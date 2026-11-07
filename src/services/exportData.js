/**
 * 내보내기 (I-014) — 거래 내역 CSV.
 *
 * 칸 이름은 거래 가져오기(IMPORT_GUIDE.md)와 같다 — 내보낸 파일을 그대로 다시 가져올 수 있다.
 * 가져오기에 없는 칸(member: 누가, foreign_amounts: 외화 금액 JSON)은 맨 뒤에 붙인다(가져오기는 무시한다).
 */
import { toCSV, escapeSpreadsheetText } from './csv';
import { getTransactions, getCalendarEvents, getCalendarEventTypes } from './dbManager';

export const EXPORT_HEADERS = [
  'payment_method', 'date', 'budget_category', 'sub_category', 'detail',
  'amount', 'discount_amount', 'discount_note', 'trip_name', 'trip_schedule',
  'member', 'foreign_amounts',
];

// 글자 칸은 엑셀이 수식으로 실행하지 않게 감싼다 (가져오기가 다시 벗긴다)
const TEXT_COLUMNS = ['payment_method', 'budget_category', 'sub_category', 'detail', 'discount_note', 'trip_name', 'member'];

/**
 * 기간({ from, to } — 둘 다 비면 전체)의 거래를 CSV 텍스트로. 날짜 오름차순.
 * 반환: { csv, count }
 */
export function buildTransactionsCSV(db, { from = '', to = '' } = {}) {
  const tripTypes = new Set(getCalendarEventTypes(db).filter(t => t.is_trip_type).map(t => t.value));
  const trips = {};
  getCalendarEvents(db, { includeHidden: true }).forEach(ev => {
    if (!tripTypes.has(ev.event_type)) return;
    const schedule = ev.date_from
      ? (ev.date_to && ev.date_to !== ev.date_from ? `${ev.date_from} ~ ${ev.date_to}` : ev.date_from)
      : '';
    trips[ev.id] = { name: ev.title, schedule };
  });

  const txs = getTransactions(db, { dateFrom: from || undefined, dateTo: to || undefined }).reverse();
  const rows = txs.map(tx => {
    const trip = tx.event_id ? trips[tx.event_id] : null;
    const row = {
      payment_method: tx.payment_method,
      date: tx.date,
      budget_category: tx.budget_category,
      sub_category: tx.sub_category || '',
      detail: tx.detail || '',
      amount: tx.amount,
      discount_amount: tx.discount_amount || 0,
      discount_note: tx.discount_note || '',
      trip_name: trip ? trip.name : '',
      trip_schedule: trip ? trip.schedule : '',
      member: tx.member || '',
      foreign_amounts: tx.foreign_amounts || '',
    };
    TEXT_COLUMNS.forEach(c => { row[c] = escapeSpreadsheetText(row[c]); });
    return row;
  });
  return { csv: toCSV(EXPORT_HEADERS, rows), count: rows.length };
}
