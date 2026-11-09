import { toDateStr, toYearMonth } from '../../services/dateUtils';

// 요약 화면의 필터 상태 — 앱을 닫기 전까지 유지한다(모듈 레벨).
// 요약 화면(SummaryView)은 열 때 불러오므로(I-033), 다른 화면이 "다음에 열 때 이 달로" 정해 두는 함수와 상태는 여기 둔다.
const initNow = new Date();
const initWeekAgo = new Date(initNow);
initWeekAgo.setDate(initNow.getDate() - 6);

export const summaryFilterState = {
  filterType: 'month',
  selectedMonth: toYearMonth(initNow),
  selectedYear: String(initNow.getFullYear()),
  dateFrom: toDateStr(initWeekAgo),
  dateTo: toDateStr(initNow),
  selectedEventId: '',
  eventTypeFilter: '',
  eventSortType: 'date_desc',
  reportMonth: '',
  taxYear: '',
};

/** 다음에 요약을 열 때 그 달 보기로 연다 — 거래내역의 예산 알림에서 넘어올 때 (I-025) */
export function showSummaryMonth(yearMonth) {
  summaryFilterState.filterType = 'month';
  summaryFilterState.selectedMonth = yearMonth;
}

/** 다음에 요약 › 리포트를 열 때 그 달 리포트로 연다 — 거래내역의 지난달 리포트 알림에서 넘어올 때 (I-028) */
export function showSummaryReportMonth(yearMonth) {
  summaryFilterState.reportMonth = yearMonth;
}
