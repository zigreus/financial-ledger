import initSqlJs from 'sql.js';

let SQL = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_method TEXT NOT NULL,
  date TEXT NOT NULL,
  budget_category TEXT NOT NULL,
  sub_category TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  amount INTEGER NOT NULL,
  discount_amount INTEGER DEFAULT 0,
  discount_note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budget_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0,
  color TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sub_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  budget_category TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(budget_category, name)
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0,
  is_hidden INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trip_countries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id INTEGER NOT NULL,
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payment_method_discount_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_method_name TEXT NOT NULL,
  budget_category TEXT DEFAULT '',
  sub_category TEXT DEFAULT '',
  detail_keyword TEXT DEFAULT '',
  rule_type TEXT NOT NULL DEFAULT 'percent',
  value REAL NOT NULL DEFAULT 0,
  min_amount INTEGER DEFAULT 0,
  note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS monthly_goals (
  year_month TEXT PRIMARY KEY,
  goal_amount INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recurring_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_method TEXT NOT NULL,
  budget_category TEXT NOT NULL,
  sub_category TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  amount INTEGER NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly',
  day_of_month INTEGER NOT NULL DEFAULT 1,
  month_of_year INTEGER,
  is_active INTEGER DEFAULT 1,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS recurring_registration_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recurring_id INTEGER NOT NULL,
  registered_for_month TEXT NOT NULL,
  transaction_id INTEGER,
  registered_at TEXT DEFAULT (datetime('now', 'localtime')),
  UNIQUE(recurring_id, registered_for_month)
);
`;


export async function initSQL() {
  if (!SQL) {
    SQL = await initSqlJs({
      locateFile: file => `https://unpkg.com/sql.js@1.12.0/dist/${file}`,
    });
  }
  return SQL;
}

export function createDatabase(SQL, existingData = null) {
  const db = existingData ? new SQL.Database(existingData) : new SQL.Database();
  db.run(SCHEMA);

  // 완료된 마이그레이션 코드는 dbMigrations.legacy.js 에 보존됨
  let didMigrate = false;

  // transactions 테이블에 정기지출 컬럼 추가 (기존 DB 호환)
  try { db.run('ALTER TABLE transactions ADD COLUMN is_recurring INTEGER DEFAULT 0'); didMigrate = true; } catch (e) {}
  try { db.run('ALTER TABLE transactions ADD COLUMN recurring_source_id INTEGER DEFAULT NULL'); didMigrate = true; } catch (e) {}
  // recurring_transactions 테이블에 할인 컬럼 추가 (기존 DB 호환)
  try { db.run('ALTER TABLE recurring_transactions ADD COLUMN discount_amount INTEGER DEFAULT 0'); didMigrate = true; } catch (e) {}
  try { db.run('ALTER TABLE recurring_transactions ADD COLUMN discount_note TEXT DEFAULT \'\''); didMigrate = true; } catch (e) {}
  // transactions 테이블에 정기지출 주기 컬럼 추가 (기존 DB 호환)
  try { db.run('ALTER TABLE transactions ADD COLUMN recurring_frequency TEXT DEFAULT NULL'); didMigrate = true; } catch (e) {}

  return { db, didMigrate };
}

export function exportDatabase(db) {
  return db.export();
}

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
       (payment_method, date, budget_category, sub_category, detail, amount, discount_amount, discount_note, trip_id, foreign_amounts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tx.payment_method, tx.date, tx.budget_category,
      tx.sub_category || '', tx.detail || '',
      tx.amount, tx.discount_amount || 0, tx.discount_note || '',
      tx.trip_id || null,
      tx.foreign_amounts && Object.keys(tx.foreign_amounts).length ? JSON.stringify(tx.foreign_amounts) : '',
    ]
  );
}

export function updateTransaction(db, id, tx) {
  db.run(
    `UPDATE transactions
     SET payment_method=?, date=?, budget_category=?, sub_category=?,
         detail=?, amount=?, discount_amount=?, discount_note=?,
         trip_id=?, foreign_amounts=?,
         updated_at=datetime('now','localtime')
     WHERE id=?`,
    [
      tx.payment_method, tx.date, tx.budget_category,
      tx.sub_category || '', tx.detail || '',
      tx.amount, tx.discount_amount || 0, tx.discount_note || '',
      tx.trip_id || null,
      tx.foreign_amounts && Object.keys(tx.foreign_amounts).length ? JSON.stringify(tx.foreign_amounts) : '',
      id,
    ]
  );
}

