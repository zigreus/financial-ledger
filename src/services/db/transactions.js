// 가계부 거래(transactions) 조회·추가·수정·삭제와 분할 결제 묶음 조회.

import { columnsOf, dbRowsToObjects, withTransaction } from './common';

/** 거래 목록 필터에서 '누가'를 지정하지 않은 거래만 고를 때 쓰는 값 */
export const MEMBER_NONE = '__none__';

// ── 거래 내역 ─────────────────────────────────────────────────

/**
 * 거래 목록 — 날짜 내림차순.
 * filters (모두 선택):
 *   month 'YYYY-MM' · dateFrom·dateTo 'YYYY-MM-DD'(포함)
 *   payment_method·budget_category 하나, 또는 payment_methods·budget_categories 여러 개(그중 하나면 된다, I-021)
 *   amountMin·amountMax 순지출(amount - discount_amount, AGENTS §4) 범위 — 숫자일 때만 건다
 *   member(MEMBER_NONE이면 '누가' 없음) · search(내용·세부카테고리·할인 메모)
 */
export function getTransactions(db, filters = {}) {
  let query = 'SELECT * FROM transactions WHERE 1=1';
  const params = [];
  const inList = (column, values) => {
    query += ` AND ${column} IN (${values.map(() => '?').join(', ')})`;
    params.push(...values);
  };

  if (filters.month) {
    query += " AND strftime('%Y-%m', date) = ?";
    params.push(filters.month);
  }
  if (filters.payment_method) {
    query += ' AND payment_method = ?';
    params.push(filters.payment_method);
  }
  if (Array.isArray(filters.payment_methods) && filters.payment_methods.length) {
    inList('payment_method', filters.payment_methods);
  }
  if (filters.budget_category) {
    query += ' AND budget_category = ?';
    params.push(filters.budget_category);
  }
  if (Array.isArray(filters.budget_categories) && filters.budget_categories.length) {
    inList('budget_category', filters.budget_categories);
  }
  if (Number.isFinite(filters.amountMin)) {
    query += ' AND (amount - COALESCE(discount_amount, 0)) >= ?';
    params.push(filters.amountMin);
  }
  if (Number.isFinite(filters.amountMax)) {
    query += ' AND (amount - COALESCE(discount_amount, 0)) <= ?';
    params.push(filters.amountMax);
  }
  if (filters.dateFrom) {
    query += ' AND date >= ?';
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    query += ' AND date <= ?';
    params.push(filters.dateTo);
  }
  // 구성원(I-013): MEMBER_NONE이면 '지정 안 함'인 거래만
  if (filters.member === MEMBER_NONE) {
    query += " AND COALESCE(member, '') = ''";
  } else if (filters.member) {
    query += ' AND member = ?';
    params.push(filters.member);
  }
  if (filters.search) {
    query += ' AND (detail LIKE ? OR sub_category LIKE ? OR discount_note LIKE ?)';
    const kw = `%${filters.search}%`;
    params.push(kw, kw, kw);
  }

  query += ' ORDER BY date DESC, id DESC';

  const result = db.exec(query, params);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function addTransaction(db, tx) {
  db.run(
    `INSERT INTO transactions
       (payment_method, date, budget_category, sub_category, detail, amount, discount_amount, discount_note, event_id, foreign_amounts, split_group_id, is_cash_adjustment, member)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tx.payment_method, tx.date, tx.budget_category,
      tx.sub_category || '', tx.detail || '',
      tx.amount, tx.discount_amount || 0, tx.discount_note || '',
      tx.event_id || null,
      tx.foreign_amounts && Object.keys(tx.foreign_amounts).length ? JSON.stringify(tx.foreign_amounts) : '',
      tx.split_group_id || '',
      tx.is_cash_adjustment ? 1 : 0,
      tx.member || '',
    ]
  );
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
}

export function updateTransaction(db, id, tx) {
  // discount_note를 넘기지 않으면(undefined) 기존 메모를 그대로 둔다 — 금액만 고쳐도 메모가 지워지지 않게
  db.run(
    `UPDATE transactions
     SET payment_method=?, date=?, budget_category=?, sub_category=?,
         detail=?, amount=?, discount_amount=?, discount_note=COALESCE(?, discount_note),
         event_id=?, foreign_amounts=?, split_group_id=?,
         member=COALESCE(?, member),
         updated_at=datetime('now','localtime')
     WHERE id=?`,
    [
      tx.payment_method, tx.date, tx.budget_category,
      tx.sub_category || '', tx.detail || '',
      tx.amount, tx.discount_amount || 0, tx.discount_note === undefined ? null : (tx.discount_note || ''),
      tx.event_id || null,
      tx.foreign_amounts && Object.keys(tx.foreign_amounts).length ? JSON.stringify(tx.foreign_amounts) : '',
      tx.split_group_id || '',
      // '누가'는 넘긴 경우에만 바꾼다 — 카드 대조처럼 금액만 고치는 곳이 구성원을 지우지 않게 (I-013)
      tx.member === undefined ? null : (tx.member || ''),
      id,
    ]
  );
}

export function deleteTransaction(db, id) {
  withTransaction(db, () => {
    db.run('DELETE FROM transactions WHERE id = ?', [id]);
    // 여행 정산(I-030)의 이 거래 나눔 설정도 지운다 — 남아도 쓰이지는 않지만 일정 삭제 확인창 수에 섞이지 않게
    db.run('DELETE FROM trip_split_entries WHERE transaction_id = ?', [id]);
  });
}

// ── 삭제 되돌리기 (ROADMAP U-3) ─────────────────────────────────

/** 행 하나를 새로 넣는다(id 없이 — 새 번호). 칸 이름은 테이블의 칸 목록(columnsOf)으로만 고른다(AGENTS §2.9). 넣은 행의 id */
function reinsert(db, table, row, overrides = {}) {
  const allowed = columnsOf(db, table);
  const data = { ...row, ...overrides };
  const cols = Object.keys(data).filter(c => c !== 'id' && allowed.has(c));
  db.run(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map(c => data[c] ?? null),
  );
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
}

/**
 * 거래를 지우고 되돌리기에 쓸 기록을 돌려준다 — 하나의 트랜잭션 (U-3).
 * 지우는 것은 deleteTransaction과 같다(거래 + 여행 정산의 나눔 설정). 기록에는 지운 행 그대로와,
 * 그 거래를 가리키던 것(지워도 그대로 남는 번호) — 재환전 기록(event_cash_flows.linked_tx_id),
 * 정기지출 등록 기록(recurring_registration_log.transaction_id — 연간 결제 달을 옮길 때 이 번호로 찾는다, I-037)을 담는다.
 * 거래 번호를 담는 칸을 새로 만들면 여기와 restoreDeletedTransactions에 함께 더한다(AGENTS §3).
 * 반환: { transactions: [행], splitEntries: [행], cashFlowLinks: [{ flowId, txId }], registrationLinks: [{ logId, txId }] }
 */
export function deleteTransactionsForUndo(db, ids) {
  const list = [...new Set(ids.map(Number))];
  const marks = list.map(() => '?').join(', ');
  const undo = {
    transactions: dbRowsToObjects(db.exec(`SELECT * FROM transactions WHERE id IN (${marks}) ORDER BY id`, list)),
    splitEntries: dbRowsToObjects(db.exec(`SELECT * FROM trip_split_entries WHERE transaction_id IN (${marks}) ORDER BY id`, list)),
    cashFlowLinks: dbRowsToObjects(db.exec(`SELECT id, linked_tx_id FROM event_cash_flows WHERE linked_tx_id IN (${marks})`, list))
      .map(r => ({ flowId: r.id, txId: r.linked_tx_id })),
    registrationLinks: dbRowsToObjects(db.exec(`SELECT id, transaction_id FROM recurring_registration_log WHERE transaction_id IN (${marks})`, list))
      .map(r => ({ logId: r.id, txId: r.transaction_id })),
  };
  withTransaction(db, () => list.forEach(id => deleteTransaction(db, id)));
  return undo;
}

/**
 * 지운 거래를 되살린다 — 하나의 트랜잭션 (U-3). 새 번호로 넣고(다른 기기와 합칠 때 번호가 겹치지 않게 —
 * 변경 기록이 새 행의 번호를 맞춘다), 여행 정산 나눔 설정·재환전 기록·정기지출 등록 기록의 연결을 새 번호로 이어 준다.
 * 지운 때와 같은 가계부(DB 객체)에만 써야 한다 — 기록의 번호는 그 가계부의 것이다(App이 다시 불러왔으면 막는다).
 * 분할 결제 몫은 같은 묶음(split_group_id)으로 돌아온다.
 * 그사이 그 재환전 기록이 다른 거래를 가리키게 됐으면(또는 지워졌으면) 연결은 건드리지 않는다.
 * 반환: 되살린 거래 수
 */
export function restoreDeletedTransactions(db, undo) {
  if (!undo?.transactions?.length) return 0;
  withTransaction(db, () => {
    const newId = new Map();
    undo.transactions.forEach(row => newId.set(row.id, reinsert(db, 'transactions', row)));
    undo.splitEntries.forEach(row => reinsert(db, 'trip_split_entries', row, { transaction_id: newId.get(row.transaction_id) }));
    undo.cashFlowLinks.forEach(({ flowId, txId }) => {
      if (!newId.has(txId)) return;
      db.run('UPDATE event_cash_flows SET linked_tx_id = ? WHERE id = ? AND linked_tx_id = ?', [newId.get(txId), flowId, txId]);
    });
    (undo.registrationLinks || []).forEach(({ logId, txId }) => {
      if (!newId.has(txId)) return;
      db.run('UPDATE recurring_registration_log SET transaction_id = ? WHERE id = ? AND transaction_id = ?', [newId.get(txId), logId, txId]);
    });
  });
  return undo.transactions.length;
}

// 바로 넣은 거래를 알아보는 칸 — 되돌릴 때 이 값이 모두 같아야 지운다
const SNAPSHOT_FIELDS = ['date', 'amount', 'detail', 'payment_method', 'budget_category', 'sub_category'];

/** 방금 넣은 거래의 모습 — removeAddedTransactions로 되돌릴 때 쓴다 (I-022) */
export function addedSnapshot(id, tx) {
  const snap = { id };
  SNAPSHOT_FIELDS.forEach(k => { snap[k] = k === 'amount' ? Number(tx[k]) : String(tx[k] ?? ''); });
  return snap;
}

const sameAsSnapshot = (row, snap) => SNAPSHOT_FIELDS.every(k => (
  k === 'amount' ? Number(row[k]) === snap[k] : String(row[k] ?? '') === snap[k]
));

/**
 * AI 입력이 바로 넣은 거래를 되돌린다(지운다) — 하나의 트랜잭션.
 * 그 사이 다른 기기의 변경이 합쳐지면 새 행의 id가 바뀔 수 있어(변경 기록 병합) id만 믿지 않는다:
 * 그 id의 행이 넣을 때와 같으면 지우고, 아니면 같은 모습의 행이 딱 하나일 때만 지운다. 이미 고쳤거나 지운 것은 그대로 둔다.
 * 반환: 지운 개수
 */
export function removeAddedTransactions(db, snapshots) {
  let removed = 0;
  const taken = new Set();
  withTransaction(db, () => {
    snapshots.forEach(snap => {
      const byId = dbRowsToObjects(db.exec('SELECT * FROM transactions WHERE id = ?', [snap.id]))[0];
      let target = byId && !taken.has(byId.id) && sameAsSnapshot(byId, snap) ? byId : null;
      if (!target) {
        const same = dbRowsToObjects(db.exec(
          'SELECT * FROM transactions WHERE date = ? AND amount = ? AND payment_method = ?',
          [snap.date, snap.amount, snap.payment_method],
        )).filter(row => !taken.has(row.id) && sameAsSnapshot(row, snap));
        if (same.length === 1) [target] = same;
      }
      if (!target) return;
      taken.add(target.id);
      deleteTransaction(db, target.id);
      removed += 1;
    });
  });
  return removed;
}

/** 분할 결제로 묶인 거래들 (id 순) */
export function getSplitGroupTransactions(db, groupId) {
  if (!db || !groupId) return [];
  return dbRowsToObjects(
    db.exec('SELECT * FROM transactions WHERE split_group_id = ? ORDER BY id', [groupId])
  );
}
