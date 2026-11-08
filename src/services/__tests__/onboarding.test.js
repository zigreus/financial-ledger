/**
 * @vitest-environment node
 */
// 첫 실행 기본값 (ROADMAP F-3, I-019) — 템플릿 내용, 새 가계부 판정, 확정할 때 한 번에 넣기
import initSqlJs from 'sql.js';
import { STARTER_TEMPLATES } from '../../data/starterTemplates';
import {
  createDatabase, addTransaction, addPaymentMethod, addBudgetCategory, setMasterItemHidden,
  isBlankLedger, applyStarterSetup, starterSetupProblems, STARTER_NAME_MAX,
  getBudgetCategories, getSubCategories, getPaymentMethods, getAllPaymentMethods, deletePaymentMethod,
} from '../dbManager';
import { attachChangeLog, getChangeLog, replayChanges } from '../changeLog';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });
const blankDb = () => createDatabase(SQL, null).db;
const rows = (db, sql) => db.exec(sql)[0]?.values || [];

describe('템플릿 내용', () => {
  test('가구 유형 세 가지 — 1인 가구·맞벌이·아이 있는 집', () => {
    expect(STARTER_TEMPLATES.map(t => t.label)).toEqual(['1인 가구', '맞벌이', '아이 있는 집']);
    expect(new Set(STARTER_TEMPLATES.map(t => t.id)).size).toBe(3);
  });

  test.each(STARTER_TEMPLATES.map(t => [t.label, t]))('%s: 그대로 넣을 수 있다 — 이름이 겹치지 않고, 카테고리마다 세부카테고리가 있다', (_, t) => {
    expect(starterSetupProblems(t)).toEqual([]);
    const names = t.categories.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
    t.categories.forEach(c => {
      expect(c.subs.length).toBeGreaterThan(0);
      expect(new Set(c.subs).size).toBe(c.subs.length);
    });
    expect(new Set(t.paymentMethods).size).toBe(t.paymentMethods.length);
    [...names, ...t.categories.flatMap(c => c.subs), ...t.paymentMethods].forEach(n => {
      expect(n).toBe(n.trim());
      expect(n.length).toBeGreaterThan(0);
      expect(n.length).toBeLessThanOrEqual(STARTER_NAME_MAX);
    });
    // 앱이 이름으로 알아보는 결제수단(여행 현금 지갑 등)과 마지막의 기타
    expect(t.paymentMethods).toContain('현금');
    expect(names[names.length - 1]).toBe('기타');
  });

  test('가구 유형마다 차이가 있다 — 아이 있는 집만 육아·교육, 맞벌이는 배우자 용돈', () => {
    const byId = Object.fromEntries(STARTER_TEMPLATES.map(t => [t.id, t.categories.map(c => c.name)]));
    expect(byId.kids).toEqual(expect.arrayContaining(['육아', '교육']));
    expect(byId.single).not.toContain('육아');
    expect(byId.dual).not.toContain('육아');
    const dualAllowance = STARTER_TEMPLATES.find(t => t.id === 'dual').categories.find(c => c.name === '용돈');
    expect(dualAllowance.subs).toContain('배우자 용돈');
  });
});

describe('새 가계부 판정', () => {
  test('카테고리·결제수단·거래가 하나도 없을 때만 새 가계부다 — 숨긴 항목도 있는 것으로 본다', () => {
    expect(isBlankLedger(blankDb())).toBe(true);

    const withPayment = blankDb();
    addPaymentMethod(withPayment, '현금');
    expect(isBlankLedger(withPayment)).toBe(false);

    const withHiddenCategory = blankDb();
    addBudgetCategory(withHiddenCategory, '식비');
    setMasterItemHidden(withHiddenCategory, 'budget_categories', 1, true);
    expect(isBlankLedger(withHiddenCategory)).toBe(false);

    // 짝 없는 세부카테고리만 남은 파일도 비어 있지 않다 — 넣다가 UNIQUE 오류가 나지 않게
    const withOrphanSub = blankDb();
    withOrphanSub.run('INSERT INTO sub_categories (budget_category, name) VALUES (?, ?)', ['식비', '장보기']);
    expect(isBlankLedger(withOrphanSub)).toBe(false);

    // 가져오기 등으로 거래만 있는 경우도 쓰던 가계부다
    const withTx = blankDb();
    addTransaction(withTx, { payment_method: '카드', date: '2026-11-01', budget_category: '식비', sub_category: '', detail: 'x', amount: 1 });
    expect(isBlankLedger(withTx)).toBe(false);
  });
});

