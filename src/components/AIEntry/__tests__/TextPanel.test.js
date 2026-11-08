/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 말로 입력 화면 — 고른 모델이 붐벼 다른 모델이 대신 정리하면 알려 주고, 다시 정리하면 이전 안내·진행 문구를 지운다 (B-064)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import TextPanel from '../TextPanel';
import { parseTextEntry } from '../../../services/textEntry';

vi.mock('../../../services/textEntry', () => ({ parseTextEntry: vi.fn() }));
vi.mock('../../../services/receiptAssistant', () => ({ isSuggestionComplete: () => true, suggestionToTransaction: (db, s) => s }));
vi.mock('../../../services/dbManager', () => ({ getPaymentMethods: () => [] }));
vi.mock('../SuggestionCard', () => ({ default: () => null }));
vi.mock('../SuggestionItem', () => ({ default: () => null, patchListItem: (it, patch) => ({ ...it, ...patch }) }));

global.IS_REACT_ACT_ENVIRONMENT = true;

const NOTE = 'gemini-flash-latest이(가) 붐벼서 gemini-2.5-flash(으)로 정리했습니다';
const BUSY = '서버가 붐벼서 다시 시도하는 중… (1/2)';
const USED = { modelUsed: 'gemini-2.5-flash', requestedModel: 'gemini-flash-latest' };
const entry = (detail, amount) => ({ detail, amount });

let container;
let root;
beforeEach(() => {
  window.localStorage.clear();
  // activeAI()가 이 설정을 읽는다 — Gemini 기본 모델(gemini-flash-latest)
  window.localStorage.setItem('ai_receipt_config', JSON.stringify({ provider: 'gemini', keys: { gemini: 'k' }, models: {} }));
  parseTextEntry.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () => act(async () => {
  root.render(<TextPanel db={{}} onApply={() => {}} onBulkAdd={() => {}} onClose={() => {}} onSetup={() => {}} />);
});
const typeText = (value) => act(() => {
  const el = container.querySelector('textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.includes(text));
const click = text => act(async () => { button(text).click(); });
const note = () => container.querySelector('.rs-model-note');

test('다른 모델이 대신 정리하면 한 건 결과 화면에 그 모델을 알려 준다', async () => {
  parseTextEntry.mockImplementation(async ({ onProgress }) => {
    onProgress(BUSY);
    onProgress('…답을 받았습니다', USED);
    return [entry('김치찌개', 9000)];
  });
  await render();
  await typeText('점심 김치찌개 9천원');
  await click('정리하기');
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(note().textContent).toBe(NOTE);
});

test('여러 건 결과에도 안내를 보여 주고, 다시 정리하면 이전 진행 문구와 안내를 지운다', async () => {
  parseTextEntry.mockImplementationOnce(async ({ onProgress }) => {
    onProgress(BUSY);
    onProgress('…답을 받았습니다', USED);
    return [entry('김치찌개', 9000), entry('스타벅스', 4500)];
  });
  await render();
  await typeText('김치찌개 9천원, 스타벅스 4500');
  await click('정리하기');
  expect(container.textContent).toContain('2건으로 정리했어요');
  expect(note().textContent).toBe(NOTE);

  // 다시 쓰기 → 다시 정리: 응답을 기다리는 동안 이전 진행 문구가 보이지 않는다
  let finish;
  parseTextEntry.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await click('다시 쓰기');
  await click('정리하기');
  expect(container.textContent).toContain('정리하는 중');
  expect(container.textContent).not.toContain('붐벼서');

  // 이번에는 고른 모델이 바로 정리했다 — 이전 안내가 다시 나오지 않는다
  await act(async () => { finish([entry('김치찌개', 9000), entry('스타벅스', 4500)]); });
  expect(container.textContent).toContain('2건으로 정리했어요');
  expect(note()).toBeNull();
});
