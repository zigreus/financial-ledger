/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 사진 읽기 화면 — 고른 모델이 붐벼 다른 모델이 대신 읽으면 알려 주고, 새 사진을 고르면 이전 진행 문구·안내를 지운다 (B-064)
// 여러 장·결제 내역 캡처에서 여러 건을 읽으면 목록에서 골라 한 번에 넣는다 (I-052)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ReceiptPanel from '../ReceiptPanel';
import { analyzePhotos } from '../../../services/photoEntry';
import { preparePhotos } from '../../../services/imageUtils';
import { familiarity, splitFamiliar } from '../../../services/quickEntry';

vi.mock('../../../services/photoEntry', () => ({ analyzePhotos: vi.fn() }));
vi.mock('../../../services/receiptAssistant', () => ({
  suggestionToTransaction: (db, s) => ({ detail: s.merchant, amount: s.amount, payment_method: s.payment_method }),
  isSuggestionComplete: s => !!s.payment_method && s.amount !== null && s.amount !== undefined,
}));
vi.mock('../../../services/quickEntry', () => ({
  familiarity: vi.fn(),
  splitFamiliar: vi.fn(),
  QUICK_REASONS: { existing: '같은 날 같은 금액 거래가 이미 있어요', undone: '되돌린 거래예요' },
}));
vi.mock('../../../services/imageUtils', () => ({ preparePhotos: vi.fn() }));
let memberNames = ['나', '아내'];
vi.mock('../../../services/dbManager', () => ({
  getPaymentMethods: () => ['현대EV', '신한카드'],
  getMemberNames: () => memberNames,
}));
vi.mock('../SuggestionCard', () => ({
  default: () => null,
  amountText: s => `${s.amount}원`,
  SourceBadge: () => null,
  categoryText: () => '',
  CategoryPathSelect: () => null,
  splitCategoryPath: () => ({}),
}));

global.IS_REACT_ACT_ENVIRONMENT = true;

const IMAGE = { parts: [{ base64: 'AA', mediaType: 'image/jpeg' }], previews: ['data:image/jpeg;base64,AA'] };
const SUGGESTION = { merchant: '스타벅스', confidence: 'high' };
const one = s => ({ suggestions: [s], cancels: [], note: '' });
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
  analyzePhotos.mockReset();
  preparePhotos.mockReset();
  familiarity.mockReset();
  splitFamiliar.mockReset();
  memberNames = ['나', '아내'];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = file => act(async () => {
  root.render(<ReceiptPanel db={{}} files={[file]} onApply={() => {}} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} />);
});

