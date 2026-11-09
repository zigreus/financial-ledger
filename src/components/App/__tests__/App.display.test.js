/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 작은 개선 (ROADMAP U-7~U-11) — 열 때 가리기, 처음 여는 화면, 밀어서 달 넘기기, Esc로 창 닫기, 월 묶음 모두 접기·펼치기.
// 로그인(MSAL)·저장 훅·AI 설정 동기화는 가짜, 가계부 DB는 진짜 sql.js
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../../services/dbManager';
import { addMonths, todayStr } from '../../../services/dateUtils';
import { HIDE_AGAIN_AFTER_MS, HIDE_ON_OPEN_KEY, START_TAB_KEY, resetDisplayPrefsWatch, setHideOnOpen } from '../../../services/displayPrefs';
import App from '../App';
import { preloadScreens } from '../screens';

const shared = vi.hoisted(() => ({ db: null }));

vi.mock('@azure/msal-react', () => ({
  useIsAuthenticated: () => true,
  useMsal: () => ({ instance: {}, accounts: [{ homeAccountId: 'me', username: 'me@outlook.com' }] }),
}));
vi.mock('../../../services/aiSettingsSync', () => ({
  setAISyncAccount: vi.fn(),
  syncAISettings: vi.fn(async () => 'none'),
  onAISettingsPulled: () => () => {},
}));
vi.mock('../../../hooks/useLedgerSync', async () => {
  const React = await import('react');
  const { attachChangeLog: attach } = await import('../../../services/changeLog');
  return {
    default: function useFakeLedger() {
      const [state, setState] = React.useState({ db: shared.db, version: 0 });
      const bump = () => queueMicrotask(() => setState(s => ({ ...s, version: s.version + 1 })));
      React.useState(() => attach(shared.db, { onWrite: bump }));
      return {
        db: state.db, dataVersion: state.version, loading: false, saving: false, error: '', setError: () => {}, notice: null,
        dirty: false, pendingCount: 0, loadDb: async () => {}, saveNow: async () => true, resetForLogout: () => {},
        listBackups: async () => [], createBackup: async () => '', restoreBackup: async () => {},
      };
    },
  };
});

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  expect(await preloadScreens()).toBe(true);
  SQL = await initSqlJs();
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

let root;
let container;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  resetDisplayPrefsWatch();
});

const TODAY = todayStr();
const LAST_MONTH = addMonths(TODAY.slice(0, 7), -1);
function makeLedger() {
  const { db } = M.createDatabase(SQL, null);
  M.addPaymentMethod(db, '현금');
  M.addBudgetCategory(db, '식비');
  M.addSubCategory(db, '식비', '카페');
  M.addTransaction(db, { payment_method: '현금', date: TODAY, budget_category: '식비', sub_category: '카페', detail: '이번 달 커피', amount: 5000 });
  M.addTransaction(db, { payment_method: '현금', date: `${LAST_MONTH}-15`, budget_category: '식비', sub_category: '카페', detail: '지난달 빵', amount: 3000 });
  return db;
}
async function open(db = makeLedger()) {
  shared.db = db;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<App />); });
  await wait();
  return db;
}
const wait = (ms = 0) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const click = el => act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)); });
const activeNav = () => document.body.querySelector('.nav-item.active .nav-label')?.textContent;
const curtain = () => document.body.querySelector('.privacy-curtain');
const setVisibility = (state) => act(async () => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
/** 가로로 밀기 — React가 읽는 touches·changedTouches만 채운 손 이벤트 */
const swipe = (el, dx) => act(async () => {
  const ev = (type, x) => {
    const e = new Event(type, { bubbles: true });
    const t = [{ clientX: x, clientY: 100 }];
    Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : t });
    Object.defineProperty(e, 'changedTouches', { value: t });
    return e;
  };
  el.dispatchEvent(ev('touchstart', 200));
  el.dispatchEvent(ev('touchend', 200 + dx));
});

