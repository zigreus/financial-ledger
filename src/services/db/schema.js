// DB 스키마와 열기 — 테이블 정의, sql.js 초기화, 마이그레이션(createDatabase), 내보내기.

import initSqlJs from 'sql.js';
import { columnsOf, dbRowsToObjects, runCount, tableExists, todayLocal, withTransaction } from './common';
import { recurringDateFor, ymOf } from './recurringDates';

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

-- 가족 구성원 — 거래의 '누가'(transactions.member)가 이름으로 참조한다 (I-013)
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 카테고리별 예산 (I-025) — year_month가 ''이면 상시 기본값, 'YYYY-MM'이면 그 달만 덮어쓴다.
--  since: 상시 줄에서, 이 값을 쓰기 시작한 달(그 전 달에는 이 상시 값을 쓰지 않는다)
--  kept: 월별 줄에서 1이면 상시 값을 바꿀 때 지난 달에 남긴 '그때 예산'(사용자가 그 달만 정한 것과 구분)
-- 카테고리는 이름으로 참조한다(masterData의 이름 변경·삭제가 함께 고친다)
CREATE TABLE IF NOT EXISTS category_budgets (
  budget_category TEXT NOT NULL,
  year_month      TEXT NOT NULL DEFAULT '',
  amount          INTEGER NOT NULL,
  since           TEXT NOT NULL DEFAULT '',
  kept            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (budget_category, year_month)
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
      // Vite: public/ 파일은 BASE_URL('/')에서 제공된다 (process.env는 브라우저에 없음 — I-008)
      locateFile: file => `${import.meta.env.BASE_URL}${file}`,
    });
  }
  return SQL;
}

// ── 스키마 버전 · 마이그레이션 ─────────────────────────────────────
// 새 컬럼은 COLUMN_MIGRATIONS에 한 줄 추가한다. 새 테이블은 SCHEMA에 CREATE TABLE IF NOT EXISTS로 추가한다.
// 실제로 무언가 바뀌었을 때만 didMigrate가 참이 되어야 한다 — 참이면 로드 직후 OneDrive에 다시 저장한다.
export const SCHEMA_VERSION = 7; // 4: category_budgets (I-025), 5: accounts.count_income (I-026), 6: 구독 표시 (I-027), 7: 연말정산 분류 (I-029)

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
  // 누가 쓴 거래인지 — members.name을 이름으로 참조한다. 빈 문자열은 '지정 안 함' (I-013)
  ['transactions', 'member', "TEXT DEFAULT ''"],
  // 카테고리 예산: 상시 값을 쓰기 시작한 달 / 상시를 바꿀 때 남긴 그때 예산 (I-025 — 처음 만든 표에는 없었다)
  ['category_budgets', 'since', "TEXT NOT NULL DEFAULT ''"],
  ['category_budgets', 'kept', 'INTEGER NOT NULL DEFAULT 0'],
  // 월 수지(I-026): 이 계좌의 입금을 수입으로 셀지 — NULL이면 자동(반복 수입 항목이 있는 계좌만), 1 셈, 0 세지 않음
  ['accounts', 'count_income', 'INTEGER DEFAULT NULL'],
  // 구독 모아보기(I-027): 정기지출 중 구독인지, 해지 메모, 금액을 확인한 날(그 뒤 결제만 '금액이 바뀜'으로 견준다)
  ['recurring_transactions', 'is_subscription', 'INTEGER NOT NULL DEFAULT 0'],
  ['recurring_transactions', 'cancel_note', "TEXT NOT NULL DEFAULT ''"],
  ['recurring_transactions', 'amount_checked_on', "TEXT NOT NULL DEFAULT ''"],
  // 연말정산 참고 합계(I-029): 결제수단 유형(credit·debit·cash·other, ''=미정), 카테고리·세부카테고리 항목(의료비 등, 세부의 '-'는 해당 없음)
  ['payment_methods', 'tax_type', "TEXT NOT NULL DEFAULT ''"],
  ['budget_categories', 'tax_tag', "TEXT NOT NULL DEFAULT ''"],
  ['sub_categories', 'tax_tag', "TEXT NOT NULL DEFAULT ''"],
];

