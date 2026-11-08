/**
 * @vitest-environment node
 */
// 카드 내역 대조 — 일치·묶음 일치(나눠 적음/합쳐 적음)·금액 차이·누락 추가 (B-062, B-063)
import initSqlJs from 'sql.js';
import {
  createDatabase, addTransaction, updateTransaction, deleteTransaction, getTransactions, addCalendarEvent, addEventCountry, setSetting,
} from '../dbManager';
import {
  normalizeStatement, reconcileStatement, addMissingRows, txWithAmount, buildStatementPrompt, REFUND_LOOKBACK,
} from '../cardStatement';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const TODAY = '2026-11-08';
const CARD = '신한카드';

function makeDb() {
  const { db } = createDatabase(SQL, null);
  db.run(`INSERT INTO payment_methods (name) VALUES ('현금'),('카카오페이'),('${CARD}')`);
  db.run("INSERT INTO budget_categories (name) VALUES ('식비'),('쇼핑'),('여행')");
  db.run(`INSERT INTO sub_categories (budget_category, name) VALUES
    ('식비','점심'),('식비','커피'),('쇼핑','생활용품'),('여행','식비')`);
  return db;
}
const add = (db, o) => addTransaction(db, {
  payment_method: CARD, budget_category: '식비', sub_category: '점심', ...o,
});
const row = (date, merchant, amount, extra = {}) => ({
  date, merchant, amount, is_cancel: amount < 0, currency: 'KRW', foreign_amount: 0,
  installment: '', category: '모름', detail: merchant, ...extra,
});
const run = (db, rows) => reconcileStatement(db, {
  paymentMethod: CARD,
  ...normalizeStatement({ period_from: '2026-11-01', period_to: '2026-11-07', rows }, TODAY),
});
const names = list => list.map(m => m.row.merchant);

test('일부만 적었으면 없는 건만 "가계부에 없음"으로 나온다', () => {
  const db = makeDb();
  add(db, { date: '2026-11-02', detail: '김밥천국', amount: 8000 });
  add(db, { date: '2026-11-03', detail: '맘스터치', amount: 9900 });
  const r = run(db, [
    row('2026-11-02', '김밥천국', 8000),
    row('2026-11-03', '맘스터치', 9900),
    row('2026-11-04', '스타벅스', 4500),
    row('2026-11-06', 'GS25', 3200),
  ]);
  expect(names(r.matched)).toEqual(['김밥천국', '맘스터치']);
  expect(names(r.missing).sort()).toEqual(['GS25', '스타벅스']);
  expect(r.notOnCard).toEqual([]);
});

test('나눠 적음: 카드 1건 = 가계부 여러 건이면 일치 — 금액 차이·카드에 없음으로 잡지 않는다', () => {
  const db = makeDb();
  add(db, { date: '2026-11-05', detail: '이마트 장보기', amount: 30000 });
  add(db, { date: '2026-11-05', detail: '이마트 휴지', amount: 20000, budget_category: '쇼핑', sub_category: '생활용품' });
  const r = run(db, [row('2026-11-05', '(주)이마트 성수점', 50000)]);
  expect(r.grouped).toHaveLength(1);
  expect(r.grouped[0].kind).toBe('split');
  expect(r.grouped[0].txs.map(t => t.amount).sort()).toEqual([20000, 30000]);
  expect(r.mismatched).toEqual([]);
  expect(r.notOnCard).toEqual([]);
  expect(r.missing).toEqual([]);
});

test('합쳐 적음: 카드 여러 건 = 가계부 1건이면 일치', () => {
  const db = makeDb();
  add(db, { date: '2026-11-04', detail: '스타벅스', amount: 9000, sub_category: '커피' });
  const r = run(db, [
    row('2026-11-04', '스타벅스코리아', 4500),
    row('2026-11-04', '스타벅스코리아', 4500),
  ]);
  expect(r.grouped).toHaveLength(1);
  expect(r.grouped[0].kind).toBe('merged');
  expect(r.grouped[0].rows).toHaveLength(2);
  expect(r.missing).toEqual([]);
  expect(r.notOnCard).toEqual([]);
});

test('가게가 다르면 합이 맞아도 묶지 않는다 (아무 금액이나 더해 맞추는 오탐 방지)', () => {
  const db = makeDb();
  add(db, { date: '2026-11-05', detail: '이마트', amount: 30000 });
  add(db, { date: '2026-11-05', detail: '교보문고', amount: 20000, budget_category: '쇼핑', sub_category: '생활용품' });
  const r = run(db, [row('2026-11-05', '이마트', 50000)]);
  expect(r.grouped).toEqual([]);
  expect(r.mismatched).toHaveLength(1);                  // 이마트 30,000 ↔ 50,000
  expect(r.mismatched[0].txs.map(t => t.detail)).toEqual(['이마트']);
  expect(r.notOnCard.map(t => t.detail)).toEqual(['교보문고']);
});

test('가게 이름 비교: 법인 표기·설명이 붙어도 같은 곳, 앞 2글자만 같은 다른 가게는 다른 곳', () => {
  const db = makeDb();
  add(db, { date: '2026-11-02', detail: '쿠팡 휴지', amount: 12000 });
  add(db, { date: '2026-11-02', detail: '쿠팡 세제', amount: 8000 });
  add(db, { date: '2026-11-03', detail: '스타필드 주차', amount: 3000 });
  add(db, { date: '2026-11-03', detail: '스타필드 식당', amount: 2000 });
  add(db, { date: '2026-11-04', detail: '롯데리아', amount: 9000 });
  const r = run(db, [
    row('2026-11-02', '쿠팡(주)', 20000),       // 나눠 적음으로 인정
    row('2026-11-03', '스타벅스', 5000),        // 스타필드 2건 합과 같지만 다른 가게
    row('2026-11-04', '롯데마트', 7000),        // 롯데리아와 다른 가게 → 금액 차이로 엮지 않음
  ]);
  expect(r.grouped.map(g => g.rows[0].merchant)).toEqual(['쿠팡(주)']);
  expect(r.mismatched).toEqual([]);
  expect(names(r.missing).sort()).toEqual(['롯데마트', '스타벅스']);
  expect(r.notOnCard.map(t => t.detail).sort()).toEqual(['롯데리아', '스타필드 식당', '스타필드 주차']);
});

test('같은 가게 기록이 카드보다 많으면 합이 맞는 만큼만 묶고 남는 건 "카드에 없음", 하루 넘게 떨어지면 묶지 않는다', () => {
  const db = makeDb();
  // 6건(6,000원) 대 카드 5,000원 — 5건은 이 결제, 남는 1건은 카드에 없는 기록으로 보여 준다
  for (let i = 0; i < 6; i += 1) add(db, { date: '2026-11-05', detail: '다이소', amount: 1000 });
  add(db, { date: '2026-11-01', detail: '올리브영', amount: 7000 });
  add(db, { date: '2026-11-04', detail: '올리브영', amount: 3000 });
  const r = run(db, [row('2026-11-05', '다이소', 5000), row('2026-11-04', '올리브영', 10000)]);
  expect(r.grouped.map(g => [g.rows[0].merchant, g.txs.length])).toEqual([['다이소', 5]]);
  expect(r.notOnCard.map(t => t.detail).sort()).toEqual(['다이소', '올리브영']);   // 올리브영 7,000은 사흘 전
  expect(r.mismatched.map(m => [m.rows[0].merchant, m.txs.length])).toEqual([['올리브영', 1]]);
});

test('5건 이상 나눠 적어도 합계가 같으면 일치 — "금액 차이 5,000원 → 5,000원"이 나오지 않는다', () => {
  const db = makeDb();
  for (let i = 0; i < 5; i += 1) add(db, { date: '2026-11-05', detail: '다이소', amount: 1000 });
  const r = run(db, [row('2026-11-05', '다이소', 5000)]);
  expect(r.mismatched).toEqual([]);
  expect(r.grouped).toHaveLength(1);
  expect(r.grouped[0]).toMatchObject({ kind: 'split' });
  expect(r.grouped[0].txs).toHaveLength(5);
  expect(r.notOnCard).toEqual([]);
});

test('같은 가게 여러 건인데 합이 다르면 금액 차이로 묶어 보여주고, 한 건만 고치게 하지 않는다', () => {
  const db = makeDb();
  add(db, { date: '2026-11-05', detail: '이마트', amount: 30000 });
  add(db, { date: '2026-11-05', detail: '이마트', amount: 15000, budget_category: '쇼핑', sub_category: '생활용품' });
  const r = run(db, [row('2026-11-05', '이마트', 50000)]);
  expect(r.mismatched).toHaveLength(1);
  expect(r.mismatched[0]).toMatchObject({ cardTotal: 50000, ledgerTotal: 45000 });
  expect(r.mismatched[0].txs).toHaveLength(2);           // 화면은 txs가 1건일 때만 자동 수정 버튼을 보여준다
  expect(r.notOnCard).toEqual([]);
});

test('청구할인 적용 금액(amount - discount)으로도 묶음을 인정한다', () => {
  const db = makeDb();
  add(db, { date: '2026-11-03', detail: '쿠팡', amount: 20000, discount_amount: 1000, budget_category: '쇼핑', sub_category: '생활용품' });
  add(db, { date: '2026-11-03', detail: '쿠팡', amount: 11000, discount_amount: 1000, budget_category: '쇼핑', sub_category: '생활용품' });
  const r = run(db, [row('2026-11-03', '쿠팡', 29000)]);
  expect(r.grouped).toHaveLength(1);
});

test('정확히 같은 금액 1:1 짝이 묶음보다 먼저다', () => {
  const db = makeDb();
  add(db, { date: '2026-11-05', detail: '이마트', amount: 50000 });
  add(db, { date: '2026-11-05', detail: '이마트', amount: 30000 });
  add(db, { date: '2026-11-05', detail: '이마트', amount: 20000 });
  const r = run(db, [row('2026-11-05', '이마트', 50000), row('2026-11-05', '이마트', 50000)]);
  expect(r.matched).toHaveLength(1);
  expect(r.grouped).toHaveLength(1);
  expect(r.grouped[0].kind).toBe('split');
});

