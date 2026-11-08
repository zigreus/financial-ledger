/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 거래내역 검색·필터 강화와 걸러진 결과 요약 (ROADMAP C-7, I-021)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../../services/dbManager';
import { summarizeWithAI } from '../../../services/txSummary';
import TransactionList from '../TransactionList';

vi.mock('../../../services/txSummary', async (importOriginal) => ({ ...(await importOriginal()), summarizeWithAI: vi.fn() }));

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  SQL = await initSqlJs();
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

let db;
let container;
let root;
let props;
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  summarizeWithAI.mockReset();
  ({ db } = M.createDatabase(SQL, null));
  ['신한카드', '현금', '삼성카드'].forEach(n => M.addPaymentMethod(db, n));
  ['식비', '쇼핑', '교통'].forEach(n => M.addBudgetCategory(db, n));
  const add = (o) => M.addTransaction(db, { sub_category: '', discount_amount: 0, ...o });
  add({ date: '2026-11-03', payment_method: '신한카드', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 5000 });
  add({ date: '2026-11-04', payment_method: '현금', budget_category: '식비', sub_category: '시장', detail: '시장', amount: 20000 });
  add({ date: '2026-11-05', payment_method: '삼성카드', budget_category: '쇼핑', detail: '쿠팡', amount: 50000, discount_amount: 5000 });
  add({ date: '2026-10-20', payment_method: '신한카드', budget_category: '교통', detail: '택시', amount: 12000 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    db, dataVersion: 0, onAdd: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onChanged: vi.fn(),
    onOpenImport: vi.fn(), onOpenCardCheck: vi.fn(), onOpenAccount: vi.fn(), onOpenOnboarding: vi.fn(), onOpenSettings: vi.fn(),
  };
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const render = (extra = {}) => act(async () => { root.render(<TransactionList {...props} {...extra} />); });
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text));
const chip = text => [...container.querySelectorAll('.filter-chip')].find(b => b.textContent.trim() === text);
const click = el => act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)); });
function type(el, value) {
  return act(async () => {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
const summary = () => container.querySelector('.fsum');
const totals = () => summary()?.querySelector('.fsum-totals strong').textContent;

async function openFilters() {
  await render();
  await click(button('필터'));
}

test('조건이 없으면 요약을 보이지 않고, 결제수단을 여러 개 고르면 그 거래만 모아 건수·합계·조건을 보여 준다', async () => {
  await openFilters();
  expect(summary()).toBeNull();
  await click(chip('신한카드'));
  await click(chip('현금'));
  expect(totals()).toBe('3건 · 37,000원');
  expect(summary().querySelector('.fsum-filter').textContent).toBe('결제수단 신한카드, 현금');
  await click(chip('현금'));                                   // 다시 누르면 뺀다
  expect(totals()).toBe('2건 · 17,000원');
});

test('금액 범위는 순지출 기준, 잘못된 금액은 이유를 보여 주고 그 조건은 걸지 않는다', async () => {
  await openFilters();
  const [min, max] = container.querySelectorAll('.filter-amount');
  await type(min, '10000');
  expect(totals()).toBe('3건 · 77,000원');                     // 쿠팡은 50,000-5,000=45,000
  await type(max, '20000+5000');
  expect(totals()).toBe('2건 · 32,000원');
  await type(max, '2만');
  // 잘못된 값은 금액 칸이 직접 알리고(같은 이유를 두 번 보이지 않음), 그 칸만 걸지 않는다 — 조용히 0으로 만들지 않는다
  expect(container.querySelectorAll('.formula-error')).toHaveLength(1);
  expect(container.querySelector('.filter-error')).toBeNull();
  expect(totals()).toBe('3건 · 77,000원');                     // 최소 10,000원 조건은 그대로
  await type(max, '20000+');
  expect(container.querySelector('.filter-error').textContent).toBe('최대 금액: 수식을 마저 입력하세요');
});

test('검색어만으로도 요약이 보이고, 구성 보기는 카테고리·많이 쓴 곳을 보여 준다', async () => {
  await render();
  await type(container.querySelector('.filter-search'), '스타');
  expect(totals()).toBe('1건 · 5,000원');
  await type(container.querySelector('.filter-search'), '');
  expect(summary()).toBeNull();

  await click(button('필터'));
  await click(chip('식비'));
  await click(chip('쇼핑'));
  await click(button('구성 보기'));
  const labels = [...container.querySelectorAll('.fsum-bar-label')].map(e => e.textContent);
  expect(labels).toEqual(['쇼핑', '식비']);
  expect(container.querySelector('.fsum-bar-row .fsum-bar-value').textContent).toBe('45,000원 · 64%');
  expect([...container.querySelectorAll('.fsum-detail-name')].map(e => e.textContent)).toEqual(['쿠팡', '시장', '스타벅스']);
});

test('AI 키가 없으면 AI 요약 대신 설정을 열게 한다', async () => {
  await openFilters();
  await click(chip('식비'));
  await click(button('✨ AI 요약'));
  expect(summary().textContent).toContain('AI 키를 먼저 설정해 주세요');
  await click(button('설정 › AI 열기'));
  expect(props.onOpenSettings).toHaveBeenCalledWith('ai');
  expect(summarizeWithAI).not.toHaveBeenCalled();
});

test('AI 요약은 집계와 조건 설명을 보내 받은 문장을 보여 주고, 숫자는 합계가 기준이라고 알린다', async () => {
  window.localStorage.setItem('ai_receipt_config', JSON.stringify({ provider: 'gemini', keys: { gemini: 'k' }, models: {} }));
  summarizeWithAI.mockResolvedValue({ headline: '식비에 25,000원을 썼어요', points: ['시장이 가장 커요', '카페는 한 번'], tip: '장보기를 몰아서 해 보세요' });
  await openFilters();
  await click(chip('식비'));
  await click(button('✨ AI 요약'));
  const call = summarizeWithAI.mock.calls[0][0];
  expect(call.stats).toMatchObject({ count: 2, total: 25000 });
  expect(call.filterText).toBe('카테고리 식비');
  expect(call.signal).toBeInstanceOf(AbortSignal);
  expect(container.querySelector('.fsum-ai-headline').textContent).toBe('식비에 25,000원을 썼어요');
  expect([...container.querySelectorAll('.fsum-ai-points li')].map(e => e.textContent)).toEqual(['시장이 가장 커요', '카페는 한 번']);
  expect(container.querySelector('.fsum-ai-tip').textContent).toContain('장보기를 몰아서');
  expect(container.querySelector('.fsum-ai-note').textContent).toContain('숫자는 위 합계·구성이 기준');
  expect(button('✨ 다시 요약')).toBeTruthy();
});

test('요약을 받는 동안 조건을 바꾸면 그 요청을 취소하고, 늦게 온 답은 보이지 않는다', async () => {
  window.localStorage.setItem('ai_receipt_config', JSON.stringify({ provider: 'gemini', keys: { gemini: 'k' }, models: {} }));
  let resolve;
  summarizeWithAI.mockImplementation(() => new Promise(r => { resolve = r; }));
  await openFilters();
  await click(chip('식비'));
  await click(button('✨ AI 요약'));
  expect(container.querySelector('.fsum-ai-loading')).not.toBeNull();
  const { signal } = summarizeWithAI.mock.calls[0][0];
  await click(chip('쇼핑'));
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve({ headline: '옛 조건의 요약', points: [] }); });
  expect(container.textContent).not.toContain('옛 조건의 요약');
  expect(container.querySelector('.fsum-ai-loading')).toBeNull();

  // 상관없는 거래가 바뀌면(dataVersion만) 받은 요약을 그대로 두고, 걸러진 결과가 바뀌면 버린다
  summarizeWithAI.mockResolvedValue({ headline: '지금 요약', points: [] });
  await click(button('✨ AI 요약'));
  expect(container.textContent).toContain('지금 요약');
  M.addTransaction(db, { date: '2026-11-06', payment_method: '현금', budget_category: '교통', sub_category: '', detail: '버스', amount: 1500 });
  await render({ dataVersion: 1 });
  expect(container.textContent).toContain('지금 요약');
  M.addTransaction(db, { date: '2026-11-07', payment_method: '현금', budget_category: '식비', sub_category: '', detail: '빵', amount: 3000 });
  await render({ dataVersion: 2 });
  expect(container.textContent).not.toContain('지금 요약');
});

test('요약이 실패하면 이유와 다시 시도를 보여 주고, 취소는 오류로 보이지 않는다', async () => {
  window.localStorage.setItem('ai_receipt_config', JSON.stringify({ provider: 'gemini', keys: { gemini: 'k' }, models: {} }));
  summarizeWithAI.mockRejectedValueOnce(new Error('AI 서버가 붐빕니다'));
  await openFilters();
  await click(chip('식비'));
  await click(button('✨ AI 요약'));
  expect(container.querySelector('.fsum-ai-error').textContent).toContain('AI 서버가 붐빕니다');

  summarizeWithAI.mockImplementationOnce(({ signal }) => new Promise((_, rej) => {
    signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
  }));
  await click(button('다시 시도'));
  await click(button('취소'));
  expect(container.querySelector('.fsum-ai-error')).toBeNull();
  expect(container.querySelector('.fsum-ai-loading')).toBeNull();
});

test('지금 필터를 이름 붙여 저장하고, 나중에 한 번에 걸고, 지울 수 있다 — 없어진 이름은 빼고 알린다', async () => {
  await openFilters();
  await click(chip('신한카드'));
  await click(chip('식비'));
  await click(button('＋ 지금 필터 저장'));
  await type(container.querySelector('.saved-filter-name'), '내 카드 식비');
  await click(button('저장'));
  expect(chip('⭐ 내 카드 식비')).toBeTruthy();
  await click(button('초기화'));
  expect(summary()).toBeNull();

  await click(chip('⭐ 내 카드 식비'));
  expect(totals()).toBe('1건 · 5,000원');
  expect(JSON.parse(window.localStorage.getItem('ledger_saved_filters'))[0].name).toBe('내 카드 식비');

  // 다른 화면에서 카테고리 이름을 바꿨다 — 저장한 필터의 '식비'는 이제 없다
  M.renameBudgetCategory(db, '식비', '먹거리');
  await render({ dataVersion: 1 });
  await click(button('초기화'));
  await click(chip('⭐ 내 카드 식비'));
  expect(container.querySelector('.filter-panel').textContent).toContain('지금 가계부에 없는 "식비"은(는) 빼고 걸었어요');
  expect(totals()).toBe('2건 · 17,000원');                     // 신한카드만 걸림

  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  await click(container.querySelector('.saved-filter-del'));
  expect(confirm).toHaveBeenCalledWith('"내 카드 식비" 필터를 지울까요?');
  confirm.mockRestore();
  expect(chip('⭐ 내 카드 식비')).toBeUndefined();
  expect(JSON.parse(window.localStorage.getItem('ledger_saved_filters'))).toEqual([]);
});

test('기간을 직접 입력할 때 거꾸로 된 날짜는 이유를 보여 주고 기간 조건을 걸지 않는다', async () => {
  await openFilters();
  await type(container.querySelector('select[aria-label="기간"]'), 'custom');
  await type(container.querySelector('input[aria-label="시작일"]'), '2026-11-04');
  expect(totals()).toBe('2건 · 65,000원');
  await type(container.querySelector('input[aria-label="끝나는 날"]'), '2026-11-01');
  expect(container.querySelector('.filter-error').textContent).toBe('시작일이 끝나는 날보다 늦습니다');
});

describe('리뷰에서 찾은 경우들', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test('이름 없이 저장하거나 한도를 넘겨 저장해도 화면이 내려가지 않고 이유를 보여 준다', async () => {
    await openFilters();
    await click(chip('현금'));
    await click(button('＋ 지금 필터 저장'));
    await click(button('저장'));
    expect(container.querySelector('.filter-panel').textContent).toContain('필터 이름을 적어 주세요');
    expect(container.querySelector('.filter-bar')).not.toBeNull();

    window.localStorage.setItem('ledger_saved_filters', JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, filters: {} }))));
    act(() => root.unmount());
    root = createRoot(container);
    await openFilters();                                        // '현금' 조건은 이어진다(같은 탭)
    expect(chip('현금').getAttribute('aria-pressed')).toBe('true');
    await click(button('＋ 지금 필터 저장'));
    await type(container.querySelector('.saved-filter-name'), '열한 번째');
    await click(button('저장'));
    expect(container.querySelector('.filter-panel').textContent).toContain('10개까지 저장할 수 있습니다');
    expect(chip('⭐ 열한 번째')).toBeUndefined();
  });

  test('같은 이름으로 저장하거나 지울 때는 묻고, 취소하면 그대로 둔다 — 조건이 없으면 저장 버튼도 없다', async () => {
    await openFilters();
    expect(button('＋ 지금 필터 저장')).toBeUndefined();
    await click(chip('현금'));
    await click(button('＋ 지금 필터 저장'));
    await type(container.querySelector('.saved-filter-name'), '현금만');
    await click(button('저장'));
    await click(chip('삼성카드'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await click(button('＋ 지금 필터 저장'));
    await type(container.querySelector('.saved-filter-name'), '현금만');
    await click(button('저장'));
    expect(confirm).toHaveBeenCalledWith('"현금만" 필터가 이미 있습니다. 지금 조건으로 바꿀까요?');
    expect(JSON.parse(window.localStorage.getItem('ledger_saved_filters'))[0].filters.payment_methods).toEqual(['현금']);
    await click(container.querySelector('.saved-filter-del'));
    expect(chip('⭐ 현금만')).toBeTruthy();
    confirm.mockReturnValue(true);
    await click(container.querySelector('.saved-filter-del'));
    expect(chip('⭐ 현금만')).toBeUndefined();
  });

  test('거래내역 탭을 다시 눌러 오늘로 갈 때 오늘을 빼는 기간만 풀고 다른 조건은 남긴다', async () => {
    await openFilters();
    await type(container.querySelector('select[aria-label="기간"]'), 'last_year');
    await click(chip('현금'));
    await render({ goTodayKey: 1 });
    expect(container.querySelector('select[aria-label="기간"]').value).toBe('');
    expect(chip('현금').getAttribute('aria-pressed')).toBe('true');

    await type(container.querySelector('select[aria-label="기간"]'), 'this_year');   // 오늘이 들어 있는 기간은 그대로
    await render({ goTodayKey: 2 });
    expect(container.querySelector('select[aria-label="기간"]').value).toBe('this_year');
  });

  test('다른 탭에 다녀와도(화면이 새로 그려져도) 걸던 조건이 이어진다', async () => {
    await openFilters();
    await click(chip('식비'));
    await type(container.querySelector('.filter-amount'), '10000');
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(totals()).toBe('1건 · 20,000원');
  });

  test('기간을 고르면 결과에 있는 달을 펼친다', async () => {
    window.sessionStorage.setItem('fl_expanded_months', JSON.stringify([]));
    await openFilters();
    const toggles = () => [...container.querySelectorAll('.month-toggle')].map(e => e.textContent);
    expect(toggles()[1]).toBe('▶');                             // 2026-10 (이번 달은 열 때 펼칠 수 있어 보지 않는다)
    await type(container.querySelector('select[aria-label="기간"]'), 'custom');
    await type(container.querySelector('input[aria-label="시작일"]'), '2026-10-01');
    expect(toggles()).toEqual(['▼', '▼']);
  });

  test('조건에 맞는 거래가 없으면 0건·0원과 조건을 보여 주고 한 번에 풀 수 있다', async () => {
    await openFilters();
    await type(container.querySelector('.filter-search'), '없는 가게');
    const empty = container.querySelector('.empty-state');
    expect(empty.textContent).toContain('조건에 맞는 거래가 없습니다 (0건 · 0원)');
    expect(empty.textContent).toContain('검색어 "없는 가게"');
    await click(button('조건 모두 풀기'));
    expect(container.querySelector('.empty-state')).toBeNull();
  });

  test('패널을 열면 필터바가 붙박이를 풀고, 아래 결과 줄의 결과 보기로 닫는다', async () => {
    await openFilters();
    expect(container.querySelector('.filter-bar').classList.contains('panel-open')).toBe(true);
    await click(chip('신한카드'));
    expect(container.querySelector('.filter-result').textContent).toBe('2건 · 17,000원');
    await click(button('결과 보기'));
    expect(container.querySelector('.filter-panel')).toBeNull();
    expect(container.querySelector('.filter-bar').classList.contains('panel-open')).toBe(false);
    expect(totals()).toBe('2건 · 17,000원');
  });

  test('숨긴 결제수단·카테고리는 접어 두고, 펼치거나 이미 고른 것만 보인다', async () => {
    M.setMasterItemHidden(db, 'payment_methods', M.getAllPaymentMethods(db).find(p => p.name === '삼성카드').id, true);
    await openFilters();
    expect(chip('삼성카드 (숨김)')).toBeUndefined();
    await click(button('숨긴 결제수단·카테고리 1개도 보기'));
    await click(chip('삼성카드 (숨김)'));
    await click(button('숨긴 결제수단·카테고리 접기'));
    expect(chip('삼성카드 (숨김)').getAttribute('aria-pressed')).toBe('true'); // 고른 것은 접어도 보인다
  });
});

