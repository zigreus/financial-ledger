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
import { createDatabase, addTransaction, addPaymentMethod, applyStarterSetup, getPaymentMethods, getBudgetCategories, SCHEMA_VERSION } from '../../services/dbManager';
import { STARTER_TEMPLATES } from '../../data/starterTemplates';
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
  /** 지난 세션: 지금 파일에서 거래를 하나 입력하고 올리기 시작했다 — 표식과 기록을 기기에 남겼다.
   *  inFlight는 예전 버전이 남기던 { writeId, n } 하나 형식이다 — 업데이트 뒤에도 읽혀야 한다 (B-088 이후는 배열) */
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

describe('응답을 못 받은 업로드 뒤에도 같은 입력을 두 번 넣지 않는다 (B-088)', () => {
  const offline = () => new Error('네트워크 오류 — 인터넷 연결을 확인하세요');
  /** 다음 저장은 저장소에 닿지만 응답을 잃는다(약한 신호) */
  function loseNextResponse() {
    const real = storage.write;
    storage.write = async (...args) => { storage.write = real; await real(...args); throw offline(); };
  }
  /** 다음 저장은 저장소에 닿지 못한다 */
  function failNextWrite() {
    const real = storage.write;
    storage.write = async () => { storage.write = real; throw offline(); };
  }

  test('응답을 잃은 뒤 다시 저장하면 거절(412)되어 합치는데, 이미 올라간 입력은 다시 넣지 않는다', async () => {
    const { ref, unmount } = await opened();
    await act(async () => { addTransaction(ref.current.db, tx('한 번만')); });
    loseNextResponse();
    expect(await saveNowResult(ref)).toBe(false);
    expect(await saveNowResult(ref)).toBe(true);
    expect(detailsOf(storage.current())).toEqual(['지금', '한 번만']);
    expect(details(ref.current.db)).toEqual(['지금', '한 번만']);
    expect(ref.current.pendingCount).toBe(0);
    unmount();
  });

  test('응답을 잃고, 다음 시도는 닿지도 못한 뒤 연결이 돌아와도 한 번만', async () => {
    const { ref, unmount } = await opened();
    await act(async () => { addTransaction(ref.current.db, tx('한 번만')); });
    loseNextResponse();
    expect(await saveNowResult(ref)).toBe(false);
    await act(async () => { addTransaction(ref.current.db, tx('그다음 입력')); });
    failNextWrite();
    expect(await saveNowResult(ref)).toBe(false);
    expect(await saveNowResult(ref)).toBe(true);
    expect(detailsOf(storage.current())).toEqual(['지금', '한 번만', '그다음 입력']);
    unmount();
  });

  test('응답을 잃은 사이 다른 기기가 그 위에 저장했어도, 합칠 때 내 업로드를 알아본다', async () => {
    const { ref, unmount } = await opened();
    await act(async () => { addTransaction(ref.current.db, tx('한 번만')); });
    loseNextResponse();
    expect(await saveNowResult(ref)).toBe(false);
    otherDeviceAdds('다른 기기'); // 내 업로드가 들어간 파일 위에 저장 — 마지막 표식이 다른 기기 것으로 바뀐다
    expect(await saveNowResult(ref)).toBe(true);
    expect(detailsOf(storage.current())).toEqual(['지금', '한 번만', '다른 기기']);
    unmount();
  });

  test('응답을 잃고 재시도도 실패한 채 앱을 닫았다가, 그 사이 다른 기기가 저장한 뒤 다시 열어도 한 번만', async () => {
    const first = await opened();
    await act(async () => { addTransaction(first.ref.current.db, tx('한 번만')); });
    loseNextResponse();
    expect(await saveNowResult(first.ref)).toBe(false);
    failNextWrite();
    expect(await saveNowResult(first.ref)).toBe(false);
    first.unmount();
    expect(pendingStored().entries).toHaveLength(1); // 이 기기는 아직 저장 안 된 변경으로 알고 있다

    otherDeviceAdds('다른 기기');
    const again = await opened();
    await waitSave();
    expect(details(again.ref.current.db)).toEqual(['지금', '한 번만', '다른 기기']);
    expect(detailsOf(storage.current())).toEqual(['지금', '한 번만', '다른 기기']);
    expect(pendingStored()).toBeNull();
    again.unmount();
  });
});

