// 카테고리별 예산 (I-025, ROADMAP C-5) — 상시 기본값·월별 덮어쓰기, 순지출 기준 예산 대비, 이름 변경·삭제 연동, 병합
import initSqlJs from 'sql.js';
import {
  createDatabase, addTransaction, addBudgetCategory, addSubCategory,
  isCategoryBudgetEnabled, setCategoryBudgetEnabled, getDefaultCategoryBudgets, getCategoryBudgetsForMonth,
  setDefaultCategoryBudget, setMonthCategoryBudget, getCategoryBudgetStatus, countCategoryBudgets,
  getOrphanCategoryBudgetNames, deleteCategoryBudgets, renameBudgetCategory, deleteBudgetCategory, SCHEMA_VERSION,
} from '../dbManager';
import { attachChangeLog, getChangeLog, replayChanges } from '../changeLog';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

function makeDb() {
  const { db } = createDatabase(SQL, null);
  ['식비', '교통', '여가'].forEach(c => { addBudgetCategory(db, c); addSubCategory(db, c, '기타'); });
  return db;
}
const spend = (db, category, date, amount, discount = 0) => addTransaction(db, {
  payment_method: '현금', date, budget_category: category, sub_category: '기타', detail: category, amount, discount_amount: discount,
});
const budgetOf = (db, ym, cat) => getCategoryBudgetsForMonth(db, ym)[cat];
const rowCount = db => Number(db.exec('SELECT COUNT(*) FROM category_budgets')[0].values[0][0]);

test('스키마: 새 표가 있고 버전이 올랐다 — 예전(v3) 파일은 처음 열 때 한 번만 바꾼다', () => {
  const db = makeDb();
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
  expect(db.exec("SELECT name FROM sqlite_master WHERE name = 'category_budgets'")[0].values).toHaveLength(1);

  db.run('DROP TABLE category_budgets');
  db.run('PRAGMA user_version = 3');
  const v3 = db.export();
  const first = createDatabase(SQL, v3);
  expect(first.didMigrate).toBe(true);
  expect(first.db.exec("SELECT name FROM sqlite_master WHERE name = 'category_budgets'")[0].values).toHaveLength(1);
  expect(createDatabase(SQL, first.db.export()).didMigrate).toBe(false);
});

test('선택 기능 — 처음에는 꺼져 있고 켜고 끌 수 있다', () => {
  const db = makeDb();
  expect(isCategoryBudgetEnabled(db)).toBe(false);
  setCategoryBudgetEnabled(db, true);
  expect(isCategoryBudgetEnabled(db)).toBe(true);
  setCategoryBudgetEnabled(db, false);
  expect(isCategoryBudgetEnabled(db)).toBe(false);
});

test('상시 예산은 정한 달부터 쓴다(그 전 달은 예산 없음). 그 달만 덮어쓰기와 지우기', () => {
  const db = makeDb();
  setDefaultCategoryBudget(db, '식비', 400000, '2026-11');
  expect(budgetOf(db, '2026-10', '식비')).toBeUndefined();
  expect(budgetOf(db, '2026-11', '식비')).toEqual({ amount: 400000, source: 'default', hasDefault: true });
  setMonthCategoryBudget(db, '식비', '2026-12', 600000);
  setMonthCategoryBudget(db, '교통', '2026-12', 100000);
  expect(getDefaultCategoryBudgets(db)).toEqual({ 식비: 400000 });
  expect(getCategoryBudgetsForMonth(db, '2026-12')).toEqual({
    식비: { amount: 600000, source: 'month', hasDefault: true },
    교통: { amount: 100000, source: 'month', hasDefault: false },
  });
  setMonthCategoryBudget(db, '식비', '2026-12', null);           // 상시 예산으로
  expect(budgetOf(db, '2026-12', '식비')).toEqual({ amount: 400000, source: 'default', hasDefault: true });
  setMonthCategoryBudget(db, '교통', '2026-12', null);           // 상시가 없으니 그 달 예산이 없어진다
  expect(budgetOf(db, '2026-12', '교통')).toBeUndefined();
});

