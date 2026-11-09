import React, { useState, useMemo, useEffect } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  getMonthlySummary, getMonthlySubCategorySummary,
  getPaymentMethodSummary, getAvailableMonths,
  getYearlySummary, getYearlyPaymentMethodSummary, getYearlySubCategorySummary,
  getRangeSummary, getRangePaymentMethodSummary, getRangeSubCategorySummary,
  getAvailableYears, getEventSummary, getEventDetailSummary, getEventPaymentMethodSummary,
  getMemberSummary, getMemberNames,
  getCalendarEvents, getMonthlyTotalsWithGoals, getSetting, getCalendarEventTypes,
  isMonthlyBalanceEnabled, getMonthlyIncome, isMonthlyReportEnabled, getReportMonths,
  isTaxSummaryEnabled, getTaxYears,
} from '../../services/dbManager';
import { formatAmount } from '../../services/formulaEvaluator';
import { categoryColor } from '../common/categoryColor';
import './SummaryView.css';
import { currentYearMonth, addMonths } from '../../services/dateUtils';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';
import CategoryBudgetPanel from './CategoryBudgetPanel';
import MonthlyBalanceCard from './MonthlyBalanceCard';
import MonthlyReport from './MonthlyReport';
import TaxSummary from './TaxSummary';
import { summaryFilterState, showSummaryMonth, showSummaryReportMonth } from './summaryState';

// 앱 종료 전까지 필터 상태 유지 (모듈 레벨) — 다른 화면이 정해 두는 함수와 함께 summaryState.js에 있다 (I-033)
const _filterState = summaryFilterState;
export { showSummaryMonth, showSummaryReportMonth };

// 막대 길이(%) — 환불로 0 이하가 된 값은 빈 막대로 (음수 너비는 CSS가 무시해 막대가 가득 차 보인다)
function barPercent(value, maxValue) {
  if (!(maxValue > 0) || !(value > 0)) return 0;
  return Math.min(100, (value / maxValue) * 100);
}

// 막대 최대값 — 양수 값 중 가장 큰 것 (없으면 1)
function barMax(values) {
  return Math.max(1, ...values.filter(v => v > 0));
}

const netOf = r => (r.total || 0) - (r.discount || 0);

function BarChart({ data, maxValue, color, formatLabel, currentMonth }) {
  return (
    <div className="bar-chart">
      {data.map((item, i) => {
        const isCurrent = currentMonth && item.label === currentMonth;
        return (
          <div key={i} className={`bar-row${isCurrent ? ' bar-row-current' : ''}`}>
            <span className="bar-label">{item.label}</span>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{
                  width: `${barPercent(item.value, maxValue)}%`,
                  backgroundColor: isCurrent ? '#FF8C42' : (color || '#4ECDC4'),
                }}
              />
            </div>
            <span className="bar-value">{formatLabel ? formatLabel(item.value) : item.value}</span>
          </div>
        );
      })}
    </div>
  );
}

function ForeignAmountsTags({ foreignTotals }) {
  const entries = Object.entries(foreignTotals);
  if (entries.length === 0) return null;
  return (
    <div className="foreign-tags-inline">
      {entries.map(([currency, amount]) => (
        <span key={currency} className="foreign-amount-tag">
          {currency} {amount % 1 === 0 ? formatAmount(amount) : amount.toFixed(2)}
        </span>
      ))}
    </div>
  );
}

function aggregateForeign(rows) {
  const all = {};
  rows.forEach(r => {
    Object.entries(r.foreignTotals).forEach(([c, a]) => {
      all[c] = (all[c] || 0) + a;
    });
  });
  return all;
}