const offlineError = () => new Error('네트워크 오류 — 인터넷 연결을 확인하세요');
/** 다음 저장은 저장소에 닿지 못한다 */
function failNext() {
  const real = storage.write;
  storage.write = async () => { storage.write = real; throw offlineError(); };
}
/** 다음 저장은 저장소에 닿지만 응답을 잃는다 */
function loseNext() {
  const real = storage.write;
  storage.write = async (...a) => { storage.write = real; await real(...a); throw offlineError(); };
}
/** 저장 i번째를 plan[i]대로: 'lose'면 올라가지만 응답을 잃는다, 그 밖에는 그대로 */
function writePlan(plan) {
  const real = storage.write;
  let i = 0;
  storage.write = async (...args) => {
    const mode = plan[i++];
    if (mode === 'lose') { await real(...args); throw offlineError(); }
    return real(...args);
  };
}

describe('결과를 모르는 업로드 목록이 지켜야 할 것 (B-088)', () => {
  test('닿지 못한 시도 다음 시도가 응답을 잃어도 한 번만 — 실제로 올라간 쪽만큼 뺀다', async () => {
    const { ref, unmount } = await opened();
    await act(async () => { addTransaction(ref.current.db, tx('하나')); });
    failNext();
    expect(await saveNowResult(ref)).toBe(false);
    await act(async () => { addTransaction(ref.current.db, tx('둘')); });
    loseNext();
    expect(await saveNowResult(ref)).toBe(false);
    expect(await saveNowResult(ref)).toBe(true);
    expect(detailsOf(storage.current())).toEqual(['지금', '하나', '둘']);
    unmount();
  });

  test('저장에 성공하면 목록을 비운다 — 그 뒤 다른 기기와 겹쳐도 새 입력이 사라지지 않는다', async () => {
    const { ref, unmount } = await opened();
    await act(async () => { addTransaction(ref.current.db, tx('하나')); });
    failNext();
    expect(await saveNowResult(ref)).toBe(false);
    expect(await saveNowResult(ref)).toBe(true);
    await act(async () => { addTransaction(ref.current.db, tx('둘')); });
    otherDeviceAdds('다른');
    expect(await saveNowResult(ref)).toBe(true);
    expect(detailsOf(storage.current())).toEqual(['지금', '하나', '다른', '둘']);
    unmount();
  });

  test('합치면 목록을 비운다 — 합친 뒤 또 겹쳐도 새 입력이 사라지지 않는다', async () => {
    const { ref, unmount } = await opened();
    await act(async () => { addTransaction(ref.current.db, tx('하나')); });
    loseNext();
    expect(await saveNowResult(ref)).toBe(false);
    await act(async () => { addTransaction(ref.current.db, tx('둘')); });
    const real = storage.write;
    let i = 0;
    storage.write = async (...a) => { i += 1; if (i === 2) { storage.write = real; throw offlineError(); } return real(...a); };
    expect(await saveNowResult(ref)).toBe(false); // 거절 → 합침('하나'는 이미 있음) → 다음 저장은 닿지 못함
    await act(async () => { addTransaction(ref.current.db, tx('셋')); });
    otherDeviceAdds('다른');
    expect(await saveNowResult(ref)).toBe(true);
    expect(detailsOf(storage.current())).toEqual(['지금', '하나', '다른', '둘', '셋']);
    unmount();
  });
});

