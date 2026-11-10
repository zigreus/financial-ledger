// AI 명령 (I-051) — 말한 요청을 할 일로 검증하고, 실행하고, 되돌린다
import initSqlJs from 'sql.js';
import {
  createDatabase, addTransaction, getTransactions, addRecurringTransaction, getRecurringTransactions,
  getRegistrationLog, getSetting, getMonthlyGoal, isCategoryBudgetEnabled,
  isMonthlyReportEnabled, getBudgetCategories, getSubCategories, getPaymentMethods, getMemberNames, addMember,
} from '../dbManager';
import { analyzeWithAI } from '../aiClient';
import {
  looksLikeCommand, parseCommand, buildCommandPrompt, buildPlan, planAction, findTargetTransactions,
  runPlan, undoPlan, isRunnable, describeRun,
} from '../aiCommand';
import { getTheme } from '../displayPrefs';

vi.mock('../aiClient', async (importOriginal) => ({ ...(await importOriginal()), analyzeWithAI: vi.fn() }));

const TODAY = '2026-11-10';
const AI = { provider: 'gemini', apiKey: 'k', model: 'gemini-flash-latest' };
let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => { analyzeWithAI.mockReset(); });

function makeDb() {
  const { db } = createDatabase(SQL, null);
  db.run("INSERT INTO payment_methods (name, sort_order) VALUES ('현금', 1),('신한카드', 2)");
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('식비', 1),('생활', 2)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('식비','점심',1),('식비','커피',2),('생활','구독',1)");
  addMember(db, '엄마');
  return db;
}
const tx = (db, o) => addTransaction(db, {
  payment_method: '신한카드', date: '2026-11-09', budget_category: '식비', sub_category: '커피', detail: '스타벅스', amount: 4500, ...o,
});
const T = o => ({ date_from: '', date_to: '', keyword: '', amount: 0, category: '', sub_category: '', payment_method: '', member: '', which: 'all', recurring_id: 0, ...o });
const C = o => ({ date: '', amount: 0, detail: '', category: '', payment_method: '', member: '', day_of_month: 0, month_of_year: 0, ...o });
const S = o => ({ key: '', value: '', month: '', name: '', parent: '', ...o });
const act = (type, { target, changes, setting, summary = '' } = {}) => ({ type, summary, target: T(target), changes: C(changes), setting: S(setting) });
const all = db => getTransactions(db);

describe('명령처럼 보이는 글', () => {
  test.each([
    '방금 넣은 거 지워 줘', '어제 스타벅스 수정', '넷플릭스 정기지출 17000원으로', '식비 예산 50만원',
    '이번 달 외식 얼마 썼어?', '화면 어둡게', '월간 리포트 켜 줘', '카테고리 하나 만들어 줘',
  ])('%s → 명령', (t) => expect(looksLikeCommand(t)).toBe(true));
  test.each(['어제 점심 김치찌개 9천원 현금', '스타벅스 4500 카카오페이'])('%s → 새 거래', (t) => expect(looksLikeCommand(t)).toBe(false));
});

describe('지시문 — 목록만 보내고 거래 내역은 보내지 않는다', () => {
  test('정기지출 이름·구성원·선택 기능이 들어가고, 거래 내용은 없다', () => {
    const db = makeDb();
    tx(db, { detail: '비밀가게' });
    addRecurringTransaction(db, { payment_method: '신한카드', budget_category: '생활', sub_category: '구독', detail: '넷플릭스', amount: 13500, day_of_month: 5 });
    const p = buildCommandPrompt(db, '넷플릭스 17000원으로', TODAY);
    expect(p).toContain('넷플릭스 13,500원 매월 5일 · 신한카드');
    expect(p).toContain('[구성원] 엄마');
    expect(p).toContain('monthlyReport: 월간 리포트 (꺼짐)');
    expect(p).toContain('[사용자가 말한 내용]\n넷플릭스 17000원으로');
    // 입력 습관(세부내역 이름)은 말로 입력과 같은 범위로 들어가지만, 날짜·금액이 붙은 거래 목록은 없다
    expect(p).not.toContain('2026-11-09');
  });

  test('응답 모양을 바로잡고, 아무것도 없으면 되묻는다', async () => {
    analyzeWithAI.mockResolvedValueOnce({ actions: 'x', entries: [null], reply: '' });
    const r = await parseCommand({ db: makeDb(), ai: AI, text: '음', today: TODAY });
    expect(r.actions).toEqual([]);
    expect(r.entries).toEqual([]);
    expect(r.reply).toMatch(/알아듣지 못했어요/);
  });
});

