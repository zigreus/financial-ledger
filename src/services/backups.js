/**
 * 가계부 백업 규칙 (I-014) — 저장소의 백업 폴더(OneDrive는 Apps/financial-ledger/backups/)에 ledger.db 사본을 둔다.
 *
 *  - 매일 백업: 그날 가계부를 처음 열 때 ledger-YYYY-MM-DD.db 를 만든다(같은 이름이 있으면 덮어쓰지 않음).
 *  - 직접 백업·되돌리기 직전 백업: ledger-YYYY-MM-DD-HHMMSS.db (같은 초에 또 만들면 -2, -3 …을 붙인다)
 *  - 최근 BACKUP_KEEP개만 남기고, 매일 백업을 만든 뒤 오래된 것을 지운다(이 이름 규칙의 파일만).
 *
 * 저장소 자체 버전 기록은 자동 저장 때마다 쌓여 금방 밀려나므로, 며칠 전으로 되돌리려면 이 백업이 필요하다.
 * 파일을 실제로 읽고 쓰는 것은 저장소(storage/provider.js)이고, 이 모듈은 이름·목록·정리 규칙만 맡는다 (F-2).
 * 화면은 이 모듈을 직접 부르지 않고 useLedgerSync가 감싼 함수를 쓴다 (AGENTS.md §2-2).
 */
import { toDateStr } from './dateUtils';

export const BACKUP_KEEP = 30;
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

/** 백업 목록 — 이름 규칙에 맞는 파일만, 최근 것부터: [{ id, name, size, modified, date, time, daily }] */
export async function listBackups(storage) {
  const out = [];
  (await storage.listBackups()).forEach(item => {
    const parsed = parseBackupName(item.name);
    if (parsed) out.push({ id: item.id, name: item.name, size: item.size || 0, modified: item.modified || '', ...parsed });
  });
  // 이름 순서는 매일 백업과 시각 붙은 백업이 섞이므로, 만든(고친) 시각 → 이름 순으로 정렬한다
  return out.sort((a, b) => (b.modified || '').localeCompare(a.modified || '') || b.name.localeCompare(a.name));
}

/** 백업 파일을 만든다. 같은 이름이 이미 있으면 덮어쓰지 않고 false. */
export async function uploadBackup(storage, name, bytes) {
  if (!parseBackupName(name)) throw new Error(`백업 이름 규칙과 다릅니다: ${name}`);
  return storage.createBackup(name, bytes);
}

/** 시각이 붙은 새 백업을 만든다 — 같은 이름이 있으면 번호를 붙여 다시 시도한다. 만든 이름을 돌려준다. */
export async function uploadNewBackup(storage, bytes, now = new Date()) {
  for (let seq = 1; seq <= 9; seq += 1) {
    const name = backupName(now, { daily: false, seq });
    if (await uploadBackup(storage, name, bytes)) return name;
  }
  throw new Error('같은 시각의 백업이 너무 많습니다 — 잠시 후 다시 시도하세요');
}

/** 백업 파일 내용 — 이름 규칙에 맞는 백업 파일만 돌려준다(다른 파일 id면 내용을 받기 전에 거절) */
export async function downloadBackup(storage, id) {
  const bytes = await storage.readBackup(id, name => !!parseBackupName(name));
  if (!bytes) throw new Error('백업 파일이 아닙니다');
  return bytes;
}

/** 최근 keep개를 남기고 오래된 백업을 지운다. 지운 개수를 돌려준다. */
export async function pruneBackups(storage, keep = BACKUP_KEEP) {
  const extra = (await listBackups(storage)).slice(keep);
  let removed = 0;
  for (const item of extra) {
    // 목록에서 이름 규칙을 확인한 백업 파일만 지운다
    if (await storage.deleteBackup(item.id)) removed += 1;
  }
  return removed;
}