describe('U-7 가계부를 열 때 가리기', () => {
  test('켜 두면 열 때 화면 전체를 덮고, 누르면 걷힌다 — 끄면(기본) 덮지 않는다', async () => {
    window.localStorage.setItem(HIDE_ON_OPEN_KEY, '1');
    await open();
    expect(curtain().textContent).toContain('화면을 가려 두었어요');
    await click(curtain());
    expect(curtain()).toBeNull();
  });

  test('다른 앱으로 가는 순간 덮고 — 1분 안에 돌아오면 저절로 걷고, 오래 있다 오면 그대로 둔다', async () => {
    window.localStorage.setItem(HIDE_ON_OPEN_KEY, '1');
    await open();
    await click(curtain());
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await setVisibility('hidden');
    expect(curtain()).not.toBeNull();                      // 떠나는 순간(앱 전환 화면의 미리 보기 전에) 덮였다
    now += 10 * 1000;
    await setVisibility('visible');
    expect(curtain()).toBeNull();
    await setVisibility('hidden');
    now += HIDE_AGAIN_AFTER_MS + 1000;
    await setVisibility('visible');
    expect(curtain()).not.toBeNull();
  });

  test('덮인 채로 다른 앱에 다녀오면 금방 와도 그대로 덮여 있다', async () => {
    window.localStorage.setItem(HIDE_ON_OPEN_KEY, '1');
    await open();
    await setVisibility('hidden');
    await setVisibility('visible');
    expect(curtain()).not.toBeNull();
  });

  test('머리글의 🔒로 지금 바로 가린다 — 켜 두었을 때만 보인다', async () => {
    window.localStorage.setItem(HIDE_ON_OPEN_KEY, '1');
    await open();
    await click(curtain());
    await click(document.body.querySelector('.btn-cover'));
    expect(curtain()).not.toBeNull();
  });

  test('덮는 동안 뒤 화면은 닿을 수 없다(inert) — Esc가 뒤의 창을 닫지 않고, 걷으면 그대로 있다', async () => {
    window.localStorage.setItem(HIDE_ON_OPEN_KEY, '1');
    await open();
    await click(curtain());
    await click([...container.querySelectorAll('.tx-item')].find(el => el.textContent.includes('이번 달 커피')));
    await setVisibility('hidden');
    const behind = [...curtain().parentElement.children].filter(el => el !== curtain());
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.every(el => el.hasAttribute('inert'))).toBe(true);
    expect(document.activeElement).toBe(curtain());
    // 실제 키보드 이벤트처럼 취소할 수 있는 Esc
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(document.body.querySelector('.modal-content .btn-danger')).not.toBeNull();
    await click(curtain());
    expect(behind.some(el => el.hasAttribute('inert'))).toBe(false);
    expect(document.body.querySelector('.modal-content .btn-danger')).not.toBeNull();
  });

  test('금방 다녀오면 쓰던 칸으로 초점이 돌아온다 — 덮은 뒤에 생긴 것도 가려진다', async () => {
    window.localStorage.setItem(HIDE_ON_OPEN_KEY, '1');
    await open();
    await click(curtain());
    await click(container.querySelector('.nav-add'));
    const detail = [...document.body.querySelectorAll('.tx-form input')].find(i => i.type === 'text');
    await act(async () => { detail.focus(); });
    expect(document.activeElement).toBe(detail);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await setVisibility('hidden');
    expect(document.activeElement).toBe(curtain());
    const late = document.createElement('div');
    await act(async () => { curtain().parentElement.appendChild(late); await new Promise(r => setTimeout(r, 0)); });
    expect(late.hasAttribute('inert')).toBe(true);
    now += 5000;
    await setVisibility('visible');
    expect(curtain()).toBeNull();
    expect(late.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(detail);
    late.remove();
  });

  test('바로가기로 열었으면 가린 화면을 걷은 뒤에 입력 창이 열린다', async () => {
    window.localStorage.setItem(HIDE_ON_OPEN_KEY, '1');
    window.history.replaceState(null, '', '/?action=add');
    await open();
    await wait(10);
    expect(curtain()).not.toBeNull();
    expect(document.body.querySelector('.tx-form')).toBeNull();
    await click(curtain());
    await wait(10);
    expect(document.body.querySelector('.tx-form')).not.toBeNull();
  });

  test('설정에서 켜고 끄면 머리글의 🔒가 바로 따라간다', async () => {
    await open();
    expect(document.body.querySelector('.btn-cover')).toBeNull();
    await act(async () => { setHideOnOpen(true); });
    expect(document.body.querySelector('.btn-cover')).not.toBeNull();
    await act(async () => { setHideOnOpen(false); });
    expect(document.body.querySelector('.btn-cover')).toBeNull();
  });

  test('끄면(기본) 덮지 않고, 머리글에 🔒도 없다 — 다른 앱에 다녀와도 그대로', async () => {
    await open();
    expect(curtain()).toBeNull();
    expect(document.body.querySelector('.btn-cover')).toBeNull();
    await setVisibility('hidden');
    await setVisibility('visible');
    expect(curtain()).toBeNull();
  });
});