test('상시 예산을 바꾸면 이번 달부터 새 값 — 옛 값을 실제로 쓰던 지난 달(지출이 있던 달)만 그때 예산으로 남긴다', () => {
  const db = makeDb();
  spend(db, '식비', '2026-06-10', 10000);                         // 예산을 정하기 전 달
  setDefaultCategoryBudget(db, '식비', 400000, '2026-09');
  spend(db, '식비', '2026-09-10', 10000);
  spend(db, '식비', '2026-10-10', 10000);
  spend(db, '식비', '2026-11-03', 10000);
  setDefaultCategoryBudget(db, '식비', 500000, '2026-11');        // 11월에 바꿈
  expect(budgetOf(db, '2026-06', '식비')).toBeUndefined();          // 정하기 전 달은 남기지 않는다
  expect(budgetOf(db, '2026-09', '식비')).toEqual({ amount: 400000, source: 'kept', hasDefault: false });
  expect(budgetOf(db, '2026-10', '식비')).toEqual({ amount: 400000, source: 'kept', hasDefault: false });
  expect(budgetOf(db, '2026-11', '식비')).toEqual({ amount: 500000, source: 'default', hasDefault: true });
  expect(budgetOf(db, '2027-01', '식비').amount).toBe(500000);
  // 지난 달에 사용자가 그 달만 정해 둔 값은 그대로
  setMonthCategoryBudget(db, '식비', '2026-10', 450000);
  setDefaultCategoryBudget(db, '식비', null, '2026-12');          // 12월에 상시 예산 없애기
  expect(budgetOf(db, '2026-10', '식비')).toEqual({ amount: 450000, source: 'month', hasDefault: false });
  expect(budgetOf(db, '2026-11', '식비')).toEqual({ amount: 500000, source: 'kept', hasDefault: false });
  expect(budgetOf(db, '2026-12', '식비')).toBeUndefined();
});

test('같은 값을 다시 저장하거나 같은 달 안에서 고치면(오타 정정) 지난 달을 남기지 않는다', () => {
  const db = makeDb();
  ['2026-01', '2026-05', '2026-09'].forEach(m => spend(db, '식비', `${m}-10`, 10000));
  setDefaultCategoryBudget(db, '식비', 400000, '2026-11');
  setDefaultCategoryBudget(db, '식비', 400000, '2026-11');        // 그대로 저장
  setDefaultCategoryBudget(db, '식비', 4000000, '2026-11');       // 오타
  setDefaultCategoryBudget(db, '식비', 400000, '2026-11');        // 바로 고침
  expect(rowCount(db)).toBe(1);
  expect(budgetOf(db, '2026-11', '식비').amount).toBe(400000);
  expect(budgetOf(db, '2026-09', '식비')).toBeUndefined();
});

test('예산 대비는 순지출(지출 - 할인) — 80% 이상 주의, 100% 넘으면 초과(딱 100%는 주의), 예산 있는 카테고리만 카테고리 순서로', () => {
  const db = makeDb();
  setDefaultCategoryBudget(db, '여가', 100000, '2026-11');
  setDefaultCategoryBudget(db, '식비', 100000, '2026-11');
  setDefaultCategoryBudget(db, '교통', 100000, '2026-11');
  spend(db, '식비', '2026-11-01', 90000, 15000);   // 순 75,000 → 75%
  spend(db, '교통', '2026-11-02', 80000);          // 80% → 주의
  spend(db, '여가', '2026-11-03', 100000);          // 100% → 주의
  spend(db, '여가', '2026-10-03', 999999);          // 다른 달은 셈하지 않는다
  const status = getCategoryBudgetStatus(db, '2026-11');
  expect(status.map(r => [r.category, r.spent, r.level])).toEqual([
    ['식비', 75000, 'ok'], ['교통', 80000, 'warn'], ['여가', 100000, 'warn'],
  ]);
  spend(db, '여가', '2026-11-04', 1);
  expect(getCategoryBudgetStatus(db, '2026-11').find(r => r.category === '여가').level).toBe('over');
  expect(getCategoryBudgetStatus(db, '2026-12').map(r => r.spent)).toEqual([0, 0, 0]);
});

test('숨긴 카테고리의 예산은 숨김 표시와 함께 셈하고, 목록에 없는 이름의 예산은 빼고 따로 알려 지울 수 있다', () => {
  const db = makeDb();
  setDefaultCategoryBudget(db, '여가', 300000, '2026-11');
  db.run("UPDATE budget_categories SET is_hidden = 1 WHERE name = '여가'");
  expect(getCategoryBudgetStatus(db, '2026-11')).toEqual([expect.objectContaining({ category: '여가', hidden: true })]);

  db.run("INSERT INTO category_budgets (budget_category, year_month, amount, since) VALUES ('없는카테', '', 1000, '2026-01')");
  expect(getCategoryBudgetStatus(db, '2026-11').map(r => r.category)).toEqual(['여가']);
  expect(getOrphanCategoryBudgetNames(db)).toEqual(['없는카테']);
  deleteCategoryBudgets(db, '없는카테');
  expect(getOrphanCategoryBudgetNames(db)).toEqual([]);
});

