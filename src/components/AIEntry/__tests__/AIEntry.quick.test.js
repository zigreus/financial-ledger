/**
 * @vitest-environment jsdom
 */
// AI 입력 (I-022) — 한 상자에 넣으면 카드 문자는 규칙으로, 그 밖의 글은 AI로 읽고, 늘 넣던 거래는 확인 없이 바로 넣는다
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js';
import { createDatabase, addTransaction } from '../../../services/dbManager';
import { AIError } from '../../../services/aiClient';
import { loadCardMap } from '../../../services/cardSms';
import { todayStr, addDays, parseDateStr } from '../../../services/dateUtils';
import AIEntry from '../AIEntry';
import { parseTextEntry } from '../../../services/textEntry';
import { loadAIDraft, saveAIDraft } from '../../../services/aiDraft';

vi.mock('../../../services/textEntry', () => ({ parseTextEntry: vi.fn(), UNCLEAR: 'unclear' }));
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

const TODAY = todayStr();
const mmdd = (date) => { const d = parseDateStr(date); return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`; };
const sms = (amount, time, shop) => `[Web발신]\n신한카드(1234)승인 홍*동 ${amount}원(일시불)${mmdd(TODAY)} ${time} ${shop} 누적1,234,567원`;
const STARBUCKS_SMS = sms('12,500', '12:34', '스타벅스코리아');
const NEW_SHOP_SMS = sms('30,000', '13:10', '처음가본가게');

let SQL;
let db;
let container;
let root;
let onQuickAdd;
let onBulkAdd;
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('ai_receipt_config', JSON.stringify({ provider: 'gemini', keys: { gemini: 'k' }, models: {} }));
  parseTextEntry.mockReset();
  onQuickAdd = vi.fn(() => null);
  onBulkAdd = vi.fn();
  ({ db } = createDatabase(SQL, null));
  db.run('DELETE FROM payment_methods');
  ['신한카드', '현금'].forEach((n, i) => db.run('INSERT INTO payment_methods (name, sort_order) VALUES (?, ?)', [n, i]));
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('식비', 0)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('식비', '카페', 0), ('식비', '외식', 1)");
  // 늘 가던 곳: 스타벅스(식비 > 카페, 신한카드) 두 번
  [10, 17].forEach(n => addTransaction(db, {
    payment_method: '신한카드', date: addDays(TODAY, -n), budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 4500,
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () => act(async () => {
  root.render(<AIEntry db={db} onApply={() => {}} onBulkAdd={onBulkAdd} onQuickAdd={onQuickAdd} resetKey={0} />);
});
const visible = el => !!el && !el.closest('[hidden]');
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text && visible(b));
const click = el => act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)); });
const setValue = (el, value) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const quickBox = () => container.querySelector('.quick-box textarea');
async function submit(text) {
  await click(container.querySelector('.ai-entry-main'));
  await setValue(quickBox(), text);
  await click(button('정리하기'));
}

/** App handleQuickAdd가 돌려주는 것과 같은 모양 — undo는 한 번만 지우고(count), 어디서 되돌리든 onUndone으로 알린다 */
function fakeHandle(count) {
  let removed = null;
  const listeners = new Set();
  return {
    undo: vi.fn(() => {
      if (removed === null) { removed = count; listeners.forEach(fn => fn(removed)); }
      return removed;
    }),
    onUndone: (fn) => {
      if (removed !== null) { fn(removed); return () => {}; }
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** AI가 정리한 한 건(말로 입력) — 늘 넣던 스타벅스 */
const spokenStarbucks = () => ({
  date: TODAY, merchant: '스타벅스', detail: '스타벅스', amount: 5000, currency: 'KRW', foreignAmount: null, rate: 0,
  event_id: null, eventTitle: '', payment_method: '신한카드', paymentHint: '', budget_category: '식비', sub_category: '카페',
  items: [], historyDetail: '스타벅스', historyCount: 2, confidence: 'high', warnings: [],
  sources: { date: 'text', detail: 'history', category: 'history', payment_method: 'text' },
});
/** 처음 보는 식당 — AI가 분류를 골랐다 */
const spokenNewPlace = () => ({
  ...spokenStarbucks(), merchant: '처음가본식당', detail: '처음가본식당', amount: 20000, payment_method: '현금',
  sub_category: '외식', historyDetail: '', historyCount: 0,
  sources: { date: 'text', detail: 'text', category: 'ai', payment_method: 'text' },
});

test('막대에는 AI 입력 버튼 하나뿐이다', async () => {
  await render();
  expect(container.querySelectorAll('.ai-entry-bar .ai-entry-btn')).toHaveLength(1);
  expect(container.querySelector('.ai-entry-main').textContent).toContain('AI 입력');
});

test('카드 문자가 모두 늘 가던 곳이면 AI 없이 읽어 바로 넣고 막대로 돌아간다 (AI 키가 없어도)', async () => {
  window.localStorage.removeItem('ai_receipt_config');
  await render();
  await submit(STARBUCKS_SMS);
  expect(parseTextEntry).not.toHaveBeenCalled();
  expect(onQuickAdd).toHaveBeenCalledTimes(1);
  const [rows, opts] = onQuickAdd.mock.calls[0];
  expect(rows).toEqual([expect.objectContaining({
    date: TODAY, detail: '스타벅스', amount: 12500, payment_method: '신한카드', budget_category: '식비', sub_category: '카페',
  })]);
  expect(opts).toEqual({ done: true });
  expect(onBulkAdd).not.toHaveBeenCalled();
  expect(container.querySelector('.ai-entry-bar')).not.toBeNull();
  expect(loadCardMap()).toEqual({});        // 카드 → 결제수단 기억은 사용자가 확인한 것만 (바로 넣은 건은 카드사로 고른 것)
  // 다시 열면 처음부터
  await click(container.querySelector('.ai-entry-main'));
  expect(quickBox().value).toBe('');
});

test('늘 가던 곳과 처음 보는 곳이 섞이면 늘 가던 곳만 바로 넣고 나머지는 카드 문자 화면에서 확인받는다', async () => {
  await render();
  const text = `${STARBUCKS_SMS}\n${NEW_SHOP_SMS}`;
  await submit(text);
  expect(onQuickAdd).toHaveBeenCalledTimes(1);
  expect(onQuickAdd.mock.calls[0][0].map(r => r.detail)).toEqual(['스타벅스']);
  expect(onQuickAdd.mock.calls[0][1]).toEqual({ done: false });
  expect(container.textContent).toContain('확인이 필요한 카드 문자 1건');
  expect(container.textContent).toContain('자주 넣던 1건은 바로 추가했어요');
  expect(container.textContent).toContain('처음가본가게');
  expect(container.textContent).toContain('빈 칸이 있어요');               // 확인이 필요한 이유
  // 다시 붙여넣기 → 쓰던 글이 남은 AI 입력 상자
  await click(button('다시 붙여넣기'));
  expect(quickBox().value).toBe(text);
});

test('처음 보는 카드 문자만 있으면 바로 넣지 않는다', async () => {
  await render();
  await submit(NEW_SHOP_SMS);
  expect(onQuickAdd).not.toHaveBeenCalled();
  expect(container.textContent).toContain('카드 문자 1건');
  expect(container.textContent).not.toContain('바로 추가했어요');
});

test('그 밖의 글은 AI가 정리하고, 늘 넣던 것은 바로 넣고 나머지만 확인받는다', async () => {
  parseTextEntry.mockResolvedValueOnce([spokenStarbucks(), spokenNewPlace()]);
  await render();
  await submit('스타벅스 5천원 신한카드, 처음가본식당 2만원 현금');
  expect(parseTextEntry).toHaveBeenCalledTimes(1);
  expect(parseTextEntry.mock.calls[0][0].text).toBe('스타벅스 5천원 신한카드, 처음가본식당 2만원 현금');
  expect(onQuickAdd).toHaveBeenCalledTimes(1);
  expect(onQuickAdd.mock.calls[0][0]).toEqual([expect.objectContaining({ detail: '스타벅스', amount: 5000 })]);
  expect(onQuickAdd.mock.calls[0][1]).toEqual({ done: false });
  expect(container.textContent).toContain('자주 넣던 1건은 바로 추가했어요');
  expect(container.textContent).toContain('확인이 필요한 이유: 처음 보는 곳이에요');
  expect(container.textContent).toContain('처음가본식당');

  // 다시 쓰고 정리해도 바로 넣은 스타벅스는 또 넣지 않는다 — 체크를 끈 채 이유와 함께 보여 준다
  parseTextEntry.mockResolvedValueOnce([spokenStarbucks(), spokenNewPlace()]);
  await click(button('다시 쓰기'));
  await click(button('정리하기'));
  expect(onQuickAdd).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('확인이 필요한 2건이에요');
  const rows = [...container.querySelectorAll('.tp-item')];
  const starbucks = rows.find(r => r.textContent.includes('스타벅스'));
  expect(starbucks.textContent).toContain('앞에서 바로 넣은 거래예요');
  expect(starbucks.querySelector('input[type="checkbox"]').checked).toBe(false);
  expect(rows.find(r => r.textContent.includes('처음가본식당')).querySelector('input[type="checkbox"]').checked).toBe(true);
});

const row = name => [...container.querySelectorAll('.tp-item')].find(r => r.textContent.includes(name));
const isChecked = name => row(name).querySelector('input[type="checkbox"]').checked;

test('확인 화면의 되돌리기: 바로 넣은 건을 되돌리고 목록에 체크 없이 다시 올린다 (말로 입력)', async () => {
  const handle = fakeHandle(1);
  onQuickAdd.mockReturnValue(handle);
  parseTextEntry.mockResolvedValueOnce([spokenStarbucks(), spokenNewPlace()]);
  await render();
  await submit('스타벅스 5천원 신한카드, 처음가본식당 2만원 현금');
  await click(button('되돌리기'));
  expect(handle.undo).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('바로 넣었던 1건을 되돌렸어요');
  expect(container.textContent).toContain('확인이 필요한 2건이에요');
  expect(row('스타벅스').textContent).toContain('되돌린 거래예요');
  expect(isChecked('스타벅스')).toBe(false);
  expect(button('되돌리기')).toBeUndefined();
});

test('화면 위 알림에서 되돌려도 확인 화면이 알고, 다시 정리해도 되돌린 건을 또 바로 넣지 않는다 (말로 입력)', async () => {
  const handle = fakeHandle(1);
  onQuickAdd.mockReturnValue(handle);
  parseTextEntry.mockResolvedValueOnce([spokenStarbucks(), spokenNewPlace()]);
  await render();
  await submit('스타벅스 5천원 신한카드, 처음가본식당 2만원 현금');
  await act(async () => { handle.undo(); });                  // 알림의 되돌리기
  expect(container.textContent).toContain('바로 넣었던 1건을 되돌렸어요');
  expect(row('스타벅스').textContent).toContain('되돌린 거래예요');

  parseTextEntry.mockResolvedValueOnce([spokenStarbucks(), spokenNewPlace()]);
  await click(button('다시 쓰기'));
  await click(button('정리하기'));
  expect(onQuickAdd).toHaveBeenCalledTimes(1);                  // 사용자가 되돌린 것을 되살리지 않는다
  expect(row('스타벅스').textContent).toContain('되돌린 거래예요');
  expect(isChecked('스타벅스')).toBe(false);
});

test('되돌린 줄을 직접 체크해 두면 덧붙여 정리해도 그 체크가 남는다 (넣으려던 거래가 빠지지 않게)', async () => {
  const handle = fakeHandle(1);
  onQuickAdd.mockReturnValue(handle);
  parseTextEntry.mockResolvedValueOnce([spokenStarbucks(), spokenNewPlace()]);
  await render();
  await submit('스타벅스 5천원 신한카드, 처음가본식당 2만원 현금');
  await click(button('되돌리기'));
  await click(row('스타벅스').querySelector('input[type="checkbox"]'));
  expect(isChecked('스타벅스')).toBe(true);

  parseTextEntry.mockResolvedValueOnce([spokenStarbucks(), { ...spokenNewPlace(), amount: 25000 }]);
  await click(container.querySelector('.tp-followup-open'));
  await setValue(container.querySelector('.tp-followup textarea'), '식당은 2만 5천원이었어');
  await click(button('덧붙여 정리하기'));
  expect(parseTextEntry).toHaveBeenCalledTimes(2);
  expect(row('처음가본식당').textContent).toContain('25,000');
  expect(isChecked('스타벅스')).toBe(true);
  expect(isChecked('처음가본식당')).toBe(true);
  expect(onQuickAdd).toHaveBeenCalledTimes(1);                    // 덧붙여 정리할 때는 바로 넣지 않는다
});

test('덧붙여 정리하며 바로 넣은 건이 금액만 같은 다른 줄과 짝지어져도 그 체크를 이어받지 않고, 빠진 줄을 알린다', async () => {
  const bakery = { ...spokenNewPlace(), merchant: '동네빵집', detail: '동네빵집', amount: 5000 };
  parseTextEntry.mockResolvedValueOnce([spokenStarbucks(), bakery, spokenNewPlace()]);
  await render();
  await submit('스타벅스 5천원 신한카드, 동네빵집 5천원 현금, 처음가본식당 2만원 현금');
  expect(onQuickAdd).toHaveBeenCalledTimes(1);
  expect(isChecked('동네빵집')).toBe(true);

  parseTextEntry.mockResolvedValueOnce([spokenStarbucks(), spokenNewPlace()]);   // "빵집은 빼 줘"
  await click(container.querySelector('.tp-followup-open'));
  await setValue(container.querySelector('.tp-followup textarea'), '빵집은 빼 줘');
  await click(button('덧붙여 정리하기'));
  expect(row('스타벅스').textContent).toContain('앞에서 바로 넣은 거래예요');
  expect(isChecked('스타벅스')).toBe(false);                    // 이미 넣은 스타벅스를 또 넣지 않게
  expect(isChecked('처음가본식당')).toBe(true);
  expect(container.querySelector('.tp-restore').textContent).toContain('동네빵집');
});

test('바로 넣은 뒤 금액을 고쳐 말하고 되돌리면, 고친 건만 남기고 원래 건은 다시 올리지 않는다', async () => {
  const handle = fakeHandle(1);
  onQuickAdd.mockReturnValue(handle);
  parseTextEntry.mockResolvedValueOnce([spokenStarbucks(), spokenNewPlace()]);
  await render();
  await submit('스타벅스 5천원 신한카드, 처음가본식당 2만원 현금');
  // 다시 써서 스타벅스 금액을 고쳤다 — 바로 넣은 것과 비슷한 건으로 체크 없이
  parseTextEntry.mockResolvedValueOnce([{ ...spokenStarbucks(), amount: 4500 }, spokenNewPlace()]);
  await click(button('다시 쓰기'));
  await click(button('정리하기'));
  expect(row('스타벅스').textContent).toContain('앞에서 바로 넣은 거래와 비슷해요');
  await click(button('되돌리기'));
  const starbucksRows = [...container.querySelectorAll('.tp-item')].filter(r => r.textContent.includes('스타벅스'));
  expect(starbucksRows).toHaveLength(1);
  expect(starbucksRows[0].textContent).toContain('4,500');
  expect(starbucksRows[0].textContent).toContain('고쳐 말한 것 같아요');
});

test('확인 화면의 되돌리기 (카드 문자): 되돌린 건을 체크 없이 다시 올리고, 다시 붙여넣어도 또 바로 넣지 않는다', async () => {
  const handle = fakeHandle(1);
  onQuickAdd.mockReturnValue(handle);
  await render();
  const text = `${STARBUCKS_SMS}\n${NEW_SHOP_SMS}`;
  await submit(text);
  await click(button('되돌리기'));
  expect(handle.undo).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('카드 문자 2건');
  expect(row('스타벅스').textContent).toContain('되돌린 거래예요');
  expect(isChecked('스타벅스')).toBe(false);

  // 다시 붙여넣기 → 같은 글을 다시 정리: 되돌린 스타벅스는 바로 넣지 않고, 되돌린 안내도 남는다
  await click(button('다시 붙여넣기'));
  expect(quickBox().value).toBe(text);
  await click(button('정리하기'));
  expect(onQuickAdd).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('바로 넣었던 1건을 되돌렸어요');
  expect(row('스타벅스').textContent).toContain('되돌린 거래예요');
  expect(isChecked('스타벅스')).toBe(false);
  expect([...container.querySelectorAll('.tp-item')].filter(r => r.textContent.includes('스타벅스'))).toHaveLength(1);
});

test('카드 문자: 화면 위 알림에서 되돌려도 확인 화면이 알고, 다시 붙여넣기로 오가도 앞 묶음을 되돌릴 수 있다', async () => {
  const handle = fakeHandle(1);
  onQuickAdd.mockImplementation((rows) => { rows.forEach(r => addTransaction(db, r)); return handle; }); // App처럼 실제로 넣는다
  await render();
  await submit(`${STARBUCKS_SMS}\n${NEW_SHOP_SMS}`);
  await click(button('다시 붙여넣기'));
  await click(button('정리하기'));                                  // 앞 묶음은 가계부에 있어 중복으로 확인받는다
  expect(onQuickAdd).toHaveBeenCalledTimes(1);
  expect(row('스타벅스').textContent).toContain('가계부에 이미 있는 것 같아요');
  expect(container.textContent).toContain('자주 넣던 1건은 바로 추가했어요');
  await act(async () => { handle.undo(); });
  expect(container.textContent).toContain('바로 넣었던 1건을 되돌렸어요');
  // '이미 있는 것 같아요'로 보이던 줄이 '되돌린 거래'로 바뀐다 (두 줄이 되지 않게)
  const starbucks = [...container.querySelectorAll('.tp-item')].filter(r => r.textContent.includes('스타벅스'));
  expect(starbucks).toHaveLength(1);
  expect(starbucks[0].textContent).toContain('되돌린 거래예요');
  expect(starbucks[0].textContent).not.toContain('이미 있는 것 같아요');
  expect(isChecked('스타벅스')).toBe(false);
});

describe('정리하던 글 이어서 하기 (I-023)', () => {
  const remount = () => act(async () => {
    root.unmount();
    root = createRoot(container);
    root.render(<AIEntry db={db} onApply={() => {}} onBulkAdd={onBulkAdd} onQuickAdd={onQuickAdd} resetKey={0} />);
  });

  test('정리하는 사이 앱이 닫혀도 다시 열면 이어서 정리한다 — 이번에는 바로 넣지 않고, 그새 넣은 거래는 체크 없이', async () => {
    const said = '스타벅스 5천원 신한카드, 처음가본식당 2만원 현금';
    parseTextEntry.mockReturnValueOnce(new Promise(() => {}));         // 분석하는 중에
    await render();
    await submit(said);
    expect(loadAIDraft()).toBe(said);
    await remount();                                                     // 휴대폰이 앱을 닫았다가 다시 열었다
    expect(container.querySelector('.ai-entry-draft').textContent).toContain('정리하다 만 글이 있어요');

    // 앱이 닫히기 전에 스타벅스는 이미 들어갔다(바로 넣기)
    addTransaction(db, { payment_method: '신한카드', date: TODAY, budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 5000 });
    await click(button('이어서 정리'));
    expect(quickBox().value).toBe(said);
    expect(container.querySelector('.quick-box').textContent).toContain('이번에는 바로 넣지 않고 모두 확인을 받아요');
    parseTextEntry.mockResolvedValueOnce([spokenStarbucks(), spokenNewPlace()]);
    await click(button('정리하기'));
    expect(onQuickAdd).not.toHaveBeenCalled();
    expect(row('스타벅스').textContent).toContain('같은 날 같은 금액 거래가 이미 있어요');
    expect(isChecked('스타벅스')).toBe(false);
    expect(isChecked('처음가본식당')).toBe(true);

    // 추가하면 남은 글을 지운다
    await click([...container.querySelectorAll('button')].find(b => b.textContent.includes('1건 추가')));
    expect(onBulkAdd).toHaveBeenCalledTimes(1);
    expect(loadAIDraft()).toBe('');
  });

  test('버리기를 누르거나 닫으면 남은 글을 지운다', async () => {
    saveAIDraft('점심 김치찌개 9천원');
    await render();
    await click(button('버리기'));
    expect(container.querySelector('.ai-entry-draft')).toBeNull();
    expect(loadAIDraft()).toBe('');

    parseTextEntry.mockResolvedValueOnce([spokenNewPlace()]);
    await submit('처음가본식당 2만원 현금');
    expect(loadAIDraft()).toBe('처음가본식당 2만원 현금');
    await click(button('취소'));
    expect(loadAIDraft()).toBe('');
    expect(container.querySelector('.ai-entry-draft')).toBeNull();
  });

  test('이어서 정리하면 아직 넣지 않은 늘 넣던 거래도 바로 넣지 않고, 체크된 채 확인받는다', async () => {
    saveAIDraft('스타벅스 5천원 신한카드');
    await render();
    await click(button('이어서 정리'));
    parseTextEntry.mockResolvedValueOnce([spokenStarbucks()]);
    await click(button('정리하기'));
    expect(onQuickAdd).not.toHaveBeenCalled();
    expect(container.textContent).toContain('이렇게 입력하시겠습니까?');   // 한 건 확인 화면
    expect(container.textContent).not.toContain('같은 날 같은 금액');
  });

  test('남은 글이 카드 문자여도 이어서 정리하면 바로 넣지 않는다 (안내와 같게)', async () => {
    saveAIDraft(STARBUCKS_SMS);
    await render();
    await click(button('이어서 정리'));
    await click(button('정리하기'));
    expect(onQuickAdd).not.toHaveBeenCalled();
    expect(container.textContent).toContain('카드 문자 1건');
    expect(isChecked('스타벅스')).toBe(true);
    // 카드 문자 화면에서 추가하면 남은 글도 끝났다 (창은 App이 닫아 막대로 돌아오지 않아도)
    await click([...container.querySelectorAll('button')].find(b => b.textContent.includes('1건 추가')));
    expect(onBulkAdd).toHaveBeenCalledTimes(1);
    expect(loadAIDraft()).toBe('');
  });

  test('관련 없는 닫기로는 남은 글을 지우지 않는다 — AI 입력을 열었다 닫거나, 꺼내기만 하고 닫아도', async () => {
    saveAIDraft('점심 김치찌개 9천원');
    await render();
    await click(container.querySelector('.ai-entry-main'));
    await click(button('닫기'));
    expect(loadAIDraft()).toBe('점심 김치찌개 9천원');
    expect(container.querySelector('.ai-entry-draft')).not.toBeNull();

    await click(button('이어서 정리'));
    await click(button('닫기'));
    expect(loadAIDraft()).toBe('점심 김치찌개 9천원');
    expect(container.querySelector('.ai-entry-draft')).not.toBeNull();
  });

  test('새 글을 정리하면 막대의 옛 남은 글을 대신하고, 다음 거래로 넘어가면(resetKey) 그 글을 지운다', async () => {
    saveAIDraft('옛 글');
    await render();
    expect(container.querySelector('.ai-entry-draft').textContent).toContain('옛 글');
    parseTextEntry.mockReturnValueOnce(new Promise(() => {}));
    await submit('새 글 점심 9천원');
    expect(loadAIDraft()).toBe('새 글 점심 9천원');
    await act(async () => {                                                // 폼에서 직접 '추가하고 계속'
      root.render(<AIEntry db={db} onApply={() => {}} onBulkAdd={onBulkAdd} onQuickAdd={onQuickAdd} resetKey={1} />);
    });
    expect(loadAIDraft()).toBe('');
    expect(container.querySelector('.ai-entry-draft')).toBeNull();
  });

  test('남은 글을 고쳐 쓰면 새 글로 보아 늘 넣던 것은 바로 넣는다', async () => {
    saveAIDraft('스타벅스 5천원');
    await render();
    await click(button('이어서 정리'));
    await setValue(quickBox(), '스타벅스 5천원 신한카드');
    expect(container.querySelector('.quick-box').textContent).not.toContain('바로 넣지 않고');
    parseTextEntry.mockResolvedValueOnce([spokenStarbucks()]);
    await click(button('정리하기'));
    expect(onQuickAdd).toHaveBeenCalledTimes(1);
  });
});

test('승인 거절·청구 안내 문자만 있으면 AI로 넘기지 않고 넣을 것이 없다고 알린다', async () => {
  await render();
  await submit('[Web발신]\n신한카드(1234)승인거절 홍*동 12,500원 11/08 12:34 스타벅스 잔액부족');
  expect(parseTextEntry).not.toHaveBeenCalled();
  expect(onQuickAdd).not.toHaveBeenCalled();
  expect(container.querySelector('.quick-box .rs-error-text').textContent).toContain('넣을 결제가 없습니다 — 건너뛴 글 1개 (승인 거절 1)');
});

test('금액을 못 읽은 문자가 함께 있으면 늘 가던 곳을 바로 넣어도 창을 닫지 않고 알린다', async () => {
  await render();
  await submit(`${STARBUCKS_SMS}\n[Web발신]\n신한카드(1234)승인 홍*동 ${mmdd(TODAY)} 13:10 김밥천국`);
  expect(onQuickAdd).toHaveBeenCalledWith([expect.objectContaining({ detail: '스타벅스' })], { done: false });
  expect(container.textContent).toContain('읽지 못한 카드 문자가 있어요');
  expect(container.textContent).toContain('금액 없음 1');
});

test('카드 문자처럼 보였는데 AI에 맡긴 글, 취소·예약 같은 말이 있는 글은 늘 넣던 것이라도 확인받는다', async () => {
  parseTextEntry.mockResolvedValue([spokenStarbucks()]);
  await render();
  await submit('신한카드 1.5만원 결제 12:30 스타벅스');
  expect(parseTextEntry).toHaveBeenCalledTimes(1);
  expect(onQuickAdd).not.toHaveBeenCalled();
  expect(container.textContent).toContain('이렇게 입력하시겠습니까?');

  await click(button('취소'));
  await submit('스타벅스 5천원 신한카드 결제 취소됐어');
  expect(parseTextEntry).toHaveBeenCalledTimes(2);
  expect(onQuickAdd).not.toHaveBeenCalled();
});

test('AI가 정리한 것이 모두 늘 넣던 것이면 바로 넣고 입력 창을 닫는다', async () => {
  parseTextEntry.mockResolvedValueOnce([spokenStarbucks()]);
  await render();
  await submit('스타벅스 5천원 신한카드');
  expect(onQuickAdd).toHaveBeenCalledWith([expect.objectContaining({ detail: '스타벅스' })], { done: true });
  expect(container.querySelector('.ai-entry-bar')).not.toBeNull();
});

test('카드 문자처럼 보여도 금액을 읽지 못하면 AI에 맡긴다', async () => {
  parseTextEntry.mockRejectedValueOnce(new AIError('무엇을 사셨나요?', 'unclear'));
  await render();
  await submit('신한카드 1.5만원 결제 12:30');
  expect(parseTextEntry).toHaveBeenCalledTimes(1);
});

test('AI 키가 없으면 설정부터 — 취소하면 쓰던 글로, 저장하면 쓴 글을 바로 정리한다', async () => {
  window.localStorage.removeItem('ai_receipt_config');
  await render();
  await submit('점심 김치찌개 9천원');
  expect(container.querySelector('.fake-settings')).not.toBeNull();
  await click(button('설정 취소'));
  expect(quickBox().value).toBe('점심 김치찌개 9천원');
  expect(parseTextEntry).not.toHaveBeenCalled();

  parseTextEntry.mockRejectedValueOnce(new AIError('얼마였나요?', 'unclear'));
  await click(button('정리하기'));
  await click(button('설정 저장'));
  expect(parseTextEntry).toHaveBeenCalledTimes(1);
  expect(parseTextEntry.mock.calls[0][0].text).toBe('점심 김치찌개 9천원');
  expect(container.textContent).toContain('얼마였나요?');
});
