// 가족 구성원 — 거래의 '누가'(transactions.member). 목록·추가·이름 변경·삭제 (I-013).
// 거래는 구성원을 이름으로 참조한다(카테고리·결제수단과 같은 방식) — 두 기기가 같은 이름을 함께 추가해
// 병합 때 UNIQUE로 한쪽이 빠져도 거래 쪽 참조가 어긋나지 않는다. 그래서 이름을 바꾸거나 지울 때는
// 거래의 참조도 같은 트랜잭션에서 함께 고친다 (AGENTS.md §3).

import { dbRowsToObjects, withTransaction } from './common';

export function getMembers(db) {
  return dbRowsToObjects(db.exec('SELECT id, name, sort_order FROM members ORDER BY sort_order, id'));
}

export function getMemberNames(db) {
  return getMembers(db).map(m => m.name);
}

function cleanName(name) {
  const n = String(name ?? '').trim();
  if (!n) throw new Error('이름을 입력하세요.');
  if (n.length > 20) throw new Error('이름은 20자까지 쓸 수 있습니다.');
  return n;
}

function memberExists(db, name) {
  return !!db.exec('SELECT 1 FROM members WHERE name = ?', [name])[0]?.values.length;
}

export function addMember(db, name) {
  const n = cleanName(name);
  if (memberExists(db, n)) throw new Error(`"${n}"은(는) 이미 있습니다.`);
  const next = (db.exec('SELECT COALESCE(MAX(sort_order), 0) FROM members')[0]?.values[0][0] || 0) + 1;
  db.run('INSERT INTO members (name, sort_order) VALUES (?, ?)', [n, next]);
  return n;
}

/** 구성원 이름을 바꾸고, 그 이름으로 적힌 거래도 함께 바꾼다. */
export function renameMember(db, oldName, newName) {
  const n = cleanName(newName);
  if (n === oldName) return n;
  if (memberExists(db, n)) throw new Error(`"${n}"은(는) 이미 있습니다.`);
  withTransaction(db, () => {
    db.run('UPDATE members SET name = ? WHERE name = ?', [n, oldName]);
    db.run('UPDATE transactions SET member = ? WHERE member = ?', [n, oldName]);
  });
  return n;
}

/** 이 구성원으로 적힌 거래 수 */
export function getMemberUsage(db, name) {
  return db.exec('SELECT COUNT(*) FROM transactions WHERE member = ?', [name])[0]?.values[0][0] || 0;
}

/** 구성원을 지운다. 그 이름으로 적힌 거래는 '지정 안 함'(빈 값)이 된다 — 거래 자체는 지우지 않는다. */
export function deleteMember(db, name) {
  withTransaction(db, () => {
    db.run("UPDATE transactions SET member = '' WHERE member = ?", [name]);
    db.run('DELETE FROM members WHERE name = ?', [name]);
  });
}
