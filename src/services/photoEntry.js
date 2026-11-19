/**
 * 사진으로 입력 — 영수증 여러 장, 카드·페이 앱의 결제(이용) 내역 캡처를 한 번에 읽는다.
 *
 *  - 사진 몇 장이든 한 번의 AI 요청으로 보내고, 결제마다 한 건(entries)으로 받는다.
 *    영수증 한 장 = 한 건, 결제 내역 목록 한 장 = 보이는 결제 수만큼.
 *  - 한 건씩 기존 영수증 추천(buildSuggestion)으로 이 가계부에 맞춘다(사진에 보이는 것 > 예전 기록, 목록에 없는 값은 버림).
 *  - 여러 건이면 확인 목록에서 고른다. 미리 체크하지 않는 것:
 *      · 가계부에 같은 날 같은 금액 거래가 이미 있음(내역을 계속 받아 겹치는 경우) — duplicateOf
 *      · 같은 사진 묶음에 같은 결제가 앞에 또 있음(겹쳐 찍음) — batchDuplicate
 *      · 가계부에 같은 가게 결제를 금액·날짜를 조금 다르게 적었거나 나눠·합쳐 적음 — nearOf. 금액·날짜가 다르면
 *        '수정 권장'으로 그 기록을 사진대로 고치게 한다 (I-065)
 *    그 밖의 결제는 기본으로 체크하고, 직접 고쳐야 할 점(간편결제 이름뿐·날짜를 못 읽음·앞날짜·AI가 알려 준 것)은
 *    needsFix([{ text, fields }])로 붙여 화면이 '수정 필요'로 드러낸다 — fields 중 하나를 고치면 풀린다.
 *      · 같은 묶음에 취소 줄이 있는 결제 — pairedCancel
 *    취소·환불 줄은 넣지 않고 cancels로 알린다(이미 넣은 거래면 사용자가 지운다).
 *  - 사용자가 목록에서 날짜·금액·내용을 고치면 markDuplicates로 다시 대조한다.
 */
import { analyzeWithAI, AIError } from './aiClient';
import {
  buildDataContext, buildSuggestion, isPaymentGateway, normalizeName, resolveDate, CATEGORY_ALT_DESCRIPTION, CATEGORY_ALT_RULE,
} from './receiptAssistant';
import { getTransactions, hasForeignAmount } from './dbManager';
import { namesMatch } from './cardSms';
import { cleanFollowUps } from './textEntry';
import { todayStr, addDays, parseDateStr } from './dateUtils';
import {
  merchantInfo, merchantLevel, findCombination, GENERIC_HEADS, SAME,
} from './paymentMatch';

const ENTRY = {
  type: 'object',
  properties: {
    date: { type: 'string', description: '결제일 YYYY-MM-DD. 보이지 않으면 빈 문자열 (주문·결제 완료 화면의 주문번호가 날짜로 시작하면 그 날짜)' },
    merchant: { type: 'string', description: '가맹점(상호)명. 보이는 그대로' },
    total: { type: 'number', description: '이 결제의 최종 금액(할인 후, 부가세 포함). 사용자 설명이 다른 금액(내 몫 등)을 말하면 그 금액. 숫자만, 취소도 양수' },
    currency: { type: 'string', description: 'ISO 4217 통화 코드. 한국 원화는 KRW' },
    is_cancel: { type: 'boolean', description: '취소·환불 건이면 true' },
    installment: { type: 'string', description: '할부 표시가 보이면 그대로 (예: 3개월). 일시불이거나 안 보이면 빈 문자열' },
    payment_hint: { type: 'string', description: '이 결제에 보이는 카드·결제 수단 그대로 (예: 현대카드 EV, 신한카드 1234, 현금, 카카오페이 신한카드 — 간편결제와 카드가 함께 보이면 둘 다). 없으면 빈 문자열' },
    payment_method: { type: 'string', description: '결제수단 목록 중 하나, 판단이 어려우면 "모름"' },
    category: { type: 'string', description: '"카테고리 > 세부카테고리" 목록 중 하나, 판단이 어려우면 "모름"' },
    category_alt: { type: 'string', description: CATEGORY_ALT_DESCRIPTION },
    detail: {
      type: 'string',
      description: '가계부 세부내역에 쓸 짧은 이름 — 가게 이름(입력 습관에 같은 가게가 있으면 그 표기 그대로). 가게가 간편결제 이름뿐이고 산 상품이 보이면 무엇인지 알 수 있는 짧은 상품 이름',
    },
    items: {
      type: 'array',
      description: '영수증이나 주문·결제 완료 화면처럼 산 상품이 보이면 주요 품목(최대 15개), 결제 내역 목록이면 빈 배열',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, amount: { type: 'number' } },
        required: ['name', 'amount'],
      },
    },
    confidence: { type: 'string', description: 'high | medium | low — 금액·날짜를 확실히 읽었는지' },
    note: {
      type: 'string',
      description: '이 결제에서 확실하지 않은 점을 짧게 (예: 날짜 머리글이 잘려 달력에서 고른 날로 짐작, 금액 일부가 가려짐). 확실하면 빈 문자열',
    },
    needs_fix: {
      type: 'string',
      description: '무엇을 샀는지 알 수 없어 사용자가 고쳐야 할 때만, 무엇을 고칠지 한 줄 (예: 결제대행 이름만 있고 상품도 안 보임 — 세부내역·카테고리). 가게나 산 상품이 분명하면 빈 문자열',
    },
  },
  required: ['date', 'merchant', 'total', 'currency', 'is_cancel', 'installment', 'payment_hint', 'payment_method',
    'category', 'category_alt', 'detail', 'items', 'confidence', 'note', 'needs_fix'],
};