test('승인·취소 짝, 외화 결제 추천은 그대로', () => {
  const db = makeDb();
  const ev = addCalendarEvent(db, { title: '일본 도쿄', date_from: '2026-11-01', date_to: '2026-11-07', event_type: 'trip' });
  addEventCountry(db, ev, '일본', 'JPY', 8.78);
  setSetting(db, 'trip_default_category', '여행');
  add(db, { date: '2026-11-03', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
  const r = run(db, [
    row('2026-11-03', '쿠팡', 30000),
    row('2026-11-04', '쿠팡', -30000),
    row('2026-11-03', 'ICHIRAN', 10536, { currency: 'JPY', foreign_amount: 1200, category: '여행 > 식비' }),
  ]);
  expect(r.cancelled).toHaveLength(1);
  expect(r.cancelled[0].tx.detail).toBe('쿠팡');
  expect(r.missing).toHaveLength(1);
  expect(r.missing[0].suggestion).toMatchObject({ event_id: ev, foreignAmount: 1200, budget_category: '여행', sub_category: '식비' });
});

test('취소된 결제는 같은 가게 거래만 삭제를 권한다 — 금액만 같은 다른 가게 거래는 "카드에 없음"', () => {
  const db = makeDb();
  add(db, { date: '2026-11-03', detail: '올리브영', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
  const r = run(db, [row('2026-11-03', '쿠팡', 30000), row('2026-11-04', '쿠팡', -30000)]);
  expect(r.cancelled).toHaveLength(1);
  expect(r.cancelled[0].tx).toBeNull();                   // 화면은 tx가 있을 때만 "가계부에서 삭제"를 보여준다
  expect(r.matched).toEqual([]);
  expect(r.notOnCard.map(t => t.detail)).toEqual(['올리브영']);
});

describe('짝짓는 순서 — 다른 가게 같은 금액 건이 같은 가게 기록을 가져가지 않는다', () => {
  const splitEmart = (db) => {
    add(db, { date: '2026-11-05', detail: '이마트 장보기', amount: 30000 });
    add(db, { date: '2026-11-05', detail: '이마트 휴지', amount: 20000, budget_category: '쇼핑', sub_category: '생활용품' });
  };

  test('나눠 적은 한 몫을 다른 가게 카드 건이 가져가지 않는다 — 안 적은 건은 "가계부에 없음"', () => {
    const db = makeDb();
    splitEmart(db);
    const r = run(db, [row('2026-11-05', '이마트', 50000), row('2026-11-06', '교보문고', 20000)]);
    expect(r.grouped.map(g => [g.kind, g.rows[0].merchant, g.txs.length])).toEqual([['split', '이마트', 2]]);
    expect(r.matched).toEqual([]);
    expect(r.mismatched).toEqual([]);                      // 예전: 이마트 30,000 → 50,000 수정 버튼 (누르면 70,000)
    expect(names(r.missing)).toEqual(['교보문고']);
  });

  test('하루 차이 같은 가게 짝이 같은 날 다른 가게 짝보다 먼저다', () => {
    const db = makeDb();
    splitEmart(db);
    add(db, { date: '2026-11-04', detail: '올리브영', amount: 20000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = run(db, [row('2026-11-05', '(주)이마트 성수점', 50000), row('2026-11-05', '올리브영 성수', 20000)]);
    expect(r.matched.map(m => m.tx.detail)).toEqual(['올리브영']);
    expect(r.grouped).toHaveLength(1);
    expect(r.mismatched).toEqual([]);
    expect(r.notOnCard).toEqual([]);
  });

  test('합이 안 맞아도 같은 가게 기록은 남겨 둬, 남은 한 건에만 수정 버튼이 붙지 않는다', () => {
    const db = makeDb();
    splitEmart(db);
    const r = run(db, [row('2026-11-05', '이마트', 45000), row('2026-11-05', '교보문고', 20000)]);
    expect(r.matched).toEqual([]);
    expect(r.mismatched).toHaveLength(1);
    expect(r.mismatched[0]).toMatchObject({ cardTotal: 45000, ledgerTotal: 50000 });
    expect(r.mismatched[0].txs).toHaveLength(2);           // 가계부 여러 건 → 자동 수정 없음
    expect(names(r.missing)).toEqual(['교보문고']);
  });
});

describe('같은 가게 카드 여러 건 — 첫 카드 건이 가계부 건을 모두 가져가지 않는다', () => {
  const pairsOf = r => r.mismatched.map(m => [m.rows.map(x => x.amount), m.txs.map(t => t.amount)]);

  test('이틀 연속 같은 가게: 날마다 1:1 금액 차이 (가계부에 없음으로 빠져 중복 추가되지 않게)', () => {
    const db = makeDb();
    add(db, { date: '2026-11-05', detail: '이마트', amount: 48000 });
    add(db, { date: '2026-11-06', detail: '이마트', amount: 13000 });
    const r = run(db, [row('2026-11-05', '이마트', 50000), row('2026-11-06', '이마트', 12000)]);
    expect(pairsOf(r)).toEqual([[[50000], [48000]], [[12000], [13000]]]);
    expect(r.missing).toEqual([]);
    expect(r.notOnCard).toEqual([]);
  });

  test('같은 날 두 번: 금액이 가까운 것끼리 1:1', () => {
    const db = makeDb();
    add(db, { date: '2026-11-04', detail: '스타벅스', amount: 4600, sub_category: '커피' });
    add(db, { date: '2026-11-04', detail: '스타벅스', amount: 5100, sub_category: '커피' });
    const r = run(db, [row('2026-11-04', '스타벅스', 4500), row('2026-11-04', '스타벅스', 5000)]);
    expect(pairsOf(r)).toEqual([[[4500], [4600]], [[5000], [5100]]]);
    expect(r.missing).toEqual([]);
  });

  test('카드 2건·가계부 2건의 합계가 같으면 나눠·합쳐 적은 것으로 일치 (데이터는 고치지 않는다)', () => {
    const db = makeDb();
    add(db, { date: '2026-11-05', detail: '이마트 장보기', amount: 35000 });
    add(db, { date: '2026-11-05', detail: '이마트 휴지', amount: 15000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = run(db, [row('2026-11-05', '이마트', 30000), row('2026-11-05', '이마트', 20000)]);
    expect(r.grouped.map(g => [g.kind, g.rows.length, g.txs.length])).toEqual([['mixed', 2, 2]]);
    expect(r.mismatched).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  test('1:1로 나누고 남은 가계부 건은 가까운 짝에 붙여, 나눠 적은 한 몫에만 수정 버튼이 붙지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-05', detail: '이마트', amount: 30000 });
    add(db, { date: '2026-11-05', detail: '이마트', amount: 18000 });
    add(db, { date: '2026-11-06', detail: '이마트', amount: 13000 });
    const r = run(db, [row('2026-11-05', '이마트', 50000), row('2026-11-06', '이마트', 12000)]);
    expect(pairsOf(r)).toEqual([[[50000], [30000, 18000]], [[12000], [13000]]]);
    expect(r.missing).toEqual([]);
    expect(r.notOnCard).toEqual([]);
  });

  test('카드 여러 건을 1건으로 합쳐 적었는데 합이 다르면 카드 합계로 고칠 수 있다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-04', detail: '스타벅스', amount: 9500, sub_category: '커피' });
    const rows = [row('2026-11-04', '스타벅스', 4500), row('2026-11-04', '스타벅스', 4500)];
    const r = run(db, rows);
    expect(r.mismatched).toHaveLength(1);
    expect(r.mismatched[0]).toMatchObject({ cardTotal: 9000, ledgerTotal: 9500 });
    expect(r.mismatched[0].txs).toHaveLength(1);
    expect(r.missing).toEqual([]);
    // 화면의 "카드 합계로 수정"과 같은 동작
    const [tx] = r.mismatched[0].txs;
    updateTransaction(db, tx.id, txWithAmount(tx, r.mismatched[0].cardTotal));
    const again = run(db, rows);
    expect(again.mismatched).toEqual([]);
    expect(again.grouped.map(g => g.kind)).toEqual(['merged']);
  });
});

describe('가게 이름 비교', () => {
  const one = (ledgerDetail, cardMerchant) => {
    const db = makeDb();
    add(db, { date: '2026-11-05', detail: ledgerDetail, amount: 10000 });
    return run(db, [row('2026-11-05', cardMerchant, 12000)]);
  };

  test('가운데·뒤만 같은 다른 백화점에 "카드 금액으로 수정"을 붙이지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-05', detail: '롯데백화점', amount: 79000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = run(db, [row('2026-11-05', '현대백화점 판교점', 120000), row('2026-11-05', '롯데백화점 본점', 80000)]);
    expect(r.mismatched.map(m => [m.rows[0].merchant, m.txs[0].detail])).toEqual([['롯데백화점 본점', '롯데백화점']]);
    expect(names(r.missing)).toEqual(['현대백화점 판교점']);
  });

  test.each([
    ['롯데백화점', '현대백화점'],
    ['SK 사랑주유소', 'GS칼텍스 행복주유소'],
    ['서울치과의원', '밝은치과의원'],
    ['카카오페이 송금', '카카오T 택시'],
    ['네이버웹툰', '네이버페이 OO몰'],
    ['이마트24편의점', 'CU편의점'],
    ['www.11st.co.kr', 'www.coupang.com'],
    ['스타필드', '스타벅스'],
    ['롯데 시네마', '롯데백화점 본점'],                        // 두 글자 첫 단어 규칙은 첫 단어가 똑같을 때만
  ])('다른 가게: 가계부 "%s" ↔ 카드 "%s"', (ledgerDetail, cardMerchant) => {
    const r = one(ledgerDetail, cardMerchant);
    expect(r.mismatched).toEqual([]);
    expect(names(r.missing)).toEqual([cardMerchant]);
  });

  test.each([
    ['스타벅스', '스타벅스 강남점'],
    ['이마트 장보기', '(주)이마트 성수점'],
    ['쿠팡 휴지', '쿠팡(주)'],
    ['무신사 셔츠', '네이버페이 무신사'],
    ['coupang', 'WWW.COUPANG.COM'],
    ['카카오페이 송금', '카카오페이'],
  ])('같은 가게: 가계부 "%s" ↔ 카드 "%s"', (ledgerDetail, cardMerchant) => {
    const r = one(ledgerDetail, cardMerchant);
    expect(r.mismatched.map(m => m.txs.map(t => t.detail))).toEqual([[ledgerDetail]]);
    expect(r.missing).toEqual([]);
  });
});

test('성능: 카드 행×가계부 거래마다 DB를 다시 읽지 않는다 (렌더 중에 계산된다)', () => {
  const db = makeDb();
  const rows = [];
  for (let d = 1; d <= 7; d += 1) {
    for (let i = 0; i < 10; i += 1) {
      add(db, { date: `2026-11-0${d}`, detail: `가게${i}`, amount: 1000 + i * 100 });
      rows.push(row(`2026-11-0${d}`, `가게${i}`, 1000 + i * 100 + (i % 2 ? 50 : 0)));   // 절반은 금액 차이
    }
  }
  const exec = vi.spyOn(db, 'exec');
  const r = run(db, rows);
  expect(r.matched).toHaveLength(35);
  expect(r.mismatched).toHaveLength(35);
  expect(exec).toHaveBeenCalledTimes(2);                   // 이 결제수단·다른 결제수단의 기간 거래를 한 번씩만 읽는다
});

test('여러 건 추가는 한 묶음 — 하나라도 실패하면 아무것도 들어가지 않는다', () => {
  const db = makeDb();
  const r = run(db, [row('2026-11-04', '스타벅스', 4500), row('2026-11-06', 'GS25', 3200)]);
  const picks = r.missing.map(m => ({ suggestion: m.suggestion, budget_category: '식비', sub_category: '커피' }));

  const broken = [picks[0], { ...picks[1], suggestion: { ...picks[1].suggestion, amount: null } }]; // NOT NULL 위반
  expect(() => addMissingRows(db, broken)).toThrow();
  expect(getTransactions(db, { payment_method: CARD })).toHaveLength(0);

  expect(addMissingRows(db, picks)).toBe(2);
  expect(getTransactions(db, { payment_method: CARD }).map(t => t.sub_category)).toEqual(['커피', '커피']);
  const again = run(db, [row('2026-11-04', '스타벅스', 4500), row('2026-11-06', 'GS25', 3200)]);
  expect(again.missing).toEqual([]);
  expect(again.matched).toHaveLength(2);
});

// ── 2차 리뷰 (T1~T15) ─────────────────────────────────────────────

const runIn = (db, rows, from, to) => reconcileStatement(db, {
  paymentMethod: CARD,
  ...normalizeStatement({ period_from: from, period_to: to, rows }, TODAY),
});
const ledgerSum = db => getTransactions(db, { payment_method: CARD }).reduce((s, t) => s + t.amount, 0);
/** 화면이 권하는 버튼을 모두 누른다 — 수정 버튼(가계부 1건), 미리 체크된 "가계부에 없음", 취소 결제 삭제 */
function pressRecommended(db, r) {
  r.mismatched.filter(m => m.fixable)
    .forEach(m => updateTransaction(db, m.txs[0].id, txWithAmount(m.txs[0], m.cardTotal)));
  const picks = r.missing.filter(m => m.autoCheck)
    .map(m => ({ suggestion: m.suggestion, budget_category: '식비', sub_category: '점심' }));
  if (picks.length) addMissingRows(db, picks);
  r.cancelled.filter(c => c.tx).forEach(c => deleteTransaction(db, c.tx.id));
}
const suggests = r => r.mismatched.some(m => m.fixable) || r.missing.some(m => m.autoCheck) || r.cancelled.some(c => c.tx);

describe('같은 가게 덩어리 — 다른 가게 건이 카드 건을 가져가지 않고, 크기와 상관없이 합계를 본다', () => {
  test('합쳐 적은 카드 건 하나를 다른 가게 같은 금액 기록이 가져가지 않는다 → 카드 합계로 수정', () => {
    const db = makeDb();
    add(db, { date: '2026-11-05', detail: '이마트', amount: 52000 });       // 카드 30,000 + 20,000을 1건으로 (오타)
    add(db, { date: '2026-11-06', detail: '교보문고', amount: 20000 });     // 이 카드 내역에는 없음
    const rows = [row('2026-11-05', '이마트', 30000), row('2026-11-05', '이마트', 20000)];
    const r = run(db, rows);
    expect(r.matched).toEqual([]);                                         // 예전: 이마트 20,000 ↔ 교보문고
    expect(r.mismatched.map(m => [m.rows.length, m.txs.length, m.cardTotal])).toEqual([[2, 1, 50000]]);
    expect(r.notOnCard.map(t => t.detail)).toEqual(['교보문고']);
    pressRecommended(db, r);
    const again = run(db, rows);
    expect(again.grouped.map(g => g.kind)).toEqual(['merged']);
    expect(ledgerSum(db)).toBe(70000);                                     // 이마트 50,000 + 교보문고 20,000
  });

  test('1:1 금액 차이 짝의 카드 건도 다른 가게 기록이 가져가지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-05', detail: '스타벅스', amount: 4600, sub_category: '커피' });
    add(db, { date: '2026-11-05', detail: '스타벅스', amount: 5100, sub_category: '커피' });
    add(db, { date: '2026-11-06', detail: '이디야', amount: 5000, sub_category: '커피' });
    const r = run(db, [row('2026-11-05', '스타벅스', 4500), row('2026-11-05', '스타벅스', 5000)]);
    expect(r.mismatched.map(m => [m.rows[0].amount, m.txs[0].amount])).toEqual([[4500, 4600], [5000, 5100]]);
    expect(r.notOnCard.map(t => t.detail)).toEqual(['이디야']);
  });

  test('카드 2건 · 가계부 10건(품목별)의 합계가 같으면 묶음 — 한 몫에 수정 버튼을 붙이지 않는다', () => {
    const db = makeDb();
    for (let i = 0; i < 10; i += 1) add(db, { date: '2026-11-05', detail: '이마트', amount: 5100 });
    const r = run(db, [row('2026-11-05', '이마트', 25000), row('2026-11-05', '이마트', 26000)]);
    expect(r.grouped.map(g => [g.kind, g.rows.length, g.txs.length])).toEqual([['mixed', 2, 10]]);
    expect(r.mismatched).toEqual([]);
  });

  test('합이 다른 큰 덩어리: 남는 기록은 모자란 짝에만 붙이고, 가계부 여러 건 짝에는 수정 버튼이 없다', () => {
    const db = makeDb();
    [12000, 8000, 7000, 9000, 6000, 10000].forEach(a => add(db, { date: '2026-11-05', detail: '코스트코', amount: a }));
    const r = run(db, [row('2026-11-05', '코스트코 양재점', 40000), row('2026-11-05', '코스트코 양재점', 13000)]);
    expect(r.mismatched.filter(m => m.txs.length === 1)).toEqual([]);     // 한 몫만 고치는 버튼 없음
    expect(r.notOnCard).toEqual([]);
    expect(r.missing).toEqual([]);

    const db2 = makeDb();
    for (let i = 0; i < 10; i += 1) add(db2, { date: '2026-11-05', detail: '이마트', amount: 5100 });
    add(db2, { date: '2026-11-05', detail: '이마트', amount: 1000 });
    const r2 = run(db2, [row('2026-11-05', '이마트', 25000), row('2026-11-05', '이마트', 26000)]);
    expect(r2.mismatched.filter(m => m.txs.length === 1)).toEqual([]);
  });

  test('SIMILAR 기록이 빠진 채 "합계로 수정"이 붙지 않는다 — 남는 카드 건은 "비슷한 기록 있음"으로 미리 체크하지 않음', () => {
    const db = makeDb();
    add(db, { date: '2026-11-05', detail: '이마트', amount: 31000 });
    add(db, { date: '2026-11-05', detail: '이마트장보기', amount: 18000 });
    const r = run(db, [row('2026-11-04', '이마트성수점', 30000), row('2026-11-05', '이마트성수점', 20000)]);
    expect(r.mismatched.map(m => [m.rows.map(x => x.amount), m.txs.map(t => t.amount)])).toEqual([[[30000], [31000]]]);
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]).toMatchObject({ autoCheck: false, cautions: ['similar'] });
    expect(r.missing[0].similarTx.detail).toBe('이마트장보기');
    pressRecommended(db, r);
    expect(ledgerSum(db)).toBe(48000);                                     // 예전: 합계로 수정 → 68,000
  });
});

