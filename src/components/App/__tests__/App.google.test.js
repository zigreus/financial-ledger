/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// Google 로그인으로 쓰기 (M-1, I-031) — 세션이 있으면 Google Drive 저장소, 토큰이 끝나면 '다시 연결', 없으면 로그인 화면
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../../services/dbManager';
import { ReconnectRequiredError } from '../../../services/storage/provider';
import { startGoogleLogin, rememberGoogleResult, clearGoogleNotice } from '../../../auth/googleAuth';
import App from '../App';
import { preloadScreens } from '../screens';

vi.mock('../../../auth/googleAuth', async (orig) => ({ ...(await orig()), startGoogleLogin: vi.fn() }));

const shared = vi.hoisted(() => ({ db: null, storage: undefined, msal: false }));

vi.mock('@azure/msal-react', () => ({
  useIsAuthenticated: () => shared.msal,
  useMsal: () => ({ instance: {}, accounts: shared.msal ? [{ homeAccountId: 'ms', username: 'me@outlook.com' }] : [], inProgress: 'none' }),
}));
vi.mock('../../../services/aiSettingsSync', () => ({
  setAISyncAccount: vi.fn(),
  syncAISettings: vi.fn(async () => 'none'),
  onAISettingsPulled: () => () => {},
}));
vi.mock('../../../hooks/useLedgerSync', async () => {
  const React = await import('react');
  return {
    allowNextUnload: () => {},
    default: function useFakeLedger({ storage }) {
      shared.storage = storage;
      return {
        db: storage ? shared.db : null, dataVersion: 0, loading: false, saving: false, error: '', setError: () => {}, notice: null,
        offline: false, dirty: false, pendingCount: 2, loadDb: async () => {}, saveNow: async () => true, resetForLogout: () => {},
        listBackups: async () => [], createBackup: async () => '', restoreBackup: async () => {},
      };
    },
  };
});

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  // 열 때 불러오는 화면(I-033)을 미리 불러 둔다 — 화면이 기다림 없이 바로 그려지게
  expect(await preloadScreens()).toBe(true);
  SQL = await initSqlJs();
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

let root;
let container;
beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'cid');
  shared.msal = false;
  shared.storage = undefined;
  ({ db: shared.db } = M.createDatabase(SQL, null));
  M.addPaymentMethod(shared.db, '현금');
  M.addBudgetCategory(shared.db, '식비');
  M.addSubCategory(shared.db, '식비', '카페');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); });

const session = (expiresInMs) => window.localStorage.setItem('ledger_google_session', JSON.stringify({
  accessToken: expiresInMs > 0 ? 'AT' : '', expiresAt: Date.now() + expiresInMs, sub: 'g1', email: 'mom@gmail.com',
}));
const show = () => act(async () => { root.render(<App />); });

test('로그인하지 않았으면 로그인 화면 — Google 버튼이 보인다', async () => {
  await show();
  expect(container.textContent).toContain('Google 계정으로 로그인');
  expect(container.textContent).toContain('Microsoft 계정으로 로그인');
  expect(shared.storage).toBeNull();
});

test('Google 세션이 있으면 Google Drive 저장소로 연다 — 계정 키는 google:<sub>, 머리글에 이름', async () => {
  session(60 * 60 * 1000);
  await show();
  expect(shared.storage.accountKey).toBe('google:g1');
  expect(container.querySelector('.btn-user').textContent).toBe('mom');
  expect(container.querySelector('.g-reconnect')).toBeNull();
});

test('토큰이 끝났으면 저장소가 연결 없음처럼 실패하고, 다시 연결 안내를 보인다(보관 중인 변경 수와 함께)', async () => {
  session(-1000);
  await show();
  await expect(shared.storage.read()).rejects.toBeInstanceOf(ReconnectRequiredError);
  const banner = container.querySelector('.g-reconnect');
  expect(banner.textContent).toContain('Google 연결 시간이 끝났어요(mom@gmail.com)');
  expect(banner.textContent).toContain('저장 안 된 변경 2건은 이 기기에 보관 중이에요');
  expect(banner.querySelector('button').textContent).toBe('다시 연결');
});

describe("'다시 연결'", () => {
  beforeEach(() => { startGoogleLogin.mockReset(); clearGoogleNotice(); });
  afterEach(() => { Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); });
  const reconnectButton = () => container.querySelector('.g-reconnect-btn');

  test('누르면 계정 확인 화면을 띄울 수 있는 방식으로(화면 없는 방식만이 아니라) Google에 다녀온다', async () => {
    session(-1000);
    await show();
    await act(async () => { reconnectButton().click(); });
    expect(startGoogleLogin).toHaveBeenCalledWith({ reconnect: true });
    expect(reconnectButton().textContent).toBe('이동 중…');
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });   // 뒤로 와도 굳지 않는다
    expect(reconnectButton().textContent).toBe('다시 연결');
  });

  test('앱을 열 때 화면 없이 다녀오다 직접 로그인이 필요했으면 그 안내를 함께 보인다', async () => {
    session(-1000);
    rememberGoogleResult({ handled: true, ok: false, needLogin: true });
    await show();
    expect(container.querySelector('.g-reconnect').textContent).toContain('Google에 다시 로그인해야 합니다');
  });

  test('연결이 없으면 이동하지 않고 알린다', async () => {
    session(-1000);
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await show();
    await act(async () => { reconnectButton().click(); });
    expect(startGoogleLogin).not.toHaveBeenCalled();
    expect(container.querySelector('.g-reconnect').textContent).toContain('지금은 연결이 없어요');
  });
});

test('Microsoft로 로그인했으면 예전처럼 OneDrive', async () => {
  shared.msal = true;
  await show();
  expect(shared.storage.accountKey).toBe('ms');
  expect(container.querySelector('.g-reconnect')).toBeNull();
});
