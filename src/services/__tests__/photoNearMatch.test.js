// 사진 목록의 수정 권장 (I-065) — 카드 이용내역을 읽었을 때, 가계부에 금액·날짜를 조금 다르게 적은 같은 결제를 찾아
// 새로 넣지 않고 그 기록을 사진대로 고치게 권한다. 나눠·합쳐 적은 기록은 이미 있는 거래로 본다.
import initSqlJs from 'sql.js';
import { createDatabase, addTransaction, correctTransaction, getTransactions } from '../dbManager';
import {
  markDuplicates, canFixNear, suggestFixNear, nearFix, NEAR_CAUTION, NEAR_BLOCKED,
} from '../photoEntry';
import { todayStr, addDays } from '../dateUtils';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const TODAY = todayStr();
const D = addDays(TODAY, -10);

function makeDb() {
  const { db } = createDatabase(SQL, null);
  db.run('DELETE FROM payment_methods');
  ['현대EV', '신한카드', '현금'].forEach((n, i) => db.run('INSERT INTO payment_methods (name, sort_order) VALUES (?, ?)', [n, i]));
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('식비', 0), ('생활', 1)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('식비', '카페', 0), ('생활', '생필품', 0)");
  return db;
}

const tx = (db, over = {}) => addTransaction(db, {
  payment_method: '현대EV', date: D, budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 6000, ...over,
});
// 사진에서 읽은 한 줄 (buildSuggestion 모양 중 대조에 쓰는 칸)
const row = (over = {}) => ({
  date: D, merchant: '스타벅스 강남점', detail: '스타벅스', amount: 6500, payment_method: '현대EV',
  sources: { date: 'receipt' }, warnings: [], foreignAmount: null, installment: '', ...over,
});
const mark = (db, rows) => markDuplicates(db, rows);
// 사진이 D-2 ~ D+2를 보여 주게 하는 앞뒤 결제 — 사진의 첫날·끝날은 잘렸을 수 있어(edge) 그 사이 날짜로 시험한다
const FRAME = [
  row({ date: addDays(D, -2), merchant: '교보문고', detail: '교보문고', amount: 12000 }),
  row({ date: addDays(D, 2), merchant: '올리브영', detail: '올리브영', amount: 5000 }),
];