/** 컬럼이 없을 때만 추가한다. 추가했으면 true. */
function ensureColumn(db, table, column, ddl) {
  if (!tableExists(db, table) || columnsOf(db, table).has(column)) return false;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
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

  // ── 구성원 목록 맞추기 (I-013) ─────────────────────────────────
  // 한 기기가 이름을 바꾸거나 지운 사이 다른 기기가 옛 이름으로 적은 거래가 병합되면, 목록에 없는 이름이 남는다.
  // 그 이름을 목록에 되살려 설정에서 바꾸거나 지울 수 있게 한다. 이미 맞으면 아무것도 바꾸지 않는다.
  step('구성원 목록 맞추기', () => runCount(db, `INSERT INTO members (name, sort_order)
    SELECT DISTINCT member, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM members)
    FROM transactions
    WHERE COALESCE(member, '') != '' AND member NOT IN (SELECT name FROM members)`) > 0);

  // ── 계좌 자동등록 내역의 '대상 월' 채우기 + 중복 정리 (B-007) ─────────
  step('계좌 자동등록 대상 월 정리', () => normalizeAccountRecurringMonths(db));

  // ── 지운 계좌에 남은 앞으로의 자동 예정 정리 (I-026) ─────────────────
  // 계좌를 지우면 앞으로의 자동 예정도 지운다(deleteAccount). 그 전 버전이나 예전 버전 기기로 지운 계좌에는 남아 있어,
  // 날짜가 지나면 지난 입금처럼 수입에 잡혀 월급 계좌를 바꾼 달에 새 계좌 월급과 겹친다. 날짜가 지나기 전에 지운다.
  step('지운 계좌의 앞으로 예정 정리', () => runCount(db,
    `DELETE FROM account_transactions
     WHERE is_auto_generated = 1 AND is_modified = 0 AND date > ?
       AND account_id IN (SELECT id FROM accounts WHERE is_active = 0)`,
    [todayLocal()]) > 0);

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

// ── AUTOINCREMENT 번호 (I-014 되돌리기) ─────────────────────────────
// 백업으로 되돌린 파일은 그때의 sqlite_sequence를 갖고 있어, 그 뒤 만들어졌다 사라진 행의 id를 새 행이 다시 받는다.
// 그러면 다른 기기가 아직 저장하지 못한 "UPDATE … WHERE id=?"가 엉뚱한 새 행을 고칠 수 있으므로,
// 되돌리기 전에 쓰던 파일의 번호보다 작아지지 않게 올려 둔다.

/** { 테이블: 마지막으로 쓴 AUTOINCREMENT 번호 } */
export function getAutoIncrementSeqs(db) {
  if (!tableExists(db, 'sqlite_sequence')) return {};
  const out = {};
  (db.exec('SELECT name, seq FROM sqlite_sequence')[0]?.values || []).forEach(([name, seq]) => { out[name] = seq; });
  return out;
}

/** 각 테이블의 번호를 seqs 이상으로 올린다 (낮추지는 않는다). 대상 DB에 없는 테이블은 건너뛴다. */
export function raiseAutoIncrementSeqs(db, seqs) {
  Object.entries(seqs || {}).forEach(([name, seq]) => {
    if (!tableExists(db, name) || !tableExists(db, 'sqlite_sequence')) return;
    const cur = db.exec('SELECT seq FROM sqlite_sequence WHERE name = ?', [name])[0]?.values[0]?.[0];
    if (cur === undefined) db.run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [name, seq]);
    else if (cur < seq) db.run('UPDATE sqlite_sequence SET seq = ? WHERE name = ?', [seq, name]);
  });
}
