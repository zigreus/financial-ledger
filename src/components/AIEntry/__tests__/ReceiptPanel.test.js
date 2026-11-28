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
vi.mock('../../../services/photoEntry', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, analyzePhotos: vi.fn(), markDuplicates: vi.fn(), realMarkDuplicates: real.markDuplicates };
});
vi.mock('../../../services/receiptAssistant', async (importOriginal) => ({
  ...(await importOriginal()),
  suggestionToTransaction: (db, s) => ({ detail: s.detail || s.merchant, amount: s.amount, payment_method: s.payment_method }),
  isSuggestionComplete: s => !!s.payment_method && s.amount !== null && s.amount !== undefined,
}));
vi.mock('../../../services/quickEntry', () => ({
  familiarity: vi.fn(),
  splitFamiliar: vi.fn(),
  isCategoryReason: () => false,
  BLANK_REASON: '빈 칸이 있어요',
  QUICK_REASONS: { existing: '같은 날 같은 금액 거래가 이미 있어요', undone: '되돌린 거래예요' },
}));
vi.mock('../../../services/imageUtils', () => ({ preparePhotos: vi.fn() }));
let memberNames = ['나', '아내'];
let ledger = []; // 가짜 가계부 거래
let detailsProps = null; // 한 건 화면이 SuggestionDetails에 넘긴 것 — 결제수단·카테고리 고르기(onPatch)를 부른다 (I-066)
vi.mock('../../../services/dbManager', () => ({
  getPaymentMethods: () => ['현대EV', '신한카드'],
  getMemberNames: () => memberNames,
  getTransactions: (db, { dateFrom, dateTo }) => ledger.filter(t => t.date >= dateFrom && t.date <= dateTo),
  hasForeignAmount: () => false,
}));
vi.mock('../SuggestionCard', () => ({
  default: (props) => { detailsProps = props; return null; },
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
// 사진이 2024-12-30 ~ 2025-01-03을 보여 주게 하는 앞뒤 결제 — 사진의 첫날·끝날 기록은 고치기를 미리 고르지 않으므로 (I-065)
const FRAME = [row('교보문고', 12000, { date: '2024-12-30' }), row('올리브영', 5000, { date: '2025-01-03' })];
const renderList = (props = {}) => act(async () => {
  root.render(<ReceiptPanel db={{}} files={[{ name: 'a.jpg' }, { name: 'b.jpg' }]} onApply={() => {}} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} {...props} />);
});
const addButton = () => [...container.querySelectorAll('.rs-btn-primary')].at(-1);
const boxes = () => [...container.querySelectorAll('.tp-item input[type=checkbox]')];
// 줄마다 넣기 체크와 '수정 권장'의 고치기 체크 (I-065)
const addBox = i => [...container.querySelectorAll('.tp-item')][i].querySelector('.tp-item-head input[type=checkbox]');
const fixBox = i => [...container.querySelectorAll('.tp-item')][i].querySelector('.rs-near-fix input[type=checkbox]');
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
  analyzePhotos.mockResolvedValue({ suggestions: [row('편의점', 3000), row('마트', 7000), ...FRAME], cancels: [], note: '' });
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  await openEdit(0);
  await typeInto(amountField(0), '3500');             // 고쳐서 금액이 다른 같은 결제가 됐다 — 넣지 않고 고치기를 권한다 (I-065)
  expect(addBox(0).checked).toBe(false);
  expect(fixBox(0).checked).toBe(true);
  await act(async () => { revertButton(0).click(); });
  expect(addBox(0).checked).toBe(false);
  expect(fixBox(0)).toBeNull();
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


// 설명 덧붙여 다시 읽기 (I-063) — 사진에 없는 것(나눠 냄·누구 것·일부만)을 적으면 사진을 그 설명과 함께 처음부터 다시 읽는다
const noteLink = () => [...container.querySelectorAll('button')].find(b => b.textContent === '+ 설명 덧붙여 다시 읽기');
const noteBox = () => container.querySelector('.tp-followup textarea');
const rereadButton = () => [...container.querySelectorAll('.tp-followup button')].find(b => b.textContent === '다시 읽기');
const buttonNamed = name => [...container.querySelectorAll('button')].find(b => b.textContent === name);
const writeNote = async (text) => {
  if (!noteBox()) await act(async () => { noteLink().click(); });
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(noteBox(), text);
    noteBox().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const sentNotes = () => analyzePhotos.mock.calls.map(c => c[0].notes);

test('한 건 결과에서 설명을 덧붙이면 같은 사진을 설명과 함께 다시 읽고, 덧붙인 설명은 화면에 남는다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValueOnce(one({ ...SUGGESTION, amount: 30000 }));
  const onApply = vi.fn();
  await act(async () => {
    root.render(<ReceiptPanel db={{}} files={[{ name: 'a.jpg' }]} onApply={onApply} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} />);
  });
  await flush();
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  await writeNote('친구랑 반반 냈어요');
  expect(buttonNamed('이대로 채우기').disabled).toBe(true);       // 쓴 설명을 두고 채우지 않게
  expect(container.textContent).toContain("'다시 읽기'를 누르거나 지우면");

  analyzePhotos.mockResolvedValueOnce(one({ ...SUGGESTION, amount: 15000 }));
  await act(async () => { rereadButton().click(); });
  await flush();
  expect(sentNotes()).toEqual([[], ['친구랑 반반 냈어요']]);
  expect(analyzePhotos.mock.calls[1][0].parts).toBe(IMAGE.parts); // 같은 사진을 다시 보낸다
  expect(container.querySelector('.tp-quote').textContent).toContain('친구랑 반반 냈어요');
  expect(noteBox()).toBeNull();                                    // 상자는 닫히고 링크만
  await act(async () => { buttonNamed('이대로 채우기').click(); });
  expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ amount: 15000 }));

  // 또 덧붙이면 앞 설명과 함께 보낸다
  analyzePhotos.mockResolvedValueOnce(one({ ...SUGGESTION, amount: 15000 }));
  await writeNote('현금이었어요');
  await act(async () => { rereadButton().click(); });
  await flush();
  expect(sentNotes()[2]).toEqual(['친구랑 반반 냈어요', '현금이었어요']);
});