describe('확정할 때 한 번에 넣기', () => {
  test('고른 카테고리·세부카테고리·결제수단을 고른 순서대로 넣고 개수를 돌려준다 — 거래 입력 폼에서 바로 고를 수 있다', () => {
    const db = blankDb();
    const t = STARTER_TEMPLATES.find(x => x.id === 'kids');
    const counts = applyStarterSetup(db, t);
    expect(counts).toEqual({
      categories: t.categories.length,
      subCategories: t.categories.reduce((n, c) => n + c.subs.length, 0),
      paymentMethods: t.paymentMethods.length,
    });
    expect(getBudgetCategories(db)).toEqual(t.categories.map(c => c.name));
    t.categories.forEach(c => expect(getSubCategories(db, c.name)).toEqual(c.subs));
    expect(getPaymentMethods(db)).toEqual(t.paymentMethods);
    expect(getAllPaymentMethods(db).map(p => p.sort_order)).toEqual(t.paymentMethods.map((_, i) => i + 1));
    expect(isBlankLedger(db)).toBe(false);
  });

  test('이름 앞뒤 공백은 지우고 같은 이름은 한 번만 넣는다', () => {
    const db = blankDb();
    const counts = applyStarterSetup(db, {
      categories: [{ name: ' 식비 ', subs: ['외식', ' 외식', '배달'] }, { name: '식비', subs: ['장보기'] }],
      paymentMethods: ['현금', ' 현금 ', '신한카드'],
    });
    expect(counts).toEqual({ categories: 1, subCategories: 2, paymentMethods: 2 });
    expect(getSubCategories(db, '식비')).toEqual(['외식', '배달']);
    expect(getPaymentMethods(db)).toEqual(['현금', '신한카드']);
  });

  test('넣을 수 없는 선택은 이유를 알려 주고 아무것도 쓰지 않는다', () => {
    const cases = [
      [{ categories: [], paymentMethods: ['현금'] }, /카테고리를 하나 이상/],
      [{ categories: [{ name: '식비', subs: [] }], paymentMethods: ['현금'] }, /'식비'의 세부카테고리를 하나 이상/],
      [{ categories: [{ name: '식비', subs: ['외식'] }], paymentMethods: [' '] }, /결제수단을 하나 이상/],
      [{ categories: [{ name: '식비', subs: ['외식'] }], paymentMethods: ['가'.repeat(STARTER_NAME_MAX + 1)] }, /자까지/],
    ];
    cases.forEach(([setup, message]) => {
      const db = blankDb();
      attachChangeLog(db);
      expect(() => applyStarterSetup(db, setup)).toThrow(message);
      expect(getChangeLog(db).entries).toHaveLength(0);
      expect(isBlankLedger(db)).toBe(true);
    });
  });

  test('이미 쓰던 가계부에는 넣지 않는다 — 마이그레이션이 아니다', () => {
    const db = blankDb();
    addPaymentMethod(db, '우리 카드');
    expect(() => applyStarterSetup(db, STARTER_TEMPLATES[0])).toThrow(/이미 카테고리·결제수단이나 거래가 있는/);
    expect(getBudgetCategories(db)).toEqual([]);
    expect(getPaymentMethods(db)).toEqual(['우리 카드']);
  });

  test('중간에 실패하면 전부 되돌린다 (하나의 트랜잭션)', () => {
    const db = blankDb();
    attachChangeLog(db);
    const realRun = db.run.bind(db);
    db.run = (sql, params) => {
      if (/INSERT INTO payment_methods/.test(sql)) throw new Error('디스크 오류');
      return realRun(sql, params);
    };
    expect(() => applyStarterSetup(db, STARTER_TEMPLATES[0])).toThrow('디스크 오류');
    db.run = realRun;
    expect(rows(db, 'SELECT COUNT(*) FROM budget_categories')[0][0]).toBe(0);
    expect(rows(db, 'SELECT COUNT(*) FROM sub_categories')[0][0]).toBe(0);
    expect(getChangeLog(db).entries).toHaveLength(0);
  });

  test('넣는 동안만 쓰는 표식은 남지 않는다', () => {
    const db = blankDb();
    applyStarterSetup(db, STARTER_TEMPLATES[0]);
    expect(rows(db, "SELECT COUNT(*) FROM settings WHERE key LIKE 'starter%'")[0][0]).toBe(0);
  });
});

