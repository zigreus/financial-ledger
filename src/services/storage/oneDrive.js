/**
 * OneDrive 저장소 (Microsoft Graph) — ./provider.js의 계약을 구현한다 (ROADMAP F-2, I-018).
 *
 *  - 가계부: Apps/financial-ledger/ledger.db. 버전은 OneDrive eTag이고, 저장은 If-Match로만 한다 (B-001).
 *  - 백업: Apps/financial-ledger/backups/ (I-014)
 *  - 설정: Apps/financial-ledger/<이름>.json (I-015) — 가계부 DB와 섞지 않는다
 *
 * 화면은 이 파일을 직접 부르지 않는다. App이 createOneDriveStorage로 만든 저장소를 useLedgerSync·aiSettingsSync에 넘긴다.
 */
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { loginRequest } from '../../auth/msalConfig';
import { ONEDRIVE_DB_PATH } from '../../config';
import { ConflictError, OfflineError, ReauthRedirectError } from './provider';

// MSAL이 토큰을 받으러 나가다 연결이 없어 실패한 오류 (BrowserAuthError·ClientAuthError의 errorCode)
const MSAL_NETWORK_ERRORS = new Set(['no_network_connectivity', 'endpoints_resolution_error', 'post_request_failed', 'get_request_failed', 'network_error']);
const offlineNow = () => typeof navigator !== 'undefined' && navigator.onLine === false;

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const ITEM_URL = `${GRAPH_BASE}/me/drive/root:/${ONEDRIVE_DB_PATH}`;
const APP_FOLDER = ONEDRIVE_DB_PATH.replace(/[^/]+$/, ''); // 'Apps/financial-ledger/'
export const BACKUP_DIR = `${APP_FOLDER}backups`;           // 'Apps/financial-ledger/backups'
const BACKUP_DIR_URL = `${GRAPH_BASE}/me/drive/root:/${BACKUP_DIR}`;

/**
 * interactive: false — 다시 로그인해야 해도 로그인 화면으로 넘어가지 않고 실패만 돌려준다.
 * 화면 뒤에서 도는 부가 기능(예: AI 설정 공유)이 입력 중인 화면을 떠나게 하면 안 되기 때문이다.
 */
async function getToken(instance, accounts, { interactive = true } = {}) {
  try {
    const res = await instance.acquireTokenSilent({ ...loginRequest, account: accounts[0] });
    return res.accessToken;
  } catch (e) {
    // 연결이 없으면 로그인 화면으로 넘기지 않는다 — 열리지 않는 페이지로 가 입력 중인 앱을 잃는다 (I-024)
    if (offlineNow() || MSAL_NETWORK_ERRORS.has(e?.errorCode)) throw new OfflineError();
    // 사용자가 직접 로그인해야 하는 경우에만 리다이렉트한다 (B-005).
    // 네트워크 오류 같은 일시적 실패는 그냥 실패로 돌려 나중에 다시 시도하게 한다.
    if (e instanceof InteractionRequiredAuthError && !interactive) {
      throw new Error('다시 로그인해야 OneDrive를 쓸 수 있습니다');
    }
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
    throw new OfflineError();
  }
}

// ── 가계부 파일 ──────────────────────────────────────────────────