describe('거래 찾기', () => {
  test('조건 없이 모두를 고르지 않는다 (방금 넣은 것은 된다)', () => {
    const db = makeDb();
    tx(db, {});
    expect(findTargetTransactions(db, T({})).error).toMatch(/어떤 거래인지/);
    const id = tx(db, { detail: '이디야' });
    expect(findTargetTransactions(db, T({ which: 'last_added' })).rows.map(r => r.id)).toEqual([id]);
  });

  test('가게 이름은 띄어쓰기·대소문자 없이, 금액은 할인 전·후 모두', () => {
    const db = makeDb();
    const a = tx(db, { detail: '스타 벅스', amount: 5000, discount_amount: 500 });
    tx(db, { detail: '이디야', amount: 4500 });
    expect(findTargetTransactions(db, T({ keyword: '스타벅스' })).rows.map(r => r.id)).toEqual([a]);
    expect(findTargetTransactions(db, T({ keyword: '스타벅스', amount: 4500 })).rows.map(r => r.id)).toEqual([a]);
  });

  test('목록에 없는 카테고리·결제수단·없는 날짜는 막는다', () => {
    const db = makeDb();
    expect(findTargetTransactions(db, T({ category: '외식' })).error).toMatch(/'외식' 카테고리가 없어요/);
    expect(findTargetTransactions(db, T({ payment_method: '국민카드' })).error).toMatch(/결제수단이 없어요/);
    expect(findTargetTransactions(db, T({ date_from: '2026-02-30' })).error).toMatch(/날짜/);
  });
});

describe('거래 고치기·지우기', () => {
  test('고칠 거래를 보여 주고(쓰지 않음), 실행하면 고치고, 되돌리면 그대로', () => {
    const db = makeDb();
    const id = tx(db, {});
    const step = planAction(db, act('tx_update', { target: { keyword: '스타벅스', date_from: '2026-11-09' }, changes: { category: '식비 > 점심', amount: 5000 } }));
    expect(step.ok).toBe(true);
    expect(step.auto).toBe(false);
    expect(step.title).toContain('금액 5,000원');
    expect(all(db)[0].amount).toBe(4500); // 계획만으로는 쓰지 않는다
    const { records } = runPlan(db, [step]);
    expect(all(db)[0]).toMatchObject({ id, amount: 5000, sub_category: '점심' });
    expect(undoPlan(db, records)).toEqual({ undone: 1, kept: 0 });
    expect(all(db)[0]).toMatchObject({ id, amount: 4500, sub_category: '커피' });
  });

  test('되돌리기 전에 사용자가 다시 고친 거래는 건드리지 않는다', () => {
    const db = makeDb();
    const id = tx(db, {});
    const step = planAction(db, act('tx_update', { target: { keyword: '스타벅스' }, changes: { amount: 5000 } }));
    const { records } = runPlan(db, [step]);
    db.run('UPDATE transactions SET amount = 6000 WHERE id = ?', [id]);
    expect(undoPlan(db, records)).toEqual({ undone: 0, kept: 1 });
    expect(all(db)[0].amount).toBe(6000);
  });

  test('목록에 없는 분류로는 고치지 않는다', () => {
    const db = makeDb();
    tx(db, {});
    const step = planAction(db, act('tx_update', { target: { keyword: '스타벅스' }, changes: { category: '외식 > 카페' } }));
    expect(step.ok).toBe(false);
    expect(step.error).toMatch(/목록에 없어요/);
    expect(isRunnable(step)).toBe(false);
  });

  test('분할 결제의 금액은 고치지 않고, 지울 때는 묶음을 함께 지운다', () => {
    const db = makeDb();
    tx(db, { amount: 3000, split_group_id: 'g1' });
    tx(db, { amount: 1500, split_group_id: 'g1', payment_method: '현금' });
    const upd = planAction(db, act('tx_update', { target: { keyword: '스타벅스', payment_method: '신한카드' }, changes: { amount: 5000 } }));
    expect(upd.ok).toBe(false);
    expect(upd.lines.join()).toMatch(/분할 결제/);
    const del = planAction(db, act('tx_delete', { target: { keyword: '스타벅스', payment_method: '신한카드' } }));
    expect(del.title).toBe('거래 2건 지우기');
    const { records } = runPlan(db, [del]);
    expect(all(db)).toHaveLength(0);
    undoPlan(db, records);
    expect(all(db).map(r => r.split_group_id)).toEqual(['g1', 'g1']);
  });

  test('조회는 합계만 보여 주고 아무것도 쓰지 않는다', () => {
    const db = makeDb();
    tx(db, { amount: 4500 });
    tx(db, { amount: 10000, discount_amount: 1000, detail: '김밥', sub_category: '점심', date: '2026-11-02' });
    tx(db, { amount: 7000, date: '2026-10-30' });
    const step = planAction(db, act('tx_query', { target: { date_from: '2026-11-01', date_to: TODAY, category: '식비' } }));
    expect(step.title).toBe('2건 · 순지출 13,500원');
    expect(step.auto).toBe(true);
    expect(isRunnable(step)).toBe(false);
  });
});

