/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 다른 계정과 함께 쓰기 (ROADMAP M-2, 1단계 Microsoft 개인 계정) — 참여 링크로 열기, 가계부 바꾸기, 열 수 없을 때.
// OneDrive 저장소 만들기와 저장 훅은 가짜(어느 가계부로 만들었는지만 본다), 가계부 DB는 진짜 sql.js
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../../services/dbManager';
import { buildJoinLink, capturePendingJoin, getSharedLedgers, peekPendingJoin } from '../../../services/ledgers';
import { SHARED_GONE_MESSAGE } from '../../../services/storage/oneDrive';
import { OfflineError } from '../../../services/storage/provider';
import { createMemoryStorage } from '../../../services/storage/memory';
import App from '../App';
import { preloadScreens } from '../screens';

const CONSUMER = '9188040d-6c67-4c5b-b112-36a304b66dad';
const shared = vi.hoisted(() => ({
  storages: [], current: null, settings: null, closed: 0, ownDb: null, sharedDb: null, accounts: [], instance: {}, inspect: null, ownRef: null, failShared: false,
}));

vi.mock('@azure/msal-react', () => ({
  useIsAuthenticated: () => true,
  // MSAL처럼 계정 목록·인스턴스는 그릴 때마다 같은 것(바뀌면 저장소를 새로 만든다)
  useMsal: () => ({ instance: shared.instance, accounts: shared.accounts }),
}));
vi.mock('../../../services/aiSettingsSync', () => ({
  setAISyncAccount: vi.fn(),
  syncAISettings: vi.fn(async () => 'none'),
  onAISettingsPulled: () => () => {},
}));
vi.mock('../../../services/storage/oneDrive', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createOneDriveStorage: (instance, accounts, { ledger = null } = {}) => {
      const accountKey = accounts[0].homeAccountId;
      // 설정 파일(ledgers.json)은 테스트마다 새로 — shared.settings
      const base = { accountKey, readSettings: (...a) => shared.settings.readSettings(...a), writeSettings: (...a) => shared.settings.writeSettings(...a) };
      const s = ledger
        ? { ...base, ledger, isShared: true, ledgerKey: actual.sharedLedgerKey(accountKey, ledger) }
        : {
          ...base,
          isShared: false,
          sharing: {
            provider: 'ms',
            ownLedgerRef: async () => shared.ownRef,
            inspectShared: async ref => shared.inspect(ref),
            invite: async () => shared.ownRef,
            listMembers: async () => [],
            removeMember: async () => {},
          },
        };
      shared.storages.push(s);
      return s;
    },
  };
});
vi.mock('../../../hooks/useLedgerSync', async () => {
  const React = await import('react');
  return {
    allowNextUnload: () => {},
    default: function useFakeLedger({ storage }) {
      shared.current = storage;   // 지금 쓰는 저장소
      const [loaded, setLoaded] = React.useState(null);   // { storage, fail } — 불러올 때마다 새로(다시 그리게)
      const ok = loaded?.storage === storage && !loaded.fail;
      const db = ok ? (storage?.isShared ? shared.sharedDb : shared.ownDb) : null;
      return {
        db, dataVersion: 0, loading: false, saving: false,
        error: loaded?.storage === storage && loaded.fail ? '불러오기 실패: 공유받은 가계부를 열 수 없습니다' : '',
        setError: () => {}, notice: null, offline: false, dirty: false, pendingCount: 0,
        loadDb: async () => { setLoaded({ storage, fail: !!storage?.isShared && shared.failShared }); }, saveNow: async () => true, resetForLogout: () => {},
        closeLedger: () => { shared.closed += 1; setLoaded(null); },
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

const REF = { driveId: 'momdrive', itemId: 'MOM!1' };
function ledger(detail) {
  const { db } = M.createDatabase(SQL, null);
  M.addPaymentMethod(db, '현금');
  M.addBudgetCategory(db, '식비');
  M.addTransaction(db, { payment_method: '현금', date: '2026-11-08', budget_category: '식비', detail, amount: 1000 });
  return db;
}

let root;
let container;
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  shared.storages = [];
  shared.current = null;
  shared.settings = createMemoryStorage({ accountKey: 'settings' });
  shared.ownDb = ledger('내 거래');
  shared.sharedDb = ledger('엄마 가계부 거래');
  shared.accounts = [{ homeAccountId: `me.${CONSUMER}`, tenantId: CONSUMER, name: '아빠' }];
  shared.instance = {};
  shared.ownRef = { driveId: 'mydrive', itemId: 'MINE!1' };
  shared.inspect = async () => ({ name: 'ledger.db', ownerName: '엄마' });
  shared.failShared = false;
  shared.closed = 0;
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const open = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<App />); });
  await wait(10);
};
const wait = (ms = 0) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
const click = el => act(async () => { el.click(); await new Promise(r => setTimeout(r, 10)); });
const button = text => [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const lastStorage = () => shared.current;
const shownDetails = () => [...document.body.querySelectorAll('.tx-item')].map(el => el.textContent);
const joinVia = (ref = REF) => {
  window.history.replaceState(null, '', new URL(buildJoinLink('https://app.example', ref, '엄마')).search);
  capturePendingJoin(window);
};

test('참여 링크로 열면 묻고, 열기를 누르면 공유받은 가계부로 — 머리글에서 내 가계부로 바꿀 수 있다', async () => {
  joinVia();
  await open();
  expect(document.body.textContent).toContain('엄마님이 함께 쓰자고 공유한 가계부예요');
  expect(lastStorage().isShared).toBe(false);
  await click(button('열기'));
  await wait(10);
  expect(lastStorage().isShared).toBe(true);
  expect(lastStorage().ledger).toEqual(REF);
  expect(shownDetails().some(t => t.includes('엄마 가계부 거래'))).toBe(true);
  expect(getSharedLedgers(shared.accounts[0].homeAccountId).map(l => l.ownerName)).toEqual(['엄마']);
  const title = document.body.querySelector('.header-title-btn');
  expect(title.textContent).toContain('엄마 가계부');

  await click(title);
  expect(document.body.querySelector('.ledger-pick--on').textContent).toContain('엄마 가계부');
  await click([...document.body.querySelectorAll('.ledger-pick')].find(b => b.textContent.includes('내 가계부')));
  await wait(10);
  expect(lastStorage().isShared).toBe(false);
  expect(shownDetails().some(t => t.includes('내 거래'))).toBe(true);
  expect(document.body.querySelector('.header-title-btn').textContent).toContain('지금 가계부');
});

test('나중에를 누르면 넣지 않고 링크는 남겨 두어, 다음에 앱을 열 때 다시 묻는다', async () => {
  joinVia();
  await open();
  await click(button('나중에'));
  expect(getSharedLedgers(shared.accounts[0].homeAccountId)).toEqual([]);
  expect(document.body.querySelector('.ledger-dialog')).toBeNull();
  expect(peekPendingJoin()).not.toBeNull();
  act(() => root.unmount());
  container.remove();
  await open();
  expect(document.body.textContent).toContain('엄마님이 함께 쓰자고 공유한 가계부예요');
});

test('연결이 없거나 잠깐의 오류면 링크를 남겨 둔다 — 연결 없음은 묻지도 않는다', async () => {
  shared.inspect = async () => { throw new OfflineError(); };
  joinVia();
  await open();
  expect(document.body.querySelector('.ledger-dialog')).toBeNull();
  expect(peekPendingJoin()).not.toBeNull();
  act(() => root.unmount());
  container.remove();
  shared.inspect = async () => { throw new Error('OneDrive 확인 오류: 503'); };
  await open();
  expect(document.body.querySelector('.ledger-dialog [role="alert"]').textContent).toContain('잠시 뒤 앱을 다시 열어 주세요');
  await click(button('닫기'));
  expect(peekPendingJoin()).not.toBeNull();
});

test('내 가계부의 링크면 묻지 않는다', async () => {
  joinVia(shared.ownRef);
  await open();
  expect(document.body.querySelector('.ledger-dialog')).toBeNull();
  expect(document.body.textContent).toContain('내 가계부의 참여 링크예요');
});

test('초대받지 않은 계정이면(열 수 없음) 초대받은 계정인지 확인하라고 알리고 링크는 버린다', async () => {
  shared.inspect = async () => { throw new Error(SHARED_GONE_MESSAGE); };
  joinVia();
  await open();
  expect(document.body.querySelector('.ledger-dialog [role="alert"]').textContent).toContain('초대받은 Microsoft 계정으로 로그인했는지');
  expect(button('열기')).toBeUndefined();
  expect(peekPendingJoin()).toBeNull();
});

test('가계부를 바꾸면 지금 가계부를 먼저 닫고 처음 화면(거래내역)으로 — 앞 가계부의 화면·뒤로가기 기록을 쓰지 않는다', async () => {
  joinVia();
  await open();
  await click(button('나중에'));
  await click([...document.body.querySelectorAll('.nav-item')].find(b => b.textContent.includes('요약')));
  expect(document.body.querySelector('.nav-item.active .nav-label').textContent).toBe('요약');
  // 목록에 넣고 바꾸기
  act(() => root.unmount());
  container.remove();
  await open();
  await click(button('열기'));
  expect(shared.closed).toBe(1);
  expect(document.body.querySelector('.nav-item.active .nav-label').textContent).toBe('거래내역');
  await act(async () => { window.history.back(); await new Promise(r => setTimeout(r, 20)); });
  expect(lastStorage().isShared).toBe(true);
  expect(document.body.querySelector('.nav-item.active .nav-label').textContent).toBe('거래내역');
});

test('회사·학교 Microsoft 계정이면 아직 지원하지 않는다고 알린다', async () => {
  shared.accounts = [{ homeAccountId: 'me.contoso', tenantId: 'contoso', name: '아빠' }];
  joinVia();
  await open();
  expect(document.body.querySelector('.ledger-dialog [role="alert"]').textContent).toContain('회사·학교 Microsoft 계정은 아직');
});

test('이미 넣은 가계부의 참여 링크를 다시 누르면 묻지 않고 그 가계부로 — 보고 있으면 그대로(멈추지 않는다)', async () => {
  joinVia();
  await open();
  await click(button('열기'));
  expect(lastStorage().isShared).toBe(true);
  act(() => root.unmount());
  container.remove();
  joinVia();   // 대화방의 같은 링크를 또 눌렀다
  await open();
  expect(document.body.querySelector('.ledger-dialog')).toBeNull();
  expect(lastStorage().isShared).toBe(true);
  expect(shownDetails().some(t => t.includes('엄마 가계부 거래'))).toBe(true);
  expect(peekPendingJoin()).toBeNull();
  // 내 가계부를 보다가 누르면 그 가계부로 바꾼다
  await click(document.body.querySelector('.header-title-btn'));
  await click([...document.body.querySelectorAll('.ledger-pick')].find(b => b.textContent.includes('내 가계부')));
  await wait(10);
  expect(lastStorage().isShared).toBe(false);
  act(() => root.unmount());
  container.remove();
  joinVia();
  await open();
  await wait(10);
  expect(document.body.querySelector('.ledger-dialog')).toBeNull();
  expect(lastStorage().isShared).toBe(true);
  expect(shownDetails().some(t => t.includes('엄마 가계부 거래'))).toBe(true);
});

test('잘못된 링크(400)는 다시 묻지 않게 버린다', async () => {
  shared.inspect = async () => { throw new Error('공유받은 가계부를 확인하지 못했습니다: 400 Bad Request'); };
  joinVia();
  await open();
  expect(document.body.querySelector('.ledger-dialog [role="alert"]').textContent).toContain('초대받은 Microsoft 계정으로 로그인했는지');
  expect(peekPendingJoin()).toBeNull();
});

test('다른 기기에서 지금 보던 가계부를 목록에서 뺐으면 닫고 내 가계부로', async () => {
  joinVia();
  await open();
  await click(button('열기'));
  await wait(20);
  expect(lastStorage().isShared).toBe(true);
  act(() => root.unmount());
  container.remove();
  // 다른 기기가 나중에 뺐다(ledgers.json)
  const { data, version } = await shared.settings.readSettings('ledgers.json');
  const id = Object.keys(data.entries)[0];
  await shared.settings.writeSettings('ledgers.json', { entries: { [id]: { ...data.entries[id], removed: true, at: Date.now() + 60000 } } }, version);
  const closedBefore = shared.closed;
  await open();
  await wait(20);
  expect(lastStorage().isShared).toBe(false);
  expect(shared.closed).toBe(closedBefore + 1);
  expect(shownDetails().some(t => t.includes('내 거래'))).toBe(true);
});

test('참여 링크 때문에 미룬 첫 실행 안내는 나중에를 누르면 연다(내 가계부가 비어 있을 때)', async () => {
  shared.ownDb = M.createDatabase(SQL, null).db;   // 빈 내 가계부
  joinVia();
  await open();
  expect(document.body.querySelector('.onb-body')).toBeNull();   // 참여 링크를 먼저 묻는다
  expect(document.body.querySelector('.ledger-dialog')).not.toBeNull();
  await click(button('나중에'));
  await wait(10);
  expect(document.body.querySelector('.onb-body')).not.toBeNull();
});

test('공유받은 가계부를 열 수 없게 되면(주인이 공유를 끊음) 불러오기 실패 화면에서 내 가계부로 돌아갈 수 있다', async () => {
  joinVia();
  await open();
  await click(button('열기'));
  shared.failShared = true;
  // 머리글의 새로고침(다시 불러오기)
  await click(document.body.querySelector('.btn-refresh'));
  await wait(10);
  const back = button('내 가계부 열기');
  expect(back).toBeDefined();
  await click(back);
  await wait(10);
  expect(lastStorage().isShared).toBe(false);
  expect(shownDetails().some(t => t.includes('내 거래'))).toBe(true);
});