export function deleteTransaction(db, id) {
  db.run('DELETE FROM transactions WHERE id = ?', [id]);
}

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

// ── 요약 ───────────────────────────────────────────────────────

export function getAvailableMonths(db) {
  const result = db.exec(
    "SELECT DISTINCT strftime('%Y-%m', date) as month FROM transactions ORDER BY month DESC"
  );
  return result.length ? result[0].values.map(r => r[0]) : [];
}

export function getMonthlySummary(db, month) {
  const query = month
    ? `SELECT budget_category, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
       FROM transactions WHERE strftime('%Y-%m', date) = ?
       GROUP BY budget_category ORDER BY total DESC`
    : `SELECT budget_category, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
       FROM transactions GROUP BY budget_category ORDER BY total DESC`;

  const result = db.exec(query, month ? [month] : []);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getMonthlySubCategorySummary(db, month, budgetCategory) {
  const query = month
    ? `SELECT sub_category, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
       FROM transactions WHERE strftime('%Y-%m', date) = ? AND budget_category = ?
       GROUP BY sub_category ORDER BY total DESC`
    : `SELECT sub_category, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
       FROM transactions WHERE budget_category = ?
       GROUP BY sub_category ORDER BY total DESC`;
  const params = month ? [month, budgetCategory] : [budgetCategory];
  const result = db.exec(query, params);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getMonthlyTotals(db, limit = 24) {
  const query = limit
    ? `SELECT strftime('%Y-%m', date) as month,
              SUM(amount) as total,
              SUM(discount_amount) as discount,
              COUNT(*) as cnt
       FROM transactions
       GROUP BY month ORDER BY month DESC
       LIMIT ${limit}`
    : `SELECT strftime('%Y-%m', date) as month,
              SUM(amount) as total,
              SUM(discount_amount) as discount,
              COUNT(*) as cnt
       FROM transactions
       GROUP BY month ORDER BY month DESC`;
  const result = db.exec(query);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getPaymentMethodSummary(db, month) {
  const query = month
    ? `SELECT payment_method, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
       FROM transactions WHERE strftime('%Y-%m', date) = ?
       GROUP BY payment_method ORDER BY total DESC`
    : `SELECT payment_method, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
       FROM transactions GROUP BY payment_method ORDER BY total DESC`;

  const result = db.exec(query, month ? [month] : []);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getAvailableYears(db) {
  const result = db.exec(
    "SELECT DISTINCT strftime('%Y', date) as year FROM transactions ORDER BY year DESC"
  );
  return result.length ? result[0].values.map(r => r[0]) : [];
}

export function getYearlySummary(db, year) {
  const query = `SELECT budget_category, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
                 FROM transactions WHERE strftime('%Y', date) = ?
                 GROUP BY budget_category ORDER BY total DESC`;
  const result = db.exec(query, [year]);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getYearlySubCategorySummary(db, year, budgetCategory) {
  const query = `SELECT sub_category, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
                 FROM transactions WHERE strftime('%Y', date) = ? AND budget_category = ?
                 GROUP BY sub_category ORDER BY total DESC`;
  const result = db.exec(query, [year, budgetCategory]);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getYearlyPaymentMethodSummary(db, year) {
  const query = `SELECT payment_method, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
                 FROM transactions WHERE strftime('%Y', date) = ?
                 GROUP BY payment_method ORDER BY total DESC`;
  const result = db.exec(query, [year]);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getRangeSummary(db, dateFrom, dateTo) {
  const query = `SELECT budget_category, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
                 FROM transactions WHERE date >= ? AND date <= ?
                 GROUP BY budget_category ORDER BY total DESC`;
  const result = db.exec(query, [dateFrom, dateTo]);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getRangeSubCategorySummary(db, dateFrom, dateTo, budgetCategory) {
  const query = `SELECT sub_category, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
                 FROM transactions WHERE date >= ? AND date <= ? AND budget_category = ?
                 GROUP BY sub_category ORDER BY total DESC`;
  const result = db.exec(query, [dateFrom, dateTo, budgetCategory]);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getRangePaymentMethodSummary(db, dateFrom, dateTo) {
  const query = `SELECT payment_method, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
                 FROM transactions WHERE date >= ? AND date <= ?
                 GROUP BY payment_method ORDER BY total DESC`;
  const result = db.exec(query, [dateFrom, dateTo]);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getTripSummary(db) {
  const query = `
    SELECT tr.id as trip_id, tr.name as trip_name,
           t.amount, t.discount_amount, t.foreign_amounts
    FROM transactions t
    JOIN trips tr ON t.trip_id = tr.id
    WHERE t.trip_id IS NOT NULL
    ORDER BY tr.sort_order, tr.id
  `;

  const result = db.exec(query);
  if (!result.length) return [];
  const { columns, values } = result[0];

  const tripMap = {};
  const tripOrder = [];
  values.forEach(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });

    const key = obj.trip_id;
    if (!tripMap[key]) {
      tripMap[key] = { trip_id: obj.trip_id, trip_name: obj.trip_name, total: 0, discount: 0, cnt: 0, foreignTotals: {} };
      tripOrder.push(key);
    }
    const trip = tripMap[key];
    trip.total += obj.amount || 0;
    trip.discount += obj.discount_amount || 0;
    trip.cnt += 1;

    if (obj.foreign_amounts) {
      try {
        const fa = JSON.parse(obj.foreign_amounts);
        Object.entries(fa).forEach(([currency, amount]) => {
          trip.foreignTotals[currency] = (trip.foreignTotals[currency] || 0) + Number(amount);
        });
      } catch (e) {}
    }
  });

  return tripOrder.map(k => tripMap[k]).sort((a, b) => b.total - a.total);
}

export function getTripDetailSummary(db, tripId) {
  const result = db.exec(
    'SELECT sub_category, amount, discount_amount, foreign_amounts FROM transactions WHERE trip_id = ?',
    [tripId]
  );
  if (!result.length) return [];
  const { columns, values } = result[0];

  const subMap = {};
  const subOrder = [];
  values.forEach(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    const key = obj.sub_category || '(미분류)';
    if (!subMap[key]) {
      subMap[key] = { sub_category: key, total: 0, discount: 0, cnt: 0, foreignTotals: {} };
      subOrder.push(key);
    }
    const sub = subMap[key];
    sub.total += obj.amount || 0;
    sub.discount += obj.discount_amount || 0;
    sub.cnt += 1;
    if (obj.foreign_amounts) {
      try {
        const fa = JSON.parse(obj.foreign_amounts);
        Object.entries(fa).forEach(([currency, amount]) => {
          sub.foreignTotals[currency] = (sub.foreignTotals[currency] || 0) + Number(amount);
        });
      } catch (e) {}
    }
  });
  return subOrder.map(k => subMap[k]).sort((a, b) => b.total - a.total);
}

export function getTripPaymentMethodSummary(db, tripId = null) {
  const where = tripId ? 'trip_id = ?' : 'trip_id IS NOT NULL';
  const params = tripId ? [tripId] : [];
  const query = `SELECT payment_method, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
                 FROM transactions WHERE ${where}
                 GROUP BY payment_method ORDER BY total DESC`;
  const result = db.exec(query, params);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
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

export function moveItemToPosition(db, table, id, newIndex, budgetCategory = null) {
  const allowed = ['payment_methods', 'budget_categories', 'sub_categories'];
  if (!allowed.includes(table)) throw new Error('Invalid table name');

  let hiddenRes;
  if (table === 'sub_categories') {
    hiddenRes = db.exec('SELECT is_hidden FROM sub_categories WHERE id = ?', [id]);
  } else {
    hiddenRes = db.exec(`SELECT is_hidden FROM ${table} WHERE id = ?`, [id]);
  }
  if (!hiddenRes.length || !hiddenRes[0].values.length) return;
  const isHidden = hiddenRes[0].values[0][0];

  let itemsRes;
  if (table === 'sub_categories' && budgetCategory) {
    itemsRes = db.exec(
      'SELECT id FROM sub_categories WHERE is_hidden = ? AND budget_category = ? ORDER BY sort_order',
      [isHidden, budgetCategory]
    );
  } else {
    itemsRes = db.exec(
      `SELECT id FROM ${table} WHERE is_hidden = ? ORDER BY sort_order`,
      [isHidden]
    );
  }
  if (!itemsRes.length) return;
  const ids = itemsRes[0].values.map(([itemId]) => itemId);

  const currentIdx = ids.indexOf(id);
  if (currentIdx === -1) return;
  ids.splice(currentIdx, 1);

  const clamped = Math.max(0, Math.min(newIndex, ids.length));
  ids.splice(clamped, 0, id);

  ids.forEach((itemId, i) => {
    db.run(`UPDATE ${table} SET sort_order = ? WHERE id = ?`, [i + 1, itemId]);
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

export function renameBudgetCategory(db, oldName, newName) {
  if (!newName || !newName.trim()) throw new Error('이름을 입력하세요.');
  const trimmed = newName.trim();
  const exists = db.exec('SELECT COUNT(*) FROM budget_categories WHERE name = ? AND name != ?', [trimmed, oldName]);
  if ((exists[0]?.values[0][0] || 0) > 0) throw new Error('이미 같은 이름의 카테고리가 있습니다.');
  db.run('UPDATE budget_categories SET name = ? WHERE name = ?', [trimmed, oldName]);
  db.run('UPDATE sub_categories SET budget_category = ? WHERE budget_category = ?', [trimmed, oldName]);
  db.run('UPDATE transactions SET budget_category = ? WHERE budget_category = ?', [trimmed, oldName]);
}

export function renameSubCategory(db, budgetCategory, oldName, newName) {
  if (!newName || !newName.trim()) throw new Error('이름을 입력하세요.');
  const trimmed = newName.trim();
  const exists = db.exec('SELECT COUNT(*) FROM sub_categories WHERE budget_category = ? AND name = ? AND name != ?', [budgetCategory, trimmed, oldName]);
  if ((exists[0]?.values[0][0] || 0) > 0) throw new Error('이미 같은 이름의 세부카테고리가 있습니다.');
  db.run('UPDATE sub_categories SET name = ? WHERE budget_category = ? AND name = ?', [trimmed, budgetCategory, oldName]);
  db.run('UPDATE transactions SET sub_category = ? WHERE budget_category = ? AND sub_category = ?', [trimmed, budgetCategory, oldName]);
}

export function getSubCategoryTxCount(db, budgetCategory, name) {
  const res = db.exec(
    'SELECT COUNT(*) FROM transactions WHERE budget_category = ? AND sub_category = ?',
    [budgetCategory, name]
  );
  return res[0]?.values[0][0] || 0;
}

export function deleteSubCategory(db, budgetCategory, name) {
  db.run('DELETE FROM sub_categories WHERE budget_category = ? AND name = ?', [budgetCategory, name]);
}

export function moveTripCountryToPosition(db, id, tripId, newIndex) {
  const itemsRes = db.exec(
    'SELECT id FROM trip_countries WHERE trip_id = ? ORDER BY sort_order, id',
    [tripId]
  );
  if (!itemsRes.length) return;
  const ids = itemsRes[0].values.map(([itemId]) => itemId);

  const currentIdx = ids.indexOf(id);
  if (currentIdx === -1) return;
  ids.splice(currentIdx, 1);

  const clamped = Math.max(0, Math.min(newIndex, ids.length));
  ids.splice(clamped, 0, id);

  ids.forEach((itemId, i) => {
    db.run('UPDATE trip_countries SET sort_order = ? WHERE id = ?', [i + 1, itemId]);
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

export function bulkInsertTransactions(db, txList) {
  db.run('BEGIN');
  try {
    ensurePaymentMethodsExist(db, txList);
    txList.forEach(tx => addTransaction(db, tx));
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

export function cleanupHiddenPaymentMethods(db) {
  // 숨겨진 결제수단 중 데이터에서 사용되지 않는 것들 삭제
  const result = db.exec(
    `SELECT id, name FROM payment_methods WHERE is_hidden = 1`
  );
  if (!result.length) return;

  result[0].values.forEach(row => {
    const [id, name] = row;
    const usageResult = db.exec(
      'SELECT COUNT(*) FROM transactions WHERE payment_method = ?',
      [name]
    );
    const count = usageResult[0]?.values[0][0] || 0;
    if (count === 0) {
      db.run('DELETE FROM payment_methods WHERE id = ?', [id]);
    }
  });
}

export function setCategoryColor(db, categoryId, color) {
  db.run('UPDATE budget_categories SET color = ? WHERE id = ?', [color, categoryId]);
}

export function getCategoryColor(db, categoryName) {
  const result = db.exec('SELECT color FROM budget_categories WHERE name = ?', [categoryName]);
  if (!result.length) return '';
  return result[0].values[0][0] || '';
}

export function getPaymentMethodDiscountRates(db) {
  const result = db.exec('SELECT name, discount_rate FROM payment_methods');
  if (!result.length) return {};
  const rates = {};
  result[0].values.forEach(([name, rate]) => { rates[name] = rate || 0; });
  return rates;
}

export function setPaymentMethodDiscountRate(db, name, rate) {
  db.run('UPDATE payment_methods SET discount_rate = ? WHERE name = ?', [rate, name]);
}


// ── 여행 ──────────────────────────────────────────────────────────

export function getTrips(db) {
  const res = db.exec('SELECT id, name FROM trips WHERE is_hidden = 0 ORDER BY sort_order, id');
  if (!res.length) return [];
  return res[0].values.map(([id, name]) => ({
    id, name,
    countries: getTripCountries(db, id),
  }));
}

export function getTripCountries(db, tripId) {
  const res = db.exec(
    'SELECT id, country, currency FROM trip_countries WHERE trip_id = ? ORDER BY sort_order, id',
    [tripId]
  );
  if (!res.length) return [];
  return res[0].values.map(([id, country, currency]) => ({ id, country, currency }));
}

export function getAllTrips(db) {
  const res = db.exec('SELECT id, name, sort_order, is_hidden FROM trips ORDER BY sort_order, id');
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function addTrip(db, name) {
  if (!name || !name.trim()) throw new Error('여행 이름을 입력하세요');
  const minSort = db.exec('SELECT COALESCE(MIN(sort_order), 1) FROM trips');
  const nextSort = (minSort[0]?.values[0][0] || 1) - 1;
  db.run('INSERT INTO trips (name, sort_order, is_hidden) VALUES (?, ?, 0)', [name.trim(), nextSort]);
}

export function updateTripName(db, id, name) {
  if (!name || !name.trim()) throw new Error('여행 이름을 입력하세요');
  db.run('UPDATE trips SET name = ? WHERE id = ?', [name.trim(), id]);
}

export function deleteTrip(db, id) {
  const res = db.exec('SELECT COUNT(*) FROM transactions WHERE trip_id = ?', [id]);
  const count = res[0]?.values[0][0] || 0;
  db.run('UPDATE transactions SET trip_id = NULL WHERE trip_id = ?', [id]);
  db.run('DELETE FROM trip_countries WHERE trip_id = ?', [id]);
  db.run('DELETE FROM trips WHERE id = ?', [id]);
  return count;
}

export function moveTripToPosition(db, id, newIndex) {
  const hiddenRes = db.exec('SELECT is_hidden FROM trips WHERE id = ?', [id]);
  if (!hiddenRes.length || !hiddenRes[0].values.length) return;
  const isHidden = hiddenRes[0].values[0][0];

  const itemsRes = db.exec('SELECT id FROM trips WHERE is_hidden = ? ORDER BY sort_order', [isHidden]);
  if (!itemsRes.length) return;
  const ids = itemsRes[0].values.map(([itemId]) => itemId);

  const currentIdx = ids.indexOf(id);
  if (currentIdx === -1) return;
  ids.splice(currentIdx, 1);

  const clamped = Math.max(0, Math.min(newIndex, ids.length));
  ids.splice(clamped, 0, id);

  ids.forEach((itemId, i) => {
    db.run('UPDATE trips SET sort_order = ? WHERE id = ?', [i + 1, itemId]);
  });
}

export function reorderTrip(db, id, direction) {
  const currRes = db.exec('SELECT sort_order FROM trips WHERE id = ?', [id]);
  if (!currRes.length || !currRes[0].values.length) return;
  const currentOrder = currRes[0].values[0][0];
  const neighborRes = direction === 'up'
    ? db.exec('SELECT id, sort_order FROM trips WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1', [currentOrder])
    : db.exec('SELECT id, sort_order FROM trips WHERE sort_order > ? ORDER BY sort_order ASC LIMIT 1', [currentOrder]);
  if (!neighborRes.length || !neighborRes[0].values.length) return;
  const [neighborId, neighborOrder] = neighborRes[0].values[0];
  db.run('UPDATE trips SET sort_order = ? WHERE id = ?', [neighborOrder, id]);
  db.run('UPDATE trips SET sort_order = ? WHERE id = ?', [currentOrder, neighborId]);
}

export function addTripCountry(db, tripId, country, currency) {
  if (!currency || !currency.trim()) throw new Error('화폐 단위를 입력하세요');
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) FROM trip_countries WHERE trip_id = ?', [tripId]);
  const nextSort = (maxSort[0]?.values[0][0] || 0) + 1;
  db.run(
    'INSERT INTO trip_countries (trip_id, country, currency, sort_order) VALUES (?, ?, ?, ?)',
    [tripId, country.trim(), currency.trim().toUpperCase(), nextSort]
  );
}

export function updateTripCountry(db, id, country, currency) {
  if (!currency || !currency.trim()) throw new Error('화폐 단위를 입력하세요');
  db.run(
    'UPDATE trip_countries SET country = ?, currency = ? WHERE id = ?',
    [country.trim(), currency.trim().toUpperCase(), id]
  );
}

export function deleteTripCountry(db, id) {
  db.run('DELETE FROM trip_countries WHERE id = ?', [id]);
}

// ── 결제수단 할인규칙 ────────────────────────────────────────────

export function getDiscountRules(db, paymentMethodName) {
  const result = db.exec(
    'SELECT id, payment_method_name, budget_category, sub_category, detail_keyword, rule_type, value, min_amount, note FROM payment_method_discount_rules WHERE payment_method_name = ? ORDER BY id',
    [paymentMethodName]
  );
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function addDiscountRule(db, rule) {
  db.run(
    `INSERT INTO payment_method_discount_rules (payment_method_name, budget_category, sub_category, detail_keyword, rule_type, value, min_amount, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [rule.payment_method_name, rule.budget_category || '', rule.sub_category || '', rule.detail_keyword || '', rule.rule_type, rule.value, rule.min_amount || 0, rule.note || '']
  );
}

export function deleteDiscountRule(db, id) {
  db.run('DELETE FROM payment_method_discount_rules WHERE id = ?', [id]);
}

/**
 * rules 배열에서 (카테고리, 세부카테고리, 세부내역, 금액)에 맞는 최적 규칙을 찾아 할인 금액 반환.
 * - 우선순위 스코어: detail_keyword(+4) > budget_category(+2) > sub_category(+1)
 * - detail_keyword는 부분 일치(대소문자 무시)
 * - rule_type: 'percent' (value=비율 e.g.0.01), 'fixed' (value=고정원), 'remainder' (value=단위 e.g.1000)
 */
export function evaluateDiscountRule(rules, budgetCategory, subCategory, amount, detail = '') {
  if (!rules.length || !amount || amount <= 0) return 0;

  const detailLower = (detail || '').toLowerCase();
  let bestRule = null;
  let bestScore = -1;

  for (const rule of rules) {
    if (rule.budget_category && rule.budget_category !== budgetCategory) continue;
    if (rule.sub_category && rule.sub_category !== subCategory) continue;
    if (rule.detail_keyword && !detailLower.includes(rule.detail_keyword.toLowerCase())) continue;
    const score = (rule.budget_category ? 2 : 0) + (rule.sub_category ? 1 : 0) + (rule.detail_keyword ? 4 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  if (!bestRule) return 0;
  if (amount < (bestRule.min_amount || 0)) return 0;

  if (bestRule.rule_type === 'percent') return Math.round(amount * bestRule.value);
  if (bestRule.rule_type === 'fixed') return Math.round(bestRule.value);
  if (bestRule.rule_type === 'remainder') return amount % bestRule.value;
  return 0;
}

// ── 앱 설정 ──────────────────────────────────────────────────────

export function getSetting(db, key, defaultVal = '') {
  const res = db.exec('SELECT value FROM settings WHERE key = ?', [key]);
  if (!res.length || !res[0].values.length) return defaultVal;
  return res[0].values[0][0] ?? defaultVal;
}

export function setSetting(db, key, value) {
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
}

// ── 월 목표금액 ───────────────────────────────────────────────────

export function getMonthlyGoal(db, yearMonth) {
  const res = db.exec('SELECT goal_amount FROM monthly_goals WHERE year_month = ?', [yearMonth]);
  if (!res.length || !res[0].values.length) return null;
  return res[0].values[0][0];
}

export function getEffectiveMonthlyGoal(db, yearMonth) {
  const override = getMonthlyGoal(db, yearMonth);
  if (override !== null) return override;
  const def = getSetting(db, 'default_monthly_goal', '');
  return def !== '' ? parseInt(def, 10) : null;
}

export function setMonthlyGoal(db, yearMonth, amount) {
  db.run('INSERT OR REPLACE INTO monthly_goals (year_month, goal_amount) VALUES (?, ?)', [yearMonth, amount]);
}

/**
 * 상시 목표금액 변경 시 호출.
 * 기존 거래내역이 있는 월 중 개별 설정이 없는 월을 현재(구) 기본값으로 스냅샷한 뒤 새 값을 저장.
 * 이후 새로 생기는 월만 신규 기본값이 적용된다.
 */
export function changeDefaultMonthlyGoal(db, newAmount) {
  const oldDefault = getSetting(db, 'default_monthly_goal', '');
  if (oldDefault !== '') {
    const oldVal = parseInt(oldDefault, 10);
    // 거래내역이 있는 모든 월 조회
    const monthsRes = db.exec(
      "SELECT DISTINCT strftime('%Y-%m', date) as month FROM transactions ORDER BY month"
    );
    const months = monthsRes.length ? monthsRes[0].values.map(r => r[0]) : [];
    // 개별 설정이 없는 월만 구 기본값으로 고정
    months.forEach(ym => {
      db.run(
        'INSERT OR IGNORE INTO monthly_goals (year_month, goal_amount) VALUES (?, ?)',
        [ym, oldVal]
      );
    });
  }
  setSetting(db, 'default_monthly_goal', String(newAmount));
}

export function deleteMonthlyGoal(db, yearMonth) {
  db.run('DELETE FROM monthly_goals WHERE year_month = ?', [yearMonth]);
}

export function getAllMonthlyGoals(db) {
  const res = db.exec('SELECT year_month, goal_amount FROM monthly_goals ORDER BY year_month DESC');
  if (!res.length) return {};
  const map = {};
  res[0].values.forEach(([ym, amt]) => { map[ym] = amt; });
  return map;
}

export function getMonthlyTotalsWithGoals(db, limit = 24) {
  const totals = getMonthlyTotals(db, limit);
  const goalsMap = getAllMonthlyGoals(db);
  const defaultGoal = getSetting(db, 'default_monthly_goal', '');
  const defGoalNum = defaultGoal !== '' ? parseInt(defaultGoal, 10) : null;
  return totals.map(r => ({
    ...r,
    goal: goalsMap[r.month] !== undefined ? goalsMap[r.month] : defGoalNum,
  }));
}

// ── 정기지출 템플릿 ───────────────────────────────────────────────

export function getRecurringTransactions(db) {
  const res = db.exec(
    `SELECT id, payment_method, budget_category, sub_category, detail, amount, discount_amount, discount_note, frequency, day_of_month, month_of_year, is_active, note
     FROM recurring_transactions
     ORDER BY
       CASE frequency WHEN 'monthly' THEN 0 ELSE 1 END,
       COALESCE(month_of_year, 0),
       CASE day_of_month WHEN 0 THEN 32 ELSE day_of_month END`
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function addRecurringTransaction(db, data) {
  db.run(
    `INSERT INTO recurring_transactions (payment_method, budget_category, sub_category, detail, amount, discount_amount, discount_note, frequency, day_of_month, month_of_year, is_active, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      data.payment_method, data.budget_category, data.sub_category || '',
      data.detail || '', data.amount,
      data.discount_amount || 0, data.discount_note || '',
      data.frequency || 'monthly', data.day_of_month ?? 1,
      data.month_of_year || null, data.note || '',
    ]
  );
}

export function updateRecurringTransaction(db, id, data) {
  db.run(
    `UPDATE recurring_transactions SET payment_method=?, budget_category=?, sub_category=?, detail=?, amount=?, discount_amount=?, discount_note=?, frequency=?, day_of_month=?, month_of_year=?, note=? WHERE id=?`,
    [
      data.payment_method, data.budget_category, data.sub_category || '',
      data.detail || '', data.amount,
      data.discount_amount || 0, data.discount_note || '',
      data.frequency || 'monthly', data.day_of_month ?? 1,
      data.month_of_year || null, data.note || '', id,
    ]
  );
}

export function deleteRecurringTransaction(db, id) {
  db.run('DELETE FROM recurring_transactions WHERE id = ?', [id]);
  db.run('DELETE FROM recurring_registration_log WHERE recurring_id = ?', [id]);
}

export function setRecurringActive(db, id, isActive) {
  db.run('UPDATE recurring_transactions SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
}

export function getRegistrationLog(db) {
  const res = db.exec('SELECT recurring_id, registered_for_month FROM recurring_registration_log ORDER BY registered_for_month DESC');
  if (!res.length) return {};
  const map = {};
  res[0].values.forEach(([rid, ym]) => {
    if (!map[rid]) map[rid] = new Set();
    map[rid].add(ym);
  });
  return map;
}

// ── 자동등록 ─────────────────────────────────────────────────────

function resolveDay(year, month1based, dayOfMonth) {
  // month1based: 1=1월, 12=12월
  const lastDay = new Date(year, month1based, 0).getDate(); // month1based month의 마지막 날
  if (dayOfMonth === 0) return lastDay;
  return Math.min(dayOfMonth, lastDay);
}

export function runAutoRegister(db) {
  const now = new Date();
  const targetDate = new Date(now.getFullYear(), now.getMonth() + 2, 1);
  const targetYear = targetDate.getFullYear();
  const targetMonth = targetDate.getMonth() + 1; // 1-indexed
  const targetYearMonth = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;

  const recurring = getRecurringTransactions(db).filter(r => r.is_active);
  let count = 0;

  recurring.forEach(r => {
    if (r.frequency === 'annual' && r.month_of_year !== targetMonth) return;

    const alreadyDone = db.exec(
      'SELECT 1 FROM recurring_registration_log WHERE recurring_id = ? AND registered_for_month = ?',
      [r.id, targetYearMonth]
    );
    if (alreadyDone.length && alreadyDone[0].values.length) return;

    const day = resolveDay(targetYear, targetMonth, r.day_of_month);
    const txDate = `${targetYearMonth}-${String(day).padStart(2, '0')}`;

    // 자동 할인 계산: template에 할인이 없으면 결제수단 규칙 적용
    let discountAmt = r.discount_amount || 0;
    let discountNote = r.discount_note || '';
    if (discountAmt === 0) {
      const rules = getDiscountRules(db, r.payment_method);
      const autoDiscount = evaluateDiscountRule(rules, r.budget_category, r.sub_category || '', r.amount, r.detail || '');
      if (autoDiscount > 0) discountAmt = autoDiscount;
    }

    db.run(
      `INSERT INTO transactions (payment_method, date, budget_category, sub_category, detail, amount, discount_amount, discount_note, is_recurring, recurring_source_id, recurring_frequency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [r.payment_method, txDate, r.budget_category, r.sub_category || '', r.detail || '', r.amount, discountAmt, discountNote, r.id, r.frequency]
    );

    const txIdRes = db.exec('SELECT last_insert_rowid()');
    const txId = txIdRes[0]?.values[0][0] || null;

    db.run(
      'INSERT OR IGNORE INTO recurring_registration_log (recurring_id, registered_for_month, transaction_id) VALUES (?, ?, ?)',
      [r.id, targetYearMonth, txId]
    );
    count++;
  });

  return { count, targetYearMonth };
}