describe('정기지출', () => {
  const netflix = db => addRecurringTransaction(db, { payment_method: '신한카드', budget_category: '생활', sub_category: '구독', detail: '넷플릭스', amount: 13500, day_of_month: 5 });

  test('금액·결제일 고치기와 되돌리기', () => {
    const db = makeDb();
    const id = netflix(db);
    const step = planAction(db, act('recurring_update', { target: { recurring_id: id }, changes: { amount: 17000, day_of_month: 31 } }));
    expect(step.ok).toBe(true);
    expect(step.lines[1]).toContain('17,000원 매월 말일');
    const { records } = runPlan(db, [step]);
    expect(getRecurringTransactions(db)[0]).toMatchObject({ amount: 17000, day_of_month: 0 });
    undoPlan(db, records);
    expect(getRecurringTransactions(db)[0]).toMatchObject({ amount: 13500, day_of_month: 5 });
  });

  test('없는 번호는 막는다', () => {
    const db = makeDb();
    expect(planAction(db, act('recurring_update', { target: { recurring_id: 99 }, changes: { amount: 1 } })).ok).toBe(false);
  });

  test('지우고 되돌리면 등록 기록도 돌아와 이번 달을 또 등록하지 않는다', () => {
    const db = makeDb();
    const id = netflix(db);
    const txId = tx(db, { detail: '넷플릭스', budget_category: '생활', sub_category: '구독', amount: 13500, date: '2026-11-05' });
    db.run('UPDATE transactions SET recurring_source_id = ? WHERE id = ?', [id, txId]);
    db.run("INSERT INTO recurring_registration_log (recurring_id, registered_for_month, transaction_id) VALUES (?, '2026-11', ?)", [id, txId]);
    const step = planAction(db, act('recurring_delete', { target: { recurring_id: id } }));
    const { records } = runPlan(db, [step]);
    expect(getRecurringTransactions(db)).toHaveLength(0);
    expect(all(db)).toHaveLength(1); // 이미 등록된 거래는 그대로
    undoPlan(db, records);
    const [back] = getRecurringTransactions(db);
    expect(back).toMatchObject({ detail: '넷플릭스', amount: 13500 });
    expect(getRegistrationLog(db)[back.id]).toBeTruthy();
    expect(all(db)[0].recurring_source_id).toBe(back.id);
  });

  test('새로 만들려면 금액·카테고리·결제수단·결제일이 모두 있어야 한다', () => {
    const db = makeDb();
    const bad = planAction(db, act('recurring_add', { changes: { detail: '유튜브', amount: 14900 } }));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/카테고리·결제수단·결제일/);
    const good = planAction(db, act('recurring_add', { changes: { detail: '유튜브', amount: 14900, category: '생활 > 구독', payment_method: '신한카드', day_of_month: 15 } }));
    const { records } = runPlan(db, [good]);
    expect(getRecurringTransactions(db)[0]).toMatchObject({ detail: '유튜브', day_of_month: 15 });
    undoPlan(db, records);
    expect(getRecurringTransactions(db)).toHaveLength(0);
  });
});

