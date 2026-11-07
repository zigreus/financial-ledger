/**
 * @vitest-environment node
 */
// 거래 CSV 내보내기 (I-014) — 가져오기와 같은 칸, 다시 읽으면 같은 값
import initSqlJs from 'sql.js';
import { createDatabase, addTransaction, addCalendarEvent } from '../dbManager';
import { buildTransactionsCSV, EXPORT_HEADERS } from '../exportData';
import { parseCSV, toCSV, escapeSpreadsheetText, unescapeSpreadsheetText } from '../csv';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

test('toCSV는 쉼표·따옴표·줄바꿈을 감싸고, parseCSV로 다시 읽으면 같은 값이다', () => {
  const rows = [{ a: '점심, 저녁', b: '말 "따옴표"', c: '두\n줄' }, { a: '', b: 0, c: null }];
  const back = parseCSV(toCSV(['a', 'b', 'c'], rows)).map(r => r.fields);
  expect(back).toEqual([{ a: '점심, 저녁', b: '말 "따옴표"', c: '두\n줄' }, { a: '', b: '0', c: '' }]);
});

test('기간 안 거래를 날짜순으로, 여행 일정·누가·외화까지 내보낸다', () => {
  const { db } = createDatabase(SQL, null);
  const trip = addCalendarEvent(db, { title: '일본 도쿄', date_from: '2026-02-03', date_to: '2026-02-07', event_type: 'trip' });
  const party = addCalendarEvent(db, { title: '돌잔치', date_from: '2026-02-10', date_to: '2026-02-10', event_type: 'occasion' });
  addTransaction(db, { payment_method: '카드', date: '2026-02-05', budget_category: '여행', sub_category: '숙박', detail: '호텔', amount: 220000, event_id: trip, foreign_amounts: { JPY: 25000 }, member: '엄마' });
  addTransaction(db, { payment_method: '현금', date: '2026-02-01', budget_category: '식비', detail: '점심, 김밥', amount: 9000, discount_amount: 1000, discount_note: '쿠폰' });
  addTransaction(db, { payment_method: '카드', date: '2026-02-10', budget_category: '경조사', detail: '축의금', amount: 100000, event_id: party });
  addTransaction(db, { payment_method: '카드', date: '2026-03-01', budget_category: '식비', detail: '기간 밖', amount: 1 });

  const { csv, count } = buildTransactionsCSV(db, { from: '2026-02-01', to: '2026-02-28' });
  expect(count).toBe(3);
  const rows = parseCSV(csv).map(r => r.fields);
  expect(Object.keys(rows[0])).toEqual(EXPORT_HEADERS);
  expect(rows.map(r => r.detail)).toEqual(['점심, 김밥', '호텔', '축의금']);
  expect(rows[0]).toMatchObject({ amount: '9000', discount_amount: '1000', discount_note: '쿠폰', trip_name: '', member: '' });
  expect(rows[1]).toMatchObject({
    trip_name: '일본 도쿄', trip_schedule: '2026-02-03 ~ 2026-02-07', member: '엄마', foreign_amounts: '{"JPY":25000}',
  });
  expect(rows[2].trip_name).toBe(''); // 여행이 아닌 일정은 trip_name으로 내보내지 않는다(다시 가져올 때 여행이 생기지 않게)

  // 숨긴(지난) 여행 일정도 연결을 잃지 않는다
  db.run('UPDATE calendar_events SET is_hidden = 1 WHERE id = ?', [trip]);
  const again = parseCSV(buildTransactionsCSV(db, { from: '2026-02-01', to: '2026-02-28' }).csv).map(r => r.fields);
  expect(again[1].trip_name).toBe('일본 도쿄');

  expect(buildTransactionsCSV(db).count).toBe(4); // 기간이 없으면 전체
});

test('엑셀이 수식으로 실행하지 않게 =, +, -, @로 시작하는 글자 칸에 따옴표를 붙이고, 가져오기는 다시 뗀다', () => {
  const { db } = createDatabase(SQL, null);
  addTransaction(db, { payment_method: '카드', date: '2026-02-01', budget_category: '식비', detail: '=HYPERLINK("x")', amount: 1000 });
  addTransaction(db, { payment_method: '카드', date: '2026-02-02', budget_category: '식비', detail: '-할인 반영', amount: 2000 });
  const rows = parseCSV(buildTransactionsCSV(db).csv).map(r => r.fields);
  expect(rows[0].detail).toBe('\'=HYPERLINK("x")');
  expect(rows[1].detail).toBe('\'-할인 반영');
  expect(rows[0].amount).toBe('1000'); // 숫자 칸은 그대로
  expect(rows.map(r => unescapeSpreadsheetText(r.detail))).toEqual(['=HYPERLINK("x")', '-할인 반영']);
  // 평범한 글자, 원래 '로 시작하던 글자는 건드리지 않는다
  expect(escapeSpreadsheetText('점심')).toBe('점심');
  expect(unescapeSpreadsheetText("'따옴표로 시작")).toBe("'따옴표로 시작");
});