describe('취소된 결제', () => {
  test('취소 건은 목록에서 먼저 나온 승인이 아니라 취소일 직전 승인과 짝짓는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-01', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = run(db, [row('2026-11-01', '쿠팡', 30000), row('2026-11-06', '쿠팡', 30000), row('2026-11-06', '쿠팡', -30000)]);
    expect(r.cancelled.map(c => [c.approval.date, c.tx])).toEqual([['2026-11-06', null]]);
    expect(r.matched.map(m => m.row.date)).toEqual(['2026-11-01']);
    expect(r.missing).toEqual([]);
  });

  test('같은 날 같은 금액이면 살아 있는 결제가 기록을 가져간다 — 지우고 추가하기를 반복하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-04', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const rows = [row('2026-11-04', '쿠팡', 30000), row('2026-11-04', '쿠팡', -30000), row('2026-11-04', '쿠팡', 30000)];
    const r = run(db, rows);
    expect(r.cancelled.map(c => c.tx)).toEqual([null]);
    expect(r.matched).toHaveLength(1);
    expect(suggests(r)).toBe(false);
  });

  test('승인 기록이 하루 밀린 살아 있는 결제 기록과 섞여도, 지운 뒤 다시 지우라고 하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-02', detail: '이마트 휴지', amount: 12000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-11-01', detail: '이마트 휴지', amount: 12000, budget_category: '쇼핑', sub_category: '생활용품' });
    const rows = [row('2026-11-01', '이마트', 12000), row('2026-10-31', '(주)이마트 성수점', 12000), row('2026-11-02', '이마트', -12000)];
    const r = runIn(db, rows, '2026-10-30', '2026-11-02');
    expect(r.cancelled.filter(c => c.tx)).toHaveLength(1);
    pressRecommended(db, r);
    const again = runIn(db, rows, '2026-10-30', '2026-11-02');
    expect(suggests(again)).toBe(false);
    expect(ledgerSum(db)).toBe(12000);
  });

  test('승인 기록은 지우게 하고, 살아 있는 결제는 나눠 적은 기록·금액 오타 기록과 짝짓는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-01', detail: '스타벅스', amount: 10000, sub_category: '커피' });   // 취소된 승인의 기록
    add(db, { date: '2026-11-01', detail: '스타벅스', amount: 3900, sub_category: '커피' });
    add(db, { date: '2026-11-01', detail: '스타벅스 커피', amount: 6100, sub_category: '커피' });
    const r = run(db, [row('2026-11-01', '스타벅스', 10000), row('2026-11-01', '스타벅스', 10000), row('2026-11-01', '스타벅스', -10000)]);
    expect(r.cancelled.map(c => c.tx && c.tx.amount)).toEqual([10000]);
    expect(r.grouped.map(g => g.txs.map(t => t.amount))).toEqual([[3900, 6100]]);

    const db2 = makeDb();
    add(db2, { date: '2026-11-01', detail: '이마트 장보기', amount: 50000 });   // 취소된 승인의 기록
    add(db2, { date: '2026-11-01', detail: '이마트 장보기', amount: 50100 });   // 살아 있는 결제 (오타)
    const r2 = run(db2, [row('2026-11-01', '이마트 성수점', 50000), row('2026-11-01', '(주)이마트 성수점', 50000), row('2026-11-02', '이마트 성수점', -50000)]);
    expect(r2.cancelled.map(c => c.tx && c.tx.amount)).toEqual([50000]);
    expect(r2.mismatched.map(m => [m.cardTotal, m.txs[0].amount])).toEqual([[50000, 50100]]);
    pressRecommended(db2, r2);
    expect(ledgerSum(db2)).toBe(50000);
  });

  test('삭제 후보는 ±1일·명세서 기간 안의 기록만 — 다음 기간의 재주문을 지우라고 하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-09', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = run(db, [row('2026-11-06', '쿠팡', 30000), row('2026-11-06', '쿠팡', -30000)]);
    expect(r.cancelled.map(c => c.tx)).toEqual([null]);
  });

  test('가맹점명을 못 읽은 취소 건은 아무 승인과 짝짓지 않는다 (환불로 추가할 수 있게 남김)', () => {
    const db = makeDb();
    add(db, { date: '2026-11-03', detail: '이마트', amount: 30000 });
    add(db, { date: '2026-11-04', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = run(db, [row('2026-11-03', '이마트', 30000), row('2026-11-04', '쿠팡', 30000), row('2026-11-05', '', -30000)]);
    expect(r.cancelled).toEqual([]);
    expect(r.matched).toHaveLength(2);
    expect(r.missing.map(m => m.row.amount)).toEqual([-30000]);
  });

  test('가계부에 승인과 환불을 둘 다 적었으면 삭제를 권하지 않고 둘 다 일치', () => {
    const db = makeDb();
    add(db, { date: '2026-11-03', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-11-04', detail: '쿠팡 환불', amount: -30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = run(db, [row('2026-11-03', '쿠팡', 30000), row('2026-11-04', '쿠팡', -30000)]);
    expect(r.cancelled).toEqual([]);
    expect(r.matched.map(m => m.tx.amount)).toEqual([30000, -30000]);
    expect(suggests(r)).toBe(false);
  });
});

describe('기간 밖·할부·비슷한 기록 — 이미 적은 건을 또 추가하지 않게', () => {
  test('할부 원거래일(기간 밖) 행도 그 날짜의 가계부와 비교한다', () => {
    const db = makeDb();
    add(db, { date: '2026-08-15', detail: '삼성전자', amount: 1200000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = run(db, [row('2026-08-15', '삼성전자', 1200000, { installment: '12개월' }), row('2026-11-03', '스타벅스', 4500)]);
    expect(r.matched.map(m => m.tx.detail)).toEqual(['삼성전자']);
    expect(names(r.missing)).toEqual(['스타벅스']);
    expect(r.missing[0].autoCheck).toBe(true);
  });

  test('명세서 기간을 잘못 읽어도 행 날짜의 가계부와 비교하고, "카드에 없음"은 기간 안 기록만 본다 (J1)', () => {
    const db = makeDb();
    add(db, { date: '2026-10-20', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-10-21', detail: '이마트', amount: 32000 });
    add(db, { date: '2026-10-22', detail: '김밥천국', amount: 8000 });            // 기간 밖 — 카드 행 다음 날이어도 보여 주지 않는다
    add(db, { date: '2026-10-25', detail: '맘스터치', amount: 9000 });
    const r = run(db, [row('2026-10-20', '스타벅스', 4500), row('2026-10-21', '이마트', 32000)]);
    expect(r.matched).toHaveLength(2);
    expect(r.missing).toEqual([]);
    expect(r.notOnCard).toEqual([]);
  });

  test('기간 밖·할부 행이 가계부에 없으면 미리 체크하지 않는다', () => {
    const db = makeDb();
    const r = run(db, [row('2026-10-15', '쿠팡', 30000), row('2026-11-03', '삼성전자', 600000, { installment: '3개월' })]);
    expect(r.missing.map(m => [m.autoCheck, m.cautions])).toEqual([[false, ['period']], [false, ['installment']]]);
  });

  test('다른 가게·같은 금액·2~3일 차이는 짝짓지 않고 "비슷한 기록 있음"으로 알린다 (±1일은 짝지음)', () => {
    const db = makeDb();
    add(db, { date: '2026-11-02', detail: '점심', amount: 9900 });
    add(db, { date: '2026-11-05', detail: '점심', amount: 7000 });
    const r = run(db, [row('2026-11-05', '맘스터치', 9900), row('2026-11-06', '김밥천국', 7000)]);
    expect(r.matched.map(m => m.row.merchant)).toEqual(['김밥천국']);
    expect(r.missing.map(m => [m.row.merchant, m.autoCheck, m.similarTx && m.similarTx.amount])).toEqual([['맘스터치', false, 9900]]);
  });

  test('비슷한 이름만 맞는 금액 오타 기록이 있으면 미리 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-05', detail: '이마트장보기', amount: 31000 });
    const r = run(db, [row('2026-11-05', '이마트성수점', 30000)]);
    expect(r.mismatched).toEqual([]);                                          // SIMILAR에는 수정 버튼을 붙이지 않는다
    expect(r.missing.map(m => [m.autoCheck, m.similarTx.detail])).toEqual([[false, '이마트장보기']]);
  });

  test('AI가 고른 입력 습관 표기(detail)도 가게 이름 별칭으로 본다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-04', detail: '파리바게뜨', amount: 4800 });
    const r = run(db, [row('2026-11-05', 'SPC GFS', 5000, { detail: '파리바게뜨' })]);
    expect(r.missing.map(m => [m.autoCheck, m.similarTx && m.similarTx.detail])).toEqual([[false, '파리바게뜨']]);
  });
});

