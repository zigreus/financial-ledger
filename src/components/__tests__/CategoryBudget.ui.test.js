/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 카테고리별 예산 화면 (I-025, ROADMAP C-5) — 설정(켜고 끄기·상시 예산), 요약의 예산 대비(이 달만 바꾸기), 거래내역 알림
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../services/dbManager';
import { currentYearMonth } from '../../services/dateUtils';
import CategoryBudgetSettings from '../SettingsView/sections/CategoryBudgetSettings';
import CategoryBudgetPanel, { shortWon } from '../SummaryView/CategoryBudgetPanel';
import OpenNotices from '../TransactionList/OpenNotices';
import TransactionList from '../TransactionList/TransactionList';
import SummaryView, { showSummaryMonth } from '../SummaryView/SummaryView';

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  SQL = await initSqlJs();
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const MONTH = currentYearMonth();
let db;
let container;
let root;
beforeEach(() => {
  window.localStorage.clear();
  ({ db } = M.createDatabase(SQL, null));
  M.addPaymentMethod(db, '현금');
  ['식비', '교통'].forEach(c => { M.addBudgetCategory(db, c); M.addSubCategory(db, c, '기타'); });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const spend = (category, amount, discount = 0) => M.addTransaction(db, {
  payment_method: '현금', date: `${MONTH}-01`, budget_category: category, sub_category: '기타', detail: category, amount, discount_amount: discount,
});
const render = el => act(async () => { root.render(el); });
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text || b.title === text);
const click = el => act(async () => { el.click(); });
const setValue = (el, value) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('설정 › 카테고리별 예산', () => {
  let version = 0;
  const setError = vi.fn();
  const onChanged = vi.fn();
  // 실제 앱은 쓰기마다 dataVersion이 올라 다시 그린다 — 여기서는 동작 뒤에 직접 다시 그린다
  const show = () => render(<CategoryBudgetSettings db={db} dataVersion={version += 1} onChanged={onChanged} setError={setError} />);
  const act2 = async (el) => { await click(el); await show(); };

  test('처음에는 꺼져 있어 목록이 없고, 켜면 카테고리마다 미설정 — 상시 예산을 정하고 없앨 수 있다', async () => {
    await show();
    expect(container.querySelector('.cb-settings-list')).toBeNull();
    await act2(button('카테고리별 예산 켜기'));
    expect(M.isCategoryBudgetEnabled(db)).toBe(true);
    expect(onChanged).toHaveBeenCalled();
    const rows = () => [...container.querySelectorAll('.cb-settings-row')].map(r => r.textContent);
    expect(rows()).toEqual(['식비미설정', '교통미설정']);

    await click(button('식비 예산 수정'));
    await setValue(container.querySelector('.cb-settings-edit input'), '40만');
    await click(button('저장'));
    expect(setError).toHaveBeenLastCalledWith('올바른 금액을 입력하세요.');
    await setValue(container.querySelector('.cb-settings-edit input'), '400000');
    await act2(button('저장'));
    expect(rows()).toEqual(['식비400,000원', '교통미설정']);
    expect(M.getDefaultCategoryBudgets(db)).toEqual({ 식비: 400000 });

    await click(button('식비 예산 수정'));
    await act2(button('예산 없애기'));
    expect(M.getDefaultCategoryBudgets(db)).toEqual({});
    expect(rows()).toEqual(['식비미설정', '교통미설정']);
  });

  test('숨긴 카테고리도 예산이 있으면 숨김 표시와 함께 보이고, 목록에 없는 이름의 예산은 따로 보여 지울 수 있다', async () => {
    M.setCategoryBudgetEnabled(db, true);
    M.setDefaultCategoryBudget(db, '교통', 100000);
    db.run("UPDATE budget_categories SET is_hidden = 1 WHERE name IN ('교통', '식비')");
    db.run("INSERT INTO category_budgets (budget_category, year_month, amount) VALUES ('없는카테', '', 1000)");
    await show();
    const rows = [...container.querySelectorAll('.cb-settings-row')].map(r => r.textContent);
    expect(rows).toEqual(['교통숨김100,000원', '없는카테']);       // 예산 없는 숨긴 식비는 보이지 않는다
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act2(button('없는카테 예산 지우기'));
    expect(M.getOrphanCategoryBudgetNames(db)).toEqual([]);
    window.confirm.mockRestore();
  });

  test('끄면 화면에서만 감추고 정해 둔 예산은 남긴다', async () => {
    M.setCategoryBudgetEnabled(db, true);
    M.setDefaultCategoryBudget(db, '교통', 100000);
    await show();
    await act2(button('카테고리별 예산 끄기'));
    expect(container.querySelector('.cb-settings-list')).toBeNull();
    expect(M.getDefaultCategoryBudgets(db)).toEqual({ 교통: 100000 });
  });
});

describe('요약 › 카테고리 — 예산 대비', () => {
  let version = 100;
  const show = () => render(<CategoryBudgetPanel db={db} dataVersion={version += 1} month={MONTH} />);

  test('꺼져 있으면 아무것도 보이지 않는다', async () => {
    M.setDefaultCategoryBudget(db, '식비', 100000);
    await show();
    expect(container.innerHTML).toBe('');
  });

  test('켰는데 예산이 없으면 어디서 정하는지 알리고, 지난 달이면 상시 예산은 정한 달부터라고 알린다', async () => {
    M.setCategoryBudgetEnabled(db, true);
    await show();
    expect(container.textContent).toContain('설정 › 지출계획 › 예산');
    await render(<CategoryBudgetPanel db={db} dataVersion={version += 1} month="2020-01" />);
    expect(container.textContent).toContain('이 달에는 정해 둔 예산이 없었어요');
  });

  test('순지출로 남은·넘은 금액과 주의·초과를 보이고, 이 달만 바꾸거나 상시 예산으로 되돌린다', async () => {
    M.setCategoryBudgetEnabled(db, true);
    M.setDefaultCategoryBudget(db, '식비', 100000);
    M.setDefaultCategoryBudget(db, '교통', 50000);
    spend('식비', 95000, 10000);                 // 순 85,000 → 85% 주의
    spend('교통', 51000);                         // 102% 초과
    await show();
    const rows = () => [...container.querySelectorAll('.cb-row')];
    expect(rows().map(r => r.className)).toEqual(['cb-row cb-row--warn', 'cb-row cb-row--over']);
    expect(rows()[0].textContent).toContain('15,000원 남음');
    expect(rows()[0].textContent).toContain('거의 다 썼어요');
    expect(rows()[1].textContent).toContain('1,000원 초과');

    await click(rows()[0].querySelector('.cb-row-main'));
    await setValue(container.querySelector('.cb-edit input'), '200000');
    await click(button('이 달만 바꾸기'));
    await show();
    expect(rows()[0].className).toBe('cb-row cb-row--ok');
    expect(rows()[0].textContent).toContain('이 달만');
    expect(M.getDefaultCategoryBudgets(db).식비).toBe(100000);   // 상시 예산은 그대로

    await click(rows()[0].querySelector('.cb-row-main'));
    expect(rows()[0].querySelector('.cb-row-main').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.cb-edit input').getAttribute('aria-label')).toBe(`${MONTH} 식비 예산`);
    await click(button('상시 예산으로'));
    await show();
    expect(rows()[0].textContent).not.toContain('이 달만');
  });

  test('상시 예산 없이 그 달만 정한 예산은 "이 달 예산 없애기"로 지운다 (문구 = 동작)', async () => {
    M.setCategoryBudgetEnabled(db, true);
    M.setMonthCategoryBudget(db, '교통', MONTH, 30000);
    await show();
    await click(container.querySelector('.cb-row-main'));
    expect(button('상시 예산으로')).toBeUndefined();
    await click(button('이 달 예산 없애기'));
    await show();
    expect(container.querySelector('.cb-row')).toBeNull();
  });
});

test('짧은 금액 — 반올림한 뒤 소수점을 정한다 ("10.0만"이 아니라 "10만")', () => {
  expect([9999, 15000, 99999, 340000, 1999999].map(shortWon)).toEqual(['9,999원', '1.5만', '10만', '34만', '200만']);
});

describe('요약 화면에서 — 그 달 카테고리 탭에서만, 달을 바꾸면 편집 칸을 닫는다', () => {
  const showSummary = (extra = {}) => render(
    <SummaryView db={db} dataVersion={1} tab="category" drilldownCategory={null} onTabChange={() => {}} onDrilldownChange={() => {}} {...extra} />,
  );

  beforeEach(() => {
    M.setCategoryBudgetEnabled(db, true);
    M.setDefaultCategoryBudget(db, '식비', 100000);
    spend('식비', 50000);
    M.addTransaction(db, { payment_method: '현금', date: '2025-01-05', budget_category: '식비', sub_category: '기타', detail: '예전', amount: 1000 });
  });

  test('알림에서 넘어오면(showSummaryMonth) 그 달 예산 대비가 보인다', async () => {
    showSummaryMonth(MONTH);
    await showSummary();
    expect(container.querySelector('.cb-panel').textContent).toContain('식비');
  });

  test("'전체 기간'·세부 보기에서는 보이지 않는다", async () => {
    showSummaryMonth('');
    await showSummary();
    expect(container.querySelector('.cb-panel')).toBeNull();
    showSummaryMonth(MONTH);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await showSummary({ drilldownCategory: '식비' });
    expect(container.querySelector('.cb-panel')).toBeNull();
  });

  test('연도별로 바꾸면 사라지고, 달을 바꾸면 열려 있던 편집 칸이 닫힌다', async () => {
    M.setMonthCategoryBudget(db, '식비', '2025-01', 1000);       // 바꿀 달에도 식비 예산 줄이 있다
    showSummaryMonth(MONTH);
    await showSummary();
    await click(container.querySelector('.cb-row-main'));
    expect(container.querySelector('.cb-edit')).not.toBeNull();
    const select = container.querySelector('.filter-inputs select');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, '2025-01');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('.cb-row').textContent).toContain('1,000원');   // 그 달의 줄은 보이고
    expect(container.querySelector('.cb-edit')).toBeNull();                         // 앞 달의 편집 칸은 닫혔다
    await click([...container.querySelectorAll('.filter-type-btn')].find(b => b.textContent.trim() === '연도별'));
    expect(container.querySelector('.cb-panel')).toBeNull();
  });
});

