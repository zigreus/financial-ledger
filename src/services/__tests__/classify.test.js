// AI 입력 분류(classify) — 원문이 먼저, 예전 기록은 판단 근거·다른 후보 (I-062)
import initSqlJs from 'sql.js';
import { createDatabase } from '../dbManager';
import {
  alternativePatch, applyAlternative, classify, otherAlternatives,
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
