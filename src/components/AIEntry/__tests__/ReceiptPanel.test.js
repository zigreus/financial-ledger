/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 사진 읽기 화면 — 고른 모델이 붐벼 다른 모델이 대신 읽으면 알려 주고, 새 사진을 고르면 이전 진행 문구·안내를 지운다 (B-064)
// 여러 장·결제 내역 캡처에서 여러 건을 읽으면 목록에서 골라 한 번에 넣는다 (I-052)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ReceiptPanel from '../ReceiptPanel';
import { analyzePhotos, markDuplicates, realMarkDuplicates } from '../../../services/photoEntry';
import { preparePhotos } from '../../../services/imageUtils';
import { familiarity, splitFamiliar } from '../../../services/quickEntry';

// 겹친 결제 다시 따지기는 보통 지금 표시를 그대로 둔다 — 줄 사이가 얽히는 경우는 실제 규칙(realMarkDuplicates)과 가짜 가계부(ledger)로
vi.mock('../../../services/photoEntry', async (importOriginal) => ({
  analyzePhotos: vi.fn(),
  markDuplicates: vi.fn(),
  realMarkDuplicates: (await importOriginal()).markDuplicates,
}));
vi.mock('../../../services/receiptAssistant', async (importOriginal) => ({
  ...(await importOriginal()),
  suggestionToTransaction: (db, s) => ({ detail: s.detail || s.merchant, amount: s.amount, payment_method: s.payment_method }),
  isSuggestionComplete: s => !!s.payment_method && s.amount !== null && s.amount !== undefined,
}));
vi.mock('../../../services/quickEntry', () => ({
  familiarity: vi.fn(),
  splitFamiliar: vi.fn(),
  isCategoryReason: () => false,
  QUICK_REASONS: { existing: '같은 날 같은 금액 거래가 이미 있어요', undone: '되돌린 거래예요' },
}));
vi.mock('../../../services/imageUtils', () => ({ preparePhotos: vi.fn() }));
let memberNames = ['나', '아내'];
let ledger = []; // 가짜 가계부 거래
vi.mock('../../../services/dbManager', () => ({
  getPaymentMethods: () => ['현대EV', '신한카드'],
  getMemberNames: () => memberNames,
  getTransactions: (db, { dateFrom, dateTo }) => ledger.filter(t => t.date >= dateFrom && t.date <= dateTo),
}));
vi.mock('../SuggestionCard', () => ({
  default: () => null,
  amountText: s => `${s.amount}원`,
  SourceBadge: () => null,
  categoryText: () => '',
  CategoryPathSelect: () => null,
  splitCategoryPath: () => ({}),
  Alternatives: () => null,
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
  markDuplicates.mockImplementation((db, list) => list);
  ledger = [];
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
      row('편의점', 3000, { duplicateOf: { id: 9, detail: '편의점', amount: 3000, payment_method: '현대EV' } }),
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
  expect(container.textContent).toContain('이미 넣은 거래가 있어요(편의점 3,000원 · 현대EV)');
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
    suggestions: [row('주유소', 50000, { payment_method: '' }), row('편의점', 3000, { payment_method: '', duplicateOf: { id: 1, detail: '편의점', amount: 3000, payment_method: '현대EV' } })],
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

test('결제수단을 한 번에 바꿔 넣을 수 있게 된 줄은 중복이 아니면 체크된다 (날짜를 못 읽었어도)', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({
    suggestions: [row('주유소', 50000, { payment_method: '', sources: { date: 'today' } }), row('마트', 7000, { payment_method: '' })],
    cancels: [],
    note: '',
  });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  await select('결제수단 모두 바꾸기', '현대EV');
  expect(boxes().map(x => x.checked)).toEqual([true, true]);
});

// 줄마다 고치기 — 날짜·세부내역·금액을 고쳐 넣고, 고칠 때마다 이미 넣은 거래와 다시 대조한다
const typeInto = (el, value) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
const items = () => [...container.querySelectorAll('.tp-item')];
const openEdit = i => act(async () => { items()[i].querySelector('.tp-edit-toggle').click(); });
const field = (i, sel) => items()[i].querySelector(sel);
const amountField = i => field(i, 'input[aria-label="금액"]');

test('고치기로 날짜·세부내역·금액(수식)을 고친 값 그대로 넣는다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({ suggestions: [row('네이버페이', 43950), row('마트', 7000)], cancels: [], note: '' });
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  await openEdit(0);
  await typeInto(field(0, 'input[type=date]'), '2025-01-03');
  await typeInto(field(0, '.tp-edit-row input[type=text]'), '쿠팡 기저귀');
  await typeInto(amountField(0), '40000+3950');
  expect(items()[0].querySelector('b').textContent).toBe('쿠팡 기저귀');
  expect(items()[0].querySelector('small').textContent).toContain('2025-01-03');
  expect(addButton().textContent).toBe('2건 추가 (50,950원)');
  await act(async () => { addButton().click(); });
  expect(onBulkAdd.mock.calls[0][0][0]).toEqual({ detail: '쿠팡 기저귀', amount: 43950, payment_method: '현대EV' });
});

test('금액을 잘못 쓰거나 입력 중이면 그 줄은 넣지 않고 이유를 보인다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({ suggestions: [row('주유소', 50000), row('마트', 7000)], cancels: [], note: '' });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  await openEdit(0);
  await typeInto(amountField(0), '5만');
  expect(boxes()[0].checked).toBe(false);
  expect(boxes()[0].disabled).toBe(true);
  expect(items()[0].textContent).toContain('금액을 확인하세요');
  expect(addButton().textContent).toBe('1건 추가 (7,000원)');
  await typeInto(amountField(0), '50000+');
  expect(items()[0].textContent).toContain('수식을 마저 입력하세요');
  await typeInto(amountField(0), '50000+1000');
  expect(boxes()[0].checked).toBe(true);           // 고쳐서 넣을 수 있게 되면 다시 체크
  expect(addButton().textContent).toBe('2건 추가 (58,000원)');
});

