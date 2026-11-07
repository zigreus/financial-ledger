/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 계좌·고정 입출금·할인 입력의 잘못된 금액이 조용히 0으로 저장되지 않는다 (B-065)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { AccountForm, RecurringItemForm } from '../AccountManagement';
import RecurringSection from '../../SettingsView/sections/RecurringSection';
import DiscountRulesSection from '../../SettingsView/sections/DiscountRulesSection';
import * as M from '../../../services/dbManager';

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

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
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}
const byPlaceholder = (c, text) => c.querySelector(`input[placeholder="${text}"]`);
const buttonByText = (c, text) => [...c.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const submit = async (c) => { await act(async () => { c.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); };

describe('계좌 추가 폼', () => {
  async function openForm() {
    const onSave = vi.fn();
    const c = await render(<AccountForm onSave={onSave} onCancel={() => {}} />);
    await act(async () => { setValue(byPlaceholder(c, '예: 월급통장'), '월급통장'); });
    return { c, onSave };
  }

  test('기준 잔액에 "100만"처럼 잘못된 값을 넣으면 0원으로 저장하지 않고 막는다', async () => {
    const { c, onSave } = await openForm();
    await act(async () => { setValue(byPlaceholder(c, '0'), '100만'); });
    expect(c.querySelector('.acct-form-error').textContent).toMatch(/기준 잔액/);
    expect(buttonByText(c, '저장').disabled).toBe(true);
    await submit(c); // 버튼이 막혀도 Enter 등으로 제출될 수 있다
    expect(onSave).not.toHaveBeenCalled();
  });

  test('위험 임계값이 잘못됐거나 음수면 막는다', async () => {
    const { c, onSave } = await openForm();
    for (const bad of ['5천', '-5000']) {
      await act(async () => { setValue(byPlaceholder(c, '0 (미설정)'), bad); });
      expect(c.querySelector('.acct-form-error').textContent).toMatch(/위험 임계값/);
      await submit(c);
    }
    expect(onSave).not.toHaveBeenCalled();
  });

  test('입력 중인 수식("1000+")은 오류 대신 마저 입력하라고 안내하고 저장을 막는다', async () => {
    const { c, onSave } = await openForm();
    await act(async () => { setValue(byPlaceholder(c, '0'), '1000+'); });
    expect(c.querySelector('.acct-form-error').textContent).toBe('기준 잔액 수식을 마저 입력하세요');
    expect(buttonByText(c, '저장').disabled).toBe(true);
    await submit(c);
    expect(onSave).not.toHaveBeenCalled();
  });

  test('저장된 계좌(마이너스 잔액·임계값 없음)를 고칠 때 오류 없이 그대로 저장된다', async () => {
    const onSave = vi.fn();
    const account = { name: '마이너스통장', current_balance: -120000, danger_threshold: 0, balance_date: '2026-01-01' };
    const c = await render(<AccountForm account={account} onSave={onSave} onCancel={() => {}} />);
    expect(c.querySelector('.acct-form-error')).toBeNull();
    await submit(c);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ current_balance: -120000, danger_threshold: 0 }));
  });

  test('빈 칸은 0원, 수식·음수 잔액은 계산해서 저장한다', async () => {
    const { c, onSave } = await openForm();
    await submit(c);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ current_balance: 0, danger_threshold: 0 }));

    await act(async () => {
      setValue(byPlaceholder(c, '0'), '1000-5000');
      setValue(byPlaceholder(c, '0 (미설정)'), '300,000');
    });
    expect(c.querySelector('.acct-form-error')).toBeNull();
    await submit(c);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ current_balance: -4000, danger_threshold: 300000 }));
  });
});

