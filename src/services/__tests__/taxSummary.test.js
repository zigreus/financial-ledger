// 연말정산 참고 합계 (I-029, ROADMAP C-10) — 결제수단 유형별·항목별 한 해 결제액(공제액은 계산하지 않음)
import initSqlJs from 'sql.js';
import {
  createDatabase, SCHEMA_VERSION, addTransaction, addPaymentMethod, addBudgetCategory, addSubCategory,
  renameBudgetCategory, renameSubCategory, deleteSubCategory,
  isTaxSummaryEnabled, setTaxSummaryEnabled, setPaymentMethodTaxType, setCategoryTaxTag, setSubCategoryTaxTag,
  getTaxSummary, getTaxClassification, getTaxYears, TAX_TAG_NONE,
} from '../dbManager';
import { attachChangeLog, getChangeLog, replayChanges } from '../changeLog';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

function makeDb() {
  const { db } = createDatabase(SQL, null);
  ['신한카드', '토스체크', '현금', '네이버페이'].forEach(n => addPaymentMethod(db, n));
  ['의료', '교통', '식비', '교육'].forEach(c => addBudgetCategory(db, c));
  addSubCategory(db, '교통', '버스·지하철');
  addSubCategory(db, '교통', '택시');
  addSubCategory(db, '의료', '병원');
  const spend = (date, pm, cat, amount, extra = {}) => addTransaction(db, {
    payment_method: pm, date, budget_category: cat, detail: extra.detail || '', amount, ...extra,
  });
  spend('2026-01-10', '신한카드', '의료', 100000, { sub_category: '병원', discount_amount: 5000 });
  spend('2026-02-10', '토스체크', '교통', 50000, { sub_category: '버스·지하철' });
  spend('2026-02-11', '신한카드', '교통', 30000, { sub_category: '택시' });
  spend('2026-03-10', '현금', '식비', 20000);
  spend('2026-03-11', '네이버페이', '식비', 15000);
  spend('2026-04-01', '신한카드', '식비', -10000);                       // 환불
  spend('2026-05-01', '신한카드', '식비', 200000, { foreign_amounts: { USD: 150 } });   // 해외 결제
  spend('2026-06-01', '토스체크', '교육', 300000);
  spend('2025-12-31', '신한카드', '의료', 999999);                        // 다른 해
  return { db, spend };
}

test('스키마 — 결제수단 유형·카테고리 항목 칸이 생기고 버전이 올랐다', () => {
  const { db } = makeDb();
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
  const cols = t => db.exec(`PRAGMA table_info(${t})`)[0].values.map(r => r[1]);
  expect(cols('payment_methods')).toContain('tax_type');
  expect(cols('budget_categories')).toContain('tax_tag');
  expect(cols('sub_categories')).toContain('tax_tag');
});

test('선택 기능 — 처음에는 꺼져 있다', () => {
  const { db } = makeDb();
  expect(isTaxSummaryEnabled(db)).toBe(false);
  setTaxSummaryEnabled(db, true);
  expect(isTaxSummaryEnabled(db)).toBe(true);
});

test('유형을 정하지 않으면 모두 미정 — 해외 결제는 따로, 환불은 빼서 더한다', () => {
  const { db } = makeDb();
  const s = getTaxSummary(db, '2026');
  expect(s.total).toEqual({ amount: 505000, discount: 5000, count: 7 });
  expect(s.foreign).toEqual({ amount: 200000, count: 1 });
  expect(s.types.find(t => t.key === '')).toMatchObject({ label: '유형 미정', amount: 505000, count: 7 });
  expect(s.untypedMethods).toEqual(['토스체크', '신한카드', '현금', '네이버페이']);
  expect(s.tags).toEqual([]);
  expect(getTaxYears(db)).toEqual(['2026', '2025']);
});

