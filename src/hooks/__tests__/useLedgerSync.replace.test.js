/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 가계부 파일로 바꾸기 (I-035, ROADMAP F-5) — 병합 시나리오(useLedgerSync.merge.test.js)와 같은 메모리 가짜 저장소·진짜 sql.js.
// 따로 둔 까닭: asm 판 sql.js는 힙 크기가 정해져 있어, 한 파일(같은 워커)에 시나리오가 너무 많으면 메모리가 모자란다.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { createMemoryStorage } from '../../services/storage/memory';
import { OfflineError } from '../../services/storage/provider';
import { createDatabase, addTransaction } from '../../services/dbManager';
import { attachChangeLog, getChangeLog, stampWriteId, savePending, generationOfBytes, readGeneration } from '../../services/changeLog';
import { inspectLedgerFile } from '../../services/ledgerFile';
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
  const bytes = db.export();
  db.close();
  return bytes;
}
const rowsOf = (bytes) => {
  const db = new SQL.Database(bytes);
  try { return db.exec('SELECT id, detail, amount FROM transactions ORDER BY id')[0]?.values || []; } finally { db.close(); }
};
const detailsOf = bytes => rowsOf(bytes).map(r => r[1]);
const details = db => (db.exec('SELECT detail FROM transactions ORDER BY id')[0]?.values || []).map(r => r[0]);
const pendingStored = (key = 'me') => JSON.parse(window.localStorage.getItem(`ledger_pending_changes:${key}`) || 'null');
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const waitSave = () => act(async () => { await new Promise(r => setTimeout(r, 450)); });

let storage;
let mounted = [];
beforeEach(() => {
  window.localStorage.clear();
  storage = createMemoryStorage({ accountKey: 'me', bytes: ledgerWith('옛 1', '옛 2', '옛 3', '옛 4', '옛 5') });
});
afterEach(() => { mounted.forEach(u => u()); mounted = []; });

async function opened(store = storage) {
  const ref = { current: null };
  function Harness() { ref.current = useLedgerSync({ storage: store }); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Harness />); });
  await act(async () => { await ref.current.loadDb(); });
  await flush();
  const unmount = () => act(() => root.unmount());
  mounted.push(unmount);
  return ref;
}
/** 연결을 끊었다 이을 수 있는 저장소 — 다른 기기가 저장하지 못한 변경을 들고 있게 */
function flaky(store) {
  const net = { up: true };
  const guard = fn => async (...args) => { if (!net.up) throw new OfflineError(); return fn(...args); };
  return { net, store: { ...store, read: guard(store.read), getVersion: guard(store.getVersion), write: guard(store.write) } };
}

test('파일로 바꾸면 저장소가 그 내용이 되고, 바꾸기 전 파일은 백업에, 새 행 번호는 옛 가계부보다 크다', async () => {
  const A = await opened();
  const other = ledgerWith('다른 계정 1', '다른 계정 2');
  await act(async () => { await A.current.replaceWithFile(other); });
  await flush();

  expect(detailsOf(storage.current())).toEqual(['다른 계정 1', '다른 계정 2']);
  expect(details(A.current.db)).toEqual(['다른 계정 1', '다른 계정 2']);
  expect(A.current.notice.text).toBe('✓ 가계부를 올린 파일로 바꿨습니다');
  expect(generationOfBytes(storage.current())).not.toBe(0);               // 새 세대
  expect(readGeneration(A.current.db)).toBe(generationOfBytes(storage.current()));
  const backups = await storage.listBackups();
  const before = await Promise.all(backups.map(b => storage.readBackup(b.id, () => true)));
  expect(before.some(b => detailsOf(b).join() === '옛 1,옛 2,옛 3,옛 4,옛 5')).toBe(true);

  // 새 거래는 옛 가계부의 번호(1~5)를 다시 받지 않는다 — 다른 기기의 밀린 변경이 그 번호를 가리켜도 엉뚱한 행이 아니게
  await act(async () => { addTransaction(A.current.db, tx('바꾼 뒤 입력')); });
  await waitSave();
  expect(rowsOf(storage.current()).map(r => r.slice(0, 2))).toEqual([[1, '다른 계정 1'], [2, '다른 계정 2'], [6, '바꾼 뒤 입력']]);
});

