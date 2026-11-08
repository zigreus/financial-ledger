// 수입·월 수지 (I-026, ROADMAP C-6) — 고른 계좌의 입금(예정 포함)을 수입으로, 가계부 순지출을 지출로
import initSqlJs from 'sql.js';
import {
  createDatabase, addTransaction, addAccount, addRecurringItem, addAccountTransaction, updateAccountTransaction, deleteAccount,
  isMonthlyBalanceEnabled, setMonthlyBalanceEnabled, getIncomeAccounts, setAccountCountsIncome,
  getMonthlyIncome, getMonthlyBalance, SCHEMA_VERSION, deleteRecurringItem, addCalendarEvent, addEventCashFlow,
  runAccountAutoRegister, getAccountTransactions, getRecurringItems,
} from '../dbManager';
import { attachChangeLog, getChangeLog, replayChanges } from '../changeLog';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const TODAY = '2026-11-15';
function makeDb() {
  const { db } = createDatabase(SQL, null);
  const salary = addAccount(db, { name: '월급통장' });
  addRecurringItem(db, { account_id: salary, name: '월급', type: 'income', day_of_month: 25, fixed_amount: 3000000, auto_register: false });
  const saving = addAccount(db, { name: '적금통장' });                   // 반복 수입이 없다
  return { db, salary, saving };
}
const income = (db, account, date, amount, extra = {}) => addAccountTransaction(db, {
  account_id: account, date, type: 'income', description: '입금', amount, ...extra,
});

test('스키마 — 계좌에 수입으로 셀지 고르는 칸이 생기고 버전이 올랐다', () => {
  const { db } = makeDb();
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
  const cols = db.exec('PRAGMA table_info(accounts)')[0].values.map(r => r[1]);
  expect(cols).toContain('count_income');
});

test('선택 기능 — 처음에는 꺼져 있다', () => {
  const { db } = makeDb();
  expect(isMonthlyBalanceEnabled(db)).toBe(false);
  setMonthlyBalanceEnabled(db, true);
  expect(isMonthlyBalanceEnabled(db)).toBe(true);
});

test('수입으로 셀 계좌 — 고르지 않으면 반복 수입이 있는 계좌만, 직접 고르거나 자동으로 되돌릴 수 있다', () => {
  const { db, salary, saving } = makeDb();
  expect(getIncomeAccounts(db)).toEqual([
    { id: salary, name: '월급통장', hasRecurringIncome: true, auto: true, counted: true, deleted: false },
    { id: saving, name: '적금통장', hasRecurringIncome: false, auto: true, counted: false, deleted: false },
  ]);
  setAccountCountsIncome(db, salary, false);
  setAccountCountsIncome(db, saving, true);
  expect(getIncomeAccounts(db).map(a => [a.name, a.auto, a.counted])).toEqual([['월급통장', false, false], ['적금통장', false, true]]);
  setAccountCountsIncome(db, salary, null);
  expect(getIncomeAccounts(db)[0]).toMatchObject({ auto: true, counted: true });
  deleteAccount(db, saving);                                             // 쓰지 않는 계좌는 목록에서 빠진다
  expect(getIncomeAccounts(db).map(a => a.name)).toEqual(['월급통장']);
});

test('수입은 센 계좌의 입금만 — 출금·세지 않는 계좌는 빼고, 아직 오지 않은 예정과 고치지 않은 예정을 따로 알린다', () => {
  const { db, salary, saving } = makeDb();
  income(db, salary, '2026-11-25', 3000000, { recurring_item_id: 1, is_auto_generated: true });   // 예정(오늘 뒤)
  income(db, salary, '2026-11-02', 50000);                                                          // 이자 등
  addAccountTransaction(db, { account_id: salary, date: '2026-11-03', type: 'expense', description: '카드 대금', amount: 900000 });
  income(db, saving, '2026-11-05', 500000);                                                          // 적금 이체 — 세지 않음
  income(db, salary, '2026-10-25', 2950000, { recurring_item_id: 1, is_auto_generated: true });   // 날짜는 지났지만 고치지 않음
  expect(getMonthlyIncome(db, null, TODAY)).toEqual({
    '2026-11': { income: 3050000, upcoming: 3000000, unconfirmed: 0 },
    '2026-10': { income: 2950000, upcoming: 0, unconfirmed: 2950000 },
  });
  expect(getMonthlyIncome(db, ['2026-10'], TODAY)).toEqual({ '2026-10': { income: 2950000, upcoming: 0, unconfirmed: 2950000 } });
  expect(getMonthlyIncome(db, [], TODAY)).toEqual({});
});

