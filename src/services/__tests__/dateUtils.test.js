/**
 * @vitest-environment node
 */
// 로컬 날짜 도우미 (I-006, B-011)
import {
  toDateStr, toYearMonth, ymd, parseDateStr, addMonths, addDays, isValidDateStr,
} from '../dateUtils';
import { getNextBusinessDay, getPrevBusinessDay, isWeekend } from '../../data/holidays';

test('로컬 기준으로 포맷한다', () => {
  const d = new Date(2026, 0, 5, 0, 30); // 1월 5일 00:30 — UTC로 바꾸면 전날이 되는 시각
  expect(toDateStr(d)).toBe('2026-01-05');
  expect(toYearMonth(d)).toBe('2026-01');
  expect(ymd(2026, 3, 1)).toBe('2026-03-01');
});

test('문자열을 로컬 자정으로 해석한다', () => {
  const d = parseDateStr('2026-11-07');
  expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 10, 7, 0]);
});

test('월·일 이동은 연말·월말을 넘는다', () => {
  expect(addMonths('2026-12', 1)).toBe('2027-01');
  expect(addMonths('2026-01', -1)).toBe('2025-12');
  expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
});

test('실제 달력에 없는 날짜를 거른다', () => {
  expect(isValidDateStr('2026-02-28')).toBe(true);
  expect(isValidDateStr('2026-02-29')).toBe(false);
  expect(isValidDateStr('2026-13-01')).toBe(false);
  expect(isValidDateStr('2026-1-1')).toBe(false);
});

test('영업일 계산 (2027 공휴일·대체공휴일)', () => {
  expect(getPrevBusinessDay('2027-01-01')).toBe('2026-12-31'); // 신정
  expect(getNextBusinessDay('2027-02-07')).toBe('2027-02-10'); // 설날 + 대체공휴일
  expect(getNextBusinessDay('2027-10-09')).toBe('2027-10-12'); // 한글날(토) → 대체공휴일 10/11(월)
  expect(isWeekend('2026-11-07')).toBe(true);
});