test('설명과 함께 다시 읽는 중에 취소하거나 실패하면 앞 결과로 돌아가고, 쓰던 설명은 상자에 남는다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValueOnce({ suggestions: [row('주유소', 50000), row('마트', 7000)], cancels: [], note: '' });
  const onClose = vi.fn();
  await renderList({ onBulkAdd: vi.fn(), onClose });
  await flush();
  await openEdit(1);
  await typeInto(amountField(1), '8000');                         // 직접 고친 값

  analyzePhotos.mockImplementationOnce(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
  })));
  await writeNote('마트는 생활용품이에요');
  await act(async () => { rereadButton().click(); });
  expect(container.textContent).toContain('설명과 함께 다시 읽는 중');
  await act(async () => { buttonNamed('취소').click(); });
  await flush();
  expect(onClose).not.toHaveBeenCalled();
  expect(container.textContent).toContain('사진에서 결제 2건을 찾았어요');
  expect(addButton().textContent).toBe('2건 추가 (58,000원)');    // 고친 값(마트 8,000원)도 그대로
  expect(noteBox().value).toBe('마트는 생활용품이에요');

  const busy = new Error('요청이 너무 많습니다'); busy.kind = 'quota';
  analyzePhotos.mockRejectedValueOnce(busy);
  await act(async () => { rereadButton().click(); });
  await flush();
  expect(container.textContent).toContain('사진에서 결제 2건을 찾았어요');
  expect(container.querySelector('.tp-followup .rs-error-text').textContent).toBe('요청이 너무 많습니다');
  expect([...container.querySelectorAll('.tp-followup button')].some(b => b.textContent === 'AI 설정')).toBe(true);
  expect(noteBox().value).toBe('마트는 생활용품이에요');
  expect(addButton().disabled).toBe(true);                        // 쓴 설명이 남아 있는 동안은 추가하지 않는다
});

test('설명을 덧붙였으면 늘 넣던 결제라도 바로 넣지 않고 확인받는다 — 처음부터 설명과 함께 온 사진도', async () => {
  memberNames = [];
  preparePhotos.mockResolvedValue(IMAGE);
  familiarity.mockReturnValue({ familiar: true, reason: '' });
  const onAutoAdd = vi.fn(() => null);
  // 사진과 함께 온 설명 (AI 입력 상자에 먼저 쓴 글)
  analyzePhotos.mockResolvedValueOnce(one({ ...SUGGESTION, amount: 5000 }));
  await act(async () => {
    root.render(<ReceiptPanel db={{}} files={[{ name: 'a.jpg' }]} initialNotes={['  회사 경비예요 ']} onApply={() => {}} onAutoAdd={onAutoAdd} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} />);
  });
  await flush();
  expect(sentNotes()[0]).toEqual(['회사 경비예요']);
  expect(onAutoAdd).not.toHaveBeenCalled();
  expect(familiarity).not.toHaveBeenCalled();
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(container.querySelector('.tp-quote').textContent).toContain('회사 경비예요');

  // 여러 건을 읽은 뒤 덧붙인 설명 — 다시 읽은 결과도 바로 넣지 않는다
  splitFamiliar.mockReturnValue({ familiar: [], review: [] });
  analyzePhotos.mockResolvedValueOnce({ suggestions: [row('주유소', 50000), row('마트', 7000)], cancels: [], note: '' });
  await renderList({ onAutoAdd, files: [{ name: 'b.jpg' }] });
  await flush();
  expect(sentNotes()[1]).toEqual([]);                              // 새 사진 — 앞 설명은 따라가지 않는다
  splitFamiliar.mockClear();
  const a = row('주유소', 50000);
  analyzePhotos.mockResolvedValueOnce({ suggestions: [a, row('마트', 7000)], cancels: [], note: '' });
  splitFamiliar.mockReturnValue({ familiar: [a], review: [] });
  await writeNote('남편 카드 내역이에요');
  await act(async () => { rereadButton().click(); });
  await flush();
  expect(splitFamiliar).not.toHaveBeenCalled();
  expect(onAutoAdd).not.toHaveBeenCalled();
  expect(boxes().map(b => b.checked)).toEqual([true, true]);
});

test('결제를 찾지 못한 화면에서도 설명을 덧붙여 다시 읽을 수 있다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValueOnce({ suggestions: [], cancels: [], note: '' });
  await renderList();
  await flush();
  expect(container.textContent).toContain('사진에서 결제를 찾지 못했습니다');
  expect(buttonNamed('다시 시도')).toBeDefined();
  await writeNote('토스 송금 내역이에요 — 3만원 보낸 것');
  expect(buttonNamed('다시 시도')).toBeUndefined();               // 쓴 설명을 버리고 다시 시도하지 않게

  analyzePhotos.mockResolvedValueOnce({ suggestions: [], cancels: [], note: '' });
  await act(async () => { rereadButton().click(); });
  await flush();
  expect(container.querySelector('.tp-followup .rs-error-text').textContent).toContain('설명과 함께 읽어도 결제를 찾지 못했어요');

  analyzePhotos.mockResolvedValueOnce(one({ ...SUGGESTION, amount: 30000 }));
  await act(async () => { rereadButton().click(); });
  await flush();
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(sentNotes().slice(1)).toEqual([['토스 송금 내역이에요 — 3만원 보낸 것'], ['토스 송금 내역이에요 — 3만원 보낸 것']]);
});

