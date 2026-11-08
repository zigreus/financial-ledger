/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 매일 백업·되돌리기 흐름 (I-014) — 저장소는 버전 규칙을 지키는 메모리 가짜(F-2), DB는 진짜 sql.js
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { createMemoryStorage } from '../../services/storage/memory';
import { listBackups } from '../../services/backups';
import { createDatabase, addTransaction } from '../../services/dbManager';
import { attachChangeLog, getChangeLog, replayChanges, stampWriteId } from '../../services/changeLog';
import { todayStr } from '../../services/dateUtils';
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
/** 다른 기기가 지금 저장소 파일에 거래를 하나 더 적어 저장한다 */
function otherDeviceAdds(detail) {
  const { db } = createDatabase(SQL, storage.current());
  addTransaction(db, tx(detail));
  stampWriteId(db); // 실제 저장처럼 자기 동기화 표식을 남긴다
  storage.replace(db.export());
}
/** 되돌릴 백업을 저장소 백업 폴더에 넣어 두고 { id, date }를 돌려준다 */
async function seedBackup(bytes, name = 'ledger-2020-01-01.db') {
  await storage.createBackup(name, bytes);
  const found = (await storage.listBackups()).find(b => b.name === name);
  return { id: found.id, date: '2020-01-01' };
}
/** 시각이 붙은 백업(직접 백업·되돌리기 직전 백업)의 내용 — 만든 순서대로 */
async function timedBackups() {
  const list = (await storage.listBackups()).filter(b => /-\d{6}(-\d+)?\.db$/.test(b.name));
  return Promise.all(list.map(b => storage.readBackup(b.id, () => true)));
}

async function mount() {
  const ref = { current: null };
  function Harness() { ref.current = useLedgerSync({ storage }); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Harness />); });
  return { ref, unmount: () => act(() => root.unmount()) };
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const waitSave = () => act(async () => { await new Promise(r => setTimeout(r, 450)); });

beforeEach(() => {
  window.localStorage.clear();
  storage = createMemoryStorage({ accountKey: 'me', bytes: ledgerWith('지금') });
});

async function opened() {
  const m = await mount();
  await act(async () => { await m.ref.current.loadDb(); });
  await flush();
  return m;
}

test('그날 처음 받으면 받은 파일 그대로 매일 백업을 만들고 오래된 백업을 정리하며, 같은 날 다시 열면 만들지 않는다', async () => {
  for (let d = 1; d <= 30; d += 1) await storage.createBackup(`ledger-2020-01-${String(d).padStart(2, '0')}.db`, ledgerWith('옛날'));
  const create = vi.spyOn(storage, 'createBackup');

  const first = await opened();
  expect(create).toHaveBeenCalledTimes(1);
  const list = await listBackups(storage);
  expect(list).toHaveLength(30); // 새 백업 1개를 만들고 가장 오래된 1개를 지웠다
  expect(list[0].name).toBe(`ledger-${todayStr()}.db`);
  expect(list.some(b => b.name === 'ledger-2020-01-01.db')).toBe(false);
  expect(detailsOf(await storage.readBackup(list[0].id, () => true))).toEqual(['지금']);
  expect(window.localStorage.getItem('ledger_last_backup:me')).toBe(todayStr());
  first.unmount();

  const again = await opened();
  expect(create).toHaveBeenCalledTimes(1);
  again.unmount();
});

