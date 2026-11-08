/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// AI 설정 화면 — 다른 기기에서 받아 온 키를 보여 주고, 손댄 칸만 저장한다 (I-015, B-071)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import AISettingsForm from '../AISettingsForm';
import { getAIConfig, updateAIConfig } from '../../../services/aiClient';
import { syncAISettings, setAISyncAccount } from '../../../services/aiSettingsSync';
import * as OneDrive from '../../../services/oneDriveService';

vi.mock('../../../services/oneDriveService', async (importOriginal) => ({
  ...(await importOriginal()),
  readSettingsFile: vi.fn(),
  writeSettingsFile: vi.fn(),
}));

global.IS_REACT_ACT_ENVIRONMENT = true;

/** OneDrive의 ai-settings.json 대신 쓰는 메모리 파일. gate()로 읽기를 잠시 붙잡을 수 있다 */
let cloud;
let rev;
let hold = null;
function setCloud(data) { cloud = data ? JSON.parse(JSON.stringify(data)) : null; rev += 1; }
function gate() {
  let release;
  hold = new Promise(r => { release = r; });
  return () => { hold = null; release(); };
}

beforeEach(() => {
  window.localStorage.clear();
  cloud = null;
  rev = 0;
  hold = null;
  OneDrive.readSettingsFile.mockImplementation(async () => {
    if (hold) await hold;
    return { data: cloud ? JSON.parse(JSON.stringify(cloud)) : null, eTag: cloud ? `e${rev}` : null };
  });
  OneDrive.writeSettingsFile.mockImplementation(async (_i, _a, _n, data, eTag) => {
    if (eTag !== (cloud ? `e${rev}` : null)) throw new OneDrive.ConflictError();
    setCloud(data);
  });
  setAISyncAccount({}, [{ homeAccountId: 'me' }]);
});
afterEach(() => { document.body.innerHTML = ''; setAISyncAccount(null); });

async function render(props = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<AISettingsForm {...props} />); });
  return container;
}
const keyInput = c => c.querySelector('input[type="password"]');
const buttons = c => [...c.querySelectorAll('button')];
const button = (c, text) => buttons(c).find(b => b.textContent.includes(text));
function type(el, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

test('앱 시작 동기화가 먼저 키를 받아 와도, 그보다 먼저 열린 설정 화면에 키가 채워진다', async () => {
  setCloud({ provider: 'gemini', keys: { gemini: 'AIza-PC' }, models: {} });
  const release = gate();
  const appSync = syncAISettings();                 // App이 앱을 열 때 시작한 동기화 (아직 읽는 중)
  const c = await render({ compact: true, onSaved: () => {} });
  expect(keyInput(c).value).toBe('');
  release();
  await act(async () => { await appSync; });
  await flush();
  expect(keyInput(c).value).toBe('AIza-PC');
  expect(button(c, '저장하고 계속').disabled).toBe(false);
  expect(c.textContent).toContain('다른 기기에서 저장한 AI 설정을 불러왔습니다');
});

test('설정 화면을 열어 둔 사이 다른 기기에서 지운 키는 화면에서도 사라진다 — 옛 키를 다시 올리지 않는다', async () => {
  updateAIConfig({ keys: { gemini: 'G' } });
  await syncAISettings();
  const c = await render();
  expect(keyInput(c).value).toBe('G');

  setCloud({ ...cloud, keys: { gemini: '', claude: '' }, changedAt: { gemini: 9 } });   // 다른 기기에서 삭제
  await act(async () => { await syncAISettings(); });                                  // 앱으로 돌아올 때의 동기화
  expect(keyInput(c).value).toBe('');
  expect(cloud.keys.gemini).toBe('');
});

test('입력하던 키는 받아 온 값으로 덮어쓰지 않고, 저장하면 그 칸만 올린다', async () => {
  setCloud({ provider: 'claude', keys: { gemini: '', claude: 'C' }, models: {} });
  const c = await render();
  await flush();
  expect(keyInput(c).value).toBe('C');
  await act(async () => { button(c, 'Gemini').click(); });
  await act(async () => { type(keyInput(c), 'TYPED'); });

  setCloud({ ...cloud, keys: { gemini: 'OTHER', claude: 'C2' }, changedAt: { gemini: 9, claude: 9 } });
  await act(async () => { await syncAISettings(); });
  expect(keyInput(c).value).toBe('TYPED');                           // 고른 공급자·입력하던 키는 그대로

  await act(async () => { button(c, '저장').click(); });
  await flush();
  expect(cloud.keys).toEqual({ gemini: 'TYPED', claude: 'C2' });     // 손대지 않은 Claude 키는 받아 온 그대로
  expect(cloud.provider).toBe('gemini');
  expect(getAIConfig().pending).toEqual({});
});

test('키 삭제는 확인을 받고, 취소하면 아무것도 바꾸지 않는다', async () => {
  updateAIConfig({ keys: { gemini: 'G' } });
  await syncAISettings();
  const c = await render();
  await flush();

  window.confirm = vi.fn(() => false);
  await act(async () => { button(c, '키 삭제').click(); });
  expect(window.confirm).toHaveBeenCalled();
  expect(getAIConfig().keys.gemini).toBe('G');

  window.confirm = vi.fn(() => true);
  await act(async () => { button(c, '키 삭제').click(); });
  await flush();
  expect(getAIConfig().keys.gemini).toBe('');
  expect(cloud.keys.gemini).toBe('');
  expect(c.textContent).toContain('이 기기와 OneDrive에서 지웠습니다');
});

test('다른 공급자 칸에 넣던 키도 저장할 때 버리지 않는다', async () => {
  const c = await render();
  await flush();
  await act(async () => { type(keyInput(c), 'G-NEW'); });               // Gemini 칸
  await act(async () => { button(c, 'Claude').click(); });
  await act(async () => { type(keyInput(c), 'C-NEW'); });               // Claude 칸
  await act(async () => { button(c, '저장').click(); });
  await flush();
  expect(getAIConfig().keys).toEqual({ gemini: 'G-NEW', claude: 'C-NEW' });
  expect(getAIConfig().provider).toBe('claude');
  expect(cloud.keys).toEqual({ gemini: 'G-NEW', claude: 'C-NEW' });
});

test('어디에도 키가 없으면 다른 기기에서 넣는 방법을 알려 준다', async () => {
  const c = await render();
  await flush();
  expect(c.textContent).toContain('그 기기에서 가계부 앱을 한 번 연 뒤');
});

test('다른 공급자 칸을 비워 둔 채 저장해도 그 키를 지우지 않는다 — 삭제는 확인을 받는 키 삭제로만', async () => {
  updateAIConfig({ keys: { gemini: 'G', claude: 'C' } });
  await syncAISettings();
  const c = await render();
  await flush();
  await act(async () => { type(keyInput(c), ''); });                    // Gemini 칸을 비움 (새 키를 붙여 넣으려다)
  await act(async () => { button(c, 'Claude').click(); });
  await act(async () => { type(keyInput(c), 'C-NEW'); });
  await act(async () => { button(c, '저장').click(); });
  await flush();
  expect(getAIConfig().keys).toEqual({ gemini: 'G', claude: 'C-NEW' });
  expect(cloud.keys).toEqual({ gemini: 'G', claude: 'C-NEW' });
});