describe('카드 내역 정리 (normalizeStatement)', () => {
  test('취소인데 양수로 읽은 금액은 음수로, 0원 행은 세어서 알린다', () => {
    const st = normalizeStatement({
      rows: [
        row('2026-11-04', '쿠팡', 30000, { is_cancel: true }),
        { ...row('2026-11-03', 'AMAZON', 0), currency: 'USD', foreign_amount: 25.5 },
        row('2026-11-03', '스타벅스', 4500),
      ],
    }, TODAY);
    expect(st.rows.map(r => [r.merchant, r.amount, r.isCancel])).toEqual([['쿠팡', -30000, true], ['스타벅스', 4500, false]]);
    expect(st.zeroAmount).toBe(1);
    expect(st.unreadable).toBe(0);
  });

  test('행 칸이 없는 응답은 0건으로 두지 않고 오류 — "모두 맞습니다"가 거짓으로 나오지 않게', () => {
    expect(() => normalizeStatement({ is_card_statement: true, card_name: '신한' }, TODAY)).toThrow(/읽지 못했습니다/);
    expect(() => normalizeStatement({}, TODAY)).toThrow(/읽지 못했습니다/);
    expect(() => normalizeStatement(null, TODAY)).toThrow(/읽지 못했습니다/);
    expect(normalizeStatement({ is_card_statement: true, rows: [] }, TODAY).rows).toEqual([]);
  });
});

test('성능: "가계부에 없음"이 많아도 분류 추천이 행마다 DB를 다시 읽지 않는다', () => {
  const db = makeDb();
  const shops = ['스타벅스', '이마트', '쿠팡', '다이소', 'GS25', '올리브영', '맘스터치', '김밥천국', '교보문고', 'CU'];
  for (let i = 0; i < 600; i += 1) {
    add(db, {
      date: `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`,
      detail: `${shops[i % 10]} ${i % 37}`, amount: 1000 + (i % 50) * 100, payment_method: '카카오페이',
    });
  }
  const rows = Array.from({ length: 150 }, (_, i) => row(`2026-10-${String(1 + (i % 30)).padStart(2, '0')}`, `${shops[i % 10]} 지점${i}`, 1234 + i));
  const exec = vi.spyOn(db, 'exec');
  const r = reconcileStatement(db, {
    paymentMethod: CARD, ...normalizeStatement({ period_from: '2026-10-01', period_to: '2026-10-30', rows }, TODAY),
  });
  expect(r.missing).toHaveLength(150);
  expect(exec.mock.calls.length).toBeLessThanOrEqual(8);                     // 예전: 450번 넘게
});

// ── 3차 리뷰 (S1~S8) ─────────────────────────────────────────────

describe('겹친 캡처 — 같은 결제가 두 번 읽힘', () => {
  test('날짜·가게·금액이 같은 행은 하나만 짝짓고, 남는 행은 "두 번 읽혔을 수 있어요"로 미리 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-03', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-11-04', detail: '이마트', amount: 32000 });
    const rows = [row('2026-11-03', '스타벅스 강남점', 4500), row('2026-11-04', '이마트', 32000),
      row('2026-11-04', '이마트', 32000), row('2026-11-03', '스타벅스 강남점', 4500)];
    const r = run(db, rows);
    expect(r.matched).toHaveLength(2);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck, m.cautions])).toEqual([[32000, false, ['duplicate']], [4500, false, ['duplicate']]]);
    pressRecommended(db, r);
    expect(ledgerSum(db)).toBe(36500);                                     // 예전: 73,000
  });

  test('같은 날 정말 두 번 결제하고 둘 다 적었으면 둘 다 일치', () => {
    const db = makeDb();
    add(db, { date: '2026-11-04', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-11-04', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    const r = run(db, [row('2026-11-04', '스타벅스', 4500), row('2026-11-04', '스타벅스', 4500)]);
    expect(r.matched).toHaveLength(2);
    expect(r.missing).toEqual([]);
  });

  test('합쳐 적은 기록의 오타가 있어도 두 번 읽힌 행을 합계에 넣지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-31', detail: '올리브영', amount: 23000, budget_category: '쇼핑', sub_category: '생활용품' });
    const rows = [row('2026-10-31', '올리브영 성수', 10000), row('2026-10-31', '올리브영 성수', 12000), row('2026-10-31', '올리브영 성수', 12000)];
    const r = runIn(db, rows, '2026-10-30', '2026-11-02');
    expect(r.mismatched.map(m => [m.rows.map(x => x.amount).sort(), m.cardTotal])).toEqual([[[10000, 12000], 22000]]);
    expect(r.missing.map(m => [m.row.amount, m.cautions])).toEqual([[12000, ['duplicate']]]);
  });

  test('승인이 두 번 읽히고 취소된 경우 — 삭제를 권하지는 않고 확인만 띄운다 (같은 날 다시 산 것일 수도)', () => {
    const db = makeDb();
    add(db, { date: '2026-11-03', detail: '이마트 장보기', amount: 4500 });
    const r = run(db, [row('2026-11-03', '이마트 성수점', 4500), row('2026-11-04', '이마트 성수점', -4500), row('2026-11-03', '이마트 성수점', 4500)]);
    expect(r.cancelled.map(c => [c.tx, c.maybeTx && c.maybeTx.amount])).toEqual([[null, 4500]]);
    expect(suggests(r)).toBe(false);
  });
});

describe('다른 결제수단·환불', () => {
  test('다른 결제수단(카카오페이)으로 적은 같은 결제는 미리 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-03', detail: '스타벅스', amount: 4500, payment_method: '카카오페이', sub_category: '커피' });
    const r = run(db, [row('2026-11-03', '카카오페이 스타벅스', 4500)]);
    expect(r.missing.map(m => [m.autoCheck, m.cautions, m.otherTx && m.otherTx.payment_method])).toEqual([[false, ['otherMethod'], '카카오페이']]);
  });

  test('지난 기간 결제의 환불 행은 원래 결제를 "비슷한 기록"으로 잡지 않고, 원래 결제의 환불로 안내하며 미리 체크한다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-30', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = run(db, [row('2026-11-02', '쿠팡', -30000), row('2026-11-03', '스타벅스', 4500)]);
    const refund = r.missing.find(m => m.row.amount < 0);
    expect(refund).toMatchObject({ autoCheck: true, cautions: [], similarTx: null });
    expect(refund.refundOf.date).toBe('2026-10-30');
  });

  test('지난 기간 결제 기록은 환불 행의 몫 — 다른 카드 건이 금액 차이로 가져가 고치지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-29', detail: '스타벅스 커피', amount: 5000, sub_category: '커피' });
    const r = runIn(db, [row('2026-10-30', '스타벅스', 20000), row('2026-10-30', '스타벅스', -5000)], '2026-10-30', '2026-11-02');
    expect(r.mismatched).toEqual([]);                                       // 예전: 5,000 → 20,000 수정
    expect(r.missing.map(m => [m.row.amount, m.autoCheck])).toEqual([[20000, true], [-5000, true]]);
    pressRecommended(db, r);
    expect(ledgerSum(db)).toBe(20000);
  });

  test('가계부의 환불 기록은 가게 이름이 없어도("반품 환불"), 며칠 뒤에 적었어도 알아본다 — 승인 삭제를 권하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-03', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-11-05', detail: '반품 환불', amount: -30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = run(db, [row('2026-11-03', '쿠팡', 30000), row('2026-11-05', '쿠팡', -30000)]);
    expect(r.cancelled).toEqual([]);
    expect(r.matched.map(m => [m.tx.amount, m.nameDiffers])).toEqual([[30000, false], [-30000, true]]);

    const db2 = makeDb();
    add(db2, { date: '2026-11-01', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db2, { date: '2026-11-07', detail: '쿠팡 환불', amount: -30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r2 = run(db2, [row('2026-11-01', '쿠팡', 30000), row('2026-11-02', '쿠팡', -30000)]);
    expect(r2.cancelled).toEqual([]);
    expect(suggests(r2)).toBe(false);
  });

  test('취소된 승인에 맞는 기록이 둘이면 어느 쪽인지 모르므로 삭제를 권하지 않는다 (지난 기간 결제의 환불일 수 있음)', () => {
    const db = makeDb();
    add(db, { date: '2026-10-29', detail: '올리브영', amount: 20000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-10-31', detail: '올리브영', amount: 20000, budget_category: '쇼핑', sub_category: '생활용품' });
    const rows = [row('2026-10-30', '올리브영', 20000), row('2026-10-31', '올리브영', -20000)];
    const r = runIn(db, rows, '2026-10-30', '2026-11-02');
    expect(r.cancelled.map(c => [c.tx, !!c.maybeTx])).toEqual([[null, true]]);
    expect(suggests(r)).toBe(false);                                        // 예전: 지우고 다시 대조하면 하나 더 지우라고 함
  });
});

describe('이름이 다른 짝·기간 경계', () => {
  test('이름을 제대로 적는 가게의 카드 건은 다른 가게 같은 금액 기록과 "일치"로 숨지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-04', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-11-03', detail: '올리브영', amount: 8000, budget_category: '쇼핑', sub_category: '생활용품' });  // 다른 카드로 산 것
    const r = run(db, [row('2026-11-04', '스타벅스', 4500), row('2026-11-04', '스타벅스 강남점', 8000)]);
    expect(r.matched.map(m => m.row.amount)).toEqual([4500]);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck])).toEqual([[8000, false]]);
    expect(r.notOnCard.map(t => t.detail)).toEqual(['올리브영']);
  });

  test('가게 이름 없이 적은 기록과의 같은 금액 짝은 "이름 다름"으로 표시한다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-05', detail: '점심', amount: 7000 });
    const r = run(db, [row('2026-11-05', '김밥천국', 7000)]);
    expect(r.matched.map(m => m.nameDiffers)).toEqual([true]);
  });

  test('취소된 승인의 가계부 기록이 기간 시작 하루 전이면 "기간 밖"으로 확인만 띄운다 (앞 명세서의 기록일 수 있어 권하지 않음)', () => {
    const db = makeDb();
    add(db, { date: '2026-10-31', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = run(db, [row('2026-11-01', '쿠팡', 30000), row('2026-11-02', '쿠팡', -30000)]);
    expect(r.cancelled.map(c => [c.tx, c.maybeTx && c.maybeTx.date, c.outsidePeriod])).toEqual([[null, '2026-10-31', true]]);
    expect(suggests(r)).toBe(false);
  });

  test('가게 이름 없이 적은 금액 오타 기록이 기간 밖 하루 전에 있으면 미리 체크하지 않고 비슷한 기록으로 알린다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-29', detail: '장보기', amount: 22000 });
    const r = runIn(db, [row('2026-10-30', '교보문고 광화문', 20000)], '2026-10-30', '2026-11-02');
    expect(r.missing.map(m => [m.autoCheck, m.similarTx && m.similarTx.detail])).toEqual([[false, '장보기']]);
    expect(r.notOnCard).toEqual([]);                                        // 기간 밖 기록은 "카드에 없음"에 넣지 않는다 (J1)
  });

  test('날짜를 4일 잘못 적은 같은 가게 기록이 있으면 미리 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-07', detail: '이마트', amount: 12000 });
    const r = run(db, [row('2026-11-03', '이마트', 12000)]);
    expect(r.missing.map(m => [m.autoCheck, m.similarTx && m.similarTx.date])).toEqual([[false, '2026-11-07']]);
  });
});

// ── 4차 리뷰 (B1~B5, G1~G3, T5·T23~T29) ─────────────────────────────

