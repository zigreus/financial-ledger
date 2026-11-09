/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 작은 개선 (ROADMAP U-3~U-6) — 삭제 되돌리기, 금액 읽어 주기, 날짜 빠른 선택, 이 거래로 새로 입력.
// 로그인(MSAL)·저장 훅·AI 설정 동기화는 가짜, 가계부 DB는 진짜 sql.js(변경 기록 포함)
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../../services/dbManager';
import { addDays, todayStr } from '../../../services/dateUtils';
import App from '../App';
import { preloadScreens } from '../screens';
import AIEntry from '../../AIEntry/lazyAIEntry';

const shared = vi.hoisted(() => ({ db: null }));

vi.mock('@azure/msal-react', () => ({
  useIsAuthenticated: () => true,
  useMsal: () => ({ instance: {}, accounts: [{ homeAccountId: 'me', username: 'me@outlook.com' }] }),
}));
vi.mock('../../../services/aiSettingsSync', () => ({
  setAISyncAccount: vi.fn(),
  syncAISettings: vi.fn(async () => 'none'),
  onAISettingsPulled: () => () => {},
}));
vi.mock('../../../hooks/useLedgerSync', async () => {
  const React = await import('react');
  const { attachChangeLog: attach } = await import('../../../services/changeLog');
  return {
    default: function useFakeLedger() {
      const [state, setState] = React.useState({ db: shared.db, version: 0 });
      const bump = () => queueMicrotask(() => setState(s => ({ ...s, version: s.version + 1 })));
      React.useState(() => attach(shared.db, { onWrite: bump }));
      // 저장소에서 다시 받은 것처럼(다른 기기와 합침) DB 객체를 바꾼다
      shared.reload = (next) => { attach(next, { onWrite: bump }); setState(s => ({ db: next, version: s.version + 1 })); };
      return {
        db: state.db, dataVersion: state.version, loading: false, saving: false, error: '', setError: () => {}, notice: null,
        dirty: false, pendingCount: 0, loadDb: async () => {}, saveNow: async () => true, resetForLogout: () => {},
        listBackups: async () => [], createBackup: async () => '', restoreBackup: async () => {},
      };
    },
  };
});

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  expect(await preloadScreens()).toBe(true);
  await AIEntry.preload();
  SQL = await initSqlJs();
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

let root;
let container;
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '');
});

const TODAY = todayStr();
async function open() {
  const { db } = M.createDatabase(SQL, null);
  M.addPaymentMethod(db, '현금');
  M.addPaymentMethod(db, '신한카드');
  M.addBudgetCategory(db, '식비');
  M.addSubCategory(db, '식비', '카페');
  M.addTransaction(db, { payment_method: '신한카드', date: TODAY, budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 5000 });
  M.addTransaction(db, { payment_method: '현금', date: TODAY, budget_category: '식비', sub_category: '카페', detail: '빵집', amount: 3000 });
  shared.db = db;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<App />); });
  await wait();
  return db;
}
const wait = (ms = 0) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
// 창(ModalOverlay)은 body에 그려진다 — 화면 전체에서 찾는다
const button = text => [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const click = el => act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)); });
const details = db => M.getTransactions(db).map(t => t.detail).sort();
const topToast = () => document.body.querySelector('.toast-banner.toast-top');
const item = text => [...container.querySelectorAll('.tx-item')].find(el => el.textContent.includes(text));
const setValue = (input, value) => act(async () => {
  const proto = input.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
  input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});

test('U-3 삭제하면 화면 위 알림의 되돌리기로 그대로 되살린다', async () => {
  const db = await open();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await click(item('스타벅스'));
  await click(document.body.querySelector('.modal-content .btn-danger'));
  expect(details(db)).toEqual(['빵집']);
  expect(topToast().textContent).toContain('✓ 거래가 삭제되었습니다');
  await click(button('되돌리기'));
  expect(details(db)).toEqual(['빵집', '스타벅스']);
  const back = M.getTransactions(db).find(t => t.detail === '스타벅스');
  expect([back.payment_method, back.amount, back.date, back.sub_category]).toEqual(['신한카드', 5000, TODAY, '카페']);
  expect(topToast().textContent).toBe('✓ 지운 거래를 되살렸습니다');
  expect(topToast().querySelector('button')).toBeNull();
});

