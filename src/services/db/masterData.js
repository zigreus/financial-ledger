// 결제수단·카테고리·세부카테고리 — 목록, 정렬·숨김, 이름 변경·삭제(참조 정리), 사용처 집계,
// 가져오기용 일괄 생성.

import { withTransaction } from './common';
import { addTransaction } from './transactions';

// ── 마스터 데이터 ──────────────────────────────────────────────

export function getPaymentMethods(db) {
  const result = db.exec('SELECT name FROM payment_methods WHERE is_hidden = 0 ORDER BY sort_order, name');
  return result.length ? result[0].values.map(r => r[0]) : [];
}

export function getBudgetCategories(db) {
  const result = db.exec('SELECT name FROM budget_categories WHERE is_hidden = 0 ORDER BY sort_order, name');
  return result.length ? result[0].values.map(r => r[0]) : [];
}

export function getSubCategories(db, budgetCategory) {
  if (!budgetCategory) return [];
  const result = db.exec(
    'SELECT name FROM sub_categories WHERE budget_category = ? AND is_hidden = 0 ORDER BY sort_order, name',
    [budgetCategory]
  );
  return result.length ? result[0].values.map(r => r[0]) : [];
}

// ── 마스터 데이터 편집 (설정용) ──────────────────────────

export function getAllPaymentMethods(db) {
  const result = db.exec('SELECT id, name, sort_order, is_hidden, discount_rate FROM payment_methods ORDER BY sort_order, name');
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getAllBudgetCategories(db) {
  const result = db.exec('SELECT id, name, sort_order, is_hidden, color FROM budget_categories ORDER BY sort_order, name');
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getAllSubCategories(db, budgetCategory = null) {
  if (budgetCategory) {
    const result = db.exec(
      'SELECT id, budget_category, name, sort_order, is_hidden FROM sub_categories WHERE budget_category = ? ORDER BY sort_order, name',
      [budgetCategory]
    );
    if (!result.length) return [];
    const { columns, values } = result[0];
    return values.map(row => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  } else {
    const result = db.exec('SELECT id, budget_category, name, sort_order, is_hidden FROM sub_categories ORDER BY budget_category, sort_order, name');
    if (!result.length) return [];
    const { columns, values } = result[0];
    return values.map(row => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  }
}

export function reorderMasterItem(db, table, id, direction) {
  const allowed = ['payment_methods', 'budget_categories', 'sub_categories'];
  if (!allowed.includes(table)) throw new Error('Invalid table name');

  // 현재 아이템의 sort_order (sub_categories는 budget_category도 필요)
  let currRes;
  if (table === 'sub_categories') {
    currRes = db.exec('SELECT sort_order, budget_category FROM sub_categories WHERE id = ?', [id]);
  } else {
    currRes = db.exec(`SELECT sort_order FROM ${table} WHERE id = ?`, [id]);
  }
  if (!currRes.length || !currRes[0].values.length) return;

  const currentOrder = currRes[0].values[0][0];
  const budgetCat = table === 'sub_categories' ? currRes[0].values[0][1] : null;

  // 인접 아이템 찾기
  let neighborRes;
  if (table === 'sub_categories') {
    neighborRes = direction === 'up'
      ? db.exec('SELECT id, sort_order FROM sub_categories WHERE sort_order < ? AND budget_category = ? ORDER BY sort_order DESC LIMIT 1', [currentOrder, budgetCat])
      : db.exec('SELECT id, sort_order FROM sub_categories WHERE sort_order > ? AND budget_category = ? ORDER BY sort_order ASC LIMIT 1', [currentOrder, budgetCat]);
  } else {
    neighborRes = direction === 'up'
      ? db.exec(`SELECT id, sort_order FROM ${table} WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1`, [currentOrder])
      : db.exec(`SELECT id, sort_order FROM ${table} WHERE sort_order > ? ORDER BY sort_order ASC LIMIT 1`, [currentOrder]);
  }
  if (!neighborRes.length || !neighborRes[0].values.length) return;

  const [neighborId, neighborOrder] = neighborRes[0].values[0];
  db.run(`UPDATE ${table} SET sort_order = ? WHERE id = ?`, [neighborOrder, id]);
  db.run(`UPDATE ${table} SET sort_order = ? WHERE id = ?`, [currentOrder, neighborId]);
}

/**
 * 항목을 같은 그룹(표시/숨김) 안의 newIndex 위치로 옮긴다.
 * newIndex는 옮기는 항목을 뺀 그룹 목록 기준이다.
 * 표시 → 숨김 순으로 전체를 1..n으로 다시 번호 매겨, 두 그룹의 sort_order가 겹치지 않게 한다 (B-027).
 * 정렬 기준(is_hidden, sort_order, name, id)은 설정 화면의 표시 순서와 같다.
 * sub_categories는 그 항목이 속한 대분류 안에서만 움직인다.
 */
export function moveItemToPosition(db, table, id, newIndex) {
  const allowed = ['payment_methods', 'budget_categories', 'sub_categories'];
  if (!allowed.includes(table)) throw new Error('Invalid table name');

  const isSub = table === 'sub_categories';
  const rowRes = db.exec(
    `SELECT is_hidden${isSub ? ', budget_category' : ''} FROM ${table} WHERE id = ?`,
    [id]
  );
  const row = rowRes[0]?.values[0];
  if (!row) return;
  const isHidden = row[0] ? 1 : 0;

  const itemsRes = isSub
    ? db.exec(
      `SELECT id, COALESCE(is_hidden, 0) FROM sub_categories WHERE budget_category = ?
       ORDER BY COALESCE(is_hidden, 0), sort_order, name, id`,
      [row[1]]
    )
    : db.exec(`SELECT id, COALESCE(is_hidden, 0) FROM ${table} ORDER BY COALESCE(is_hidden, 0), sort_order, name, id`);
  const items = itemsRes[0]?.values || [];

  const group = items.filter(([itemId, h]) => (h ? 1 : 0) === isHidden && itemId !== id).map(([itemId]) => itemId);
  const others = items.filter(([, h]) => (h ? 1 : 0) !== isHidden).map(([itemId]) => itemId);
  const clamped = Math.max(0, Math.min(newIndex, group.length));
  group.splice(clamped, 0, id);
  const ordered = isHidden ? [...others, ...group] : [...group, ...others];

  withTransaction(db, () => {
    ordered.forEach((itemId, i) => {
      db.run(`UPDATE ${table} SET sort_order = ? WHERE id = ?`, [i + 1, itemId]);
    });
  });
}

export function setMasterItemHidden(db, table, id, isHidden) {
  const allowed = ['payment_methods', 'budget_categories', 'sub_categories'];
  if (!allowed.includes(table)) throw new Error('Invalid table name');
  db.run(`UPDATE ${table} SET is_hidden = ? WHERE id = ?`, [isHidden ? 1 : 0, id]);
}

export function addPaymentMethod(db, name) {
  if (!name || !name.trim()) throw new Error('Name is required');
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) as max FROM payment_methods');
  const nextSort = (maxSort[0]?.values[0][0] || 0) + 1;
  db.run('INSERT INTO payment_methods (name, sort_order, is_hidden) VALUES (?, ?, 0)', [name.trim(), nextSort]);
}

export function addBudgetCategory(db, name) {
  if (!name || !name.trim()) throw new Error('Name is required');
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) as max FROM budget_categories');
  const nextSort = (maxSort[0]?.values[0][0] || 0) + 1;
  db.run('INSERT INTO budget_categories (name, sort_order, is_hidden) VALUES (?, ?, 0)', [name.trim(), nextSort]);
}

export function addSubCategory(db, budgetCategory, name) {
  if (!budgetCategory || !name || !name.trim()) throw new Error('Both category and name are required');
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) as max FROM sub_categories WHERE budget_category = ?', [budgetCategory]);
  const nextSort = (maxSort[0]?.values[0][0] || 0) + 1;
  db.run('INSERT INTO sub_categories (budget_category, name, sort_order, is_hidden) VALUES (?, ?, ?, 0)', [budgetCategory, name.trim(), nextSort]);
}

// 카테고리·세부카테고리를 이름으로 참조하는 테이블 (이름 변경·삭제 시 함께 고친다)
const CATEGORY_REF_TABLES = ['transactions', 'recurring_transactions', 'favorite_transactions', 'payment_method_discount_rules'];

function countRows(db, sql, params) {
  return Number(db.exec(sql, params)[0]?.values[0][0]) || 0;
}

/** 세부카테고리 이름이 다른 대분류에도 있으면 true (auto_pattern_settings는 세부카테고리 이름만 키로 쓴다) */
function subCategoryNameUsedElsewhere(db, budgetCategory, name) {
  return countRows(db, 'SELECT COUNT(*) FROM sub_categories WHERE name = ? AND budget_category != ?', [name, budgetCategory]) > 0;
}

/**
 * 대분류 이름 변경 — 거래·정기지출·즐겨찾기·할인규칙·여행 기본 카테고리 설정까지 한 번에 바꾼다 (B-019).
 */
export function renameBudgetCategory(db, oldName, newName) {
  if (!newName || !newName.trim()) throw new Error('이름을 입력하세요.');
  const trimmed = newName.trim();
  if (trimmed === oldName) return;
  if (countRows(db, 'SELECT COUNT(*) FROM budget_categories WHERE name = ?', [trimmed]) > 0) {
    throw new Error('이미 같은 이름의 카테고리가 있습니다.');
  }
  withTransaction(db, () => {
    db.run('UPDATE budget_categories SET name = ? WHERE name = ?', [trimmed, oldName]);
    db.run('UPDATE sub_categories SET budget_category = ? WHERE budget_category = ?', [trimmed, oldName]);
    CATEGORY_REF_TABLES.forEach(table => {
      db.run(`UPDATE ${table} SET budget_category = ? WHERE budget_category = ?`, [trimmed, oldName]);
    });
    db.run("UPDATE settings SET value = ? WHERE key = 'trip_default_category' AND value = ?", [trimmed, oldName]);
  });
}

/**
 * 세부카테고리 이름 변경 — 거래·정기지출·즐겨찾기·할인규칙·자동 결제수단 패턴까지 바꾼다 (B-019).
 */
export function renameSubCategory(db, budgetCategory, oldName, newName) {
  if (!newName || !newName.trim()) throw new Error('이름을 입력하세요.');
  const trimmed = newName.trim();
  if (trimmed === oldName) return;
  if (countRows(db, 'SELECT COUNT(*) FROM sub_categories WHERE budget_category = ? AND name = ?', [budgetCategory, trimmed]) > 0) {
    throw new Error('이미 같은 이름의 세부카테고리가 있습니다.');
  }
  withTransaction(db, () => {
    db.run('UPDATE sub_categories SET name = ? WHERE budget_category = ? AND name = ?', [trimmed, budgetCategory, oldName]);
    CATEGORY_REF_TABLES.forEach(table => {
      db.run(
        `UPDATE ${table} SET sub_category = ? WHERE budget_category = ? AND sub_category = ?`,
        [trimmed, budgetCategory, oldName]
      );
    });
    // 같은 이름의 세부카테고리가 다른 대분류에 없을 때만 패턴 설정을 새 이름으로 옮긴다
    if (!subCategoryNameUsedElsewhere(db, budgetCategory, oldName)) {
      db.run(
        `INSERT OR IGNORE INTO auto_pattern_settings (sub_category, is_disabled)
         SELECT ?, is_disabled FROM auto_pattern_settings WHERE sub_category = ?`,
        [trimmed, oldName]
      );
      db.run('DELETE FROM auto_pattern_settings WHERE sub_category = ?', [oldName]);
    }
  });
}

/** 세부카테고리를 쓰는 곳별 건수 { transactions, recurring, favorites, discountRules } */
export function getSubCategoryUsage(db, budgetCategory, name) {
  const count = (table) => countRows(
    db, `SELECT COUNT(*) FROM ${table} WHERE budget_category = ? AND sub_category = ?`, [budgetCategory, name]
  );
  return {
    transactions: count('transactions'),
    recurring: count('recurring_transactions'),
    favorites: count('favorite_transactions'),
    discountRules: count('payment_method_discount_rules'),
  };
}

/**
 * 세부카테고리 삭제 (B-020).
 * 거래·정기지출·즐겨찾기의 세부카테고리는 비우고(거래는 이슈 필터에 잡힌다),
 * 이 세부카테고리 전용 할인규칙은 더 이상 맞는 거래가 없으므로 지운다.
 */
export function deleteSubCategory(db, budgetCategory, name) {
  withTransaction(db, () => {
    db.run('DELETE FROM sub_categories WHERE budget_category = ? AND name = ?', [budgetCategory, name]);
    ['transactions', 'recurring_transactions', 'favorite_transactions'].forEach(table => {
      db.run(
        `UPDATE ${table} SET sub_category = '' WHERE budget_category = ? AND sub_category = ?`,
        [budgetCategory, name]
      );
    });
    db.run(
      'DELETE FROM payment_method_discount_rules WHERE budget_category = ? AND sub_category = ?',
      [budgetCategory, name]
    );
    if (!subCategoryNameUsedElsewhere(db, budgetCategory, name)) {
      db.run('DELETE FROM auto_pattern_settings WHERE sub_category = ?', [name]);
    }
  });
}

/** 대분류를 쓰는 곳별 건수 { transactions, recurring, favorites, discountRules } */
export function getBudgetCategoryUsage(db, name) {
  const count = (table) => countRows(db, `SELECT COUNT(*) FROM ${table} WHERE budget_category = ?`, [name]);
  return {
    transactions: count('transactions'),
    recurring: count('recurring_transactions'),
    favorites: count('favorite_transactions'),
    discountRules: count('payment_method_discount_rules'),
  };
}

/**
 * 대분류 삭제 (B-020) — 어디에서도 쓰지 않을 때만 지운다.
 * 사용 중이면 이름 변경이나 숨기기를 쓰도록 오류를 낸다.
 */
export function deleteBudgetCategory(db, name) {
  const usage = getBudgetCategoryUsage(db, name);
  if (Object.values(usage).some(n => n > 0)) {
    throw new Error(`"${name}"은(는) 사용 중이라 삭제할 수 없습니다. 이름을 바꾸거나 숨기기를 사용하세요.`);
  }
  withTransaction(db, () => {
    db.run('DELETE FROM sub_categories WHERE budget_category = ?', [name]);
    db.run('DELETE FROM budget_categories WHERE name = ?', [name]);
    db.run("UPDATE settings SET value = '' WHERE key = 'trip_default_category' AND value = ?", [name]);
  });
}

export function ensurePaymentMethodsExist(db, txList) {
  // 트랜잭션 목록에서 사용된 결제수단들을 자동으로 추가
  const paymentMethods = new Set(txList.map(tx => tx.payment_method).filter(Boolean));
  const existingResult = db.exec('SELECT name FROM payment_methods');
  const existingMethods = new Set(existingResult[0]?.values.map(r => r[0]) || []);

  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) as max FROM payment_methods');
  let nextSort = (maxSort[0]?.values[0][0] || 0) + 1;

  paymentMethods.forEach(method => {
    if (!existingMethods.has(method)) {
      db.run('INSERT INTO payment_methods (name, sort_order, is_hidden) VALUES (?, ?, 0)', [method, nextSort]);
      nextSort++;
    }
  });
}

