// 사진으로 입력 (I-052) — 영수증 여러 장·카드 이용내역 캡처의 여러 결제를 한 번에 읽는다
import initSqlJs from 'sql.js';
import { createDatabase, addTransaction } from '../dbManager';
import { buildPhotoSuggestions, buildPhotoPrompt, markDuplicates, isPaymentGateway } from '../photoEntry';
import { todayStr, addDays } from '../dateUtils';
import { otherAlternatives, CATEGORY_ALT_RULE } from '../receiptAssistant';

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

test('간편결제·결제대행 이름뿐인지 — 회사 표시·결제가 붙어도, 실제 가게가 함께 있으면 아님', () => {
  ['네이버페이', 'NAVER PAY', 'Npay', 'N페이', '네이버페이 결제', '네이버파이낸셜(주)', '(주)카카오페이', '카카오페이(주)',
    '토스페이먼츠(주)', 'TOSS', '비바리퍼블리카', '(주)케이지이니시스', 'NICE PAYMENTS', '나이스페이먼츠', '한국사이버결제']
    .forEach(name => expect([name, isPaymentGateway(name)]).toEqual([name, true]));
  ['카카오페이 - 한살림서울협동조합', '다이소아성산업', '토스트', '쿠팡', '주유소']
    .forEach(name => expect([name, isPaymentGateway(name)]).toEqual([name, false]));
});

test('직접 고쳐야 할 점 — 간편결제는 세부내역·카테고리, AI가 알려 준 것, 날짜를 못 읽으면 날짜 (한 건이면 경고로)', () => {
  const db = makeDb();
  const fixesOf = s => (s.needsFix || []).map(f => [f.text, f.fields]);
  const many = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'list', note: '',
    entries: [
      entry({ merchant: '네이버페이', total: 43950, needs_fix: '' }),
      entry({ merchant: '알 수 없는 상점 12', total: 5000, needs_fix: '가게 이름이 잘려 무엇인지 모름 — 세부내역을 고쳐 주세요' }),
      entry({ merchant: '김밥천국', total: 8000, needs_fix: '없음' }),           // '없음'은 빈 값
      entry({ merchant: '와플사이', total: 4500, date: '' }),                    // 날짜 머리글이 잘렸다
    ],
  }, { today: TODAY }).suggestions;
  expect(many.map(fixesOf)).toEqual([
    [['네이버페이 결제라 무엇을 샀는지 알 수 없어요 — 세부내역·카테고리를 고쳐 주세요', ['detail', 'budget_category', 'sub_category']]],
    [['가게 이름이 잘려 무엇인지 모름 — 세부내역을 고쳐 주세요', ['date', 'detail', 'amount', 'budget_category', 'sub_category']]],
    [],
    [['날짜를 읽지 못해 오늘 날짜로 두었어요 — 날짜를 골라 주세요', ['date']]],
  ]);

  const one = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'list', note: '', entries: [entry({ merchant: '네이버페이', total: 43950 })],
  }).suggestions[0];
  expect(one.warnings).toEqual(['네이버페이 결제라 무엇을 샀는지 알 수 없어요 — 세부내역·카테고리를 고쳐 주세요']);
});

test('늘 넣던 대로 분류한 결제는 AI가 고치라고 해도 수정 필요로 보지 않는다', () => {
  const db = makeDb();
  addTransaction(db, { payment_method: '현대EV', date: D1, budget_category: '식비', sub_category: '외식', detail: '쿠팡', amount: 12000 });
  const [s] = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'list', note: '',
    entries: [entry({ merchant: '쿠팡', total: 30000, needs_fix: '무엇을 샀는지 모름' }), entry({ merchant: '마트', total: 1000 })],
  }).suggestions;
  expect(s.sources.category).toBe('history');
  expect(s.needsFix).toEqual([]);
});

test('사진에 보이는 것이 예전 기록보다 먼저 — 가게 표기는 예전대로, 분류는 AI가 사진(품목)을 보고 습관과 달리 골랐으면 그것 (I-062)', () => {
  const db = makeDb();
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('생활', 2)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('생활', '생활용품', 0)");
  addTransaction(db, { payment_method: '현대EV', date: D1, budget_category: '식비', sub_category: '외식', detail: '이마트', amount: 12000 });
  addTransaction(db, { payment_method: '현대EV', date: D2, budget_category: '식비', sub_category: '외식', detail: '이마트', amount: 9000 });
  const [byItems, unsure] = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'receipt', note: '',
    entries: [
      entry({ merchant: '(주)이마트 성수점', total: 25000, category: '생활 > 생활용품', items: [{ name: '세제', amount: 25000 }] }),
      entry({ merchant: '(주)이마트 성수점', total: 7000, category: '모름' }),
    ],
  }).suggestions;
  expect(byItems).toMatchObject({ detail: '이마트', historyDetail: '이마트', budget_category: '생활', sub_category: '생활용품' });
  expect(byItems.sources).toMatchObject({ detail: 'history', category: 'ai' });
  expect(otherAlternatives(byItems).map(o => [o.kind, o.sub_category, o.cnt])).toEqual([['past', '외식', 2]]);
  expect(unsure).toMatchObject({ detail: '이마트', budget_category: '식비', sub_category: '외식', categoryGuess: true });
  expect(unsure.sources.category).toBe('history');
});

test('AI가 지시문에서 못 본 습관(많이 쓴 40개 밖)이면 같은 가게의 예전 기록으로 — 바로 넣지 않고 AI가 고른 것은 후보로, AI의 수정 필요도 보인다 (I-062)', () => {
  const db = makeDb();
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('생활', 2)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('생활', '생활용품', 0)");
  for (let i = 0; i < 40; i++) {
    for (let k = 0; k < 3; k++) addTransaction(db, { payment_method: '현금', date: D1, budget_category: '식비', sub_category: '외식', detail: `가게${i}`, amount: 1000 });
  }
  addTransaction(db, { payment_method: '현대EV', date: D1, budget_category: '생활', sub_category: '생활용품', detail: '다이소', amount: 5000 });
  addTransaction(db, { payment_method: '현대EV', date: D2, budget_category: '생활', sub_category: '생활용품', detail: '다이소', amount: 3000 });
  expect(buildPhotoPrompt(db, { today: TODAY })).not.toContain('다이소 →');
  const [s, other] = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'list', note: '',
    entries: [
      entry({ merchant: '다이소 성수점', total: 5000, category: '식비 > 외식', needs_fix: '무엇을 샀는지 모름' }),
      entry({ merchant: '가게', total: 1000 }),
    ],
  }).suggestions;
  expect(s).toMatchObject({ detail: '다이소', budget_category: '생활', sub_category: '생활용품', categoryGuess: true });
  expect(otherAlternatives(s).map(o => [o.kind, o.budget_category, o.sub_category])).toEqual([['ai', '식비', '외식']]);
  expect(s.needsFix.map(f => f.text)).toEqual(['무엇을 샀는지 모름']);
  expect(other.alternatives).toEqual([]);
});

test('지시문이 헷갈릴 때만 2순위(category_alt)를 달라고 하고, 준 2순위는 후보로 (I-062)', () => {
  const db = makeDb();
  expect(buildPhotoPrompt(db, { today: TODAY })).toContain(CATEGORY_ALT_RULE);
  const [s] = buildPhotoSuggestions(db, {
    is_payment: true, kind: 'receipt', note: '', entries: [entry({ merchant: '주유소 편의점', category: '식비 > 외식', category_alt: '교통 > 충전' })],
  }).suggestions;
  expect(otherAlternatives(s).map(o => [o.kind, o.sub_category])).toEqual([['second', '충전']]);
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
