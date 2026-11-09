/**
 * 가계부 파일 살피기 (I-035, ROADMAP F-5) — '가계부 파일로 바꾸기' 전에 올린 .db가 이 앱의 가계부인지 확인하고,
 * 지금 가계부와 견줄 수 있게 무엇이 들었는지 센다. DB에는 쓰지 않는다(메모리에서 열고 닫는다).
 * 다른 계정(OneDrive ↔ Google Drive)으로 옮길 때: 옛 계정에서 '가계부 파일(.db) 내려받기' → 새 계정에서 '가계부 파일로 바꾸기'.
 */
import { initSQL, createDatabase } from './dbManager';

// 이 앱의 가계부라면 꼭 있는 테이블
const REQUIRED_TABLES = ['transactions', 'budget_categories', 'payment_methods', 'settings'];

const count = (db, sql) => {
  try { return Number(db.exec(sql)[0]?.values[0]?.[0]) || 0; } catch (e) { return 0; }
};

/** 가계부에 든 것 — { transactions, from, to, categories, paymentMethods, accounts, events, recurring } */
export function ledgerSummary(db) {
  let from = '';
  let to = '';
  try {
    const [[min, max] = []] = db.exec('SELECT MIN(date), MAX(date) FROM transactions')[0]?.values || [];
    from = min || '';
    to = max || '';
  } catch (e) { /* 비어 있음 */ }
  return {
    transactions: count(db, 'SELECT COUNT(*) FROM transactions'),
    from,
    to,
    categories: count(db, 'SELECT COUNT(*) FROM budget_categories'),
    paymentMethods: count(db, 'SELECT COUNT(*) FROM payment_methods'),
    accounts: count(db, 'SELECT COUNT(*) FROM accounts'),
    events: count(db, 'SELECT COUNT(*) FROM calendar_events'),
    recurring: count(db, 'SELECT COUNT(*) FROM recurring_transactions'),
  };
}

/**
 * 올린 파일을 살핀다 — 이 앱의 가계부가 아니거나, 더 새 버전 앱의 것이거나, 옮겨 열 수 없으면 이유를 담아 던진다.
 * 반환: ledgerSummary (옛 버전 파일은 지금 버전으로 옮겨 연 뒤 센다 — 바꿀 때도 같은 방법으로 연다)
 */
export async function inspectLedgerFile(bytes) {
  const SQL = await initSQL();
  let raw = null;
  try {
    raw = new SQL.Database(bytes);
    const tables = new Set((raw.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0]?.values || []).map(r => r[0]));
    if (!REQUIRED_TABLES.every(t => tables.has(t))) throw new Error('이 앱의 가계부 파일이 아닙니다 — 설정 › 데이터에서 내려받은 가계부 파일(.db)을 고르세요.');
  } catch (e) {
    if (/가계부 파일이 아닙니다/.test(e.message)) throw e;
    throw new Error('가계부 파일(.db)이 아니거나 손상된 파일입니다.');
  } finally {
    if (raw) raw.close();
  }
  const opened = createDatabase(SQL, bytes);
  try {
    if (opened.newerSchema) throw new Error('더 새 버전의 앱에서 만든 파일입니다 — 페이지를 새로고침해 앱을 업데이트한 뒤 다시 해 주세요.');
    if (opened.migrationErrors.length) throw new Error(`파일을 여는 중 오류: ${opened.migrationErrors.join(' / ')}`);
    return ledgerSummary(opened.db);
  } finally {
    opened.db.close();
  }
}
