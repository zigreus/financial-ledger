// 사진으로 입력 (I-052) — 영수증 여러 장·카드 이용내역 캡처의 여러 결제를 한 번에 읽는다
import initSqlJs from 'sql.js';
import { createDatabase, addTransaction } from '../dbManager';
import { buildPhotoSuggestions, buildPhotoPrompt, markDuplicates } from '../photoEntry';
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

test('현대카드 앱 이용내역 캡처 두 장(사용자 예시) — 날짜별로 모두 넣고, 같은 가게·금액이라도 날짜가 다르면 따로', () => {
  const db = makeDb();
  // 이미 넣어 둔 11/9 결제 — 내역을 다시 받아도 두 번 넣지 않는다
  addTransaction(db, { payment_method: '현대EV', date: '2026-11-09', budget_category: '교통', sub_category: '충전', detail: '대득에너지', amount: 1000 });
  const card = (date, merchant, total) => entry({ date, merchant, total, payment_hint: 'Hyundai EV카드', category: '모름' });
  const { suggestions, cancels } = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'list', note: '',
    entries: [
      card('2026-11-08', '네이버페이', 43950),
      card('2026-11-08', '신성통상TOPTEN엔터식스안양', 109700),
      card('2026-11-08', '다이소아성산업', 1000),
      card('2026-11-08', '네이버페이', 23900),
      card('2026-11-07', '다이소아성산업', 3000),
      card('2026-11-11', '와플사이', 4500),
      card('2026-11-11', '다이소아성산업', 3000),
      card('2026-11-11', '한살림서울협동조합', 24120),
      card('2026-11-11', '네이버페이', 51500),
      card('2026-11-10', '전기차충전 - 한국자동차환경협회(사)', 4352),
      card('2026-11-09', '귀뚜라미에너지시흥고객센터', 14000),
      card('2026-11-09', '대득에너지금천셀프주유소', 1000),
    ],
  }, { today: '2026-11-11' });
  expect(cancels).toEqual([]);
  expect(suggestions).toHaveLength(12);
  expect(suggestions.every(s => s.payment_method === '현대EV' && s.sources.date === 'receipt')).toBe(true);
  // 11/11 합계는 앱 달력의 83,120원과 같다
  expect(suggestions.filter(s => s.date === '2026-11-11').reduce((n, s) => n + s.amount, 0)).toBe(83120);
  expect(suggestions.filter(s => s.batchDuplicate)).toEqual([]);   // 11/7·11/11 다이소 3,000원은 서로 다른 결제
  expect(suggestions.filter(s => s.duplicateOf).map(s => s.merchant)).toEqual(['대득에너지금천셀프주유소']);
});

test('이미 넣은 거래는 한 줄하고만 짝짓고, 결제수단과 이름이 다 맞는 거래를 먼저 고른다', () => {
  const db = makeDb();
  addTransaction(db, { payment_method: '신한카드', date: D1, budget_category: '식비', sub_category: '외식', detail: '다이소', amount: 3000 });
  addTransaction(db, { payment_method: '현대EV', date: D1, budget_category: '식비', sub_category: '외식', detail: '다이소', amount: 3000 });
  const base = { date: D1, amount: 3000, merchant: '다이소아성산업', detail: '다이소', payment_method: '현대EV', sources: {} };
  const out = markDuplicates(db, [
    base,
    { ...base, merchant: '다이소 2층', payment_method: '신한카드' },
    { ...base, date: D2 },
  ]);
  expect(out[0].duplicateOf).toEqual(expect.objectContaining({ payment_method: '현대EV' }));
  expect(out[1].duplicateOf).toEqual(expect.objectContaining({ payment_method: '신한카드' }));
  expect(out[2].duplicateOf).toBeNull();                       // 다른 날

  // 같은 날 같은 금액이 둘인데 가계부에는 하나만 있으면 하나만 이미 있는 것
  const twice = markDuplicates(db, [base, { ...base, merchant: '다이소', payment_method: '현대EV' }]);
  expect(twice.filter(s => s.duplicateOf && s.duplicateOf.payment_method === '현대EV')).toHaveLength(1);
});

