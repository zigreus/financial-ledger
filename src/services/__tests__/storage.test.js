/**
 * @vitest-environment jsdom
 */
// 저장소 계약 (F-2, I-018) — 같은 테스트를 메모리 가짜와 OneDrive 구현(가짜 Graph 서버 위)에 모두 돌린다.
//  - 메모리 가짜: 병합 시나리오 테스트가 기대는 버전 규칙을 정말 지키는지
//  - OneDrive: 요청(If-Match·conflictBehavior=fail·읽는 순서)과 응답 코드 변환이 계약에 맞는지.
//    버전 규칙 자체는 가짜 Graph 서버가 실제 Graph를 흉내 내 지킨다 — 실제 Graph의 동작을 증명하지는 않는다.
// 새 저장소(예: Google Drive)를 붙이면 contract('...')를 하나 더 부른다.
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { ConflictError, OfflineError, ReauthRedirectError } from '../storage/provider';
import { createMemoryStorage } from '../storage/memory';
import { createOneDriveStorage } from '../storage/oneDrive';

const bytesOf = (...n) => new Uint8Array(n);
const list = b => Array.from(b || []);

// ── 가짜 Graph 서버: 경로별 파일 하나, eTag 조건부 저장(If-Match·conflictBehavior=fail)을 실제처럼 지킨다 ──
const GRAPH = 'https://graph.microsoft.com/v1.0';
function fakeGraph() {
  const files = new Map(); // path → { id, name, bytes, eTag, modified }
  let n = 0;
  const reply = (status, body = {}, bytes = null) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => new TextDecoder().decode(bytes || new Uint8Array()),
    arrayBuffer: async () => (bytes || new Uint8Array()).slice().buffer,
  });
  const meta = f => ({ id: f.id, name: f.name, eTag: f.eTag, size: f.bytes.length, file: {}, lastModifiedDateTime: f.modified, '@microsoft.graph.downloadUrl': `https://download.test/${f.id}` });
  const byId = id => [...files.entries()].find(([, f]) => f.id === id);
  const toBytes = body => (typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body));

  const fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    const dl = /^https:\/\/download\.test\/(.+)$/.exec(url);
    if (dl) { const hit = byId(dl[1]); return hit ? reply(200, {}, hit[1].bytes) : reply(404); }
    if (init.headers?.Authorization !== 'Bearer T') return reply(401);

    const item = new RegExp(`^${GRAPH}/me/drive/items/([^/?]+)$`).exec(url);
    if (item) {
      const hit = byId(decodeURIComponent(item[1]));
      if (method === 'DELETE') { if (hit) files.delete(hit[0]); return reply(hit ? 204 : 404); }
      return hit ? reply(200, meta(hit[1])) : reply(404);
    }

    const m = new RegExp(`^${GRAPH}/me/drive/root:/(.+?)(:/content|:/children)?(\\?.*)?$`).exec(url);
    if (!m) return reply(400);
    const path = decodeURIComponent(m[1]);
    const query = m[3] || '';
    if (m[2] === ':/children') {
      const kids = [...files.entries()].filter(([p]) => p.startsWith(`${path}/`)).map(([, f]) => meta(f));
      return kids.length ? reply(200, { value: kids }) : reply(404);
    }
    const found = files.get(path);
    if (method === 'PUT') {
      const ifMatch = init.headers['If-Match'];
      if (ifMatch && (!found || found.eTag !== ifMatch)) return reply(412);
      if (query.includes('conflictBehavior=fail') && found) return reply(409);
      n += 1;
      const next = { id: found?.id || `id${n}`, name: path.split('/').pop(), bytes: toBytes(init.body), eTag: `"etag-${n}"`, modified: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString() };
      files.set(path, next);
      return reply(found ? 200 : 201, meta(next));
    }
    if (!found) return reply(404);
    if (m[2] === ':/content') return reply(200, {}, found.bytes);
    return reply(200, query.includes('$select=eTag') ? { eTag: found.eTag } : meta(found));
  });

  return {
    fetch,
    /** 다른 기기가 저장한 것처럼 바꾼다 */
    put(path, body) { n += 1; files.set(path, { id: files.get(path)?.id || `id${n}`, name: path.split('/').pop(), bytes: toBytes(body), eTag: `"etag-${n}"`, modified: new Date().toISOString() }); },
    remove(path) { files.delete(path); },
  };
}