/** OneDrive 파일의 현재 eTag. 파일이 없으면 null. */
async function getRemoteETag(instance, accounts) {
  const token = await getToken(instance, accounts);
  const res = await graphFetch(`${ITEM_URL}?$select=eTag`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OneDrive 확인 오류: ${res.status} ${res.statusText}`);
  return (await res.json()).eTag || null;
}

/**
 * DB 파일과 그 시점의 eTag를 읽는다. 파일이 없으면 { bytes: null, version: null }.
 * 메타데이터(eTag)를 먼저 읽고 내용을 받는다 — 그 사이 파일이 바뀌면 내용이 eTag보다 새것일 수 있지만,
 * 그 경우 다음 저장이 412로 거절되어 다시 합치므로 안전하다.
 */
async function readDb(instance, accounts) {
  const token = await getToken(instance, accounts);
  const metaRes = await graphFetch(ITEM_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (metaRes.status === 404) return { bytes: null, version: null };
  if (!metaRes.ok) throw new Error(`OneDrive 읽기 오류: ${metaRes.status} ${metaRes.statusText}`);
  const meta = await metaRes.json();

  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  const res = downloadUrl
    ? await graphFetch(downloadUrl)
    : await graphFetch(`${ITEM_URL}:/content`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`OneDrive 읽기 오류: ${res.status} ${res.statusText}`);
  const buffer = await res.arrayBuffer();
  return { bytes: new Uint8Array(buffer), version: meta.eTag || null };
}

/**
 * DB 파일을 저장한다. eTag를 주면 OneDrive의 파일이 그 상태일 때만 저장한다(If-Match).
 * 그 사이 다른 기기가 저장했으면 ConflictError를 던진다. 성공하면 새 eTag를 돌려준다.
 * eTag가 없으면(파일이 아직 없을 때) 새로 만들되, 그 사이 누가 만들었으면 덮어쓰지 않고 ConflictError.
 * 파일이 사라진 뒤의 If-Match 저장은 412(→ ConflictError)로 온다고 본다(HTTP 규칙). 실제 Graph로는 확인하지 않았다 —
 * 404로 온다면 '저장 오류'가 되어 다시 합치지 못하므로, 그때는 여기서 404도 ConflictError로 바꾼다.
 */
async function writeDb(instance, accounts, dbBytes, eTag) {
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

// ── 백업 폴더 (I-014) ────────────────────────────────────────────

/** 백업 폴더의 파일 — 하위 폴더는 뺀다. 폴더가 아직 없으면 []. 200개씩 최대 5쪽. */
async function listBackupFiles(instance, accounts) {
  const token = await getToken(instance, accounts);
  const headers = { Authorization: `Bearer ${token}` };
  const out = [];
  let url = `${BACKUP_DIR_URL}:/children?$top=200`;
  for (let page = 0; url && page < 5; page += 1) {
    const res = await graphFetch(url, { headers });
    if (res.status === 404) return []; // 아직 백업 폴더가 없음
    if (!res.ok) throw new Error(`백업 목록 오류: ${res.status} ${res.statusText}`);
    const body = await res.json();
    (body.value || []).forEach(item => {
      if (item.file) out.push({ id: item.id, name: item.name, size: item.size || 0, modified: item.lastModifiedDateTime || '' });
    });
    url = body['@odata.nextLink'] || null;
  }
  return out;
}

/** 백업 파일을 만든다. 같은 이름이 이미 있으면 덮어쓰지 않고 false. */
async function createBackupFile(instance, accounts, name, bytes) {
  const token = await getToken(instance, accounts);
  const res = await graphFetch(`${BACKUP_DIR_URL}/${name}:/content?@microsoft.graph.conflictBehavior=fail`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  if (res.status === 409) return false;
  if (!res.ok) throw new Error(`백업 저장 오류: ${res.status} ${res.statusText}`);
  return true;
}

/** 백업 파일 내용 — 이름을 먼저 보고 accept(name)이 거짓이면 내용을 받지 않고 null */
async function readBackupFile(instance, accounts, id, accept) {
  const token = await getToken(instance, accounts);
  const itemUrl = `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(id)}`;
  const metaRes = await graphFetch(itemUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!metaRes.ok) throw new Error(`백업 읽기 오류: ${metaRes.status} ${metaRes.statusText}`);
  const meta = await metaRes.json();
  if (!accept(meta.name)) return null;
  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  const res = downloadUrl
    ? await graphFetch(downloadUrl)
    : await graphFetch(`${itemUrl}/content`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`백업 읽기 오류: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** 백업 파일을 지운다. 지웠거나 이미 없으면 true. */
async function deleteBackupFile(instance, accounts, id) {
  const token = await getToken(instance, accounts);
  const res = await graphFetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok || res.status === 404;
}

// ── 계정 설정 파일 (가계부 DB와 별도) ─────────────────────────────
// 같은 Microsoft 계정으로 로그인한 기기끼리 나눠 쓰는 작은 JSON 설정 (예: ai-settings.json).
// 가계부 DB(ledger.db)와 섞지 않는다 — DB는 변경 기록·병합·내보내기로 여기저기 복사된다.

const settingsUrl = name => `${GRAPH_BASE}/me/drive/root:/${APP_FOLDER}${encodeURIComponent(name)}`;

// 화면 뒤에서 도는 동기화라 로그인 화면으로 넘어가지 않고(interactive: false), 응답이 없으면 15초 뒤 포기한다
const SETTINGS_TIMEOUT_MS = 15000;
const settingsSignal = () => (
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(SETTINGS_TIMEOUT_MS) : undefined
);

/** 설정 동기화용 토큰 — 로그인 화면으로 넘어가지 않고, 토큰 갱신이 멈춰도 같은 시간 안에 포기한다 */
function settingsToken(instance, accounts) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('OneDrive 응답이 없습니다 — 연결을 확인하세요')), SETTINGS_TIMEOUT_MS);
  });
  return Promise.race([getToken(instance, accounts, { interactive: false }), timeout])
    .finally(() => clearTimeout(timer));
}

