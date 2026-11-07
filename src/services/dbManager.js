import initSqlJs from 'sql.js';
import { getNextBusinessDay, getPrevBusinessDay } from '../data/holidays';
import { toDateStr, toYearMonth, todayStr, addDays } from './dateUtils';

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
  event_id INTEGER DEFAULT NULL,
  foreign_amounts TEXT DEFAULT '',
  trip_id INTEGER DEFAULT NULL,
  is_recurring INTEGER DEFAULT 0,
  recurring_source_id INTEGER DEFAULT NULL,
  recurring_frequency TEXT DEFAULT NULL,
  split_group_id TEXT DEFAULT '',
  is_cash_adjustment INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0,
  is_hidden INTEGER DEFAULT 0,
  discount_rate REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budget_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0,
  color TEXT DEFAULT '',
  is_hidden INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sub_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  budget_category TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_hidden INTEGER DEFAULT 0,
  UNIQUE(budget_category, name)
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

CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  date_from TEXT DEFAULT '',
  date_to TEXT DEFAULT '',
  event_type TEXT DEFAULT 'general',
  color TEXT DEFAULT '',
  note TEXT DEFAULT '',
  is_hidden INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS event_countries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  exchange_rate REAL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS calendar_event_types (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  value        TEXT    NOT NULL UNIQUE,
  label        TEXT    NOT NULL,
  color        TEXT    NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_system    INTEGER NOT NULL DEFAULT 0,
  is_trip_type INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS favorite_transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  payment_method  TEXT NOT NULL,
  budget_category TEXT NOT NULL,
  sub_category    TEXT DEFAULT '',
  detail          TEXT DEFAULT '',
  amount          INTEGER,
  sort_order      INTEGER DEFAULT 0,
  use_count       INTEGER DEFAULT 0,
  last_used_at    TEXT,
  created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS auto_pattern_settings (
  sub_category  TEXT PRIMARY KEY,
  is_disabled   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pattern_suggestion_log (
  pattern_key           TEXT PRIMARY KEY,
  suggest_count         INTEGER DEFAULT 0,
  dismiss_count         INTEGER DEFAULT 0,
  never_suggest         INTEGER DEFAULT 0,
  last_suggest_tx_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  bank             TEXT DEFAULT '',
  account_number   TEXT DEFAULT '',
  current_balance  INTEGER DEFAULT 0,
  balance_date     TEXT DEFAULT '',
  danger_threshold INTEGER DEFAULT 0,
  is_default       INTEGER DEFAULT 0,
  note             TEXT DEFAULT '',
  sort_order       INTEGER DEFAULT 0,
  is_active        INTEGER DEFAULT 1,
  created_at       TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS account_recurring_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            INTEGER NOT NULL,
  name                  TEXT NOT NULL,
  type                  TEXT NOT NULL DEFAULT 'expense',
  day_of_month          INTEGER NOT NULL DEFAULT 1,
  holiday_rule          TEXT DEFAULT 'next_business',
  amount_type           TEXT DEFAULT 'fixed',
  fixed_amount          INTEGER DEFAULT 0,
  auto_payment_method   TEXT DEFAULT '',
  auto_register         INTEGER DEFAULT 1,
  register_months_ahead INTEGER DEFAULT 2,
  note                  TEXT DEFAULT '',
  sort_order            INTEGER DEFAULT 0,
  is_active             INTEGER DEFAULT 1,
  created_at            TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS account_transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        INTEGER NOT NULL,
  date              TEXT NOT NULL,
  type              TEXT NOT NULL DEFAULT 'expense',
  category          TEXT DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  amount            INTEGER NOT NULL,
  base_amount       INTEGER DEFAULT NULL,
  recurring_item_id INTEGER DEFAULT NULL,
  is_auto_generated INTEGER DEFAULT 0,
  is_modified       INTEGER DEFAULT 0,
  is_imported       INTEGER DEFAULT 0,
  created_at        TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 계좌 자동등록에서 사용자가 지운 달 (다시 만들지 않는다)
CREATE TABLE IF NOT EXISTS account_recurring_skips (
  recurring_item_id INTEGER NOT NULL,
  recurring_month   TEXT    NOT NULL,
  PRIMARY KEY (recurring_item_id, recurring_month)
);

CREATE TABLE IF NOT EXISTS event_cash_flows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL,
  date       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'exchange',
  currency   TEXT NOT NULL,
  amount     REAL NOT NULL,
  krw_cost   INTEGER DEFAULT 0,
  account_id INTEGER DEFAULT NULL,
  note       TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

`;


// sql.js WASM은 빌드 때 public/에 복사해 둔 같은 버전 파일을 쓴다 (scripts/copy-sql-wasm.js).
// 외부 CDN에 의존하지 않으므로 CDN 장애·버전 불일치로 앱이 못 열리는 일이 없다.
export async function initSQL() {
  if (!SQL) {
    SQL = await initSqlJs({
      locateFile: file => `${process.env.PUBLIC_URL || ''}/${file}`,
    });
  }
  return SQL;
}

// ── 스키마 버전 · 마이그레이션 ─────────────────────────────────────
// 새 컬럼은 COLUMN_MIGRATIONS에 한 줄 추가한다. 새 테이블은 SCHEMA에 CREATE TABLE IF NOT EXISTS로 추가한다.
// 실제로 무언가 바뀌었을 때만 didMigrate가 참이 되어야 한다 — 참이면 로드 직후 OneDrive에 다시 저장한다.
export const SCHEMA_VERSION = 2;

const COLUMN_MIGRATIONS = [
  // [테이블, 컬럼, 정의]
  ['transactions', 'is_recurring', 'INTEGER DEFAULT 0'],
  ['transactions', 'recurring_source_id', 'INTEGER DEFAULT NULL'],
  ['transactions', 'recurring_frequency', 'TEXT DEFAULT NULL'],
  ['transactions', 'event_id', 'INTEGER DEFAULT NULL'],
  ['transactions', 'split_group_id', "TEXT DEFAULT ''"],
  ['transactions', 'is_cash_adjustment', 'INTEGER DEFAULT 0'],
  ['recurring_transactions', 'discount_amount', 'INTEGER DEFAULT 0'],
  ['recurring_transactions', 'discount_note', "TEXT DEFAULT ''"],
  ['event_countries', 'exchange_rate', 'REAL DEFAULT 0'],
  // 계좌 자동등록: 어느 달 몫인지 (휴일 보정으로 실제 날짜가 다른 달이 될 수 있다)
  ['account_transactions', 'recurring_month', "TEXT DEFAULT ''"],
  // 여행 현금 흐름과 함께 만든 기록 — 흐름을 지울 때 같이 정리한다 (B-038)
  ['event_cash_flows', 'account_tx_id', 'INTEGER DEFAULT NULL'],   // 계좌 출금/입금 기록
  ['event_cash_flows', 'linked_flow_id', 'INTEGER DEFAULT NULL'],  // 이월 나감 ↔ 이월 들어옴
  ['event_cash_flows', 'linked_tx_id', 'INTEGER DEFAULT NULL'],    // 재환전의 환차손익 거래
];

function tableExists(db, table) {
  const res = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", [table]);
  return !!res[0]?.values.length;
}

function columnsOf(db, table) {
  const res = db.exec(`PRAGMA table_info(${table})`);
  return new Set((res[0]?.values || []).map(r => r[1]));
}

/** 컬럼이 없을 때만 추가한다. 추가했으면 true. */
function ensureColumn(db, table, column, ddl) {
  if (!tableExists(db, table) || columnsOf(db, table).has(column)) return false;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

/** 쓰기 문장을 실행하고 바뀐 행 수를 돌려준다. */
function runCount(db, sql, params) {
  db.run(sql, params);
  return db.getRowsModified();
}

/**
 * 여러 문장을 하나의 단위로 실행한다 — 중간에 실패하면 전부 되돌린다.
 * SAVEPOINT를 써서 중첩 호출도 안전하다.
 */
let savepointSeq = 0;
export function withTransaction(db, fn) {
  const name = `sp_${++savepointSeq}`;
  db.run(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.run(`RELEASE ${name}`);
    return result;
  } catch (e) {
    db.run(`ROLLBACK TO ${name}`);
    db.run(`RELEASE ${name}`);
    throw e;
  }
}

/** 예전 trips/trip_countries 테이블을 calendar_events로 옮긴다 (아주 오래된 DB에만 해당). */
function migrateLegacyTrips(db) {
  if (!tableExists(db, 'trips')) return false;
  ensureColumn(db, 'trips', 'schedule', "TEXT DEFAULT ''");
  const hasCountries = tableExists(db, 'trip_countries');

  withTransaction(db, () => {
    const trips = db.exec('SELECT id, name, schedule, sort_order FROM trips ORDER BY sort_order, id');
    (trips[0]?.values || []).forEach(([tripId, name, schedule, sortOrder]) => {
      const already = db.exec(
        'SELECT id FROM calendar_events WHERE note LIKE ? AND event_type = ?',
        [`%[trip_id:${tripId}]%`, 'trip']
      );
      if (already[0]?.values.length) return;

      const noteVal = schedule ? `${schedule} [trip_id:${tripId}]` : `[trip_id:${tripId}]`;
      db.run(
        `INSERT INTO calendar_events (title, date_from, date_to, event_type, color, note, sort_order)
         VALUES (?, '', '', 'trip', '#F0A500', ?, ?)`,
        [name, noteVal, sortOrder]
      );
      const newEventId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];

      if (hasCountries) {
        const countries = db.exec(
          'SELECT country, currency, sort_order FROM trip_countries WHERE trip_id = ? ORDER BY sort_order, id',
          [tripId]
        );
        (countries[0]?.values || []).forEach(([country, currency, cSort]) => {
          db.run(
            'INSERT INTO event_countries (event_id, country, currency, sort_order) VALUES (?, ?, ?, ?)',
            [newEventId, country, currency, cSort]
          );
        });
      }

      db.run('UPDATE transactions SET event_id = ? WHERE trip_id = ? AND event_id IS NULL', [newEventId, tripId]);
    });
    db.run('DROP TABLE IF EXISTS trip_countries');
    db.run('DROP TABLE trips');
  });
  return true;
}

/**
 * DB를 열고 스키마를 최신으로 맞춘다.
 * 반환: { db, didMigrate, migrationErrors, newerSchema }
 *  - didMigrate: 실제로 스키마·데이터를 바꿨을 때만 true (true면 호출부가 OneDrive에 저장)
 *  - migrationErrors: 실패한 마이그레이션 메시지 목록 (조용히 삼키지 않는다)
 *  - newerSchema: 이 앱보다 새 버전 앱이 만든 DB면 true (화면에서 새로고침을 안내)
 */
export function createDatabase(SQL, existingData = null) {
  const db = existingData ? new SQL.Database(existingData) : new SQL.Database();
  const migrationErrors = [];
  let didMigrate = !existingData; // 새 DB는 처음 한 번 저장해야 한다

  const step = (label, fn) => {
    try {
      if (fn()) didMigrate = true;
    } catch (e) {
      migrationErrors.push(`${label}: ${e.message}`);
      // eslint-disable-next-line no-console
      console.error(`[DB 마이그레이션 실패] ${label}`, e);
    }
  };

  const storedVersion = db.exec('PRAGMA user_version')[0]?.values[0][0] || 0;

  step('기본 스키마', () => { db.run(SCHEMA); return false; });

  COLUMN_MIGRATIONS.forEach(([table, column, ddl]) => {
    step(`${table}.${column} 추가`, () => ensureColumn(db, table, column, ddl));
  });

  // recurring_transactions.is_active 컬럼 제거 (기존 DB 호환)
  step('recurring_transactions.is_active 제거', () => {
    if (!columnsOf(db, 'recurring_transactions').has('is_active')) return false;
    db.run('ALTER TABLE recurring_transactions DROP COLUMN is_active');
    return true;
  });

  // 즐겨찾기 금액을 선택 항목으로 — amount의 NOT NULL 제거 (기존 DB 호환)
  step('favorite_transactions.amount NULL 허용', () => {
    const favSql = db.exec(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='favorite_transactions'"
    )[0]?.values[0]?.[0] || '';
    if (!/amount\s+INTEGER\s+NOT\s+NULL/i.test(favSql)) return false;
    withTransaction(db, () => {
      db.run(`CREATE TABLE favorite_transactions_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        payment_method  TEXT NOT NULL,
        budget_category TEXT NOT NULL,
        sub_category    TEXT DEFAULT '',
        detail          TEXT DEFAULT '',
        amount          INTEGER,
        sort_order      INTEGER DEFAULT 0,
        use_count       INTEGER DEFAULT 0,
        last_used_at    TEXT,
        created_at      TEXT DEFAULT (datetime('now', 'localtime'))
      )`);
      db.run(`INSERT INTO favorite_transactions_new
              SELECT id, name, payment_method, budget_category, sub_category, detail,
                     amount, sort_order, use_count, last_used_at, created_at
              FROM favorite_transactions`);
      db.run('DROP TABLE favorite_transactions');
      db.run('ALTER TABLE favorite_transactions_new RENAME TO favorite_transactions');
    });
    return true;
  });

  step('trips → calendar_events 이전', () => migrateLegacyTrips(db));

  // 쓰지 않는 holidays 테이블 정리 (공휴일은 src/data/holidays.js에서 바로 읽는다)
  step('holidays 테이블 제거', () => {
    if (!tableExists(db, 'holidays')) return false;
    db.run('DROP TABLE holidays');
    return true;
  });

  // ── calendar_event_types 기본값 및 데이터 정규화 ───────────────────
  step('일정 유형 기본값', () => {
    let changed = 0;
    changed += runCount(db, `INSERT OR IGNORE INTO calendar_event_types (value, label, color, sort_order, is_system, is_trip_type)
      VALUES
        ('trip',     '여행',   '#F0A500', 0, 1, 1),
        ('occasion', '경조사', '#EC4899', 1, 0, 0),
        ('general',  '일상',   '#9CA3AF', 2, 1, 0)`);
    // general: 이름 '기타'→'일상', sort_order 999→2 (기존 DB 호환)
    changed += runCount(db, `UPDATE calendar_event_types SET label='일상', sort_order=2
      WHERE value='general' AND (label='기타' OR sort_order=999)`);
    // 구 유형(holiday, medical) 및 정의되지 않은 유형 → general
    changed += runCount(db, `UPDATE calendar_events SET event_type = 'general'
      WHERE event_type IN ('holiday', 'medical')
         OR event_type NOT IN (SELECT value FROM calendar_event_types)`);
    return changed > 0;
  });

  // ── 계좌 자동등록 내역의 '대상 월' 채우기 + 중복 정리 (B-007) ─────────
  step('계좌 자동등록 대상 월 정리', () => normalizeAccountRecurringMonths(db));

  const newerSchema = storedVersion > SCHEMA_VERSION;
  if (!newerSchema && storedVersion !== SCHEMA_VERSION && migrationErrors.length === 0) {
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    didMigrate = true;
  }

  return { db, didMigrate, migrationErrors, newerSchema };
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

// 특정 월의 날짜별 지출 합계 반환 { 'YYYY-MM-DD': { total, discount, count } }
export function getDailyTotals(db, month) {
  if (!db || !month) return {};
  const result = db.exec(
    `SELECT date, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as count
     FROM transactions WHERE strftime('%Y-%m', date) = ?
     GROUP BY date`,
    [month]
  );
  if (!result.length) return {};
  const map = {};
  result[0].values.forEach(row => {
    map[row[0]] = { total: row[1] || 0, discount: row[2] || 0, count: row[3] || 0 };
  });
  return map;
}

// ── 캘린더 이벤트 ──────────────────────────────────────────────────

export function getCalendarEvents(db, opts = {}) {
  if (!db) return [];
  let q = 'SELECT * FROM calendar_events WHERE 1=1';
  const params = [];
  if (!opts.includeHidden) { q += ' AND is_hidden = 0'; }
  if (opts.eventType) { q += ' AND event_type = ?'; params.push(opts.eventType); }
  q += ' ORDER BY sort_order, id';
  const res = db.exec(q, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    obj.countries = getEventCountries(db, obj.id);
    return obj;
  });
}

export function getCalendarEventsInRange(db, dateFrom, dateTo) {
  if (!db) return [];
  // date_from이 비어있지 않고, 기간이 겹치는 이벤트.
  // 종료일이 없으면 하루짜리, 예전에 시작·종료가 뒤바뀌어 저장된 일정은 두 날짜 중 앞·뒤로 본다.
  const res = db.exec(
    `SELECT * FROM calendar_events
     WHERE is_hidden = 0
       AND date_from != ''
       AND MIN(date_from, COALESCE(NULLIF(date_to, ''), date_from)) <= ?
       AND MAX(date_from, COALESCE(NULLIF(date_to, ''), date_from)) >= ?
     ORDER BY date_from, id`,
    [dateTo, dateFrom]
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    obj.countries = getEventCountries(db, obj.id);
    return obj;
  });
}

export function getUndatedCalendarEvents(db) {
  if (!db) return [];
  const res = db.exec(
    "SELECT * FROM calendar_events WHERE is_hidden = 0 AND (date_from = '' OR date_from IS NULL) ORDER BY sort_order, id"
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    obj.countries = getEventCountries(db, obj.id);
    return obj;
  });
}

export function getEventCountries(db, eventId) {
  if (!db || !eventId) return [];
  const res = db.exec(
    'SELECT id, country, currency, COALESCE(exchange_rate, 0), sort_order FROM event_countries WHERE event_id = ? ORDER BY sort_order, id',
    [eventId]
  );
  if (!res.length) return [];
  return res[0].values.map(([id, country, currency, exchange_rate, sort_order]) =>
    ({ id, country, currency, exchange_rate: Number(exchange_rate) || 0, sort_order }));
}

/** 일정 날짜 검증 — 종료일만 있거나 종료일이 시작일보다 빠르면 달력에 나타나지 않으므로 막는다 */
function validateEventDates(ev) {
  const from = ev.date_from || '';
  const to = ev.date_to || '';
  if (to && !from) throw new Error('종료일이 있으면 시작일도 입력하세요');
  if (from && to && to < from) throw new Error('종료일이 시작일보다 빠릅니다');
}

export function addCalendarEvent(db, ev) {
  if (!db || !ev.title?.trim()) throw new Error('제목을 입력하세요');
  validateEventDates(ev);
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), -1) FROM calendar_events');
  const nextSort = (maxSort[0]?.values[0][0] ?? -1) + 1;
  db.run(
    `INSERT INTO calendar_events (title, date_from, date_to, event_type, color, note, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ev.title.trim(), ev.date_from || '', ev.date_to || '', ev.event_type || 'general',
     ev.color || '', ev.note || '', nextSort]
  );
  const res = db.exec('SELECT last_insert_rowid()');
  return res[0].values[0][0];
}

