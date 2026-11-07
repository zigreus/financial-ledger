/**
 * @vitest-environment node
 */
// 가족 구성원(누가) — 이름 참조·마이그레이션·병합 (I-013)
import initSqlJs from 'sql.js';
import {
  createDatabase, SCHEMA_VERSION, addTransaction, updateTransaction, getTransactions, MEMBER_NONE,
  getMembers, getMemberNames, addMember, renameMember, deleteMember, getMemberUsage, getMemberSummary,
} from '../dbManager';
import { attachChangeLog, getChangeLog, replayChanges } from '../changeLog';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const tx = (detail, amount, extra = {}) => ({
  payment_method: '카드', date: '2026-11-08', budget_category: '식비', sub_category: '', detail, amount, ...extra,
});
const memberOf = (db, detail) => db.exec('SELECT member FROM transactions WHERE detail = ?', [detail])[0]?.values[0][0];

test('예전(v2) DB를 열면 members 테이블과 transactions.member가 생기고 버전이 올라간다', () => {
  const old = new SQL.Database();
  old.run(`CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, payment_method TEXT NOT NULL, date TEXT NOT NULL,
           budget_category TEXT NOT NULL, sub_category TEXT DEFAULT '', detail TEXT DEFAULT '', amount INTEGER NOT NULL)`);
  old.run("INSERT INTO transactions (payment_method, date, budget_category, amount) VALUES ('카드', '2026-01-01', '식비', 1000)");
  old.run('PRAGMA user_version = 2');
  const { db, didMigrate, migrationErrors } = createDatabase(SQL, old.export());
  expect(migrationErrors).toEqual([]);
  expect(didMigrate).toBe(true);
  expect(db.exec('PRAGMA user_version')[0].values[0][0]).toBe(SCHEMA_VERSION);
  expect(db.exec('SELECT member FROM transactions')[0].values[0][0]).toBe('');
  expect(getMembers(db)).toEqual([]);

  // 이미 최신이면 다시 열어도 아무것도 바꾸지 않는다 (불필요한 업로드 방지)
  expect(createDatabase(SQL, db.export()).didMigrate).toBe(false);
});

test('추가·중복 이름 막기·이름 변경·삭제가 거래 참조를 함께 고친다', () => {
  const { db } = createDatabase(SQL, null);
  addMember(db, ' 엄마 ');
  addMember(db, '아빠');
  expect(getMemberNames(db)).toEqual(['엄마', '아빠']);
  expect(() => addMember(db, '엄마')).toThrow(/이미 있습니다/);
  expect(() => addMember(db, '  ')).toThrow(/이름을 입력/);

  addTransaction(db, tx('점심', 9000, { member: '엄마' }));
  addTransaction(db, tx('커피', 4500, { member: '아빠' }));
  expect(getMemberUsage(db, '엄마')).toBe(1);

  renameMember(db, '엄마', '지민');
  expect(getMemberNames(db)).toEqual(['지민', '아빠']);
  expect(memberOf(db, '점심')).toBe('지민');
  expect(() => renameMember(db, '지민', '아빠')).toThrow(/이미 있습니다/);

  deleteMember(db, '아빠');
  expect(getMemberNames(db)).toEqual(['지민']);
  expect(memberOf(db, '커피')).toBe(''); // 거래는 남고 '누가'만 비워진다
  expect(getTransactions(db)).toHaveLength(2);
});

test("updateTransaction은 member를 넘긴 경우에만 바꾼다 (카드 대조 금액 수정이 '누가'를 지우지 않게)", () => {
  const { db } = createDatabase(SQL, null);
  const id = addTransaction(db, tx('점심', 9000, { member: '엄마' }));
  updateTransaction(db, id, tx('점심', 9500));
  expect(memberOf(db, '점심')).toBe('엄마');
  updateTransaction(db, id, tx('점심', 9500, { member: '' }));
  expect(memberOf(db, '점심')).toBe('');
});

