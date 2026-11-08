/**
 * @vitest-environment jsdom
 */
// 말로 입력 화면 — 정보가 모자라면 되묻고, 덧붙여 말하면 처음 말과 합쳐 다시 정리한다 (I-017)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js';
import { createDatabase } from '../../../services/dbManager';
import { AIError } from '../../../services/aiClient';
import TextPanel from '../TextPanel';
import { parseTextEntry } from '../../../services/textEntry';

vi.mock('../../../services/textEntry', () => ({ parseTextEntry: vi.fn(), UNCLEAR: 'unclear' }));

global.IS_REACT_ACT_ENVIRONMENT = true;

let SQL;
let db;
let container;
let root;
let onBulkAdd;
let onSetup;
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('ai_receipt_config', JSON.stringify({ provider: 'gemini', keys: { gemini: 'k' }, models: {} }));
  parseTextEntry.mockReset();
  ({ db } = createDatabase(SQL, null));
  db.run("INSERT INTO payment_methods (name) VALUES ('현금'),('신한카드')");
  db.run("INSERT INTO budget_categories (name) VALUES ('식비')");
  db.run("INSERT INTO sub_categories (budget_category, name) VALUES ('식비','점심'),('식비','커피')");
  onBulkAdd = vi.fn();
  onSetup = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const sug = o => ({
  date: '2026-11-08', merchant: '', detail: '', amount: null, currency: 'KRW', foreignAmount: null, rate: 0,
  event_id: null, eventTitle: '', payment_method: '', paymentHint: '', budget_category: '', sub_category: '',
  items: [], historyDetail: '', historyCount: 0, confidence: 'high', warnings: [], sources: {}, ...o,
});
const full = o => sug({ detail: '김치찌개', amount: 9000, payment_method: '현금', budget_category: '식비', sub_category: '점심', ...o });

const render = () => act(async () => {
  root.render(<TextPanel db={db} onApply={() => {}} onBulkAdd={onBulkAdd} onClose={() => {}} onSetup={onSetup} />);
});
const setValue = (el, value) => act(() => {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});
const firstText = () => container.querySelector('.rs-box > textarea');
const followText = () => container.querySelector('.tp-followup textarea');
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const click = text => act(async () => { button(text).click(); });
const lastCall = () => parseTextEntry.mock.calls[parseTextEntry.mock.calls.length - 1][0];

async function say(text) {
  await render();
  await setValue(firstText(), text);
  await click('정리하기');
}

test('결제 건을 못 찾으면 실패 대신 무엇이 부족한지 묻고, 덧붙인 말과 합쳐 다시 정리한다', async () => {
  parseTextEntry.mockRejectedValueOnce(new AIError('무엇을 얼마에 사셨나요?', 'unclear'));
  await say('오늘 좀 썼어');
  expect(container.textContent).toContain('조금 더 알려 주세요');
  expect(container.querySelector('.tp-ask').textContent).toBe('무엇을 얼마에 사셨나요?');
  expect(container.querySelector('.rs-error-text')).toBeNull();
  expect(document.activeElement).toBe(followText());          // 바로 이어 말할 수 있게

  parseTextEntry.mockResolvedValueOnce([full({})]);
  await setValue(followText(), '점심 김치찌개 9천원 현금');
  await click('덧붙여 정리하기');
  expect(lastCall()).toMatchObject({
    text: '오늘 좀 썼어',
    followUps: [{ asked: '무엇을 얼마에 사셨나요?', said: '점심 김치찌개 9천원 현금' }],
  });
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(container.querySelector('.tp-quote').textContent).toBe('“오늘 좀 썼어”+ “점심 김치찌개 9천원 현금”');
  expect(container.querySelector('.tp-followup')).toBeNull();  // 다 채워졌으면 덧붙이기 상자는 없다
});

test('정리한 건에 빠진 정보가 있으면 알려 주고, 덧붙인 말로 채운다', async () => {
  parseTextEntry.mockResolvedValueOnce([full({ amount: null, payment_method: '' })]);
  await say('점심 김치찌개');
  expect(container.querySelector('.tp-followup-title').textContent).toContain('빠진 정보가 있어요');
  expect(container.querySelector('.tp-gaps').textContent).toBe('금액·결제수단');
  expect(followText().placeholder).toBe('예) 9천원이었어요, 현금으로 냈어요');
  expect(button('덧붙여 정리하기').disabled).toBe(true);

  parseTextEntry.mockResolvedValueOnce([full({})]);
  await setValue(followText(), '9천원 현금');
  await click('덧붙여 정리하기');
  expect(lastCall().followUps).toEqual([{ asked: '금액·결제수단을(를) 몰라요. 알려 주세요.', said: '9천원 현금' }]);
  expect(container.querySelector('.tp-followup')).toBeNull();
});