test('다른 모델이 대신 읽으면 결과 화면에 그 모델을 알려 준다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  const answer = deferred();
  analyzePhotos.mockImplementation(({ onProgress }) => {
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

  await act(async () => { answer.resolve(one(SUGGESTION)); });
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(container.querySelector('.rs-model-note').textContent).toBe(NOTE);
});

test('새 사진을 고르면 이전 사진의 진행 문구와 대신 읽은 모델 안내를 지운다', async () => {
  // 첫 사진: 다른 모델이 대신 읽어 안내가 붙는다
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockImplementationOnce(async ({ onProgress }) => {
    onProgress('…', { modelUsed: 'gemini-2.5-flash', requestedModel: 'gemini-flash-latest' });
    return one(SUGGESTION);
  });
  await render({ name: 'a.jpg', type: 'image/jpeg' });
  await flush();
  expect(container.querySelector('.rs-model-note')).not.toBeNull();

  // 두 번째 사진: 붐빈다는 진행 문구가 나온 채 응답을 기다린다
  analyzePhotos.mockImplementationOnce(({ onProgress, signal }) => {
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
  preparePhotos.mockReturnValueOnce(preparing.promise);
  await render({ name: 'c.jpg', type: 'image/jpeg' });
  expect(container.textContent).toContain('사진 읽는 중');
  expect(container.textContent).not.toContain('붐벼서');

  // 이번에는 고른 모델이 바로 읽었다 — 첫 사진의 안내가 다시 나오지 않는다
  analyzePhotos.mockImplementationOnce(async () => one(SUGGESTION));
  await act(async () => { preparing.resolve(IMAGE); });
  await flush();
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(container.querySelector('.rs-model-note')).toBeNull();
});

// AI 입력 (I-022) — 늘 가던 가게의 분명한 영수증은 확인 없이 바로 넣는다
const renderQuick = (file, onAutoAdd) => act(async () => {
  root.render(<ReceiptPanel db={{}} files={[file]} onApply={() => {}} onAutoAdd={onAutoAdd} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} />);
});

test('AI 입력에서 늘 가던 가게의 영수증이면 확인 화면 없이 바로 넣는다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue(one({ ...SUGGESTION, amount: 5000 }));
  familiarity.mockReturnValue({ familiar: true, reason: '' });
  const onAutoAdd = vi.fn();
  await renderQuick({ name: 'a.jpg', type: 'image/jpeg' }, onAutoAdd);
  await flush();
  expect(familiarity).toHaveBeenCalledWith({}, expect.objectContaining({ merchant: '스타벅스' }), 'receipt');
  expect(onAutoAdd).toHaveBeenCalledWith([{ detail: '스타벅스', amount: 5000 }], { remaining: 0 });
  expect(container.textContent).not.toContain('이렇게 입력하시겠습니까?');
});

test('처음 보는 가게면 확인 화면에 그 이유를 보이고, 영수증 버튼(onAutoAdd 없음)에서는 따지지 않는다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue(one({ ...SUGGESTION, amount: 5000 }));
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

// 여러 장·결제 내역 캡처 (I-052) — 결제가 여러 건이면 목록에서 골라 한 번에 넣는다
const row = (merchant, amount, extra = {}) => ({
  merchant, detail: merchant, amount, date: '2025-01-01', payment_method: '현대EV', paymentHint: '현대카드',
  sources: { date: 'receipt' }, warnings: [], ...extra,
});
const renderList = (props = {}) => act(async () => {
  root.render(<ReceiptPanel db={{}} files={[{ name: 'a.jpg' }, { name: 'b.jpg' }]} onApply={() => {}} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} {...props} />);
});
const addButton = () => [...container.querySelectorAll('.rs-btn-primary')].at(-1);
const boxes = () => [...container.querySelectorAll('.tp-item input[type=checkbox]')];
const select = (label, value) => act(async () => {
  const el = container.querySelector(`select[aria-label="${label}"]`);
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
});

test('결제 내역 여러 건 — 이미 있는 것·겹친 것·취소된 것은 체크 없이, 나머지를 한 번에 넣는다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({
    suggestions: [
      row('주유소', 50000),
      row('편의점', 3000, { duplicateOf: { id: 9 } }),
      row('주유소', 50000, { batchDuplicate: true }),
      row('식당', 12000, { pairedCancel: true }),
      row('마트', 30000),
    ],
    cancels: [{ date: '2026-11-02', merchant: '식당', amount: 12000, paired: true }],
    note: '',
  });
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  expect(container.textContent).toContain('사진에서 결제 5건을 찾았어요');
  expect(boxes().map(b => b.checked)).toEqual([true, false, false, false, true]);
  expect(container.textContent).toContain('같은 날 같은 금액 거래가 이미 있어요');
  expect(container.textContent).toContain('앞 줄과 같은 결제예요');
  expect(container.textContent).toContain('취소·환불 1건은 넣지 않아요');
  expect(addButton().textContent).toBe('2건 추가 (80,000원)');

  await select('누가', '아내');                    // 아내 카드 내역 — '누가'를 한 번에
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).toHaveBeenCalledWith([
    { detail: '주유소', amount: 50000, payment_method: '현대EV', member: '아내' },
    { detail: '마트', amount: 30000, payment_method: '현대EV', member: '아내' },
  ]);
});