test('바로 넣은 뒤 설명과 함께 다시 읽으면 그 결제는 새 목록의 "이미 넣은 거래"로, 되돌리면 "되돌린 거래"로 (두 번 넣지 않게)', async () => {
  useRealRules();
  memberNames = [];
  preparePhotos.mockResolvedValue(IMAGE);
  const f = row('주유소', 50000);
  const r = row('마트', 7000);
  analyzePhotos.mockResolvedValueOnce({ suggestions: [f, r], cancels: [], note: '' });
  splitFamiliar.mockReturnValue({ familiar: [f], review: [{ s: r, reason: '처음 보는 곳이에요' }] });
  let undone;
  const onAutoAdd = vi.fn((rows) => {
    rows.forEach((x, i) => ledger.push({ id: 100 + i, date: '2025-01-01', ...x }));
    return { undo: () => 1, onUndone: (fn) => { undone = fn; return () => {}; } };
  });
  const onBulkAdd = vi.fn();
  await renderList({ onAutoAdd, onBulkAdd });
  await flush();
  expect(onAutoAdd).toHaveBeenCalledTimes(1);

  // 다시 읽은 결과 — 바로 넣은 주유소도 다시 읽힌다(사진 읽기가 가계부와 대조해 '이미 넣은 거래'로 표시)
  const dup = { id: 100, date: '2025-01-01', detail: '주유소', amount: 50000, payment_method: '현대EV' };
  analyzePhotos.mockResolvedValueOnce({ suggestions: [row('주유소', 50000, { duplicateOf: dup }), row('마트', 7000)], cancels: [], note: '' });
  await writeNote('마트는 생활용품이에요');
  await act(async () => { rereadButton().click(); });
  await flush();
  expect(onAutoAdd).toHaveBeenCalledTimes(1);
  expect(boxes().map(b => b.checked)).toEqual([false, true]);
  expect(items()[0].textContent).toContain('이미 넣은 거래가 있어요');
  expect(container.textContent).toContain('자주 넣던 1건은 바로 추가했어요');  // 되돌리기는 그대로

  // 다른 줄을 고쳐도 '이미 넣은 거래'는 풀리지 않는다 (앞서 바로 넣은 것은 이제 새 목록의 줄이 대신한다)
  await openEdit(1);
  await typeInto(amountField(1), '7500');
  expect(items()[0].textContent).toContain('이미 넣은 거래가 있어요');
  expect(boxes()[0].checked).toBe(false);

  // 되돌리면 줄을 더하지 않고, 그 줄이 체크 없이 '되돌린 거래'가 된다
  ledger = ledger.filter(t => t.id !== 100);
  await act(async () => { undone(1); });
  expect(items().length).toBe(2);
  expect(items()[0].textContent).toContain('되돌린 거래예요');
  expect(boxes().map(b => b.checked)).toEqual([false, true]);
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).toHaveBeenCalledWith([expect.objectContaining({ detail: '마트', amount: 7500 })]);
});

// 리뷰에서 찾은 경우 (I-063) — 다시 읽은 결과가 앞서 바로 넣은·되돌린 결제와 겹치면 저절로 체크하지 않는다
function autoAddedList() {
  useRealRules();
  memberNames = [];
  preparePhotos.mockResolvedValue(IMAGE);
  const f = row('주유소', 50000);
  analyzePhotos.mockResolvedValueOnce({ suggestions: [f, row('마트', 7000)], cancels: [], note: '' });
  splitFamiliar.mockReturnValue({ familiar: [f], review: [] });
  const ctl = { undone: null };
  const onAutoAdd = vi.fn((rows) => {
    rows.forEach((x, i) => ledger.push({ id: 100 + i, date: '2025-01-01', ...x }));
    return { undo: () => 1, onUndone: (fn) => { ctl.undone = fn; return () => {}; } };
  });
  return { ctl, onAutoAdd };
}
const undoAutoAdded = ctl => act(async () => { ledger = ledger.filter(t => t.id !== 100); ctl.undone(1); });

test('설명대로 금액이 바뀐 결제가 앞서 바로 넣은 것과 같은 곳·같은 날이면 체크 없이 알리고, 되돌리면 "설명대로 다시 읽은 것"으로 (두 번 넣지 않게)', async () => {
  const { ctl, onAutoAdd } = autoAddedList();
  const onBulkAdd = vi.fn();
  await renderList({ onAutoAdd, onBulkAdd });
  await flush();
  analyzePhotos.mockResolvedValueOnce({ suggestions: [row('주유소', 25000), row('마트', 7000)], cancels: [], note: '' });
  await writeNote('주유소는 반반 냈어요');
  await act(async () => { rereadButton().click(); });
  await flush();
  expect(boxes().map(b => b.checked)).toEqual([false, true]);
  expect(items()[0].textContent).toContain('앞에서 바로 넣은 결제와 같은 곳·같은 날이에요');

  await undoAutoAdded(ctl);
  expect(items().length).toBe(2);
  expect(items()[0].textContent).toContain('되돌린 결제를 설명대로 다시 읽은 것 같아요');
  expect(boxes().map(b => b.checked)).toEqual([false, true]);
  await act(async () => { boxes()[0].click(); });                 // 맞으면 직접 고른다
  await act(async () => { addButton().click(); });
  expect(onBulkAdd.mock.calls[0][0].map(r => r.amount)).toEqual([25000, 7000]);
});

