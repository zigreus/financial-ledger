// 즐겨찾기 거래 템플릿과 즐겨찾기 자동 추천 기록.

import { withTransaction } from './common';

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