const runNov = (db, rows) => runIn(db, rows, '2026-11-01', '2026-11-30');
const fixable = m => m.fixable;

describe('앞뒤 명세서의 기록 — 명세서 기간이 있으면 기간 밖 기록과 짝짓거나 고치라고 하지 않는다', () => {
  test('기간 시작 전 같은 가게·같은 금액 기록이 이번 달 빠진 결제를 가리지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-30', detail: '스타벅스', amount: 4500, sub_category: '커피' });   // 10월 대조에서 이미 맞은 기록
    add(db, { date: '2026-11-05', detail: '이마트', amount: 32000 });
    const r = runNov(db, [row('2026-11-01', '스타벅스 강남점', 4500), row('2026-11-05', '이마트', 32000)]);
    expect(r.matched.map(m => m.row.merchant)).toEqual(['이마트']);
    expect(r.missing.map(m => [m.row.merchant, m.autoCheck, m.similarTx && m.similarTx.date])).toEqual([['스타벅스 강남점', false, '2026-10-30']]);
  });

  test('기간 끝 뒤 기록도 마찬가지', () => {
    const db = makeDb();
    add(db, { date: '2026-12-02', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    const r = reconcileStatement(db, { paymentMethod: CARD, ...normalizeStatement({ period_from: '2026-11-01', period_to: '2026-11-30', rows: [row('2026-11-30', '스타벅스', 4500)] }, '2026-12-08') });
    expect(r.matched).toEqual([]);
    expect(r.missing.map(m => m.autoCheck)).toEqual([false]);
  });

  test('기간 시작 전날 다른 금액 기록에 "카드 금액으로 수정"을 권하지 않는다 (10월 기록을 고치지 않게)', () => {
    const db = makeDb();
    add(db, { date: '2026-10-31', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    const r = runNov(db, [row('2026-11-01', '스타벅스 강남점', 5000)]);
    expect(r.mismatched).toEqual([]);
    expect(r.missing.map(m => [m.autoCheck, m.similarTx.date])).toEqual([[false, '2026-10-31']]);
  });

  test('기간 경계를 넘겨 나눠 적은 몫이 있으면 남은 몫을 고치라고 하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-31', detail: '이마트', amount: 20000 });
    add(db, { date: '2026-11-01', detail: '이마트', amount: 30000 });
    const r = runNov(db, [row('2026-11-01', '이마트', 50000)]);
    expect(r.mismatched.map(m => [m.txs.map(t => t.amount), m.namelessNear.map(t => t.amount)])).toEqual([[[30000], [20000]]]);
    expect(r.mismatched.filter(fixable)).toEqual([]);
  });

  test('명세서 기간을 못 읽어 행 날짜로 정했으면 범위 밖 하루 앞 기록과 짝짓지 않고 비슷한 기록으로 알린다 (J4)', () => {
    const db = makeDb();
    add(db, { date: '2026-10-31', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    const r = reconcileStatement(db, { paymentMethod: CARD, ...normalizeStatement({ rows: [row('2026-11-01', '스타벅스', 4500)] }, TODAY) });
    expect(r.matched).toEqual([]);
    expect(r.missing.map(m => [m.autoCheck, m.similarTx && m.similarTx.date])).toEqual([[false, '2026-10-31']]);
    expect(r.notOnCard).toEqual([]);
  });
});

describe('가게 이름 없이 나눠·합쳐 적은 기록 — 추가·수정이 이중 계산하지 않게', () => {
  test('한 몫만 가게 이름, 나머지는 품목 이름이면 이름 있는 몫을 고치라고 하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-03', detail: '이마트 장보기', amount: 30000 });
    add(db, { date: '2026-11-03', detail: '생활용품', amount: 20000, budget_category: '쇼핑', sub_category: '생활용품' });
    const rows = [row('2026-11-03', '이마트 성수점', 50000)];
    const r = run(db, rows);
    expect(r.mismatched.map(m => m.namelessNear.map(t => t.detail))).toEqual([['생활용품']]);
    pressRecommended(db, r);
    expect(ledgerSum(db)).toBe(50000);                                       // 예전: 30,000 → 50,000 수정해 70,000
  });

  test('카드 2건을 품목 이름 1건으로 합쳐 적었으면 2건을 미리 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-02', detail: '장보기', amount: 15000 });
    const r = run(db, [row('2026-11-02', '이마트 성수점', 12000), row('2026-11-02', '이마트 성수점', 3000)]);
    expect(r.missing.map(m => m.autoCheck)).toEqual([false, false]);
  });

  test('카드 1건을 품목 이름 2건으로 나눠 적었으면 미리 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-03', detail: '식료품', amount: 30000 });
    add(db, { date: '2026-11-03', detail: '생활용품', amount: 20000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = run(db, [row('2026-11-03', '이마트 성수점', 50000)]);
    expect(r.missing.map(m => m.autoCheck)).toEqual([false]);
  });

  test('기간 2일 전에 이름 없이 금액을 잘못 적은 기록이 있으면 미리 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-30', detail: '점심', amount: 9000 });
    const r = runIn(db, [row('2026-11-01', '김밥천국', 9500)], '2026-11-01', '2026-11-07');
    expect(r.missing.map(m => [m.autoCheck, m.similarTx && m.similarTx.detail])).toEqual([[false, '점심']]);
  });

  test('이름 없는 기록 하나에 같은 금액 카드 건이 둘이면 어느 쪽과도 짝짓지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-03', detail: '점심', amount: 3000 });
    const r = run(db, [row('2026-11-02', '교보문고', 3000), row('2026-11-04', '맘스터치', 3000)]);
    expect(r.matched).toEqual([]);
    expect(r.missing.map(m => m.autoCheck)).toEqual([false, false]);
  });
});

describe('취소·다른 결제수단 판단', () => {
  test('지난 기간에 적어 둔 같은 금액 환불 기록을 이번 취소 건이 가져가지 않는다 (승인 전날보다 앞선 환불)', () => {
    const db = makeDb();
    add(db, { date: '2026-10-20', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-10-29', detail: '쿠팡 환불', amount: -30000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-11-03', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = runIn(db, [row('2026-11-03', '쿠팡', 30000), row('2026-11-04', '쿠팡', -30000)], '2026-11-01', '2026-11-07');
    expect(r.matched).toEqual([]);
    // 같은 가게 환불 기록이 기간 밖에 있으면 (10/20 결제를 반품하며 미리 적은 환불이고 이 취소가 그 결제의 것일 수도 있어) 삭제는 확인만 (N3)
    expect(r.cancelled.map(c => [c.tx, c.maybeTx && c.maybeTx.date, c.doubtTx && c.doubtTx.date])).toEqual([[null, '2026-11-03', '2026-10-29']]);

    const db2 = makeDb();
    add(db2, { date: '2026-10-30', detail: '무신사 환불', amount: -30000 });
    add(db2, { date: '2026-11-03', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r2 = runIn(db2, [row('2026-11-03', '쿠팡', 30000), row('2026-11-04', '쿠팡', -30000)], '2026-11-01', '2026-11-07');
    expect(r2.cancelled.map(c => c.tx && c.tx.date)).toEqual(['2026-11-03']);
  });

  test('취소된 승인의 기록을 날짜를 밀려 적은 살아 있는 결제도 노리면 삭제를 권하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-11-03', detail: '이마트', amount: 10000 });     // 11/1 결제를 이틀 늦게 적은 기록일 수도
    const r = run(db, [row('2026-11-01', '이마트', 10000), row('2026-11-03', '이마트 성수점', 10000), row('2026-11-04', '이마트 성수점', -10000)]);
    expect(r.cancelled.map(c => c.tx)).toEqual([null]);
    expect(suggests(r)).toBe(false);
  });

  test('다른 결제수단: 같은 금액이면 이름 없이 ±3일, 같은 가게면 ±5일·금액이 가까울 때만', () => {
    const db = makeDb();
    add(db, { date: '2026-11-05', detail: '점심', amount: 9000, payment_method: '카카오페이' });
    expect(run(db, [row('2026-11-03', '김밥천국', 9000)]).missing.map(m => m.cautions)).toEqual([['otherMethod']]);

    const db2 = makeDb();
    add(db2, { date: '2026-11-07', detail: '김밥천국', amount: 9000, payment_method: '카카오페이' });
    expect(run(db2, [row('2026-11-03', '김밥천국', 9000)]).missing.map(m => m.cautions)).toEqual([['otherMethod']]);

    const db3 = makeDb();
    add(db3, { date: '2026-11-04', detail: 'GS25', amount: 2500, payment_method: '카카오페이' });  // 자주 가는 가게의 다른 결제
    expect(run(db3, [row('2026-11-03', 'GS25 성수점', 4800)]).missing.map(m => m.autoCheck)).toEqual([true]);
  });
});

// ── 5차 리뷰 (J1~J6) ─────────────────────────────

const runOct = (db, rows, today = '2026-11-15') => reconcileStatement(db, {
  paymentMethod: CARD,
  ...normalizeStatement({ period_from: '2026-10-01', period_to: '2026-10-31', rows }, today),
});
const runNoPeriod = (db, rows) => reconcileStatement(db, { paymentMethod: CARD, ...normalizeStatement({ rows }, '2026-11-15') });
const allGood = r => !r.mismatched.length && !r.missing.length && !r.notOnCard.length && !r.cancelled.some(c => c.tx || c.maybeTx);

describe('두 글자 첫 단어 브랜드 ("본죽 점심" ↔ "본죽 성수점")', () => {
  test('금액이 같으면 근처에 같은 브랜드 기록이 또 있어도 짝짓는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-21', detail: '본죽', amount: 10000 });
    add(db, { date: '2026-10-22', detail: '본죽 점심', amount: 12000 });
    add(db, { date: '2026-10-22', detail: 'CU 간식', amount: 3500 });
    const r = runOct(db, [row('2026-10-20', '본죽 성수점', 10000), row('2026-10-22', '본죽 성수점', 12000), row('2026-10-22', 'CU 성수역점', 3500)]);
    expect(r.matched.map(m => [m.row.amount, m.tx.detail, m.nameDiffers])).toEqual([[10000, '본죽', false], [12000, '본죽 점심', false], [3500, 'CU 간식', false]]);
    expect(allGood(r)).toBe(true);
  });

  test('금액이 다르면 금액 차이로 고치기를 권하지 않고, 비슷한 기록으로 알려 미리 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-06', detail: '본죽 점심', amount: 9500 });
    const r = runOct(db, [row('2026-10-06', '본죽 성수점', 9000)]);
    expect(r.mismatched).toEqual([]);
    expect(r.missing.map(m => [m.autoCheck, m.cautions, m.similarTx && m.similarTx.detail])).toEqual([[false, ['similar'], '본죽 점심']]);
  });

  test('흔한 일반어 첫 단어("점심", "택시")는 브랜드로 보지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-05', detail: '점심 김밥', amount: 8000 });
    add(db, { date: '2026-10-05', detail: '김밥천국', amount: 8000 });   // 같은 금액 이름 없는 기록이 둘 — "점심"이 브랜드면 이름 짝이 생긴다
    const r = runOct(db, [row('2026-10-05', '점심 국수집', 8000)]);
    expect(r.matched).toEqual([]);
    expect(r.missing.map(m => m.autoCheck)).toEqual([false]);
  });
});

