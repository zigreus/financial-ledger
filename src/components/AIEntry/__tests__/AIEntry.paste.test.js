/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 영수증 캡처 붙여넣기 (I-020) — 파일로 저장했다 고르지 않고 단축키·붙여넣기 버튼으로 바로 읽는다
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js';
import { createDatabase } from '../../../services/dbManager';
import AIEntry from '../AIEntry';

// 영수증 화면은 받은 파일의 이름·크기만 보여 준다 (실제 화면은 ReceiptPanel.test.js)
vi.mock('../ReceiptPanel', () => ({
  default: ({ files, onClose }) => (
    <div className="fake-receipt">
      <span className="fake-file">{files ? files.map(f => f.name).join(',') : ''}</span>
      <span className="fake-size">{files ? files.map(f => f.size).join(',') : ''}</span>
      <button type="button" onClick={onClose}>닫기</button>
    </div>
  ),
}));
// 말로 입력은 정리하는 중으로 머문다 (AI 응답은 TextPanel 테스트에서)
vi.mock('../../../services/textEntry', () => ({ parseTextEntry: vi.fn(() => new Promise(() => {})), UNCLEAR: 'unclear' }));
vi.mock('../AISettingsForm', () => ({
  default: ({ onSaved, onCancel }) => (
    <div className="fake-settings">
      <button type="button" onClick={() => {
        window.localStorage.setItem('ai_receipt_config', JSON.stringify({ provider: 'gemini', keys: { gemini: 'k' }, models: {} }));
        onSaved();
      }}>설정 저장</button>
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
  ({ db } = createDatabase(SQL, null));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete navigator.clipboard;
  delete window.matchMedia;
  vi.restoreAllMocks();
});

const render = (resetKey = 0) => act(async () => {
  root.render(<AIEntry db={db} onApply={() => {}} onBulkAdd={() => {}} resetKey={resetKey} />);
});
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.closest('[hidden]'));
const click = el => act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)); });
const png = (bytes = 1) => new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' });
const receiptFile = () => container.querySelector('.fake-file')?.textContent ?? null;
const receiptSize = () => container.querySelector('.fake-size')?.textContent ?? null;
const PASTE_BUTTON = '🖼️ 캡처한 영수증 붙여넣기';
const clipboardImage = (bytes = 2) => ({ types: ['image/png'], getType: async () => new Blob([new Uint8Array(bytes)], { type: 'image/png' }) });
const openQuick = () => click(container.querySelector('.ai-entry-main'));
const setValue = (el, value) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
/** AI 입력 상자에 글을 넣고 정리한다 — 카드 문자면 카드 문자 화면, 아니면 말로 입력 화면으로 간다 */
async function submitQuick(text) {
  await openQuick();
  await setValue(container.querySelector('.quick-box textarea'), text);
  await click(button('정리하기'));
}
// 처음 보는 가게라 바로 넣지 않고 카드 문자 화면에서 확인받는다
const NEW_SHOP_SMS = '[Web발신]\n신한카드(1234)승인 홍*동 12,500원(일시불)11/08 12:34 처음가본가게 누적1,234,567원';

/** 붙여넣기 이벤트를 target에서 보낸다(문서까지 올라간다). 기본 붙여넣기를 막았으면 true */
async function paste({ images = [], text = '', target = container } = {}) {
  const e = new Event('paste', { bubbles: true, cancelable: true });
  const items = images.map(f => ({ kind: 'file', type: f.type, getAsFile: () => f }));
  Object.defineProperty(e, 'clipboardData', { value: { items, files: images, getData: t => (t === 'text/plain' ? text : '') } });
  await act(async () => { target.dispatchEvent(e); });
  return e.defaultPrevented;
}

test('빠른 입력 막대가 보일 때 캡처를 단축키로 붙여넣으면 영수증으로 읽는다', async () => {
  await render();
  expect(await paste({ images: [png()] })).toBe(true);
  expect(receiptFile()).toMatch(/^캡처-\d{8}-\d{6}\.png$/);
});

test('영수증 화면에서 다시 붙여넣으면 새 캡처로 바꿔 읽는다', async () => {
  await render();
  await paste({ images: [png(1)] });
  expect(receiptSize()).toBe('1');
  await paste({ images: [png(5)] });
  expect(receiptSize()).toBe('5');
});

test('글 붙여넣기는 가로채지 않는다 — 엑셀처럼 글과 그림이 함께 오면 입력 칸 밖이어도 글로 둔다', async () => {
  await render();
  const input = document.createElement('input');
  container.appendChild(input);
  expect(await paste({ text: '12000' })).toBe(false);
  expect(await paste({ images: [png()], text: '스타벅스 4500', target: input })).toBe(false);
  expect(await paste({ images: [png()], text: '스타벅스 4500' })).toBe(false);
  expect(receiptFile()).toBeNull();
});

test('AI 입력 상자에서 붙여넣은 캡처는 영수증으로 읽는다', async () => {
  await render();
  await openQuick();
  expect(container.querySelector('.quick-box')).not.toBeNull();
  expect(await paste({ images: [png(7)] })).toBe(true);
  expect(receiptSize()).toBe('7');
});