test('고쳐서 이미 넣은 거래와 같아지면 체크를 끄고, 다시 달라지면 켠다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  // 가계부에 3,000원 거래가 있다고 친다
  markDuplicates.mockImplementation((db, list) => list.map(s => ({
    ...s, duplicateOf: s.amount === 3000 ? { id: 5, detail: '다이소', amount: 3000, payment_method: '현대EV' } : null,
  })));
  analyzePhotos.mockResolvedValue({ suggestions: [row('다이소', 1000), row('마트', 7000)], cancels: [], note: '' });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  await openEdit(0);
  await typeInto(amountField(0), '3000');
  expect(boxes()[0].checked).toBe(false);
  expect(items()[0].textContent).toContain('이미 넣은 거래가 있어요(다이소 3,000원 · 현대EV)');
  await typeInto(amountField(0), '1000');
  expect(boxes()[0].checked).toBe(true);
});

test('추가를 누를 때 그사이 들어온 같은 거래가 있으면 넣지 않고 체크를 끈 채 보여 준다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({ suggestions: [row('주유소', 50000), row('마트', 7000)], cancels: [], note: '' });
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  // 다른 기기에서 마트 7,000원을 넣었다
  markDuplicates.mockImplementation((db, list) => list.map(s => ({
    ...s, duplicateOf: s.amount === 7000 ? { id: 7, detail: '마트', amount: 7000, payment_method: '현대EV' } : null,
  })));
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).not.toHaveBeenCalled();
  expect(boxes().map(b => b.checked)).toEqual([true, false]);
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).toHaveBeenCalledWith([expect.objectContaining({ detail: '주유소' })]);
});

test('모두 빼기·모두 고르기 — 고르기는 이미 있는 결제를 빼고 고른다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({
    suggestions: [row('주유소', 50000), row('편의점', 3000, { duplicateOf: { id: 9, detail: '편의점', amount: 3000, payment_method: '현대EV' } }), row('마트', 7000)],
    cancels: [],
    note: '',
  });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  const allButton = () => [...container.querySelectorAll('button')].find(b => /모두 (빼기|고르기)/.test(b.textContent));
  expect(allButton().textContent).toBe('모두 빼기');
  await act(async () => { allButton().click(); });
  expect(boxes().map(b => b.checked)).toEqual([false, false, false]);
  await act(async () => { allButton().click(); });
  expect(boxes().map(b => b.checked)).toEqual([true, false, true]);
  await act(async () => { boxes()[1].click(); });   // 이미 있는 결제도 직접 고르면 넣을 수 있다
  expect(boxes().map(b => b.checked)).toEqual([true, true, true]);
});