export function updateCalendarEvent(db, id, ev) {
  if (!db || !ev.title?.trim()) throw new Error('제목을 입력하세요');
  validateEventDates(ev);
  db.run(
    `UPDATE calendar_events SET title=?, date_from=?, date_to=?, event_type=?, color=?, note=?, is_hidden=?
     WHERE id=?`,
    [ev.title.trim(), ev.date_from || '', ev.date_to || '', ev.event_type || 'general',
     ev.color || '', ev.note || '', ev.is_hidden ? 1 : 0, id]
  );
}

/**
 * 일정을 지우면 함께 바뀌는 것 — 삭제 확인 문구용.
 *  txCount: 일정 연결만 풀리고 남는 거래 수
 *  flowCount: 같이 지워지는 환전·정산 기록 수 (accountFlowCount: 그중 계좌 입출금으로도 기록된 것)
 */
export function getCalendarEventLinkCounts(db, id) {
  if (!db || !id) return { txCount: 0, flowCount: 0, accountFlowCount: 0 };
  const one = (sql) => Number(db.exec(sql, [id])[0]?.values[0][0]) || 0;
  return {
    txCount: one('SELECT COUNT(*) FROM transactions WHERE event_id = ?'),
    flowCount: one('SELECT COUNT(*) FROM event_cash_flows WHERE event_id = ?'),
    // addEventCashFlow는 계좌를 지정하고 원화 금액이 있을 때만 계좌 내역을 만든다
    accountFlowCount: one(`SELECT COUNT(*) FROM event_cash_flows
      WHERE event_id = ? AND account_id IS NOT NULL AND COALESCE(krw_cost, 0) != 0`),
  };
}

/**
 * 일정 삭제 — 국가·환율과 환전·정산 기록(event_cash_flows)은 함께 지우고,
 * 연결된 거래는 남긴 채 일정 연결만 푼다. 계좌 입출금 내역(account_transactions)은 실제 돈의 이동이라 그대로 둔다.
 */
export function deleteCalendarEvent(db, id) {
  withTransaction(db, () => {
    db.run('DELETE FROM event_countries WHERE event_id = ?', [id]);
    // 다른 일정에 남는 이월 짝은 실제로 옮긴 현금이라 지우지 않고, 연결만 끊는다
    db.run(`UPDATE event_cash_flows SET linked_flow_id = NULL
            WHERE event_id != ? AND linked_flow_id IN (SELECT id FROM event_cash_flows WHERE event_id = ?)`, [id, id]);
    db.run('DELETE FROM event_cash_flows WHERE event_id = ?', [id]);
    db.run('UPDATE transactions SET event_id = NULL WHERE event_id = ?', [id]);
    db.run('DELETE FROM calendar_events WHERE id = ?', [id]);
  });
}

export function addEventCountry(db, eventId, country, currency, exchangeRate = 0) {
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), -1) FROM event_countries WHERE event_id = ?', [eventId]);
  const nextSort = (maxSort[0]?.values[0][0] ?? -1) + 1;
  db.run('INSERT INTO event_countries (event_id, country, currency, exchange_rate, sort_order) VALUES (?, ?, ?, ?, ?)',
    [eventId, country, currency, Number(exchangeRate) || 0, nextSort]);
}

export function updateEventCountry(db, id, country, currency, exchangeRate = 0) {
  db.run('UPDATE event_countries SET country=?, currency=?, exchange_rate=? WHERE id=?',
    [country, currency, Number(exchangeRate) || 0, id]);
}