test('말로 입력·카드 문자·AI 설정 화면에서는 붙여넣기를 가로채지 않는다', async () => {
  await render();
  await submitQuick('점심 김치찌개 9천원');
  expect(container.querySelector('.rs-analyzing')).not.toBeNull();   // 말로 입력이 바로 정리하는 중
  expect(container.querySelector('.ai-entry-bar')).toBeNull();
  expect(await paste({ images: [png()] })).toBe(false);

  await render(1);
  await submitQuick(NEW_SHOP_SMS);
  expect(container.textContent).toContain('처음가본가게');
  expect(await paste({ images: [png()] })).toBe(false);

  await render(2);
  await click(button('⚙'));
  expect(container.querySelector('.fake-settings')).not.toBeNull();
  expect(await paste({ images: [png()] })).toBe(false);
  expect(receiptFile()).toBeNull();
});

test('AI 설정 전에 붙여넣으면 설정을 마친 뒤 그 캡처를 읽고, 설정을 취소하면 버린다', async () => {
  window.localStorage.clear();
  await render();
  await paste({ images: [png(3)] });
  expect(container.querySelector('.fake-settings')).not.toBeNull();
  await click(button('설정 저장'));
  expect(receiptSize()).toBe('3');

  await click(button('닫기'));
  window.localStorage.clear();
  await paste({ images: [png(4)] });
  await click(button('설정 취소'));
  expect(receiptFile()).toBeNull();
  // 취소한 캡처는 남지 않는다 — 나중에 설정만 열어 저장해도 그 캡처를 읽지 않는다
  await click(button('⚙'));
  await click(button('설정 저장'));
  expect(receiptFile()).toBeNull();
  expect(container.querySelector('.ai-entry-bar')).not.toBeNull();
});

test('다음 거래로 넘어가면(resetKey) 기다리던 캡처와 붙여넣기 오류를 지운다', async () => {
  window.localStorage.clear();
  await render(0);
  await paste({ images: [png()] });                 // 설정을 기다리는 캡처
  await render(1);
  expect(container.querySelector('.ai-entry-bar')).not.toBeNull();
  await click(button('⚙'));
  await click(button('설정 저장'));
  expect(receiptFile()).toBeNull();

  navigator.clipboard = { read: vi.fn(async () => []) };
  await render(2);
  await click(button(PASTE_BUTTON));
  expect(container.querySelector('.ai-entry-error')).not.toBeNull();
  await render(3);
  expect(container.querySelector('.ai-entry-error')).toBeNull();
});

test('붙여넣기 버튼은 막대 밖에 클립보드를 읽을 수 있을 때만 보이고, 누르면 캡처를 읽는다', async () => {
  await render();
  expect(button(PASTE_BUTTON)).toBeUndefined();

  navigator.clipboard = { read: vi.fn(async () => [clipboardImage(2)]) };
  await render(1);
  const pasteButton = button(PASTE_BUTTON);
  expect(pasteButton.closest('.ai-entry-bar')).toBeNull();
  expect(container.querySelectorAll('.ai-entry-bar .ai-entry-btn')).toHaveLength(1);   // 'AI 입력' 하나 (I-022)
  await click(pasteButton);
  expect(navigator.clipboard.read).toHaveBeenCalledTimes(1);
  expect(receiptSize()).toBe('2');
});

test('붙여넣기 버튼을 눌렀는데 이미지가 없으면 이유를 보여 주고, 다른 화면에 다녀오면 지운다', async () => {
  navigator.clipboard = { read: vi.fn(async () => [{ types: ['text/plain'], getType: async () => new Blob(['x']) }]) };
  await render();
  await click(button(PASTE_BUTTON));
  expect(container.querySelector('.ai-entry-error').textContent).toContain('클립보드에 이미지가 없습니다');
  expect(receiptFile()).toBeNull();
  await openQuick();
  await click(button('닫기'));
  expect(container.querySelector('.ai-entry-error')).toBeNull();
});

test('클립보드를 읽는 동안 다른 화면으로 가면, 늦게 온 결과로 영수증 화면을 열지 않는다', async () => {
  let resolve;
  navigator.clipboard = { read: vi.fn(() => new Promise(r => { resolve = r; })) };
  await render();
  await click(button(PASTE_BUTTON));
  await openQuick();
  await act(async () => { resolve([clipboardImage()]); await new Promise(r => setTimeout(r, 0)); });
  expect(receiptFile()).toBeNull();
  expect(container.querySelector('.quick-box')).not.toBeNull(); // AI 입력 상자 그대로
});

test('마우스가 있는 기기에서는 단축키를 알려 주고(Mac은 ⌘V), 터치 기기에서는 알리지 않는다', async () => {
  window.matchMedia = (q) => ({ matches: q === '(pointer: fine)', addEventListener() {}, removeEventListener() {} });
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
  await render();
  expect(container.querySelector('.ai-entry-hint').textContent).toContain('Ctrl+V');

  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  await render(1);
  expect(container.querySelector('.ai-entry-hint').textContent).toContain('⌘V');

  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  await render(2);
  expect(container.querySelector('.ai-entry-hint')).toBeNull();
});

test('클립보드를 읽는 동안 다음 거래로 넘어가면(resetKey, 같은 막대 화면) 늦게 온 결과를 버린다', async () => {
  let resolve;
  navigator.clipboard = { read: vi.fn(() => new Promise(r => { resolve = r; })) };
  await render(0);
  await click(button(PASTE_BUTTON));
  await render(1);                                      // '추가하고 계속'으로 다음 거래
  await act(async () => { resolve([clipboardImage()]); await new Promise(r => setTimeout(r, 0)); });
  expect(receiptFile()).toBeNull();
  expect(container.querySelector('.ai-entry-bar')).not.toBeNull();
});
