/**
 * 한국 법정 공휴일 데이터
 *
 * 연도별로 관리. 새 연도 추가 시 해당 연도 배열 추가.
 * 대체공휴일은 확정된 경우에만 포함.
 *
 * 출처: 우주항공청 월력요항, 행정안전부 공고
 * 마지막 업데이트: 2026-05
 */

const HOLIDAYS_BY_YEAR = {
  2026: [
    // ── 1월 ──
    { date: '2026-01-01', name: '신정' },

    // ── 2월 ──
    { date: '2026-02-16', name: '설날 연휴' },
    { date: '2026-02-17', name: '설날' },
    { date: '2026-02-18', name: '설날 연휴' },

    // ── 3월 ──
    { date: '2026-03-01', name: '삼일절' },
    { date: '2026-03-02', name: '대체공휴일(삼일절)' }, // 3/1 일요일

    // ── 5월 ──
    // 근로자의 날: 근로기준법상 법정 유급휴일. 카드 결제일 계산 시 다음 업무일로 이동.
    { date: '2026-05-01', name: '근로자의 날' },
    { date: '2026-05-05', name: '어린이날' },
    { date: '2026-05-24', name: '부처님오신날' },
    { date: '2026-05-25', name: '대체공휴일(부처님오신날)' }, // 5/24 일요일

    // ── 6월 ──
    { date: '2026-06-03', name: '전국동시지방선거' },
    { date: '2026-06-06', name: '현충일' }, // 토요일, 대체공휴일 미적용

    // ── 8월 ──
    { date: '2026-08-15', name: '광복절' },
    { date: '2026-08-17', name: '대체공휴일(광복절)' }, // 8/15 토요일

    // ── 9월 ──
    { date: '2026-09-24', name: '추석 연휴' },
    { date: '2026-09-25', name: '추석' },
    { date: '2026-09-26', name: '추석 연휴' },
    // 9/26(토) 대체공휴일 여부: 행안부 최종 확인 필요 (아래 주석 참고)
    // { date: '2026-09-28', name: '대체공휴일(추석)' },

    // ── 10월 ──
    { date: '2026-10-03', name: '개천절' },
    { date: '2026-10-05', name: '대체공휴일(개천절)' }, // 10/3 토요일
    { date: '2026-10-09', name: '한글날' },

    // ── 12월 ──
    { date: '2026-12-25', name: '성탄절' },
  ],

  // 2027년 공휴일은 확정 후 추가
  // 2027: [],
};

/**
 * 특정 날짜가 공휴일인지 확인
 * @param {string} dateStr - 'YYYY-MM-DD' 형식
 * @returns {boolean}
 */
export function isHoliday(dateStr) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const list = HOLIDAYS_BY_YEAR[year];
  if (!list) return false;
  return list.some((h) => h.date === dateStr);
}

/**
 * 특정 날짜가 주말(토/일)인지 확인
 * @param {string} dateStr - 'YYYY-MM-DD' 형식
 * @returns {boolean}
 */
export function isWeekend(dateStr) {
  const day = new Date(dateStr).getDay();
  return day === 0 || day === 6;
}

/**
 * 공휴일 또는 주말이면 다음 업무일을 반환
 * @param {string} dateStr - 'YYYY-MM-DD' 형식
 * @returns {string} - 실제 업무일 'YYYY-MM-DD'
 */
export function getNextBusinessDay(dateStr) {
  let d = new Date(dateStr);
  while (isWeekend(toDateStr(d)) || isHoliday(toDateStr(d))) {
    d.setDate(d.getDate() + 1);
  }
  return toDateStr(d);
}

export function getPrevBusinessDay(dateStr) {
  let d = new Date(dateStr);
  while (isWeekend(toDateStr(d)) || isHoliday(toDateStr(d))) {
    d.setDate(d.getDate() - 1);
  }
  return toDateStr(d);
}

/**
 * 매월 N일의 실제 결제일 계산 (공휴일/주말이면 다음 업무일)
 * @param {number} year
 * @param {number} month - 1-indexed
 * @param {number} dayOfMonth
 * @param {string} holidayRule - 'next_business' | 'prev_business' | 'none'
 * @returns {string} - 'YYYY-MM-DD'
 */
export function getActualPaymentDate(year, month, dayOfMonth, holidayRule = 'none') {
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
  if (holidayRule === 'next_business') return getNextBusinessDay(dateStr);
  if (holidayRule === 'prev_business') return getPrevBusinessDay(dateStr);
  return dateStr;
}

/**
 * 특정 연도의 공휴일 목록 반환
 * @param {number} year
 * @returns {Array<{date: string, name: string}>}
 */
export function getHolidaysByYear(year) {
  return HOLIDAYS_BY_YEAR[year] || [];
}

/**
 * 지원되는 연도 목록 반환
 * @returns {number[]}
 */
export function getSupportedYears() {
  return Object.keys(HOLIDAYS_BY_YEAR).map(Number).sort();
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default HOLIDAYS_BY_YEAR;