export function deleteEventCountry(db, id) {
  db.run('DELETE FROM event_countries WHERE id = ?', [id]);
}

// ── 여행 현금 지갑 ──────────────────────────────────────────────────
//
// 출금/환전은 "지출"이 아니라 계좌 → 현금지갑 이동이다.
// 따라서 가계부 합계(transactions)에는 넣지 않고 event_cash_flows에만 기록하며,
// 실제 현금 사용은 기존 transactions(결제수단='현금')이 담당한다.
// 잔여 현금 = Σ흐름 − Σ현금사용.

const KRW = 'KRW';

const todayLocal = todayStr;

export function getEventCashFlows(db, eventId) {
  if (!db || !eventId) return [];
  const res = db.exec(
    `SELECT id, event_id, date, type, currency, amount, krw_cost, account_id, note
     FROM event_cash_flows WHERE event_id = ? ORDER BY date, id`,
    [eventId]
  );
  if (!res.length) return [];
  return res[0].values.map(([id, event_id, date, type, currency, amount, krw_cost, account_id, note]) =>
    ({ id, event_id, date, type, currency, amount: Number(amount), krw_cost: Number(krw_cost) || 0, account_id, note }));
}

const lastInsertId = (db) => db.exec('SELECT last_insert_rowid()')[0].values[0][0];

/** 결과가 정확히 한 행일 때만 그 id — 예전 기록의 짝을 추정할 때 애매하면 건드리지 않는다 */
function uniqueRowId(db, sql, params) {
  const rows = db.exec(sql, params)[0]?.values || [];
  return rows.length === 1 ? rows[0][0] : null;
}

const CASH_FLOW_ACCOUNT_CATEGORY = '여행 현금';