test('월급이 들어와 실제 금액으로 고치면 그 금액(더는 예정이 아님) — 휴일로 다음 달 1일에 들어와도 그 몫의 달로 센다', () => {
  const { db, salary } = makeDb();
  const id = income(db, salary, '2026-11-25', 3000000, { recurring_item_id: 1, is_auto_generated: true });
  updateAccountTransaction(db, id, { date: '2026-11-25', type: 'income', description: '월급', amount: 3123000 });
  addRecurringItem(db, { account_id: salary, name: '수당', type: 'income', day_of_month: 30, fixed_amount: 200000, auto_register: false });
  income(db, salary, '2026-12-01', 200000, { recurring_item_id: 2, recurring_month: '2026-11' }); // 휴일로 다음 달 1일에 들어온 11월 몫
  expect(getMonthlyIncome(db, ['2026-11', '2026-12'], '2026-12-31')).toEqual({ '2026-11': { income: 3323000, upcoming: 0, unconfirmed: 0 } });
});

test('반복 수입 항목을 지우거나(이직) 계좌를 지워도 지난 달 수입은 그대로 센다', () => {
  const { db, salary } = makeDb();
  income(db, salary, '2026-09-25', 3000000, { recurring_item_id: 1 });
  income(db, salary, '2026-10-25', 3000000, { recurring_item_id: 1 });
  deleteRecurringItem(db, 1);
  expect(getMonthlyIncome(db, null, TODAY)).toEqual({
    '2026-09': { income: 3000000, upcoming: 0, unconfirmed: 0 },
    '2026-10': { income: 3000000, upcoming: 0, unconfirmed: 0 },
  });
  deleteAccount(db, salary);
  expect(getMonthlyIncome(db, ['2026-10'], TODAY)['2026-10'].income).toBe(3000000);
  // 설정 목록: 쓰는 계좌 다음에, 지난 달 수입이 잡히는 지운 계좌도 보여 끌 수 있게
  expect(getIncomeAccounts(db).map(a => [a.name, a.deleted, a.counted])).toEqual([['적금통장', false, false], ['월급통장', true, true]]);
  setAccountCountsIncome(db, salary, false);
  expect(getMonthlyIncome(db, ['2026-10'], TODAY)).toEqual({});
});

