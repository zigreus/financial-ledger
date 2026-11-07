/**
 * @vitest-environment jsdom
 */
// 카드 승인 문자 → 거래 추천 (I-012)
import initSqlJs from 'sql.js';
import { createDatabase, addTransaction } from '../dbManager';
import {
  splitMessages, parseCardMessage, parseCardMessages, buildSmsSuggestions, rememberCards, loadCardMap,
} from '../cardSms';

const TODAY = '2026-11-08';
const lines = (...l) => l.join('\n');

const SHINHAN = '[Web발신]\n신한카드(1234)승인 홍*동 12,500원(일시불)11/08 12:34 스타벅스코리아 누적1,234,567원';
const KB = '[Web발신]\nKB국민카드1234승인\n홍*동님\n45,000원 일시불\n11/07 19:05\n김밥천국 강남점\n누적1,234,567원';
const SAMSUNG = '[Web발신]\n삼성1234승인 홍*동\n8,900원 일시불\n11/06 08:12 GS25 역삼점\n누적100,000원';
const HYUNDAI = '[Web발신]\n현대카드 M 승인\n홍*동\n360,000원 03개월\n10/30 14:20\n하이마트\n누적2,000,000원';
const CHECK = '[Web발신]\n신한체크승인 홍*동 5,000원 11/08 09:00 (주)이마트24 잔액30,000원';
const CANCEL = '[Web발신]\n신한카드(1234)승인취소 홍*동 12,500원(일시불)11/08 13:00 스타벅스코리아';
const OVERSEAS = '[Web발신]\n신한카드(1234)해외승인 홍*동 USD 12.50 11/05 03:12 AMAZON.COM';
const PAY_PUSH = '[카카오페이] 스타벅스 12,500원 결제 완료 11/08 12:00';

describe('문자 하나 읽기', () => {
  test('신한 한 줄 문자 — 누적 금액은 결제 금액이 아니다', () => {
    const m = parseCardMessage(SHINHAN.replace('[Web발신]\n', ''), TODAY);
    expect(m).toMatchObject({
      kind: 'approve', issuer: '신한', digits: '1234', isCheck: false, cardKey: '신한카드 1234',
      amount: 12500, currency: 'KRW', date: '2026-11-08', time: '12:34', merchant: '스타벅스코리아',
    });
  });

  test('KB 여러 줄 문자 — 이름 줄을 건너뛰고 시각 다음 줄이 가맹점', () => {
    const m = parseCardMessages(KB, TODAY).messages[0];
    expect(m).toMatchObject({ issuer: 'KB국민', digits: '1234', amount: 45000, date: '2026-11-07', merchant: '김밥천국 강남점' });
  });

  test('삼성 — 시각과 같은 줄의 가맹점', () => {
    const m = parseCardMessages(SAMSUNG, TODAY).messages[0];
    expect(m).toMatchObject({ issuer: '삼성', amount: 8900, date: '2026-11-06', merchant: 'GS25 역삼점' });
  });

  test('현대 — 카드 끝자리가 없어도 읽고, 할부 개월을 읽는다', () => {
    const m = parseCardMessages(HYUNDAI, TODAY).messages[0];
    expect(m).toMatchObject({ issuer: '현대', digits: '', amount: 360000, installment: 3, date: '2026-10-30', merchant: '하이마트' });
  });

  test('체크카드 — 잔액은 금액이 아니고, (주)는 지운다', () => {
    const m = parseCardMessages(CHECK, TODAY).messages[0];
    expect(m).toMatchObject({ isCheck: true, cardKey: '신한체크', amount: 5000, merchant: '이마트24' });
  });

  test('승인 취소', () => {
    const m = parseCardMessages(CANCEL, TODAY).messages[0];
    expect(m).toMatchObject({ kind: 'cancel', amount: 12500, merchant: '스타벅스코리아' });
  });

  test('해외 승인 — 외화 금액', () => {
    const m = parseCardMessages(OVERSEAS, TODAY).messages[0];
    expect(m).toMatchObject({ amount: null, currency: 'USD', foreignAmount: 12.5, merchant: 'AMAZON.COM', date: '2026-11-05' });
  });

  test('간편결제 알림의 [이름]은 발급사로 보고, 바로 뒤 가맹점을 지우지 않는다', () => {
    const m = parseCardMessages(PAY_PUSH, TODAY).messages[0];
    expect(m).toMatchObject({ issuer: '카카오페이', cardKey: '카카오페이', amount: 12500, merchant: '스타벅스' });
  });

  test('연도가 없는 날짜는 오늘 기준 가장 가까운 과거 — 1월에 받은 12월 문자는 작년', () => {
    const m = parseCardMessage('신한카드(1234)승인 홍*동 9,000원(일시불)12/30 10:00 서점', '2026-01-03');
    expect(m.date).toBe('2025-12-30');
  });

  test('금액이 없는 글은 건너뛴 글로 돌려준다', () => {
    const r = parseCardMessages('오늘 점심 뭐 먹지?', TODAY);
    expect(r.messages).toHaveLength(0);
    expect(r.skipped).toEqual([{ text: '오늘 점심 뭐 먹지?', reason: 'unread' }]);
  });
});