export function addEventCashFlow(db, flow) {
  if (!db || !flow.event_id) throw new Error('일정을 선택하세요');
  const currency = (flow.currency || KRW).trim().toUpperCase();
  const amount = Number(flow.amount);
  if (!isFinite(amount) || amount === 0) throw new Error('금액을 입력하세요');
  const krwCost = Math.round(Number(flow.krw_cost) || 0);

  return withTransaction(db, () => {
    // 계좌를 지정했으면 계좌 잔액에도 반영 (출금=지출 / 입금=수입).
    // 흐름을 지울 때 같이 지우도록 계좌 기록 id를 흐름에 남긴다.
    let accountTxId = null;
    if (flow.account_id && krwCost !== 0) {
      addAccountTransaction(db, {
        account_id: flow.account_id,
        date: flow.date,
        type: amount > 0 ? 'expense' : 'income',
        category: CASH_FLOW_ACCOUNT_CATEGORY,
        description: flow.note || (amount > 0 ? `${currency} 환전/출금` : `${currency} 재환전/입금`),
        amount: Math.abs(krwCost),
      });
      accountTxId = lastInsertId(db);
    }

    db.run(
      `INSERT INTO event_cash_flows
         (event_id, date, type, currency, amount, krw_cost, account_id, note, account_tx_id, linked_flow_id, linked_tx_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [flow.event_id, flow.date, flow.type || 'exchange', currency, amount,
       krwCost, flow.account_id || null, flow.note || '',
       accountTxId, flow.linked_flow_id || null, flow.linked_tx_id || null]
    );
    const id = lastInsertId(db);

    syncEventRateFromFlows(db, flow.event_id, currency);
    return id;
  });
}

/**
 * 현금 흐름 하나를 지울 때 함께 정리할 기록 — 삭제 확인 문구와 deleteEventCashFlow가 같이 쓴다.
 *  accountTx : 이 흐름으로 만든 계좌 출금/입금 기록
 *  pairFlow  : 이월의 짝 (다른 일정의 '이월 들어옴'/'이월 나감')
 *  fxTx      : 재환전 때 기록한 환차손익 거래
 *  accountTxMissing : 계좌에 반영된 흐름인데 그 기록을 찾지 못함 (직접 지워야 함)
 * 연결 id가 없는 예전 기록은 같은 날짜·금액으로 짝을 찾되, 후보가 하나일 때만 연결로 본다.
 */
export function getCashFlowLinks(db, id) {
  if (!db || !id) return null;
  const flow = dbRowsToObjects(db.exec('SELECT * FROM event_cash_flows WHERE id = ?', [id]))[0];
  if (!flow) return null;
  const cur = String(flow.currency || '').trim().toUpperCase();
  const amount = Number(flow.amount) || 0;
  const krw = Math.abs(Math.round(Number(flow.krw_cost) || 0));

  // 계좌 기록
  let accountTxId = flow.account_tx_id || null;
  if (!accountTxId && flow.account_id && krw > 0) {
    accountTxId = db.exec(
      `SELECT id FROM account_transactions
       WHERE account_id = ? AND date = ? AND category = ? AND amount = ? AND type = ?
         AND id NOT IN (SELECT account_tx_id FROM event_cash_flows WHERE account_tx_id IS NOT NULL)
       ORDER BY id DESC LIMIT 1`,
      [flow.account_id, flow.date, CASH_FLOW_ACCOUNT_CATEGORY, krw, amount > 0 ? 'expense' : 'income']
    )[0]?.values[0]?.[0] || null;
  }
  const accountTx = accountTxId ? dbRowsToObjects(db.exec(
    `SELECT t.id, t.amount, t.type, a.name AS account_name
     FROM account_transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`,
    [accountTxId]
  ))[0] || null : null;

  // 이월의 짝
  let pairId = flow.linked_flow_id || null;
  if (!pairId && (flow.type === 'carryover_out' || flow.type === 'carryover_in')) {
    pairId = uniqueRowId(db,
      `SELECT id FROM event_cash_flows
       WHERE type = ? AND date = ? AND UPPER(currency) = ? AND ABS(amount + ?) < 0.005
         AND event_id != ? AND linked_flow_id IS NULL`,
      [flow.type === 'carryover_out' ? 'carryover_in' : 'carryover_out', flow.date, cur, amount, flow.event_id]);
  }
  const pairFlow = pairId ? dbRowsToObjects(db.exec(
    `SELECT f.*, e.title AS event_title
     FROM event_cash_flows f LEFT JOIN calendar_events e ON e.id = f.event_id WHERE f.id = ?`,
    [pairId]
  ))[0] || null : null;

  // 재환전의 환차손익 거래 — 예전 기록은 그날 이 일정의 외화 재환전이 하나뿐일 때만 추정한다
  let fxTxId = flow.linked_tx_id || null;
  if (!fxTxId && flow.type === 'refund' && cur !== KRW) {
    const sameDayRefunds = Number(db.exec(
      `SELECT COUNT(*) FROM event_cash_flows
       WHERE event_id = ? AND date = ? AND type = 'refund' AND UPPER(currency) != ?`,
      [flow.event_id, flow.date, KRW]
    )[0]?.values[0][0]) || 0;
    if (sameDayRefunds === 1) {
      fxTxId = uniqueRowId(db,
        `SELECT id FROM transactions
         WHERE event_id = ? AND date = ? AND COALESCE(is_cash_adjustment, 0) = 1
           AND detail IN ('환전 차손', '환전 차익')
           AND id NOT IN (SELECT linked_tx_id FROM event_cash_flows WHERE linked_tx_id IS NOT NULL)`,
        [flow.event_id, flow.date]);
    }
  }
  const fxTx = fxTxId ? dbRowsToObjects(db.exec(
    'SELECT id, detail, amount, discount_amount FROM transactions WHERE id = ?', [fxTxId]
  ))[0] || null : null;

  return {
    flow,
    accountTx,
    accountTxMissing: !!flow.account_id && krw > 0 && !accountTx,
    pairFlow,
    fxTx,
  };
}

/** 현금 흐름 삭제 — 함께 만든 계좌 기록·이월 짝·환차손익 거래도 지운다. 지운 내용을 돌려준다. */
export function deleteEventCashFlow(db, id) {
  if (!db) return null;
  const links = getCashFlowLinks(db, id);
  if (!links) return null;

  withTransaction(db, () => {
    if (links.accountTx) deleteAccountTransaction(db, links.accountTx.id);
    if (links.fxTx) deleteTransaction(db, links.fxTx.id);
    if (links.pairFlow) {
      if (links.pairFlow.account_tx_id) deleteAccountTransaction(db, links.pairFlow.account_tx_id);
      db.run('DELETE FROM event_cash_flows WHERE id = ?', [links.pairFlow.id]);
      syncEventRateFromFlows(db, links.pairFlow.event_id, links.pairFlow.currency);
    }
    db.run('DELETE FROM event_cash_flows WHERE id = ?', [id]);
    syncEventRateFromFlows(db, links.flow.event_id, links.flow.currency);
  });
  return links;
}

/**
 * 일정에 연결된 현금(결제수단='현금') 거래의 통화별 사용액.
 * 현지 통화 금액이 기록돼 있으면 그 통화 지갑에서, 없으면 원화 지갑에서 차감한다.
 */
export function getEventCashSpending(db, eventId) {
  const spent = {};
  if (!db || !eventId) return spent;
  const res = db.exec(
    `SELECT amount, foreign_amounts FROM transactions
     WHERE event_id = ? AND payment_method = '현금' AND COALESCE(is_cash_adjustment, 0) = 0`,
    [eventId]
  );
  if (!res.length) return spent;

  const walletCurrencies = new Set(
    (db.exec('SELECT DISTINCT currency FROM event_countries WHERE event_id = ?', [eventId])[0]?.values || [])
      .map(r => String(r[0]).trim().toUpperCase())
  );

  res[0].values.forEach(([amount, foreignJson]) => {
    let fa = {};
    try { fa = foreignJson ? JSON.parse(foreignJson) : {}; } catch (e) {}
    const matched = Object.entries(fa).filter(([cur, val]) =>
      walletCurrencies.has(String(cur).trim().toUpperCase()) && Number(val) > 0);

    if (matched.length) {
      matched.forEach(([cur, val]) => {
        const c = String(cur).trim().toUpperCase();
        spent[c] = (spent[c] || 0) + Number(val);
      });
    } else {
      spent[KRW] = (spent[KRW] || 0) + (Number(amount) || 0);
    }
  });
  return spent;
}

/**
 * 일정의 통화별 현금 지갑 현황.
 * balance = 흐름 합계 − 현금 사용액, avgRate = 취득 원화 / 취득 수량.
 */
export function getEventWallets(db, eventId) {
  if (!db || !eventId) return [];
  const flows = getEventCashFlows(db, eventId);
  const spending = getEventCashSpending(db, eventId);
  const countries = getEventCountries(db, eventId);

  const currencyLabel = {};
  countries.forEach(c => {
    const cur = String(c.currency || '').trim().toUpperCase();
    if (cur) currencyLabel[cur] = c.country;
  });

  const map = {};
  const ensure = (cur) => {
    if (!map[cur]) {
      map[cur] = {
        currency: cur,
        country: currencyLabel[cur] || (cur === KRW ? '원화' : ''),
        inflow: 0, acquired: 0, krwCost: 0, spent: 0, balance: 0, avgRate: 0,
      };
    }
    return map[cur];
  };

  // 환율이 설정된 통화는 흐름이 없어도 지갑을 노출한다 (원화는 환전 대상이 아니므로 제외)
  Object.keys(currencyLabel).filter(c => c !== KRW).forEach(ensure);
  flows.forEach(f => {
    const w = ensure(f.currency);
    w.inflow += f.amount;
    if (f.amount > 0 && f.krw_cost > 0) {
      w.acquired += f.amount;
      w.krwCost += f.krw_cost;
    }
  });
  // 원화 현금 지출은 지갑에 넣지 않는다 — 원화를 따로 환전해 둔 기록이 있을 때만 추적
  const krwTracked = flows.some(f => f.currency === KRW);
  Object.keys(spending)
    .filter(cur => cur !== KRW || krwTracked)
    .forEach(cur => { ensure(cur).spent += spending[cur]; });

  return Object.values(map).map(w => ({
    ...w,
    balance: w.inflow - w.spent,
    avgRate: w.acquired > 0 ? w.krwCost / w.acquired : 0,
  })).sort((a, b) => (a.currency === KRW ? 1 : 0) - (b.currency === KRW ? 1 : 0)
      || a.currency.localeCompare(b.currency));
}

/**
 * 현금 관리 내역용 — 흐름(환전/정산/종료)과 실제 현금 사용 거래를 한 줄기로 합쳐
 * 날짜순으로 돌려준다. kind로 구분한다: 'flow' | 'spend'
 */
export function getEventCashLedger(db, eventId) {
  if (!db || !eventId) return [];

  const walletCurrencies = new Set(
    (db.exec('SELECT DISTINCT UPPER(currency) FROM event_countries WHERE event_id = ?', [eventId])[0]?.values || [])
      .map(r => String(r[0]))
  );

  const flows = getEventCashFlows(db, eventId);
  const rows = flows.map(f => ({ ...f, kind: 'flow' }));

  // 원화는 따로 환전해 둔 기록이 있을 때만 지갑으로 추적한다 (getEventWallets와 동일 규칙)
  const krwTracked = flows.some(f => f.currency === KRW);

  const res = db.exec(
    `SELECT id, date, budget_category, sub_category, detail, amount, foreign_amounts, split_group_id
     FROM transactions
     WHERE event_id = ? AND payment_method = '현금' AND COALESCE(is_cash_adjustment, 0) = 0
     ORDER BY date, id`,
    [eventId]
  );

  (res[0]?.values || []).forEach(([id, date, cat, sub, detail, amount, foreignJson, splitId]) => {
    let fa = {};
    try { fa = foreignJson ? JSON.parse(foreignJson) : {}; } catch (e) {}
    const matched = Object.entries(fa).filter(([cur, val]) =>
      walletCurrencies.has(String(cur).trim().toUpperCase()) && Number(val) > 0);

    // 현지 통화로 쓴 건 통화별로, 아니면 원화 지출로 한 줄
    const legs = matched.length
      ? matched.map(([cur, val]) => ({ currency: String(cur).trim().toUpperCase(), amount: -Number(val) }))
      : [{ currency: KRW, amount: -(Number(amount) || 0) }];

    legs.filter(leg => leg.currency !== KRW || krwTracked).forEach(leg => rows.push({
      id: `tx-${id}-${leg.currency}`,
      kind: 'spend',
      tx_id: id,
      date,
      type: 'spend',
      currency: leg.currency,
      amount: leg.amount,
      krw_cost: Number(amount) || 0,
      note: detail || [cat, sub].filter(Boolean).join(' / '),
      is_split: !!splitId,
    }));
  });

  // 같은 날짜면 흐름 먼저. 같은 종류끼리는 0을 돌려 원래 순서(id 순)를 유지한다 (sort는 안정 정렬)
  const kindOrder = r => (r.kind === 'flow' ? 0 : 1);
  return rows.sort((a, b) =>
    a.date.localeCompare(b.date) || kindOrder(a) - kindOrder(b));
}

/** 환전 기록에서 실효 환율을 구해 event_countries.exchange_rate에 반영한다. */
export function syncEventRateFromFlows(db, eventId, currency) {
  const cur = String(currency || '').trim().toUpperCase();
  if (!db || !eventId || !cur || cur === KRW) return;

  const res = db.exec(
    `SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(krw_cost), 0)
     FROM event_cash_flows
     WHERE event_id = ? AND UPPER(currency) = ? AND amount > 0 AND krw_cost > 0`,
    [eventId, cur]
  );
  const [qty, cost] = res[0]?.values[0] || [0, 0];
  if (!qty || !cost) return;

  const rate = Number(cost) / Number(qty);
  db.run('UPDATE event_countries SET exchange_rate = ? WHERE event_id = ? AND UPPER(currency) = ?',
    [rate, eventId, cur]);
}

function walletOf(db, eventId, currency) {
  const cur = String(currency || '').trim().toUpperCase();
  return getEventWallets(db, eventId).find(w => w.currency === cur) || null;
}

/**
 * 지갑의 원가 환율 — 평균 취득 환율, 없으면 일정에 설정된 환율 (원화는 1, 모르면 0).
 * 화면(종료 처리의 취득 원가·환차손익 표시)도 이 값을 써야 DB 계산과 어긋나지 않는다.
 */
export function getWalletRate(db, eventId, wallet) {
  if (!wallet) return 0;
  if (wallet.currency === KRW) return 1;
  if (wallet.avgRate) return wallet.avgRate;
  const c = getEventCountries(db, eventId)
    .find(x => String(x.currency).trim().toUpperCase() === wallet.currency);
  return c?.exchange_rate || 0;
}

/** 지갑의 현지 금액을 원화로 환산한다. 평균 환율이 없으면 일정에 설정된 환율을 쓴다. */
function walletKrw(db, eventId, wallet, foreignAmount) {
  return Math.round(foreignAmount * getWalletRate(db, eventId, wallet));
}

/** 가계부에 거래를 만들 때의 분류 검사 — 세부카테고리가 있는 카테고리면 세부카테고리도 필수 */
function requireCategory(db, budgetCategory, subCategory, what) {
  if (!budgetCategory) throw new Error(`${what} 카테고리를 선택하세요`);
  if (!subCategory && getSubCategories(db, budgetCategory).length > 0) {
    throw new Error(`${what} 세부카테고리를 선택하세요`);
  }
}

/**
 * 실물 정산 — 지갑에 실제로 남은 현금을 입력해 계산상 잔액과 맞춘다.
 *  mode 'expense' : 부족분을 '미기록 현금 지출'로 가계부에 기록 (잔액은 자동으로 맞춰짐)
 *  mode 'adjust'  : 가계부는 두고 지갑 잔액만 보정
 */
export function reconcileEventWallet(db, opts) {
  const cur = String(opts.currency || '').trim().toUpperCase();
  const wallet = walletOf(db, opts.event_id, cur);
  if (!wallet) throw new Error('지갑을 찾을 수 없습니다');

  const actual = Number(opts.actual);
  if (!isFinite(actual) || actual < 0) throw new Error('실제 잔액을 입력하세요');

  const diff = Number((actual - wallet.balance).toFixed(2));
  if (Math.abs(diff) < 0.005) return { diff: 0 };

  const date = opts.date || todayLocal();

  if (opts.mode === 'expense' && diff < 0) {
    requireCategory(db, opts.budget_category, opts.sub_category, '지출로 기록할');
    const missing = -diff;
    addTransaction(db, {
      payment_method: '현금',
      date,
      budget_category: opts.budget_category || '',
      sub_category: opts.sub_category || '',
      detail: opts.detail || '미기록 현금 지출 (정산)',
      amount: walletKrw(db, opts.event_id, wallet, missing),
      event_id: opts.event_id,
      foreign_amounts: cur === KRW ? {} : { [cur]: missing },
    });
    return { diff, mode: 'expense' };
  }

  addEventCashFlow(db, {
    event_id: opts.event_id,
    date,
    type: 'adjust',
    currency: cur,
    amount: diff,
    krw_cost: 0,
    note: opts.detail || '실물 정산',
  });
  return { diff, mode: 'adjust' };
}

/**
 * 여행 종료 처리 — 남은 현금을 정리한다.
 *  mode 'refund'    : 재환전해서 계좌로 입금 (received_krw, account_id)
 *  mode 'carryover' : 다른 일정으로 이월 (target_event_id) — 취득 원가도 함께 넘긴다
 *  mode 'writeoff'  : 남은 현금을 지갑에서 비움 (원화 현금으로 보관 등)
 * 재환전 시 환차손익을 계산해 돌려주고, record_fx가 참이면 가계부에도 반영한다.
 */
export function closeEventWallet(db, opts) {
  const cur = String(opts.currency || '').trim().toUpperCase();
  const wallet = walletOf(db, opts.event_id, cur);
  if (!wallet) throw new Error('지갑을 찾을 수 없습니다');

  const balance = Number(wallet.balance.toFixed(2));
  if (Math.abs(balance) < 0.005) return { closed: false };

  // 잔액이 음수면 환전 기록이 빠진 것 — 재환전·이월하면 가짜 환차익·빚 이월이 생긴다
  if (balance < 0 && opts.mode !== 'writeoff') {
    throw new Error('잔액이 음수인 지갑은 재환전·이월할 수 없습니다. 빠진 환전 기록을 추가하거나 "지갑에서 비우기"를 쓰세요.');
  }

  const date = opts.date || todayLocal();

  if (opts.mode === 'carryover') {
    if (!opts.target_event_id) throw new Error('이월할 일정을 선택하세요');
    const srcTitle = db.exec('SELECT title FROM calendar_events WHERE id = ?', [opts.event_id])[0]?.values[0][0] || '';
    const dstTitle = db.exec('SELECT title FROM calendar_events WHERE id = ?', [opts.target_event_id])[0]?.values[0][0] || '';

    return withTransaction(db, () => {
      const outId = addEventCashFlow(db, {
        event_id: opts.event_id, date, type: 'carryover_out', currency: cur,
        amount: -balance, krw_cost: 0, note: `${dstTitle}(으)로 이월`,
      });

      // 이월 대상에 해당 통화가 없으면 만들어 줘야 환율이 따라간다
      const hasCountry = getEventCountries(db, opts.target_event_id)
        .some(c => String(c.currency).trim().toUpperCase() === cur);
      if (!hasCountry && cur !== KRW) {
        addEventCountry(db, opts.target_event_id, wallet.country || cur, cur, wallet.avgRate || 0);
      }

      // 나감 ↔ 들어옴을 서로 연결해 두어, 한쪽을 지우면 짝도 함께 지운다
      const inId = addEventCashFlow(db, {
        event_id: opts.target_event_id, date, type: 'carryover_in', currency: cur,
        amount: balance, krw_cost: walletKrw(db, opts.event_id, wallet, balance),
        note: `${srcTitle}에서 이월`, linked_flow_id: outId,
      });
      db.run('UPDATE event_cash_flows SET linked_flow_id = ? WHERE id = ?', [inId, outId]);
      return { closed: true, mode: 'carryover', balance };
    });
  }

  if (opts.mode === 'refund') {
    const received = Math.round(Number(opts.received_krw) || 0);

    // 취득 원가 대비 실제로 회수한 금액의 차이 = 환차손익.
    // 원가를 모르면(환율 없음) 차이를 계산할 수 없으므로 기록하지 않는다.
    const basis = walletKrw(db, opts.event_id, wallet, balance);
    const fx = basis > 0 ? received - basis : 0;
    const recordFx = !!opts.record_fx && fx !== 0 && cur !== KRW;
    if (recordFx) requireCategory(db, opts.budget_category, opts.sub_category, '환차손익을 기록할');

    return withTransaction(db, () => {
      const flowId = addEventCashFlow(db, {
        event_id: opts.event_id, date, type: 'refund', currency: cur,
        amount: -balance, krw_cost: received, account_id: opts.account_id || null,
        note: opts.note || (cur === KRW ? '현금 입금' : '재환전 후 입금'),
      });

      if (recordFx) {
        const txId = addTransaction(db, {
          payment_method: '현금',
          date,
          budget_category: opts.budget_category,
          sub_category: opts.sub_category || '',
          detail: fx < 0 ? '환전 차손' : '환전 차익',
          amount: fx < 0 ? -fx : 0,
          discount_amount: fx > 0 ? fx : 0,
          event_id: opts.event_id,
          is_cash_adjustment: 1,
        });
        // 재환전 기록을 지우면 이 환차손익 거래도 함께 지운다
        db.run('UPDATE event_cash_flows SET linked_tx_id = ? WHERE id = ?', [txId, flowId]);
      }
      return { closed: true, mode: 'refund', balance, basis, fx, recordedFx: recordFx };
    });
  }

  addEventCashFlow(db, {
    event_id: opts.event_id, date, type: 'close', currency: cur,
    amount: -balance, krw_cost: 0, note: opts.note || '지갑 정리',
  });
  return { closed: true, mode: 'writeoff', balance };
}

// ── 캘린더 일정 유형 ────────────────────────────────────────────────

export function getCalendarEventTypes(db) {
  if (!db) return [];
  const res = db.exec(
    'SELECT id, value, label, color, sort_order, is_system, is_trip_type FROM calendar_event_types ORDER BY sort_order, id'
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => { const o = {}; columns.forEach((c, i) => o[c] = row[i]); return o; });
}

export function addCalendarEventType(db, { label, color }) {
  if (!label?.trim()) throw new Error('유형 이름을 입력하세요');
  const slug = label.trim().replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const value = (slug.replace(/_/g, '').length >= 2) ? slug : 'type_' + Date.now();
  const maxSort = db.exec(
    "SELECT COALESCE(MAX(sort_order), 0) FROM calendar_event_types WHERE value != 'general'"
  );
  const nextSort = (maxSort[0]?.values[0][0] ?? 0) + 1;
  db.run(
    'INSERT INTO calendar_event_types (value, label, color, sort_order, is_system, is_trip_type) VALUES (?, ?, ?, ?, 0, 0)',
    [value, label.trim(), color || '#9CA3AF', nextSort]
  );
}

export function updateCalendarEventType(db, id, { label, color }) {
  if (!label?.trim()) throw new Error('유형 이름을 입력하세요');
  db.run('UPDATE calendar_event_types SET label=?, color=? WHERE id=?', [label.trim(), color, id]);
}

export function deleteCalendarEventType(db, id) {
  const row = db.exec('SELECT value, is_system FROM calendar_event_types WHERE id = ?', [id]);
  if (!row.length || !row[0].values.length) throw new Error('유형을 찾을 수 없습니다');
  const [value, isSystem] = row[0].values[0];
  if (isSystem) throw new Error('시스템 유형은 삭제할 수 없습니다');
  const usage = db.exec('SELECT COUNT(*) FROM calendar_events WHERE event_type = ?', [value]);
  const cnt = usage[0]?.values[0][0] || 0;
  if (cnt > 0) throw new Error(`${cnt}개 일정에서 사용 중입니다`);
  db.run('DELETE FROM calendar_event_types WHERE id = ?', [id]);
}

/**
 * 일정 유형을 targetIndex로 옮긴다 (B-026).
 * targetIndex는 옮기는 유형을 뺀 목록 기준이다 (moveItemToPosition·reorderFavorite와 같은 규칙).
 */
export function moveCalendarEventType(db, id, targetIndex) {
  const all = getCalendarEventTypes(db);
  const fromIdx = all.findIndex(t => t.id === id);
  if (fromIdx === -1) return;
  const reordered = [...all];
  const [moved] = reordered.splice(fromIdx, 1);
  const clamped = Math.max(0, Math.min(targetIndex, reordered.length));
  reordered.splice(clamped, 0, moved);
  withTransaction(db, () => {
    reordered.forEach((t, i) => {
      db.run('UPDATE calendar_event_types SET sort_order=? WHERE id=?', [i, t.id]);
    });
  });
}

export function getCalendarEventTypeUsageCount(db, value) {
  if (!db) return 0;
  const res = db.exec('SELECT COUNT(*) FROM calendar_events WHERE event_type = ?', [value]);
  return res[0]?.values[0][0] || 0;
}

export function setCalendarEventTypeTripFlag(db, id, isTripType) {
  db.run('UPDATE calendar_event_types SET is_trip_type=? WHERE id=?', [isTripType ? 1 : 0, id]);
}

// ── 캘린더 이벤트 요약 (요약 탭 일정별) ────────────────────────────

function aggregateEventRows(rows, keyField) {
  const map = {};
  const order = [];
  rows.forEach(obj => {
    const key = obj[keyField];
    if (!map[key]) {
      map[key] = {
        event_id: obj.event_id, event_title: obj.event_title,
        date_from: obj.date_from || '', date_to: obj.date_to || '',
        event_type: obj.event_type, color: obj.color,
        total: 0, discount: 0, cnt: 0, foreignTotals: {},
      };
      order.push(key);
    }
    const e = map[key];
    e.total += obj.amount || 0;
    e.discount += obj.discount_amount || 0;
    e.cnt += 1;
    if (obj.foreign_amounts) {
      try {
        Object.entries(JSON.parse(obj.foreign_amounts)).forEach(([cur, amt]) => {
          e.foreignTotals[cur] = (e.foreignTotals[cur] || 0) + Number(amt);
        });
      } catch {}
    }
  });
  return order.map(k => map[k]).sort((a, b) => b.total - a.total);
}

export function getEventSummary(db, eventType = null) {
  if (!db) return [];
  let q = `SELECT ce.id as event_id, ce.title as event_title,
                  ce.date_from, ce.date_to, ce.event_type, ce.color,
                  t.amount, t.discount_amount, t.foreign_amounts
           FROM transactions t
           JOIN calendar_events ce ON t.event_id = ce.id
           WHERE t.event_id IS NOT NULL`;
  const params = [];
  if (eventType) { q += ' AND ce.event_type = ?'; params.push(eventType); }
  const res = db.exec(q, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  const rows = values.map(row => { const o = {}; columns.forEach((c, i) => o[c] = row[i]); return o; });
  return aggregateEventRows(rows, 'event_id');
}

export function getEventDetailSummary(db, eventId) {
  if (!db || !eventId) return [];
  const res = db.exec(
    'SELECT sub_category, amount, discount_amount, foreign_amounts FROM transactions WHERE event_id = ?',
    [eventId]
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  const subMap = {};
  const subOrder = [];
  values.forEach(row => {
    const obj = {}; columns.forEach((c, i) => obj[c] = row[i]);
    const key = obj.sub_category || '(미분류)';
    if (!subMap[key]) { subMap[key] = { sub_category: key, total: 0, discount: 0, cnt: 0, foreignTotals: {} }; subOrder.push(key); }
    const s = subMap[key];
    s.total += obj.amount || 0;
    s.discount += obj.discount_amount || 0;
    s.cnt += 1;
    if (obj.foreign_amounts) {
      try { Object.entries(JSON.parse(obj.foreign_amounts)).forEach(([cur, amt]) => { s.foreignTotals[cur] = (s.foreignTotals[cur] || 0) + Number(amt); }); } catch {}
    }
  });
  return subOrder.map(k => subMap[k]).sort((a, b) => b.total - a.total);
}

/**
 * 일정에 연결된 거래의 결제수단별 합계.
 *  - eventId가 있으면 그 일정만 (event_type은 '')
 *  - 없으면 결제수단 × 일정 유형별 소계. eventType을 주면 그 유형의 일정만 (요약 화면의 유형 필터)
 */
export function getEventPaymentMethodSummary(db, eventId = null, eventType = null) {
  if (!db) return [];
  let q, params;
  if (eventId) {
    q = `SELECT t.payment_method, '' as event_type,
                SUM(t.amount) as total, SUM(t.discount_amount) as discount, COUNT(*) as cnt
         FROM transactions t WHERE t.event_id = ?
         GROUP BY t.payment_method ORDER BY total DESC`;
    params = [eventId];
  } else {
    q = `SELECT t.payment_method, ce.event_type,
                SUM(t.amount) as total, SUM(t.discount_amount) as discount, COUNT(*) as cnt
         FROM transactions t
         JOIN calendar_events ce ON t.event_id = ce.id
         WHERE t.event_id IS NOT NULL${eventType ? ' AND ce.event_type = ?' : ''}
         GROUP BY t.payment_method, ce.event_type
         ORDER BY t.payment_method, total DESC`;
    params = eventType ? [eventType] : [];
  }
  return dbRowsToObjects(db.exec(q, params));
}

// ── 기간별 요약 (월·연·기간 × 카테고리·세부카테고리·결제수단) ──────────────
// 아래 9개 함수는 기간 조건과 묶는 기준만 다르다. 쿼리는 summarizeTransactions 한 곳에서 만든다.

const SUMMARY_GROUP_COLUMNS = ['budget_category', 'sub_category', 'payment_method'];

/** 기간 조건 — { month } | { year } | { from, to }. month가 비어 있으면 전체 기간 (연·기간은 항상 적용) */
function summaryPeriod(period) {
  if ('month' in period) {
    return period.month ? { conds: ["strftime('%Y-%m', date) = ?"], params: [period.month] } : { conds: [], params: [] };
  }
  if ('year' in period) return { conds: ["strftime('%Y', date) = ?"], params: [period.year] };
  return { conds: ['date >= ?', 'date <= ?'], params: [period.from, period.to] };
}

/**
 * 거래를 groupBy 열로 묶은 합계: [{ [groupBy], total, discount, cnt }] (total 내림차순).
 * 세부카테고리 요약은 항상 budgetCategory 한 카테고리 안에서 묶는다 (드릴다운).
 */
function summarizeTransactions(db, groupBy, period, budgetCategory) {
  if (!SUMMARY_GROUP_COLUMNS.includes(groupBy)) throw new Error(`알 수 없는 요약 기준: ${groupBy}`);
  const { conds, params } = summaryPeriod(period);
  if (groupBy === 'sub_category') {
    conds.push('budget_category = ?');
    params.push(budgetCategory);
  }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  return dbRowsToObjects(db.exec(
    `SELECT ${groupBy}, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
     FROM transactions${where}
     GROUP BY ${groupBy} ORDER BY total DESC`,
    params
  ));
}

export function getMonthlySummary(db, month) {
  return summarizeTransactions(db, 'budget_category', { month });
}

export function getMonthlySubCategorySummary(db, month, budgetCategory) {
  return summarizeTransactions(db, 'sub_category', { month }, budgetCategory);
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
  return summarizeTransactions(db, 'payment_method', { month });
}

export function getAvailableYears(db) {
  const result = db.exec(
    "SELECT DISTINCT strftime('%Y', date) as year FROM transactions ORDER BY year DESC"
  );
  return result.length ? result[0].values.map(r => r[0]) : [];
}

export function getYearlySummary(db, year) {
  return summarizeTransactions(db, 'budget_category', { year });
}

export function getYearlySubCategorySummary(db, year, budgetCategory) {
  return summarizeTransactions(db, 'sub_category', { year }, budgetCategory);
}

export function getYearlyPaymentMethodSummary(db, year) {
  return summarizeTransactions(db, 'payment_method', { year });
}

export function getRangeSummary(db, dateFrom, dateTo) {
  return summarizeTransactions(db, 'budget_category', { from: dateFrom, to: dateTo });
}

export function getRangeSubCategorySummary(db, dateFrom, dateTo, budgetCategory) {
  return summarizeTransactions(db, 'sub_category', { from: dateFrom, to: dateTo }, budgetCategory);
}

export function getRangePaymentMethodSummary(db, dateFrom, dateTo) {
  return summarizeTransactions(db, 'payment_method', { from: dateFrom, to: dateTo });
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

/**
 * 여행 유형 일정 선택 시 자동으로 채울 가계부 카테고리.
 * 설정한 적이 없으면 이름에 '여행'이 들어간 카테고리를 자동 추론한다.
 * '사용 안 함'은 빈 값으로 저장되며, 이때는 추론하지 않는다.
 * 반환값은 현재 숨겨지지 않은 카테고리일 때만 유효하다.
 */
export function getTripDefaultCategory(db) {
  if (!db) return '';
  const categories = getBudgetCategories(db);
  const saved = getSetting(db, 'trip_default_category', null);
  if (saved !== null) return saved && categories.includes(saved) ? saved : '';
  return categories.find(c => c === '여행') || categories.find(c => c.includes('여행')) || '';
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
  return def !== '' ? Number(def) : null;
}

export function setMonthlyGoal(db, yearMonth, amount) {
  db.run('INSERT OR REPLACE INTO monthly_goals (year_month, goal_amount) VALUES (?, ?)', [yearMonth, amount]);
}

/**
 * 상시 목표금액 변경·해제 시 호출. newAmount가 null이면 상시 목표를 해제한다.
 * 기존 거래내역이 있는 월 중 개별 설정이 없는 월을 현재(구) 기본값으로 스냅샷한 뒤 새 값을 저장.
 * 이후 새로 생기는 월만 신규 기본값이 적용된다.
 */
export function changeDefaultMonthlyGoal(db, newAmount) {
  withTransaction(db, () => {
    const oldDefault = getSetting(db, 'default_monthly_goal', '');
    if (oldDefault !== '') {
      const oldVal = Math.round(Number(oldDefault)) || 0;
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
    setSetting(db, 'default_monthly_goal', newAmount === null ? '' : String(newAmount));
  });
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
  const defGoalNum = defaultGoal !== '' ? Number(defaultGoal) : null;
  return totals.map(r => ({
    ...r,
    goal: goalsMap[r.month] !== undefined ? goalsMap[r.month] : defGoalNum,
  }));
}

// ── 정기지출 템플릿 ───────────────────────────────────────────────

export function getRecurringTransactions(db) {
  const res = db.exec(
    `SELECT id, payment_method, budget_category, sub_category, detail, amount, discount_amount, discount_note, frequency, day_of_month, month_of_year, note
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
    `INSERT INTO recurring_transactions (payment_method, budget_category, sub_category, detail, amount, discount_amount, discount_note, frequency, day_of_month, month_of_year, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

// ── 즐겨찾기 템플릿 ───────────────────────────────────────────────

export function getFavorites(db) {
  const res = db.exec(
    `SELECT id, name, payment_method, budget_category, sub_category, detail, amount, sort_order, use_count, last_used_at, created_at
     FROM favorite_transactions
     ORDER BY sort_order ASC, created_at DESC`
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

/** 즐겨찾기 금액은 선택 항목 — 비었거나 0 이하면 NULL로 저장한다 */
function normalizeFavoriteAmount(amount) {
  const n = Number(amount);
  return amount === '' || amount === null || amount === undefined || !isFinite(n) || n <= 0
    ? null : Math.round(n);
}

export function addFavorite(db, data) {
  const maxSortRes = db.exec('SELECT COALESCE(MAX(sort_order), -1) as maxSort FROM favorite_transactions');
  const maxSort = maxSortRes.length > 0 ? maxSortRes[0].values[0][0] : -1;

  db.run(
    `INSERT INTO favorite_transactions (name, payment_method, budget_category, sub_category, detail, amount, sort_order, use_count, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.name, data.payment_method, data.budget_category,
      data.sub_category || '', data.detail || '', normalizeFavoriteAmount(data.amount),
      maxSort + 1, 0, null,
    ]
  );
}

export function updateFavorite(db, id, data) {
  db.run(
    `UPDATE favorite_transactions SET name=?, payment_method=?, budget_category=?, sub_category=?, detail=?, amount=? WHERE id=?`,
    [
      data.name, data.payment_method, data.budget_category,
      data.sub_category || '', data.detail || '', normalizeFavoriteAmount(data.amount), id,
    ]
  );
}

export function deleteFavorite(db, id) {
  db.run('DELETE FROM favorite_transactions WHERE id = ?', [id]);
}

export function recordFavoriteUse(db, id) {
  const now = new Date().toLocaleString('sv-SE');
  db.run(
    `UPDATE favorite_transactions SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`,
    [now, id]
  );
}

/**
 * 즐겨찾기를 newPosition으로 옮긴다 (B-018). newPosition은 옮기는 항목을 뺀 목록 기준이다.
 * 순서 기준은 getFavorites와 같고(sort_order, created_at DESC), 전체를 0..n-1로 다시 번호 매긴다.
 */
export function reorderFavorite(db, id, newPosition) {
  const res = db.exec('SELECT id FROM favorite_transactions ORDER BY sort_order ASC, created_at DESC, id DESC');
  const ids = (res[0]?.values || []).map(([itemId]) => itemId).filter(itemId => itemId !== id);
  if (ids.length === (res[0]?.values.length || 0)) return; // 없는 id
  const clamped = Math.max(0, Math.min(newPosition, ids.length));
  ids.splice(clamped, 0, id);
  withTransaction(db, () => {
    ids.forEach((itemId, i) => {
      db.run('UPDATE favorite_transactions SET sort_order = ? WHERE id = ?', [i, itemId]);
    });
  });
}

// ── 스마트 패턴: 자동 결제수단 선택 ─────────────────────────────────

// 자동 결제수단 기준: 그 세부카테고리의 최근 20건 중 10건 이상이고, 한 결제수단이 80% 이상
const AUTO_PM_SAMPLE = 20;
const AUTO_PM_MIN = 10;
const AUTO_PM_RATIO = 0.8;

/** 세부카테고리의 자동 결제수단 후보와 근거 { payment_method, count, total } — 기준 미달이면 null */
function autoPaymentStats(db, subCategory) {
  const res = db.exec(
    `SELECT payment_method
     FROM transactions
     WHERE sub_category = ? AND payment_method IN (SELECT name FROM payment_methods WHERE is_hidden = 0)
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [subCategory, AUTO_PM_SAMPLE]
  );
  const methods = (res[0]?.values || []).map(r => r[0]);
  if (methods.length < AUTO_PM_MIN) return null;
  const counts = {};
  methods.forEach(m => { counts[m] = (counts[m] || 0) + 1; });
  const [paymentMethod, count] = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
  if (count / methods.length < AUTO_PM_RATIO) return null;
  return { payment_method: paymentMethod, count, total: methods.length };
}

/** 세부카테고리를 고르면 자동으로 채울 결제수단. 설정에서 끈 패턴은 쓰지 않는다 (B-058). */
export function getAutoPaymentMethod(db, subCategory) {
  if (!subCategory) return null;
  const disabled = db.exec('SELECT is_disabled FROM auto_pattern_settings WHERE sub_category = ?', [subCategory]);
  if (disabled[0]?.values[0]?.[0]) return null;
  return autoPaymentStats(db, subCategory)?.payment_method || null;
}

/**
 * 세부내역별 입력 습관 — 같은 세부내역을 어떤 카테고리·결제수단으로 적어 왔는지.
 * 영수증 AI가 "기존 데이터 기준"으로 추천할 때 쓴다. 최근 sinceMonths개월, 많이 쓴 순.
 */
export function getDetailPatterns(db, { sinceMonths = 12, limit = 500 } = {}) {
  if (!db) return [];
  const d = new Date();
  d.setMonth(d.getMonth() - sinceMonths);
  const since = toDateStr(d);
  const res = db.exec(
    `SELECT detail, budget_category, sub_category, payment_method,
            COUNT(*) AS cnt, MAX(date) AS last_date
     FROM transactions
     WHERE detail != '' AND date >= ? AND COALESCE(is_cash_adjustment, 0) = 0
     GROUP BY detail, budget_category, sub_category, payment_method
     ORDER BY cnt DESC, last_date DESC
     LIMIT ?`,
    [since, limit]
  );
  return dbRowsToObjects(res).map(r => ({ ...r, cnt: Number(r.cnt) }));
}

/**
 * 설정 화면의 자동 결제수단 패턴 목록 — 실제 자동 선택(getAutoPaymentMethod)과 같은 기준으로 계산한다 (B-028, B-058).
 * 최근 거래 100건에 나온 세부카테고리 중 기준을 넘는 것만 보여 준다. 반환: [{ sub_category, payment_method, count, total, is_disabled }]
 */
export function getDetectedPatterns(db) {
  const subs = db.exec(
    `SELECT DISTINCT sub_category FROM (
       SELECT sub_category FROM transactions
       WHERE COALESCE(sub_category, '') != ''
       ORDER BY created_at DESC, id DESC
       LIMIT 100
     ) ORDER BY sub_category`
  )[0]?.values.map(r => r[0]) || [];

  return subs.map(sub => {
    const stats = autoPaymentStats(db, sub);
    if (!stats) return null;
    const disabled = db.exec('SELECT is_disabled FROM auto_pattern_settings WHERE sub_category = ?', [sub]);
    return { sub_category: sub, ...stats, is_disabled: disabled[0]?.values[0]?.[0] ? 1 : 0 };
  }).filter(Boolean);
}

export function toggleAutoPattern(db, subCategory, isDisabled) {
  db.run(
    `INSERT OR REPLACE INTO auto_pattern_settings (sub_category, is_disabled) VALUES (?, ?)`,
    [subCategory, isDisabled ? 1 : 0]
  );
}

export function deleteAutoPattern(db, subCategory) {
  db.run('DELETE FROM auto_pattern_settings WHERE sub_category = ?', [subCategory]);
}

// ── 즐겨찾기 자동 추천 ──────────────────────────────────────────

export function getSuggestionLog(db, patternKey) {
  const res = db.exec('SELECT * FROM pattern_suggestion_log WHERE pattern_key = ?', [patternKey]);
  if (!res.length) return null;
  const { columns, values } = res[0];
  if (!values.length) return null;

  const obj = {};
  columns.forEach((col, i) => { obj[col] = values[0][i]; });
  return obj;
}

export function recordSuggestDismiss(db, patternKey, currentTxCount) {
  const log = getSuggestionLog(db, patternKey);
  const newDismissCount = (log?.dismiss_count ?? 0) + 1;
  const shouldNeverSuggest = newDismissCount >= 3 ? 1 : 0;

  db.run(
    `INSERT OR REPLACE INTO pattern_suggestion_log (pattern_key, suggest_count, dismiss_count, never_suggest, last_suggest_tx_count)
     VALUES (?, ?, ?, ?, ?)`,
    [patternKey, log?.suggest_count ?? 0, newDismissCount, shouldNeverSuggest, currentTxCount]
  );
}

export function recordNeverSuggest(db, patternKey) {
  const log = getSuggestionLog(db, patternKey);
  db.run(
    `INSERT OR REPLACE INTO pattern_suggestion_log (pattern_key, suggest_count, dismiss_count, never_suggest, last_suggest_tx_count)
     VALUES (?, ?, ?, 1, ?)`,
    [patternKey, log?.suggest_count ?? 0, log?.dismiss_count ?? 0, log?.last_suggest_tx_count ?? 0]
  );
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

const ymOf = toYearMonth;

function nextYm(ym) {
  const [y, m] = ym.split('-').map(Number);
  return ymOf(new Date(y, m, 1)); // m은 1부터 → 그대로 넣으면 다음 달
}

const AUTO_REGISTER_MAX_BACKFILL = 12;

/**
 * 정기지출 자동등록 — 오늘 기준 두 달 뒤까지 등록한다.
 * 마지막으로 등록한 달 다음부터 목표 달까지 빠진 달을 모두 채운다 (B-010: 앱을 한 달 넘게 안 열어도 누락 없음).
 * 처음 등록하는 항목은 목표 달만 등록한다 (이미 손으로 적은 이번 달 몫과 겹치지 않게).
 * 이미 등록한 달은 recurring_registration_log(UNIQUE)로 다시 만들지 않는다.
 */
export function runAutoRegister(db, now = new Date()) {
  const targetYearMonth = ymOf(new Date(now.getFullYear(), now.getMonth() + 2, 1));
  const recurring = getRecurringTransactions(db);
  let count = 0;
  const months = new Set();

  withTransaction(db, () => {
    recurring.forEach(r => {
      const last = db.exec(
        'SELECT MAX(registered_for_month) FROM recurring_registration_log WHERE recurring_id = ?',
        [r.id]
      )[0]?.values[0]?.[0] || null;

      const candidates = [];
      if (!last) {
        candidates.push(targetYearMonth);
      } else {
        for (let ym = nextYm(last); ym <= targetYearMonth; ym = nextYm(ym)) candidates.push(ym);
      }

      candidates.slice(-AUTO_REGISTER_MAX_BACKFILL).forEach(ym => {
        const [year, month] = ym.split('-').map(Number);
        if (r.frequency === 'annual' && Number(r.month_of_year) !== month) return;

        const alreadyDone = db.exec(
          'SELECT 1 FROM recurring_registration_log WHERE recurring_id = ? AND registered_for_month = ?',
          [r.id, ym]
        );
        if (alreadyDone[0]?.values.length) return;

        const day = resolveDay(year, month, r.day_of_month);
        const txDate = `${ym}-${String(day).padStart(2, '0')}`;

        // 자동 할인 계산: template에 할인이 없으면 결제수단 규칙 적용
        let discountAmt = r.discount_amount || 0;
        const discountNote = r.discount_note || '';
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
        const txId = db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] || null;

        db.run(
          'INSERT OR IGNORE INTO recurring_registration_log (recurring_id, registered_for_month, transaction_id) VALUES (?, ?, ?)',
          [r.id, ym, txId]
        );
        count++;
        months.add(ym);
      });
    });
  });

  return { count, targetYearMonth, months: [...months].sort() };
}

// ── 계좌 관리 ────────────────────────────────────────────────────

function dbRowsToObjects(result) {
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getAllAccounts(db) {
  const res = db.exec('SELECT * FROM accounts WHERE is_active = 1 ORDER BY sort_order, id');
  return dbRowsToObjects(res);
}

export function getAccount(db, id) {
  const res = db.exec('SELECT * FROM accounts WHERE id = ?', [id]);
  const rows = dbRowsToObjects(res);
  return rows[0] || null;
}

/**
 * 각 계좌의 잔액 기준일(balance_date)부터 오늘까지 거래 합계 (B-022)
 * 실제 현재 잔액 = current_balance(기준일 시작 잔액) + 이 합계.
 * 기준일 이전 거래는 이미 current_balance에 들어 있으므로 더하지 않는다. 기준일이 비었으면 전부 더한다.
 */
export function getAccountsActualBalances(db) {
  const today = new Date();
  const todayYmd = toDateStr(today);
  const res = db.exec(
    `SELECT t.account_id,
            COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE -t.amount END), 0) AS tx_sum
     FROM account_transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE t.date <= ? AND t.date >= COALESCE(a.balance_date, '')
     GROUP BY t.account_id`,
    [todayYmd]
  );
  const txSums = {};
  if (res.length) res[0].values.forEach(([id, sum]) => { txSums[id] = sum; });
  return txSums;
}

export function getDefaultAccount(db) {
  const res = db.exec('SELECT * FROM accounts WHERE is_default = 1 AND is_active = 1 ORDER BY sort_order, id LIMIT 1');
  const rows = dbRowsToObjects(res);
  return rows[0] || null;
}

// 기본 계좌는 하나만 — 이 계좌를 기본으로 하면 나머지는 해제한다 (B-023)
export function addAccount(db, data) {
  return withTransaction(db, () => {
    const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), -1) FROM accounts');
    const nextSort = (maxSort[0]?.values[0][0] ?? -1) + 1;
    if (data.is_default) db.run('UPDATE accounts SET is_default = 0 WHERE is_default = 1');
    db.run(
      `INSERT INTO accounts (name, bank, account_number, current_balance, balance_date, danger_threshold, is_default, note, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.name || '', data.bank || '', data.account_number || '',
       data.current_balance || 0, data.balance_date || '', data.danger_threshold || 0,
       data.is_default ? 1 : 0, data.note || '', nextSort]
    );
    const res = db.exec('SELECT last_insert_rowid()');
    return res[0].values[0][0];
  });
}

