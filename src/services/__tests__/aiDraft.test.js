/**
 * @vitest-environment jsdom
 */
// AI 입력에서 정리하던 글 (I-023) — 같은 날에만 되살린다
import { saveAIDraft, loadAIDraft, clearAIDraft, setAIDraftAccount } from '../aiDraft';

beforeEach(() => { window.localStorage.clear(); setAIDraftAccount('me'); });

test('로그인한 계정에 묶는다 — 다른 계정으로 로그인하면 보이지 않고 지운다', () => {
  saveAIDraft('점심 9천원 현금');
  setAIDraftAccount('someone-else');
  expect(loadAIDraft()).toBe('');
  setAIDraftAccount('me');
  expect(loadAIDraft()).toBe('');                    // 이미 지웠다
});

test('적어 둔 글을 되살리고, 지우면 없다. 빈 글은 적지 않는다', () => {
  saveAIDraft('  점심 9천원 현금 ');
  expect(loadAIDraft()).toBe('점심 9천원 현금');
  clearAIDraft();
  expect(loadAIDraft()).toBe('');
  saveAIDraft('점심');
  saveAIDraft('   ');
  expect(loadAIDraft()).toBe('');
});

test("다른 날 적어 둔 글은 되살리지 않고 지운다 — '어제' 같은 말이 다른 날짜가 된다", () => {
  window.localStorage.setItem('ai_entry_draft', JSON.stringify({ text: '어제 점심 9천원', date: '2000-01-01', account: 'me' }));
  expect(loadAIDraft()).toBe('');
  expect(window.localStorage.getItem('ai_entry_draft')).toBeNull();
});

test('망가진 기록은 무시한다', () => {
  window.localStorage.setItem('ai_entry_draft', '{not json');
  expect(loadAIDraft()).toBe('');
});