test('다른 기기가 저장하지 못한 수정·추가는 바뀐 가계부에 넣지 않고 그 기기에 알린다', async () => {
  const { net, store } = flaky(storage);
  const B = await opened(store);
  net.up = false;
  await act(async () => {
    B.current.db.run('UPDATE transactions SET amount = ? WHERE id = ?', [99999, 1]);   // 옛 가계부의 1번
    addTransaction(B.current.db, tx('B의 새 입력'));
  });
  await waitSave();
  expect(B.current.pendingCount).toBe(2);

  const A = await opened();
  await act(async () => { await A.current.replaceWithFile(ledgerWith('다른 계정 1', '다른 계정 2')); });
  const replaced = storage.current();

  net.up = true;
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await waitSave();
  await flush();
  // 바뀐 가계부의 1번(다른 계정 1)은 B의 수정을 받지 않았고, B의 새 입력도 들어가지 않았다
  expect(rowsOf(storage.current())).toEqual(rowsOf(replaced));
  expect(rowsOf(storage.current())[0]).toEqual([1, '다른 계정 1', 1000]);
  expect(details(B.current.db)).toEqual(['다른 계정 1', '다른 계정 2']);
  expect(B.current.pendingCount).toBe(0);
  expect(pendingStored()).toBeNull();
  // 넣지 못한 B의 변경은 잃지 않는다 — 그 변경이 담긴 B의 가계부(옛 가계부 + B의 입력)가 백업 목록에 남는다
  await flush();
  expect(B.current.notice.text).toMatch(/넣지 못한 변경 2건이 담긴 이 기기의 가계부를 백업\(.+\)으로 남겼습니다/);
  const all = await Promise.all((await storage.listBackups()).map(b => storage.readBackup(b.id, () => true)));
  const kept = all.find(b => detailsOf(b).includes('B의 새 입력'));
  expect(kept).toBeDefined();
  expect(rowsOf(kept)[0]).toEqual([1, '옛 1', 99999]);

  // 그 뒤의 입력은 평소처럼 합쳐진다
  await act(async () => { addTransaction(B.current.db, tx('B 다시 입력')); });
  await waitSave();
  expect(detailsOf(storage.current())).toEqual(['다른 계정 1', '다른 계정 2', 'B 다시 입력']);
});

test('지난 세션에 보관한 옛 가계부의 변경도, 다시 열었을 때 가계부가 바뀌었으면 넣지 않는다', async () => {
  // 다른 기기(A)가 파일로 바꿨다
  const base = storage.current();
  const A = await opened();
  await act(async () => { await A.current.replaceWithFile(ledgerWith('다른 계정 1')); });
  mounted.shift()();

  // 이 기기에는 바꾸기 전 옛 가계부 위에서 만든 변경이 보관돼 있다(앱을 닫았던 사이)
  const old = createDatabase(SQL, base).db;
  attachChangeLog(old);
  addTransaction(old, tx('보관한 입력'));
  savePending('me', { entries: getChangeLog(old).entries, inFlight: [], base: 'old', generation: generationOfBytes(base) });
  old.close();

  const C = await opened();
  await flush();
  expect(details(C.current.db)).toEqual(['다른 계정 1']);
  // 이 기기에 그 바탕(사본)이 없어(테스트의 jsdom에는 IndexedDB가 없음) 백업으로는 남기지 못했다고 알린다
  expect(C.current.notice.text).toMatch(/저장하지 못한 변경 1건은 넣지 않았습니다 — 이 기기에 그 바탕 가계부가 없어 백업으로 남기지 못했습니다/);
  expect(pendingStored()).toBeNull();
  expect(detailsOf(storage.current())).toEqual(['다른 계정 1']);
});

