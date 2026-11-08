/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 첫 실행 흐름 (F-3, I-019) — 빈 가계부면 안내를 열고, 기본값을 넣으면 첫 거래 안내로 이어진다.
// 로그인(MSAL)·저장 훅·AI 설정 동기화는 가짜, 가계부 DB는 진짜 sql.js
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../../services/dbManager';
import { attachChangeLog } from '../../../services/changeLog';
import App from '../App';

const shared = vi.hoisted(() => ({ db: null, accounts: [{ homeAccountId: 'me', username: 'me@outlook.com' }], instance: {}, reload: null }));

vi.mock('@azure/msal-react', () => ({
  useIsAuthenticated: () => true,
  useMsal: () => ({ instance: shared.instance, accounts: shared.accounts }),
}));
vi.mock('../../../services/aiSettingsSync', () => ({
  setAISyncAccount: vi.fn(),
  syncAISettings: vi.fn(async () => 'none'),
  onAISettingsPulled: () => () => {},
}));
vi.mock('../../AIEntry/AIEntry', () => ({ default: () => null }));
vi.mock('../../../hooks/useLedgerSync', async () => {
  const React = await import('react');
  const { attachChangeLog: attach } = await import('../../../services/changeLog');
  return {
    default: function useFakeLedger() {
      const [state, setState] = React.useState({ db: shared.db, version: 0 });
      const bump = () => queueMicrotask(() => setState(s => ({ ...s, version: s.version + 1 })));
      React.useState(() => attach(shared.db, { onWrite: bump }));
      // 🔄·앱 복귀처럼 저장소에서 다시 받아 DB를 바꾼다
      shared.reload = (next) => { attach(next, { onWrite: bump }); setState(s => ({ db: next, version: s.version + 1 })); };
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
  SQL = await initSqlJs();
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

const roots = [];
afterEach(() => {
  roots.splice(0).forEach(({ root, container }) => { act(() => root.unmount()); container.remove(); });
});
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '');
});

async function openApp(db) {
  shared.db = db;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => { root.render(<App />); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return container;
}
const button = (c, text) => [...c.querySelectorAll('button')].find(b => b.textContent.includes(text));
const click = (el) => act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)); });
const back = () => act(async () => { window.history.back(); await new Promise(r => setTimeout(r, 30)); });
const onboarding = (c) => c.querySelector('.onboarding');

test('빈 가계부를 처음 열면 첫 실행 안내가 열리고, 기본값을 넣으면 닫히며 첫 거래 안내 3단계로 이어진다', async () => {
  const c = await openApp(M.createDatabase(SQL, null).db);
  expect(onboarding(c)).not.toBeNull();

  expect(c.querySelector('.onb-account').textContent).toContain('me@outlook.com의 OneDrive');
  await click(button(c, '맞벌이'));
  await click(button(c, '이대로 시작하기'));
  await act(async () => { await new Promise(r => setTimeout(r, 30)); });
  expect(onboarding(c)).toBeNull();
  expect(window.history.state.showOnboarding).toBe(false); // 안내를 연 기록은 뒤로 물렸다
  expect(c.querySelector('.toast-banner').textContent).toMatch(/카테고리 12개·결제수단 4개를 넣었습니다/);
  expect(M.getBudgetCategories(shared.db)).toContain('용돈');

  const guide = c.querySelector('.first-entry');
  expect(guide.textContent).toContain('첫 거래를 입력해 볼까요?');
  expect(guide.querySelectorAll('.first-entry-steps li')).toHaveLength(3);
  expect(guide.querySelector('.first-entry-warn')).toBeNull();
  await click(button(c, '첫 거래 입력해 보기'));
  expect(c.querySelector('.tx-form')).not.toBeNull();
});

test("'나중에'를 고르면 이 기기에서는 다음에 열 때 저절로 열지 않고, 거래내역 빈 화면의 버튼으로 다시 연다", async () => {
  const db = M.createDatabase(SQL, null).db;
  let c = await openApp(db);
  await click(button(c, '나중에 할게요'));
  expect(onboarding(c)).toBeNull();
  expect(M.isBlankLedger(db)).toBe(true); // 가계부에는 아무것도 쓰지 않았다
  expect(c.querySelector('.first-entry').textContent).toContain('새 가계부예요');

  roots.splice(0).forEach(({ root, container }) => { act(() => root.unmount()); container.remove(); });
  c = await openApp(db);
  expect(onboarding(c)).toBeNull();
  await click(button(c, '기본 카테고리·결제수단 넣기'));
  expect(onboarding(c)).not.toBeNull();
});

