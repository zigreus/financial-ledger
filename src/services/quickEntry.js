/**
 * AI 입력 (I-022) — 사진·카드 문자·말을 한 곳에 넣으면 알아서 읽고, 늘 넣던 거래는 바로 추가한다.
 *
 *  - 갈래: 사진 → 영수증(AI) / 카드 승인·취소 문자로 보이는 글 → 규칙(AI 없음) / 그 밖의 글 → 말로 입력(AI)
 *  - 바로 넣기: 사용자가 정한 기준 — "자주 쓰는 것으로 판단되면 바로 등록하고, 새로운 것 같으면 확인".
 *    자주 넣던 거래 = 같은 가게를 같은 카테고리·세부카테고리로 최근 1년에 2번 이상 넣었고(입력 습관),
 *    결제수단(카드 문자의 카드·글에 적힌 것·늘 같은 결제수단)·금액·날짜가 분명하며,
 *    확인할 거리(경고·중복·외화·취소·앞날짜)가 없는 것. 나머지는 지금처럼 확인받는다.
 *    바로 넣은 것도 되돌릴 수 있다(App의 알림·확인 화면의 버튼 → removeAddedTransactions).
 */
import { isSuggestionComplete, normalizeName } from './receiptAssistant';
import { findExistingTransaction } from './cardSms';
import { getDetailPatterns } from './dbManager';
import { todayStr } from './dateUtils';

export const FAMILIAR_MIN_COUNT = 2;

/**
 * 바로 넣은(되돌린) 거래를 다시 만났을 때 확인 목록에 붙이는 이유 — 체크를 끈 채 보인다.
 * 한 건 화면('이대로 채우기')에도 맞게 '고르세요'라고 쓴다
 */
export const QUICK_REASONS = {
  again: '앞에서 바로 넣은 거래예요 — 또 넣을 때만 고르세요',
  similar: '앞에서 바로 넣은 거래와 비슷해요 — 고쳐 말한 거라면 바로 넣은 것을 되돌린 뒤 고르세요',
  undone: '되돌린 거래예요 — 고쳐서 넣을 때만 고르세요',
  fixed: '앞에서 되돌린 거래를 고쳐 말한 것 같아요 — 맞으면 고르세요',
};

// 예전 세부내역과 가게 이름이 같거나, 한쪽이 다른 쪽을 품고 겹치는 글자가 이만큼은 돼야 같은 곳으로 본다
// (예: 예전 '커피' ↔ 이번 '커피빈'처럼 두 글자만 겹치면 다른 가게일 수 있다)
const SAME_PLACE_MIN_OVERLAP = 3;

// 말로 적은 글에 이런 말이 있으면 바로 넣지 않는다 — 취소·환불·거절·예약·할부는 넣을 거래인지, 얼마인지 확인이 필요하다
const UNSURE_WORDS_RE = /취소|환불|거절|반품|예정|예약|할부/;

/** 말로 적은 글로 바로 넣어도 되는지 (취소·예약 같은 말이 없을 때) */
export function mayAutoAddText(text) {
  return !UNSURE_WORDS_RE.test(String(text || ''));
}

/** 짧은 이름이 긴 이름 안에 있되, 바로 뒤에 숫자가 이어지지 않는다 — '이마트' ↔ '이마트24'는 다른 곳 */
function containsName(longer, shorter) {
  const i = longer.indexOf(shorter);
  if (i < 0) return false;
  return !/\d/.test(longer.charAt(i + shorter.length));
}

/** 두 이름이 같은 곳인지 — 같거나, 겹치는 글자가 3자 이상이고 한쪽이 다른 쪽을 품는다 */
function sameName(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < SAME_PLACE_MIN_OVERLAP) return false;
  return a.length >= b.length ? containsName(a, b) : containsName(b, a);
}

// 이름 바로 뒤에 붙어도 같은 이름으로 보는 말 — "스타벅스에서", "이마트랑"
const PARTICLES = new Set(['', '에서', '에', '서', '이랑', '랑', '하고', '으로', '로', '의', '은', '는', '이', '가', '을', '를', '도', '께']);

/**
 * 사용자가 쓴 글에 그 이름(정규화한 것)이 낱말로 있는지 — 띄어 쓴 이름("메가 커피")은 이어 붙여 본다.
 * 다른 이름의 일부는 아니어야 한다: '커피빈'에 '커피'는 없고, 3자 이상 이름 뒤에는 조사만 붙을 수 있다.
 */
function mentionsName(said, name) {
  if (!name) return false;
  const tokens = String(said || '').split(/[^0-9a-zA-Z가-힣ぁ-んァ-ン一-龥]+/).map(normalizeName).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    let joined = '';
    for (let j = i; j < tokens.length && j < i + 3; j += 1) {
      joined += tokens[j];
      if (joined === name) return true;
      if (name.length >= SAME_PLACE_MIN_OVERLAP && joined.startsWith(name) && PARTICLES.has(joined.slice(name.length))) return true;
      if (joined.length >= name.length) break;
    }
  }
  return false;
}

/**
 * 예전 습관과 같은 곳인지.
 * 말로 입력(said가 있음)은 AI가 습관의 표기로 바꿔 줄 수 있어, 사용자가 실제로 쓴 글에 이름이 있어야 한다:
 * 가게 이름을 읽었으면 그 이름이 글에 있고 습관과 같은 곳일 때, 못 읽었으면 습관의 이름이 글에 낱말로 있을 때.
 */