/**
 * 설정 파일과 그 시점의 eTag를 읽는다. 파일이 없으면 { data: null, version: null }.
 * 내용이 JSON이 아니면 data만 null이다(eTag는 있으므로 덮어써 고칠 수 있다).
 */
async function readSettingsFile(instance, accounts, name) {
  const token = await settingsToken(instance, accounts);
  const auth = { Authorization: `Bearer ${token}` };
  const metaRes = await graphFetch(settingsUrl(name), { headers: auth, signal: settingsSignal() });
  if (metaRes.status === 404) return { data: null, version: null };
  if (!metaRes.ok) throw new Error(`OneDrive 설정 읽기 오류: ${metaRes.status} ${metaRes.statusText}`);
  const meta = await metaRes.json();
  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  const res = downloadUrl
    ? await graphFetch(downloadUrl, { signal: settingsSignal() })
    : await graphFetch(`${settingsUrl(name)}:/content`, { headers: auth, signal: settingsSignal() });
  if (!res.ok) throw new Error(`OneDrive 설정 읽기 오류: ${res.status} ${res.statusText}`);
  let data = null;
  try { data = JSON.parse(await res.text()); } catch (e) { data = null; }
  return { data, version: meta.eTag || null };
}

/**
 * 설정 파일을 저장한다. 읽을 때의 eTag를 주면 그 상태일 때만 저장하고(If-Match),
 * eTag가 없으면(파일이 없었으면) 새로 만들되 그 사이 누가 만들었으면 덮어쓰지 않는다.
 * 그 사이 다른 기기가 저장했으면 ConflictError — 다시 읽어 합친 뒤 저장한다.
 */
async function writeSettingsFile(instance, accounts, name, data, eTag) {
  const token = await settingsToken(instance, accounts);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let url = `${settingsUrl(name)}:/content`;
  if (eTag) headers['If-Match'] = eTag;
  else url += '?@microsoft.graph.conflictBehavior=fail';
  const res = await graphFetch(url, { method: 'PUT', headers, body: JSON.stringify(data), signal: settingsSignal() });
  if (res.status === 412 || res.status === 409) throw new ConflictError();
  if (!res.ok) throw new Error(`OneDrive 설정 저장 오류: ${res.status} ${res.statusText}`);
}

/**
 * 로그인한 Microsoft 계정의 OneDrive 저장소 (./provider.js의 LedgerStorage).
 * @param {import('@azure/msal-browser').IPublicClientApplication} instance
 * @param {Array<{ homeAccountId?: string }>} accounts — MSAL 계정 목록(첫 계정을 쓴다)
 * @returns {import('./provider').LedgerStorage}
 */
export function createOneDriveStorage(instance, accounts) {
  return {
    accountKey: accounts?.[0]?.homeAccountId || '',
    read: () => readDb(instance, accounts),
    getVersion: () => getRemoteETag(instance, accounts),
    write: (bytes, version) => writeDb(instance, accounts, bytes, version),
    listBackups: () => listBackupFiles(instance, accounts),
    createBackup: (name, bytes) => createBackupFile(instance, accounts, name, bytes),
    readBackup: (id, accept) => readBackupFile(instance, accounts, id, accept),
    deleteBackup: id => deleteBackupFile(instance, accounts, id),
    readSettings: name => readSettingsFile(instance, accounts, name),
    writeSettings: (name, data, version) => writeSettingsFile(instance, accounts, name, data, version),
  };
}
