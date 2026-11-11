/**
 * 카드 승인 문자 → 거래 입력 추천 (I-012).
 *
 * AI 없이 규칙으로 읽는다 — 키가 없어도, 오프라인이어도 바로 된다.
 *  1) 붙여넣은 글을 문자 단위로 나눈다 ([Web발신] 표시, 빈 줄, 새 승인 머리말 기준).
 *     승인 거절·청구 예정 안내는 결제가 아니므로 건너뛴다
 *  2) 문자마다 금액(누적·잔액 제외)·날짜·시각·카드사·카드 끝자리·가맹점·할부·승인/취소를 읽는다
 *  3) 영수증·말로 입력과 같은 규칙으로 분류한다 — 가맹점은 예전 입력 습관, 결제수단은
 *     "이 카드 문자는 이 결제수단"으로 기억한 값 > 카드사 이름과 맞는 결제수단 > 예전 습관
 *  4) 이미 가계부에 있는 거래는 중복으로, 승인 취소 문자는 지울 거래 후보로 보여 준다
 *
 * 카드사마다 문자 모양이 달라 칸 위치를 고정하지 않고, 아는 조각(금액·날짜·이름 가림 등)을 지운 뒤
 * 남는 글자를 가맹점으로 본다.
 */
import { evaluateFormula, parseForeignAmount, today as todayStr } from './formulaEvaluator';
import { addDays, isValidDateStr, parseDateStr, ymd } from './dateUtils';
import { classify, normalizeName, pickPaymentMethod, resolveAmount, resolveDate } from './receiptAssistant';
import { getPaymentMethods, getTransactions } from './dbManager';

// ── 읽기 규칙 ───────────────────────────────────────────────────

const MARKER_RE = /\[\s*(?:web|WEB|Web)?\s*(?:국외|국제)?\s*발신\s*\]/g;
const KEYWORD_RE = /(승인|취소|결제|거절)/;
/** 승인되지 않은 결제 — 가계부에 넣지 않는다 */
const DECLINED_RE = /거절|승인\s*거부|결제\s*거부|승인\s*실패|결제\s*실패|승인\s*불가|잔액\s*부족|한도\s*초과/;
/** 광고성 문자 끝의 '무료수신거부 080-…' 같은 줄 — 결제 내용이 아니다 */
const FOOTER_RE = /(?:무료)?\s*수신\s*거[부절][^\n]*/g;
/** 결제가 아닌 안내(청구·출금 예정 등) */
const NOTICE_RE = /결제\s*예정|출금\s*예정|청구\s*(?:금액|예정)|명세서|이용\s*대금|납부\s*예정|결제일\s*안내/;
const CUR_CODES = 'USD|JPY|EUR|CNY|GBP|AUD|CAD|HKD|SGD|THB|VND|TWD|PHP|CHF|NZD|MYR|IDR';
const NUM = '\\d[\\d,]*(?:\\.\\d+)?';
const FX_SOURCE = `(?:(${CUR_CODES})\\s*(${NUM})|(${NUM})\\s*(${CUR_CODES})|([$€])\\s*(${NUM}))`;
const WON_SOURCE = '(-?\\d[\\d,]*)\\s*원';
/** 결제 금액이 아닌 원 금액 (바로 앞에 이 말이 있으면 건너뜀) */
const NOT_PAYMENT_BEFORE = /(누적|잔액|한도|총|남은|가능|포인트|적립|캐시백)\s*[:：]?\s*$/;
/** "11.07 12:00"처럼 시각이 바로 뒤에 붙은 점 날짜만 날짜로 본다 (금액 12.50과 헷갈리지 않게) */
const DOT_DATE_SOURCE = '(\\d{1,2})\\.(\\d{1,2})(?=\\s+\\d{1,2}:\\d{2})';

