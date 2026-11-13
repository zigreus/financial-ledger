/**
 * OneDrive 저장소 (Microsoft Graph) — ./provider.js의 계약을 구현한다 (ROADMAP F-2, I-018).
 *
 *  - 가계부: Apps/financial-ledger/ledger.db. 버전은 OneDrive eTag이고, 저장은 If-Match로만 한다 (B-001).
 *    다른 계정이 공유한 가계부(M-2)는 /drives/{driveId}/items/{itemId} — 같은 버전 규칙. 매일 백업은 주인 기기만 만들고,
 *    넣지 못한 이 기기의 변경이 담긴 사본(I-035)은 내 앱 폴더의 shared-backups/<가계부>에 둔다.
 *    주인은 자기 가계부 파일을 이메일로 초대해 공유한다(invite, 구성원 목록·빼기 — 앱 폴더는 공유하지 않는다).
 *  - 백업: Apps/financial-ledger/backups/ (I-014)
 *  - 설정: Apps/financial-ledger/<이름>.json (I-015) — 가계부 DB와 섞지 않는다
 *
 * 화면은 이 파일을 직접 부르지 않는다. App이 createOneDriveStorage로 만든 저장소를 useLedgerSync·aiSettingsSync에 넘긴다.
 */
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { loginRequest } from '../../auth/msalConfig';
import { ONEDRIVE_DB_PATH } from '../../config';
import { ConflictError, OfflineError, ReauthRedirectError } from './provider';
import { poke, readBody, stallSignal, stalledReason, stopStall, untilStalled, uploadStallMs } from './stall';

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
async function getToken(instance, accounts, { interactive = true, signal } = {}) {
  try {
    // 토큰 갱신이 멈추면(약한 LTE) 끊는다 — 가계부 받기·저장이 영영 끝나지 않게 (stall.js)
    const res = await untilStalled(instance.acquireTokenSilent({ ...loginRequest, account: accounts[0] }), signal);
    return res.accessToken;
  } catch (e) {
    if (e instanceof OfflineError) throw e; // 멈춰 끊었다
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
    const res = await fetch(url, init);
    poke(init?.signal); // 응답이 왔다 — 멈춤 시계를 처음부터
    return res;
  } catch (e) {
    throw stalledReason(init?.signal) || new OfflineError();
  }
}

/** 가계부 파일을 다루는 동안의 멈춤 시계 — 끝나면(성공·실패) 멈춘다 */
async function watched(what, fn) {
  const signal = stallSignal(what);
  try {
    return await fn(signal);
  } catch (e) {
    // 작은 응답(JSON)을 읽다 끊긴 것도 멈춤으로 — 브라우저에 따라 그냥 AbortError로 올 수 있다
    throw stalledReason(signal) || e;
  } finally {
    stopStall(signal);
  }
}

// ── 가계부 파일 ──────────────────────────────────────────────────

/**
 * 가계부 파일이 있는 곳 — 내 가계부(앱 폴더의 ledger.db)이거나 다른 계정이 공유한 파일(M-2).
 * metaUrl: 파일 정보, contentUrl: 내용, shared: 공유받은 파일(없으면 새로 만들지 않고 '열 수 없음'으로 알린다)
 */
