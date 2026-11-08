/**
 * 카드 결제 내역 대조 — 카드 앱 캡처·명세서 PDF를 AI로 읽어 가계부와 비교한다.
 *
 *   일치          : 금액이 같고 날짜가 ±3일 안 (한 건은 한 건하고만 짝지음, 같은 가게가 먼저)
 *   일치(묶음)    : 같은 가게·±1일에서 여러 건의 합이 같음 — 데이터는 고치지 않는다
 *                   · 나눠 적음: 카드 1건 = 가계부 여러 건 (카테고리별로 나눠 적은 경우)
 *                   · 합쳐 적음: 카드 여러 건 = 가계부 1건
 *   금액 차이     : 날짜·가게는 맞는데 금액이 다름 → 가계부가 1건일 때만 카드 금액으로 수정 가능
 *   가계부에 없음 : 카드에만 있음 → 분류를 추천해 바로 추가
 *   카드에 없음   : 그 기간 이 결제수단으로 적었는데 카드에 없음 → 결제수단 확인 필요
 *   취소된 결제   : 카드에 승인과 취소가 함께 있음 → 가계부에 같은 가게 승인 건이 남아 있으면 알림
 *
 * 비교는 AI 없이 로컬에서 한다 — 추가·수정 후 다시 계산하면 바로 반영된다.
 */
import { analyzeWithAI, AIError } from './aiClient';
import {
  buildDataContext, classify, findTrip, normalizeName, suggestionToTransaction,
} from './receiptAssistant';
import { addTransaction, withTransaction } from './dbManager';
import { todayStr, addDays, isValidDateStr, parseDateStr } from './dateUtils';

export const TOLERANCE_DAYS = 3;
/** 묶음 일치는 같은 가게·이 날짜 차이 안에서만, 이 건수까지만 본다 (아무 금액이나 더해 맞추는 오탐 방지) */
export const GROUP_DAYS = 1;
export const GROUP_MAX = 4;
/** "가계부에 없음"을 미리 체크하기 전에 비슷한 기록을 찾는 범위 — 짝짓기(±3일)보다 넓게 (날짜를 며칠 잘못 적은 기록) */
export const SIMILAR_DAYS = TOLERANCE_DAYS + 2;

const SCHEMA = {
  type: 'object',
  properties: {
    is_card_statement: { type: 'boolean', description: '카드 결제(승인) 내역이나 명세서이면 true' },
    card_name: { type: 'string', description: '보이는 카드 이름. 없으면 빈 문자열' },
    period_from: { type: 'string', description: '내역 기간 시작 YYYY-MM-DD. 안 보이면 빈 문자열' },
    period_to: { type: 'string', description: '내역 기간 끝 YYYY-MM-DD. 안 보이면 빈 문자열' },
    rows: {
      type: 'array',
      description: '결제·취소 건 (같은 건은 한 번만)',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '결제일 YYYY-MM-DD' },
          merchant: { type: 'string', description: '가맹점명 (보이는 그대로)' },
          amount: { type: 'number', description: '원화 결제 금액. 취소·환불은 음수' },
          is_cancel: { type: 'boolean', description: '취소·환불 건이면 true' },
          currency: { type: 'string', description: '해외결제면 현지 통화 코드, 아니면 KRW' },
          foreign_amount: { type: 'number', description: '해외결제 현지 금액, 아니면 0' },
          installment: { type: 'string', description: '할부 표시 (예: 3개월). 일시불이면 빈 문자열' },
          category: { type: 'string', description: '"카테고리 > 세부카테고리" 목록 중 하나, 애매하면 "모름"' },
          detail: { type: 'string', description: '가계부 세부내역 추천 (입력 습관 표기 우선)' },
        },
        required: ['date', 'merchant', 'amount', 'is_cancel', 'currency', 'foreign_amount', 'installment', 'category', 'detail'],
      },
    },
    note: { type: 'string', description: '사용자에게 알릴 점 (잘린 화면, 흐린 부분 등). 없으면 빈 문자열' },
  },
  required: ['is_card_statement', 'card_name', 'period_from', 'period_to', 'rows', 'note'],
};

const SYSTEM = [
  '당신은 한국 가계부 앱의 카드 내역 정리 도우미입니다.',
  '카드 결제 내역·명세서에 실제로 보이는 결제 건만 빠짐없이, 중복 없이 옮겨 적습니다.',
  '분류는 주어진 목록 안에서 사용자의 입력 습관을 우선해 고릅니다.',
].join(' ');

export function buildStatementPrompt(db, paymentMethod, today = todayStr()) {
  return [
    buildDataContext(db, today).text,
    '',
    `[대조할 결제수단] ${paymentMethod}`,
    '',
    '첨부 파일은 이 카드의 결제(승인) 내역이나 명세서입니다.',
    '여러 장이면 한 목록을 이어 찍었거나 길게 잘라 보낸 것이라 겹치는 부분이 있습니다 — 같은 결제는 한 번만 적으세요.',
    '',
    '[규칙]',
    '- rows에는 실제 결제·취소 건만. 소계·합계·결제예정액·포인트·안내 문구는 제외.',
    '- 청구할인·캐시백·포인트 차감·할인 금액 줄은 rows에 넣지 않는다 (결제를 취소한 것이 아니다).',
    '- amount는 원화 금액. 취소·환불은 음수로 적고 is_cancel=true.',
    '- 해외결제는 currency·foreign_amount에 현지 통화와 금액, amount에 원화 금액.',
    '- 할부는 결제한 총액을 amount에, installment에 "3개월" 같은 표시.',
    '- 날짜에 연도가 없으면 오늘 기준 가장 가까운 과거 날짜.',
    '- category·detail은 입력 습관에 같은 가게가 있으면 그 분류·표기를 따른다.',
  ].join('\n');
}

/** 파일들을 AI로 읽어 카드 결제 행 목록을 만든다 */
export async function analyzeStatement({ db, ai, files, paymentMethod, signal, onProgress, today = todayStr() }) {
  const raw = await analyzeWithAI({
    ai, system: SYSTEM, prompt: buildStatementPrompt(db, paymentMethod, today), schema: SCHEMA,
    toolName: 'record_card_statement', description: '카드 결제 내역을 행 단위로 기록한다',
    files, signal, onProgress, maxTokens: 16000,
  });
  if (raw && raw.is_card_statement === false) {
    throw new AIError('카드 결제 내역으로 보이지 않습니다 — 카드 앱의 이용내역이나 명세서를 올려 주세요', 'parse');
  }
  return normalizeStatement(raw || {}, today);
}

/**
 * AI 응답을 카드 행 목록으로 정리한다.
 * 행 칸(rows)이 아예 없으면 0건으로 두지 않고 오류를 낸다 — 0건이면 "모두 맞습니다"로 잘못 보인다.
 * 금액이 0원이거나 읽지 못한 행은 조용히 빼지 않고 zeroAmount로 센다 (해외결제 원화 미확정 등).
 */
const DISCOUNT_LINE = /청구\s*할인|캐시\s*백|포인트\s*(차감|사용|결제)|즉시\s*할인|할인\s*금액/;

export function normalizeStatement(raw, today = todayStr()) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rows)) {
    throw new AIError('명세서 내용을 읽지 못했습니다 — 다시 시도해 주세요', 'parse');
  }
  const rows = [];
  let unreadable = 0;
  let zeroAmount = 0;
  let discountLines = 0;
  raw.rows.forEach((r, i) => {
    if (!r || typeof r !== 'object') { unreadable += 1; return; }
    let amount = Math.round(Number(r.amount) || 0);
    if (!amount) { zeroAmount += 1; return; }
    // 청구할인·캐시백·포인트 차감 줄은 결제 취소가 아니다 — AI가 넣었어도 빼고 센다 (환불로 추가되지 않게)
    if (amount < 0 && DISCOUNT_LINE.test(String(r.merchant || ''))) { discountLines += 1; return; }
    if (!isValidDateStr(r.date) || r.date > addDays(today, 1)) { unreadable += 1; return; }
    // 취소·환불인데 양수로 읽었으면 음수로 — 그대로 두면 결제로 대조·추가된다
    const isCancel = !!r.is_cancel || amount < 0;
    if (isCancel) amount = -Math.abs(amount);
    const currency = /^[A-Za-z]{3}$/.test(String(r.currency || '').trim()) ? String(r.currency).trim().toUpperCase() : 'KRW';
    rows.push({
      id: `r${i}`,
      date: r.date,
      merchant: String(r.merchant || '').trim(),
      amount,
      isCancel,
      currency,
      // 외화 금액은 크기만 (취소 행은 음수로 읽히기도 한다 — 같은 외화 금액의 승인을 찾는 데 쓴다)
      foreignAmount: currency !== 'KRW' && Number(r.foreign_amount) ? Math.round(Math.abs(Number(r.foreign_amount)) * 100) / 100 : null,
      installment: String(r.installment || '').trim(),
      aiCategory: r.category,
      aiDetail: r.detail,
    });
  });
  return {
    cardName: String(raw.card_name || '').trim(),
    periodFrom: isValidDateStr(raw.period_from) ? raw.period_from : '',
    periodTo: isValidDateStr(raw.period_to) ? raw.period_to : '',
    rows,
    unreadable,
    zeroAmount,
    discountLines,
    note: String(raw.note || '').trim(),
  };
}

// ── 대조 ────────────────────────────────────────────────────────

function dayDiff(a, b) {
  return Math.round(Math.abs(parseDateStr(a) - parseDateStr(b)) / 86400000);
}

// 결제대행·간편결제 표기 — "네이버페이 OO몰"이면 실제 가게는 OO몰이다
const PAY_NAMES = '네이버페이|naverpay|npay|카카오페이|kakaopay|토스페이먼츠|tosspayments|토스페이|tosspay|페이코|payco'
  + '|스마일페이|smilepay|케이지이니시스|kg이니시스|이니시스|inicis|nhnkcp|나이스페이|nicepay|다날|danal|페이팔|paypal';
const PAY_PREFIX = new RegExp(`^(${PAY_NAMES})`);
const PAY_ONLY = new RegExp(`^(${PAY_NAMES})$`);
const LEGAL = /\(주\)|㈜|주식회사|\(유\)|유한회사/g;
const REFUND_WORDS = /부분\s*취소|취소|환불|반품|환급/g;
const NAME_SPLIT = /[^0-9A-Za-z가-힣ぁ-んァ-ン一-龥]+/;

/**
 * 가게 이름 비교 재료 — 한 번만 만들어 둔다 (행·거래마다 다시 계산하지 않게).
 *   raw : 법인 표기·www·도메인 끝을 뺀 이름        "(주)이마트 성수점" → "이마트성수점"
 *   key : raw에서 앞의 결제대행 표기까지 뺀 이름    "네이버페이 무신사" → "무신사"
 *   head: 첫 단어 (결제대행 단어는 건너뜀)          "이마트 장보기" → "이마트"
 */
function merchantInfo(name) {
  const cleaned = String(name || '')
    .replace(LEGAL, ' ')
    .replace(REFUND_WORDS, ' ')   // "다이소 환불"·"쿠팡 반품"도 그 가게 이름으로 본다
    .replace(/(https?:\/\/)?www\d?\./gi, ' ')
    .replace(/\.(co\.kr|or\.kr|com|net|org|kr)\b/gi, ' ');
  const raw = normalizeName(cleaned);
  const rest = raw.replace(PAY_PREFIX, '');
  const words = cleaned.split(NAME_SPLIT).map(normalizeName).filter(Boolean);
  while (words.length > 1 && PAY_ONLY.test(words[0])) words.shift();
  const first = words[0] || '';
  const firstRest = first.replace(PAY_PREFIX, '');
  return { raw, key: rest.length >= 2 ? rest : raw, head: firstRest.length >= 2 ? firstRest : first };
}