describe('불러오는 사이에 저장이 돌 때 (B-088)', () => {
  /** 다른 기기가 저장해 둔 상태에서 불러오기를 시작하고, 그 읽기를 붙잡아 둔다 */
  async function loadingHeld(ref) {
    otherDeviceAdds('다른');
    const realRead = storage.read;
    let release;
    const gate = new Promise(r => { release = r; });
    let first = true;
    storage.read = async () => { if (first) { first = false; await gate; } return realRead(); };
    let loading;
    await act(async () => { loading = ref.current.loadDb({ silent: true }); });
    await flush();
    return { release: () => release(), loading };
  }

  test('불러오는 사이 응답을 잃은 저장이 생기면 받은 파일로 바꾸지 않는다 — 이미 올라간 입력을 또 넣지 않는다', async () => {
    const { ref, unmount } = await opened();
    const { release, loading } = await loadingHeld(ref);
    await act(async () => { addTransaction(ref.current.db, tx('내 입력')); });
    writePlan(['ok', 'lose']); // 1: 옛 버전이라 거절 → 합침, 2: 올라가지만 응답을 잃음
    expect(await saveNowResult(ref)).toBe(false);
    expect(detailsOf(storage.current())).toEqual(['지금', '다른', '내 입력']);

    await act(async () => { release(); await loading; });
    expect(details(ref.current.db)).toEqual(['지금', '다른', '내 입력']);
    expect(await saveNowResult(ref)).toBe(true);
    expect(detailsOf(storage.current())).toEqual(['지금', '다른', '내 입력']);
    expect(details(ref.current.db)).toEqual(['지금', '다른', '내 입력']);
    expect(ref.current.pendingCount).toBe(0);
    unmount();
  });

  test('불러오는 사이 건너뛰는 변경(이미 있는 결제수단)이 섞여 있어도 올라가지 않은 입력을 잃지 않는다', async () => {
    const { ref, unmount } = await opened();
    const { release, loading } = await loadingHeld(ref);
    await act(async () => {
      addPaymentMethod(ref.current.db, '새 카드'); // 같은 이름을 다시 넣으면 UNIQUE로 건너뛴다
      addTransaction(ref.current.db, tx('내 입력'));
    });
    writePlan(['ok', 'lose', 'lose']);
    expect(await saveNowResult(ref)).toBe(false);
    await act(async () => { release(); await loading; });

    await act(async () => { addTransaction(ref.current.db, tx('나중 입력')); });
    expect(await saveNowResult(ref)).toBe(true);
    const remote = new SQL.Database(storage.current());
    expect(details(remote)).toEqual(['지금', '다른', '내 입력', '나중 입력']);
    expect(remote.exec('SELECT COUNT(*) FROM payment_methods WHERE name = ?', ['새 카드'])[0].values[0][0]).toBe(1);
    unmount();
  });

  test('불러오는 사이 저장의 응답이 오는 중이면 끝나기를 기다렸다 다시 확인한다 — 응답을 잃지 않아도 중복되지 않게', async () => {
    const { ref, unmount } = await opened();
    const { release, loading } = await loadingHeld(ref);
    await act(async () => { addTransaction(ref.current.db, tx('내 입력')); });
    const real = storage.write;
    let i = 0;
    let answer;
    const answered = new Promise(r => { answer = r; });
    storage.write = async (...a) => {
      i += 1;
      if (i === 2) { const v = await real(...a); await answered; return v; } // 올라갔고 응답은 오는 중
      return real(...a);
    };
    let saving;
    await act(async () => { saving = ref.current.saveNow(); });
    await flush();
    await flush();
    expect(detailsOf(storage.current())).toEqual(['지금', '다른', '내 입력']);

    release();
    await flush();
    await flush();
    answer();
    await act(async () => { await saving; await loading; });
    await act(async () => { addTransaction(ref.current.db, tx('다음 입력')); });
    expect(await saveNowResult(ref)).toBe(true);
    expect(detailsOf(storage.current())).toEqual(['지금', '다른', '내 입력', '다음 입력']);
    expect(details(ref.current.db)).toEqual(['지금', '다른', '내 입력', '다음 입력']);
    unmount();
  });
});