// 줄 사이가 얽히는 경우 — 실제 겹침 규칙으로
const useRealRules = () => markDuplicates.mockImplementation((db, list, opts) => realMarkDuplicates(db, list, opts));

test('겹쳐 찍은 짝 중 앞 줄을 고쳐 짝이 풀려도, 뒤 줄은 저절로 체크되지 않는다 (같은 결제 두 번 방지)', async () => {
  useRealRules();
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({
    suggestions: [row('주유소', 50000), row('주유소', 50000, { batchDuplicate: true })], cancels: [], note: '',
  });
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  expect(boxes().map(b => b.checked)).toEqual([true, false]);
  await openEdit(0);
  await typeInto(amountField(0), '');                 // 지우고 다시 쓰는 중에도
  await typeInto(amountField(0), '55000');
  expect(boxes().map(b => b.checked)).toEqual([true, false]);
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).toHaveBeenCalledWith([expect.objectContaining({ amount: 55000 })]);
});

test('직접 고른 체크는 금액을 다시 쓰는 동안(빈 칸·입력 중인 수식) 사라지지 않는다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  const dup = { id: 4, detail: '주유소', amount: 4000, payment_method: '현대EV' };
  analyzePhotos.mockResolvedValue({
    suggestions: [row('주유소', 4000, { duplicateOf: dup }), row('마트', 7000)], cancels: [], note: '',
  });
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  expect(boxes()[0].checked).toBe(false);             // 이미 넣은 거래라 미리 체크하지 않은 줄
  await act(async () => { boxes()[0].click(); });     // 또 넣으려고 직접 고른다
  await openEdit(0);
  await typeInto(amountField(0), '');
  await typeInto(amountField(0), '4000+');
  expect(boxes()[0].checked).toBe(false);             // 넣을 수 없는 동안은 빠진다
  await typeInto(amountField(0), '4000+500');
  expect(boxes()[0].checked).toBe(true);
  await act(async () => { addButton().click(); });
  expect(onBulkAdd.mock.calls[0][0].map(r => r.amount)).toEqual([4500, 7000]);
});

test('이 화면에서 바로 넣은 결제는 남은 줄의 "이미 있는 거래"로 보지 않는다', async () => {
  useRealRules();
  memberNames = [];
  preparePhotos.mockResolvedValue(IMAGE);
  const f = row('가게A', 4500);
  const r = row('가게B', 4500);
  analyzePhotos.mockResolvedValue({ suggestions: [f, r], cancels: [], note: '' });
  splitFamiliar.mockReturnValue({ familiar: [f], review: [{ s: r, reason: '처음 보는 곳이에요' }] });
  // 바로 넣으면 가계부에 들어간다 (같은 날·금액·결제수단)
  const onAutoAdd = vi.fn((rows) => {
    rows.forEach((x, i) => ledger.push({ id: 100 + i, date: '2025-01-01', ...x }));
    return { undo: () => 0, onUndone: () => () => {} };
  });
  const onBulkAdd = vi.fn();
  await renderList({ onAutoAdd, onBulkAdd });
  await flush();
  expect(boxes().map(b => b.checked)).toEqual([true]);
  await openEdit(0);
  await typeInto(field(0, '.tp-edit-row input[type=text]'), '가게B 점심');
  expect(boxes().map(b => b.checked)).toEqual([true]);
  expect(items()[0].textContent).not.toContain('이미 넣은 거래');
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).toHaveBeenCalledWith([expect.objectContaining({ detail: '가게B 점심' })]);
});

