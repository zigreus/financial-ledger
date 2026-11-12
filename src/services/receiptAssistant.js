/**
 * AI 입력 추천 공통 + 영수증 → 거래 입력 추천.
 *
 * 1) AI에게 이 가계부의 결제수단·카테고리 목록, 사용자의 입력 습관, 여행 일정을 함께 보낸다.
 * 2) AI가 읽은 사실(날짜·가맹점·금액·통화·결제 흔적)과 분류 추천을 받는다.
 * 3) 기존 데이터로 다시 맞춘다 — 분류는 "이 가게를 예전에 어떻게 적었나"를 AI 추천보다 우선하고,
 *    목록에 없는 값은 버린다. 외화면 해당 통화의 여행 일정과 환율로 원화를 계산한다.
 * 각 항목에 근거(source)를 붙여 "이렇게 입력하시겠습니까?" 화면에서 보여준다.
 *
 * 영수증·말로 입력·카드 내역 대조가 아래 공통 함수(buildDataContext, classify,
 * pickPaymentMethod, resolveAmount, suggestionToTransaction)를 함께 쓴다.
 */
import {
  getPaymentMethods, getBudgetCategories, getSubCategories,
  getDetailPatterns, getBlankDetailHabits, getAutoPaymentMethod, getDiscountRules, evaluateDiscountRule,
  getCalendarEvents, getCalendarEventTypes, getTripDefaultCategory,
} from './dbManager';
import { today as todayStr } from './formulaEvaluator';
import { normalizeName } from './db/common';
import { isValidDateStr as isValidDate, addDays } from './dateUtils';

const UNKNOWN = '모름';
const PATTERN_LIMIT = 40;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export const SOURCE_LABEL = {
  receipt: '사진',
  text: '입력한 말',
  statement: '카드 내역',
  sms: '카드 문자',
  history: '기존 내역',
  ai: 'AI 추천',
  trip: '여행 일정',
  today: '오늘 날짜',
};

// ── AI에게 보낼 가계부 정보 ──────────────────────────────────────

function tripEventsOf(db) {
  const tripTypes = new Set(getCalendarEventTypes(db).filter(t => t.is_trip_type).map(t => t.value));
  return getCalendarEvents(db).filter(ev => tripTypes.has(ev.event_type) && (ev.countries || []).length);
}

export function categoryPaths(db) {
  const paths = [];
  getBudgetCategories(db).forEach(cat => {
    const subs = getSubCategories(db, cat);
    if (subs.length) subs.forEach(sub => paths.push(`${cat} > ${sub}`));
    else paths.push(cat);
  });
  return paths;
}

/**
 * 사용자가 사전에 동의한 범위(목록·입력 습관·여행 일정)만 담은 지시문 앞부분.
 * 영수증·말로 입력·카드 내역 대조가 함께 쓴다.
 */
export function buildDataContext(db, today = todayStr()) {
  const methods = getPaymentMethods(db);
  const paths = categoryPaths(db);
  const patterns = getDetailPatterns(db).slice(0, PATTERN_LIMIT);
  const blankHabits = getBlankDetailHabits(db);
  const trips = tripEventsOf(db).slice(0, 10);
  const dow = WEEKDAYS[new Date(`${today}T00:00:00`).getDay()];

  const lines = [
    `[오늘 날짜] ${today} (${dow}요일)`,
    '',
    `[결제수단 목록] ${methods.join(', ') || '(없음)'}`,
    '',
    '[카테고리 > 세부카테고리 목록]',
    ...paths,
    '',
    '[이 사용자의 입력 습관 — 세부내역 → 카테고리 / 결제수단 (횟수)]',
    ...(patterns.length
      ? patterns.map(p => `${p.detail} → ${p.budget_category}${p.sub_category ? ` > ${p.sub_category}` : ''} / ${p.payment_method} (${p.cnt})`)
      : ['(아직 없음)']),
    '',
    '[세부내역 — 꼭 채우지 않아도 됩니다]',
    '세부내역(detail)이 카테고리·세부카테고리 이름을 되풀이할 뿐이면 빈 문자열로 둔다 (예: 세부카테고리가 저녁인데 세부내역 "저녁"). 가게 이름·산 물건처럼 더 알려 주는 말이 있을 때만 적는다.',
    ...(blankHabits.length
      ? ['이 사용자가 보통 세부내역을 비워 두는 세부카테고리 (비운 횟수/전체):',
        ...blankHabits.map(h => `${h.budget_category} > ${h.sub_category} (${h.blank}/${h.total})`)]
      : []),
  ];
  if (trips.length) {
    lines.push('', '[여행 일정 — 외화 결제면 참고]');
    trips.forEach(ev => {
      const curs = ev.countries.map(c => c.currency).filter(Boolean).join('/');
      lines.push(`${ev.title} ${ev.date_from || ''}${ev.date_to ? `~${ev.date_to}` : ''} (${curs})`);
    });
  }
  return { methods, paths, patterns, text: lines.join('\n') };
}