describe('U-8 처음 여는 화면', () => {
  test('고른 화면으로 연다', async () => {
    window.localStorage.setItem(START_TAB_KEY, 'summary');
    await open();
    expect(activeNav()).toBe('요약');
  });

  test("'확인할 것'이 보이면 거래내역부터 — 예산을 넘은 카테고리", async () => {
    window.localStorage.setItem(START_TAB_KEY, 'calendar');
    const db = makeLedger();
    M.setCategoryBudgetEnabled(db, true);
    M.setDefaultCategoryBudget(db, '식비', 1000, TODAY.slice(0, 7));
    await open(db);
    expect(activeNav()).toBe('거래내역');
    expect(document.body.querySelector('.open-notices')).not.toBeNull();
  });

  test("'확인할 것'을 오늘 닫았으면 고른 화면으로 — 카드가 보이지 않으면 막지 않는다", async () => {
    window.localStorage.setItem(START_TAB_KEY, 'calendar');
    window.localStorage.setItem('ledger_budget_alert_dismissed', JSON.stringify({ date: TODAY, keys: ['식비:over'] }));
    const db = makeLedger();
    M.setCategoryBudgetEnabled(db, true);
    M.setDefaultCategoryBudget(db, '식비', 1000, TODAY.slice(0, 7));
    await open(db);
    expect(activeNav()).toBe('캘린더');
  });

  test('빈 가계부(첫 실행 안내)면 거래내역', async () => {
    window.localStorage.setItem(START_TAB_KEY, 'summary');
    const { db } = M.createDatabase(SQL, null);
    await open(db);
    expect(activeNav()).toBe('거래내역');
  });

  test('바로가기(거래 입력)로 열면 거래내역과 입력 창', async () => {
    window.localStorage.setItem(START_TAB_KEY, 'summary');
    window.history.replaceState(null, '', '/?action=add');
    await open();
    await wait(10);
    expect(activeNav()).toBe('거래내역');
    expect(document.body.querySelector('.tx-form')).not.toBeNull();
  });
});

describe('U-9 밀어서 달 넘기기 (요약)', () => {
  test('카테고리 탭의 한 달 보기에서 오른쪽으로 밀면 지난달, 왼쪽으로 밀면 다시 이번 달 — 세로로 민 것은 넘기지 않는다', async () => {
    await open();
    await click([...document.body.querySelectorAll('.nav-item')].find(b => b.textContent.includes('요약')));
    await click([...document.body.querySelectorAll('.summary-tabs .tab')].find(b => b.textContent === '카테고리'));
    const month = () => document.body.querySelector('.summary-filter select').value;
    expect(month()).toBe(TODAY.slice(0, 7));
    const page = document.body.querySelector('.summary-page');
    await swipe(page, 120);
    expect(month()).toBe(LAST_MONTH);
    await swipe(page, 30);   // 덜 밀었다
    expect(month()).toBe(LAST_MONTH);
    await swipe(page, -120);
    expect(month()).toBe(TODAY.slice(0, 7));
    await swipe(page, -120); // 더 새 달은 없다
    expect(month()).toBe(TODAY.slice(0, 7));
    await swipe(document.body.querySelector('.summary-filter select'), 120);   // 입력 칸에서 시작한 것은 넘기지 않는다
    expect(month()).toBe(TODAY.slice(0, 7));
  });
});