function samePlace(s, said) {
  const past = normalizeName(s.historyDetail);
  const merchant = normalizeName(s.merchant);
  if (!past) return false;
  if (said === undefined) return sameName(merchant, past);
  if (merchant) return mentionsName(said, merchant) && sameName(merchant, past);
  return mentionsName(said, past);
}

/** 글에 결제수단이 적혀 있는지 — '신한카드'는 '신한'만 말해도, '카카오페이'는 '카카오'만 말해도 된다 */
function mentionsPayment(said, method) {
  const words = normalizeName(said);
  const name = normalizeName(method);
  if (!name) return false;
  if (words.includes(name)) return true;
  const core = name.replace(/(카드|체크|페이|pay)$/, '');
  return core.length >= 2 && words.includes(core);
}

/**
 * 결제수단이 분명한지.
 *  - 카드 문자: 그 카드로 기억해 둔 결제수단이거나 카드사로 고른 것만 (습관으로 짐작한 것은 다른 카드일 수 있다)
 *  - 글·영수증에 적힌 결제수단을 그대로 맞춘 것 (말로 입력은 사용자가 쓴 글에 그 결제수단이 있어야 한다 — AI의 말만 믿지 않음)
 *  - 예전 습관: 이 가게를 늘 같은 결제수단으로 넣었을 때만 (영수증에 카드가 찍혔는데 맞추지 못했으면 아님)
 */
function surePayment(db, s, kind, said) {
  const source = s.sources?.payment_method;
  if (kind === 'sms') return source === 'sms';
  if (source === kind) return kind !== 'text' || mentionsPayment(said, s.payment_method); // 'text' | 'receipt'
  if (source !== 'history') return false;
  if (kind === 'receipt' && String(s.paymentHint || '').trim()) return false;
  const used = new Set(getDetailPatterns(db).filter(p => p.detail === s.historyDetail).map(p => p.payment_method));
  return used.size === 1 && used.has(s.payment_method);
}

/**
 * 바로 넣어도 되는지 — { familiar, reason }. 아니면 reason에 확인이 필요한 이유(화면에 보인다).
 * kind: 'receipt' | 'sms' | 'text'. said: 말로 입력이면 사용자가 쓴 글
 */
export function familiarity(db, s, kind, { said } = {}) {
  const no = reason => ({ familiar: false, reason });
  if (!s || s.kind === 'cancel') return no('승인 취소는 지울 거래를 확인해야 해요');
  if (!isSuggestionComplete(s)) return no('빈 칸이 있어요');
  if (!(Number(s.amount) > 0)) return no('금액을 확인해 주세요');
  if (s.currency && s.currency !== 'KRW') return no('외화 결제예요');
  if (s.event_id) return no('여행 일정에 넣는 거래예요');
  if (s.duplicateOf) return no('이미 넣은 거래 같아요');
  if (s.warnings && s.warnings.length) return no(s.warnings[0]);
  if (s.date > todayStr()) return no('앞날짜 거래예요');
  if (kind === 'receipt' && (s.confidence === 'low' || s.sources?.date !== 'receipt')) return no('영수증의 날짜·금액을 확인해 주세요');
  if (s.sources?.category !== 'history') return no('처음 보는 곳이에요');
  if ((Number(s.historyCount) || 0) < FAMILIAR_MIN_COUNT) return no('아직 자주 넣던 곳이 아니에요');
  const spoken = kind === 'text' ? String(said || '') : undefined;
  if (!samePlace(s, spoken)) return no(`예전의 '${s.historyDetail}'와 같은 곳인지 확인해 주세요`);
  if (!surePayment(db, s, kind, spoken)) return no('결제수단을 확인해 주세요');
  if (findExistingTransaction(db, s)) return no('같은 날 같은 금액 거래가 이미 있어요');
  return { familiar: true, reason: '' };
}

const batchKey = s => [s.date, s.amount, normalizeName(s.detail), s.payment_method].join('|');

/**
 * 추천 목록을 바로 넣을 것과 확인할 것으로 나눈다 — { familiar: [추천], review: [{ s, reason }] } (원래 순서 유지)
 * 한 번에 온 목록에 같은 거래가 둘 이상이면(고쳐 말한 것일 수 있다) 모두 확인받는다.
 * 말로 입력에서 여러 건이 같은 습관(세부내역)으로 맞춰졌으면, 글의 다른 건 이름으로 같은 곳이라 본 것일 수 있어 확인받는다.
 */
export function splitFamiliar(db, suggestions, kind, opts) {
  const tally = (keyOf) => {
    const counts = new Map();
    suggestions.forEach(s => { const k = keyOf(s); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
    return s => counts.get(keyOf(s)) || 0;
  };
  const sameTx = tally(batchKey);
  const samePast = tally(s => (kind === 'text' ? normalizeName(s.historyDetail) : ''));
  const familiar = [];
  const review = [];
  suggestions.forEach(s => {
    let f;
    if (sameTx(s) > 1) f = { familiar: false, reason: '같은 거래가 두 번 있어요 — 한 번만 넣을지 확인해 주세요' };
    else if (samePast(s) > 1) f = { familiar: false, reason: `'${s.historyDetail}' 거래가 여럿이에요 — 각각 맞는지 확인해 주세요` };
    else f = familiarity(db, s, kind, opts);
    if (f.familiar) familiar.push(s);
    else review.push({ s, reason: f.reason });
  });
  return { familiar, review };
}