describe('거래내역 — 예산 알림', () => {
  const props = () => ({
    db, dataVersion: 0, onAdd: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onChanged: vi.fn(),
    onOpenImport: vi.fn(), onOpenCardCheck: vi.fn(), onOpenAccount: vi.fn(), onOpenOnboarding: vi.fn(), onOpenSettings: vi.fn(),
  });

  test('80% 이상·초과한 카테고리를 알리고, 누르면 그 달 예산 대비로, 닫으면 오늘은 다시 보이지 않는다', async () => {
    const onOpenBudget = vi.fn();
    const alerts = [
      { category: '식비', budget: 100000, spent: 85000, ratio: 0.85, level: 'warn' },
      { category: '교통', budget: 50000, spent: 51000, ratio: 1.02, level: 'over' },
    ];
    await render(<OpenNotices budgetAlerts={alerts} onOpenBudget={onOpenBudget} />);
    expect(container.textContent).toContain('식비 이번 달 예산의 85%를 썼어요 (15,000원 남음)');
    expect(container.textContent).toContain('교통 이번 달 예산 50,000원을 1,000원 넘었어요');
    await click(container.querySelector('.balance-alert-link'));
    expect(onOpenBudget).toHaveBeenCalled();
    await click(container.querySelector('.balance-alert-close'));
    expect(container.querySelector('.open-notice-budget')).toBeNull();
    await render(<div />);
    await render(<OpenNotices budgetAlerts={alerts} onOpenBudget={onOpenBudget} />);
    expect(container.querySelector('.open-notice-budget')).toBeNull();
    // 식비가 80% 아래로 내려가도 이미 닫은 교통 초과는 다시 뜨지 않는다
    await render(<OpenNotices budgetAlerts={[alerts[1]]} onOpenBudget={onOpenBudget} />);
    expect(container.querySelector('.open-notice-budget')).toBeNull();
    // 식비가 주의에서 초과로 바뀌면 그것만 새로 알린다
    await render(<OpenNotices budgetAlerts={[{ ...alerts[0], spent: 120000, ratio: 1.2, level: 'over' }, alerts[1]]} onOpenBudget={onOpenBudget} />);
    expect([...container.querySelectorAll('.open-notice-budget')].map(li => li.textContent)).toEqual([
      expect.stringContaining('식비 이번 달 예산 100,000원을 20,000원 넘었어요'),
    ]);
  });

  test('거래내역 첫 화면 — 켰을 때만, 넘긴 카테고리가 있을 때만 보인다', async () => {
    M.setDefaultCategoryBudget(db, '식비', 100000);
    spend('식비', 90000);
    await render(<TransactionList {...props()} />);
    expect(container.querySelector('.open-notice-budget')).toBeNull();              // 꺼져 있다
    M.setCategoryBudgetEnabled(db, true);
    const onOpenBudget = vi.fn();
    await render(<TransactionList {...props()} dataVersion={1} onOpenBudget={onOpenBudget} />);
    expect(container.querySelector('.open-notice-budget').textContent).toContain('식비');
    await click(container.querySelector('.open-notice-budget .balance-alert-link'));
    expect(onOpenBudget).toHaveBeenCalledWith(MONTH);
  });
});