test('결제수단을 한 번에 바꾸면 빈 줄이 채워져 체크되고, 이미 있는 결제는 그대로 체크 없이 둔다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({
    suggestions: [row('주유소', 50000, { payment_method: '' }), row('편의점', 3000, { payment_method: '', duplicateOf: { id: 1 } })],
    cancels: [],
    note: '',
  });
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  expect(boxes().map(b => b.checked)).toEqual([false, false]);
  await select('결제수단 모두 바꾸기', '현대EV');
  expect(boxes().map(b => b.checked)).toEqual([true, false]);
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).toHaveBeenCalledWith([{ detail: '주유소', amount: 50000, payment_method: '현대EV' }]); // '누가'는 정하지 않음
});

test('AI 입력에서는 자주 넣던 건을 바로 넣고 나머지만 확인받는다 — 모두 자주 넣던 것이면 목록 없이 끝난다', async () => {
  memberNames = [];                                  // '누가'를 적지 않는 가계부
  preparePhotos.mockResolvedValue(IMAGE);
  const a = row('주유소', 50000);
  const b = row('처음가게', 7000);
  analyzePhotos.mockResolvedValue({ suggestions: [a, b], cancels: [], note: '' });
  splitFamiliar.mockReturnValue({ familiar: [a], review: [{ s: b, reason: '처음 보는 곳이에요' }] });
  const onAutoAdd = vi.fn(() => null);
  await renderList({ onAutoAdd });
  await flush();
  expect(splitFamiliar).toHaveBeenCalledWith({}, [a, b], 'receipt');
  expect(onAutoAdd).toHaveBeenCalledWith([{ detail: '주유소', amount: 50000, payment_method: '현대EV' }], { remaining: 1 });
  expect(container.textContent).toContain('확인이 필요한 결제 1건');
  expect(container.textContent).toContain('처음 보는 곳이에요');

  splitFamiliar.mockReturnValue({ familiar: [a, b], review: [] });
  onAutoAdd.mockClear();
  await renderList({ onAutoAdd, files: [{ name: 'c.jpg' }] });
  await flush();
  expect(onAutoAdd).toHaveBeenCalledWith(expect.any(Array), { remaining: 0 });
});

test('사진에서 결제를 하나도 찾지 못하면 오류로 알린다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({ suggestions: [], cancels: [], note: '' });
  await renderList();
  await flush();
  expect(container.textContent).toContain('사진에서 결제를 찾지 못했습니다');
});

test("'누가'를 적는 가계부이거나 AI가 알릴 점을 남겼으면 바로 넣지 않고 모두 확인받는다", async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  const a = row('주유소', 50000);
  const b = row('마트', 7000);
  analyzePhotos.mockResolvedValue({ suggestions: [a, b], cancels: [], note: '' });
  splitFamiliar.mockReturnValue({ familiar: [a, b], review: [] });
  const onAutoAdd = vi.fn();
  await renderList({ onAutoAdd });
  await flush();
  expect(onAutoAdd).not.toHaveBeenCalled();
  expect(boxes().map(x => x.checked)).toEqual([true, true]);

  memberNames = [];
  analyzePhotos.mockResolvedValue({ suggestions: [a, b], cancels: [], note: '아래쪽이 잘렸습니다' });
  await renderList({ onAutoAdd, files: [{ name: 'c.jpg' }] });
  await flush();
  expect(onAutoAdd).not.toHaveBeenCalled();
  expect(container.textContent).toContain('아래쪽이 잘렸습니다');
});

test('결제수단을 한 번에 바꿔도 날짜를 읽지 못한 줄은 체크하지 않는다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({
    suggestions: [row('주유소', 50000, { payment_method: '', sources: { date: 'today' } }), row('마트', 7000, { payment_method: '' })],
    cancels: [],
    note: '',
  });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  await select('결제수단 모두 바꾸기', '현대EV');
  expect(boxes().map(x => x.checked)).toEqual([false, true]);
});
