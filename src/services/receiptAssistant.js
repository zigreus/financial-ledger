/**
 * 영수증 → 거래 입력 추천.
 *
 * 1) AI에게 영수증 사진과 함께 이 가계부의 결제수단·카테고리 목록, 사용자의 입력 습관을 보낸다.
 * 2) AI가 읽은 사실(날짜·가맹점·금액·통화·결제 흔적)과 분류 추천을 받는다.
 * 3) 기존 데이터로 다시 맞춘다 — 분류는 "이 가게를 예전에 어떻게 적었나"를 AI 추천보다 우선하고,
 *    목록에 없는 값은 버린다. 외화면 해당 통화의 여행 일정과 환율로 원화를 계산한다.
 * 각 항목에 근거(source)를 붙여 "이렇게 입력하시겠습니까?" 화면에서 보여준다.
 */
import {
  getPaymentMethods, getBudgetCategories, getSubCategories,
  getDetailPatterns, getAutoPaymentMethod,
  getCalendarEvents, getCalendarEventTypes, getTripDefaultCategory,
} from './dbManager';
import { analyzeImage, AIError } from './aiClient';
import { today as todayStr } from './formulaEvaluator';

const UNKNOWN = '모름';
const PATTERN_LIMIT = 40;

export const SOURCE_LABEL = {
  receipt: '영수증',
  history: '기존 내역',
  ai: 'AI 추천',
  trip: '여행 일정',
  today: '오늘 날짜',
};

// ── AI 요청 구성 ────────────────────────────────────────────────

