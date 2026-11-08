/**
 * @vitest-environment jsdom
 */
// 거래내역 필터 (ROADMAP C-7, I-021) — 기간·여러 개 선택·금액 범위, 설명, 저장한 필터
import initSqlJs from 'sql.js';
import { createDatabase, addTransaction, getTransactions, MEMBER_NONE } from '../dbManager';
import {
  EMPTY_FILTERS, resolvePeriod, parseAmountBound, toQuery, isFiltered, describeFilters,
  excludesToday, withoutPeriod, loadSessionFilters, storeSessionFilters,
  loadSavedFilters, saveFilter, deleteSavedFilter, fitSavedFilters, SAVED_MAX,
} from '../txFilters';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => { window.localStorage.clear(); });

const TODAY = '2026-11-08';
const f = (patch) => ({ ...EMPTY_FILTERS, ...patch });

describe('기간', () => {
  test.each([
    ['this_month', { dateFrom: '2026-11-01', dateTo: '2026-11-30' }],
    ['last_month', { dateFrom: '2026-10-01', dateTo: '2026-10-31' }],
    ['last_3_months', { dateFrom: '2026-09-01', dateTo: '2026-11-30' }],
    ['this_year', { dateFrom: '2026-01-01', dateTo: '2026-12-31' }],
    ['last_year', { dateFrom: '2025-01-01', dateTo: '2025-12-31' }],
    ['', {}],
  ])('%s', (period, expected) => {
    expect(resolvePeriod(f({ period }), TODAY)).toEqual(expected);
  });

  test('해가 바뀌는 달·2월 말일도 맞다', () => {
    expect(resolvePeriod(f({ period: 'last_month' }), '2026-01-15')).toEqual({ dateFrom: '2025-12-01', dateTo: '2025-12-31' });
    expect(resolvePeriod(f({ period: 'this_month' }), '2028-02-10')).toEqual({ dateFrom: '2028-02-01', dateTo: '2028-02-29' });
    expect(resolvePeriod(f({ period: 'last_3_months' }), '2026-02-03')).toEqual({ dateFrom: '2025-12-01', dateTo: '2026-02-28' });
  });

  test('월 고르기·직접 입력 — 잘못된 날짜와 거꾸로 된 기간은 이유를 알려 준다', () => {
    expect(resolvePeriod(f({ period: 'month', month: '2026-03' }), TODAY)).toEqual({ month: '2026-03' });
    expect(resolvePeriod(f({ period: 'month', month: '' }), TODAY)).toEqual({});
    expect(resolvePeriod(f({ period: 'custom', dateFrom: '2026-03-01', dateTo: '2026-03-31' }), TODAY))
      .toEqual({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });
    expect(resolvePeriod(f({ period: 'custom', dateFrom: '2026-03-01' }), TODAY)).toEqual({ dateFrom: '2026-03-01', dateTo: undefined });
    expect(resolvePeriod(f({ period: 'custom', dateFrom: '2026-04-01', dateTo: '2026-03-01' }), TODAY).error).toBe('시작일이 끝나는 날보다 늦습니다');
    expect(resolvePeriod(f({ period: 'custom', dateFrom: '2026-02-30' }), TODAY).error).toBe('날짜를 올바르게 입력하세요');
  });
});

describe('금액 범위', () => {
  test('빈 칸은 조건 없음, 수식은 계산, 잘못된 값·입력 중인 수식은 0으로 만들지 않고 이유를 준다', () => {
    expect(parseAmountBound('')).toEqual({ value: null, error: '' });
    expect(parseAmountBound('1만')).toEqual({ value: null, error: '금액을 올바르게 입력하세요' });
    expect(parseAmountBound('10000+5000')).toEqual({ value: 15000, error: '' });
    expect(parseAmountBound('10000+')).toEqual({ value: null, error: '수식을 마저 입력하세요', incomplete: true });
    expect(parseAmountBound('-500')).toEqual({ value: -500, error: '' });   // 환불·환차익은 순지출이 음수
    expect(parseAmountBound('0')).toEqual({ value: 0, error: '' });
  });

  test('잘못된 칸은 그 칸만 걸지 않는다 — 맞는 칸은 걸고, 이유는 금액 칸 자체가 보여 준다', () => {
    expect(toQuery(f({ amountMin: '1만' }), TODAY)).toEqual({ query: {}, errors: {} });
    expect(toQuery(f({ amountMin: '1만', amountMax: '5000' }), TODAY)).toEqual({ query: { amountMax: 5000 }, errors: {} });
  });

  test('입력 중인 수식은 칸마다 알리고, 최소가 최대보다 크면 둘 다 걸지 않는다 — 같으면 정확히 그 금액', () => {
    expect(toQuery(f({ amountMin: '1000+', amountMax: '5000*' }), TODAY).errors.amount)
      .toBe('최소 금액: 수식을 마저 입력하세요 · 최대 금액: 수식을 마저 입력하세요');
    expect(toQuery(f({ amountMin: '5000', amountMax: '1000' }), TODAY)).toEqual({ query: {}, errors: { amount: '최소 금액이 최대 금액보다 큽니다' } });
    expect(toQuery(f({ amountMin: '5000', amountMax: '5000' }), TODAY)).toEqual({ query: { amountMin: 5000, amountMax: 5000 }, errors: {} });
    expect(toQuery(f({ amountMin: '1000', amountMax: '5000' }), TODAY).query).toEqual({ amountMin: 1000, amountMax: 5000 });
  });
});

