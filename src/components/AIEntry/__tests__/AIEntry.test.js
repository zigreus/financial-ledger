/**
 * @vitest-environment jsdom
 */
// 빠른 입력 — 말로 입력 중에 AI 설정을 다녀와도 하던 대화가 남는다 (I-017)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js';
import { createDatabase } from '../../../services/dbManager';
import { AIError } from '../../../services/aiClient';
import AIEntry from '../AIEntry';
import { parseTextEntry } from '../../../services/textEntry';

vi.mock('../../../services/textEntry', () => ({ parseTextEntry: vi.fn(), UNCLEAR: 'unclear' }));
// 설정 화면은 저장·취소만 흉내 낸다 (실제 화면은 AISettingsForm.test.js)
vi.mock('../AISettingsForm', () => ({
  default: ({ onSaved, onCancel }) => (
    <div className="fake-settings">
      <button type="button" onClick={onSaved}>설정 저장</button>
      <button type="button" onClick={onCancel}>설정 취소</button>
    </div>
  ),
}));

global.IS_REACT_ACT_ENVIRONMENT = true;

let SQL;
let db;
let container;
let root;
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('ai_receipt_config', JSON.stringify({ provider: 'gemini', keys: { gemini: 'k' }, models: {} }));
  parseTextEntry.mockReset();
  ({ db } = createDatabase(SQL, null));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (resetKey = 0) => act(async () => {
  root.render(<AIEntry db={db} onApply={() => {}} onBulkAdd={() => {}} resetKey={resetKey} />);
});
const visible = el => !!el && !el.closest('[hidden]');
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text && visible(b));
const click = text => act(async () => { button(text).click(); });
const setValue = (el, value) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const followText = () => container.querySelector('.tp-followup textarea');

async function startConversation() {
  await render();
  await click('💬말로 입력');
  await setValue(container.querySelector('textarea'), '좀 썼어');
  parseTextEntry.mockRejectedValueOnce(new AIError('무엇을 사셨나요?', 'unclear'));
  await click('정리하기');
  parseTextEntry.mockRejectedValueOnce(new AIError('API 키를 확인하세요 (invalid)', 'auth'));
  await setValue(followText(), '점심 김치찌개');
  await click('덧붙여 정리하기');
  await click('AI 설정');
  expect(visible(container.querySelector('.fake-settings'))).toBe(true);
  expect(visible(followText())).toBe(false);                 // 말로 입력 화면은 숨겨 두기만 한다
}

test('설정을 저장하고 돌아오면 하던 대화와 쓰던 말이 그대로 있다', async () => {
  await startConversation();
  await click('설정 저장');
  expect(container.querySelector('.fake-settings')).toBeNull();
  expect(visible(followText())).toBe(true);
  expect(followText().value).toBe('점심 김치찌개');
  expect(container.querySelector('.tp-quote').textContent).toBe('“좀 썼어”');
  expect(container.querySelector('.tp-followup .rs-error-text')).toBeNull();   // 고치러 다녀왔으니 이전 키 오류는 지운다

  parseTextEntry.mockReset();
  parseTextEntry.mockRejectedValueOnce(new AIError('얼마였나요?', 'unclear'));
  await click('덧붙여 정리하기');
  expect(parseTextEntry.mock.calls[0][0].followUps).toEqual([{ asked: '무엇을 사셨나요?', said: '점심 김치찌개' }]);
});

test('설정을 취소해도 하던 대화로 돌아가고, 닫으면 다음에는 처음부터', async () => {
  await startConversation();
  await click('설정 취소');
  expect(followText().value).toBe('점심 김치찌개');

  await click('닫기');
  expect(container.querySelector('.tp-followup')).toBeNull();
  await click('💬말로 입력');
  expect(container.querySelector('textarea').value).toBe('');
});
