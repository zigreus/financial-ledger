/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 수입·월 수지 화면 (I-026, ROADMAP C-6) — 설정(켜고 끄기·수입으로 셀 계좌), 요약 › 월별 추이의 이 달 수지·수입/남은 돈
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../services/dbManager';
import { currentYearMonth, todayStr, addDays } from '../../services/dateUtils';
import MonthlyBalanceSettings from '../SettingsView/sections/MonthlyBalanceSettings';
import MonthlyBalanceCard, { rateText } from '../SummaryView/MonthlyBalanceCard';
import SummaryView from '../SummaryView/SummaryView';

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  SQL = await initSqlJs();
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

const MONTH = currentYearMonth();
let db;
let salary;
let saving;
let container;
let root;
let version = 0;
beforeEach(() => {
  ({ db } = M.createDatabase(SQL, null));
  salary = M.addAccount(db, { name: '월급통장' });
  M.addRecurringItem(db, { account_id: salary, name: '월급', type: 'income', day_of_month: 25, fixed_amount: 3000000, auto_register: false });
  saving = M.addAccount(db, { name: '적금통장' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const render = el => act(async () => { root.render(el); });
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text || b.title === text);
const click = el => act(async () => { el.click(); });
const spend = (amount, discount = 0) => M.addTransaction(db, {
  payment_method: '현금', date: `${MONTH}-01`, budget_category: '식비', detail: '지출', amount, discount_amount: discount,
});

describe('설정 › 수입·월 수지', () => {
  const show = () => render(<MonthlyBalanceSettings db={db} dataVersion={version += 1} onChanged={() => {}} />);
  const rows = () => [...container.querySelectorAll('.cb-settings-row')].map(r => r.textContent);

  test('처음에는 꺼져 있고, 켜면 계좌마다 수입으로 셀지 보인다 — 반복 수입이 있는 계좌만 기본으로', async () => {
    await show();
    expect(container.querySelector('.cb-settings-list')).toBeNull();
    await click(button('수입·월 수지 켜기'));
    await show();
    expect(M.isMonthlyBalanceEnabled(db)).toBe(true);
    expect(rows()).toEqual(['월급통장반복 수입 계좌라 셈', '적금통장반복 수입이 없어 세지 않음']);
    expect(container.querySelector('.mb-transfer-hint')).toBeNull();
    expect(button('월급통장 입금을 수입으로 세지 않기').getAttribute('aria-pressed')).toBe('true');
    expect(button('적금통장 입금을 수입으로 세기').getAttribute('aria-pressed')).toBe('false');
  });

  test('반복 수입이 있어 자동으로 세는 계좌가 여럿이면 내 계좌끼리 옮긴 돈인지 확인하라고 알린다', async () => {
    M.addRecurringItem(db, { account_id: saving, name: '적금 이체', type: 'income', day_of_month: 26, fixed_amount: 500000, auto_register: false });
    M.setMonthlyBalanceEnabled(db, true);
    await show();
    expect(container.querySelector('.mb-transfer-hint').textContent).toContain('내 계좌끼리 옮기는 돈이면');
  });

  test('지운 계좌도 지난 달 수입이 잡히면 따로 보여 끌 수 있다', async () => {
    M.addAccountTransaction(db, { account_id: salary, date: '2026-10-25', type: 'income', description: '월급', amount: 3000000 });
    M.deleteAccount(db, salary);
    M.setMonthlyBalanceEnabled(db, true);
    await show();
    expect(container.textContent).toContain('지운 계좌 — 켜 둔 계좌는 지난 입금이 수입에 잡혀요');
    await click(button('월급통장 입금을 수입으로 세지 않기'));
    expect(M.getIncomeAccounts(db).find(a => a.name === '월급통장').counted).toBe(false);
  });

  test('직접 고르고, 자동으로 되돌릴 수 있다. 끄면 고른 값은 남는다', async () => {
    M.setMonthlyBalanceEnabled(db, true);
    await show();
    await click(button('월급통장 입금을 수입으로 세지 않기'));
    await show();
    expect(rows()[0]).toBe('월급통장직접 고름자동으로');
    expect(M.getIncomeAccounts(db)[0].counted).toBe(false);
    await click(button('자동으로'));
    await show();
    expect(M.getIncomeAccounts(db)[0]).toMatchObject({ auto: true, counted: true });
    await click(button('적금통장 입금을 수입으로 세기'));
    await click(button('수입·월 수지 끄기'));
    await show();
    expect(container.querySelector('.cb-settings-list')).toBeNull();
    expect(M.getIncomeAccounts(db)[1].counted).toBe(true);
  });
});

describe('요약 › 월별 추이 — 이 달 수지', () => {
  const show = () => render(<MonthlyBalanceCard db={db} dataVersion={version += 1} month={MONTH} />);

  test('꺼져 있으면 보이지 않는다', async () => {
    await show();
    expect(container.innerHTML).toBe('');
  });

  test('수입(예정 포함)·지출(순지출)·남은 돈·저축률', async () => {
    M.setMonthlyBalanceEnabled(db, true);
    M.addAccountTransaction(db, { account_id: salary, date: addDays(todayStr(), 1), type: 'income', description: '월급', amount: 3000000, recurring_item_id: 1, recurring_month: MONTH, is_auto_generated: true });
    M.addAccountTransaction(db, { account_id: saving, date: `${MONTH}-01`, type: 'income', description: '적금', amount: 999999 });  // 세지 않음
    spend(1100000, 100000);
    await show();
    const values = [...container.querySelectorAll('.mb-card-grid dd')].map(d => d.textContent);
    expect([...container.querySelectorAll('.mb-card-grid dt')].map(d => d.textContent)).toEqual(['수입', '지출(할인 뺀)', '남은 돈', '저축률']);
    expect(values).toEqual(['3,000,000원', '1,000,000원', '2,000,000원', '67%']);
    expect(container.querySelector('.mb-card').textContent).toContain('아직 들어오지 않은 예정 수입 3,000,000원이 포함돼 있어요');
    expect(container.querySelector('.mb-left--plus')).not.toBeNull();
  });

  test('날짜가 지났지만 고치지 않은 예정 입금은 실제 금액이 다르면 고치라고 알린다', async () => {
    M.setMonthlyBalanceEnabled(db, true);
    M.addAccountTransaction(db, { account_id: salary, date: `${MONTH}-01`, type: 'income', description: '월급', amount: 3000000, recurring_item_id: 1, recurring_month: MONTH, is_auto_generated: true });
    await show();
    expect(container.querySelector('.mb-card').textContent).toContain('금액을 고치지 않은 예정 입금 3,000,000원');
  });

  test('쓴 돈이 더 많으면 남은 돈이 빨갛게, 수입이 없으면 어디서 고르는지 알린다', async () => {
    M.setMonthlyBalanceEnabled(db, true);
    spend(50000);
    await show();
    expect([...container.querySelectorAll('.mb-card-grid dd')].map(d => d.textContent)).toEqual(['0원', '50,000원', '-50,000원', '-']);
    expect(container.querySelector('.mb-left--minus')).not.toBeNull();
    expect(container.querySelector('.mb-card-note').textContent).toContain('수입으로 셀 계좌를 고르세요');
  });

  test('저축률 문구', () => {
    expect([null, Infinity, 0.4, -0.25].map(rateText)).toEqual(['-', '-', '40%', '-25%']);
  });
});

describe('요약 › 월별 추이 — 월별 목록의 수입/남은 돈', () => {
  const showSummary = () => render(
    <SummaryView db={db} dataVersion={version += 1} tab="monthly" drilldownCategory={null} onTabChange={() => {}} onDrilldownChange={() => {}} />,
  );

  test('켰을 때만 칸이 생기고, 예정이 섞인 달은 * 로 표시한다', async () => {
    spend(1000000);
    M.addAccountTransaction(db, { account_id: salary, date: addDays(todayStr(), 1), type: 'income', description: '월급', amount: 3000000, recurring_item_id: 1, recurring_month: MONTH });
    await showSummary();
    expect([...container.querySelectorAll('.summary-table th')].map(th => th.textContent)).not.toContain('수입/남은 돈');
    expect(container.querySelector('.mb-card')).toBeNull();
    expect(container.querySelector('.summary-table.with-balance')).toBeNull();      // 끄면 예전 표 그대로(건수 칸을 감추지 않음)

    expect(container.querySelector('.mb-table-note')).toBeNull();

    M.setMonthlyBalanceEnabled(db, true);
    await showSummary();
    expect([...container.querySelectorAll('.summary-table th')].map(th => th.textContent)).toContain('수입/남은 돈');
    expect(container.querySelector('.summary-table.with-balance .mb-col-cnt')).not.toBeNull();   // 좁은 화면에서 감출 칸
    const cells = [...container.querySelector('.current-month-row').querySelectorAll('td')];
    expect(cells[cells.length - 1].textContent).toBe('3,000,000원 *+2,000,000원');
    expect(container.querySelector('.mb-table-note').textContent).toContain('* 예정 금액이 포함된 수입');
    expect(container.querySelector('.mb-card')).not.toBeNull();
  });
});
