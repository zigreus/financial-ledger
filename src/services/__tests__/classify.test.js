// AI 입력 분류(classify) — 원문이 먼저, 예전 기록은 판단 근거·다른 후보 (I-062)
import initSqlJs from 'sql.js';
import { createDatabase } from '../dbManager';
import {
  alternativePatch, applyAlternative, buildDataContext, categoryExamples, classify, otherAlternatives, relatedPatterns,
} from '../receiptAssistant';
import { todayStr } from '../dateUtils';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const TODAY = todayStr();

function makeDb() {
  const { db } = createDatabase(SQL, null);
  db.run("INSERT INTO payment_methods (name) VALUES ('현금'),('신한카드')");
  db.run("INSERT INTO budget_categories (name) VALUES ('식비'),('여행'),('쇼핑')");
  db.run(`INSERT INTO sub_categories (budget_category, name) VALUES
    ('식비','점심'),('식비','커피'),('식비','간식'),('여행','간식'),('여행','식사'),('쇼핑','생활용품')`);
  return db;
}
const add = (db, detail, n, cat, sub) => {
  for (let i = 0; i < n; i++) {
    db.run("INSERT INTO transactions (date, payment_method, budget_category, sub_category, detail, amount) VALUES (?, '현금', ?, ?, ?, 1000)", [TODAY, cat, sub, detail]);
  }
};
const pathOf = c => `${c.budget_category} > ${c.sub_category}`;

describe('카드 명세서 대조는 가게 이름뿐이라 같은 가게의 예전 기록이 판단이다', () => {
  test('AI가 달리 골라도 예전 기록, 짐작으로 보지 않는다 — 카드 문자도 같다', () => {
    const db = makeDb();
    add(db, '스타벅스', 5, '식비', '커피');
    const statement = classify(db, { merchant: '스타벅스 성수점', detail: '스타벅스', aiCategory: '식비 > 점심', readSource: 'statement' });
    expect(statement).toMatchObject({ detail: '스타벅스', sub_category: '커피', categoryGuess: false });
    expect(statement.sources.category).toBe('history');
    const sms = classify(db, { merchant: '스타벅스 성수점', detail: '스타벅스 성수점', readSource: 'sms' });
    expect(sms).toMatchObject({ detail: '스타벅스', sub_category: '커피', categoryGuess: false, alternatives: [] });
  });

  test('사진은 같은 가게여도 AI가 습관을 보고 달리 골랐으면 AI가 고른 것', () => {
    const db = makeDb();
    add(db, '스타벅스', 5, '식비', '커피');
    const photo = classify(db, { merchant: '스타벅스 성수점', detail: '스타벅스', aiCategory: '쇼핑 > 생활용품', readSource: 'receipt' });
    expect(photo).toMatchObject({ sub_category: '생활용품' });
    expect(otherAlternatives(photo).map(o => o.kind)).toEqual(['past']);
  });
});

describe('여행 일정의 결제', () => {
  test('후보는 여행 카테고리 안의 것만 — 여행 결제를 여행 밖으로 옮기는 후보를 보이지 않는다', () => {
    const db = makeDb();
    add(db, '로손', 3, '식비', '간식');
    const s = classify(db, { merchant: '로손', detail: '로손', aiCategory: '여행 > 간식', aiAltCategory: '여행 > 식사', eventId: 1 });
    expect(pathOf(s)).toBe('여행 > 간식');
    expect(s.alternatives.map(pathOf)).toEqual(['여행 > 간식', '여행 > 식사']);
  });

  test('AI가 여행 밖을 골랐고 예전 기록이 여행 카테고리 안이면 그 세부카테고리를 살린다', () => {
    const db = makeDb();
    add(db, '로손', 3, '여행', '간식');
    const s = classify(db, { merchant: '로손', detail: '로손', aiCategory: '식비 > 점심', eventId: 1 });
    expect(pathOf(s)).toBe('여행 > 간식');
    expect(s.sources.category).toBe('history');
  });
});