describe('리뷰에서 찾은 문자 모양', () => {
  const read = (text, today = TODAY) => parseCardMessages(text, today);

  test('승인 거절·잔액 부족 문자는 결제가 아니라 건너뛴다', () => {
    const r = read(lines(
      '[Web발신]', '신한체크 승인거절 홍*동 12,500원 11/08 12:34 스타벅스 잔액부족',
      '[Web발신]', 'KB국민카드1*2*거절', '홍*동님', '9,000원', '11/08 10:00', '편의점',
    ));
    expect(r.messages).toHaveLength(0);
    expect(r.skipped.map(x => x.reason)).toEqual(['declined', 'declined']);
  });

  test('결제 예정·출금 예정 안내는 결제가 아니라 건너뛴다', () => {
    const r = read('신한카드 11월 결제예정금액 1,234,567원 (11/15 출금예정)');
    expect(r.messages).toHaveLength(0);
    expect(r.skipped[0].reason).toBe('notice');
  });

  test('간편결제 알림의 가맹점 이름에 카드사 글자가 있어도 발급사로 보지 않는다', () => {
    expect(read('[카카오페이] 하나로마트 32,000원 결제 완료 11/08 12:00').messages[0])
      .toMatchObject({ issuer: '카카오페이', merchant: '하나로마트', amount: 32000 });
    expect(read('[토스] 롯데리아 4,500원 결제 11/08 12:00').messages[0])
      .toMatchObject({ issuer: '토스', merchant: '롯데리아', cardKey: '토스' });
    expect(read('[현대카드] 승인 ABC마트 59,000원 11/08 12:00').messages[0])
      .toMatchObject({ issuer: '현대', cardKey: '현대카드', merchant: 'ABC마트' });
  });

  test('가린 이름은 머리말 이름 자리만 지운다 — 해외 가맹점의 *는 그대로', () => {
    expect(read(lines('[Web발신]', '신한카드(1234)해외승인 홍*동 USD 9.99 11/05 03:12 AMZN Mktp US*2K3')).messages[0].merchant)
      .toBe('AMZN Mktp US*2K3');
    expect(read(lines('[Web발신]', '신한카드(1234)승인 홍길* 4,000원(일시불)11/08 12:34 GOOGLE*YOUTUBE')).messages[0].merchant)
      .toBe('GOOGLE*YOUTUBE');
    expect(read(lines('[Web발신]', 'KB국민카드1234승인', '홍길동님', '8,000원 일시불', '11/07 19:05', '김밥천국')).messages[0].merchant)
      .toBe('김밥천국');
  });

  test('가맹점 줄에 결제·승인 글자가 있어도 문자를 나누지 않는다', () => {
    const r = read(lines('[Web발신]', 'KB국민카드1234승인', '홍*동님', '15,000원 일시불', '11/07 19:05', '네이버페이결제', '누적1,000,000원'));
    expect(r.messages).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
    expect(r.messages[0].merchant).toBe('네이버페이결제');
  });

  test('카드 끝자리 자리의 숫자가 금액이면 끝자리로 보지 않고, 가맹점 속 취소는 취소가 아니다', () => {
    expect(read('삼성카드 8900원 승인 11/08 12:00 빵집').messages[0]).toMatchObject({ digits: '', cardKey: '삼성카드', amount: 8900 });
    expect(read(lines('[Web발신]', '신한카드(1234)승인', '홍*동', '30,000원 일시불', '11/08 12:00', '취소불가상품몰')).messages[0])
      .toMatchObject({ kind: 'approve', merchant: '취소불가상품몰' });
  });

  test('하나카드처럼 승인 말이 없는 머리말, 점 날짜, 대괄호 가맹점, CRLF, 가린 끝자리', () => {
    expect(read('하나(1*2*)홍*동님 11/08 12:34 일시불 / 12,500원 / 스타벅스').messages[0])
      .toMatchObject({ issuer: '하나', digits: '1*2*', merchant: '스타벅스', amount: 12500, date: '2026-11-08' });
    expect(read(['[Web발신]', '우리(1234)승인', '홍*동님', '7,000원 일시불', '11.07 12:00', '맥도날드'].join('\r\n')).messages[0])
      .toMatchObject({ date: '2026-11-07', merchant: '맥도날드' });
    expect(read(lines('[Web발신]', 'NH카드1*2*승인', '홍*동', '12,000원 일시불', '11/08 09:00', '[쿠팡]로켓배송')).messages[0])
      .toMatchObject({ issuer: 'NH농협', digits: '1*2*', merchant: '쿠팡 로켓배송' });
  });
});

