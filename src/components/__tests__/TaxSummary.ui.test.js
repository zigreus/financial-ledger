/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 연말정산 참고 합계 화면 (I-029, ROADMAP C-10) — 요약 › 연말정산 탭(켰을 때만), 유형·항목 고르기, 해 고르기, 설정 켜고 끄기
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../services/dbManager';
import SummaryView from '../SummaryView/SummaryView';
import TaxSummarySettings from '../SettingsView/sections/TaxSummarySettings';

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  SQL = await initSqlJs();
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let db;
let container;
let root;
let version = 0;
let changed = 0;
beforeEach(() => {
  ({ db } = M.createDatabase(SQL, null));
  ['신한카드', '토스체크'].forEach(n => M.addPaymentMethod(db, n));
  ['의료', '교통'].forEach(c => M.addBudgetCategory(db, c));
  M.addSubCategory(db, '교통', '버스');
  M.addSubCategory(db, '교통', '택시');
  const spend = (date, pm, cat, amount, extra = {}) => M.addTransaction(db, { payment_method: pm, date, budget_category: cat, detail: '', amount, ...extra });
  spend('2025-03-01', '신한카드', '의료', 100000);
  spend('2025-04-01', '토스체크', '교통', 30000, { sub_category: '버스' });
  spend('2025-04-02', '신한카드', '교통', 20000, { sub_category: '택시' });
  spend('2025-05-01', '신한카드', '의료', 50000, { foreign_amounts: { USD: 40 } });
  spend('2024-12-01', '신한카드', '의료', 70000);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  changed = 0;
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const render = el => act(async () => { root.render(el); });
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text || b.title === text);
const click = el => act(async () => { el.click(); });
const choose = (select, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
});
const show = (tab = 'tax') => render(
  <SummaryView db={db} dataVersion={version += 1} tab={tab} drilldownCategory={null} onTabChange={() => {}} onDrilldownChange={() => {}} onChanged={() => { changed += 1; }} />,
);
const pickYear = async (y) => { await choose(container.querySelector('select[aria-label="연도"]'), y); await show(); };

test('끄면 탭이 없고 연말정산 탭으로 열려도 월별 추이를 보인다', async () => {
  await show();
  expect(button('연말정산')).toBeUndefined();
  expect(container.querySelector('.tax')).toBeNull();
  expect(container.querySelector('.tab.active').textContent).toBe('월별 추이');
});

// 해를 고르는 테스트(pickYear)보다 먼저 — 고른 해는 요약 화면이 앱을 끌 때까지 기억한다
test('1·2월에는 작년을, 그 밖에는 올해를 먼저 보이고, 숨긴 카테고리도 그 해에 썼으면 분류할 수 있다', async () => {
  M.addTransaction(db, { payment_method: '신한카드', date: '2026-01-10', budget_category: '의료', detail: '', amount: 5000 });
  M.setTaxSummaryEnabled(db, true);
  const med = M.getAllBudgetCategories(db).find(c => c.name === '의료');
  M.setMasterItemHidden(db, 'budget_categories', med.id, true);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date(2026, 0, 15, 10));
    await show();
    expect(container.querySelector('select[aria-label="연도"]').value).toBe('2025');
    await click(button('분류 정하기'));
    expect(container.querySelector('select[aria-label="의료 항목"]')).not.toBeNull();
    expect(container.textContent).toContain('숨김');

    act(() => root.unmount());
    root = createRoot(container);
    vi.setSystemTime(new Date(2026, 10, 15, 10));
    await show();
    expect(container.querySelector('select[aria-label="연도"]').value).toBe('2026');
  } finally {
    vi.useRealTimers();
  }
});

test('켜면 한 해 결제를 유형별로 — 유형을 정하지 않은 결제수단을 알리고, 해외 결제는 뺀다', async () => {
  M.setTaxSummaryEnabled(db, true);
  await show();
  expect(button('연말정산')).toBeDefined();
  await pickYear('2025');
  const tax = container.querySelector('.tax');
  expect(tax.querySelector('.tax-total').textContent).toContain('150,000원');
  expect(tax.querySelector('.tax-warn').textContent).toContain('신한카드, 토스체크');
  expect(tax.textContent).toContain('해외 결제(외화 금액이 있는 거래) 50,000원 · 1건은 카드 소득공제에서 빠지는 결제라');
  expect(tax.textContent).toContain('공제액은 계산하지 않아요');
});

test('분류 정하기 — 결제수단 유형과 카테고리·세부카테고리 항목을 고르면 합계가 바뀐다', async () => {
  M.setTaxSummaryEnabled(db, true);
  await show();
  await pickYear('2025');
  await click(button('분류 정하기'));
  const sel = label => container.querySelector(`select[aria-label="${label}"]`);
  await choose(sel('신한카드 유형'), 'credit');
  await choose(sel('토스체크 유형'), 'debit');
  await choose(sel('의료 항목'), '의료비');
  await choose(sel('교통 항목'), '대중교통');
  await show();
  await choose(sel('교통 › 택시 항목'), M.TAX_TAG_NONE);
  await show();
  expect(changed).toBe(5);
  const s = M.getTaxSummary(db, '2025');
  expect(s.untypedMethods).toEqual([]);
  expect(s.tags.map(g => [g.tag, g.amount])).toEqual([['의료비', 100000], ['대중교통', 30000]]);
  expect(container.querySelector('.tax-warn')).toBeNull();
  const rows = [...container.querySelectorAll('.tax-block .tax-row-btn')].map(r => r.textContent);
  expect(rows).toEqual(['신용카드120,000원 2건', '체크카드·현금영수증30,000원 1건']);
  await click(container.querySelector('.tax-row-btn'));
  expect(container.querySelector('.tax-sublist').textContent).toContain('신한카드');
});

test('세부카테고리별로 고르기는 화면만 펼치고 가계부에는 쓰지 않는다', async () => {
  M.setTaxSummaryEnabled(db, true);
  await show();
  await click(button('분류 정하기'));
  const before = JSON.stringify(M.getTaxClassification(db));
  await click([...container.querySelectorAll('button')].filter(b => b.textContent === '세부카테고리별로 고르기')[0]);
  expect(container.querySelector('select[aria-label="교통 › 버스 항목"]')).not.toBeNull();
  expect(JSON.stringify(M.getTaxClassification(db))).toBe(before);
  expect(changed).toBe(0);
});

test('설정 — 켜고 끌 수 있다(끄면 탭만 감추고 분류는 남는다)', async () => {
  M.setPaymentMethodTaxType(db, '신한카드', 'credit');
  await render(<TaxSummarySettings db={db} dataVersion={version += 1} onChanged={() => {}} />);
  await click(button('연말정산 참고 합계 켜기'));
  expect(M.isTaxSummaryEnabled(db)).toBe(true);
  await render(<TaxSummarySettings db={db} dataVersion={version += 1} onChanged={() => {}} />);
  await click(button('연말정산 참고 합계 끄기'));
  expect(M.isTaxSummaryEnabled(db)).toBe(false);
  expect(M.getTaxClassification(db).methods.find(m => m.name === '신한카드').taxType).toBe('credit');
});