test('덧붙여 정리하다 실패하면 이전 결과와 쓰던 말을 그대로 두고 이유를 보여 준다. 취소하면 결과 화면으로 돌아간다', async () => {
  parseTextEntry.mockResolvedValueOnce([full({ amount: null })]);
  await say('점심 김치찌개');

  parseTextEntry.mockRejectedValueOnce(new AIError('네트워크 오류 — 인터넷 연결을 확인하세요', 'network'));
  await setValue(followText(), '9천원');
  await click('덧붙여 정리하기');
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(container.querySelector('.tp-followup .rs-error-text').textContent).toContain('네트워크 오류');
  expect(followText().value).toBe('9천원');

  // 결제 건을 못 찾았다는 답이어도 이미 정리한 결과는 지우지 않는다
  parseTextEntry.mockRejectedValueOnce(new AIError('무엇을 사셨나요?', 'unclear'));
  await click('덧붙여 정리하기');
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(container.querySelector('.tp-followup .rs-error-text').textContent).toBe('덧붙인 말을 반영하지 못했어요 — 무엇을 사셨나요?');

  parseTextEntry.mockImplementationOnce(() => new Promise(() => {}));
  await click('덧붙여 정리하기');
  expect(container.textContent).toContain('덧붙인 말과 합쳐 정리하는 중');
  await click('취소');
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
  expect(followText().value).toBe('9천원');
});

test('다시 쓰기는 지금까지 말한 것을 한 글로 모아 준다', async () => {
  parseTextEntry.mockRejectedValueOnce(new AIError('얼마였나요?', 'unclear'));
  await say('점심 김치찌개');
  parseTextEntry.mockResolvedValueOnce([full({ payment_method: '' })]);
  await setValue(followText(), '9천원');
  await click('덧붙여 정리하기');

  await click('다시 쓰기');
  expect(firstText().value).toBe('점심 김치찌개\n9천원');
  parseTextEntry.mockResolvedValueOnce([full({})]);
  await click('정리하기');
  expect(lastCall()).toMatchObject({ text: '점심 김치찌개\n9천원', followUps: [] });
});

test('여러 건 목록에서 고른 결제수단은 덧붙여 다시 정리해도 남는다', async () => {
  parseTextEntry.mockResolvedValueOnce([
    full({ payment_method: '' }),
    full({ detail: '스타벅스', amount: null, budget_category: '식비', sub_category: '커피' }),
  ]);
  await say('김치찌개 9천원, 스타벅스');
  expect(container.querySelector('.tp-gaps').textContent).toBe('김치찌개결제수단스타벅스금액');

  const firstSelect = container.querySelector('.tp-item select');
  await setValue(firstSelect, '신한카드');
  expect(container.querySelector('.tp-gaps').textContent).toBe('스타벅스금액');   // 고른 칸은 더 묻지 않는다

  parseTextEntry.mockResolvedValueOnce([
    full({ payment_method: '' }),
    full({ detail: '스타벅스', amount: 4500, budget_category: '식비', sub_category: '커피' }),
  ]);
  await setValue(followText(), '스타벅스는 4500원');
  await click('덧붙여 정리하기');
  expect(lastCall().followUps[0].asked).toBe('빠진 정보를 알려 주세요 — 스타벅스: 금액');
  expect(container.querySelector('.tp-item select').value).toBe('신한카드');
  expect(container.querySelector('.tp-followup')).toBeNull();

  await click('2건 추가 (13,500원)');
  expect(onBulkAdd.mock.calls[0][0].map(t => [t.detail, t.payment_method, t.amount]))
    .toEqual([['김치찌개', '신한카드', 9000], ['스타벅스', '현금', 4500]]);
});

test('덧붙여 쓰던 말이 있으면 추가 버튼을 막고, 다시 쓰기는 그 말까지 모아 준다', async () => {
  parseTextEntry.mockResolvedValueOnce([full({ amount: null })]);
  await say('점심 김치찌개');
  expect(button('이대로 채우기').disabled).toBe(false);
  await setValue(followText(), '9천원');
  expect(button('이대로 채우기').disabled).toBe(true);
  expect(container.querySelector('.tp-pending')).not.toBeNull();
  await click('다시 쓰기');
  expect(firstText().value).toBe('점심 김치찌개\n9천원');
});