// ── 기존 데이터로 맞추기 (공통) ──────────────────────────────────

export { normalizeName };

/** 추천 한 건을 가리키는 이름 — 세부내역, 없으면 가게, 그것도 없으면 세부카테고리 (세부내역은 비워 둘 수 있다, I-056) */
export const suggestionName = s => String(s?.detail || s?.merchant || s?.sub_category || '').trim();

// 정확히 같은 이름으로 찾은 습관의 점수 바닥 (matchHistory)
const EXACT_SCORE = 1e9;

// 가맹점명과 세부내역이 얼마나 구체적으로 맞는지 — 정확히 같으면 가장 높고,
// 한쪽이 다른 쪽을 포함하면 겹치는 글자 수(= 짧은 쪽 길이)가 길수록 높다. 맞지 않으면 0.
function nameMatchLength(key, detail) {
  if (key === detail) return Infinity;
  if (key.includes(detail) || detail.includes(key)) return Math.min(key.length, detail.length);
  return 0;
}

/**
 * 가맹점명으로 예전에 적어 둔 세부내역을 찾는다.
 * 더 구체적으로 맞는 것(정확히 같음 > 겹치는 글자가 긴 것)이 먼저이고, 횟수는 같은 수준끼리만 비교한다.
 * 예) "이마트 성수점" → 자주 쓴 "마트"(2자)보다 "이마트"(3자)
 * 반환: 패턴 행 + score (없으면 null)
 */
export function matchHistory(db, ...names) {
  const keys = names.map(normalizeName).filter(k => k.length >= 2);
  if (!keys.length) return null;
  let best = null;
  getDetailPatterns(db).forEach(p => {
    const d = normalizeName(p.detail);
    if (d.length < 2) return;
    const match = Math.max(...keys.map(k => nameMatchLength(k, d)));
    if (!match) return;
    // 구체성(정확 일치 1순위, 겹친 길이 2순위)을 먼저, 같은 수준이면 많이 쓴 순
    const score = (match === Infinity ? EXACT_SCORE : match * 1e5) + Math.min(p.cnt, 99999);
    if (!best || score > best.score) best = { ...p, score };
  });
  return best;
}

// 로컬 날짜 도우미는 dateUtils에 있다 — 다른 모듈이 이 이름으로 가져다 쓰므로 그대로 내보낸다
export { isValidDate, addDays };

/** 읽은 날짜가 올바르고 미래(하루 넘게)가 아니면 그 날짜, 아니면 오늘 */
export function resolveDate(raw, today, readSource) {
  if (isValidDate(raw) && raw <= addDays(today, 1)) return { date: raw, source: readSource };
  return { date: today, source: 'today' };
}

/** 외화 결제가 속할 여행 일정 — 날짜가 겹치는 일정, 없으면 가장 최근 일정 */
export function findTrip(db, currency, date) {
  const candidates = tripEventsOf(db)
    .map(ev => ({ ev, country: ev.countries.find(c => String(c.currency).trim().toUpperCase() === currency) }))
    .filter(x => x.country);
  if (!candidates.length) return null;
  const inRange = candidates.find(({ ev }) =>
    ev.date_from && date >= ev.date_from && date <= (ev.date_to || ev.date_from));
  if (inRange) return inRange;
  return candidates.sort((a, b) => (b.ev.date_from || '').localeCompare(a.ev.date_from || ''))[0];
}