describe('다른 후보', () => {
  test('AI가 분류를 못 골라도 2순위를 주면 후보로 보인다', () => {
    const db = makeDb();
    const s = classify(db, { detail: '케이크', aiCategory: '모름', aiAltCategory: '식비 > 간식', readSource: 'text' });
    expect(s.budget_category).toBe('');
    expect(otherAlternatives(s).map(o => [o.kind, pathOf(o)])).toEqual([['second', '식비 > 간식']]);
  });

  test('세부내역을 직접 고쳤으면 후보를 골라도 고친 세부내역은 그대로 — 고치지 않았으면 후보의 것으로', () => {
    const db = makeDb();
    add(db, '메가', 3, '식비', '커피');
    const s = { ...classify(db, { merchant: '메가', detail: '메가', aiCategory: '식비 > 점심', readSource: 'text' }) };
    const past = otherAlternatives(s)[0];
    expect(past.kind).toBe('past');
    expect(alternativePatch({ ...s, detail: '메가 케이크' }, past)).toEqual({ budget_category: '식비', sub_category: '커피', categoryGuess: false });
    expect(alternativePatch(s, past)).toMatchObject({ detail: '메가', historyDetail: '메가', historyCount: 3 });
    expect(applyAlternative({ ...s, detail: '메가 케이크' }, past)).toMatchObject({ detail: '메가 케이크', sub_category: '커피' });
  });
});

describe('말로 입력에서 원문이 부르는 이름', () => {
  test("세부내역이 카테고리 이름을 되풀이할 뿐이면('스타벅스' + '커피') 가게 이름만 말한 것 — 예전 기록이 같은 곳", () => {
    const db = makeDb();
    add(db, '스타벅스', 6, '식비', '커피');
    const s = classify(db, { merchant: '스타벅스', detail: '커피', aiCategory: '식비 > 커피', readSource: 'text' });
    expect(s).toMatchObject({ detail: '스타벅스', sub_category: '커피' });
    expect(s.history).toMatchObject({ detail: '스타벅스', cnt: 6 });
  });

  test("가게와 산 것을 함께 말했으면 산 것의 예전 기록이 먼저 ('이마트 우유' → '우유'), 없으면 가게 기록은 채우기만", () => {
    const db = makeDb();
    add(db, '이마트', 30, '쇼핑', '생활용품');
    add(db, '우유', 5, '식비', '간식');
    const unsure = classify(db, { merchant: '이마트', detail: '우유', aiCategory: '모름', readSource: 'text' });
    expect(unsure).toMatchObject({ detail: '우유', sub_category: '간식' });
    expect(unsure.history).toMatchObject({ detail: '우유', cnt: 5 });
    const agree = classify(db, { merchant: '이마트', detail: '우유', aiCategory: '식비 > 간식', readSource: 'text' });
    expect(agree.history).toMatchObject({ detail: '우유' });
    const storeOnly = classify(db, { merchant: '이마트', detail: '휴지', aiCategory: '모름', readSource: 'text' });
    expect(storeOnly).toMatchObject({ detail: '휴지', sub_category: '생활용품', history: null, categoryGuess: true });
  });

  test("산 것('커피')으로 시작하는 더 긴 다른 기록('커피 원두')이 가게의 기록을 밀어내지 않는다", () => {
    const db = makeDb();
    add(db, '이디야', 30, '식비', '커피');
    add(db, '커피 원두', 4, '쇼핑', '생활용품');
    const unsure = classify(db, { merchant: '이디야', detail: '커피', aiCategory: '모름', readSource: 'text' });
    expect(unsure).toMatchObject({ sub_category: '커피' });
    const agree = classify(db, { merchant: '이디야', detail: '이디야 라떼', aiCategory: '식비 > 커피', readSource: 'text' });
    expect(agree).toMatchObject({ detail: '이디야 라떼', sub_category: '커피', alternatives: [] });
    expect(agree.history).toMatchObject({ detail: '이디야', cnt: 30 });
  });
});