const OWN_TARGET = { metaUrl: ITEM_URL, contentUrl: `${ITEM_URL}:/content`, shared: false };
function sharedTarget({ driveId, itemId }) {
  const metaUrl = `${GRAPH_BASE}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
  return { metaUrl, contentUrl: `${metaUrl}/content`, shared: true };
}
/** 공유받은 가계부에 닿지 못함 — 주인이 공유를 끊었거나 파일을 옮겼다(404·403) */
export const SHARED_GONE_MESSAGE = '공유받은 가계부를 열 수 없습니다 — 주인이 공유를 끊었거나 가계부 파일을 지웠을 수 있어요. 내 가계부로 돌아가거나 주인에게 다시 초대를 부탁하세요';
function sharedGone(target, res) {
  return target.shared && (res.status === 404 || res.status === 403);
}

/** OneDrive 파일의 현재 eTag. 파일이 없으면 null. */
async function getRemoteETag(instance, accounts, target = OWN_TARGET) {
  return watched('OneDrive 확인', async (signal) => {
    const token = await getToken(instance, accounts, { signal });
    const res = await graphFetch(`${target.metaUrl}?$select=eTag`, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (sharedGone(target, res)) throw new Error(SHARED_GONE_MESSAGE);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`OneDrive 확인 오류: ${res.status} ${res.statusText}`);
    return (await res.json()).eTag || null;
  });
}

/**
 * DB 파일과 그 시점의 eTag를 읽는다. 파일이 없으면 { bytes: null, version: null }.
 * 메타데이터(eTag)를 먼저 읽고 내용을 받는다 — 그 사이 파일이 바뀌면 내용이 eTag보다 새것일 수 있지만,
 * 그 경우 다음 저장이 412로 거절되어 다시 합치므로 안전하다.
 */
async function readDb(instance, accounts, target = OWN_TARGET) {
  return watched('OneDrive 가계부 받기', async (signal) => {
    // 단계별 걸린 시간 — 느렸으면 동기화가 문제 알리기 기록에 남긴다(어디서 느린지 알 수 있게)
    const t0 = Date.now();
    const token = await getToken(instance, accounts, { signal });
    const t1 = Date.now();
    const metaRes = await graphFetch(target.metaUrl, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (sharedGone(target, metaRes)) throw new Error(SHARED_GONE_MESSAGE);
    if (metaRes.status === 404) return { bytes: null, version: null };
    if (!metaRes.ok) throw new Error(`OneDrive 읽기 오류: ${metaRes.status} ${metaRes.statusText}`);
    const meta = await metaRes.json();
    const t2 = Date.now();

    const downloadUrl = meta['@microsoft.graph.downloadUrl'];
    const res = downloadUrl
      ? await graphFetch(downloadUrl, { signal })
      : await graphFetch(target.contentUrl, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (!res.ok) throw new Error(`OneDrive 읽기 오류: ${res.status} ${res.statusText}`);
    const bytes = await readBody(res, signal);
    const timing = { stages: [['로그인 토큰', t1 - t0], ['파일 정보', t2 - t1], ['내용 받기', Date.now() - t2]], size: bytes.length };
    return { bytes, version: meta.eTag || null, timing };
  });
}

/**
 * DB 파일을 저장한다. eTag를 주면 OneDrive의 파일이 그 상태일 때만 저장한다(If-Match).
 * 그 사이 다른 기기가 저장했으면 ConflictError를 던진다. 성공하면 새 eTag를 돌려준다.
 * eTag가 없으면(파일이 아직 없을 때) 새로 만들되, 그 사이 누가 만들었으면 덮어쓰지 않고 ConflictError.
 * 파일이 사라진 뒤의 If-Match 저장은 412(→ ConflictError)로 온다고 본다(HTTP 규칙). 실제 Graph로는 확인하지 않았다 —
 * 404로 온다면 '저장 오류'가 되어 다시 합치지 못하므로, 그때는 여기서 404도 ConflictError로 바꾼다.
 */
async function writeDb(instance, accounts, dbBytes, eTag, target = OWN_TARGET) {
  // 공유받은 가계부는 주인 드라이브의 그 파일에만 쓴다 — 없으면 새로 만들지 않는다(다른 곳에 새 가계부가 생기지 않게)
  if (target.shared && !eTag) throw new Error(SHARED_GONE_MESSAGE);
  return watched('OneDrive 저장', async (signal) => {
    const token = await getToken(instance, accounts, { signal });
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    };
    let url = target.contentUrl;
    if (eTag) headers['If-Match'] = eTag;
    else url += '?@microsoft.graph.conflictBehavior=fail';

    // 올리는 동안은 진행을 볼 수 없다 — 파일 크기만큼 더 기다린다. 멈춰 끊기면 '올라갔는지 모르는 저장'(OfflineError)
    poke(signal, uploadStallMs(dbBytes));
    const res = await graphFetch(url, { method: 'PUT', headers, body: dbBytes, signal });
    if (res.status === 412 || res.status === 409) throw new ConflictError();
    if (sharedGone(target, res)) throw new Error(SHARED_GONE_MESSAGE);
    if (!res.ok) throw new Error(`OneDrive 저장 오류: ${res.status} ${res.statusText}`);
    const item = await res.json().catch(() => ({}));
    return item.eTag || null;
  });
}

// ── 백업 폴더 (I-014) ────────────────────────────────────────────

/**
 * 공유받은 가계부(M-2)의 남긴 사본 폴더 — 내 OneDrive 앱 폴더 안에 가계부마다 따로(주인의 백업 목록이 아니다).
 * 매일 백업은 주인 기기만 만들고(useLedgerSync), 여기에는 다른 기기가 가계부를 통째로 바꿔 넣지 못한 이 기기의 변경이 담긴
 * 사본만 남는다(I-035)
 */
const safeName = v => String(v).replace(/[^A-Za-z0-9]/g, '_').slice(0, 80);
const sharedBackupDirUrl = ({ driveId, itemId }) => `${GRAPH_BASE}/me/drive/root:/${APP_FOLDER}shared-backups/${safeName(driveId)}_${safeName(itemId)}`;

/** 백업 폴더의 파일 — 하위 폴더는 뺀다. 폴더가 아직 없으면 []. 200개씩 최대 5쪽. */
async function listBackupFiles(instance, accounts, dirUrl = BACKUP_DIR_URL) {
  const token = await getToken(instance, accounts);
  const headers = { Authorization: `Bearer ${token}` };
  const out = [];
  let url = `${dirUrl}:/children?$top=200`;
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
async function createBackupFile(instance, accounts, name, bytes, dirUrl = BACKUP_DIR_URL) {
  const token = await getToken(instance, accounts);
  const res = await graphFetch(`${dirUrl}/${name}:/content?@microsoft.graph.conflictBehavior=fail`, {
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

// ── 다른 계정과 함께 쓰기 (M-2) — 주인 쪽 ──────────────────────

const OWN_ITEM_SELECT = `${ITEM_URL}?$select=id,parentReference`;

/** 내 가계부 파일의 번호 — { driveId, itemId }. 파일이 아직 없으면 null */
async function ownLedgerRef(instance, accounts) {
  const token = await getToken(instance, accounts);
  const res = await graphFetch(OWN_ITEM_SELECT, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OneDrive 확인 오류: ${res.status} ${res.statusText}`);
  const item = await res.json();
  return { driveId: item.parentReference?.driveId || '', itemId: item.id || '' };
}