test('추가를 누를 때는 체크를 끄기만 한다 — 그사이 겹침이 풀린 줄을 저절로 넣지 않는다', async () => {
  useRealRules();
  ledger = [{ id: 1, date: '2025-01-01', detail: '편의점', amount: 3000, payment_method: '현대EV' }];
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({
    suggestions: [row('편의점', 3000, { duplicateOf: { id: 1, detail: '편의점', amount: 3000, payment_method: '현대EV' } }), row('마트', 7000)],
    cancels: [],
    note: '',
  });
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  expect(boxes().map(b => b.checked)).toEqual([false, true]);
  ledger = [];                                         // 다른 기기에서 그 거래를 지웠다
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).toHaveBeenCalledWith([expect.objectContaining({ detail: '마트' })]);
});

test('그사이 같은 거래가 들어와 뺀 줄이 있으면 이유를 알리고 멈춘다', async () => {
  useRealRules();
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({ suggestions: [row('주유소', 50000), row('마트', 7000)], cancels: [], note: '' });
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  ledger = [{ id: 3, date: '2025-01-01', detail: '마트', amount: 7000, payment_method: '현대EV' }];
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).not.toHaveBeenCalled();
  expect(container.querySelector('[role=alert]').textContent).toContain('같은 거래가 들어와 1건을 뺐어요');
  expect(boxes().map(b => b.checked)).toEqual([true, false]);
});

// 읽은 값으로(되돌리기) — 고친 줄을 사진에서 읽은 값으로
const revertButton = i => [...items()[i].querySelectorAll('button')].find(b => b.textContent.trim() === '읽은 값으로');

test('되돌리기로 고친 날짜·내용·금액·결제수단을 읽은 값으로 돌리고, 금액 칸도 그 값으로 맞춘다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({ suggestions: [row('주유소', 50000), row('마트', 7000)], cancels: [], note: '' });
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  expect(revertButton(0)).toBeUndefined();           // 고치기 전에는 없다
  await openEdit(0);
  await typeInto(field(0, 'input[type=date]'), '2025-01-05');
  await typeInto(field(0, '.tp-edit-row input[type=text]'), '셀프주유');
  await typeInto(amountField(0), '5만');               // 잘못 써서 빠졌다
  await act(async () => {
    const sel = items()[0].querySelector('.tp-item-fields select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, '신한카드');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(boxes()[0].checked).toBe(false);
  await act(async () => { revertButton(0).click(); });
  expect(items()[0].querySelector('b').textContent).toBe('주유소');
  expect(field(0, 'input[type=date]').value).toBe('2025-01-01');
  expect(amountField(0).value).toBe('50000');
  expect(items()[0].querySelector('.tp-item-fields select').value).toBe('현대EV');
  expect(boxes()[0].checked).toBe(true);
  expect(revertButton(0)).toBeUndefined();           // 읽은 값 그대로면 버튼이 사라진다
  await act(async () => { addButton().click(); });
  expect(onBulkAdd.mock.calls[0][0][0]).toEqual({ detail: '주유소', amount: 50000, payment_method: '현대EV' });
});

test('되돌리면 처음의 겹침도 돌아온다 — 이미 넣은 거래와 같던 줄은 다시 체크 없이', async () => {
  useRealRules();
  ledger = [{ id: 1, date: '2025-01-01', detail: '편의점', amount: 3000, payment_method: '현대EV' }];
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({ suggestions: [row('편의점', 3000), row('마트', 7000)], cancels: [], note: '' });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  await openEdit(0);
  await typeInto(amountField(0), '3500');             // 고쳐서 다른 결제가 됐다
  expect(boxes()[0].checked).toBe(true);
  await act(async () => { revertButton(0).click(); });
  expect(boxes()[0].checked).toBe(false);
  expect(items()[0].textContent).toContain('이미 넣은 거래가 있어요');
});

// 결제마다 AI 메모 — 확실하지 않은 점
test('AI가 결제마다 남긴 메모를 그 줄에 보이고, 메모가 있는 결제는 바로 넣지 않는다', async () => {
  memberNames = [];
  preparePhotos.mockResolvedValue(IMAGE);
  const a = row('와플사이', 4500, { aiNote: '날짜 머리글이 잘려 달력에서 고른 11일로 짐작했어요' });
  const b = row('주유소', 50000);
  analyzePhotos.mockResolvedValue({ suggestions: [a, b], cancels: [], note: '' });
  splitFamiliar.mockReturnValue({ familiar: [b], review: [] });
  const onAutoAdd = vi.fn(() => null);
  await renderList({ onAutoAdd });
  await flush();
  expect(splitFamiliar).toHaveBeenCalledWith({}, [b], 'receipt');   // 메모가 있는 줄은 바로 넣을 후보가 아니다
  expect(items()[0].querySelector('.tp-item-ai-note').textContent).toBe('AI 메모: 날짜 머리글이 잘려 달력에서 고른 11일로 짐작했어요');
});

test('중복이 아니면 기본으로 체크된다 — 잘 안 읽혔거나 날짜를 못 읽었거나 AI 메모가 있어도', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({
    suggestions: [
      row('주유소', 50000, { confidence: 'low' }),
      row('와플사이', 4500, { sources: { date: 'today' }, aiNote: '날짜를 짐작했어요' }),
      row('편의점', 3000, { duplicateOf: { id: 9, detail: '편의점', amount: 3000, payment_method: '현대EV' } }),
      row('마트', 7000),
    ],
    cancels: [],
    note: '',
  });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  expect(boxes().map(b => b.checked)).toEqual([true, true, false, true]);
});

test('읽은 값으로 되돌리면 체크도 처음처럼 — 고치며 뺀 체크가 되돌린 뒤에도 남지 않는다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({ suggestions: [row('주유소', 50000), row('마트', 7000)], cancels: [], note: '' });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  await openEdit(0);
  await typeInto(amountField(0), '52000');
  await act(async () => { boxes()[0].click(); });     // 고친 값은 빼 두었다가
  expect(boxes()[0].checked).toBe(false);
  await act(async () => { revertButton(0).click(); });
  expect(boxes()[0].checked).toBe(true);              // 읽은 값으로 돌리면 처음처럼(중복이 아니면 체크)
});

