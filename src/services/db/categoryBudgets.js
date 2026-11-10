// 카테고리별 예산 (I-025, ROADMAP C-5) — 선택 기능: 설정에서 켜야 화면에 보인다(가족 공통 설정).
//
// 상시 기본값(year_month = '')과 월별 덮어쓰기('YYYY-MM')를 둔다 — 월 목표금액과 비슷한 구조.
//  - 상시 줄의 since: 그 값을 쓰기 시작한 달. 그 전 달에는 쓰지 않는다(예산을 정하기 전 달은 예산 없음).
//  - 상시 값을 바꾸면 이번 달부터 새 값. 옛 값을 실제로 쓰던 지난 달(since ~ 지난달, 그 카테고리 지출이 있던 달)에만
//    그때 예산을 월별 줄로 남긴다(kept = 1, 화면에 '그때 예산'). 같은 달 안에서 고치면(오타 정정) 남기지 않는다.
// 비교 금액은 순지출(amount - discount_amount, AGENTS §4·B-051) — 요약 화면의 카테고리 합계와 같은 계산(getMonthlySummary).
// 카테고리는 이름으로 참조한다 — masterData의 renameBudgetCategory·deleteBudgetCategory가 함께 고친다(AGENTS §3).
// 카테고리 목록에 없는 이름의 예산(다른 기기가 카테고리를 지운 사이 정한 것 등)은 예산 대비에서 빼고, 설정에서 지울 수 있게 보인다.

import { withTransaction } from './common';
import { getSetting, setSetting } from './settings';
import { getMonthlySummary } from './summary';
import { currentYearMonth } from '../dateUtils';

export const CATEGORY_BUDGET_SETTING = 'category_budget_enabled';
/** 이 비율을 넘으면 '거의 다 씀'으로 알린다 */
export const BUDGET_WARN_RATIO = 0.8;

const rowsOf = res => res[0]?.values || [];

export function isCategoryBudgetEnabled(db) {
  return !!db && getSetting(db, CATEGORY_BUDGET_SETTING, '0') === '1';
}

export function setCategoryBudgetEnabled(db, enabled) {
  setSetting(db, CATEGORY_BUDGET_SETTING, enabled ? '1' : '0');
}

/** 그 카테고리에 정해 둔 예산 줄 수(상시·월별) — 카테고리를 지울 때 알리려고 */
export function countCategoryBudgets(db, category) {
  return Number(rowsOf(db.exec('SELECT COUNT(*) FROM category_budgets WHERE budget_category = ?', [category]))[0]?.[0]) || 0;
}

/** 상시 기본 예산 { 카테고리: 금액 } */
export function getDefaultCategoryBudgets(db) {
  const map = {};
  rowsOf(db.exec("SELECT budget_category, amount FROM category_budgets WHERE year_month = ''"))
    .forEach(([cat, amount]) => { map[cat] = Number(amount); });
  return map;
}

/**
 * 그 달에 쓰는 예산 { 카테고리: { amount, source, hasDefault } }
 *  - source: 'month'(그 달만 정함) | 'kept'(상시를 바꿀 때 남긴 그때 예산) | 'default'(상시)
 *  - hasDefault: 그 달에 쓸 상시 예산이 있는지(그 달 줄을 지우면 상시로 돌아가는지)
 */
export function getCategoryBudgetsForMonth(db, yearMonth) {
  const rows = rowsOf(db.exec(
    "SELECT budget_category, year_month, amount, since, kept FROM category_budgets WHERE year_month IN ('', ?)",
    [yearMonth],
  ));
  const defaults = {};
  const months = {};
  rows.forEach(([cat, ym, amount, since, kept]) => {
    if (ym === '') {
      if (!since || since <= yearMonth) defaults[cat] = Number(amount);
    } else {
      months[cat] = { amount: Number(amount), source: kept ? 'kept' : 'month' };
    }
  });
  const map = {};
  new Set([...Object.keys(defaults), ...Object.keys(months)]).forEach((cat) => {
    const hasDefault = defaults[cat] !== undefined;
    map[cat] = months[cat]
      ? { ...months[cat], hasDefault }
      : { amount: defaults[cat], source: 'default', hasDefault };
  });
  return map;
}

/**
 * 상시 기본 예산을 바꾸거나(amount) 없앤다(null). 이번 달부터 새 값을 쓴다.
 * 옛 값을 실제로 쓰던 지난 달(옛 값의 since ~ 지난달 중 그 카테고리 지출이 있고 그 달 줄이 없는 달)에만 그때 예산을 남긴다.
 * 같은 값이면 아무것도 하지 않는다.
 */
