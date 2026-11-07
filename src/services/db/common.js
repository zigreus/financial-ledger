// DB 모듈 공용 도우미 — 행 → 객체 변환, 트랜잭션(SAVEPOINT), 테이블·컬럼 검사, 오늘 날짜.
// 여러 db 모듈이 함께 쓰는 것만 둔다 (db 모듈끼리 서로 순환 import하지 않도록 바닥에 두는 모듈).

import { todayStr } from '../dateUtils';

export function tableExists(db, table) {
  const res = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", [table]);
  return !!res[0]?.values.length;
}

export function columnsOf(db, table) {
  const res = db.exec(`PRAGMA table_info(${table})`);
  return new Set((res[0]?.values || []).map(r => r[1]));
}

/** 쓰기 문장을 실행하고 바뀐 행 수를 돌려준다. */
export function runCount(db, sql, params) {
  db.run(sql, params);
  return db.getRowsModified();
}

/**
 * 여러 문장을 하나의 단위로 실행한다 — 중간에 실패하면 전부 되돌린다.
 * SAVEPOINT를 써서 중첩 호출도 안전하다.
 */
let savepointSeq = 0;
export function withTransaction(db, fn) {
  const name = `sp_${++savepointSeq}`;
  db.run(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.run(`RELEASE ${name}`);
    return result;
  } catch (e) {
    db.run(`ROLLBACK TO ${name}`);
    db.run(`RELEASE ${name}`);
    throw e;
  }
}

export const todayLocal = todayStr;

export function dbRowsToObjects(result) {
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}