const SCHEMA = {
  type: 'object',
  properties: {
    is_payment: { type: 'boolean', description: '영수증이나 결제(이용) 내역 사진이면 true' },
    kind: { type: 'string', description: 'receipt(영수증·주문 한 건의 화면) | list(카드·은행·페이 앱의 결제 내역 목록) | mixed' },
    entries: { type: 'array', description: '결제 건 — 같은 결제는 한 번만', items: ENTRY },
    note: { type: 'string', description: '사용자에게 알릴 점(흐림, 잘린 화면, 합계 불확실 등). 없으면 빈 문자열' },
  },
  required: ['is_payment', 'kind', 'entries', 'note'],
};

const SYSTEM = [
  '당신은 한국 가계부 앱의 사진 입력 도우미입니다.',
  '영수증·카드 결제 내역 사진에서 실제로 보이는 결제만 빠짐없이, 중복 없이 옮기고, 보이지 않는 값은 지어내지 않습니다.',
  '분류(결제수단·카테고리)는 반드시 주어진 목록 안에서 고르고, 사진에 보이는 것(품목·가게)이 먼저이며 기존 입력 습관은 판단 근거로 씁니다.',
].join(' ');
// 사용자가 사진에 설명을 덧붙였을 때 시스템 지시문에 더한다 — 설명대로 금액·건수를 정하는 것은 지어내는 것이 아니다 (I-063)
const SYSTEM_WITH_NOTES = `${SYSTEM} 사용자가 덧붙인 설명은 사진과 같은 원문이며, 설명이 말한 대로 금액(내 몫)·건수(나누기·일부만)를 정합니다.`;

/**
 * 사용자가 덧붙인 사진 설명 — 빈 것은 버리고, 길거나 많으면 말로 입력의 덧붙인 말과 같은 규칙으로 줄인다 (I-063)
 */
export function cleanPhotoNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return cleanFollowUps(notes.map(said => ({ said }))).map(f => f.said);
}

/**
 * 사진 AI 지시문 (테스트·디버깅용으로 노출)
 * notes: 사용자가 덧붙인 설명 — 사진에 보이지 않는 사실(산 것·누구 것·나눠 냄·일부만)을 원문으로 함께 읽는다 (I-063)
 */
