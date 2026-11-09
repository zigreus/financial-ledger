// 가계부 거래(transactions) 조회·추가·수정·삭제와 분할 결제 묶음 조회.

import { dbRowsToObjects, withTransaction } from './common';

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