describe('리뷰 2차에서 찾은 경우들', () => {
  test('거래내역 탭을 다시 누른 적이 있어도, 다른 탭에 다녀와 새로 그려질 때는 이어 온 기간을 풀지 않는다', async () => {
    await render({ goTodayKey: 1 });                            // 이번 세션에 탭을 한 번 다시 누름
    await click(button('필터'));
    await type(container.querySelector('select[aria-label="기간"]'), 'custom');
    await type(container.querySelector('input[aria-label="시작일"]'), '2026-10-01');
    await type(container.querySelector('input[aria-label="끝나는 날"]'), '2026-10-31');
    await click(chip('신한카드'));
    expect(totals()).toBe('1건 · 12,000원');
    act(() => root.unmount());
    root = createRoot(container);
    await render({ goTodayKey: 1 });                            // 설정 › AI에 다녀옴 — 같은 키로 새로 그려짐
    expect(totals()).toBe('1건 · 12,000원');
  });

  test('음수 금액도 범위로 쓸 수 있다 — 조용히 빼지 않는다', async () => {
    await openFilters();
    const [, max] = container.querySelectorAll('.filter-amount');
    await type(max, '-1');
    expect(container.querySelector('.formula-error')).toBeNull();
    const empty = container.querySelector('.empty-state');
    expect(empty.textContent).toContain('조건에 맞는 거래가 없습니다 (0건 · 0원)');
    expect(empty.textContent).toContain('금액 -1원 이하');
  });

  test('기간 결과의 달을 펼친 뒤 사용자가 접은 달은, 다른 탭에 다녀와도 다시 펼치지 않는다', async () => {
    await openFilters();
    await type(container.querySelector('select[aria-label="기간"]'), 'custom');
    await type(container.querySelector('input[aria-label="시작일"]'), '2026-10-01');
    const header = (ym) => [...container.querySelectorAll('.month-header')].find(h => h.textContent.includes(ym));
    const toggleOf = (ym) => header(ym).querySelector('.month-toggle').textContent;
    expect(toggleOf('2026-10')).toBe('▼');
    await click(header('2026-10'));
    expect(toggleOf('2026-10')).toBe('▶');
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(toggleOf('2026-10')).toBe('▶');
  });
});
