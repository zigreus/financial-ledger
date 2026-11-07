/**
 * 가져오기 공통 도우미 — 거래내역 가져오기(ImportModal)와 계좌 내역 불러오기가 함께 쓴다.
 *  - 날짜·금액 정규화 (실제 달력 기준 검사, parseInt 미사용)
 *  - 이미 있는 내역과 겹치는 행 표시 (같은 파일을 두 번 올려도 두 배가 되지 않게)
 *  - 여행 이름·일정 → 캘린더 여행 일정 연결
 */
import { getCalendarEventTypes, addCalendarEvent } from './dbManager';
import { ymd, isValidDateStr } from './dateUtils';

function toDateStr(y, m, d) {
  const s = ymd(y, m, d);
  return isValidDateStr(s) ? s : null;
}

/**
 * 날짜 문자열을 'YYYY-MM-DD'로 바꾼다. 실제로 없는 날짜(2026-02-30, 13월 등)면 null.
 * 2026-05-25 / 2026.05.25 / 2026/5/25 / '2026-05-25 14:33' 형식을 받는다.
 */
export function normalizeDateStr(raw) {
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?=$|[\sT])/.exec(String(raw ?? '').trim());
  if (!m) return null;
  return toDateStr(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * 파일에서 읽은 금액 → 원 단위 정수. 비었으면 null, 숫자가 아니면 NaN.
 * 쉼표·공백·'원'·'₩'은 무시하고, 음수는 그대로 돌려준다(호출부에서 판단).
 * 칸이 밀린 행(날짜가 금액 칸에 들어간 경우 등)을 잡아내려고 수식은 받지 않는다.
 */
export function parseImportAmount(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : NaN;
  const s = String(raw).replace(/[,\s원₩]/g, '');
  if (s === '') return null;
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return NaN;
  return Math.round(Number(s));
}

// ── 중복 표시 ────────────────────────────────────────────────────

/**
 * 이미 DB에 있는 내역과 같은 행에 isDuplicate를 붙인다.
 * 같은 키의 행이 파일에 n개, DB에 m개 있으면 앞의 min(n, m)개만 중복으로 본다 —
 * 같은 날 같은 금액의 커피 두 잔처럼 원래 여러 건인 내역을 지키기 위해서다.
 */
export function markDuplicates(rows, keyOf, existingCounts) {
  const seen = new Map();
  return rows.map(row => {
    const key = keyOf(row);
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    return { ...row, isDuplicate: n < (existingCounts.get(key) || 0) };
  });
}

function dateRange(rows) {
  const dates = rows.map(r => r.date).filter(Boolean).sort();
  return dates.length ? [dates[0], dates[dates.length - 1]] : null;
}

function countBy(res) {
  const map = new Map();
  (res[0]?.values || []).forEach(row => {
    const cnt = row[row.length - 1];
    map.set(row.slice(0, -1).join('|'), Number(cnt) || 0);
  });
  return map;
}

/** 가계부 거래 중복 키: 날짜 + 결제수단 + 금액 + 세부내역 */
export const txDuplicateKey = (r) => [r.date, r.payment_method, r.amount, r.detail || ''].join('|');

export function countExistingTransactions(db, rows) {
  const range = dateRange(rows);
  if (!range) return new Map();
  return countBy(db.exec(
    `SELECT date, payment_method, amount, COALESCE(detail, ''), COUNT(*)
     FROM transactions WHERE date BETWEEN ? AND ?
     GROUP BY date, payment_method, amount, COALESCE(detail, '')`,
    range
  ));
}

/** 계좌 내역 중복 키: 날짜 + 수입/지출 + 금액 + 내용 */
export const accountTxDuplicateKey = (r) => [r.date, r.type, r.amount, r.description || ''].join('|');

export function countExistingAccountTransactions(db, accountId, rows) {
  const range = dateRange(rows);
  if (!range) return new Map();
  return countBy(db.exec(
    `SELECT date, type, amount, COALESCE(description, ''), COUNT(*)
     FROM account_transactions WHERE account_id = ? AND date BETWEEN ? AND ?
     GROUP BY date, type, amount, COALESCE(description, '')`,
    [accountId, ...range]
  ));
}

// ── 여행 일정 연결 ───────────────────────────────────────────────

/**
 * '2026-02-03 ~ 2026-02-07', '2026-01-18 ~ 01-22', '2026-02-03' → { from, to }. 읽을 수 없으면 null.
 */
export function parseTripSchedule(schedule) {
  const s = String(schedule ?? '').trim();
  if (!s) return null;
  const [left, right] = s.split('~').map(x => x.trim());
  const from = normalizeDateStr(left);
  if (!from) return null;
  if (right === undefined || right === '') return { from, to: from };
  let to = normalizeDateStr(right);
  if (!to) {
    const md = /^(\d{1,2})[-./](\d{1,2})$/.exec(right);
    if (!md) return null;
    const year = Number(from.slice(0, 4));
    to = toDateStr(year, Number(md[1]), Number(md[2]));
    if (to && to < from) to = toDateStr(year + 1, Number(md[1]), Number(md[2])); // 해를 넘기는 여행
  }
  if (!to || to < from) return null;
  return { from, to };
}

/** 여행 유형(calendar_event_types.is_trip_type=1)의 일정 목록 */
export function loadTripEvents(db) {
  const tripTypes = getCalendarEventTypes(db).filter(t => t.is_trip_type).map(t => t.value);
  if (!tripTypes.length) return [];
  const res = db.exec(
    `SELECT id, title, COALESCE(date_from, ''), COALESCE(date_to, ''), COALESCE(note, '')
     FROM calendar_events WHERE event_type IN (${tripTypes.map(() => '?').join(', ')}) ORDER BY id`,
    tripTypes
  );
  return (res[0]?.values || []).map(([id, title, date_from, date_to, note]) =>
    ({ id, title: String(title || '').trim(), date_from, date_to, note }));
}

/**
 * 여행 이름·일정에 맞는 일정을 찾는다. 없으면 null.
 *  - 일정을 읽을 수 있으면 시작·종료일이 같은 일정
 *  - 예전 trips에서 옮겨 온 일정은 날짜 없이 메모에 일정 문자열이 있으므로 메모로도 찾는다
 *  - 일정 없이 이름만 있으면 거래 날짜가 기간 안에 드는 일정, 같은 이름이 하나뿐이면 그 일정
 */
export function findTripEvent(events, name, schedule, date) {
  const same = events.filter(e => e.title === name);
  if (!same.length) return null;
  const scheduleRaw = String(schedule ?? '').trim();
  const sched = parseTripSchedule(scheduleRaw);
  if (sched) {
    const exact = same.find(e => e.date_from === sched.from && (e.date_to || e.date_from) === sched.to);
    if (exact) return exact;
  }
  if (scheduleRaw) return same.find(e => e.note.includes(scheduleRaw)) || null;
  return same.find(e => e.date_from && e.date_from <= date && date <= (e.date_to || e.date_from))
    || (same.length === 1 ? same[0] : null);
}

/**
 * 새 여행 일정을 만든다. 일정 문자열을 읽을 수 없으면 해당 거래들의 첫날~마지막 날로 잡는다.
 * 반환: 새 일정 id
 */
export function createTripEvent(db, { name, schedule, dates }) {
  const types = getCalendarEventTypes(db).filter(t => t.is_trip_type);
  const type = types.find(t => t.value === 'trip') || types[0] || { value: 'trip', color: '' };
  const scheduleRaw = String(schedule ?? '').trim();
  const sched = parseTripSchedule(scheduleRaw);
  const sorted = [...dates].filter(Boolean).sort();
  const from = sched ? sched.from : (sorted[0] || '');
  const to = sched ? sched.to : (sorted[sorted.length - 1] || '');
  return addCalendarEvent(db, {
    title: name,
    date_from: from,
    date_to: to,
    event_type: type.value,
    color: type.color || '',
    note: sched ? '' : scheduleRaw,
  });
}
