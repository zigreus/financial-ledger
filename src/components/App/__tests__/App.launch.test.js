/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 홈 화면 바로가기·공유 받기·오프라인 표시 (I-024) — 로그인·저장 훅·AI 입력 화면은 가짜, 가계부 DB는 진짜 sql.js
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../../services/dbManager';
import { takeSharedItems } from '../../../services/shareInbox';
import App from '../App';

const shared = vi.hoisted(() => ({ db: null, offline: false, starts: [], accounts: [{ homeAccountId: 'me', username: 'me@outlook.com' }], instance: {} }));

vi.mock('@azure/msal-react', () => ({
  useIsAuthenticated: () => true,
  useMsal: () => ({ instance: shared.instance, accounts: shared.accounts }),
}));
vi.mock('../../../services/aiSettingsSync', () => ({
  setAISyncAccount: vi.fn(),
  syncAISettings: vi.fn(async () => 'none'),
  onAISettingsPulled: () => () => {},
}));
vi.mock('../../../services/shareInbox', async (importOriginal) => ({
  ...(await importOriginal()),
  takeSharedItems: vi.fn(async () => null),
  clearSharedItems: vi.fn(async () => {}),
}));
// AI 입력은 받은 시작 정보(start)만 기록한다
vi.mock('../../AIEntry/AIEntry', () => ({
  default: ({ start }) => { shared.starts.push(start); return <div className="fake-ai">{start ? JSON.stringify({ quick: !!start.quick, text: start.text || '', files: (start.files || []).length }) : 'none'}</div>; },
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
        offline: shared.offline, dirty: false, pendingCount: 0, loadDb: async () => {}, saveNow: async () => true, resetForLogout: () => {},
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

let root;
let container;
afterEach(() => { act(() => root.unmount()); container.remove(); window.history.replaceState(null, '', '/'); });
beforeEach(() => {
  window.localStorage.clear();
  shared.starts = [];
  shared.offline = false;
  takeSharedItems.mockReset();
  takeSharedItems.mockResolvedValue(null);
});

function ledger({ blank = false } = {}) {
  const { db } = M.createDatabase(SQL, null);
  if (!blank) {
    M.addPaymentMethod(db, '현금');
    M.addBudgetCategory(db, '식비');
    M.addSubCategory(db, '식비', '카페');
    M.addTransaction(db, { payment_method: '현금', date: '2026-11-01', budget_category: '식비', sub_category: '카페', detail: '예전 커피', amount: 4000 });
  }
  return db;
}
async function openAt(url, db = ledger()) {
  window.history.replaceState(null, '', url);
  shared.db = db;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<App />); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const fakeAI = () => container.querySelector('.fake-ai');

test("바로가기 'AI 입력'으로 열면 입력 창과 AI 입력 상자를 바로 열고, 주소의 표시는 지운다", async () => {
  await openAt('/?action=ai');
  expect(container.querySelector('.tx-form')).not.toBeNull();
  expect(JSON.parse(fakeAI().textContent)).toEqual({ quick: true, text: '', files: 0 });
  expect(window.location.search).toBe('');
});

test("바로가기 '거래 입력'으로 열면 입력 창만 연다", async () => {
  await openAt('/?action=add');
  expect(container.querySelector('.tx-form')).not.toBeNull();
  expect(fakeAI().textContent).toBe('none');
});

test('공유로 받은 사진·글이 있으면 AI 입력으로 연다 — 로그인을 거쳐 주소의 표시가 사라졌어도', async () => {
  takeSharedItems.mockResolvedValue({ text: '스타벅스 영수증', files: [new File([new Uint8Array([1])], 'r.jpg', { type: 'image/jpeg' })] });
  await openAt('/');
  expect(container.querySelector('.tx-form')).not.toBeNull();
  expect(JSON.parse(fakeAI().textContent)).toEqual({ quick: false, text: '스타벅스 영수증', files: 1 });
});

test('평소에는 입력 창을 열지 않고, 빈 가계부는 첫 실행 안내가 먼저다', async () => {
  await openAt('/');
  expect(container.querySelector('.tx-form')).toBeNull();
  root.unmount(); container.remove();
  await openAt('/?action=ai', ledger({ blank: true }));
  expect(container.querySelector('.tx-form')).toBeNull();
  expect(container.querySelector('.onboarding')).not.toBeNull();
});

test('입력 창을 닫았다 다시 열면 AI 입력은 평소대로 시작한다', async () => {
  await openAt('/?action=ai');
  await act(async () => { window.history.back(); await new Promise(r => setTimeout(r, 30)); });
  expect(container.querySelector('.tx-form')).toBeNull();
  await act(async () => { container.querySelector('.nav-add').click(); await new Promise(r => setTimeout(r, 0)); });
  expect(fakeAI().textContent).toBe('none');
});

test('연결이 없으면 헤더에 오프라인을 보인다', async () => {
  shared.offline = true;
  await openAt('/');
  expect(container.querySelector('.header-offline').textContent).toBe('오프라인');
});
