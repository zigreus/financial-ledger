// 구독 모아보기 (I-027, ROADMAP C-8) — 정기지출 중 구독의 월·연 환산 합계, 바뀐 금액, 해지 메모
// + 정기지출 금액을 바꾸면 미리 등록한 앞으로의 거래도 따라 바꾸기 (B-092)
import initSqlJs from 'sql.js';
import {
  createDatabase, SCHEMA_VERSION, addRecurringTransaction, updateRecurringTransaction, getRecurringTransactions,
  deleteRecurringTransaction, runAutoRegister, addDiscountRule, getTransactions,
  isSubscriptionsEnabled, setSubscriptionsEnabled, getSubscriptions, getSubscriptionTotals,
  setRecurringSubscription, setSubscriptionNote, looksLikeSubscription, keepSubscriptionAmount,
} from '../dbManager';
import { attachChangeLog, getChangeLog, replayChanges } from '../changeLog';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const TODAY = '2026-11-15';
const base = {
  payment_method: '신한카드', budget_category: '문화', sub_category: '', frequency: 'monthly', day_of_month: 5,
};
function makeDb() {
  const { db } = createDatabase(SQL, null);
  addRecurringTransaction(db, { ...base, detail: '넷플릭스', amount: 13500, is_subscription: true });
  addRecurringTransaction(db, { ...base, detail: '쿠팡 와우', amount: 7890, discount_amount: 890 });
  addRecurringTransaction(db, { ...base, detail: '도메인', amount: 24000, frequency: 'annual', month_of_year: 3, is_subscription: true });
  addRecurringTransaction(db, { ...base, budget_category: '주거', detail: '관리비', amount: 250000 });
  const ids = Object.fromEntries(getRecurringTransactions(db).map(r => [r.detail, r.id]));
  return { db, ids };
}
const template = (db, id) => getRecurringTransactions(db).find(r => r.id === id);
/** 자동등록이 만든 것과 같은 거래(템플릿의 결제수단·카테고리·내용) — extra로 사용자가 고친 것을 흉내 낸다 */
const paid = (db, recurringId, date, amount, extra = {}) => {
  const r = template(db, recurringId);
  db.run(
    `INSERT INTO transactions (payment_method, date, budget_category, sub_category, detail, amount, discount_amount, discount_note,
                               is_recurring, recurring_source_id, recurring_frequency, split_group_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [extra.payment_method || r.payment_method, date, r.budget_category, r.sub_category || '', r.detail, amount,
      extra.discount_amount || 0, extra.discount_note || '', recurringId, r.frequency, extra.split_group_id || ''],
  );
};
const rowsOf = (db, recurringId) => getTransactions(db, {})
  .filter(t => t.recurring_source_id === recurringId)
  .map(t => [t.date, t.amount, t.discount_amount, t.payment_method])
  .sort((a, b) => a[0].localeCompare(b[0]));
function atToday(fn) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 15, 12));                         // 오늘 2026-11-15
  try { return fn(); } finally { vi.useRealTimers(); }
}

test('스키마 — 정기지출에 구독 표시·해지 메모·금액 확인일 칸이 생기고 버전이 올랐다', () => {
  const { db } = makeDb();
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
  const cols = db.exec('PRAGMA table_info(recurring_transactions)')[0].values.map(r => r[1]);
  expect(cols).toEqual(expect.arrayContaining(['is_subscription', 'cancel_note', 'amount_checked_on']));
});

test('선택 기능 — 처음에는 꺼져 있다', () => {
  const { db } = makeDb();
  expect(isSubscriptionsEnabled(db)).toBe(false);
  setSubscriptionsEnabled(db, true);
  expect(isSubscriptionsEnabled(db)).toBe(true);
});

test('구독으로 표시한 것만 — 월 환산(연간은 12로 나눔)·연 환산, 할인 뺀 금액', () => {
  const { db, ids } = makeDb();
  setRecurringSubscription(db, ids['쿠팡 와우'], true);
  const subs = getSubscriptions(db, TODAY);
  expect(subs.map(s => [s.detail, s.net, s.monthly, s.annual])).toEqual([
    ['넷플릭스', 13500, 13500, 162000],
    ['쿠팡 와우', 7000, 7000, 84000],
    ['도메인', 24000, 2000, 24000],
  ]);
  expect(getSubscriptionTotals(subs)).toEqual({ count: 3, monthly: 22500, annual: 270000 });
  setRecurringSubscription(db, ids['쿠팡 와우'], false);
  expect(getSubscriptions(db, TODAY).map(s => s.detail)).toEqual(['넷플릭스', '도메인']);
  expect(getSubscriptionTotals([])).toEqual({ count: 0, monthly: 0, annual: 0 });
});

test('템플릿 할인이 없으면 결제수단 할인 규칙으로 — 자동등록과 같은 금액', () => {
  const { db, ids } = makeDb();
  addDiscountRule(db, { payment_method_name: '신한카드', budget_category: '문화', rule_type: 'percent', value: 0.1 });
  const netflix = getSubscriptions(db, TODAY).find(s => s.id === ids['넷플릭스']);
  expect([netflix.discount, netflix.net, netflix.annual]).toEqual([1350, 12150, 145800]);
  runAutoRegister(db, new Date(2026, 10, 15));
  expect(rowsOf(db, ids['넷플릭스'])).toEqual([['2027-01-05', 13500, 1350, '신한카드']]);
});

describe('금액이 바뀐 구독 알림', () => {
  test('최근 결제(오늘까지)가 등록 금액과 3% 넘게 다르면 — 앞으로의 거래는 최근 결제가 아니다', () => {
    const { db, ids } = makeDb();
    const id = ids['넷플릭스'];
    expect(getSubscriptions(db, TODAY)[0]).toMatchObject({ lastPaid: null, changed: false });
    paid(db, id, '2026-10-05', 13500);
    paid(db, id, '2026-11-05', 17000);                                  // 카드 대조로 실제 결제액을 고쳤다
    paid(db, id, '2026-12-05', 13500);                                  // 미리 등록된 다음 달
    expect(getSubscriptions(db, TODAY)[0]).toMatchObject({
      lastPaid: { date: '2026-11-05', amount: 17000, net: 17000, split: false }, changed: true,
    });
    expect(getSubscriptions(db, '2026-10-31')[0]).toMatchObject({ lastPaid: { date: '2026-10-05' }, changed: false });
    db.run("UPDATE transactions SET amount = 13900 WHERE date = '2026-11-05'");   // 3% 안 — 외화 결제처럼 조금 다름
    expect(getSubscriptions(db, TODAY)[0].changed).toBe(false);
    db.run("UPDATE transactions SET amount = 14000 WHERE date = '2026-11-05'");   // 3.7% — 작은 인상도 알린다
    expect(getSubscriptions(db, TODAY)[0].changed).toBe(true);
  });

  test('나눠 결제한 회차는 몫을 합쳐 견준다(연결은 원래 행에만 남는다)', () => {
    const { db, ids } = makeDb();
    const id = ids['넷플릭스'];
    paid(db, id, '2026-11-05', 6750, { split_group_id: 'g1' });
    db.run(`INSERT INTO transactions (payment_method, date, budget_category, detail, amount, split_group_id)
            VALUES ('국민카드', '2026-11-05', '문화', '넷플릭스', 6750, 'g1')`);
    expect(getSubscriptions(db, TODAY)[0]).toMatchObject({ lastPaid: { amount: 13500, split: true }, changed: false });
  });

  test('정기지출 금액을 올리면 옛 금액의 지난 결제로 다시 알리지 않는다 — 결제일 당일에 고쳐도, 연간 구독도', () => {
    atToday(() => {
      const { db, ids } = makeDb();
      const id = ids['넷플릭스'];
      paid(db, id, '2026-11-05', 13500);
      updateRecurringTransaction(db, id, { ...template(db, id), amount: 17000 });
      expect(getSubscriptions(db, TODAY)[0]).toMatchObject({ amount: 17000, amount_checked_on: '2026-11-15', changed: false });

      paid(db, id, '2026-11-15', 13500);                                // 오늘 옛 금액으로 결제된 날 고침
      expect(getSubscriptions(db, TODAY)[0].changed).toBe(false);
      expect(getSubscriptions(db, '2026-12-05')[0].changed).toBe(false);
      paid(db, id, '2026-12-05', 18000);                                // 고친 뒤 결제가 또 다르면 알린다
      expect(getSubscriptions(db, '2026-12-05')[0].changed).toBe(true);

      const domain = ids['도메인'];
      paid(db, domain, '2026-03-04', 24000);
      updateRecurringTransaction(db, domain, { ...template(db, domain), amount: 30000 });
      expect(getSubscriptions(db, '2027-03-01').find(s => s.id === domain).changed).toBe(false);
    });
  });

  test("'이대로 두기' — 그 결제까지는 알리지 않고, 다음 결제가 또 다르면 다시 알린다", () => {
    const { db, ids } = makeDb();
    const id = ids['넷플릭스'];
    paid(db, id, '2026-11-05', 9900);                                   // 프로모션 가격
    expect(getSubscriptions(db, TODAY)[0].changed).toBe(true);
    keepSubscriptionAmount(db, id, '2026-11-05');
    expect(getSubscriptions(db, TODAY)[0].changed).toBe(false);
    paid(db, id, '2026-12-05', 13500);
    expect(getSubscriptions(db, '2026-12-10')[0].changed).toBe(false);
    paid(db, id, '2027-01-05', 9900);
    expect(getSubscriptions(db, '2027-01-10')[0].changed).toBe(true);
  });
});

describe('정기지출을 고치면 미리 등록한 앞으로의 거래도 (B-092)', () => {
  test('금액만 바꾸면 손대지 않은 앞으로의 거래만 — 지난 거래·금액·결제수단·할인을 고친 거래·분할 결제는 그대로', () => {
    atToday(() => {
      const { db, ids } = makeDb();
      const id = ids['넷플릭스'];
      paid(db, id, '2026-11-05', 13500);                                // 지난 거래
      paid(db, id, '2026-12-05', 13500);                                // 손대지 않음 → 바뀐다
      paid(db, id, '2027-01-05', 15000);                                // 금액을 고침
      paid(db, id, '2027-02-05', 13500, { payment_method: '현금' });     // 결제수단을 고침
      paid(db, id, '2027-03-05', 13500, { discount_amount: 3000, discount_note: '이벤트' });   // 할인을 직접 넣음
      paid(db, id, '2027-04-05', 13500, { split_group_id: 'g1' });      // 나눠 결제
      updateRecurringTransaction(db, id, { ...template(db, id), amount: 17000 });
      expect(rowsOf(db, id)).toEqual([
        ['2026-11-05', 13500, 0, '신한카드'], ['2026-12-05', 17000, 0, '신한카드'], ['2027-01-05', 15000, 0, '신한카드'],
        ['2027-02-05', 13500, 0, '현금'], ['2027-03-05', 13500, 3000, '신한카드'], ['2027-04-05', 13500, 0, '신한카드'],
      ]);
    });
  });

  test('할인은 같은 규칙으로 다시 계산하고, 할인만 바꿔도 따라간다', () => {
    atToday(() => {
      const { db, ids } = makeDb();
      const id = ids['넷플릭스'];
      addDiscountRule(db, { payment_method_name: '신한카드', budget_category: '문화', rule_type: 'percent', value: 0.1 });
      paid(db, id, '2026-12-05', 13500, { discount_amount: 1350 });     // 자동등록이 규칙으로 넣은 할인
      updateRecurringTransaction(db, id, { ...template(db, id), amount: 17000 });
      expect(rowsOf(db, id)).toEqual([['2026-12-05', 17000, 1700, '신한카드']]);
      updateRecurringTransaction(db, id, { ...template(db, id), discount_amount: 2000, discount_note: '제휴' });
      expect(rowsOf(db, id)).toEqual([['2026-12-05', 17000, 2000, '신한카드']]);
      expect(getTransactions(db, {}).find(t => t.date === '2026-12-05').discount_note).toBe('제휴');
      updateRecurringTransaction(db, id, { ...template(db, id), note: '메모만' });   // 금액·할인이 그대로면 그대로
      expect(rowsOf(db, id)).toEqual([['2026-12-05', 17000, 2000, '신한카드']]);
    });
  });

  test('자동등록 뒤에 할인 규칙을 만들어 할인 0으로 등록된 거래도 따라간다', () => {
    atToday(() => {
      const { db, ids } = makeDb();
      const id = ids['넷플릭스'];
      paid(db, id, '2026-12-05', 13500);                                // 규칙을 만들기 전에 등록됨
      addDiscountRule(db, { payment_method_name: '신한카드', budget_category: '문화', rule_type: 'percent', value: 0.1 });
      updateRecurringTransaction(db, id, { ...template(db, id), amount: 17000 });
      expect(rowsOf(db, id)).toEqual([['2026-12-05', 17000, 1700, '신한카드']]);
      expect(template(db, id).amount_checked_on).toBe('2026-11-15');
    });
  });

  test('주기·날짜·결제수단을 함께 바꾸면 옛 일정으로 등록된 거래는 건드리지 않는다', () => {
    atToday(() => {
      const { db, ids } = makeDb();
      const id = ids['넷플릭스'];
      paid(db, id, '2026-12-05', 13500);
      paid(db, id, '2027-01-05', 13500);
      paid(db, id, '2027-02-05', 15000);                                // 사용자가 일부러 고친 거래 — 확인일에 넣지 않는다
      updateRecurringTransaction(db, id, { ...template(db, id), frequency: 'annual', month_of_year: 1, amount: 135000 });
      expect(rowsOf(db, id).slice(0, 2)).toEqual([['2026-12-05', 13500, 0, '신한카드'], ['2027-01-05', 13500, 0, '신한카드']]);
      // 옛 금액 그대로 남은 거래가 결제일을 지나도 '금액이 바뀜'으로 알리지 않는다(마지막 남은 거래까지 확인한 것으로)
      expect(template(db, id).amount_checked_on).toBe('2027-01-05');
      expect(getSubscriptions(db, '2026-12-06')[0].changed).toBe(false);
      expect(getSubscriptions(db, '2027-01-06')[0].changed).toBe(false);
      expect(getSubscriptions(db, '2027-02-06')[0].changed).toBe(true);
      db.run("DELETE FROM transactions WHERE date IN ('2027-01-05', '2027-02-05')");
      updateRecurringTransaction(db, id, { ...template(db, id), frequency: 'monthly', month_of_year: null, amount: 13500 });
      updateRecurringTransaction(db, id, { ...template(db, id), day_of_month: 10, amount: 15000 });
      expect(rowsOf(db, id)).toEqual([['2026-12-05', 13500, 0, '신한카드']]);
      updateRecurringTransaction(db, id, { ...template(db, id), day_of_month: 5, amount: 13500 });
      updateRecurringTransaction(db, id, { ...template(db, id), payment_method: '국민카드', amount: 17000 });
      expect(rowsOf(db, id)).toEqual([['2026-12-05', 13500, 0, '신한카드']]);
    });
  });

  test('병합 — 다른 기기 파일에 다시 실행해도 그 기기가 등록해 둔 앞으로의 거래가 바뀐다', () => {
    atToday(() => {
      const { db, ids } = makeDb();
      const id = ids['넷플릭스'];
      const bytes = db.export();
      const mine = createDatabase(SQL, bytes).db;
      runAutoRegister(mine, new Date(2026, 10, 15));                    // 불러온 직후 자동등록(변경 기록 전)
      attachChangeLog(mine);
      updateRecurringTransaction(mine, id, { ...template(mine, id), amount: 17000 });
      const remote = createDatabase(SQL, bytes).db;
      paid(remote, id, '2026-11-20', 500);                               // 다른 기기가 먼저 거래를 넣어 id가 다르다
      runAutoRegister(remote, new Date(2026, 10, 15));
      replayChanges(remote, getChangeLog(mine).entries);
      expect(template(remote, id)).toMatchObject({ amount: 17000, amount_checked_on: '2026-11-15' });
      expect(rowsOf(remote, id)).toEqual([['2026-11-20', 500, 0, '신한카드'], ['2027-01-05', 17000, 0, '신한카드']]);
    });
  });

  test('병합 — 금액 확인일은 합치는 파일에서 계산해, 다른 기기가 그 사이 등록한 옛 금액 거래도 넣는다', () => {
    atToday(() => {
      const { db, ids } = makeDb();
      const id = ids['넷플릭스'];
      paid(db, id, '2026-12-05', 13500);
      const bytes = db.export();
      const mine = createDatabase(SQL, bytes).db;
      attachChangeLog(mine);
      updateRecurringTransaction(mine, id, { ...template(mine, id), payment_method: '국민카드', amount: 17000 });
      expect(template(mine, id).amount_checked_on).toBe('2026-12-05');
      const remote = createDatabase(SQL, bytes).db;
      paid(remote, id, '2027-02-05', 13500);                             // 다른 기기가 먼저 다음 예정을 등록했다
      replayChanges(remote, getChangeLog(mine).entries);
      expect(template(remote, id)).toMatchObject({ amount: 17000, payment_method: '국민카드', amount_checked_on: '2027-02-05' });
    });
  });
});

test('구독 표시·해지 메모는 넘길 때만 바꾼다(구독 모아보기를 끈 화면에서 고쳐도 남는다)', () => {
  const { db, ids } = makeDb();
  setSubscriptionNote(db, ids['넷플릭스'], '  3월에 해지  ');
  const r = template(db, ids['넷플릭스']);
  expect(r.cancel_note).toBe('3월에 해지');
  const { is_subscription: _s, cancel_note: _c, ...fields } = r;
  updateRecurringTransaction(db, r.id, { ...fields, amount: 14000 });
  expect(template(db, r.id)).toMatchObject({ amount: 14000, is_subscription: 1, cancel_note: '3월에 해지' });
  updateRecurringTransaction(db, r.id, { ...fields, amount: 14000, is_subscription: false, cancel_note: '' });
  expect(template(db, r.id)).toMatchObject({ is_subscription: 0, cancel_note: '' });
  deleteRecurringTransaction(db, r.id);
  expect(getSubscriptions(db, TODAY).map(s => s.detail)).toEqual(['도메인']);
});

test('구독 같아 보이는 정기지출', () => {
  expect(looksLikeSubscription({ detail: '넷플릭스 프리미엄' })).toBe(true);
  expect(looksLikeSubscription({ detail: 'YouTube Premium' })).toBe(true);
  expect(looksLikeSubscription({ detail: '관리비', budget_category: '주거' })).toBe(false);
  expect(looksLikeSubscription({ detail: '', sub_category: '구독' })).toBe(true);
});

test('병합 — 이 기기에서 새로 만든 정기지출의 구독 표시·메모도, 다른 기기가 먼저 만들어 id가 바뀌면 새 id에 들어간다', () => {
  const { db } = makeDb();
  const bytes = db.export();
  const mine = createDatabase(SQL, bytes).db;
  attachChangeLog(mine);
  addRecurringTransaction(mine, { ...base, detail: '멜론', amount: 10900 });
  const melon = getRecurringTransactions(mine).find(r => r.detail === '멜론').id;
  setRecurringSubscription(mine, melon, true);
  setSubscriptionNote(mine, melon, '연말에 해지');
  keepSubscriptionAmount(mine, melon, '2026-11-01');
  const remote = createDatabase(SQL, bytes).db;
  addRecurringTransaction(remote, { ...base, detail: '다른 기기 정기지출', amount: 1000 });  // 다른 기기가 먼저 같은 id를 차지
  replayChanges(remote, getChangeLog(mine).entries);
  const rows = getRecurringTransactions(remote);
  expect(rows.find(r => r.detail === '다른 기기 정기지출')).toMatchObject({ is_subscription: 0, cancel_note: '', amount_checked_on: '' });
  expect(rows.find(r => r.detail === '멜론')).toMatchObject({ is_subscription: 1, cancel_note: '연말에 해지', amount_checked_on: '2026-11-01' });
});
