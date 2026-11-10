/**
 * @vitest-environment jsdom
 */
// AI 명령 (I-051) — AI 입력 상자에 '지워·고쳐·설정' 같은 말을 하면 할 일을 보여 주고 실행한다
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js';
import { createDatabase, addTransaction, getTransactions, isMonthlyReportEnabled } from '../../../services/dbManager';
import { analyzeWithAI } from '../../../services/aiClient';
import { runPlan } from '../../../services/aiCommand';
import AIEntry from '../AIEntry';
import { parseTextEntry } from '../../../services/textEntry';

vi.mock('../../../services/aiClient', async (importOriginal) => ({ ...(await importOriginal()), analyzeWithAI: vi.fn() }));
vi.mock('../../../services/textEntry', async (importOriginal) => ({ ...(await importOriginal()), parseTextEntry: vi.fn(() => new Promise(() => {})) }));

global.IS_REACT_ACT_ENVIRONMENT = true;

let SQL;
let db;
let container;
let root;
let onCommand;
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('ai_receipt_config', JSON.stringify({ provider: 'gemini', keys: { gemini: 'k' }, models: {} }));
  analyzeWithAI.mockReset();
  parseTextEntry.mockClear();
  ({ db } = createDatabase(SQL, null));
  db.run("INSERT INTO payment_methods (name, sort_order) VALUES ('신한카드', 1)");
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('식비', 1)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('식비', '카페', 1)");
  addTransaction(db, { payment_method: '신한카드', date: '2026-11-09', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 4500 });
  // App이 하는 일 — 실행하고 결과를 돌려준다
  onCommand = vi.fn((steps) => runPlan(db, steps));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const T = o => ({ date_from: '', date_to: '', keyword: '', amount: 0, category: '', sub_category: '', payment_method: '', member: '', which: 'all', recurring_id: 0, ...o });
const C = { date: '', amount: 0, detail: '', category: '', payment_method: '', member: '', day_of_month: 0, month_of_year: 0 };
const S = o => ({ key: '', value: '', month: '', name: '', parent: '', ...o });

const render = (props = {}) => act(async () => {
  root.render(<AIEntry db={db} onApply={() => {}} onBulkAdd={() => {}} onQuickAdd={() => null} onCommand={onCommand} resetKey={0} {...props} />);
});
const visible = el => !!el && !el.closest('[hidden]');
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text && visible(b));
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const click = el => act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)); });
const setValue = (el, value) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
async function submit(text) {
  await click(container.querySelector('.ai-entry-main'));
  setValue(container.querySelector('.quick-box textarea'), text);
  await click(button('정리하기'));
  await flush();
}

test('거래 지우기는 맞는 거래를 보여 주고, 실행을 눌러야 지운다', async () => {
  analyzeWithAI.mockResolvedValueOnce({
    actions: [{ type: 'tx_delete', summary: '', target: T({ keyword: '스타벅스' }), changes: C, setting: S() }], entries: [], reply: '',
  });
  await render();
  await submit('어제 스타벅스 지워 줘');
  expect(container.textContent).toContain('이렇게 할게요');
  expect(container.textContent).toContain('거래 1건 지우기');
  expect(container.textContent).toContain('11/09 스타벅스 4,500원');
  expect(getTransactions(db)).toHaveLength(1);
  await click(button('실행'));
  expect(onCommand).toHaveBeenCalledTimes(1);
  expect(getTransactions(db)).toHaveLength(0);
});

test('되돌리기 쉬운 설정은 바로 한다', async () => {
  analyzeWithAI.mockResolvedValueOnce({
    actions: [{ type: 'feature', summary: '', target: T(), changes: C, setting: S({ key: 'monthlyReport', value: 'on' }) }], entries: [], reply: '',
  });
  await render();
  await submit('월간 리포트 켜 줘');
  expect(onCommand).toHaveBeenCalledTimes(1);
  expect(onCommand.mock.calls[0][1]).toEqual({ close: true, planDb: db });
  expect(isMonthlyReportEnabled(db)).toBe(true);
});

test('조회는 결과를 이 화면에 보여 준다', async () => {
  analyzeWithAI.mockResolvedValueOnce({
    actions: [{ type: 'tx_query', summary: '', target: T({ category: '식비' }), changes: C, setting: S() }], entries: [], reply: '',
  });
  await render();
  await submit('식비 얼마 썼어?');
  expect(container.textContent).toContain('찾아봤어요');
  expect(container.textContent).toContain('1건 · 순지출 4,500원');
  expect(onCommand).not.toHaveBeenCalled();
});

test('새 거래만 말했으면 말로 입력으로 넘긴다', async () => {
  analyzeWithAI.mockResolvedValueOnce({ actions: [], entries: [{ detail: '김밥', amount: 3000 }], reply: '' });
  await render();
  await submit('김밥 3000원 추가해 줘 카테고리는 식비');
  expect(parseTextEntry).toHaveBeenCalledTimes(1);
  expect(parseTextEntry.mock.calls[0][0].text).toBe('김밥 3000원 추가해 줘 카테고리는 식비');
});

test('되묻는 말은 고쳐 쓰게 한다', async () => {
  analyzeWithAI.mockResolvedValueOnce({ actions: [], entries: [], reply: '어느 정기지출인지 알려 주세요' });
  await render();
  await submit('정기지출 바꿔 줘');
  expect(container.textContent).toContain('어느 정기지출인지 알려 주세요');
  await click(button('고쳐 쓰기'));
  expect(container.querySelector('.quick-box textarea').value).toBe('정기지출 바꿔 줘');
});

test('명령을 받지 않는 곳(onCommand 없음)에서는 예전처럼 말로 입력으로 읽는다', async () => {
  await render({ onCommand: undefined });
  await submit('어제 스타벅스 지워 줘');
  expect(analyzeWithAI).not.toHaveBeenCalled();
  expect(parseTextEntry).toHaveBeenCalledTimes(1);
});