// 발급사 — 긴 이름부터. aliases는 결제수단 이름과 맞춰 볼 때 쓴다
const ISSUERS = [
  { re: /KB\s*국민|국민|KB/i, name: 'KB국민', aliases: ['국민', 'kb'] },
  { re: /NH\s*농협|농협|NH/i, name: 'NH농협', aliases: ['농협', 'nh'] },
  { re: /IBK\s*기업|IBK|기업/i, name: 'IBK기업', aliases: ['기업', 'ibk'] },
  { re: /카카오뱅크/, name: '카카오뱅크', aliases: ['카카오뱅크', '카뱅'] },
  { re: /케이뱅크/, name: '케이뱅크', aliases: ['케이뱅크'] },
  { re: /토스뱅크|토스/, name: '토스뱅크', aliases: ['토스'] },
  { re: /SC\s*제일|SC/i, name: 'SC제일', aliases: ['sc제일', '제일'] },
  { re: /BC|비씨/i, name: 'BC', aliases: ['bc', '비씨'] },
  { re: /MG|새마을/i, name: 'MG새마을금고', aliases: ['새마을', 'mg'] },
  ...['신한', '삼성', '현대', '롯데', '하나', '우리', '씨티', '수협', '광주', '전북', '제주', '우체국', '신협']
    .map(n => ({ re: new RegExp(n), name: n, aliases: [n] })),
];

const won = () => new RegExp(WON_SOURCE, 'g');
const fx = () => new RegExp(FX_SOURCE);
const fxAll = () => new RegExp(FX_SOURCE, 'g');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 결제 금액으로 볼 원 금액 (누적·잔액 등은 뺀다). 없으면 null. 음수면 취소 표시. */
function findWonAmount(text) {
  const re = won();
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    if (NOT_PAYMENT_BEFORE.test(before)) continue;
    const n = evaluateFormula(m[1].replace(/^-/, ''));
    if (n === null || isNaN(n) || n <= 0) continue;
    return { amount: n, negative: m[1].startsWith('-'), index: m.index };
  }
  return null;
}

function findForeignAmount(text) {
  const m = fx().exec(text);
  if (!m) return null;
  const currency = m[1] || m[4] || (m[5] === '€' ? 'EUR' : 'USD');
  const value = parseForeignAmount(m[2] || m[3] || m[6]);
  return value && value > 0 ? { currency, foreignAmount: value, index: m.index } : null;
}

const hasAmount = (line) => !!(findWonAmount(line) || findForeignAmount(line));
const hasDate = (line) => /\d{1,2}\/\d{1,2}|\d{1,2}월\s*\d{1,2}일|\d{4}[./-]\d{1,2}[./-]\d{1,2}/.test(line)
  || new RegExp(DOT_DATE_SOURCE).test(line);

/** 날짜 — 연도가 없으면 오늘 기준 가장 가까운 과거(내일까지는 올해로 본다) */
function findDate(text, today) {
  const full = /(\d{4})[./-](\d{1,2})[./-](\d{1,2})/.exec(text);
  if (full) {
    const d = ymd(Number(full[1]), Number(full[2]), Number(full[3]));
    return isValidDateStr(d) ? d : '';
  }
  const m = /(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/.exec(text)
    || /(\d{1,2})월\s*(\d{1,2})일/.exec(text)
    || new RegExp(`(?:^|[^\\d.])${DOT_DATE_SOURCE}`).exec(text);
  if (!m) return '';
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(today.slice(0, 4));
  let d = ymd(year, month, day);
  if (!isValidDateStr(d) || d > addDays(today, 1)) d = ymd(year - 1, month, day);
  return isValidDateStr(d) ? d : '';
}

/** 머리말에서 금액(또는 승인·취소·결제 말)이 나오기 전까지 — 발급사·취소 여부는 여기서만 본다 */
function headPart(header, { untilKeyword = false } = {}) {
  const cuts = [findWonAmount(header)?.index, findForeignAmount(header)?.index];
  if (untilKeyword) cuts.push(KEYWORD_RE.exec(header)?.index);
  const at = Math.min(...cuts.filter(i => i !== undefined && i >= 0), header.length);
  return header.slice(0, at);
}

/**
 * 발급사. 맨 앞 [이름](발신 표시 아님)이 있으면 그것, 없으면 머리말 앞부분(승인·취소·결제 말이나 금액 전)에서 찾는다
 * — 가맹점 이름 속 '하나로마트'·'롯데리아' 같은 글자를 발급사로 보지 않게.
 */
function findIssuer(header) {
  const label = /^\s*\[([^\]]{2,12})\]/.exec(header);
  if (label && !/발신/.test(label[1])) {
    const text = label[1].trim();
    const known = ISSUERS.find(i => i.re.test(text));
    const isCard = !!known && /카드|체크/.test(text);
    return {
      name: isCard ? known.name : text,
      aliases: [text, ...(known ? known.aliases : [])],
      matched: label[0], index: label.index, bracket: true, card: isCard,
    };
  }
  const scope = headPart(header, { untilKeyword: true });
  let best = null;
  ISSUERS.forEach(issuer => {
    const m = issuer.re.exec(scope);
    if (!m || (best && m.index >= best.index)) return;
    // 영문 약자(BC·KB·NH…)가 단어 속이면(ABC마트) 발급사가 아니다
    if (/[A-Za-z]/.test(scope[m.index - 1] || '')) return;
    // 바로 뒤가 카드·체크·(끝자리)·숫자·승인/취소/결제여야 머리말이다 — '하나로마트', '롯데시네마'는 가맹점
    if (!ISSUER_TAIL_RE.test(header.slice(m.index + m[0].length))) return;
    best = { ...issuer, index: m.index, matched: m[0], card: true };
  });
  return best;
}