test('U-3 그사이 가계부를 다시 불러왔으면(다른 기기와 합침 등) 되살리지 않고 알린다 — 지운 번호가 새 가계부의 다른 행일 수 있다', async () => {
  const db = await open();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await click(item('스타벅스'));
  await click(document.body.querySelector('.modal-content .btn-danger'));
  const next = M.createDatabase(SQL, db.export()).db;   // 지운 뒤의 가계부를 새로 받았다
  await act(async () => { shared.reload(next); });
  await wait();
  await click(button('되돌리기'));
  expect(details(next)).toEqual(['빵집']);
  expect(details(db)).toEqual(['빵집']);
  expect(topToast().textContent).toContain('그사이 가계부를 다시 불러와 되돌리지 못했습니다');
});

test('U-6 분할 결제는 묶음 합계로, 숨긴 결제수단은 옮기지 않는다', async () => {
  const db = await open();
  M.addTransaction(db, { payment_method: '신한카드', date: TODAY, budget_category: '식비', sub_category: '카페', detail: '회식', amount: 30000, split_group_id: 'g1' });
  M.addTransaction(db, { payment_method: '현금', date: TODAY, budget_category: '식비', sub_category: '카페', detail: '회식', amount: 20000, split_group_id: 'g1' });
  db.run("UPDATE payment_methods SET is_hidden = 1 WHERE name = '신한카드'");
  await act(async () => { shared.reload(db); });
  await wait();
  // 숨긴 신한카드로 낸 몫을 연다
  await click([...container.querySelectorAll('.tx-item')].find(el => el.textContent.includes('회식') && el.textContent.includes('30,000')));
  await click(button('복사해 입력'));
  const form = document.body.querySelector('.tx-form');
  expect([...form.querySelectorAll('input')].some(i => i.value === '50000')).toBe(true);
  const payment = form.querySelector('select');
  expect(payment.value).toBe('');                                     // 숨긴 카드는 고르지 않는다
  expect([...payment.options].some(o => o.textContent.includes('(숨김)'))).toBe(false);
});

test('U-6 거래 상세의 복사해 입력 — 내용·분류·결제수단·금액은 그대로, 날짜는 오늘인 새 거래', async () => {
  const db = await open();
  await click(item('스타벅스'));
  await click(button('복사해 입력'));
  const form = document.body.querySelector('.tx-form');
  expect(form).not.toBeNull();
  expect(document.body.textContent).toContain('거래 추가');
  expect(form.querySelector('#txf-date').value).toBe(TODAY);
  const selects = [...form.querySelectorAll('select')];
  expect(selects.map(s => s.value)).toEqual(expect.arrayContaining(['신한카드', '식비', '카페']));
  expect([...form.querySelectorAll('input')].some(i => i.value === '스타벅스')).toBe(true);
  expect([...form.querySelectorAll('input')].some(i => i.value === '5000')).toBe(true);
  // 날짜를 어제로 바꿔 추가하면 원래 거래는 그대로 두고 새 거래가 하나 더 생긴다
  await click(button('어제'));
  await click([...form.querySelectorAll('button')].find(b => b.type === 'submit'));
  await wait(10);
  const starbucks = M.getTransactions(db).filter(t => t.detail === '스타벅스').map(t => t.date).sort();
  expect(starbucks).toEqual([addDays(TODAY, -1), TODAY]);
});

test('U-5 날짜 빠른 선택 — 오늘·어제·그제를 누르면 그 날짜, 고른 것이 표시된다', async () => {
  await open();
  await click(container.querySelector('.nav-add'));
  const date = () => document.body.querySelector('#txf-date').value;
  const chip = label => [...document.body.querySelectorAll('.txf-date-chip')].find(b => b.textContent === label);
  expect(date()).toBe(TODAY);
  expect(chip('오늘').getAttribute('aria-pressed')).toBe('true');
  await click(chip('그제'));
  expect(date()).toBe(addDays(TODAY, -2));
  expect(chip('그제').getAttribute('aria-pressed')).toBe('true');
  expect(chip('오늘').getAttribute('aria-pressed')).toBe('false');
  await click(chip('어제'));
  expect(date()).toBe(addDays(TODAY, -1));
});

test('U-4 금액 읽어 주기 — 입력하는 동안 만 원부터 만·억 단위로, 수식은 결과 옆에', async () => {
  await open();
  await click(container.querySelector('.nav-add'));
  const amount = document.body.querySelector('.tx-form .amount-input input');
  await act(async () => { amount.focus(); amount.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
  await setValue(amount, '1250000');
  expect(document.body.querySelector('.tx-form .amount-words').textContent).toBe('125만 원');
  await setValue(amount, '9000');
  expect(document.body.querySelector('.tx-form .amount-words')).toBeNull();
  await setValue(amount, '100000*3');
  expect(document.body.querySelector('.tx-form .formula-preview').textContent).toBe('= 300,000원 · 30만 원');
});