export function buildPhotoPrompt(db, { photos = 1, today = todayStr(), notes = [] } = {}) {
  const said = cleanPhotoNotes(notes);
  const lines = [
    // 설명에 나온 이름의 예전 기록도 함께 보낸다 — 말로 입력처럼 AI가 판단 근거로 쓰게 (I-062)
    buildDataContext(db, today, { text: said.join('\n') }).text,
    '',
    `[첨부] 사진 ${photos}장. 세로로 긴 사진은 겹치게 잘라 여러 조각으로 보냈습니다.`,
    '',
    '[규칙]',
    '- 영수증이면 영수증 한 장이 entries 한 건. 긴 영수증을 여러 장·조각으로 나눠 찍었으면 한 건으로.',
    '- 카드사·은행·페이 앱의 결제(이용) 내역 목록이면 보이는 결제마다 한 건씩 빠짐없이. 겹쳐 찍은 부분의 같은 결제는 한 번만.',
    '- 소계·합계·결제예정금액·누적·포인트·청구할인·캐시백·안내 문구 줄은 넣지 않는다.',
    '- 카드 앱 위쪽 달력(주간·월간)의 날짜별 합계와 "결제일" 금액, 광고 배너는 결제가 아니다 — 넣지 않는다.',
    '- 목록은 날짜 머리글(예: "11. 8(일)") 아래에 그날 결제가 이어진다. 시각(20:26)·할부 표시는 날짜가 아니다.',
    '- 맨 위 결제들의 날짜 머리글이 스크롤로 잘려 안 보이면, 위쪽 달력에서 고른 날(동그라미 표시)의 날짜를 쓴다. 그것도 없으면 빈 문자열.',
    '- 가맹점이 "카카오페이 - 한살림서울협동조합"처럼 간편결제 이름과 함께 나오면 merchant는 실제 가게(한살림서울협동조합). "네이버페이"만 있으면 그대로.',
    '- 간편결제·쇼핑 앱의 주문·결제 완료 화면(상품명·수량·결제 금액이 보임)은 영수증처럼 주문 한 건이 entries 한 건이고 상품을 items에 넣는다. 판매처(스토어 이름)가 보이면 merchant는 그 판매처, 없으면 간편결제 이름 그대로.',
    '- 주문·결제 완료 화면에 결제 날짜가 없고 주문번호가 날짜로 시작하면(예: 20261116…) 그 날짜를 쓰고, note에 주문번호로 짐작했다고 적는다.',
    '- 취소·환불 건은 is_cancel=true, total은 취소 금액(양수).',
    '- total은 실제로 낸 최종 금액. 할부는 결제한 총액(installment에 할부 표시). 쉼표·통화 기호 없이 숫자만.',
    '- 해외결제는 원화 청구 금액이 보이면 그 금액을 KRW로, 현지 금액만 보이면 그 통화와 금액으로.',
    '- 날짜가 안 보이면 빈 문자열(위의 주문번호 경우 말고 다른 숫자로 짐작하지 않는다). 연도가 없으면 오늘 기준 가장 가까운 과거 날짜.',
    '- 목록 위에 카드 이름이 한 번만 보이면 그 카드를 모든 결제의 payment_hint로.',
    '- payment_method·category는 위 목록의 표기 그대로, 애매하면 "모름". 카드 이름이 결제수단 목록의 하나와 같은 카드로 보이면 그 결제수단.',
    '- 간편결제로 낸 결제에 연결한 카드가 보이지 않으면 payment_hint는 보이는 간편결제 이름(없으면 빈 문자열), payment_method는 결제수단 목록에 그 간편결제 자체가 있으면 그것, 없으면 "모름" — 입력 습관으로 카드를 짐작하지 않는다.',
    CATEGORY_ALT_RULE,
    '- detail은 입력 습관에 같은 가게가 있으면 그 표기를 그대로, 없으면 짧은 상호명. 카테고리 이름을 되풀이할 뿐이면 빈 문자열.',
    '- 가게가 간편결제 이름뿐이고 산 상품이 보이면 detail은 무엇인지 알 수 있는 짧은 상품 이름 (예: "코튼 순면 호텔 수건 40수 150g 10장 세트" → "수건", 상품이 여럿이면 "수건 외 2개"), category는 그 상품으로 고른다. 간편결제 이름으로 적힌 예전 기록은 다른 가게·다른 물건이라 따르지 않는다.',
    '- 결제마다 note에 확실하지 않은 점을 한 줄로 — 짐작한 값이 있으면 무엇을 왜 짐작했는지. 확실하면 빈 문자열. 사진 전체에 해당하는 점은 맨 위 note에만.',
    '- 날짜나 금액을 짐작했으면(잘림·가림·흐림) 그 결제의 confidence는 low. 주문번호로 날짜만 정했으면 medium(note에 적은 대로).',
    '- 무엇을 샀는지 알 수 없어 사용자가 고쳐야 할 결제(간편결제·결제대행 이름뿐이고 상품도 안 보임 등)만 needs_fix에 무엇을 고칠지 한 줄로. 쿠팡·편의점처럼 가게가 분명하거나 산 상품이 보이면 빈 문자열.',
    '- 영수증·결제 내역이 아니면 is_payment=false.',
  ];
  if (said.length) {
    lines.push(
      '- 아래 [사용자가 덧붙인 설명]은 사진에 보이지 않는 사실(산 물건·용도, 누구 것인지, 나눠 냈는지, 어떤 결제만 넣을지 등)을 사용자가 알려 준 것이다. 사진과 함께 판단의 원문으로 쓴다.',
      '- 설명이 위 규칙과 다르면 설명을 따른다 (예: "식비와 생활용품으로 나눠 줘" → 영수증 한 장을 품목대로 여러 건, "반반 냈어" → total은 내 몫, "11월 것만" → 그 결제만). 설명끼리 다르면 나중 설명을 따른다.',
      '- 설명 때문에 사진에 보이는 금액·날짜·건수와 다르게 적었으면 그 결제의 note에 무엇을 왜 바꿨는지 한 줄로.',
      '- 설명이 있어도 결제수단·카테고리는 위 목록 안에서만 고른다.',
      '',
      '[사용자가 덧붙인 설명]',
      // 여러 줄 설명은 이어지는 줄을 들여 써 한 설명으로 읽히게
      ...said.map(n => `- ${n.split(/\r\n|\r|\n/).join('\n  ')}`),
    );
  }
  return lines.join('\n');
}

/**
 * 사진들(prepared.parts — imageUtils.preparePhotos)을 AI로 읽어 입력 추천을 만든다.
 * notes: 사용자가 덧붙인 설명(I-063) — 없으면 사진만 읽는다.
 * 반환: buildPhotoSuggestions 참고
 */
export async function analyzePhotos({ db, ai, parts, photos = 1, notes = [], signal, onProgress, today = todayStr() }) {
  const raw = await analyzeWithAI({
    ai, system: cleanPhotoNotes(notes).length ? SYSTEM_WITH_NOTES : SYSTEM, prompt: buildPhotoPrompt(db, { photos, today, notes }), schema: SCHEMA,
    toolName: 'record_payments', description: '사진에서 읽은 결제를 기록한다',
    files: parts, signal, onProgress, maxTokens: 16000,
  });
  if (raw && raw.is_payment === false) {
    throw new AIError('영수증이나 결제 내역으로 보이지 않습니다 — 잘 보이게 다시 찍어 주세요', 'parse');
  }
  return buildPhotoSuggestions(db, raw || {}, { today, promptText: cleanPhotoNotes(notes).join('\n') });
}