const SCHEMA = {
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

const SYSTEM = [
  '당신은 한국 가계부 앱의 영수증 입력 도우미입니다.',
  '영수증에서 실제로 보이는 사실만 추출하고, 보이지 않는 값은 지어내지 않습니다.',
  '분류(결제수단·카테고리)는 반드시 주어진 목록 안에서 고르고, 사용자의 기존 입력 습관을 우선합니다.',
].join(' ');

function tripEventsOf(db) {
  const tripTypes = new Set(getCalendarEventTypes(db).filter(t => t.is_trip_type).map(t => t.value));
  return getCalendarEvents(db).filter(ev => tripTypes.has(ev.event_type) && (ev.countries || []).length);
}

/** AI에게 보낼 가계부 정보 — 사용자가 사전에 동의한 범위(목록·입력 습관)만 담는다 */
export function buildReceiptContext(db, today = todayStr()) {
  const methods = getPaymentMethods(db);
  const paths = [];
  getBudgetCategories(db).forEach(cat => {
    const subs = getSubCategories(db, cat);
    if (subs.length) subs.forEach(sub => paths.push(`${cat} > ${sub}`));
    else paths.push(cat);
  });
  const patterns = getDetailPatterns(db).slice(0, PATTERN_LIMIT);
  const trips = tripEventsOf(db).slice(0, 10);

  const lines = [
    `[오늘 날짜] ${today}`,
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
    lines.push('', '[여행 일정 — 외화 영수증이면 참고]');
    trips.forEach(ev => {
      const curs = ev.countries.map(c => c.currency).filter(Boolean).join('/');
      lines.push(`${ev.title} ${ev.date_from || ''}${ev.date_to ? `~${ev.date_to}` : ''} (${curs})`);
    });
  }
  lines.push(
    '',
    '[규칙]',
    '- total은 실제로 낸 최종 금액(할인 후). 쉼표·통화 기호 없이 숫자만.',
    '- 날짜가 안 보이면 빈 문자열. 연도가 없으면 오늘 기준 가장 가까운 과거 날짜.',
    '- payment_method·category는 위 목록의 표기 그대로, 애매하면 "모름".',
    '- detail은 입력 습관에 같은 가게가 있으면 그 표기를 그대로, 없으면 짧은 상호명.',
    '- 영수증이 아니면 is_receipt=false.',
  );

  return { methods, paths, patterns, prompt: lines.join('\n') };
}

/** 영수증 이미지를 분석해 입력 추천을 돌려준다 */
export async function analyzeReceipt({ db, ai, image, signal, today = todayStr() }) {
  const context = buildReceiptContext(db, today);
  const raw = await analyzeImage({
    ai, system: SYSTEM, prompt: context.prompt, schema: SCHEMA,
    toolName: 'record_receipt', image, signal,
  });
  if (raw && raw.is_receipt === false) {
    throw new AIError('영수증으로 보이지 않습니다 — 영수증이 잘 보이게 다시 찍어 주세요', 'parse');
  }
  return buildSuggestion(db, raw || {}, { today });
}

// ── 기존 데이터로 맞추기 ─────────────────────────────────────────

const norm = s => String(s || '').toLowerCase().replace(/[^0-9a-z가-힣ぁ-んァ-ン一-龥]/g, '');

/** 가맹점명으로 예전에 적어 둔 세부내역을 찾는다 (많이 쓴 것, 더 구체적인 것 우선) */
export function matchHistory(db, ...names) {
  const keys = names.map(norm).filter(k => k.length >= 2);
  if (!keys.length) return null;
  let best = null;
  getDetailPatterns(db).forEach(p => {
    const d = norm(p.detail);
    if (d.length < 2) return;
    if (!keys.some(k => k.includes(d) || d.includes(k))) return;
    const score = p.cnt * 100 + d.length;
    if (!best || score > best.score) best = { ...p, score };
  });
  return best;
}

// 로컬 날짜로 비교한다 — toISOString()은 UTC라 한국 시간에선 하루 전 날짜가 나온다
function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 외화 영수증이 속할 여행 일정 — 날짜가 겹치는 일정, 없으면 가장 최근 일정 */
function findTrip(db, currency, date) {
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
 * AI 응답을 이 가계부 데이터에 맞춘 입력 추천으로 바꾼다.
 * 반환값의 sources는 항목별 근거 (SOURCE_LABEL 키).
 */
export function buildSuggestion(db, raw, { today = todayStr() } = {}) {
  const sources = {};
  const warnings = [];
  const methods = getPaymentMethods(db);

  // 날짜 — 읽은 날짜가 미래(하루 넘게)면 오인식으로 본다
  let date = today;
  sources.date = 'today';
  if (isValidDate(raw.date) && raw.date <= addDays(today, 1)) {
    date = raw.date;
    sources.date = 'receipt';
  }

  // 예전 입력 습관
  const history = matchHistory(db, raw.merchant, raw.detail);

  // 세부내역
  const detail = (history?.detail || raw.detail || raw.merchant || '').trim();
  sources.detail = history ? 'history' : 'receipt';

  // 금액 · 통화 · 여행 일정
  const currency = /^[A-Za-z]{3}$/.test(String(raw.currency || '').trim())
    ? String(raw.currency).trim().toUpperCase() : 'KRW';
  const total = Number(raw.total) > 0 ? Number(raw.total) : null;
  let amount = null;
  let foreignAmount = null;
  let eventId = null;
  let eventTitle = '';
  let rate = 0;

  if (total === null) {
    warnings.push('금액을 읽지 못했습니다 — 직접 입력하세요');
  } else if (currency === 'KRW') {
    amount = Math.round(total);
  } else {
    foreignAmount = Math.round(total * 100) / 100;
    const trip = findTrip(db, currency, date);
    if (trip) {
      eventId = trip.ev.id;
      eventTitle = trip.ev.title;
      rate = Number(trip.country.exchange_rate) || 0;
      sources.event = 'trip';
      if (rate > 0) amount = Math.round(foreignAmount * rate);
      else warnings.push(`'${eventTitle}' 일정에 ${currency} 환율이 없어 원화 금액은 직접 입력해야 합니다`);
    } else {
      warnings.push(`${currency} 영수증이지만 이 통화의 여행 일정이 없습니다 — 원화 금액을 직접 입력하세요`);
    }
  }

  // 카테고리 — 예전 습관 > AI 추천, 여행 중이면 여행 카테고리 안에서
  let category = null;
  if (history && getBudgetCategories(db).includes(history.budget_category)) {
    const subs = getSubCategories(db, history.budget_category);
    category = { cat: history.budget_category, sub: subs.includes(history.sub_category) ? history.sub_category : '' };
    sources.category = 'history';
  } else {
    category = splitPath(raw.category, db);
    if (category) sources.category = 'ai';
  }
  const tripCategory = eventId ? getTripDefaultCategory(db) : '';
  if (tripCategory && (!category || category.cat !== tripCategory)) {
    const subs = getSubCategories(db, tripCategory);
    category = { cat: tripCategory, sub: category && subs.includes(category.sub) ? category.sub : '' };
    sources.category = 'trip';
  }

  // 결제수단 — 영수증에 찍힌 것 > 예전 습관 > 세부카테고리 패턴
  let paymentMethod = '';
  if (methods.includes(raw.payment_method)) {
    paymentMethod = raw.payment_method;
    sources.payment_method = raw.payment_hint ? 'receipt' : 'ai';
  } else if (history && methods.includes(history.payment_method)) {
    paymentMethod = history.payment_method;
    sources.payment_method = 'history';
  } else if (category?.sub) {
    const auto = getAutoPaymentMethod(db, category.sub);
    if (auto) { paymentMethod = auto; sources.payment_method = 'history'; }
  }

  const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium';
  if (confidence === 'low') warnings.push('영수증이 잘 안 읽혔습니다 — 금액과 날짜를 꼭 확인하세요');
  if (raw.note) warnings.push(String(raw.note));

  return {
    date,
    merchant: String(raw.merchant || '').trim(),
    detail,
    amount,
    currency,
    foreignAmount,
    rate,
    event_id: eventId,
    eventTitle,
    payment_method: paymentMethod,
    paymentHint: String(raw.payment_hint || '').trim(),
    budget_category: category?.cat || '',
    sub_category: category?.sub || '',
    items: Array.isArray(raw.items)
      ? raw.items.filter(i => i && i.name).slice(0, 15).map(i => ({ name: String(i.name), amount: Number(i.amount) || 0 }))
      : [],
    historyDetail: history?.detail || '',
    historyCount: history?.cnt || 0,
    confidence,
    warnings,
    sources,
  };
}
