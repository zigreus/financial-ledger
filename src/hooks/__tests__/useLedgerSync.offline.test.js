/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 연결 없이 열기 (I-024, ROADMAP C-4) — 저장소는 메모리 가짜(연결을 끊을 수 있게 감쌈), 사본도 메모리 가짜, DB는 진짜 sql.js
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { createMemoryStorage } from '../../services/storage/memory';
import { OfflineError } from '../../services/storage/provider';
import { StalledError } from '../../services/storage/stall';
import { getErrorLog } from '../../services/errorLog';
import { createMemoryOfflineCache } from '../../services/offlineCache';
import { createDatabase, addTransaction, addRecurringTransaction } from '../../services/dbManager';
import { savePending, stampWriteId } from '../../services/changeLog';
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
const detailsOf = (bytes) => details(new SQL.Database(bytes));

let storage;
let net;
let cache;
/** 메모리 저장소를 감싸 연결을 끊을 수 있게 한다 — 끊기면 OfflineError (OneDrive 구현과 같은 약속) */
function offlineAware(store) {
  const guard = fn => async (...args) => { if (!net.up) throw new OfflineError(); return fn(...args); };
  return { ...store, read: guard(store.read), getVersion: guard(store.getVersion), write: guard(store.write), createBackup: guard(store.createBackup), listBackups: guard(store.listBackups) };
}

