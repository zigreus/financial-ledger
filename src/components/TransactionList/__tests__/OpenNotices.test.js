/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 확인할 것 (I-036) — 잔액 위험(B-066)·예산(I-025)·구독 결제 예정·지난달 리포트(I-028)를 한 카드에,
// 앱을 열면 거래내역이 이번 달 대신 이 카드로 스크롤한다(B-093)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../../services/dbManager';
import { todayStr, addDays } from '../../../services/dateUtils';
import OpenNotices from '../OpenNotices';
import TransactionList from '../TransactionList';

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  SQL = await initSqlJs();
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let container;
let root;
beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const balance = (over = {}) => ({
  accountId: 3, accountName: '생활비', threshold: 500000, date: '2026-11-25', balance: 400000, daysUntil: 17, isNow: false, ...over,
});
const TODAY = todayStr();
const payment = (over = {}) => ({ id: 41, recurringId: 7, name: '넷플릭스', date: addDays(TODAY, 1), daysUntil: 1, amount: 13500, ...over });
const md = d => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;

const render = el => act(async () => { root.render(el); });
const remount = async (el) => {
  act(() => root.unmount());
  root = createRoot(container);
  await render(el);
};
const click = el => act(async () => { el.click(); });
const card = () => container.querySelector('.open-notices');
const closeBtn = () => container.querySelector('.balance-alert-close');

describe('잔액 위험', () => {
  test('내려가는 날·금액·위험선을 보여 주고, 누르면 그 계좌로 간다', async () => {
    const onOpenAccount = vi.fn();
    await render(<OpenNotices balanceAlerts={[balance()]} onOpenAccount={onOpenAccount} />);
    expect(card().textContent).toContain('생활비 11월 25일(17일 뒤) 잔액이 400,000원으로 위험선(500,000원) 아래로 내려가요');
    expect(card().getAttribute('role')).toBe('alert');
    expect(card().querySelector('.open-notices-title').textContent).toBe('확인할 것');      // 문서가 부르는 이름이 보인다
    expect(card().getAttribute('aria-labelledby')).toBe(card().querySelector('.open-notices-title').id);
    await click(container.querySelector('.open-notice-balance .balance-alert-link'));
    expect(onOpenAccount).toHaveBeenCalledWith(3);
  });

  test('이미 아래면 지금 잔액으로 알린다', async () => {
    await render(<OpenNotices balanceAlerts={[balance({ isNow: true, balance: 300000, daysUntil: 0 })]} />);
    expect(card().textContent).toContain('잔액 300,000원 — 위험선(500,000원)보다 적어요');
  });

  test('닫으면 같은 내용은 다시 안 보이고, 날짜나 금액이 바뀌면 다시 보인다', async () => {
    await render(<OpenNotices balanceAlerts={[balance()]} />);
    await click(closeBtn());
    expect(card()).toBeNull();
    await remount(<OpenNotices balanceAlerts={[balance()]} />);
    expect(card()).toBeNull();
    await remount(<OpenNotices balanceAlerts={[balance({ balance: 350000 })]} />);
    expect(card()).not.toBeNull();
  });
});

describe('구독 결제 예정', () => {
  test('오늘·내일·모레·n일 뒤와 날짜, 결제액 — 누르면 구독(정기지출)으로', async () => {
    const onOpenSubscriptions = vi.fn();
    const payments = [
      payment({ id: 1, name: '도메인', date: TODAY, daysUntil: 0, amount: 24000 }),
      payment({ id: 2 }),
      payment({ id: 3, name: '유튜브', date: addDays(TODAY, 2), daysUntil: 2, amount: 14900 }),
      payment({ id: 'r9', name: '멜론', date: addDays(TODAY, 3), daysUntil: 3, amount: 10900 }),
    ];
    await render(<OpenNotices payments={payments} onOpenSubscriptions={onOpenSubscriptions} />);
    expect([...container.querySelectorAll('.open-notice-due')].map(li => li.textContent)).toEqual([
      '🔔도메인 오늘 24,000원이 결제돼요 보기 ›',
      `🔔넷플릭스 내일(${md(addDays(TODAY, 1))}) 13,500원이 결제돼요 보기 ›`,
      `🔔유튜브 모레(${md(addDays(TODAY, 2))}) 14,900원이 결제돼요 보기 ›`,
      `🔔멜론 3일 뒤(${md(addDays(TODAY, 3))}) 10,900원이 결제돼요 보기 ›`,
    ]);
    expect(card().getAttribute('role')).toBe('status');                  // 급한 알림이 아니다
    await click(container.querySelector('.open-notice-due .balance-alert-link'));
    expect(onOpenSubscriptions).toHaveBeenCalled();
  });

  test('닫은 결제(그 구독의 그 날짜)는 다음 날에도 다시 보이지 않고, 날짜가 바뀐 결제·다른 구독은 보인다 — 지난 결제의 기록은 버린다', async () => {
    await render(<OpenNotices payments={[payment()]} />);
    await click(closeBtn());
    expect(card()).toBeNull();
    await remount(<OpenNotices payments={[payment({ daysUntil: 0 })]} />);
    expect(card()).toBeNull();
    await remount(<OpenNotices payments={[payment({ date: addDays(TODAY, 2), daysUntil: 2 })]} />);
    expect(card().textContent).toContain('모레');
    await click(closeBtn());
    expect(JSON.parse(window.localStorage.getItem('ledger_subscription_due_dismissed')))
      .toEqual([`7@${addDays(TODAY, 1)}`, `7@${addDays(TODAY, 2)}`]);
    // 지난 결제의 닫은 기록은 쓸 때 정리된다
    window.localStorage.setItem('ledger_subscription_due_dismissed', JSON.stringify(['5@2000-01-01', `7@${addDays(TODAY, 2)}`]));
    await remount(<OpenNotices payments={[payment({ id: 6, recurringId: 8 })]} />);
    await click(closeBtn());
    expect(JSON.parse(window.localStorage.getItem('ledger_subscription_due_dismissed')))
      .toEqual([`7@${addDays(TODAY, 2)}`, `8@${addDays(TODAY, 1)}`]);
  });

  test('등록 전 일정으로 닫은 결제가 나중에 자동등록돼(거래 번호가 생겨)도 다시 뜨지 않는다', async () => {
    await render(<OpenNotices payments={[payment({ id: 'r7' })]} />);         // 연결 없이 연 동안 — 자동등록 전
    await click(closeBtn());
    await remount(<OpenNotices payments={[payment({ id: 912 })]} />);         // 연결 뒤 자동등록된 같은 결제
    expect(card()).toBeNull();
  });
});

