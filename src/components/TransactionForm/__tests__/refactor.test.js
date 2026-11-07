/* eslint-disable */
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import TransactionForm from '../TransactionForm';
import * as M from '../../../services/dbManager';

jest.mock('../../AIEntry/AIEntry', () => (props) => { global.__aiProps = props; return null; });

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  const initSqlJs = require('sql.js/dist/sql-asm.js');
  SQL = await initSqlJs();
});
beforeEach(() => { try { window.localStorage.clear(); } catch (e) {} });

function makeDb() {
  const { db } = M.createDatabase(SQL);
  db.run('DELETE FROM payment_methods');
  ['카드', '현금', '신한'].forEach((n, i) => db.run('INSERT INTO payment_methods (name, sort_order) VALUES (?, ?)', [n, i]));
  db.run("INSERT INTO payment_method_discount_rules (payment_method_name, rule_type, value) VALUES ('카드', 'percent', 0.01)");
  db.run('DELETE FROM budget_categories'); db.run('DELETE FROM sub_categories');
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('식비', 0), ('여행', 1)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('식비','외식',0), ('식비','카페',1), ('여행','현지',0)");
  return db;
}
const rows = (db, sql, p) => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};
async function render(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = jest.fn();
  await act(async () => { root.render(<TransactionForm onCancel={() => {}} {...props} onSave={onSave} />); });
  return { container, root, onSave };
}
function setValue(el, value) {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  act(() => { setter.call(el, value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
}
const byPh = (c, ph) => c.querySelector(`input[placeholder="${ph}"]`);
const selectByLabel = (c, label) => [...c.querySelectorAll('.form-group')]
  .find(g => g.querySelector('label')?.textContent.startsWith(label))?.querySelector('select');
const submit = (c) => act(() => { c.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
const click = (el) => act(() => { el.click(); });
const amountInput = (c) => byPh(c, '금액 (예: 12000+3000)');
const discountInput = (c) => byPh(c, '0');
const buttonByText = (c, t) => [...c.querySelectorAll('button')].find(b => b.textContent.trim() === t);

test('즐겨찾기: ☆ 추가 → 이름 바꾸기 → 칩 적용 → 해제', async () => {
  const db = makeDb();
  const { container } = await render({ db, editingTx: null });
  const star = () => container.querySelector('.btn-star');
  expect(star().disabled).toBe(true);
  setValue(selectByLabel(container, '결제수단'), '카드');
  setValue(selectByLabel(container, '카테고리'), '식비');
  setValue(selectByLabel(container, '세부카테고리'), '외식');
  container.querySelector('input[placeholder^="예: 김치찌개"]') && setValue(container.querySelector('input[placeholder^="예: 김치찌개"]'), '김치찌개');
  setValue(amountInput(container), '9000');
  expect(star().textContent).toBe('☆');
  click(star());
  const popupInput = container.querySelector('.star-popup input');
  expect(popupInput.value).toBe('김치찌개');
  expect(star().textContent).toBe('★');
  setValue(popupInput, '점심');
  click(buttonByText(container, '완료'));
  expect(container.querySelector('.star-popup')).toBeNull();
  expect([...container.querySelectorAll('.favorite-chip')].map(b => b.textContent)).toEqual(['★ 점심']);
  expect(rows(db, 'SELECT name, amount FROM favorite_transactions')).toEqual([{ name: '점심', amount: 9000 }]);

  // 다른 값으로 바꾼 뒤 칩을 누르면 즐겨찾기 값으로 채움
  setValue(selectByLabel(container, '세부카테고리'), '카페');
  setValue(amountInput(container), '1234');
  expect(star().textContent).toBe('☆');
  click(container.querySelector('.favorite-chip'));
  expect(selectByLabel(container, '세부카테고리').value).toBe('외식');
  expect(amountInput(container).value).toBe('9000');
  expect(star().textContent).toBe('★');
  expect(rows(db, 'SELECT use_count FROM favorite_transactions')[0].use_count).toBe(1);

  // 해제
  click(star());
  expect(container.querySelector('.star-popup input').value).toBe('점심');
  click(buttonByText(container, '해제'));
  expect(container.querySelectorAll('.favorite-chip').length).toBe(0);
  expect(star().textContent).toBe('☆');
});

test('연속 입력: 저장 후 날짜·결제수단·카테고리 유지, 나머지 비움', async () => {
  const db = makeDb();
  const { container, onSave } = await render({ db, editingTx: null, defaultDate: '2026-10-05' });
  click(container.querySelector('.continuous-toggle input'));
  setValue(selectByLabel(container, '결제수단'), '카드');
  setValue(selectByLabel(container, '카테고리'), '식비');
  setValue(selectByLabel(container, '세부카테고리'), '외식');
  setValue(amountInput(container), '10000');
  expect(discountInput(container).value).toBe('100');
  expect(buttonByText(container, '추가하고 계속')).toBeTruthy();
  submit(container);
  expect(onSave.mock.calls[0][1]).toEqual({ keepOpen: true });
  expect(onSave.mock.calls[0][0]).toMatchObject({ date: '2026-10-05', amount: 10000, discount_amount: 100, payment_method: '카드' });
  expect(container.querySelector('.continuous-count').textContent).toBe('1건 추가됨');
  expect(amountInput(container).value).toBe('');
  expect(discountInput(container).value).toBe('');
  expect(selectByLabel(container, '결제수단').value).toBe('카드');
  expect(selectByLabel(container, '카테고리').value).toBe('식비');
  expect(selectByLabel(container, '세부카테고리').value).toBe('');
  expect(container.querySelector('input[type="date"]').value).toBe('2026-10-05');
  expect(buttonByText(container, '닫기')).toBeTruthy();
  setValue(amountInput(container), '5000');
  expect(discountInput(container).value).toBe('50');
});

test('세부카테고리를 고르면 자주 쓴 결제수단을 자동 선택하고 할인 계산', async () => {
  const db = makeDb();
  for (let i = 0; i < 10; i++) M.addTransaction(db, { payment_method: '카드', date: '2026-10-01', budget_category: '식비', sub_category: '카페', amount: 5000 });
  const { container } = await render({ db, editingTx: null });
  setValue(selectByLabel(container, '카테고리'), '식비');
  setValue(amountInput(container), '20000');
  setValue(selectByLabel(container, '세부카테고리'), '카페');
  expect(selectByLabel(container, '결제수단').value).toBe('카드');
  expect(discountInput(container).value).toBe('200');
});

test('AI 입력 적용: 일정·외화·분류를 채우고 분할은 끔', async () => {
  const db = makeDb();
  const ev = M.addCalendarEvent(db, { title: '도쿄', date_from: '2026-10-01', event_type: 'trip' });
  M.addEventCountry(db, ev, '일본', 'JPY', 9);
  M.addEventCashFlow(db, { event_id: ev, date: '2026-10-01', type: 'exchange', currency: 'JPY', amount: 10000, krw_cost: 90000 });
  const { container } = await render({ db, editingTx: null });
  click(container.querySelector('.split-toggle input'));
  expect(container.querySelector('.split-fields')).not.toBeNull();
  act(() => {
    global.__aiProps.onApply({ date: '2026-10-03', detail: '라멘', payment_method: '현금', budget_category: '여행', sub_category: '현지',
      event_id: ev, currency: 'JPY', foreignAmount: 1200, amount: 10800 });
  });
  expect(container.querySelector('.split-fields')).toBeNull();
  expect(byPh(container, 'JPY 금액 (예: 1200+800)').value).toBe('1200');
  expect(amountInput(container).value).toBe('10800');
  expect(selectByLabel(container, '세부카테고리').value).toBe('현지');
  expect(selectByLabel(container, '일정').value).toBe(String(ev));
  // 현금으로 ¥1,200을 쓰면 지갑 ¥10,000 → ¥8,800
  expect(container.querySelector('.wallet-badge.active').textContent).toContain('10,000 JPY → 8,800');
});

test('분할 거래 수정에서 분할을 끄면 총액 한 건으로, 할인은 총액 기준 재계산', async () => {
  const db = makeDb();
  const a = M.addTransaction(db, { payment_method: '카드', date: '2026-10-02', budget_category: '식비', sub_category: '외식', amount: 30000, discount_amount: 300, split_group_id: 'sg-k' });
  M.addTransaction(db, { payment_method: '신한', date: '2026-10-02', budget_category: '식비', sub_category: '외식', amount: 15000, split_group_id: 'sg-k' });
  const editingTx = rows(db, 'SELECT * FROM transactions WHERE id = ?', [a])[0];
  const { container, onSave } = await render({ db, editingTx });
  expect(amountInput(container).value).toBe('45000');
  expect(byPh(container, '예: 30000').value).toBe('30000');
  expect(discountInput(container).value).toBe('300');
  expect(container.textContent).toContain('할인금액 (카드 몫)');
  click(container.querySelector('.split-toggle input'));
  expect(container.querySelector('.split-unlink-warn').textContent).toContain('신한 15,000원');
  expect(discountInput(container).value).toBe('450');
  submit(container);
  expect(onSave.mock.calls[0][0]).toMatchObject({ id: a, amount: 45000, discount_amount: 450, split_group_id: '' });
});