/** 세부내역이 카테고리·세부카테고리 이름을 되풀이할 뿐인지 (공백·기호 무시) */
export function repeatsCategory(detail, cat, sub) {
  const d = normalizeName(detail);
  return !!d && (d === normalizeName(sub) || d === normalizeName(cat));
}

function splitPath(path, db) {
  const [cat, sub = ''] = String(path || '').split('>').map(s => s.trim());
  if (!cat || cat === UNKNOWN || !getBudgetCategories(db).includes(cat)) return null;
  const subs = getSubCategories(db, cat);
  return { cat, sub: subs.includes(sub) ? sub : '' };
}

/**
 * 세부내역·카테고리 — 예전 습관 > AI 추천, 여행 일정이면 여행 카테고리 안에서.
 * 반환: { detail, budget_category, sub_category, history, sources: { detail, category } }
 */
export function classify(db, { merchant, detail, aiCategory, eventId, readSource = 'receipt' }) {
  // AI가 고른 카테고리 이름을 되풀이한 세부내역('저녁' → 식비 > 저녁)은 가게 이름이 아니다 —
  // 예전에 똑같이 적은 것만 습관으로 보고, 겹치는 글자로는 찾지 않는다('저녁'이 '저녁회식'에 걸리지 않게)
  const aiPath = splitPath(aiCategory, db);
  const generic = name => !!aiPath && repeatsCategory(name, aiPath.cat, aiPath.sub);
  const named = name => (generic(name) ? '' : name);
  let history = matchHistory(db, named(merchant), named(detail));
  if (!history) {
    const exact = matchHistory(db, ...[merchant, detail].filter(generic));
    if (exact && exact.score >= EXACT_SCORE) history = exact;
  }
  const sources = {};

  let outDetail = (history?.detail || named(detail) || named(merchant) || '').trim();
  sources.detail = history ? 'history' : readSource;

  let category = null;
  if (history && getBudgetCategories(db).includes(history.budget_category)) {
    const subs = getSubCategories(db, history.budget_category);
    category = { cat: history.budget_category, sub: subs.includes(history.sub_category) ? history.sub_category : '' };
    sources.category = 'history';
  } else {
    category = splitPath(aiCategory, db);
    if (category) sources.category = 'ai';
  }
  const tripCategory = eventId ? getTripDefaultCategory(db) : '';
  if (tripCategory && (!category || category.cat !== tripCategory)) {
    const subs = getSubCategories(db, tripCategory);
    category = { cat: tripCategory, sub: category && subs.includes(category.sub) ? category.sub : '' };
    sources.category = 'trip';
  }

  // 세부내역은 꼭 채우지 않는다 — 고른 카테고리 이름을 되풀이할 뿐이면 비운다 (I-056)
  if (category && repeatsCategory(outDetail, category.cat, category.sub)) outDetail = '';
  if (!outDetail) delete sources.detail;

  return {
    detail: outDetail,
    budget_category: category?.cat || '',
    sub_category: category?.sub || '',
    history,
    sources,
  };
}

/** 결제수단 — 원문에 드러난 것 > 예전 습관 > 세부카테고리 패턴 */
export function pickPaymentMethod(db, { aiMethod, evident, history, sub, readSource = 'receipt' }) {
  const methods = getPaymentMethods(db);
  if (methods.includes(aiMethod)) return { payment_method: aiMethod, source: evident ? readSource : 'ai' };
  if (history && methods.includes(history.payment_method)) return { payment_method: history.payment_method, source: 'history' };
  if (sub) {
    const auto = getAutoPaymentMethod(db, sub);
    if (auto) return { payment_method: auto, source: 'history' };
  }
  return { payment_method: '', source: null };
}

/**
 * 금액·통화 → 원화 금액, 외화면 여행 일정·환율까지.
 * 반환: { amount, currency, foreignAmount, rate, event_id, eventTitle, warnings }
 */