describe('조회 조건과 실제 거래', () => {
  function ledger() {
    const { db } = createDatabase(SQL, null);
    const add = (o) => addTransaction(db, { sub_category: '', detail: '', discount_amount: 0, ...o });
    add({ date: '2026-11-03', payment_method: '신한카드', budget_category: '식비', detail: '스타벅스', amount: 5000 });
    add({ date: '2026-11-04', payment_method: '현금', budget_category: '식비', detail: '시장', amount: 20000, member: '엄마' });
    add({ date: '2026-10-20', payment_method: '삼성카드', budget_category: '쇼핑', detail: '쿠팡', amount: 50000, discount_amount: 45000 });
    add({ date: '2025-12-31', payment_method: '신한카드', budget_category: '교통', detail: '택시', amount: 12000 });
    return db;
  }
  const details = (db, filters) => getTransactions(db, toQuery(f(filters), TODAY).query).map(t => t.detail);

  test('결제수단·카테고리는 여러 개 중 하나면 된다', () => {
    const db = ledger();
    expect(details(db, { payment_methods: ['신한카드', '현금'] })).toEqual(['시장', '스타벅스', '택시']);
    expect(details(db, { budget_categories: ['식비', '교통'], payment_methods: ['신한카드'] })).toEqual(['스타벅스', '택시']);
  });

  test('금액은 순지출(할인 뺀 금액)로 걸러 월 합계와 같은 기준이다', () => {
    const db = ledger();
    expect(details(db, { amountMin: '10000' })).toEqual(['시장', '택시']);       // 쿠팡은 50,000-45,000=5,000
    expect(details(db, { amountMax: '5000' })).toEqual(['스타벅스', '쿠팡']);
  });

  test('기간·검색어·누가를 함께 건다, 조건이 없으면 전부', () => {
    const db = ledger();
    expect(details(db, { period: 'this_year' })).toEqual(['시장', '스타벅스', '쿠팡']);
    expect(details(db, { period: 'this_month', search: '스타' })).toEqual(['스타벅스']);
    expect(details(db, { member: '엄마' })).toEqual(['시장']);
    expect(details(db, { member: MEMBER_NONE, period: 'this_month' })).toEqual(['스타벅스']);
    expect(details(db, {})).toHaveLength(4);
  });

  test('이름에 따옴표·괄호가 있어도 그대로 비교한다 (값은 ?로 바인딩)', () => {
    const { db } = createDatabase(SQL, null);
    addTransaction(db, { date: '2026-11-01', payment_method: "O'Reilly (카드)", budget_category: '식비', sub_category: '', detail: 'x', amount: 1 });
    expect(details(db, { payment_methods: ["O'Reilly (카드)"] })).toEqual(['x']);
  });
});

test('조건이 걸렸는지와 사람이 읽는 설명', () => {
  expect(isFiltered(EMPTY_FILTERS)).toBe(false);
  expect(isFiltered(f({ search: '  ' }))).toBe(false);
  expect(isFiltered(f({ payment_methods: ['현금'] }))).toBe(true);
  expect(isFiltered(f({ amountMax: '5000' }))).toBe(true);
  expect(isFiltered(f({ member: '엄마' }))).toBe(true);
  expect(isFiltered(f({ period: 'this_month' }))).toBe(true);

  const filters = f({ period: 'this_year', payment_methods: ['신한카드', '현금'], budget_categories: ['식비'], amountMin: '10000', search: '스타벅스', member: '엄마' });
  expect(describeFilters(filters, toQuery(filters, TODAY).query))
    .toBe('기간 2026-01-01~2026-12-31(올해) · 결제수단 신한카드, 현금 · 카테고리 식비 · 금액 10,000원 이상 · 누가 엄마 · 검색어 "스타벅스"');
  expect(describeFilters(EMPTY_FILTERS, {})).toBe('전체 거래');
  const month = f({ period: 'month', month: '2026-03', amountMax: '3000', member: MEMBER_NONE });
  expect(describeFilters(month, toQuery(month, TODAY).query)).toBe('기간 2026-03 · 금액 3,000원 이하 · 누가: 지정 안 함');
  // 한쪽만 정한 기간 — 자동등록한 앞날 거래도 들어가므로 '지금'이 아니라 '이후'
  expect(describeFilters(f({ period: 'custom' }), { dateFrom: '2026-03-01' })).toBe('기간 2026-03-01 이후');
  expect(describeFilters(f({ period: 'custom' }), { dateTo: '2026-03-31' })).toBe('기간 2026-03-31까지');
});

