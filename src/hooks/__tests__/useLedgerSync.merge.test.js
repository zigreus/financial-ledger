/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 자동 저장·충돌 병합 시나리오 (B-001·B-002·B-003, F-2) — 저장소는 버전 규칙을 지키는 메모리 가짜, DB는 진짜 sql.js
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { createMemoryStorage } from '../../services/storage/memory';
import { ConflictError, ReauthRedirectError } from '../../services/storage/provider';
import { createDatabase, addTransaction, SCHEMA_VERSION } from '../../services/dbManager';
import { attachChangeLog, getChangeLog, stampWriteId, savePending } from '../../services/changeLog';
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
const rowsOf = (db) => db.exec('SELECT id, detail, amount FROM transactions ORDER BY id')[0]?.values || [];
const details = (db) => rowsOf(db).map(r => r[1]);
const detailsOf = (bytes) => details(new SQL.Database(bytes));
const pendingStored = (key = 'me') => JSON.parse(window.localStorage.getItem(`ledger_pending_changes:${key}`) || 'null');

let storage;
/** 다른 기기가 지금 저장소 파일에 거래를 하나 더 적어 저장한다 */
function otherDeviceAdds(detail) {
  const { db } = createDatabase(SQL, storage.current());
  addTransaction(db, tx(detail));
  stampWriteId(db);
  storage.replace(db.export());
}