test('바로 넣었다 되돌린 거래는 설명과 함께 다시 읽어도 체크 없이 "되돌린 거래"로 돌아온다', async () => {
  const { ctl, onAutoAdd } = autoAddedList();
  await renderList({ onAutoAdd, onBulkAdd: vi.fn() });
  await flush();
  await undoAutoAdded(ctl);
  expect(boxes().map(b => b.checked)).toEqual([true, false]);       // 마트, 되돌린 주유소
  analyzePhotos.mockResolvedValueOnce({ suggestions: [row('주유소', 50000), row('마트', 7000)], cancels: [], note: '' });
  await writeNote('마트는 생활용품이에요');
  await act(async () => { rereadButton().click(); });
  await flush();
  expect(boxes().map(b => b.checked)).toEqual([false, true]);
  expect(items()[0].textContent).toContain('되돌린 거래예요');
});

test('설명과 함께 읽은 한 건이 이미 넣은 거래와 같으면, 바로 넣기를 따지지 않아도 확인 화면에 그 이유를 보인다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  const dup = { id: 7, date: '2025-01-01', detail: '스타벅스', amount: 5000, payment_method: '현대EV' };
  analyzePhotos.mockResolvedValueOnce(one({ ...SUGGESTION, amount: 5000, duplicateOf: dup }));
  await act(async () => {
    root.render(<ReceiptPanel db={{}} files={[{ name: 'a.jpg' }]} initialNotes={['회사 경비예요']} onApply={() => {}} onAutoAdd={vi.fn()} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} />);
  });
  await flush();
  expect(familiarity).not.toHaveBeenCalled();
  expect(container.querySelector('.quick-reason').textContent).toContain('이미 넣은 거래가 있어요(스타벅스 5,000원 · 현대EV)');
});

test('설명 없이 다시 시도하면 지난 "다시 읽기" 오류는 지운다', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValueOnce({ suggestions: [], cancels: [], note: '' });
  await renderList();
  await flush();
  await writeNote('카드 이용내역이에요');
  const busy = new Error('요청이 너무 많습니다'); busy.kind = 'quota';
  analyzePhotos.mockRejectedValueOnce(busy);
  await act(async () => { rereadButton().click(); });
  await flush();
  expect(container.querySelector('.tp-followup .rs-error-text').textContent).toBe('요청이 너무 많습니다');
  // 오류 화면에는 'AI 설정'이 이미 있다 — 설명 상자에 또 두지 않는다
  expect([...container.querySelectorAll('button')].filter(b => b.textContent === 'AI 설정').length).toBe(1);
  await writeNote('');
  analyzePhotos.mockResolvedValueOnce(one({ ...SUGGESTION, amount: 5000 }));
  await act(async () => { buttonNamed('다시 시도').click(); });
  await flush();
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(container.textContent).not.toContain('요청이 너무 많습니다');
  expect(noteBox()).toBeNull();
});

test('설명은 보내는 그대로 화면에 남는다 — 많으면 첫 설명과 최근 것만', async () => {
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockResolvedValue(one({ ...SUGGESTION, amount: 5000 }));
  await act(async () => {
    root.render(<ReceiptPanel db={{}} files={[{ name: 'a.jpg' }]} initialNotes={['설명1', '설명2', '설명3', '설명4', '설명5', '설명6']} onApply={() => {}} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} />);
  });
  await flush();
  await writeNote('설명7');
  await act(async () => { rereadButton().click(); });
  await flush();
  const sent = sentNotes().at(-1);
  expect(sent).toEqual(['설명1', '설명3', '설명4', '설명5', '설명6', '설명7']);
  expect(container.querySelector('.tp-quote').textContent).not.toContain('설명2');
  expect(container.querySelector('.tp-quote').textContent).toContain('설명7');
});

// 다시 리뷰에서 찾은 경우 (I-063) — 바로 넣은 결제와 같은 곳·같은 날인 줄은 모두 체크 없이, 고쳐도 저절로 체크되지 않게
async function rereadWith(next, note = '설명') {
  analyzePhotos.mockResolvedValueOnce(next);
  await writeNote(note);
  await act(async () => { rereadButton().click(); });
  await flush();
}

test('품목대로 나뉜 줄은 바로 넣은 결제와 같은 곳·같은 날이면 모두 체크 없이 둔다', async () => {
  const { onAutoAdd } = autoAddedList();                                          // 주유소 50,000 바로 넣음
  await renderList({ onAutoAdd, onBulkAdd: vi.fn() });
  await flush();
  await rereadWith({ suggestions: [row('주유소', 40000), row('주유소', 10000), row('마트', 7000)], cancels: [], note: '' }, '세차는 따로');
  expect(boxes().map(b => b.checked)).toEqual([false, false, true]);
  expect(items()[1].textContent).toContain('앞에서 바로 넣은 결제와 같은 곳·같은 날이에요');
});

test('같은 곳 결제가 둘이면 어느 줄이 바로 넣은 것인지 알 수 없어 그곳 줄을 모두 체크 없이 둔다', async () => {
  useRealRules();
  memberNames = [];
  preparePhotos.mockResolvedValue(IMAGE);
  const a = row('스타벅스', 4500);
  analyzePhotos.mockResolvedValueOnce({ suggestions: [a, row('스타벅스', 6000)], cancels: [], note: '' });
  splitFamiliar.mockReturnValue({ familiar: [a], review: [] });
  const onAutoAdd = vi.fn((rows) => {
    rows.forEach((x, i) => ledger.push({ id: 100 + i, date: '2025-01-01', ...x }));
    return { undo: () => 1, onUndone: () => () => {} };
  });
  await renderList({ onAutoAdd, onBulkAdd: vi.fn() });
  await flush();
  await rereadWith({ suggestions: [row('스타벅스', 6000), row('스타벅스', 2250)], cancels: [], note: '' }, '4500원은 반반');
  expect(boxes().map(b => b.checked)).toEqual([false, false]);
});

