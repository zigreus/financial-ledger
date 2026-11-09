// 구독 모아보기 (I-027, ROADMAP C-8) — 정기지출 중 구독의 월·연 환산 합계, 바뀐 금액, 해지 메모
// + 정기지출 금액을 바꾸면 미리 등록한 앞으로의 거래도 따라 바꾸기 (B-092)
import initSqlJs from 'sql.js';
import {
  createDatabase, SCHEMA_VERSION, addRecurringTransaction, updateRecurringTransaction, getRecurringTransactions,
  deleteRecurringTransaction, runAutoRegister, addDiscountRule, getTransactions,
  isSubscriptionsEnabled, setSubscriptionsEnabled, getSubscriptions, getSubscriptionTotals,
  setRecurringSubscription, setSubscriptionNote, looksLikeSubscription, keepSubscriptionAmount,
  getUpcomingSubscriptionPayments, SUBSCRIPTION_DUE_DAYS, getRecurringDateMoves,
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

describe('곧 결제될 구독 (I-036)', () => {
  test('미리 등록된 거래 중 오늘부터 3일 뒤까지, 날짜순 — 구독이 아닌 정기지출·지난 결제·그 뒤 결제는 빼고', () => {
    const { db, ids } = makeDb();
    expect(SUBSCRIPTION_DUE_DAYS).toBe(3);
    paid(db, ids['넷플릭스'], '2026-11-14', 13500);                         // 어제 — 지났다
    paid(db, ids['넷플릭스'], '2026-11-17', 13500);                         // 모레
    paid(db, ids['도메인'], '2026-11-15', 24000);                           // 오늘
    paid(db, ids['넷플릭스'], '2026-11-19', 13500);                         // 4일 뒤 — 아직
    paid(db, ids['쿠팡 와우'], '2026-11-16', 7890);                         // 구독이 아님
    expect(getUpcomingSubscriptionPayments(db, TODAY)).toEqual([
      expect.objectContaining({ recurringId: ids['도메인'], name: '도메인', date: '2026-11-15', daysUntil: 0, amount: 24000 }),
      expect.objectContaining({ recurringId: ids['넷플릭스'], name: '넷플릭스', date: '2026-11-17', daysUntil: 2, amount: 13500 }),
    ]);
    paid(db, ids['넷플릭스'], '2026-11-18', 13500);
    expect(getUpcomingSubscriptionPayments(db, TODAY).map(p => p.daysUntil)).toEqual([0, 2, 3]);
  });

  test('사용자가 고친 거래를 따른다 — 금액(할인 전)·내용·날짜, 지운 결제는 알리지 않고, 나눠 결제는 몫을 합친다', () => {
    const { db, ids } = makeDb();
    paid(db, ids['넷플릭스'], '2026-11-16', 17000, { discount_amount: 1000 });
    db.run("UPDATE transactions SET detail = '넷플릭스 프리미엄' WHERE date = '2026-11-16'");
    paid(db, ids['도메인'], '2026-11-17', 12000, { split_group_id: 'g1' });
    db.run(`INSERT INTO transactions (payment_method, date, budget_category, detail, amount, split_group_id)
            VALUES ('국민카드', '2026-11-17', '문화', '도메인', 12000, 'g1')`);
    expect(getUpcomingSubscriptionPayments(db, TODAY).map(p => [p.name, p.amount])).toEqual([
      ['넷플릭스 프리미엄', 17000], ['도메인', 24000],
    ]);
    db.run("DELETE FROM transactions WHERE date = '2026-11-16'");            // 해지하며 지웠다
    db.run("UPDATE transactions SET date = '2026-11-25' WHERE split_group_id = 'g1'");  // 날짜를 옮겼다
    expect(getUpcomingSubscriptionPayments(db, TODAY)).toEqual([]);
  });

  test('구독 표시를 빼면 알리지 않고, 내용이 비면 정기지출의 이름으로', () => {
    const { db, ids } = makeDb();
    paid(db, ids['넷플릭스'], '2026-11-16', 13500);
    db.run("UPDATE transactions SET detail = '' WHERE date = '2026-11-16'");
    expect(getUpcomingSubscriptionPayments(db, TODAY)[0].name).toBe('넷플릭스');
    setRecurringSubscription(db, ids['넷플릭스'], false);
    expect(getUpcomingSubscriptionPayments(db, TODAY)).toEqual([]);
  });

  test('자동등록한 달은 미리 들어간 거래로 — 그 거래를 지우면(해지) 정기지출의 날짜로 다시 세지 않는다', () => {
    const { db, ids } = makeDb();
    updateRecurringTransaction(db, ids['넷플릭스'], { ...template(db, ids['넷플릭스']), day_of_month: 2 });
    runAutoRegister(db, new Date(2026, 9, 1));                             // 처음 — 12월만
    runAutoRegister(db, new Date(2026, 10, 1));                            // 1월
    const due = getUpcomingSubscriptionPayments(db, '2026-12-30');        // 해를 넘겨도
    expect(due.map(p => [p.date, p.daysUntil, p.amount, typeof p.id])).toEqual([['2027-01-02', 3, 13500, 'number']]);
    db.run('DELETE FROM transactions WHERE id = ?', [due[0].id]);
    expect(getUpcomingSubscriptionPayments(db, '2026-12-30')).toEqual([]);
  });

  test('등록된 거래를 아직 등록 전인 달로 옮겨 오면 그 거래로 한 번만 알린다', () => {
    const { db, ids } = makeDb();
    updateRecurringTransaction(db, ids['넷플릭스'], { ...template(db, ids['넷플릭스']), day_of_month: 17 });
    runAutoRegister(db, new Date(2026, 10, 15));                           // 처음 — 2027-01만 등록
    const jan = getTransactions(db, {}).find(t => t.recurring_source_id === ids['넷플릭스']);
    expect(jan.date).toBe('2027-01-17');
    db.run('UPDATE transactions SET date = ? WHERE id = ?', ['2026-11-16', jan.id]);
    expect(getUpcomingSubscriptionPayments(db, TODAY).map(p => [p.id, p.date])).toEqual([[jan.id, '2026-11-16']]);
    db.run('UPDATE transactions SET date = ? WHERE id = ?', ['2026-11-02', jan.id]);   // 11월 안 — 창 밖
    expect(getUpcomingSubscriptionPayments(db, TODAY)).toEqual([]);
  });

  test('아직 자동등록하지 않은 달(새로 만든 구독은 두 달 뒤부터 등록)은 정기지출의 결제일·금액으로', () => {
    const { db, ids } = makeDb();
    updateRecurringTransaction(db, ids['넷플릭스'], { ...template(db, ids['넷플릭스']), day_of_month: 0 });   // 말일
    runAutoRegister(db, new Date(2026, 10, 28));                           // 처음 — 2027-01만 등록
    expect(getUpcomingSubscriptionPayments(db, '2026-11-28')).toEqual([
      { id: `r${ids['넷플릭스']}`, recurringId: ids['넷플릭스'], name: '넷플릭스', date: '2026-11-30', daysUntil: 2, amount: 13500 },
    ]);
    // 연간 구독은 그 달에만
    updateRecurringTransaction(db, ids['도메인'], { ...template(db, ids['도메인']), month_of_year: 12, day_of_month: 1 });
    expect(getUpcomingSubscriptionPayments(db, '2026-11-28').map(p => [p.name, p.date])).toEqual([
      ['넷플릭스', '2026-11-30'], ['도메인', '2026-12-01'],
    ]);
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

describe('결제일을 바꾸면 앞으로의 거래도 옮기기 (I-037)', () => {
  const datesOf = (db, recurringId) => rowsOf(db, recurringId).map(r => r[0]);
  const logOf = (db, recurringId) => (db.exec(
    'SELECT registered_for_month FROM recurring_registration_log WHERE recurring_id = ? ORDER BY 1', [recurringId],
  )[0]?.values || []).map(v => v[0]);
  const pairs = list => list.map(m => [m.from, m.to]);
  /** 넷플릭스 결제일을 day로 바꿔 두고(앞으로의 거래가 없을 때) 그 일정대로 등록된 것처럼 거래를 넣는다 */
  const netflixOn = (day, dates) => {
    const { db, ids } = makeDb();
    const id = ids['넷플릭스'];
    updateRecurringTransaction(db, id, { ...template(db, id), day_of_month: day });
    dates.forEach(d => paid(db, id, d, 13500));
    return { db, ids, id };
  };

  test('미리보기 — 옮길 것, 새 결제일이 지나 그대로 둘 것, 날짜를 직접 고쳐 그대로 둘 것', () => {
    const { db, id } = netflixOn(20, ['2026-11-05', '2026-11-20', '2026-12-20', '2027-01-20', '2027-02-03']);
    const t = template(db, id);
    const preview = getRecurringDateMoves(db, id, { ...t, day_of_month: 10 }, TODAY);
    expect(pairs(preview.moves)).toEqual([['2026-12-20', '2026-12-10'], ['2027-01-20', '2027-01-10']]);
    expect(pairs(preview.stays)).toEqual([['2026-11-20', '2026-11-10']]);        // 오늘(11-15) 뒤지만 새 날짜는 지났다
    expect(pairs(preview.kept)).toEqual([['2027-02-03', '2027-02-10']]);         // 20일이 아닌 날 — 지금 결제일과 다르다(직접 고친 날짜)
    expect(preview.amountFollows).toBe(false);
    expect(getRecurringDateMoves(db, id, { ...t, day_of_month: 10, amount: 15000 }, TODAY).amountFollows).toBe(true);
    expect(getRecurringDateMoves(db, id, { ...t, day_of_month: 10, amount: 15000, payment_method: '국민카드' }, TODAY).amountFollows).toBe(false);
    // 결제일이 그대로거나 주기를 바꾸면 묻지 않는다
    expect(getRecurringDateMoves(db, id, { ...t, amount: 15000 }, TODAY).moves).toEqual([]);
    expect(getRecurringDateMoves(db, id, { ...t, frequency: 'annual', month_of_year: 1 }, TODAY).moves).toEqual([]);
  });

  test('옮기기 — 말일(0)·그 달에 없는 날(31일→2월 말일), 지난 결제·새 결제일이 지난 것·직접 고친 날짜는 그대로', () => {
    atToday(() => {
      const { db, id } = netflixOn(20, ['2026-11-05', '2026-11-20', '2026-12-20', '2027-01-20', '2027-02-20', '2027-03-02']);
      updateRecurringTransaction(db, id, { ...template(db, id), day_of_month: 31 }, { moveDates: true });
      expect(datesOf(db, id)).toEqual(['2026-11-05', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-02']);
      updateRecurringTransaction(db, id, { ...template(db, id), day_of_month: 0 }, { moveDates: true });  // 이미 말일 — 그대로
      expect(datesOf(db, id)).toEqual(['2026-11-05', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-02']);
      updateRecurringTransaction(db, id, { ...template(db, id), day_of_month: 14 }, { moveDates: true });
      expect(datesOf(db, id)).toEqual(['2026-11-05', '2026-11-30', '2026-12-14', '2027-01-14', '2027-02-14', '2027-03-02']);
      // 묻는 창에서 '정기지출만 바꾸기'를 고르면 거래는 그대로
      updateRecurringTransaction(db, id, { ...template(db, id), day_of_month: 20 });
      expect(datesOf(db, id)).toEqual(['2026-11-05', '2026-11-30', '2026-12-14', '2027-01-14', '2027-02-14', '2027-03-02']);
      expect(template(db, id).day_of_month).toBe(20);
    });
  });

  test('분할 결제는 같은 묶음의 몫을 함께 옮기고, 다른 정기지출·손으로 넣은 거래는 건드리지 않는다', () => {
    atToday(() => {
      const { db, ids } = makeDb();
      const id = ids['넷플릭스'];
      paid(db, id, '2026-12-05', 6750, { split_group_id: 'g1' });
      db.run(`INSERT INTO transactions (payment_method, date, budget_category, detail, amount, split_group_id)
              VALUES ('국민카드', '2026-12-05', '문화', '넷플릭스', 6750, 'g1')`);
      paid(db, ids['쿠팡 와우'], '2026-12-05', 7890);
      db.run(`INSERT INTO transactions (payment_method, date, budget_category, detail, amount)
              VALUES ('신한카드', '2026-12-05', '문화', '넷플릭스', 13500)`);           // 손으로 넣은 거래
      updateRecurringTransaction(db, id, { ...template(db, id), day_of_month: 25 }, { moveDates: true });
      const rows = db.exec('SELECT payment_method, date, COALESCE(recurring_source_id, 0) FROM transactions ORDER BY id')[0].values;
      expect(rows).toEqual([
        ['신한카드', '2026-12-25', id], ['국민카드', '2026-12-25', 0], ['신한카드', '2026-12-05', ids['쿠팡 와우']], ['신한카드', '2026-12-05', 0],
      ]);
    });
  });

  test('금액도 함께 바꾸고 옮기면 옮기는 거래 중 손대지 않은 것만 금액도 따라간다 — 그대로 두는 거래는 금액도 그대로', () => {
    atToday(() => {
      const { db, id } = netflixOn(20, ['2026-11-20', '2026-12-20', '2027-01-20', '2027-02-03']);
      db.run("UPDATE transactions SET amount = 14000 WHERE date = '2027-01-20'");   // 사용자가 고친 금액
      updateRecurringTransaction(db, id, { ...template(db, id), day_of_month: 10, amount: 17000 }, { moveDates: true });
      expect(rowsOf(db, id)).toEqual([
        ['2026-11-20', 13500, 0, '신한카드'],                              // 새 결제일(11-10)이 지나 그대로 — 금액도
        ['2026-12-10', 17000, 0, '신한카드'],
        ['2027-01-10', 14000, 0, '신한카드'],                              // 옮기지만 고친 금액은 그대로
        ['2027-02-03', 13500, 0, '신한카드'],                              // 직접 고친 날짜 — 그대로
      ]);
      // 옛 금액으로 남은 앞으로의 거래가 있으니 그 날까지는 '금액이 바뀜'으로 알리지 않는다
      expect(template(db, id).amount_checked_on).toBe('2027-02-03');
      // 옮기지 않으면 일정이 바뀐 수정이라 금액도 따라가지 않는다(B-092 그대로)
      updateRecurringTransaction(db, id, { ...template(db, id), day_of_month: 5, amount: 20000 });
      expect(rowsOf(db, id).map(r => r[1])).toEqual([13500, 17000, 14000, 13500]);
    });
  });

  describe('연간 구독의 달을 옮기면 가장 가까운 해의 새 달로 — 등록 기록도 옮겨 자동등록이 한 번 더 넣지 않는다', () => {
    test('달 안에서', () => {
      atToday(() => {
        const { db, ids } = makeDb();
        const id = ids['도메인'];
        updateRecurringTransaction(db, id, { ...template(db, id), month_of_year: 1 });
        runAutoRegister(db, new Date(2026, 10, 15));                     // 처음 — 2027-01 등록
        expect(datesOf(db, id)).toEqual(['2027-01-05']);
        const preview = getRecurringDateMoves(db, id, { ...template(db, id), month_of_year: 2, day_of_month: 29 }, TODAY);
        expect(pairs(preview.moves)).toEqual([['2027-01-05', '2027-02-28']]);   // 2027년 2월에는 29일이 없다
        updateRecurringTransaction(db, id, { ...template(db, id), month_of_year: 2, day_of_month: 29 }, { moveDates: true });
        expect(datesOf(db, id)).toEqual(['2027-02-28']);
        expect(logOf(db, id)).toEqual(['2027-02']);
        runAutoRegister(db, new Date(2026, 11, 15));                     // 2027-02까지
        expect(datesOf(db, id)).toEqual(['2027-02-28']);
      });
    });

    test('12월 → 1월은 다음 해 1월로', () => {
      atToday(() => {
        const { db, ids } = makeDb();
        const id = ids['도메인'];
        updateRecurringTransaction(db, id, { ...template(db, id), month_of_year: 12, day_of_month: 20 });
        runAutoRegister(db, new Date(2026, 9, 15));                      // 처음 — 2026-12 등록
        expect(datesOf(db, id)).toEqual(['2026-12-20']);
        updateRecurringTransaction(db, id, { ...template(db, id), month_of_year: 1 }, { moveDates: true });
        expect(datesOf(db, id)).toEqual(['2027-01-20']);
        expect(logOf(db, id)).toEqual(['2027-01']);
        runAutoRegister(db, new Date(2026, 10, 15));                     // 2027-01까지 — 한 번 더 넣지 않는다
        expect(datesOf(db, id)).toEqual(['2027-01-20']);
        expect(getUpcomingSubscriptionPayments(db, '2027-01-18').filter(p => p.recurringId === id).map(p => [p.date, typeof p.id])).toEqual([['2027-01-20', 'number']]);
      });
    });

    test('1월 → 12월은 앞 해 12월로', () => {
      atToday(() => {
        const { db, ids } = makeDb();
        const id = ids['도메인'];
        updateRecurringTransaction(db, id, { ...template(db, id), month_of_year: 1 });
        runAutoRegister(db, new Date(2026, 10, 15));                     // 처음 — 2027-01 등록
        updateRecurringTransaction(db, id, { ...template(db, id), month_of_year: 12 }, { moveDates: true });
        expect(datesOf(db, id)).toEqual(['2026-12-05']);
        expect(logOf(db, id)).toEqual(['2026-12']);
        runAutoRegister(db, new Date(2026, 11, 15));                     // 2027-02까지 — 12월 일정이라 더 넣지 않는다
        expect(datesOf(db, id)).toEqual(['2026-12-05']);
        expect(getUpcomingSubscriptionPayments(db, '2026-12-03').filter(p => p.recurringId === id).map(p => [p.date, typeof p.id])).toEqual([['2026-12-05', 'number']]);
      });
    });
  });

  test('병합 — 다른 기기 파일에 다시 실행해도 그 기기가 등록해 둔 앞으로의 거래까지 같은 규칙으로 옮긴다(직접 고친 날짜는 그대로)', () => {
    atToday(() => {
      const { db, ids } = makeDb();
      const id = ids['넷플릭스'];
      const bytes = db.export();
      const mine = createDatabase(SQL, bytes).db;
      runAutoRegister(mine, new Date(2026, 10, 15));                    // 불러온 직후 자동등록(변경 기록 전) — 2027-01
      attachChangeLog(mine);
      updateRecurringTransaction(mine, id, { ...template(mine, id), day_of_month: 0 }, { moveDates: true });
      expect(datesOf(mine, id)).toEqual(['2027-01-31']);
      const remote = createDatabase(SQL, bytes).db;
      paid(remote, id, '2026-11-20', 500);                               // 다른 기기가 먼저 넣은 거래(5일이 아님) — id도 다르다
      runAutoRegister(remote, new Date(2026, 11, 1));                    // 그 기기는 2027-02까지 등록했다
      replayChanges(remote, getChangeLog(mine).entries);
      expect(template(remote, id).day_of_month).toBe(0);
      expect(datesOf(remote, id)).toEqual(['2026-11-20', '2027-02-28']);
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
