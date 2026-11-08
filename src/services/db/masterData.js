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

// ── 첫 실행 기본값 (ROADMAP F-3, I-019) ─────────────────────────

export const STARTER_NAME_MAX = 20;

// 새 가계부의 조건 — 카테고리·세부카테고리·결제수단·거래가 하나도 없다(숨긴 것도 있는 것으로 본다)
const BLANK_TABLES = ['budget_categories', 'sub_categories', 'payment_methods', 'transactions'];
const BLANK_SQL = BLANK_TABLES.map(table => `NOT EXISTS (SELECT 1 FROM ${table})`).join(' AND ');
const STARTER_MARK = 'starter_setup_pending'; // 첫 실행 기본값을 넣는 동안만 있는 표식 (settings)

/** 아직 아무것도 없는 새 가계부인지 — 카테고리·세부카테고리·결제수단·거래가 하나도 없다(숨긴 것도 있는 것으로 본다) */
export function isBlankLedger(db) {
  return BLANK_TABLES.every(table => countRows(db, `SELECT COUNT(*) FROM ${table}`) === 0);
}

const cleanName = (name) => String(name ?? '').trim();
const uniqueNames = (names) => [...new Set(names.map(cleanName).filter(Boolean))];

/**
 * 첫 실행 안내에서 고른 것을 넣을 수 없는 이유(화면에 그대로 보인다). 없으면 [].
 * setup: { categories: [{ name, subs: [이름] }], paymentMethods: [이름] }
 */
export function starterSetupProblems(setup) {
  const categories = (setup?.categories || []).filter(c => cleanName(c?.name));
  const paymentMethods = uniqueNames(setup?.paymentMethods || []);
  const problems = [];
  if (!categories.length) problems.push('카테고리를 하나 이상 고르세요');
  const noSubs = categories.find(c => !uniqueNames(c.subs || []).length);
  if (noSubs) problems.push(`'${cleanName(noSubs.name)}'의 세부카테고리를 하나 이상 남겨 주세요 — 거래를 입력할 때 세부카테고리를 고릅니다`);
  if (!paymentMethods.length) problems.push('결제수단을 하나 이상 고르세요');
  const names = [
    ...categories.map(c => c.name), ...categories.flatMap(c => c.subs || []), ...paymentMethods,
  ].map(cleanName);
  const tooLong = names.find(n => n.length > STARTER_NAME_MAX);
  if (tooLong) problems.push(`이름은 ${STARTER_NAME_MAX}자까지 쓸 수 있습니다: ${tooLong}`);
  return problems;
}

/**
 * 첫 실행 안내에서 고른 카테고리·세부카테고리·결제수단을 한 번에 넣는다(사용자가 확정할 때만 부른다, §2-3).
 * 새 가계부(isBlankLedger)에만 넣는다 — 이미 쓰던 가계부에는 넣지 않는다(마이그레이션이 아님).
 * 이름은 앞뒤 공백을 지우고, 같은 이름은 한 번만 넣으며, 고른 순서대로 정렬 순서를 매긴다.
 *
 * 비어 있는지는 SQL 문장 안에서도 다시 본다. 이 쓰기는 변경 기록에 남아, 다른 기기와 저장이 겹치면 최신 파일에
 * 그대로 다시 실행된다(두 기기가 동시에 시작했거나, 오프라인에서 확정해 두었다가 나중에 저장할 때). 그때 그 파일이
 * 이미 꾸며져 있으면 아무것도 넣지 않는다 — 먼저 저장한 쪽 하나만 남는다.
 *  1) 파일이 비어 있을 때만 이번 실행의 표식(token)을 settings에 남기고  2) 표식이 있을 때만 넣고  3) 표식을 지운다
 * 반환: { categories, subCategories, paymentMethods } — 넣은 개수
 */
