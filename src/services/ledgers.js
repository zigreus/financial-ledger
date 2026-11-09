/**
 * 가계부 목록 — 내 가계부 + 다른 계정이 공유한 가계부 (ROADMAP M-2, 1단계 Microsoft 개인 계정).
 *
 *  - 참여 링크: 주인이 초대하면 앱이 `?join=ms&drive=…&item=…&from=…` 링크를 만들어 메신저로 보낸다.
 *    파일 번호는 비밀이 아니다 — 초대받은 계정만 열 수 있다. 앱을 열 때 이 링크를 이 기기에 받아 두고(로그인하러 다녀와도
 *    남게) 주소에서 지운다. 로그인 뒤 App이 꺼내 '이 가계부를 열까요?'를 묻는다.
 *  - 목록은 계정마다 이 기기(localStorage)와 그 계정 드라이브의 설정 파일(ledgers.json — AI 설정처럼 내 앱 폴더)에 둔다.
 *    항목마다 바꾼 시각을 두어 기기끼리 합칠 때 더 나중에 바꾼 것을 따른다(뺀 것도 기록해 다른 기기에서 되살아나지 않게).
 *  - 지금 보는 가계부는 기기마다 따로('' = 내 가계부).
 */
import { ConflictError } from './storage/provider';

const PENDING_JOIN_KEY = 'ledger_pending_join';
const LIST_KEY = 'ledger_list:';
const CURRENT_KEY = 'ledger_current:';
export const LEDGERS_FILE = 'ledgers.json';
/** 받아 둔 참여 링크는 이만큼 지나면 버린다 */
const JOIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 내 가계부 */
export const OWN_LEDGER = '';
const ID_RE = /^[A-Za-z0-9!_-]{1,200}$/;

const storageGet = (key) => { try { return window.localStorage.getItem(key); } catch { return null; } };
const storageSet = (key, value) => {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* 비공개 모드 — 이번에만 */ }
};

/** 공유받은 가계부의 번호 — 'ms:<driveId>:<itemId>' */
export const ledgerIdOf = ({ driveId, itemId }) => `ms:${driveId}:${itemId}`;

// ── 참여 링크 ───────────────────────────────────────────────

/** 참여 링크 — 주인이 메신저로 보낸다. fromName: 받는 사람에게 보일 주인 이름 */
export function buildJoinLink(origin, { driveId, itemId }, fromName = '') {
  const q = new URLSearchParams({ join: 'ms', drive: driveId, item: itemId });
  if (fromName) q.set('from', fromName);
  return `${origin}/?${q.toString()}`;
}

/**
 * 앱을 열 때 한 번 — 주소의 참여 링크를 이 기기에 받아 두고 주소에서 지운다(새로 고침해도 또 묻지 않게).
 * 반환: 받아 둔 참여 정보 { provider, driveId, itemId, from, at } 또는 null
 */
