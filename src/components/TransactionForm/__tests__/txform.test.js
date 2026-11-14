/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import TransactionForm from '../TransactionForm';
import * as M from '../../../services/dbManager';

vi.mock('../../AIEntry/AIEntry', () => ({ default: () => null }));

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function makeDb() {
  const { db } = M.createDatabase(SQL);
  db.run("DELETE FROM payment_methods");
  ['카드', '현금', '신한'].forEach((n, i) => db.run('INSERT INTO payment_methods (name, sort_order) VALUES (?, ?)', [n, i]));
  db.run("INSERT INTO payment_method_discount_rules (payment_method_name, rule_type, value) VALUES ('카드', 'percent', 0.01)");
  db.run("DELETE FROM budget_categories"); db.run("DELETE FROM sub_categories");
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('식비', 0), ('여행', 1)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order, is_hidden) VALUES ('식비','외식',0,0), ('식비','택시',1,1), ('여행','현지',0,0)");
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
  const onSave = vi.fn();
  await act(async () => { root.render(<TransactionForm onCancel={() => {}} {...props} onSave={onSave} />); });
  return { container, root, onSave };
}

function setValue(el, value) {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
const byPh = (c, ph) => c.querySelector(`input[placeholder="${ph}"]`);
const selectByLabel = (c, label) => [...c.querySelectorAll('.form-group')]
  .find(g => g.querySelector('label')?.textContent.startsWith(label))?.querySelector('select');
const submit = (c) => act(() => { c.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
const reasons = (c) => [...c.querySelectorAll('.submit-tooltip span')].map(s => s.textContent.replace(/[•\n]/g, '').trim());
const discountInput = (c) => byPh(c, '0');

test('B-033: 숨긴 일정·바뀐 환율에서도 분할 거래를 그대로 저장', async () => {
  const db = makeDb();
  const ev = M.addCalendarEvent(db, { title: '도쿄', date_from: '2026-10-01', event_type: 'trip' });
  M.addEventCountry(db, ev, '일본', 'JPY', 9.5); // 이후 환율이 바뀐 상태
  const card = M.addTransaction(db, { payment_method: '카드', date: '2026-10-02', budget_category: '여행', sub_category: '현지', amount: 27000, discount_amount: 270, discount_note: '청구할인', event_id: ev, foreign_amounts: { JPY: 3000 }, split_group_id: 'sg-1' });
  M.addTransaction(db, { payment_method: '현금', date: '2026-10-02', budget_category: '여행', sub_category: '현지', amount: 18000, event_id: ev, foreign_amounts: { JPY: 2000 }, split_group_id: 'sg-1' });

  for (const hidden of [false, true]) {
    db.run('UPDATE calendar_events SET is_hidden = ? WHERE id = ?', [hidden ? 1 : 0, ev]);
    const editingTx = rows(db, 'SELECT * FROM transactions WHERE id = ?', [card])[0];
    const { container, onSave, root } = await render({ db, editingTx });
    expect(reasons(container)).toEqual([]);
    submit(container);
    const [payload] = onSave.mock.calls[0];
    expect(payload.map(p => [p.payment_method, p.amount, p.foreign_amounts, p.discount_amount, p.discount_note]))
      .toEqual([['카드', 27000, { JPY: 3000 }, 270, '청구할인'], ['현금', 18000, { JPY: 2000 }, 0, '']]);
    act(() => root.unmount());
  }
});

test('B-030: 분할 첫 몫의 할인은 그 몫 기준', async () => {
  const db = makeDb();
  const { container, onSave } = await render({ db, editingTx: null });
  setValue(selectByLabel(container, '결제수단'), '카드');
  setValue(selectByLabel(container, '카테고리'), '식비');
  setValue(selectByLabel(container, '세부카테고리'), '외식');
  setValue(byPh(container, '금액 (예: 12000+3000)'), '100000');
  expect(discountInput(container).value).toBe('1000');
  act(() => { container.querySelector('.split-toggle input').click(); });
  setValue(byPh(container, '예: 30000'), '30000');
  setValue(selectByLabel(container, '나머지 결제수단'), '신한');
  expect(discountInput(container).value).toBe('300');
  submit(container);
  const [payload] = onSave.mock.calls[0];
  expect(payload.map(p => [p.payment_method, p.amount, p.discount_amount])).toEqual([['카드', 30000, 300], ['신한', 70000, 0]]);
});

test('B-032: 현금으로 바꾸면 자동 할인 비움, 직접 입력한 수익은 유지', async () => {
  const db = makeDb();
  const { container } = await render({ db, editingTx: null });
  setValue(selectByLabel(container, '결제수단'), '카드');
  setValue(byPh(container, '금액 (예: 12000+3000)'), '10000');
  expect(discountInput(container).value).toBe('100');
  setValue(selectByLabel(container, '결제수단'), '현금');
  expect(discountInput(container).value).toBe('');
  setValue(discountInput(container), '500');
  setValue(selectByLabel(container, '결제수단'), '');
  setValue(selectByLabel(container, '결제수단'), '현금');
  expect(discountInput(container).value).toBe('500');
});

test('B-035: 환율 없는 통화 입력이 원화 금액을 지우지 않음', async () => {
  const db = makeDb();
  const ev = M.addCalendarEvent(db, { title: '여행', date_from: '2026-10-01', event_type: 'trip' });
  M.addEventCountry(db, ev, '일본', 'JPY', 9);
  M.addEventCountry(db, ev, '미국', 'USD', 0);
  const { container } = await render({ db, editingTx: null });
  setValue(selectByLabel(container, '일정'), String(ev));
  setValue(byPh(container, '금액 (예: 12000+3000)'), '50000');
  setValue(byPh(container, 'USD 금액 (예: 1200+800)'), '40');
  expect(byPh(container, '금액 (예: 12000+3000)').value).toBe('50000');
  setValue(byPh(container, 'JPY 금액 (예: 1200+800)'), '1000');
  expect(byPh(container, '금액 (예: 12000+3000)').value).toBe('9000');
  // B-034: 두 통화 이상이면 분할 불가
  act(() => { container.querySelector('.split-toggle input').click(); });
  expect(reasons(container)).toContain('현지 금액이 두 통화 이상이면 분할할 수 없습니다');
});

test('B-036/B-043: 잘못된 할인 수식은 막고, 숨긴 세부카테고리는 유지', async () => {
  const db = makeDb();
  const id = M.addTransaction(db, { payment_method: '카드', date: '2026-10-02', budget_category: '식비', sub_category: '택시', amount: 5000 });
  const editingTx = rows(db, 'SELECT * FROM transactions WHERE id = ?', [id])[0];
  const { container, onSave } = await render({ db, editingTx });
  expect(selectByLabel(container, '세부카테고리').value).toBe('택시');
  setValue(discountInput(container), '1000+');
  expect(reasons(container)).toContain('할인금액을 올바르게 입력하세요');
  submit(container);
  expect(onSave).not.toHaveBeenCalled();
  setValue(discountInput(container), '100');
  submit(container);
  expect(onSave.mock.calls[0][0]).toMatchObject({ sub_category: '택시', discount_amount: 100, amount: 5000 });
});

test('분할 통화가 바뀌면 숫자를 다른 통화로 해석하지 않음', async () => {
  const db = makeDb();
  const ev = M.addCalendarEvent(db, { title: '여행', date_from: '2026-10-01', event_type: 'trip' });
  M.addEventCountry(db, ev, '일본', 'JPY', 9);
  const { container } = await render({ db, editingTx: null });
  setValue(selectByLabel(container, '결제수단'), '카드');
  setValue(byPh(container, '금액 (예: 12000+3000)'), '45000');
  act(() => { container.querySelector('.split-toggle input').click(); });
  setValue(byPh(container, '예: 30000'), '27000');
  setValue(selectByLabel(container, '일정'), String(ev));
  setValue(byPh(container, 'JPY 금액 (예: 1200+800)'), '5000');
  expect(reasons(container).some(r => r.startsWith('분할 통화가 JPY'))).toBe(true);
});

test('B-096: AI 입력이 말한 결제수단을 못 맞춰 비워 두면 자동 결제수단(세부카테고리 습관)으로 채우지 않는다', async () => {
  const db = makeDb();
  for (let i = 0; i < 10; i++) {
    M.addTransaction(db, { payment_method: '신한', date: '2026-10-01', budget_category: '식비', sub_category: '외식', amount: 10000 + i });
  }
  expect(M.getAutoPaymentMethod(db, '외식')).toBe('신한');
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('식비','배달',2)");
  for (let i = 0; i < 10; i++) {
    M.addTransaction(db, { payment_method: '현금', date: '2026-10-02', budget_category: '식비', sub_category: '배달', amount: 5000 + i });
  }
  const suggestion = {
    date: '2026-10-05', detail: '김밥천국', amount: 9000, currency: 'KRW', foreignAmount: null, event_id: null,
    payment_method: '', budget_category: '식비', sub_category: '외식',
  };
  const said = await render({ db, aiStart: { apply: { ...suggestion, paymentSaid: '현대카드' } } });
  expect(selectByLabel(said.container, '결제수단').value).toBe('');
  expect(reasons(said.container)).toContain('결제수단을 선택하세요');
  // 세부카테고리를 바꿔도 사용자가 결제수단을 고르기 전에는 채우지 않는다
  setValue(selectByLabel(said.container, '세부카테고리'), '배달');
  expect(selectByLabel(said.container, '결제수단').value).toBe('');
  act(() => said.root.unmount());

  // AI가 세부카테고리를 모르고 넘겼어도 — 나중에 세부카테고리를 골라도 채우지 않는다
  const noSub = await render({ db, aiStart: { apply: { ...suggestion, sub_category: '', paymentSaid: '현대카드' } } });
  setValue(selectByLabel(noSub.container, '세부카테고리'), '외식');
  expect(selectByLabel(noSub.container, '결제수단').value).toBe('');
  // 사용자가 결제수단을 고르면 그대로, 폼의 다른 동작은 그대로다
  setValue(selectByLabel(noSub.container, '결제수단'), '현금');
  expect(selectByLabel(noSub.container, '결제수단').value).toBe('현금');
  act(() => noSub.root.unmount());

  // 말했다는데 무엇인지 몰라(표현 없이) 비운 것도 채우지 않는다
  const unknown = await render({ db, aiStart: { apply: { ...suggestion, paymentSaid: '', paymentMentioned: true } } });
  expect(selectByLabel(unknown.container, '결제수단').value).toBe('');
  act(() => unknown.root.unmount());

  // 결제수단을 말하지 않았으면 예전처럼 자동으로 채운다
  const plain = await render({ db, aiStart: { apply: suggestion } });
  expect(selectByLabel(plain.container, '결제수단').value).toBe('신한');
  act(() => plain.root.unmount());
});
