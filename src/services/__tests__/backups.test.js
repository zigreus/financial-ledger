/**
 * @vitest-environment jsdom
 */
// 백업 규칙 (I-014) — 저장소는 OneDrive 구현을 쓰고 Graph 호출은 가짜 fetch로 확인한다 (F-2 뒤에도 요청이 그대로인지)
import {
  backupName, parseBackupName, listBackups, uploadBackup, uploadNewBackup, downloadBackup, pruneBackups,
} from '../backups';
import { createOneDriveStorage, BACKUP_DIR } from '../storage/oneDrive';

const instance = { acquireTokenSilent: async () => ({ accessToken: 'T' }) };
const storage = createOneDriveStorage(instance, [{ homeAccountId: 'me' }]);
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body });

afterEach(() => { vi.unstubAllGlobals(); });

test('이름 규칙 — 매일 백업과 시각이 붙은 백업', () => {
  const now = new Date(2026, 10, 8, 9, 5, 7);
  expect(backupName(now)).toBe('ledger-2026-11-08.db');
  expect(backupName(now, { daily: false })).toBe('ledger-2026-11-08-090507.db');
  expect(parseBackupName('ledger-2026-11-08.db')).toEqual({ date: '2026-11-08', time: '', daily: true });
  expect(parseBackupName('ledger-2026-11-08-090507.db')).toEqual({ date: '2026-11-08', time: '09:05:07', daily: false });
  expect(backupName(now, { daily: false, seq: 2 })).toBe('ledger-2026-11-08-090507-2.db');
  expect(parseBackupName('ledger-2026-11-08-090507-2.db')).toEqual({ date: '2026-11-08', time: '09:05:07', daily: false });
  expect(parseBackupName('ledger.db')).toBeNull();
  expect(parseBackupName('메모.txt')).toBeNull();
  expect(BACKUP_DIR).toBe('Apps/financial-ledger/backups');
});

test('목록은 이름 규칙에 맞는 파일만, 최근 것부터 — 폴더가 없으면 빈 목록', async () => {
  const fetch = vi.fn(async () => json(200, {
    value: [
      { id: '1', name: 'ledger-2026-11-06.db', size: 2048, file: {}, lastModifiedDateTime: '2026-11-06T00:01:00Z' },
      { id: '2', name: 'ledger-2026-11-08-090507.db', size: 4096, file: {}, lastModifiedDateTime: '2026-11-08T00:05:07Z' },
      { id: '3', name: '다른 파일.xlsx', size: 1, file: {}, lastModifiedDateTime: '2026-11-09T00:00:00Z' },
      { id: '4', name: 'ledger-2026-11-07.db', folder: {}, lastModifiedDateTime: '2026-11-07T00:00:00Z' },
    ],
  }));
  vi.stubGlobal('fetch', fetch);
  const list = await listBackups(storage);
  expect(list.map(b => b.id)).toEqual(['2', '1']);
  expect(list[0]).toMatchObject({ name: 'ledger-2026-11-08-090507.db', size: 4096, daily: false, time: '09:05:07' });
  expect(fetch.mock.calls[0][0]).toContain('/me/drive/root:/Apps/financial-ledger/backups:/children');
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer T');

  vi.stubGlobal('fetch', vi.fn(async () => json(404, {})));
  expect(await listBackups(storage)).toEqual([]);
});

test('같은 이름이 있으면 덮어쓰지 않는다 (conflictBehavior=fail → 409면 false)', async () => {
  const fetch = vi.fn(async () => json(201, {}));
  vi.stubGlobal('fetch', fetch);
  expect(await uploadBackup(storage, 'ledger-2026-11-08.db', new Uint8Array([1]))).toBe(true);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toContain('/backups/ledger-2026-11-08.db:/content?@microsoft.graph.conflictBehavior=fail');
  expect(init.method).toBe('PUT');

  vi.stubGlobal('fetch', vi.fn(async () => json(409, {})));
  expect(await uploadBackup(storage, 'ledger-2026-11-08.db', new Uint8Array([1]))).toBe(false);

  await expect(uploadBackup(storage, 'ledger.db', new Uint8Array([1]))).rejects.toThrow(/이름 규칙/);
});

test('같은 초에 이미 백업이 있으면 번호를 붙여 새로 만든다', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json(409, {}))
    .mockResolvedValueOnce(json(201, {}));
  vi.stubGlobal('fetch', fetch);
  const name = await uploadNewBackup(storage, new Uint8Array([1]), new Date(2026, 10, 8, 9, 5, 7));
  expect(name).toBe('ledger-2026-11-08-090507-2.db');
  expect(fetch.mock.calls[1][0]).toContain('/backups/ledger-2026-11-08-090507-2.db:/content');
});

test('내려받기는 백업 파일만 — 다른 파일 id면 거절한다', async () => {
  const bytes = new Uint8Array([7, 8, 9]);
  vi.stubGlobal('fetch', vi.fn(async (url) => (url === 'https://dl/1'
    ? { ok: true, status: 200, arrayBuffer: async () => bytes.buffer }
    : json(200, { name: 'ledger-2026-11-08.db', '@microsoft.graph.downloadUrl': 'https://dl/1' }))));
  expect(Array.from(await downloadBackup(storage, 'abc'))).toEqual([7, 8, 9]);

  const fetch = vi.fn(async () => json(200, { name: 'ledger.db', '@microsoft.graph.downloadUrl': 'https://dl/2' }));
  vi.stubGlobal('fetch', fetch);
  await expect(downloadBackup(storage, 'main')).rejects.toThrow(/백업 파일이 아닙니다/);
  expect(fetch.mock.calls.map(([url]) => url)).not.toContain('https://dl/2'); // 이름을 보고 내용은 받지 않는다
});

test('정리는 최근 keep개를 남기고 나머지 백업만 지운다', async () => {
  const value = Array.from({ length: 5 }, (_, i) => ({
    id: `b${i}`, name: `ledger-2026-11-0${i + 1}.db`, size: 1, file: {}, lastModifiedDateTime: `2026-11-0${i + 1}T00:00:00Z`,
  }));
  const fetch = vi.fn(async (url, init = {}) => (init.method === 'DELETE' ? json(204, {}) : json(200, { value })));
  vi.stubGlobal('fetch', fetch);
  expect(await pruneBackups(storage, 3)).toBe(2);
  const deleted = fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url.split('/').pop());
  expect(deleted.sort()).toEqual(['b0', 'b1']); // 가장 오래된 둘
});
