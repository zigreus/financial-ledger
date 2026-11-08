// 가계부 거래(transactions) 조회·추가·수정·삭제와 분할 결제 묶음 조회.

import { dbRowsToObjects } from './common';

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
  db.run('DELETE FROM transactions WHERE id = ?', [id]);
}

/** 분할 결제로 묶인 거래들 (id 순) */
export function getSplitGroupTransactions(db, groupId) {
  if (!db || !groupId) return [];
  return dbRowsToObjects(
    db.exec('SELECT * FROM transactions WHERE split_group_id = ? ORDER BY id', [groupId])
  );
}