function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return i;
}

// 가게 이름이 아닌 흔한 첫 단어 — 두 글자 첫 단어가 같아도 같은 가게로 보지 않는다 ("점심 김밥" ↔ "점심 국수")
const GENERIC_HEADS = new Set([
  '점심', '저녁', '아침', '간식', '야식', '커피', '택시', '주유', '장보기', '식비', '외식', '배달', '회식', '마트', '카페',
  '쇼핑', '선물', '병원', '약국', '버스', '교통', '생활', '기타', '송금', '결제', '충전', '환불', '취소', '할인', '적립',
  '이체', '입금', '출금', '구독', '월세', '보험', '통신', '용돈', '반찬', '과일', '주차', '세탁', '미용', '학원', '식당',
]);

const SAME = 2;     // 같은 가게 — 금액이 달라도 "카드 금액으로 수정"을 권할 수 있다
const SIMILAR = 1;  // 아마 같은 가게 — 금액이 정확히 맞을 때(1:1·묶음 합계)만 근거로 쓴다

/**
 * 카드 가맹점명과 가계부 세부내역이 같은 곳을 가리키는지.
 *   SAME   : 한쪽이 다른 쪽을 포함 ("스타벅스 강남점" ⊃ "스타벅스"),
 *            또는 한쪽 첫 단어(3글자 이상)로 다른 쪽이 시작 ("이마트 장보기" ↔ "(주)이마트 성수점")
 *   SIMILAR: 앞 3글자 이상이 같음 ("이마트성수점" ↔ "이마트장보기"),
 *            또는 두 글자 첫 단어가 같음 ("본죽 점심" ↔ "본죽 성수점", "CU 간식" ↔ "CU 성수역점") — 일반어("점심 김밥")는 빼고
 * 가운데·뒤만 같은 건 다른 가게다 — 현대백화점/롯데백화점, 밝은치과의원/서울치과의원,
 * 앞 2글자만 같은 것도 — 스타벅스/스타필드, 롯데마트/롯데리아.
 * (예전 입력 습관 matchHistory로 맞추던 별칭은 같은 "포함" 규칙이라 SAME에 이미 들어 있다)
 */
function merchantLevel(a, b) {
  if (a.raw.length < 2 || b.raw.length < 2) return 0;
  if (a.raw.includes(b.raw) || b.raw.includes(a.raw) || a.key.includes(b.key) || b.key.includes(a.key)) return SAME;
  if ((a.head.length >= 3 && b.key.startsWith(a.head)) || (b.head.length >= 3 && a.key.startsWith(b.head))) return SAME;
  if (a.head.length === 2 && a.head === b.head && !GENERIC_HEADS.has(a.head)) return SIMILAR;
  return commonPrefixLength(a.key, b.key) >= 3 ? SIMILAR : 0;
}

const gross = tx => Number(tx.amount) || 0;
const net = tx => gross(tx) - (Number(tx.discount_amount) || 0);
const sumOf = (list, value) => list.reduce((s, x) => s + value(x), 0);

/** 해외결제 환율 차이 범위 — 원화가 ±10% 안 */
function fxClose(a, b) {
  return a > 0 && b > 0 && Math.abs(a - b) <= a * 0.1;
}

function hasForeign(tx) {
  try {
    const f = tx.foreign_amounts ? JSON.parse(tx.foreign_amounts) : {};
    return Object.keys(f).some(k => k !== 'KRW' && Number(f[k]));
  } catch (e) {
    return false;
  }
}

function amountMatches(row, tx) {
  return row.amount === gross(tx) || (net(tx) !== gross(tx) && row.amount === net(tx));
}

/**
 * items 중 2~GROUP_MAX개를 골라 value 합이 target인 조합 (건수가 적은 것 먼저).
 * 후보는 같은 가게·가까운 날짜로 이미 걸러져 있어 몇 개 안 된다.
 */
function findCombination(items, value, target) {
  const pool = items.slice(0, 10);
  for (let size = 2; size <= Math.min(GROUP_MAX, pool.length); size += 1) {
    const pick = [];
    const search = (start, sum) => {
      if (pick.length === size) return sum === target;
      for (let i = start; i < pool.length; i += 1) {
        pick.push(pool[i]);
        if (search(i + 1, sum + value(pool[i]))) return true;
        pick.pop();
      }
      return false;
    };
    if (search(0, 0)) return [...pick];
  }
  return null;
}

function groupBy(list, keyOf) {
  const map = new Map();
  list.forEach(x => {
    const k = keyOf(x);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  });
  return map;
}

/** items 중 1~maxPick개를 골라 value 합이 target ±tolerance인 조합이 있는지 (후보는 몇 개 안 된다) */
function subsetNear(items, value, target, tolerance, maxPick) {
  const search = (start, picked, sum) => {
    if (picked > 0 && Math.abs(sum - target) <= tolerance) return true;
    if (picked === maxPick) return false;
    for (let i = start; i < items.length; i += 1) {
      if (search(i + 1, picked + 1, sum + value(items[i]))) return true;
    }
    return false;
  };
  return search(0, 0, 0);
}

/** 날짜 ±days 안의 항목을 [{ item, dd }]로 — 날짜별로 묶어 두고 같은 질문은 다시 계산하지 않는다 */
function nearByDate(items) {
  const byDate = groupBy(items, it => it.date);
  const cache = new Map();
  return (date, days) => {
    const k = `${date}|${days}`;
    if (!cache.has(k)) {
      const out = [];
      for (let d = -days; d <= days; d += 1) {
        (byDate.get(addDays(date, d)) || []).forEach(item => out.push({ item, dd: Math.abs(d) }));
      }
      cache.set(k, out);
    }
    return cache.get(k);
  };
}