export function applyStarterSetup(db, setup) {
  const problems = starterSetupProblems(setup);
  if (problems.length) throw new Error(problems[0]);
  if (!isBlankLedger(db)) throw new Error('이미 카테고리·결제수단이나 거래가 있는 가계부입니다 — 설정에서 고치세요');

  const seen = new Set();
  const categories = setup.categories
    .map(c => ({ name: cleanName(c.name), subs: uniqueNames(c.subs || []) }))
    .filter(c => c.name && !seen.has(c.name) && seen.add(c.name));
  const paymentMethods = uniqueNames(setup.paymentMethods);
  const token = `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const marked = `EXISTS (SELECT 1 FROM settings WHERE key = '${STARTER_MARK}' AND value = ?)`;

  withTransaction(db, () => {
    db.run(`INSERT OR REPLACE INTO settings (key, value) SELECT '${STARTER_MARK}', ? WHERE ${BLANK_SQL}`, [token]);
    categories.forEach((c, i) => {
      db.run(`INSERT INTO budget_categories (name, sort_order, is_hidden) SELECT ?, ?, 0 WHERE ${marked}`, [c.name, i + 1, token]);
      c.subs.forEach((sub, j) => {
        db.run(
          `INSERT INTO sub_categories (budget_category, name, sort_order, is_hidden) SELECT ?, ?, ?, 0 WHERE ${marked}`,
          [c.name, sub, j + 1, token]
        );
      });
    });
    paymentMethods.forEach((name, i) => {
      db.run(`INSERT INTO payment_methods (name, sort_order, is_hidden) SELECT ?, ?, 0 WHERE ${marked}`, [name, i + 1, token]);
    });
    db.run(`DELETE FROM settings WHERE key = '${STARTER_MARK}' AND value = ?`, [token]);
  });
  return {
    categories: categories.length,
    subCategories: categories.reduce((n, c) => n + c.subs.length, 0),
    paymentMethods: paymentMethods.length,
  };
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
 * 대분류 이름 변경 — 거래·정기지출·즐겨찾기·할인규칙·여행 기본 카테고리 설정·카테고리 예산까지 한 번에 바꾼다 (B-019, I-025).
 */
export function renameBudgetCategory(db, oldName, newName) {
  if (!newName || !newName.trim()) throw new Error('이름을 입력하세요.');
  const trimmed = newName.trim();
  if (trimmed === oldName) return;
  if (countRows(db, 'SELECT COUNT(*) FROM budget_categories WHERE name = ?', [trimmed]) > 0) {
    throw new Error('이미 같은 이름의 카테고리가 있습니다.');
  }
  withTransaction(db, () => {
    // 카테고리 예산 (I-025) — 새 이름의 카테고리가 없으면 그 이름으로 남은 예산은 목록에 없는 카테고리의 것이다.
    // 먼저 지워야 키가 겹치지 않고 옛 예산을 엉뚱하게 넘겨받지 않는다. 이름을 바꾸기 전에, 그 이름의 카테고리가 없을 때만 지운다 —
    // 병합으로 다시 실행될 때 다른 기기가 그 사이 만든 같은 이름 카테고리의 예산을 지우지 않게
    db.run(
      'DELETE FROM category_budgets WHERE budget_category = ? AND NOT EXISTS (SELECT 1 FROM budget_categories WHERE name = ?)',
      [trimmed, trimmed],
    );
    db.run('UPDATE budget_categories SET name = ? WHERE name = ?', [trimmed, oldName]);
    db.run('UPDATE sub_categories SET budget_category = ? WHERE budget_category = ?', [trimmed, oldName]);
    CATEGORY_REF_TABLES.forEach(table => {
      db.run(`UPDATE ${table} SET budget_category = ? WHERE budget_category = ?`, [trimmed, oldName]);
    });
    db.run("UPDATE settings SET value = ? WHERE key = 'trip_default_category' AND value = ?", [trimmed, oldName]);
    db.run('UPDATE OR IGNORE category_budgets SET budget_category = ? WHERE budget_category = ?', [trimmed, oldName]);
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
    // 그 카테고리의 예산도 지운다 (I-025) — 쓰는 거래가 없어야 지울 수 있으니 비교할 지출도 없다
    db.run('DELETE FROM category_budgets WHERE budget_category = ?', [name]);
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
