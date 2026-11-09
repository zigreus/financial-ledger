/**
 * @vitest-environment jsdom
 */
// Google Drive 저장소 (M-1, I-031) — 원자적 조건부 저장이 없는 Drive에서 '확인하고 올린 뒤 다시 확인'이 저장을 잃지 않는지,
// 로그인 시간이 끝났을 때·연결이 없을 때의 오류. 계약 테스트는 storage.test.js의 contract('Google Drive(가짜 Drive)').
// (확인하지 못한 업로드를 localStorage에 기억하므로 jsdom에서 돈다)
import { ConflictError, OfflineError, ReconnectRequiredError } from '../storage/provider';
import { createGoogleDriveStorage } from '../storage/googleDrive';
import { fakeDrive } from './fakeDrive';

beforeEach(() => { window.localStorage.clear(); });

const bytesOf = (...n) => new Uint8Array(n);
const list = b => Array.from(b || []);
const make = (drive, extra = {}) => createGoogleDriveStorage({ accountKey: 'google:1', getToken: () => 'T', fetchImpl: drive.fetch, ...extra });

test('확인과 올리기 사이에 다른 기기가 저장했으면 그 기기의 내용을 되돌려 두고 ConflictError — 다시 읽으면 그 내용이다', async () => {
  const drive = fakeDrive();
  const s = make(drive);
  const v1 = await s.write(bytesOf(1), null);
  drive.hooks.beforeUpload = () => drive.put('ledger.db', bytesOf(9));   // 내가 버전을 확인한 직후 다른 기기가 저장
  await expect(s.write(bytesOf(2), v1)).rejects.toBeInstanceOf(ConflictError);
  const now = await s.read();
  expect(list(now.bytes)).toEqual([9]);                                   // 다른 기기의 저장을 잃지 않았다
  expect(drive.revisionsOf('ledger.db')).toEqual([[1], [9], [2], [9]]);   // 내 것은 리비전 기록에만 남는다
  const v = await s.write(bytesOf(9, 2), now.version);                    // 합쳐서 다시 저장하면 된다
  expect(v).toBe(await s.getVersion());
});

test('두 기기가 처음 저장을 동시에 해 파일이 둘 생기면 먼저 만든 쪽을 쓰고 내 것은 지운다', async () => {
  const drive = fakeDrive();
  const s = make(drive);
  // 내 기기가 '파일 없음'을 확인한 뒤, 만들기 전에 다른 기기가 먼저 만든 상황을 흉내 낸다
  const realFetch = drive.fetch.getMockImplementation();
  let injected = false;
  drive.fetch.mockImplementation(async (url, init) => {
    if (!injected && String(url).includes('upload/drive/v3/files?uploadType=multipart')) {
      injected = true;
      drive.addDuplicate('ledger.db', bytesOf(7));
    }
    return realFetch(url, init);
  });
  await expect(s.write(bytesOf(1), null)).rejects.toBeInstanceOf(ConflictError);
  expect(drive.countNamed('ledger.db')).toBe(1);
  expect(list((await s.read()).bytes)).toEqual([7]);
});

test('로그인 시간이 끝났으면 ReconnectRequiredError(연결 없음처럼 처리) — 401이면 토큰을 만료로 표시', async () => {
  const drive = fakeDrive({ token: 'NEW' });
  const onUnauthorized = vi.fn();
  const s = make(drive, { onUnauthorized });
  const err = await s.read().catch(e => e);
  expect(err).toBeInstanceOf(ReconnectRequiredError);
  expect(err).toBeInstanceOf(OfflineError);
  expect(onUnauthorized).toHaveBeenCalled();

  const expired = make(drive, { getToken: () => { throw new ReconnectRequiredError(); } });
  await expect(expired.write(bytesOf(1), null)).rejects.toBeInstanceOf(ReconnectRequiredError);
});