describe('고정 입출금 폼', () => {
  async function openForm() {
    const onSave = vi.fn();
    const c = await render(<RecurringItemForm paymentMethods={['카드']} onSave={onSave} onCancel={() => {}} />);
    await act(async () => { setValue(byPlaceholder(c, '예: 월급, 신한카드 결제'), '관리비'); });
    return { c, onSave };
  }

  test('고정 금액이 잘못됐거나 음수면 막고, 빈 칸은 0원이다', async () => {
    const { c, onSave } = await openForm();
    for (const bad of ['20만', '-1000']) {
      await act(async () => { setValue(byPlaceholder(c, '예상 금액 입력'), bad); });
      expect(c.querySelector('.acct-form-error')).not.toBeNull();
      await submit(c);
    }
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => { setValue(byPlaceholder(c, '예상 금액 입력'), ''); });
    await submit(c);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ fixed_amount: 0 }));
  });

  test('저장된 항목의 고정 금액을 고칠 때 오류 없이 그대로 저장된다', async () => {
    const onSave = vi.fn();
    const item = { name: '관리비', type: 'expense', day_of_month: 25, amount_type: 'fixed', fixed_amount: 230000 };
    const c = await render(<RecurringItemForm item={item} paymentMethods={['카드']} onSave={onSave} onCancel={() => {}} />);
    expect(c.querySelector('.acct-form-error')).toBeNull();
    await submit(c);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ fixed_amount: 230000 }));
  });

  test('카드 자동 집계로 바꾸면 고정 금액 칸의 잘못된 값은 상관없다', async () => {
    const { c, onSave } = await openForm();
    await act(async () => { setValue(byPlaceholder(c, '예상 금액 입력'), '20만'); });
    await act(async () => { buttonByText(c, '카드 자동 집계').click(); });
    expect(c.querySelector('.acct-form-error')).toBeNull();
    await submit(c);
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ amount_type: 'auto', fixed_amount: 0 }));
  });
});

describe('설정의 할인 입력', () => {
  function makeDb() {
    const { db } = M.createDatabase(SQL);
    db.run("INSERT INTO payment_methods (name, sort_order) VALUES ('카드', 0)");
    db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('통신', 0)");
    return db;
  }

  test('정기지출 할인이 잘못됐으면 0원으로 저장하지 않고 오류를 보여 준다', async () => {
    const db = makeDb();
    const setError = vi.fn();
    const c = await render(<RecurringSection db={db} dataVersion={0} onChanged={() => {}} setError={setError} />);
    await act(async () => { buttonByText(c, '+ 정기지출 추가').click(); });
    const selects = c.querySelectorAll('select');
    await act(async () => { setValue(selects[0], '카드'); });
    await act(async () => { setValue(c.querySelectorAll('select')[1], '통신'); });
    await act(async () => {
      setValue(byPlaceholder(c, '예: 13500'), '55000');
      setValue(byPlaceholder(c, '자동계산 (0=없음)'), '5천');
    });
    await act(async () => { buttonByText(c, '추가').click(); });
    expect(setError).toHaveBeenLastCalledWith('할인을 올바르게 입력하세요.');
    expect(M.getRecurringTransactions(db)).toHaveLength(0);

    await act(async () => { setValue(byPlaceholder(c, '자동계산 (0=없음)'), '5,000'); });
    await act(async () => { buttonByText(c, '추가').click(); });
    expect(M.getRecurringTransactions(db)).toEqual([expect.objectContaining({ amount: 55000, discount_amount: 5000 })]);
  });

  test('할인 규칙의 최소 금액이 잘못됐으면 조건 없는 규칙(0원)으로 저장하지 않는다', async () => {
    const db = makeDb();
    const setError = vi.fn();
    const c = await render(<DiscountRulesSection db={db} dataVersion={0} onChanged={() => {}} setError={setError} drilldownPayment={{ name: '카드' }} />);
    await act(async () => { setValue(c.querySelector('select'), 'remainder'); });
    await act(async () => {
      setValue(byPlaceholder(c, '예: 1000'), '1000');
      setValue(byPlaceholder(c, '예: 5000'), '5천');
    });
    await act(async () => { buttonByText(c, '+ 규칙 추가').click(); });
    expect(setError).toHaveBeenLastCalledWith('최소 금액을 올바르게 입력하세요.');
    expect(M.getDiscountRules(db, '카드')).toHaveLength(0);

    await act(async () => { setValue(byPlaceholder(c, '예: 5000'), ''); });
    await act(async () => { buttonByText(c, '+ 규칙 추가').click(); });
    expect(M.getDiscountRules(db, '카드')).toEqual([expect.objectContaining({ rule_type: 'remainder', min_amount: 0 })]);
  });
});