/**
 * 이메일로 초대 — 그 Microsoft 계정에 내 가계부 파일 하나의 쓰기 권한을 준다(앱 폴더·AI 설정 파일은 공유하지 않는다).
 * Microsoft가 초대 메일도 보낸다(그 메일의 링크는 OneDrive로 열리므로, 앱의 참여 링크를 따로 보낸다). 반환: { driveId, itemId }
 */
async function inviteMember(instance, accounts, email, message) {
  const ref = await ownLedgerRef(instance, accounts);
  if (!ref?.itemId) throw new Error('가계부 파일이 아직 없습니다 — 가계부를 한 번 저장한 뒤 초대하세요');
  const token = await getToken(instance, accounts);
  const res = await graphFetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(ref.itemId)}/invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipients: [{ email }], message, requireSignIn: true, sendInvitation: true, roles: ['write'],
    }),
  });
  if (res.status === 400) throw new Error('초대하지 못했습니다 — 이메일 주소를 확인하세요(Microsoft 계정이어야 해요)');
  if (!res.ok) throw new Error(`초대하지 못했습니다: ${res.status} ${res.statusText}`);
  return ref;
}

/** 가계부 파일을 함께 쓰는 사람 — [{ id, name, email, owner }] (주인 자신은 owner: true) */
async function listMembers(instance, accounts) {
  const ref = await ownLedgerRef(instance, accounts);
  if (!ref?.itemId) return [];
  const token = await getToken(instance, accounts);
  const res = await graphFetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(ref.itemId)}/permissions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`함께 쓰는 사람을 불러오지 못했습니다: ${res.status} ${res.statusText}`);
  const body = await res.json();
  // 위 폴더에서 물려받은 것은 여기서 다루지 않는다. 링크 권한은 특정 사람에게 준 것(초대·사람이 붙은 것)만 —
  // 개인 계정의 초대가 어떤 모양으로 오는지 실제 계정으로 확인하기 전이라(SETUP 5-6) 예전 모양(grantedTo·grantedToIdentities)도 본다
  const personOf = p => p.grantedToV2?.user || p.grantedToV2?.siteUser || p.grantedTo?.user
    || p.grantedToIdentitiesV2?.[0]?.user || p.grantedToIdentitiesV2?.[0]?.siteUser || p.grantedToIdentities?.[0]?.user || null;
  return (body.value || [])
    .filter(p => !p.inheritedFrom && (!p.link || p.invitation || personOf(p)))
    .map((p) => {
      const user = personOf(p) || {};
      return {
        id: p.id,
        name: user.displayName || '',
        email: user.email || p.invitation?.email || '',
        owner: (p.roles || []).includes('owner'),
      };
    });
}