describe('금액이 다른 같은 결제', () => {
  test('같은 가게·같은 결제수단·같은 날인데 금액이 다르면 넣지 않고 그 기록을 사진 금액으로 고치기를 권한다', () => {
    const db = makeDb();
    const id = tx(db);
    const [s] = mark(db, [row(), ...FRAME]);
    expect(s.duplicateOf).toBeNull();
    expect(s.nearOf).toEqual(expect.objectContaining({ kind: 'amount', blocked: '', cautions: [] }));
    expect(s.nearOf.txs).toEqual([expect.objectContaining({ id, amount: 6000, date: D, detail: '스타벅스' })]);
    expect(suggestFixNear(s)).toBe(true);
    expect(nearFix(s)).toEqual({ id, amount: 6500, date: D });
  });

  test('하루 차이면 날짜도 사진대로 고친다 — 이틀 넘게 차이 나면 금액이 다른 기록은 같은 결제로 보지 않는다', () => {
    const db = makeDb();
    const id = tx(db, { date: addDays(D, -1) });
    const [s] = mark(db, [row(), ...FRAME]);
    expect(nearFix(s)).toEqual({ id, amount: 6500, date: D });
    expect(suggestFixNear(s)).toBe(true);

    const far = makeDb();
    tx(far, { date: addDays(D, -2) });
    expect(mark(far, [row()])[0].nearOf).toBeNull();
  });

  test('다른 가게·다른 결제수단·간편결제 이름뿐·일반어(점심)로 적은 기록은 같은 결제로 보지 않는다', () => {
    const db = makeDb();
    tx(db, { detail: '스타필드' });                          // 앞 두 글자만 같은 다른 가게
    tx(db, { payment_method: '신한카드' });                  // 다른 카드
    tx(db, { detail: '점심', amount: 9000 });
    tx(db, { detail: '네이버페이', amount: 12000 });
    const [a, b, c] = mark(db, [
      row(),
      row({ merchant: '김밥천국', detail: '점심', amount: 8000 }),
      row({ merchant: '네이버페이', detail: '', amount: 15000 }),
    ]);
    expect([a.nearOf, b.nearOf, c.nearOf]).toEqual([null, null, null]);
  });

  test('사진 줄에 결제수단이 없으면(간편결제·카드 안 보임) 결제수단은 따지지 않는다', () => {
    const db = makeDb();
    tx(db, { payment_method: '신한카드' });
    expect(mark(db, [row({ payment_method: '' })])[0].nearOf).toEqual(expect.objectContaining({ kind: 'amount' }));
  });

  test('정확히 같은 거래가 먼저 짝지어지고, 남은 기록만 수정 권장 — 한 기록은 한 줄하고만', () => {
    const db = makeDb();
    const exact = tx(db, { amount: 4500 });
    const off = tx(db, { amount: 6400 });
    const [a, b, c] = mark(db, [row({ amount: 4500 }), row({ amount: 6500 }), row({ amount: 7000 })]);
    expect(a.duplicateOf).toEqual(expect.objectContaining({ id: exact }));
    expect(b.nearOf.txs[0].id).toBe(off);
    expect(c.nearOf).toBeNull();
    // 이 기록(6,400)은 두 줄의 후보였다 — 어느 짝인지 확실하지 않아 미리 고르지 않는다
    expect(b.nearOf.cautions).toContain('many');
    expect(suggestFixNear(b)).toBe(false);
    expect(canFixNear(b)).toBe(true);
  });

  test('할인 뒤 금액이 사진 금액과 같으면 이미 넣은 거래다 (영수증은 할인 뒤 금액)', () => {
    const db = makeDb();
    const id = tx(db, { amount: 10000, discount_amount: 1000 });
    const [s] = mark(db, [row({ amount: 9000 })]);
    expect(s.duplicateOf).toEqual(expect.objectContaining({ id }));
    expect(s.nearOf).toBeNull();
  });

  test('날짜를 읽지 못해 오늘로 둔 줄·앞날짜·외화 결제는 짝짓지 않는다 — 믿을 수 없는 값으로 기록을 고치지 않게', () => {
    const db = makeDb();
    tx(db, { date: TODAY });
    tx(db, { date: addDays(TODAY, 1) });
    tx(db);
    const [a, b, c] = mark(db, [
      row({ date: TODAY, sources: { date: 'today' } }),
      row({ date: addDays(TODAY, 1) }),
      row({ foreignAmount: 5, currency: 'USD' }),
    ]);
    expect([a.nearOf, b.nearOf, c.nearOf]).toEqual([null, null, null]);
  });

  test('외화로 적은 기록·현금 잔액 맞춤은 고칠 기록으로 보지 않는다', () => {
    const db = makeDb();
    tx(db, { foreign_amounts: { USD: 5 } });
    tx(db, { is_cash_adjustment: 1, payment_method: '현대EV' });
    expect(mark(db, [row()])[0].nearOf).toBeNull();
  });
});