test('되돌린(바로 넣었다 취소한) 거래는 고쳤다 읽은 값으로 돌려도 다시 체크되지 않는다', async () => {
  useRealRules();
  memberNames = [];
  preparePhotos.mockResolvedValue(IMAGE);
  const f = row('가게A', 4500);
  const r = row('가게B', 7000);
  analyzePhotos.mockResolvedValue({ suggestions: [f, r], cancels: [], note: '' });
  splitFamiliar.mockReturnValue({ familiar: [f], review: [{ s: r, reason: '' }] });
  let undone;
  const onAutoAdd = vi.fn(() => ({ undo: () => 1, onUndone: (fn) => { undone = fn; return () => {}; } }));
  await renderList({ onAutoAdd });
  await flush();
  await act(async () => { undone(1); });             // 바로 넣은 가게A를 되돌렸다 — 목록에 체크 없이 돌아온다
  expect(items()[1].textContent).toContain('되돌린 거래예요');
  expect(boxes()[1].checked).toBe(false);
  ledger = [{ id: 9, date: '2025-01-01', detail: '다른곳', amount: 3000, payment_method: '현대EV' }];
  await openEdit(1);
  await typeInto(amountField(1), '3000');             // 고쳐서 이미 있는 거래와 같아졌다가
  await act(async () => { revertButton(1).click(); }); // 읽은 값으로
  expect(boxes()[1].checked).toBe(false);
});

// 수정 필요 — 직접 고쳐야 할 결제(예: 네이버페이)는 굵게 드러낸다
const NAVER_FIX = '네이버페이 결제라 무엇을 샀는지 알 수 없어요 — 세부내역·카테고리를 고쳐 주세요';
const naverFix = () => [{ text: NAVER_FIX, fields: ['detail', 'budget_category', 'sub_category'] }];
const DATE_FIX = '날짜를 읽지 못해 오늘 날짜로 두었어요 — 날짜를 골라 주세요';

