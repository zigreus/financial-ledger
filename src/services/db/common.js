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

/** 행 하나를 새로 넣는다(id 없이 — 새 번호). 칸 이름은 테이블의 칸 목록(columnsOf)으로만 고른다(AGENTS §2.9). 넣은 행의 id */
export function reinsert(db, table, row, overrides = {}) {
  const allowed = columnsOf(db, table);
  const data = { ...row, ...overrides };
  const cols = Object.keys(data).filter(c => c !== 'id' && allowed.has(c));
  db.run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map(c => data[c] ?? null),
  );
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
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

/**
 * 외화 금액이 있는 거래(해외 결제)인지 — transactions.foreign_amounts(JSON {통화: 금액})에 원화(KRW)가 아닌 통화의 0 아닌 금액이 있으면.
 * 일정 통화는 직접 적을 수 있어 국내 일정의 'KRW'만 적힌 거래도 있다 — 그건 해외 결제가 아니다. 깨진 JSON은 국내로 본다.
 * (카드 대조·연말정산 참고 합계가 같이 쓴다)
 */
export function hasForeignAmount(foreignAmounts) {
  if (!foreignAmounts) return false;
  try {
    const f = JSON.parse(foreignAmounts);
    return !!f && typeof f === 'object' && Object.keys(f).some(k => k.trim().toUpperCase() !== 'KRW' && Number(f[k]));
  } catch (e) {
    return false;
  }
}

/** 이름 비교용 — 소문자, 숫자·영문·한글·가나·한자만 (가게 이름·세부내역 견주기) */
export const normalizeName = s => String(s || '').toLowerCase().replace(/[^0-9a-z가-힣ぁ-んァ-ン一-龥]/g, '');

export function dbRowsToObjects(result) {
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}