describe('간편결제 이름은 가게가 아니다 — 그 이름으로 예전 기록을 찾지 않는다 (B-099)', () => {
  const withNaverHistory = () => {
    const db = makeDb();
    db.run("INSERT INTO budget_categories (name) VALUES ('정기결제')");
    db.run("INSERT INTO sub_categories (budget_category, name) VALUES ('정기결제','연회비')");
    add(db, '네이버페이 taptap', 1, '정기결제', '연회비');
    return db;
  };

  test('네이버페이 주문 화면 — 네이버페이로 시작하는 다른 가게의 기록을 쓰지 않고, AI가 상품으로 적은 세부내역·분류 그대로', () => {
    const db = withNaverHistory();
    const c = classify(db, {
      merchant: '네이버페이', detail: '센서등', aiCategory: '쇼핑 > 생활용품', readSource: 'receipt',
      items: ['LED 무선 센서등 21CM 동작감지 현관 계단 센스등'],
    });
    expect(c).toMatchObject({ detail: '센서등', budget_category: '쇼핑', sub_category: '생활용품', history: null, categoryGuess: false, alternatives: [] });
    expect(c.sources).toEqual({ detail: 'receipt', category: 'ai' });
    // AI가 상품을 못 적었어도(세부내역이 간편결제 이름) 다른 가게의 기록으로 채우지 않는다
    const bare = classify(db, { merchant: '네이버페이', detail: '네이버페이', aiCategory: '모름', readSource: 'receipt' });
    expect(bare).toMatchObject({ detail: '네이버페이', budget_category: '', history: null });
    // 카드 문자도
    expect(classify(db, { merchant: '네이버페이', detail: '네이버페이', readSource: 'sms' })).toMatchObject({ budget_category: '', history: null });
  });

  test('간편결제 이름 말고 아무것도 없으면(카드 문자, 상품 없는 내역 줄) 예전에 그 이름 그대로 적은 기록만 본다', () => {
    const db = withNaverHistory();
    add(db, '네이버페이', 2, '쇼핑', '생활용품');
    const sms = classify(db, { merchant: '네이버페이', detail: '네이버페이', readSource: 'sms' });
    expect(sms).toMatchObject({ detail: '네이버페이', sub_category: '생활용품' });
    expect(sms.history).toMatchObject({ detail: '네이버페이', cnt: 2 });
    const row = classify(db, { merchant: '네이버페이', detail: '', aiCategory: '모름', readSource: 'receipt' });
    expect(row).toMatchObject({ detail: '네이버페이', sub_category: '생활용품' });
    // 상품이 보였으면 그 기록은 이 상품의 것이 아니다
    const order = classify(db, { merchant: '네이버페이', detail: '', aiCategory: '모름', readSource: 'receipt', items: ['수건 10장'] });
    expect(order).toMatchObject({ budget_category: '', history: null });
  });

  test('설명대로 사진의 세부내역에 품목을 적었으면 가게의 예전 표기로 바꾸지 않는다 — 가게 이름이면 지금처럼', () => {
    const db = makeDb();
    add(db, '다이소', 4, '쇼핑', '생활용품');
    const items = ['LED 무선 센서등 21CM'];
    const promptText = '세부내역에는 물품명';
    const item = classify(db, { merchant: '다이소 성수점', detail: 'LED 센서등', aiCategory: '쇼핑 > 생활용품', readSource: 'receipt', items, promptText });
    expect(item).toMatchObject({ detail: 'LED 센서등', sub_category: '생활용품' });
    expect(item.sources.detail).toBe('receipt');
    expect(item.history).toMatchObject({ detail: '다이소' });           // 같은 가게·같은 분류 — 결제수단 습관은 그 가게의 것
    const store = classify(db, { merchant: '다이소 성수점', detail: '다이소', aiCategory: '쇼핑 > 생활용품', readSource: 'receipt', items, promptText });
    expect(store).toMatchObject({ detail: '다이소', sub_category: '생활용품' });
    expect(store.sources.detail).toBe('history');
    // 품목과 겹치지 않는 다른 이름(법인 이름 대신 쓴 상호)은 가게 이름으로 본다
    add(db, '스타벅스', 3, '식비', '커피');
    const brand = classify(db, { merchant: '에스씨케이컴퍼니', detail: '스타벅스', aiCategory: '식비 > 커피', readSource: 'receipt', items: ['아메리카노'], promptText });
    expect(brand.sources.detail).toBe('history');
  });

  test('설명이 없으면 사진의 세부내역은 상호다 — 품목 이름이 상호로 시작해도(CU 종량제봉투, 김밥) 예전 표기로', () => {
    const db = makeDb();
    add(db, 'CU편의점', 3, '쇼핑', '생활용품');
    add(db, '김밥천국 성수', 3, '식비', '점심');
    const cu = classify(db, { merchant: '(주)비지에프리테일', detail: 'CU', aiCategory: '쇼핑 > 생활용품', readSource: 'receipt', items: ['CU 종량제봉투 20L'] });
    expect(cu).toMatchObject({ detail: 'CU편의점' });
    expect(cu.history).toMatchObject({ detail: 'CU편의점' });
    // 설명이 있어도 짧은 품목('김밥')이 상호('김밥천국')의 앞머리일 뿐이면 품목이 아니다
    const kimbap = classify(db, {
      merchant: '홍길동', detail: '김밥천국', aiCategory: '식비 > 점심', readSource: 'receipt', items: ['김밥', '라면'], promptText: '점심',
    });
    expect(kimbap).toMatchObject({ detail: '김밥천국 성수' });
  });

  test('카드 명세서의 "네이버페이 무신사"는 앞의 간편결제 이름 뿐인 기록(네이버페이)이 아니라 실제 가게의 기록으로', () => {
    const db = makeDb();
    add(db, '네이버페이', 3, '식비', '간식');
    add(db, '무신사 스토어', 2, '쇼핑', '생활용품');
    const c = classify(db, { merchant: '네이버페이 무신사', detail: '무신사', aiCategory: '모름', readSource: 'statement' });
    expect(c).toMatchObject({ detail: '무신사 스토어', sub_category: '생활용품' });
    // 말로 입력의 '네이버페이 수건'도 간편결제 이름뿐인 기록으로 분류하지 않는다
    const text = classify(db, { merchant: '네이버페이', detail: '네이버페이 수건', aiCategory: '모름', readSource: 'text' });
    expect(text).toMatchObject({ budget_category: '', history: null });
  });

  test('간편결제 이름은 표기가 달라도 같은 곳 — 카드 문자 "네이버페이결제"는 예전의 "네이버페이" 기록으로, 같은 표기가 먼저', () => {
    const db = makeDb();
    add(db, '네이버페이', 2, '쇼핑', '생활용품');
    expect(classify(db, { merchant: '네이버페이결제', detail: '네이버페이결제', readSource: 'sms' })).toMatchObject({ detail: '네이버페이', sub_category: '생활용품' });
    expect(classify(db, { merchant: 'N pay', detail: 'N pay', readSource: 'sms' })).toMatchObject({ detail: '네이버페이', sub_category: '생활용품' });
    expect(classify(db, { merchant: '카카오페이', detail: '카카오페이', readSource: 'sms' })).toMatchObject({ budget_category: '', history: null });
    add(db, 'N pay', 5, '식비', '간식');                                          // 더 많이 썼어도 표기가 다르다
    expect(classify(db, { merchant: '네이버페이결제', detail: '네이버페이결제', readSource: 'sms' })).toMatchObject({ detail: '네이버페이', sub_category: '생활용품' });
  });

  test('"토스"(송금·토스 앱)는 결제대행 토스페이먼츠와 다른 곳', () => {
    const db = makeDb();
    add(db, '토스', 6, '식비', '간식');
    const c = classify(db, { merchant: '토스페이먼츠', detail: '토스페이먼츠', aiCategory: '쇼핑 > 생활용품', readSource: 'statement' });
    expect(c).toMatchObject({ sub_category: '생활용품', history: null });
  });

  test('말로 입력에서 간편결제 이름으로 시작하는 말은 사용자가 쓴 말이라 그대로 예전 기록을 찾는다', () => {
    const db = makeDb();
    add(db, '카카오페이 멜론', 5, '쇼핑', '생활용품');
    const c = classify(db, { merchant: '카카오페이', detail: '카카오페이 멜론', aiCategory: '모름', readSource: 'text' });
    expect(c).toMatchObject({ detail: '카카오페이 멜론', sub_category: '생활용품' });
    expect(c.history).toMatchObject({ detail: '카카오페이 멜론', cnt: 5 });
  });

  test('네이버페이 화면인데 AI가 예전 기록을 따라 "네이버페이 taptap"이라 적으면 그 기록으로 채우지 않고 확인을 받는다', () => {
    const db = withNaverHistory();
    const items = ['LED 무선 센서등 21CM'];
    const echo = classify(db, { merchant: '네이버페이', detail: '네이버페이 taptap', aiCategory: '쇼핑 > 생활용품', readSource: 'receipt', items });
    expect(echo).toMatchObject({ sub_category: '생활용품', history: null, gatewayBought: 'check' });
    expect(classify(db, { merchant: '네이버페이', detail: '', aiCategory: '모름', readSource: 'receipt', items })).toMatchObject({ gatewayBought: 'check' });
    expect(classify(db, { merchant: '네이버페이', detail: '센서등', aiCategory: '모름', readSource: 'receipt', items })).toMatchObject({ gatewayBought: 'known' });
    // 줄인 상품 이름은 품목 이름과 글자가 맞지 않아도 산 것이다
    expect(classify(db, { merchant: '네이버페이', detail: '수건', aiCategory: '모름', readSource: 'receipt', items: ['코튼순면호텔수건 40수'] }))
      .toMatchObject({ gatewayBought: 'known' });
    expect(classify(db, { merchant: '네이버페이', detail: '수건', aiCategory: '모름', readSource: 'receipt' })).toMatchObject({ gatewayBought: 'known' });
    expect(classify(db, { merchant: '네이버페이', detail: '', aiCategory: '모름', readSource: 'receipt' })).toMatchObject({ gatewayBought: 'unknown' });
    expect(classify(db, { merchant: '다이소', detail: '다이소', aiCategory: '모름', readSource: 'receipt' }).gatewayBought).toBe('');
  });

  test('글에 나온 간편결제 이름으로 다른 가게의 예전 기록·간편결제 이름뿐인 기록을 AI에게 보내지 않는다', () => {
    const db = withNaverHistory();
    add(db, '네이버페이', 1, '쇼핑', '생활용품');
    for (let i = 0; i < 40; i++) add(db, `가게${i}`, 2, '식비', '점심');
    expect(relatedPatterns(db, '네이버페이로 수건 샀어').map(p => p.detail)).toEqual([]);
    expect(relatedPatterns(db, '네이버페이 수건 샀어').map(p => p.detail)).toEqual([]);
    expect(relatedPatterns(db, '네이버페이 taptap 연회비').map(p => p.detail)).toEqual(['네이버페이 taptap']);
  });
});

