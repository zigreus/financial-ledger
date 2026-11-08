/**
 * 거래내역 필터 (ROADMAP C-7, I-021) — 화면의 필터 상태를 getTransactions 조건으로 바꾸고, 사람이 읽는 설명을 만든다.
 *
 *  - 기간: 이번 달·지난달·최근 3개월·올해·작년·월 고르기·직접 입력 → dateFrom/dateTo/month
 *  - 결제수단·카테고리: 여러 개(그중 하나면 된다)
 *  - 금액: 순지출(amount - discount_amount) 범위, 음수도 된다(환불). 입력은 AmountInput 문자열 그대로 들고 있다가 여기서
 *    계산한다(AGENTS §4) — 잘못된 값은 0으로 만들지 않고 그 칸만 걸지 않는다(이유는 금액 칸이 같은 기준으로 보여 준다)
 *  - 저장한 필터: 이 기기 localStorage. 꺼낼 때 지금 가계부에 없는 이름(바뀌거나 지운 결제수단·카테고리·구성원)은 버린다(AGENTS §3)
 */
import { todayStr, addMonths, addDays, isValidDateStr } from './dateUtils';
import { parseOptionalAmount, isIncompleteFormula, formatAmount } from './formulaEvaluator';
import { MEMBER_NONE } from './dbManager';

export const EMPTY_FILTERS = {
  search: '', period: '', month: '', dateFrom: '', dateTo: '',
  payment_methods: [], budget_categories: [], member: '', amountMin: '', amountMax: '',
};

export const PERIODS = [
  { id: '', label: '전체 기간' },
  { id: 'this_month', label: '이번 달' },
  { id: 'last_month', label: '지난달' },
  { id: 'last_3_months', label: '최근 3개월' },
  { id: 'this_year', label: '올해' },
  { id: 'last_year', label: '작년' },
  { id: 'month', label: '월 고르기' },
  { id: 'custom', label: '직접 입력' },
];

const lastDayOf = ym => addDays(`${addMonths(ym, 1)}-01`, -1);

/** 기간 → { dateFrom, dateTo, month, error } (빈 값은 조건 없음) */
export function resolvePeriod(f, today = todayStr()) {
  const ym = today.slice(0, 7);
  const year = Number(today.slice(0, 4));
  switch (f.period) {
    case 'this_month': return { dateFrom: `${ym}-01`, dateTo: lastDayOf(ym) };
    case 'last_month': { const m = addMonths(ym, -1); return { dateFrom: `${m}-01`, dateTo: lastDayOf(m) }; }
    case 'last_3_months': return { dateFrom: `${addMonths(ym, -2)}-01`, dateTo: lastDayOf(ym) };
    case 'this_year': return { dateFrom: `${year}-01-01`, dateTo: `${year}-12-31` };
    case 'last_year': return { dateFrom: `${year - 1}-01-01`, dateTo: `${year - 1}-12-31` };
    case 'month': return /^\d{4}-\d{2}$/.test(f.month || '') ? { month: f.month } : {};
    case 'custom': {
      const from = (f.dateFrom || '').trim();
      const to = (f.dateTo || '').trim();
      if ((from && !isValidDateStr(from)) || (to && !isValidDateStr(to))) return { error: '날짜를 올바르게 입력하세요' };
      if (from && to && from > to) return { error: '시작일이 끝나는 날보다 늦습니다' };
      return { dateFrom: from || undefined, dateTo: to || undefined };
    }
    default: return {};
  }
}

/** 금액 칸 하나 → { value(null이면 조건 없음), error } */
export function parseAmountBound(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { value: null, error: '' };
  if (isIncompleteFormula(text)) return { value: null, error: '수식을 마저 입력하세요', incomplete: true };
  // 음수도 받는다 — 순지출은 환불·환차익으로 음수일 수 있다(금액 칸도 allowNegative라 같은 기준으로 오류를 보인다)
  const n = parseOptionalAmount(text, { allowNegative: true });
  if (Number.isNaN(n)) return { value: null, error: '금액을 올바르게 입력하세요' };
  return { value: n, error: '' };
}