export function resolveAmount(db, { total, currency: rawCurrency, date }) {
  const warnings = [];
  const currency = /^[A-Za-z]{3}$/.test(String(rawCurrency || '').trim())
    ? String(rawCurrency).trim().toUpperCase() : 'KRW';
  const value = Number(total) > 0 ? Number(total) : null;
  const out = { amount: null, currency, foreignAmount: null, rate: 0, event_id: null, eventTitle: '', warnings };

  if (value === null) {
    warnings.push('금액을 읽지 못했습니다 — 직접 입력하세요');
  } else if (currency === 'KRW') {
    out.amount = Math.round(value);
  } else {
    out.foreignAmount = Math.round(value * 100) / 100;
    const trip = findTrip(db, currency, date);
    if (trip) {
      out.event_id = trip.ev.id;
      out.eventTitle = trip.ev.title;
      out.rate = Number(trip.country.exchange_rate) || 0;
      if (out.rate > 0) out.amount = Math.round(out.foreignAmount * out.rate);
      else warnings.push(`'${out.eventTitle}' 일정에 ${currency} 환율이 없어 원화 금액은 직접 입력해야 합니다`);
    } else {
      warnings.push(`${currency} 결제지만 이 통화의 여행 일정이 없습니다 — 원화 금액을 직접 입력하세요`);
    }
  }
  return out;
}

/** 바로 저장할 수 있을 만큼 채워졌는지 (폼의 필수 항목과 같음) */
export function isSuggestionComplete(s) {
  return !!(s && s.payment_method && s.budget_category && s.sub_category && s.amount !== null && s.amount !== undefined);
}

/** 추천을 저장용 거래로 — 할인은 폼과 같은 결제수단 규칙으로 계산 */
export function suggestionToTransaction(db, s) {
  const discount = s.payment_method && s.payment_method !== '현금'
    ? evaluateDiscountRule(getDiscountRules(db, s.payment_method), s.budget_category, s.sub_category, s.amount, s.detail)
    : 0;
  return {
    payment_method: s.payment_method,
    date: s.date,
    budget_category: s.budget_category,
    sub_category: s.sub_category,
    detail: s.detail || '',
    amount: s.amount,
    discount_amount: discount > 0 ? discount : 0,
    event_id: s.event_id || null,
    foreign_amounts: s.event_id && s.foreignAmount !== null ? { [s.currency]: s.foreignAmount } : {},
  };
}

// ── 영수증 (사진 읽기는 services/photoEntry) ─────────────────────

/**
 * 영수증 AI 응답을 이 가계부 데이터에 맞춘 입력 추천으로 바꾼다.
 * 반환값의 sources는 항목별 근거 (SOURCE_LABEL 키).
 */
export function buildSuggestion(db, raw, { today = todayStr() } = {}) {
  const { date, source: dateSource } = resolveDate(raw.date, today, 'receipt');
  const money = resolveAmount(db, { total: raw.total, currency: raw.currency, date });
  const cls = classify(db, {
    merchant: raw.merchant, detail: raw.detail, aiCategory: raw.category, eventId: money.event_id,
  });
  const pay = pickPaymentMethod(db, {
    aiMethod: raw.payment_method, evident: !!raw.payment_hint, history: cls.history, sub: cls.sub_category,
  });

  const sources = { date: dateSource, ...cls.sources };
  if (money.event_id) sources.event = 'trip';
  if (pay.source) sources.payment_method = pay.source;

  const warnings = [...money.warnings];
  const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium';
  if (confidence === 'low') warnings.push('사진이 잘 안 읽혔습니다 — 금액과 날짜를 꼭 확인하세요');
  if (raw.note) warnings.push(String(raw.note));

  return {
    date,
    merchant: String(raw.merchant || '').trim(),
    detail: cls.detail,
    amount: money.amount,
    currency: money.currency,
    foreignAmount: money.foreignAmount,
    rate: money.rate,
    event_id: money.event_id,
    eventTitle: money.eventTitle,
    payment_method: pay.payment_method,
    paymentHint: String(raw.payment_hint || '').trim(),
    budget_category: cls.budget_category,
    sub_category: cls.sub_category,
    items: Array.isArray(raw.items)
      ? raw.items.filter(i => i && i.name).slice(0, 15).map(i => ({ name: String(i.name), amount: Number(i.amount) || 0 }))
      : [],
    historyDetail: cls.history?.detail || '',
    historyCount: cls.history?.cnt || 0,
    confidence,
    warnings,
    sources,
  };
}
