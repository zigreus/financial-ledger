/**
 * Google Drive 저장소 (Drive API v3) — ./provider.js의 계약을 구현한다 (ROADMAP M-1, I-031).
 *
 *  - 위치: 내 드라이브 › financial-ledger 폴더 › ledger.db, backups/, <이름>.json(설정). 범위는 drive.file —
 *    이 앱이 만든 파일만 보인다(같은 OAuth 클라이언트라 다른 기기에서 만든 것도 보인다).
 *  - 버전: 파일의 headRevisionId(내용이 바뀔 때마다 새 값).
 *  - ⚠ Drive v3에는 OneDrive의 If-Match 같은 원자적 조건부 저장이 문서화되어 있지 않다(ROADMAP M-1 사전 검증). 그래서
 *    1) 저장 직전에 버전을 확인하고(다르면 ConflictError),
 *    2) 올린 뒤 리비전 목록(시간 순서로 정렬)에서 내 리비전 바로 앞이 내가 확인한 버전인지 다시 본다.
 *       그 사이 다른 기기가 저장했다면 내가 그 위를 덮은 것이므로, 맨 위가 아직 내 것이면 그 기기의 리비전을 다시 올려
 *       되돌리고 ConflictError를 던진다 — 동기화는 그 내용을 받아 내 변경을 다시 실행해 합친다(그 기기의 저장도 잃지 않는다).
 *    3) 확인·되돌리기가 끝나기 전에 실패하거나(연결 끊김·앱 종료) 리비전 목록에 잠깐 기다려도 없으면, 저장을 '올라갔는지
 *       모르는 저장'(일반 오류)으로 끝내 동기화가 변경을 계속 들고 있게 하고, 그 업로드를 이 기기에 기억했다가
 *       다음 읽기·버전 확인·저장 전에 마저 확인한다(10분 넘게 확인하지 못하거나 파일이 없어졌으면 버린다).
 *       확인하지 못한 내 업로드가 맨 위에 있는 동안은 다음 저장도 충돌 대신 같은 오류로 끝내, 병합이 그 파일을 받아들이지 않게 한다.
 *    남는 위험: 되돌리기 전에 또 다른 기기가 내 것 위에 저장한 경우(되돌리지 않는다 — 끼어든 기기의 그 저장은 잃는다),
 *    확인하지 못한 채 앱을 다시 열어 그 파일을 받은 뒤에야 끼어든 저장이 확인되는 경우(받은 쪽의 내 입력이 사라질 수 있다),
 *    목록 순서·리비전 보존이 기대와 다를 때(확인할 수 없으면 되돌리지 않는다), 앱이 올리기 응답을 받기 직전에 꺼진 경우.
 *    가족이 같은 순간에 저장할 때만 생기며, 실제 Drive로는 확인하지 못했다 — 사용자가 SETUP 2-2의 점검을 한 뒤 널리 쓴다.
 *  - 같은 이름이 둘 생기면(처음 만들 때 두 기기가 동시에) 가장 먼저 만든 것을 쓴다. 나중에 만든 쪽이 자기 것을 지운다.
 *    (Drive 검색이 방금 만든 파일을 늦게 보여 주면 두 기기가 잠깐 다른 파일에 쓸 수 있다 — 드물다)
 *  - 사용자가 financial-ledger 폴더를 옮기거나 이름을 바꾸면 찾지 못해 새로 만든다(SETUP에 '바꾸지 마세요').
 *  - 로그인 시간이 끝났으면(토큰 만료·401) ReconnectRequiredError — 연결 없음처럼 이어 쓰고 앱이 '다시 연결'을 보인다.
 *
 * 화면은 이 파일을 직접 부르지 않는다. App이 만든 저장소를 useLedgerSync·aiSettingsSync에 넘긴다.
 */