test('결제수단 유형별 합계 — 결제수단마다 나눠 보인다', () => {
  const { db } = makeDb();
  setPaymentMethodTaxType(db, '신한카드', 'credit');
  setPaymentMethodTaxType(db, '토스체크', 'debit');
  setPaymentMethodTaxType(db, '현금', 'cash');
  const s = getTaxSummary(db, '2026');
  const byKey = Object.fromEntries(s.types.map(t => [t.key, [t.amount, t.count]]));
  expect(byKey).toEqual({ credit: [120000, 3], debit: [350000, 2], cash: [20000, 1], other: [0, 0], '': [15000, 1] });
  expect(s.untypedMethods).toEqual(['네이버페이']);
  expect(s.types[0].methods).toEqual([{ name: '신한카드', amount: 120000, count: 3 }]);
  expect(() => setPaymentMethodTaxType(db, '신한카드', 'bogus')).toThrow();
  setPaymentMethodTaxType(db, '신한카드', '');
  expect(getTaxSummary(db, '2026').untypedMethods).toContain('신한카드');
});

test('항목별 합계 — 세부카테고리가 먼저, 비우면 카테고리를 따르고, 해당 없음은 뺀다', () => {
  const { db } = makeDb();
  setCategoryTaxTag(db, '의료', '의료비');
  setCategoryTaxTag(db, '교통', '대중교통');
  setSubCategoryTaxTag(db, '교통', '택시', TAX_TAG_NONE);
  setCategoryTaxTag(db, '교육', '교육비');
  const s = getTaxSummary(db, '2026');
  expect(s.tags.map(g => [g.tag, g.amount, g.count])).toEqual([
    ['의료비', 100000, 1], ['교육비', 300000, 1], ['대중교통', 50000, 1],
  ]);
  expect(s.tags[0].parts).toEqual([{ category: '의료', sub: '병원', amount: 100000, count: 1 }]);
  setSubCategoryTaxTag(db, '교통', '택시', '');                            // 다시 카테고리를 따른다
  expect(getTaxSummary(db, '2026').tags.find(g => g.tag === '대중교통').amount).toBe(80000);
  expect(() => setCategoryTaxTag(db, '의료', '아무거나')).toThrow();
});

test('이름을 바꾸면 항목이 따라가고, 세부카테고리를 지우면 함께 없어진다', () => {
  const { db } = makeDb();
  setCategoryTaxTag(db, '의료', '의료비');
  setSubCategoryTaxTag(db, '교통', '버스·지하철', '대중교통');
  renameBudgetCategory(db, '의료', '병원비');
  renameSubCategory(db, '교통', '버스·지하철', '대중교통');
  const c = getTaxClassification(db);
  expect(c.categories.find(x => x.name === '병원비').taxTag).toBe('의료비');
  expect(c.categories.find(x => x.name === '교통').subs.find(x => x.name === '대중교통').taxTag).toBe('대중교통');
  expect(getTaxSummary(db, '2026').tags.map(g => [g.tag, g.amount])).toEqual([['의료비', 100000], ['대중교통', 50000]]);
  deleteSubCategory(db, '교통', '대중교통');                               // 거래는 세부카테고리가 비고 카테고리(항목 없음)를 따른다
  expect(getTaxSummary(db, '2026').tags.map(g => g.tag)).toEqual(['의료비']);
});

test('환차손익 조정·원화만 적힌 일정 거래·오늘 뒤 예정 거래 — 조정은 빼고, 원화는 국내로, 예정은 따로', () => {
  const { db, spend } = makeDb();
  spend('2026-07-01', '현금', '식비', 0, { discount_amount: 7000, is_cash_adjustment: true, detail: '환전 차익' });
  spend('2026-07-02', '현금', '식비', 4000, { is_cash_adjustment: true, detail: '환전 차손' });
  spend('2026-07-03', '신한카드', '식비', 30000, { foreign_amounts: { KRW: 30000 } });   // 국내 일정
  spend('2026-07-04', '신한카드', '식비', 10000, { foreign_amounts: { USD: 0 } });       // 0인 외화는 외화가 아니다
  spend('2026-12-25', '신한카드', '식비', 50000);                                       // 미리 등록된 정기지출
  spend('2027-01-05', '신한카드', '식비', 50000);
  const s = getTaxSummary(db, '2026', '2026-11-15');
  expect(s.total).toEqual({ amount: 505000 + 40000, discount: 5000, count: 9 });
  expect(s.foreign).toEqual({ amount: 200000, count: 1 });
  expect(s.upcoming).toEqual({ amount: 50000, count: 1 });
  expect(getTaxYears(db, '2026-11-15')).toEqual(['2026', '2025']);       // 미리 등록된 내년은 아직 고를 수 없다
});

