// 월간 리포트 (I-028, ROADMAP C-9) — 3개월 평균 대비 늘고 준 카테고리, 큰 지출 3건, 무지출일, 목표·예산 결과
import initSqlJs from 'sql.js';
import {
  createDatabase, addTransaction, setMonthlyGoal, setCategoryBudgetEnabled, setDefaultCategoryBudget, addBudgetCategory,
  setMonthlyBalanceEnabled, addAccount, addRecurringItem, addAccountTransaction,
  isMonthlyReportEnabled, setMonthlyReportEnabled, getMonthlyReport, getReportMonths, getMonthlyReportHeadline, reportAvgLabel, reportSoFarLabel,
} from '../dbManager';
import { buildReportPrompt, polishReportWithAI } from '../monthlyReportAI';
import { analyzeWithAI } from '../aiClient';

vi.mock('../aiClient', async (orig) => ({ ...(await orig()), analyzeWithAI: vi.fn() }));

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const TODAY = '2026-11-03';
const spend = (db, date, category, amount, extra = {}) => addTransaction(db, {
  payment_method: '카드', date, budget_category: category, detail: extra.detail || `${category} 지출`, amount, ...extra,
});

// 8·9월이 앞 달 기록(7월은 쓰기 전이라 없음), 10월이 리포트 달
function makeDb() {
  const { db } = createDatabase(SQL, null);
  ['2026-08', '2026-09'].forEach(m => {
    spend(db, `${m}-03`, '식비', 300000);
    spend(db, `${m}-04`, '교통', 100000);
    spend(db, `${m}-05`, '쇼핑', 200000);
  });
  spend(db, '2026-10-02', '식비', 450000, { detail: '한우 가게' });   // +150,000 (+50%) — 크게 늘었다
  spend(db, '2026-10-03', '교통', 120000);                              // +20,000 — 3만 원이 안 돼 알리지 않는다
  spend(db, '2026-10-04', '쇼핑', 50000);                               // -150,000 — 크게 줄었다
  spend(db, '2026-10-05', '의료', 60000);                               // 평균 0 → 새 지출
  spend(db, '2026-10-06', '간식', 10000);                               // 새 지출이지만 작다
  return db;
}

test('선택 기능 — 처음에는 꺼져 있다', () => {
  const db = makeDb();
  expect(isMonthlyReportEnabled(db)).toBe(false);
  setMonthlyReportEnabled(db, true);
  expect(isMonthlyReportEnabled(db)).toBe(true);
});

test('합계와 3개월 평균 — 거래가 있는 앞 달만으로 평균을 낸다', () => {
  const r = getMonthlyReport(makeDb(), '2026-10', TODAY);
  expect([r.month, r.inProgress, r.total, r.count]).toEqual(['2026-10', false, 690000, 5]);
  expect(r.avg).toEqual({ months: ['2026-08', '2026-09'], total: 600000 });
});

test('평균보다 크게 늘거나 줄어든 카테고리 — 3만 원 이상이면서 평균의 30% 이상', () => {
  const r = getMonthlyReport(makeDb(), '2026-10', TODAY);
  expect(r.rises.map(c => [c.name, c.total, c.avg, c.diff])).toEqual([
    ['식비', 450000, 300000, 150000], ['의료', 60000, 0, 60000],
  ]);
  expect(r.drops.map(c => [c.name, c.diff])).toEqual([['쇼핑', -150000]]);
  expect(r.categories.map(c => c.name)).toEqual(['식비', '교통', '의료', '쇼핑', '간식']);
});

test('비교할 앞 달이 없으면 평균·증감이 없다', () => {
  const { db } = createDatabase(SQL, null);
  spend(db, '2026-10-02', '식비', 450000);
  const r = getMonthlyReport(db, '2026-10', TODAY);
  expect([r.avg, r.rises, r.drops]).toEqual([null, [], []]);
});