/** 함께 쓰는 사람에서 뺀다 — 그 계정은 더 이상 이 가계부에 닿지 못한다 */
async function removeMember(instance, accounts, permissionId) {
  const ref = await ownLedgerRef(instance, accounts);
  if (!ref?.itemId) return;
  const token = await getToken(instance, accounts);
  const res = await graphFetch(
    `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(ref.itemId)}/permissions/${encodeURIComponent(permissionId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok && res.status !== 404) throw new Error(`빼지 못했습니다: ${res.status} ${res.statusText}`);
}

/**
 * 공유받은 가계부를 열 수 있는지 미리 본다(참여 링크를 열 때) — { name, ownerName }.
 * 닿지 못하면(초대받지 않은 계정·공유를 끊음) SHARED_GONE_MESSAGE로 던진다
 */
async function inspectShared(instance, accounts, ref) {
  const target = sharedTarget(ref);
  const token = await getToken(instance, accounts);
  const res = await graphFetch(`${target.metaUrl}?$select=id,name,eTag,createdBy,shared`, { headers: { Authorization: `Bearer ${token}` } });
  if (sharedGone(target, res)) throw new Error(SHARED_GONE_MESSAGE);
  if (!res.ok) throw new Error(`공유받은 가계부를 확인하지 못했습니다: ${res.status} ${res.statusText}`);
  const item = await res.json();
  const ownerName = item.shared?.owner?.user?.displayName || item.createdBy?.user?.displayName || '';
  return { name: item.name || '', ownerName };
}

/** Microsoft 개인 계정인지 — 회사·학교 계정은 공유받은 파일에 관리자 동의가 필요해 1단계에서 빼었다(M-2 결정) */
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
export function isPersonalMicrosoftAccount(account) {
  const tid = account?.tenantId || account?.idTokenClaims?.tid || '';
  return tid === CONSUMER_TENANT || (account?.homeAccountId || '').endsWith(`.${CONSUMER_TENANT}`);
}

/** 공유받은 가계부의 열쇠 — 미저장 변경·연결 없이 열 사본·백업 표식을 가계부마다 따로 둔다(계정 열쇠와 다르게) */
export const sharedLedgerKey = (accountKey, { driveId, itemId }) => `${accountKey}#ms:${driveId}:${itemId}`;

/**
 * 로그인한 Microsoft 계정의 OneDrive 저장소 (./provider.js의 LedgerStorage).
 * @param {import('@azure/msal-browser').IPublicClientApplication} instance
 * @param {Array<{ homeAccountId?: string }>} accounts — MSAL 계정 목록(첫 계정을 쓴다)
 * @param {{ ledger?: { driveId: string, itemId: string } | null }} [options]
 *   ledger: 다른 계정이 공유한 가계부(M-2) — 없으면 내 가계부. 설정 파일(AI 설정 등)은 늘 내 앱 폴더
 * @returns {import('./provider').LedgerStorage}
 */
export function createOneDriveStorage(instance, accounts, { ledger = null } = {}) {
  const accountKey = accounts?.[0]?.homeAccountId || '';
  const target = ledger ? sharedTarget(ledger) : OWN_TARGET;
  const settings = {
    readSettings: name => readSettingsFile(instance, accounts, name),
    writeSettings: (name, data, version) => writeSettingsFile(instance, accounts, name, data, version),
  };
  const file = {
    read: () => readDb(instance, accounts, target),
    getVersion: () => getRemoteETag(instance, accounts, target),
    write: (bytes, version) => writeDb(instance, accounts, bytes, version, target),
  };
  if (ledger) {
    return {
      accountKey,
      ledgerKey: sharedLedgerKey(accountKey, ledger),
      isShared: true,
      ...file,
      // 공유받은 가계부의 매일 백업은 주인 기기만 만든다(M-2 결정 — useLedgerSync가 건너뛴다). 이 폴더는 내 OneDrive 앱 폴더의
      // shared-backups/<가계부> — 다른 기기가 가계부를 통째로 바꿔 넣지 못한 이 기기의 변경이 담긴 사본만 남는다(I-035)
      listBackups: () => listBackupFiles(instance, accounts, sharedBackupDirUrl(ledger)),
      createBackup: (name, bytes) => createBackupFile(instance, accounts, name, bytes, sharedBackupDirUrl(ledger)),
      readBackup: (id, accept) => readBackupFile(instance, accounts, id, accept),
      deleteBackup: id => deleteBackupFile(instance, accounts, id),
      ...settings,
    };
  }
  return {
    accountKey,
    isShared: false,
    ...file,
    listBackups: () => listBackupFiles(instance, accounts),
    createBackup: (name, bytes) => createBackupFile(instance, accounts, name, bytes),
    readBackup: (id, accept) => readBackupFile(instance, accounts, id, accept),
    deleteBackup: id => deleteBackupFile(instance, accounts, id),
    ...settings,
    // 다른 계정과 함께 쓰기(M-2) — 내 가계부 파일을 공유한다. 공유받은 사람은 참여 링크로 연다
    sharing: {
      provider: 'ms',
      ownLedgerRef: () => ownLedgerRef(instance, accounts),
      invite: (email, message) => inviteMember(instance, accounts, email, message),
      listMembers: () => listMembers(instance, accounts),
      removeMember: id => removeMember(instance, accounts, id),
      inspectShared: ref => inspectShared(instance, accounts, ref),
    },
  };
}