// 간편결제·결제대행 이름인지 — receiptAssistant에 있다 (분류도 같은 목록으로 거른다, B-099)
export { isPaymentGateway };

// AI가 '없음'처럼 빈 값 대신 쓴 말
const NO_FIX_RE = /^(없음|해당\s*없음|없습니다|none|n\/a|-|—)?$/i;
const FIX_ANY = ['date', 'detail', 'amount', 'budget_category', 'sub_category'];
const GATEWAY_FIELDS = ['detail', 'budget_category', 'sub_category'];

/**
 * 직접 고쳐야 할 점 — [{ text, fields }]. fields 중 하나를 고치면 그 점은 풀린다.
 *  - 간편결제·결제대행 이름뿐인 결제(classify의 gatewayBought, B-099) → 세부내역·카테고리
 *      · unknown: 산 것이 보이지 않음 — 고쳐 주세요
 *      · check: 상품은 보이는데 세부내역이 그 상품과 맞지 않음(비었거나 예전 기록을 따라 적음) — 확인해 주세요
 *      · known: 주문 화면의 상품으로 적었다 — 고칠 것이 아니다
 *  - AI가 알려 준 것 — AI도 예전에 같은 가게를 넣은 습관대로 분류했으면 따르지 않는다(늘 넣던 대로면 고칠 것이 없다).
 *    AI가 분류를 못 해 예전 기록으로 채운 것(categoryGuess)은 알린다 (I-062)
 *  - 간편결제로 냈는데 연결한 카드가 사진에 없음(unseenCard) → 결제수단만 (B-099)
 *  - 날짜를 읽지 못해 오늘로 둠·앞날짜 → 날짜
 */
function fixesFor(e, s, today) {
  const fixes = [];
  const aiFix = String(e.needs_fix || '').trim();
  const pay = String(e.merchant || '').trim();
  if (s.gatewayBought === 'unknown') {
    fixes.push({ text: `${pay} 결제라 무엇을 샀는지 알 수 없어요 — 세부내역·카테고리를 고쳐 주세요`, fields: GATEWAY_FIELDS });
  } else if (s.gatewayBought === 'check') {
    fixes.push({ text: `${pay} 결제예요 — 세부내역·카테고리가 산 상품에 맞는지 확인해 주세요`, fields: GATEWAY_FIELDS });
  } else if (!NO_FIX_RE.test(aiFix) && (s.sources.category !== 'history' || s.categoryGuess)) {
    fixes.push({ text: aiFix, fields: FIX_ANY });
  }
  if (s.unseenCard) {
    fixes.push({ text: `${s.unseenCard}에 연결한 카드가 사진에 없어요 — 결제수단을 골라 주세요`, fields: ['payment_method'] });
  }
  if (s.sources.date === 'today') {
    fixes.push({ text: '날짜를 읽지 못해 오늘 날짜로 두었어요 — 날짜를 골라 주세요', fields: ['date'] });
  } else if (s.date > today) {
    fixes.push({ text: '앞날짜예요 — 날짜를 확인해 주세요', fields: ['date'] });
  }
  return fixes;
}

const sameMerchant = (a, b) => {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return true; // 한쪽 이름을 못 읽었으면 금액·날짜로만 본다
  return x === y || (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x)));
};

/**
 * AI 응답 → { suggestions, cancels, kind, note }
 *  - suggestions: buildSuggestion 결과에 duplicateOf·batchDuplicate·pairedCancel을 붙인 것(원래 순서)
 *  - cancels: [{ date, merchant, amount, currency, paired }] — paired: 같은 묶음의 결제와 짝이 맞음
 * 결제 건 칸(entries)이 아예 없으면 오류 — 0건이면 "넣을 것 없음"으로 잘못 보인다.
 */