export function updateAccount(db, id, data) {
  withTransaction(db, () => {
    if (data.is_default) db.run('UPDATE accounts SET is_default = 0 WHERE is_default = 1 AND id != ?', [id]);
    db.run(
      `UPDATE accounts SET name=?, bank=?, account_number=?, current_balance=?, balance_date=?,
       danger_threshold=?, is_default=?, note=? WHERE id=?`,
      [data.name || '', data.bank || '', data.account_number || '',
       data.current_balance || 0, data.balance_date || '', data.danger_threshold || 0,
       data.is_default ? 1 : 0, data.note || '', id]
    );
  });
}

export function setDefaultAccount(db, id) {
  withTransaction(db, () => {
    db.run('UPDATE accounts SET is_default = 0 WHERE is_default = 1');
    if (id) db.run('UPDATE accounts SET is_default = 1 WHERE id = ?', [id]);
  });
}

export function deleteAccount(db, id) {
  db.run('UPDATE accounts SET is_active = 0 WHERE id = ?', [id]);
}

export function reorderAccounts(db, orderedIds) {
  orderedIds.forEach((id, i) => {
    db.run('UPDATE accounts SET sort_order = ? WHERE id = ?', [i, id]);
  });
}

// ── 고정 입출금 항목 ─────────────────────────────────────────────

