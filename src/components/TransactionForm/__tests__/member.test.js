/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 거래 폼의 '누가' (I-013)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import TransactionForm from '../TransactionForm';
import * as M from '../../../services/dbManager';
import { setDeviceMember } from '../../../services/deviceMember';

vi.mock('../../AIEntry/AIEntry', () => ({ default: (props) => { global.__aiProps = props; return null; } }));

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => window.localStorage.clear());

function makeDb() {
  const { db } = M.createDatabase(SQL);
  db.run("INSERT INTO payment_methods (name, sort_order) VALUES ('카드', 0)");
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('식비', 0)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('식비', '외식', 0)");
  M.addMember(db, '엄마');
  M.addMember(db, '아빠');
  return db;
}

async function render(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSave = vi.fn();
  const onBulkAdd = vi.fn();
  await act(async () => { root.render(<TransactionForm onCancel={() => {}} onBulkAdd={onBulkAdd} {...props} onSave={onSave} />); });
  return { container, root, onSave, onBulkAdd };
}
function setValue(el, value) {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
const selectByLabel = (c, label) => [...c.querySelectorAll('.form-group')]
  .find(g => g.querySelector('label')?.textContent.startsWith(label))?.querySelector('select');
const chips = (c) => [...c.querySelectorAll('.member-chip')];
const active = (c) => chips(c).filter(b => b.classList.contains('active')).map(b => b.textContent);
const submit = (c) => act(() => { c.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
function fill(c) {
  setValue(selectByLabel(c, '결제수단'), '카드');
  setValue(selectByLabel(c, '카테고리'), '식비');
  setValue(selectByLabel(c, '세부카테고리'), '외식');
  setValue(c.querySelector('input[placeholder="금액 (예: 12000+3000)"]'), '9000');
}

test('새 거래는 이 기기 사용자가 미리 골라져 있고, 칩을 바꾸거나 다시 눌러 비울 수 있다', async () => {
  const db = makeDb();
  setDeviceMember('아빠');
  const { container, onSave } = await render({ db, editingTx: null });
  expect(chips(container).map(b => b.textContent)).toEqual(['엄마', '아빠']);
  expect(active(container)).toEqual(['아빠']);

  act(() => chips(container)[0].click());
  expect(active(container)).toEqual(['엄마']);
  fill(container);
  submit(container);
  expect(onSave.mock.calls[0][0]).toMatchObject({ member: '엄마', amount: 9000 });

  act(() => chips(container)[0].click());
  expect(active(container)).toEqual([]);
});

test('목록에서 사라진 이 기기 사용자는 쓰지 않고, 구성원이 없으면 칩을 그리지 않는다', async () => {
  const db = makeDb();
  setDeviceMember('삭제된 사람');
  const { container } = await render({ db, editingTx: null });
  expect(active(container)).toEqual([]);

  const { db: empty } = M.createDatabase(SQL);
  const r2 = await render({ db: empty, editingTx: null });
  expect(chips(r2.container)).toHaveLength(0);
});

test('수정할 때는 거래에 적힌 누가를 보여 주고 그대로 저장한다', async () => {
  const db = makeDb();
  setDeviceMember('아빠');
  const id = M.addTransaction(db, { payment_method: '카드', date: '2026-11-01', budget_category: '식비', sub_category: '외식', amount: 5000, member: '엄마' });
  const editingTx = M.getTransactions(db).find(t => t.id === id);
  const { container, onSave } = await render({ db, editingTx });
  expect(active(container)).toEqual(['엄마']);
  submit(container);
  expect(onSave.mock.calls[0][0]).toMatchObject({ id, member: '엄마' });
});

test('빠른 입력으로 여러 건을 넣을 때도 폼에서 고른 누가를 붙인다', async () => {
  const db = makeDb();
  setDeviceMember('엄마');
  const { onBulkAdd } = await render({ db, editingTx: null });
  global.__aiProps.onBulkAdd([{ detail: 'a', amount: 1 }, { detail: 'b', amount: 2, member: '' }], { deleteIds: [7] });
  expect(onBulkAdd).toHaveBeenCalledWith(
    [{ detail: 'a', amount: 1, member: '엄마' }, { detail: 'b', amount: 2, member: '' }],
    { deleteIds: [7] },
  );
});
