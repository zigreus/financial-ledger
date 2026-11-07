/**
 * 로컬 날짜 도우미 (I-006) — 앱의 날짜는 모두 로컬 'YYYY-MM-DD' 문자열로 다룬다.
 *
 * ⚠️ 쓰지 말 것
 *  - date.toISOString(): UTC라 한국(UTC+9)에서 오전 9시 전에는 하루 전 날짜가 된다
 *  - new Date('YYYY-MM-DD'): UTC 자정으로 해석되어 음수 시간대에서 하루 밀린다 (B-011)
 */

const pad2 = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DD' (로컬) */
export function toDateStr(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Date → 'YYYY-MM' (로컬) */
export function toYearMonth(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/** 연·월(1부터)·일 숫자 → 'YYYY-MM-DD'. 달력 검사는 하지 않는다 (필요하면 isValidDateStr). */
export function ymd(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** 'YYYY-MM-DD' → 로컬 자정 Date */
export function parseDateStr(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d || 1);
}

/** 오늘 'YYYY-MM-DD' */
export function todayStr() {
  return toDateStr(new Date());
}

/** 이번 달 'YYYY-MM' */
export function currentYearMonth() {
  return toYearMonth(new Date());
}

/** 'YYYY-MM'에서 n개월 이동한 'YYYY-MM' */
export function addMonths(yearMonth, n) {
  const [y, m] = String(yearMonth).split('-').map(Number);
  return toYearMonth(new Date(y, m - 1 + n, 1));
}

/** 'YYYY-MM-DD'에서 n일 이동한 'YYYY-MM-DD' */
export function addDays(dateStr, n) {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** 실제 달력에 있는 'YYYY-MM-DD'인지 (2026-02-30, 13월 등은 false) */
export function isValidDateStr(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}
