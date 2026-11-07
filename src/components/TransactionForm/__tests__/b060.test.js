/* eslint-disable */
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import TransactionForm from '../TransactionForm';
import * as M from '../../../services/dbManager';

jest.mock('../../AIEntry/AIEntry', () => () => null);

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  const initSqlJs = require('sql.js/dist/sql-asm.js');
  SQL = await initSqlJs();
});

function makeDb() {
  const { db } = M.createDatabase(SQL);
  db.run('DELETE FROM payment_methods');
  ['카드', '현금'].forEach((n, i) => db.run('INSERT INTO payment_methods (name, sort_order) VALUES (?, ?)', [n, i]));
  db.run('DELETE FROM budget_categories'); db.run('DELETE FROM sub_categories');
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('여행', 0)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('여행','현지',0)");
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
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
const byPh = (c, ph) => c.querySelector(`input[placeholder="${ph}"]`);
const submit = (c) => act(() => { c.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
const note = (c) => [...c.querySelectorAll('.fx-note')].map(n => n.textContent).join(' | ');
const tx = (db, id) => rows(db, 'SELECT * FROM transactions WHERE id = ?', [id])[0];

function deletedEventTx(db) {
  const ev = M.addCalendarEvent(db, { title: '도쿄', date_from: '2026-10-01', event_type: 'trip' });
  M.addEventCountry(db, ev, '일본', 'JPY', 9);
  const id = M.addTransaction(db, { payment_method: '카드', date: '2026-10-02', budget_category: '여행', sub_category: '현지', amount: 27000, event_id: ev, foreign_amounts: { JPY: 3000 } });
  M.deleteCalendarEvent(db, ev); // event_id = NULL, foreign_amounts 남음
  return id;
}

test('일정이 지워진 거래: 저장된 통화 칸을 보여 주고, 손대지 않으면 그대로 저장', async () => {
  const db = makeDb();
  const id = deletedEventTx(db);
  expect(tx(db, id).event_id).toBeNull();
  const { container, onSave } = await render({ db, editingTx: tx(db, id) });
  expect(byPh(container, 'JPY 금액').value).toBe('3000');
  expect(note(container)).toContain('연결된 일정이 없어');
  submit(container);
  expect(onSave.mock.calls[0][0]).toMatchObject({ amount: 27000, event_id: null, foreign_amounts: { JPY: 3000 } });
});

test('값을 고쳐도 원화는 다시 계산하지 않고, 비우면 외화 금액을 지움', async () => {
  const db = makeDb();
  const id = deletedEventTx(db);
  const { container, onSave } = await render({ db, editingTx: tx(db, id) });
  setValue(byPh(container, 'JPY 금액'), '2500');
  expect(byPh(container, '금액 (예: 12000+3000)').value).toBe('27000');
  submit(container);
  expect(onSave.mock.calls[0][0]).toMatchObject({ amount: 27000, foreign_amounts: { JPY: 2500 } });

  const r2 = await render({ db, editingTx: tx(db, id) });
  setValue(byPh(r2.container, 'JPY 금액'), '');
  expect(byPh(r2.container, 'JPY 금액')).not.toBeNull(); // 칸은 남아 다시 입력 가능
  submit(r2.container);
  expect(r2.onSave.mock.calls[0][0].foreign_amounts).toEqual({});
  expect(r2.onSave.mock.calls[0][0].amount).toBe(27000);
});

test('일정에 그 통화가 없거나 일정이 숨겨진 경우', async () => {
  const db = makeDb();
  const ev = M.addCalendarEvent(db, { title: '뉴욕', date_from: '2026-10-01', event_type: 'trip' });
  M.addEventCountry(db, ev, '미국', 'USD', 1300);
  const id = M.addTransaction(db, { payment_method: '카드', date: '2026-10-02', budget_category: '여행', sub_category: '현지', amount: 27000, event_id: ev, foreign_amounts: { JPY: 3000 } });
  let r = await render({ db, editingTx: tx(db, id) });
  expect(byPh(r.container, 'USD 금액 (예: 1200+800)')).not.toBeNull();
  expect(byPh(r.container, 'JPY 금액').value).toBe('3000');
  expect(note(r.container)).toContain('연결된 일정에 이 통화가 없어');
  submit(r.container);
  expect(r.onSave.mock.calls[0][0]).toMatchObject({ amount: 27000, foreign_amounts: { JPY: 3000 } });

  db.run('UPDATE calendar_events SET is_hidden = 1 WHERE id = ?', [ev]);
  r = await render({ db, editingTx: tx(db, id) });
  expect(byPh(r.container, 'JPY 금액').value).toBe('3000');
  expect(note(r.container)).toContain('연결된 일정이 숨겨져 있어');
  submit(r.container);
  expect(r.onSave.mock.calls[0][0]).toMatchObject({ amount: 27000, event_id: ev, foreign_amounts: { JPY: 3000 } });
});

test('일정이 지워진 분할 거래도 외화 몫을 그대로 저장', async () => {
  const db = makeDb();
  const ev = M.addCalendarEvent(db, { title: '도쿄', date_from: '2026-10-01', event_type: 'trip' });
  const a = M.addTransaction(db, { payment_method: '카드', date: '2026-10-02', budget_category: '여행', sub_category: '현지', amount: 27000, event_id: ev, foreign_amounts: { JPY: 3000 }, split_group_id: 'sg-x' });
  M.addTransaction(db, { payment_method: '현금', date: '2026-10-02', budget_category: '여행', sub_category: '현지', amount: 18000, event_id: ev, foreign_amounts: { JPY: 2000 }, split_group_id: 'sg-x' });
  M.deleteCalendarEvent(db, ev);
  const { container, onSave } = await render({ db, editingTx: tx(db, a) });
  expect(byPh(container, 'JPY 금액').value).toBe('5000');
  submit(container);
  expect(onSave.mock.calls[0][0].map(p => [p.payment_method, p.amount, p.foreign_amounts]))
    .toEqual([['카드', 27000, { JPY: 3000 }], ['현금', 18000, { JPY: 2000 }]]);
});

test('새 거래: 일정을 풀면 현지 금액도 비워짐 (기존 동작 유지)', async () => {
  const db = makeDb();
  const ev = M.addCalendarEvent(db, { title: '도쿄', date_from: '2026-10-01', event_type: 'trip' });
  M.addEventCountry(db, ev, '일본', 'JPY', 9);
  const { container } = await render({ db, editingTx: null });
  const sel = [...container.querySelectorAll('.form-group')].find(g => g.querySelector('label')?.textContent.startsWith('일정')).querySelector('select');
  const setSel = (v) => { const s = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; act(() => { s.call(sel, v); sel.dispatchEvent(new Event('change', { bubbles: true })); }); };
  setSel(String(ev));
  setValue(byPh(container, 'JPY 금액 (예: 1200+800)'), '1000');
  setSel('');
  expect(byPh(container, 'JPY 금액')).toBeNull();
  expect(container.textContent).not.toContain('저장된 현지 금액');
});