describe('J1 "카드에 없음"은 명세서 기간 안 기록만', () => {
  test('평범한 달 — 앞뒤 명세서 몫(9/30, 11/1) 기록이 있어도 "모두 맞습니다"', () => {
    const db = makeDb();
    add(db, { date: '2026-10-31', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-11-01', detail: '쿠팡', amount: 23000 });
    add(db, { date: '2026-09-30', detail: 'GS25', amount: 3200 });
    add(db, { date: '2026-10-01', detail: '이마트', amount: 54000 });
    const r = runOct(db, [row('2026-10-31', '스타벅스 성수점', 4500), row('2026-10-01', '(주)이마트 성수점', 54000)]);
    expect(r.matched).toHaveLength(2);
    expect(r.notOnCard).toEqual([]);
    expect(allGood(r)).toBe(true);
  });

  test('할부 원거래일(7/3) 근처의 다른 7월 기록이 매달 "카드에 없음"으로 나오지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-07-03', detail: '삼성디지털프라자', amount: 1200000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-07-04', detail: 'GS25', amount: 3200 });
    add(db, { date: '2026-10-05', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    const r = runOct(db, [row('2026-07-03', '삼성디지털프라자 성수점', 1200000, { installment: '3개월' }), row('2026-10-05', '스타벅스', 4500)]);
    expect(r.notOnCard).toEqual([]);
    expect(allGood(r)).toBe(true);
  });

  test('금액 차이 옆(±1일)의 기간 밖 같은 가게 기록은 합이 맞지 않아도 알리고 고치기를 권하지 않는다 — "카드에 없음"에 안 보이므로', () => {
    const db = makeDb();
    add(db, { date: '2026-11-01', detail: '올리브영', amount: 12000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-11-03', detail: '올리브영', amount: 2000, budget_category: '쇼핑', sub_category: '생활용품' });  // 11/2 결제를 하루 늦게·틀리게 적음
    const r = runIn(db, [row('2026-11-01', '올리브영', 10000), row('2026-11-02', '올리브영', 3000)], '2026-10-30', '2026-11-02');
    expect(r.mismatched.map(m => [m.cardTotal, m.ledgerTotal, m.namelessNear.map(t => t.amount), m.fixable])).toEqual([[13000, 12000, [2000], false]]);
    expect(r.notOnCard).toEqual([]);
  });

  test('기간 안 기록은 그대로 "카드에 없음"', () => {
    const db = makeDb();
    add(db, { date: '2026-10-10', detail: '맘스터치', amount: 9000 });
    const r = runOct(db, [row('2026-10-05', '스타벅스', 4500)]);
    expect(r.notOnCard.map(t => t.detail)).toEqual(['맘스터치']);
  });
});

describe('J2 할부 금액 차이는 고치기를 권하지 않는다', () => {
  test('할부를 달마다 나눠 적는 사용자 — 첫 몫 400,000 vs 카드 총액 1,200,000', () => {
    const db = makeDb();
    add(db, { date: '2026-10-03', detail: '삼성디지털프라자 노트북', amount: 400000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-10-05', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    const r = runOct(db, [
      row('2026-10-03', '삼성디지털프라자 성수점', 1200000, { installment: '3개월' }),
      row('2026-10-05', '스타벅스 성수점', 4500),
    ]);
    expect(r.mismatched.map(m => [m.cardTotal, m.ledgerTotal, m.cautions, m.fixable])).toEqual([[1200000, 400000, ['installment'], false]]);
    expect(suggests(r)).toBe(false);
  });

  test('다음 달 명세서에 원거래(7/3) 행이 다시 나와도 7/3 첫 몫 기록을 고치라고 하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-07-03', detail: '삼성디지털프라자 노트북', amount: 400000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-08-03', detail: '삼성디지털프라자 노트북', amount: 400000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-08-10', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    const r = reconcileStatement(db, {
      paymentMethod: CARD,
      ...normalizeStatement({
        period_from: '2026-08-01',
        period_to: '2026-08-31',
        rows: [row('2026-07-03', '삼성디지털프라자 성수점', 1200000, { installment: '3개월' }), row('2026-08-10', '스타벅스 성수점', 4500)],
      }, '2026-09-15'),
    });
    expect(r.mismatched.map(m => [m.txs[0].date, m.cautions, m.fixable])).toEqual([['2026-07-03', ['installment'], false]]);
    expect(suggests(r)).toBe(false);
  });

  test('일시불 금액 차이는 그대로 고치기를 권한다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-03', detail: '이마트', amount: 32000 });
    const r = runOct(db, [row('2026-10-03', '이마트 성수점', 23000)]);
    expect(r.mismatched.map(m => [m.cautions, m.fixable])).toEqual([[[], true]]);
  });
});

describe('J3 환불 행 — 원래 결제 기록을 찾아 미리 체크, 못 찾으면 체크하지 않는다', () => {
  test('원래 결제를 지운 사용자 — 취소 행만 있고 원래 결제 기록이 없으면 미리 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-05', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    const r = runOct(db, [row('2026-10-02', '쿠팡(주)', -30000), row('2026-10-05', '스타벅스 성수점', 4500)]);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck, m.cautions, m.refundOf])).toEqual([[-30000, false, ['noOriginal'], null]]);
  });

  test('원래 결제가 읽는 범위 밖(25일 전)에 있어도 찾아 안내하고 미리 체크한다', () => {
    const db = makeDb();
    add(db, { date: '2026-09-10', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = runOct(db, [row('2026-10-05', '쿠팡(주)', -30000)]);
    expect(r.missing.map(m => [m.autoCheck, m.cautions, m.refundOf && m.refundOf.date])).toEqual([[true, [], '2026-09-10']]);
  });

  test(`${REFUND_LOOKBACK}일보다 오래된 결제는 원래 결제로 보지 않는다`, () => {
    const db = makeDb();
    add(db, { date: '2026-05-01', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = runOct(db, [row('2026-10-05', '쿠팡(주)', -30000)]);
    expect(r.missing.map(m => [m.autoCheck, m.cautions])).toEqual([[false, ['noOriginal']]]);
  });

  test('다른 가게·다른 금액 결제는 원래 결제가 아니다 — 같은 가게의 더 큰 결제가 있으면 부분취소일 수 있다고 안내 (K5)', () => {
    const db = makeDb();
    add(db, { date: '2026-09-20', detail: '무신사', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-09-21', detail: '쿠팡', amount: 50000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = runOct(db, [row('2026-10-05', '쿠팡(주)', -30000)]);
    expect(r.missing.map(m => [m.autoCheck, m.cautions, m.refundOf, m.partialOf && m.partialOf.date])).toEqual([[false, ['partialRefund'], null, '2026-09-21']]);

    const db2 = makeDb();
    add(db2, { date: '2026-09-20', detail: '무신사', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    expect(runOct(db2, [row('2026-10-05', '쿠팡(주)', -30000)]).missing.map(m => m.cautions)).toEqual([['noOriginal']]);
  });

  test('이번 카드의 다른 결제와 짝지은 기록은 원래 결제로 보지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-04', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });   // 10/6 결제를 이틀 일찍 적음
    const r = runOct(db, [row('2026-10-06', '쿠팡(주)', 30000), row('2026-10-05', '쿠팡(주)', -30000)]);
    expect(r.matched.map(m => [m.row.amount, m.tx.date])).toEqual([[30000, '2026-10-04']]);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck, m.cautions, m.refundOf])).toEqual([[-30000, false, ['noOriginal'], null]]);
  });
});

describe('J4 기간을 못 읽어 행 날짜로 정한 범위 밖 기록', () => {
  test('부분 캡처(10/15~) — 범위 밖 10/14 같은 금액 기록과 짝짓지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-14', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-10-20', detail: '이마트', amount: 54000 });
    const r = runNoPeriod(db, [row('2026-10-15', '스타벅스 성수점', 4500), row('2026-10-20', '(주)이마트 성수점', 54000)]);
    expect(r.matched.map(m => m.row.merchant)).toEqual(['(주)이마트 성수점']);
    expect(r.missing.map(m => [m.row.merchant, m.autoCheck, m.similarTx && m.similarTx.date])).toEqual([['스타벅스 성수점', false, '2026-10-14']]);
    expect(r.notOnCard).toEqual([]);
  });

  test('범위 밖 다른 금액 기록은 금액 차이로 보이되 고치기를 권하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-14', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-10-20', detail: '이마트', amount: 54000 });
    const r = runNoPeriod(db, [row('2026-10-15', '스타벅스 성수점', 5000), row('2026-10-20', '(주)이마트 성수점', 54000)]);
    expect(r.mismatched.map(m => [m.txs[0].date, m.cautions, m.fixable])).toEqual([['2026-10-14', ['outsideRange'], false]]);
    expect(suggests(r)).toBe(false);
  });

  test('범위 안 기록은 날짜가 며칠 달라도 그대로 짝짓는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-15', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-10-18', detail: '이마트', amount: 54000 });
    const r = runNoPeriod(db, [row('2026-10-15', '스타벅스 성수점', 4500), row('2026-10-20', '(주)이마트 성수점', 54000)]);
    expect(r.matched).toHaveLength(2);
    expect(allGood(r)).toBe(true);
  });
});

describe('J5 부분취소', () => {
  test('주유 선승인 100,000 → 부분취소 −47,700, 가계부엔 실제 52,300 — 부분취소 반영으로 일치', () => {
    const db = makeDb();
    add(db, { date: '2026-10-05', detail: 'GS칼텍스 주유', amount: 52300 });
    const r = runOct(db, [row('2026-10-05', 'GS칼텍스 성수주유소', 100000), row('2026-10-05', 'GS칼텍스 성수주유소', -47700)]);
    expect(r.grouped.map(g => [g.kind, g.rows.map(x => x.amount), g.txs.map(t => t.amount)])).toEqual([['partialCancel', [100000, -47700], [52300]]]);
    expect(r.mismatched).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(allGood(r)).toBe(true);
  });

  test('취소가 승인보다 앞이거나 차액이 맞지 않으면 묶지 않고 취소 행을 미리 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-05', detail: 'GS칼텍스 주유', amount: 52300 });
    const r = runOct(db, [row('2026-10-05', 'GS칼텍스 성수주유소', 100000), row('2026-10-04', 'GS칼텍스 성수주유소', -47700)]);
    expect(r.grouped).toEqual([]);
    expect(r.mismatched).toHaveLength(1);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck])).toEqual([[-47700, false]]);

    const db2 = makeDb();
    add(db2, { date: '2026-10-05', detail: 'GS칼텍스 주유', amount: 50000 });
    const r2 = runOct(db2, [row('2026-10-05', 'GS칼텍스 성수주유소', 100000), row('2026-10-06', 'GS칼텍스 성수주유소', -47700)]);
    expect(r2.grouped).toEqual([]);
    expect(r2.missing.map(m => [m.row.amount, m.autoCheck])).toEqual([[-47700, false]]);
  });
});

describe('J6 두 번 읽힘·청구할인 줄·늦게 적은 환불', () => {
  test('겹친 캡처에서 이름이 조금 다르게 두 번 읽힌 결제("성수역점"/"성수역")는 미리 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-05', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    const r = runOct(db, [row('2026-10-05', '스타벅스 성수역점', 4500), row('2026-10-05', '스타벅스 성수역', 4500)]);
    expect(r.matched).toHaveLength(1);
    expect(r.missing.map(m => [m.autoCheck, m.cautions])).toEqual([[false, ['duplicate']]]);
  });

  test('같은 날 다른 지점의 같은 금액 결제는 두 번 읽힘으로 보지 않는다', () => {
    const db = makeDb();
    const r = runOct(db, [row('2026-10-05', '스타벅스 성수역점', 4500), row('2026-10-05', '스타벅스 강남점', 4500)]);
    expect(r.missing.map(m => m.cautions)).toEqual([[], []]);
  });

  test('청구할인·캐시백 줄은 행으로 넣지 않고 세며, 프롬프트에도 규칙이 있다', () => {
    const st = normalizeStatement({
      rows: [
        row('2026-10-05', '스타벅스 성수점', 5000),
        row('2026-10-05', '스타벅스 성수점 청구할인', -500),
        row('2026-10-06', '캐시백 적립', -300),
        row('2026-10-07', '쿠팡(주)', -30000),
      ],
    }, '2026-11-15');
    expect(st.rows.map(r => r.amount)).toEqual([5000, -30000]);
    expect(st.discountLines).toBe(2);
    expect(buildStatementPrompt(makeDb(), CARD, '2026-11-15')).toContain('청구할인·캐시백·포인트 차감');

    const db = makeDb();
    add(db, { date: '2026-10-05', detail: '스타벅스', amount: 5000, discount_amount: 500, sub_category: '커피' });
    const r = runOct(db, [row('2026-10-05', '스타벅스 성수점', 5000), row('2026-10-05', '스타벅스 성수점 청구할인', -500)]);
    expect(allGood(r)).toBe(true);
  });

  test('취소한 결제의 환불을 기간 뒤(11/8)에 적었으면 알아보고 승인 삭제를 권하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-27', detail: '쿠팡', amount: 30000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-11-08', detail: '쿠팡 환불', amount: -30000, budget_category: '쇼핑', sub_category: '생활용품' });
    const r = runOct(db, [row('2026-10-27', '쿠팡(주)', 30000), row('2026-10-29', '쿠팡(주)', -30000)], '2026-11-20');
    expect(r.cancelled).toEqual([]);
    expect(r.matched.map(m => m.tx.date).sort()).toEqual(['2026-10-27', '2026-11-08']);
    expect(suggests(r)).toBe(false);
  });
});