test('고친 값으로 다시 대조한다 — 금액을 고치면 이미 있는 거래·앞 줄과 더는 겹치지 않는다', () => {
  const db = makeDb();
  addTransaction(db, { payment_method: '현대EV', date: D1, budget_category: '식비', sub_category: '외식', detail: '김밥천국', amount: 8000 });
  const s = { date: D1, amount: 8000, merchant: '김밥천국', detail: '김밥천국', payment_method: '현대EV', sources: {} };
  const [a, b] = markDuplicates(db, [s, { ...s }]);
  expect([!!a.duplicateOf, a.batchDuplicate, !!b.duplicateOf, b.batchDuplicate]).toEqual([true, false, false, true]);
  const [c, d] = markDuplicates(db, [{ ...a, amount: 9000 }, b]);
  expect([!!c.duplicateOf, c.batchDuplicate, !!d.duplicateOf, d.batchDuplicate]).toEqual([false, false, true, false]);
});

test('짝은 목록 전체에서 결제수단·이름이 다 맞는 것부터 — 앞 줄이 결제수단만 맞는 거래를 가져가지 않는다', () => {
  const db = makeDb();
  addTransaction(db, { payment_method: '현대EV', date: D1, budget_category: '식비', sub_category: '외식', detail: '메가커피', amount: 4500 });
  const base = { date: D1, amount: 4500, payment_method: '현대EV', sources: {} };
  const [a, b] = markDuplicates(db, [{ ...base, merchant: '처음가게', detail: '처음가게' }, { ...base, merchant: '메가커피', detail: '메가커피' }]);
  expect(a.duplicateOf).toBeNull();
  expect(b.duplicateOf).toEqual(expect.objectContaining({ detail: '메가커피' }));
});

test('이 화면에서 바로 넣은 결제(claimed)가 제 거래를 먼저 가져가 다른 줄과 짝짓지 않는다', () => {
  const db = makeDb();
  addTransaction(db, { payment_method: '현대EV', date: D1, budget_category: '식비', sub_category: '외식', detail: '가게A', amount: 4500 });
  const base = { date: D1, amount: 4500, payment_method: '현대EV', sources: {} };
  const [r] = markDuplicates(db, [{ ...base, merchant: '가게B', detail: '가게B' }], { claimed: [{ ...base, merchant: '가게A', detail: '가게A' }] });
  expect(r.duplicateOf).toBeNull();
  expect(markDuplicates(db, [{ ...base, merchant: '가게B', detail: '가게B' }])[0].duplicateOf).not.toBeNull();
});

test('결제마다의 메모 — 여러 건이면 그 줄의 aiNote로, 한 건이면 경고로', () => {
  const db = makeDb();
  const many = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'list', note: '',
    entries: [entry({ merchant: '네이버페이', note: '간편결제라 실제 가게를 알 수 없어요' }), entry({ merchant: '김밥천국', total: 8000, note: '' })],
  }).suggestions;
  expect(many.map(s => s.aiNote)).toEqual(['간편결제라 실제 가게를 알 수 없어요', '']);
  expect(many[0].warnings).toEqual([]);

  const one = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'receipt', note: '아래쪽이 흐립니다',
    entries: [entry({ note: '합계가 반쯤 가려졌어요' })],
  }).suggestions[0];
  expect(one.aiNote).toBeUndefined();
  expect(one.warnings).toEqual(['아래쪽이 흐립니다 · 합계가 반쯤 가려졌어요']);

  // 사진 전체 메모와 결제 메모가 같으면 한 번만
  const same = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'receipt', note: '합계가 흐립니다', entries: [entry({ note: '합계가 흐립니다' })],
  }).suggestions[0];
  expect(same.warnings).toEqual(['합계가 흐립니다']);
});

test('결제 칸이 없는 응답은 0건이 아니라 오류', () => {
  expect(() => buildPhotoSuggestions(makeDb(), { is_payment: true, note: '' })).toThrow('사진 내용을 읽지 못했습니다');
});

test('지시문에 사진 수와 목록·겹침 규칙이 들어간다', () => {
  const prompt = buildPhotoPrompt(makeDb(), { photos: 3, today: TODAY });
  expect(prompt).toContain('사진 3장');
  expect(prompt).toContain('결제(이용) 내역 목록이면 보이는 결제마다 한 건씩');
  expect(prompt).toContain('현대EV');
  expect(prompt).toContain('결제마다 note에 확실하지 않은 점');
});