/** 이 결제수단(otherMethods면 다른 결제수단 전부)의 기간 거래 */
function ledgerFor(db, paymentMethod, from, to, { otherMethods = false } = {}) {
  const res = db.exec(
    `SELECT * FROM transactions
     WHERE payment_method ${otherMethods ? '!=' : '='} ? AND date >= ? AND date <= ? AND COALESCE(is_cash_adjustment, 0) = 0
     ORDER BY date, id`,
    [paymentMethod, from, to]
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

/** 원래 결제를 더 거슬러 찾을 기간·취소일 뒤로 늦게 적은 환불을 찾을 기간 (취소·환불 행이 있을 때만 읽는다) */
export const REFUND_LOOKBACK = 120;
export const LATE_REFUND_DAYS = 30;

/** 읽는 범위 앞쪽(earlier)과 뒤쪽(later)의 이 결제수단 기록을 한 번에 읽는다 — 결제·환불 모두 */
function refundReads(db, paymentMethod, earlierFrom, readFrom, readTo, laterTo) {
  const res = db.exec(
    `SELECT * FROM transactions
     WHERE payment_method = ? AND COALESCE(is_cash_adjustment, 0) = 0
       AND ((date >= ? AND date < ?) OR (date > ? AND date <= ?))
     ORDER BY date, id`,
    [paymentMethod, earlierFrom, readFrom, readTo, laterTo]
  );
  if (!res.length) return { earlier: [], later: [] };
  const { columns, values } = res[0];
  const all = values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
  return { earlier: all.filter(t => t.date < readFrom), later: all.filter(t => t.date > readTo) };
}

/** 카드에만 있는 건을 가계부 추가용 추천으로 */
export function rowSuggestion(db, row, paymentMethod) {
  const trip = row.currency !== 'KRW' ? findTrip(db, row.currency, row.date) : null;
  const eventId = trip ? trip.ev.id : null;
  const cls = classify(db, {
    merchant: row.merchant, detail: row.aiDetail, aiCategory: row.aiCategory, eventId, readSource: 'statement',
  });
  const sources = { date: 'statement', payment_method: 'statement', ...cls.sources };
  if (eventId) sources.event = 'trip';
  return {
    date: row.date,
    merchant: row.merchant,
    detail: cls.detail + (row.isCancel && !/취소|환불/.test(cls.detail) ? ' (취소)' : ''),
    amount: row.amount,
    currency: row.currency,
    foreignAmount: row.amount < 0 ? null : row.foreignAmount,   // 환불 기록에는 외화를 적지 않는다 (예전과 같게)
    rate: trip ? Number(trip.country.exchange_rate) || 0 : 0,
    event_id: eventId,
    eventTitle: trip ? trip.ev.title : '',
    payment_method: paymentMethod,
    paymentHint: '',
    budget_category: cls.budget_category,
    sub_category: cls.sub_category,
    items: [],
    historyDetail: cls.history?.detail || '',
    historyCount: cls.history?.cnt || 0,
    confidence: 'high',
    warnings: [],
    sources,
  };
}

/**
 * 대조 한 번 동안 같은 읽기 쿼리를 다시 하지 않는 db — "가계부에 없음" 행마다 분류 추천(classify)이
 * 입력 습관·카테고리 목록을 읽으므로, 행이 많으면 같은 쿼리가 수백 번 돈다.
 * 읽기 전용으로만 쓴다 (쓰기는 원래 db로).
 */
function cachedReads(db) {
  const cache = new Map();
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'exec') {
        return (sql, params) => {
          const key = `${sql}\u0000${JSON.stringify(params || [])}`;
          if (!cache.has(key)) cache.set(key, target.exec(sql, params));
          return cache.get(key);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * 카드 행 목록과 가계부를 비교한다.
 * 반환: { period, matched, grouped, mismatched, missing, notOnCard, cancelled }
 *   grouped:    [{ kind: 'split' | 'merged' | 'mixed' | 'partialCancel', rows, txs }] — 나눠 적음 / 합쳐 적음 / 둘 다 /
 *               부분취소 반영(rows = 결제 행들 + 취소 행, 카드 − 취소 = 가계부) — 합계가 같아 일치로 본다
 *   mismatched: [{ rows, txs, cardTotal, ledgerTotal, namelessNear, cautions, fixable }] — fixable(txs가 1건이고
 *               cautions가 없음)일 때만 카드 금액(합계)으로 고치기를 권한다.
 *               cautions: 'nameless' | 'installment'(할부) | 'outsideRange'(행 날짜로 정한 범위 밖 기록)
 *                         | 'partialCancel'(카드에서 일부 취소된 결제, partialCancelRow)
 *               namelessNear: 차이와 합이 같은 근처 짝 없는 기록
 *               (가게 이름 없이 적은 것, 기간 밖에 적은 같은 가게 것 — 나눠 적은 나머지일 수 있음)
 *   matched:    [{ row, tx, dayDiff, nameDiffers }] — nameDiffers: 가게 이름이 다른 같은 금액 짝 (⑤, 환불)
 *   missing:    [{ row, suggestion, autoCheck, cautions, similarTx, otherTx, refundOf, partialOf, partialOfRow,
 *                  partialCancelRow, partialCancelRows }]
 *               partialOfRow: 금액이 다른 취소 행의 카드 승인, partialCancelRows: 승인 행의 (아직 쓰이지 않은) 부분취소들
 *               (partialCancelRow는 그 첫 행) — 승인과 취소가 모두 "가계부에 없음"이면 함께 체크한다
 *               cautions: 'duplicate'(두 번 읽힘) | 'period'(명세서 기간 밖) | 'installment'(할부)
 *                         | 'otherMethod'(다른 결제수단으로 적음) | 'similar'(비슷한 기록 있음)
 *                         | 'noOriginal'(환불인데 원래 결제 기록이 없음 — 지웠을 수 있음)
 *                         | 'partialRefund'(같은 가게의 더 큰 결제가 있음 — 부분취소일 수 있음, partialOf)
 *                         | 'manyOriginals'(같은 가게·같은 금액 결제가 여러 번 — 어느 결제의 환불인지 모름)
 *                         | 'partialCheck'(부분취소인데 카드 승인이 가계부와 금액이 다름) | 'partialCancelled'(부분취소된 승인 — 함께 확인)
 *                         | 'partialRecorded'(부분취소, 카드 승인은 가계부에 원래 금액으로 있음 — 지난 결제의 환불일 수도)
 *                         | 'cancelDup'(같은 금액 취소가 두 줄 — 이 결제의 취소일 수 있음)
 *               — 하나라도 있으면 미리 체크하지 않는다 (이미 적은 건을 또 추가하지 않게)
 *               refundOf: 환불 행의 원래 결제 기록 (안내만 — 추가하면 합계가 맞는다)
 *   cancelled:  [{ approval, cancel, tx, maybeTx, outsidePeriod, doubtTx }] — tx가 있으면 "가계부에서 삭제" 추천,
 *               maybeTx는 확실하지 않은 삭제 후보 (권하지 않고 확인만), doubtTx는 그렇게 본 근거인 기간 밖 같은 금액 환불 기록
 *
 * 짝짓는 순서 — 확실한 것부터 해서, 앞 단계가 뒤 단계의 짝을 빼앗지 않게 한다:
 *   ①② 같은 가게·같은 금액 1:1, 같은 가게 묶음(여러 건의 합이 정확히 같음) — 같은 날 먼저, 그다음 ±1일
 *   ③ 같은 가게·±N일·같은 금액 1:1
 *   ④ 취소된 승인 건 — 남은 거래 중 같은 가게·±1일·기간 안·같은 금액 (→ "가계부에서 삭제" 추천)
 *   ⑤ 다른 가게·±1일·같은 금액 1:1 — ⑥에서 쓸 같은 가게 카드 건·거래는 빼고
 *   ⑥ 같은 가게·±1일인데 금액이 다름
 * 다른 가게·2~N일 차이·같은 금액은 짝짓지 않고 "가계부에 없음"에서 비슷한 기록으로 알린다.
 */
export function reconcileStatement(db, { paymentMethod, rows, periodFrom, periodTo, toleranceDays = TOLERANCE_DAYS }) {
  const dates = rows.map(r => r.date).sort();
  // 기간을 못 읽었으면 할부 표시가 없는 행 날짜로 범위를 정한다 — 할부 원거래 행(몇 달 전)까지 넣으면 그 사이 기록이
  // 모두 "카드에 없음"이 된다. 가계부는 아래에서 모든 행 날짜를 덮게 읽는다
  //   (시작만 — 맨 끝 행이 새 할부 결제일 수 있으니 끝은 모든 행으로 정한다)
  const plainDates = rows.filter(r => !r.installment).map(r => r.date).sort();
  const from = periodFrom || plainDates[0] || dates[0] || '';
  const to = periodTo || dates[dates.length - 1] || '';
  const empty = { period: { from, to }, matched: [], grouped: [], mismatched: [], missing: [], notOnCard: [], cancelled: [] };
  if (!from || !to) return empty;
  const inPeriod = d => d >= from && d <= to;
  // 명세서에 기간이 적혀 있는지 — 못 읽었으면 행 날짜로 범위를 정한다 (일부만 캡처했을 수 있음)
  const explicitPeriod = !!(periodFrom && periodTo);

  // 가계부는 명세서 기간과 카드 행 날짜를 모두 덮게 읽는다 — 할부 원거래일·기간을 잘못 읽은 행도 비교되게.
  // ("카드에 없음"은 명세서 기간 안의 거래만)
  const lo = dates.length && dates[0] < from ? dates[0] : from;
  const hi = dates.length && dates[dates.length - 1] > to ? dates[dates.length - 1] : to;
  const readFrom = addDays(lo, -Math.max(toleranceDays, SIMILAR_DAYS));
  const readTo = addDays(hi, Math.max(toleranceDays, SIMILAR_DAYS));
  const ledger = ledgerFor(db, paymentMethod, readFrom, readTo);
  // 다른 결제수단(카카오페이 등)으로 적은 같은 결제 — 짝짓지는 않고 "가계부에 없음"을 미리 체크하지 않는 데만 쓴다
  const others = ledgerFor(db, paymentMethod, readFrom, readTo, { otherMethods: true });
  // 취소·환불 행이 있을 때만 한 번 더 읽는다 — 앞으로 REFUND_LOOKBACK일(원래 결제·미리 적은 환불),
  // 마지막 취소일 뒤로 LATE_REFUND_DAYS일(늦게 적은 환불)
  const cancelDates = rows.filter(r => r.isCancel).map(r => r.date).sort();
  const extra = cancelDates.length
    ? refundReads(db, paymentMethod, addDays(readFrom, -REFUND_LOOKBACK), readFrom, readTo,
      addDays(cancelDates[cancelDates.length - 1], LATE_REFUND_DAYS))
    : { earlier: [], later: [] };
  // 이름 비교 재료·날짜 색인은 한 번만 만든다 — 화면을 그릴 때 계산하므로 행×거래마다 DB를 읽지 않는다
  const rowName = new Map(rows.map(r => [r.id, merchantInfo(r.merchant)]));
  const txName = new Map([...ledger, ...others, ...extra.earlier, ...extra.later].map(t => [t.id, merchantInfo(t.detail)]));
  // AI가 입력 습관에서 고른 세부내역(aiDetail)은 가게 이름 별칭 — 짝짓기에는 SIMILAR로만 쓴다 (금액이 정확히 같을 때만 근거,
  // 금액 차이 수정 판정에는 쓰지 않음). "점심"·"장보기" 같은 일반어 표기는 별칭으로 보지 않는다
  const pairAlias = new Map(rows.map(r => {
    if (!r.aiDetail) return [r.id, null];
    const al = merchantInfo(r.aiDetail);
    const generic = GENERIC_HEADS.has(al.raw) || GENERIC_HEADS.has(al.head);
    return [r.id, al.raw === rowName.get(r.id).raw || generic ? null : al];
  }));
  const nameLevel = (row, tx) => merchantLevel(rowName.get(row.id), txName.get(tx.id));   // 별칭 없이 가게 이름만
  const levelOf = (row, tx) => {
    const level = nameLevel(row, tx);
    if (level) return level;
    const al = pairAlias.get(row.id);
    return al && merchantLevel(al, txName.get(tx.id)) > 0 ? SIMILAR : 0;
  };
  const txsNear = nearByDate(ledger);
  const othersNear = nearByDate(others);
  const listOrder = new Map(rows.map((r, i) => [r.id, i]));
  const byStatement = (a, b) => listOrder.get(a.id) - listOrder.get(b.id);
  const txOrder = new Map(ledger.map((t, i) => [t.id, i]));
  const byLedger = (a, b) => txOrder.get(a.id) - txOrder.get(b.id);

  // 겹친 캡처에서 같은 결제가 두 번 읽혔을 수 있는 행 — 날짜·가게·금액이 같은 행의 두 번째부터 (copyOf: 복사본 → 첫 행).
  // 같은 날 같은 결제를 정말 두 번 했을 수도 있으니 지우지 않고, 대조할 때 첫 행보다 뒤로 미룬다 (아래 deferred)
  //   이름은 한쪽이 다른 쪽을 포함하면 같은 것으로 본다 (겹친 부분에서 "스타벅스 성수역점"이 "스타벅스 성수역"으로 잘려 읽힘)
  const copyOf = new Map();
  const firsts = [];
  const sameReading = (a, b) => {
    const x = rowName.get(a.id);
    const y = rowName.get(b.id);
    if (!x.raw || !y.raw) return a.merchant === b.merchant;
    return x.raw.includes(y.raw) || y.raw.includes(x.raw);
  };
  rows.forEach(r => {
    const first = firsts.find(f => f.date === r.date && f.amount === r.amount && sameReading(f, r));
    if (first) copyOf.set(r.id, first);
    else firsts.push(r);
  });
  const extraCopy = new Set(copyOf.keys());

  const usedRows = new Set();
  const usedTx = new Set();
  const matched = [];
  const grouped = [];
  const mismatched = [];
  const take = (row, tx, dd, level) => {
    usedRows.add(row.id);
    usedTx.add(tx.id);
    matched.push({ row, tx, dayDiff: dd, nameDiffers: level === 0 });
  };

  // 가게 이름 없는 기록 ("점심", "장보기", "반품 환불") — 근처 어느 카드 행의 가게와도 이름이 닿지 않는 거래
  const allRowsNear = nearByDate(rows);
  const nameless = new Set(ledger
    .filter(t => !allRowsNear(t.date, SIMILAR_DAYS).some(({ item: r }) => levelOf(r, t) > 0))
    .map(t => t.id));

  // 취소·환불 행
  //   1) 가계부에 적어 둔 환불 — 같은 금액 음수 거래. 이름이 닿는 것을 먼저, 그다음 가게 이름 없이("반품 환불") 읽는 범위
  //      안에 적은 것을 정한다 → 승인 삭제를 권하지 않는다. 단계마다 모든 취소 행의 후보를 모아 날짜 차이가 작은 짝부터
  //      정한다 (취소 행 순서대로 고르면 먼저 오는 다른 취소가 가까운 짝의 기록을 가져간다).
  //      명세서 기간 밖 기록(앞·뒤)은 취소일과 그 기록 사이에 같은 가게·같은 금액 결제가 없을 때만 — 있으면 그 결제의 환불이다
  //      (앞뒤 명세서에서 이미 짝지은 환불이 이번 달 빠뜨린 환불을 가리지 않게).
  //      늦게 적은 환불(읽는 범위 뒤 ~ 취소일 + LATE_REFUND_DAYS일)은 이름이 닿고, 취소 전에 같은 가게·같은 금액 결제 기록이
  //      있을 때만 (결제를 지운 사람은 환불도 적지 않는다)
  //   2) 없으면 카드 안의 승인과 짝 — 가계부에 둘 다 없으면 서로 상쇄되므로 비교에서 뺀다.
  //      취소일 이전 승인 중 같은 가게 것, 그중 이름이 똑같은 것, 그다음 가장 최근 것.
  //      가맹점명을 못 읽은 취소 건은 아무 승인과 짝짓지 않는다.
  const cancelRows = rows.filter(r => r.isCancel && !extraCopy.has(r.id))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byStatement(a, b)));
  // 카드 안에 이 취소의 승인 행이 있으면, 승인 전날보다 앞선 환불 기록은 다른(지난) 환불의 것이다
  const notBeforeOf = new Map(cancelRows.map(c => {
    const cn = rowName.get(c.id);
    const ownApproval = rows
      .filter(r => !r.isCancel && r.amount === -c.amount && r.date <= c.date && merchantLevel(rowName.get(r.id), cn) === SAME)
      .map(r => r.date).sort()[0];
    return [c.id, ownApproval ? addDays(ownApproval, -GROUP_DAYS) : ''];
  }));
  const purchaseOf = (c, p) => gross(p) === -c.amount && levelOf(c, p) > 0;
  const allRead = [...extra.earlier, ...ledger, ...extra.later];
  // 취소일과 기록 사이에 같은 가게·같은 금액 결제가 또 있음 — 그 기록은 그 결제의 환불일 수 있다
  //   뒤쪽 기록: 취소일 다음 날 ~ 기록 날짜(그날 결제하고 그날 환불을 적은 경우 포함)
  //   앞쪽 기록: 기록 날짜 ~ 취소 전날 (그 결제가 이 취소의 결제라면, 결제 전이나 결제한 날 적힌 환불은 이 취소의 것일 수 없다)
  const purchaseBetween = (c, t) => (t.date > c.date
    ? allRead.some(p => purchaseOf(c, p) && p.date > c.date && p.date <= t.date)
    : allRead.some(p => purchaseOf(c, p) && p.date >= t.date && p.date < c.date));
  const inRead = t => t.date >= readFrom && t.date <= readTo;
  const outsideStatement = t => (explicitPeriod && !inPeriod(t.date)) || !inRead(t);
  const lateOk = (c, t) => t.date <= addDays(c.date, LATE_REFUND_DAYS)
    && [...ledger, ...extra.earlier].some(p => purchaseOf(c, p) && p.date <= addDays(c.date, GROUP_DAYS)
      && p.date >= addDays(c.date, -REFUND_LOOKBACK));
  const refundOk = (c, t, level) => (inRead(t) ? level >= 0 : level > 0 && lateOk(c, t))
    && (!outsideStatement(t) || !purchaseBetween(c, t));
  const refundCands = (c, ok) => {
    const notBefore = notBeforeOf.get(c.id);
    return [...ledger, ...extra.later].filter(t => !usedTx.has(t.id) && gross(t) === c.amount && t.date >= notBefore)
      .map(t => ({ c, t, level: levelOf(c, t), dd: dayDiff(c.date, t.date) }))
      .filter(x => ok(x) && refundOk(c, x.t, x.level));
  };
  const claimAll = ok => cancelRows.filter(c => !usedRows.has(c.id)).flatMap(c => refundCands(c, ok))
    .sort((a, b) => a.dd - b.dd || byStatement(a.c, b.c))
    .forEach(x => { if (!usedRows.has(x.c.id) && !usedTx.has(x.t.id)) take(x.c, x.t, x.dd, x.level); });
  claimAll(x => x.level > 0);
  claimAll(x => x.level === 0 && inRead(x.t) && nameless.has(x.t.id));
  // 같은 금액 환불 기록(같은 가게, 또는 읽는 범위 안의 가게 이름 없는 것)이 기간 밖에 있는데 짝짓지 않은 취소 —
  // 사이 결제에 막혔거나, 카드의 같은 금액 승인보다 앞서 적혀 있어(지난 기간 결제를 미리 적은 환불일 수 있음) 뺀 것.
  // 그 기록이 이 취소의 것일 수도 있으니 승인 기록 삭제는 권하지 않고 확인만 띄운다 (아래 ④에서 maybeTx)
  const doubtfulCancel = new Map();   // 취소 행 id → 그 근거인 환불 기록 (화면의 확인 안내에 보여 준다)
  cancelRows.filter(c => !usedRows.has(c.id)).forEach(c => {
    const t = [...ledger, ...extra.later].find(x => !usedTx.has(x.id) && gross(x) === c.amount
      && outsideStatement(x) && (levelOf(c, x) > 0 || (inRead(x) && nameless.has(x.id) && x.date >= notBeforeOf.get(c.id))));
    if (t) doubtfulCancel.set(c.id, t);
  });
  const pairedApproval = new Map();   // approval row id → cancel row
  const pairedCancel = new Set();
  cancelRows.filter(c => !usedRows.has(c.id)).forEach(c => {
    const cn = rowName.get(c.id);
    if (cn.raw.length < 2) return;
    const sameName = r => (rowName.get(r.id).raw === cn.raw ? 1 : 0);
    const approval = rows
      .filter(r => !r.isCancel && !extraCopy.has(r.id) && !pairedApproval.has(r.id) && r.amount === -c.amount
        && r.date <= c.date && merchantLevel(rowName.get(r.id), cn) === SAME)
      .sort((a, b) => sameName(b) - sameName(a) || (a.date > b.date ? -1 : a.date < b.date ? 1 : byStatement(a, b)))[0];
    if (!approval) return;
    pairedApproval.set(approval.id, c);
    pairedCancel.add(c.id);
  });
  const isApproval = r => pairedApproval.has(r.id);
  // 지난 기간 결제의 환불 — 카드에 승인이 없는 취소 행의 원래 결제 기록(기간 전·같은 가게·같은 금액)은
  // 다른 카드 건이 가져가지 않게 묶어 둔다 (그 기록은 지난 명세서의 것이고, 환불 행을 추가하면 합계가 맞는다)
  const originalOf = new Map();   // 취소 행 id → 원래 결제 기록
  rows.filter(r => r.isCancel && !usedRows.has(r.id) && !pairedCancel.has(r.id) && !extraCopy.has(r.id)).forEach(c => {
    const orig = ledger
      .filter(t => !usedTx.has(t.id) && t.date < from && t.date <= c.date && gross(t) === -c.amount && levelOf(c, t) > 0)
      .sort((a, b) => (a.date > b.date ? -1 : 1))[0];
    if (!orig) return;
    usedTx.add(orig.id);
    originalOf.set(c.id, orig);
  });
  // 금액이 다른 취소(취소 수수료를 뗀 취소·여러 개 주문 중 일부 취소·해외결제 환율 차이) — 카드 안의 같은 가게 승인과 짝지어 둔다.
  //   원화: 취소일 이전의 더 큰 승인, 외화: 같은 통화·같은 외화 금액의 승인 (원화 금액은 환율 차이로 다를 수 있다),
  //   한쪽이라도 해외결제면 원화 ±10% 안의 취소도 (외화 금액을 한쪽에서만 읽었고 환율이 올라 취소 원화가 더 큰 경우).
  //   한 승인이 여러 번 나눠 취소될 수 있다 — 취소 합이 승인보다 작은 동안 같은 승인에 붙인다
  //   그 승인은 보통 결제처럼 대조하고, 결과에서 둘을 함께 다룬다 (승인만 추가되거나 취소만 추가되지 않게).
  //   가계부에 같은 가게·같은 금액 결제(지난 기간 originalOf, 또는 REFUND_LOOKBACK일 안)가 있는 취소는 그 결제의 환불로 본다
  //   (금액이 정확히 맞는 근거가 더 강하다)
  const partialPair = new Map();         // 취소 행 id → 승인 행
  const partialOfApproval = new Map();   // 승인 행 id → [취소 행]
  const exactOriginal = c => [...ledger, ...extra.earlier].some(t => !usedTx.has(t.id) && gross(t) === -c.amount && t.date <= c.date
    && t.date >= addDays(c.date, -REFUND_LOOKBACK) && levelOf(c, t) > 0);
  cancelRows.filter(c => !usedRows.has(c.id) && !pairedCancel.has(c.id) && !originalOf.has(c.id) && !exactOriginal(c)).forEach(c => {
    const cn = rowName.get(c.id);
    if (cn.raw.length < 2) return;
    const sameFx = r => c.foreignAmount !== null && r.currency === c.currency && r.foreignAmount === c.foreignAmount;
    const sameName = r => (rowName.get(r.id).raw === cn.raw ? 1 : 0);
    const taken = r => sumOf(partialOfApproval.get(r.id) || [], x => -x.amount);
    const fits = r => {
      if (sameFx(r)) return !partialOfApproval.has(r.id);
      if (r.amount > taken(r) - c.amount) return true;   // 남은 금액이 이 취소보다 크다
      return !partialOfApproval.has(r.id) && (r.currency !== 'KRW' || c.currency !== 'KRW') && fxClose(r.amount, -c.amount);
    };
    const approval = rows
      .filter(r => !r.isCancel && !extraCopy.has(r.id) && !pairedApproval.has(r.id)
        && r.date <= c.date && merchantLevel(rowName.get(r.id), cn) === SAME && fits(r))
      .sort((a, b) => Number(sameFx(b)) - Number(sameFx(a)) || sameName(b) - sameName(a)
        || (a.date > b.date ? -1 : a.date < b.date ? 1 : byStatement(a, b)))[0];
    if (!approval) return;
    partialPair.set(c.id, approval);
    partialOfApproval.set(approval.id, [...(partialOfApproval.get(approval.id) || []), c]);
  });
  const liveCancelsOf = r => (partialOfApproval.get(r.id) || []).filter(c => !usedRows.has(c.id));
  // 복사본은 첫 행이 짝을 다 찾은 뒤에 본다 (deferred) — 1:1 짝(①③⑤)에는 끼지 않고, 합이 정확한 묶음(②)과
  // 합이 다른 덩어리(⑥)에서 차이를 줄일 때만 붙고, 남으면 같은 결제의 기록이 하나 더 있을 때만 짝짓는다.
  // 단, 첫 행이 취소된 승인이면 복사본은 보통 결제로 본다 — 같은 날 취소하고 다시 산 경우를 지키기 위해
  // (두 번 읽힌 것이면 화면에서 "취소된 결제"에 확인을 띄운다 → maybeTx)
  const deferred = new Set([...copyOf].filter(([, first]) => !isApproval(first)).map(([id]) => id));
  const comparable = rows.filter(r => !pairedCancel.has(r.id) && !deferred.has(r.id));
  const liveCopies = rows.filter(r => deferred.has(r.id) && !r.isCancel);
  const rowsNear = nearByDate(comparable);
  const copiesNear = nearByDate(liveCopies);
  const freeRow = r => !usedRows.has(r.id) && !r.isCancel && !isApproval(r);
  const freeTx = t => !usedTx.has(t.id) && gross(t) > 0;

  // 같은 금액 1:1 후보 — 날짜가 가까운 것, 같은 가게인 것 먼저.
  // 취소된 승인 건은 ①②③에서 짝짓지 않고 ④에서 남은 거래와만 짝짓는다
  const exact = [];
  // 명세서에 기간이 적혀 있으면, 기간 안 카드 건은 기간 밖 기록(앞뒤 명세서의 것)과 짝짓지 않는다 —
  // 지난 대조에서 이미 맞은 기록이 이번 달에 빠진 결제를 가리거나, 그 기록을 고치라고 하지 않게.
  // 그런 기록은 "비슷한 기록(기간 밖)"으로만 알린다.
  const neighborOf = (row, tx) => explicitPeriod && inPeriod(row.date) && !inPeriod(tx.date);
  // 기간을 행 날짜로 정했으면(일부만 캡처했을 수 있음) 범위 밖 기록(행과 같은 날일 수 없음)도 1:1·묶음으로 짝짓지 않는다 —
  // 캡처에 없는 다른 결제의 기록이 이번에 빠진 결제를 가릴 수 있다. 금액이 다른 같은 가게 기록은 ⑥에서 금액 차이로 보이되
  // 고치기를 권하지 않는다 ('outsideRange')
  const outsideRange = (row, tx) => !explicitPeriod && inPeriod(row.date) && !inPeriod(tx.date);
  const awayFrom = (row, tx) => neighborOf(row, tx) || outsideRange(row, tx);
  comparable.forEach(row => {
    txsNear(row.date, toleranceDays).forEach(({ item: tx, dd }) => {
      if (awayFrom(row, tx)) return;
      if (amountMatches(row, tx)) exact.push({ row, tx, dd, level: levelOf(row, tx) });
    });
  });
  // 날짜 차이·가게가 같으면 다른 후보가 적은 쪽이 먼저 고른다 (후보가 많은 쪽이 하나뿐인 쪽의 짝을 빼앗지 않게)
  const optionsOfRow = new Map();
  const optionsOfTx = new Map();
  exact.forEach(c => {
    if (c.level === 0) return;
    optionsOfRow.set(c.row.id, (optionsOfRow.get(c.row.id) || 0) + 1);
    optionsOfTx.set(c.tx.id, (optionsOfTx.get(c.tx.id) || 0) + 1);
  });
  const options = c => (optionsOfRow.get(c.row.id) || 0) + (optionsOfTx.get(c.tx.id) || 0);
  exact.sort((a, b) => a.dd - b.dd || b.level - a.level || options(a) - options(b));
  const pairExact = accept => exact.forEach(c => {
    if (usedRows.has(c.row.id) || usedTx.has(c.tx.id) || !accept(c)) return;
    take(c.row, c.tx, c.dd, c.level);
  });
  // 취소된 승인 건이 가져갈 수 있는 거래 — 확실히 같은 가게·±1일·같은 금액.
  // 명세서 기간 밖이어도 ±1일이면 보여 준다 (기간 첫날 결제를 전날로 적은 경우) — 화면에 "기간 밖"으로 표시
  const approvalFits = c => isApproval(c.row) && c.dd <= GROUP_DAYS && c.level === SAME;

  // ①② 같은 가게 — 같은 날을 먼저 다 보고, 그다음 ±1일 (하루 차이 1:1이 같은 날 나눠 적은 몫을 가져가지 않게)
  //   ① 같은 금액 1:1
  //   ② 묶음: 여러 건의 합이 정확히 같으면 맞게 적은 것
  //      나눠 적음: 카드 1건 = 가계부 여러 건 (예: 이마트 50,000 → 식비 30,000 + 생활용품 20,000)
  //      합쳐 적음: 카드 여러 건 = 가계부 1건 (예: 커피 4,500 두 번 → 9,000 한 번)
  for (let days = 0; days <= GROUP_DAYS; days += 1) {
    pairExact(c => !isApproval(c.row) && c.dd <= days && c.level > 0);
    [...comparable, ...liveCopies].filter(freeRow).forEach(row => {
      const pool = txsNear(row.date, days).map(n => n.item).filter(t => freeTx(t) && !awayFrom(row, t) && levelOf(row, t) > 0);
      const txs = findCombination(pool, gross, row.amount) || findCombination(pool, net, row.amount);
      if (!txs) return;
      usedRows.add(row.id);
      txs.forEach(t => usedTx.add(t.id));
      grouped.push({ kind: 'split', rows: [row], txs });
    });
    ledger.filter(freeTx).forEach(tx => {
      // 두 번 읽혔을 수 있는 복사본은 같은 날 기록에만 합친다 (두 잔을 한 번에 적는 건 그날이다)
      const pool = [...rowsNear(tx.date, days), ...copiesNear(tx.date, 0)].map(n => n.item)
        .filter(r => freeRow(r) && !awayFrom(r, tx) && levelOf(r, tx) > 0);
      const picked = findCombination(pool, r => r.amount, gross(tx))
        || (net(tx) !== gross(tx) ? findCombination(pool, r => r.amount, net(tx)) : null);
      if (!picked) return;
      usedTx.add(tx.id);
      picked.forEach(r => usedRows.add(r.id));
      grouped.push({ kind: 'merged', rows: picked.sort(byStatement), txs: [tx] });
    });
  }

  // ③ 같은 가게·±N일·같은 금액 — 취소된 승인 건(±1일)의 기록일 수 있는 거래는 건드리지 않는다
  const approvalTx = new Set(exact.filter(approvalFits).map(c => c.tx.id));
  pairExact(c => !isApproval(c.row) && c.level > 0 && !approvalTx.has(c.tx.id));

  // ④ 취소된 승인 건 — 살아 있는 결제의 확실한 짝(①②③)을 정한 뒤 남은 거래하고만 짝짓는다.
  //    먼저 짝지으면 살아 있는 결제의 기록을 가져가, 지운 뒤 다시 대조하면 또 지우라고 한다.
  //    ⑤⑥보다는 먼저 — 금액 오타 덩어리나 다른 가게 건이 승인 기록을 가져가지 않게.
  //    맞는 기록이 둘 이상이면 어느 것이 취소된 결제인지 모른다 (지난 기간 결제의 환불일 수도 있다) —
  //    삭제를 권하지 않고 확인만 띄운다 (maybeTx). 권하면 지운 뒤 다시 대조할 때 나머지도 지우라고 한다.
  //    그 기록을 아직 짝 없는 살아 있는 같은 가게 카드 건도 같은 금액으로 노리면(날짜를 며칠 밀려 적은 결제) 역시 확인만.
  const ambiguousFit = new Map();   // 승인 행 id → 가장 가까운 후보 기록
  const wantedByLive = tx => exact.some(c => c.tx === tx && !isApproval(c.row) && !usedRows.has(c.row.id) && c.level > 0)
    || liveCopies.some(r => !usedRows.has(r.id) && amountMatches(r, tx) && levelOf(r, tx) > 0 && dayDiff(r.date, tx.date) <= toleranceDays);
  rows.filter(isApproval).forEach(a => {
    // 후보는 기간 밖 기록까지 본다 — 기간 밖 기록(앞뒤 명세서의 것일 수 있음)이 있으면 권하지 않고 확인만
    const fits = txsNear(a.date, GROUP_DAYS)
      .filter(({ item: t }) => !usedTx.has(t.id) && amountMatches(a, t) && levelOf(a, t) === SAME)
      .sort((x, y) => x.dd - y.dd);
    const doubtful = doubtfulCancel.has(pairedApproval.get(a.id).id);
    if (fits.length === 1 && inPeriod(fits[0].item.date) && !wantedByLive(fits[0].item) && !doubtful) take(a, fits[0].item, fits[0].dd, SAME);
    else if (fits.length) ambiguousFit.set(a.id, fits[0].item);
  });
  //    남은 게 없을 때: 같은 가게·같은 금액 살아 있는 카드 건이 그 거래를 가져갔는데, 그 카드 건 옆(±1일)에
  //    아직 짝 없는 같은 가게 기록이 있으면 그것이 살아 있는 결제의 기록(나눠 적음·금액 오타)이다.
  //    → 그 거래는 승인 기록으로 돌리고, 살아 있는 카드 건은
  //      · 남은 기록 몇 건의 합이 정확히 맞으면 바로 "나눠 적음"으로 묶고
  //      · 아니면 다른 카드 건이 노리지 않는 기록이 있을 때만 풀어 ⑤⑥에서 다시 짝짓는다
  const claimedByOther = (t, live) => rowsNear(t.date, GROUP_DAYS)
    .some(({ item: r }) => r.id !== live.id && freeRow(r) && levelOf(r, t) === SAME);
  exact.filter(approvalFits).forEach(c => {
    if (usedRows.has(c.row.id) || !usedTx.has(c.tx.id) || doubtfulCancel.has(pairedApproval.get(c.row.id).id)) return;
    const k = matched.findIndex(m => m.tx.id === c.tx.id && !isApproval(m.row) && m.row.amount === c.row.amount
      && merchantLevel(rowName.get(m.row.id), rowName.get(c.row.id)) === SAME);
    if (k < 0) return;
    const live = matched[k].row;
    const spares = txsNear(live.date, GROUP_DAYS).map(n => n.item)
      .filter(t => freeTx(t) && !awayFrom(live, t) && levelOf(live, t) === SAME);   // 앞뒤 명세서의 기록은 몫이 아니다
    const parts = findCombination(spares, gross, live.amount);
    if (!parts && !spares.some(t => !claimedByOther(t, live))) return;
    matched.splice(k, 1);
    if (parts) {
      parts.forEach(t => usedTx.add(t.id));
      grouped.push({ kind: 'split', rows: [live], txs: parts.sort(byLedger) });
    } else {
      usedRows.delete(live.id);
    }
    usedRows.add(c.row.id);
    matched.push({ row: c.row, tx: c.tx, dayDiff: c.dd, nameDiffers: false });
  });
  //    승인 건이 가져가지 않은 거래는 다시 ③에 쓸 수 있다
  pairExact(c => !isApproval(c.row) && c.level > 0);

  // 남은 복사본 — 같은 날 같은 결제가 정말 두 번이었으면 남은 같은 가게·같은 금액 기록과 짝짓는다
  // (⑤⑥보다 먼저 — 그 기록이 다른 카드 건의 금액 차이 덩어리로 들어가 고쳐지지 않게)
  rows.filter(r => deferred.has(r.id) && !usedRows.has(r.id)).forEach(row => {
    const hit = txsNear(row.date, toleranceDays)
      .filter(({ item: t }) => !usedTx.has(t.id) && !awayFrom(row, t) && amountMatches(row, t) && levelOf(row, t) > 0)
      .sort((a, b) => a.dd - b.dd)[0];
    if (hit) take(row, hit.item, hit.dd, SAME);
  });

  // 기간 밖에 같은 가게·같은 금액 기록이 있는 기간 안 카드 건 — 경계를 넘겨 날짜를 적은 그 결제일 수 있다.
  // 짝짓지는 않지만(앞 명세서의 기록일 수도) 다른 가게 기록과 짝짓거나 다른 짝에 덧붙여 합계로 고치지도 않는다
  // (금액 차이 덩어리에서 1:1 짝은 될 수 있다) → 남으면 "비슷한 기록(기간 밖)"
  const boundaryTx = new Map();   // 경계 행 id → 그 기간 밖 같은 가게·같은 금액 기록
  rows.forEach(r => {
    if (usedRows.has(r.id)) return;
    const hit = txsNear(r.date, toleranceDays).find(({ item: t }) => !usedTx.has(t.id) && (neighborOf(r, t) || outsideRange(r, t))
      && amountMatches(r, t) && levelOf(r, t) > 0);
    if (hit) boundaryTx.set(r.id, hit.item);
  });
  const boundaryRow = new Set(boundaryTx.keys());

  // 같은 가게·±1일 카드 건과 가계부 건을 이어 붙인 덩어리 (⑥의 재료).
  //   잇는 기준은 SAME이고, SIMILAR 가계부 건은 이미 있는 덩어리에 덧붙이기만 한다
  //   (그래야 SIMILAR 건이 다른 가게 짝으로 빠지고 남은 한 건에만 수정 버튼이 붙는 일이 없다)
  const sameShopClusters = () => {
    const links = [];
    const similar = [];
    [...comparable, ...liveCopies].filter(freeRow).forEach(row => {
      const copy = deferred.has(row.id);   // 복사본은 덩어리에 붙기만 한다 (pairUp의 1:1 짝은 되지 않음)
      const boundary = boundaryRow.has(row.id);   // 경계 행은 1:1 짝만 되고 남은 행으로 붙지 않는다
      txsNear(row.date, GROUP_DAYS).forEach(({ item: tx, dd }) => {
        if (!freeTx(tx) || neighborOf(row, tx)) return;   // 앞뒤 명세서의 기록은 금액 수정 대상으로 묶지 않는다
        // 행 날짜로 정한 범위 밖의 같은 금액 기록은 묶지 않는다 (묶으면 합이 같아 "일치"가 된다)
        if (outsideRange(row, tx) && amountMatches(row, tx)) return;
        const level = levelOf(row, tx);
        if (level === SAME) links.push({ row, tx, dd, copy, boundary });
        else if (level === SIMILAR) similar.push({ row, tx, dd, similar: true, copy, boundary });
      });
    });
    const byRow = groupBy(links, e => e.row.id);
    const byTx = groupBy(links, e => e.tx.id);
    const rowCluster = new Map();
    const txCluster = new Map();
    const clusters = [];
    links.forEach(start => {
      if (rowCluster.has(start.row.id)) return;
      const cl = { rows: [start.row], txs: [], links: [] };
      clusters.push(cl);
      rowCluster.set(start.row.id, cl);
      const todo = [{ row: start.row }];
      while (todo.length) {
        const { row, tx } = todo.pop();
        if (row) {
          byRow.get(row.id).forEach(e => {
            if (txCluster.has(e.tx.id)) return;
            txCluster.set(e.tx.id, cl);
            cl.txs.push(e.tx);
            todo.push({ tx: e.tx });
          });
        } else {
          byTx.get(tx.id).forEach(e => {
            if (rowCluster.has(e.row.id)) return;
            rowCluster.set(e.row.id, cl);
            cl.rows.push(e.row);
            todo.push({ row: e.row });
          });
        }
      }
    });
    links.forEach(e => rowCluster.get(e.row.id).links.push(e));
    similar.sort((a, b) => a.dd - b.dd).forEach(e => {
      const cl = rowCluster.get(e.row.id);
      if (!cl) return;
      if (!txCluster.has(e.tx.id)) {
        txCluster.set(e.tx.id, cl);
        cl.txs.push(e.tx);
      }
      // 짝 나누기(pairUp)에서 어느 카드 건 옆에 있는지 알아야 한다 — 이 덩어리의 거래만
      if (txCluster.get(e.tx.id) === cl) cl.links.push(e);
    });
    return clusters;
  };

  // ⑤ 다른 가게·±1일·같은 금액 — 가계부에 가게 이름 없이("점심") 적은 경우를 위한 짝.
  //    · ⑥에서 같은 가게 금액 차이로 볼 카드 건·거래는 남겨 둔다
  //      (다른 가게 건이 나눠·합쳐 적은 한 몫을 가져가면 남은 몫만 "카드 금액으로 수정"돼 합계가 틀어진다)
  //    · 이 가게 이름으로 적은 기록이 따로 있는 카드 건, 다른 카드 건의 가게 이름으로 적힌 거래는 엮지 않는다
  //      — 이름을 제대로 적는 가게인데 이름이 다르면 같은 결제가 아니다 (다른 카드로 산 것이 "일치"로 숨지 않게)
  const reservedTx = new Set();
  const reservedRows = new Set();
  sameShopClusters().forEach(cl => {
    cl.txs.forEach(t => reservedTx.add(t.id));
    cl.rows.forEach(r => reservedRows.add(r.id));
  });
  //      (가게 이름으로만 본다 — AI 별칭이 닿는 기록이 있다고 다른 표기("배달의민족")와의 같은 금액 짝을 막지 않게)
  rows.forEach(row => txsNear(row.date, toleranceDays).forEach(({ item: t }) => {
    if (nameLevel(row, t) === 0) return;
    reservedRows.add(row.id);
    reservedTx.add(t.id);
  }));
  //    · 같은 금액 후보가 양쪽 다 하나뿐일 때만 — 가게 이름 없는 기록 하나를 두고 같은 금액 카드 건이 둘이면 어느 쪽인지 모른다
  const crossOk = c => c.dd <= GROUP_DAYS && !isApproval(c.row) && !reservedTx.has(c.tx.id) && !reservedRows.has(c.row.id)
    && !boundaryRow.has(c.row.id)
    && !usedRows.has(c.row.id) && !usedTx.has(c.tx.id);
  const crossCands = exact.filter(crossOk);
  const crossCount = key => crossCands.reduce((n, c) => n + (key(c) ? 1 : 0), 0);
  pairExact(c => crossOk(c) && crossCount(x => x.tx === c.tx) === 1 && crossCount(x => x.row === c.row) === 1);

  // ⑥ 금액 차이 — 덩어리마다 정리한다
  const settle = (rs, ts) => {
    rs.sort(byStatement);
    ts.sort(byLedger);
    rs.forEach(r => usedRows.add(r.id));
    ts.forEach(t => usedTx.add(t.id));
    const cardTotal = sumOf(rs, r => r.amount);
    const ledgerTotal = sumOf(ts, gross);
    if (cardTotal === ledgerTotal || cardTotal === sumOf(ts, net)) {
      // 합계가 같으면 건수와 상관없이 맞게 나눠·합쳐 적은 것 (②가 건수 제한으로 놓친 경우)
      if (rs.length === 1 && ts.length === 1) matched.push({ row: rs[0], tx: ts[0], dayDiff: dayDiff(rs[0].date, ts[0].date), nameDiffers: false });
      else grouped.push({ kind: rs.length === 1 ? 'split' : ts.length === 1 ? 'merged' : 'mixed', rows: rs, txs: ts });
    } else {
      mismatched.push({ rows: rs, txs: ts, cardTotal, ledgerTotal });
    }
  };
  sameShopClusters().forEach(cl => {
    // 같은 가게·±1일 덩어리 전체의 합이 같으면 건수와 상관없이 한 묶음
    if (sumsAgree(cl.rows, cl.txs)) { settle(cl.rows, cl.txs); return; }
    // 다르면 가까운 것끼리 짝지어 나눈다 (이틀 연속 같은 가게, 금액 오타 + 빠진 건 등)
    pairUp(cl.links).forEach(p => settle(p.rows, p.txs));
  });

  // 부분취소 — 금액 차이 짝과 같은 날이나 그 뒤에 같은 가게 취소 행이 짝 없이 있고, 카드 − 취소 = 가계부이면 맞게 적은 것
  // (주유 선승인 100,000 → 부분취소 −47,700, 가계부엔 실제 결제액 52,300). 그 취소 행을 추가하라고 하지 않는다
  const looseCancels = rows.filter(r => r.isCancel && !usedRows.has(r.id) && !pairedCancel.has(r.id) && !extraCopy.has(r.id)
    && !originalOf.has(r.id));
  //   한 주문을 여러 번 나눠 취소했으면 같은 가게 취소 2~GROUP_MAX건의 합으로도 본다
  for (let i = mismatched.length - 1; i >= 0 && looseCancels.length; i -= 1) {
    const m = mismatched[i];
    const first = m.rows.map(r => r.date).sort()[0];
    const pool = looseCancels.filter(c => c.date >= first
      && m.rows.some(r => !r.isCancel && merchantLevel(rowName.get(r.id), rowName.get(c.id)) === SAME));
    const cut = [m.cardTotal - m.ledgerTotal, m.cardTotal - sumOf(m.txs, net)].filter(x => x > 0);
    const picked = cut.map(x => pool.find(c => -c.amount === x)).find(Boolean)
      || cut.map(x => findCombination(pool, c => -c.amount, x)).find(Boolean);
    if (!picked) continue;
    const cs = Array.isArray(picked) ? picked : [picked];
    cs.forEach(c => { usedRows.add(c.id); looseCancels.splice(looseCancels.indexOf(c), 1); });
    mismatched.splice(i, 1);
    grouped.push({ kind: 'partialCancel', rows: [...m.rows, ...cs.sort(byStatement)], txs: m.txs });
  }
  //   카드의 승인·취소가 둘 다 남았고 가계부에 순액(승인 − 취소) 기록이 승인일 −N일 ~ 취소일 +N일에 있으면 맞게 적은 것
  //   (KTX 45,000 → 취소 −44,600, 가계부엔 "취소수수료 400"). 같은 가게 기록이거나 가게 이름 없는 기록만
  partialOfApproval.forEach((list, aId) => {
    const a = rows.find(r => r.id === aId);
    const cs = list.filter(c => !usedRows.has(c.id));
    if (usedRows.has(a.id) || !cs.length) return;
    const rest = a.amount + sumOf(cs, c => c.amount);
    const lo = addDays(a.date, -toleranceDays);
    const hi = addDays(cs[cs.length - 1].date, toleranceDays);
    const t = ledger.find(x => !usedTx.has(x.id) && rest > 0 && (gross(x) === rest || net(x) === rest) && x.date >= lo && x.date <= hi
      && (!explicitPeriod || inPeriod(x.date)) && (levelOf(a, x) > 0 || nameless.has(x.id)));
    if (!t) return;
    [a, ...cs].forEach(r => usedRows.add(r.id));
    usedTx.add(t.id);
    grouped.push({ kind: 'partialCancel', rows: [a, ...cs], txs: [t] });
  });

  // 취소 짝 — 같은 가게 승인 건(④)이 가계부에 남아 있으면 알린다 (기간 밖 기록이면 outsidePeriod)
  //   maybeTx: 어느 기록이 취소된 결제의 것인지 확실하지 않을 때의 후보 — 권하지 않고 확인 후 지울 수 있게만 보여 준다
  //            · 승인이 두 번 읽힌 듯한데(같은 날·가게·금액 행이 또 있음) 그 행이 기록을 가져감 (같은 날 다시 산 것일 수도)
  //            · 맞는 기록이 둘 이상 (지난 기간 결제의 환불일 수도)
  //            · 맞는 기록이 명세서 기간 밖 (앞뒤 명세서에서 이미 맞은 기록일 수도)
  const cancelled = [];
  pairedApproval.forEach((cancelRow, approvalId) => {
    const approval = rows.find(r => r.id === approvalId);
    const hit = matched.find(m => m.row.id === approvalId);
    const twin = !hit && matched.find(m => copyOf.get(m.row.id) === approval);
    const unsure = !hit && ambiguousFit.get(approvalId);
    const maybeTx = twin ? twin.tx : (unsure && !usedTx.has(unsure.id) ? unsure : null);
    cancelled.push({
      approval,
      cancel: cancelRow,
      tx: hit ? hit.tx : null,
      maybeTx,
      outsidePeriod: !inPeriod((hit ? hit.tx : maybeTx || approval).date),
      doubtTx: hit ? null : doubtfulCancel.get(cancelRow.id) || null,
    });
  });
  const firstRow = (a, b) => byStatement(a.rows[0], b.rows[0]);
  const matchedOut = matched.filter(m => !isApproval(m.row)).sort((a, b) => byStatement(a.row, b.row));

  // 남은 카드 건 — 이미 적었을 수도 있는 건은 미리 체크하지 않는다 (cautions):
  //   duplicate  : 같은 날·같은 가게·같은 금액 행이 또 있음 (겹친 캡처에서 두 번 읽혔을 수 있음)
  //   period     : 명세서 기간 밖 (할부 원거래·날짜를 잘못 읽음)
  //   installment: 할부
  //   otherMethod: 다른 결제수단으로 적은 같은 결제 (같은 금액 ±1일, 같은 가게 ±N일)
  //   similar    : 이 결제수단의 짝 없는 기록 중 같은(비슷한) 가게 ±SIMILAR_DAYS일, 같은 금액 ±N일,
  //                가게 이름 없는 기록("점심")이면 ±1일·금액이 가까운 것
  // 금액 부호가 다른 기록(결제 ↔ 환불)은 비슷한 기록으로 보지 않는다. 환불 행의 원래 결제는 refundOf로만 알린다.
  // AI가 입력 습관에서 고른 세부내역(aiDetail)도 가게 이름 별칭으로 본다.
  const rdb = cachedReads(db);
  const sameSign = (row, t) => Math.sign(gross(t)) === Math.sign(row.amount);
  const aliasOf = row => (row.aiDetail && normalizeName(row.aiDetail) !== rowName.get(row.id).raw ? merchantInfo(row.aiDetail) : null);
  const nameAlike = (row, alias, t) => levelOf(row, t) > 0 || !!(alias && merchantLevel(alias, txName.get(t.id)) > 0);
  const nearest = (near, date, days, ok) => {
    let best = null;
    near(date, days).forEach(({ item: t, dd }) => {
      if ((!best || dd < best.dd) && ok(t, dd)) best = { tx: t, dd };
    });
    return best ? best.tx : null;
  };
  // 가게 이름 없는 기록은 ±1일·금액이 가까우면(오타) 비슷한 기록으로 본다
  const nearAmount = (row, t) => Math.abs(gross(t) - row.amount) <= Math.max(2500, Math.abs(row.amount) * 0.3);
  const similarTxOf = (row, alias) => nearest(txsNear, row.date, SIMILAR_DAYS, (t, dd) => !usedTx.has(t.id) && sameSign(row, t)
    && (nameAlike(row, alias, t) || (dd <= toleranceDays && amountMatches(row, t))
      || (dd <= toleranceDays && nameless.has(t.id) && nearAmount(row, t))));
  // 다른 결제수단: 같은 금액이면 이름과 상관없이 ±N일, 이름이 닿으면 ±SIMILAR_DAYS일·금액이 가까울 때(오타 범위)만
  const typoRange = (row, t) => Math.abs(gross(t) - row.amount) <= Math.max(1000, Math.abs(row.amount) * 0.2);
  const otherTxOf = (row, alias) => nearest(othersNear, row.date, SIMILAR_DAYS, (t, dd) => sameSign(row, t)
    && ((dd <= toleranceDays && amountMatches(row, t)) || (nameAlike(row, alias, t) && typoRange(row, t))));
  // 환불 행의 원래 결제 — 지난 기간 결제로 묶어 둔 기록(originalOf), 아니면 짝 없는 같은 가게·같은 금액 결제 중
  // 환불일까지 REFUND_LOOKBACK일 안의 가장 최근 것 (다른 결제수단 기록 포함). 이번 카드의 다른 결제와 짝지은 기록은 그 결제의 것.
  // 못 찾으면 'noOriginal' — 반품하면서 결제 기록을 지웠을 수 있으니 미리 체크하지 않는다
  //   · 그런 결제가 둘 이상(정기 구매 등)이면 어느 결제의 환불인지, 그 기록이 남아 있는지 모른다 → 'manyOriginals'
  //   · 같은 가게의 더 큰 결제가 있으면 부분취소일 수 있다 → 'partialRefund' (partialOf)
  //   · 같은 가게·같은 금액 환불 기록이 미리(반품 신청일)·늦게 적혀 있으면 비슷한 기록 → 'similar'
  const refundPool = [...ledger, ...extra.earlier, ...others].filter(t => gross(t) > 0 && !usedTx.has(t.id));
  const latestOf = list => list.reduce((b, t) => (!b || t.date > b.date ? t : b), null);
  const refundInfo = row => {
    if (row.amount >= 0) return { original: null, many: false, refundRecord: null, partialOf: null };
    const back = addDays(row.date, -REFUND_LOOKBACK);
    const near = t => t.date <= row.date && t.date >= back && levelOf(row, t) > 0;
    const exacts = refundPool.filter(t => gross(t) === -row.amount && near(t));
    // 해외결제 환불은 환율 차이로 원화가 ±10% 달라도 원래 결제로 본다
    const fx = exacts.length ? [] : refundPool.filter(t => (row.currency !== 'KRW' || hasForeign(t)) && fxClose(gross(t), -row.amount) && near(t));
    const original = originalOf.get(row.id) || latestOf(exacts) || latestOf(fx);
    const refundRecord = [...ledger, ...extra.earlier, ...extra.later].find(t => !usedTx.has(t.id) && gross(t) === row.amount
      && t.date >= back && t.date <= addDays(row.date, LATE_REFUND_DAYS) && levelOf(row, t) > 0) || null;
    const partialOf = original ? null : latestOf([...ledger, ...extra.earlier].filter(t => gross(t) > -row.amount && near(t)));
    return { original, many: exacts.length + (originalOf.has(row.id) ? 1 : 0) >= 2, refundRecord, partialOf };
  };
  // 가게 이름 없이 나눠·합쳐 적은 기록 ("식료품 30,000 + 생활용품 20,000" = 이마트 50,000)
  //   · 짝 없는 이름 없는 기록(±1일) 2~4건의 합이 이 카드 건과 정확히 같다
  //   · 이름 없는 기록 1건이 남은 카드 건 몇 개(이 건 포함)의 합과 같다 (오타 범위 안)
  // → 미리 체크하지 않는다 (추가하면 이중 계산)
  const leftRows = rows.filter(r => !usedRows.has(r.id) && !isApproval(r) && !pairedCancel.has(r.id));
  const leftNear = nearByDate(leftRows);
  const leftRowsNear = (date, days) => leftNear(date, days).map(n => n.item);
  const freeNameless = date => txsNear(date, GROUP_DAYS).map(n => n.item)
    .filter(t => !usedTx.has(t.id) && nameless.has(t.id) && gross(t) > 0);
  const mergeTolerance = amount => Math.max(1000, Math.abs(amount) * 0.05);
  const namelessPartsOf = row => (row.amount > 0 ? findCombination(freeNameless(row.date), gross, row.amount) : null);
  const namelessMergeOf = row => {
    if (row.amount <= 0) return null;
    return freeNameless(row.date).find(t => {
      const pool = leftRowsNear(t.date, GROUP_DAYS).filter(r => r !== row && r.amount > 0).slice(0, 8);
      const target = gross(t) - row.amount;
      return target > 0 && subsetNear(pool, r => r.amount, target, mergeTolerance(gross(t)), GROUP_MAX - 1);
    }) || null;
  };
  // 금액 차이가 근처 짝 없는 기록(가게 이름 없는 것, 기간 밖 같은 가게 것)의 합과 같으면 나눠 적은 나머지일 수 있다
  // — 한 번에 고치기를 권하지 않는다.
  // 기간 밖 같은 가게 기록(±1일)은 합이 맞지 않아도 알린다 — "카드에 없음"은 기간 안 기록만 보여 주므로,
  // 경계를 넘겨 적은 이 결제의 몫(금액 오타 포함)이면 여기 말고는 보이는 곳이 없다
  const freeNeighbors = row => txsNear(row.date, GROUP_DAYS).map(n => n.item)
    .filter(t => !usedTx.has(t.id) && gross(t) > 0 && (neighborOf(row, t) || outsideRange(row, t)) && levelOf(row, t) > 0);
  //   · 다른 금액 차이 짝의 가계부 건까지 더해 맞으면 (한 영수증을 가게 이름 몫 + 품목 이름 몫으로 나눈 것) 둘 다 권하지 않는다
  //   · 이 짝의 가계부 건 + 근처 이름 없는 기록이 남은 카드 건과 맞으면, 그 가계부 건은 그 카드 건의 몫이다
  const singles = mismatched.filter(m => m.txs.length === 1);
  const singlesByTxDate = nearByDate(singles.map(m => ({ date: m.txs[0].date, m })));
  const singleRowsNear = nearByDate(singles.flatMap(o => o.rows.map(r => ({ date: r.date, r, o }))));
  const sumTo = (pool, target) => {
    if (target <= 0) return null;
    const one = pool.find(t => gross(t) === target);
    return one ? [one] : findCombination(pool, gross, target);
  };
  mismatched.forEach(m => { m.namelessNear = []; });
  mismatched.forEach(m => {
    const near = [...new Set(m.rows.flatMap(r => [...freeNameless(r.date), ...freeNeighbors(r)]))];
    const others = singlesByTxDate(m.rows[0].date, GROUP_DAYS).map(n => n.item.m)
      .filter(o => o !== m && levelOf(m.rows[0], o.txs[0]) > 0).map(o => o.txs[0]);
    // 카드 금액과 똑같은 이름 없는 기록이 옆에 있으면 그것이 이 결제의 기록일 수 있다 ("생필품 20,000")
    const sameAmount = near.find(t => gross(t) === m.cardTotal);
    const parts = (sameAmount ? [sameAmount] : null)
      || sumTo(near, m.cardTotal - m.ledgerTotal) || sumTo([...near, ...others], m.cardTotal - m.ledgerTotal);
    if (!parts) {
      // 경계 행(기간 밖 ±N일에 같은 가게·같은 금액 기록이 있음)이면 그 기록이 이 결제의 것일 수 있다 — 고치면 이중으로 들어간다
      const boundary = m.rows.map(r => boundaryTx.get(r.id)).filter(t => t && !usedTx.has(t.id));
      const outside = [...new Set([...m.rows.flatMap(freeNeighbors), ...boundary])];
      if (outside.length) m.namelessNear = outside;
      return;
    }
    m.namelessNear = parts;
    singles.filter(o => o !== m && parts.includes(o.txs[0])).forEach(o => { if (!o.namelessNear.length) o.namelessNear = [m.txs[0]]; });
  });
  const ownedBy = new Map();   // 남은 카드 건 id → 그 몫인 금액 차이 짝의 가계부 건
  singles.forEach(m => {
    const t = m.txs[0];
    const near = freeNameless(t.date);
    // 남은 카드 건, 다른 금액 차이 짝의 카드 건 (서로 상대 몫을 가져간 경우 둘 다 막는다)
    const otherRows = singleRowsNear(t.date, GROUP_DAYS).map(n => n.item).filter(({ o }) => o !== m);
    [...leftRowsNear(t.date, GROUP_DAYS).map(r => ({ r, o: null })), ...otherRows]
      .filter(({ r }) => r.amount > 0 && levelOf(r, t) > 0).forEach(({ r, o }) => {
        const parts = sumTo(near, r.amount - gross(t));
        if (!parts) return;
        if (!m.namelessNear.length) m.namelessNear = parts;
        if (o && !o.namelessNear.length) o.namelessNear = [t];
        if (!o && !ownedBy.has(r.id)) ownedBy.set(r.id, t);
      });
    // 남은 같은 가게 카드 건(±1일)을 더하면(또는 그것들만으로) 이 기록과 맞으면 여러 결제를 합쳐 적은 기록이다
    // — 이 카드 건 금액으로 고치지 않고, 그 카드 건들도 미리 체크하지 않는다
    const pool = leftRowsNear(t.date, toleranceDays).filter(r => r.amount > 0 && levelOf(r, t) > 0).slice(0, 8);
    if (!pool.length) return;
    const tol = mergeTolerance(gross(t));
    // 이 짝의 카드 건들보다 남은 카드 건을 섞은(또는 그것들만의) 조합이 이 기록과 더 잘 맞는 경우도 포함
    const far = Math.abs(gross(t) - m.cardTotal) > tol;
    const merged = (m.cardTotal < m.ledgerTotal && subsetNear(pool, r => r.amount, gross(t) - m.cardTotal, tol, GROUP_MAX - 1))
      || (far && subsetNear(pool, r => r.amount, gross(t), tol, GROUP_MAX))
      || (far && subsetNear([...m.rows, ...pool], r => r.amount, gross(t), tol, GROUP_MAX));
    if (!merged) return;
    if (!m.namelessNear.length) m.namelessNear = [t];
    pool.forEach(r => { if (!ownedBy.has(r.id)) ownedBy.set(r.id, t); });
  });
  // 금액 차이에서 "카드 금액으로 수정"을 권하지 않는 이유 (cautions) — 하나라도 있으면 안내와 "그래도 수정" 링크만
  //   nameless    : 차이만큼의 근처 짝 없는 기록이 있음 (나눠·합쳐 적은 나머지일 수 있음 — namelessNear)
  //   installment : 할부 — 달마다 나눠 적는 사람은 첫 몫만 적어 둔다 (다음 달 명세서에 원거래 행이 다시 나와도 같다)
  //   outsideRange: 기간을 읽지 못해 행 날짜로 정한 범위 밖의 기록 (일부만 캡처했으면 다른 결제의 기록일 수 있음)
  //   partialCancel: 카드에서 일부 취소된 결제 (partialCancelRow) — 가계부에 취소 뒤 금액을 적었을 수 있다
  mismatched.forEach(m => {
    const cautions = [];
    if (m.namelessNear.length) cautions.push('nameless');
    if (m.rows.some(r => r.installment)) cautions.push('installment');
    if (!explicitPeriod && m.txs.some(t => !inPeriod(t.date))) cautions.push('outsideRange');
    const cuts = m.rows.flatMap(liveCancelsOf);
    if (cuts.length) { cautions.push('partialCancel'); m.partialCancelRow = cuts[0]; m.partialCancelRows = cuts; }
    m.cautions = cautions;
    m.fixable = m.txs.length === 1 && !cautions.length;
  });
  const twinUsed = row => {
    const first = copyOf.get(row.id) || row;
    return rows.some(r => r !== row && (r === first || copyOf.get(r.id) === first) && usedRows.has(r.id));
  };
  const missing = leftRows
    .map(row => {
      const alias = aliasOf(row);
      const parts = namelessPartsOf(row);
      const pairedWith = partialPair.get(row.id) || null;   // 이 취소 행의 승인 (금액이 다름)
      // 카드 안에 승인 짝이 있으면 원래 결제·부분취소 후보는 그 승인이다 — 같은 환불 기록이 따로 있는지(similar)만 본다
      const refund = pairedWith ? { ...refundInfo(row), original: null, many: false, partialOf: null } : refundInfo(row);
      const similarTx = similarTxOf(row, alias) || (parts ? parts[0] : null) || namelessMergeOf(row) || ownedBy.get(row.id)
        || refund.refundRecord || null;
      const otherTx = otherTxOf(row, alias);
      const cautions = [];
      if (extraCopy.has(row.id) || twinUsed(row)) cautions.push('duplicate');
      if (!inPeriod(row.date)) cautions.push('period');
      if (row.installment) cautions.push('installment');
      if (otherTx) cautions.push('otherMethod');
      if (similarTx) cautions.push('similar');
      if (row.amount < 0 && !refund.original && !pairedWith) cautions.push(refund.partialOf ? 'partialRefund' : 'noOriginal');
      if (refund.many) cautions.push('manyOriginals');
      // 승인이 가계부에 원래 금액으로 적혀 있으면(1:1·묶음) 취소를 추가하면 맞지만, 지난 결제(기록을 지운)의 환불일 수도 있어
      // 미리 체크하지 않는다 ('partialRecorded'). 금액 차이로 남았으면 결제 기록부터 확인해야 한다 ('partialCheck')
      if (pairedWith && !leftRows.includes(pairedWith)) {
        const recorded = matched.some(x => x.row === pairedWith)
          || grouped.some(g => g.kind !== 'partialCancel' && g.rows.includes(pairedWith));
        cautions.push(recorded ? 'partialRecorded' : 'partialCheck');
      }
      // 같은 금액 취소가 두 줄(두 번 읽힘으로 보임) — 한 줄은 이 결제의 취소일 수 있다
      if (row.amount > 0 && leftRows.some(r => extraCopy.has(r.id) && r.isCancel && r.amount === -row.amount && r.date >= row.date
        && merchantLevel(rowName.get(r.id), rowName.get(row.id)) === SAME)) cautions.push('cancelDup');
      return {
        row,
        suggestion: rowSuggestion(rdb, row, paymentMethod),
        autoCheck: !cautions.length,
        cautions,
        similarTx,
        otherTx,
        refundOf: refund.original,
        partialOf: refund.partialOf,
        partialOfRow: pairedWith,
        partialCancelRow: liveCancelsOf(row)[0] || null,
        partialCancelRows: liveCancelsOf(row),
      };
    });
  // 승인과 그 부분취소가 둘 다 "가계부에 없음"이면 함께 다룬다 — 둘 다 주의가 없을 때만 둘 다 미리 체크하고(순액이 맞음),
  // 아니면 둘 다 체크하지 않고 승인에 'partialCancelled'를 단다 (승인만 추가되면 취소 금액만큼 틀린다)
  missing.forEach(m => {
    const cs = missing.filter(x => m.partialCancelRows.includes(x.row));
    if (!cs.length) return;
    if (m.cautions.length || cs.some(c => c.cautions.length)) {
      m.cautions.push('partialCancelled');
      m.autoCheck = false;
      cs.forEach(c => { c.autoCheck = false; });
    }
  });
  // 카드에 없음 — 명세서 기간(기간을 못 읽었으면 행 날짜 범위) 안의 기록만. 기간 밖 기록은 앞뒤 명세서 몫인 정상 기록이고,
  // 경계를 넘겨 적은 기록은 짝 없는 카드 행의 "비슷한 기록(기간 밖)" 주의나 금액 차이의 근처 기록으로 보인다
  const notOnCard = ledger.filter(t => !usedTx.has(t.id) && inPeriod(t.date));

  return {
    period: { from, to },
    matched: matchedOut,
    grouped: grouped.sort(firstRow),
    mismatched: mismatched.sort(firstRow),
    missing,
    notOnCard,
    cancelled,
  };
}

function sumsAgree(rs, ts) {
  const card = sumOf(rs, r => r.amount);
  return card === sumOf(ts, gross) || card === sumOf(ts, net);
}

/**
 * 합이 맞지 않는 같은 가게 덩어리를 짝으로 나눈다.
 *  1) 가까운 것끼리 1:1 — 금액 차이가 작은 것, 날짜가 가까운 것 먼저 (SAME 연결만)
 *  2) 남은 카드 건·가계부 건은 붙였을 때 차이(카드 − 가계부)가 줄어드는 짝에만, 가장 많이 줄어드는 곳에 붙인다.
 *     · 가계부 건을 붙인 짝은 가계부가 여러 건이라 자동 수정을 하지 않는다 (나눠 적은 한 몫만 고치면 이중 계산)
 *     · 카드 건을 붙인 짝은 카드 합계로 고칠 수 있다 (합쳐 적음)
 *     · 어디에도 줄이지 못하는 카드 건은 "가계부에 없음", 가계부 건은 "카드에 없음"으로 남는다
 */
function pairUp(links) {
  const pairs = [];
  const ofRow = new Map();
  const ofTx = new Map();
  const diff = e => Math.abs(e.row.amount - gross(e.tx));
  links.filter(e => !e.similar && !e.copy).sort((a, b) => diff(a) - diff(b) || a.dd - b.dd).forEach(e => {
    if (ofRow.has(e.row.id) || ofTx.has(e.tx.id)) return;
    const p = { rows: [e.row], txs: [e.tx] };
    pairs.push(p);
    ofRow.set(e.row.id, p);
    ofTx.set(e.tx.id, p);
  });

  const gap = p => sumOf(p.rows, r => r.amount) - sumOf(p.txs, gross);   // 카드 − 가계부
  const linksOfRow = groupBy(links.filter(e => !e.similar), e => e.row.id);
  const linksOfTx = groupBy(links, e => e.tx.id);
  const rowsLeft = () => [...linksOfRow.values()].map(es => es[0].row).filter(r => !ofRow.has(r.id));
  const txsLeft = () => [...linksOfTx.values()].map(es => es[0].tx).filter(t => !ofTx.has(t.id));
  const bestPair = (candidates, after) => {
    let best = null;
    let bestGain = 0;
    candidates.forEach(p => {
      const gain = Math.abs(gap(p)) - Math.abs(after(p));
      if (gain > bestGain) { best = p; bestGain = gain; }
    });
    return best;
  };
  // 두 번 읽혔을 수 있는 복사본은 진짜 카드 건을 다 붙여 본 뒤에 붙인다
  const isCopy = r => !!linksOfRow.get(r.id)[0].copy;
  const isBoundary = r => !!linksOfRow.get(r.id)[0].boundary;
  const attachRows = () => rowsLeft().filter(r => !isBoundary(r))
    .sort((a, b) => Number(isCopy(a)) - Number(isCopy(b)) || b.amount - a.amount).filter(r => {
    const near = linksOfRow.get(r.id).filter(e => ofTx.has(e.tx.id)).map(e => ofTx.get(e.tx.id));
    const p = bestPair(near, q => gap(q) + r.amount);
    if (!p) return false;
    p.rows.push(r);
    ofRow.set(r.id, p);
    return true;
  }).length;
  const attachTxs = () => txsLeft().sort((a, b) => gross(b) - gross(a)).filter(t => {
    const near = linksOfTx.get(t.id).filter(e => ofRow.has(e.row.id)).map(e => ofRow.get(e.row.id));
    const p = bestPair(near, q => gap(q) - gross(t));
    if (!p) return false;
    p.txs.push(t);
    ofTx.set(t.id, p);
    return true;
  }).length;
  // 붙일 때마다 차이가 줄어들므로 끝난다
  while (attachRows() + attachTxs() > 0) { /* 더 붙일 것이 없을 때까지 */ }
  return pairs;
}

/**
 * "가계부에 없음"에서 고른 건을 한 번에 추가한다. 중간에 실패하면 전부 되돌린다.
 * picks: [{ suggestion, budget_category, sub_category }] — 화면에서 바꾼 분류를 덮어쓴다.
 */
export function addMissingRows(db, picks) {
  withTransaction(db, () => {
    picks.forEach(({ suggestion, budget_category, sub_category }) => {
      addTransaction(db, suggestionToTransaction(db, { ...suggestion, budget_category, sub_category }));
    });
  });
  return picks.length;
}

/** "카드 금액으로 수정"에 쓸 갱신 데이터 — DB 행을 updateTransaction 형식으로 */
export function txWithAmount(tx, amount) {
  let foreign = {};
  try { foreign = tx.foreign_amounts ? JSON.parse(tx.foreign_amounts) : {}; } catch (e) { foreign = {}; }
  return {
    payment_method: tx.payment_method,
    date: tx.date,
    budget_category: tx.budget_category,
    sub_category: tx.sub_category,
    detail: tx.detail,
    amount,
    discount_amount: tx.discount_amount || 0,
    discount_note: tx.discount_note || '',
    event_id: tx.event_id,
    foreign_amounts: foreign,
    split_group_id: tx.split_group_id || '',
  };
}
