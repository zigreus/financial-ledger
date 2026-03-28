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
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sub_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  budget_category TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(budget_category, name)
);
`;

const DEFAULT_PAYMENT_METHODS = [
  '신한카드', '현대카드', '삼성카드', 'KB국민카드', '롯데카드',
  '현금',
];

const DEFAULT_CATEGORIES = {
  '식비':       ['아침', '점심', '저녁', '간식/카페', '야식'],
  '쇼핑':       ['생필품', '가전', '가구', '의류', '온라인쇼핑'],
  '차량교통비': ['주유', '세차', '주차비', '대중교통', '택시', '고속도로'],
  '의류/미용':  ['의류', '미용실', '화장품', '악세서리'],
  '의료/건강':  ['병원', '약국', '헬스/운동'],
  '교육':       ['학원', '교재', '온라인강의'],
  '여행/문화':  ['숙박', '항공/교통', '식비', '쇼핑', '문화생활', '입장료'],
  '반려동물':   ['사료/간식', '병원', '용품'],
  '기타':       ['기타'],
};

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

  // is_hidden 컬럼 마이그레이션 (있으면 무시)
  ['payment_methods', 'budget_categories', 'sub_categories'].forEach(table => {
    try {
      db.run(`ALTER TABLE ${table} ADD COLUMN is_hidden INTEGER DEFAULT 0`);
    } catch (e) {
      // 이미 존재하면 무시
    }
  });

  // 기본 데이터는 테이블이 비어있을 때만 삽입
  const pmCount = db.exec('SELECT COUNT(*) FROM payment_methods')[0]?.values[0][0] || 0;
  if (pmCount === 0) {
    DEFAULT_PAYMENT_METHODS.forEach((name, i) => {
      db.run('INSERT OR IGNORE INTO payment_methods (name, sort_order) VALUES (?, ?)', [name, i + 1]);
    });
    Object.entries(DEFAULT_CATEGORIES).forEach(([cat, subs], catIdx) => {
      db.run('INSERT OR IGNORE INTO budget_categories (name, sort_order) VALUES (?, ?)', [cat, catIdx + 1]);
      subs.forEach((sub, subIdx) => {
        db.run(
          'INSERT OR IGNORE INTO sub_categories (budget_category, name, sort_order) VALUES (?, ?, ?)',
          [cat, sub, subIdx + 1]
        );
      });
    });
  }

  return db;
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
       (payment_method, date, budget_category, sub_category, detail, amount, discount_amount, discount_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tx.payment_method, tx.date, tx.budget_category,
      tx.sub_category || '', tx.detail || '',
      tx.amount, tx.discount_amount || 0, tx.discount_note || '',
    ]
  );
}

export function updateTransaction(db, id, tx) {
  db.run(
    `UPDATE transactions
     SET payment_method=?, date=?, budget_category=?, sub_category=?,
         detail=?, amount=?, discount_amount=?, discount_note=?,
         updated_at=datetime('now','localtime')
     WHERE id=?`,
    [
      tx.payment_method, tx.date, tx.budget_category,
      tx.sub_category || '', tx.detail || '',
      tx.amount, tx.discount_amount || 0, tx.discount_note || '',
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

export function getMonthlyTotals(db) {
  const result = db.exec(
    `SELECT strftime('%Y-%m', date) as month,
            SUM(amount) as total,
            SUM(discount_amount) as discount,
            COUNT(*) as cnt
     FROM transactions
     GROUP BY month ORDER BY month DESC
     LIMIT 24`
  );
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

// ── 마스터 데이터 편집 (설정용) ──────────────────────────

export function getAllPaymentMethods(db) {
  const result = db.exec('SELECT id, name, sort_order, is_hidden FROM payment_methods ORDER BY sort_order, name');
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getAllBudgetCategories(db) {
  const result = db.exec('SELECT id, name, sort_order, is_hidden FROM budget_categories ORDER BY sort_order, name');
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