test('체크 없이 둔 줄(바로 넣은 결제와 같은 곳)은 고쳐서 넣을 수 있게 돼도 저절로 체크되지 않고 이유가 남는다', async () => {
  const { onAutoAdd } = autoAddedList();
  await renderList({ onAutoAdd, onBulkAdd: vi.fn() });
  await flush();
  await rereadWith({ suggestions: [row('주유소', 25000, { payment_method: '' }), row('마트', 7000)], cancels: [], note: '' }, '주유소는 반반');
  expect(boxes().map(b => b.checked)).toEqual([false, true]);
  await act(async () => {
    const sel = items()[0].querySelector('.tp-item-fields select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, '현대EV');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(boxes()[0].checked).toBe(false);
  expect(items()[0].textContent).toContain('앞에서 바로 넣은 결제와 같은 곳·같은 날이에요');
});

test('설명 빼고 다시 읽기 — 넘겨받은 설명이 맞지 않으면 설명 없이 다시 읽고, 다시 읽은 결과는 바로 넣지 않는다', async () => {
  memberNames = [];
  preparePhotos.mockResolvedValue(IMAGE);
  familiarity.mockReturnValue({ familiar: true, reason: '' });
  const onAutoAdd = vi.fn(() => null);
  analyzePhotos.mockResolvedValueOnce(one({ ...SUGGESTION, amount: 2500 }));
  await act(async () => {
    root.render(<ReceiptPanel db={{}} files={[{ name: 'a.jpg' }]} initialNotes={['반반 냈어요']} onApply={() => {}} onAutoAdd={onAutoAdd} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} />);
  });
  await flush();
  const drop = () => buttonNamed('설명 빼고 다시 읽기');
  await writeNote('현금');
  expect(drop()).toBeUndefined();                                  // 쓰는 중인 설명이 있으면 그 상자부터
  await writeNote('');
  const answer = deferred();
  analyzePhotos.mockReturnValueOnce(answer.promise);
  await act(async () => { drop().click(); });
  expect(container.textContent).toContain('설명 없이 다시 읽는 중');
  await act(async () => { answer.resolve(one({ ...SUGGESTION, amount: 5000 })); });
  await flush();
  expect(sentNotes().at(-1)).toEqual([]);
  expect(onAutoAdd).not.toHaveBeenCalled();
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(container.querySelector('.tp-quote')).toBeNull();
  expect(drop()).toBeUndefined();
});

test('한 건 화면에서도 바로 넣은 결제를 되돌리면 이유를 맞춘다 — "이미 넣은 거래"로 남지 않게', async () => {
  const { ctl, onAutoAdd } = autoAddedList();
  await renderList({ onAutoAdd, onBulkAdd: vi.fn() });
  await flush();
  const dup = { id: 100, date: '2025-01-01', detail: '주유소', amount: 50000, payment_method: '현대EV' };
  await rereadWith(one(row('주유소', 50000, { duplicateOf: dup, confidence: 'high' })), '마트는 다른 사람 거예요');
  expect(container.querySelector('.quick-reason').textContent).toContain('이미 넣은 거래가 있어요');
  await undoAutoAdded(ctl);
  expect(container.querySelector('.quick-reason').textContent).toContain('되돌린 거래예요');
});

test("'모두 고르기'는 체크 없이 둔 줄(바로 넣은 결제와 같은 곳)을 켜지 않고, 그 줄 때문에 '모두 고르기'로 보이지도 않는다", async () => {
  const { onAutoAdd } = autoAddedList();
  await renderList({ onAutoAdd, onBulkAdd: vi.fn() });
  await flush();
  await rereadWith({ suggestions: [row('주유소', 25000), row('마트', 7000), row('카페', 3000)], cancels: [], note: '' }, '주유소는 반반');
  const allButton = () => [...container.querySelectorAll('button')].find(b => /모두 (빼기|고르기)/.test(b.textContent));
  expect(boxes().map(b => b.checked)).toEqual([false, true, true]);
  expect(allButton().textContent).toBe('모두 빼기');
  await act(async () => { allButton().click(); });
  expect(boxes().map(b => b.checked)).toEqual([false, false, false]);
  await act(async () => { allButton().click(); });
  expect(boxes().map(b => b.checked)).toEqual([false, true, true]);
});

// ── 수정 권장 (I-065) — 가계부에 금액·날짜를 다르게 적은 같은 결제는 넣지 않고 그 기록을 사진대로 고치게 권한다 ──
const STARBUCKS_TX = { id: 4, date: '2025-01-01', detail: '스타벅스', amount: 6000, payment_method: '현대EV' };
/** 사진을 읽은 결과 — 실제 규칙으로 가계부(ledger)와 대조해 둔다 (analyzePhotos가 하는 것처럼) */
const readWithRealRules = (suggestions) => {
  useRealRules();
  preparePhotos.mockResolvedValue(IMAGE);
  analyzePhotos.mockImplementation(async () => ({ suggestions: realMarkDuplicates({}, suggestions), cancels: [], note: '' }));
};

test('금액이 다르게 적힌 같은 결제는 넣지 않고 고치기를 미리 골라 두며, 추가 버튼이 고치기도 함께 반영한다', async () => {
  ledger = [STARBUCKS_TX];
  readWithRealRules([row('스타벅스', 6500), row('마트', 7000), ...FRAME]);
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  expect(container.querySelector('.rs-near-count').textContent).toContain('수정 권장 1건');
  expect(items()[0].querySelector('.tp-near-badge').textContent).toBe('수정 권장');
  expect(items()[0].textContent).toContain('가계부: 2025-01-01 · 스타벅스 6,000원 · 현대EV');
  expect(items()[0].textContent).toContain('가계부 기록을 사진대로 고치기 — 금액 6,000원 → 6,500원');
  expect(items()[0].textContent).toContain('가계부에 금액이 다르게 적힌 같은 결제가 있어요');
  expect([addBox(0).checked, fixBox(0).checked, addBox(1).checked]).toEqual([false, true, true]);
  expect(addButton().textContent).toBe('3건 추가 (24,000원) · 1건 고치기');
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).toHaveBeenCalledWith(
    [
      { detail: '마트', amount: 7000, payment_method: '현대EV' },
      { detail: '교보문고', amount: 12000, payment_method: '현대EV' },
      { detail: '올리브영', amount: 5000, payment_method: '현대EV' },
    ],
    { updates: [{ id: 4, amount: 6500, date: '2025-01-01' }] },
  );
});

test('넣기와 고치기는 함께 고르지 않는다 — 하나를 고르면 다른 하나가 풀리고, 고치기만 골라도 반영할 수 있다', async () => {
  ledger = [STARBUCKS_TX];
  readWithRealRules([row('스타벅스', 6500), row('마트', 7000), ...FRAME]);
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  await act(async () => { addBox(0).click(); });          // 따로 결제한 것 — 새로 넣는다
  expect([addBox(0).checked, fixBox(0).checked]).toEqual([true, false]);
  await act(async () => { fixBox(0).click(); });          // 다시 고치기로
  expect([addBox(0).checked, fixBox(0).checked]).toEqual([false, true]);
  // '모두 빼기'는 넣기 체크만 — 고치기는 그대로 남는다
  const allButton = [...container.querySelectorAll('button')].find(b => b.textContent === '모두 빼기');
  await act(async () => { allButton.click(); });
  expect(fixBox(0).checked).toBe(true);
  expect(addButton().textContent).toBe('1건 고치기');
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).toHaveBeenCalledWith([], { updates: [{ id: 4, amount: 6500, date: '2025-01-01' }] });
});

