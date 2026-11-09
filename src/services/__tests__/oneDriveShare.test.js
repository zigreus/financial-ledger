/**
 * @vitest-environment jsdom
 */
// OneDrive — 다른 계정이 공유한 가계부와 주인의 초대 (ROADMAP M-2). 요청 모양을 확인한다(Graph는 가짜 fetch)
import {
  createOneDriveStorage, isPersonalMicrosoftAccount, sharedLedgerKey, SHARED_GONE_MESSAGE,
} from '../storage/oneDrive';
import { ConflictError } from '../storage/provider';

const instance = { acquireTokenSilent: async () => ({ accessToken: 'T' }) };
const ME = [{ homeAccountId: 'uid.9188040d-6c67-4c5b-b112-36a304b66dad', tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad', name: '엄마' }];
const REF = { driveId: 'abc123', itemId: 'ABC123!45' };
const SHARED_URL = 'https://graph.microsoft.com/v1.0/drives/abc123/items/ABC123!45';
const SHARED_BACKUPS = 'https://graph.microsoft.com/v1.0/me/drive/root:/Apps/financial-ledger/shared-backups/abc123_ABC123_45';

const ok = (body, extra = {}) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, ...extra });
const fail = status => ({ ok: false, status, statusText: String(status), json: async () => ({}) });