/**
 * 화면 필터 → { query: getTransactions 조건, errors: { period, amount } }
 * 잘못된 부분은 그 조건만 빼고 건다 — 최소·최대는 따로: 한쪽이 잘못돼도 맞는 쪽은 건다.
 * errors.amount는 화면에 보일 이유: 입력 중인 수식, 최소 > 최대. (잘못된 값은 금액 칸 자체가 오류를 보여 주므로 여기 넣지 않는다)
 */
export function toQuery(f, today = todayStr()) {
  const errors = {};
  const query = {};
  if (f.search && f.search.trim()) query.search = f.search.trim();
  if (f.member) query.member = f.member;
  if (f.payment_methods?.length) query.payment_methods = [...f.payment_methods];
  if (f.budget_categories?.length) query.budget_categories = [...f.budget_categories];

  const period = resolvePeriod(f, today);
  if (period.error) errors.period = period.error;
  else {
    if (period.month) query.month = period.month;
    if (period.dateFrom) query.dateFrom = period.dateFrom;
    if (period.dateTo) query.dateTo = period.dateTo;
  }

  const min = parseAmountBound(f.amountMin);
  const max = parseAmountBound(f.amountMax);
  const amountNotes = [];
  if (min.incomplete) amountNotes.push(`최소 금액: ${min.error}`);
  if (max.incomplete) amountNotes.push(`최대 금액: ${max.error}`);
  if (min.value !== null && max.value !== null && min.value > max.value) {
    amountNotes.push('최소 금액이 최대 금액보다 큽니다');
  } else {
    if (min.value !== null) query.amountMin = min.value;
    if (max.value !== null) query.amountMax = max.value;
  }
  if (amountNotes.length) errors.amount = amountNotes.join(' · ');
  return { query, errors };
}

/** 기본값과 다른 조건이 하나라도 있는지 (검색어 포함) */
export function isFiltered(f) {
  return !!((f.search && f.search.trim()) || f.period || f.member
    || f.payment_methods?.length || f.budget_categories?.length
    || String(f.amountMin ?? '').trim() || String(f.amountMax ?? '').trim());
}

/** 걸린 조건을 사람이 읽는 한 줄로 — 요약 화면과 AI 요약 지시문이 쓴다. 조건이 없으면 '전체 거래' */
export function describeFilters(f, query) {
  const parts = [];
  const period = PERIODS.find(p => p.id === f.period);
  const label = period && period.id !== 'custom' ? `(${period.label})` : '';
  if (query.month) parts.push(`기간 ${query.month}`);
  else if (query.dateFrom && query.dateTo) parts.push(`기간 ${query.dateFrom}~${query.dateTo}${label}`);
  else if (query.dateFrom) parts.push(`기간 ${query.dateFrom} 이후`); // 자동등록한 앞날 거래도 들어간다
  else if (query.dateTo) parts.push(`기간 ${query.dateTo}까지`);
  if (query.payment_methods?.length) parts.push(`결제수단 ${query.payment_methods.join(', ')}`);
  if (query.budget_categories?.length) parts.push(`카테고리 ${query.budget_categories.join(', ')}`);
  if (query.amountMin !== undefined && query.amountMax !== undefined) parts.push(`금액 ${formatAmount(query.amountMin)}~${formatAmount(query.amountMax)}원`);
  else if (query.amountMin !== undefined) parts.push(`금액 ${formatAmount(query.amountMin)}원 이상`);
  else if (query.amountMax !== undefined) parts.push(`금액 ${formatAmount(query.amountMax)}원 이하`);
  if (query.member) parts.push(query.member === MEMBER_NONE ? '누가: 지정 안 함' : `누가 ${query.member}`);
  if (query.search) parts.push(`검색어 "${query.search}"`);
  return parts.length ? parts.join(' · ') : '전체 거래';
}

/** 기간 조건이 오늘을 빼는지 — 거래내역 탭을 다시 눌러 '오늘로' 갈 때 풀어야 하는지 */
export function excludesToday(query, today = todayStr()) {
  if (query.month) return query.month !== today.slice(0, 7);
  return !!((query.dateFrom && query.dateFrom > today) || (query.dateTo && query.dateTo < today));
}