// ── 6차 리뷰 (K1~K5) ─────────────────────────────

describe('K1 가계부의 환불 기록 — 이름 맞는 짝 먼저, 늦게 적은 환불은 근거가 있을 때만', () => {
  const octCancel = [row('2026-10-05', '스타벅스 성수점', 4500), row('2026-10-27', '캐치테이블 예약금', 10000), row('2026-10-28', '캐치테이블 예약금', -10000)];

  test.each(['2026-11-25', '2026-12-08'])('승인 기록만 있는 취소 — 뒤에 적은 다른 가게 같은 금액 환불(%s)을 짝으로 쓰지 않고 승인 삭제를 권한다', (refundDate) => {
    const db = makeDb();
    add(db, { date: '2026-10-05', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-10-27', detail: '캐치테이블 예약금', amount: 10000 });
    add(db, { date: refundDate, detail: '공연 예매 취소', amount: -10000 });
    const r = runOct(db, octCancel, '2026-12-20');
    expect(r.cancelled.map(c => c.tx && c.tx.detail)).toEqual(['캐치테이블 예약금']);
    expect(r.matched.map(m => m.tx.detail)).toEqual(['스타벅스']);
  });

  test('그 환불 기록은 다음 달 명세서의 취소 행과 짝짓는다 (같은 기록을 두 명세서가 쓰지 않게)', () => {
    const db = makeDb();
    add(db, { date: '2026-11-25', detail: '공연 예매 취소', amount: -10000 });
    add(db, { date: '2026-11-03', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    const r = reconcileStatement(db, {
      paymentMethod: CARD,
      ...normalizeStatement({ period_from: '2026-11-01', period_to: '2026-11-30', rows: [row('2026-11-03', '스타벅스 성수점', 4500), row('2026-11-25', '인터파크티켓', -10000)] }, '2026-12-20'),
    });
    expect(r.matched.map(m => [m.tx.detail, m.nameDiffers])).toEqual([['스타벅스', false], ['공연 예매 취소', true]]);
    expect(allGood(r)).toBe(true);
  });

  test('승인 기록을 지운 사용자 — 다음 달의 다른 가게 환불도, 다른 반품의 같은 가게 환불도 짝으로 쓰지 않는다', () => {
    const rows = [row('2026-10-05', '스타벅스 성수점', 4500), row('2026-10-27', '쿠팡(주)', 30000), row('2026-10-29', '쿠팡(주)', -30000)];
    const db = makeDb();
    add(db, { date: '2026-10-05', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-11-20', detail: '올리브영 환불', amount: -30000 });
    const r = runOct(db, rows, '2026-12-10');
    expect(r.missing).toEqual([]);
    expect(allGood(r)).toBe(true);

    const db2 = makeDb();
    add(db2, { date: '2026-10-05', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db2, { date: '2026-11-12', detail: '쿠팡', amount: 30000 });
    add(db2, { date: '2026-11-18', detail: '쿠팡 환불', amount: -30000 });   // 11/12 결제의 환불
    const r2 = runOct(db2, rows, '2026-12-10');
    expect(r2.missing).toEqual([]);
    expect(allGood(r2)).toBe(true);
  });

  test('같은 금액 취소 행이 둘이면 이름 맞는 환불 기록을 그 가게 취소가 먼저 가져간다', () => {
    const db = makeDb();
    add(db, { date: '2026-09-15', detail: '올리브영', amount: 30000 });
    add(db, { date: '2026-10-20', detail: '올리브영 환불', amount: -30000 });
    const r = runOct(db, [row('2026-10-10', '쿠팡(주)', 30000), row('2026-10-11', '쿠팡(주)', -30000), row('2026-10-20', '올리브영 성수', -30000)]);
    expect(r.matched.map(m => [m.row.merchant, m.tx.detail])).toEqual([['올리브영 성수', '올리브영 환불']]);
    expect(r.cancelled.map(c => [c.approval.merchant, c.tx])).toEqual([['쿠팡(주)', null]]);
    expect(r.missing).toEqual([]);
  });
});

describe('K2 환불 행을 미리 체크하는 근거', () => {
  test('반품 신청일(읽는 범위 앞)에 미리 적은 같은 가게 환불이 있으면 비슷한 기록으로 알리고 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-09-10', detail: '쿠팡', amount: 30000 });
    add(db, { date: '2026-09-22', detail: '쿠팡 환불', amount: -30000 });
    const r = runOct(db, [row('2026-10-03', '쿠팡(주)', -30000)]);
    expect(r.missing.map(m => [m.autoCheck, m.cautions, m.similarTx && m.similarTx.date])).toEqual([[false, ['similar'], '2026-09-22']]);
  });

  test('같은 가게·같은 금액 결제가 둘 이상(정기 구매)이면 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-07-29', detail: '쿠팡 생수', amount: 23900 });
    add(db, { date: '2026-08-28', detail: '쿠팡 생수', amount: 23900 });
    const r = runOct(db, [row('2026-10-02', '쿠팡(주)', -23900)]);
    expect(r.missing.map(m => [m.autoCheck, m.cautions])).toEqual([[false, ['manyOriginals']]]);
  });
});

describe('K3·K4·K5', () => {
  test('경계 ±2일에 같은 가게·같은 금액 기록이 있는 카드 건의 금액 차이는 고치기를 권하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-09-30', detail: 'GS25', amount: 5800 });   // 10/2 결제를 이틀 앞에 적음
    add(db, { date: '2026-10-01', detail: 'GS25', amount: 1300 });   // 9/30 결제를 하루 뒤에 적음
    const r = runOct(db, [row('2026-10-02', 'GS25 성수역점', 5800)]);
    expect(r.mismatched.map(m => [m.ledgerTotal, m.namelessNear.map(t => t.date), m.fixable])).toEqual([[1300, ['2026-09-30'], false]]);
  });

  test('AI가 고른 입력 습관 표기("메가커피")로 같은 금액 결제를 짝짓는다 — 금액이 다르면 고치기를 권하지 않는다', () => {
    const db = makeDb();
    const rows = [];
    ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-13', '2026-10-14'].forEach(d => {
      add(db, { date: d, detail: '메가커피', amount: 2000, sub_category: '커피' });
      rows.push(row(d, '메가엠지씨커피 성수점', 2000, { detail: '메가커피' }));
    });
    const r = runOct(db, rows);
    expect(r.matched).toHaveLength(5);
    expect(allGood(r)).toBe(true);

    const db2 = makeDb();
    add(db2, { date: '2026-10-06', detail: '메가커피', amount: 2500, sub_category: '커피' });
    const r2 = runOct(db2, [row('2026-10-06', '메가엠지씨커피 성수점', 2000, { detail: '메가커피' })]);
    expect(r2.mismatched).toEqual([]);
    expect(r2.missing.map(m => m.autoCheck)).toEqual([false]);
  });

  test('일반어 습관 표기("점심")는 짝짓기 별칭으로 쓰지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-05', detail: '점심', amount: 8000 });
    add(db, { date: '2026-10-05', detail: '점심', amount: 8000 });
    const r = runOct(db, [row('2026-10-05', '김밥천국 성수점', 8000, { detail: '점심' })]);
    expect(r.matched).toEqual([]);                     // 같은 금액 이름 없는 기록이 둘 — 어느 것인지 모른다
  });

  test('부분취소 — 카드의 결제를 가계부에 다 적었으면 취소 행을 그 결제의 부분취소로 안내하되 체크하지 않는다 (지난 결제의 환불일 수도)', () => {
    const db = makeDb();
    add(db, { date: '2026-10-05', detail: '쿠팡', amount: 90000 });
    const r = runOct(db, [row('2026-10-05', '쿠팡(주)', 90000), row('2026-10-08', '쿠팡(주)', -30000)]);
    expect(r.missing.map(m => [m.autoCheck, m.cautions, m.partialOfRow && m.partialOfRow.amount])).toEqual([[false, ['partialRecorded'], 90000]]);
  });
});

// ── 7차 리뷰 (M1·M2) ─────────────────────────────

describe('M1·M2 기간 밖 환불 기록 — 사이 결제가 있으면 짝짓지 않고, 후보 전체를 날짜 차이순으로 배정', () => {
  test('10/1 취소(9/28 예약금)의 환불을 안 적었으면, 11/2 환불(10/29 예약금의 것)을 가져가지 않고 "가계부에 없음"으로 보인다', () => {
    const db = makeDb();
    add(db, { date: '2026-09-28', detail: '캐치테이블 예약금', amount: 10000 });
    add(db, { date: '2026-10-05', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-10-29', detail: '캐치테이블 예약금', amount: 10000 });
    add(db, { date: '2026-11-02', detail: '캐치테이블 환불', amount: -10000 });
    const r = runOct(db, [row('2026-10-01', '캐치테이블', -10000), row('2026-10-05', '스타벅스 성수점', 4500), row('2026-10-29', '캐치테이블', 10000)]);
    expect(r.missing.map(m => [m.row.date, m.autoCheck, m.refundOf && m.refundOf.date])).toEqual([['2026-10-01', true, '2026-09-28']]);
    const nov = reconcileStatement(db, { paymentMethod: CARD, ...normalizeStatement({ period_from: '2026-11-01', period_to: '2026-11-30', rows: [row('2026-11-02', '캐치테이블', -10000)] }, '2026-12-08') });
    expect(nov.matched.map(m => m.tx.date)).toEqual(['2026-11-02']);
  });

  test('9월 명세서에서 짝지은 9/29 환불을 10/3 취소(9/30 결제)가 가져가지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-09-25', detail: 'KTX', amount: 45000 });
    add(db, { date: '2026-09-29', detail: 'KTX 환불', amount: -45000 });
    add(db, { date: '2026-09-30', detail: 'KTX', amount: 45000 });
    add(db, { date: '2026-10-05', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    const r = runOct(db, [row('2026-10-03', 'KTX 코레일', -45000), row('2026-10-05', '스타벅스 성수점', 4500)]);
    expect(r.matched.map(m => m.row.amount)).toEqual([4500]);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck])).toEqual([[-45000, false]]);   // 같은 금액 결제가 둘 — 확인만
  });

  test('가게 이름 없는 환불 기록은 날짜가 가까운 취소가 가져간다 (먼저 오는 다른 가게 취소가 아니라)', () => {
    const db = makeDb();
    add(db, { date: '2026-10-15', detail: '쿠팡', amount: 30000 });
    add(db, { date: '2026-10-20', detail: '반품 환불', amount: -30000 });
    const r = runOct(db, [row('2026-10-03', '올리브영 성수', 30000), row('2026-10-05', '올리브영 성수', -30000), row('2026-10-15', '쿠팡(주)', 30000), row('2026-10-20', '쿠팡(주)', -30000)]);
    expect(r.matched.map(m => [m.row.merchant, m.row.amount, m.tx.detail])).toEqual([['쿠팡(주)', 30000, '쿠팡'], ['쿠팡(주)', -30000, '반품 환불']]);
    expect(r.cancelled.map(c => [c.approval.merchant, c.tx])).toEqual([['올리브영 성수', null]]);
    expect(r.missing).toEqual([]);
  });

  test('사이 결제 때문에 짝짓지 않은 기간 밖 같은 가게 환불 기록이 있으면 승인 기록 삭제를 권하지 않고 확인만 띄운다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-27', detail: '캐치테이블 예약금', amount: 10000 });
    add(db, { date: '2026-11-01', detail: '캐치테이블 예약금', amount: 10000 });
    add(db, { date: '2026-11-03', detail: '캐치테이블 예약금 환불', amount: -10000 });   // 11/1 예약금의 환불일 수도, 이 취소의 늦은 기록일 수도
    const r = runOct(db, [row('2026-10-27', '캐치테이블', 10000), row('2026-10-28', '캐치테이블', -10000)]);
    expect(r.cancelled.map(c => [c.tx, c.maybeTx && c.maybeTx.date])).toEqual([[null, '2026-10-27']]);
    expect(suggests(r)).toBe(false);
  });
});