describe('월급 계좌를 바꾸면(옛 계좌 삭제) 수입이 겹치지 않는다', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 15, 12));                         // 오늘 2026-11-15 (deleteAccount가 쓰는 오늘)
  });
  afterEach(() => { vi.useRealTimers(); });

  function switchSalaryAccount() {
    const { db } = createDatabase(SQL, null);
    const oldAcct = addAccount(db, { name: '옛 월급통장' });
    addRecurringItem(db, { account_id: oldAcct, name: '월급', type: 'income', day_of_month: 20, fixed_amount: 3000000 });
    runAccountAutoRegister(db, new Date(2026, 8, 1));                    // 9월 1일 자동 등록 — 9·10·11월 예정
    const rows = getAccountTransactions(db, oldAcct);
    const oct = rows.find(t => t.recurring_month === '2026-10');
    updateAccountTransaction(db, oct.id, { date: oct.date, type: 'income', description: '월급', amount: 3123000 }); // 10월은 실제 금액으로 확정
    const newAcct = addAccount(db, { name: '새 월급통장' });
    addRecurringItem(db, { account_id: newAcct, name: '월급', type: 'income', day_of_month: 25, fixed_amount: 3000000 });
    runAccountAutoRegister(db, new Date(2026, 10, 15));                  // 새 계좌 11·12·1월 예정(옛 계좌도 12·1월 예정이 생긴다)
    return { db, oldAcct, newAcct };
  }

  test('계좌를 지우면 앞으로의 자동 예정은 지워지고, 지난 내역(고치지 않은 예정 포함)은 남는다', () => {
    const { db, oldAcct } = switchSalaryAccount();
    expect(getAccountTransactions(db, oldAcct).some(t => t.date > '2026-11-15')).toBe(true);
    deleteAccount(db, oldAcct);
    const left = getAccountTransactions(db, oldAcct);
    expect(left.every(t => t.date <= '2026-11-15')).toBe(true);
    expect(left.map(t => t.recurring_month).sort()).toEqual(['2026-09', '2026-10']);
  });

  test('이 달부터는 새 계좌 월급만, 지난 달은 옛 계좌 입금 그대로(고치지 않은 예정도), 더 고칠 수 없으니 미확정으로 알리지 않는다', () => {
    const { db, oldAcct } = switchSalaryAccount();
    deleteAccount(db, oldAcct);
    expect(getMonthlyIncome(db, ['2026-09', '2026-10', '2026-11', '2026-12'], '2026-11-15')).toEqual({
      '2026-09': { income: 3000000, upcoming: 0, unconfirmed: 0 },
      '2026-10': { income: 3123000, upcoming: 0, unconfirmed: 0 },
      '2026-11': { income: 3000000, upcoming: 3000000, unconfirmed: 0 },
      '2026-12': { income: 3000000, upcoming: 3000000, unconfirmed: 0 },
    });
    expect(getIncomeAccounts(db, '2026-11-15').map(a => [a.name, a.deleted])).toEqual([['새 월급통장', false], ['옛 월급통장', true]]);
  });

  test('예전에 지워 앞으로의 예정이 남아 있는 계좌(예전 버전·다른 기기)도 그 예정은 세지 않고, 다시 열면 지워 날짜가 지나도 겹치지 않는다', () => {
    const { db, oldAcct } = switchSalaryAccount();
    db.run('UPDATE accounts SET is_active = 0 WHERE id = ?', [oldAcct]);  // 예정을 지우지 않던 예전 삭제
    const inc = getMonthlyIncome(db, ['2026-11', '2026-12'], '2026-11-15');
    expect(inc['2026-11'].income).toBe(3000000);
    expect(inc['2026-12'].income).toBe(3000000);

    const reopened = createDatabase(SQL, db.export());                   // 이 버전으로 불러오면 남은 예정을 지운다
    expect(reopened.didMigrate).toBe(true);
    expect(getAccountTransactions(reopened.db, oldAcct).map(t => t.recurring_month).sort()).toEqual(['2026-09', '2026-10']);
    expect(createDatabase(SQL, reopened.db.export()).didMigrate).toBe(false);   // 이미 정리했으면 다시 저장하지 않는다
    const later = getMonthlyIncome(reopened.db, ['2026-10', '2026-11', '2026-12', '2027-01'], '2027-02-01');
    expect(Object.fromEntries(Object.entries(later).map(([ym, v]) => [ym, v.income]))).toEqual({
      '2026-10': 3123000, '2026-11': 3000000, '2026-12': 3000000, '2027-01': 3000000,
    });
  });
});

test('여행 현금을 재환전해 돌아온 돈은 수입이 아니다', () => {
  const { db, salary } = makeDb();
  const trip = addCalendarEvent(db, { title: '여행', date_from: '2026-10-01', date_to: '2026-10-05', event_type: 'trip' });
  addEventCashFlow(db, { event_id: trip, date: '2026-10-01', currency: 'USD', amount: 700, krw_cost: 1000000, account_id: salary });
  addEventCashFlow(db, { event_id: trip, date: '2026-10-06', currency: 'USD', amount: -200, krw_cost: 300000, account_id: salary });
  income(db, salary, '2026-10-25', 3000000);
  expect(getAccountTransactions(db, salary).filter(t => t.type === 'income')).toHaveLength(2);   // 재환전 입금이 계좌에 있다
  expect(getMonthlyIncome(db, ['2026-10'], TODAY)['2026-10'].income).toBe(3000000);
});