export function buildPhotoSuggestions(db, raw, { today = todayStr(), promptText = '' } = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) {
    throw new AIError('사진 내용을 읽지 못했습니다 — 다시 시도해 주세요', 'parse');
  }
  const note = String(raw.note || '').trim();
  const entries = raw.entries.filter(e => e && typeof e === 'object');
  const approvals = entries.filter(e => !e.is_cancel && !(Number(e.total) < 0));
  const single = approvals.length === 1 && approvals.length === entries.length;

  const cancels = entries.filter(e => !approvals.includes(e)).map(e => {
    const { date } = resolveDate(e.date, today, 'receipt');
    const currency = /^[A-Za-z]{3}$/.test(String(e.currency || '').trim()) ? String(e.currency).trim().toUpperCase() : 'KRW';
    const value = Math.abs(Number(e.total)) || null;
    return {
      date,
      merchant: String(e.merchant || '').trim(),
      amount: currency === 'KRW' && value !== null ? Math.round(value) : null,
      foreignAmount: currency !== 'KRW' && value !== null ? value : null,
      currency,
      paired: false,
    };
  });

  const suggestions = approvals.map(e => {
    const entryNote = String(e.note || '').trim();
    const s = buildSuggestion(db, { ...e, note: '' }, { today, promptText });
    // 할부 결제 — 가계부에 달마다 나눠 적었을 수 있어 금액이 달라도 고치기를 미리 고르지 않는다 (I-065)
    s.installment = String(e.installment || '').trim();
    const fixes = fixesFor(e, s, today);
    if (single) {
      // 한 건이면 고칠 점·알릴 점(사진 전체·이 결제)을 그 건의 경고로 — 같은 말은 한 번만
      const said = [...new Set([...fixes.map(f => f.text), note, entryNote].filter(Boolean))].join(' · ');
      if (said) s.warnings.push(said);
    } else {
      // 여러 건이면 사진 전체의 것은 화면 위에 한 번, 결제마다의 것은 그 줄의 AI 메모·수정 필요로 — 바로 넣지 않는다
      s.items = []; // 결제 내역 목록에는 품목이 없다 — AI가 넣었어도 여러 건이면 보이지 않는다
      s.aiNote = entryNote;
      s.needsFix = fixes;
    }
    return s;
  });

  // 같은 묶음의 취소와 짝짓기 — 금액이 같고 가게가 같으며 취소보다 앞선(같은 날 포함) 결제, 한 건은 한 건하고만
  cancels.forEach(c => {
    if (c.amount === null) return;
    const hit = suggestions.find(s => !s.pairedCancel && s.amount === c.amount && s.date <= c.date && sameMerchant(s.merchant, c.merchant));
    if (hit) { hit.pairedCancel = true; c.paired = true; }
  });

  return { suggestions: markDuplicates(db, suggestions), cancels, kind: String(raw.kind || ''), note };
}

/**
 * 겹친 결제를 다시 표시한다 — 사진을 읽은 뒤, 그리고 사용자가 목록에서 고칠 때마다. 새 추천 배열을 돌려준다(원래 순서).
 *  - duplicateOf: 가계부에 이미 있는 거래 { id, date, detail, payment_method, amount } — 같은 날·같은 금액이고
 *    결제수단이나 가게 이름이 같은 것. 한 거래는 한 줄하고만 짝짓는다(같은 날 같은 금액 결제가 둘인데 하나만 넣었으면 하나는 새 것).
 *    짝은 목록 전체에서 결제수단·이름이 다 맞는 것부터, 다음은 결제수단만, 마지막에 이름만 맞는 것으로 짓는다
 *    (앞 줄이 결제수단만 맞는 거래를 먼저 가져가 정작 같은 결제가 '새 것'으로 남지 않게).
 *    금액은 할인 전 금액이나 할인 뒤 금액(영수증은 할인 뒤) 중 하나가 같으면 같은 금액이다.
 *  - claimed: 이 화면에서 바로 넣은 추천 — 그 거래는 먼저 제 짝으로 가져가 목록의 다른 줄과 짝짓지 않는다
 *  - batchDuplicate: 같은 목록 앞에 같은 결제가 있음(겹쳐 찍음) — 가게 이름이 같거나, 맞춘 세부내역·결제수단이 같으면 같은 결제
 *  - nearOf: 똑같지는 않지만 가계부에 이미 적은 같은 결제 — markNear 참고 (I-065)
 */
export function markDuplicates(db, suggestions, { claimed = [] } = {}) {
  const usable = s => s.amount !== null && s.amount !== undefined && Number(s.amount) > 0 && !!s.date;
  const out = suggestions.map(orig => ({ ...orig, batchDuplicate: false, duplicateOf: null, nearOf: null }));

  const seen = new Set();
  out.forEach(s => {
    if (!usable(s)) return;
    // 이름이 없는 쪽(세부내역을 비운 건 등)으로는 같은 결제라 보지 않는다 (I-056)
    const merchant = normalizeName(s.merchant || s.detail);
    const detail = normalizeName(s.detail);
    const keys = [
      merchant && ['m', s.date, s.amount, merchant].join('|'),
      detail && ['d', s.date, s.amount, detail, s.payment_method].join('|'),
    ].filter(Boolean);
    if (keys.some(k => seen.has(k))) s.batchDuplicate = true;
    keys.forEach(k => seen.add(k));
  });

  const byDay = new Map();
  const dayTxs = (date) => {
    if (!byDay.has(date)) byDay.set(date, getTransactions(db, { dateFrom: date, dateTo: date }));
    return byDay.get(date);
  };
  const sameMethod = (s, tx) => !!s.payment_method && tx.payment_method === s.payment_method;
  const sameName = (s, tx) => namesMatch(tx.detail, s.merchant) || namesMatch(tx.detail, s.detail);
  const rules = [
    (s, tx) => sameMethod(s, tx) && sameName(s, tx),
    sameMethod,
    sameName,
  ];
  const used = new Set();
  const claimants = claimed.filter(usable).map(s => ({ s, done: false, mine: false }));
  const rows = out.filter(usable).map(s => ({ s, done: false, mine: true }));
  rules.forEach(rule => {
    [...claimants, ...rows].forEach(r => {
      if (r.done) return;
      const hit = dayTxs(r.s.date).find(tx => !used.has(tx.id) && paidAs(r.s.amount, tx) && rule(r.s, tx));
      if (!hit) return;
      used.add(hit.id);
      r.done = true;
      if (r.mine) {
        r.s.duplicateOf = {
          id: hit.id, date: hit.date, detail: hit.detail || hit.sub_category || '',
          payment_method: hit.payment_method, amount: Number(hit.amount) || 0,
        };
      }
    });
  });
  markNear(db, out.filter(usable), used);
  return out;
}

