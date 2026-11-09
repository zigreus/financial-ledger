/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 문제 알리기가 필요한 순간 (I-038) — 화면 위 띠로 알린 오류를 기록하고(늘 있는 안내는 빼고),
// 가계부를 불러오지 못한 화면·화면을 그리다 멈춘 화면에서도 문제 알리기를 열 수 있다
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../../services/dbManager';
import { getErrorLog } from '../../../services/errorLog';
import App from '../App';
import ErrorBoundary from '../../common/ErrorBoundary';
import { preloadScreens } from '../screens';

const shared = vi.hoisted(() => ({ db: null, error: '', loaded: true, loading: false }));

vi.mock('@azure/msal-react', () => ({
  useIsAuthenticated: () => true,
  useMsal: () => ({ instance: {}, accounts: [{ homeAccountId: 'ms', username: 'me@outlook.com' }], inProgress: 'none' }),
}));
vi.mock('../../../services/aiSettingsSync', () => ({
  setAISyncAccount: vi.fn(),
  syncAISettings: vi.fn(async () => 'none'),
  onAISettingsPulled: () => () => {},
}));
vi.mock('../../../hooks/useLedgerSync', () => ({
  allowNextUnload: () => {},
  default: function useFakeLedger() {
    return {
      db: shared.loaded ? shared.db : null, dataVersion: 0, loading: shared.loading, saving: false, error: shared.error, setError: () => {}, notice: null,
      offline: false, dirty: false, pendingCount: 0, loadDb: async () => {}, saveNow: async () => true, resetForLogout: () => {},
      listBackups: async () => [], createBackup: async () => '', restoreBackup: async () => {},
    };
  },
}));

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  expect(await preloadScreens()).toBe(true);   // 문제 알리기도 함께 불러 둔다
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
  shared.error = '';
  shared.loaded = true;
  shared.loading = false;
  ({ db: shared.db } = M.createDatabase(SQL, null));
  M.addPaymentMethod(shared.db, '현금');
  M.addBudgetCategory(shared.db, '식비');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

const show = (el = <App />) => act(async () => { root.render(el); });
const button = label => [...container.querySelectorAll('button')].find(b => b.textContent === label);

test('화면 위 띠로 알린 오류는 이 기기의 오류 기록에 남는다 — 연결 없음 같은 늘 있는 안내는 남기지 않는다', async () => {
  shared.error = '저장 실패: OneDrive 저장 오류: 500 — 변경 내용은 이 기기에 보관되어 있고, 연결되면 다시 저장합니다';
  await show();
  expect(container.querySelector('.error-banner').textContent).toContain('저장 실패');
  expect(getErrorLog().map(e => [e.kind, e.message])).toEqual([['화면에 알린 오류', shared.error]]);
  shared.error = '연결이 없어 새로 받지 못했습니다 — 이 기기의 가계부로 계속 쓸 수 있고, 연결되면 저장합니다';
  await show();
  expect(getErrorLog()).toHaveLength(1);
});

test('가계부를 불러오지 못한 화면에서도 문제 알리기를 열 수 있다(오류가 있을 때만)', async () => {
  shared.loaded = false;
  await show();
  expect(button('문제 알리기')).toBeUndefined();   // 오류 없이 기다리는 중이면 보이지 않는다
  shared.error = '불러오기 실패: OneDrive 읽기 오류: 503 Service Unavailable';
  await show();
  await act(async () => { button('문제 알리기').click(); });
  expect(button('문제 알리기')).toBeUndefined();
  const text = container.querySelector('.load-report .preport-text').textContent;
  expect(text).toContain('저장소: OneDrive');
  expect(text).toContain('[화면에 알린 오류] 불러오기 실패: OneDrive 읽기 오류: 503 Service Unavailable');
});

test('다시 불러오는 동안에도 적던 글이 남고, 가계부를 열면 닫혀 다음 실패 때는 버튼부터', async () => {
  shared.loaded = false;
  shared.error = '불러오기 실패: 503';
  await show();
  await act(async () => { button('문제 알리기').click(); });
  const area = () => container.querySelector('.load-report textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  act(() => { setter.call(area(), '안 열려요'); area().dispatchEvent(new Event('input', { bubbles: true })); });
  shared.loading = true;   // '가계부 불러오기'를 눌러 다시 불러오는 중
  await show();
  expect(container.querySelector('.spinner')).not.toBeNull();
  expect(area().value).toBe('안 열려요');
  shared.loading = false;
  shared.loaded = true;
  shared.error = '';
  await show();
  expect(container.querySelector('.load-report')).toBeNull();
  shared.loaded = false;
  shared.error = '불러오기 실패: 503';
  await show();
  expect(container.querySelector('.load-report')).toBeNull();
  expect(button('문제 알리기')).toBeDefined();
});

test('화면을 그리다 멈추면 흰 화면 대신 안내·다시 열기·문제 알리기 — 오류는 이 기기에 남는다', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});   // React가 잡은 오류를 콘솔에 적는 것
  function Broken() { throw new TypeError('cannot read x'); }
  await show(<ErrorBoundary><Broken /></ErrorBoundary>);
  expect(container.querySelector('.crash-title').textContent).toBe('화면을 그리다 문제가 생겼어요');
  expect(button('다시 열기')).toBeDefined();
  expect(getErrorLog().some(e => e.kind === '화면 오류' && e.message === 'TypeError: cannot read x')).toBe(true);
  await act(async () => { button('문제 알리기').click(); });
  expect(container.querySelector('.crash-card .preport-text').textContent).toContain('[화면 오류] TypeError: cannot read x');
});

test('오류가 없으면 그대로 그린다', async () => {
  await show(<ErrorBoundary><p className="ok">괜찮아요</p></ErrorBoundary>);
  expect(container.querySelector('.ok').textContent).toBe('괜찮아요');
  expect(container.querySelector('.crash-page')).toBeNull();
});