test('거래 목록 필터와 구성원별 합계', () => {
  const { db } = createDatabase(SQL, null);
  addTransaction(db, tx('a', 1000, { member: '엄마' }));
  addTransaction(db, tx('b', 2000, { member: '엄마', discount_amount: 500 }));
  addTransaction(db, tx('c', 4000, { member: '아빠' }));
  addTransaction(db, tx('d', 8000));
  addTransaction(db, tx('e', 100, { date: '2026-10-01', member: '엄마' }));

  expect(getTransactions(db, { member: '엄마' }).map(t => t.detail).sort()).toEqual(['a', 'b', 'e']);
  expect(getTransactions(db, { member: MEMBER_NONE }).map(t => t.detail)).toEqual(['d']);

  expect(getMemberSummary(db, { month: '2026-11' })).toEqual([
    { member: '', total: 8000, discount: 0, cnt: 1 },
    { member: '아빠', total: 4000, discount: 0, cnt: 1 },
    { member: '엄마', total: 3000, discount: 500, cnt: 2 },
  ]);
  // 정렬은 표에 보이는 순지출 기준 — 할인이 커서 순지출이 작아지면 아래로 (B-051)
  addTransaction(db, tx('f', 2000, { member: '엄마' }));
  addTransaction(db, tx('g', 1000, { member: '아빠', discount_amount: 2500 }));
  expect(getMemberSummary(db, { month: '2026-11' }).map(r => [r.member, r.total - r.discount]))
    .toEqual([['', 8000], ['엄마', 4500], ['아빠', 2500]]);
  expect(getMemberSummary(db, { year: '2026' }).find(r => r.member === '엄마').cnt).toBe(4); // a, b, f + 10월 e
  expect(getMemberSummary(db, { from: '2026-10-01', to: '2026-10-31' })).toEqual([
    { member: '엄마', total: 100, discount: 0, cnt: 1 },
  ]);
});

describe('충돌 병합 (이름 참조라 병합에 안전)', () => {
  test('두 기기가 같은 이름을 각자 추가해도 하나만 남고, 양쪽 거래의 누가는 그대로다', () => {
    const base = createDatabase(SQL, null).db.export();
    const A = createDatabase(SQL, base).db;
    attachChangeLog(A);
    const B = createDatabase(SQL, base).db;

    addMember(B, '아빠');
    addMember(B, '엄마');
    addTransaction(B, tx('B 점심', 9000, { member: '엄마' }));
    const remote = B.export();

    addMember(A, '엄마');
    addTransaction(A, tx('A 커피', 4500, { member: '엄마' }));

    const fresh = createDatabase(SQL, remote).db;
    const { skipped } = replayChanges(fresh, getChangeLog(A).entries);
    expect(skipped).toBe(1); // A의 '엄마' 추가는 이미 있어 건너뜀
    expect(getMemberNames(fresh)).toEqual(['아빠', '엄마']);
    expect(memberOf(fresh, 'A 커피')).toBe('엄마');
    expect(memberOf(fresh, 'B 점심')).toBe('엄마');
  });

  test('이름을 바꾼 쪽이 먼저 저장한 뒤 옛 이름으로 적은 거래가 병합되면, 다음에 열 때 그 이름을 목록에 되살린다', () => {
    const { db: seed } = createDatabase(SQL, null);
    addMember(seed, '엄마');
    const base = seed.export();
    const A = createDatabase(SQL, base).db;
    const B = createDatabase(SQL, base).db;
    attachChangeLog(B);

    renameMember(A, '엄마', '지민');
    const remote = A.export();
    addTransaction(B, tx('B 장보기', 30000, { member: '엄마' }));

    const fresh = createDatabase(SQL, remote).db;
    replayChanges(fresh, getChangeLog(B).entries);
    expect(getMemberNames(fresh)).toEqual(['지민']); // 병합 직후엔 목록에 없는 이름

    const reopened = createDatabase(SQL, fresh.export());
    expect(reopened.didMigrate).toBe(true);
    expect(getMemberNames(reopened.db)).toEqual(['지민', '엄마']);
    expect(createDatabase(SQL, reopened.db.export()).didMigrate).toBe(false); // 한 번 맞추면 끝
  });

  test('한 기기에서 이름을 바꾸는 동안 다른 기기가 옛 이름으로 적은 거래도 병합 뒤 새 이름이 된다', () => {
    const { db: seed } = createDatabase(SQL, null);
    addMember(seed, '엄마');
    const base = seed.export();
    const A = createDatabase(SQL, base).db;
    attachChangeLog(A);
    const B = createDatabase(SQL, base).db;

    addTransaction(B, tx('B 장보기', 30000, { member: '엄마' }));
    const remote = B.export();

    renameMember(A, '엄마', '지민');

    const fresh = createDatabase(SQL, remote).db;
    replayChanges(fresh, getChangeLog(A).entries);
    expect(getMemberNames(fresh)).toEqual(['지민']);
    expect(memberOf(fresh, 'B 장보기')).toBe('지민');
  });
});