// ── 수정 권장 (I-065) ─────────────────────────────────────────────

/** 금액이 같은데 날짜만 다른 기록을 찾는 범위 — 카드 대조의 짝짓기(±3일)와 같게 */
export const NEAR_DATE_DAYS = 3;
/** 금액이 다른 기록·나눠(합쳐) 적은 기록을 찾는 범위 — 카드 대조의 금액 차이(±1일)와 같게 */
export const NEAR_AMOUNT_DAYS = 1;
/** 같은 곳·같은 금액 결제가 이 날짜 안에 또 있으면 늘 하는 결제(버스·커피)라 어느 기록인지 장담하지 않는다 */
const REPEAT_DAYS = 7;
/** 잘못 적은 금액으로 볼 차이 — 카드 대조의 오타 범위와 같게(1,000원과 20% 중 큰 것). 넘으면 다른 결제·내 몫일 수 있다 */
const typoGap = (amount, other) => Math.abs(amount - other) <= Math.max(1000, Math.abs(amount) * 0.2);

/**
 * 고치기를 미리 고르지 않는 이유(nearOf.cautions) — 화면이 이 글로 알린다.
 * 고칠 수 없는 이유(nearOf.blocked)가 있으면 고치기를 보이지 않고 거래내역에서 고치게 한다.
 */
export const NEAR_CAUTION = {
  many: '근처에 같은 곳 결제가 더 있어 어느 기록인지 확실하지 않아요',
  edge: '사진의 첫날·끝날이거나 사진 밖 날짜의 기록이에요 — 사진에서 잘린 다른 결제일 수 있어요',
  far: '금액 차이가 커요 — 다른 결제이거나 내 몫만 적은 것일 수 있어요',
  repeat: '같은 곳에서 같은 금액을 자주 결제했어요 — 다른 날의 결제일 수 있어요',
  rest: '근처에 차액만큼의 기록이 있어요 — 한 결제를 나눠 적었다면 고치면 이중으로 계산돼요',
  installment: '할부 결제예요 — 달마다 나눠 적고 있다면 고치지 마세요',
};
export const NEAR_BLOCKED = {
  split: '나눠 결제한 거래의 한 몫이에요 — 거래내역에서 묶음 전체를 고쳐 주세요',
  discount: '할인이 사진 금액보다 커요 — 거래내역에서 고쳐 주세요',
};

const gross = tx => Number(tx.amount) || 0;
const net = tx => gross(tx) - (Number(tx.discount_amount) || 0);
/** 사진 금액이 이 기록의 금액인지 — 할인 전이나 할인 뒤 (영수증은 할인 뒤, 카드 이용내역은 대개 할인 전) */
const paidAs = (amount, tx) => amount === gross(tx) || (net(tx) !== gross(tx) && amount === net(tx));
const dayGap = (a, b) => Math.round(Math.abs(parseDateStr(a) - parseDateStr(b)) / 86400000);
const brief = tx => ({
  id: tx.id, date: tx.date, detail: tx.detail || tx.sub_category || '', payment_method: tx.payment_method,
  amount: gross(tx), discount: Number(tx.discount_amount) || 0, split: !!tx.split_group_id,
});

/**
 * 똑같지는 않지만 가계부에 이미 적은 같은 결제를 찾는다 (사진 목록의 '수정 권장', I-065).
 * 같은 결제로 보는 것은 가게 이름이 같은 곳(카드 대조와 같은 규칙, 간편결제 이름·일반어는 빼고)이고
 * 결제수단이 같은(사진 줄에 결제수단이 없으면 아무것이나) 기록뿐이다. 확실한 것부터 짝짓는다:
 *   ① date   : 금액이 같고 날짜만 1~3일 다름 → 날짜를 사진대로 고치기 권장
 *   ② split  : ±1일의 기록 2~4건의 합이 사진 금액 — 나눠 적음, 이미 있는 거래로 본다
 *   ③ merged : ±1일의 사진 줄 2~4건의 합이 기록 한 건 — 합쳐 적음, 이미 있는 거래로 본다
 *   ④ amount : ±1일, 금액이 다름 → 금액(날짜가 다르면 날짜도)을 사진대로 고치기 권장
 * nearOf: { kind, txs: [기록], rows(merged — 합친 줄 수), blocked, cautions }
 *   blocked: 여기서 고칠 수 없음(NEAR_BLOCKED) — 나눠 결제한 한 몫 등. 고치기를 보이지 않는다
 *   cautions: 고치기를 미리 고르지 않는 이유(NEAR_CAUTION) — 고를지는 사람이 정한다
 * 외화 결제·외화 기록은 원화 환산이 달라 짝짓지 않는다. used: 이미 짝지은 기록(넘겨받아 더 채운다)
 */
