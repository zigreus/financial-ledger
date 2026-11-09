// 정기지출·계좌 고정항목의 날짜 계산 — 말일 보정, 휴일 규칙, 월 키.
// recurring(정기지출 자동등록)·accounts(계좌 자동등록)·schema(마이그레이션)가 함께 쓴다.

import { toYearMonth, ymd } from '../dateUtils';
import { getNextBusinessDay, getPrevBusinessDay } from '../../data/holidays';

export function resolveDay(year, month1based, dayOfMonth) {
  // month1based: 1=1월, 12=12월
  const lastDay = new Date(year, month1based, 0).getDate(); // month1based month의 마지막 날
  if (dayOfMonth === 0) return lastDay;
  return Math.min(dayOfMonth, lastDay);
}

export const ymOf = toYearMonth;

/** 정기지출(가계부)의 그 달 결제일 — 말일 보정만(휴일 규칙 없음). 자동등록과 구독 결제 예정 알림이 함께 쓴다 */
export function recurringTxDateFor(r, ym) {
  const [year, month] = ym.split('-').map(Number);
  return ymd(year, month, resolveDay(year, month, r.day_of_month));
}

/** 고정항목의 해당 월 실제 처리일 (말일 보정 + 휴일 규칙) */
export function recurringDateFor(item, ym) {
  const [year, month] = ym.split('-').map(Number);
  const day = resolveDay(year, month, Number(item.day_of_month) || 0);
  const rawDate = `${ym}-${String(day).padStart(2, '0')}`;
  if (item.holiday_rule === 'next_business') return getNextBusinessDay(rawDate);
  if (item.holiday_rule === 'prev_business') return getPrevBusinessDay(rawDate);
  return rawDate;
}
