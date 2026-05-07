import initSqlJs from 'sql.js';
import HOLIDAYS_BY_YEAR, { getNextBusinessDay, getPrevBusinessDay } from '../data/holidays';

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

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  schedule TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  is_hidden INTEGER DEFAULT 0,
  UNIQUE(name, schedule)
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
  amount          INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL
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
  // recurring_transactions.is_active 컬럼 제거 (기존 DB 호환)
  try { db.run('ALTER TABLE recurring_transactions DROP COLUMN is_active'); didMigrate = true; } catch (e) {}
  // trips 테이블에 여행일정 컬럼 추가 (기존 DB 호환)
  try { db.run("ALTER TABLE trips ADD COLUMN schedule TEXT DEFAULT ''"); didMigrate = true; } catch (e) {}
  // trips UNIQUE 제약 변경: name 단독 → (name, schedule) 복합 (기존 DB 호환)
  try {
    const schemaRes = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='trips'");
    const schemaSql = schemaRes[0]?.values[0]?.[0] || '';
    if (!schemaSql.includes('UNIQUE(name, schedule)') && !schemaSql.includes('UNIQUE (name, schedule)')) {
      db.run(`CREATE TABLE trips_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        schedule TEXT DEFAULT '',
        sort_order INTEGER DEFAULT 0,
        is_hidden INTEGER DEFAULT 0,
        UNIQUE(name, schedule)
      )`);
      db.run(`INSERT INTO trips_new SELECT id, name, COALESCE(schedule, ''), sort_order, is_hidden FROM trips`);
      db.run(`DROP TABLE trips`);
      db.run(`ALTER TABLE trips_new RENAME TO trips`);
      didMigrate = true;
    }
  } catch (e) {}

  // transactions에 event_id 컬럼 추가
  try { db.run('ALTER TABLE transactions ADD COLUMN event_id INTEGER DEFAULT NULL'); didMigrate = true; } catch (e) {}

  // ── trips → calendar_events 마이그레이션 ──────────────────────────
  // trips 테이블이 존재하면 마이그레이션 실행 후 DROP
  try {
    const tripsExist = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='trips'");
    if (tripsExist.length && tripsExist[0].values.length > 0) {
      const trips = db.exec('SELECT id, name, schedule, sort_order FROM trips ORDER BY sort_order, id');
      if (trips.length) {
        trips[0].values.forEach(([tripId, name, schedule, sortOrder]) => {
          // calendar_events에 여행 이벤트 삽입 (중복 방지: migrated_from_trip_id로 체크)
          const alreadyMigrated = db.exec(
            'SELECT id FROM calendar_events WHERE note LIKE ? AND event_type = ?',
            [`%[trip_id:${tripId}]%`, 'trip']
          );
          if (alreadyMigrated.length && alreadyMigrated[0].values.length > 0) return;

          const noteVal = schedule
            ? `${schedule} [trip_id:${tripId}]`
            : `[trip_id:${tripId}]`;

          db.run(
            `INSERT INTO calendar_events (title, date_from, date_to, event_type, color, note, sort_order)
             VALUES (?, '', '', 'trip', '#F0A500', ?, ?)`,
            [name, noteVal, sortOrder]
          );
          const newEventRes = db.exec('SELECT last_insert_rowid()');
          const newEventId = newEventRes[0].values[0][0];

          // trip_countries → event_countries
          const countries = db.exec(
            'SELECT country, currency, sort_order FROM trip_countries WHERE trip_id = ? ORDER BY sort_order, id',
            [tripId]
          );
          if (countries.length) {
            countries[0].values.forEach(([country, currency, cSort]) => {
              db.run(
                'INSERT INTO event_countries (event_id, country, currency, sort_order) VALUES (?, ?, ?, ?)',
                [newEventId, country, currency, cSort]
              );
            });
          }

          // transactions.event_id 매핑
          db.run(
            'UPDATE transactions SET event_id = ? WHERE trip_id = ? AND event_id IS NULL',
            [newEventId, tripId]
          );
        });
      }

      // row count 검증 후 DROP
      const ecCount = db.exec('SELECT COUNT(*) FROM event_countries');
      const tcCount = db.exec("SELECT COUNT(*) FROM trip_countries");
      const evtCount = db.exec('SELECT COUNT(*) FROM calendar_events WHERE event_type = ?', ['trip']);
      const trCount = db.exec('SELECT COUNT(*) FROM trips');
      const ecOk = (ecCount[0]?.values[0][0] || 0) >= (tcCount[0]?.values[0][0] || 0);
      const evtOk = (evtCount[0]?.values[0][0] || 0) >= (trCount[0]?.values[0][0] || 0);
      if (ecOk && evtOk) {
        db.run('DROP TABLE IF EXISTS trip_countries');
        db.run('DROP TABLE IF EXISTS trips');
      }
      didMigrate = true;
    }
  } catch (e) {}

  // ── calendar_event_types 초기화 및 데이터 정규화 ────────────────────
  try {
    db.run(`INSERT OR IGNORE INTO calendar_event_types (value, label, color, sort_order, is_system, is_trip_type)
      VALUES
        ('trip',     '여행',   '#F0A500', 0, 1, 1),
        ('occasion', '경조사', '#EC4899', 1, 0, 0),
        ('general',  '일상',   '#9CA3AF', 2, 1, 0)`);
    // general: 이름 '기타'→'일상', sort_order 999→2 로 업데이트 (기존 DB 호환)
    db.run(`UPDATE calendar_event_types SET label='일상', sort_order=2 WHERE value='general' AND (label='기타' OR sort_order=999)`);
    // 구 유형(holiday, medical) → general 이전
    db.run(`UPDATE calendar_events SET event_type = 'general' WHERE event_type IN ('holiday', 'medical')`);
    // 미정의 event_type 방어
    db.run(`UPDATE calendar_events SET event_type = 'general'
            WHERE event_type NOT IN (SELECT value FROM calendar_event_types)`);
    didMigrate = true;
  } catch (e) {}

  // ── holidays 테이블 동기화 ────────────────────────────────────
  try {
    Object.values(HOLIDAYS_BY_YEAR).flat().forEach(({ date, name }) => {
      db.run('INSERT OR REPLACE INTO holidays (date, name) VALUES (?, ?)', [date, name]);
    });
  } catch (e) {}

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
       (payment_method, date, budget_category, sub_category, detail, amount, discount_amount, discount_note, event_id, foreign_amounts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tx.payment_method, tx.date, tx.budget_category,
      tx.sub_category || '', tx.detail || '',
      tx.amount, tx.discount_amount || 0, tx.discount_note || '',
      tx.event_id || null,
      tx.foreign_amounts && Object.keys(tx.foreign_amounts).length ? JSON.stringify(tx.foreign_amounts) : '',
    ]
  );
}