function markNear(db, rows, used) {
  // 날짜를 읽지 못해 오늘로 둔 줄·앞날짜는 날짜를 믿을 수 없다 — 그 날짜로 기록을 고치지 않게 짝짓지 않는다
  const today = todayStr();
  const open = rows.filter(s => !s.duplicateOf && !s.batchDuplicate && !s.pairedCancel
    && (s.foreignAmount === null || s.foreignAmount === undefined)
    && s.sources?.date !== 'today' && s.date <= today);
  if (!open.length) return;
  // 사진이 보여 주는 날짜 — 믿을 수 있는 날짜만으로 (오늘로 둔 줄이 범위를 넓히지 않게).
  // 사진은 카드 내역의 일부라 첫날·끝날은 그날 결제가 잘렸을 수 있다 — 그 날짜의 기록도 '사진 가장자리'로 본다
  const dates = rows.filter(s => s.sources?.date !== 'today' && s.date <= today).map(s => s.date).sort();
  const inside = d => d > dates[0] && d < dates[dates.length - 1];

  // 가까운 날의 기록 — 늘 하는 결제인지(REPEAT_DAYS)까지 보게 넓게 읽는다. 현금 잔액 맞춤은 결제가 아니다.
  // 줄을 고칠 때마다 다시 따지므로 날짜가 두 달 안에 모여 있으면 한 번에 읽는다
  const ledger = new Map();
  const keep = (tx) => { if (!tx.is_cash_adjustment) ledger.set(tx.id, tx); };
  const openDates = [...new Set(open.map(s => s.date))].sort();
  const first = openDates[0];
  const last = openDates[openDates.length - 1];
  if (dayGap(first, last) <= 62) {
    getTransactions(db, { dateFrom: addDays(first, -REPEAT_DAYS), dateTo: addDays(last, REPEAT_DAYS) }).forEach(keep);
  } else {
    openDates.forEach((date) => {
      getTransactions(db, { dateFrom: addDays(date, -REPEAT_DAYS), dateTo: addDays(date, REPEAT_DAYS) }).forEach(keep);
    });
  }
  const taken = used;
  const free = [...ledger.values()].filter(tx => !taken.has(tx.id) && !hasForeignAmount(tx.foreign_amounts));
  const isFree = tx => !taken.has(tx.id);

  // 가게로 볼 수 있는 이름만 — 간편결제 이름뿐이거나 일반어(점심·장보기)면 어느 가게인지 모른다 (B-099)
  const infos = new Map();
  const placeName = (name) => {
    const text = String(name || '').trim();
    if (!infos.has(text)) {
      const n = text && !isPaymentGateway(text) ? merchantInfo(text) : null;
      infos.set(text, n && n.raw.length >= 2 && !GENERIC_HEADS.has(n.raw) && !GENERIC_HEADS.has(n.head) ? n : null);
    }
    return infos.get(text);
  };
  const namesOf = s => [placeName(s.merchant), placeName(s.detail)].filter(Boolean);
  const sameName = (s, tx) => {
    const t = placeName(tx.detail);
    return !!t && namesOf(s).some(n => merchantLevel(n, t) === SAME);
  };
  const sameRowName = (a, b) => namesOf(a).some(n => namesOf(b).some(m => merchantLevel(n, m) === SAME));
  const methodOk = (s, tx) => !s.payment_method || tx.payment_method === s.payment_method;
  const fits = (s, tx, days) => dayGap(s.date, tx.date) <= days && methodOk(s, tx) && sameName(s, tx);
  /**
   * 고칠 수 없는 이유 — 나눠 결제한 한 몫은 그 몫만 고치면 묶음이 틀어진다,
   * 금액을 할인보다 작게 고치면 순지출이 음수가 된다(날짜만 고칠 때는 금액을 바꾸지 않으니 상관없다)
   */
  const blockedOf = (s, tx, kind) => {
    if (tx.split_group_id) return 'split';
    if (kind === 'amount' && s.amount < (Number(tx.discount_amount) || 0)) return 'discount';
    return '';
  };

  // ① 금액이 같고 날짜만 다름 — 가까운 날부터
  const byDate = [];
  open.forEach(s => free.forEach((tx) => {
    const dd = dayGap(s.date, tx.date);
    if (dd >= 1 && paidAs(s.amount, tx) && fits(s, tx, NEAR_DATE_DAYS)) byDate.push({ s, tx, dd });
  }));
  byDate.sort((a, b) => a.dd - b.dd);
  byDate.forEach(({ s, tx }) => {
    if (s.nearOf || !isFree(tx)) return;
    taken.add(tx.id);
    const cautions = [];
    if (!inside(tx.date)) cautions.push('edge');
    // 같은 곳·같은 금액이 가까운 날 또 있으면(가계부든 사진이든) 늘 하는 결제 — 어느 날 것인지 모른다
    const again = [...ledger.values()].some(o => o.id !== tx.id && paidAs(s.amount, o) && fits(s, o, REPEAT_DAYS))
      || rows.some(o => o !== s && o.amount === s.amount && dayGap(o.date, s.date) <= REPEAT_DAYS && sameRowName(o, s));
    if (again) cautions.push('repeat');
    s.nearOf = { kind: 'date', txs: [brief(tx)], blocked: blockedOf(s, tx, 'date'), cautions };
  });

  // ② 나눠 적음 — 사진 한 줄 = 기록 여러 건
  open.forEach((s) => {
    if (s.nearOf) return;
    const pool = free.filter(tx => isFree(tx) && fits(s, tx, NEAR_AMOUNT_DAYS));
    if (pool.length < 2) return;
    const parts = findCombination(pool, gross, s.amount) || findCombination(pool, net, s.amount);
    if (!parts) return;
    parts.forEach(tx => taken.add(tx.id));
    s.nearOf = { kind: 'split', txs: parts.map(brief), blocked: '', cautions: [] };
  });

  // ③ 합쳐 적음 — 사진 여러 줄 = 기록 한 건
  free.forEach((tx) => {
    if (!isFree(tx)) return;
    const pool = open.filter(s => !s.nearOf && fits(s, tx, NEAR_AMOUNT_DAYS));
    if (pool.length < 2) return;
    const parts = findCombination(pool, s => s.amount, gross(tx))
      || (net(tx) !== gross(tx) ? findCombination(pool, s => s.amount, net(tx)) : null);
    if (!parts) return;
    taken.add(tx.id);
    parts.forEach((s) => { s.nearOf = { kind: 'merged', txs: [brief(tx)], rows: parts.length, blocked: '', cautions: [] }; });
  });

  // ④ 금액이 다름 — 가까운 날, 금액 차이가 작은 것부터
  const cands = new Map(open.filter(s => !s.nearOf).map(s => [s, free.filter(tx => isFree(tx)
    && !paidAs(s.amount, tx) && fits(s, tx, NEAR_AMOUNT_DAYS))]));
  const byAmount = [];
  cands.forEach((list, s) => list.forEach(tx => byAmount.push({
    s, tx, dd: dayGap(s.date, tx.date), gap: Math.abs(s.amount - gross(tx)) / Math.max(s.amount, gross(tx)),
  })));
  byAmount.sort((a, b) => a.dd - b.dd || a.gap - b.gap);
  byAmount.forEach(({ s, tx }) => {
    if (s.nearOf || !isFree(tx)) return;
    taken.add(tx.id);
    const cautions = [];
    // 이 줄의 후보가 여럿이거나, 이 기록을 후보로 둔 다른 줄이 있으면 어느 짝인지 모른다
    if (cands.get(s).length > 1 || byAmount.some(p => p.tx === tx && p.s !== s)) cautions.push('many');
    if (!inside(tx.date)) cautions.push('edge');
    if (!typoGap(s.amount, gross(tx))) cautions.push('far');
    // 차액만큼의 기록이 근처에 있으면 한 결제를 다른 이름으로 나눠 적은 나머지일 수 있다
    const rest = s.amount - gross(tx);
    if (rest > 0 && free.some(o => o.id !== tx.id && isFree(o) && gross(o) === rest
      && dayGap(o.date, tx.date) <= NEAR_AMOUNT_DAYS && methodOk(s, o))) cautions.push('rest');
    if (s.installment) cautions.push('installment');
    s.nearOf = { kind: 'amount', txs: [brief(tx)], blocked: blockedOf(s, tx, 'amount'), cautions };
  });
}

/** 가계부 기록을 사진대로 고칠 수 있는 줄인지 — 날짜·금액이 다른 같은 결제이고 막는 이유가 없음 */
export const canFixNear = s => !!s?.nearOf && (s.nearOf.kind === 'date' || s.nearOf.kind === 'amount') && !s.nearOf.blocked;
/** 고치기를 미리 골라 둘 만한지 — 고칠 수 있고 망설일 이유(cautions)가 없음 */
export const suggestFixNear = s => canFixNear(s) && !s.nearOf.cautions.length;

/**
 * 고칠 내용 — { id, amount, date } (사진 줄의 지금 값으로, 가계부 기록의 다른 칸·할인은 그대로).
 * 날짜만 다른 기록(date)은 날짜만 — 금액은 할인 뒤 금액으로 같았을 수 있어 그대로 둔다. 바뀌는 것이 없으면 null
 */
export function nearFix(s) {
  if (!canFixNear(s)) return null;
  const [tx] = s.nearOf.txs;
  const amount = s.nearOf.kind === 'date' ? tx.amount : s.amount;
  if (amount === tx.amount && tx.date === s.date) return null;
  return { id: tx.id, amount, date: s.date };
}