test('매일 백업이 실패해도 앱은 열리고, 다음에 받을 때 다시 시도한다', async () => {
  const create = vi.spyOn(storage, 'createBackup').mockRejectedValueOnce(new Error('네트워크 오류'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const m = await opened();
  expect(warn).toHaveBeenCalledWith('[매일 백업 실패]', expect.any(Error));
  warn.mockRestore();
  expect(details(m.ref.current.db)).toEqual(['지금']);
  expect(window.localStorage.getItem('ledger_last_backup:me')).toBeNull();

  otherDeviceAdds('다른 기기'); // 파일이 바뀌어 다시 받게 한다
  await act(async () => { await m.ref.current.loadDb({ silent: true }); });
  await flush();
  expect(create).toHaveBeenCalledTimes(2);
  expect(window.localStorage.getItem('ledger_last_backup:me')).toBe(todayStr());
  m.unmount();
});

test('되돌리기: 미저장 변경 저장 → 지금 저장소 파일 백업 → 백업 파일을 올리고 화면 DB 교체', async () => {
  const backup = await seedBackup(ledgerWith('백업 시점'));
  const { ref, unmount } = await opened();
  await act(async () => { addTransaction(ref.current.db, tx('미저장', 500)); });

  await act(async () => { await ref.current.restoreBackup(backup); });

  // 되돌리기 전 백업에는 방금 저장한 변경까지 들어 있다
  const before = await timedBackups();
  expect(before).toHaveLength(1);
  expect(detailsOf(before[0])).toEqual(['지금', '미저장']);
  expect(detailsOf(storage.current())).toEqual(['백업 시점']);
  expect(details(ref.current.db)).toEqual(['백업 시점']);
  expect(ref.current.pendingCount).toBe(0);
  expect(window.localStorage.getItem('ledger_pending_changes:me')).toBeNull();
  unmount();
});

test('되돌린 뒤 새 행은 되돌리기 전에 쓰던 id를 다시 받지 않는다 — 다른 기기의 밀린 수정이 엉뚱한 행을 고치지 않는다', async () => {
  storage = createMemoryStorage({ accountKey: 'me', bytes: ledgerWith('지금', '백업 뒤') }); // id 1, 2
  const backup = await seedBackup(ledgerWith('백업 시점'));
  const { ref, unmount } = await opened();

  // 다른 기기 B: 되돌리기 전 화면에서 id 2를 고쳤지만 아직 저장하지 못함
  const B = createDatabase(SQL, storage.current()).db;
  attachChangeLog(B);
  B.run('UPDATE transactions SET detail = ?, amount = ? WHERE id = ?', ['B 수정', 9999, 2]);

  await act(async () => { await ref.current.restoreBackup(backup); });
  await act(async () => { addTransaction(ref.current.db, tx('되돌린 뒤 새 거래')); });
  await waitSave();

  const ids = ref.current.db.exec('SELECT id, detail FROM transactions ORDER BY id')[0].values;
  expect(ids).toEqual([[1, '백업 시점'], [3, '되돌린 뒤 새 거래']]);

  // B가 저장을 거절당하고 최신 파일에 기록을 다시 실행해도 새 거래는 그대로다
  const merged = createDatabase(SQL, storage.current()).db;
  replayChanges(merged, getChangeLog(B).entries);
  expect(details(merged)).toEqual(['백업 시점', '되돌린 뒤 새 거래']);
  unmount();
});

test('되돌리는 동안 이 기기에서 입력한 것은 버리지 않고 되돌린 가계부에 이어서 저장한다', async () => {
  const backup = await seedBackup(ledgerWith('백업 시점'));
  const { ref, unmount } = await opened();
  const realRead = storage.readBackup;
  let release;
  storage.readBackup = (id, accept) => new Promise(r => { release = () => r(realRead(id, accept)); });

  let restoring;
  await act(async () => { restoring = ref.current.restoreBackup(backup); });
  await act(async () => { addTransaction(ref.current.db, tx('되돌리는 중 입력')); });
  await waitSave(); // 자동 저장이 돌았어도 되돌리는 중에는 올리지 않는다
  expect(detailsOf(storage.current())).toEqual(['지금']);

  await act(async () => { release(); await restoring; });
  expect(details(ref.current.db)).toEqual(['백업 시점', '되돌리는 중 입력']);
  expect(ref.current.pendingCount).toBe(1);
  await waitSave();
  expect(detailsOf(storage.current())).toEqual(['백업 시점', '되돌리는 중 입력']);
  unmount();
});

test('올리기 직전에 다른 기기가 저장했으면 그 파일도 백업한 뒤 다시 올린다', async () => {
  const backup = await seedBackup(ledgerWith('백업 시점'));
  const { ref, unmount } = await opened();
  const realCreate = storage.createBackup;
  let once = true;
  storage.createBackup = async (name, bytes) => {
    const created = await realCreate(name, bytes);
    if (once) { once = false; otherDeviceAdds('직전 다른 기기'); } // 백업한 직후 다른 기기가 저장
    return created;
  };

  await act(async () => { await ref.current.restoreBackup(backup); });
  const before = await timedBackups();
  expect(before).toHaveLength(2);
  expect(detailsOf(before[1])).toEqual(['지금', '직전 다른 기기']);
  expect(detailsOf(storage.current())).toEqual(['백업 시점']);
  unmount();
});

test('올린 뒤 응답을 못 받았어도 실제로 올라갔으면 되돌리기를 마친다', async () => {
  const backup = await seedBackup(ledgerWith('백업 시점'));
  const { ref, unmount } = await opened();
  const realWrite = storage.write;
  storage.write = async (...args) => { storage.write = realWrite; await realWrite(...args); throw new Error('네트워크 오류'); };

  await act(async () => { await ref.current.restoreBackup(backup); });
  expect(details(ref.current.db)).toEqual(['백업 시점']);
  unmount();
});

test('불러오는 중에 또 불러오면 같은 불러오기를 기다리고, 되돌리기는 그 불러오기가 끝난 뒤 바꾼다', async () => {
  const backup = await seedBackup(ledgerWith('백업 시점'));
  const { ref, unmount } = await opened();
  otherDeviceAdds('다른 기기'); // 파일이 바뀌어 다시 받게 한다
  const realRead = storage.read;
  let release;
  storage.read = () => { storage.read = realRead; return new Promise(r => { release = () => r(realRead()); }); };

  let first; let second; let restoring;
  await act(async () => {
    first = ref.current.loadDb({ silent: true });
    second = ref.current.loadDb(); // 🔄를 또 누름
  });
  expect(second).toBe(first);
  await act(async () => { restoring = ref.current.restoreBackup(backup); });
  await act(async () => { release(); await first; await restoring; });
  expect(details(ref.current.db)).toEqual(['백업 시점']); // 늦게 끝난 불러오기가 되돌린 화면을 덮지 않는다
  unmount();
});

test('올린 결과를 확인하지 못하면 실패라고 단정하지 않고 확인을 안내한다', async () => {
  const backup = await seedBackup(ledgerWith('백업 시점'));
  const { ref, unmount } = await opened();
  const realWrite = storage.write;
  storage.write = async (...args) => {
    storage.write = realWrite;
    await realWrite(...args);
    otherDeviceAdds('그 사이 다른 기기'); // 확인하기 전에 다른 기기가 덮어씀
    throw new Error('네트워크 오류');
  };
  let error = null;
  await act(async () => {
    try { await ref.current.restoreBackup(backup); } catch (e) { error = e; }
  });
  expect(error.message).toMatch(/되돌리기 결과를 확인하지 못했습니다/);
  unmount();
});

test('백업 파일이 깨졌으면 ledger.db와 화면을 그대로 두고, 자동 저장을 다시 켠다', async () => {
  const backup = await seedBackup(new Uint8Array([1, 2, 3, 4]));
  const { ref, unmount } = await opened();
  const before = storage.current();

  let error = null;
  await act(async () => {
    try { await ref.current.restoreBackup(backup); } catch (e) { error = e; }
  });
  expect(error).toBeTruthy();
  expect(storage.current()).toEqual(before);
  expect(details(ref.current.db)).toEqual(['지금']);

  await act(async () => { addTransaction(ref.current.db, tx('그 뒤 입력')); });
  await waitSave();
  expect(detailsOf(storage.current())).toEqual(['지금', '그 뒤 입력']);
  unmount();
});

test('백업 폴더의 다른 파일은 되돌리기에 쓰지 않는다', async () => {
  await storage.createBackup('메모.txt', ledgerWith('엉뚱한 파일'));
  const other = (await storage.listBackups()).find(b => b.name === '메모.txt');
  const { ref, unmount } = await opened();
  let error = null;
  await act(async () => {
    try { await ref.current.restoreBackup({ id: other.id, date: '?' }); } catch (e) { error = e; }
  });
  expect(error.message).toMatch(/백업 파일이 아닙니다/);
  expect(detailsOf(storage.current())).toEqual(['지금']);
  expect(await listBackups(storage)).toHaveLength(1); // 목록에는 이름 규칙에 맞는 오늘 백업만
  unmount();
});
