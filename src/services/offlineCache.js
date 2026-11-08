/**
 * 이 기기에 두는 가계부 사본 (I-024, ROADMAP C-4) — 연결이 없을 때도 앱을 열어 입력할 수 있게.
 *
 * 저장소와 맞춘 순간(불러오기·저장 성공·병합·되돌리기)의 파일과 그 버전을 계정별로 하나씩 둔다.
 * 연결이 없으면 useLedgerSync가 이 사본으로 열고, 그 위에 이 기기의 미저장 변경을 다시 실행한다.
 * 연결되면 이 사본의 버전으로 저장을 시도해 — 그 사이 다른 기기가 저장했으면 거절되어 — 기존 병합 경로로 합친다.
 * 로그아웃하면 모두 지운다 (B-004 — 기기에 가계부가 남지 않게).
 *
 * 브라우저에서는 IndexedDB(크기 제한이 넉넉하고 바이너리를 그대로 담는다)를 쓰고, 테스트는 메모리 가짜를 쓴다.
 * @typedef {{ bytes: Uint8Array, version: string|null, savedAt: string }} OfflineCopy
 * @typedef {{
 *   save: (accountKey: string, bytes: Uint8Array, version: string|null) => Promise<void>,
 *   load: (accountKey: string) => Promise<OfflineCopy|null>,
 *   clearAll: () => Promise<void>,
 * }} OfflineCache
 */

const DB_NAME = 'financial-ledger';
const STORE = 'ledger-copies';

function openIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB를 쓸 수 없습니다')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB가 막혀 있습니다'));
  });
}

async function withStore(mode, fn) {
  const idb = await openIdb();
  try {
    return await new Promise((resolve, reject) => {
      const t = idb.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('IndexedDB 작업이 취소되었습니다'));
    });
  } finally {
    idb.close();
  }
}

/** 브라우저용 — IndexedDB. 쓸 수 없는 환경(비공개 모드 등)에서는 실패를 던진다(부르는 쪽이 무시한다) */
export function createIndexedDbOfflineCache() {
  return {
    async save(accountKey, bytes, version) {
      if (!accountKey || !bytes) return;
      await withStore('readwrite', s => s.put({ bytes: new Uint8Array(bytes), version: version ?? null, savedAt: new Date().toISOString() }, accountKey));
    },
    async load(accountKey) {
      if (!accountKey) return null;
      const found = await withStore('readonly', s => s.get(accountKey));
      return found && found.bytes ? { ...found, bytes: new Uint8Array(found.bytes) } : null;
    },
    async clearAll() {
      await withStore('readwrite', s => s.clear());
    },
  };
}

/** 테스트용 — 메모리. 같은 객체를 넘기면 '앱을 다시 연' 세션도 같은 사본을 본다 */
export function createMemoryOfflineCache() {
  const copies = new Map();
  return {
    async save(accountKey, bytes, version) {
      if (!accountKey || !bytes) return;
      copies.set(accountKey, { bytes: new Uint8Array(bytes), version: version ?? null, savedAt: new Date().toISOString() });
    },
    async load(accountKey) {
      const found = copies.get(accountKey);
      return found ? { ...found, bytes: new Uint8Array(found.bytes) } : null;
    },
    async clearAll() { copies.clear(); },
    /** 테스트 도우미 — 지금 사본 */
    peek: accountKey => copies.get(accountKey) || null,
  };
}

let shared = null;
/** 앱이 쓰는 사본 저장소 (하나) */
export function defaultOfflineCache() {
  if (!shared) shared = createIndexedDbOfflineCache();
  return shared;
}