test('가장 큰 지출 3건 — 분할 결제는 몫을 합치고, 환불·전액 할인은 빼고, 할인 뺀 금액으로', () => {
  const db = makeDb();
  spend(db, '2026-10-10', '가전', 400000, { detail: '냉장고', split_group_id: 's1' });
  spend(db, '2026-10-10', '가전', 300000, { detail: '냉장고', split_group_id: 's1', payment_method: '다른 카드' });
  spend(db, '2026-10-11', '식비', 500000, { discount_amount: 100000, detail: '회식' });
  spend(db, '2026-10-12', '쇼핑', -80000, { detail: '환불' });
  const r = getMonthlyReport(db, '2026-10', TODAY);
  expect(r.biggest).toEqual([
    { date: '2026-10-10', detail: '냉장고', category: '가전', amount: 700000, split: true },
    { date: '2026-10-02', detail: '한우 가게', category: '식비', amount: 450000, split: false },
    { date: '2026-10-11', detail: '회식', category: '식비', amount: 400000, split: false },
  ]);
});

test('무지출일 — 순지출이 있는 거래가 없는 날, 이번 달은 오늘까지, 지난달과 견준다', () => {
  const db = makeDb();
  spend(db, '2026-10-20', '쇼핑', -30000, { detail: '환불만 있는 날' });
  spend(db, '2026-10-21', '간식', 5000, { discount_amount: 5000, detail: '전액 할인' });
  const r = getMonthlyReport(db, '2026-10', TODAY);
  expect(r.noSpend).toEqual({ days: 31 - 5, of: 31, prevDays: 30 - 3, prevOf: 30 });

  spend(db, '2026-11-01', '식비', 10000);
  spend(db, '2026-11-25', '통신', 500000);                               // 미리 등록된 정기지출 — 오늘 뒤라 무지출일·큰 지출에 넣지 않는다
  const now = getMonthlyReport(db, '2026-11', TODAY);
  expect(now.inProgress).toBe(true);
  expect(now.noSpend).toMatchObject({ days: 2, of: 3 });
  expect(now.drops).toEqual([]);                                          // 진행 중인 달은 '줄었다'를 알리지 않는다
  expect([now.total, now.upcoming]).toEqual([510000, 500000]);           // 합계에는 들어 있고 따로 알린다
  expect(now.biggest.map(b => b.amount)).toEqual([10000]);
});

test('진행 중인 달은 목표·예산을 지켰다고 단정하지 않는다(넘었으면 넘었다)', () => {
  const db = makeDb();
  spend(db, '2026-11-02', '식비', 10000);
  setMonthlyGoal(db, '2026-11', 1000000);
  expect(getMonthlyReport(db, '2026-11', TODAY).goal).toEqual({ amount: 1000000, spent: 10000, ratio: 0.01, over: false, achieved: null });
  setMonthlyGoal(db, '2026-11', 5000);
  expect(getMonthlyReport(db, '2026-11', TODAY).goal).toMatchObject({ over: true, achieved: null });
  const prompt = buildReportPrompt(getMonthlyReport(db, '2026-11', TODAY));
  expect(prompt).toContain('진행 중이라 지금까지 5,000원 넘음');
  setMonthlyGoal(db, '2026-11', 1000000);
  expect(buildReportPrompt(getMonthlyReport(db, '2026-11', TODAY))).toContain('진행 중, 지금까지 1% 씀(남은 990,000원), 달성 여부는 아직 모름');
  expect(buildReportPrompt(getMonthlyReport(db, '2026-11', TODAY), { showGoal: false })).not.toContain('월 목표');
  spend(db, '2026-11-20', '통신', 50000);                                // 오늘 뒤 예정 거래가 있으면 '예정 포함'
  const withUpcoming = getMonthlyReport(db, '2026-11', TODAY);
  expect(reportSoFarLabel(withUpcoming)).toBe('예정 포함 ');
  expect(buildReportPrompt(withUpcoming)).toContain('진행 중, 예정 포함 6% 씀');
  expect(reportSoFarLabel(getMonthlyReport(db, '2026-10', TODAY))).toBe('');
});