let calls;
function route(handler) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url: decodeURIComponent(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    return handler(decodeURIComponent(url), init);
  }));
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('공유받은 가계부 저장소', () => {
  test('그 파일을 읽고 쓰고(If-Match), 남긴 사본은 내 앱 폴더의 shared-backups에만, 열쇠는 가계부마다 따로 — 설정 파일은 내 앱 폴더', async () => {
    route((url, init) => {
      if (url === SHARED_URL) return ok({ eTag: 'e1', '@microsoft.graph.downloadUrl': 'https://dl/x' });
      if (url === 'https://dl/x') return ok({});
      if (url === `${SHARED_URL}?$select=eTag`) return ok({ eTag: 'e1' });
      if (url === `${SHARED_URL}/content` && init.method === 'PUT') return ok({ eTag: 'e2' });
      if (url.includes('/me/drive/root:/Apps/financial-ledger/ai-settings.json')) return fail(404);
      if (url === `${SHARED_BACKUPS}:/children?$top=200`) return fail(404);
      if (url.startsWith(`${SHARED_BACKUPS}/ledger-2026-11-10.db:/content`) && init.method === 'PUT') return ok({});
      return fail(500);
    });
    const s = createOneDriveStorage(instance, ME, { ledger: REF });
    expect(s.isShared).toBe(true);
    expect(s.accountKey).toBe(ME[0].homeAccountId);
    expect(s.ledgerKey).toBe(sharedLedgerKey(ME[0].homeAccountId, REF));
    expect(s.ledgerKey).not.toBe(s.accountKey);
    expect(s.sharing).toBeUndefined();
    const read = await s.read();
    expect(read.version).toBe('e1');
    expect(await s.getVersion()).toBe('e1');
    expect(await s.write(new Uint8Array([9]), 'e1')).toBe('e2');
    const put = calls.find(c => c.method === 'PUT');
    expect(put.url).toBe(`${SHARED_URL}/content`);
    expect(put.headers['If-Match']).toBe('e1');
    expect(await s.listBackups()).toEqual([]);
    expect(await s.createBackup('ledger-2026-11-10.db', new Uint8Array([1]))).toBe(true);
    expect(await s.readSettings('ai-settings.json')).toEqual({ data: null, version: null });
    expect(calls.some(c => c.url.includes('/financial-ledger/backups'))).toBe(false);   // 내 가계부의 백업 목록과 섞지 않는다
    expect(calls.filter(c => c.url.includes('shared-backups')).every(c => c.url.startsWith(SHARED_BACKUPS))).toBe(true);
  });

  test('주인이 공유를 끊었거나 파일을 옮겼으면(404·403) 새로 만들지 않고 열 수 없다고 알린다', async () => {
    route(() => fail(404));
    const s = createOneDriveStorage(instance, ME, { ledger: REF });
    await expect(s.read()).rejects.toThrow(SHARED_GONE_MESSAGE);
    await expect(s.getVersion()).rejects.toThrow(SHARED_GONE_MESSAGE);
    await expect(s.write(new Uint8Array([1]), null)).rejects.toThrow(SHARED_GONE_MESSAGE);   // 파일 없이 새로 만들지 않는다
    route(() => fail(403));
    await expect(s.write(new Uint8Array([1]), 'e1')).rejects.toThrow(SHARED_GONE_MESSAGE);
    route(() => fail(412));
    await expect(s.write(new Uint8Array([1]), 'e1')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('주인 — 이메일로 초대, 함께 쓰는 사람', () => {
  const OWN_META = 'https://graph.microsoft.com/v1.0/me/drive/root:/Apps/financial-ledger/ledger.db?$select=id,parentReference';
  const ownMeta = () => ok({ id: 'MYITEM!1', parentReference: { driveId: 'mydrive' } });

  test('초대는 가계부 파일 하나에 쓰기 권한(로그인 필요) — 참여 링크에 쓸 번호를 돌려준다', async () => {
    route((url, init) => {
      if (url === OWN_META) return ownMeta();
      if (url.endsWith('/me/drive/items/MYITEM!1/invite') && init.method === 'POST') return ok({ value: [{ id: 'p1' }] });
      return fail(500);
    });
    const s = createOneDriveStorage(instance, ME);
    expect(s.isShared).toBe(false);
    const ref = await s.sharing.invite('dad@outlook.com', '함께 써요');
    expect(ref).toEqual({ driveId: 'mydrive', itemId: 'MYITEM!1' });
    const body = JSON.parse(calls.find(c => c.method === 'POST').body);
    expect(body).toEqual({
      recipients: [{ email: 'dad@outlook.com' }], message: '함께 써요', requireSignIn: true, sendInvitation: true, roles: ['write'],
    });
    expect(calls.some(c => c.url.includes('/Apps/financial-ledger/invite') || c.url.includes('financial-ledger:/invite'))).toBe(false);   // 앱 폴더는 공유하지 않는다
  });

  test('잘못된 이메일·가계부 파일이 없을 때는 이유를 알린다', async () => {
    route(url => (url === OWN_META ? ownMeta() : fail(400)));
    const s = createOneDriveStorage(instance, ME);
    await expect(s.sharing.invite('x', '')).rejects.toThrow('이메일 주소를 확인하세요');
    route(() => fail(404));
    await expect(s.sharing.invite('dad@outlook.com', '')).rejects.toThrow('가계부 파일이 아직 없습니다');
    expect(await s.sharing.ownLedgerRef()).toBeNull();
    expect(await s.sharing.listMembers()).toEqual([]);
  });

  test('함께 쓰는 사람 — 물려받은 권한·링크 공유는 빼고, 주인은 표시해 두며, 빼기는 그 권한을 지운다', async () => {
    route((url, init) => {
      if (url === OWN_META) return ownMeta();
      if (url.endsWith('/me/drive/items/MYITEM!1/permissions') && (init.method || 'GET') === 'GET') {
        return ok({
          value: [
            { id: 'own', roles: ['owner'], grantedToV2: { user: { displayName: '엄마', email: 'mom@outlook.com' } } },
            { id: 'p1', roles: ['write'], grantedToV2: { user: { displayName: '아빠', email: 'dad@outlook.com' } } },
            { id: 'p2', roles: ['write'], invitation: { email: 'kid@outlook.com' } },
            { id: 'p3', roles: ['read'], link: { type: 'view' } },
            { id: 'p4', roles: ['write'], inheritedFrom: { id: 'folder' }, grantedToV2: { user: { displayName: '누군가' } } },
            { id: 'p5', roles: ['write'], link: { type: 'edit' }, grantedToIdentitiesV2: [{ user: { displayName: '할머니', email: 'grandma@outlook.com' } }] },
            { id: 'p6', roles: ['write'], grantedTo: { user: { displayName: '삼촌' } } },
          ],
        });
      }
      if (url.endsWith('/me/drive/items/MYITEM!1/permissions/p1') && init.method === 'DELETE') return { ok: true, status: 204 };
      return fail(500);
    });
    const s = createOneDriveStorage(instance, ME);
    expect(await s.sharing.listMembers()).toEqual([
      { id: 'own', name: '엄마', email: 'mom@outlook.com', owner: true },
      { id: 'p1', name: '아빠', email: 'dad@outlook.com', owner: false },
      { id: 'p2', name: '', email: 'kid@outlook.com', owner: false },
      { id: 'p5', name: '할머니', email: 'grandma@outlook.com', owner: false },   // 특정 사람에게 준 링크 권한
      { id: 'p6', name: '삼촌', email: '', owner: false },                          // 예전 모양(grantedTo)
    ]);
    await s.sharing.removeMember('p1');
    expect(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/permissions/p1'))).toBe(true);
  });

  test('참여 링크를 열 때 — 열 수 있으면 주인 이름, 없으면 열 수 없다고', async () => {
    route(url => (url.startsWith(SHARED_URL) ? ok({ name: 'ledger.db', shared: { owner: { user: { displayName: '엄마' } } } }) : fail(500)));
    const s = createOneDriveStorage(instance, ME);
    expect(await s.sharing.inspectShared(REF)).toEqual({ name: 'ledger.db', ownerName: '엄마' });
    route(() => fail(403));
    await expect(s.sharing.inspectShared(REF)).rejects.toThrow(SHARED_GONE_MESSAGE);
  });
});

test('개인 Microsoft 계정만 함께 쓰기 — 회사·학교 계정은 아직', () => {
  expect(isPersonalMicrosoftAccount(ME[0])).toBe(true);
  expect(isPersonalMicrosoftAccount({ homeAccountId: 'u.9188040d-6c67-4c5b-b112-36a304b66dad' })).toBe(true);
  expect(isPersonalMicrosoftAccount({ homeAccountId: 'u.contoso-tenant', tenantId: 'contoso-tenant' })).toBe(false);
  expect(isPersonalMicrosoftAccount(null)).toBe(false);
});