test('요청이 나가지 못하면 OfflineError', async () => {
  const s = make({ fetch: async () => { throw new TypeError('Failed to fetch'); } }, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await expect(s.getVersion()).rejects.toBeInstanceOf(OfflineError);
});

test('저장 오류는 충돌로 보지 않는다 — 결과를 모르는 업로드로 남겨야 하므로', async () => {
  const drive = fakeDrive();
  const s = make(drive);
  const v1 = await s.write(bytesOf(1), null);
  const realFetch = drive.fetch.getMockImplementation();
  drive.fetch.mockImplementation(async (url, init) => (
    init?.method === 'PATCH' ? { ok: false, status: 500, statusText: 'oops', json: async () => ({}) } : realFetch(url, init)
  ));
  const err = await s.write(bytesOf(2), v1).catch(e => e);
  expect(err).not.toBeInstanceOf(ConflictError);
  expect(err.message).toContain('Google Drive 저장 오류: 500');
});

describe('올린 뒤 확인이 끝나기 전에 실패해도 끼어든 저장을 잃지 않는다', () => {
  const isList = (url, method) => method === 'GET' && /\/revisions\?/.test(url);
  const isRevDownload = (url, method) => method === 'GET' && /\/revisions\/[^/?]+\?alt=media/.test(url);
  const cases = [
    ['리비전 목록이 500', { match: isList, status: 500 }],
    ['리비전 목록 중 연결 끊김', { match: isList, status: 'offline' }],
    ['리비전 목록이 401(로그인 만료)', { match: isList, status: 401 }],
    ['되돌릴 리비전 받기 중 연결 끊김', { match: isRevDownload, status: 'offline' }],
  ];
  test.each(cases)('%s → 다음 읽기 전에 마저 확인해 끼어든 기기의 내용을 되돌려 둔다', async (_, fail) => {
    const drive = fakeDrive();
    const s = make(drive);
    const v1 = await s.write(bytesOf(1), null);
    drive.hooks.beforeUpload = () => {
      drive.put('ledger.db', bytesOf(9));
      drive.hooks.failNext = fail;                                        // 내가 올린 뒤의 확인 단계에서 실패
    };
    const err = await s.write(bytesOf(2), v1).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConflictError);                        // 결과를 모르는 저장으로 남는다
    expect(list((await s.read()).bytes)).toEqual([9]);                    // 다음 읽기가 먼저 마저 확인하고 되돌렸다
  });

  test('확인하지 못한 업로드는 이 기기에 기억해 — 앱을 다시 열어도(새 저장소 객체) 마저 확인한다', async () => {
    const drive = fakeDrive();
    const s = make(drive);
    const v1 = await s.write(bytesOf(1), null);
    drive.hooks.beforeUpload = () => {
      drive.put('ledger.db', bytesOf(9));
      drive.hooks.failNext = { match: isList, status: 'offline' };
    };
    await s.write(bytesOf(2), v1).catch(() => {});
    const reopened = make(drive);
    expect(list((await reopened.read()).bytes)).toEqual([9]);
    expect(window.localStorage.getItem('ledger_gdrive_unverified:google:1:ledger.db')).toBeNull();
  });

  test('기억한 업로드의 파일이 없어졌으면(404) 기억을 버리고 — 읽기·새로 만들기가 막히지 않는다', async () => {
    const drive = fakeDrive();
    const s = make(drive);
    const v1 = await s.write(bytesOf(1), null);
    drive.hooks.failNext = { match: isList, status: 500 };
    await s.write(bytesOf(2), v1).catch(() => {});
    expect(window.localStorage.getItem('ledger_gdrive_unverified:google:1:ledger.db')).not.toBeNull();
    drive.remove('ledger.db');                                            // 사용자가 Drive에서 지웠다
    expect(await make(drive).read()).toEqual({ bytes: null, version: null });
    expect(window.localStorage.getItem('ledger_gdrive_unverified:google:1:ledger.db')).toBeNull();
    expect(await s.write(bytesOf(3), null)).toBeTruthy();
  });

  test('확인하지 못한 내 업로드가 맨 위에 있는 동안은 다음 저장도 충돌로 알리지 않는다(병합이 받아들이지 않게), 403도 바로 버리지 않는다', async () => {
    const drive = fakeDrive();
    const s = make(drive, { verifyRetryMs: [0] });
    const v1 = await s.write(bytesOf(1), null);
    let hide = 99;
    drive.hooks.revisionList = l => (hide-- > 0 ? l.slice(0, -1) : l);
    await s.write(bytesOf(2), v1).catch(() => {});
    const again = await s.write(bytesOf(3), v1).catch(e => e);
    expect(again).not.toBeInstanceOf(ConflictError);
    expect(again.message).toContain('아직 확인하지 못했습니다');
    drive.hooks.revisionList = null;
    drive.hooks.failNext = { match: isList, status: 403 };
    await s.getVersion();
    expect(window.localStorage.getItem('ledger_gdrive_unverified:google:1:ledger.db')).not.toBeNull();
    await s.getVersion();                                                 // 목록이 보이면 마저 확인하고 버린다
    expect(window.localStorage.getItem('ledger_gdrive_unverified:google:1:ledger.db')).toBeNull();
  });

  test('확인 중 다른 오류(500)가 나도 이번 읽기는 막지 않고 기억만 남긴다, 연결 없음은 그대로 알린다', async () => {
    const drive = fakeDrive();
    const s = make(drive);
    const v1 = await s.write(bytesOf(1), null);
    drive.hooks.failNext = { match: isList, status: 500 };
    await s.write(bytesOf(2), v1).catch(() => {});
    drive.hooks.failNext = { match: isList, status: 503 };
    expect(list((await s.read()).bytes)).toEqual([2]);
    expect(window.localStorage.getItem('ledger_gdrive_unverified:google:1:ledger.db')).not.toBeNull();
    drive.hooks.failNext = { match: isList, status: 'offline' };
    await expect(s.read()).rejects.toBeInstanceOf(OfflineError);
  });
});

