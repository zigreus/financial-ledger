/**
 * 이 기기를 쓰는 가족 구성원 (I-013) — 새 거래의 '누가' 기본값.
 *
 * 기기마다 다르므로 가계부 DB가 아니라 이 브라우저(localStorage)에 이름으로 둔다.
 * 구성원 이름이 바뀌거나 지워졌으면 목록에 없는 이름이 되므로, 쓸 때마다 DB 목록과 대조한다.
 */
import { getMemberNames } from './dbManager';

const KEY = 'ledger_device_member';

export function getDeviceMember() {
  try { return window.localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
}

export function setDeviceMember(name) {
  try {
    if (name) window.localStorage.setItem(KEY, name);
    else window.localStorage.removeItem(KEY);
  } catch (e) { /* 비공개 모드 등 — 기본값 없이 쓴다 */ }
}

/** DB 목록에 있는 이 기기 구성원 이름. 없거나 목록에서 사라졌으면 '' */
export function resolveDeviceMember(db) {
  const name = getDeviceMember();
  return name && db && getMemberNames(db).includes(name) ? name : '';
}