// 호출부의 withTransaction 안에서도 쓸 수 있도록 SAVEPOINT(withTransaction)로 묶는다
export function bulkInsertTransactions(db, txList) {
  withTransaction(db, () => {
    ensurePaymentMethodsExist(db, txList);
    txList.forEach(tx => addTransaction(db, tx));
  });
}

export function ensureCategoriesExist(db, categoryNames) {
  const existing = new Set(
    (db.exec('SELECT name FROM budget_categories')[0]?.values || []).map(r => r[0])
  );
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) FROM budget_categories')[0]?.values[0][0] || 0;
  let nextSort = maxSort + 1;
  categoryNames.forEach(name => {
    if (!existing.has(name)) {
      db.run('INSERT INTO budget_categories (name, sort_order) VALUES (?, ?)', [name, nextSort++]);
      existing.add(name);
    }
  });
}

export function ensureSubCategoriesExist(db, subcats) {
  // subcats: [{budget_category, name}]
  subcats.forEach(({ budget_category, name }) => {
    const maxSort = db.exec(
      'SELECT COALESCE(MAX(sort_order), 0) FROM sub_categories WHERE budget_category = ?',
      [budget_category]
    )[0]?.values[0][0] || 0;
    db.run(
      'INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)',
      [budget_category, name, maxSort + 1]
    );
  });
}

