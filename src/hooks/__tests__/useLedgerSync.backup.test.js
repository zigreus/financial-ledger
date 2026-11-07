/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 매일 백업·되돌리기 흐름 (I-014) — OneDrive는 eTag를 지키는 메모리 가짜, DB는 진짜 sql.js
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as OD from '../../services/oneDriveService';
import * as BK from '../../services/oneDriveBackup';
import { createDatabase, addTransaction } from '../../services/dbManager';
import { attachChangeLog, getChangeLog, replayChanges, stampWriteId } from '../../services/changeLog';
import { todayStr } from '../../services/dateUtils';
import useLedgerSync from '../useLedgerSync';

vi.mock('../../services/oneDriveService', () => {
  class ConflictError extends Error {}
  class ReauthRedirectError extends Error {}
  return {
    ConflictError, ReauthRedirectError, GRAPH_BASE: 'https://graph.test',
    getToken: vi.fn(), graphFetch: vi.fn(),
    readDbFromOneDrive: vi.fn(), writeDbToOneDrive: vi.fn(), getRemoteETag: vi.fn(),
  };
});
vi.mock('../../services/oneDriveBackup', async (importOriginal) => ({
  ...(await importOriginal()),
  listBackups: vi.fn(), uploadBackup: vi.fn(), uploadNewBackup: vi.fn(), downloadBackup: vi.fn(), pruneBackups: vi.fn(),
}));
vi.mock('../../services/dbManager', async (importOriginal) => {
  const actual = await importOriginal();
  const initSqlJs = (await import('sql.js/dist/sql-asm.js')).default;
  let SQL = null;
  return { ...actual, initSQL: async () => (SQL ||= await initSqlJs()) };
});

global.IS_REACT_ACT_ENVIRONMENT = true;
const instance = {};
const accounts = [{ homeAccountId: 'me' }];
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

/** eTag 조건부 저장을 흉내 내는 OneDrive 파일 하나 */
const remote = { bytes: null, n: 1, get eTag() { return `e${this.n}`; } };
function remoteSave(bytes) { remote.bytes = bytes; remote.n += 1; }
/** 다른 기기가 지금 OneDrive 파일에 거래를 하나 더 적어 저장한다 */
function otherDeviceAdds(detail) {
  const { db } = createDatabase(SQL, remote.bytes);
  addTransaction(db, tx(detail));
  stampWriteId(db); // 실제 저장처럼 자기 동기화 표식을 남긴다
  remoteSave(db.export());
}

async function mount() {
  const ref = { current: null };
  function Harness() { ref.current = useLedgerSync({ instance, accounts }); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Harness />); });
  return { ref, unmount: () => act(() => root.unmount()) };
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const waitSave = () => act(async () => { await new Promise(r => setTimeout(r, 450)); });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  remote.bytes = ledgerWith('지금');
  remote.n = 1;
  OD.readDbFromOneDrive.mockImplementation(async () => ({ data: remote.bytes, eTag: remote.eTag }));
  OD.getRemoteETag.mockImplementation(async () => remote.eTag);
  OD.writeDbToOneDrive.mockImplementation(async (i, a, bytes, eTag) => {
    if (eTag !== remote.eTag) throw new OD.ConflictError();
    remoteSave(bytes);
    return remote.eTag;
  });
  BK.uploadBackup.mockResolvedValue(true);
  BK.uploadNewBackup.mockImplementation(async () => `ledger-2026-11-08-1200${BK.uploadNewBackup.mock.calls.length}.db`);
  BK.pruneBackups.mockResolvedValue(0);
  BK.downloadBackup.mockResolvedValue(ledgerWith('백업 시점'));
});

async function opened() {
  const m = await mount();
  await act(async () => { await m.ref.current.loadDb(); });
  await flush();
  return m;
}

test('그날 처음 받으면 받은 파일 그대로 매일 백업을 만들고, 같은 날 다시 열면 만들지 않는다', async () => {
  const first = await opened();
  expect(BK.uploadBackup).toHaveBeenCalledTimes(1);
  const [, , name, bytes] = BK.uploadBackup.mock.calls[0];
  expect(name).toBe(`ledger-${todayStr()}.db`);
  expect(detailsOf(bytes)).toEqual(['지금']);
  expect(BK.pruneBackups).toHaveBeenCalledTimes(1);
  expect(window.localStorage.getItem('ledger_last_backup:me')).toBe(todayStr());
  first.unmount();

  const again = await opened();
  expect(BK.uploadBackup).toHaveBeenCalledTimes(1);
  again.unmount();
});

