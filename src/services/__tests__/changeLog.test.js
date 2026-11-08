/**
 * @vitest-environment node
 */
// 변경 기록·충돌 병합 테스트 (B-001, I-001)
import initSqlJs from 'sql.js';
import {
  createDatabase, addTransaction, addCalendarEvent, addEventCountry, withTransaction,
  addPaymentMethod, setMasterItemHidden, getAllPaymentMethods, ensureSubCategoriesExist,
} from '../dbManager';
import {
  attachChangeLog, getChangeLog, replayChanges, stampWriteId, readWriteId, hasWriteId, paramColumns, SYNC_LOG_KEEP,
} from '../changeLog';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const tx = (date, detail, amount) => ({
  payment_method: '카드', date, budget_category: '식비', sub_category: '', detail, amount,
});
const rows = (db, sql) => (db.exec(sql)[0]?.values || []);

test('두 기기가 같은 버전에서 각자 추가해도 병합하면 둘 다 남고, 새 행 참조 id가 바뀐다', () => {
  const { db: base } = createDatabase(SQL, null);
  addTransaction(base, tx('2026-11-01', '기존', 1000));
  let remote = base.export();

  const A = createDatabase(SQL, remote).db;
  attachChangeLog(A);
  const B = createDatabase(SQL, remote).db;

  // B가 먼저 저장
  addTransaction(B, tx('2026-11-05', 'B 점심', 9000));
  const evB = addCalendarEvent(B, { title: 'B 여행', date_from: '2026-12-01', date_to: '2026-12-03', event_type: 'trip' });
  addEventCountry(B, evB, '일본', 'JPY', 9.1);
  remote = B.export();

  // A는 옛 버전에서 추가 (같은 id가 겹친다)
  addTransaction(A, tx('2026-11-06', 'A 저녁', 20000));
  const evA = addCalendarEvent(A, { title: 'A 출장', date_from: '2026-12-10', date_to: '2026-12-12', event_type: 'trip' });
  addEventCountry(A, evA, '미국', 'USD', 1400);
  expect(evA).toBe(evB);

  const fresh = createDatabase(SQL, remote).db;
  const { skipped } = replayChanges(fresh, getChangeLog(A).entries);
  expect(skipped).toBe(0);
  expect(rows(fresh, 'SELECT detail FROM transactions ORDER BY id').map(r => r[0]))
    .toEqual(['기존', 'B 점심', 'A 저녁']);
  expect(rows(fresh, `SELECT e.title, c.country FROM event_countries c
                      JOIN calendar_events e ON e.id = c.event_id ORDER BY c.id`))
    .toEqual([['B 여행', '일본'], ['A 출장', '미국']]);
});

test('되돌린 트랜잭션의 문장은 기록에서 빠진다', () => {
  const { db } = createDatabase(SQL, null);
  attachChangeLog(db);
  withTransaction(db, () => addTransaction(db, tx('2026-11-01', 'keep', 1)));
  expect(() => withTransaction(db, () => {
    addTransaction(db, tx('2026-11-01', 'drop', 2));
    throw new Error('x');
  })).toThrow();
  const sqls = getChangeLog(db).entries.map(e => e.params?.[4]);
  expect(sqls).toEqual(['keep']);
});

test('읽기는 기록하지 않고 쓰기만 기록하며, onWrite가 불린다', () => {
  const { db } = createDatabase(SQL, null);
  const onWrite = vi.fn();
  attachChangeLog(db, { onWrite });
  db.exec('SELECT * FROM transactions');
  addTransaction(db, tx('2026-11-01', 'x', 1));
  expect(getChangeLog(db).entries).toHaveLength(1);
  expect(onWrite).toHaveBeenCalledTimes(1);
});

test('교체된 옛 DB로 들어온 쓰기는 새 DB로 넘어간다', () => {
  const oldDb = createDatabase(SQL, null).db;
  const newDb = createDatabase(SQL, null).db;
  attachChangeLog(oldDb);
  attachChangeLog(newDb);
  getChangeLog(oldDb).forwardTo = newDb;
  addTransaction(oldDb, tx('2026-11-01', 'late', 1));
  expect(rows(newDb, 'SELECT detail FROM transactions').map(r => r[0])).toEqual(['late']);
  expect(getChangeLog(newDb).entries).toHaveLength(1);
});

test('동기화 표식은 기록되지 않고 파일에 남는다', () => {
  const { db } = createDatabase(SQL, null);
  attachChangeLog(db);
  const id = stampWriteId(db);
  expect(getChangeLog(db).entries).toHaveLength(0);
  expect(readWriteId(createDatabase(SQL, db.export()).db)).toBe(id);
});