test('결제수단을 정하지 않아 넣을 수 없는 줄도 가계부 기록은 고칠 수 있다 — 고치기는 기록의 분류·결제수단을 쓴다', async () => {
  ledger = [STARBUCKS_TX];
  readWithRealRules([row('스타벅스', 6500, { payment_method: '' }), row('마트', 7000), ...FRAME]);
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  expect(addBox(0).disabled).toBe(true);
  expect([fixBox(0).disabled, fixBox(0).checked]).toEqual([false, true]);
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).toHaveBeenCalledWith(expect.any(Array), { updates: [{ id: 4, amount: 6500, date: '2025-01-01' }] });
});

test('사진의 첫날·끝날 기록이면(잘린 다른 결제일 수 있음) 고치기를 미리 고르지 않는다', async () => {
  ledger = [STARBUCKS_TX];
  readWithRealRules([row('스타벅스', 6500), row('마트', 7000)]);   // 사진은 2025-01-01 하루
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  expect([addBox(0).checked, fixBox(0).checked]).toEqual([false, false]);
  expect(items()[0].textContent).toContain('사진의 첫날·끝날이거나');
  expect(addButton().textContent).toBe('1건 추가 (7,000원)');
});

test('망설일 이유(할부 등)가 있으면 고치기를 미리 고르지 않고 그 이유를 보인다', async () => {
  ledger = [{ ...STARBUCKS_TX, amount: 100000 }];
  readWithRealRules([row('스타벅스', 300000, { installment: '3개월' }), row('마트', 7000)]);
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  expect([addBox(0).checked, fixBox(0).checked]).toEqual([false, false]);
  expect(items()[0].textContent).toContain('할부 결제예요');
  expect(addButton().textContent).toBe('1건 추가 (7,000원)');
});

test('나눠 결제한 한 몫이면 고치기를 보이지 않고 거래내역에서 고치라고 알린다', async () => {
  ledger = [{ ...STARBUCKS_TX, split_group_id: 'g1' }];
  readWithRealRules([row('스타벅스', 6500), row('마트', 7000)]);
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  expect(fixBox(0)).toBeNull();
  expect(items()[0].textContent).toContain('나눠 결제한 거래의 한 몫이에요');
  expect(addBox(0).checked).toBe(false);
});

test('가계부에 나눠 적은 결제는 이미 있는 거래로 — 고치기 없이 체크도 하지 않는다', async () => {
  ledger = [
    { id: 5, date: '2025-01-01', detail: '이마트 장보기', amount: 20000, payment_method: '현대EV' },
    { id: 6, date: '2025-01-01', detail: '이마트 세제', amount: 10000, payment_method: '현대EV' },
  ];
  readWithRealRules([row('이마트', 30000), row('마트', 7000)]);
  await renderList({ onBulkAdd: vi.fn() });
  await flush();
  expect(items()[0].textContent).toContain('나눠 적은 거래 2건이 이미 있어요');
  expect(items()[0].querySelector('.tp-near-badge')).toBeNull();
  expect(fixBox(0)).toBeNull();
  expect(addBox(0).checked).toBe(false);
});

test('추가를 누를 때 고칠 기록이 그사이 바뀌었으면 고치지 않고 이유를 알린다', async () => {
  ledger = [STARBUCKS_TX];
  readWithRealRules([row('스타벅스', 6500), row('마트', 7000), ...FRAME]);
  const onBulkAdd = vi.fn();
  await renderList({ onBulkAdd });
  await flush();
  ledger = [{ ...STARBUCKS_TX, amount: 6500 }];           // 다른 기기에서 이미 고쳤다
  await act(async () => { addButton().click(); });
  expect(onBulkAdd).not.toHaveBeenCalled();
  expect(container.querySelector('[role=alert]').textContent).toContain('고칠 거래 1건을 뺐어요');
  expect(items()[0].textContent).toContain('이미 넣은 거래가 있어요');
  expect(fixBox(0)).toBeNull();
});