describe('최종 점검에서 찾은 문자 모양', () => {
  const read = (text, today = TODAY) => parseCardMessages(text, today);

  test('카드사 이름으로 시작하는 가맹점 줄(하나로마트 결제)에서 문자를 나누지 않는다', () => {
    const r = read(lines('[Web발신]', 'KB국민카드1234승인', '홍*동님', '32,000원 일시불', '11/07 19:05', '하나로마트 결제', '누적1,000,000원'));
    expect(r.messages).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
    expect(r.messages[0]).toMatchObject({ issuer: 'KB국민', merchant: '하나로마트' }); // 끝의 '결제'는 지운다
  });

  test('단어 속 영문 약자(ABC마트의 BC)나 가맹점 이름 속 카드사 글자는 발급사가 아니다', () => {
    expect(read('ABC마트 12,000원 결제 11/08 12:00').messages[0]).toMatchObject({ issuer: '', merchant: 'ABC마트' });
    expect(read('롯데시네마 15,000원 결제 11/08 12:00').messages[0]).toMatchObject({ issuer: '', merchant: '롯데시네마' });
  });

  test('*가 들어간 한글 가맹점은 이름으로 보고 지우지 않는다', () => {
    expect(read('신한카드(1234)승인 홍*동 8,000원(일시불)11/08 12:34 쿠팡*로켓').messages[0].merchant).toBe('쿠팡*로켓');
    expect(read(lines('[Web발신]', 'KB국민카드1234승인', '홍*동님', '9,000원 일시불', '11/07 19:05', '카카오*택시')).messages[0].merchant).toBe('카카오*택시');
  });

  test('수신거부 안내 줄은 거절이 아니고, 표시 없이 붙은 거절 문자는 다음 승인과 나눈다', () => {
    const footer = read(lines('[Web발신]', '신한카드(1234)승인 홍*동 8,000원(일시불)11/08 12:34 빵집', '무료수신거부 080-000-0000'));
    expect(footer.messages[0]).toMatchObject({ amount: 8000, merchant: '빵집' });
    const glued = read(lines('KB국민카드1234거절', '홍*동님', '9,000원', '11/08 10:00', '편의점', 'KB국민카드1234승인', '홍*동님', '4,000원', '11/08 10:05', '편의점'));
    expect(glued.messages.map(m => m.amount)).toEqual([4000]);
    expect(glued.skipped.map(x => x.reason)).toEqual(['declined']);
  });
});