export function updateTransaction(db, id, tx) {
  db.run(
    `UPDATE transactions
     SET payment_method=?, date=?, budget_category=?, sub_category=?,
         detail=?, amount=?, discount_amount=?, discount_note=?,
         event_id=?, foreign_amounts=?,
         updated_at=datetime('now','localtime')
     WHERE id=?`,
    [
      tx.payment_method, tx.date, tx.budget_category,
      tx.sub_category || '', tx.detail || '',
      tx.amount, tx.discount_amount || 0, tx.discount_note || '',
      tx.event_id || null,
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
  // date_from이 비어있지 않고, 기간이 겹치는 이벤트
  const res = db.exec(
    `SELECT * FROM calendar_events
     WHERE is_hidden = 0
       AND date_from != ''
       AND date_from <= ?
       AND (date_to >= ? OR (date_to = '' AND date_from >= ?))
     ORDER BY date_from, id`,
    [dateTo, dateFrom, dateFrom]
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
    'SELECT id, country, currency, sort_order FROM event_countries WHERE event_id = ? ORDER BY sort_order, id',
    [eventId]
  );
  if (!res.length) return [];
  return res[0].values.map(([id, country, currency, sort_order]) => ({ id, country, currency, sort_order }));
}

export function addCalendarEvent(db, ev) {
  if (!db || !ev.title?.trim()) throw new Error('제목을 입력하세요');
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
  db.run(
    `UPDATE calendar_events SET title=?, date_from=?, date_to=?, event_type=?, color=?, note=?, is_hidden=?
     WHERE id=?`,
    [ev.title.trim(), ev.date_from || '', ev.date_to || '', ev.event_type || 'general',
     ev.color || '', ev.note || '', ev.is_hidden ? 1 : 0, id]
  );
}

export function deleteCalendarEvent(db, id) {
  db.run('DELETE FROM event_countries WHERE event_id = ?', [id]);
  db.run('UPDATE transactions SET event_id = NULL WHERE event_id = ?', [id]);
  db.run('DELETE FROM calendar_events WHERE id = ?', [id]);
}

export function addEventCountry(db, eventId, country, currency) {
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), -1) FROM event_countries WHERE event_id = ?', [eventId]);
  const nextSort = (maxSort[0]?.values[0][0] ?? -1) + 1;
  db.run('INSERT INTO event_countries (event_id, country, currency, sort_order) VALUES (?, ?, ?, ?)',
    [eventId, country, currency, nextSort]);
}