test('한 건 화면에서도 금액이 다르게 적힌 같은 결제면 그 기록을 바로 고칠 수 있다', async () => {
  ledger = [STARBUCKS_TX];
  preparePhotos.mockResolvedValue(IMAGE);
  useRealRules();
  analyzePhotos.mockImplementation(async () => one(realMarkDuplicates({}, [row('스타벅스', 6500, { confidence: 'high' })])[0]));
  const onBulkAdd = vi.fn();
  await act(async () => {
    root.render(<ReceiptPanel db={{}} files={[{ name: 'a.jpg' }]} onApply={() => {}} onBulkAdd={onBulkAdd} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} />);
  });
  await flush();
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(container.textContent).toContain('가계부에 금액이 다르게 적힌 같은 결제가 있어요');
  const fixButton = [...container.querySelectorAll('button')].find(b => b.textContent === '가계부 기록 고치기');
  await act(async () => { fixButton.click(); });
  expect(onBulkAdd).toHaveBeenCalledWith([], { updates: [{ id: 4, amount: 6500, date: '2025-01-01' }] });
});

test('한 건 화면의 고치기도 누른 순간 다시 대조한다 — 그사이 기록이 이미 고쳐졌으면 고치지 않고 알린다', async () => {
  ledger = [STARBUCKS_TX];
  preparePhotos.mockResolvedValue(IMAGE);
  useRealRules();
  analyzePhotos.mockImplementation(async () => one(realMarkDuplicates({}, [row('스타벅스', 6500, { confidence: 'high' })])[0]));
  const onBulkAdd = vi.fn();
  await act(async () => {
    root.render(<ReceiptPanel db={{}} files={[{ name: 'a.jpg' }]} onApply={() => {}} onBulkAdd={onBulkAdd} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} />);
  });
  await flush();
  ledger = [{ ...STARBUCKS_TX, amount: 6500 }];           // 다른 기기에서 이미 고쳤다
  const fixButton = [...container.querySelectorAll('button')].find(b => b.textContent === '가계부 기록 고치기');
  await act(async () => { fixButton.click(); });
  expect(onBulkAdd).not.toHaveBeenCalled();
  expect(container.textContent).toContain('이미 넣은 거래가 있어요');
  expect([...container.querySelectorAll('button')].some(b => b.textContent === '가계부 기록 고치기')).toBe(false);
});

describe('한 건 화면의 이대로 넣기 — 입력 창 없이 바로 넣는다 (I-066)', () => {
  const paid = (o = {}) => row('스타벅스', 6500, { budget_category: '식비', sub_category: '커피', confidence: 'high', ...o });
  const renderOne = (props = {}) => act(async () => {
    root.render(<ReceiptPanel db={{}} files={[{ name: 'a.jpg' }]} onApply={() => {}} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} {...props} />);
  });

  test('다 읽혔으면 이대로 넣기가 기본 버튼이고, 누르면 그 결제를 바로 넣는다 — 이대로 채우기는 입력 창을 채운다', async () => {
    readWithRealRules([paid()]);
    const onBulkAdd = vi.fn();
    const onApply = vi.fn();
    await renderOne({ onBulkAdd, onApply });
    await flush();
    expect(buttonNamed('이대로 넣기').className).toContain('rs-btn-primary');
    expect(buttonNamed('이대로 채우기').className).toContain('rs-btn-secondary');
    await act(async () => { buttonNamed('이대로 넣기').click(); });
    expect(onBulkAdd).toHaveBeenCalledWith([{ detail: '스타벅스', amount: 6500, payment_method: '현대EV' }]);
    await act(async () => { buttonNamed('이대로 채우기').click(); });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ amount: 6500, payment_method: '현대EV' }));
  });

  test('결제수단·금액을 모르면 바로 넣지 않고 이유를 보인다', async () => {
    readWithRealRules([paid({ payment_method: '' })]);
    await renderOne({ onBulkAdd: vi.fn() });
    await flush();
    expect(buttonNamed('이대로 넣기').disabled).toBe(true);
    expect(container.querySelector('.rs-add-note').textContent).toBe('결제수단을 고르면 바로 넣을 수 있어요');

    readWithRealRules([paid({ amount: null })]);
    await act(async () => {
      root.render(<ReceiptPanel db={{}} files={[{ name: 'b.jpg' }]} onApply={() => {}} onBulkAdd={vi.fn()} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} />);
    });
    await flush();
    expect(buttonNamed('이대로 넣기').disabled).toBe(true);
    expect(container.querySelector('.rs-add-note').textContent).toContain('금액을 몰라 바로 넣을 수 없어요');
  });

  test('이미 넣은 거래와 같으면 기본 버튼 없이 그래도 넣기로 — 알고 누르면 넣는다', async () => {
    ledger = [{ ...STARBUCKS_TX, amount: 6500 }];
    readWithRealRules([paid()]);
    const onBulkAdd = vi.fn();
    await renderOne({ onBulkAdd });
    await flush();
    expect(container.textContent).toContain('이미 넣은 거래가 있어요');
    expect(buttonNamed('이대로 넣기')).toBeUndefined();
    expect(buttonNamed('그래도 넣기').className).toContain('rs-btn-secondary');
    await act(async () => { buttonNamed('그래도 넣기').click(); });
    expect(onBulkAdd).toHaveBeenCalledTimes(1);
  });

  test('누른 순간 다시 대조한다 — 그사이 같은 거래가 들어왔으면 넣지 않고 알린다', async () => {
    readWithRealRules([paid()]);
    const onBulkAdd = vi.fn();
    await renderOne({ onBulkAdd });
    await flush();
    ledger = [{ ...STARBUCKS_TX, amount: 6500 }];          // 다른 기기에서 같은 결제를 넣었다
    await act(async () => { buttonNamed('이대로 넣기').click(); });
    expect(onBulkAdd).not.toHaveBeenCalled();
    expect(container.querySelector('.quick-reason').textContent).toContain('이미 넣은 거래가 있어요');
    expect(buttonNamed('그래도 넣기')).toBeDefined();
  });

  test('바로 넣을 곳이 없으면(onBulkAdd 없음) 전처럼 이대로 채우기만', async () => {
    readWithRealRules([paid()]);
    await renderOne();
    await flush();
    expect(buttonNamed('이대로 넣기')).toBeUndefined();
    expect(buttonNamed('이대로 채우기').className).toContain('rs-btn-primary');
  });
});