test('실제 흐름 — 자동 등록이 예정을 만들고, 들어와서 고치면 실제 금액이 된다', () => {
  const { db } = createDatabase(SQL, null);
  const acct = addAccount(db, { name: '월급통장' });
  addRecurringItem(db, { account_id: acct, name: '월급', type: 'income', day_of_month: 25, fixed_amount: 3000000 });
  const now = new Date(2026, 10, 15);                                    // 2026-11-15
  runAccountAutoRegister(db, now);
  const before = getMonthlyIncome(db, null, '2026-11-15');
  expect(before['2026-11']).toEqual({ income: 3000000, upcoming: 3000000, unconfirmed: 0 });
  expect(Object.keys(before).length).toBeGreaterThanOrEqual(2);          // 앞으로 몇 달 치 예정도 있다
  const nov = getAccountTransactions(db, acct).find(t => t.recurring_month === '2026-11');
  expect(getMonthlyIncome(db, ['2026-11'], '2026-11-30')['2026-11']).toEqual({ income: 3000000, upcoming: 0, unconfirmed: 3000000 });
  updateAccountTransaction(db, nov.id, { date: nov.date, type: 'income', description: '월급', amount: 3080000 });
  expect(getMonthlyIncome(db, ['2026-11'], '2026-11-30')['2026-11']).toEqual({ income: 3080000, upcoming: 0, unconfirmed: 0 });
  expect(getRecurringItems(db, acct)).toHaveLength(1);
});

test('병합 — 이 기기에서 새로 만든 계좌의 선택도, 다른 기기가 계좌를 먼저 만들어 id가 바뀌면 새 id의 계좌에 들어간다', () => {
  const base = makeDb();
  const bytes = base.db.export();
  const mine = createDatabase(SQL, bytes).db;
  attachChangeLog(mine);
  const mineNew = addAccount(mine, { name: '내 새 계좌' });             // 이 기기에서 id 3
  setAccountCountsIncome(mine, mineNew, true);
  setAccountCountsIncome(mine, base.saving, true);
  const remote = createDatabase(SQL, bytes).db;
  addAccount(remote, { name: '다른 기기 계좌' });                      // 다른 기기가 먼저 id 3을 차지
  replayChanges(remote, getChangeLog(mine).entries);
  expect(getIncomeAccounts(remote).map(a => [a.name, a.counted])).toEqual([
    ['월급통장', true], ['적금통장', true], ['다른 기기 계좌', false], ['내 새 계좌', true],
  ]);
});

test('월 수지 — 남은 돈 = 수입 - 가계부 순지출(할인 뺀 금액), 저축률 = 남은 돈 / 수입 (수입이 없으면 없음)', () => {
  const { db, salary } = makeDb();
  income(db, salary, '2026-11-10', 3000000);
  addTransaction(db, { payment_method: '현금', date: '2026-11-05', budget_category: '식비', detail: '마트', amount: 1100000, discount_amount: 100000 });
  addTransaction(db, { payment_method: '현금', date: '2026-10-05', budget_category: '식비', detail: '지난달', amount: 999999 });
  expect(getMonthlyBalance(db, '2026-11', TODAY)).toEqual({
    income: 3000000, upcoming: 0, unconfirmed: 0, spend: 1000000, left: 2000000, rate: 2000000 / 3000000,
  });
  expect(getMonthlyBalance(db, '2026-10', TODAY)).toEqual({ income: 0, upcoming: 0, unconfirmed: 0, spend: 999999, left: -999999, rate: null });
});
