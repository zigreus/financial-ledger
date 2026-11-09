/**
 * 변경 기록 (B-001, B-003, B-005)
 *
 * 마지막으로 OneDrive에 저장한 뒤 DB에 실행한 쓰기 문장(db.run / 쓰기용 db.exec)을 순서대로 기록한다.
 *  - 다른 기기가 먼저 저장해 충돌(412)이 나면, 최신 DB에 이 기록을 다시 실행해 양쪽 변경을 합친다.
 *  - 기록은 작아서 브라우저 저장소에 보관할 수 있다 — 재인증 리다이렉트·탭 종료 뒤에도 변경을 되살린다.
 *
 * 새로 추가한 행의 id는 최신 DB에서 달라질 수 있다(그 사이 다른 기기가 행을 추가한 경우).
 * 그래서 다시 실행할 때 "이 기록 안에서 추가한 행"을 가리키는 id 파라미터를 새 id로 바꿔 끼운다.
 * 어떤 파라미터가 어떤 테이블의 id인지는 컬럼 이름으로 판단한다 (FK_COLUMNS).
 * ⚠️ 다른 테이블의 id를 담는 컬럼을 새로 만들면 FK_COLUMNS에 꼭 추가한다.
 */

/** 참조 컬럼 → 참조하는 테이블 */
export const FK_COLUMNS = {
  event_id: 'calendar_events',
  target_event_id: 'calendar_events',
  account_id: 'accounts',
  recurring_item_id: 'account_recurring_items',
  recurring_id: 'recurring_transactions',
  recurring_source_id: 'recurring_transactions',
  transaction_id: 'transactions',
  // 여행 현금 흐름의 연결 (B-038)
  account_tx_id: 'account_transactions',
  linked_flow_id: 'event_cash_flows',
  linked_tx_id: 'transactions',
};

const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA\s+\w+\s*=)/i;
const TX_RE = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

const isWrite = (sql) => WRITE_RE.test(String(sql || ''));

/**
 * db에 변경 기록을 붙인다. db.run / db.exec를 감싸 쓰기 문장을 기록한다.
 * onWrite: 쓰기가 기록될 때마다 호출 (화면 갱신·자동 저장 예약용)
 * initialEntries: 이미 있는 기록(충돌 병합 뒤 넘겨받는 기록 등)
 */
export function attachChangeLog(db, { onWrite, initialEntries = [] } = {}) {
  const proto = Object.getPrototypeOf(db);
  const rawRun = proto.run;
  const rawExec = proto.exec;

  const state = {
    entries: [...initialEntries],
    marks: [],        // 열린 트랜잭션/SAVEPOINT: { name, index }
    forwardTo: null,  // 교체된 옛 DB면, 늦게 들어온 쓰기를 새 DB로 넘긴다
    onWrite,
    depth: 0,
  };

  const lastInsertId = () => rawExec.call(db, 'SELECT last_insert_rowid()')[0].values[0][0];

  const trackTx = (sql) => {
    const s = String(sql).trim();
    if (/^(BEGIN)\b/i.test(s)) { state.marks.push({ name: null, index: state.entries.length }); return; }
    const sp = /^SAVEPOINT\s+(\w+)/i.exec(s);
    if (sp) { state.marks.push({ name: sp[1], index: state.entries.length }); return; }
    const rel = /^RELEASE\s+(?:SAVEPOINT\s+)?(\w+)/i.exec(s);
    if (rel) {
      const i = state.marks.map(m => m.name).lastIndexOf(rel[1]);
      if (i >= 0) state.marks.length = i;
      return;
    }
    const rbTo = /^ROLLBACK\s+(?:TRANSACTION\s+)?TO\s+(?:SAVEPOINT\s+)?(\w+)/i.exec(s);
    if (rbTo) {
      const mark = [...state.marks].reverse().find(m => m.name === rbTo[1]);
      if (mark) state.entries.length = mark.index;
      return;
    }
    if (/^ROLLBACK\b/i.test(s)) {
      if (state.marks.length) state.entries.length = state.marks[0].index;
      state.marks = [];
      return;
    }
    if (/^(COMMIT|END)\b/i.test(s)) state.marks = [];
  };

  const record = (method, sql, params) => {
    if (TX_RE.test(sql)) { trackTx(sql); return; }
    if (!isWrite(sql)) return;
    const entry = { method, sql, params: params === undefined ? undefined : JSON.parse(JSON.stringify(params)) };
    const ins = /^\s*(?:INSERT|REPLACE)\b[\s\S]*?\bINTO\s+(\w+)/i.exec(sql);
    if (ins && db.getRowsModified() > 0) {
      entry.insertTable = ins[1];
      entry.insertId = lastInsertId();
    }
    state.entries.push(entry);
    if (state.onWrite) state.onWrite();
  };

  db.run = function run(sql, params) {
    if (state.forwardTo) { state.forwardTo.run(sql, params); return db; }
    state.depth += 1;
    try {
      rawRun.call(db, sql, params);
    } finally {
      state.depth -= 1;
    }
    if (state.depth === 0) record('run', sql, params);
    return db;
  };

  db.exec = function exec(sql, params) {
    if (state.forwardTo && (isWrite(sql) || TX_RE.test(sql))) return state.forwardTo.exec(sql, params);
    state.depth += 1;
    let res;
    try {
      res = rawExec.call(db, sql, params);
    } finally {
      state.depth -= 1;
    }
    if (state.depth === 0) record('exec', sql, params);
    return res;
  };

  db.__changeLog = state;
  return state;
}