describe('날짜만 다른 같은 결제', () => {
  test('금액이 같고 날짜가 1~3일 다르면 날짜만 사진대로 고치기를 권한다 (할인은 그대로)', () => {
    const db = makeDb();
    const id = tx(db, { date: addDays(D, -2), amount: 10000, discount_amount: 1000 });
    const [s] = mark(db, [row({ amount: 9000 })]);   // 할인 뒤 금액으로 읽음
    expect(s.nearOf).toEqual(expect.objectContaining({ kind: 'date', cautions: ['edge'] }));
    expect(nearFix(s)).toEqual({ id, amount: 10000, date: D });  // 금액은 기록 그대로
  });

  test('사진 날짜 사이의 기록이면 미리 고르고, 사진 밖이나 첫날·끝날이면(잘린 다른 결제일 수 있음) 고르지 않는다', () => {
    const db = makeDb();
    tx(db, { date: addDays(D, -1) });
    const [inside] = mark(db, [row({ amount: 6000 }), ...FRAME]);
    expect(inside.nearOf).toEqual(expect.objectContaining({ kind: 'date', cautions: [] }));
    expect(suggestFixNear(inside)).toBe(true);
    const [outside] = mark(db, [row({ amount: 6000 })]);
    expect(outside.nearOf.cautions).toEqual(['edge']);
    expect(NEAR_CAUTION.edge).toBeTruthy();
    // 사진이 그 기록의 날(D-1)부터 시작하면 — 그날 결제가 위로 잘렸을 수 있다
    const [boundary] = mark(db, [row({ amount: 6000, date: addDays(D, 1) }), row({ date: addDays(D, -1), merchant: '이마트', detail: '이마트', amount: 30000 })]);
    expect(boundary.nearOf.cautions).toEqual(['edge']);
  });

  test('날짜를 읽지 못해 오늘로 둔 줄은 사진 날짜 범위를 넓히지 않는다', () => {
    const db = makeDb();
    tx(db, { date: addDays(D, 2) });
    const unread = row({ date: TODAY, sources: { date: 'today' }, merchant: '이마트', detail: '이마트', amount: 30000 });
    const [s] = mark(db, [row({ amount: 6000 }), FRAME[0], unread]);
    expect(s.nearOf.cautions).toContain('edge');   // 사진은 D-2 ~ D — D+2의 기록은 사진 밖
  });

  test('같은 곳·같은 금액을 자주 결제했으면(버스·커피) 어느 날 것인지 몰라 미리 고르지 않는다', () => {
    const db = makeDb();
    tx(db, { date: addDays(D, -1), detail: '버스', amount: 1500, budget_category: '생활', sub_category: '생필품' });
    tx(db, { date: addDays(D, -3), detail: '버스', amount: 1500, budget_category: '생활', sub_category: '생필품' });
    const bus = { merchant: '서울버스', detail: '버스', amount: 1500 };
    // '버스'는 일반어라 이름으로 보지 않는다 — 가게 이름이 분명한 경우로
    const [s] = mark(db, [row({ ...bus, detail: '' })]);
    expect(s.nearOf).toBeNull();
    const cafe = makeDb();
    tx(cafe, { date: addDays(D, -1), detail: '메가커피', amount: 2000 });
    tx(cafe, { date: addDays(D, -4), detail: '메가커피', amount: 2000 });
    const [m] = mark(cafe, [row({ merchant: '메가MGC커피', detail: '메가커피', amount: 2000 }), row({ date: addDays(D, -1), merchant: '이마트', detail: '이마트', amount: 100 })]);
    expect(m.nearOf).toEqual(expect.objectContaining({ kind: 'date' }));
    expect(m.nearOf.cautions).toContain('repeat');
    expect(suggestFixNear(m)).toBe(false);
  });
});

describe('나눠·합쳐 적은 기록은 이미 있는 거래', () => {
  test('한 결제를 가계부에 나눠 적었으면(합이 같음) 이미 있는 거래로 보고 고치기를 권하지 않는다 (B-062처럼 이중 계산 방지)', () => {
    const db = makeDb();
    tx(db, { detail: '이마트 장보기', amount: 20000, budget_category: '식비' });
    tx(db, { detail: '이마트 세제', amount: 10000, budget_category: '생활', sub_category: '생필품' });
    const [s] = mark(db, [row({ merchant: '(주)이마트 성수점', detail: '이마트', amount: 30000 })]);
    expect(s.nearOf).toEqual(expect.objectContaining({ kind: 'split' }));
    expect(s.nearOf.txs.map(t => t.amount).sort()).toEqual([10000, 20000]);
    expect(canFixNear(s)).toBe(false);
  });

  test('여러 결제를 가계부에 한 건으로 합쳐 적었으면 그 줄들은 모두 이미 있는 거래', () => {
    const db = makeDb();
    tx(db, { amount: 9500 });
    const [a, b, c] = mark(db, [row({ amount: 4500 }), row({ amount: 5000 }), row({ merchant: '이마트', detail: '이마트', amount: 3000 })]);
    expect([a.nearOf?.kind, b.nearOf?.kind, c.nearOf]).toEqual(['merged', 'merged', null]);
    expect(canFixNear(a)).toBe(false);
  });

  test('나눠 적은 나머지를 다른 이름으로 적었으면(차액과 같은 기록) 고치면 이중 계산 — 미리 고르지 않는다', () => {
    const db = makeDb();
    tx(db, { detail: '이마트', amount: 20000 });
    tx(db, { detail: '세제', amount: 10000, budget_category: '생활', sub_category: '생필품' });
    const [s] = mark(db, [row({ merchant: '이마트', detail: '이마트', amount: 30000 })]);
    expect(s.nearOf).toEqual(expect.objectContaining({ kind: 'amount' }));
    expect(s.nearOf.cautions).toContain('rest');
    expect(suggestFixNear(s)).toBe(false);
  });
});