test('앞날짜로 미리 넣은 거래만 있으면 그날을 가계부 시작으로 보지 않는다', () => {
  const { db } = createDatabase(SQL, null);
  spend(db, '2026-11-25', '월세', 500000);
  spend(db, '2026-11-12', '통신', 50000);
  const r = getMonthlyReport(db, '2026-11', '2026-11-10');
  expect(r.partialFrom).toBeNull();
  expect(r.noSpend).toMatchObject({ days: 10, of: 10 });
});

test('평균은 0 아래로 내려가지 않는다 — 앞 달에 환불만 있던 카테고리는 늘었다·줄었다·새 지출로 보이지 않는다', () => {
  const db = makeDb();
  spend(db, '2026-06-28', '가전', 1500000);
  spend(db, '2026-08-03', '가전', -1500000, { detail: '환불' });          // 평균 기간(8~9월)에는 환불만
  spend(db, '2026-10-15', '선물', -50000, { detail: '환불만' });          // 평균 0인 카테고리에 이 달 환불만
  const r = getMonthlyReport(db, '2026-10', TODAY);
  expect(r.categories.find(c => c.name === '가전')).toBeUndefined();
  expect(r.rises.map(c => c.name)).toEqual(['식비', '의료']);
  expect(r.drops.map(c => c.name)).toEqual(['쇼핑']);
});

test('한 번뿐인 큰 지출 뒤에는 석 달 내내 줄었다고 하지 않는다 — 앞 달 중 두 달 이상 쓴 카테고리만', () => {
  const db = makeDb();
  spend(db, '2026-09-20', '여행', 1800000);
  expect(getMonthlyReport(db, '2026-10', TODAY).drops.map(c => c.name)).toEqual(['쇼핑']);
});

test('달 중간에 쓰기 시작한 첫 달은 비교에서 빼고, 그 달 리포트는 시작한 날부터 센다', () => {
  const { db } = createDatabase(SQL, null);
  spend(db, '2026-08-25', '식비', 100000);
  spend(db, '2026-09-03', '식비', 420000);
  const sep = getMonthlyReport(db, '2026-09', TODAY);
  expect([sep.avg, sep.rises, sep.noSpend.prevDays]).toEqual([null, [], null]);
  const aug = getMonthlyReport(db, '2026-08', TODAY);
  expect(aug.partialFrom).toBe('2026-08-25');
  expect(aug.noSpend).toMatchObject({ days: 6, of: 7 });
  spend(db, '2026-08-05', '식비', 1000);                                   // 5일부터 썼으면 첫 달도 한 달로 본다
  expect(getMonthlyReport(db, '2026-09', TODAY).avg).toEqual({ months: ['2026-08'], total: 101000 });
});

test('알림용 가벼운 요약은 리포트와 같은 값 — 비교 기준을 부르는 말', () => {
  const db = makeDb();
  const r = getMonthlyReport(db, '2026-10', TODAY);
  expect(getMonthlyReportHeadline(db, '2026-10')).toEqual({ month: '2026-10', total: r.total, count: r.count, avg: r.avg });
  expect(getMonthlyReportHeadline(db, '2026-07')).toEqual({ month: '2026-07', total: 0, count: 0, avg: null });
  expect(reportAvgLabel(r)).toBe('앞 2개월 평균');
  expect(reportAvgLabel({ month: '2026-09', avg: { months: ['2026-08'] } })).toBe('지난달');
  expect(reportAvgLabel({ month: '2026-10', avg: { months: ['2026-08'] } })).toBe('8월');
});

test('연말·연초 — 1월 리포트는 앞 해 10~12월과 견준다', () => {
  const { db } = createDatabase(SQL, null);
  ['2026-10', '2026-11', '2026-12'].forEach(m => spend(db, `${m}-05`, '식비', 300000));
  spend(db, '2027-01-05', '식비', 600000);
  const r = getMonthlyReport(db, '2027-01', '2027-02-02');
  expect(r.avg).toEqual({ months: ['2026-10', '2026-11', '2026-12'], total: 300000 });
  expect(r.noSpend).toMatchObject({ of: 31, prevOf: 31, prevDays: 30 });
  expect(reportAvgLabel(r)).toBe('앞 3개월 평균');
});