export function getChangeLog(db) {
  return db?.__changeLog || null;
}

/** 기록되지 않는 쓰기 (동기화 표식 등 내부용) */
export function rawRun(db, sql, params) {
  Object.getPrototypeOf(db).run.call(db, sql, params);
}

// ── 다시 실행할 때 id 바꿔 끼우기 ─────────────────────────────────

function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** SQL의 ? 자리마다 어느 컬럼에 대응하는지 구한다. 모르면 null. */
export function paramColumns(sql) {
  const ins = /^\s*(?:INSERT|REPLACE)\b[\s\S]*?\bINTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*;?\s*$/i.exec(sql);
  if (ins) {
    const columns = ins[2].split(',').map(c => c.trim());
    const cols = [];
    splitTopLevel(ins[3]).forEach((v, i) => {
      const count = (v.match(/\?/g) || []).length;
      for (let k = 0; k < count; k++) cols.push(v.trim() === '?' ? columns[i] : null);
    });
    return { table: ins[1], cols };
  }
  const tableMatch = /^\s*UPDATE\s+(?:OR\s+\w+\s+)?(\w+)/i.exec(sql) || /^\s*DELETE\s+FROM\s+(\w+)/i.exec(sql);
  const cols = [];
  const re = /\?/g;
  let m;
  while ((m = re.exec(sql))) {
    const before = sql.slice(0, m.index);
    const cm = /(\w+)\s*(?:=|==|!=|<>|<=|>=|<|>)\s*$/.exec(before) || /(\w+)\s+IN\s*\([^()]*$/i.exec(before);
    cols.push(cm ? cm[1] : null);
  }
  return { table: tableMatch ? tableMatch[1] : null, cols };
}

function remapParams(entry, remap) {
  const { params } = entry;
  if (!Array.isArray(params) || remap.size === 0) return params;
  const { table, cols } = paramColumns(entry.sql);
  return params.map((v, i) => {
    const col = cols[i];
    if (!col) return v;
    const target = col === 'id' ? table : FK_COLUMNS[col];
    const ids = target && remap.get(target);
    return ids && ids.has(v) ? ids.get(v) : v;
  });
}

/** 이 문장이 대상 DB에 들어가지 않은 행(gone: { 테이블 → Set(옛 id) })을 id·참조 컬럼으로 가리키는지 (B-091) */
function refersToGone(entry, gone) {
  if (!gone.size || !Array.isArray(entry.params)) return false;
  const { table, cols } = paramColumns(entry.sql);
  return entry.params.some((v, i) => {
    const col = cols[i];
    if (!col) return false;
    const target = col === 'id' ? table : FK_COLUMNS[col];
    return !!(target && gone.get(target)?.has(v));
  });
}

/**
 * 기록을 다른 DB(보통 OneDrive에서 새로 받은 최신 DB)에 다시 실행한다.
 * 같은 값을 양쪽에서 추가해 UNIQUE 제약에 걸리는 문장은 건너뛴다(이미 반영된 것으로 본다).
 * 이 기기에서는 넣었지만 대상 DB에는 들어가지 않은 행(UNIQUE로 건너뜀, 조건부 INSERT…SELECT가 0행)은 기억해 두고,
 * 그 행을 id나 참조 컬럼으로 가리키는 뒤 문장(수정·삭제·딸린 행, 딸린 행의 딸린 행까지)도 건너뛴다 — 옛 id 그대로 실행하면
 * 대상 DB에서 같은 번호를 가진 다른 기기의 행을 고치거나 지운다 (B-091). 건너뛴 문장은 이어 갈 기록에도 남기지 않는다.
 * 반환: { entries: 대상 DB 기준으로 id를 고친 기록, skipped: 이미 있어 건너뛴 문장(UNIQUE·OR IGNORE),
 *        dropped: 대상 DB에 맞지 않아 뺀 문장(조건부 INSERT…SELECT가 0행, 들어가지 않은 행을 가리킴) }
 */
export function replayChanges(targetDb, entries) {
  const remap = new Map();
  const gone = new Map();
  const markGone = (table, id) => {
    if (!gone.has(table)) gone.set(table, new Set());
    gone.get(table).add(id);
  };
  const rewritten = [];
  let skipped = 0;
  let dropped = 0;
  const raw = Object.getPrototypeOf(targetDb);

  raw.run.call(targetDb, 'SAVEPOINT replay_changes');
  try {
    entries.forEach(entry => {
      if (refersToGone(entry, gone)) {
        dropped += 1;
        // 건너뛴 문장이 행을 넣는 것이었으면 그 행도 없는 것이다 — 그 행을 가리키는 더 뒤 문장도 건너뛴다
        if (entry.insertTable && entry.insertId != null) markGone(entry.insertTable, entry.insertId);
        return;
      }
      const params = remapParams(entry, remap);
      try {
        if (entry.method === 'exec') raw.exec.call(targetDb, entry.sql, params);
        else raw.run.call(targetDb, entry.sql, params);
      } catch (e) {
        if (/UNIQUE constraint failed/i.test(String(e.message || e))) {
          skipped += 1;
          if (entry.insertTable && entry.insertId != null) markGone(entry.insertTable, entry.insertId);
          return;
        }
        throw e;
      }
      const next = { ...entry, params };
      if (entry.insertTable && entry.insertId != null && targetDb.getRowsModified() === 0) {
        // 이 기기에서는 넣었지만 대상 DB에는 들어가지 않았다 — OR IGNORE는 같은 행이 이미 있는 것, 조건부 INSERT…SELECT는 조건이 맞지 않은 것
        if (/^\s*INSERT\s+OR\s+IGNORE\b/i.test(entry.sql)) skipped += 1;
        else dropped += 1;
        markGone(entry.insertTable, entry.insertId);
        return;
      }
      if (entry.insertTable && entry.insertId != null) {
        const newId = raw.exec.call(targetDb, 'SELECT last_insert_rowid()')[0].values[0][0];
        if (newId !== entry.insertId) {
          if (!remap.has(entry.insertTable)) remap.set(entry.insertTable, new Map());
          remap.get(entry.insertTable).set(entry.insertId, newId);
        }
        next.insertId = newId;
      }
      rewritten.push(next);
    });
    raw.run.call(targetDb, 'RELEASE replay_changes');
  } catch (e) {
    raw.run.call(targetDb, 'ROLLBACK TO replay_changes');
    raw.run.call(targetDb, 'RELEASE replay_changes');
    throw e;
  }
  return { entries: rewritten, skipped, dropped };
}

// ── 동기화 표식 ──────────────────────────────────────────────────
// 저장 요청마다 고유 id를 DB 안(settings)에 적어 둔다. 응답을 못 받은 저장이
// 실제로는 반영됐는지(저장소 파일에 그 id가 있는지) 나중에 확인해, 같은 변경을 두 번 넣지 않는다.
//  - sync_write_id: 마지막 저장의 id (되돌리기가 '내 파일이 그대로 올라갔는지' 확인할 때)
//  - sync_write_log: 최근 저장 id들(JSON 배열). 다른 기기가 내 저장 위에 합쳐 저장하면 마지막 id는 그 기기 것으로
//    바뀌지만 이 목록에는 내 id가 남는다 — 그래야 나중에 합치거나 다시 열 때 이미 올라간 변경을 알아본다 (B-088)

const SYNC_KEY = 'sync_write_id';
const SYNC_LOG_KEY = 'sync_write_log';
export const SYNC_LOG_KEEP = 100;

const readSetting = (db, key) => {
  const res = Object.getPrototypeOf(db).exec.call(db, 'SELECT value FROM settings WHERE key = ?', [key]);
  return res[0]?.values[0]?.[0];
};

function readWriteLog(db) {
  try {
    const list = JSON.parse(readSetting(db, SYNC_LOG_KEY) || '[]');
    return Array.isArray(list) ? list.filter(id => typeof id === 'string') : [];
  } catch (e) {
    return []; // 깨진 값은 없는 것으로 본다 — 다음 저장이 새로 쓴다
  }
}

/**
 * 저장 직전에 새 표식을 남긴다. replaces: 이 기기가 같은 버전 위에서 앞서 시도했지만 결과를 모르는 저장의 표식 —
 * 목록에서 뺀다. 그중 실제로 올라간 것이 있으면 이번 저장은 거절되고(버전이 다름) 그 파일에는 그 표식이 이미 있다.
 * 그래서 파일에는 버전 하나당 이 기기의 표식이 많아야 하나만 남고, 오래 오프라인이어도 다른 기기의 표식을 밀어내지 않는다.
 */
export function stampWriteId(db, { replaces = [] } = {}) {
  const id = `w-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const log = [...readWriteLog(db).filter(old => !replaces.includes(old)), id].slice(-SYNC_LOG_KEEP);
  rawRun(db, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [SYNC_KEY, id]);
  rawRun(db, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [SYNC_LOG_KEY, JSON.stringify(log)]);
  return id;
}

export function readWriteId(db) {
  return readSetting(db, SYNC_KEY) || '';
}

/** 이 파일에 그 저장 id가 들어간 적이 있는지 — 마지막 저장이 아니어도(그 위에 다른 기기가 저장했어도) 찾는다 */
export function hasWriteId(db, id) {
  if (!id) return false;
  return readWriteId(db) === id || readWriteLog(db).includes(id);
}

// ── 가계부 세대 (I-035, ROADMAP F-5) ──────────────────────────────
// 가계부를 다른 파일로 통째로 바꾸면(설정 › 데이터 › 가계부 파일로 바꾸기) 새 세대 표시를 남긴다.
// 저장하지 못한 변경은 그 변경의 바탕이 된 가계부와 세대가 같을 때만 다시 실행한다 — 바꾼 가계부에서 같은 번호의 행은
// 전혀 다른 거래라, 다른 기기의 밀린 수정·삭제가 엉뚱한 행에 들어간다. 세대 표시가 없는 가계부는 ''(처음 세대).
// 백업으로 되돌리기는 같은 가계부의 옛 모습이라 세대를 바꾸지 않는다(되돌린 가계부에 밀린 변경을 이어서 저장).
// 표시는 SQLite 파일 머리의 application_id(32비트 정수, 0 = 처음 세대)에 둔다 — 늘 읽혀 있는 첫 페이지라 쓸 때마다
// 읽어도 비용이 없고, 표(settings)에 섞이지 않아 병합·내보내기에 끼지 않는다. (user_version은 스키마 버전이 쓴다)

export function readGeneration(db) {
  if (!db) return 0;
  try {
    return Number(Object.getPrototypeOf(db).exec.call(db, 'PRAGMA application_id')[0]?.values[0]?.[0]) || 0;
  } catch (e) {
    return 0; // 닫힌 DB 등
  }
}

/**
 * 파일 바이트에서 바로 읽는 세대 — SQLite 파일 머리 68~71바이트(application_id, 큰 쪽이 앞). 파일이 없으면 0.
 * 저장·병합 경로는 DB에 질의하지 않고 이것으로 견준다(받은 파일·올린 파일의 바이트가 늘 있다)
 */
export function generationOfBytes(bytes) {
  if (!bytes || bytes.length < 100) return 0;
  // eslint-disable-next-line no-bitwise
  return ((bytes[68] << 24) | (bytes[69] << 16) | (bytes[70] << 8) | bytes[71]) | 0;
}

/** 새 세대 표시를 남긴다(변경 기록에 남지 않게 — 파일째 올리는 DB에만 쓴다). 반환: 새 표시(0이 아닌 정수) */
export function stampGeneration(db) {
  let id = 0;
  while (!id) id = Math.floor(Math.random() * 0x7fffffff);
  // PRAGMA는 값을 ?로 묶을 수 없다 — 여기서 만든 정수만 넣는다 (AGENTS §2-9)
  rawRun(db, `PRAGMA application_id = ${id}`);
  return id;
}

// ── 브라우저 보관 ────────────────────────────────────────────────

const PENDING_PREFIX = 'ledger_pending_changes:';

export function savePending(accountKey, pending) {
  if (!accountKey) return;
  try {
    if (!pending || !pending.entries?.length) window.localStorage.removeItem(PENDING_PREFIX + accountKey);
    else window.localStorage.setItem(PENDING_PREFIX + accountKey, JSON.stringify(pending));
  } catch (e) { /* 저장 공간 부족·비공개 모드 — 메모리의 기록으로만 진행 */ }
}

export function loadPending(accountKey) {
  if (!accountKey) return null;
  try {
    const raw = window.localStorage.getItem(PENDING_PREFIX + accountKey);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && Array.isArray(parsed.entries) && parsed.entries.length ? parsed : null;
  } catch (e) {
    return null;
  }
}

export function clearPending(accountKey) {
  savePending(accountKey, null);
}

/** 이 계정의 가계부들(내 가계부 + 공유받은 가계부의 열쇠 '<계정>#…', M-2)에 보관한 미저장 변경 열쇠 */
function pendingKeysOf(accountKey) {
  if (!accountKey) return [];
  const out = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i) || '';
      if (!k.startsWith(PENDING_PREFIX)) continue;
      const key = k.slice(PENDING_PREFIX.length);
      if (key === accountKey || key.startsWith(`${accountKey}#`)) out.push(key);
    }
  } catch (e) { /* 비공개 모드 */ }
  return out;
}

/** 로그아웃 — 이 계정의 모든 가계부에 보관한 미저장 변경을 지운다 */
export function clearPendingForAccount(accountKey) {
  pendingKeysOf(accountKey).forEach(key => clearPending(key));
}

/** 이 계정의 다른 가계부(exceptKey가 아닌 것)에 보관한 미저장 변경 수 — 로그아웃 전에 묻는다 */
export function countPendingForAccount(accountKey, exceptKey = '') {
  return pendingKeysOf(accountKey)
    .filter(key => key !== exceptKey)
    .reduce((n, key) => n + (loadPending(key)?.entries.length || 0), 0);
}
