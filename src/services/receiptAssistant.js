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
  getDetailPatterns, getAutoPaymentMethod, getDiscountRules, evaluateDiscountRule,
  getCalendarEvents, getCalendarEventTypes, getTripDefaultCategory,
} from './dbManager';
import { analyzeImage, AIError } from './aiClient';
import { today as todayStr } from './formulaEvaluator';
import { isValidDateStr as isValidDate, addDays } from './dateUtils';

const UNKNOWN = '모름';
const PATTERN_LIMIT = 40;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export const SOURCE_LABEL = {
  receipt: '영수증',
  text: '입력한 말',
  statement: '카드 내역',
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

export const normalizeName = s => String(s || '').toLowerCase().replace(/[^0-9a-z가-힣ぁ-んァ-ン一-龥]/g, '');

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
    const score = (match === Infinity ? 1e9 : match * 1e5) + Math.min(p.cnt, 99999);
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
  const history = matchHistory(db, merchant, detail);
  const sources = {};

  const outDetail = (history?.detail || detail || merchant || '').trim();
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

// ── 영수증 ──────────────────────────────────────────────────────

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    is_receipt: { type: 'boolean', description: '영수증·결제 내역 이미지이면 true' },
    date: { type: 'string', description: '결제일 YYYY-MM-DD. 보이지 않으면 빈 문자열' },
    merchant: { type: 'string', description: '가맹점(상호)명. 지점명 포함 가능' },
    total: { type: 'number', description: '실제 결제한 최종 금액(할인 후, 부가세 포함). 숫자만' },
    currency: { type: 'string', description: 'ISO 4217 통화 코드. 한국 원화는 KRW' },
    items: {
      type: 'array',
      description: '주요 품목 (최대 15개)',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, amount: { type: 'number' } },
        required: ['name', 'amount'],
      },
    },
    payment_hint: { type: 'string', description: '영수증에 찍힌 결제 수단 그대로 (예: 신한카드 1234, 현금, 카카오페이). 없으면 빈 문자열' },
    payment_method: { type: 'string', description: '결제수단 목록 중 하나, 판단이 어려우면 "모름"' },
    category: { type: 'string', description: '"카테고리 > 세부카테고리" 목록 중 하나, 판단이 어려우면 "모름"' },
    detail: { type: 'string', description: '가계부 세부내역에 쓸 짧은 이름. 입력 습관에 같은 가게가 있으면 그 표기 그대로' },
    confidence: { type: 'string', description: 'high | medium | low — 금액·날짜를 확실히 읽었는지' },
    note: { type: 'string', description: '사용자에게 알릴 점(흐림, 합계 불확실, 여러 장 등). 없으면 빈 문자열' },
  },
  required: ['is_receipt', 'date', 'merchant', 'total', 'currency', 'items', 'payment_hint',
    'payment_method', 'category', 'detail', 'confidence', 'note'],
};

const RECEIPT_SYSTEM = [
  '당신은 한국 가계부 앱의 영수증 입력 도우미입니다.',
  '영수증에서 실제로 보이는 사실만 추출하고, 보이지 않는 값은 지어내지 않습니다.',
  '분류(결제수단·카테고리)는 반드시 주어진 목록 안에서 고르고, 사용자의 기존 입력 습관을 우선합니다.',
].join(' ');

/** 영수증 AI 지시문 (테스트·디버깅용으로 노출) */
export function buildReceiptContext(db, today = todayStr()) {
  const ctx = buildDataContext(db, today);
  const prompt = [
    ctx.text,
    '',
    '[규칙]',
    '- total은 실제로 낸 최종 금액(할인 후). 쉼표·통화 기호 없이 숫자만.',
    '- 날짜가 안 보이면 빈 문자열. 연도가 없으면 오늘 기준 가장 가까운 과거 날짜.',
    '- payment_method·category는 위 목록의 표기 그대로, 애매하면 "모름".',
    '- detail은 입력 습관에 같은 가게가 있으면 그 표기를 그대로, 없으면 짧은 상호명.',
    '- 영수증이 아니면 is_receipt=false.',
  ].join('\n');
  return { ...ctx, prompt };
}

/** 영수증 이미지를 분석해 입력 추천을 돌려준다 */
export async function analyzeReceipt({ db, ai, image, signal, onProgress, today = todayStr() }) {
  const context = buildReceiptContext(db, today);
  const raw = await analyzeImage({
    ai, system: RECEIPT_SYSTEM, prompt: context.prompt, schema: RECEIPT_SCHEMA,
    toolName: 'record_receipt', image, signal, onProgress,
  });
  if (raw && raw.is_receipt === false) {
    throw new AIError('영수증으로 보이지 않습니다 — 영수증이 잘 보이게 다시 찍어 주세요', 'parse');
  }
  return buildSuggestion(db, raw || {}, { today });
}

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
  if (confidence === 'low') warnings.push('영수증이 잘 안 읽혔습니다 — 금액과 날짜를 꼭 확인하세요');
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
