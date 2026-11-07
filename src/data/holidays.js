/**
 * 한국 법정 공휴일 데이터
 *
 * 연도별로 관리. 새 연도 추가 시 해당 연도 배열 추가.
 * 대체공휴일은 확정된 경우에만 포함.
 *
 * 출처: 우주항공청 월력요항, 행정안전부 공고
 * 마지막 업데이트: 2026-11 (2027년 추가)
 * 매년 하반기에 다음 해 데이터를 추가해야 한다 — 없으면 계좌 자동등록의 휴일 보정이 주말만 반영된다.
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

  // 2027년: 월력요항 기준. 대체공휴일 규칙(설·추석은 일요일, 국경일·어린이날·부처님오신날·성탄절은 토·일과 겹치면)을 적용했다.
  // 임시공휴일이 새로 지정되면 여기에 추가한다.
  2027: [
    // ── 1월 ──
    { date: '2027-01-01', name: '신정' },

    // ── 2월 ──
    { date: '2027-02-06', name: '설날 연휴' },
    { date: '2027-02-07', name: '설날' },
    { date: '2027-02-08', name: '설날 연휴' },
    { date: '2027-02-09', name: '대체공휴일(설날)' }, // 2/7 일요일

    // ── 3월 ──
    { date: '2027-03-01', name: '삼일절' },

    // ── 5월 ──
    { date: '2027-05-01', name: '근로자의 날' }, // 토요일
    { date: '2027-05-05', name: '어린이날' },
    { date: '2027-05-13', name: '부처님오신날' },

    // ── 6월 ──
    { date: '2027-06-06', name: '현충일' }, // 일요일, 대체공휴일 미적용

    // ── 8월 ──
    { date: '2027-08-15', name: '광복절' },
    { date: '2027-08-16', name: '대체공휴일(광복절)' }, // 8/15 일요일

    // ── 9월 ──
    { date: '2027-09-14', name: '추석 연휴' },
    { date: '2027-09-15', name: '추석' },
    { date: '2027-09-16', name: '추석 연휴' },

    // ── 10월 ──
    { date: '2027-10-03', name: '개천절' },
    { date: '2027-10-04', name: '대체공휴일(개천절)' }, // 10/3 일요일
    { date: '2027-10-09', name: '한글날' },
    { date: '2027-10-11', name: '대체공휴일(한글날)' }, // 10/9 토요일

    // ── 12월 ──
    { date: '2027-12-25', name: '성탄절' },
    { date: '2027-12-27', name: '대체공휴일(성탄절)' }, // 12/25 토요일
  ],

  // 2028년 공휴일은 확정 후 추가 — 없으면 앱이 "공휴일 데이터 없음"을 알린다 (hasHolidayData)
};

// 'YYYY-MM-DD'를 로컬 날짜로 해석한다.
// new Date('YYYY-MM-DD')는 UTC 자정으로 해석되어 음수 시간대에서 하루 전 날짜가 된다 (B-011).
function parseLocalDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 해당 연도의 공휴일 데이터가 있는지 — 없으면 휴일 보정이 주말만 반영된다 */
export function hasHolidayData(year) {
  return Array.isArray(HOLIDAYS_BY_YEAR[Number(year)]);
}

/**
 * 특정 날짜가 공휴일인지 확인
 * @param {string} dateStr - 'YYYY-MM-DD' 형식
 * @returns {boolean}
 */
export function isHoliday(dateStr) {
  const list = HOLIDAYS_BY_YEAR[Number(String(dateStr).slice(0, 4))];
  if (!list) return false;
  return list.some((h) => h.date === dateStr);
}

/**
 * 특정 날짜가 주말(토/일)인지 확인
 * @param {string} dateStr - 'YYYY-MM-DD' 형식
 * @returns {boolean}
 */
export function isWeekend(dateStr) {
  const day = parseLocalDate(dateStr).getDay();
  return day === 0 || day === 6;
}

/**
 * 공휴일 또는 주말이면 다음 업무일을 반환
 * @param {string} dateStr - 'YYYY-MM-DD' 형식
 * @returns {string} - 실제 업무일 'YYYY-MM-DD'
 */
export function getNextBusinessDay(dateStr) {
  const d = parseLocalDate(dateStr);
  while (isWeekend(toDateStr(d)) || isHoliday(toDateStr(d))) {
    d.setDate(d.getDate() + 1);
  }
  return toDateStr(d);
}

/** 공휴일 또는 주말이면 이전 업무일을 반환 */
export function getPrevBusinessDay(dateStr) {
  const d = parseLocalDate(dateStr);
  while (isWeekend(toDateStr(d)) || isHoliday(toDateStr(d))) {
    d.setDate(d.getDate() - 1);
  }
  return toDateStr(d);
}

export default HOLIDAYS_BY_YEAR;