export function updateEventCountry(db, id, country, currency) {
  db.run('UPDATE event_countries SET country=?, currency=? WHERE id=?', [country, currency, id]);
}

export function deleteEventCountry(db, id) {
  db.run('DELETE FROM event_countries WHERE id = ?', [id]);
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

export function moveCalendarEventType(db, id, targetIndex) {
  const all = getCalendarEventTypes(db);
  const fromIdx = all.findIndex(t => t.id === id);
  if (fromIdx === -1) return;
  const reordered = [...all];
  const [moved] = reordered.splice(fromIdx, 1);
  reordered.splice(targetIndex, 0, moved);
  reordered.forEach((t, i) => {
    db.run('UPDATE calendar_event_types SET sort_order=? WHERE id=?', [i, t.id]);
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

export function getEventPaymentMethodSummary(db, eventId = null) {
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
         WHERE t.event_id IS NOT NULL
         GROUP BY t.payment_method, ce.event_type
         ORDER BY t.payment_method, total DESC`;
    params = [];
  }
  const res = db.exec(q, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => { const o = {}; columns.forEach((c, i) => o[c] = row[i]); return o; });
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
    SELECT tr.id as trip_id, tr.name as trip_name, tr.schedule as trip_schedule,
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
      tripMap[key] = { trip_id: obj.trip_id, trip_name: obj.trip_name, trip_schedule: obj.trip_schedule || '', total: 0, discount: 0, cnt: 0, foreignTotals: {} };
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

export function getBudgetCategoryTxCount(db, name) {
  const res = db.exec(
    'SELECT COUNT(*) FROM transactions WHERE budget_category = ?',
    [name]
  );
  return res[0]?.values[0][0] || 0;
}

export function deleteBudgetCategory(db, name) {
  db.run('DELETE FROM sub_categories WHERE budget_category = ?', [name]);
  db.run('DELETE FROM budget_categories WHERE name = ?', [name]);
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

export function ensureCategoriesExist(db, categoryNames) {
  const existing = new Set(
    (db.exec('SELECT name FROM budget_categories')[0]?.values || []).map(r => r[0])
  );
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) FROM budget_categories')[0]?.values[0][0] || 0;
  let nextSort = maxSort + 1;
  categoryNames.forEach(name => {
    if (!existing.has(name)) {
      db.run('INSERT INTO budget_categories (name, sort_order) VALUES (?, ?)', [name, nextSort++]);
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

export function ensureTripsExist(db, trips) {
  // trips: [{name, schedule}]
  trips.forEach(({ name, schedule }) => {
    const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), 0) FROM trips')[0]?.values[0][0] || 0;
    db.run(
      'INSERT OR IGNORE INTO trips (name, schedule, sort_order, is_hidden) VALUES (?, ?, ?, 0)',
      [name, schedule || '', maxSort + 1]
    );
  });
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
  const res = db.exec('SELECT id, name, schedule FROM trips WHERE is_hidden = 0 ORDER BY sort_order, id');
  if (!res.length) return [];
  return res[0].values.map(([id, name, schedule]) => ({
    id, name, schedule: schedule || '',
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
  const res = db.exec('SELECT id, name, schedule, sort_order, is_hidden FROM trips ORDER BY sort_order, id');
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function addTrip(db, name, schedule = '') {
  if (!name || !name.trim()) throw new Error('여행 이름을 입력하세요');
  const minSort = db.exec('SELECT COALESCE(MIN(sort_order), 1) FROM trips');
  const nextSort = (minSort[0]?.values[0][0] || 1) - 1;
  try {
    db.run('INSERT INTO trips (name, schedule, sort_order, is_hidden) VALUES (?, ?, ?, 0)', [name.trim(), schedule.trim(), nextSort]);
  } catch (e) {
    throw new Error(`"${name.trim()}${schedule.trim() ? ` (${schedule.trim()})` : ''}" 여행이 이미 존재합니다`);
  }
}

export function updateTripName(db, id, name, schedule = '') {
  if (!name || !name.trim()) throw new Error('여행 이름을 입력하세요');
  try {
    db.run('UPDATE trips SET name = ?, schedule = ? WHERE id = ?', [name.trim(), schedule.trim(), id]);
  } catch (e) {
    throw new Error(`"${name.trim()}${schedule.trim() ? ` (${schedule.trim()})` : ''}" 여행이 이미 존재합니다`);
  }
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

export function addFavorite(db, data) {
  const maxSortRes = db.exec('SELECT COALESCE(MAX(sort_order), -1) as maxSort FROM favorite_transactions');
  const maxSort = maxSortRes.length > 0 ? maxSortRes[0].values[0][0] : -1;

  db.run(
    `INSERT INTO favorite_transactions (name, payment_method, budget_category, sub_category, detail, amount, sort_order, use_count, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.name, data.payment_method, data.budget_category,
      data.sub_category || '', data.detail || '', data.amount,
      maxSort + 1, 0, null,
    ]
  );
}

export function updateFavorite(db, id, data) {
  db.run(
    `UPDATE favorite_transactions SET name=?, payment_method=?, budget_category=?, sub_category=?, detail=?, amount=? WHERE id=?`,
    [
      data.name, data.payment_method, data.budget_category,
      data.sub_category || '', data.detail || '', data.amount, id,
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

export function reorderFavorite(db, id, newPosition) {
  moveItemToPosition(db, 'favorite_transactions', id, newPosition);
}

// ── 스마트 패턴: 자동 결제수단 선택 ─────────────────────────────────

export function getAutoPaymentMethod(db, subCategory) {
  if (!subCategory) return null;

  // 최근 20개 거래에서 결제수단 목록 가져오기
  const res = db.exec(
    `SELECT payment_method
     FROM transactions
     WHERE sub_category = ? AND payment_method IN (SELECT name FROM payment_methods WHERE is_hidden = 0)
     ORDER BY created_at DESC
     LIMIT 20`,
    [subCategory]
  );

  if (!res.length || !res[0].values.length) return null;

  // 결제수단별 집계
  const methodCounts = {};
  let total = 0;
  res[0].values.forEach(row => {
    const method = row[0];
    methodCounts[method] = (methodCounts[method] || 0) + 1;
    total++;
  });

  // 가장 많은 결제수단 찾기
  const sorted = Object.entries(methodCounts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return null;

  const [paymentMethod, count] = sorted[0];

  // 80% 이상이고 10건 이상이면 반환
  if (total >= 10 && count / total >= 0.8) {
    return paymentMethod;
  }
  return null;
}

export function getDetectedPatterns(db) {
  const res = db.exec(
    `SELECT t.sub_category, t.payment_method, COUNT(*) as cnt, COALESCE(aps.is_disabled, 0) as is_disabled
     FROM (
       SELECT sub_category, payment_method FROM transactions
       ORDER BY created_at DESC
       LIMIT 100
     ) t
     LEFT JOIN auto_pattern_settings aps ON aps.sub_category = t.sub_category
     JOIN payment_methods pm ON pm.name = t.payment_method AND pm.is_hidden = 0
     GROUP BY t.sub_category, t.payment_method
     HAVING cnt >= 10
     ORDER BY t.sub_category, cnt DESC`
  );

  if (!res.length) return [];
  const { columns, values } = res[0];
  const patterns = {};

  values.forEach(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    const { sub_category, payment_method, cnt, is_disabled } = obj;

    if (!patterns[sub_category]) {
      patterns[sub_category] = { sub_category, payment_method, count: cnt, total: cnt, is_disabled };
    }
  });

  return Object.values(patterns);
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

export function runAutoRegister(db) {
  const now = new Date();
  const targetDate = new Date(now.getFullYear(), now.getMonth() + 2, 1);
  const targetYear = targetDate.getFullYear();
  const targetMonth = targetDate.getMonth() + 1; // 1-indexed
  const targetYearMonth = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;

  const recurring = getRecurringTransactions(db);
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

// 각 계좌의 실제 현재 잔액 (current_balance + 오늘까지의 거래 합산)
export function getAccountsActualBalances(db) {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const res = db.exec(
    `SELECT account_id,
            COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END), 0) AS tx_sum
     FROM account_transactions WHERE date <= ? GROUP BY account_id`,
    [todayStr]
  );
  const txSums = {};
  if (res.length) res[0].values.forEach(([id, sum]) => { txSums[id] = sum; });
  return txSums;
}

export function getDefaultAccount(db) {
  const res = db.exec('SELECT * FROM accounts WHERE is_default = 1 AND is_active = 1 LIMIT 1');
  const rows = dbRowsToObjects(res);
  return rows[0] || null;
}

export function addAccount(db, data) {
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), -1) FROM accounts');
  const nextSort = (maxSort[0]?.values[0][0] ?? -1) + 1;
  db.run(
    `INSERT INTO accounts (name, bank, account_number, current_balance, balance_date, danger_threshold, is_default, note, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.name || '', data.bank || '', data.account_number || '',
     data.current_balance || 0, data.balance_date || '', data.danger_threshold || 0,
     data.is_default ? 1 : 0, data.note || '', nextSort]
  );
  const res = db.exec('SELECT last_insert_rowid()');
  return res[0].values[0][0];
}

export function updateAccount(db, id, data) {
  db.run(
    `UPDATE accounts SET name=?, bank=?, account_number=?, current_balance=?, balance_date=?,
     danger_threshold=?, is_default=?, note=? WHERE id=?`,
    [data.name || '', data.bank || '', data.account_number || '',
     data.current_balance || 0, data.balance_date || '', data.danger_threshold || 0,
     data.is_default ? 1 : 0, data.note || '', id]
  );
}

export function setDefaultAccount(db, id) {
  db.run('UPDATE accounts SET is_default = 0');
  if (id) db.run('UPDATE accounts SET is_default = 1 WHERE id = ?', [id]);
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

export function updateRecurringItem(db, id, data) {
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
}

export function deleteRecurringItem(db, id) {
  db.run('UPDATE account_recurring_items SET is_active = 0 WHERE id = ?', [id]);
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
        recurring_item_id, is_auto_generated, is_modified, is_imported)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.account_id, data.date, data.type || 'expense', data.category || '',
     data.description || '', data.amount, data.base_amount ?? null,
     data.recurring_item_id ?? null,
     data.is_auto_generated ? 1 : 0, data.is_modified ? 1 : 0, data.is_imported ? 1 : 0]
  );
}

export function updateAccountTransaction(db, id, data) {
  db.run(
    `UPDATE account_transactions SET date=?, type=?, category=?, description=?, amount=?,
     is_modified=1 WHERE id=?`,
    [data.date, data.type || 'expense', data.category || '', data.description || '',
     data.amount, id]
  );
}

export function deleteAccountTransaction(db, id) {
  db.run('DELETE FROM account_transactions WHERE id = ?', [id]);
}

export function bulkInsertAccountTransactions(db, accountId, rows) {
  db.run('BEGIN');
  try {
    rows.forEach(row => {
      db.run(
        `INSERT INTO account_transactions
           (account_id, date, type, description, amount, is_imported)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [accountId, row.date, row.type, row.description, row.amount]
      );
    });
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

// ── 카드 결제 추정액 집계 ────────────────────────────────────────

export function getCardPaymentTotal(db, paymentMethod, yearMonth) {
  if (!paymentMethod || !yearMonth) return 0;
  const res = db.exec(
    `SELECT COALESCE(SUM(amount - COALESCE(discount_amount, 0)), 0)
     FROM transactions WHERE payment_method = ? AND strftime('%Y-%m', date) = ?`,
    [paymentMethod, yearMonth]
  );
  return res[0]?.values[0][0] || 0;
}

// ── 계좌 자동 등록 ───────────────────────────────────────────────

export function runAccountAutoRegister(db) {
  const accounts = getAllAccounts(db);
  const now = new Date();
  let totalCount = 0;

  accounts.forEach(account => {
    const items = getRecurringItems(db, account.id).filter(i => i.auto_register);

    items.forEach(item => {
      const monthsAhead = item.register_months_ahead || 2;

      for (let m = 0; m <= monthsAhead; m++) {
        const targetDate = new Date(now.getFullYear(), now.getMonth() + m, 1);
        const year = targetDate.getFullYear();
        const month = targetDate.getMonth() + 1;
        const yearMonth = `${year}-${String(month).padStart(2, '0')}`;

        const alreadyExists = db.exec(
          `SELECT 1 FROM account_transactions
           WHERE recurring_item_id = ? AND strftime('%Y-%m', date) = ?`,
          [item.id, yearMonth]
        );
        if (alreadyExists.length && alreadyExists[0].values.length) continue;

        const lastDay = new Date(year, month, 0).getDate();
        const day = Math.min(item.day_of_month, lastDay);
        const rawDate = `${yearMonth}-${String(day).padStart(2, '0')}`;
        const actualDate = item.holiday_rule === 'next_business'
          ? getNextBusinessDay(rawDate)
          : item.holiday_rule === 'prev_business'
            ? getPrevBusinessDay(rawDate)
            : rawDate;

        let amount = item.fixed_amount || 0;
        let baseAmount = null;

        if (item.amount_type === 'auto' && item.auto_payment_method) {
          const prevDate = new Date(year, month - 2, 1);
          const prevYM = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
          amount = getCardPaymentTotal(db, item.auto_payment_method, prevYM);
          baseAmount = amount;
        }

        if (amount === 0) continue;

        db.run(
          `INSERT INTO account_transactions
             (account_id, date, type, category, description, amount, base_amount,
              recurring_item_id, is_auto_generated, is_modified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
          [account.id, actualDate, item.type, '',
           item.name, amount, baseAmount, item.id]
        );
        totalCount++;
      }
    });
  });

  return totalCount;
}

// ── 잔액 예측 ────────────────────────────────────────────────────

export function getBalanceForecast(db, accountId, daysAhead = 90) {
  const account = getAccount(db, accountId);
  if (!account) return [];

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + daysAhead);
  const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

  // current_balance(시작 금액)에서 과거 거래를 순서대로 적용 → 실제 현재 잔액
  const pastRes = db.exec(
    'SELECT * FROM account_transactions WHERE account_id = ? AND date <= ? ORDER BY date ASC, id ASC',
    [accountId, todayStr]
  );
  const pastTxs = dbRowsToObjects(pastRes);

  let actualCurrentBalance = account.current_balance || 0;
  for (const tx of pastTxs) {
    if (tx.type === 'income') actualCurrentBalance += tx.amount;
    else actualCurrentBalance -= tx.amount;
  }

  // 오늘 이후 거래를 예측 이벤트로 처리
  const futureRes = db.exec(
    'SELECT * FROM account_transactions WHERE account_id = ? AND date > ? AND date <= ? ORDER BY date ASC, id ASC',
    [accountId, todayStr, endStr]
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