describe('리비전 목록 순서를 믿지 않는다', () => {
  test('최신 것부터 와도 시간 순서로 맞춰 확인한다 — 끼어듦이 없으면 그냥 저장된다', async () => {
    const drive = fakeDrive();
    drive.hooks.revisionList = l => [...l].reverse();
    const s = make(drive);
    const v1 = await s.write(bytesOf(1), null);
    const v2 = await s.write(bytesOf(2), v1);
    const v3 = await s.write(bytesOf(3), v2);
    expect(v3).toBe(await s.getVersion());
    drive.hooks.beforeUpload = () => drive.put('ledger.db', bytesOf(9));
    await expect(s.write(bytesOf(4), v3)).rejects.toBeInstanceOf(ConflictError);
    expect(list((await s.read()).bytes)).toEqual([9]);
  });

  test('확인한 버전이 내 것보다 뒤로 보이는 등 순서를 믿을 수 없으면 되돌리지 않고, 성공 대신 결과를 모르는 저장으로 끝낸다', async () => {
    const drive = fakeDrive();
    const s = make(drive, { verifyRetryMs: [0] });
    const v1 = await s.write(bytesOf(1), null);
    drive.hooks.revisionList = l => l.map(r => ({ ...r, modifiedTime: '2026-01-01T00:00:00.000Z' })).reverse();
    const err = await s.write(bytesOf(2), v1).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConflictError);                        // 동기화가 변경을 계속 들고 있게
    expect(list((await s.read()).bytes)).toEqual([2]);                    // 되돌리지 않았다
  });

  test('목록이 잠깐 늦게 보이면 다시 확인한다 — 그 사이 끼어든 저장도 찾아 되돌린다', async () => {
    const drive = fakeDrive();
    const s = make(drive, { verifyRetryMs: [0] });
    const v1 = await s.write(bytesOf(1), null);
    let hide = 1;
    drive.hooks.revisionList = l => (hide-- > 0 ? l.slice(0, -1) : l);   // 처음 한 번은 내 리비전이 아직 없다
    drive.hooks.beforeUpload = () => drive.put('ledger.db', bytesOf(9));
    await expect(s.write(bytesOf(2), v1)).rejects.toBeInstanceOf(ConflictError);
    expect(list((await s.read()).bytes)).toEqual([9]);
  });

  test('되돌리기 전에 또 다른 저장이 내 것 위에 올라갔으면 되돌리지 않고 충돌로만 알린다', async () => {
    const drive = fakeDrive();
    const s = make(drive);
    const v1 = await s.write(bytesOf(1), null);
    drive.hooks.beforeUpload = () => {
      drive.put('ledger.db', bytesOf(9));
      drive.hooks.failNext = null;
      const realFetch = drive.fetch.getMockImplementation();
      let once = true;
      drive.fetch.mockImplementation(async (url, init) => {
        const res = await realFetch(url, init);
        if (once && (init?.method || 'GET') === 'GET' && /\/revisions\?/.test(url)) {
          once = false;
          drive.put('ledger.db', bytesOf(7));                             // 확인하는 사이 세 번째 기기가 내 것 위에 저장
        }
        return res;
      });
    };
    await expect(s.write(bytesOf(2), v1)).rejects.toBeInstanceOf(ConflictError);
    expect(list((await s.read()).bytes)).toEqual([7]);
  });
});

test('앱 폴더 안에만 만들고, 다른 이름의 파일은 건드리지 않는다', async () => {
  const drive = fakeDrive();
  const s = make(drive);
  await s.write(bytesOf(1), null);
  await s.createBackup('ledger-2026-11-01.db', bytesOf(5));
  const folders = [...drive.files.values()].filter(f => f.mime === 'application/vnd.google-apps.folder').map(f => [f.name, f.parent]);
  expect(folders.map(f => f[0]).sort()).toEqual(['backups', 'financial-ledger']);
  expect(folders.find(f => f[0] === 'financial-ledger')[1]).toBe('root');
});