describe('저장이 겹쳐 다른 파일에 다시 실행될 때 — 그 파일이 비어 있을 때만 넣는다', () => {
  /** 이 기기에서 확정한 기록 (변경 기록 그대로) */
  function confirmedOn(bytes, templateId) {
    const db = createDatabase(SQL, bytes).db;
    attachChangeLog(db);
    applyStarterSetup(db, STARTER_TEMPLATES.find(t => t.id === templateId));
    return getChangeLog(db).entries;
  }

  test('두 기기가 동시에 시작하면 먼저 저장한 기본값만 남는다 — 나중 기록은 다시 실행돼도 아무것도 넣지 않는다', () => {
    const blankBytes = blankDb().export();
    const A = createDatabase(SQL, blankBytes).db;
    applyStarterSetup(A, STARTER_TEMPLATES.find(t => t.id === 'single')); // A가 먼저 저장
    const lateEntries = confirmedOn(blankBytes, 'kids');                   // B는 같은 빈 파일에서 확정

    const merged = createDatabase(SQL, A.export()).db;
    const before = getBudgetCategories(merged);
    replayChanges(merged, lateEntries);
    expect(getBudgetCategories(merged)).toEqual(before);
    expect(getBudgetCategories(merged)).not.toContain('육아');
    expect(getPaymentMethods(merged)).toEqual(STARTER_TEMPLATES[0].paymentMethods);
    expect(rows(merged, "SELECT COUNT(*) FROM settings WHERE key LIKE 'starter%'")[0][0]).toBe(0);
  });

  test('오프라인에서 확정해 두었다가, 그 사이 다른 기기가 꾸민 파일에 다시 실행돼도 아무것도 넣지 않는다', () => {
    const blankBytes = blankDb().export();
    const pending = confirmedOn(blankBytes, 'dual');
    // 그 사이 다른 기기가 직접 꾸미고 거래도 적어 저장했다
    const other = createDatabase(SQL, blankBytes).db;
    addPaymentMethod(other, '우리카드');
    addBudgetCategory(other, '생활비');
    addTransaction(other, { payment_method: '우리카드', date: '2026-11-01', budget_category: '생활비', sub_category: '', detail: '마트', amount: 30000 });

    const merged = createDatabase(SQL, other.export()).db;
    replayChanges(merged, pending);
    expect(getBudgetCategories(merged)).toEqual(['생활비']);
    expect(getPaymentMethods(merged)).toEqual(['우리카드']);
    expect(rows(merged, 'SELECT COUNT(*) FROM sub_categories')[0][0]).toBe(0);
  });

  test('오프라인 확정 뒤 설정에서 지우고 숨긴 것도 꾸며진 파일의 같은 번호 행을 건드리지 않는다 (B-091)', () => {
    const blankBytes = blankDb().export();
    const mine = createDatabase(SQL, blankBytes).db;
    attachChangeLog(mine);
    applyStarterSetup(mine, STARTER_TEMPLATES.find(t => t.id === 'single'));
    const transferId = getAllPaymentMethods(mine).find(p => p.name === '계좌이체').id;
    deletePaymentMethod(mine, transferId);                         // 안 쓰는 결제수단 지우기 (id 기준)
    setMasterItemHidden(mine, 'budget_categories', 2, true);       // 주거/통신 숨기기 (id 기준)

    const other = createDatabase(SQL, blankBytes).db;
    ['우리카드', '국민카드', '삼성카드', '토스'].forEach(n => addPaymentMethod(other, n));
    addBudgetCategory(other, '생활비');
    addBudgetCategory(other, '외식');
    const merged = createDatabase(SQL, other.export()).db;
    replayChanges(merged, getChangeLog(mine).entries);
    expect(getPaymentMethods(merged)).toEqual(['우리카드', '국민카드', '삼성카드', '토스']);
    expect(getBudgetCategories(merged)).toEqual(['생활비', '외식']);
  });

  test('다시 실행할 파일이 아직 비어 있으면 그대로 넣는다 (예: 오프라인 확정을 나중에 저장)', () => {
    const blankBytes = blankDb().export();
    const pending = confirmedOn(blankBytes, 'kids');
    const later = createDatabase(SQL, blankBytes).db; // 다른 기기는 손대지 않았지만 파일 버전만 바뀐 경우
    replayChanges(later, pending);
    const t = STARTER_TEMPLATES.find(x => x.id === 'kids');
    expect(getBudgetCategories(later)).toEqual(t.categories.map(c => c.name));
    expect(getSubCategories(later, '육아')).toEqual(t.categories.find(c => c.name === '육아').subs);
    expect(getPaymentMethods(later)).toEqual(t.paymentMethods);
  });
});