describe('세부카테고리마다의 예 — 이 사용자가 어떤 것을 어디에 넣는지 AI에게 보인다 (I-064)', () => {
  test('결제수단이 달라도 합쳐 세고 많이 쓴 5개 — 간편결제 이름·카테고리 이름 되풀이·목록에 없는 분류는 빼고, 목록 순서로', () => {
    const p = (detail, cnt, cat = '주거', sub = '물품', method = '현금') => ({ detail, budget_category: cat, sub_category: sub, payment_method: method, cnt });
    const out = categoryExamples([
      p('멀티탭', 3), p('전구', 2), p('전구', 2, '주거', '물품', '신한카드'), p('네이버페이', 9), p('물품', 5),
      p('수납함', 2), p('건전지', 1), p('행거', 1), p('못', 1),
      p('김밥', 4, '식비', '점심'), p('옛날 것', 9, '없는', '분류'),
    ], ['식비 > 점심', '식비 > 커피', '주거 > 물품']);
    expect(out).toEqual([
      { path: '식비 > 점심', details: ['김밥'] },
      { path: '주거 > 물품', details: ['전구', '멀티탭', '수납함', '건전지', '행거'] },
    ]);
  });

  test('지시문에 예가 들어가고, AI가 예에서 본 가게를 달리 분류했으면 AI가 고른 것이 먼저', () => {
    const db = makeDb();
    for (let i = 0; i < 40; i++) add(db, `가게${i}`, 3, '식비', '점심');
    add(db, '다이소', 2, '쇼핑', '생활용품');
    const { text } = buildDataContext(db, TODAY);
    expect(text).not.toContain('다이소 →');                         // 많이 쓴 40개에는 없다
    expect(text).toContain('[세부카테고리마다 이 사용자가 자주 적은 세부내역 — 어떤 물건·가게를 어디에 넣는지]\n');
    expect(text.split('\n')).toContain('쇼핑 > 생활용품: 다이소');
    expect(text).toContain('처음 보는 물건·가게는 세부카테고리마다의 예를 보고');
    const c = classify(db, { merchant: '다이소 성수점', detail: '다이소', aiCategory: '식비 > 간식', readSource: 'receipt' });
    expect(c).toMatchObject({ detail: '다이소', sub_category: '간식', categoryGuess: false });
    expect(c.sources.category).toBe('ai');
  });

  test('말로 입력도 — 예에서 본 가게를 AI가 달리 분류했으면 AI가 고른 것, 많이 쓴 입력 습관 줄에 있는 것은 예에 되풀이하지 않는다', () => {
    const db = makeDb();
    for (let i = 0; i < 40; i++) add(db, `가게${i}`, 3, '식비', '점심');
    add(db, '다이소', 2, '쇼핑', '생활용품');
    const c = classify(db, { merchant: '다이소', detail: '다이소', aiCategory: '식비 > 간식', readSource: 'text' });
    expect(c).toMatchObject({ sub_category: '간식', categoryGuess: false });
    const lines = buildDataContext(db, TODAY).text.split('\n');
    expect(lines).toContain('쇼핑 > 생활용품: 다이소');
    expect(lines.some(l => l.startsWith('식비 > 점심:'))).toBe(false);   // 가게0~39는 입력 습관 줄에 이미 있다
  });

  test('긴 예는 글자 단위로 줄여 보내고, 줄인 것은 AI가 본 것으로 치지 않는다', () => {
    const db = makeDb();
    for (let i = 0; i < 40; i++) add(db, `가게${i}`, 3, '식비', '점심');
    const long = '아주 긴 세부내역 이름이 스무 글자를 넘어갑니다 🎁🎁';
    add(db, long, 2, '쇼핑', '생활용품');
    const line = buildDataContext(db, TODAY).text.split('\n').find(l => l.startsWith('쇼핑 > 생활용품:'));
    expect(line).toBe(`쇼핑 > 생활용품: ${Array.from(long).slice(0, 20).join('')}…`);
    const c = classify(db, { merchant: long, detail: long, aiCategory: '식비 > 간식', readSource: 'receipt' });
    expect(c).toMatchObject({ sub_category: '생활용품', categoryGuess: true });
  });

  test('예전 기록이 없으면 예 칸을 넣지 않는다', () => {
    expect(buildDataContext(makeDb(), TODAY).text).not.toContain('세부카테고리마다');
  });
});
