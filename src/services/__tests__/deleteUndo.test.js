// 거래 삭제 되돌리기 (ROADMAP U-3)와 금액 읽어 주기 (U-4) — 지운 행을 그대로 되살리고, 연결(여행 정산 나눔·재환전 기록·분할 묶음)을 새 번호로 잇는다.
// 다른 기기와 합칠 때(변경 기록 다시 실행)도 같은 결과가 되는지 본다.
import initSqlJs from 'sql.js';
import * as M from '../dbManager';
import { attachChangeLog, getChangeLog, replayChanges } from '../changeLog';
import { amountInWords } from '../formulaEvaluator';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const rows = (db, sql, params = []) => (db.exec(sql, params)[0]?.values || []);
const tx = (over = {}) => ({
  payment_method: '신한카드', date: '2026-11-08', budget_category: '식비', sub_category: '외식', detail: '김밥', amount: 9000, ...over,
});

function makeDb() {
  const { db } = M.createDatabase(SQL, null);
  M.addPaymentMethod(db, '신한카드');
  M.addPaymentMethod(db, '현금');
  M.addBudgetCategory(db, '식비');
  M.addSubCategory(db, '식비', '외식');
  return db;
}

/** 거래 줄 — 번호를 빼고 비교한다(되살리면 새 번호) */
const txRows = db => rows(db, `SELECT payment_method, date, detail, amount, discount_amount, COALESCE(split_group_id, ''),
  COALESCE(member, ''), COALESCE(foreign_amounts, '') FROM transactions ORDER BY date, detail, payment_method`);

