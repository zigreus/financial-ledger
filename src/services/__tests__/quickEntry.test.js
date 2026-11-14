/**
 * @vitest-environment jsdom
 */
// AI 입력 (I-022) — 늘 넣던 거래만 바로 넣고, 바로 넣은 것은 되돌릴 수 있다
import initSqlJs from 'sql.js';
import {
  createDatabase, addTransaction, addedSnapshot, removeAddedTransactions, getTransactions,
} from '../dbManager';
import { familiarity, splitFamiliar, mayAutoAddText } from '../quickEntry';
import { buildSmsSuggestions, looksLikeCardMessage } from '../cardSms';
import { todayStr, addDays, parseDateStr } from '../dateUtils';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => window.localStorage.clear());

const TODAY = todayStr();
const lines = (...l) => l.join('\n');
const mmdd = (date) => { const d = parseDateStr(date); return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`; };

function makeDb({ starbucks = 2 } = {}) {
  const { db } = createDatabase(SQL, null);
  db.run('DELETE FROM payment_methods');
  ['신한카드', 'KB국민카드', '현금'].forEach((n, i) => db.run('INSERT INTO payment_methods (name, sort_order) VALUES (?, ?)', [n, i]));
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('식비', 0)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('식비', '카페', 0), ('식비', '외식', 1)");
  for (let i = 0; i < starbucks; i += 1) {
    addTransaction(db, { payment_method: '신한카드', date: addDays(TODAY, -10 - i * 7), budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 4500 });
  }
  return db;
}

/** 늘 넣던 스타벅스 결제 추천 — 필요한 칸만 바꿔 쓴다 */
const familiarSuggestion = (over = {}) => ({
  date: TODAY, merchant: '스타벅스', detail: '스타벅스', amount: 5000, currency: 'KRW', foreignAmount: null,
  event_id: null, payment_method: '신한카드', budget_category: '식비', sub_category: '카페',
  historyDetail: '스타벅스', historyCount: 2, confidence: 'high', warnings: [], duplicateOf: null,
  sources: { date: 'sms', detail: 'history', category: 'history', payment_method: 'sms' },
  ...over,
});

describe('바로 넣어도 되는지 (familiarity)', () => {
  test('같은 가게를 같은 분류로 2번 넣었고 결제수단·금액·날짜가 분명하면 바로 넣는다', () => {
    const db = makeDb();
    expect(familiarity(db, familiarSuggestion(), 'sms')).toEqual({ familiar: true, reason: '' });
    // 가게 이름이 예전 세부내역을 품고 있어도 같은 곳 (스타벅스코리아 ↔ 스타벅스)
    expect(familiarity(db, familiarSuggestion({ merchant: '스타벅스코리아' }), 'sms').familiar).toBe(true);
    // 말로 입력은 사용자가 쓴 글에 그 가게 이름이 있어야 한다
    const spoken = familiarSuggestion({ merchant: '', sources: { date: 'text', category: 'history', payment_method: 'text' } });
    expect(familiarity(db, spoken, 'text', { said: '스타벅스 5천원 신한카드' }).familiar).toBe(true);
    expect(familiarity(db, spoken, 'text', { said: '커피 5천원 신한카드' }).reason).toContain("'스타벅스'와 같은 곳인지");
    expect(familiarity(db, spoken, 'text').reason).toContain('같은 곳인지');
  });

  test("말로 입력: AI가 습관의 표기로 바꿔 줘도 사용자가 '커피'라고만 했으면 '메가커피'로 바로 넣지 않는다", () => {
    const db = makeDb();
    const megaCoffee = familiarSuggestion({
      merchant: '', detail: '메가커피', historyDetail: '메가커피', historyCount: 3, payment_method: '현금',
      sources: { date: 'text', category: 'history', payment_method: 'text' },
    });
    expect(familiarity(db, megaCoffee, 'text', { said: '커피 2천원 현금' }).familiar).toBe(false);
    expect(familiarity(db, { ...megaCoffee, merchant: '메가커피' }, 'text', { said: '커피 2천원 현금' }).familiar).toBe(false);
    expect(familiarity(db, megaCoffee, 'text', { said: '메가 커피 2천원 현금' }).familiar).toBe(true);
  });

  test("말로 입력: 글에 이름이 있어도 다른 이름의 일부면 같은 곳이 아니다 — '커피빈'↔'커피', '이마트24'↔'이마트'", () => {
    const db = makeDb();
    const spoken = (past, merchant, payment = '현금') => familiarSuggestion({
      merchant, detail: past, historyDetail: past, historyCount: 3, payment_method: payment,
      sources: { date: 'text', category: 'history', payment_method: 'text' },
    });
    expect(familiarity(db, spoken('커피', '커피빈'), 'text', { said: '커피빈 4500 현금' }).familiar).toBe(false);
    expect(familiarity(db, spoken('커피', ''), 'text', { said: '커피빈 4500 현금' }).familiar).toBe(false);
    expect(familiarity(db, spoken('이마트', '이마트24'), 'text', { said: '이마트24 5천원 현금' }).familiar).toBe(false);
    expect(familiarity(db, spoken('이마트', ''), 'text', { said: '이마트24 5천원 현금' }).familiar).toBe(false);
    // 같은 이름 그대로이거나 조사가 붙은 것은 같은 곳
    expect(familiarity(db, spoken('커피', ''), 'text', { said: '커피 4500 현금' }).familiar).toBe(true);
    expect(familiarity(db, spoken('이마트', '이마트'), 'text', { said: '이마트에서 5천원 현금' }).familiar).toBe(true);
    expect(familiarity(db, spoken('스타벅스', '스타벅스', '신한카드'), 'text', { said: '스타벅스랑 신한으로 5천원' }).familiar).toBe(true);
  });

  test('말로 입력: 결제수단을 글에 적지 않았으면 AI가 적었다고 해도 확인받는다', () => {
    const db = makeDb();
    const spoken = familiarSuggestion({ sources: { date: 'text', category: 'history', payment_method: 'text' } });
    expect(familiarity(db, spoken, 'text', { said: '스타벅스 5천원' }).reason).toBe('결제수단을 확인해 주세요');
    expect(familiarity(db, spoken, 'text', { said: '스타벅스 5천원 신한카드' }).familiar).toBe(true);
    expect(familiarity(db, spoken, 'text', { said: '스타벅스 5천원 신한으로' }).familiar).toBe(true);
  });

  test('말로 입력: 여러 건이 같은 습관(세부내역)으로 맞춰지면 — 다른 건의 이름 덕에 같은 곳으로 본 것일 수 있어 확인받는다', () => {
    const db = makeDb();
    const a = familiarSuggestion({ merchant: '', sources: { date: 'text', category: 'history', payment_method: 'text' } });
    const b = { ...a, amount: 6000 };                    // AI가 '처음가본카페'를 습관 표기 '스타벅스'로 바꿨다
    const { familiar, review } = splitFamiliar(db, [a, b], 'text', { said: '스타벅스 5천원 신한카드, 처음가본카페 6천원 신한카드' });
    expect(familiar).toEqual([]);
    expect(review.map(r => r.reason)).toEqual([expect.stringContaining("'스타벅스' 거래가 여럿"), expect.stringContaining("'스타벅스' 거래가 여럿")]);
  });

  test("가게 이름 뒤에 숫자가 이어지면 다른 곳 — '이마트' ↔ '이마트24'", () => {
    const db = makeDb();
    const emart = over => familiarSuggestion({ detail: '이마트', historyDetail: '이마트', ...over });
    expect(familiarity(db, emart({ merchant: '이마트24 역삼점' }), 'sms').reason).toContain('같은 곳인지');
    expect(familiarity(db, emart({ merchant: '이마트 성수점' }), 'sms').familiar).toBe(true);
  });

  test('결제수단: 카드 문자는 그 카드로 기억했거나 카드사로 고른 것만, 습관은 이 가게를 늘 같은 결제수단으로 넣었을 때만', () => {
    const db = makeDb();                         // 스타벅스는 늘 신한카드
    const byHistory = (kind, over) => familiarSuggestion({ sources: { date: kind, category: 'history', payment_method: 'history' }, ...over });
    expect(familiarity(db, byHistory('sms'), 'sms').reason).toBe('결제수단을 확인해 주세요');
    expect(familiarity(db, byHistory('text'), 'text', { said: '스타벅스 5천원' }).familiar).toBe(true);
    expect(familiarity(db, byHistory('receipt'), 'receipt').familiar).toBe(true);
    // 영수증에 카드가 찍혔는데 그 카드를 맞추지 못해 습관으로 골랐다
    expect(familiarity(db, byHistory('receipt', { paymentHint: '삼성카드 ****1234' }), 'receipt').reason).toBe('결제수단을 확인해 주세요');
    // 같은 가게를 다른 결제수단으로도 넣었다 — 이번에 무엇으로 냈는지 모른다
    addTransaction(db, { payment_method: '현금', date: addDays(TODAY, -30), budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 4500 });
    expect(familiarity(db, byHistory('text'), 'text', { said: '스타벅스 5천원' }).reason).toBe('결제수단을 확인해 주세요');
  });

  test('B-096 말로 입력: 다른 결제수단을 말했으면 늘 쓰던 결제수단(습관)으로 바로 넣지 않는다', () => {
    const db = makeDb();                         // 스타벅스는 늘 신한카드
    const byHistory = over => familiarSuggestion({ sources: { date: 'text', category: 'history', payment_method: 'history' }, ...over });
    // AI가 말한 카드를 못 짚어 습관(신한카드)으로 골랐다 — 글에 다른 카드가 있다
    expect(familiarity(db, byHistory(), 'text', { said: '현대카드 스타벅스 5천원' }).reason).toBe('결제수단을 확인해 주세요');
    expect(familiarity(db, byHistory(), 'text', { said: '스타벅스 5천원 KB국민' }).reason).toBe('결제수단을 확인해 주세요');
    expect(familiarity(db, byHistory({ paymentSaid: '현대' }), 'text', { said: '현대 스타벅스 5천원' }).reason).toBe('결제수단을 확인해 주세요');
    // 말한 것이 습관과 같거나, 결제수단 얘기가 없으면 습관대로
    expect(familiarity(db, byHistory({ paymentSaid: '신한' }), 'text', { said: '신한 스타벅스 5천원' }).familiar).toBe(true);
    expect(familiarity(db, byHistory(), 'text', { said: '스타벅스 5천원' }).familiar).toBe(true);
  });

  test('B-096 말로 입력: 가게 이름 속 글자나 다른 갈래의 카드는 그 결제수단 이야기가 아니다', () => {
    const db = makeDb();
    db.run("INSERT INTO payment_methods (name, sort_order) VALUES ('하나카드', 9)");
    const habitTx = detail => addTransaction(db, { payment_method: '신한카드', date: addDays(TODAY, -3), budget_category: '식비', sub_category: '외식', detail, amount: 30000 });
    const byHistory = name => familiarSuggestion({
      merchant: name, detail: name, historyDetail: name, sub_category: '외식',
      sources: { date: 'text', category: 'history', payment_method: 'history' },
    });
    // 늘 신한카드로 넣던 하나로마트 — '하나'는 가게 이름이지 하나카드가 아니다
    habitTx('하나로마트'); habitTx('하나로마트');
    expect(familiarity(db, byHistory('하나로마트'), 'text', { said: '하나로마트 3만원' }).familiar).toBe(true);
    // '교통카드 충전'의 '카드'는 이름의 일부
    habitTx('교통카드 충전'); habitTx('교통카드 충전');
    expect(familiarity(db, byHistory('교통카드 충전'), 'text', { said: '교통카드 충전 5만원' }).familiar).toBe(true);
    expect(familiarity(db, byHistory('교통카드 충전'), 'text', { said: '교통카드 충전 5만원 하나카드' }).reason).toBe('결제수단을 확인해 주세요');
    // '신한체크'라고 했으면 신한카드를 말한 것이 아니다 — '신한카드로'·'신한으로'는 맞다
    const spoken = familiarSuggestion({ sources: { date: 'text', category: 'history', payment_method: 'text' } });
    expect(familiarity(db, spoken, 'text', { said: '스타벅스 5천원 신한체크' }).reason).toBe('결제수단을 확인해 주세요');
    expect(familiarity(db, spoken, 'text', { said: '스타벅스 5천원 신한카드로' }).familiar).toBe(true);
    expect(familiarity(db, spoken, 'text', { said: '스타벅스 5천원 신한으로' }).familiar).toBe(true);
  });

  test("B-096 말로 입력: 말한 표현('현대카드')이 목록 표기('현대카드M')를 가리키면 그 결제수단으로 바로 넣는다", () => {
    const db = makeDb();
    db.run("INSERT INTO payment_methods (name, sort_order) VALUES ('현대카드M', 9)");
    const s = familiarSuggestion({ payment_method: '현대카드M', paymentSaid: '현대카드', sources: { date: 'text', category: 'history', payment_method: 'text' } });
    expect(familiarity(db, s, 'text', { said: '현대카드 스타벅스 5천원' }).familiar).toBe(true);
    // AI가 짚은 표현이 글에 없으면 믿지 않는다
    expect(familiarity(db, s, 'text', { said: '스타벅스 5천원' }).reason).toBe('결제수단을 확인해 주세요');
    // 표현이 다른 결제수단을 가리키면 아니다
    expect(familiarity(db, { ...s, paymentSaid: '신한카드' }, 'text', { said: '신한카드 스타벅스 5천원' }).reason).toBe('결제수단을 확인해 주세요');
  });

  test('앞날짜 거래와, 한 번에 온 목록 안의 같은 거래는 확인받는다', () => {
    const db = makeDb();
    expect(familiarity(db, familiarSuggestion({ date: addDays(TODAY, 1) }), 'sms').reason).toBe('앞날짜 거래예요');
    const { familiar, review } = splitFamiliar(db, [familiarSuggestion(), familiarSuggestion(), familiarSuggestion({ amount: 6000 })], 'sms');
    expect(familiar.map(s => s.amount)).toEqual([6000]);
    expect(review.map(r => r.reason)).toEqual([expect.stringContaining('같은 거래가 두 번'), expect.stringContaining('같은 거래가 두 번')]);
  });

  test('세부내역을 비운 다른 건(점심·저녁)은 같은 거래로 보지 않는다 (I-056)', () => {
    const db = makeDb();
    const blank = sub => familiarSuggestion({ merchant: '', detail: '', sub_category: sub, amount: 10000 });
    const { review } = splitFamiliar(db, [blank('카페'), blank('외식')], 'sms');
    expect(review.map(r => r.reason)).not.toContainEqual(expect.stringContaining('같은 거래가 두 번'));
  });

  test('취소·환불·거절·예약·할부 같은 말이 있으면 말로 입력을 바로 넣지 않는다', () => {
    expect(mayAutoAddText('스타벅스 4500 신한카드')).toBe(true);
    ['스타벅스 4500 결제 취소됐어', '쿠팡 환불 2만원', '다음 주 미용실 예약 3만원 현금', '노트북 3개월 할부 120만원'].forEach(t => {
      expect(mayAutoAddText(t)).toBe(false);
    });
  });

  test.each([
    ['승인 취소', { kind: 'cancel' }, '승인 취소'],
    ['빈 칸', { sub_category: '' }, '빈 칸'],
    ['금액 없음', { amount: null }, '빈 칸'],
    ['금액 0', { amount: 0 }, '금액'],
    ['외화', { currency: 'USD', foreignAmount: 3.5 }, '외화'],
    ['여행 일정', { event_id: 7 }, '여행'],
    ['중복', { duplicateOf: { id: 1 } }, '이미 넣은'],
    ['경고', { warnings: ['3개월 할부 — 전체 금액으로 넣습니다'] }, '할부'],
    ['AI가 고른 분류', { sources: { date: 'sms', category: 'ai', payment_method: 'sms' } }, '처음 보는 곳'],
    ['한 번만 넣은 곳', { historyCount: 1 }, '자주 넣던 곳이 아니에요'],
    ['두 글자만 겹치는 가게', { merchant: '커피빈', historyDetail: '커피', detail: '커피' }, "'커피'와 같은 곳인지"],
    ['AI가 짐작한 결제수단', { sources: { date: 'text', category: 'history', payment_method: 'ai' } }, '결제수단'],
    ['결제수단 근거 없음', { sources: { date: 'text', category: 'history' } }, '결제수단'],
  ])('%s → 확인받는다', (_, over, reason) => {
    const db = makeDb();
    const f = familiarity(db, familiarSuggestion(over), 'sms');
    expect(f.familiar).toBe(false);
    expect(f.reason).toContain(reason);
  });

  test('영수증은 날짜를 영수증에서 읽었고 AI가 확신할 때만', () => {
    const db = makeDb();
    const receipt = over => familiarSuggestion({ sources: { date: 'receipt', category: 'history', payment_method: 'receipt' }, ...over });
    expect(familiarity(db, receipt(), 'receipt').familiar).toBe(true);
    expect(familiarity(db, receipt({ confidence: 'low' }), 'receipt').reason).toContain('영수증');
    expect(familiarity(db, receipt({ sources: { date: 'today', category: 'history', payment_method: 'receipt' } }), 'receipt').reason).toContain('영수증');
  });

  test('같은 날 같은 금액 거래가 이미 있으면 확인받는다', () => {
    const db = makeDb();
    addTransaction(db, { payment_method: '신한카드', date: TODAY, budget_category: '식비', sub_category: '외식', detail: '점심', amount: 5000 });
    expect(familiarity(db, familiarSuggestion(), 'sms').reason).toContain('이미 있어요');
  });

  test('카드 문자에서: 늘 가던 곳은 바로, 처음 보는 곳·한 번 가 본 곳은 확인', () => {
    const db = makeDb();
    addTransaction(db, { payment_method: '신한카드', date: addDays(TODAY, -3), budget_category: '식비', sub_category: '외식', detail: '김밥천국', amount: 8000 });
    const sms = lines(
      '[Web발신]', `신한카드(1234)승인 홍*동 12,500원(일시불)${mmdd(TODAY)} 12:34 스타벅스코리아 누적1,234,567원`,
      '[Web발신]', `신한카드(1234)승인 홍*동 9,000원(일시불)${mmdd(TODAY)} 12:50 김밥천국 누적1,243,567원`,
      '[Web발신]', `신한카드(1234)승인 홍*동 30,000원(일시불)${mmdd(TODAY)} 13:10 처음가본가게 누적1,273,567원`,
    );
    const { items } = buildSmsSuggestions(db, sms, { today: TODAY });
    const { familiar, review } = splitFamiliar(db, items, 'sms');
    expect(familiar.map(s => s.detail)).toEqual(['스타벅스']);
    expect(review.map(r => [r.s.merchant, r.reason])).toEqual([
      ['김밥천국', '아직 자주 넣던 곳이 아니에요'],
      ['처음가본가게', '빈 칸이 있어요'],          // 분류를 정하지 못했다
    ]);
  });
});

describe('카드 문자로 보이는지 (looksLikeCardMessage)', () => {
  test.each([
    ['[Web발신]\n신한카드(1234)승인 홍*동 12,500원(일시불)11/08 12:34 스타벅스', true],
    ['신한카드(1234)승인 홍*동 12,500원(일시불)11/08 12:34 스타벅스', true],
    ['KB국민카드1234승인\n홍*동님\n45,000원 일시불\n11/07 19:05\n김밥천국', true],
    ['[현대카드] 승인 ABC마트 59,000원 11/08 12:00', true],
    ['삼성카드 8900원 승인 11.08 12:00 빵집', true],
    ['어제 신한카드로 스타벅스 4500원 결제했어', false],
    ['신한카드로 4.5천원 결제', false],
    ['신한카드 1.5만원 결제했고 커피 4,500원', false],
    ['점심 김치찌개 9천원 현금, 11/08 저녁 치킨 2만원', false],
    ['', false],
  ])('%s → %s', (text, expected) => {
    expect(looksLikeCardMessage(text)).toBe(expected);
  });
});

describe('바로 넣은 거래 되돌리기 (removeAddedTransactions)', () => {
  const tx = (over = {}) => ({ payment_method: '신한카드', date: TODAY, budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 5000, ...over });
  const add = (db, t) => addedSnapshot(addTransaction(db, t), t);
  const count = db => getTransactions(db).length;

  test('넣은 그대로면 지우고 지운 개수를 돌려준다 — 같은 거래 두 건도 둘 다', () => {
    const db = makeDb({ starbucks: 0 });
    const snaps = [add(db, tx()), add(db, tx()), add(db, tx({ amount: 3000, detail: '빵' }))];
    expect(count(db)).toBe(3);
    expect(removeAddedTransactions(db, snaps)).toBe(3);
    expect(count(db)).toBe(0);
  });

  test('그 사이 고쳤거나 지운 거래는 그대로 둔다', () => {
    const db = makeDb({ starbucks: 0 });
    const a = add(db, tx());
    const b = add(db, tx({ amount: 3000, detail: '빵' }));
    db.run('UPDATE transactions SET amount = 6000 WHERE id = ?', [a.id]);
    db.run('DELETE FROM transactions WHERE id = ?', [b.id]);
    expect(removeAddedTransactions(db, [a, b])).toBe(0);
    expect(getTransactions(db).map(t => t.amount)).toEqual([6000]);
  });

  // 충돌 병합으로 내 새 거래의 id가 밀리고, 원래 id에는 다른 기기의 거래가 들어온 상황을 만든다
  const remap = (db, snap, newId, other) => {
    db.run('UPDATE transactions SET id = ? WHERE id = ?', [newId, snap.id]);
    db.run(
      'INSERT INTO transactions (id, payment_method, date, budget_category, sub_category, detail, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [snap.id, other.payment_method, other.date, other.budget_category, other.sub_category, other.detail, other.amount],
    );
  };

  test('병합으로 id가 바뀌면 같은 모습의 거래가 하나일 때만 찾아 지운다 — 원래 id의 다른 거래는 두고', () => {
    const db = makeDb({ starbucks: 0 });
    const snap = add(db, tx());
    remap(db, snap, 100, tx({ detail: '다른 기기 점심', sub_category: '외식', amount: 9000 }));
    expect(removeAddedTransactions(db, [snap])).toBe(1);
    expect(getTransactions(db).map(t => t.detail)).toEqual(['다른 기기 점심']);
  });

  test('id가 바뀌었는데 같은 모습의 거래가 여럿이면 어느 것인지 몰라 지우지 않는다', () => {
    const db = makeDb({ starbucks: 0 });
    const snap = add(db, tx());
    remap(db, snap, 200, tx({ detail: '다른 기기 점심', sub_category: '외식', amount: 9000 }));
    addTransaction(db, tx());                                   // 다른 기기도 같은 날 같은 커피를 넣었다
    expect(removeAddedTransactions(db, [snap])).toBe(0);
    expect(count(db)).toBe(3);
  });
});