describe('설정·목록 — 바로 하고 되돌린다', () => {
  test('월 목표: 늘 쓰는 값을 바꾸고 되돌리면 그때 남긴 달 값까지 지운다', () => {
    const db = makeDb();
    tx(db, { date: '2026-10-01' });
    db.run("INSERT INTO settings (key, value) VALUES ('default_monthly_goal', '1000000')");
    const step = planAction(db, act('goal', { changes: { amount: 1500000 } }));
    expect(step.auto).toBe(true);
    const { records } = runPlan(db, [step]);
    expect(getSetting(db, 'default_monthly_goal')).toBe('1500000');
    expect(getMonthlyGoal(db, '2026-10')).toBe(1000000);
    undoPlan(db, records);
    expect(getSetting(db, 'default_monthly_goal')).toBe('1000000');
    expect(getMonthlyGoal(db, '2026-10')).toBe(null);
  });

  test('카테고리 예산: 기능이 꺼져 있으면 함께 켜고, 되돌리면 함께 끈다', () => {
    const db = makeDb();
    const step = planAction(db, act('budget', { target: { category: '식비' }, changes: { amount: 500000 } }));
    expect(step.lines.join()).toMatch(/선택 기능도 켜요/);
    const { records } = runPlan(db, [step]);
    expect(isCategoryBudgetEnabled(db)).toBe(true);
    expect(db.exec("SELECT amount FROM category_budgets WHERE budget_category = '식비' AND year_month = ''")[0].values[0][0]).toBe(500000);
    undoPlan(db, records);
    expect(isCategoryBudgetEnabled(db)).toBe(false);
    expect(db.exec('SELECT COUNT(*) FROM category_budgets')[0].values[0][0]).toBe(0);
  });

  test('선택 기능: 이미 켜져 있으면 막고, 켜고 되돌린다', () => {
    const db = makeDb();
    const step = planAction(db, act('feature', { setting: { key: 'monthlyReport', value: 'on' } }));
    const { records } = runPlan(db, [step]);
    expect(isMonthlyReportEnabled(db)).toBe(true);
    expect(planAction(db, act('feature', { setting: { key: 'monthlyReport', value: 'on' } })).error).toMatch(/이미 켜져/);
    undoPlan(db, records);
    expect(isMonthlyReportEnabled(db)).toBe(false);
  });

  test('목록에 새 이름 — 있는 이름은 막고, 되돌리면 쓰지 않았을 때만 지운다', () => {
    const db = makeDb();
    expect(planAction(db, act('add_category', { setting: { name: '식비' } })).ok).toBe(false);
    const steps = [
      planAction(db, act('add_category', { setting: { name: '교통' } })),
      planAction(db, act('add_sub_category', { setting: { name: '간식', parent: '식비' } })),
      planAction(db, act('add_payment_method', { setting: { name: '카카오페이' } })),
      planAction(db, act('add_member', { setting: { name: '아빠' } })),
    ];
    expect(steps.every(st => st.ok && st.auto)).toBe(true);
    const { records } = runPlan(db, steps);
    expect(getBudgetCategories(db)).toContain('교통');
    tx(db, { payment_method: '카카오페이' }); // 그사이 쓰기 시작한 것
    expect(undoPlan(db, records)).toEqual({ undone: 3, kept: 1 });
    expect(getBudgetCategories(db)).not.toContain('교통');
    expect(getSubCategories(db, '식비')).not.toContain('간식');
    expect(getPaymentMethods(db)).toContain('카카오페이');
    expect(getMemberNames(db)).not.toContain('아빠');
  });

  test('화면 설정(이 기기)은 DB에 쓰지 않고 바로 바꾼다', () => {
    const db = makeDb();
    const step = planAction(db, act('display', { setting: { key: 'theme', value: 'dark' } }));
    const { records, dbChanged } = runPlan(db, [step]);
    expect(getTheme()).toBe('dark');
    expect(dbChanged).toBe(false);
    undoPlan(db, records);
    expect(getTheme()).toBe('light');
  });

  test('모르는 할 일·화면은 막는다', () => {
    const db = makeDb();
    expect(planAction(db, act('launch_rocket')).ok).toBe(false);
    expect(planAction(db, act('open', { setting: { key: 'nowhere' } })).ok).toBe(false);
    expect(runPlan(db, [planAction(db, act('open', { setting: { key: 'summary' } }))]).open).toBe('summary');
  });
});

