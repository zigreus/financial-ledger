/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// AI 입력이 바로 넣은 거래 (I-022) — 화면 위 알림·확인 화면의 '되돌리기'로 넣은 그대로인 것만 지운다.
// 로그인(MSAL)·저장 훅·AI 설정 동기화와 AI 입력 화면은 가짜, 가계부 DB는 진짜 sql.js
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../../services/dbManager';
import App from '../App';
import { preloadScreens } from '../screens';

const shared = vi.hoisted(() => ({
  db: null, accounts: [{ homeAccountId: 'me', username: 'me@outlook.com' }], instance: {}, reload: null, result: null,
}));

vi.mock('@azure/msal-react', () => ({
  useIsAuthenticated: () => true,
  useMsal: () => ({ instance: shared.instance, accounts: shared.accounts }),
}));
vi.mock('../../../services/aiSettingsSync', () => ({
  setAISyncAccount: vi.fn(),
  syncAISettings: vi.fn(async () => 'none'),
  onAISettingsPulled: () => () => {},
}));
// AI 입력은 늘 넣던 거래를 골랐다고 치고 바로 넣기만 부른다 (실제 판단은 AIEntry.quick.test.js). 돌려받은 { undo }를 남겨 둔다
vi.mock('../../AIEntry/AIEntry', () => {
  const row = (detail, amount) => ({ payment_method: '현금', date: '2026-11-08', budget_category: '식비', sub_category: '카페', detail, amount });
  return {
    default: ({ onQuickAdd }) => (
      <div className="fake-ai">
        <button type="button" onClick={() => { shared.result = onQuickAdd([row('스타벅스', 5000)], { done: true }); }}>바로 넣고 끝</button>
        <button type="button" onClick={() => { shared.result = onQuickAdd([row('스타벅스', 5000), row('빵', 3000)], { done: false }); }}>바로 넣고 남음</button>
      </div>
    ),
  };
});
vi.mock('../../../hooks/useLedgerSync', async () => {
  const React = await import('react');
  const { attachChangeLog: attach } = await import('../../../services/changeLog');
  return {
    default: function useFakeLedger() {
      const [state, setState] = React.useState({ db: shared.db, version: 0 });
      const bump = () => queueMicrotask(() => setState(s => ({ ...s, version: s.version + 1 })));
      React.useState(() => attach(shared.db, { onWrite: bump }));
      // 앱으로 돌아와 저장소에서 다시 받은 것처럼 DB 객체를 바꾼다
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
afterEach(() => { act(() => root.unmount()); container.remove(); });
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '');
  shared.result = null;
});

/** 기본 목록(현금, 식비 > 카페)과 예전 거래가 있는 가계부 — extra로 거래를 더 넣는다 */
function makeLedger(extra = []) {
  const { db } = M.createDatabase(SQL, null);
  M.addPaymentMethod(db, '현금');
  M.addBudgetCategory(db, '식비');
  M.addSubCategory(db, '식비', '카페');
  [{ detail: '예전 커피', amount: 4000, date: '2026-11-01' }, ...extra].forEach(t => M.addTransaction(db, {
    payment_method: '현금', date: '2026-11-08', budget_category: '식비', sub_category: '카페', ...t,
  }));
  return db;
}

async function openForm() {
  const db = makeLedger();
  shared.db = db;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<App />); });
  await wait();
  await click(container.querySelector('.nav-add'));
  expect(container.querySelector('.tx-form')).not.toBeNull();
  return db;
}
const wait = (ms = 0) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.includes(text));
const click = el => act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)); });
const details = db => M.getTransactions(db).map(t => t.detail).sort();
const topToast = () => container.querySelector('.toast-banner.toast-top');

test('확인할 것이 없으면 입력 창을 닫고 화면 위에 되돌리기 알림을 띄운다 — 되돌리면 그 거래를 지운다', async () => {
  const db = await openForm();
  await click(button('바로 넣고 끝'));
  await wait(30);
  expect(container.querySelector('.tx-form')).toBeNull();
  expect(details(db)).toEqual(['스타벅스', '예전 커피']);
  expect(topToast().textContent).toContain('✓ 자주 넣던 스타벅스 5,000원 바로 추가됨');

  await click(button('되돌리기'));
  expect(details(db)).toEqual(['예전 커피']);
  expect(topToast().textContent).toBe('✓ 방금 바로 넣은 1건을 되돌렸습니다');
  expect(topToast().querySelector('button')).toBeNull();
});

test('확인할 것이 남아 있으면 입력 창은 열어 두고, 그 사이 고친 거래는 되돌리지 않는다', async () => {
  const db = await openForm();
  await click(button('바로 넣고 남음'));
  expect(container.querySelector('.tx-form')).not.toBeNull();
  expect(topToast().textContent).toContain('자주 넣던 2건 8,000원 바로 추가됨');

  const bread = M.getTransactions(db).find(t => t.detail === '빵');
  M.updateTransaction(db, bread.id, { ...bread, amount: 3500 });
  await click(button('되돌리기'));
  expect(details(db)).toEqual(['빵', '예전 커피']);
  expect(topToast().textContent).toBe('1건만 되돌렸습니다 — 나머지는 그사이 고쳐졌거나 지워졌습니다');
});

test('알림과 확인 화면의 되돌리기는 같은 것 — 한 번만 지우고 다시 누르면 그때의 개수를 돌려준다', async () => {
  const db = await openForm();
  await click(button('바로 넣고 남음'));
  let first;
  await act(async () => { first = shared.result.undo(); });
  expect(first).toBe(2);
  expect(details(db)).toEqual(['예전 커피']);
  expect(topToast().textContent).toBe('✓ 방금 바로 넣은 2건을 되돌렸습니다');
  M.addTransaction(db, { payment_method: '현금', date: '2026-11-08', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 5000 });
  let second;
  await act(async () => { second = shared.result.undo(); });
  expect(second).toBe(2);
  expect(details(db)).toEqual(['스타벅스', '예전 커피']);      // 다시 넣은 거래는 건드리지 않는다
});

test('바로 넣은 뒤 저장소에서 다시 받아 DB가 바뀌어도(병합으로 id가 밀림) 내 거래만 되돌린다', async () => {
  await openForm();
  await click(button('바로 넣고 남음'));                    // 스타벅스 id 2, 빵 id 3
  // 다른 기기가 먼저 저장해 id 2·3에 다른 거래가 있고, 내 거래는 그 뒤로 밀린 파일
  const merged = makeLedger([
    { detail: '다른 기기 점심', amount: 9000 }, { detail: '다른 기기 저녁', amount: 12000 },
    { detail: '스타벅스', amount: 5000 }, { detail: '빵', amount: 3000 },
  ]);
  await act(async () => { shared.reload(merged); });
  await wait();
  await click(button('되돌리기'));
  expect(details(merged)).toEqual(['다른 기기 저녁', '다른 기기 점심', '예전 커피']);
  expect(topToast().textContent).toBe('✓ 방금 바로 넣은 2건을 되돌렸습니다');
});
