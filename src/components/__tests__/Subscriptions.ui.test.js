/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 구독 모아보기 화면 (I-027, ROADMAP C-8) — 지출계획 › 정기지출: 켜고 끄기, 합계, 바뀐 금액, 해지 메모, 구독 고르기, 폼
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../services/dbManager';
import { todayStr, addDays, addMonths, currentYearMonth } from '../../services/dateUtils';
import RecurringSection from '../SettingsView/sections/RecurringSection';

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

let db;
let container;
let root;
let version = 0;
const base = { payment_method: '신한카드', budget_category: '문화', frequency: 'monthly', day_of_month: 5 };
beforeEach(() => {
  ({ db } = M.createDatabase(SQL, null));
  M.addPaymentMethod(db, '신한카드');
  M.addRecurringTransaction(db, { ...base, detail: '넷플릭스', amount: 13500 });
  M.addRecurringTransaction(db, { ...base, budget_category: '주거', detail: '관리비', amount: 250000 });
  M.addRecurringTransaction(db, { ...base, detail: '도메인', amount: 24000, frequency: 'annual', month_of_year: 3 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

const idOf = detail => M.getRecurringTransactions(db).find(r => r.detail === detail).id;
const show = () => act(async () => {
  root.render(<RecurringSection db={db} dataVersion={version += 1} onChanged={() => {}} setError={() => {}} />);
});
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text || b.title === text);
const click = async el => { await act(async () => { el.click(); }); await show(); };
const typeInto = (input, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

test('처음에는 꺼져 있고(합계·구독 표시 없음), 켜면 구독을 고를 수 있다 — 구독 같아 보이는 것이 위로', async () => {
  await show();
  expect(container.querySelector('.sub-totals')).toBeNull();
  expect(button('구독 고르기')).toBeUndefined();
  await click(button('구독 모아보기 켜기'));
  expect(M.isSubscriptionsEnabled(db)).toBe(true);
  expect(container.querySelector('.sub-panel').textContent).toContain('구독으로 표시한 정기지출이 없어요');
  await click(button('구독 고르기'));
  const rows = [...container.querySelectorAll('.sub-pick-list .cb-settings-row')].map(r => r.textContent);
  expect(rows[0]).toContain('넷플릭스');
  expect(rows[0]).toContain('구독 같아요');
  expect(rows.slice(1).some(t => t.includes('구독 같아요'))).toBe(false);
  await click(button('넷플릭스 구독으로 표시'));
  await click(button('도메인 구독으로 표시'));
  expect(M.getSubscriptions(db).map(s => s.detail)).toEqual(['넷플릭스', '도메인']);
  const totals = [...container.querySelectorAll('.sub-totals strong')].map(s => s.textContent);
  expect(totals).toEqual(['15,500원', '186,000원', '2개']);
  expect(container.querySelectorAll('.sub-badge')).toHaveLength(2);           // 정기지출 목록에 '구독' 표시
  expect(container.querySelector('.sub-list').textContent).toContain('월 2,000원꼴');
});

const paidYesterday = (id, amount) => db.run(
  `INSERT INTO transactions (payment_method, date, budget_category, detail, amount, recurring_source_id)
   VALUES ('신한카드', ?, '문화', '넷플릭스', ?, ?)`, [addDays(todayStr(), -1), amount, id],
);

test('최근 결제가 등록 금액과 다르면 알리고, 등록 금액을 바꾸면 알림이 사라진다', async () => {
  M.setSubscriptionsEnabled(db, true);
  const id = idOf('넷플릭스');
  M.setRecurringSubscription(db, id, true);
  paidYesterday(id, 17000);
  await show();
  expect(container.querySelector('.sub-row--changed .sub-changed').textContent).toContain('최근 결제 17,000원');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  await click(button('등록 금액 17,000원으로 바꾸기'));
  expect(confirm.mock.calls[0][0]).toContain('13,500원에서 17,000원으로');
  expect(M.getRecurringTransactions(db).find(r => r.id === id).amount).toBe(17000);
  expect(container.querySelector('.sub-row--changed')).toBeNull();
});

test("'이대로 두기'를 누르면 그 결제로는 다시 알리지 않는다", async () => {
  M.setSubscriptionsEnabled(db, true);
  const id = idOf('넷플릭스');
  M.setRecurringSubscription(db, id, true);
  paidYesterday(id, 9900);
  await show();
  await click(button('이대로 두기'));
  expect(container.querySelector('.sub-row--changed')).toBeNull();
  expect(M.getRecurringTransactions(db).find(r => r.id === id).amount).toBe(13500);
});

test('해지 메모를 남기고 고칠 수 있다', async () => {
  M.setSubscriptionsEnabled(db, true);
  M.setRecurringSubscription(db, idOf('넷플릭스'), true);
  await show();
  await click(button('해지 메모 남기기'));
  await typeInto(container.querySelector('input[aria-label="넷플릭스 해지 메모"]'), '3월에 해지');
  await click(button('저장'));
  expect(container.querySelector('.sub-note').textContent).toContain('해지 메모: 3월에 해지');
  await click(button('메모 고치기'));
  const input = container.querySelector('input[aria-label="넷플릭스 해지 메모"]');
  await typeInto(input, '앱에서 해지');
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await show();
  expect(container.querySelector('.sub-note').textContent).toContain('해지 메모: 앱에서 해지');
});

test('폼 — 켰을 때만 구독 칸이 보이고, 끈 동안 고쳐도 구독 표시·메모는 남는다', async () => {
  const id = idOf('넷플릭스');
  M.setRecurringSubscription(db, id, true);
  M.setSubscriptionNote(db, id, '메모');
  await show();
  await click(container.querySelector('button[title="수정"]'));
  expect(container.querySelector('#recurring-is-subscription')).toBeNull();
  await click(button('수정 저장'));
  expect(M.getRecurringTransactions(db).find(r => r.id === id)).toMatchObject({ is_subscription: 1, cancel_note: '메모' });

  M.setSubscriptionsEnabled(db, true);
  await show();
  await click(container.querySelector('button[title="수정"]'));
  const box = container.querySelector('#recurring-is-subscription');
  expect(box.checked).toBe(true);
  await click(box);
  await click(button('수정 저장'));
  expect(M.getRecurringTransactions(db).find(r => r.id === id).is_subscription).toBe(0);
});

test('끄면 화면만 감추고 고른 구독은 남는다', async () => {
  M.setSubscriptionsEnabled(db, true);
  M.setRecurringSubscription(db, idOf('넷플릭스'), true);
  await show();
  await click(button('구독 모아보기 끄기'));
  expect(container.querySelector('.sub-list')).toBeNull();
  expect(container.querySelector('.sub-badge')).toBeNull();
  expect(M.getSubscriptions(db).map(s => s.detail)).toEqual(['넷플릭스']);
});

describe('결제일을 바꾸면 앞으로의 거래도 옮길지 묻는다 (I-037)', () => {
  const NEXT = addMonths(currentYearMonth(), 1);
  const AFTER = addMonths(currentYearMonth(), 2);
  const register = (id, date) => db.run(
    `INSERT INTO transactions (payment_method, date, budget_category, detail, amount, is_recurring, recurring_source_id, recurring_frequency)
     VALUES ('신한카드', ?, '문화', '넷플릭스', 13500, 1, ?, 'monthly')`, [date, id],
  );
  const datesOf = id => db.exec('SELECT date FROM transactions WHERE recurring_source_id = ? ORDER BY date', [id])[0].values.map(v => v[0]);
  // 목록은 결제일 순이라 결제일을 바꾸면 자리가 바뀐다 — 넷플릭스 줄의 수정을 누른다
  const editNetflix = () => click([...container.querySelectorAll('.settings-item')]
    .find(el => el.textContent.includes('넷플릭스')).querySelector('button[title="수정"]'));
  const editDay = async (day) => {
    await show();
    await editNetflix();
    await typeInto(container.querySelector('input[placeholder="1~31, 0=말일"]'), day);
    await click(button('수정 저장'));
  };

  test("앞으로의 거래를 보여 주고 — '돌아가기'는 저장하지 않고, '함께 옮기기'는 거래도 새 결제일로", async () => {
    const id = idOf('넷플릭스');
    register(id, `${NEXT}-05`);
    register(id, `${AFTER}-05`);
    await editDay('25');
    const dialog = container.querySelector('.rmove');
    expect(dialog.textContent).toContain('결제일을 5일에서 25일로 바꿉니다. 미리 등록된 앞으로의 거래 2건도 새 결제일로 옮길까요?');
    expect([...dialog.querySelectorAll('.rmove-list li')].map(li => li.textContent)).toEqual([
      expect.stringMatching(/5일 → .*25일$/), expect.stringMatching(/5일 → .*25일$/),
    ]);
    await click(button('돌아가기'));
    expect(container.querySelector('.rmove')).toBeNull();
    expect(button('수정 저장')).toBeDefined();                            // 폼은 그대로
    expect(M.getRecurringTransactions(db).find(r => r.id === id).day_of_month).toBe(5);
    await click(button('수정 저장'));
    await click(button('함께 옮기기'));
    expect(container.querySelector('.rmove')).toBeNull();
    expect(M.getRecurringTransactions(db).find(r => r.id === id).day_of_month).toBe(25);
    expect(datesOf(id)).toEqual([`${NEXT}-25`, `${AFTER}-25`]);
  });

  test("'정기지출만 바꾸기'는 거래를 그대로 두고, 옮길 거래가 없으면 묻지 않는다", async () => {
    const id = idOf('넷플릭스');
    register(id, `${NEXT}-05`);
    await editDay('25');
    await click(button('정기지출만 바꾸기'));
    expect(M.getRecurringTransactions(db).find(r => r.id === id).day_of_month).toBe(25);
    expect(datesOf(id)).toEqual([`${NEXT}-05`]);
    db.run('DELETE FROM transactions');
    await editDay('10');
    expect(container.querySelector('.rmove')).toBeNull();
    expect(M.getRecurringTransactions(db).find(r => r.id === id).day_of_month).toBe(10);
  });

  test('지금 결제일과 날짜가 다른 거래는 그대로 둔다고 알리고 옮기지 않는다', async () => {
    const id = idOf('넷플릭스');
    register(id, `${NEXT}-05`);
    register(id, `${AFTER}-03`);                                         // 5일이 아닌 날
    await editDay('25');
    const dialog = container.querySelector('.rmove');
    expect(dialog.textContent).toContain('앞으로의 거래 1건도 새 결제일로 옮길까요?');
    expect(dialog.textContent).toMatch(/3일 거래는 지금 결제일\(5일\)과 날짜가 달라\(직접 고쳤거나 예전 결제일\) 그대로 둡니다\./);
    await click(button('함께 옮기기'));
    expect(datesOf(id)).toEqual([`${NEXT}-25`, `${AFTER}-03`]);
  });

  test('금액도 바꾸면 옮길 때 금액도 따라간다고 알린다', async () => {
    const id = idOf('넷플릭스');
    register(id, `${NEXT}-05`);
    await show();
    await editNetflix();
    await typeInto(container.querySelector('input[placeholder="1~31, 0=말일"]'), '25');
    const amount = [...container.querySelectorAll('input')].find(i => i.value === '13500');
    await typeInto(amount, '17000');
    await click(button('수정 저장'));
    expect(container.querySelector('.rmove').textContent).toContain('옮기는 거래 중 손대지 않은 것(금액·할인·결제수단 등을 고치지 않은 것)은 금액·할인도 새 값으로 바뀝니다.');
    await click(button('함께 옮기기'));
    expect(db.exec('SELECT date, amount FROM transactions WHERE recurring_source_id = ?', [id])[0].values).toEqual([[`${NEXT}-25`, 17000]]);
  });
});