// dataVersion: DB에 쓰기가 있을 때마다 App이 올리는 숫자. sql.js는 같은 db 객체를 제자리에서 바꾸므로
// db를 읽는 memo는 [db]만으로는 다시 계산되지 않는다 — dataVersion을 함께 의존성에 둔다.
function SummaryView({ db, dataVersion = 0, tab: tabProp, drilldownCategory, onTabChange, onDrilldownChange, onOpenSettings, onChanged }) {
  const [monthlySubTab, setMonthlySubTab] = useState('list'); // 'list' | 'chart'
  const [monthlyLimit, setMonthlyLimit] = useState(24);
  const [filterType, setFilterType] = useState(() => _filterState.filterType);
  const currentYear = useMemo(() => String(new Date().getFullYear()), []);
  const [selectedYear, setSelectedYear] = useState(() => _filterState.selectedYear);
  const [dateFrom, setDateFrom] = useState(() => _filterState.dateFrom);
  const [dateTo, setDateTo] = useState(() => _filterState.dateTo);
  const [selectedEventId, setSelectedEventId] = useState(() => _filterState.selectedEventId);
  const [eventTypeFilter, setEventTypeFilter] = useState(() => _filterState.eventTypeFilter);
  const [eventSortType, setEventSortType] = useState(() => _filterState.eventSortType || 'date_desc');
  const [categorySortType, setCategorySortType] = useState('amount_desc');

  const currentMonth = useMemo(() => currentYearMonth(), []);

  const [selectedMonth, setSelectedMonth] = useState(() => _filterState.selectedMonth);

  // 필터 상태 변경 시 모듈 레벨에 저장 (앱 종료 전까지 유지)
  useEffect(() => { _filterState.filterType = filterType; }, [filterType]);
  useEffect(() => { _filterState.selectedMonth = selectedMonth; }, [selectedMonth]);
  useEffect(() => { _filterState.selectedYear = selectedYear; }, [selectedYear]);
  useEffect(() => { _filterState.dateFrom = dateFrom; }, [dateFrom]);
  useEffect(() => { _filterState.dateTo = dateTo; }, [dateTo]);
  useEffect(() => { _filterState.selectedEventId = selectedEventId; }, [selectedEventId]);
  useEffect(() => { _filterState.eventTypeFilter = eventTypeFilter; }, [eventTypeFilter]);
  useEffect(() => { _filterState.eventSortType = eventSortType; }, [eventSortType]);

  // db 내용이 바뀔 때마다(dataVersion) 새 참조가 되는 스냅샷 — db를 읽는 memo·effect는 live에 의존한다 (B-014, I-010)
  const live = useDbSnapshot(db, dataVersion);
  // 월간 리포트 (I-028) — 켰을 때만 '리포트' 탭이 있다. 끈 채로 리포트 탭이 열리면 월별 추이를 보인다
  const reportEnabled = useMemo(() => isMonthlyReportEnabled(live.db), [live]);
  // 연말정산 참고 합계 (I-029) — 켰을 때만 '연말정산' 탭이 있다
  const taxEnabled = useMemo(() => isTaxSummaryEnabled(live.db), [live]);
  const tab = (tabProp === 'report' && !reportEnabled) || (tabProp === 'tax' && !taxEnabled) ? 'monthly' : tabProp;
  // 보는 해: 고른 해, 아니면 1·2월(연말정산 때)은 작년·그 밖에는 올해(그 해에 거래가 없으면 가장 최근 해)
  const [pickedTaxYear, setPickedTaxYear] = useState(() => _filterState.taxYear);
  const taxYears = useMemo(() => (taxEnabled ? getTaxYears(live.db) : []), [live, taxEnabled]);
  const preferredTaxYear = String(Number(currentMonth.slice(0, 4)) - (Number(currentMonth.slice(5, 7)) <= 2 ? 1 : 0));
  const taxYear = pickedTaxYear || (taxYears.includes(preferredTaxYear) || !taxYears.length ? preferredTaxYear : taxYears[0]);
  const pickTaxYear = (y) => {
    _filterState.taxYear = y;
    setPickedTaxYear(y);
  };
  // 보는 달: 사용자가 고른 달(알림에서 연 달 포함). 고르지 않았으면 지난달(거래가 없으면 가장 최근 달)
  const [pickedReportMonth, setPickedReportMonth] = useState(() => _filterState.reportMonth);
  const reportMonths = useMemo(() => (reportEnabled ? getReportMonths(live.db) : []), [live, reportEnabled]);
  const lastMonth = addMonths(currentMonth, -1);
  const reportMonth = pickedReportMonth || (reportMonths.includes(lastMonth) || !reportMonths.length ? lastMonth : reportMonths[0]);
  const pickReportMonth = (ym) => {
    _filterState.reportMonth = ym;
    setPickedReportMonth(ym);
  };
  const months = useMemo(() => getAvailableMonths(live.db), [live]);
  const years = useMemo(() => getAvailableYears(live.db), [live]);
  const monthlyTotals = useMemo(() => getMonthlyTotalsWithGoals(live.db, monthlyLimit), [live, monthlyLimit]);
  // 수입·월 수지 (I-026) — 켰을 때만 월별 목록에 수입·남은 돈을 보인다
  const balanceEnabled = useMemo(() => isMonthlyBalanceEnabled(live.db), [live]);
  const incomeByMonth = useMemo(
    () => (balanceEnabled ? getMonthlyIncome(live.db, monthlyTotals.map(r => r.month)) : {}),
    [live, balanceEnabled, monthlyTotals],
  );
  const isMobile = useIsMobile();
  const showGoal = useMemo(
    () => getSetting(live.db, isMobile ? 'show_goal_display_mobile' : 'show_goal_display_pc', '1') !== '0',
    [live, isMobile]
  );
  const calendarEvents = useMemo(() => getCalendarEvents(live.db), [live]);

  const categorySummary = useMemo(() => {
    if (filterType === 'month') return getMonthlySummary(live.db, selectedMonth);
    if (filterType === 'year') return selectedYear ? getYearlySummary(live.db, selectedYear) : [];
    if (filterType === 'range') return dateFrom && dateTo ? getRangeSummary(live.db, dateFrom, dateTo) : [];
    return [];
  }, [live, filterType, selectedMonth, selectedYear, dateFrom, dateTo]);

  const subCategorySummary = useMemo(() => {
    if (!drilldownCategory) return [];
    if (filterType === 'month') return getMonthlySubCategorySummary(live.db, selectedMonth, drilldownCategory);
    if (filterType === 'year') return selectedYear ? getYearlySubCategorySummary(live.db, selectedYear, drilldownCategory) : [];
    if (filterType === 'range') return dateFrom && dateTo ? getRangeSubCategorySummary(live.db, dateFrom, dateTo, drilldownCategory) : [];
    return [];
  }, [live, drilldownCategory, filterType, selectedMonth, selectedYear, dateFrom, dateTo]);

  const paymentSummary = useMemo(() => {
    if (filterType === 'month') return getPaymentMethodSummary(live.db, selectedMonth);
    if (filterType === 'year') return selectedYear ? getYearlyPaymentMethodSummary(live.db, selectedYear) : [];
    if (filterType === 'range') return dateFrom && dateTo ? getRangePaymentMethodSummary(live.db, dateFrom, dateTo) : [];
    // 특정 일정을 고르지 않았으면 유형 필터를 적용해 상단 총액(eventSummary)과 같은 범위로 집계한다
    if (filterType === 'event') {
      return selectedEventId
        ? getEventPaymentMethodSummary(live.db, Number(selectedEventId))
        : getEventPaymentMethodSummary(live.db, null, eventTypeFilter || null);
    }
    return [];
  }, [live, filterType, selectedMonth, selectedYear, dateFrom, dateTo, selectedEventId, eventTypeFilter]);

  // 구성원별 합계 (I-013) — 구성원이 있을 때 월·연·기간 보기에서만
  const members = useMemo(() => getMemberNames(live.db), [live]);
  const memberSummary = useMemo(() => {
    if (!members.length) return [];
    if (filterType === 'month') return getMemberSummary(live.db, { month: selectedMonth });
    if (filterType === 'year') return selectedYear ? getMemberSummary(live.db, { year: selectedYear }) : [];
    if (filterType === 'range') return dateFrom && dateTo ? getMemberSummary(live.db, { from: dateFrom, to: dateTo }) : [];
    return [];
  }, [live, members, filterType, selectedMonth, selectedYear, dateFrom, dateTo]);

  const eventTypes = useMemo(() => getCalendarEventTypes(live.db), [live]);
  const eventTypeMap = useMemo(
    () => Object.fromEntries(eventTypes.map(t => [t.value, t])),
    [eventTypes]
  );

  const eventSummary = useMemo(() => getEventSummary(live.db, eventTypeFilter || null), [live, eventTypeFilter]);
  const sortedEventSummary = useMemo(() => {
    const arr = [...eventSummary];
    if (eventSortType === 'date_desc') return arr.sort((a, b) => (b.date_from || '').localeCompare(a.date_from || ''));
    if (eventSortType === 'date_asc')  return arr.sort((a, b) => (a.date_from || '').localeCompare(b.date_from || ''));
    if (eventSortType === 'cnt_desc')  return arr.sort((a, b) => b.cnt - a.cnt);
    if (eventSortType === 'cnt_asc')   return arr.sort((a, b) => a.cnt - b.cnt);
    if (eventSortType === 'amount_asc') return arr.sort((a, b) => (a.total - (a.discount||0)) - (b.total - (b.discount||0)));
    return arr.sort((a, b) => (b.total - (b.discount||0)) - (a.total - (a.discount||0))); // amount_desc
  }, [eventSummary, eventSortType]);

  const handleEventSort = (col) => {
    setEventSortType(prev => prev === `${col}_desc` ? `${col}_asc` : `${col}_desc`);
  };
  const eventSortMark = (col) => {
    if (eventSortType === `${col}_desc`) return ' ▼';
    if (eventSortType === `${col}_asc`)  return ' ▲';
    return '';
  };

  const sortedCategorySummary = useMemo(() => {
    const arr = [...categorySummary];
    if (categorySortType === 'name_asc')    return arr.sort((a, b) => (a.budget_category || '').localeCompare(b.budget_category || ''));
    if (categorySortType === 'name_desc')   return arr.sort((a, b) => (b.budget_category || '').localeCompare(a.budget_category || ''));
    if (categorySortType === 'cnt_desc')    return arr.sort((a, b) => b.cnt - a.cnt);
    if (categorySortType === 'cnt_asc')     return arr.sort((a, b) => a.cnt - b.cnt);
    if (categorySortType === 'amount_asc')  return arr.sort((a, b) => (a.total - (a.discount||0)) - (b.total - (b.discount||0)));
    return arr.sort((a, b) => (b.total - (b.discount||0)) - (a.total - (a.discount||0))); // amount_desc
  }, [categorySummary, categorySortType]);

  const sortedSubCategorySummary = useMemo(() => {
    const arr = [...subCategorySummary];
    if (categorySortType === 'name_asc')    return arr.sort((a, b) => (a.sub_category || '').localeCompare(b.sub_category || ''));
    if (categorySortType === 'name_desc')   return arr.sort((a, b) => (b.sub_category || '').localeCompare(a.sub_category || ''));
    if (categorySortType === 'cnt_desc')    return arr.sort((a, b) => b.cnt - a.cnt);
    if (categorySortType === 'cnt_asc')     return arr.sort((a, b) => a.cnt - b.cnt);
    if (categorySortType === 'amount_asc')  return arr.sort((a, b) => (a.total - (a.discount||0)) - (b.total - (b.discount||0)));
    return arr.sort((a, b) => (b.total - (b.discount||0)) - (a.total - (a.discount||0))); // amount_desc
  }, [subCategorySummary, categorySortType]);

  const handleCategorySort = (col) => {
    setCategorySortType(prev => prev === `${col}_desc` ? `${col}_asc` : `${col}_desc`);
  };
  const catSortMark = (col) => {
    if (categorySortType === `${col}_desc`) return ' ▼';
    if (categorySortType === `${col}_asc`)  return ' ▲';
    return '';
  };
  const eventDetailSummary = useMemo(
    () => selectedEventId ? getEventDetailSummary(live.db, Number(selectedEventId)) : [],
    [live, selectedEventId]
  );

  // 월·연 선택 목록 — 거래가 있는 달만 있으면, 이번 달에 아직 거래가 없을 때 선택값이 목록에 없어 빈칸으로 보인다.
  // 이번 달(올해)과 지금 고른 값은 항상 목록에 넣는다.
  const monthOptions = useMemo(
    () => [...new Set([...months, currentMonth, selectedMonth].filter(Boolean))].sort().reverse(),
    [months, currentMonth, selectedMonth]
  );
  const yearOptions = useMemo(
    () => [...new Set([...years, currentYear, selectedYear].filter(Boolean))].sort().reverse(),
    [years, currentYear, selectedYear]
  );

  const totalSpend = useMemo(() => categorySummary.reduce((s, r) => s + r.total, 0), [categorySummary]);
  const totalDiscount = useMemo(() => categorySummary.reduce((s, r) => s + (r.discount || 0), 0), [categorySummary]);

  const eventTotalSpend = useMemo(() => eventSummary.reduce((s, r) => s + r.total, 0), [eventSummary]);
  const eventTotalDiscount = useMemo(() => eventSummary.reduce((s, r) => s + (r.discount || 0), 0), [eventSummary]);

  const detailTotalSpend = useMemo(() => eventDetailSummary.reduce((s, r) => s + r.total, 0), [eventDetailSummary]);
  const detailTotalDiscount = useMemo(() => eventDetailSummary.reduce((s, r) => s + (r.discount || 0), 0), [eventDetailSummary]);

  // 결제수단 탭 일정 전체 모드: payment_method별로 event_type 소계 그룹핑
  const groupedPaymentSummary = useMemo(() => {
    if (filterType !== 'event' || selectedEventId) return null;
    const groups = {};
    const order = [];
    paymentSummary.forEach(r => {
      if (!groups[r.payment_method]) {
        groups[r.payment_method] = { payment_method: r.payment_method, total: 0, discount: 0, cnt: 0, types: [] };
        order.push(r.payment_method);
      }
      groups[r.payment_method].total += r.total || 0;
      groups[r.payment_method].discount += r.discount || 0;
      groups[r.payment_method].cnt += r.cnt || 0;
      if (r.event_type) groups[r.payment_method].types.push(r);
    });
    return order.map(k => groups[k]).sort((a, b) => b.total - a.total);
  }, [paymentSummary, filterType, selectedEventId]);

  const showFilter = tab === 'category' || tab === 'payment';
  const hasDateFilter = (filterType === 'month' && selectedMonth) ||
    (filterType === 'year' && selectedYear) ||
    (filterType === 'range' && dateFrom && dateTo);

  // 현재 일정 모드의 총액 (전체 또는 특정 일정)
  const eventDisplaySpend = selectedEventId ? detailTotalSpend : eventTotalSpend;
  const eventDisplayDiscount = selectedEventId ? detailTotalDiscount : eventTotalDiscount;
  const eventDisplayForeign = selectedEventId
    ? aggregateForeign(eventDetailSummary)
    : aggregateForeign(eventSummary);

  return (
    <div className="summary-page">
      {/* 메인 탭 */}
      <div className={`summary-tabs${reportEnabled || taxEnabled ? ' summary-tabs--many' : ''}`}>
        <button className={tab === 'monthly' ? 'tab active' : 'tab'} onClick={() => onTabChange('monthly')}>월별 추이</button>
        <button className={tab === 'category' ? 'tab active' : 'tab'} onClick={() => onTabChange('category')}>카테고리</button>
        <button className={tab === 'payment' ? 'tab active' : 'tab'} onClick={() => onTabChange('payment')}>결제수단</button>
        {reportEnabled && (
          <button className={tab === 'report' ? 'tab active' : 'tab'} onClick={() => onTabChange('report')}>리포트</button>
        )}
        {taxEnabled && (
          <button className={tab === 'tax' ? 'tab active' : 'tab'} onClick={() => onTabChange('tax')}>연말정산</button>
        )}
      </div>

      {tab === 'tax' && (
        <div className="summary-section">
          <TaxSummary
            db={db}
            dataVersion={dataVersion}
            year={taxYear}
            years={taxYears}
            onYearChange={pickTaxYear}
            onChanged={onChanged}
          />
        </div>
      )}

      {tab === 'report' && (
        <div className="summary-section" style={{ paddingTop: 12 }}>
          <MonthlyReport
            db={db}
            dataVersion={dataVersion}
            month={reportMonth}
            months={reportMonths}
            onMonthChange={pickReportMonth}
            showGoal={showGoal}
            onOpenSettings={onOpenSettings}
          />
        </div>
      )}

      {/* 필터 (카테고리/결제수단 탭에서만) */}
      {showFilter && (
        <div className="summary-filter">
          <div className="filter-type-buttons">
            <button
              className={`filter-type-btn ${filterType === 'month' ? 'active' : ''}`}
              onClick={() => { setFilterType('month'); setSelectedMonth(currentMonth); if (drilldownCategory) onDrilldownChange(null); }}
            >
              월별
            </button>
            <button
              className={`filter-type-btn ${filterType === 'year' ? 'active' : ''}`}
              onClick={() => { setFilterType('year'); setSelectedYear(currentYear); if (drilldownCategory) onDrilldownChange(null); }}
            >
              연도별
            </button>
            <button
              className={`filter-type-btn ${filterType === 'range' ? 'active' : ''}`}
              onClick={() => {
                setFilterType('range');
                if (drilldownCategory) onDrilldownChange(null);
              }}
            >
              기간별
            </button>
            <button
              className={`filter-type-btn ${filterType === 'event' ? 'active' : ''}`}
              onClick={() => { setFilterType('event'); setSelectedEventId(''); setEventTypeFilter(''); if (drilldownCategory) onDrilldownChange(null); }}
            >
              일정별
            </button>
          </div>

          <div className="filter-inputs">
            {filterType === 'month' && (
              <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}>
                <option value="">전체 기간</option>
                {monthOptions.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
            {filterType === 'year' && (
              <select value={selectedYear} onChange={e => setSelectedYear(e.target.value)}>
                {yearOptions.map(y => <option key={y} value={y}>{y}년</option>)}
              </select>
            )}
            {filterType === 'range' && (
              <div className="date-range-inputs">
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} placeholder="시작일" />
                <span className="date-separator">~</span>
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} placeholder="종료일" />
              </div>
            )}
            {filterType === 'event' && (
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  value={eventTypeFilter}
                  onChange={e => { setEventTypeFilter(e.target.value); setSelectedEventId(''); }}
                  style={{ flex: '0 0 auto' }}
                >
                  <option value="">전체 유형</option>
                  {eventTypes.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                {calendarEvents.length > 0 && (
                  <select value={selectedEventId} onChange={e => setSelectedEventId(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
                    <option value="">전체 일정</option>
                    {calendarEvents
                      .filter(ev => !eventTypeFilter || ev.event_type === eventTypeFilter)
                      .sort((a, b) => (b.date_from || '').localeCompare(a.date_from || ''))
                      .map(ev => (
                        <option key={ev.id} value={String(ev.id)}>
                          {ev.title}{ev.date_from ? ` (${ev.date_from})` : ''}
                        </option>
                      ))
                    }
                  </select>
                )}
              </div>
            )}
          </div>

          {/* 총액 요약 */}
          {filterType === 'event' ? (
            (eventSummary.length > 0 || eventDetailSummary.length > 0) && (
              <div className="summary-total-row">
                <span>총액: <strong>{formatAmount(eventDisplaySpend - eventDisplayDiscount)}원</strong></span>
                <span className="amount-secondary">지출 {formatAmount(eventDisplaySpend)}원</span>
                {eventDisplayDiscount > 0 && (
                  <span className="discount-tag">할인 -{formatAmount(eventDisplayDiscount)}원</span>
                )}
                {Object.entries(eventDisplayForeign).map(([c, a]) => (
                  <span key={c} className="foreign-amount-tag" style={{ marginLeft: 4 }}>
                    {c} {a % 1 === 0 ? formatAmount(a) : a.toFixed(2)}
                  </span>
                ))}
              </div>
            )
          ) : (
            hasDateFilter && (
              <div className="summary-total-row">
                <span>총액: <strong>{formatAmount(totalSpend - totalDiscount)}원</strong></span>
                <span className="amount-secondary">지출 {formatAmount(totalSpend)}원</span>
                {totalDiscount > 0 && (
                  <span className="discount-tag">할인 -{formatAmount(totalDiscount)}원</span>
                )}
              </div>
            )
          )}
        </div>
      )}

      {/* 월별 추이 탭 */}
      {tab === 'monthly' && (
        <div className="summary-section">
          {/* 이번 달 수지 (I-026) — 수입·월 수지를 켰을 때만 */}
          <MonthlyBalanceCard db={db} dataVersion={dataVersion} month={currentMonth} />
          <div className="summary-sub-tabs">
            <button className={monthlySubTab === 'list' ? 'sub-tab active' : 'sub-tab'} onClick={() => setMonthlySubTab('list')}>목록</button>
            <button className={monthlySubTab === 'chart' ? 'sub-tab active' : 'sub-tab'} onClick={() => setMonthlySubTab('chart')}>그래프</button>
            <select value={monthlyLimit} onChange={e => setMonthlyLimit(Number(e.target.value))} style={{ marginLeft: 'auto' }}>
              <option value={12}>12개월</option>
              <option value={24}>24개월</option>
              <option value={36}>36개월</option>
              <option value={60}>60개월</option>
              <option value={0}>전체</option>
            </select>
          </div>

          {monthlyTotals.length === 0 ? (
            <p className="empty-state">데이터가 없습니다.</p>
          ) : monthlySubTab === 'chart' ? (
            <BarChart
              data={monthlyTotals.map(r => ({ label: r.month, value: netOf(r) }))}
              maxValue={barMax(monthlyTotals.map(netOf))}
              color="#45B7D1"
              formatLabel={v => `${formatAmount(v)}원`}
              currentMonth={currentMonth}
            />
          ) : (
            <>
            <table className={`summary-table${balanceEnabled ? ' with-balance' : ''}`}>
              <thead>
                <tr>
                  <th>월</th>
                  <th className="mb-col-cnt">건수</th>
                  <th>지출/할인</th>
                  <th>{showGoal ? '총액/목표' : '총액'}</th>
                  {balanceEnabled && <th>수입/남은 돈</th>}
                </tr>
              </thead>
              <tbody>
                {monthlyTotals.map(r => {
                  const isCurrent = r.month === currentMonth;
                  const net = r.total - (r.discount || 0);
                  const diff = r.goal !== null && r.goal !== undefined ? r.goal - net : null;
                  const isSaved = diff !== null && diff >= 0;
                  const inc = incomeByMonth[r.month];
                  const left = inc ? inc.income - net : null;
                  return (
                    <tr key={r.month} className={isCurrent ? 'current-month-row' : ''}>
                      <td>{r.month}</td>
                      <td className="mb-col-cnt">{r.cnt}</td>
                      <td className="amount-cell">
                        {formatAmount(r.total)}원
                        {r.discount > 0 && (
                          <div className="cell-sub-line cell-sub-discount">-{formatAmount(r.discount)}원</div>
                        )}
                      </td>
                      <td className="total-cell">
                        {formatAmount(net)}원
                        {showGoal && r.goal !== null && r.goal !== undefined && (
                          <>
                            <div className={`cell-sub-line ${isSaved ? 'cell-sub-saved' : 'cell-sub-over'}`}>
                              {isSaved ? `+${formatAmount(diff)}원` : `-${formatAmount(Math.abs(diff))}원`}
                            </div>
                            <div className="cell-goal-amount">목표 {formatAmount(r.goal)}</div>
                          </>
                        )}
                      </td>
                      {balanceEnabled && (
                        <td className="income-cell">
                          {inc ? (
                            <>
                              {formatAmount(inc.income)}원{(inc.upcoming > 0 || inc.unconfirmed > 0) && ' *'}
                              <div className={`cell-sub-line ${left >= 0 ? 'cell-sub-left-plus' : 'cell-sub-left-minus'}`}>
                                {left >= 0 ? '+' : '-'}{formatAmount(Math.abs(left))}원
                              </div>
                            </>
                          ) : '-'}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {balanceEnabled && Object.values(incomeByMonth).some(v => v.upcoming > 0 || v.unconfirmed > 0) && (
              <p className="mb-table-note">* 예정 금액이 포함된 수입(아직 들어오지 않았거나 금액을 고치지 않음)</p>
            )}
            </>
          )}
        </div>
      )}

      {/* 카테고리별 탭 */}
      {tab === 'category' && (
        <div className="summary-section">
          {/* 예산 대비 (I-025) — 카테고리별 예산을 켰을 때, 달을 고른 월 보기에서만('전체 기간' 제외).
              달이 바뀌면 새로 그린다 — 열려 있던 편집 칸이 다른 달에 남지 않게 */}
          {filterType === 'month' && selectedMonth && !drilldownCategory && (
            <CategoryBudgetPanel key={selectedMonth} db={db} dataVersion={dataVersion} month={selectedMonth} />
          )}
          {filterType === 'event' ? (
            /* 일정별 모드 */
            selectedEventId ? (
              /* 특정 일정 선택 → 세부카테고리별 */
              <>
                <button className="drilldown-back-btn" onClick={() => setSelectedEventId('')}>
                  {(() => { const ev = calendarEvents.find(e => String(e.id) === selectedEventId); return ev ? `← ${ev.title}` : '← 전체 일정'; })()}
                </button>
                {eventDetailSummary.length === 0 ? (
                  <p className="empty-state">데이터가 없습니다.</p>
                ) : (
                  <table className="summary-table">
                    <thead>
                      <tr>
                        <th>세부카테고리</th>
                        <th className="col-cnt">건수</th>
                        <th>총액(원)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {eventDetailSummary.map(r => (
                        <tr key={r.sub_category}>
                          <td className="event-name-cell">
                            {r.sub_category}
                            <span className="mobile-sub-cnt">{r.cnt}건</span>
                          </td>
                          <td className="col-cnt">{r.cnt}</td>
                          <td className="total-cell">
                            {formatAmount(r.total - (r.discount || 0))}원
                            <ForeignAmountsTags foreignTotals={r.foreignTotals} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td><strong>합계</strong></td>
                        <td className="col-cnt"></td>
                        <td className="total-cell">
                          <strong>{formatAmount(detailTotalSpend - detailTotalDiscount)}원</strong>
                          <ForeignAmountsTags foreignTotals={aggregateForeign(eventDetailSummary)} />
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </>
            ) : (
              /* 전체 일정 목록 */
              eventSummary.length === 0 ? (
                <p className="empty-state">일정 데이터가 없습니다.</p>
              ) : (
                <table className="summary-table">
                  <thead>
                    <tr>
                      <th className="sortable" onClick={() => handleEventSort('date')}>일정{eventSortMark('date')}</th>
                      <th className="sortable col-cnt" onClick={() => handleEventSort('cnt')}>건수{eventSortMark('cnt')}</th>
                      <th className="sortable" onClick={() => handleEventSort('amount')}>총액(원){eventSortMark('amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedEventSummary.map(r => (
                      <tr key={r.event_id} className="clickable-row" onClick={() => setSelectedEventId(String(r.event_id))}>
                        <td className="event-name-cell">
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                            <span style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, marginTop: 3,
                              background: r.color || eventTypeMap[r.event_type]?.color || '#9CA3AF' }} />
                            <div style={{ overflow: 'hidden' }}>
                              <span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.event_title}<span className="drilldown-arrow">›</span></span>
                              <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {eventTypeMap[r.event_type]?.label ?? r.event_type}
                                {r.date_from && <> · {r.date_from.slice(5)}{r.date_to ? ` ~ ${r.date_to.slice(5)}` : ''}</>}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="col-cnt">{r.cnt}</td>
                        <td className="total-cell">
                          {formatAmount(r.total - (r.discount || 0))}원
                          <ForeignAmountsTags foreignTotals={r.foreignTotals} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td><strong>합계</strong></td>
                      <td className="col-cnt"></td>
                      <td className="total-cell">
                        <strong>{formatAmount(eventTotalSpend - eventTotalDiscount)}원</strong>
                        <ForeignAmountsTags foreignTotals={aggregateForeign(eventSummary)} />
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )
            )
          ) : drilldownCategory ? (
            /* 세부카테고리 드릴다운 뷰 */
            <>
              <button className="drilldown-back-btn" onClick={() => window.history.back()}>
                ← {drilldownCategory}
              </button>
              {subCategorySummary.length === 0 ? (
                <p className="empty-state">데이터가 없습니다.</p>
              ) : (
                <>
                  <BarChart
                    data={sortedSubCategorySummary.map(r => ({ label: r.sub_category || '(미분류)', value: netOf(r) }))}
                    maxValue={barMax(sortedSubCategorySummary.map(netOf))}
                    color={categoryColor(drilldownCategory)}
                    formatLabel={v => `${formatAmount(v)}원`}
                  />
                  <table className="summary-table">
                    <thead>
                      <tr>
                        <th className="sortable" onClick={() => handleCategorySort('name')}>세부항목{catSortMark('name')}</th>
                        <th className="sortable" onClick={() => handleCategorySort('cnt')}>건수{catSortMark('cnt')}</th>
                        <th>지출</th>
                        <th>할인</th>
                        <th className="sortable" onClick={() => handleCategorySort('amount')}>총액{catSortMark('amount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSubCategorySummary.map(r => (
                        <tr key={r.sub_category || ''}>
                          <td>{r.sub_category || '(미분류)'}</td>
                          <td>{r.cnt}</td>
                          <td className="amount-cell">{formatAmount(r.total)}원</td>
                          <td className="discount-cell">{r.discount > 0 ? `-${formatAmount(r.discount)}원` : '-'}</td>
                          <td className="total-cell">{formatAmount(r.total - (r.discount || 0))}원</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan="2"><strong>합계</strong></td>
                        <td className="amount-cell">
                          <strong>{formatAmount(subCategorySummary.reduce((s, r) => s + r.total, 0))}원</strong>
                        </td>
                        <td className="discount-cell">
                          {subCategorySummary.reduce((s, r) => s + (r.discount || 0), 0) > 0
                            ? <strong>-{formatAmount(subCategorySummary.reduce((s, r) => s + (r.discount || 0), 0))}원</strong>
                            : '-'}
                        </td>
                        <td className="total-cell">
                          <strong>{formatAmount(subCategorySummary.reduce((s, r) => s + r.total - (r.discount || 0), 0))}원</strong>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </>
              )}
            </>
          ) : (
            /* 일반 카테고리별 */
            categorySummary.length === 0 ? (
              <p className="empty-state">데이터가 없습니다.</p>
            ) : (
              <>
                <BarChart
                  data={sortedCategorySummary.map(r => ({ label: r.budget_category, value: netOf(r) }))}
                  maxValue={barMax(sortedCategorySummary.map(netOf))}
                  color={null}
                  formatLabel={v => `${formatAmount(v)}원`}
                />
                <table className="summary-table">
                  <thead>
                    <tr>
                      <th className="sortable" onClick={() => handleCategorySort('name')}>카테고리{catSortMark('name')}</th>
                      <th className="sortable" onClick={() => handleCategorySort('cnt')}>건수{catSortMark('cnt')}</th>
                      <th>지출/할인</th>
                      <th className="sortable" onClick={() => handleCategorySort('amount')}>총액{catSortMark('amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCategorySummary.map(r => (
                      <tr
                        key={r.budget_category}
                        className="clickable-row"
                        onClick={() => onDrilldownChange(r.budget_category)}
                      >
                        <td>
                          <span className="cat-dot" style={{ backgroundColor: categoryColor(r.budget_category) }} />
                          {r.budget_category}
                          <span className="drilldown-arrow">›</span>
                        </td>
                        <td>{r.cnt}</td>
                        <td className="amount-cell">
                          {formatAmount(r.total)}원
                          {r.discount > 0 && (
                            <div className="cell-sub-line cell-sub-discount">-{formatAmount(r.discount)}원</div>
                          )}
                        </td>
                        <td className="total-cell">{formatAmount(r.total - (r.discount || 0))}원</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan="2"><strong>합계</strong></td>
                      <td className="amount-cell">
                        <strong>{formatAmount(totalSpend)}원</strong>
                        {totalDiscount > 0 && (
                          <div className="cell-sub-line cell-sub-discount">-{formatAmount(totalDiscount)}원</div>
                        )}
                      </td>
                      <td className="total-cell"><strong>{formatAmount(totalSpend - totalDiscount)}원</strong></td>
                    </tr>
                  </tfoot>
                </table>
              </>
            )
          )}
        </div>
      )}

      {/* 결제수단별 탭 */}
      {tab === 'payment' && (
        <div className="summary-section">
          {groupedPaymentSummary ? (
            /* 일정 전체 모드: 유형별 소계 */
            groupedPaymentSummary.length === 0 ? (
              <p className="empty-state">데이터가 없습니다.</p>
            ) : (
              <table className="summary-table">
                <thead>
                  <tr>
                    <th>결제수단</th>
                    <th>건수</th>
                    <th>지출/할인</th>
                    <th>총액</th>
                  </tr>
                </thead>
                <tbody>
                  {groupedPaymentSummary.map(g => (
                    <React.Fragment key={g.payment_method}>
                      <tr style={{ fontWeight: 600 }}>
                        <td>{g.payment_method}</td>
                        <td>{g.cnt}</td>
                        <td className="amount-cell">
                          {formatAmount(g.total)}원
                          {g.discount > 0 && <div className="cell-sub-line cell-sub-discount">-{formatAmount(g.discount)}원</div>}
                        </td>
                        <td className="total-cell">{formatAmount(g.total - g.discount)}원</td>
                      </tr>
                      {g.types.length > 1 && g.types.map(t => (
                        <tr key={t.event_type} style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                          <td style={{ paddingLeft: 16 }}>
                            <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                              background: eventTypeMap[t.event_type]?.color || '#9CA3AF', marginRight: 5, verticalAlign: 'middle' }} />
                            {eventTypeMap[t.event_type]?.label ?? t.event_type}
                          </td>
                          <td>{t.cnt}</td>
                          <td className="amount-cell">{formatAmount(t.total)}원</td>
                          <td className="total-cell">{formatAmount(t.total - (t.discount || 0))}원</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan="2"><strong>합계</strong></td>
                    <td className="amount-cell">
                      <strong>{formatAmount(groupedPaymentSummary.reduce((s, r) => s + r.total, 0))}원</strong>
                      {groupedPaymentSummary.reduce((s, r) => s + r.discount, 0) > 0 && (
                        <div className="cell-sub-line cell-sub-discount">-{formatAmount(groupedPaymentSummary.reduce((s, r) => s + r.discount, 0))}원</div>
                      )}
                    </td>
                    <td className="total-cell">
                      <strong>{formatAmount(groupedPaymentSummary.reduce((s, r) => s + r.total - r.discount, 0))}원</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            )
          ) : (
            /* 일반 모드 */
            paymentSummary.length === 0 ? (
              <p className="empty-state">데이터가 없습니다.</p>
            ) : (
              <table className="summary-table">
                <thead>
                  <tr>
                    <th>결제수단</th>
                    <th>건수</th>
                    <th>지출/할인</th>
                    <th>총액</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentSummary.map(r => (
                    <tr key={r.payment_method}>
                      <td>{r.payment_method}</td>
                      <td>{r.cnt}</td>
                      <td className="amount-cell">
                        {formatAmount(r.total)}원
                        {r.discount > 0 && (
                          <div className="cell-sub-line cell-sub-discount">-{formatAmount(r.discount)}원</div>
                        )}
                      </td>
                      <td className="total-cell">{formatAmount(r.total - (r.discount || 0))}원</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan="2"><strong>합계</strong></td>
                    <td className="amount-cell">
                      <strong>{formatAmount(paymentSummary.reduce((s, r) => s + r.total, 0))}원</strong>
                      {paymentSummary.reduce((s, r) => s + (r.discount || 0), 0) > 0 && (
                        <div className="cell-sub-line cell-sub-discount">-{formatAmount(paymentSummary.reduce((s, r) => s + (r.discount || 0), 0))}원</div>
                      )}
                    </td>
                    <td className="total-cell">
                      <strong>{formatAmount(paymentSummary.reduce((s, r) => s + r.total - (r.discount || 0), 0))}원</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            )
          )}

          {memberSummary.length > 0 && (
            <table className="summary-table summary-member-table">
              <thead>
                <tr>
                  <th>누가</th>
                  <th>건수</th>
                  <th>지출/할인</th>
                  <th>총액</th>
                </tr>
              </thead>
              <tbody>
                {memberSummary.map(r => (
                  <tr key={r.member || '__none__'}>
                    <td>{r.member || '지정 안 함'}</td>
                    <td>{r.cnt}</td>
                    <td className="amount-cell">
                      {formatAmount(r.total)}원
                      {r.discount > 0 && <div className="cell-sub-line cell-sub-discount">-{formatAmount(r.discount)}원</div>}
                    </td>
                    <td className="total-cell">{formatAmount(r.total - (r.discount || 0))}원</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export default SummaryView;
