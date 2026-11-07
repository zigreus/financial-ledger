/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 잘못 입력한 현지 금액·환율·월 목표가 조용히 버려지지 않는다 (B-067, B-068, B-069)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import TransactionForm from '../TransactionForm/TransactionForm';
import { EventForm } from '../CalendarView/CalendarView';
import TransactionList from '../TransactionList/TransactionList';
import * as M from '../../services/dbManager';
import { currentYearMonth } from '../../services/dateUtils';

vi.mock('../AIEntry/AIEntry', () => ({ default: () => null }));

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  SQL = await initSqlJs();
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const roots = [];
afterEach(() => {
  roots.splice(0).forEach(({ root, container }) => { act(() => root.unmount()); container.remove(); });
});

async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => { root.render(element); });
  return container;
}
function setValue(el, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const byPh = (c, ph) => c.querySelector(`input[placeholder="${ph}"]`);
const buttonByText = (c, text) => [...c.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const rows = (db, sql, p) => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};

function makeDb() {
  const { db } = M.createDatabase(SQL);
  db.run('DELETE FROM payment_methods');
  db.run("INSERT INTO payment_methods (name, sort_order) VALUES ('카드', 0)");
  db.run('DELETE FROM budget_categories'); db.run('DELETE FROM sub_categories');
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('여행', 0)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('여행','현지',0)");
  return db;
}
function tripTx(db) {
  const ev = M.addCalendarEvent(db, { title: '도쿄', date_from: '2026-10-01', event_type: 'trip' });
  M.addEventCountry(db, ev, '일본', 'JPY', 9.5);
  const id = M.addTransaction(db, { payment_method: '카드', date: '2026-10-02', budget_category: '여행', sub_category: '현지', amount: 9500, event_id: ev, foreign_amounts: { JPY: 1000 } });
  return { ev, tx: rows(db, 'SELECT * FROM transactions WHERE id = ?', [id])[0] };
}

describe('현지 금액 (B-067)', () => {
  test('현지 금액을 "1만"으로 바꾸면 원화만 남기고 외화를 버리지 않고 저장을 막는다', async () => {
    const db = makeDb();
    const { tx } = tripTx(db);
    const onSave = vi.fn();
    const c = await render(<TransactionForm db={db} editingTx={tx} onCancel={() => {}} onSave={onSave} />);
    const jpy = byPh(c, 'JPY 금액 (예: 1200+800)');
    expect(jpy.value).toBe('1000');
    await act(async () => { setValue(jpy, '1만'); });
    expect(c.textContent).toContain('현지 금액을 올바르게 입력하세요');
    await act(async () => { c.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => { setValue(jpy, '2000'); });
    expect(c.textContent).not.toContain('현지 금액을 올바르게 입력하세요');
    await act(async () => { c.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(onSave.mock.calls[0][0]).toMatchObject({ amount: 19000, foreign_amounts: { JPY: 2000 } });
  });

  test('현지 금액을 비우면 오류 없이 외화 기록을 지우고 저장한다', async () => {
    const db = makeDb();
    const { tx } = tripTx(db);
    const onSave = vi.fn();
    const c = await render(<TransactionForm db={db} editingTx={tx} onCancel={() => {}} onSave={onSave} />);
    await act(async () => { setValue(byPh(c, 'JPY 금액 (예: 1200+800)'), ''); });
    expect(c.textContent).not.toContain('현지 금액을 올바르게 입력하세요');
    // 환율이 있는 통화를 비우면 원화도 비워지므로(기존 동작) 원화를 직접 넣는다
    await act(async () => { setValue(byPh(c, '금액 (예: 12000+3000)'), '9500'); });
    await act(async () => { c.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(onSave).toHaveBeenCalled();
    expect(onSave.mock.calls[0][0].foreign_amounts).toEqual({});
  });
});

describe('여행 환율 (B-068)', () => {
  async function openTrip(db) {
    const { ev } = tripTx(db);
    const types = M.getCalendarEventTypes(db);
    const editingEvent = M.getCalendarEvents(db, { includeHidden: true }).find(e => e.id === ev);
    const onSave = vi.fn();
    const c = await render(
      <EventForm db={db} editingEvent={editingEvent} eventTypes={types} eventTypeMap={Object.fromEntries(types.map(t => [t.value, t]))}
        onSave={onSave} onDelete={() => {}} onCancel={() => {}} />
    );
    return { c, ev, onSave };
  }
  const rateOf = (db, ev) => rows(db, 'SELECT exchange_rate FROM event_countries WHERE event_id = ?', [ev])[0].exchange_rate;

  test('환율에 "약950"처럼 잘못된 값을 넣으면 \'환율 없음\'으로 저장하지 않고 오류를 보여 준다', async () => {
    const db = makeDb();
    const { c, ev, onSave } = await openTrip(db);
    const rate = byPh(c, '환율 (예: 950/100)');
    expect(rate.value).toBe('9.5');
    for (const bad of ['약950', '-9.5']) {
      await act(async () => { setValue(rate, bad); });
      await act(async () => { c.querySelector('.cv-form-save-btn').click(); });
      expect(c.textContent).toContain('일본 환율을 올바르게 입력하세요');
    }
    expect(onSave).not.toHaveBeenCalled();
    expect(rateOf(db, ev)).toBe(9.5);
  });

  test('여행이 아닌 유형으로 바꾸면 보이지 않는 환율 칸 때문에 저장이 막히지 않는다', async () => {
    const db = makeDb();
    const { c, onSave } = await openTrip(db);
    await act(async () => { setValue(byPh(c, '환율 (예: 950/100)'), '약950'); });
    await act(async () => { buttonByText(c, '일상').click(); });
    expect(byPh(c, '환율 (예: 950/100)')).toBeNull();
    await act(async () => { c.querySelector('.cv-form-save-btn').click(); });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  test('국가 이름을 지우고 저장하면 그 국가·환율을 지운다 (B-070)', async () => {
    const db = makeDb();
    const { c, ev, onSave } = await openTrip(db);
    await act(async () => { setValue(byPh(c, '국가 (예: 일본)'), ''); });
    await act(async () => { c.querySelector('.cv-form-save-btn').click(); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(rows(db, 'SELECT * FROM event_countries WHERE event_id = ?', [ev])).toEqual([]);
  });

  test('환율을 비우거나 0으로 두면 환율 없음으로 저장하고, 수식은 계산한다', async () => {
    const db = makeDb();
    const { c, ev, onSave } = await openTrip(db);
    const rate = byPh(c, '환율 (예: 950/100)');
    await act(async () => { setValue(rate, '950/100'); });
    await act(async () => { c.querySelector('.cv-form-save-btn').click(); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(rateOf(db, ev)).toBe(9.5);

    await act(async () => { setValue(rate, ''); });
    await act(async () => { c.querySelector('.cv-form-save-btn').click(); });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(rateOf(db, ev)).toBe(0);

    await act(async () => { setValue(rate, '0'); });
    await act(async () => { c.querySelector('.cv-form-save-btn').click(); });
    expect(onSave).toHaveBeenCalledTimes(3);
    expect(rateOf(db, ev)).toBe(0);
  });
});

describe('월 목표 (B-069)', () => {
  test('목표 금액에 "50만"·음수·입력 중인 수식을 넣고 ✓를 누르면 편집이 닫히지 않고 이유를 보여 준다', async () => {
    const db = makeDb();
    const month = currentYearMonth();
    M.addTransaction(db, { payment_method: '카드', date: `${month}-01`, budget_category: '여행', sub_category: '현지', amount: 1000 });
    const onChanged = vi.fn();
    const c = await render(<TransactionList db={db} dataVersion={0} onAdd={() => {}} onEdit={() => {}} onDelete={() => {}} onChanged={onChanged} />);
    await act(async () => { c.querySelector('.month-goal-set-btn').click(); });
    const input = byPh(c, '목표금액');
    for (const [bad, msg] of [['50만', '0 이상의 금액을 입력하세요'], ['-5000', '0 이상의 금액을 입력하세요'], ['5000+', '수식을 마저 입력하세요']]) {
      await act(async () => { setValue(byPh(c, '목표금액'), bad); });
      expect(c.querySelector('.month-goal-error')).toBeNull(); // 고치는 중에는 지운다
      await act(async () => { c.querySelector('.month-goal-btn-ok').click(); });
      expect(byPh(c, '목표금액')).not.toBeNull(); // 편집이 열린 채로 남는다
      expect(c.querySelector('.month-goal-error').textContent).toBe(msg);
    }
    expect(M.getAllMonthlyGoals(db)[month]).toBeUndefined();
    expect(onChanged).not.toHaveBeenCalled();

    await act(async () => { setValue(byPh(c, '목표금액'), '500,000'); });
    await act(async () => { c.querySelector('.month-goal-btn-ok').click(); });
    expect(byPh(c, '목표금액')).toBeNull();
    expect(M.getAllMonthlyGoals(db)[month]).toBe(500000);
  });
});
