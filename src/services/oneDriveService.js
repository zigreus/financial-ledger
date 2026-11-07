import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { loginRequest } from '../auth/msalConfig';
import { ONEDRIVE_DB_PATH } from '../config';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const ITEM_URL = `${GRAPH_BASE}/me/drive/root:/${ONEDRIVE_DB_PATH}`;

/** 다른 기기가 먼저 저장해서 내 저장이 거절됨 (HTTP 412/409) — 최신 파일을 받아 합친 뒤 다시 저장해야 한다 */
export class ConflictError extends Error {
  constructor() {
    super('다른 기기에서 가계부가 먼저 저장되었습니다');
    this.name = 'ConflictError';
  }
}

/** 재로그인이 필요해 리다이렉트를 시작함 — 미저장 변경은 브라우저에 보관되어 돌아온 뒤 다시 저장된다 */
export class ReauthRedirectError extends Error {
  constructor() {
    super('로그인이 만료되어 다시 로그인합니다… 저장 안 된 변경은 돌아온 뒤 자동으로 저장됩니다.');
    this.name = 'ReauthRedirectError';
  }
}

async function getToken(instance, accounts) {
  try {
    const res = await instance.acquireTokenSilent({ ...loginRequest, account: accounts[0] });
    return res.accessToken;
  } catch (e) {
    // 사용자가 직접 로그인해야 하는 경우에만 리다이렉트한다 (B-005).
    // 네트워크 오류 같은 일시적 실패는 그냥 실패로 돌려 나중에 다시 시도하게 한다.
    if (e instanceof InteractionRequiredAuthError) {
      await instance.acquireTokenRedirect({ ...loginRequest, account: accounts[0] });
      throw new ReauthRedirectError();
    }
    throw new Error(`인증 토큰을 받지 못했습니다 (${e.errorCode || e.message}) — 연결을 확인하세요`);
  }
}

async function graphFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error('네트워크 오류 — 인터넷 연결을 확인하세요');
  }
}

/** OneDrive 파일의 현재 eTag. 파일이 없으면 null. */
export async function getRemoteETag(instance, accounts) {
  const token = await getToken(instance, accounts);
  const res = await graphFetch(`${ITEM_URL}?$select=eTag`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OneDrive 확인 오류: ${res.status} ${res.statusText}`);
  return (await res.json()).eTag || null;
}

/**
 * DB 파일과 그 시점의 eTag를 읽는다. 파일이 없으면 { data: null, eTag: null }.
 * 메타데이터(eTag)를 먼저 읽고 내용을 받는다 — 그 사이 파일이 바뀌면 내용이 eTag보다 새것일 수 있지만,
 * 그 경우 다음 저장이 412로 거절되어 다시 합치므로 안전하다.
 */
export async function readDbFromOneDrive(instance, accounts) {
  const token = await getToken(instance, accounts);
  const metaRes = await graphFetch(ITEM_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (metaRes.status === 404) return { data: null, eTag: null };
  if (!metaRes.ok) throw new Error(`OneDrive 읽기 오류: ${metaRes.status} ${metaRes.statusText}`);
  const meta = await metaRes.json();

  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  const res = downloadUrl
    ? await graphFetch(downloadUrl)
    : await graphFetch(`${ITEM_URL}:/content`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`OneDrive 읽기 오류: ${res.status} ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  return { data: new Uint8Array(buffer), eTag: meta.eTag || null };
}

/**
 * DB 파일을 저장한다. eTag를 주면 OneDrive의 파일이 그 상태일 때만 저장한다(If-Match).
 * 그 사이 다른 기기가 저장했으면 ConflictError를 던진다. 성공하면 새 eTag를 돌려준다.
 * eTag가 없으면(파일이 아직 없을 때) 새로 만들되, 그 사이 누가 만들었으면 덮어쓰지 않고 ConflictError.
 */
export async function writeDbToOneDrive(instance, accounts, dbBytes, eTag) {
  const token = await getToken(instance, accounts);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/octet-stream',
  };
  let url = `${ITEM_URL}:/content`;
  if (eTag) headers['If-Match'] = eTag;
  else url += '?@microsoft.graph.conflictBehavior=fail';

  const res = await graphFetch(url, { method: 'PUT', headers, body: dbBytes });
  if (res.status === 412 || res.status === 409) throw new ConflictError();
  if (!res.ok) throw new Error(`OneDrive 저장 오류: ${res.status} ${res.statusText}`);
  const item = await res.json().catch(() => ({}));
  return item.eTag || null;
}
