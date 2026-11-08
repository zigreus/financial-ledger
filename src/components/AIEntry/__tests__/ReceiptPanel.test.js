/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 영수증 읽기 화면 — 고른 모델이 붐벼 다른 모델이 대신 읽으면 알려 주고, 새 사진을 고르면 이전 진행 문구·안내를 지운다 (B-064)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ReceiptPanel from '../ReceiptPanel';
import { analyzeReceipt } from '../../../services/receiptAssistant';
import { prepareImage } from '../../../services/imageUtils';
import { familiarity } from '../../../services/quickEntry';

vi.mock('../../../services/receiptAssistant', () => ({
  analyzeReceipt: vi.fn(),
  suggestionToTransaction: (db, s) => ({ detail: s.merchant, amount: s.amount }),
}));
vi.mock('../../../services/quickEntry', () => ({ familiarity: vi.fn() }));
vi.mock('../../../services/imageUtils', () => ({ prepareImage: vi.fn() }));
vi.mock('../SuggestionCard', () => ({ default: () => null }));

global.IS_REACT_ACT_ENVIRONMENT = true;

const IMAGE = { base64: 'AA', mediaType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AA' };
const SUGGESTION = { merchant: '스타벅스', confidence: 'high' };
const NOTE = 'gemini-flash-latest이(가) 붐벼서 gemini-2.5-flash(으)로 읽었습니다';
const BUSY = '서버가 붐벼서 다시 시도하는 중… (1/2)';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

let container;
let root;
beforeEach(() => {
  window.localStorage.clear();
  // activeAI()가 이 설정을 읽는다 — Gemini 기본 모델(gemini-flash-latest)
  window.localStorage.setItem('ai_receipt_config', JSON.stringify({ provider: 'gemini', keys: { gemini: 'k' }, models: {} }));
  analyzeReceipt.mockReset();
  prepareImage.mockReset();
  familiarity.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = file => act(async () => {
  root.render(<ReceiptPanel db={{}} file={file} onApply={() => {}} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} />);
});

test('다른 모델이 대신 읽으면 결과 화면에 그 모델을 알려 준다', async () => {
  prepareImage.mockResolvedValue(IMAGE);
  const answer = deferred();
  analyzeReceipt.mockImplementation(({ onProgress }) => {
    onProgress(BUSY);
    onProgress('gemini-flash-latest이(가) 붐벼서 gemini-2.5-flash(으)로 답을 받았습니다', {
      modelUsed: 'gemini-2.5-flash', requestedModel: 'gemini-flash-latest',
    });
    return answer.promise;
  });

  await render({ name: 'a.jpg', type: 'image/jpeg' });
  await flush();
  expect(container.textContent).toContain(BUSY);           // 읽는 중에는 진행 문구
  expect(container.textContent).not.toContain('읽었습니다'); // 안내는 결과 화면에서만

  await act(async () => { answer.resolve(SUGGESTION); });
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(container.querySelector('.rs-model-note').textContent).toBe(NOTE);
});

test('새 사진을 고르면 이전 사진의 진행 문구와 대신 읽은 모델 안내를 지운다', async () => {
  // 첫 사진: 다른 모델이 대신 읽어 안내가 붙는다
  prepareImage.mockResolvedValue(IMAGE);
  analyzeReceipt.mockImplementationOnce(async ({ onProgress }) => {
    onProgress('…', { modelUsed: 'gemini-2.5-flash', requestedModel: 'gemini-flash-latest' });
    return SUGGESTION;
  });
  await render({ name: 'a.jpg', type: 'image/jpeg' });
  await flush();
  expect(container.querySelector('.rs-model-note')).not.toBeNull();

  // 두 번째 사진: 붐빈다는 진행 문구가 나온 채 응답을 기다린다
  analyzeReceipt.mockImplementationOnce(({ onProgress, signal }) => {
    onProgress(BUSY);
    return new Promise((_, reject) => signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    }));
  });
  await render({ name: 'b.jpg', type: 'image/jpeg' });
  await flush();
  expect(container.textContent).toContain(BUSY);

  // 세 번째 사진: 준비하는 동안 이전 사진의 진행 문구가 남지 않는다
  const preparing = deferred();
  prepareImage.mockReturnValueOnce(preparing.promise);
  await render({ name: 'c.jpg', type: 'image/jpeg' });
  expect(container.textContent).toContain('영수증 읽는 중');
  expect(container.textContent).not.toContain('붐벼서');

  // 이번에는 고른 모델이 바로 읽었다 — 첫 사진의 안내가 다시 나오지 않는다
  analyzeReceipt.mockImplementationOnce(async () => SUGGESTION);
  await act(async () => { preparing.resolve(IMAGE); });
  await flush();
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(container.querySelector('.rs-model-note')).toBeNull();
});

// AI 입력 (I-022) — 늘 가던 가게의 분명한 영수증은 확인 없이 바로 넣는다
const renderQuick = (file, onAutoAdd) => act(async () => {
  root.render(<ReceiptPanel db={{}} file={file} onApply={() => {}} onAutoAdd={onAutoAdd} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} />);
});

test('AI 입력에서 늘 가던 가게의 영수증이면 확인 화면 없이 바로 넣는다', async () => {
  prepareImage.mockResolvedValue(IMAGE);
  analyzeReceipt.mockResolvedValue({ ...SUGGESTION, amount: 5000 });
  familiarity.mockReturnValue({ familiar: true, reason: '' });
  const onAutoAdd = vi.fn();
  await renderQuick({ name: 'a.jpg', type: 'image/jpeg' }, onAutoAdd);
  await flush();
  expect(familiarity).toHaveBeenCalledWith({}, expect.objectContaining({ merchant: '스타벅스' }), 'receipt');
  expect(onAutoAdd).toHaveBeenCalledWith([{ detail: '스타벅스', amount: 5000 }], { remaining: 0 });
  expect(container.textContent).not.toContain('이렇게 입력하시겠습니까?');
});

test('처음 보는 가게면 확인 화면에 그 이유를 보이고, 영수증 버튼(onAutoAdd 없음)에서는 따지지 않는다', async () => {
  prepareImage.mockResolvedValue(IMAGE);
  analyzeReceipt.mockResolvedValue({ ...SUGGESTION, amount: 5000 });
  familiarity.mockReturnValue({ familiar: false, reason: '처음 보는 곳이에요' });
  const onAutoAdd = vi.fn();
  await renderQuick({ name: 'a.jpg', type: 'image/jpeg' }, onAutoAdd);
  await flush();
  expect(onAutoAdd).not.toHaveBeenCalled();
  expect(container.querySelector('.quick-reason').textContent).toBe('확인이 필요한 이유: 처음 보는 곳이에요');

  familiarity.mockClear();
  await render({ name: 'b.jpg', type: 'image/jpeg' });
  await flush();
  expect(familiarity).not.toHaveBeenCalled();
  expect(container.querySelector('.quick-reason')).toBeNull();
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
});