// ── 8차 리뷰 (N1·N2·N4·N5) ─────────────────────────────

describe('N1 금액이 다른 취소 — 카드 안의 같은 가게 승인과 함께 다룬다', () => {
  const ktx = () => [row('2026-10-14', '코레일 KTX', -44600), row('2026-10-09', '코레일 KTX', 45000), row('2026-10-05', '스타벅스 성수점', 4500)];
  const octSum = db => getTransactions(db, { payment_method: CARD }).filter(t => t.date >= '2026-10-01' && t.date <= '2026-10-31').reduce((s, t) => s + t.amount, 0);

  test('KTX 45,000 → 취소 −44,600, 가계부에 둘 다 없으면 둘 다 미리 체크해 순액이 맞는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-05', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    const r = runOct(db, ktx());
    expect(r.missing.map(m => [m.row.amount, m.autoCheck]).sort((a, b) => a[0] - b[0])).toEqual([[-44600, true], [45000, true]]);
    pressRecommended(db, r);
    expect(octSum(db)).toBe(4900);
  });

  test.each(['KTX 취소수수료', '코레일 취소수수료'])('가계부에 순액("%s" 400)만 적었으면 부분취소 반영으로 일치', (detail) => {
    const db = makeDb();
    add(db, { date: '2026-10-05', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-10-14', detail, amount: 400 });
    const r = runOct(db, ktx());
    expect(r.grouped.map(g => [g.kind, g.rows.map(x => x.amount), g.txs.map(t => t.amount)])).toEqual([['partialCancel', [45000, -44600], [400]]]);
    expect(allGood(r)).toBe(true);
  });

  test('쿠팡 90,000 중 −60,000 부분취소 — 둘 다 없으면 둘 다 미리 체크, 결제를 적었으면 취소를 안내만', () => {
    const rows = [row('2026-10-12', '쿠팡(주)', -60000), row('2026-10-10', '쿠팡(주)', 90000)];
    const db = makeDb();
    const r = runOct(db, rows);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck, (m.partialOfRow || m.partialCancelRow).amount])).toEqual([[-60000, true, 90000], [90000, true, -60000]]);

    const db2 = makeDb();
    add(db2, { date: '2026-10-10', detail: '쿠팡', amount: 90000 });
    const r2 = runOct(db2, rows);
    expect(r2.missing.map(m => [m.row.amount, m.autoCheck, m.cautions])).toEqual([[-60000, false, ['partialRecorded']]]);
  });

  test('해외결제 취소의 원화가 환율 차이로 달라도 같은 외화 금액이면 짝 — 둘 다 없으면 둘 다, 환불 기록이 따로 있으면 체크하지 않는다', () => {
    const fx = (date, amount, fa) => row(date, 'AMAZON.COM', amount, { currency: 'USD', foreign_amount: fa });
    const rows = [fx('2026-10-12', 135200, 100), fx('2026-10-15', -133900, -100)];
    const st = normalizeStatement({ rows }, TODAY);
    expect(st.rows.map(x => x.foreignAmount)).toEqual([100, 100]);

    const r = runOct(makeDb(), rows);
    expect(r.missing.map(m => m.autoCheck)).toEqual([true, true]);

    const db3 = makeDb();
    add(db3, { date: '2026-10-12', detail: 'AMAZON 이어폰', amount: 135200 });
    add(db3, { date: '2026-10-15', detail: 'AMAZON 환불', amount: -135200 });
    const r3 = runOct(db3, rows);
    expect(r3.missing.map(m => [m.autoCheck, m.cautions])).toEqual([[false, ['similar', 'partialRecorded']]]);
  });

  test('결제가 금액 차이로 남았으면 고치기를 권하지 않고, 취소 행은 결제 기록을 확인하라고 한다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-10', detail: '쿠팡', amount: 85000 });
    const r = runOct(db, [row('2026-10-10', '쿠팡(주)', 90000), row('2026-10-12', '쿠팡(주)', -60000)]);
    expect(r.mismatched.map(m => [m.cautions, m.fixable, m.partialCancelRow.amount])).toEqual([[['partialCancel'], false, -60000]]);
    expect(r.missing.map(m => [m.autoCheck, m.cautions])).toEqual([[false, ['partialCheck']]]);
  });

  test('승인이나 취소에 주의가 있으면 둘 다 체크하지 않는다 (승인만 추가되지 않게)', () => {
    const db = makeDb();
    add(db, { date: '2026-10-11', detail: '쿠팡', amount: 90000, payment_method: '카카오페이' });
    const r = runOct(db, [row('2026-10-10', '쿠팡(주)', 90000), row('2026-10-12', '쿠팡(주)', -60000)]);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck, m.cautions])).toEqual([[90000, false, ['otherMethod', 'partialCancelled']], [-60000, false, []]]);
  });
});

describe('N2·N4·N5', () => {
  test('기간을 못 읽었을 때 할부 원거래 행은 범위를 넓히지 않는다 — 그 사이 기록이 "카드에 없음"으로 넘치지 않게', () => {
    const db = makeDb();
    ['2026-08-08', '2026-09-12', '2026-10-17'].forEach(d => add(db, { date: d, detail: '스타벅스', amount: 4500, sub_category: '커피' }));
    add(db, { date: '2026-07-03', detail: '삼성 냉장고', amount: 1200000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-11-02', detail: 'GS25', amount: 3000 });
    const r = runNoPeriod(db, [row('2026-11-02', 'GS25 성수역점', 3000), row('2026-07-03', '삼성전자 디지털프라자', 1200000, { installment: '12개월 중 5회' })]);
    expect(r.period).toEqual({ from: '2026-11-02', to: '2026-11-02' });
    expect(r.matched).toHaveLength(2);
    expect(r.notOnCard).toEqual([]);
  });

  test('확인만 띄우는 취소 건에 그렇게 본 근거(기간 밖 같은 금액 환불 기록)를 싣는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-27', detail: '캐치테이블 예약금', amount: 10000 });
    add(db, { date: '2026-11-01', detail: '캐치테이블 예약금', amount: 10000 });
    add(db, { date: '2026-11-03', detail: '캐치테이블 예약금 환불', amount: -10000 });
    const r = runOct(db, [row('2026-10-27', '캐치테이블', 10000), row('2026-10-28', '캐치테이블', -10000)]);
    expect(r.cancelled.map(c => [c.tx, c.doubtTx && c.doubtTx.date])).toEqual([[null, '2026-11-03']]);
  });

  test('같은 날·같은 가게·같은 금액 취소가 두 줄이면 짝 없는 같은 금액 승인을 미리 체크하지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-09-28', detail: '쿠팡', amount: 30000 });
    add(db, { date: '2026-10-12', detail: '쿠팡 반품 환불', amount: -30000 });
    const r = runOct(db, [row('2026-10-12', '쿠팡(주)', -30000), row('2026-10-10', '쿠팡(주)', 30000), row('2026-10-12', '쿠팡 주식회사 반품', -30000)]);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck, m.cautions])).toEqual([[30000, false, ['cancelDup']], [-30000, false, ['duplicate']]]);
  });
});

// ── 9차 리뷰 (P1~P5) ─────────────────────────────

describe('P1~P5 금액이 다른 취소 마무리', () => {
  const fxRow = (date, amount, fa) => row(date, 'AMAZON.COM', amount, fa === undefined ? {} : { currency: 'USD', foreign_amount: fa });

  test.each([
    ['취소 행에 외화 없음', fxRow('2026-10-12', 135200, 100), fxRow('2026-10-15', -136500)],
    ['승인 행에 외화 없음', fxRow('2026-10-12', 135200), fxRow('2026-10-15', -136500, -100)],
  ])('해외결제 취소의 원화가 환율 상승으로 더 커도(±10%) 승인과 짝 — %s', (label, approval, cancel) => {
    const db = makeDb();
    const r = runOct(db, [approval, cancel]);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck])).toEqual([[135200, true], [-136500, true]]);
    pressRecommended(db, r);
    expect(ledgerSum(db)).toBe(-1300);
    expect(allGood(runOct(db, [approval, cancel]))).toBe(true);
  });

  test('해외결제 환불의 원래 결제가 가계부에 있으면 원화가 ±10% 달라도 원래 결제로 본다', () => {
    const db = makeDb();
    add(db, { date: '2026-09-20', detail: 'AMAZON 이어폰', amount: 135200 });
    const r = runOct(db, [fxRow('2026-10-05', -136500, -100)]);
    expect(r.missing.map(m => [m.autoCheck, m.cautions, m.refundOf && m.refundOf.date])).toEqual([[true, [], '2026-09-20']]);
  });

  test('승인과 짝지은 취소라도 같은 가게·같은 금액 환불 기록이 미리 적혀 있으면 비슷한 기록으로 알린다', () => {
    const db = makeDb();
    add(db, { date: '2026-09-10', detail: '쿠팡', amount: 50000 });
    add(db, { date: '2026-09-22', detail: '쿠팡 반품', amount: -20000 });
    const r = runOct(db, [row('2026-10-08', '쿠팡(주)', -20000), row('2026-10-05', '쿠팡(주)', 30000)]);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck, m.cautions, m.similarTx && m.similarTx.date]))
      .toEqual([[-20000, false, ['similar'], '2026-09-22'], [30000, false, ['partialCancelled'], null]]);
  });

  test('한 주문을 두 번 부분취소 — 가계부에 없으면 셋 다 미리 체크, 순액 하나로 적었으면 부분취소 반영으로 일치', () => {
    const rows = [row('2026-10-14', '쿠팡(주)', -30000), row('2026-10-12', '쿠팡(주)', -20000), row('2026-10-10', '쿠팡(주)', 90000)];
    const db = makeDb();
    const r = runOct(db, rows);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck])).toEqual([[-30000, true], [-20000, true], [90000, true]]);
    expect(r.missing[2].partialCancelRows.map(c => c.amount)).toEqual([-20000, -30000]);
    pressRecommended(db, r);
    expect(ledgerSum(db)).toBe(40000);

    const db2 = makeDb();
    add(db2, { date: '2026-10-10', detail: '쿠팡', amount: 40000 });
    const r2 = runOct(db2, rows);
    expect(r2.grouped.map(g => [g.kind, g.rows.map(x => x.amount)])).toEqual([['partialCancel', [90000, -30000, -20000]]]);
    expect(allGood(r2)).toBe(true);
  });

  test('기간 없는 캡처의 맨 끝 행이 새 할부 결제여도 범위 끝은 그 날까지', () => {
    const db = makeDb();
    add(db, { date: '2026-10-01', detail: '스타벅스', amount: 4500, sub_category: '커피' });
    add(db, { date: '2026-10-16', detail: '삼성 냉장고', amount: 1200000, budget_category: '쇼핑', sub_category: '생활용품' });
    add(db, { date: '2026-10-16', detail: '올리브영', amount: 18000 });
    const r = runNoPeriod(db, [row('2026-10-16', '삼성전자 디지털프라자', 1200000, { installment: '12개월' }), row('2026-10-01', '스타벅스 성수점', 4500)]);
    expect(r.period).toEqual({ from: '2026-10-01', to: '2026-10-16' });
    expect(r.notOnCard.map(t => t.detail)).toEqual(['올리브영']);
  });

  test('다른 승인과 묶인 취소는 이 승인의 부분취소로 붙이지 않는다', () => {
    const db = makeDb();
    add(db, { date: '2026-10-03', detail: '쿠팡', amount: 20000 });
    const r = runOct(db, [row('2026-10-09', '쿠팡(주)', -10000), row('2026-10-08', '쿠팡(주)', 50000), row('2026-10-03', '쿠팡(주)', 30000)]);
    expect(r.grouped.map(g => g.rows.map(x => x.amount))).toEqual([[30000, -10000]]);
    expect(r.missing.map(m => [m.row.amount, m.autoCheck, m.partialCancelRow])).toEqual([[50000, true, null]]);
  });
});
