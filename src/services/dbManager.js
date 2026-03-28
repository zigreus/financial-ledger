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
  '카카오페이', '네이버페이', '토스페이', '현금',
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
  const result = db.exec('SELECT name FROM payment_methods ORDER BY sort_order, name');
  return result.length ? result[0].values.map(r => r[0]) : [];
}

export function getBudgetCategories(db) {
  const result = db.exec('SELECT name FROM budget_categories ORDER BY sort_order, name');
  return result.length ? result[0].values.map(r => r[0]) : [];
}

export function getSubCategories(db, budgetCategory) {
  if (!budgetCategory) return [];
  const result = db.exec(
    'SELECT name FROM sub_categories WHERE budget_category = ? ORDER BY sort_order, name',
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