describe('붙여넣은 글 나누기', () => {
  test('[Web발신]으로 나뉜 여러 문자', () => {
    expect(splitMessages([SHINHAN, KB, SAMSUNG].join('\n'))).toHaveLength(3);
  });

  test('표시 없이 줄마다 붙어 있는 한 줄 문자', () => {
    const text = lines('신한카드(1234)승인 홍*동 12,500원(일시불)11/08 12:34 스타벅스', '신한카드(1234)승인 홍*동 3,000원(일시불)11/08 15:00 편의점');
    const r = parseCardMessages(text, TODAY);
    expect(r.messages.map(m => [m.amount, m.merchant])).toEqual([[12500, '스타벅스'], [3000, '편의점']]);
  });

  test('표시·빈 줄 없이 이어 붙은 여러 줄 문자도 새 승인 머리말에서 나눈다', () => {
    const strip = s => s.replace('[Web발신]\n', '');
    const r = parseCardMessages(lines(strip(KB), strip(KB).replace('45,000원', '7,000원').replace('김밥천국 강남점', '빵집')), TODAY);
    expect(r.messages.map(m => [m.amount, m.merchant])).toEqual([[45000, '김밥천국 강남점'], [7000, '빵집']]);
  });
});

// ── DB와 맞춰 추천 만들기 ─────────────────────────────────────

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => window.localStorage.clear());

function makeDb() {
  const { db } = createDatabase(SQL, null);
  db.run('DELETE FROM payment_methods');
  ['신한카드', '신한체크', 'KB국민카드', '현금'].forEach((n, i) => db.run('INSERT INTO payment_methods (name, sort_order) VALUES (?, ?)', [n, i]));
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('식비', 0)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('식비', '카페', 0), ('식비', '외식', 1)");
  // 예전 습관: 스타벅스 → 식비 > 카페
  addTransaction(db, { payment_method: '신한카드', date: '2026-10-01', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 5000 });
  return db;
}

