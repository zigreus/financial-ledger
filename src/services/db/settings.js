// 앱 설정(settings 테이블)과 월 목표금액.

import { withTransaction } from './common';
import { getBudgetCategories } from './masterData';
import { getMonthlyTotals } from './summary';

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
