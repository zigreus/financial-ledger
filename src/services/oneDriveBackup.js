/**
 * 가계부 백업 (I-014) — OneDrive의 Apps/financial-ledger/backups/ 폴더에 ledger.db 사본을 둔다.
 *
 *  - 매일 백업: 그날 가계부를 처음 열 때 ledger-YYYY-MM-DD.db 를 만든다(같은 이름이 있으면 덮어쓰지 않음).
 *  - 직접 백업·되돌리기 직전 백업: ledger-YYYY-MM-DD-HHMMSS.db (같은 초에 또 만들면 -2, -3 …을 붙인다)
 *  - 최근 BACKUP_KEEP개만 남기고, 매일 백업을 만든 뒤 오래된 것을 지운다(이 이름 규칙의 파일만).
 *
 * OneDrive 자체 버전 기록은 자동 저장 때마다 쌓여 금방 밀려나므로, 며칠 전으로 되돌리려면 이 백업이 필요하다.
 * 화면은 이 모듈을 직접 부르지 않고 useLedgerSync가 감싼 함수를 쓴다 (AGENTS.md §2-2).
 */
import { ONEDRIVE_DB_PATH } from '../config';
import { GRAPH_BASE, getToken, graphFetch } from './oneDriveService';
import { toDateStr } from './dateUtils';

export const BACKUP_KEEP = 30;
export const BACKUP_DIR = `${ONEDRIVE_DB_PATH.replace(/[^/]+$/, '')}backups`; // 'Apps/financial-ledger/backups'
const BACKUP_NAME_RE = /^ledger-(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2})(\d{2})(?:-(\d{1,2}))?)?\.db$/;

const pad2 = n => String(n).padStart(2, '0');

/** 백업 파일 이름. daily=false면 시각까지 붙이고, seq(2 이상)가 있으면 뒤에 -seq를 붙인다. */
export function backupName(now = new Date(), { daily = true, seq = 1 } = {}) {
  const date = toDateStr(now);
  if (daily) return `ledger-${date}.db`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `ledger-${date}-${time}${seq > 1 ? `-${seq}` : ''}.db`;
}

/** 백업 이름이면 { date, time('HH:MM:SS' | ''), daily }, 아니면 null */
export function parseBackupName(name) {
  const m = BACKUP_NAME_RE.exec(String(name || ''));
  if (!m) return null;
  return { date: m[1], time: m[2] ? `${m[2]}:${m[3]}:${m[4]}` : '', daily: !m[2] };
}

const dirUrl = `${GRAPH_BASE}/me/drive/root:/${BACKUP_DIR}`;

/** 백업 목록 — 최근 것부터: [{ id, name, size, modified, date, time, daily }] */
export async function listBackups(instance, accounts) {
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
      const parsed = item.file ? parseBackupName(item.name) : null;
      if (parsed) out.push({ id: item.id, name: item.name, size: item.size || 0, modified: item.lastModifiedDateTime || '', ...parsed });
    });
    url = body['@odata.nextLink'] || null;
  }
  // 이름 순서는 매일 백업과 시각 붙은 백업이 섞이므로, 만든(고친) 시각 → 이름 순으로 정렬한다
  return out.sort((a, b) => (b.modified || '').localeCompare(a.modified || '') || b.name.localeCompare(a.name));
}

/** 백업 파일을 만든다. 같은 이름이 이미 있으면 덮어쓰지 않고 false. */
export async function uploadBackup(instance, accounts, name, bytes) {
  if (!parseBackupName(name)) throw new Error(`백업 이름 규칙과 다릅니다: ${name}`);
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

/** 시각이 붙은 새 백업을 만든다 — 같은 이름이 있으면 번호를 붙여 다시 시도한다. 만든 이름을 돌려준다. */
export async function uploadNewBackup(instance, accounts, bytes, now = new Date()) {
  for (let seq = 1; seq <= 9; seq += 1) {
    const name = backupName(now, { daily: false, seq });
    if (await uploadBackup(instance, accounts, name, bytes)) return name;
  }
  throw new Error('같은 시각의 백업이 너무 많습니다 — 잠시 후 다시 시도하세요');
}

/** 백업 파일 내용 */
export async function downloadBackup(instance, accounts, id) {
  const token = await getToken(instance, accounts);
  const itemUrl = `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(id)}`;
  const metaRes = await graphFetch(itemUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!metaRes.ok) throw new Error(`백업 읽기 오류: ${metaRes.status} ${metaRes.statusText}`);
  const meta = await metaRes.json();
  if (!parseBackupName(meta.name)) throw new Error('백업 파일이 아닙니다');
  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  const res = downloadUrl
    ? await graphFetch(downloadUrl)
    : await graphFetch(`${itemUrl}/content`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`백업 읽기 오류: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** 최근 keep개를 남기고 오래된 백업을 지운다. 지운 개수를 돌려준다. */
export async function pruneBackups(instance, accounts, keep = BACKUP_KEEP) {
  const list = await listBackups(instance, accounts);
  const extra = list.slice(keep);
  if (!extra.length) return 0;
  const token = await getToken(instance, accounts);
  let removed = 0;
  for (const item of extra) {
    // 목록에서 이름 규칙을 확인한 백업 파일만 지운다
    const res = await graphFetch(`${GRAPH_BASE}/me/drive/items/${encodeURIComponent(item.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok || res.status === 404) removed += 1;
  }
  return removed;
}