describe('추천 만들기', () => {
  test('카드사 이름으로 결제수단을 고르고(체크 문자는 체크), 예전 습관으로 분류한다', () => {
    const db = makeDb();
    const { items } = buildSmsSuggestions(db, [SHINHAN, CHECK, KB].join('\n'), { today: TODAY });
    expect(items.map(s => s.payment_method)).toEqual(['신한카드', '신한체크', 'KB국민카드']);
    expect(items[0]).toMatchObject({ detail: '스타벅스', budget_category: '식비', sub_category: '카페', amount: 12500 });
    expect(items[0].sources.payment_method).toBe('sms');
  });

  test('기억해 둔 카드 → 결제수단이 우선이고, 목록에 없는 결제수단 기억은 버린다', () => {
    const db = makeDb();
    rememberCards([['신한카드 1234', '현금'], ['KB국민카드 1234', '없는카드']]);
    expect(loadCardMap()['신한카드 1234']).toBe('현금');
    const { items } = buildSmsSuggestions(db, [SHINHAN, KB].join('\n'), { today: TODAY });
    expect(items.map(s => s.payment_method)).toEqual(['현금', 'KB국민카드']);
  });

  test('가계부에 이미 있는 거래와 같은 문자를 두 번 붙여넣은 것은 중복으로 표시한다', () => {
    const db = makeDb();
    addTransaction(db, { payment_method: 'KB국민카드', date: '2026-11-07', budget_category: '식비', sub_category: '외식', detail: '김밥', amount: 45000 });
    const { items } = buildSmsSuggestions(db, [KB, SAMSUNG, SAMSUNG].join('\n'), { today: TODAY });
    expect(items[0].duplicateOf).toMatchObject({ date: '2026-11-07', amount: 45000 });
    expect(items[1].duplicateOf).toBeNull();
    expect(items[2].duplicateOf).toEqual({ inPaste: true });
  });

  test('승인 취소 문자는 지울 거래 후보를 찾는다(분할 결제는 제외)', () => {
    const db = makeDb();
    const id = addTransaction(db, { payment_method: '신한카드', date: '2026-11-08', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 12500 });
    addTransaction(db, { payment_method: '신한카드', date: '2026-11-08', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 12500, split_group_id: 'sg-1' });
    const { items } = buildSmsSuggestions(db, CANCEL, { today: TODAY });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'cancel', match: { id, strong: true, daysBefore: 0 } });
  });

  test('이미 적어 둔 결제의 승인과 취소를 함께 붙여넣으면, 취소가 그 거래를 지울 후보가 된다', () => {
    const db = makeDb();
    const id = addTransaction(db, { payment_method: '신한카드', date: '2026-11-08', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 12500 });
    const { items } = buildSmsSuggestions(db, [SHINHAN, CANCEL].join('\n'), { today: TODAY });
    const approve = items.find(s => s.kind === 'approve');
    const cancel = items.find(s => s.kind === 'cancel');
    expect(approve.duplicateOf).toMatchObject({ id });
    expect(cancel).toMatchObject({ pairedInPaste: false, match: { id, strong: true } });
  });

  test('승인·취소를 함께 붙여넣었을 때, 가계부의 같은 카드·같은 날·같은 금액 다른 거래나 분할 몫은 미리 체크하지 않는다', () => {
    const db = makeDb();
    const other = addTransaction(db, { payment_method: '신한카드', date: '2026-11-08', budget_category: '식비', sub_category: '외식', detail: '점심 김밥', amount: 12500 });
    let items = buildSmsSuggestions(db, [SHINHAN, CANCEL].join('\n'), { today: TODAY }).items;
    expect(items.find(s => s.kind === 'cancel').match).toMatchObject({ id: other, strong: false });

    const db2 = makeDb();
    addTransaction(db2, { payment_method: '신한카드', date: '2026-11-08', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 12500, split_group_id: 'sg-9' });
    addTransaction(db2, { payment_method: '현금', date: '2026-11-08', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 12500, split_group_id: 'sg-9' });
    items = buildSmsSuggestions(db2, [SHINHAN, CANCEL].join('\n'), { today: TODAY }).items;
    expect(items.find(s => s.kind === 'cancel').match).toBeNull(); // 분할 몫은 자동으로 고르지 않는다
  });

  test('취소 문자와 금액이 같아도 가맹점이 다른 새 승인과는 짝짓지 않는다', () => {
    const db = makeDb();
    const other = lines('[Web발신]', '신한카드(1234)승인 홍*동 12,500원(일시불)11/08 14:00 서점');
    const { items } = buildSmsSuggestions(db, [other, CANCEL].join('\n'), { today: TODAY });
    expect(items.find(s => s.kind === 'approve').pairedCancel).toBeFalsy();
    expect(items.find(s => s.kind === 'cancel').pairedInPaste).toBe(false);
  });

  test('일주일 전 같은 가게·같은 금액 거래는 후보로만 보여 주고 미리 체크하지 않는다', () => {
    const db = makeDb();
    const id = addTransaction(db, { payment_method: '신한카드', date: '2026-11-01', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 12500 });
    const { items } = buildSmsSuggestions(db, CANCEL, { today: TODAY });
    expect(items[0].match).toMatchObject({ id, daysBefore: 7, strong: false });
  });

  test('같은 글에 승인과 그 취소가 함께 있으면 둘 다 건너뛴다', () => {
    const db = makeDb();
    const { items } = buildSmsSuggestions(db, [SHINHAN, CANCEL].join('\n'), { today: TODAY });
    const approve = items.find(s => s.kind === 'approve');
    const cancel = items.find(s => s.kind === 'cancel');
    expect(approve.pairedCancel).toBe(true);
    expect(cancel).toMatchObject({ pairedInPaste: true, match: null, amount: 12500 });
  });

  test('해외 결제는 여행 일정이 없으면 원화를 비우고 알린다', () => {
    const db = makeDb();
    const { items } = buildSmsSuggestions(db, OVERSEAS, { today: TODAY });
    expect(items[0]).toMatchObject({ amount: null, currency: 'USD', foreignAmount: 12.5 });
    expect(items[0].warnings.join(' ')).toMatch(/여행 일정이 없습니다/);
  });
});