test('매일 백업이 실패해도 앱은 열리고, 다음에 받을 때 다시 시도한다', async () => {
  BK.uploadBackup.mockRejectedValueOnce(new Error('네트워크 오류'));
  const m = await opened();
  expect(details(m.ref.current.db)).toEqual(['지금']);
  expect(window.localStorage.getItem('ledger_last_backup:me')).toBeNull();

  otherDeviceAdds('다른 기기'); // 파일이 바뀌어 다시 받게 한다
  await act(async () => { await m.ref.current.loadDb({ silent: true }); });
  await flush();
  expect(BK.uploadBackup).toHaveBeenCalledTimes(2);
  expect(window.localStorage.getItem('ledger_last_backup:me')).toBe(todayStr());
  m.unmount();
});

test('되돌리기: 미저장 변경 저장 → 지금 OneDrive 파일 백업 → 백업 파일을 올리고 화면 DB 교체', async () => {
  const { ref, unmount } = await opened();
  await act(async () => { addTransaction(ref.current.db, tx('미저장', 500)); });

  await act(async () => { await ref.current.restoreBackup({ id: 'b1', date: '2026-11-01' }); });

  // 되돌리기 전 백업에는 방금 저장한 변경까지 들어 있다
  expect(BK.uploadNewBackup).toHaveBeenCalledTimes(1);
  expect(detailsOf(BK.uploadNewBackup.mock.calls[0][2])).toEqual(['지금', '미저장']);
  expect(detailsOf(remote.bytes)).toEqual(['백업 시점']);
  expect(details(ref.current.db)).toEqual(['백업 시점']);
  expect(ref.current.pendingCount).toBe(0);
  expect(window.localStorage.getItem('ledger_pending_changes:me')).toBeNull();
  unmount();
});

test('되돌린 뒤 새 행은 되돌리기 전에 쓰던 id를 다시 받지 않는다 — 다른 기기의 밀린 수정이 엉뚱한 행을 고치지 않는다', async () => {
  remote.bytes = ledgerWith('지금', '백업 뒤'); // id 1, 2
  const { ref, unmount } = await opened();

  // 다른 기기 B: 되돌리기 전 화면에서 id 2를 고쳤지만 아직 저장하지 못함
  const B = createDatabase(SQL, remote.bytes).db;
  attachChangeLog(B);
  B.run('UPDATE transactions SET detail = ?, amount = ? WHERE id = ?', ['B 수정', 9999, 2]);

  await act(async () => { await ref.current.restoreBackup({ id: 'b1', date: '2026-11-01' }); });
  await act(async () => { addTransaction(ref.current.db, tx('되돌린 뒤 새 거래')); });
  await waitSave();

  const ids = ref.current.db.exec('SELECT id, detail FROM transactions ORDER BY id')[0].values;
  expect(ids).toEqual([[1, '백업 시점'], [3, '되돌린 뒤 새 거래']]);

  // B가 412를 받고 최신 파일에 기록을 다시 실행해도 새 거래는 그대로다
  const merged = createDatabase(SQL, remote.bytes).db;
  replayChanges(merged, getChangeLog(B).entries);
  expect(details(merged)).toEqual(['백업 시점', '되돌린 뒤 새 거래']);
  unmount();
});

test('되돌리는 동안 이 기기에서 입력한 것은 버리지 않고 되돌린 가계부에 이어서 저장한다', async () => {
  const { ref, unmount } = await opened();
  let release;
  BK.downloadBackup.mockImplementation(() => new Promise(r => { release = () => r(ledgerWith('백업 시점')); }));

  let restoring;
  await act(async () => { restoring = ref.current.restoreBackup({ id: 'b1', date: '2026-11-01' }); });
  await act(async () => { addTransaction(ref.current.db, tx('되돌리는 중 입력')); });
  await waitSave(); // 자동 저장이 돌았어도 되돌리는 중에는 올리지 않는다
  expect(detailsOf(remote.bytes)).toEqual(['지금']);

  await act(async () => { release(); await restoring; });
  expect(details(ref.current.db)).toEqual(['백업 시점', '되돌리는 중 입력']);
  expect(ref.current.pendingCount).toBe(1);
  await waitSave();
  expect(detailsOf(remote.bytes)).toEqual(['백업 시점', '되돌리는 중 입력']);
  unmount();
});