describe('고칠 수 없거나 망설일 이유', () => {
  test('나눠 결제한 한 몫이면 여기서 고치지 않는다 — 거래내역에서 묶음 전체를 고치게', () => {
    const db = makeDb();
    tx(db, { amount: 3000, split_group_id: 'g1' });
    const [s] = mark(db, [row()]);
    expect(s.nearOf.blocked).toBe('split');
    expect(canFixNear(s)).toBe(false);
    expect(nearFix(s)).toBeNull();
    expect(NEAR_BLOCKED.split).toBeTruthy();
  });

  test('할부 결제는 달마다 나눠 적었을 수 있어 미리 고르지 않는다', () => {
    const db = makeDb();
    tx(db, { amount: 280000 });
    const [s] = mark(db, [row({ amount: 300000, installment: '3개월' }), ...FRAME]);
    expect(s.nearOf.cautions).toEqual(['installment']);
    expect(canFixNear(s)).toBe(true);
    expect(suggestFixNear(s)).toBe(false);
  });

  test('할인이 사진 금액보다 크면 고치지 않는다 (순지출이 음수가 된다) — 날짜만 고칠 때는 상관없다', () => {
    const db = makeDb();
    tx(db, { amount: 6000, discount_amount: 3000 });
    const [s] = mark(db, [row({ amount: 2000 })]);
    expect(s.nearOf.blocked).toBe('discount');
    const dated = makeDb();
    tx(dated, { date: addDays(D, -1), amount: 6000, discount_amount: 3000 });
    const [d] = mark(dated, [row({ amount: 3000 }), ...FRAME]);  // 할인 뒤 금액으로 읽음
    expect(d.nearOf).toEqual(expect.objectContaining({ kind: 'date', blocked: '' }));
  });

  test('금액 차이가 크면(1,000원·20%를 넘음) 다른 결제이거나 내 몫만 적은 것일 수 있어 미리 고르지 않는다', () => {
    const db = makeDb();
    tx(db, { detail: '스타벅스 카드충전', amount: 50000 });
    const [charge] = mark(db, [row({ amount: 4500 }), ...FRAME]);
    expect(charge.nearOf.cautions).toEqual(['far']);
    expect(suggestFixNear(charge)).toBe(false);
    const half = makeDb();
    tx(half, { detail: '한우마을', amount: 20000 });             // 반반 낸 내 몫
    const [mine] = mark(half, [row({ merchant: '한우마을', detail: '한우마을', amount: 40000 }), ...FRAME]);
    expect(mine.nearOf.cautions).toEqual(['far']);
    // 오타 범위 안이면 권한다
    const typo = makeDb();
    tx(typo, { amount: 45000 });
    expect(suggestFixNear(mark(typo, [row({ amount: 54000 }), ...FRAME])[0])).toBe(true);
  });

  test('사진의 첫날에 따로 결제한 같은 가게 기록(잘려서 사진에 없음)은 미리 고치지 않는다', () => {
    const db = makeDb();
    tx(db, { amount: 5200 });
    const [s] = mark(db, [
      row({ amount: 4500 }),
      row({ date: addDays(D, 1), merchant: '교보문고', detail: '교보문고', amount: 12000 }),
      row({ date: addDays(D, 2), merchant: '올리브영', detail: '올리브영', amount: 5000 }),
    ]);
    expect(s.nearOf.cautions).toContain('edge');
    expect(suggestFixNear(s)).toBe(false);
  });
});

describe('correctTransaction — 사진대로 금액·날짜만 고친다', () => {
  test('분류·세부내역·할인·누가는 그대로, 금액·날짜만 바꾼다. 없는 거래면 false', () => {
    const db = makeDb();
    const id = tx(db, { discount_amount: 500, member: '아내' });
    expect(correctTransaction(db, id, { amount: 6500, date: addDays(D, 1) })).toBe(true);
    const [t] = getTransactions(db, {});
    expect(t).toEqual(expect.objectContaining({
      amount: 6500, date: addDays(D, 1), detail: '스타벅스', budget_category: '식비', sub_category: '카페',
      discount_amount: 500, member: '아내', payment_method: '현대EV',
    }));
    expect(correctTransaction(db, 9999, { amount: 1000, date: D })).toBe(false);
  });

  test('올바르지 않은 금액·날짜는 쓰지 않는다', () => {
    const db = makeDb();
    const id = tx(db);
    expect(() => correctTransaction(db, id, { amount: 0, date: D })).toThrow();
    expect(() => correctTransaction(db, id, { amount: 1.5, date: D })).toThrow();
    expect(() => correctTransaction(db, id, { amount: 1000, date: '2026-02-30' })).toThrow();
    expect(getTransactions(db, {})[0].amount).toBe(6000);
  });
});
