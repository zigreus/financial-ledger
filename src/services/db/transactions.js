// 가계부 거래(transactions) 조회·추가·수정·삭제와 분할 결제 묶음 조회.

import { dbRowsToObjects } from './common';

// ── 거래 내역 ─────────────────────────────────────────────────

export function getTransactions(db, filters = {}) {
  let query = 'SELECT * FROM transactions WHERE 1=1';
  const params = [];

  if (filters.month) {
    query += " AND strftime('%Y-%m', date) = ?";
    params.push(filters.month);
  }
  if (filters.payment_method) {
    query += ' AND payment_method = ?';
    params.push(filters.payment_method);
  }
  if (filters.budget_category) {
    query += ' AND budget_category = ?';
    params.push(filters.budget_category);
  }
  if (filters.dateFrom) {
    query += ' AND date >= ?';
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    query += ' AND date <= ?';
    params.push(filters.dateTo);
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
       (payment_method, date, budget_category, sub_category, detail, amount, discount_amount, discount_note, event_id, foreign_amounts, split_group_id, is_cash_adjustment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tx.payment_method, tx.date, tx.budget_category,
      tx.sub_category || '', tx.detail || '',
      tx.amount, tx.discount_amount || 0, tx.discount_note || '',
      tx.event_id || null,
      tx.foreign_amounts && Object.keys(tx.foreign_amounts).length ? JSON.stringify(tx.foreign_amounts) : '',
      tx.split_group_id || '',
      tx.is_cash_adjustment ? 1 : 0,
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
         updated_at=datetime('now','localtime')
     WHERE id=?`,
    [
      tx.payment_method, tx.date, tx.budget_category,
      tx.sub_category || '', tx.detail || '',
      tx.amount, tx.discount_amount || 0, tx.discount_note === undefined ? null : (tx.discount_note || ''),
      tx.event_id || null,
      tx.foreign_amounts && Object.keys(tx.foreign_amounts).length ? JSON.stringify(tx.foreign_amounts) : '',
      tx.split_group_id || '',
      id,
    ]
  );
}

export function deleteTransaction(db, id) {
  db.run('DELETE FROM transactions WHERE id = ?', [id]);
}

/** 분할 결제로 묶인 거래들 (id 순) */
export function getSplitGroupTransactions(db, groupId) {
  if (!db || !groupId) return [];
  return dbRowsToObjects(
    db.exec('SELECT * FROM transactions WHERE split_group_id = ? ORDER BY id', [groupId])
  );
}