/** 기간 조건만 푼 필터 */
export const withoutPeriod = f => ({ ...f, period: '', month: '', dateFrom: '', dateTo: '' });

// ── 지금 화면의 필터 (탭을 옮겨도 이어지게, 이 탭에서만) ──────────────

const SESSION_KEY = 'fl_list_filters';

/** 탭을 옮겼다 돌아올 때 이어 쓸 필터 — 없거나 읽지 못하면 기본값 */
export function loadSessionFilters() {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    return raw ? cleanFilters(JSON.parse(raw)) : { ...EMPTY_FILTERS };
  } catch (e) {
    return { ...EMPTY_FILTERS };
  }
}

export function storeSessionFilters(f) {
  try { window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(f)); } catch (e) { /* 이어 쓰지 못할 뿐 */ }
}

// ── 저장한 필터 (이 기기) ─────────────────────────────────────────

const SAVED_KEY = 'ledger_saved_filters';
export const SAVED_MAX = 10;
export const SAVED_NAME_MAX = 20;

const cleanFilters = (raw) => {
  const f = { ...EMPTY_FILTERS };
  if (!raw || typeof raw !== 'object') return f;
  Object.keys(EMPTY_FILTERS).forEach(key => {
    const v = raw[key];
    if (Array.isArray(EMPTY_FILTERS[key])) f[key] = Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
    else if (typeof v === 'string') f[key] = v;
  });
  if (!PERIODS.some(p => p.id === f.period)) f.period = '';
  return f;
};

/** 저장한 필터 목록 [{ name, filters }] — 읽지 못하면 [] */
export function loadSavedFilters() {
  try {
    const list = JSON.parse(window.localStorage.getItem(SAVED_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    return list
      .filter(x => x && typeof x.name === 'string' && x.name.trim())
      .slice(0, SAVED_MAX)
      .map(x => ({ name: x.name.trim().slice(0, SAVED_NAME_MAX), filters: cleanFilters(x.filters) }));
  } catch (e) {
    return [];
  }
}

function storeSaved(list) {
  try { window.localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch (e) { /* 저장 공간 부족·비공개 모드 — 이번 화면에서만 */ }
  return list;
}

/** 지금 필터를 이름을 붙여 저장한다(같은 이름은 바꾼다). 새 목록을 돌려준다. 이름이 없거나 너무 많으면 오류 */
export function saveFilter(list, name, filters) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('필터 이름을 적어 주세요');
  if (trimmed.length > SAVED_NAME_MAX) throw new Error(`이름은 ${SAVED_NAME_MAX}자까지 쓸 수 있습니다`);
  const rest = list.filter(x => x.name !== trimmed);
  if (rest.length >= SAVED_MAX) throw new Error(`필터는 ${SAVED_MAX}개까지 저장할 수 있습니다 — 안 쓰는 필터를 지워 주세요`);
  return storeSaved([...rest, { name: trimmed, filters: cleanFilters(filters) }]);
}

export function deleteSavedFilter(list, name) {
  return storeSaved(list.filter(x => x.name !== name));
}

/**
 * 저장한 필터를 지금 가계부에 맞춘다 — 없는 결제수단·카테고리·구성원은 버린다(이름을 바꾸거나 지웠을 수 있다).
 * known: { paymentMethods: [이름], categories: [이름], members: [이름] }. 반환: { filters, dropped: [버린 이름] }
 */
export function fitSavedFilters(filters, known) {
  const f = cleanFilters(filters);
  const dropped = [];
  const keep = (names, allowed) => names.filter(n => (allowed.includes(n) ? true : (dropped.push(n), false)));
  f.payment_methods = keep(f.payment_methods, known.paymentMethods || []);
  f.budget_categories = keep(f.budget_categories, known.categories || []);
  if (f.member && f.member !== MEMBER_NONE && !(known.members || []).includes(f.member)) {
    dropped.push(f.member);
    f.member = '';
  }
  return { filters: f, dropped };
}