describe('U-9 밀어서 달 넘기기 (캘린더·리포트)', () => {
  test('캘린더 달력은 예전처럼 — 왼쪽으로 밀면 다음 달, 오른쪽은 지난달', async () => {
    await open();
    await click([...document.body.querySelectorAll('.nav-item')].find(b => b.textContent.includes('캘린더')));
    const title = () => document.body.querySelector('.cv-header-title').textContent;
    const before = title();
    const grid = document.body.querySelector('.cv-grid');
    await swipe(grid, 120);
    const prev = title();
    expect(prev).not.toBe(before);
    await swipe(grid, -120);
    expect(title()).toBe(before);
  });

  test('리포트도 밀어서 — 리포트의 ‹ › 와 같은 달로', async () => {
    const db = makeLedger();
    M.setMonthlyReportEnabled(db, true);
    await open(db);
    await click([...document.body.querySelectorAll('.nav-item')].find(b => b.textContent.includes('요약')));
    await click([...document.body.querySelectorAll('.summary-tabs .tab')].find(b => b.textContent === '리포트'));
    const reportTitle = () => document.body.querySelector('.mr-title').textContent;
    const first = reportTitle();
    const page = document.body.querySelector('.summary-page');
    await swipe(page, -120);   // 더 새 달로
    const second = reportTitle();
    expect(second).not.toBe(first);
    await swipe(page, 120);
    expect(reportTitle()).toBe(first);
  });
});

describe('U-10 Esc로 창 닫기', () => {
  test('거래 상세 창(바깥을 눌러 닫히는 창)은 Esc로 닫히고, 입력 창(입력을 잃을 수 있는 창)은 닫히지 않는다', async () => {
    await open();
    await click([...container.querySelectorAll('.tx-item')].find(el => el.textContent.includes('이번 달 커피')));
    expect(document.body.querySelector('.modal-content')).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await wait();
    expect(document.body.querySelector('.modal-content .btn-danger')).toBeNull();

    await click(container.querySelector('.nav-add'));
    expect(document.body.querySelector('.tx-form')).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await wait();
    expect(document.body.querySelector('.tx-form')).not.toBeNull();
  });
});

describe('U-11 월 묶음 모두 접기·펼치기', () => {
  test('모두 접기는 지금 목록의 달만 — 필터로 가려진 달의 펼침은 그대로 둔다', async () => {
    window.sessionStorage.setItem('fl_expanded_months', JSON.stringify(['2020-01']));
    await open();
    const toggle = () => container.querySelector('.tx-month-all-btn');
    await click(toggle());   // 모두 펼치기
    await click(toggle());   // 모두 접기
    expect(JSON.parse(window.sessionStorage.getItem('fl_expanded_months'))).toEqual(['2020-01']);
  });

  test('거래가 아주 많으면 모두 펼치기 전에 묻는다 — 아니오면 그대로', async () => {
    const db = makeLedger();
    for (let i = 0; i < 1001; i += 1) {
      M.addTransaction(db, { payment_method: '현금', date: `${LAST_MONTH}-10`, budget_category: '식비', sub_category: '카페', detail: `커피 ${i}`, amount: 1000 });
    }
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await open(db);
    const toggle = () => container.querySelector('.tx-month-all-btn');
    await click(toggle());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('거래 1,002건을 한꺼번에 펼칩니다');
    expect(toggle().textContent).toBe('모두 펼치기');
    await click(toggle());
    expect(toggle().textContent).toBe('모두 접기');
  });

  test('모두 펼치면 모든 달의 거래가 보이고, 모두 접으면 모두 숨는다', async () => {
    await open();
    const shown = () => [...container.querySelectorAll('.tx-item')].map(el => el.textContent);
    const toggle = () => container.querySelector('.tx-month-all-btn');
    expect(shown().some(t => t.includes('지난달 빵'))).toBe(false);   // 처음엔 이번 달만 펼쳐 있다
    expect(toggle().textContent).toBe('모두 펼치기');
    await click(toggle());
    expect(shown().some(t => t.includes('지난달 빵'))).toBe(true);
    expect(shown().some(t => t.includes('이번 달 커피'))).toBe(true);
    expect(toggle().textContent).toBe('모두 접기');
    await click(toggle());
    expect(shown()).toEqual([]);
    expect(toggle().textContent).toBe('모두 펼치기');
  });
});