async function mount(store = storage) {
  const ref = { current: null };
  function Harness() { ref.current = useLedgerSync({ storage: store }); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Harness />); });
  return { ref, unmount: () => act(() => root.unmount()) };
}
async function opened(store = storage) {
  const m = await mount(store);
  await act(async () => { await m.ref.current.loadDb(); });
  await flush();
  return m;
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const waitSave = () => act(async () => { await new Promise(r => setTimeout(r, 450)); });

beforeEach(() => {
  window.localStorage.clear();
  storage = createMemoryStorage({ accountKey: 'me', bytes: ledgerWith('지금') });
});

test('다른 기기가 먼저 저장했으면 최신 파일에 내 변경을 다시 실행해 둘 다 남긴다 — 새 행 id가 바뀌어도 내 수정은 내 행에', async () => {
  const { ref, unmount } = await opened();
  otherDeviceAdds('다른 기기'); // id 2를 먼저 차지한다

  let mine;
  await act(async () => {
    mine = addTransaction(ref.current.db, tx('내 입력', 1000)); // 이 기기에서도 id 2
    ref.current.db.run('UPDATE transactions SET amount = ? WHERE id = ?', [7777, mine]);
  });
  expect(mine).toBe(2);
  await waitSave();

  expect(rowsOf(new SQL.Database(storage.current()))).toEqual([
    [1, '지금', 1000], [2, '다른 기기', 1000], [3, '내 입력', 7777],
  ]);
  expect(rowsOf(ref.current.db)).toEqual(rowsOf(new SQL.Database(storage.current())));
  expect(ref.current.pendingCount).toBe(0);
  expect(ref.current.notice.text).toMatch(/다른 기기에서 바뀐 내용을 받아 합쳤습니다/);
  expect(pendingStored()).toBeNull();
  unmount();
});

test('두 기기가 같은 파일에 거의 동시에 입력해도 둘 다 남고, 다시 받으면 양쪽 화면이 같다', async () => {
  const deviceB = { ...storage, accountKey: 'B' }; // 같은 파일을 쓰는 다른 기기
  const A = await opened();
  const B = await opened(deviceB);

  await act(async () => {
    addTransaction(A.ref.current.db, tx('A 입력'));
    addTransaction(B.ref.current.db, tx('B 입력'));
  });
  await waitSave();
  await flush();

  expect(detailsOf(storage.current())).toEqual(['지금', 'A 입력', 'B 입력']);
  await act(async () => { await A.ref.current.loadDb({ silent: true }); });
  expect(details(A.ref.current.db)).toEqual(['지금', 'A 입력', 'B 입력']);
  expect(details(B.ref.current.db)).toEqual(['지금', 'A 입력', 'B 입력']);
  expect(A.ref.current.pendingCount + B.ref.current.pendingCount).toBe(0);
  A.unmount();
  B.unmount();
});

test('올리는 동안 생긴 입력은 버리지 않고 이어서 한 번 더 올린다', async () => {
  const { ref, unmount } = await opened();
  const realWrite = storage.write;
  let release;
  const gate = new Promise(r => { release = r; });
  const write = vi.fn(async (...args) => { if (write.mock.calls.length === 1) await gate; return realWrite(...args); });
  storage.write = write;

  await act(async () => { addTransaction(ref.current.db, tx('첫 입력')); });
  await waitSave(); // 첫 업로드가 응답을 기다리는 중
  expect(write).toHaveBeenCalledTimes(1);
  await act(async () => { addTransaction(ref.current.db, tx('올리는 중 입력')); });
  await waitSave(); // 진행 중인 저장에 합류할 뿐 새로 올리지 않는다
  expect(write).toHaveBeenCalledTimes(1);

  await act(async () => { release(); });
  await flush();
  expect(write).toHaveBeenCalledTimes(2);
  expect(detailsOf(storage.current())).toEqual(['지금', '첫 입력', '올리는 중 입력']);
  expect(ref.current.pendingCount).toBe(0);
  unmount();
});

test('저장한 뒤 다시 확인할 때는 버전만 보고, 이미 최신이면 파일을 다시 받지 않는다', async () => {
  const { ref, unmount } = await opened();
  await act(async () => { addTransaction(ref.current.db, tx('내 입력')); });
  await waitSave();

  const read = vi.spyOn(storage, 'read');
  const getVersion = vi.spyOn(storage, 'getVersion');
  await act(async () => { await ref.current.loadDb({ silent: true }); });
  expect(getVersion).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
  unmount();
});

describe('지난 세션에서 저장하지 못한 변경 (재로그인·탭 종료)', () => {
  /** 지난 세션: 지금 파일에서 거래를 하나 입력하고 올리기 시작했다 — 표식과 기록을 기기에 남겼다 */
  function lastSession(detail) {
    const { db } = createDatabase(SQL, storage.current());
    attachChangeLog(db);
    addTransaction(db, tx(detail));
    const writeId = stampWriteId(db);
    const entries = getChangeLog(db).entries;
    savePending('me', { entries, inFlight: { writeId, n: entries.length } });
    return db.export();
  }

  test('응답을 못 받았지만 실제로 올라갔으면, 다시 열 때 그 변경을 또 넣지 않는다', async () => {
    storage.replace(lastSession('지난번 입력')); // 업로드는 저장소에 닿았다
    const { ref, unmount } = await opened();
    expect(details(ref.current.db)).toEqual(['지금', '지난번 입력']);
    expect(ref.current.pendingCount).toBe(0);
    expect(pendingStored()).toBeNull();
    unmount();
  });

  test('올라가지 않았으면 다시 열 때 되살려 저장하고 알린다', async () => {
    lastSession('지난번 입력'); // 업로드가 닿지 못했다
    const { ref, unmount } = await opened();
    await waitSave();
    expect(ref.current.notice.text).toMatch(/저장되지 않았던 변경 1건을 되살려 저장합니다/);
    expect(detailsOf(storage.current())).toEqual(['지금', '지난번 입력']);
    expect(pendingStored()).toBeNull();
    unmount();
  });
});

test('합치려고 받았는데 파일이 사라졌으면 빈 파일에 변경만 넣지 않고 내 가계부 전체를 새로 만든다', async () => {
  const { ref, unmount } = await opened();
  storage.remove();
  await act(async () => { addTransaction(ref.current.db, tx('내 입력')); });
  await waitSave();
  await flush();
  expect(detailsOf(storage.current())).toEqual(['지금', '내 입력']);
  expect(ref.current.pendingCount).toBe(0);
  unmount();
});

test('열 때 DB 업데이트를 저장하다 다른 기기와 겹치면 최신 파일을 다시 받아 연다', async () => {
  const { db: old } = createDatabase(SQL, storage.current());
  old.run('PRAGMA user_version = 0'); // 예전 버전 앱이 저장한 파일 — 열면 업데이트해 한 번 저장한다
  storage = createMemoryStorage({ accountKey: 'me', bytes: old.export() });
  const realWrite = storage.write;
  storage.write = vi.fn(async (bytes, version) => {
    if (storage.write.mock.calls.length === 1) otherDeviceAdds('다른 기기'); // 올리기 직전에 다른 기기가 저장
    return realWrite(bytes, version);
  });

  const { ref, unmount } = await opened();
  expect(details(ref.current.db)).toEqual(['지금', '다른 기기']);
  expect(ref.current.error).not.toMatch(/불러오기 실패|DB 업데이트 일부 실패/); // 공휴일 데이터 경고는 날짜에 따라 붙을 수 있다
  const remote = new SQL.Database(storage.current());
  expect(remote.exec('PRAGMA user_version')[0].values[0][0]).toBe(SCHEMA_VERSION);
  unmount();
});

/** 디바운스를 기다리지 않고 지금 저장한다 — 실패 뒤 자동 재시도(B-089)에 기대지 않게 결과를 바로 본다 */
async function saveNowResult(ref) {
  let ok;
  await act(async () => { ok = await ref.current.saveNow(); });
  return ok;
}

test('저장소에 닿지 못하면 변경을 기기에 보관하고 알리며, 다시 온라인이 되면 바로 저장한다', async () => {
  const { ref, unmount } = await opened();
  const realWrite = storage.write;
  storage.write = async () => { throw new Error('네트워크 오류 — 인터넷 연결을 확인하세요'); };

  await act(async () => { addTransaction(ref.current.db, tx('오프라인 입력')); });
  expect(await saveNowResult(ref)).toBe(false);
  expect(ref.current.error).toMatch(/^저장 실패: 네트워크 오류.*이 기기에 보관/);
  expect(ref.current.pendingCount).toBe(1);
  expect(pendingStored().entries).toHaveLength(1);
  expect(detailsOf(storage.current())).toEqual(['지금']);

  // 연결이 돌아와도 online 이벤트 전에는 (다음 자동 재시도까지) 올리지 않는다
  storage.write = realWrite;
  await flush();
  expect(detailsOf(storage.current())).toEqual(['지금']);
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await flush();
  expect(detailsOf(storage.current())).toEqual(['지금', '오프라인 입력']);
  expect(ref.current.error).toBe('');
  expect(pendingStored()).toBeNull();
  unmount();
});

test('다시 로그인해야 하면 그 안내를 보여 주고 변경은 보관했다가, 돌아온 뒤 저장한다', async () => {
  const { ref, unmount } = await opened();
  const realWrite = storage.write;
  storage.write = async () => { throw new ReauthRedirectError(); };
  await act(async () => { addTransaction(ref.current.db, tx('입력')); });
  expect(await saveNowResult(ref)).toBe(false);
  expect(ref.current.error).toBe(new ReauthRedirectError().message);
  expect(pendingStored().entries).toHaveLength(1);

  storage.write = realWrite;
  expect(await saveNowResult(ref)).toBe(true);
  expect(detailsOf(storage.current())).toEqual(['지금', '입력']);
  expect(pendingStored()).toBeNull();
  unmount();
});

test('저장이 계속 거절되면 다섯 번 합쳐 본 뒤 그 저장을 그만두고 알린다 — 변경은 남는다', async () => {
  const { ref, unmount } = await opened();
  const realWrite = storage.write;
  const write = vi.fn(async () => { throw new ConflictError(); });
  storage.write = write;
  await act(async () => { addTransaction(ref.current.db, tx('입력')); });
  expect(await saveNowResult(ref)).toBe(false);
  expect(write).toHaveBeenCalledTimes(5);
  expect(ref.current.error).toMatch(/다른 기기와 저장이 계속 겹칩니다/);
  expect(details(ref.current.db)).toEqual(['지금', '입력']); // 합칠 때마다 다시 실행해도 한 건
  expect(ref.current.pendingCount).toBe(1);

  storage.write = realWrite;
  expect(await saveNowResult(ref)).toBe(true);
  expect(detailsOf(storage.current())).toEqual(['지금', '입력']);
  unmount();
});

test('저장소가 없으면(로그인 전·로그아웃 뒤) 분명한 오류로 실패한다', async () => {
  const { ref, unmount } = await mount(null);
  await act(async () => { await ref.current.loadDb(); });
  expect(ref.current.error).toBe('불러오기 실패: 로그인 정보가 없습니다 — 다시 로그인하세요');
  await expect(ref.current.listBackups()).rejects.toThrow('로그인 정보가 없습니다');
  unmount();
});
