/**
 * @vitest-environment node
 */
// 잔액 위험 알림 (B-066)
import initSqlJs from 'sql.js';
import { createDatabase, addAccount, addAccountTransaction, getAllAccounts, getBalanceAlerts } from '../dbManager';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const NOW = new Date(2026, 10, 8, 10, 0); // 2026-11-08 로컬

function setup({ balance = 1000000, threshold = 500000 } = {}) {
  const { db } = createDatabase(SQL, null);
  addAccount(db, { name: '생활비', current_balance: balance, balance_date: '2026-11-01', danger_threshold: threshold });
  const accountId = getAllAccounts(db)[0].id;
  const add = (date, type, amount, description = '') => addAccountTransaction(db, { account_id: accountId, date, type, amount, description });
  return { db, accountId, add };
}

test('앞으로 잔액이 위험선 아래로 내려가는 첫날을 알려 준다', () => {
  const { db, add } = setup();
  add('2026-11-05', 'expense', 100000);  // 지난 거래 → 지금 900,000
  add('2026-11-15', 'expense', 300000);  // 600,000
  add('2026-11-25', 'expense', 200000);  // 400,000 ← 위험선 아래
  add('2026-11-28', 'expense', 50000);
  expect(getBalanceAlerts(db, { now: NOW })).toEqual([
    expect.objectContaining({ accountName: '생활비', date: '2026-11-25', balance: 400000, daysUntil: 17, isNow: false, threshold: 500000 }),
  ]);
});

test('같은 날 들어오는 돈이 있으면 그날이 끝났을 때 잔액으로 판단한다', () => {
  const { db, add } = setup();
  add('2026-11-25', 'expense', 700000);  // 거래 순서상 잠깐 300,000
  add('2026-11-25', 'income', 2000000);  // 하루 끝 2,300,000
  expect(getBalanceAlerts(db, { now: NOW })).toEqual([]);
});

test('이미 위험선 아래면 오늘로 알리고, 위험선이 없거나 기간 밖이면 알리지 않는다', () => {
  const now = setup({ balance: 300000 });
  expect(getBalanceAlerts(now.db, { now: NOW })).toEqual([
    expect.objectContaining({ isNow: true, date: '2026-11-08', daysUntil: 0, balance: 300000 }),
  ]);

  const none = setup({ threshold: 0 });
  none.add('2026-11-10', 'expense', 990000);
  expect(getBalanceAlerts(none.db, { now: NOW })).toEqual([]);

  const far = setup();
  far.add('2027-01-20', 'expense', 900000); // 35일 넘게 뒤
  expect(getBalanceAlerts(far.db, { now: NOW })).toEqual([]);
});