test('빠진 정보가 없어도 말로 덧붙이거나 고칠 수 있다', async () => {
  parseTextEntry.mockResolvedValueOnce([full({})]);
  await say('김치찌개 9천원 현금');
  expect(container.querySelector('.tp-followup')).toBeNull();
  await click('+ 말로 덧붙이거나 고치기');
  expect(document.activeElement).toBe(followText());

  parseTextEntry.mockResolvedValueOnce([full({ payment_method: '신한카드' })]);
  await setValue(followText(), '아 신한카드였어');
  await click('덧붙여 정리하기');
  expect(lastCall().followUps).toEqual([{ asked: '', said: '아 신한카드였어' }]);
  expect(container.querySelector('.tp-followup')).toBeNull();
});

test('덧붙여 정리했더니 빠진 건이 있으면 알려 주고, 이전 목록으로 되돌릴 수 있다', async () => {
  const starbucks = o => full({ detail: '스타벅스', budget_category: '식비', sub_category: '커피', ...o });
  parseTextEntry.mockResolvedValueOnce([full({}), starbucks({ amount: null })]);
  await say('김치찌개 9천원 현금, 스타벅스');
  parseTextEntry.mockResolvedValueOnce([starbucks({ amount: 4500 })]);    // AI가 덧붙인 건만 돌려줬다
  await setValue(followText(), '스타벅스는 4500원');
  await click('덧붙여 정리하기');
  expect(container.querySelector('.tp-restore').textContent).toContain('빠진 건이 있어요: 김치찌개');

  await click('이전 목록으로 되돌리기');
  expect(container.textContent).toContain('2건으로 정리했어요');
  expect(container.querySelector('.tp-quote').textContent).toBe('“김치찌개 9천원 현금, 스타벅스”');
  expect(followText().value).toBe('스타벅스는 4500원');        // 고쳐서 다시 보낼 수 있게
  expect(container.querySelector('.tp-restore')).toBeNull();
});

test('덧붙여 정리를 취소한 뒤 늦게 온 답은 화면을 바꾸지 않는다', async () => {
  parseTextEntry.mockResolvedValueOnce([full({ amount: null })]);
  await say('점심 김치찌개');
  let finish;
  parseTextEntry.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await setValue(followText(), '9천원');
  await click('덧붙여 정리하기');
  await click('취소');
  await act(async () => { finish([full({ detail: '엉뚱한 답' })]); });
  expect(container.textContent).not.toContain('엉뚱한 답');
  expect(container.querySelector('.tp-quote').textContent).toBe('“점심 김치찌개”');
  expect(followText().value).toBe('9천원');
});

test('되묻는 화면에서 실패하면 쓰던 말을 두고 이유를 보여 주고, 다시 못 알아들으면 질문을 바꿔 대화를 이어 간다', async () => {
  parseTextEntry.mockRejectedValueOnce(new AIError('무엇을 사셨나요?', 'unclear'));
  await say('좀 썼어');

  parseTextEntry.mockRejectedValueOnce(new AIError('API 키를 확인하세요 (invalid)', 'auth'));
  await setValue(followText(), '점심');
  await click('덧붙여 정리하기');
  expect(container.textContent).toContain('조금 더 알려 주세요');
  expect(container.querySelector('.tp-followup .rs-error-text').textContent).toBe('API 키를 확인하세요 (invalid)');
  expect(followText().value).toBe('점심');
  await click('AI 설정');                                         // 키 문제는 설정으로 갈 수 있다
  expect(onSetup).toHaveBeenCalledTimes(1);

  parseTextEntry.mockRejectedValueOnce(new AIError('네트워크 오류 — 인터넷 연결을 확인하세요', 'network'));
  await click('덧붙여 정리하기');
  expect(container.querySelector('.tp-followup .rs-error-text').textContent).toContain('네트워크 오류');
  expect(button('AI 설정')).toBeUndefined();                      // 설정으로 고칠 오류가 아니다

  parseTextEntry.mockRejectedValueOnce(new AIError('점심에 얼마 쓰셨나요?', 'unclear'));
  await click('덧붙여 정리하기');
  expect(container.querySelector('.tp-ask').textContent).toBe('점심에 얼마 쓰셨나요?');
  expect(container.querySelector('.tp-quote').textContent).toBe('“좀 썼어”+ “점심”');
  expect(followText().value).toBe('');

  parseTextEntry.mockResolvedValueOnce([full({})]);
  await setValue(followText(), '9천원 현금');
  await click('덧붙여 정리하기');
  expect(lastCall().followUps).toEqual([
    { asked: '무엇을 사셨나요?', said: '점심' },
    { asked: '점심에 얼마 쓰셨나요?', said: '9천원 현금' },
  ]);
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');
});