test('올리기 직전에 다른 기기가 저장했으면 그 파일도 백업한 뒤 다시 올린다', async () => {
  const { ref, unmount } = await opened();
  let once = true;
  BK.uploadNewBackup.mockImplementation(async () => {
    if (once) { once = false; otherDeviceAdds('직전 다른 기기'); } // 백업한 직후 다른 기기가 저장
    return `ledger-2026-11-08-12000${BK.uploadNewBackup.mock.calls.length}.db`;
  });

  await act(async () => { await ref.current.restoreBackup({ id: 'b1', date: '2026-11-01' }); });
  expect(BK.uploadNewBackup).toHaveBeenCalledTimes(2);
  expect(detailsOf(BK.uploadNewBackup.mock.calls[1][2])).toEqual(['지금', '직전 다른 기기']);
  expect(detailsOf(remote.bytes)).toEqual(['백업 시점']);
  unmount();
});

test('올린 뒤 응답을 못 받았어도 실제로 올라갔으면 되돌리기를 마친다', async () => {
  const { ref, unmount } = await opened();
  const real = OD.writeDbToOneDrive.getMockImplementation();
  OD.writeDbToOneDrive.mockImplementationOnce(async (...args) => { await real(...args); throw new Error('네트워크 오류'); });

  await act(async () => { await ref.current.restoreBackup({ id: 'b1', date: '2026-11-01' }); });
  expect(details(ref.current.db)).toEqual(['백업 시점']);
  unmount();
});

test('불러오는 중에 또 불러오면 같은 불러오기를 기다리고, 되돌리기는 그 불러오기가 끝난 뒤 바꾼다', async () => {
  const { ref, unmount } = await opened();
  otherDeviceAdds('다른 기기'); // 파일이 바뀌어 다시 받게 한다
  let release;
  OD.readDbFromOneDrive.mockImplementationOnce(() => new Promise(r => { release = () => r({ data: remote.bytes, eTag: remote.eTag }); }));

  let first; let second; let restoring;
  await act(async () => {
    first = ref.current.loadDb({ silent: true });
    second = ref.current.loadDb(); // 🔄를 또 누름
  });
  expect(second).toBe(first);
  await act(async () => { restoring = ref.current.restoreBackup({ id: 'b1', date: '2026-11-01' }); });
  await act(async () => { release(); await first; await restoring; });
  expect(details(ref.current.db)).toEqual(['백업 시점']); // 늦게 끝난 불러오기가 되돌린 화면을 덮지 않는다
  unmount();
});

test('올린 결과를 확인하지 못하면 실패라고 단정하지 않고 확인을 안내한다', async () => {
  const { ref, unmount } = await opened();
  const real = OD.writeDbToOneDrive.getMockImplementation();
  OD.writeDbToOneDrive.mockImplementationOnce(async (...args) => {
    await real(...args);
    otherDeviceAdds('그 사이 다른 기기'); // 확인하기 전에 다른 기기가 덮어씀
    throw new Error('네트워크 오류');
  });
  let error = null;
  await act(async () => {
    try { await ref.current.restoreBackup({ id: 'b1', date: '2026-11-01' }); } catch (e) { error = e; }
  });
  expect(error.message).toMatch(/되돌리기 결과를 확인하지 못했습니다/);
  unmount();
});

test('백업 파일이 깨졌으면 ledger.db와 화면을 그대로 두고, 자동 저장을 다시 켠다', async () => {
  const { ref, unmount } = await opened();
  BK.downloadBackup.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
  const before = remote.bytes;

  let error = null;
  await act(async () => {
    try { await ref.current.restoreBackup({ id: 'bad', date: '2026-11-01' }); } catch (e) { error = e; }
  });
  expect(error).toBeTruthy();
  expect(remote.bytes).toBe(before);
  expect(details(ref.current.db)).toEqual(['지금']);

  await act(async () => { addTransaction(ref.current.db, tx('그 뒤 입력')); });
  await waitSave();
  expect(detailsOf(remote.bytes)).toEqual(['지금', '그 뒤 입력']);
  unmount();
});