test('오늘을 빼는 기간인지 — 거래내역 탭을 다시 눌러 오늘로 갈 때 기간만 푼다', () => {
  expect(excludesToday({}, TODAY)).toBe(false);
  expect(excludesToday({ month: '2026-11' }, TODAY)).toBe(false);
  expect(excludesToday({ month: '2026-10' }, TODAY)).toBe(true);
  expect(excludesToday({ dateFrom: '2026-01-01', dateTo: '2026-12-31' }, TODAY)).toBe(false);
  expect(excludesToday({ dateFrom: '2025-01-01', dateTo: '2025-12-31' }, TODAY)).toBe(true);
  expect(excludesToday({ dateFrom: '2026-12-01' }, TODAY)).toBe(true);
  expect(withoutPeriod(f({ period: 'custom', dateFrom: '2026-01-01', month: '2026-03', search: 'x', payment_methods: ['현금'] })))
    .toEqual(f({ search: 'x', payment_methods: ['현금'] }));
});

test('지금 화면의 필터는 탭을 옮겨도 이어지고(이 탭에서만), 깨진 값은 기본값', () => {
  window.sessionStorage.clear();
  expect(loadSessionFilters()).toEqual(EMPTY_FILTERS);
  storeSessionFilters(f({ period: 'custom', dateFrom: '2026-03-01', budget_categories: ['식비'], amountMin: '1000+' }));
  expect(loadSessionFilters()).toEqual(f({ period: 'custom', dateFrom: '2026-03-01', budget_categories: ['식비'], amountMin: '1000+' }));
  window.sessionStorage.setItem('fl_list_filters', '{깨짐');
  expect(loadSessionFilters()).toEqual(EMPTY_FILTERS);
});

describe('저장한 필터 (이 기기)', () => {
  test('저장·같은 이름은 바꾸기·지우기 — 다시 열어도 남는다', () => {
    let list = saveFilter([], '올해 카페', f({ period: 'this_year', search: '카페' }));
    list = saveFilter(list, '현금', f({ payment_methods: ['현금'] }));
    list = saveFilter(list, '올해 카페', f({ period: 'this_year', search: '스타벅스' }));
    expect(loadSavedFilters().map(s => [s.name, s.filters.search])).toEqual([['현금', ''], ['올해 카페', '스타벅스']]);
    expect(deleteSavedFilter(list, '현금').map(s => s.name)).toEqual(['올해 카페']);
    expect(loadSavedFilters().map(s => s.name)).toEqual(['올해 카페']);
  });

  test('이름이 없거나 너무 많으면 이유를 알려 준다', () => {
    expect(() => saveFilter([], '  ', EMPTY_FILTERS)).toThrow('필터 이름을 적어 주세요');
    let list = [];
    for (let i = 0; i < SAVED_MAX; i += 1) list = saveFilter(list, `필터${i}`, EMPTY_FILTERS);
    expect(() => saveFilter(list, '하나 더', EMPTY_FILTERS)).toThrow(`${SAVED_MAX}개까지`);
    expect(saveFilter(list, '필터0', f({ search: '바꿈' }))).toHaveLength(SAVED_MAX); // 같은 이름은 바꾸기
  });

  test('깨진 저장값은 버리고, 알 수 없는 칸은 기본값으로', () => {
    window.localStorage.setItem('ledger_saved_filters', '{깨짐');
    expect(loadSavedFilters()).toEqual([]);
    window.localStorage.setItem('ledger_saved_filters', JSON.stringify([
      { name: '이상한 것', filters: { period: '없는기간', payment_methods: '현금', search: 3, extra: 1 } },
      { nope: true },
    ]));
    expect(loadSavedFilters()).toEqual([{ name: '이상한 것', filters: EMPTY_FILTERS }]);
    // 다른 버전·직접 고친 저장값이 한도보다 많아도 한도까지만 읽는다
    window.localStorage.setItem('ledger_saved_filters', JSON.stringify(
      Array.from({ length: SAVED_MAX + 3 }, (_, i) => ({ name: `f${i}`, filters: {} })),
    ));
    expect(loadSavedFilters()).toHaveLength(SAVED_MAX);
  });

  test('꺼낼 때 지금 가계부에 없는 결제수단·카테고리·구성원은 빼고 무엇을 뺐는지 알려 준다', () => {
    const saved = f({ payment_methods: ['현금', '없어진 카드'], budget_categories: ['식비', '옛 카테고리'], member: '이사 간 사람' });
    const { filters, dropped } = fitSavedFilters(saved, { paymentMethods: ['현금'], categories: ['식비'], members: ['엄마'] });
    expect(filters.payment_methods).toEqual(['현금']);
    expect(filters.budget_categories).toEqual(['식비']);
    expect(filters.member).toBe('');
    expect(dropped).toEqual(['없어진 카드', '옛 카테고리', '이사 간 사람']);
    expect(fitSavedFilters(f({ member: MEMBER_NONE }), { members: [] }).filters.member).toBe(MEMBER_NONE);
  });
});