describe('계획', () => {
  test('새 거래만 말했으면 말로 입력으로 넘긴다', () => {
    const plan = buildPlan(makeDb(), { actions: [], entries: [{ detail: '김밥', amount: 3000 }], reply: '' }, TODAY);
    expect(plan.addOnly).toBe(true);
  });

  test('할 일과 새 거래를 함께 말하면 둘 다 계획에 — 빈 칸 있는 거래는 막는다', () => {
    const db = makeDb();
    tx(db, {});
    const entry = { date: '', merchant: '이디야', detail: '이디야', amount: 4000, currency: 'KRW', krw_amount: 0, payment_method: '현금', payment_mentioned: true, category: '식비 > 커피' };
    const plan = buildPlan(db, {
      actions: [act('tx_delete', { target: { keyword: '스타벅스' } })],
      entries: [entry, { ...entry, amount: 0 }],
    }, TODAY);
    expect(plan.steps.map(st => [st.kind, st.ok])).toEqual([['tx_delete', true], ['tx_add', true], ['tx_add', false]]);
    expect(plan.auto).toBe(false);
    const { records } = runPlan(db, plan.steps);
    expect(all(db).map(r => r.detail)).toEqual(['이디야']);
    undoPlan(db, records);
    expect(all(db).map(r => r.detail)).toEqual(['스타벅스']);
  });

  test('되돌리기 쉬운 것만 있으면 바로 한다', () => {
    const db = makeDb();
    const plan = buildPlan(db, { actions: [act('feature', { setting: { key: 'taxSummary', value: 'on' } }), act('goal', { changes: { amount: 2000000 } })], entries: [] });
    expect(plan.auto).toBe(true);
    expect(describeRun(plan.steps)).toMatch(/2가지를 했어요/);
  });

  test('중간에 실패하면 모두 되돌린다', () => {
    const db = makeDb();
    tx(db, {});
    const del = planAction(db, act('tx_delete', { target: { keyword: '스타벅스' } }));
    const bad = { ...planAction(db, act('add_member', { setting: { name: '아빠' } })) };
    addMember(db, '아빠'); // 계획 뒤에 다른 곳에서 같은 이름을 넣었다 → 실행 중 오류
    expect(() => runPlan(db, [del, bad])).toThrow();
    expect(all(db)).toHaveLength(1);
  });
});