export function getRecurringItems(db, accountId) {
  const res = db.exec(
    'SELECT * FROM account_recurring_items WHERE account_id = ? AND is_active = 1 ORDER BY sort_order, id',
    [accountId]
  );
  return dbRowsToObjects(res);
}

export function addRecurringItem(db, data) {
  const maxSort = db.exec(
    'SELECT COALESCE(MAX(sort_order), -1) FROM account_recurring_items WHERE account_id = ?',
    [data.account_id]
  );
  const nextSort = (maxSort[0]?.values[0][0] ?? -1) + 1;
  db.run(
    `INSERT INTO account_recurring_items
       (account_id, name, type, day_of_month, holiday_rule, amount_type, fixed_amount,
        auto_payment_method, auto_register, register_months_ahead, note, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.account_id, data.name || '', data.type || 'expense',
     data.day_of_month || 1, data.holiday_rule || 'next_business',
     data.amount_type || 'fixed', data.fixed_amount || 0,
     data.auto_payment_method || '', data.auto_register !== false ? 1 : 0,
     data.register_months_ahead || 2, data.note || '', nextSort]
  );
}

/**
 * 고정항목 수정 — 이미 만들어 둔 미래 자동 내역 중 사용자가 고치지 않은 것은 새 조건으로 다시 만든다 (B-009).
 */
export function updateRecurringItem(db, id, data) {
  withTransaction(db, () => {
    db.run(
      `UPDATE account_recurring_items SET name=?, type=?, day_of_month=?, holiday_rule=?,
       amount_type=?, fixed_amount=?, auto_payment_method=?, auto_register=?,
       register_months_ahead=?, note=? WHERE id=?`,
      [data.name || '', data.type || 'expense', data.day_of_month || 1,
       data.holiday_rule || 'next_business', data.amount_type || 'fixed',
       data.fixed_amount || 0, data.auto_payment_method || '',
       data.auto_register !== false ? 1 : 0, data.register_months_ahead || 2,
       data.note || '', id]
    );
    db.run(
      'DELETE FROM account_transactions WHERE recurring_item_id = ? AND is_modified = 0 AND date > ?',
      [id, todayLocal()]
    );
    const item = dbRowsToObjects(db.exec('SELECT * FROM account_recurring_items WHERE id = ?', [id]))[0];
    const account = item && getAccount(db, item.account_id);
    if (item && account && account.is_active && item.auto_register) {
      registerAccountItem(db, account, item, new Date());
    }
  });
}

/** 고정항목 삭제 — 사용자가 고치지 않은 미래 자동 내역도 함께 지운다 (B-009) */
export function deleteRecurringItem(db, id) {
  withTransaction(db, () => {
    db.run('UPDATE account_recurring_items SET is_active = 0 WHERE id = ?', [id]);
    db.run(
      'DELETE FROM account_transactions WHERE recurring_item_id = ? AND is_modified = 0 AND date > ?',
      [id, todayLocal()]
    );
  });
}

// ── 계좌 거래 내역 ───────────────────────────────────────────────

export function getAccountTransactions(db, accountId, opts = {}) {
  let q = 'SELECT * FROM account_transactions WHERE account_id = ?';
  const params = [accountId];
  if (opts.dateFrom) { q += ' AND date >= ?'; params.push(opts.dateFrom); }
  if (opts.dateTo)   { q += ' AND date <= ?'; params.push(opts.dateTo); }
  q += ' ORDER BY date DESC, id DESC';
  const res = db.exec(q, params);
  return dbRowsToObjects(res);
}

export function addAccountTransaction(db, data) {
  db.run(
    `INSERT INTO account_transactions
       (account_id, date, type, category, description, amount, base_amount,
        recurring_item_id, recurring_month, is_auto_generated, is_modified, is_imported)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.account_id, data.date, data.type || 'expense', data.category || '',
     data.description || '', data.amount, data.base_amount ?? null,
     data.recurring_item_id ?? null,
     data.recurring_item_id ? (data.recurring_month || String(data.date).slice(0, 7)) : '',
     data.is_auto_generated ? 1 : 0, data.is_modified ? 1 : 0, data.is_imported ? 1 : 0]
  );
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
}