describe('불러오기가 받은 파일보다 이 기기 저장이 앞설 때 (B-090)', () => {
  /** 불러오기의 읽기는 지금 상태로 끝났지만 응답이 늦게 온다 — 돌려준 함수로 놓아준다 */
  function slowFirstReadAnswer() {
    const realRead = storage.read;
    let release;
    const gate = new Promise(r => { release = r; });
    let first = true;
    storage.read = async () => { const got = await realRead(); if (first) { first = false; await gate; } return got; };
    return () => release();
  }

  test('불러오는 사이 이 기기 저장이 합쳐 성공하면, 그보다 옛 파일로 바꿔 방금 저장한 입력을 감추지 않는다', async () => {
    const { ref, unmount } = await opened();
    otherDeviceAdds('다른');
    const release = slowFirstReadAnswer();
    let loading;
    await act(async () => { loading = ref.current.loadDb({ silent: true }); });
    await flush();
    await act(async () => { addTransaction(ref.current.db, tx('내 입력')); });
    expect(await saveNowResult(ref)).toBe(true); // 거절 → 합침 → 저장 성공
    expect(details(ref.current.db)).toEqual(['지금', '다른', '내 입력']);

    await act(async () => { release(); await loading; });
    expect(details(ref.current.db)).toEqual(['지금', '다른', '내 입력']);
    expect(detailsOf(storage.current())).toEqual(['지금', '다른', '내 입력']);
    unmount();
  });

  test('불러오기가 기다린 저장이 실패하면 저장 실패 안내를 덮지 않고 멈춘다', async () => {
    const { ref, unmount } = await opened();
    otherDeviceAdds('다른');
    const realRead = storage.read;
    let releaseRead;
    const readGate = new Promise(r => { releaseRead = r; });
    let first = true;
    storage.read = async () => { if (first) { first = false; await readGate; } return realRead(); };
    let loading;
    await act(async () => { loading = ref.current.loadDb({ silent: true }); });
    await flush();

    await act(async () => { addTransaction(ref.current.db, tx('내 입력')); });
    let failWrite;
    const writeGate = new Promise(r => { failWrite = r; });
    storage.write = async () => { await writeGate; throw offlineError(); }; // 닿지 못하는 저장이 응답을 기다리는 중
    const getVersion = vi.spyOn(storage, 'getVersion');
    let saving;
    await act(async () => { saving = ref.current.saveNow(); });
    await act(async () => { releaseRead(); });
    await flush(); // 불러오기가 저장이 끝나기를 기다린다
    getVersion.mockClear();
    await act(async () => { failWrite(); await saving; await loading; });

    expect(ref.current.error).toMatch(/^저장 실패: 네트워크 오류.*이 기기에 보관/);
    expect(getVersion).not.toHaveBeenCalled(); // 실패한 저장 뒤 다시 확인하러 가지 않는다
    expect(details(ref.current.db)).toEqual(['지금', '내 입력']); // 받은 파일로 바꾸지 않았다
    expect(ref.current.pendingCount).toBe(1);
    unmount();
  });
});