test('목록에 없는 결제수단은 따로 알리고, 이 해에 쓴 카테고리를 돌려준다(숨겼어도 분류할 수 있게)', () => {
  const { db, spend } = makeDb();
  spend('2026-08-01', '삼성카드', '의료', 20000);                          // 다른 기기가 지운 사이 쓴 결제수단
  const s = getTaxSummary(db, '2026', '2026-11-15');
  expect(s.missingMethods).toEqual(['삼성카드']);
  expect(s.untypedMethods).not.toContain('삼성카드');
  expect(s.usedCategories.sort()).toEqual(['교육', '교통', '식비', '의료']);
});

test('항목 합계에 카드·현금영수증이 아닌 결제가 얼마나 섞였는지', () => {
  const { db } = makeDb();
  setCategoryTaxTag(db, '교통', '대중교통');
  setPaymentMethodTaxType(db, '토스체크', 'debit');
  setPaymentMethodTaxType(db, '신한카드', 'credit');
  expect(getTaxSummary(db, '2026', '2026-11-15').tags[0]).toMatchObject({ tag: '대중교통', amount: 80000, notCard: 0 });
  setPaymentMethodTaxType(db, '신한카드', 'cash');
  expect(getTaxSummary(db, '2026', '2026-11-15').tags[0]).toMatchObject({ amount: 80000, notCard: 30000 });
});

test('예전 버전(v6) 파일을 열면 칸이 생기고 한 번만 다시 저장한다', () => {
  const { db } = makeDb();
  ['payment_methods', 'budget_categories', 'sub_categories'].forEach(t => db.run(`ALTER TABLE ${t} DROP COLUMN ${t === 'payment_methods' ? 'tax_type' : 'tax_tag'}`));
  db.run('PRAGMA user_version = 6');
  const reopened = createDatabase(SQL, db.export());
  expect(reopened.didMigrate).toBe(true);
  expect(reopened.migrationErrors).toEqual([]);
  expect(getTaxSummary(reopened.db, '2026', '2026-11-15').total.amount).toBe(505000);
  expect(createDatabase(SQL, reopened.db.export()).didMigrate).toBe(false);
});

test('병합 — 이름으로 정하므로 다른 기기가 같은 이름의 결제수단을 먼저 만들어도 맞게 들어간다', () => {
  const { db } = createDatabase(SQL, null);
  const bytes = db.export();
  const mine = createDatabase(SQL, bytes).db;
  attachChangeLog(mine);
  addPaymentMethod(mine, '우리카드');
  setPaymentMethodTaxType(mine, '우리카드', 'credit');
  addBudgetCategory(mine, '병원');
  setCategoryTaxTag(mine, '병원', '의료비');
  const remote = createDatabase(SQL, bytes).db;
  addPaymentMethod(remote, '토스');
  addPaymentMethod(remote, '우리카드');                                   // 같은 이름을 먼저 만들었다
  replayChanges(remote, getChangeLog(mine).entries);
  const c = getTaxClassification(remote);
  expect(c.methods.map(m => [m.name, m.taxType])).toEqual([['토스', ''], ['우리카드', 'credit']]);
  expect(c.categories.find(x => x.name === '병원').taxTag).toBe('의료비');
});