const LEDGER = 'Apps/financial-ledger/ledger.db';
const instance = { acquireTokenSilent: async () => ({ accessToken: 'T' }) };

/** 같은 계약 테스트 — setup은 { storage, otherDeviceSaves(bytes), removeLedger(), putSettingsText(name, text) }를 돌려준다 */
function contract(name, setup) {
  describe(`${name} — 저장소 계약`, () => {
    let s;
    let ctx;
    beforeEach(() => { ctx = setup(); s = ctx.storage; });
    afterEach(() => { vi.unstubAllGlobals(); });

    test('파일이 없으면 null, 버전 없이 저장하면 새로 만들고 새 버전을 돌려준다', async () => {
      expect(await s.read()).toEqual({ bytes: null, version: null });
      expect(await s.getVersion()).toBeNull();
      const v1 = await s.write(bytesOf(1, 2), null);
      expect(v1).toBeTruthy();
      const got = await s.read();
      expect(list(got.bytes)).toEqual([1, 2]);
      expect(got.version).toBe(v1);
      expect(await s.getVersion()).toBe(v1);
    });

    test('읽은 버전으로만 저장된다 — 그 사이 다른 기기가 저장했으면 ConflictError이고 파일은 그대로', async () => {
      const v1 = await s.write(bytesOf(1), null);
      const v2 = await s.write(bytesOf(2), v1);
      expect(v2).toBeTruthy();
      expect(v2).not.toBe(v1);
      await expect(s.write(bytesOf(3), v1)).rejects.toBeInstanceOf(ConflictError);

      ctx.otherDeviceSaves(bytesOf(9));
      await expect(s.write(bytesOf(4), v2)).rejects.toBeInstanceOf(ConflictError);
      expect(list((await s.read()).bytes)).toEqual([9]);
    });

    test('파일이 이미 있으면 버전 없이 저장해도 덮어쓰지 않는다', async () => {
      ctx.otherDeviceSaves(bytesOf(7));
      await expect(s.write(bytesOf(1), null)).rejects.toBeInstanceOf(ConflictError);
      expect(list((await s.read()).bytes)).toEqual([7]);
    });

    test('파일이 사라졌으면 옛 버전으로는 저장되지 않고, 버전 없이 다시 만든다', async () => {
      const v1 = await s.write(bytesOf(1), null);
      ctx.removeLedger();
      await expect(s.write(bytesOf(2), v1)).rejects.toBeInstanceOf(ConflictError);
      expect(await s.write(bytesOf(3), null)).toBeTruthy();
      expect(list((await s.read()).bytes)).toEqual([3]);
    });

    test('백업 폴더: 없으면 빈 목록, 같은 이름은 덮어쓰지 않고 false, 읽기·지우기', async () => {
      expect(await s.listBackups()).toEqual([]);
      expect(await s.createBackup('ledger-2026-11-01.db', bytesOf(1))).toBe(true);
      expect(await s.createBackup('ledger-2026-11-01.db', bytesOf(2))).toBe(false);
      expect(await s.createBackup('ledger-2026-11-02.db', bytesOf(3, 4))).toBe(true);

      const files = await s.listBackups();
      expect(files.map(f => f.name).sort()).toEqual(['ledger-2026-11-01.db', 'ledger-2026-11-02.db']);
      const second = files.find(f => f.name === 'ledger-2026-11-02.db');
      expect(second).toMatchObject({ size: 2 });
      expect(typeof second.id).toBe('string');
      expect(second.modified > files.find(f => f.name === 'ledger-2026-11-01.db').modified).toBe(true);

      const firstId = files.find(f => f.name === 'ledger-2026-11-01.db').id;
      const seen = [];
      const read = await s.readBackup(firstId, name => { seen.push(name); return true; });
      expect(seen).toEqual(['ledger-2026-11-01.db']);
      expect(list(read)).toEqual([1]); // 같은 이름으로 다시 만들려던 내용으로 바뀌지 않았다
      expect(await s.readBackup(firstId, () => false)).toBeNull(); // 이름이 맞지 않으면 내용을 주지 않는다

      expect(await s.deleteBackup(second.id)).toBe(true);
      expect(await s.deleteBackup(second.id)).toBe(true); // 이미 없어도 지운 것으로 본다
      expect((await s.listBackups()).map(f => f.name)).toEqual(['ledger-2026-11-01.db']);
      // 백업은 가계부 파일과 별개다
      expect(await s.read()).toEqual({ bytes: null, version: null });
    });

    test('설정 파일: 없으면 null, 가계부와 같은 버전 규칙, JSON이 아니면 data만 null', async () => {
      expect(await s.readSettings('ai-settings.json')).toEqual({ data: null, version: null });
      await s.writeSettings('ai-settings.json', { a: 1 }, null);
      const first = await s.readSettings('ai-settings.json');
      expect(first.data).toEqual({ a: 1 });
      await expect(s.writeSettings('ai-settings.json', { a: 2 }, null)).rejects.toBeInstanceOf(ConflictError);
      await s.writeSettings('ai-settings.json', { a: 3 }, first.version);
      await expect(s.writeSettings('ai-settings.json', { a: 4 }, first.version)).rejects.toBeInstanceOf(ConflictError);
      expect((await s.readSettings('ai-settings.json')).data).toEqual({ a: 3 });
      expect(await s.read()).toEqual({ bytes: null, version: null }); // 가계부 파일과 섞이지 않는다

      ctx.putSettingsText('broken.json', '{not json');
      const broken = await s.readSettings('broken.json');
      expect(broken.data).toBeNull();
      expect(broken.version).toBeTruthy();
      await s.writeSettings('broken.json', { fixed: true }, broken.version);
      expect((await s.readSettings('broken.json')).data).toEqual({ fixed: true });
    });

    test('계정 키를 알려 준다', () => {
      expect(s.accountKey).toBe('me');
    });
  });
}