test('카테고리 이름을 바꾸면 예산도 따라가고(그 이름으로 남아 있던 다른 예산은 지운다), 지우면 예산도 지운다 (AGENTS §3)', () => {
  const db = makeDb();
  setDefaultCategoryBudget(db, '여가', 100000, '2026-11');
  setMonthCategoryBudget(db, '여가', '2026-12', 50000);
  // 다른 기기가 '취미' 카테고리를 지운 사이 정한 예산이 남아 있다
  db.run("INSERT INTO category_budgets (budget_category, year_month, amount) VALUES ('취미', '2026-12', 1)");
  renameBudgetCategory(db, '여가', '취미');
  expect(countCategoryBudgets(db, '여가')).toBe(0);
  expect(budgetOf(db, '2026-12', '취미')).toEqual({ amount: 50000, source: 'month', hasDefault: true });
  db.run("DELETE FROM sub_categories WHERE budget_category = '취미'");
  expect(countCategoryBudgets(db, '취미')).toBe(2);
  deleteBudgetCategory(db, '취미');
  expect(countCategoryBudgets(db, '취미')).toBe(0);
});

test('처음 만든 표(since·kept 칸 없음)로 연 가계부도 칸을 더해 고친다 — 칸이 있으면 바꾸지 않는다', () => {
  const db = makeDb();
  db.run('DROP TABLE category_budgets');
  db.run("CREATE TABLE category_budgets (budget_category TEXT NOT NULL, year_month TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL, PRIMARY KEY (budget_category, year_month))");
  db.run("INSERT INTO category_budgets VALUES ('식비', '', 400000)");
  const opened = createDatabase(SQL, db.export());
  expect(opened.migrationErrors).toEqual([]);
  expect(opened.didMigrate).toBe(true);
  expect(budgetOf(opened.db, '2026-11', '식비')).toEqual({ amount: 400000, source: 'default', hasDefault: true });
  expect(createDatabase(SQL, opened.db.export()).didMigrate).toBe(false);
});

test('병합 — 이름 변경을 다시 실행해도 그 사이 다른 기기가 만든 같은 이름 카테고리의 예산은 지우지 않는다', () => {
  const base = makeDb();
  setDefaultCategoryBudget(base, '식비', 300000, '2026-11');
  const bytes = base.export();

  const mine = createDatabase(SQL, bytes).db;            // 이 기기: 식비 → 먹거리
  attachChangeLog(mine);
  renameBudgetCategory(mine, '식비', '먹거리');
  const entries = getChangeLog(mine).entries;

  const remote = createDatabase(SQL, bytes).db;          // 다른 기기: 먹거리를 만들고 50만 예산
  addBudgetCategory(remote, '먹거리');
  setDefaultCategoryBudget(remote, '먹거리', 500000, '2026-11');
  replayChanges(remote, entries);
  expect(getDefaultCategoryBudgets(remote).먹거리).toBe(500000);
});

test('병합 — 예산 변경 기록을 다른 기기가 바꾼 최신 파일에 다시 실행해도 맞게 들어간다', () => {
  const base = makeDb();
  spend(base, '식비', '2026-10-10', 10000);
  setDefaultCategoryBudget(base, '식비', 400000, '2026-10');
  const bytes = base.export();

  const mine = createDatabase(SQL, bytes).db;            // 이 기기: 상시 예산을 바꾸고 그 달만 정함
  attachChangeLog(mine);
  setDefaultCategoryBudget(mine, '식비', 500000, '2026-11');
  setMonthCategoryBudget(mine, '교통', '2026-11', 70000);
  const entries = getChangeLog(mine).entries;

  const remote = createDatabase(SQL, bytes).db;          // 다른 기기: 그 사이 여가 예산을 정했다
  setDefaultCategoryBudget(remote, '여가', 90000, '2026-11');
  const { dropped } = replayChanges(remote, entries);
  expect(dropped).toBe(0);
  expect(getCategoryBudgetsForMonth(remote, '2026-11')).toEqual({
    식비: { amount: 500000, source: 'default', hasDefault: true },
    교통: { amount: 70000, source: 'month', hasDefault: false },
    여가: { amount: 90000, source: 'default', hasDefault: true },
  });
  expect(budgetOf(remote, '2026-10', '식비')).toEqual({ amount: 400000, source: 'kept', hasDefault: false });
});