/** 발급사 이름 바로 뒤에 오는 머리말 모양 (신한카드(1234)승인, 삼성1234승인, 현대카드 M 승인, 하나(1*2*), 신한체크승인 …) */
const ISSUER_TAIL_RE = /^(?:\s*(?:카드|체크|은행\s*체크)|\s*\(|\s*[\d*]|\s*[A-Za-z]{0,2}\s*(?:승인|취소|결제|거절)|$)/;

/** 새 문자의 첫 줄처럼 보이는지 — 맨 앞 [이름]이나 줄 앞쪽의 발급사 */
function looksLikeHeader(line) {
  const issuer = findIssuer(line);
  return !!issuer && issuer.index <= 3;
}

function findCardDigits(header) {
  const m = /\(([\d*]{4})\)/.exec(header)
    || /(?:카드|체크)\s*([\d*]{4})(?![\d,원.])/.exec(header)
    || /(?:^|[^\d,])([\d*]{4})(?![\d,원.])\s*(?:승인|체크|취소|결제)/.exec(header);
  return m ? m[1] : '';
}

/** 머리말(발급사 ~ 승인/취소)을 지운다 */
function stripHeader(line, issuer) {
  if (!issuer) return line;
  const at = line.indexOf(issuer.matched);
  if (at < 0) return line;
  // [카카오페이] 처럼 대괄호 이름이면 이름만 지운다 — 바로 뒤에 가맹점이 오는 알림이 많다
  if (issuer.bracket) return line.slice(0, at) + ' ' + line.slice(at + issuer.matched.length);
  const rest = line.slice(at);
  const kw = /^[^\n]*?(?:승인\s*취소|해외\s*승인|체크\s*승인|승인|취소|결제)/.exec(rest);
  const head = kw
    ? kw[0]
    : (new RegExp(`^${escapeRe(issuer.matched)}(?:카드|체크카드|체크)?\\s*(?:\\([\\d*]{4}\\)|[\\d*]{4})?`).exec(rest) || [issuer.matched])[0];
  return line.slice(0, at) + ' ' + rest.slice(head.length);
}

const STRAY_WORDS = /(^|\s)(승인\s*취소|해외\s*승인|체크\s*승인|승인|취소|결제|완료|일시불|할부|사용|님)(?=\s|$)/g;
/** 머리말 줄의 가린 이름(홍*동, 홍길*, 홍*동님)과 '홍길동님' — 한글 이름 자리만 지운다 */
const MASKED_NAME = '(?:[가-힣]\\*{1,2}[가-힣]{0,2}|[가-힣]{2}\\*{1,2}[가-힣]?)';
const HEADER_NAME_RE = new RegExp(`(^|[\\s(\\])])(?:${MASKED_NAME}\\s*님?|[가-힣]{2,4}님)(?=[\\s\\d(/]|$)`, 'g');
/** 이름만 있는 줄 (KB·현대처럼 이름이 따로 한 줄) */
const NAME_LINE_RE = new RegExp(`^(?:${MASKED_NAME}\\s*님?|[가-힣]{2,4}\\s*님)$`);

/** 알려진 조각을 지우고 남는 글자 (가맹점 후보) */
function leftover(line, header, issuer) {
  if (NAME_LINE_RE.test(line)) return '';
  let s = line.replace(MARKER_RE, ' ').replace(FOOTER_RE, ' ');
  s = s.replace(/(총\s*)?누적.*$/, ' ').replace(/(잔액|사용\s*가능|가능\s*한도|한도)\s*[:：]?\s*-?\d.*$/, ' ');
  if (line === header) {
    s = stripHeader(s, issuer);
    s = s.replace(HEADER_NAME_RE, '$1 ');
  }
  s = s.replace(won(), ' ');
  s = s.replace(fxAll(), ' ');
  s = s.replace(/\d{4}[./-]\d{1,2}[./-]\d{1,2}/g, ' ').replace(/\d{1,2}\/\d{1,2}/g, ' ').replace(/\d{1,2}월\s*\d{1,2}일/g, ' ');
  s = s.replace(new RegExp(DOT_DATE_SOURCE, 'g'), ' ');
  s = s.replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ');
  s = s.replace(/\(\s*(?:일시불|\d{1,2}\s*개월|할부)\s*\)|\d{1,2}\s*개월/g, ' ');
  s = s.replace(/[/|·]+/g, ' ').replace(/\(\s*\)/g, ' ');
  s = s.replace(/\s+/g, ' ');
  // 같은 말이 연달아 남을 수 있어 두 번 지운다 ("승인 완료")
  s = s.replace(STRAY_WORDS, ' ').replace(STRAY_WORDS, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function cleanMerchant(s) {
  return String(s || '')
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사/g, ' ')
    .replace(/[[\]]/g, ' ')
    .replace(/^[\s\-_.,:;()]+|[\s\-_.,:;()]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 건너뛸 문자인지 — 'declined'(승인 거절·실패) | 'notice'(청구·출금 예정 안내) | '' */
function skipReason(raw) {
  const text = raw.replace(FOOTER_RE, ' ');
  if (DECLINED_RE.test(text)) return 'declined';
  if (NOTICE_RE.test(text) && !/승인/.test(text)) return 'notice';
  return '';
}

const SKIP_LABEL = { declined: '승인 거절', notice: '청구·출금 안내', unread: '금액 없음' };

/** 건너뛴 글 요약 — "건너뛴 글 3개 (승인 거절 1, 금액 없음 2)" */
export function describeSkipped(skipped) {
  if (!skipped || !skipped.length) return '';
  const counts = {};
  skipped.forEach(x => { counts[x.reason] = (counts[x.reason] || 0) + 1; });
  const parts = Object.entries(counts).map(([r, n]) => `${SKIP_LABEL[r] || r} ${n}`);
  return `건너뛴 글 ${skipped.length}개 (${parts.join(', ')})`;
}

// 카드 문자의 날짜(11/08·11.08)·시각(12:34) — "4.5천원"·"1.5만원"처럼 소수점 금액은 날짜(4.5)로 보지 않는다
const SMS_DATE_TIME_RE = /(?:^|[^\d.,])\d{1,2}[/.]\d{1,2}(?![\d.,]|\s*(?:천|만|원|달러|불|유로|엔))|\d{1,2}:\d{2}/;

/**
 * 붙여넣은 글이 카드 승인·취소 문자로 보이는지 (AI 입력이 규칙으로 읽을지 AI에 맡길지 고른다, I-022).
 * [Web발신] 같은 발신 표시가 있거나, 카드사로 시작하는 승인·취소·결제 머리말 줄이 있고 날짜·시각이 함께 있을 때.
 * "어제 신한카드로 스타벅스 4500원 결제했어" 같은 말은 날짜·시각 표기가 없어 AI로 보낸다.
 */
export function looksLikeCardMessage(text) {
  const t = String(text || '');
  if (new RegExp(MARKER_RE.source).test(t)) return true;
  const header = t.split(/\r\n?|\n/).some(line => KEYWORD_RE.test(line) && looksLikeHeader(line.trim()));
  return header && SMS_DATE_TIME_RE.test(t);
}

/**
 * 붙여넣은 글을 문자 하나씩으로 나눈다.
 * [Web발신] 표시·빈 줄이 경계이고, 그런 것 없이 붙어 있어도 발급사로 시작하는 새 승인 머리말이나
 * 금액·날짜가 다 있는 줄이 나오면 새 문자로 본다. ('네이버페이결제' 같은 가맹점 줄에서는 나누지 않는다)
 */
export function splitMessages(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const segments = [];
  let cur = [];
  let curKeyword = false;
  let curAmount = false;
  const flush = () => {
    if (cur.length) segments.push(cur.join('\n'));
    cur = [];
    curKeyword = false;
    curAmount = false;
  };
  lines.forEach(raw => {
    let line = raw.trim();
    if (!line) { flush(); return; }
    if (MARKER_RE.test(line)) {
      MARKER_RE.lastIndex = 0;
      flush();
      line = line.replace(MARKER_RE, ' ').trim();
      if (!line) return;
    }
    MARKER_RE.lastIndex = 0;
    const kw = KEYWORD_RE.test(line);
    const amt = hasAmount(line);
    const complete = amt && hasDate(line);
    if (cur.length && ((kw && curKeyword && looksLikeHeader(line)) || (complete && curAmount))) flush();
    cur.push(line);
    curKeyword = curKeyword || kw;
    curAmount = curAmount || amt;
  });
  flush();
  return segments;
}

/**
 * 문자 하나를 읽는다. 금액이 없거나, 승인 거절·청구 안내면 null.
 * 반환: { raw, kind('approve'|'cancel'), issuer, digits, isCheck, cardKey, cardLabel,
 *         amount(원, 외화면 null), currency, foreignAmount, date, time, installment, merchant }
 */
export function parseCardMessage(segment, today = todayStr()) {
  const raw = String(segment || '').trim();
  if (!raw || skipReason(raw)) return null;
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const header = lines.find(l => /(승인|취소)/.test(l)) || lines.find(l => /결제/.test(l)) || lines[0];

  const wonHit = findWonAmount(raw);
  const fxHit = wonHit ? null : findForeignAmount(raw);
  if (!wonHit && !fxHit) return null;

  const issuer = findIssuer(header);
  const digits = findCardDigits(header);
  const isCheck = /체크/.test(headPart(header));
  // 취소는 머리말 앞부분이나 '결제 취소'·'취소 완료' 같은 말로만 — 가맹점 이름 속 '취소'는 무시
  const cancelled = /취소/.test(headPart(header)) || /(?:결제|승인)\s*취소|취소\s*(?:완료|승인|처리)/.test(header);
  const kind = cancelled || wonHit?.negative ? 'cancel' : 'approve';

  const timeMatch = /(\d{1,2}):(\d{2})/.exec(raw);
  const inst = /(\d{1,2})\s*개월/.exec(raw);

  // 가맹점 — 시각이 있는 줄의 남은 글자, 없으면 그 뒤 줄, 그래도 없으면 아무 줄
  const rest = lines.map(l => leftover(l, header, issuer));
  const timeIdx = lines.findIndex(l => /\d{1,2}:\d{2}/.test(l));
  const anchor = timeIdx >= 0 ? timeIdx : lines.findIndex(l => hasDate(l));
  let merchant = '';
  if (anchor >= 0) merchant = rest[anchor] || rest.slice(anchor + 1).find(Boolean) || '';
  if (!merchant) merchant = rest.find(Boolean) || '';

  const issuerName = issuer?.name || '';
  const cardType = issuer?.card ? (isCheck ? '체크' : '카드') : '';
  return {
    raw,
    kind,
    issuer: issuerName,
    issuerAliases: issuer?.aliases || [],
    digits,
    isCheck,
    cardKey: issuerName ? `${issuerName}${cardType}${digits ? ` ${digits}` : ''}` : '',
    cardLabel: issuerName ? `${issuerName}${cardType}${digits ? `(${digits})` : ''}` : '카드 문자',
    amount: wonHit ? wonHit.amount : null,
    currency: wonHit ? 'KRW' : fxHit.currency,
    foreignAmount: wonHit ? null : fxHit.foreignAmount,
    date: findDate(raw, today),
    time: timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}` : '',
    installment: inst ? Number(inst[1]) : 0,
    merchant: cleanMerchant(merchant),
  };
}

/**
 * 붙여넣은 글 전체 → { messages: 읽은 문자, skipped: [{ text, reason }] }
 * reason: 'declined'(승인 거절) | 'notice'(청구·출금 예정 안내) | 'unread'(금액을 찾지 못함)
 */
export function parseCardMessages(text, today = todayStr()) {
  const messages = [];
  const skipped = [];
  splitMessages(text).forEach(seg => {
    const reason = skipReason(seg);
    const parsed = reason ? null : parseCardMessage(seg, today);
    if (parsed) messages.push(parsed);
    else if (seg.replace(MARKER_RE, '').trim()) skipped.push({ text: seg, reason: reason || 'unread' });
    MARKER_RE.lastIndex = 0;
  });
  return { messages, skipped };
}

// ── 카드 문자 → 결제수단 기억 (기기별) ─────────────────────────────
// 카드 문자는 그 카드 주인의 휴대폰으로 오므로 기기마다 따로 기억한다.
// 결제수단 이름이 바뀌거나 숨겨지면 목록에 없는 값이 되어 쓰지 않는다 (DB 목록과 대조).

const CARD_MAP_KEY = 'ledger_card_sms_map';

export function loadCardMap() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CARD_MAP_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

/** pairs: [[cardKey, 결제수단], ...] — 기존 기억에 덧쓴다 */
export function rememberCards(pairs) {
  const map = loadCardMap();
  let changed = false;
  pairs.forEach(([key, method]) => {
    if (key && method && map[key] !== method) { map[key] = method; changed = true; }
  });
  if (!changed) return;
  try { window.localStorage.setItem(CARD_MAP_KEY, JSON.stringify(map)); } catch (e) { /* 저장 못 해도 이번 입력은 된다 */ }
}

/** 카드사 이름과 맞는 결제수단 — 하나로 좁혀질 때만 고른다 (체크 문자면 '체크'가 든 것, 아니면 안 든 것 우선) */
function guessMethodByIssuer(methods, msg) {
  if (!msg.issuerAliases.length) return '';
  const keys = msg.issuerAliases.map(normalizeName).filter(Boolean);
  const hits = methods.filter(m => keys.some(k => normalizeName(m).includes(k)));
  if (hits.length <= 1) return hits[0] || '';
  const preferred = hits.filter(m => /체크/.test(m) === msg.isCheck);
  return preferred.length === 1 ? preferred[0] : '';
}

/** 두 이름이 같은 곳인지 — 한쪽이 다른 쪽을 품는다(두 글자 이상). 사진 입력의 겹친 결제 찾기도 쓴다 */
export function namesMatch(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (x.length < 2 || y.length < 2) return false;
  return x.includes(y) || y.includes(x);
}

function txBrief(tx) {
  return {
    id: tx.id, date: tx.date, detail: tx.detail || tx.sub_category || '',
    payment_method: tx.payment_method, amount: Number(tx.amount) || 0, split: !!tx.split_group_id,
  };
}

// ── 추천 만들기 ─────────────────────────────────────────────────

function buildApproval(db, msg, methods, cardMap, today) {
  const { date, source: dateSource } = resolveDate(msg.date, today, 'sms');
  const money = resolveAmount(db, {
    total: msg.currency === 'KRW' ? msg.amount : msg.foreignAmount, currency: msg.currency, date,
  });
  const cls = classify(db, { merchant: msg.merchant, detail: msg.merchant, eventId: money.event_id, readSource: 'sms' });

  let payment = { payment_method: '', source: null };
  const remembered = msg.cardKey && cardMap[msg.cardKey];
  if (remembered && methods.includes(remembered)) {
    payment = { payment_method: remembered, source: 'sms' };
  } else {
    const guessed = guessMethodByIssuer(methods, msg);
    payment = guessed
      ? { payment_method: guessed, source: 'sms' }
      : pickPaymentMethod(db, { history: cls.history, sub: cls.sub_category, readSource: 'sms' });
  }

  const sources = { date: dateSource, ...cls.sources };
  if (money.event_id) sources.event = 'trip';
  if (payment.source) sources.payment_method = payment.source;

  const warnings = [...money.warnings];
  if (dateSource === 'today') warnings.push('날짜를 읽지 못해 오늘 날짜로 넣었습니다');
  if (msg.installment > 1) warnings.push(`${msg.installment}개월 할부 — 전체 금액으로 넣습니다`);
  if (!msg.merchant) warnings.push('가맹점을 읽지 못했습니다 — 세부내역을 직접 입력하세요');

  return {
    kind: 'approve',
    date,
    merchant: msg.merchant,
    detail: cls.detail,
    amount: money.amount,
    currency: money.currency,
    foreignAmount: money.foreignAmount,
    rate: money.rate,
    event_id: money.event_id,
    eventTitle: money.eventTitle,
    payment_method: payment.payment_method,
    paymentHint: msg.cardLabel,
    budget_category: cls.budget_category,
    sub_category: cls.sub_category,
    items: [],
    historyDetail: cls.history?.detail || '',
    historyCount: cls.history?.cnt || 0,
    warnings,
    sources,
    cardKey: msg.cardKey,
    cardLabel: msg.cardLabel,
    time: msg.time,
    duplicateOf: null,
  };
}

/** 가계부에 이미 같은 날·같은 금액으로 적은 거래 (결제수단이나 내용이 맞을 때) — AI 입력의 바로 넣기도 이것으로 중복을 거른다(I-022) */
export function findExistingTransaction(db, s) { return findExisting(db, s); }

function findExisting(db, s) {
  if (s.amount === null) return null;
  const sameDay = getTransactions(db, { dateFrom: s.date, dateTo: s.date })
    .filter(tx => Number(tx.amount) === s.amount);
  const hit = sameDay.find(tx => (s.payment_method && tx.payment_method === s.payment_method)
    || namesMatch(tx.detail, s.merchant) || namesMatch(tx.detail, s.detail));
  return hit ? txBrief(hit) : null;
}

/** 취소 문자 날짜보다 며칠 앞선 거래인지 */
const daysBefore = (txDate, date) => Math.round((parseDateStr(date) - parseDateStr(txDate)) / 86400000);

/** 미리 체크해도 될 만큼 확실한 짝 — 가맹점이 같고 취소 3일 안쪽에 산 것 */
const STRONG_CANCEL_DAYS = 3;

function cancelItem(msg, date, extra) {
  return {
    kind: 'cancel',
    date,
    merchant: msg.merchant,
    amount: msg.amount,
    currency: msg.currency,
    foreignAmount: msg.foreignAmount,
    cardKey: msg.cardKey,
    cardLabel: msg.cardLabel,
    time: msg.time,
    match: null,
    pairedInPaste: false,
    ...extra,
  };
}

/**
 * 승인 취소 문자 — 지울 거래 후보. 취소일 60일 전~취소일 사이에 같은 금액으로 적은 거래 중
 * 가맹점이나 결제수단이 맞는 것. 분할 결제는 묶음이라 자동으로 고르지 않는다.
 * 가맹점이 같고 3일 안쪽이면 strong(미리 체크), 아니면 보여 주기만 한다.
 */
function buildCancel(db, msg, methods, cardMap, today, taken) {
  const { date } = resolveDate(msg.date, today, 'sms');
  const method = (msg.cardKey && methods.includes(cardMap[msg.cardKey]) && cardMap[msg.cardKey])
    || guessMethodByIssuer(methods, msg);
  let best = null;
  if (msg.amount !== null) {
    getTransactions(db, { dateFrom: addDays(date, -60), dateTo: date })
      .filter(tx => !tx.split_group_id && Number(tx.amount) === msg.amount && !taken.has(tx.id))
      .forEach(tx => {
        const nameHit = namesMatch(tx.detail, msg.merchant);
        const methodHit = !!method && tx.payment_method === method;
        if (!nameHit && !methodHit) return;
        const score = (nameHit ? 2 : 0) + (methodHit ? 1 : 0);
        const gap = daysBefore(tx.date, date);
        if (!best || score > best.score || (score === best.score && gap < best.gap)) best = { tx, score, gap, nameHit };
      });
  }
  if (best) taken.add(best.tx.id);
  return cancelItem(msg, date, {
    match: best
      ? { ...txBrief(best.tx), daysBefore: best.gap, strong: best.nameHit && best.gap <= STRONG_CANCEL_DAYS }
      : null,
  });
}

/** 같은 승인 문자인지 알아보는 열쇠 — 날짜·금액·가맹점·카드·시각 */
export const smsKeyOf = s => [s.date, s.amount, s.merchant, s.cardKey, s.time].join('|');

/**
 * 붙여넣은 카드 문자 → 화면에 보여 줄 추천 목록.
 * 반환: { items: [승인 추천 | 취소 추천], skipped: [{ text, reason }] }
 *  - 승인: buildSuggestion과 같은 모양 + kind, cardKey, cardLabel, time, duplicateOf, pairedCancel
 *  - 취소: { kind: 'cancel', match: 지울 거래 후보 | null, pairedInPaste }
 */
export function buildSmsSuggestions(db, text, { today = todayStr(), cardMap = loadCardMap() } = {}) {
  const { messages, skipped } = parseCardMessages(text, today);
  const methods = getPaymentMethods(db);
  const approvals = messages.filter(m => m.kind === 'approve').map(m => buildApproval(db, m, methods, cardMap, today));

  // 1) 이미 가계부에 있거나, 같은 문자를 두 번 붙여넣은 승인
  const seen = new Set();
  approvals.forEach(s => {
    const key = smsKeyOf(s);
    if (seen.has(key)) {
      s.duplicateOf = { inPaste: true };
      s.warnings.push('같은 문자가 두 번 들어 있어요');
    }
    seen.add(key);
    if (!s.duplicateOf) {
      const existing = findExisting(db, s);
      if (existing) {
        s.duplicateOf = existing;
        s.warnings.push(`가계부에 이미 있는 것 같아요 — ${existing.date} ${existing.detail || existing.payment_method} ${existing.amount.toLocaleString()}원`);
      }
    }
  });

  // 2) 같은 글 안의 승인과 그 취소 (같은 금액·같은 가맹점, 카드를 알면 같은 카드)
  //    - 승인이 이미 가계부에 있으면: 취소가 그 거래를 지울 후보가 된다
  //    - 아직 없으면: 둘 다 건너뛴다 (넣었다 지울 필요가 없다)
  const taken = new Set();
  const cancelMsgs = messages.filter(m => m.kind === 'cancel');
  const results = cancelMsgs.map(m => {
    const pair = approvals.find(a => !a.pairedCancel && a.amount !== null && a.amount === m.amount
      && namesMatch(a.merchant, m.merchant) && (!a.cardKey || !m.cardKey || a.cardKey === m.cardKey));
    if (!pair) return null;
    pair.pairedCancel = true;
    const { date } = resolveDate(m.date, today, 'sms');
    if (pair.duplicateOf?.id) {
      pair.warnings.push('이 결제는 승인 취소되었습니다 — 아래 승인 취소 항목에서 가계부 거래를 지울 수 있어요');
      // 분할 결제의 몫은 묶음이라 자동으로 고르지 않는다 → 일반 취소처럼 찾는다(분할 제외)
      if (pair.duplicateOf.split) return null;
      taken.add(pair.duplicateOf.id);
      return cancelItem(m, date, {
        match: {
          ...pair.duplicateOf,
          daysBefore: daysBefore(pair.duplicateOf.date, date),
          // 같은 카드·같은 날·같은 금액이라도 내용이 다르면(점심 김밥 ↔ 스타벅스) 미리 체크하지 않는다
          strong: namesMatch(pair.duplicateOf.detail, m.merchant),
        },
      });
    }
    pair.warnings.push('붙여넣은 글에 이 결제의 승인 취소가 함께 있어 건너뜁니다');
    return cancelItem(m, date, { pairedInPaste: true });
  });
  // 3) 짝이 없는 취소는 가계부에서 지울 거래를 찾는다
  const cancels = cancelMsgs.map((m, i) => results[i] || buildCancel(db, m, methods, cardMap, today, taken));

  return { items: [...approvals, ...cancels], skipped };
}