contract('메모리', () => {
  const storage = createMemoryStorage({ accountKey: 'me' });
  return {
    storage,
    otherDeviceSaves: b => storage.replace(b),
    removeLedger: () => storage.remove(),
    putSettingsText: (name, text) => storage.putSettingsText(name, text),
  };
});

contract('OneDrive(가짜 Graph)', () => {
  const graph = fakeGraph();
  vi.stubGlobal('fetch', graph.fetch);
  return {
    storage: createOneDriveStorage(instance, [{ homeAccountId: 'me' }]),
    otherDeviceSaves: b => graph.put(LEDGER, b),
    removeLedger: () => graph.remove(LEDGER),
    putSettingsText: (name, text) => graph.put(`Apps/financial-ledger/${name}`, text),
  };
});

describe('OneDrive 요청 모양 (F-2로 옮기기 전과 같은지)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  test('가계부: 버전 확인은 eTag만, 저장은 If-Match로, 처음 만들 때는 conflictBehavior=fail로', async () => {
    const graph = fakeGraph();
    vi.stubGlobal('fetch', graph.fetch);
    const s = createOneDriveStorage(instance, [{ homeAccountId: 'me' }]);
    const v1 = await s.write(bytesOf(1), null);
    await s.write(bytesOf(2), v1);
    await s.getVersion();
    const calls = graph.fetch.mock.calls;
    expect(calls[0][0]).toBe(`${GRAPH}/me/drive/root:/${LEDGER}:/content?@microsoft.graph.conflictBehavior=fail`);
    expect(calls[0][1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer T' } });
    expect(calls[0][1].headers['If-Match']).toBeUndefined();
    expect(calls[1][0]).toBe(`${GRAPH}/me/drive/root:/${LEDGER}:/content`);
    expect(calls[1][1].headers['If-Match']).toBe(v1);
    expect(calls[2][0]).toBe(`${GRAPH}/me/drive/root:/${LEDGER}?$select=eTag`);
  });

  test('가계부를 읽을 때 버전을 먼저 읽는다 — 그 사이 바뀌면 내용이 더 새것이고, 그 위의 저장은 거절된다', async () => {
    const graph = fakeGraph();
    graph.put(LEDGER, bytesOf(1));
    const realFetch = graph.fetch.getMockImplementation();
    let changed = false;
    graph.fetch.mockImplementation(async (url, init) => {
      const res = await realFetch(url, init);
      if (!changed && url === `${GRAPH}/me/drive/root:/${LEDGER}`) { changed = true; graph.put(LEDGER, bytesOf(2)); } // 버전을 읽은 직후 다른 기기가 저장
      return res;
    });
    vi.stubGlobal('fetch', graph.fetch);
    const s = createOneDriveStorage(instance, [{ homeAccountId: 'me' }]);
    const got = await s.read();
    expect(list(got.bytes)).toEqual([2]);
    expect(got.version).not.toBe(await s.getVersion()); // 버전은 옛것
    await expect(s.write(bytesOf(3), got.version)).rejects.toBeInstanceOf(ConflictError);
  });

  test('저장 오류는 충돌로 보지 않고 그대로 알린다 — 결과를 모르는 업로드로 남겨야 하므로', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) })));
    const s = createOneDriveStorage(instance, [{ homeAccountId: 'me' }]);
    const err = await s.write(bytesOf(1), '"e1"').catch(e => e);
    expect(err).not.toBeInstanceOf(ConflictError);
    expect(err.message).toBe('OneDrive 저장 오류: 503 Service Unavailable');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(s.read()).rejects.toThrow('네트워크 오류 — 인터넷 연결을 확인하세요');
  });

  test('가계부를 쓰다 다시 로그인해야 하면 로그인 화면으로 넘기고 ReauthRedirectError, 설정 파일은 넘기지 않고 실패만', async () => {
    const msal = {
      acquireTokenSilent: async () => { throw new InteractionRequiredAuthError('interaction_required'); },
      acquireTokenRedirect: vi.fn(async () => {}),
    };
    vi.stubGlobal('fetch', vi.fn());
    const s = createOneDriveStorage(msal, [{ homeAccountId: 'me' }]);
    await expect(s.read()).rejects.toBeInstanceOf(ReauthRedirectError);
    expect(msal.acquireTokenRedirect).toHaveBeenCalledTimes(1);
    await expect(s.readSettings('ai-settings.json')).rejects.toThrow('다시 로그인해야 OneDrive를 쓸 수 있습니다');
    expect(msal.acquireTokenRedirect).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('계정이 없으면 계정 키는 빈 문자열', () => {
    expect(createOneDriveStorage(instance, []).accountKey).toBe('');
  });

  describe('연결이 없으면 OfflineError (I-024)', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    test('요청이 나가지 못하면 OfflineError — 오류 문구는 그대로', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
      const s = createOneDriveStorage(instance, [{ homeAccountId: 'me' }]);
      const err = await s.read().catch(e => e);
      expect(err).toBeInstanceOf(OfflineError);
      expect(err.message).toBe('네트워크 오류 — 인터넷 연결을 확인하세요');
      await expect(s.write(bytesOf(1), '"e1"')).rejects.toBeInstanceOf(OfflineError);
    });

    test('연결이 없을 때 다시 로그인해야 해도 로그인 화면으로 넘기지 않는다 — 열리지 않는 페이지로 가 앱을 잃지 않게', async () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      const msal = {
        acquireTokenSilent: async () => { throw new InteractionRequiredAuthError('interaction_required'); },
        acquireTokenRedirect: vi.fn(async () => {}),
      };
      vi.stubGlobal('fetch', vi.fn());
      const s = createOneDriveStorage(msal, [{ homeAccountId: 'me' }]);
      await expect(s.read()).rejects.toBeInstanceOf(OfflineError);
      expect(msal.acquireTokenRedirect).not.toHaveBeenCalled();
    });

    test('토큰을 받으러 나가다 연결 오류로 실패해도 OfflineError (onLine이 true로 남는 브라우저)', async () => {
      const msal = { acquireTokenSilent: async () => { const e = new Error('no network'); e.errorCode = 'no_network_connectivity'; throw e; } };
      vi.stubGlobal('fetch', vi.fn());
      const s = createOneDriveStorage(msal, [{ homeAccountId: 'me' }]);
      await expect(s.getVersion()).rejects.toBeInstanceOf(OfflineError);
      const other = { acquireTokenSilent: async () => { const e = new Error('bad'); e.errorCode = 'invalid_grant_x'; throw e; } };
      const err = await createOneDriveStorage(other, [{ homeAccountId: 'me' }]).getVersion().catch(e => e);
      expect(err).not.toBeInstanceOf(OfflineError);
      expect(err.message).toMatch(/인증 토큰을 받지 못했습니다/);
    });
  });
});
