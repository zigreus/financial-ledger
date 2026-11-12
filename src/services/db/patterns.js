// 입력 습관 — 세부카테고리별 자동 결제수단, 세부내역 패턴(AI 입력 추천용).

import { toDateStr } from '../dateUtils';
import { dbRowsToObjects, normalizeName } from './common';

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
 * 세부내역을 비워 두는 습관 — 세부카테고리마다, 세부내역을 비우거나 카테고리 이름만 되풀이해 적은 횟수.
 * 예) '식비 > 저녁'은 보통 세부내역 없이 적는다. AI 입력이 이런 곳의 세부내역을 억지로 채우지 않게 알려 준다.
 * 최근 sinceMonths개월, minTotal건 이상이고 비운 비율이 minRatio 이상인 것만, 많이 쓴 순.
 * 반환: [{ budget_category, sub_category, blank, total }]
 */
export function getBlankDetailHabits(db, { sinceMonths = 12, minTotal = 3, minRatio = 0.5, limit = 30 } = {}) {
  if (!db) return [];
  const d = new Date();
  d.setMonth(d.getMonth() - sinceMonths);
  const res = db.exec(
    `SELECT budget_category, sub_category, detail, COUNT(*) AS cnt
     FROM transactions
     WHERE date >= ? AND COALESCE(sub_category, '') != '' AND COALESCE(is_cash_adjustment, 0) = 0
     GROUP BY budget_category, sub_category, detail`,
    [toDateStr(d)]
  );
  const bySub = new Map();
  (res[0]?.values || []).forEach(([cat, sub, detail, cnt]) => {
    const key = `${cat}\u0000${sub}`;
    const row = bySub.get(key) || { budget_category: cat, sub_category: sub, blank: 0, total: 0 };
    // 글자가 하나도 없는 세부내역(이모지·기호뿐)은 비운 것으로 보지 않는다 — 그대로 적은 것이다
    const raw = String(detail || '').trim();
    const name = normalizeName(raw);
    if (!raw || (name && (name === normalizeName(sub) || name === normalizeName(cat)))) row.blank += Number(cnt);
    row.total += Number(cnt);
    bySub.set(key, row);
  });
  return [...bySub.values()]
    .filter(r => r.total >= minTotal && r.blank / r.total >= minRatio)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
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
