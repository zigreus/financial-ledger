/**
 * @vitest-environment node
 */
// 변경 기록·충돌 병합 테스트 (B-001, I-001)
import initSqlJs from 'sql.js';
import {
  createDatabase, addTransaction, addCalendarEvent, addEventCountry, withTransaction,
} from '../dbManager';
import {
  attachChangeLog, getChangeLog, replayChanges, stampWriteId, readWriteId, paramColumns,
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

test('paramColumns는 ? 자리의 컬럼을 찾는다', () => {
  expect(paramColumns('INSERT INTO t (a, b, c) VALUES (?, datetime(\'now\'), ?)').cols).toEqual(['a', 'c']);
  expect(paramColumns('UPDATE t SET a=?, b = ? WHERE id = ?')).toEqual({ table: 't', cols: ['a', 'b', 'id'] });
  expect(paramColumns('DELETE FROM t WHERE event_id = ?')).toEqual({ table: 't', cols: ['event_id'] });
});