describe('삭제 되돌리기 (U-3)', () => {
  test('지운 거래가 그대로 돌아온다 — 할인·누가·외화·분할 묶음까지', () => {
    const db = makeDb();
    M.addTransaction(db, tx({ discount_amount: 500, discount_note: '청구할인', member: '엄마', foreign_amounts: '{"JPY":1000}' }));
    const a = M.addTransaction(db, tx({ detail: '회식', amount: 30000, split_group_id: 'g1' }));
    const b = M.addTransaction(db, tx({ detail: '회식', amount: 20000, payment_method: '현금', split_group_id: 'g1' }));
    const before = txRows(db);
    const undo = M.deleteTransactionsForUndo(db, [a, b, a]);   // 같은 번호가 두 번 와도 한 번만
    expect(undo.transactions).toHaveLength(2);
    expect(rows(db, 'SELECT COUNT(*) FROM transactions')[0][0]).toBe(1);
    expect(M.restoreDeletedTransactions(db, undo)).toBe(2);
    expect(txRows(db)).toEqual(before);
    expect(rows(db, "SELECT COUNT(*) FROM transactions WHERE split_group_id = 'g1'")[0][0]).toBe(2);
    expect(M.restoreDeletedTransactions(db, { transactions: [] })).toBe(0);
  });

  test('여행 정산 나눔 설정과 재환전 기록의 연결도 새 번호로 이어진다 — 그사이 다른 거래로 바뀐 연결은 그대로', () => {
    const db = makeDb();
    db.run("INSERT INTO calendar_events (title, date_from, date_to, event_type) VALUES ('도쿄', '2026-11-01', '2026-11-10', 'trip')");
    const eventId = rows(db, 'SELECT id FROM calendar_events')[0][0];
    const fx = M.addTransaction(db, tx({ detail: '환차손', amount: 1200 }));
    const meal = M.addTransaction(db, tx({ detail: '라멘', amount: 15000, event_id: eventId }));
    db.run(`INSERT INTO trip_split_entries (event_id, transaction_id, payer, title, date, amount, shared_by)
            VALUES (?, ?, '나', '라멘', '2026-11-08', 15000, '나,친구')`, [eventId, meal]);
    db.run(`INSERT INTO event_cash_flows (event_id, date, type, currency, amount, krw_cost, linked_tx_id)
            VALUES (?, '2026-11-08', 'exchange', 'JPY', 10000, 90000, ?)`, [eventId, fx]);
    db.run(`INSERT INTO event_cash_flows (event_id, date, type, currency, amount, krw_cost, linked_tx_id)
            VALUES (?, '2026-11-09', 'exchange', 'JPY', 5000, 45000, ?)`, [eventId, fx]);
    const [flow1, flow2] = rows(db, 'SELECT id FROM event_cash_flows ORDER BY id').map(r => r[0]);

    const undo = M.deleteTransactionsForUndo(db, [fx, meal]);
    expect(rows(db, 'SELECT COUNT(*) FROM trip_split_entries')[0][0]).toBe(0);
    // 그사이 두 번째 재환전 기록은 다른 거래를 가리키게 됐다
    const other = M.addTransaction(db, tx({ detail: '다른 환차손', amount: 300 }));
    db.run('UPDATE event_cash_flows SET linked_tx_id = ? WHERE id = ?', [other, flow2]);

    M.restoreDeletedTransactions(db, undo);
    const newFx = rows(db, "SELECT id FROM transactions WHERE detail = '환차손'")[0][0];
    const newMeal = rows(db, "SELECT id FROM transactions WHERE detail = '라멘'")[0][0];
    expect(newFx).not.toBe(fx);
    expect(rows(db, 'SELECT transaction_id, title, shared_by FROM trip_split_entries')).toEqual([[newMeal, '라멘', '나,친구']]);
    expect(rows(db, 'SELECT id, linked_tx_id FROM event_cash_flows ORDER BY id')).toEqual([[flow1, newFx], [flow2, other]]);
  });

  test('정기지출이 등록한 거래는 등록 기록도 새 번호를 가리킨다 — 연간 결제 달을 옮길 때 찾을 수 있게(I-037)', () => {
    const db = makeDb();
    db.run(`INSERT INTO recurring_transactions (payment_method, budget_category, sub_category, detail, amount, frequency, month_of_year, day_of_month)
            VALUES ('신한카드', '식비', '외식', '도메인', 20000, 'annual', 1, 5)`);
    const rid = rows(db, 'SELECT id FROM recurring_transactions')[0][0];
    const id = M.addTransaction(db, tx({ detail: '도메인', amount: 20000, date: '2027-01-05' }));
    db.run('UPDATE transactions SET recurring_source_id = ? WHERE id = ?', [rid, id]);   // 자동등록이 넣은 것처럼
    db.run("INSERT INTO recurring_registration_log (recurring_id, registered_for_month, transaction_id) VALUES (?, '2027-01', ?)", [rid, id]);
    const undo = M.deleteTransactionsForUndo(db, [id]);
    M.restoreDeletedTransactions(db, undo);
    const newId = rows(db, "SELECT id FROM transactions WHERE detail = '도메인'")[0][0];
    expect(newId).not.toBe(id);
    expect(rows(db, 'SELECT registered_for_month, transaction_id FROM recurring_registration_log')).toEqual([['2027-01', newId]]);
    expect(rows(db, 'SELECT recurring_source_id FROM transactions WHERE id = ?', [newId])).toEqual([[rid]]);
  });

  test('다른 기기와 합칠 때 — 다시 실행해도 그 기기 가계부에 같은 거래가 돌아오고 연결도 그 기기의 새 번호를 가리킨다', () => {
    const base = makeDb();
    base.run("INSERT INTO calendar_events (title, date_from, date_to, event_type) VALUES ('도쿄', '2026-11-01', '2026-11-10', 'trip')");
    const eventId = rows(base, 'SELECT id FROM calendar_events')[0][0];
    const meal = M.addTransaction(base, tx({ detail: '라멘', amount: 15000, event_id: eventId }));
    base.run(`INSERT INTO trip_split_entries (event_id, transaction_id, payer, title, date, amount, shared_by)
              VALUES (?, ?, '나', '라멘', '2026-11-08', 15000, '나,친구')`, [eventId, meal]);
    base.run(`INSERT INTO event_cash_flows (event_id, date, type, currency, amount, krw_cost, linked_tx_id)
              VALUES (?, '2026-11-08', 'exchange', 'JPY', 10000, 90000, ?)`, [eventId, meal]);
    const bytes = base.export();

    const mine = M.createDatabase(SQL, bytes).db;
    attachChangeLog(mine);
    const undo = M.deleteTransactionsForUndo(mine, [meal]);
    M.restoreDeletedTransactions(mine, undo);

    const remote = M.createDatabase(SQL, bytes).db;
    M.addTransaction(remote, tx({ detail: '다른 기기 커피', amount: 4500 }));   // 다른 기기가 먼저 넣어 번호가 앞선다
    M.addTransaction(remote, tx({ detail: '다른 기기 빵', amount: 3000 }));
    replayChanges(remote, getChangeLog(mine).entries);

    const ramen = rows(remote, "SELECT id, amount, event_id FROM transactions WHERE detail = '라멘'");
    expect(ramen).toHaveLength(1);
    const [newId, amount, ev] = ramen[0];
    expect([amount, ev]).toEqual([15000, eventId]);
    expect(rows(remote, 'SELECT transaction_id FROM trip_split_entries')).toEqual([[newId]]);
    expect(rows(remote, 'SELECT linked_tx_id FROM event_cash_flows')).toEqual([[newId]]);
    expect(rows(remote, 'SELECT COUNT(*) FROM transactions')[0][0]).toBe(3);
  });
});

describe('금액 읽어 주기 (U-4)', () => {
  test.each([
    [9999, ''],
    [10000, '1만 원'],
    [12345, '1만 2,345원'],
    [1250000, '125만 원'],
    [1234567, '123만 4,567원'],
    [100000000, '1억 원'],
    [125000000, '1억 2,500만 원'],
    [100000500, '1억 500원'],
    [3000000000000, '3조 원'],
    [-50000, '-5만 원'],
    [12500.6, '1만 2,501원'],
    [NaN, ''],
    ['abc', ''],
  ])('%s → "%s"', (n, words) => {
    expect(amountInWords(n)).toBe(words);
  });
});
