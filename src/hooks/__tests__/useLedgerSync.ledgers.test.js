/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 가계부 바꾸기·로그아웃 (M-2) — 공유받은 가계부는 열쇠(ledgerKey)가 따로. useLedgerSync.merge.test.js의 '가계부 바꾸기'에 이어서
// (한 파일에 sql.js DB를 너무 많이 열면 메모리가 모자라 따로 둔다). 저장소는 버전 규칙을 지키는 메모리 가짜, DB는 진짜 sql.js
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { createMemoryStorage } from '../../services/storage/memory';
import { createDatabase, addTransaction } from '../../services/dbManager';
import { savePending, countPendingForAccount } from '../../services/changeLog';
import useLedgerSync from '../useLedgerSync';

vi.mock('../../services/dbManager', async (importOriginal) => {
  const actual = await importOriginal();
  const initSqlJs = (await import('sql.js/dist/sql-asm.js')).default;
  let SQL = null;
  return { ...actual, initSQL: async () => (SQL ||= await initSqlJs()) };
});

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const tx = (detail, amount = 1000) => ({ payment_method: '카드', date: '2026-11-01', budget_category: '식비', detail, amount });
function ledgerWith(...detailsList) {
  const { db } = createDatabase(SQL, null);
  detailsList.forEach(d => addTransaction(db, tx(d)));
  return db.export();
}
const details = (db) => (db.exec('SELECT detail FROM transactions ORDER BY id')[0]?.values || []).map(r => r[0]);
const pendingStored = (key = 'me') => JSON.parse(window.localStorage.getItem(`ledger_pending_changes:${key}`) || 'null');
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

let storage;
beforeEach(() => {
  window.localStorage.clear();
  storage = createMemoryStorage({ accountKey: 'me', bytes: ledgerWith('지금') });
});

async function mountSwitchable(first) {
  const ref = { current: null, setStore: null };
  function Harness() {
    const [store, setStore] = useState(first);
    ref.setStore = setStore;
    ref.current = useLedgerSync({ storage: store });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Harness />); });
  return { ref, unmount: () => act(() => root.unmount()) };
}
const switchTo = async (m, store) => {
  await act(async () => { m.ref.setStore(store); });
  await act(async () => { await m.ref.current.loadDb(); });
  await flush();
};
async function opened(store = storage) {
  const m = await mountSwitchable(store);
  await act(async () => { await m.ref.current.loadDb(); });
  await flush();
  return m;
}

describe('가계부 바꾸기 (M-2)', () => {
  test('불러오는 중에 바꿔도(closeLedger) 새 가계부가 열린다 — 늦게 끝난 옛 불러오기는 새 가계부를 건드리지 않는다', async () => {
    const own = storage;
    const shared = { ...createMemoryStorage({ accountKey: 'me', bytes: ledgerWith('가족 가계부') }), ledgerKey: 'me#ms:d1:i1', isShared: true };
    const m = await mountSwitchable(own);
    await act(async () => { await m.ref.current.loadDb(); });
    await flush();
    // 앱으로 돌아와 조용히 다시 받는 중 — 버전 확인이 늦게 온다
    let release;
    const realGetVersion = own.getVersion;
    const realRead = own.read;
    own.getVersion = () => new Promise((r) => { release = () => r(realGetVersion()); });
    own.read = () => new Promise((r) => { const prev = release; release = () => { if (prev) prev(); r(realRead()); }; });
    let silent;
    await act(async () => { silent = m.ref.current.loadDb({ silent: true }); });
    await act(async () => { m.ref.current.closeLedger(); });
    expect(m.ref.current.db).toBeNull();
    await switchTo(m, shared);
    expect(details(m.ref.current.db)).toEqual(['가족 가계부']);
    // 옛 불러오기가 이제 끝난다
    await act(async () => { if (release) release(); await silent.catch(() => {}); });
    await flush();
    expect(details(m.ref.current.db)).toEqual(['가족 가계부']);
    expect(pendingStored('me#ms:d1:i1')).toBeNull();
    m.unmount();
  });

  test('로그아웃하면 이 계정의 다른 가계부에 남은 미저장 변경도 지운다 — 다른 계정 것은 그대로', async () => {
    const entry = { entries: [{ sql: 'SELECT 1', params: [] }], inFlight: [], base: 'v1', generation: 0 };
    savePending('me#ms:d1:i1', entry);
    savePending('other', entry);
    const m = await opened();
    expect(countPendingForAccount('me', 'me')).toBe(1);
    await act(async () => { await m.ref.current.resetForLogout(); });
    expect(pendingStored('me#ms:d1:i1')).toBeNull();
    expect(pendingStored('other')).not.toBeNull();
    expect(countPendingForAccount('me')).toBe(0);
    m.unmount();
  });
});