test("직접 고쳐야 할 결제는 '수정 필요'를 굵게 보이고, 고치면 사라지며, 읽은 값으로 돌리면 다시 보인다", async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({
    suggestions: [row('네이버페이', 43950, { needsFix: naverFix() }), row('마트', 7000)], cancels: [], note: '',
  });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  expect(items()[0].classList.contains('needs-fix')).toBe(true);
  expect(items()[0].querySelector('.tp-fix-badge').textContent).toBe('수정 필요');
  expect(items()[0].querySelector('.tp-fix-note b').textContent).toBe(NAVER_FIX);
  expect(items()[1].classList.contains('needs-fix')).toBe(false);
  expect(container.querySelector('.rs-fix-count').textContent).toContain('수정 필요 1건');
  expect(boxes()[0].checked).toBe(true);              // 중복이 아니니 체크는 되어 있다
  expect(container.querySelector('.rs-fix-pending').textContent).toContain('수정 필요 1건을 고치지 않은 채 골랐어요');

  // '지금 고치기'로 바로 고치기를 연다
  await act(async () => { [...items()[0].querySelectorAll('button')].find(b => b.textContent === '지금 고치기').click(); });
  await typeInto(field(0, '.tp-edit-row input[type=text]'), '기저귀');
  expect(items()[0].classList.contains('needs-fix')).toBe(false);
  expect(container.querySelector('.rs-fix-count')).toBeNull();
  expect(container.querySelector('.rs-fix-pending')).toBeNull();

  await act(async () => { revertButton(0).click(); });
  expect(items()[0].classList.contains('needs-fix')).toBe(true);
});

test('결제수단만 한 번에 바꿔서는 수정 필요가 풀리지 않는다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({
    suggestions: [row('네이버페이', 43950, { needsFix: naverFix() }), row('마트', 7000)], cancels: [], note: '',
  });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  await select('결제수단 모두 바꾸기', '신한카드');
  expect(items()[0].classList.contains('needs-fix')).toBe(true);
});

test('수정 필요한 결제는 늘 넣던 곳이라도 바로 넣지 않는다', async () => {
  memberNames = [];
  preparePhotos.mockResolvedValue(IMAGE);
  const a = row('네이버페이', 43950, { needsFix: naverFix() });
  const b = row('주유소', 50000);
  analyzePhotos.mockResolvedValue({ suggestions: [a, b], cancels: [], note: '' });
  splitFamiliar.mockReturnValue({ familiar: [b], review: [] });
  await renderList({ onAutoAdd: vi.fn(() => null) });
  await flush();
  expect(splitFamiliar).toHaveBeenCalledWith({}, [b], 'receipt');
});

test('수정 필요는 그 점의 칸을 고쳐야 풀린다 — 네이버페이는 날짜만 고쳐서는 남고, 날짜를 못 읽은 줄은 날짜를 고르면 풀린다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({
    suggestions: [
      row('네이버페이', 43950, { needsFix: [...naverFix(), { text: DATE_FIX, fields: ['date'] }] }),
      row('마트', 7000, { needsFix: [{ text: DATE_FIX, fields: ['date'] }] }),
    ],
    cancels: [],
    note: '',
  });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  expect(items()[0].querySelector('.tp-fix-note b').textContent).toBe(`${NAVER_FIX} · ${DATE_FIX}`);
  expect(container.querySelector('.rs-fix-count').textContent).toContain('수정 필요 2건');
  await openEdit(0);
  await typeInto(field(0, 'input[type=date]'), '2025-01-03');
  expect(items()[0].querySelector('.tp-fix-note b').textContent).toBe(NAVER_FIX);   // 날짜 점만 풀렸다
  await openEdit(1);
  await typeInto(field(1, 'input[type=date]'), '2025-01-02');
  expect(items()[1].classList.contains('needs-fix')).toBe(false);
  expect(container.querySelector('.rs-fix-count').textContent).toContain('수정 필요 1건');
});

test('이미 넣은 결제는 고칠 것이 없다 — 수정 필요를 보이지도 세지도 않는다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue({
    suggestions: [
      row('네이버페이', 43950, { needsFix: naverFix(), duplicateOf: { id: 2, detail: '네이버페이', amount: 43950, payment_method: '현대EV' } }),
      row('마트', 7000),
    ],
    cancels: [],
    note: '',
  });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  expect(items()[0].classList.contains('needs-fix')).toBe(false);
  expect(container.querySelector('.rs-fix-count')).toBeNull();
});