export function updateAccountTransaction(db, id, data) {
  db.run(
    `UPDATE account_transactions SET date=?, type=?, category=?, description=?, amount=?,
     is_modified=1 WHERE id=?`,
    [data.date, data.type || 'expense', data.category || '', data.description || '',
     data.amount, id]
  );
}

/**
 * 계좌 내역 삭제. 고정항목에서 자동 생성된 내역이면 그 달을 '건너뜀'으로 기록해
 * 자동등록이 다시 만들지 않게 한다 (B-008).
 */
export function deleteAccountTransaction(db, id) {
  withTransaction(db, () => {
    const row = db.exec(
      'SELECT recurring_item_id, recurring_month FROM account_transactions WHERE id = ?', [id]
    )[0]?.values[0];
    if (row && row[0] && row[1]) {
      db.run(
        'INSERT OR IGNORE INTO account_recurring_skips (recurring_item_id, recurring_month) VALUES (?, ?)',
        [row[0], row[1]]
      );
    }
    db.run('DELETE FROM account_transactions WHERE id = ?', [id]);
  });
}

export function bulkInsertAccountTransactions(db, accountId, rows) {
  // withTransaction(SAVEPOINT)이라 다른 트랜잭션 안에서 불러도 안전하다 (B-059)
  withTransaction(db, () => {
    rows.forEach(row => {
      db.run(
        `INSERT INTO account_transactions
           (account_id, date, type, description, amount, is_imported)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [accountId, row.date, row.type, row.description, row.amount]
      );
    });
  });
}

// ── 카드 결제 추정액 집계 ────────────────────────────────────────

export function getCardPaymentTotal(db, paymentMethod, yearMonth) {
  if (!paymentMethod || !yearMonth) return 0;
  const res = db.exec(
    `SELECT COALESCE(SUM(amount), 0)
     FROM transactions WHERE payment_method = ? AND strftime('%Y-%m', date) = ?`,
    [paymentMethod, yearMonth]
  );
  return res[0]?.values[0][0] || 0;
}

// ── 계좌 자동 등록 ───────────────────────────────────────────────
// 자동 생성 내역은 (고정항목, 대상 월)로 식별한다. 휴일 보정으로 실제 날짜가 다른 달이 되어도
// 대상 월은 그대로라 중복이 생기지 않는다 (B-007). UNIQUE 인덱스가 이를 보장한다.

/** 고정항목의 해당 월 실제 처리일 (말일 보정 + 휴일 규칙) */
function recurringDateFor(item, ym) {
  const [year, month] = ym.split('-').map(Number);
  const day = resolveDay(year, month, Number(item.day_of_month) || 0);
  const rawDate = `${ym}-${String(day).padStart(2, '0')}`;
  if (item.holiday_rule === 'next_business') return getNextBusinessDay(rawDate);
  if (item.holiday_rule === 'prev_business') return getPrevBusinessDay(rawDate);
  return rawDate;
}

/** 고정항목 하나를 이번 달부터 register_months_ahead개월 뒤까지 등록·갱신한다. 새로 만든 건수를 돌려준다. */
function registerAccountItem(db, account, item, now) {
  const today = todayLocal();
  const monthsAhead = item.register_months_ahead || 2;
  let count = 0;

  for (let m = 0; m <= monthsAhead; m++) {
    const ym = ymOf(new Date(now.getFullYear(), now.getMonth() + m, 1));
    const [year, month] = ym.split('-').map(Number);
    const actualDate = recurringDateFor(item, ym);

    let amount = item.fixed_amount || 0;
    let baseAmount = null;
    if (item.amount_type === 'auto' && item.auto_payment_method) {
      amount = getCardPaymentTotal(db, item.auto_payment_method, ymOf(new Date(year, month - 2, 1)));
      baseAmount = amount;
    }

    const skipped = db.exec(
      'SELECT 1 FROM account_recurring_skips WHERE recurring_item_id = ? AND recurring_month = ?',
      [item.id, ym]
    );
    if (skipped[0]?.values.length) continue;

    const existing = dbRowsToObjects(db.exec(
      `SELECT id, date, amount, is_modified FROM account_transactions
       WHERE recurring_item_id = ? AND recurring_month = ?`,
      [item.id, ym]
    ))[0];

    if (existing) {
      if (existing.is_modified) continue; // 사용자가 고친 내역은 건드리지 않는다
      // auto 금액이 바뀌었으면 갱신
      if (item.amount_type === 'auto' && amount > 0 && amount !== existing.amount) {
        db.run('UPDATE account_transactions SET amount = ?, base_amount = ? WHERE id = ?',
          [amount, baseAmount, existing.id]);
      }
      // 공휴일 데이터가 바뀌어 처리일이 달라졌으면 미래 내역만 고친다 (B-006)
      if (existing.date !== actualDate && existing.date > today && actualDate > today) {
        db.run('UPDATE account_transactions SET date = ? WHERE id = ?', [actualDate, existing.id]);
      }
      continue;
    }

    if (amount === 0) continue;

    db.run(
      `INSERT INTO account_transactions
         (account_id, date, type, category, description, amount, base_amount,
          recurring_item_id, recurring_month, is_auto_generated, is_modified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
      [account.id, actualDate, item.type, '', item.name, amount, baseAmount, item.id, ym]
    );
    count++;
  }
  return count;
}

export function runAccountAutoRegister(db, now = new Date()) {
  let totalCount = 0;
  withTransaction(db, () => {
    getAllAccounts(db).forEach(account => {
      getRecurringItems(db, account.id)
        .filter(i => i.auto_register)
        .forEach(item => { totalCount += registerAccountItem(db, account, item, now); });
    });
  });
  return totalCount;
}

/**
 * 예전 자동 생성 내역에 대상 월을 채우고, 같은 달 중복을 정리한 뒤 UNIQUE 인덱스를 만든다 (B-007 마이그레이션).
 * 대상 월은 실제 날짜가 그 달·전달·다음 달 중 어느 달의 처리일과 맞는지로 판단한다.
 */
function normalizeAccountRecurringMonths(db) {
  let changed = false;
  const rows = dbRowsToObjects(db.exec(
    `SELECT t.id, t.date, i.day_of_month, i.holiday_rule
     FROM account_transactions t
     LEFT JOIN account_recurring_items i ON i.id = t.recurring_item_id
     WHERE t.recurring_item_id IS NOT NULL AND COALESCE(t.recurring_month, '') = ''`
  ));
  if (rows.length) {
    withTransaction(db, () => {
      rows.forEach(r => {
        let ym = String(r.date).slice(0, 7);
        if (r.day_of_month != null) {
          const [y, m] = String(r.date).split('-').map(Number);
          for (const offset of [0, -1, 1]) {
            const cand = ymOf(new Date(y, m - 1 + offset, 1));
            if (recurringDateFor(r, cand) === r.date) { ym = cand; break; }
          }
        }
        db.run('UPDATE account_transactions SET recurring_month = ? WHERE id = ?', [ym, r.id]);
      });
    });
    changed = true;
  }

  // 같은 항목·같은 달이 여러 건이면 사용자가 고친 것, 없으면 먼저 만든 것 하나만 남긴다
  const dups = db.exec(
    `SELECT recurring_item_id, recurring_month FROM account_transactions
     WHERE recurring_item_id IS NOT NULL AND recurring_month != ''
     GROUP BY recurring_item_id, recurring_month HAVING COUNT(*) > 1`
  )[0]?.values || [];
  if (dups.length) {
    withTransaction(db, () => {
      dups.forEach(([itemId, ym]) => {
        const keep = db.exec(
          `SELECT id FROM account_transactions WHERE recurring_item_id = ? AND recurring_month = ?
           ORDER BY is_modified DESC, id ASC LIMIT 1`,
          [itemId, ym]
        )[0].values[0][0];
        db.run(
          'DELETE FROM account_transactions WHERE recurring_item_id = ? AND recurring_month = ? AND id != ?',
          [itemId, ym, keep]
        );
      });
    });
    changed = true;
  }

  const hasIndex = db.exec(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ux_account_tx_recurring'"
  )[0]?.values.length;
  if (!hasIndex) {
    db.run(`CREATE UNIQUE INDEX ux_account_tx_recurring
            ON account_transactions (recurring_item_id, recurring_month)
            WHERE recurring_item_id IS NOT NULL AND recurring_month != ''`);
    changed = true;
  }
  return changed;
}

// ── 잔액 예측 ────────────────────────────────────────────────────

export function getBalanceForecast(db, accountId, daysAhead = 90) {
  const account = getAccount(db, accountId);
  if (!account) return [];

  const today = new Date();
  const todayYmd = toDateStr(today);
  const endStr = addDays(todayYmd, daysAhead);

  // current_balance(잔액 기준일 시작 잔액)에 기준일~오늘 거래를 순서대로 적용 → 실제 현재 잔액 (B-022)
  // 기준일 이전 거래는 이미 current_balance에 들어 있으므로 제외한다.
  const balanceDate = account.balance_date || '';
  const pastRes = db.exec(
    'SELECT * FROM account_transactions WHERE account_id = ? AND date <= ? AND date >= ? ORDER BY date ASC, id ASC',
    [accountId, todayYmd, balanceDate]
  );
  const pastTxs = dbRowsToObjects(pastRes);

  let actualCurrentBalance = account.current_balance || 0;
  for (const tx of pastTxs) {
    if (tx.type === 'income') actualCurrentBalance += tx.amount;
    else actualCurrentBalance -= tx.amount;
  }

  // 오늘 이후 거래를 예측 이벤트로 처리
  const futureRes = db.exec(
    'SELECT * FROM account_transactions WHERE account_id = ? AND date > ? AND date <= ? AND date >= ? ORDER BY date ASC, id ASC',
    [accountId, todayYmd, endStr, balanceDate]
  );
  const futureTxs = dbRowsToObjects(futureRes);

  let balance = actualCurrentBalance;
  const events = [];

  futureTxs.forEach(tx => {
    const delta = tx.type === 'income' ? tx.amount : -tx.amount;
    balance += delta;

    const isEstimated = !!tx.is_auto_generated && !tx.is_modified;
    const isCardEstimate = tx.amount_type === 'auto';

    events.push({
      date: tx.date,
      description: tx.description,
      type: tx.type,
      amount: tx.amount,
      balance,
      isEstimated,
      isCardEstimate,
      isBelowDanger: account.danger_threshold > 0 && balance < account.danger_threshold,
      tx,
    });
  });

  return { account, startBalance: actualCurrentBalance, events };
}