describe('리뷰 반영 — 그사이 바뀐 것·할인·되돌리기 조건', () => {
  test('계획한 뒤 바뀐 거래는 고치거나 지우지 않는다(다른 기기와 합쳐 다른 거래가 된 번호)', () => {
    const db = makeDb();
    const id = tx(db, {});
    const upd = planAction(db, act('tx_update', { target: { keyword: '스타벅스' }, changes: { detail: '스벅' } }));
    const del = planAction(db, act('tx_delete', { target: { keyword: '스타벅스' } }));
    db.run("UPDATE transactions SET detail = '다른 거래', amount = 9000 WHERE id = ?", [id]);
    const r = runPlan(db, [upd, del]);
    expect(r.skipped).toBe(2);
    expect(all(db)[0]).toMatchObject({ detail: '다른 거래', amount: 9000 });
  });

  test('할인이 있는 거래의 금액은 고치지 않고, 할인 없던 거래는 새 결제수단의 할인 규칙을 따른다', () => {
    const db = makeDb();
    tx(db, { amount: 10000, discount_amount: 1000 });
    expect(planAction(db, act('tx_update', { target: { keyword: '스타벅스' }, changes: { amount: 20000 } })).ok).toBe(false);
    const db2 = makeDb();
    tx(db2, { amount: 10000, payment_method: '현금' });
    db2.run("INSERT INTO payment_method_discount_rules (payment_method_name, budget_category, sub_category, rule_type, value) VALUES ('신한카드', '식비', '', 'percent', 0.1)");
    const step = planAction(db2, act('tx_update', { target: { keyword: '스타벅스' }, changes: { payment_method: '신한카드' } }));
    runPlan(db2, [step]);
    expect(all(db2)[0].discount_amount).toBe(1000);
  });

  test('가장 최근은 오늘까지 중에서 고른다(미리 등록된 앞날짜 거래 말고)', () => {
    const db = makeDb();
    const past = tx(db, { date: '2026-11-05' });
    tx(db, { date: '2026-12-05' });
    expect(findTargetTransactions(db, T({ keyword: '스타벅스', which: 'latest' }), TODAY).rows.map(r => r.id)).toEqual([past]);
  });

  test('선택 기능은 on·off가 아니면 막는다', () => {
    expect(planAction(makeDb(), act('feature', { setting: { key: 'monthlyReport', value: '꺼짐' } })).ok).toBe(false);
  });

  test('되돌리기 전에 직접 바꾼 예산·선택 기능은 그대로 둔다', () => {
    const db = makeDb();
    const steps = [
      planAction(db, act('budget', { target: { category: '식비' }, changes: { amount: 500000 } })),
      planAction(db, act('feature', { setting: { key: 'monthlyReport', value: 'on' } })),
    ];
    const { records } = runPlan(db, steps);
    db.run("UPDATE category_budgets SET amount = 600000 WHERE budget_category = '식비'");
    db.run("UPDATE settings SET value = '0' WHERE key = 'monthly_report_enabled'");
    expect(undoPlan(db, records)).toEqual({ undone: 0, kept: 2 });
    expect(db.exec("SELECT amount FROM category_budgets WHERE budget_category = '식비'")[0].values[0][0]).toBe(600000);
  });

  test('정기지출 고치기를 되돌리면 금액 확인한 날도 그때대로', () => {
    const db = makeDb();
    const id = addRecurringTransaction(db, { payment_method: '신한카드', budget_category: '생활', sub_category: '구독', detail: '넷플릭스', amount: 13500, day_of_month: 5 });
    db.run("UPDATE recurring_transactions SET amount_checked_on = '2026-01-01' WHERE id = ?", [id]);
    const { records } = runPlan(db, [planAction(db, act('recurring_update', { target: { recurring_id: id }, changes: { amount: 17000 } }))]);
    undoPlan(db, records);
    expect(getRecurringTransactions(db)[0]).toMatchObject({ amount: 13500, amount_checked_on: '2026-01-01' });
  });

  test('만든 카테고리 아래에 세부카테고리를 더했으면 되돌리지 않는다', () => {
    const db = makeDb();
    const { records } = runPlan(db, [planAction(db, act('add_category', { setting: { name: '교통' } }))]);
    db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('교통', '버스', 1)");
    expect(undoPlan(db, records)).toEqual({ undone: 0, kept: 1 });
    expect(getBudgetCategories(db)).toContain('교통');
  });

  test('한 문장에서 만든 이름을 바로 쓰면 먼저 만들라고 알린다', () => {
    const plan = buildPlan(makeDb(), { actions: [
      act('add_category', { setting: { name: '반려동물' } }),
      act('budget', { target: { category: '반려동물' }, changes: { amount: 100000 } }),
    ], entries: [] });
    expect(plan.steps[1].error).toMatch(/먼저 만든 뒤 다시 말해 주세요/);
  });
});
