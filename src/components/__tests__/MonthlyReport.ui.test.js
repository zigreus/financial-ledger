/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 월간 리포트 화면 (I-028, ROADMAP C-9) — 요약 › 리포트 탭(켰을 때만), 달 넘기기, 지난달 리포트 알림, 설정 켜고 끄기
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../services/dbManager';
import { currentYearMonth, addMonths } from '../../services/dateUtils';
import SummaryView from '../SummaryView/SummaryView';
import MonthlyReport from '../SummaryView/MonthlyReport';
import OpenNotices from '../TransactionList/OpenNotices';
import TransactionList from '../TransactionList/TransactionList';
import MonthlyReportSettings from '../SettingsView/sections/MonthlyReportSettings';
import { polishReportWithAI } from '../../services/monthlyReportAI';

vi.mock('../../services/monthlyReportAI', async (orig) => ({ ...(await orig()), polishReportWithAI: vi.fn() }));
vi.mock('../../services/aiClient', async (orig) => ({ ...(await orig()), activeAI: () => ({ provider: 'claude', apiKey: 'k', model: 'm' }) }));

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  SQL = await initSqlJs();
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const THIS = currentYearMonth();
const LAST = addMonths(THIS, -1);
const BEFORE = addMonths(THIS, -2);
let db;
let container;
let root;
let version = 0;
beforeEach(() => {
  ({ db } = M.createDatabase(SQL, null));
  const spend = (date, category, amount, detail) => M.addTransaction(db, { payment_method: '카드', date, budget_category: category, detail, amount });
  spend(`${BEFORE}-03`, '식비', 300000, '마트');
  spend(`${LAST}-02`, '식비', 450000, '한우 가게');
  spend(`${LAST}-05`, '쇼핑', 50000, '양말');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  try { window.localStorage.clear(); } catch (e) { /* 없음 */ }
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

const render = el => act(async () => { root.render(el); });
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text || b.title === text || b.getAttribute('aria-label') === text);
const click = el => act(async () => { el.click(); });
const showSummary = (tab = 'report', onTabChange = () => {}) => render(
  <SummaryView db={db} dataVersion={version += 1} tab={tab} drilldownCategory={null} onTabChange={onTabChange} onDrilldownChange={() => {}} />,
);

test('끄면 리포트 탭이 없고, 리포트 탭으로 열려도 월별 추이를 보인다', async () => {
  await showSummary('report');
  expect(button('리포트')).toBeUndefined();
  expect(container.querySelector('.mr')).toBeNull();
  expect(container.querySelector('.tab.active').textContent).toBe('월별 추이');
  expect(container.querySelector('.summary-tabs--many')).toBeNull();      // 끄면 탭 모양도 예전 그대로
});

test('켜면 리포트 탭에 지난달 리포트 — 합계·평균 비교·늘어난 카테고리·큰 지출·무지출일', async () => {
  M.setMonthlyReportEnabled(db, true);
  let asked = null;
  await showSummary('monthly', t => { asked = t; });
  await click(button('리포트'));
  expect(asked).toBe('report');
  await showSummary('report');
  const mr = container.querySelector('.mr');
  expect(mr.querySelector('.mr-title').textContent).toContain(`${Number(LAST.slice(5))}월 리포트`);
  expect(mr.querySelector('.mr-total-amount').textContent).toBe('500,000원 · 2건');
  expect(mr.querySelector('.mr-total-note').textContent).toBe('지난달 300,000원보다 200,000원 더 썼어요');
  expect(mr.textContent).toContain('지난달보다 크게 늘었어요');
  expect(container.querySelector('.summary-tabs--many')).not.toBeNull();
  expect(mr.textContent).toContain('+150,000원 (+50%)');
  expect([...mr.querySelectorAll('.mr-biggest .mr-row-name')].map(n => n.firstChild.textContent)).toEqual(['한우 가게', '양말']);
  expect(mr.textContent).toContain('무지출일');
  expect(mr.querySelector('.fsum-ai-btn').textContent).toContain('AI 한마디');
});

test('달을 넘겨 볼 수 있고, 거래가 없는 달은 비어 있다고 알린다', async () => {
  M.setMonthlyReportEnabled(db, true);
  await showSummary('report');
  expect(button('다음 달 리포트').disabled).toBe(true);                 // 이번 달은 거래가 없다
  await click(button('이전 달 리포트'));
  await showSummary('report');
  expect(container.querySelector('.mr-title').textContent).toContain(`${Number(BEFORE.slice(5))}월 리포트`);
  expect(container.querySelector('.mr-total-note').textContent).toBe('비교할 앞 달 기록이 없어요');
  expect(button('이전 달 리포트').disabled).toBe(true);
});

test('지난달 리포트 알림 — 열거나 닫으면 이 기기에서는 그 달 알림이 다시 보이지 않는다', async () => {
  const report = M.getMonthlyReportHeadline(db, LAST);
  let opened = null;
  await render(<OpenNotices report={report} onOpenReport={ym => { opened = ym; }} />);
  expect(container.textContent).toContain(`${Number(LAST.slice(5))}월 리포트가 나왔어요 — 순지출 500,000원, 지난달보다 200,000원 더 썼어요`);
  await click(container.querySelector('.balance-alert-link'));
  expect(opened).toBe(LAST);
  expect(container.innerHTML).toBe('');
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(<OpenNotices report={report} onOpenReport={() => {}} />);
  expect(container.innerHTML).toBe('');                                  // 다시 열어도 안 보인다
  await render(<OpenNotices report={{ ...report, month: BEFORE }} onOpenReport={() => {}} />);
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(<OpenNotices report={{ ...report, month: BEFORE }} onOpenReport={() => {}} />);
  expect(container.textContent).toContain('리포트가 나왔어요');           // 다른 달은 보인다
  await click(button('알림 닫기'));
  expect(container.innerHTML).toBe('');
});

describe('날짜를 정해 둔 경우 (2026-11-03)', () => {
  beforeEach(() => {
    ({ db } = M.createDatabase(SQL, null));
    M.addPaymentMethod(db, '카드');
    M.addBudgetCategory(db, '식비');
    const spend = (date, amount) => M.addTransaction(db, { payment_method: '카드', date, budget_category: '식비', detail: 'x', amount });
    spend('2026-08-03', 300000); spend('2026-09-03', 300000); spend('2026-10-03', 450000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 3, 10, 0, 0));
  });
  const months = ['2026-10', '2026-09', '2026-08'];

  test('달을 바꾼 뒤 늦게 온 AI 문장은 버린다', async () => {
    let resolve;
    polishReportWithAI.mockImplementationOnce(() => new Promise((res) => { resolve = res; }));
    await render(<MonthlyReport db={db} dataVersion={1} month="2026-10" months={months} onMonthChange={() => {}} />);
    await click(container.querySelector('.fsum-ai-btn'));
    expect(container.textContent).toContain('AI가 정리하는 중');
    await render(<MonthlyReport db={db} dataVersion={1} month="2026-09" months={months} onMonthChange={() => {}} />);
    await act(async () => { resolve({ headline: '10월 문장', points: [], tip: '' }); });
    expect(container.textContent).not.toContain('10월 문장');
    expect(container.querySelector('.fsum-ai-btn').textContent).toContain('AI 한마디');
  });

  test('진행 중인 달은 목표를 지켰다고 하지 않고 남은 금액을 보인다', async () => {
    M.addTransaction(db, { payment_method: '카드', date: '2026-11-02', budget_category: '식비', detail: 'x', amount: 10000 });
    M.setMonthlyGoal(db, '2026-11', 1000000);
    await render(<MonthlyReport db={db} dataVersion={1} month="2026-11" months={['2026-11', ...months]} onMonthChange={() => {}} />);
    const stats = container.querySelector('.mr-grid').textContent;
    expect(stats).toContain('990,000원 남음');
    expect(stats).toContain('지금까지 1% 썼어요');
    expect(stats).not.toContain('지켰어요');
    await render(<MonthlyReport db={db} dataVersion={2} month="2026-11" months={['2026-11', ...months]} onMonthChange={() => {}} showGoal={false} />);
    expect(container.querySelector('.mr-grid').textContent).not.toContain('월 목표');
  });

  test('거래내역 첫 화면 — 3일에는 지난달 리포트 알림, 8일에는 없다', async () => {
    M.setMonthlyReportEnabled(db, true);
    const onOpenReport = vi.fn();
    const props = {
      db, dataVersion: 1, onAdd: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onChanged: vi.fn(), onOpenImport: vi.fn(),
      onOpenCardCheck: vi.fn(), onOpenAccount: vi.fn(), onOpenOnboarding: vi.fn(), onOpenSettings: vi.fn(), onOpenReport,
    };
    await render(<TransactionList {...props} />);
    const banner = container.querySelector('.open-notice-report');
    expect(banner.textContent).toContain('10월 리포트가 나왔어요 — 순지출 450,000원, 앞 2개월 평균보다 150,000원 더 썼어요');
    await click(banner.querySelector('.balance-alert-link'));
    expect(onOpenReport).toHaveBeenCalledWith('2026-10');
    act(() => root.unmount()); root = createRoot(container);
    await render(<TransactionList {...props} dataVersion={2} />);
    expect(container.querySelector('.open-notice-report')).toBeNull();          // 본 달은 다시 보이지 않는다
    window.localStorage.clear();
    vi.setSystemTime(new Date(2026, 10, 8, 10, 0, 0));
    act(() => root.unmount()); root = createRoot(container);
    await render(<TransactionList {...props} dataVersion={3} />);
    expect(container.querySelector('.open-notice-report')).toBeNull();
  });
});

test('설정 — 켜고 끌 수 있다', async () => {
  await render(<MonthlyReportSettings db={db} dataVersion={version += 1} onChanged={() => {}} />);
  await click(button('월간 리포트 켜기'));
  expect(M.isMonthlyReportEnabled(db)).toBe(true);
  await render(<MonthlyReportSettings db={db} dataVersion={version += 1} onChanged={() => {}} />);
  expect(container.textContent).toContain('가장 큰 지출 3건');
  await click(button('월간 리포트 끄기'));
  expect(M.isMonthlyReportEnabled(db)).toBe(false);
});