import { ConflictError, OfflineError, ReconnectRequiredError, offlineFrom } from './provider';
import { poke, readBody, setStage, stallSignal, stalledReason, stopStall, uploadStallMs } from './stall';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const GOOGLE_APP_FOLDER = 'financial-ledger';
export const GOOGLE_LEDGER_NAME = 'ledger.db';
const BACKUP_FOLDER = 'backups';
const FILE_FIELDS = 'id,name,headRevisionId,size,modifiedTime,createdTime';
const SETTINGS_TIMEOUT_MS = 15000;

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * @param {object} opts
 * @param {string} opts.accountKey — 'google:<sub>'
 * @param {() => string} opts.getToken — 지금 쓸 접근 토큰. 만료됐으면 ReconnectRequiredError를 던진다
 * @param {() => void} [opts.onUnauthorized] — Drive가 401을 돌려줬을 때(토큰을 만료로 표시)
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number[]} [opts.verifyRetryMs] — 올린 뒤 리비전 목록에 내 리비전이 아직 없을 때 다시 볼 간격
 * @returns {import('./provider').LedgerStorage}
 */
export function createGoogleDriveStorage({ accountKey, getToken, onUnauthorized, fetchImpl, verifyRetryMs = [300, 1000] }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const folderCache = new Map(); // 'app' | 'backups' → id

  async function call(url, init = {}, { signal } = {}) {
    const token = getToken();
    let res;
    try {
      res = await doFetch(url, { ...init, signal, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
    } catch (e) {
      const stalled = stalledReason(signal); // 가계부를 다루다 멈춰 끊었다 (stall.js)
      if (stalled) throw stalled;
      if (signal?.aborted) throw new Error('Google Drive 응답이 없습니다 — 연결을 확인하세요');
      let host = 'Google Drive';
      try { host = new URL(url).host; } catch (e2) { /* 그대로 */ }
      throw offlineFrom(host, e);
    }
    poke(signal); // 응답이 왔다 — 멈춤 시계를 처음부터
    if (res.status === 401) {
      if (onUnauthorized) onUnauthorized(token);
      throw new ReconnectRequiredError();
    }
    return res;
  }
  const fail = (what, res) => Object.assign(new Error(`Google Drive ${what} 오류: ${res.status} ${res.statusText || ''}`.trim()), { status: res.status });

  /** parent 안의 이름이 같은 파일(또는 폴더) — 먼저 만든 것부터 */
  async function find(parentId, name, { folder = false, signal } = {}) {
    const q = `name = '${esc(name)}' and '${esc(parentId)}' in parents and trashed = false and mimeType ${folder ? '=' : '!='} '${FOLDER_MIME}'`;
    const url = `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}&orderBy=createdTime&spaces=drive&pageSize=20`;
    const res = await call(url, {}, { signal });
    if (!res.ok) throw fail('찾기', res);
    return (await res.json()).files || [];
  }

  async function createFolder(parentId, name, signal) {
    const res = await call(`${API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    }, { signal });
    if (!res.ok) throw fail('폴더 만들기', res);
    return res.json();
  }

  async function remove(id) {
    const res = await call(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return res.ok || res.status === 404;
  }

  /** 폴더 id — 없으면 create일 때만 만든다. 두 기기가 동시에 만들었으면 먼저 만든 것을 쓰고 내 것은 지운다 */
  async function folderId(key, parentId, name, create, signal) {
    if (folderCache.has(key)) return folderCache.get(key);
    let found = await find(parentId, name, { folder: true, signal });
    if (!found.length) {
      if (!create) return null;
      const mine = await createFolder(parentId, name, signal);
      found = await find(parentId, name, { folder: true, signal });
      if (found.length && found[0].id !== mine.id) await remove(mine.id).catch(() => {});
      if (!found.length) found = [mine];
    }
    folderCache.set(key, found[0].id);
    return found[0].id;
  }
  const appFolder = (create, signal) => folderId('app', 'root', GOOGLE_APP_FOLDER, create, signal);
  const backupFolder = async (create) => {
    const app = await appFolder(create);
    return app ? folderId('backups', app, BACKUP_FOLDER, create) : null;
  };

  async function download(id, revisionId = null, signal) {
    const url = revisionId
      ? `${API}/files/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}?alt=media`
      : `${API}/files/${encodeURIComponent(id)}?alt=media`;
    const res = await call(url, {}, { signal });
    if (!res.ok) throw fail('읽기', res);
    return readBody(res, signal); // 조각이 올 때마다 멈춤 시계를 처음부터 — 느려도 오고 있으면 기다린다
  }

  /** 새 파일(내용과 함께 한 번에 — 빈 파일이 잠깐이라도 보이지 않게) */
  async function createFile(parentId, name, bytes, mimeType, signal) {
    const boundary = `ledger${Math.random().toString(36).slice(2)}`;
    const meta = JSON.stringify({ name, parents: [parentId], mimeType });
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
      + `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);
    setStage(signal, '올리기', uploadStallMs(body)); // 올리는 동안은 진행을 볼 수 없다 — 크기만큼 더 기다린다
    const res = await call(`${UPLOAD}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }, { signal });
    if (!res.ok) throw fail('저장', res);
    return res.json();
  }

  async function upload(id, bytes, mimeType, signal) {
    setStage(signal, '올리기', uploadStallMs(bytes)); // 올리는 동안은 진행을 볼 수 없다 — 크기만큼 더 기다린다
    const res = await call(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=${encodeURIComponent(FILE_FIELDS)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body: bytes,
    }, { signal });
    if (!res.ok) throw fail('저장', res);
    return res.json();
  }

  /** 리비전 — 시간 순서로(목록 순서는 문서에 정해져 있지 않다) */
  async function revisions(id, signal) {
    const res = await call(`${API}/files/${encodeURIComponent(id)}/revisions?fields=${encodeURIComponent('revisions(id,modifiedTime)')}&pageSize=1000`, {}, { signal });
    if (!res.ok) throw fail('리비전 확인', res);
    const list = (await res.json()).revisions || [];
    return list.map((r, i) => ({ ...r, i })).sort((a, b) => String(a.modifiedTime || '').localeCompare(String(b.modifiedTime || '')) || a.i - b.i);
  }

  async function headOf(id, signal) {
    const res = await call(`${API}/files/${encodeURIComponent(id)}?fields=headRevisionId`, {}, { signal });
    if (!res.ok) throw fail('확인', res);
    return (await res.json()).headRevisionId || null;
  }

  // ── 확인하지 못한 업로드 (올린 뒤 확인·되돌리기가 끝나기 전에 실패했거나 리비전 목록에 아직 없던 것) ──
  // 이 기기(localStorage, 계정·파일 이름별)에 기억했다가 다음 읽기·버전 확인·저장 전에 마저 확인한다 —
  // 끼어든 기기의 저장이 '올라갔는지 모르는 저장'으로 넘어가며 조용히 사라지지 않게
  const pendingKey = name => `ledger_gdrive_unverified:${accountKey || ''}:${name}`;
  const PENDING_GIVE_UP_MS = 10 * 60 * 1000;   // 그래도 확인할 수 없으면 10분 뒤 포기한다
  const pendingMem = new Map();
  const loadPending = (name) => {
    if (pendingMem.has(name)) return pendingMem.get(name);
    try { return JSON.parse(window.localStorage.getItem(pendingKey(name)) || 'null'); } catch (e) { return null; }
  };
  const savePending = (name, p) => {
    pendingMem.set(name, p);
    try {
      if (p) window.localStorage.setItem(pendingKey(name), JSON.stringify(p));
      else window.localStorage.removeItem(pendingKey(name));
    } catch (e) { /* 이 화면에서만 기억한다 */ }
  };

  /**
   * 올린 뒤 확인 — 'ok' | 'restored'(끼어든 기기의 리비전을 되돌려 놓음) | 'moved'(그 사이 또 다른 저장이 위에 올라가 되돌리지 않음)
   * | 'unknown'(목록에 아직 없거나 순서를 믿을 수 없음)
   */
  async function verifyUpload({ fileId, base, mine, mimeType }, signal) {
    const list = await revisions(fileId, signal);
    const mineAt = list.findIndex(r => r.id === mine);
    const baseAt = list.findIndex(r => r.id === base);
    if (mineAt === -1 || baseAt === -1 || baseAt >= mineAt) return 'unknown';
    if (baseAt === mineAt - 1) return 'ok';
    // 확인한 버전과 내 리비전 사이에 다른 기기의 저장이 있다 — 내가 그 위를 덮었다. 지금 맨 위가 아직 내 것일 때만 되돌린다
    if (await headOf(fileId, signal) !== mine) return 'moved';
    const theirs = await download(fileId, list[mineAt - 1].id, signal);
    await upload(fileId, theirs, mimeType, signal);
    return 'restored';
  }

  /**
   * 기억해 둔 확인하지 못한 업로드를 마저 확인한다 — 되돌렸으면 다음 읽기가 그 내용을 받아 합친다.
   * (기억하는 업로드는 모두 실패로 끝난 저장이라 동기화가 아직 그 변경을 들고 있다 — 되돌려도 다시 실행해 합친다)
   *  - 연결 없음·로그인 만료는 그대로 던진다(연결 없음 처리).
   *  - 파일이 없어졌으면(404) 기억을 버린다 — 영원히 막히지 않게.
   *  - 그 밖의 오류나 여전히 모르면 이번 작업은 막지 않고 기억만 남긴다(10분이 지나면 버린다).
   */
  async function settlePending(name, signal) {
    const p = loadPending(name);
    if (!p) return;
    const expired = Date.now() - (p.at || 0) >= PENDING_GIVE_UP_MS;
    let result;
    try {
      result = await verifyUpload(p, signal);
    } catch (e) {
      if (e instanceof OfflineError) throw e;
      // 404만 바로 버린다 — 403은 요청 한도 초과일 수도 있어 다른 오류처럼 남겨 두었다가 10분 뒤 버린다
      if (e.status === 404 || expired) savePending(name, null);
      return;
    }
    if (result === 'unknown' && !expired) return;
    savePending(name, null);
  }

  /** 올린 뒤 확인 — 목록이 늦게 보이면 잠깐 기다렸다 다시 본다 */
  async function verifyWithRetry(pending, signal) {
    let result = await verifyUpload(pending, signal);
    for (const ms of verifyRetryMs) {
      if (result !== 'unknown') break;
      await new Promise(r => setTimeout(r, ms));
      result = await verifyUpload(pending, signal);
    }
    return result;
  }

  /**
   * 버전 규칙을 지키는 저장(가계부·설정 파일 공통). version이 null이면 파일이 없을 때만 새로 만든다.
   * 성공하면 새 버전(headRevisionId).
   */
  async function writeVersioned(name, bytes, version, mimeType, signal) {
    await settlePending(name, signal);
    const folder = await appFolder(true, signal);
    const current = (await find(folder, name, { signal }))[0] || null;
    if (version == null) {
      if (current) throw new ConflictError();
      const created = await createFile(folder, name, bytes, mimeType, signal);
      const after = await find(folder, name, { signal });
      if (after.length && after[0].id !== created.id) {
        // 그 사이 다른 기기도 새로 만들었다 — 먼저 만든 쪽을 쓰고 내 것은 지운 뒤 합친다
        await remove(created.id).catch(() => {});
        throw new ConflictError();
      }
      return created.headRevisionId || null;
    }
    // 아직 확인하지 못한 내 업로드가 맨 위에 있으면 충돌로 알리지 않는다 — 충돌이면 동기화가 그 파일을 받아
    // 내 저장이 들어갔다고 받아들인 뒤, 나중 확인이 끼어든 저장을 되돌릴 때 내 입력이 사라진다
    const unverified = loadPending(name);
    if (unverified && current && current.headRevisionId === unverified.mine) {
      throw new Error('Google Drive 저장을 아직 확인하지 못했습니다 — 잠시 뒤 다시 확인해 저장합니다');
    }
    if (!current || current.headRevisionId !== version) throw new ConflictError();
    const updated = await upload(current.id, bytes, mimeType, signal);
    const pending = { fileId: current.id, base: version, mine: updated.headRevisionId, mimeType, at: Date.now() };
    // 확인이 끝나기 전에 실패해도(연결 끊김·앱 종료) 다음에 마저 확인하도록 먼저 기억한다
    savePending(name, pending);
    setStage(signal, '올린 뒤 확인');
    const result = await verifyWithRetry(pending, signal);
    if (result === 'unknown') {
      // 확인하지 못한 저장을 성공으로 돌려주면 동기화가 변경을 내려놓아, 나중에 되돌릴 때 내 입력이 사라진다 —
      // '올라갔는지 모르는 저장'으로 끝내 변경을 계속 들고 있게 하고, 기억해 둔 채 다음 작업 전에 마저 확인한다
      throw new Error('Google Drive 저장을 아직 확인하지 못했습니다 — 잠시 뒤 다시 확인해 저장합니다');
    }
    savePending(name, null);
    if (result !== 'ok') throw new ConflictError();
    return updated.headRevisionId || null;
  }

  // ── 가계부 파일 ─────────────────────────────────────────────────
  /** 가계부 파일을 다루는 동안의 멈춤 시계 — 멈추면 StalledError(연결 없음처럼), 끝나면 멈춘다 */
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

  const read = () => watched('Google Drive 가계부 받기', async (signal) => {
    const t0 = Date.now();
    setStage(signal, '파일 찾기');
    await settlePending(GOOGLE_LEDGER_NAME, signal);
    const folder = await appFolder(false, signal);
    if (!folder) return { bytes: null, version: null };
    const file = (await find(folder, GOOGLE_LEDGER_NAME, { signal }))[0];
    if (!file) return { bytes: null, version: null };
    const t1 = Date.now();
    setStage(signal, '내용 받기');
    // 버전(메타데이터)을 먼저 읽고 그 리비전의 내용을 받는다 — 내용과 버전이 정확히 맞는다(계약, provider.js)
    const bytes = await download(file.id, file.headRevisionId || null, signal);
    // 단계별 걸린 시간 — 느렸으면 동기화가 문제 알리기 기록에 남긴다
    const timing = { stages: [['파일 찾기', t1 - t0], ['내용 받기', Date.now() - t1]], size: bytes.length };
    return { bytes, version: file.headRevisionId || null, timing };
  });

  const getVersion = () => watched('Google Drive 확인', async (signal) => {
    setStage(signal, '파일 찾기');
    await settlePending(GOOGLE_LEDGER_NAME, signal);
    const folder = await appFolder(false, signal);
    if (!folder) return null;
    const file = (await find(folder, GOOGLE_LEDGER_NAME, { signal }))[0];
    return file ? file.headRevisionId || null : null;
  });

  // ── 백업 폴더 ───────────────────────────────────────────────────
  async function listBackups() {
    const folder = await backupFolder(false);
    if (!folder) return [];
    const q = `'${esc(folder)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`;
    const out = [];
    let pageToken = '';
    for (let page = 0; page < 5; page += 1) {
      const url = `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('nextPageToken,files(id,name,size,modifiedTime)')}&spaces=drive&pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await call(url);
      if (!res.ok) throw fail('백업 목록', res);
      const body = await res.json();
      (body.files || []).forEach(f => out.push({ id: f.id, name: f.name, size: Number(f.size) || 0, modified: f.modifiedTime || '' }));
      if (!body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
    return out;
  }

  async function createBackup(name, bytes) {
    const folder = await backupFolder(true);
    if ((await find(folder, name)).length) return false;
    await createFile(folder, name, bytes, 'application/octet-stream');
    return true;
  }

  async function readBackup(id, accept) {
    const res = await call(`${API}/files/${encodeURIComponent(id)}?fields=name`);
    if (!res.ok) throw fail('백업 읽기', res);
    const { name } = await res.json();
    if (!accept(name)) return null;
    return download(id);
  }

  async function deleteBackup(id) {
    return remove(id);
  }

  // ── 계정 설정 파일 (가계부와 별도인 작은 JSON) ──────────────────
  const settingsSignal = () => (
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(SETTINGS_TIMEOUT_MS) : undefined
  );

  async function readSettings(name) {
    const signal = settingsSignal();
    await settlePending(name, signal);
    const folder = await appFolder(false, signal);
    if (!folder) return { data: null, version: null };
    const file = (await find(folder, name, { signal }))[0];
    if (!file) return { data: null, version: null };
    const bytes = await download(file.id, null, signal);
    let data = null;
    try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch (e) { data = null; }
    return { data, version: file.headRevisionId || null };
  }

  async function writeSettings(name, data, version) {
    await writeVersioned(name, new TextEncoder().encode(JSON.stringify(data)), version, 'application/json', settingsSignal());
  }

  return {
    accountKey: accountKey || '',
    read,
    getVersion,
    write: (bytes, version) => watched('Google Drive 저장', signal => writeVersioned(GOOGLE_LEDGER_NAME, bytes, version, 'application/octet-stream', signal)),
    listBackups,
    createBackup,
    readBackup,
    deleteBackup,
    readSettings,
    writeSettings,
  };
}