describe('한 건 화면에서 결제수단·카테고리 고르기 (I-066)', () => {
  const paid = (o = {}) => row('스타벅스', 6500, { budget_category: '식비', sub_category: '커피', confidence: 'high', ...o });
  const renderOne = (props = {}) => act(async () => {
    root.render(<ReceiptPanel db={{}} files={[{ name: 'a.jpg' }]} onApply={() => {}} onBulkAdd={vi.fn()} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} {...props} />);
  });
  const pick = p => act(async () => { detailsProps.onPatch(p); });

  test("결제수단을 고르면 바로 넣을 수 있고, 빈 칸 때문에 확인받던 이유는 지운다", async () => {
    readWithRealRules([paid({ payment_method: '', sources: { date: 'receipt', payment_method: 'ai' } })]);
    familiarity.mockReturnValue({ familiar: false, reason: '빈 칸이 있어요' });
    await renderOne({ onAutoAdd: vi.fn() });
    await flush();
    expect(container.querySelector('.quick-reason').textContent).toBe('확인이 필요한 이유: 빈 칸이 있어요');
    expect(buttonNamed('이대로 넣기').disabled).toBe(true);
    await pick({ payment_method: '현대EV' });
    expect(container.querySelector('.quick-reason')).toBeNull();
    expect(buttonNamed('이대로 넣기').disabled).toBe(false);
    expect(detailsProps.suggestion.payment_method).toBe('현대EV');
    expect(detailsProps.suggestion.sources.payment_method).toBeUndefined(); // 직접 고른 것 — 근거 표시를 지운다
  });

  test('고른 결제수단으로 이미 넣은 거래와 겹치면 그 이유를 보이고 그래도 넣기로 — 다시 바꾸면 풀린다', async () => {
    ledger = [{ id: 9, date: '2025-01-01', detail: '편의점', amount: 6500, payment_method: '신한카드' }];
    readWithRealRules([paid()]);
    await renderOne();
    await flush();
    expect(container.querySelector('.quick-reason')).toBeNull();
    await pick({ payment_method: '신한카드' });
    expect(container.querySelector('.quick-reason').textContent).toContain('이미 넣은 거래가 있어요(편의점 6,500원 · 신한카드)');
    expect(buttonNamed('그래도 넣기')).toBeDefined();
    await pick({ payment_method: '현대EV' });
    expect(container.querySelector('.quick-reason')).toBeNull();
    expect(buttonNamed('이대로 넣기').className).toContain('rs-btn-primary');
  });
});

describe('한 건 화면의 이유 맞추기 (I-066 리뷰)', () => {
  const paid = (o = {}) => row('스타벅스', 6500, { budget_category: '식비', sub_category: '커피', confidence: 'high', ...o });
  const renderOne = (props = {}) => act(async () => {
    root.render(<ReceiptPanel db={{}} files={[{ name: 'a.jpg' }]} onApply={() => {}} onBulkAdd={vi.fn()} onRepick={() => {}} onClose={() => {}} onSetup={() => {}} {...props} />);
  });

  test('바로 넣기를 따진 한 건도 겹친 결제면 그 자세한 이유를 보이고, 결제수단을 바꿔 겹침이 풀리면 지운다', async () => {
    ledger = [{ id: 9, date: '2025-01-01', detail: '편의점', amount: 6500, payment_method: '현대EV' }];
    readWithRealRules([paid()]);
    familiarity.mockReturnValue({ familiar: false, reason: '이미 넣은 거래 같아요' });
    await renderOne({ onAutoAdd: vi.fn() });
    await flush();
    expect(container.querySelector('.quick-reason').textContent).toContain('이미 넣은 거래가 있어요(편의점 6,500원 · 현대EV)');
    expect(buttonNamed('그래도 넣기')).toBeDefined();
    await act(async () => { detailsProps.onPatch({ payment_method: '신한카드' }); });
    expect(container.querySelector('.quick-reason')).toBeNull();
    expect(buttonNamed('이대로 넣기').className).toContain('rs-btn-primary');
  });

  test('다른 후보를 고르면 겹친 결제를 다시 따진다 — 바뀐 세부내역이 이미 넣은 거래와 같으면 그래도 넣기로', async () => {
    ledger = [{ id: 9, date: '2025-01-01', detail: '편의점', amount: 6500, payment_method: '신한카드' }];
    const past = { kind: 'past', budget_category: '식비', sub_category: '간식', detail: '편의점', categorySource: 'history', detailSource: 'history' };
    readWithRealRules([paid({ merchant: '', detail: '스타벅스', alternatives: [{ kind: 'first', budget_category: '식비', sub_category: '커피', detail: '스타벅스' }, past] })]);
    await renderOne();
    await flush();
    expect(buttonNamed('이대로 넣기')).toBeDefined();
    await act(async () => { detailsProps.onUseAlternative(past); });
    expect(detailsProps.suggestion.detail).toBe('편의점');
    expect(container.querySelector('.quick-reason').textContent).toContain('이미 넣은 거래가 있어요(편의점 6,500원 · 신한카드)');
    expect(buttonNamed('그래도 넣기')).toBeDefined();
  });
});