async function mount(opts = {}) {
  const ref = { current: null };
  function Harness() { ref.current = useLedgerSync({ storage, offlineCache: cache, ...opts }); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Harness />); });
  return { ref, unmount: () => act(() => root.unmount()) };
}
async function opened(opts) {
  const m = await mount(opts);
  await act(async () => { await m.ref.current.loadDb(); });
  await flush();
  return m;
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const waitSave = () => act(async () => { await new Promise(r => setTimeout(r, 450)); });
/** 다른 기기가 지금 저장소 파일에 거래를 하나 더 적어 저장한다 */
function otherDevice(detail) {
  const { db } = createDatabase(SQL, base.current());
  addTransaction(db, tx(detail));
  stampWriteId(db);
  base.replace(db.export());
}
const goOnline = async () => {
  net.up = true;
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await waitSave();
  await flush();
};

let base;
beforeEach(() => {
  window.localStorage.clear();
  net = { up: true };
  cache = createMemoryOfflineCache();
  base = createMemoryStorage({ accountKey: 'me', bytes: ledgerWith('지금') });
  storage = offlineAware(base);
});

test('연결된 채 열면 사본을 남기고, 다음에 연결 없이 열면 그 사본으로 연다 — 입력은 오류 없이 보관했다가 연결되면 저장한다', async () => {
  const A = await opened();
  await flush();
  expect(cache.peek('me').version).toBe(await base.getVersion());
  A.unmount();

  net.up = false;
  const B = await opened();
  expect(B.ref.current.offline).toBe(true);
  expect(details(B.ref.current.db)).toEqual(['지금']);
  expect(B.ref.current.notice.text).toMatch(/연결이 없어 이 기기에 둔 가계부.*로 열었습니다/);
  expect(B.ref.current.error).toBe('');

  await act(async () => { addTransaction(B.ref.current.db, tx('오프라인 입력')); });
  await waitSave();
  expect(B.ref.current.error).toBe('');                 // 연결이 없을 뿐 — 오류 배너 대신 offline
  expect(B.ref.current.offline).toBe(true);
  expect(B.ref.current.pendingCount).toBe(1);

  await goOnline();
  expect(detailsOf(base.current())).toEqual(['지금', '오프라인 입력']);
  expect(B.ref.current.offline).toBe(false);
  expect(B.ref.current.pendingCount).toBe(0);
  expect(cache.peek('me').version).toBe(await base.getVersion()); // 저장한 것을 새 사본으로
  B.unmount();
});

test('저장한 순간마다 사본을 새로 남긴다 — 사본은 저장소 그대로의 내용(아직 안 올린 변경 없이)', async () => {
  const A = await opened();
  await act(async () => { addTransaction(A.ref.current.db, tx('첫 입력')); });
  await waitSave();
  await flush();
  expect(detailsOf(cache.peek('me').bytes)).toEqual(['지금', '첫 입력']);
  expect(cache.peek('me').version).toBe(await base.getVersion());

  net.up = false;
  await act(async () => { addTransaction(A.ref.current.db, tx('못 올린 입력')); });
  await waitSave();
  expect(detailsOf(cache.peek('me').bytes)).toEqual(['지금', '첫 입력']);
  A.unmount();
});

test('앱을 닫기 전 저장하지 못한 변경도 사본 위에 되살리고, 연결되면 저장한다', async () => {
  const A = await opened();
  net.up = false;
  await act(async () => { addTransaction(A.ref.current.db, tx('닫기 전 입력')); });
  await waitSave();
  A.unmount();                                          // 저장하지 못한 채 앱이 닫혔다

  const B = await opened();
  expect(details(B.ref.current.db)).toEqual(['지금', '닫기 전 입력']);
  expect(B.ref.current.pendingCount).toBe(1);
  await goOnline();
  expect(detailsOf(base.current())).toEqual(['지금', '닫기 전 입력']);
  expect(B.ref.current.pendingCount).toBe(0);
  B.unmount();
});

test('사본이 저장 못 한 변경의 바탕보다 오래됐으면(사본 쓰기 실패) 연결 없이 열지 않고, 연결되면 변경을 제자리에 넣는다', async () => {
  let allow = true;
  const flaky = { ...cache, save: async (...a) => { if (!allow) throw new Error('QuotaExceeded'); return cache.save(...a); } };
  const A = await opened({ offlineCache: flaky });
  await flush();
  allow = false;                                                 // 이제 사본 쓰기가 실패한다 (저장 공간 부족 등)
  await act(async () => { addTransaction(A.ref.current.db, tx('A')); });
  await waitSave();
  await flush();
  expect(detailsOf(base.current())).toEqual(['지금', 'A']);       // 저장소는 V2
  expect(detailsOf(cache.peek('me').bytes)).toEqual(['지금']);     // 사본은 V1에 머문다

  net.up = false;
  await act(async () => {
    addTransaction(A.ref.current.db, tx('B'));                                       // V2 위에서 id 3
    A.ref.current.db.run('UPDATE transactions SET detail = ? WHERE id = ?', ['A수정', 2]); // 저장된 A(id 2)를 고침
  });
  await flush();                                                 // 저장을 시도하기 전에 앱이 닫혔다
  A.unmount();

  const B = await opened({ offlineCache: flaky });
  expect(B.ref.current.db).toBeNull();                           // V1 위에서 다시 실행하면 B가 id 2를 받아 A수정이 B에 들어간다
  expect(B.ref.current.error).toMatch(/사본이 저장하지 못한 변경보다 오래되어 연결 없이는 열 수 없습니다/);

  allow = true;
  await goOnline();
  expect(detailsOf(base.current())).toEqual(['지금', 'A수정', 'B']);
  expect(details(B.ref.current.db)).toEqual(['지금', 'A수정', 'B']);
  B.unmount();
});

test('응답을 못 받은 업로드가 실제로 올라갔으면 — 연결 없이 다시 열었다가 연결되어도 같은 입력이 두 번 들어가지 않는다 (B-088)', async () => {
  const A = await opened();
  await flush();
  const realWrite = storage.write;
  storage.write = async (b, v) => {                               // 올라갔지만 응답을 잃었다
    const r = await realWrite(b, v);
    net.up = false;
    storage.write = realWrite;
    throw new OfflineError();
  };
  await act(async () => { addTransaction(A.ref.current.db, tx('X')); });
  await waitSave();
  expect(detailsOf(base.current())).toEqual(['지금', 'X']);
  A.unmount();

  const B = await opened();
  expect(details(B.ref.current.db)).toEqual(['지금', 'X']);
  await act(async () => { addTransaction(B.ref.current.db, tx('Y')); });
  await waitSave();
  await goOnline();
  await waitSave();
  await flush();
  expect(detailsOf(base.current())).toEqual(['지금', 'X', 'Y']);
  expect(details(B.ref.current.db)).toEqual(['지금', 'X', 'Y']);
  B.unmount();
});

test('불러오는 사이 로그아웃하면 늦게 끝난 불러오기가 가계부·사본을 되살리지 않는다 (B-004)', async () => {
  const A = await opened();
  await flush();
  otherDevice('다른 기기');
  let release;
  const gate = new Promise(r => { release = r; });
  const realRead = storage.read;
  storage.read = async (...a) => { await gate; return realRead(...a); };
  let loading;
  await act(async () => { loading = A.ref.current.loadDb({ silent: true }); });
  let cleared;
  await act(async () => { cleared = A.ref.current.resetForLogout(); });
  await act(async () => { await cleared; });
  expect(cache.peek('me')).toBeNull();
  release();
  await act(async () => { await loading; });
  await flush();
  expect(cache.peek('me')).toBeNull();
  expect(A.ref.current.db).toBeNull();
  A.unmount();
});

test("처음 열 때 저장소가 늦게 답하면 사본으로 먼저 열고('맞추는 중', 오프라인 아님) 받기가 끝나면 그 자리에서 최신으로 바꾼다 — 다시 받지 않는다", async () => {
  const A = await opened();
  A.unmount();
  otherDevice('다른 기기');                                       // 사본보다 저장소가 새것이다
  const realRead = storage.read;
  let release;
  const gate = new Promise(r => { release = r; });
  const reads = vi.fn(async () => { await gate; return realRead(); });
  storage.read = reads;
  const B = await mount({ firstLoadTimeoutMs: 30 });
  await act(async () => { await B.ref.current.loadDb(); });
  await flush();
  expect(details(B.ref.current.db)).toEqual(['지금']);             // 사본으로 먼저
  expect(B.ref.current.offline).toBe(false);
  expect(B.ref.current.catchingUp).toBe(true);
  expect(B.ref.current.notice).toBeNull();                        // 느릴 뿐 — 알림을 띄우지 않는다
  release();
  await flush();
  await flush();
  expect(details(B.ref.current.db)).toEqual(['지금', '다른 기기']); // 받은 것으로 바꿨다
  expect(B.ref.current.catchingUp).toBe(false);
  expect(B.ref.current.offline).toBe(false);
  expect(reads).toHaveBeenCalledTimes(1);                         // 받던 것을 그대로 썼다
  storage.read = realRead;
  B.unmount();
});

test('사본으로 먼저 연 사이 입력하면 받던 가계부가 올 때까지 저장을 미뤘다가 그 위에 이어 저장한다 — 같은 파일을 다시 받지 않는다', async () => {
  const A = await opened();
  A.unmount();
  otherDevice('다른 기기');                                        // 사본보다 저장소가 새것 — 사본 버전으로 저장했다면 충돌
  const realRead = storage.read;
  let release;
  const gate = new Promise(r => { release = r; });
  const reads = vi.fn(async () => { await gate; return realRead(); });
  storage.read = reads;
  const writes = vi.spyOn(storage, 'write');
  const B = await mount({ firstLoadTimeoutMs: 30 });
  await act(async () => { await B.ref.current.loadDb(); });
  await act(async () => { addTransaction(B.ref.current.db, tx('먼저 연 사이 입력')); });
  await waitSave();
  expect(writes).not.toHaveBeenCalled();                           // 받던 것이 올 때까지 미룬다
  expect(B.ref.current.pendingCount).toBe(1);
  release();
  await flush();
  await waitSave();
  await flush();
  expect(detailsOf(base.current())).toEqual(['지금', '다른 기기', '먼저 연 사이 입력']);
  expect(details(B.ref.current.db)).toEqual(['지금', '다른 기기', '먼저 연 사이 입력']);
  expect(B.ref.current.pendingCount).toBe(0);
  expect(B.ref.current.catchingUp).toBe(false);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(writes).toHaveBeenCalledTimes(1);                         // 충돌 없이 한 번에
  storage.read = realRead;
  B.unmount();
});

test('지난번에 저장하지 못한 변경이 있어도 사본으로 먼저 열고, 받던 가계부가 오면 그 위에 이어 저장한다', async () => {
  const A = await opened();
  net.up = false;
  await act(async () => { addTransaction(A.ref.current.db, tx('닫기 전 입력')); });
  await waitSave();
  A.unmount();
  net.up = true;
  otherDevice('다른 기기');
  const realRead = storage.read;
  let release;
  const gate = new Promise(r => { release = r; });
  storage.read = async () => { await gate; return realRead(); };
  const B = await mount({ firstLoadTimeoutMs: 30 });
  await act(async () => { await B.ref.current.loadDb(); });
  expect(details(B.ref.current.db)).toEqual(['지금', '닫기 전 입력']);
  expect(B.ref.current.catchingUp).toBe(true);
  release();
  await flush();
  await waitSave();
  await flush();
  // 지난번 저장은 결과를 모르는 업로드라(B-088) 받은 파일과 대조해 가려내느라 더 받을 수 있다 — 결과만 본다
  expect(detailsOf(base.current())).toEqual(['지금', '다른 기기', '닫기 전 입력']);
  expect(details(B.ref.current.db)).toEqual(['지금', '다른 기기', '닫기 전 입력']);
  expect(B.ref.current.pendingCount).toBe(0);
  expect(B.ref.current.catchingUp).toBe(false);
  storage.read = realRead;
  B.unmount();
});

test('저장을 시도하기 전에 닫힌 변경을 되살려 먼저 열었으면, 받던 가계부가 올 때 그 위에 한 번에 저장한다 — 한 번만 받는다', async () => {
  const A = await opened();
  await act(async () => { addTransaction(A.ref.current.db, tx('닫기 직전 입력')); });
  await flush();                                                   // 저장을 시도하기 전에 앱이 닫혔다
  A.unmount();
  otherDevice('다른 기기');                                        // 사본 버전으로 저장했다면 충돌
  const realRead = storage.read;
  let release;
  const gate = new Promise(r => { release = r; });
  const reads = vi.fn(async () => { await gate; return realRead(); });
  storage.read = reads;
  const writes = vi.spyOn(storage, 'write');
  const B = await mount({ firstLoadTimeoutMs: 30 });
  await act(async () => { await B.ref.current.loadDb(); });
  expect(details(B.ref.current.db)).toEqual(['지금', '닫기 직전 입력']);
  await waitSave();
  expect(writes).not.toHaveBeenCalled();
  release();
  await flush();
  await waitSave();
  await flush();
  expect(detailsOf(base.current())).toEqual(['지금', '다른 기기', '닫기 직전 입력']);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(B.ref.current.pendingCount).toBe(0);
  storage.read = realRead;
  B.unmount();
});

test('사본으로 먼저 연 뒤 받기가 멈춰 끊기면(StalledError) 오프라인으로 바꾸고 문제 알리기에 남기며, 다시 시도해 연결되면 푼다', async () => {
  const A = await opened();
  A.unmount();
  const realRead = storage.read;
  let fail;
  storage.read = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
  const B = await mount({ firstLoadTimeoutMs: 30, offlineRetryMs: 40 });
  await act(async () => { await B.ref.current.loadDb(); });
  expect(B.ref.current.catchingUp).toBe(true);
  fail(new StalledError('OneDrive 가계부 받기'));
  await flush();
  await flush();
  expect(B.ref.current.offline).toBe(true);
  expect(B.ref.current.catchingUp).toBe(false);
  expect(B.ref.current.error).toBe('');                            // 조용한 불러오기 — 오류 띠 없이 '오프라인'
  expect(getErrorLog()[0]).toMatchObject({ kind: '연결' });
  expect(getErrorLog()[0].message).toMatch(/OneDrive 가계부 받기.*멈춰/);
  storage.read = realRead;                                         // 연결이 돌아왔다 — 30초마다의 다시 시도가 막히지 않는다
  await act(async () => { await new Promise(r => setTimeout(r, 200)); });
  await flush();
  expect(B.ref.current.offline).toBe(false);
  B.unmount();
});

test('연결 문제로 받지 못하면 실제 원인(단계·서버·오류)을 문제 알리기에 남긴다 — 가장 최근 하나만 (B-095)', async () => {
  const A = await opened();
  const realRead = storage.read;
  const fail = (detail) => { const e = new OfflineError(); e.detail = detail; return e; };
  storage.read = async () => { throw fail('graph.microsoft.com — TypeError: Failed to fetch'); };
  storage.getVersion = storage.read;
  await act(async () => { await A.ref.current.loadDb(); });
  storage.read = async () => { throw fail('로그인 토큰 — post_request_failed'); };
  storage.getVersion = storage.read;
  await act(async () => { await A.ref.current.loadDb(); });
  const conn = getErrorLog().filter(e => e.kind === '연결');
  expect(conn).toHaveLength(1);
  expect(conn[0]).toMatchObject({ message: '가계부 받기에 실패했습니다 — 로그인 토큰 — post_request_failed', count: 2 });
  storage.read = realRead;
  A.unmount();
});

test('뒤에서 다시 시도하는 동안 syncing — 그때 🔄을 누르면 그 시도에 합류해 ⏳를 보이고, 실패하면 이유를 알린다 (B-095)', async () => {
  const A = await opened();
  A.unmount();
  net.up = false;
  const B = await opened();
  expect(B.ref.current.offline).toBe(true);
  expect(B.ref.current.syncing).toBe(false);
  let release;
  const gate = new Promise(r => { release = r; });
  const realRead = storage.read;
  storage.read = async () => { await gate; throw new OfflineError(); };
  let quiet;
  await act(async () => { quiet = B.ref.current.loadDb({ silent: true }); });   // 30초마다의 조용한 다시 시도
  expect(B.ref.current.syncing).toBe(true);
  expect(B.ref.current.loading).toBe(false);
  let pressed;
  await act(async () => { pressed = B.ref.current.loadDb(); });                  // 🔄
  expect(pressed).toBe(quiet);                                                 // 겹쳐 받지 않고 합류
  expect(B.ref.current.loading).toBe(true);                                    // 눌린 것이 보인다
  release();
  await act(async () => { await pressed; });
  await flush();
  expect(B.ref.current.loading).toBe(false);
  expect(B.ref.current.syncing).toBe(false);
  expect(B.ref.current.error).toMatch(/연결이 없어 새로 받지 못했습니다/);       // 조용히 끝나지 않는다
  storage.read = realRead;
  B.unmount();
});

test('저장 안 된 입력이 있을 때 🔄이 먼저 저장하다 연결 문제로 실패하면 조용히 끝나지 않고 이유를 알린다 (B-095)', async () => {
  const A = await opened();
  net.up = false;
  await act(async () => { addTransaction(A.ref.current.db, tx('못 올린 입력')); });
  await waitSave();
  expect(A.ref.current.offline).toBe(true);
  await act(async () => { await A.ref.current.loadDb(); });
  expect(A.ref.current.loading).toBe(false);
  expect(A.ref.current.error).toMatch(/연결이 없어 새로 받지 못했습니다/);
  A.unmount();
});

test('가계부 받기가 오래 걸리면 단계별 시간을 문제 알리기에 남긴다', async () => {
  const realRead = storage.read;
  let now = 1000;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  storage.read = async () => { now += 7000; return { ...(await realRead()), timing: { stages: [['로그인 토큰', 6000], ['파일 정보', 500], ['내용 받기', 500]], size: 2048 } }; };
  const B = await opened();
  spy.mockRestore();
  expect(getErrorLog()[0]).toMatchObject({ kind: '느린 연결' });
  expect(getErrorLog()[0].message).toBe('가계부 받기가 느렸습니다 — 모두 7.0초 (로그인 토큰 6.0초 · 파일 정보 0.5초 · 내용 받기 0.5초, 2KB)');
  storage.read = realRead;
  B.unmount();
});

test('사본이 없으면(다시 로그인·새 기기) 느려도 오류 없이 기다려 연다 — 다시 시도해도 받기를 겹쳐 시작하지 않는다', async () => {
  const realRead = storage.read;
  let release;
  const gate = new Promise(r => { release = r; });
  const reads = vi.fn(async () => { await gate; return realRead(); });
  storage.read = reads;
  const B = await mount({ firstLoadTimeoutMs: 30, offlineRetryMs: 40 });
  let first;
  await act(async () => { first = B.ref.current.loadDb(); });
  await act(async () => { await new Promise(r => setTimeout(r, 120)); });   // 제한 시간이 지났다 — 사본이 없으니 계속 기다린다
  expect(B.ref.current.db).toBeNull();
  expect(B.ref.current.error).toBe('');
  await act(async () => { B.ref.current.loadDb(); });                       // 사용자가 다시 시도해도
  expect(reads).toHaveBeenCalledTimes(1);                                    // 새로 받지 않는다
  release();
  await act(async () => { await first; });
  await flush();
  expect(details(B.ref.current.db)).toEqual(['지금']);
  expect(B.ref.current.offline).toBe(false);
  expect(reads).toHaveBeenCalledTimes(1);
  storage.read = realRead;
  B.unmount();
});

test("연결이 없는 동안에는 가끔 다시 확인한다 — 'online' 이벤트가 오지 않아도 연결되면 저장하고 오프라인을 푼다", async () => {
  const A = await opened();
  A.unmount();
  net.up = false;
  const B = await opened({ offlineRetryMs: 40 });
  await act(async () => { addTransaction(B.ref.current.db, tx('오프라인 입력')); });
  await waitSave();
  expect(B.ref.current.offline).toBe(true);
  net.up = true;                                                 // 이벤트 없이 연결됐다
  await act(async () => { await new Promise(r => setTimeout(r, 200)); });
  await flush();
  expect(B.ref.current.offline).toBe(false);
  expect(detailsOf(base.current())).toEqual(['지금', '오프라인 입력']);
  B.unmount();
});

test('사본으로 연 동안에는 자동등록을 하지 않고, 연결되면 — 저장소가 그대로여도 — 한 번 새로 받아 자동등록한다', async () => {
  const { db } = createDatabase(SQL, base.current());
  addRecurringTransaction(db, { payment_method: '카드', budget_category: '식비', detail: '정기 구독', amount: 9900, day_of_month: 1 });
  const v = base.replace(db.export());                           // 자동등록 전의 파일 (사본과 같다)
  await cache.save('me', base.current(), v);
  net.up = false;
  const B = await opened();
  expect(details(B.ref.current.db)).toEqual(['지금']);
  await goOnline();
  expect(details(B.ref.current.db)).toContain('정기 구독');
  expect(detailsOf(base.current())).toContain('정기 구독');
  B.unmount();
});

test('결과를 모르는 업로드가 있는데 사본이 그 바탕이 아니면 연결 없이 열지 않는다 (같은 입력이 두 번 들어가지 않게)', async () => {
  const A = await opened();
  A.unmount();
  savePending('me', {
    entries: [{
      method: 'run',
      sql: 'INSERT INTO transactions (payment_method, date, budget_category, detail, amount) VALUES (?, ?, ?, ?, ?)',
      params: ['카드', '2026-11-01', '식비', '결과 모름', 1],
      insertTable: 'transactions',
      insertId: 2,
    }],
    inFlight: [{ writeId: 'w-unknown', n: 1 }],
    base: 'v-somewhere-else',
  });
  net.up = false;
  const B = await opened();
  expect(B.ref.current.db).toBeNull();
  expect(B.ref.current.error).toMatch(/사본이 저장하지 못한 변경보다 오래되어 연결 없이는 열 수 없습니다/);
  B.unmount();
});

test('사본이 없으면 연결 없이는 열 수 없다고 알리고, 연결되면 연다', async () => {
  net.up = false;
  const B = await opened();
  expect(B.ref.current.db).toBeNull();
  expect(B.ref.current.error).toMatch(/연결된 상태로 한 번 열고 나면/);
  await goOnline();
  expect(details(B.ref.current.db)).toEqual(['지금']);
  expect(B.ref.current.error).toBe('');
  expect(B.ref.current.offline).toBe(false);
  B.unmount();
});

test('사본으로 연 세션은 연결되면 저장소에서 한 번 새로 받는다(자동등록·매일 백업) — 바뀐 것이 없어도', async () => {
  const A = await opened();
  A.unmount();
  window.localStorage.removeItem('ledger_last_backup:me');
  net.up = false;
  const B = await opened();
  const reads = vi.spyOn(storage, 'read');
  await goOnline();
  expect(reads).toHaveBeenCalledTimes(1);
  expect(await base.listBackups()).toHaveLength(1);    // 그날 백업
  // 그다음 앱 복귀는 평소처럼 버전만 확인한다
  await act(async () => { await B.ref.current.loadDb({ silent: true }); });
  expect(reads).toHaveBeenCalledTimes(1);
  B.unmount();
});

test('연결된 채 연 뒤 연결이 끊기면, 새로고침은 이유를 보이고 앱 복귀(조용한 불러오기)는 오류를 띄우지 않는다', async () => {
  const A = await opened();
  net.up = false;
  await act(async () => { await A.ref.current.loadDb({ silent: true }); });
  expect(A.ref.current.error).toBe('');
  expect(A.ref.current.offline).toBe(true);
  await act(async () => { await A.ref.current.loadDb(); });
  expect(A.ref.current.error).toMatch(/연결이 없어 새로 받지 못했습니다/);
  expect(details(A.ref.current.db)).toEqual(['지금']);  // 화면의 가계부는 그대로
  await goOnline();
  expect(A.ref.current.offline).toBe(false);
  A.unmount();
});

test('로그아웃하면 이 기기의 사본을 지운다 (B-004)', async () => {
  const A = await opened();
  await flush();
  expect(cache.peek('me')).not.toBeNull();
  await act(async () => { A.ref.current.resetForLogout(); });
  await flush();
  expect(cache.peek('me')).toBeNull();
  A.unmount();
});