test('지난 세션 보관분은 이 기기의 사본(그 바탕)에 다시 실행해 백업으로 남긴다', async () => {
  const { createMemoryOfflineCache } = await import('../../services/offlineCache');
  const base = storage.current();
  const baseVersion = await storage.getVersion();
  const cache = createMemoryOfflineCache();
  await cache.save('me', base, baseVersion);           // 이 기기가 마지막으로 맞춘 사본 = 보관분의 바탕
  const A = await opened();
  await act(async () => { await A.current.replaceWithFile(ledgerWith('다른 계정 1')); });
  mounted.shift()();

  const old = createDatabase(SQL, base).db;
  attachChangeLog(old);
  addTransaction(old, tx('보관한 입력'));
  savePending('me', { entries: getChangeLog(old).entries, inFlight: [], base: baseVersion, generation: generationOfBytes(base) });
  old.close();

  const ref = { current: null };
  function Harness() { ref.current = useLedgerSync({ storage, offlineCache: cache }); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Harness />); });
  mounted.push(() => act(() => root.unmount()));
  await act(async () => { await ref.current.loadDb(); });
  await flush();
  await flush();
  expect(details(ref.current.db)).toEqual(['다른 계정 1']);
  expect(ref.current.notice.text).toMatch(/넣지 못한 변경 1건이 담긴 이 기기의 가계부를 백업\(.+\)으로 남겼습니다/);
  const all = await Promise.all((await storage.listBackups()).map(b => storage.readBackup(b.id, () => true)));
  expect(all.some(b => detailsOf(b).join() === '옛 1,옛 2,옛 3,옛 4,옛 5,보관한 입력')).toBe(true);
});

test('세대가 같은(바꾸지 않은) 가계부의 보관분은 예전처럼 되살려 저장한다 — 세대 표시가 없는 옛 보관분도', async () => {
  const base = storage.current();
  const old = createDatabase(SQL, base).db;
  attachChangeLog(old);
  addTransaction(old, tx('보관한 입력'));
  savePending('me', { entries: getChangeLog(old).entries, inFlight: [], base: 'old' });   // 옛 앱이 남긴 모양(generation 없음)
  old.close();
  const C = await opened();
  await waitSave();
  expect(detailsOf(storage.current())).toEqual(['옛 1', '옛 2', '옛 3', '옛 4', '옛 5', '보관한 입력']);
  expect(C.current.notice.text).toMatch(/되살려 저장합니다/);
});

test('백업으로 되돌리기는 세대를 바꾸지 않는다 — 다른 기기의 밀린 입력은 되돌린 가계부에 이어서 저장된다', async () => {
  const { net, store } = flaky(storage);
  const B = await opened(store);
  net.up = false;
  await act(async () => { addTransaction(B.current.db, tx('B의 새 입력')); });
  await waitSave();

  const A = await opened();
  await storage.createBackup('ledger-2020-01-01.db', ledgerWith('백업 시점'));
  const found = (await storage.listBackups()).find(b => b.name === 'ledger-2020-01-01.db');
  await act(async () => { await A.current.restoreBackup({ id: found.id, date: '2020-01-01' }); });
  expect(generationOfBytes(storage.current())).toBe(0);

  net.up = true;
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await waitSave();
  await flush();
  expect(detailsOf(storage.current())).toEqual(['백업 시점', 'B의 새 입력']);
});

describe('올린 파일 살피기', () => {
  test('이 앱의 가계부면 무엇이 들었는지 센다 — 옛 버전 파일은 옮겨 연 뒤', async () => {
    const { db } = createDatabase(SQL, null);
    addTransaction(db, { ...tx('a'), date: '2024-01-05' });
    addTransaction(db, { ...tx('b'), date: '2025-03-01' });
    db.run('PRAGMA user_version = 3');
    const s = await inspectLedgerFile(db.export());
    db.close();
    expect(s).toMatchObject({ transactions: 2, from: '2024-01-05', to: '2025-03-01', recurring: 0 });
  });

  test('가계부 파일이 아니면·다른 앱의 SQLite면·더 새 버전이면 이유를 알린다', async () => {
    await expect(inspectLedgerFile(new TextEncoder().encode('hello, this is not a database at all'.repeat(10)))).rejects.toThrow('가계부 파일(.db)이 아니거나 손상된 파일입니다');
    const foreign = new SQL.Database();
    foreign.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    await expect(inspectLedgerFile(foreign.export())).rejects.toThrow('이 앱의 가계부 파일이 아닙니다');
    foreign.close();
    const { db } = createDatabase(SQL, null);
    db.run('PRAGMA user_version = 999');
    await expect(inspectLedgerFile(db.export())).rejects.toThrow('더 새 버전의 앱에서 만든 파일입니다');
    db.close();
  });
});