describe('한 카드', () => {
  const budget = { category: '식비', budget: 100000, spent: 120000, ratio: 1.2, level: 'over' };
  const report = { month: '2026-10', count: 3, total: 450000, avg: null };

  test('잔액 → 예산 → 결제 예정 → 리포트 순, 닫기 하나로 모두 닫힌다', async () => {
    await render(<OpenNotices balanceAlerts={[balance()]} budgetAlerts={[budget]} payments={[payment()]} report={report} />);
    expect([...container.querySelectorAll('.open-notice')].map(li => li.className.replace('open-notice open-notice-', ''))).toEqual([
      'balance', 'budget', 'due', 'report',
    ]);
    expect(container.querySelectorAll('.balance-alert-close')).toHaveLength(1);
    expect(container.textContent).toContain('10월 리포트가 나왔어요 — 순지출 450,000원');
    await click(closeBtn());
    expect(container.innerHTML).toBe('');
    await remount(<OpenNotices balanceAlerts={[balance()]} budgetAlerts={[budget]} payments={[payment()]} report={report} />);
    expect(container.innerHTML).toBe('');
  });

  test('리포트를 열면 리포트만 사라지고 나머지는 남는다', async () => {
    const onOpenReport = vi.fn();
    await render(<OpenNotices payments={[payment()]} report={report} onOpenReport={onOpenReport} />);
    await click(container.querySelector('.open-notice-report .balance-alert-link'));
    expect(onOpenReport).toHaveBeenCalledWith('2026-10');
    expect(container.querySelector('.open-notice-report')).toBeNull();
    expect(container.querySelector('.open-notice-due')).not.toBeNull();
  });

  test('알림이 없으면 아무것도 그리지 않는다', async () => {
    await render(<OpenNotices balanceAlerts={[]} budgetAlerts={[]} payments={[]} report={null} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('거래내역 첫 화면 (B-093)', () => {
  let db;
  let scrolled;
  beforeEach(() => {
    ({ db } = M.createDatabase(SQL, null));
    M.addPaymentMethod(db, '카드');
    M.addBudgetCategory(db, '문화');
    M.addTransaction(db, { payment_method: '카드', date: TODAY, budget_category: '문화', detail: '영화', amount: 15000 });
    M.addRecurringTransaction(db, {
      payment_method: '카드', budget_category: '문화', detail: '넷플릭스', amount: 13500, frequency: 'monthly',
      day_of_month: Number(addDays(TODAY, 1).slice(8, 10)), is_subscription: true,
    });
    scrolled = [];
    Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this); };
  });
  const props = over => ({
    db, dataVersion: 0, goTodayKey: 0, onAdd: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onChanged: vi.fn(), onOpenImport: vi.fn(),
    onOpenCardCheck: vi.fn(), onOpenAccount: vi.fn(), onOpenOnboarding: vi.fn(), onOpenSettings: vi.fn(), ...over,
  });
  const afterMountScroll = () => act(() => new Promise(r => setTimeout(r, 200)));

  test('구독 모아보기를 켰을 때만 결제 예정을 알리고, 누르면 지출계획 › 정기지출로', async () => {
    await render(<TransactionList {...props()} />);
    expect(card()).toBeNull();
    M.setSubscriptionsEnabled(db, true);
    const onOpenSettings = vi.fn();
    await remount(<TransactionList {...props({ dataVersion: 1, onOpenSettings })} />);
    expect(container.querySelector('.open-notice-due').textContent).toContain('넷플릭스 내일');
    await click(container.querySelector('.open-notice-due .balance-alert-link'));
    expect(onOpenSettings).toHaveBeenCalledWith('recurring');
  });

  test('알림이 있으면 처음 열 때 이번 달이 아니라 알림 카드로 스크롤한다 — 닫은 뒤에는 이번 달로', async () => {
    M.setSubscriptionsEnabled(db, true);
    await render(<TransactionList {...props()} />);
    await afterMountScroll();
    expect(scrolled).toEqual([card()]);
    // 카드 위에 남길 높이는 잰 필터바 높이 + 여백 (jsdom은 높이가 0)
    expect(card().style.scrollMarginTop).toBe('8px');
    await click(closeBtn());
    scrolled = [];
    await remount(<TransactionList {...props({ dataVersion: 1 })} />);
    await afterMountScroll();
    expect(card()).toBeNull();
    expect(scrolled).toContain(container.querySelector('.month-group'));
  });

  test('다른 탭에 다녀와 다시 그려질 때(goTodayKey > 0)도 마지막 스크롤은 알림 카드', async () => {
    M.setSubscriptionsEnabled(db, true);
    await render(<TransactionList {...props({ goTodayKey: 3 })} />);
    await afterMountScroll();
    expect(scrolled[scrolled.length - 1]).toBe(card());
  });
});