test('월 목표·카테고리 예산·수지 — 정해 두었거나 켰을 때만', () => {
  const db = makeDb();
  let r = getMonthlyReport(db, '2026-10', TODAY);
  expect([r.goal, r.budgets, r.balance]).toEqual([null, null, null]);

  setMonthlyGoal(db, '2026-10', 600000);
  ['식비', '교통', '쇼핑'].forEach(c => addBudgetCategory(db, c));
  setCategoryBudgetEnabled(db, true);
  setDefaultCategoryBudget(db, '식비', 400000, '2026-10');
  setDefaultCategoryBudget(db, '교통', 130000, '2026-10');
  setDefaultCategoryBudget(db, '쇼핑', 300000, '2026-10');
  setMonthlyBalanceEnabled(db, true);
  const acct = addAccount(db, { name: '월급통장' });
  addRecurringItem(db, { account_id: acct, name: '월급', type: 'income', day_of_month: 25, fixed_amount: 3000000, auto_register: false });
  addAccountTransaction(db, { account_id: acct, date: '2026-10-25', type: 'income', description: '월급', amount: 3000000 });
  r = getMonthlyReport(db, '2026-10', TODAY);
  expect(r.goal).toEqual({ amount: 600000, spent: 690000, ratio: 690000 / 600000, over: true, achieved: false });
  expect(r.budgets.over.map(b => b.category)).toEqual(['식비']);
  expect(r.budgets.warn.map(b => b.category)).toEqual(['교통']);
  expect(r.budgets.okCount).toBe(1);
  expect(r.balance).toMatchObject({ income: 3000000, spend: 690000, left: 2310000 });
});

test('볼 수 있는 달 — 거래가 있는 달 중 이번 달까지(미리 등록된 다음 달은 빼고)', () => {
  const db = makeDb();
  spend(db, '2026-12-05', '통신', 50000);
  expect(getReportMonths(db, TODAY)).toEqual(['2026-10', '2026-09', '2026-08']);
  expect(getMonthlyReport(db, '2026-07', TODAY)).toMatchObject({ count: 0, total: 0, biggest: [] });
});

test('AI에는 합계 수준만 — 가게·메모 같은 내용은 보내지 않는다', async () => {
  const db = makeDb();
  const r = getMonthlyReport(db, '2026-10', TODAY);
  const prompt = buildReportPrompt(r);
  expect(prompt).toContain('순지출 합계 690,000원');
  expect(prompt).toContain('평균보다 크게 늘어난 카테고리: 식비 450,000원(평균 300,000원)');
  expect(prompt).toContain('비교 기준: 앞 2개월 평균 600,000원');
  expect(prompt).not.toContain('월 목표');                                // 목표를 정하지 않았으면 그 줄이 없다

  expect(prompt).toContain('가장 큰 지출: 식비 450,000원');
  expect(prompt).not.toContain('한우 가게');

  analyzeWithAI.mockResolvedValueOnce({ headline: ' 지난달보다 많이 썼어요 ', points: ['식비가 늘었어요', 42, ''], tip: '' });
  await expect(polishReportWithAI({ ai: {}, report: r })).resolves.toEqual({
    headline: '지난달보다 많이 썼어요', points: ['식비가 늘었어요'], tip: '',
  });
  expect(analyzeWithAI.mock.calls[0][0].prompt).toBe(prompt);
  analyzeWithAI.mockResolvedValueOnce({ headline: '', points: [] });
  await expect(polishReportWithAI({ ai: {}, report: r })).rejects.toThrow('만들지 못했습니다');
  await expect(polishReportWithAI({ ai: {}, report: { ...r, count: 0 } })).rejects.toThrow('정리할 거래가 없습니다');
});