test('동기화 표식은 최근 것들을 기억해, 다른 기기가 그 위에 합쳐 저장해도 내 표식을 찾는다 (B-088)', () => {
  const { db: mine } = createDatabase(SQL, null);
  const myId = stampWriteId(mine);
  // 다른 기기: 내 파일을 받아 자기 변경을 다시 실행하고 자기 표식을 남겨 저장
  const { db: other } = createDatabase(SQL, mine.export());
  addTransaction(other, tx('2026-11-02', '다른 기기', 1));
  const otherId = stampWriteId(other);
  const remote = createDatabase(SQL, other.export()).db;
  expect(readWriteId(remote)).toBe(otherId);
  expect(hasWriteId(remote, myId)).toBe(true);
  expect(hasWriteId(remote, 'w-없는-표식')).toBe(false);
  expect(hasWriteId(remote, '')).toBe(false);
});

test('동기화 표식 목록은 최근 SYNC_LOG_KEEP개만 남기고, 목록이 없던 예전 파일도 마지막 표식은 찾는다', () => {
  const { db } = createDatabase(SQL, null);
  const ids = Array.from({ length: SYNC_LOG_KEEP + 5 }, () => stampWriteId(db));
  expect(hasWriteId(db, ids[4])).toBe(false);
  expect(hasWriteId(db, ids[5])).toBe(true);
  expect(hasWriteId(db, ids[ids.length - 1])).toBe(true);

  const { db: old } = createDatabase(SQL, null);
  old.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['sync_write_id', 'w-예전']);
  expect(hasWriteId(old, 'w-예전')).toBe(true);
  old.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['sync_write_log', '{깨진 값']);
  expect(hasWriteId(old, 'w-예전')).toBe(true);
  const next = stampWriteId(old); // 깨진 목록은 새로 쓴다
  expect(hasWriteId(old, next)).toBe(true);
});

test('새 표식을 남길 때 앞서 결과를 모르는 이 기기의 표식은 목록에서 뺀다 — 다른 기기 표식은 그대로', () => {
  const { db } = createDatabase(SQL, null);
  const otherDevice = stampWriteId(db);
  const failed1 = stampWriteId(db);
  const failed2 = stampWriteId(db, { replaces: [failed1] });
  const now = stampWriteId(db, { replaces: [failed1, failed2] });
  expect(hasWriteId(db, otherDevice)).toBe(true);
  expect(hasWriteId(db, failed1)).toBe(false);
  expect(hasWriteId(db, failed2)).toBe(false);
  expect(readWriteId(db)).toBe(now);
});

test('paramColumns는 ? 자리의 컬럼을 찾는다', () => {
  expect(paramColumns('INSERT INTO t (a, b, c) VALUES (?, datetime(\'now\'), ?)').cols).toEqual(['a', 'c']);
  expect(paramColumns('UPDATE t SET a=?, b = ? WHERE id = ?')).toEqual({ table: 't', cols: ['a', 'b', 'id'] });
  expect(paramColumns('DELETE FROM t WHERE event_id = ?')).toEqual({ table: 't', cols: ['event_id'] });
});

test('백업으로 되돌린 파일에 다른 기기의 미저장 변경을 다시 실행하면, 새 입력은 들어가고 없는 행 수정은 무시된다 (I-014)', () => {
  // 백업 시점: 거래 1건
  const { db: atBackup } = createDatabase(SQL, null);
  addTransaction(atBackup, tx('2026-11-01', '백업 전', 1000));
  const backupBytes = atBackup.export();

  // 그 뒤 다른 기기 B: 거래 1건 추가(저장됨) → 저장 전에 그 거래를 고치고 새 거래를 하나 더 적음
  const B = createDatabase(SQL, backupBytes).db;
  const laterId = addTransaction(B, tx('2026-11-05', '백업 뒤', 2000));
  attachChangeLog(B);
  B.run('UPDATE transactions SET amount = ? WHERE id = ?', [2500, laterId]);
  addTransaction(B, tx('2026-11-06', 'B 미저장', 3000));

  // 이 기기가 백업으로 되돌림 → B는 다음 저장에서 412를 받고 되돌린 파일에 기록을 다시 실행한다
  const restored = createDatabase(SQL, backupBytes).db;
  const { skipped } = replayChanges(restored, getChangeLog(B).entries);
  expect(skipped).toBe(0);
  expect(rows(restored, 'SELECT detail, amount FROM transactions ORDER BY id'))
    .toEqual([['백업 전', 1000], ['B 미저장', 3000]]);
});

