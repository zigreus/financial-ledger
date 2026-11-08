/**
 * AI 입력에서 정리하던 글 (I-023) — 분석하는 사이 휴대폰이 앱을 아예 닫아 버려도(메모리 부족 등) 다시 열면 이어서 하게.
 * 정리를 시작할 때 이 기기에 적어 두고, 그 정리를 끝내면(추가·채우기·닫기) 지운다. 로그아웃하면 지운다.
 *  - 같은 날에만 되살린다 — 날이 바뀌면 "어제" 같은 말이 다른 날짜가 된다.
 *  - 로그인한 계정에 묶는다(App이 setAIDraftAccount로 알려 준다) — 다른 계정으로 로그인하면 보이지 않고 지운다.
 */
import { todayStr } from './dateUtils';

const KEY = 'ai_entry_draft';
let account = '';

/** 지금 로그인한 계정 (homeAccountId) — 남은 글을 이 계정에 묶는다 */
export function setAIDraftAccount(key) {
  account = String(key || '');
}

export function saveAIDraft(text) {
  const t = String(text || '').trim();
  try {
    if (t) window.localStorage.setItem(KEY, JSON.stringify({ text: t, date: todayStr(), account }));
    else window.localStorage.removeItem(KEY);
  } catch (e) { /* 저장 공간이 없거나 막힘 — 이어서 하기만 못 할 뿐 */ }
}

/** 오늘 이 계정이 정리하다 남은 글 (없으면 '') */
export function loadAIDraft() {
  try {
    const d = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    if (!d || typeof d.text !== 'string' || !d.text.trim()) return '';
    if (d.date !== todayStr() || String(d.account || '') !== account) {
      window.localStorage.removeItem(KEY);
      return '';
    }
    return d.text;
  } catch (e) {
    return '';
  }
}

export function clearAIDraft() {
  try { window.localStorage.removeItem(KEY); } catch (e) { /* 무시 */ }
}