export function setDefaultCategoryBudget(db, category, amount, thisMonth = currentYearMonth()) {
  const next = amount === null ? null : Math.round(amount);
  const old = rowsOf(db.exec(
    "SELECT amount, since FROM category_budgets WHERE budget_category = ? AND year_month = ''",
    [category],
  ))[0];
  if (old && next !== null && Number(old[0]) === next) return;
  if (!old && next === null) return;
  withTransaction(db, () => {
    if (old) {
      const [oldAmount, oldSince] = old;
      const months = rowsOf(db.exec(
        `SELECT DISTINCT strftime('%Y-%m', date) AS ym FROM transactions
         WHERE budget_category = ? AND strftime('%Y-%m', date) >= ? AND strftime('%Y-%m', date) < ?`,
        [category, oldSince || '0000-00', thisMonth],
      ));
      months.forEach(([ym]) => {
        db.run(
          'INSERT OR IGNORE INTO category_budgets (budget_category, year_month, amount, kept) VALUES (?, ?, ?, 1)',
          [category, ym, Number(oldAmount)],
        );
      });
    }
    if (next === null) {
      db.run("DELETE FROM category_budgets WHERE budget_category = ? AND year_month = ''", [category]);
    } else {
      db.run(
        "INSERT OR REPLACE INTO category_budgets (budget_category, year_month, amount, since, kept) VALUES (?, '', ?, ?, 0)",
        [category, next, thisMonth],
      );
    }
  });
}

/** 그 달만 예산을 바꾸거나(amount) 그 달 줄을 지운다(null — 상시 예산이 있으면 그것으로 돌아간다) */
export function setMonthCategoryBudget(db, category, yearMonth, amount) {
  if (amount === null) {
    db.run('DELETE FROM category_budgets WHERE budget_category = ? AND year_month = ?', [category, yearMonth]);
  } else {
    db.run(
      'INSERT OR REPLACE INTO category_budgets (budget_category, year_month, amount, kept) VALUES (?, ?, ?, 0)',
      [category, yearMonth, Math.round(amount)],
    );
  }
}

/** 한 카테고리의 예산 줄 전부 — AI 명령의 되돌리기가 바꾸기 전 모습으로 쓴다 (I-051) */
export function snapshotCategoryBudgets(db, category) {
  return rowsOf(db.exec(
    'SELECT year_month, amount, since, kept FROM category_budgets WHERE budget_category = ? ORDER BY year_month',
    [category],
  )).map(([yearMonth, amount, since, kept]) => ({ yearMonth, amount, since, kept }));
}

/** snapshotCategoryBudgets로 남긴 모습으로 되돌린다 */
export function restoreCategoryBudgets(db, category, rows) {
  withTransaction(db, () => {
    db.run('DELETE FROM category_budgets WHERE budget_category = ?', [category]);
    rows.forEach(r => db.run(
      'INSERT INTO category_budgets (budget_category, year_month, amount, since, kept) VALUES (?, ?, ?, ?, ?)',
      [category, r.yearMonth, r.amount, r.since, r.kept],
    ));
  });
}

/** 카테고리 목록에 없는 이름의 예산 — 설정에서 지울 수 있게 보인다 */
export function getOrphanCategoryBudgetNames(db) {
  return rowsOf(db.exec(
    'SELECT DISTINCT budget_category FROM category_budgets WHERE budget_category NOT IN (SELECT name FROM budget_categories) ORDER BY budget_category',
  )).map(([name]) => name);
}

/** 그 이름의 예산을 모두 지운다 (목록에 없는 카테고리의 예산 정리) */
export function deleteCategoryBudgets(db, category) {
  db.run('DELETE FROM category_budgets WHERE budget_category = ?', [category]);
}

/**
 * 그 달 예산 대비 — 예산이 있는 카테고리만(카테고리 목록에 있는 것만), 카테고리 순서대로.
 * [{ category, budget, spent, ratio, level: 'ok' | 'warn' | 'over', source, hasDefault, hidden }]
 *  - spent: 순지출(지출 - 할인), ratio: spent / budget (예산 0이면 쓴 것이 있을 때 over)
 *  - level: 80% 이상 warn, 100% 넘으면 over
 */
export function getCategoryBudgetStatus(db, yearMonth) {
  if (!db || !yearMonth) return [];
  const budgets = getCategoryBudgetsForMonth(db, yearMonth);
  const cats = rowsOf(db.exec('SELECT name, is_hidden FROM budget_categories ORDER BY sort_order, name'));
  const listed = cats.filter(([name]) => budgets[name]);
  if (!listed.length) return [];
  const spentBy = {};
  getMonthlySummary(db, yearMonth).forEach(r => {
    spentBy[r.budget_category] = (Number(r.total) || 0) - (Number(r.discount) || 0);
  });
  return listed.map(([category, isHidden]) => {
    const { amount: budget, source, hasDefault } = budgets[category];
    const spent = spentBy[category] || 0;
    const ratio = budget > 0 ? spent / budget : (spent > 0 ? Infinity : 0);
    let level = 'ok';
    if (ratio > 1) level = 'over';
    else if (ratio >= BUDGET_WARN_RATIO) level = 'warn';
    return { category, budget, spent, ratio, level, source, hasDefault, hidden: !!isHidden };
  });
}