describe('다시 실행 때 들어가지 않은 행을 가리키는 뒤 문장은 건너뛴다 (B-091)', () => {
  const visibleMethods = (db) => getAllPaymentMethods(db).map(m => `${m.name}${m.is_hidden ? '(숨김)' : ''}`);

  test('양쪽에서 같은 이름을 넣어 UNIQUE로 건너뛴 행을 숨기는 수정은, 같은 번호의 다른 행을 숨기지 않는다', () => {
    const base = createDatabase(SQL, null).db.export();
    const other = createDatabase(SQL, base).db;           // 다른 기기가 먼저 저장
    addPaymentMethod(other, '우리카드');                   // id 1
    addPaymentMethod(other, '토스');                       // id 2
    const mine = createDatabase(SQL, base).db;
    attachChangeLog(mine);
    addPaymentMethod(mine, '토스');                        // 이 기기에서는 id 1
    setMasterItemHidden(mine, 'payment_methods', 1, true); // 그 '토스'를 숨김

    const merged = createDatabase(SQL, other.export()).db;
    const { skipped, dropped, entries } = replayChanges(merged, getChangeLog(mine).entries);
    expect(visibleMethods(merged)).toEqual(['우리카드', '토스']); // 우리카드(id 1)가 숨겨지지 않았다
    expect(skipped).toBe(1); // '토스'는 이미 있다
    expect(dropped).toBe(1); // 들어가지 않은 행을 숨기는 수정
    expect(entries).toHaveLength(0); // 건너뛴 문장은 이어 갈 기록에도 남지 않는다
  });

  test('조건에 맞지 않아 0행이 된 INSERT를 가리키는 삭제·딸린 행도 건너뛰고, 상관없는 문장은 그대로 실행한다', () => {
    const base = createDatabase(SQL, null).db.export();
    const other = createDatabase(SQL, base).db;
    const otherEvent = addCalendarEvent(other, { title: '다른 기기 일정', date_from: '2026-12-01', date_to: '2026-12-02', event_type: 'trip' });
    const mine = createDatabase(SQL, base).db;
    attachChangeLog(mine);
    // 비어 있을 때만 넣는 일정(조건부 INSERT…SELECT) → 그 일정에 나라를 붙이고 → 거래 하나 추가
    mine.run(`INSERT INTO calendar_events (title, date_from, date_to, event_type)
              SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM calendar_events)`, ['내 일정', '2026-12-10', '2026-12-11', 'trip']);
    const myEvent = mine.exec('SELECT MAX(id) FROM calendar_events')[0].values[0][0];
    expect(myEvent).toBe(otherEvent); // 같은 번호
    addEventCountry(mine, myEvent, '일본', 'JPY', 9.1);
    addTransaction(mine, tx('2026-11-03', '상관없는 거래', 500));

    const merged = createDatabase(SQL, other.export()).db;
    const { skipped, dropped } = replayChanges(merged, getChangeLog(mine).entries);
    expect(rows(merged, 'SELECT title FROM calendar_events').map(r => r[0])).toEqual(['다른 기기 일정']);
    expect(rows(merged, 'SELECT COUNT(*) FROM event_countries')[0][0]).toBe(0); // 다른 기기 일정에 나라가 붙지 않았다
    expect(rows(merged, 'SELECT detail FROM transactions').map(r => r[0])).toEqual(['상관없는 거래']);
    expect(skipped).toBe(0);
    expect(dropped).toBe(2);
  });

  test('INSERT OR IGNORE가 이미 있는 행 때문에 0행이면 "이미 있음"으로 센다 (조건부 INSERT…SELECT의 0행과 구분)', () => {
    const base = createDatabase(SQL, null).db.export();
    const other = createDatabase(SQL, base).db;
    ensureSubCategoriesExist(other, [{ budget_category: '식비', name: '외식' }]);
    const mine = createDatabase(SQL, base).db;
    attachChangeLog(mine);
    ensureSubCategoriesExist(mine, [{ budget_category: '식비', name: '외식' }]);
    const merged = createDatabase(SQL, other.export()).db;
    const { skipped, dropped } = replayChanges(merged, getChangeLog(mine).entries);
    expect(skipped).toBe(1);
    expect(dropped).toBe(0);
    expect(rows(merged, 'SELECT COUNT(*) FROM sub_categories')[0][0]).toBe(1);
  });

  test('건너뛴 딸린 행을 다시 가리키는 문장(손자)도 건너뛴다 — 같은 번호의 다른 기기 행을 고치지 않는다', () => {
    const base = createDatabase(SQL, null).db.export();
    const other = createDatabase(SQL, base).db;
    const otherEvent = addCalendarEvent(other, { title: '다른 기기 여행', date_from: '2026-12-01', date_to: '2026-12-02', event_type: 'trip' });
    addEventCountry(other, otherEvent, '일본', 'JPY', 9.1);  // event_countries id 1
    const mine = createDatabase(SQL, base).db;
    attachChangeLog(mine);
    mine.run(`INSERT INTO calendar_events (title, date_from, date_to, event_type)
              SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM calendar_events)`, ['내 여행', '2026-12-10', '2026-12-11', 'trip']);
    addEventCountry(mine, 1, '태국', 'THB', 38);             // 이 기기에서도 event_countries id 1
    mine.run('UPDATE event_countries SET exchange_rate = ? WHERE id = ?', [40, 1]);

    const merged = createDatabase(SQL, other.export()).db;
    const { dropped } = replayChanges(merged, getChangeLog(mine).entries);
    expect(rows(merged, 'SELECT country, exchange_rate FROM event_countries')).toEqual([['일본', 9.1]]);
    expect(dropped).toBe(3);
  });
});