/**
 * 결제수단을 쓰는 곳별 건수 (B-021)
 * { transactions, discountRules, recurring, favorites, accountItems }
 * accountItems: 계좌 고정항목의 '카드 자동 집계' 결제수단 (삭제된 항목 제외)
 */
export function getPaymentMethodUsage(db, name) {
  return {
    transactions: countRows(db, 'SELECT COUNT(*) FROM transactions WHERE payment_method = ?', [name]),
    discountRules: countRows(db, 'SELECT COUNT(*) FROM payment_method_discount_rules WHERE payment_method_name = ?', [name]),
    recurring: countRows(db, 'SELECT COUNT(*) FROM recurring_transactions WHERE payment_method = ?', [name]),
    favorites: countRows(db, 'SELECT COUNT(*) FROM favorite_transactions WHERE payment_method = ?', [name]),
    accountItems: countRows(
      db,
      'SELECT COUNT(*) FROM account_recurring_items WHERE auto_payment_method = ? AND COALESCE(is_active, 1) = 1',
      [name]
    ),
  };
}

/**
 * 결제수단 삭제 (B-021) — 숨기기와 분리했다. 어디에서도 쓰지 않을 때만 지운다.
 */
export function deletePaymentMethod(db, id) {
  const name = db.exec('SELECT name FROM payment_methods WHERE id = ?', [id])[0]?.values[0]?.[0];
  if (name === undefined) return;
  const usage = getPaymentMethodUsage(db, name);
  if (Object.values(usage).some(n => n > 0)) {
    throw new Error(`"${name}"은(는) 사용 중이라 삭제할 수 없습니다. 숨기기를 사용하세요.`);
  }
  db.run('DELETE FROM payment_methods WHERE id = ?', [id]);
}
