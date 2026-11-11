// 사진으로 입력 (I-052) — 영수증 여러 장·카드 이용내역 캡처의 여러 결제를 한 번에 읽는다
import initSqlJs from 'sql.js';
import { createDatabase, addTransaction } from '../dbManager';
import { buildPhotoSuggestions, buildPhotoPrompt } from '../photoEntry';
import { todayStr, addDays } from '../dateUtils';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const TODAY = todayStr();
const D1 = addDays(TODAY, -3);
const D2 = addDays(TODAY, -2);

function makeDb() {
  const { db } = createDatabase(SQL, null);
  db.run('DELETE FROM payment_methods');
  ['현대EV', '신한카드', '현금'].forEach((n, i) => db.run('INSERT INTO payment_methods (name, sort_order) VALUES (?, ?)', [n, i]));
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('식비', 0), ('교통', 1)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('식비', '외식', 0), ('교통', '충전', 0)");
  return db;
}

const entry = (over = {}) => ({
  date: D1, merchant: '가게', total: 10000, currency: 'KRW', is_cancel: false,
  payment_hint: '현대카드 EV', payment_method: '현대EV', category: '식비 > 외식', detail: '',
  items: [], confidence: 'high', ...over,
});

test('결제 내역 목록 — 결제마다 한 건, 목록의 결제수단·분류로 맞춘다', () => {
  const db = makeDb();
  const { suggestions, cancels } = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'list', note: '',
    entries: [
      entry({ merchant: '한국전력 충전소', total: 15400, category: '교통 > 충전' }),
      entry({ merchant: '김밥천국', total: 8000, items: [{ name: '김밥', amount: 8000 }] }),
    ],
  });
  expect(cancels).toEqual([]);
  expect(suggestions.map(s => [s.merchant, s.amount, s.payment_method, s.budget_category, s.sub_category])).toEqual([
    ['한국전력 충전소', 15400, '현대EV', '교통', '충전'],
    ['김밥천국', 8000, '현대EV', '식비', '외식'],
  ]);
  expect(suggestions[1].items).toEqual([]);          // 여러 건이면 품목은 보이지 않는다
  expect(suggestions.every(s => !s.duplicateOf && !s.batchDuplicate && !s.pairedCancel)).toBe(true);
});

test('영수증 한 장이면 품목과 알릴 점을 그 건에 붙인다 (예전 영수증 화면과 같음)', () => {
  const db = makeDb();
  const { suggestions } = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'receipt', note: '아래쪽이 흐립니다',
    entries: [entry({ items: [{ name: '김밥', amount: 8000 }] })],
  });
  expect(suggestions).toHaveLength(1);
  expect(suggestions[0].items).toEqual([{ name: '김밥', amount: 8000 }]);
  expect(suggestions[0].warnings).toContain('아래쪽이 흐립니다');
});

test('가계부에 이미 있는 결제(계속 받는 내역의 겹친 부분)는 duplicateOf로 표시한다', () => {
  const db = makeDb();
  addTransaction(db, { payment_method: '현대EV', date: D1, budget_category: '식비', sub_category: '외식', detail: '김밥천국', amount: 8000 });
  const { suggestions } = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'list', note: '',
    entries: [entry({ merchant: '김밥천국', total: 8000 }), entry({ merchant: '스타벅스', total: 5000 })],
  });
  expect(suggestions[0].duplicateOf).toEqual(expect.objectContaining({ detail: '김밥천국' }));
  expect(suggestions[1].duplicateOf).toBeNull();
});

test('겹쳐 찍은 같은 결제는 뒤의 것을 batchDuplicate로, 취소 줄은 넣지 않고 같은 결제와 짝짓는다', () => {
  const db = makeDb();
  const { suggestions, cancels } = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'list', note: '',
    entries: [
      entry({ merchant: '주유소', total: 50000 }),
      entry({ merchant: '주유소', total: 50000 }),
      entry({ merchant: '쿠팡', total: 23000 }),
      entry({ merchant: '쿠팡', total: 23000, is_cancel: true, date: D2 }),
      entry({ merchant: '옛날가게', total: -4000, date: D2 }),   // 음수로만 적힌 취소
    ],
  });
  expect(suggestions.map(s => [s.merchant, !!s.batchDuplicate, !!s.pairedCancel])).toEqual([
    ['주유소', false, false],
    ['주유소', true, false],
    ['쿠팡', false, true],
  ]);
  expect(cancels.map(c => [c.merchant, c.amount, c.paired])).toEqual([['쿠팡', 23000, true], ['옛날가게', 4000, false]]);
});

test('가게 표기가 달라도 같은 세부내역·결제수단·날짜·금액으로 맞춰졌으면 겹친 결제로 본다', () => {
  const db = makeDb();
  const { suggestions } = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'list', note: '',
    entries: [entry({ merchant: '스타벅스 강남점', detail: '스타벅스', total: 5000 }), entry({ merchant: 'STARBUCKS', detail: '스타벅스', total: 5000 })],
  });
  expect(suggestions.map(s => !!s.batchDuplicate)).toEqual([false, true]);
});

test('결제 칸이 없는 응답은 0건이 아니라 오류', () => {
  expect(() => buildPhotoSuggestions(makeDb(), { is_payment: true, note: '' })).toThrow('사진 내용을 읽지 못했습니다');
});

test('지시문에 사진 수와 목록·겹침 규칙이 들어간다', () => {
  const prompt = buildPhotoPrompt(makeDb(), { photos: 3, today: TODAY });
  expect(prompt).toContain('사진 3장');
  expect(prompt).toContain('결제(이용) 내역 목록이면 보이는 결제마다 한 건씩');
  expect(prompt).toContain('현대EV');
});
