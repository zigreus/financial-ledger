/**
 * @vitest-environment node
 */
// 카드 내역 대조 — 일치·묶음 일치(나눠 적음/합쳐 적음)·금액 차이·누락 추가 (B-062, B-063)
import initSqlJs from 'sql.js';
import {
  createDatabase, addTransaction, getTransactions, addCalendarEvent, addEventCountry, setSetting,
} from '../dbManager';
import { normalizeStatement, reconcileStatement, addMissingRows } from '../cardStatement';

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

test('묶음은 4건까지만, 하루 넘게 떨어지면 묶지 않는다', () => {
  const db = makeDb();
  for (let i = 0; i < 5; i += 1) add(db, { date: '2026-11-05', detail: '다이소', amount: 1000 });
  add(db, { date: '2026-11-01', detail: '올리브영', amount: 7000 });
  add(db, { date: '2026-11-04', detail: '올리브영', amount: 3000 });
  const r = run(db, [row('2026-11-05', '다이소', 5000), row('2026-11-04', '올리브영', 10000)]);
  expect(r.grouped).toEqual([]);
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
