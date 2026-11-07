/**
 * @jest-environment node
 */
// dbManager 핵심 로직 테스트 (I-001). 실행: npm test -- --watchAll=false
import initSqlJs from 'sql.js';
import {
  createDatabase, addTransaction, addCalendarEvent, addEventCountry, withTransaction,
  addAccount, addRecurringItem, runAccountAutoRegister, deleteAccountTransaction,
  runAutoRegister, updateRecurringItem,
} from '../dbManager';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const count = (db, sql, params) => db.exec(sql, params)[0].values[0][0];
const tx = (date, detail, amount) => ({
  payment_method: '카드', date, budget_category: '식비', sub_category: '', detail, amount,
});

describe('createDatabase (B-002, I-009)', () => {
  test('변경이 없으면 다시 불러올 때 didMigrate가 false다', () => {
    const first = createDatabase(SQL, null);
    expect(first.didMigrate).toBe(true); // 새 DB는 한 번 저장해야 함
    const second = createDatabase(SQL, first.db.export());
    expect(second.didMigrate).toBe(false);
    expect(second.migrationErrors).toEqual([]);
    expect(count(second.db, 'PRAGMA user_version')).toBeGreaterThan(0);
  });

  test('사라진 trips/holidays 테이블을 다시 만들지 않는다', () => {
    const { db } = createDatabase(SQL, null);
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0].values.map(r => r[0]);
    expect(tables).not.toContain('trips');
    expect(tables).not.toContain('holidays');
  });
});

describe('계좌 자동등록 (B-007, B-008, B-009)', () => {
  const setup = () => {
    const { db } = createDatabase(SQL, null);
    const acc = addAccount(db, { name: '테스트', current_balance: 0 });
    addRecurringItem(db, { account_id: acc, name: '말일', type: 'expense', day_of_month: 31, holiday_rule: 'next_business', fixed_amount: 1000, register_months_ahead: 6 });
    addRecurringItem(db, { account_id: acc, name: '1일', type: 'expense', day_of_month: 1, holiday_rule: 'prev_business', fixed_amount: 500, register_months_ahead: 6 });
    return db;
  };

  test('여러 번 실행해도 (항목, 대상 월)마다 한 건만 만든다', () => {
    const db = setup();
    const first = runAccountAutoRegister(db);
    expect(first).toBe(14); // 2개 항목 × 7개월
    expect(runAccountAutoRegister(db)).toBe(0);
    expect(runAccountAutoRegister(db)).toBe(0);
    expect(count(db, 'SELECT COUNT(*) FROM account_transactions')).toBe(14);
  });

  test('자동 생성 내역을 지우면 그 달은 다시 만들지 않는다', () => {
    const db = setup();
    runAccountAutoRegister(db);
    const id = count(db, "SELECT MAX(id) FROM account_transactions WHERE description = '1일'");
    deleteAccountTransaction(db, id);
    expect(runAccountAutoRegister(db)).toBe(0);
  });

  test('고정항목 금액을 바꾸면 고치지 않은 미래 내역에 반영된다', () => {
    const db = setup();
    runAccountAutoRegister(db);
    const itemId = count(db, "SELECT id FROM account_recurring_items WHERE name = '말일'");
    updateRecurringItem(db, itemId, { name: '말일', type: 'expense', day_of_month: 31, holiday_rule: 'next_business', fixed_amount: 2000, register_months_ahead: 6 });
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(count(db, "SELECT COUNT(*) FROM account_transactions WHERE description = '말일' AND date > ? AND amount != 2000", [todayStr])).toBe(0);
  });

  test('예전 코드가 만든 같은 달 중복은 불러올 때 정리된다', () => {
    const db = setup();
    const itemId = count(db, "SELECT id FROM account_recurring_items WHERE name = '말일'");
    for (let i = 0; i < 3; i++) {
      db.run(`INSERT INTO account_transactions (account_id, date, type, description, amount, recurring_item_id, is_auto_generated)
              VALUES (1, '2027-02-01', 'expense', '말일', 1000, ?, 1)`, [itemId]);
    }
    db.run('DROP INDEX IF EXISTS ux_account_tx_recurring');
    db.run("UPDATE account_transactions SET recurring_month = ''");
    db.run('PRAGMA user_version = 0');
    const { db: reloaded } = createDatabase(SQL, db.export());
    expect(count(reloaded, 'SELECT COUNT(*) FROM account_transactions WHERE recurring_item_id = ?', [itemId])).toBe(1);
    // 2027-02-01은 1월 31일(일)의 다음 영업일 → 대상 월은 1월
    expect(count(reloaded, 'SELECT recurring_month FROM account_transactions WHERE recurring_item_id = ?', [itemId])).toBe('2027-01');
  });
});

describe('정기지출 자동등록 (B-010)', () => {
  test('마지막 등록 달 이후 빠진 달을 채우고, 다시 실행하면 0건', () => {
    const { db } = createDatabase(SQL, null);
    db.run("INSERT INTO recurring_transactions (payment_method, budget_category, amount, frequency, day_of_month) VALUES ('카드','주거',500000,'monthly',25)");
    db.run("INSERT INTO recurring_registration_log (recurring_id, registered_for_month) VALUES (1, '2026-09')");
    const now = new Date(2026, 10, 7); // 2026-11-07 → 목표 2027-01
    const res = runAutoRegister(db, now);
    expect(res.months).toEqual(['2026-10', '2026-11', '2026-12', '2027-01']);
    expect(runAutoRegister(db, now).count).toBe(0);
  });

  test('처음 등록하는 항목은 목표 달만 등록한다', () => {
    const { db } = createDatabase(SQL, null);
    db.run("INSERT INTO recurring_transactions (payment_method, budget_category, amount, frequency, day_of_month) VALUES ('카드','주거',500000,'monthly',0)");
    const res = runAutoRegister(db, new Date(2026, 10, 7));
    expect(res.months).toEqual(['2027-01']);
    expect(count(db, 'SELECT date FROM transactions')).toBe('2027-01-31'); // 0 = 말일
  });
});

describe('withTransaction', () => {
  test('중간에 실패하면 전부 되돌리고, 중첩해도 안전하다', () => {
    const { db } = createDatabase(SQL, null);
    expect(() => withTransaction(db, () => {
      addTransaction(db, tx('2026-11-01', 'a', 1));
      withTransaction(db, () => addTransaction(db, tx('2026-11-01', 'b', 2)));
      throw new Error('fail');
    })).toThrow('fail');
    expect(count(db, 'SELECT COUNT(*) FROM transactions')).toBe(0);
  });
});

describe('일정·국가 (변경 기록 병합에서 쓰는 함수 확인)', () => {
  test('addCalendarEvent는 새 id를 돌려준다', () => {
    const { db } = createDatabase(SQL, null);
    const id = addCalendarEvent(db, { title: 't', date_from: '2026-12-01', date_to: '2026-12-02', event_type: 'trip' });
    addEventCountry(db, id, '일본', 'JPY', 9);
    expect(count(db, 'SELECT event_id FROM event_countries')).toBe(id);
  });
});
