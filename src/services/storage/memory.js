/**
 * 메모리 저장소 — 테스트용 가짜 provider (ROADMAP F-2, I-018). 앱은 쓰지 않는다.
 *
 * 실제 저장소와 같은 버전 규칙을 지킨다: 버전이 다르면 ConflictError, 버전 없이 저장하면 파일이 없을 때만 만든다.
 * 그래서 병합 시나리오(다른 기기가 먼저 저장, 파일이 사라짐, 업로드 결과를 모름 …)를 네트워크 없이 돌릴 수 있다.
 *
 * 메서드는 this를 쓰지 않는다 — { ...storage, accountKey: 'B' }처럼 펼치면 같은 파일을 쓰는 '다른 기기'가 된다.
 * 실패를 흉내 내려면 메서드를 바꿔 끼운다(예: storage.write = async () => { throw new Error('네트워크 오류'); }).
 */
import { ConflictError } from './provider';

const copy = bytes => (bytes ? new Uint8Array(bytes) : null);

/**
 * @param {{ accountKey?: string, bytes?: Uint8Array|null }} [options] bytes: 처음부터 있는 가계부 파일
 * @returns {import('./provider').LedgerStorage & {
 *   current: () => Uint8Array|null, replace: (bytes: Uint8Array) => string, remove: () => void,
 *   putSettingsText: (name: string, text: string) => void
 * }}
 */
export function createMemoryStorage({ accountKey = 'me', bytes = null } = {}) {
  let rev = 0;
  let file = bytes ? { bytes: copy(bytes), version: `v${(rev += 1)}` } : null;
  const backups = new Map(); // id → { id, name, bytes, modified }
  const settings = new Map(); // name → { text, version }
  let seq = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1) + (seq += 1) * 1000).toISOString(); // 만든 순서대로 늘어나는 시각
  const version = () => (file ? file.version : null);

  /** 저장한 것처럼 바꾸고 새 버전을 돌려준다 */
  const put = (next) => {
    file = { bytes: copy(next), version: `v${(rev += 1)}` };
    return file.version;
  };

  return {
    accountKey,

    async read() { return { bytes: copy(file?.bytes), version: version() }; },
    async getVersion() { return version(); },
    async write(next, expected) {
      if ((expected || null) !== version()) throw new ConflictError();
      return put(next);
    },

    async listBackups() {
      return [...backups.values()].map(({ id, name, bytes: b, modified }) => ({ id, name, size: b.length, modified }));
    },
    async createBackup(name, b) {
      if ([...backups.values()].some(x => x.name === name)) return false;
      const modified = clock();
      const id = `bk${seq}`;
      backups.set(id, { id, name, bytes: copy(b), modified });
      return true;
    },
    async readBackup(id, accept) {
      const found = backups.get(id);
      if (!found) throw new Error(`백업 읽기 오류: 404 ${id}`);
      return accept(found.name) ? copy(found.bytes) : null;
    },
    async deleteBackup(id) { backups.delete(id); return true; },

    async readSettings(name) {
      const entry = settings.get(name);
      if (!entry) return { data: null, version: null };
      let data = null;
      try { data = JSON.parse(entry.text); } catch (e) { data = null; }
      return { data, version: entry.version };
    },
    async writeSettings(name, data, expected) {
      const entry = settings.get(name);
      if ((expected || null) !== (entry ? entry.version : null)) throw new ConflictError();
      settings.set(name, { text: JSON.stringify(data), version: `s${(rev += 1)}` });
    },

    // ── 테스트 도우미 (계약 밖) ──
    /** 지금 가계부 파일 내용 */
    current: () => copy(file?.bytes),
    /** 다른 기기가 저장한 것처럼 파일을 바꾼다. 새 버전을 돌려준다 */
    replace: next => put(next),
    /** 가계부 파일을 지운다 (다른 기기·사용자가 지운 경우) */
    remove: () => { file = null; },
    /** 설정 파일 내용을 글자 그대로 넣는다 (깨진 JSON 흉내) */
    putSettingsText: (name, text) => { settings.set(name, { text, version: `s${(rev += 1)}` }); },
  };
}