export function capturePendingJoin(win = typeof window !== 'undefined' ? window : null) {
  if (!win) return null;
  const url = new URL(win.location.href);
  if (url.searchParams.get('join') !== 'ms') return null;
  const driveId = url.searchParams.get('drive') || '';
  const itemId = url.searchParams.get('item') || '';
  const from = url.searchParams.get('from') || '';
  ['join', 'drive', 'item', 'from'].forEach(k => url.searchParams.delete(k));
  try { win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`); } catch { /* 무시 */ }
  // 번호 모양만 받는다 — OneDrive 번호는 영문·숫자·!·-·_ (주소 조각 '..' 같은 것이 Graph 주소에 끼지 않게)
  if (!ID_RE.test(driveId) || !ID_RE.test(itemId)) return null;
  const join = { provider: 'ms', driveId, itemId, from: from.slice(0, 40), at: Date.now() };
  storageSet(PENDING_JOIN_KEY, JSON.stringify(join));
  return join;
}

/** 받아 둔 참여 링크(오래된 것은 버린다) */
export function peekPendingJoin(now = Date.now()) {
  try {
    const join = JSON.parse(storageGet(PENDING_JOIN_KEY) || 'null');
    if (!join || join.provider !== 'ms' || !join.driveId || !join.itemId) return null;
    if (now - (join.at || 0) > JOIN_TTL_MS) { storageSet(PENDING_JOIN_KEY, null); return null; }
    return join;
  } catch {
    return null;
  }
}

export function clearPendingJoin() {
  storageSet(PENDING_JOIN_KEY, null);
}

// ── 목록 ────────────────────────────────────────────────────

/** { entries: { [id]: { id, driveId, itemId, ownerName, at, removed } } } */
function readList(accountKey) {
  try {
    const list = JSON.parse(storageGet(LIST_KEY + accountKey) || 'null');
    return list && typeof list.entries === 'object' ? list : { entries: {} };
  } catch {
    return { entries: {} };
  }
}
function writeList(accountKey, list) {
  storageSet(LIST_KEY + accountKey, JSON.stringify(list));
}

/** 공유받은 가계부 — [{ id, driveId, itemId, ownerName }] (넣은 순서) */
export function getSharedLedgers(accountKey) {
  return Object.values(readList(accountKey).entries)
    .filter(e => !e.removed)
    .sort((a, b) => (a.addedAt || a.at || 0) - (b.addedAt || b.at || 0))
    .map(({ id, driveId, itemId, ownerName }) => ({ id, driveId, itemId, ownerName: ownerName || '' }));
}

/** 공유받은 가계부를 목록에 넣는다(이미 있으면 이름만 고친다). 반환: 그 번호 */
export function addSharedLedger(accountKey, { driveId, itemId, ownerName = '' }, now = Date.now()) {
  const list = readList(accountKey);
  const id = ledgerIdOf({ driveId, itemId });
  const prev = list.entries[id];
  list.entries[id] = {
    id, driveId, itemId, ownerName: ownerName || prev?.ownerName || '', at: now, addedAt: prev && !prev.removed ? prev.addedAt || prev.at : now, removed: false,
  };
  writeList(accountKey, list);
  return id;
}

/** 목록에서 뺀다(공유 권한은 그대로 — 주인이 끊어야 끊긴다). 지금 보던 것이면 내 가계부로 */
export function removeSharedLedger(accountKey, id, now = Date.now()) {
  const list = readList(accountKey);
  const prev = list.entries[id];
  if (!prev) return;
  list.entries[id] = { ...prev, at: now, removed: true };
  writeList(accountKey, list);
  if (getCurrentLedgerId(accountKey) === id) setCurrentLedgerId(accountKey, OWN_LEDGER);
}

/** 이 기기에서 지금 보는 가계부 — '' 이면 내 가계부. 목록에 없는 번호면 내 가계부 */
export function getCurrentLedgerId(accountKey) {
  const id = storageGet(CURRENT_KEY + accountKey) || OWN_LEDGER;
  if (id === OWN_LEDGER) return OWN_LEDGER;
  return getSharedLedgers(accountKey).some(l => l.id === id) ? id : OWN_LEDGER;
}
export function setCurrentLedgerId(accountKey, id) {
  storageSet(CURRENT_KEY + accountKey, id || null);
}

/** 두 목록을 합친다 — 항목마다 더 나중에 바꾼 것 */
export function mergeLedgerLists(a, b) {
  const entries = { ...(a?.entries || {}) };
  Object.values(b?.entries || {}).forEach((e) => {
    if (!e?.id) return;
    if (!entries[e.id] || (e.at || 0) > (entries[e.id].at || 0)) entries[e.id] = e;
  });
  return { entries };
}

/**
 * 이 기기의 목록을 그 계정 드라이브의 ledgers.json과 맞춘다(다른 기기에서 넣은 공유 가계부도 보이게).
 * 실패해도 이 기기 목록은 그대로 쓴다. 반환: 목록이 바뀌었는지
 */
export async function syncLedgerList(storage) {
  const accountKey = storage?.accountKey;
  if (!accountKey || !storage.readSettings) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const before = JSON.stringify(readList(accountKey).entries);
      const { data, version } = await storage.readSettings(LEDGERS_FILE);
      // 받는 사이 이 기기에서 넣거나 뺀 것(참여 링크로 열기 등)도 잃지 않게 — 저장 직전의 목록과 합친다
      const local = readList(accountKey);
      const merged = mergeLedgerLists(data, local);
      writeList(accountKey, mergeLedgerLists(local, merged));
      if (JSON.stringify(merged.entries) !== JSON.stringify(data?.entries || {})) {
        await storage.writeSettings(LEDGERS_FILE, merged, version);
      }
      return JSON.stringify(readList(accountKey).entries) !== before;
    } catch (e) {
      if (!(e instanceof ConflictError)) return false;
    }
  }
  return false;
}