describe('저장에 실패한 뒤 다시 시도하는 간격 (B-089)', () => {
  test('0.4초마다 다시 시도하지 않고 점점 길게 기다리며, 다시 온라인이 되면 바로 저장한다', async () => {
    const { ref, unmount } = await opened();
    const realWrite = storage.write;
    const write = vi.fn(async () => { throw new Error('네트워크 오류 — 인터넷 연결을 확인하세요'); });
    storage.write = write;
    await act(async () => { addTransaction(ref.current.db, tx('오프라인 입력')); });
    expect(await saveNowResult(ref)).toBe(false);
    await act(async () => { await new Promise(r => setTimeout(r, 1200)); });
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => { await new Promise(r => setTimeout(r, 2300)); }); // 실패 뒤 2초에 한 번 더 (그다음은 그 5초 뒤)
    expect(write).toHaveBeenCalledTimes(2);

    storage.write = realWrite;
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await flush();
    expect(detailsOf(storage.current())).toEqual(['지금', '오프라인 입력']);
    unmount();
  });

  test('화면이 사라지면 예약해 둔 다시 시도도 지운다', async () => {
    const { ref, unmount } = await opened();
    const write = vi.fn(async () => { throw new Error('네트워크 오류 — 인터넷 연결을 확인하세요'); });
    storage.write = write;
    await act(async () => { addTransaction(ref.current.db, tx('입력')); });
    expect(await saveNowResult(ref)).toBe(false);
    unmount();
    await act(async () => { await new Promise(r => setTimeout(r, 2300)); });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('합칠 때 들어가지 않은 내 행을 가리키는 수정 (B-091)', () => {
  test('다른 기기도 같은 이름으로 만든 결제수단을 이 기기에서 숨겼다면, 합칠 때 같은 번호의 다른 결제수단을 숨기지 않는다', async () => {
    const { ref, unmount } = await opened();
    // 다른 기기가 먼저 '우리카드'(id 1)·'토스'(id 2)를 만들어 저장했다
    const { db: other } = createDatabase(SQL, storage.current());
    addPaymentMethod(other, '우리카드');
    addPaymentMethod(other, '토스');
    storage.replace(other.export());

    // 이 기기는 옛 파일 위에서 '토스'(여기서는 id 1)를 만들고 숨겼다
    await act(async () => {
      addPaymentMethod(ref.current.db, '토스');
      ref.current.db.run('UPDATE payment_methods SET is_hidden = 1 WHERE id = ?', [1]);
    });
    expect(await saveNowResult(ref)).toBe(true);
    const remote = new SQL.Database(storage.current());
    expect(remote.exec('SELECT name, is_hidden FROM payment_methods ORDER BY id')[0].values).toEqual([['우리카드', 0], ['토스', 0]]);
    expect(ref.current.notice.text).toBe('다른 기기에서 바뀐 내용을 받아 합쳤습니다 (이미 있는 1건 제외 · 먼저 바뀐 내용과 맞지 않는 이 기기 변경 일부는 넣지 않았습니다)');
    unmount();
  });
});

test('지난 세션에서 오프라인으로 고른 첫 실행 기본값은, 그 사이 다른 기기가 꾸민 가계부에 넣지 않고 그렇다고 알린다 (B-091)', async () => {
  storage = createMemoryStorage({ accountKey: 'me', bytes: createDatabase(SQL, null).db.export() });
  const { db: last } = createDatabase(SQL, storage.current());
  attachChangeLog(last);
  applyStarterSetup(last, STARTER_TEMPLATES[0]);
  savePending('me', { entries: getChangeLog(last).entries, inFlight: [] });
  const { db: other } = createDatabase(SQL, storage.current());
  addPaymentMethod(other, '우리카드');
  storage.replace(other.export());

  const { ref, unmount } = await opened();
  await waitSave();
  expect(getPaymentMethods(ref.current.db)).toEqual(['우리카드']);
  expect(getBudgetCategories(ref.current.db)).toEqual([]);
  expect(ref.current.notice.text).toContain('먼저 바뀐 내용과 맞지 않는 이 기기 변경 일부는 넣지 않았습니다');
  expect(getPaymentMethods(new SQL.Database(storage.current()))).toEqual(['우리카드']);
  unmount();
});

describe('연결 없이 열기 (I-024)', () => {
  test('오래된 사본에서 시작했는데 그 사이 다른 기기가 저장했으면, 연결되면 최신 파일에 합쳐 둘 다 남긴다', async () => {
    const { createMemoryOfflineCache } = await import('../../services/offlineCache');
    const { OfflineError } = await import('../../services/storage/provider');
    const cache = createMemoryOfflineCache();
    const net = { up: true };
    const guard = fn => async (...args) => { if (!net.up) throw new OfflineError(); return fn(...args); };
    const store = { ...storage, read: guard(storage.read), getVersion: guard(storage.getVersion), write: guard(storage.write) };
    const mountWith = async () => {
      const ref = { current: null };
      function Harness() { ref.current = useLedgerSync({ storage: store, offlineCache: cache }); return null; }
      const root = createRoot(document.createElement('div'));
      await act(async () => { root.render(<Harness />); });
      await act(async () => { await ref.current.loadDb(); });
      await flush();
      return { ref, unmount: () => act(() => root.unmount()) };
    };

    const A = await mountWith();                 // 연결된 채 열어 사본(v1)을 남긴다
    A.unmount();
    otherDeviceAdds('다른 기기');                 // 그 사이 다른 기기가 저장(v2)

    net.up = false;
    const B = await mountWith();                 // 해외 — 연결 없이 사본(v1)으로 연다
    expect(details(B.ref.current.db)).toEqual(['지금']);
    await act(async () => { addTransaction(B.ref.current.db, tx('여행 중 입력')); });
    await waitSave();
    expect(B.ref.current.offline).toBe(true);

    net.up = true;                                // 연결되면 v1로 저장 → 거절 → 최신(v2)에 다시 실행해 합친다
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await waitSave();
    await flush();
    expect(detailsOf(storage.current())).toEqual(['지금', '다른 기기', '여행 중 입력']);
    expect(details(B.ref.current.db)).toEqual(['지금', '다른 기기', '여행 중 입력']);
    expect(B.ref.current.pendingCount).toBe(0);
    expect(B.ref.current.offline).toBe(false);
    B.unmount();
  });
});