test('뒤로가기로 닫으면 이번만 닫는다 — 다음에 열 때 다시 연다', async () => {
  const db = M.createDatabase(SQL, null).db;
  let c = await openApp(db);
  expect(onboarding(c)).not.toBeNull();
  await back();
  expect(onboarding(c)).toBeNull();

  roots.splice(0).forEach(({ root, container }) => { act(() => root.unmount()); container.remove(); });
  c = await openApp(db);
  expect(onboarding(c)).not.toBeNull();
});

test('가져오기를 고르면 안내 대신 가져오기 창이 열리고, 닫으면 안내로 돌아온다', async () => {
  const c = await openApp(M.createDatabase(SQL, null).db);
  await click(button(onboarding(c), '가져오기'));
  expect(onboarding(c)).toBeNull();
  expect(c.querySelector('.import-file-input, input[type="file"]')).not.toBeNull();
  await back();
  expect(c.querySelector('input[type="file"]')).toBeNull();
  expect(onboarding(c)).not.toBeNull();
});

test('이미 쓰던 가계부는 안내를 열지 않는다 — 거래가 없으면 첫 거래 안내, 고를 결제수단이 없으면 먼저 만들라고 알리고 그 설정을 연다', async () => {
  const db = M.createDatabase(SQL, null).db;
  M.addBudgetCategory(db, '식비');
  M.addSubCategory(db, '식비', '외식');
  const c = await openApp(db);
  expect(onboarding(c)).toBeNull();
  expect(c.querySelector('.first-entry').textContent).toContain('첫 거래를 입력해 볼까요?');
  expect(c.querySelector('.first-entry-warn').textContent).toContain('먼저 설정에서 결제수단을 하나 이상');
  await click(button(c, '설정에서 만들기'));
  expect(c.querySelector('.tab.active').textContent).toBe('결제수단');
});

test('세부카테고리가 없는 카테고리만 있으면 저장할 수 없다고 알린다 (입력 폼은 세부카테고리를 꼭 고른다)', async () => {
  const db = M.createDatabase(SQL, null).db;
  M.addPaymentMethod(db, '현금');
  M.addBudgetCategory(db, '식비');
  const c = await openApp(db);
  expect(c.querySelector('.first-entry-warn').textContent).toContain('먼저 설정에서 세부카테고리를 하나 이상');
  await click(button(c, '설정에서 만들기'));
  expect(c.querySelector('.tab.active').textContent).toBe('카테고리');
});

test('저장소에서 다시 받아(🔄·앱 복귀) 빈 가계부로 바뀌어도 이번 세션에는 다시 열지 않는다', async () => {
  const c = await openApp(M.createDatabase(SQL, null).db);
  await back(); // 이번만 닫음
  expect(onboarding(c)).toBeNull();
  await act(async () => { shared.reload(M.createDatabase(SQL, null).db); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  expect(onboarding(c)).toBeNull();
});

test('열려 있는 동안 다른 기기의 변경이 들어와 가계부가 비지 않게 되면 안내를 닫고 이유를 알리며, 열린 기록도 지운다', async () => {
  const c = await openApp(M.createDatabase(SQL, null).db);
  expect(window.history.state.showOnboarding).toBe(true);
  const other = M.createDatabase(SQL, null).db; // 다른 기기가 꾸민 파일을 받아 합친 결과
  M.addPaymentMethod(other, '우리카드');
  await act(async () => { shared.reload(other); });
  await act(async () => { await new Promise(r => setTimeout(r, 30)); });
  expect(onboarding(c)).toBeNull();
  expect(c.querySelector('.toast-banner').textContent).toContain('다른 기기에서 카테고리·결제수단을 만들어 첫 실행 안내를 닫았습니다');
  expect(window.history.state.showOnboarding).toBe(false);
});

test('거래가 있으면 안내 없이 목록을 보여 준다', async () => {
  const db = M.createDatabase(SQL, null).db;
  M.addPaymentMethod(db, '현금');
  M.addTransaction(db, { payment_method: '현금', date: '2026-11-01', budget_category: '식비', sub_category: '외식', detail: '점심', amount: 9000 });
  const c = await openApp(db);
  expect(onboarding(c)).toBeNull();
  expect(c.querySelector('.first-entry')).toBeNull();
  expect(c.textContent).toContain('점심');
});
