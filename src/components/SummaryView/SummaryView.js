import React, { useState, useMemo, useEffect } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  getMonthlySummary, getMonthlySubCategorySummary,
  getPaymentMethodSummary, getAvailableMonths,
  getYearlySummary, getYearlyPaymentMethodSummary, getYearlySubCategorySummary,
  getRangeSummary, getRangePaymentMethodSummary, getRangeSubCategorySummary,
  getAvailableYears, getTripSummary, getTripDetailSummary, getTripPaymentMethodSummary,
  getTrips, getMonthlyTotalsWithGoals, getSetting,
} from '../../services/dbManager';
import { formatAmount } from '../../services/formulaEvaluator';
import './SummaryView.css';

// 날짜 포맷 헬퍼
const _fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

// 앱 종료 전까지 필터 상태 유지 (모듈 레벨)
const _initNow = new Date();
const _initWeekAgo = new Date(_initNow);
_initWeekAgo.setDate(_initNow.getDate() - 6);
const _filterState = {
  filterType: 'month',
  selectedMonth: `${_initNow.getFullYear()}-${String(_initNow.getMonth()+1).padStart(2,'0')}`,
  selectedYear: String(_initNow.getFullYear()),
  dateFrom: _fmt(_initWeekAgo),
  dateTo: _fmt(_initNow),
  selectedTripId: '',
};

const CATEGORY_COLORS = {
  '식비': '#FF6B6B',
  '쇼핑': '#4ECDC4',
  '차량교통비': '#45B7D1',
  '의류/미용': '#F7DC6F',
  '의료/건강': '#82E0AA',
  '교육': '#BB8FCE',
  '여행/문화': '#F0A500',
  '반려동물': '#A3C4F3',
  '기타': '#AAB7B8',
};

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
                  width: maxValue ? `${(item.value / maxValue) * 100}%` : '0%',
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

function ForeignAmountsCell({ foreignTotals }) {
  const entries = Object.entries(foreignTotals);
  if (entries.length === 0) return <span className="amount-secondary">-</span>;
  return entries.map(([currency, amount]) => (
    <span key={currency} className="foreign-amount-tag">
      {currency} {amount % 1 === 0 ? formatAmount(amount) : amount.toFixed(2)}
    </span>
  ));
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

function SummaryView({ db, tab, drilldownCategory, onTabChange, onDrilldownChange }) {
  const [monthlySubTab, setMonthlySubTab] = useState('list'); // 'list' | 'chart'
  const [monthlyLimit, setMonthlyLimit] = useState(24);
  const [filterType, setFilterType] = useState(() => _filterState.filterType);
  const currentYear = useMemo(() => String(new Date().getFullYear()), []);
  const [selectedYear, setSelectedYear] = useState(() => _filterState.selectedYear);
  const [dateFrom, setDateFrom] = useState(() => _filterState.dateFrom);
  const [dateTo, setDateTo] = useState(() => _filterState.dateTo);
  const [selectedTripId, setSelectedTripId] = useState(() => _filterState.selectedTripId);

  const currentMonth = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  const [selectedMonth, setSelectedMonth] = useState(() => _filterState.selectedMonth);

  // 필터 상태 변경 시 모듈 레벨에 저장 (앱 종료 전까지 유지)
  useEffect(() => { _filterState.filterType = filterType; }, [filterType]);
  useEffect(() => { _filterState.selectedMonth = selectedMonth; }, [selectedMonth]);
  useEffect(() => { _filterState.selectedYear = selectedYear; }, [selectedYear]);
  useEffect(() => { _filterState.dateFrom = dateFrom; }, [dateFrom]);
  useEffect(() => { _filterState.dateTo = dateTo; }, [dateTo]);
  useEffect(() => { _filterState.selectedTripId = selectedTripId; }, [selectedTripId]);

  const months = useMemo(() => getAvailableMonths(db), [db]);
  const years = useMemo(() => getAvailableYears(db), [db]);
  const monthlyTotals = useMemo(() => getMonthlyTotalsWithGoals(db, monthlyLimit), [db, monthlyLimit]);
  const isMobile = useIsMobile();
  const showGoal = useMemo(
    () => getSetting(db, isMobile ? 'show_goal_display_mobile' : 'show_goal_display_pc', '1') !== '0',
    [db, isMobile]
  );
  const trips = useMemo(() => getTrips(db), [db]);

  const categorySummary = useMemo(() => {
    if (filterType === 'month') return getMonthlySummary(db, selectedMonth);
    if (filterType === 'year') return selectedYear ? getYearlySummary(db, selectedYear) : [];
    if (filterType === 'range') return dateFrom && dateTo ? getRangeSummary(db, dateFrom, dateTo) : [];
    return [];
  }, [db, filterType, selectedMonth, selectedYear, dateFrom, dateTo]);

  const subCategorySummary = useMemo(() => {
    if (!drilldownCategory) return [];
    if (filterType === 'month') return getMonthlySubCategorySummary(db, selectedMonth, drilldownCategory);
    if (filterType === 'year') return selectedYear ? getYearlySubCategorySummary(db, selectedYear, drilldownCategory) : [];
    if (filterType === 'range') return dateFrom && dateTo ? getRangeSubCategorySummary(db, dateFrom, dateTo, drilldownCategory) : [];
    return [];
  }, [db, drilldownCategory, filterType, selectedMonth, selectedYear, dateFrom, dateTo]);

  const paymentSummary = useMemo(() => {
    if (filterType === 'month') return getPaymentMethodSummary(db, selectedMonth);
    if (filterType === 'year') return selectedYear ? getYearlyPaymentMethodSummary(db, selectedYear) : [];
    if (filterType === 'range') return dateFrom && dateTo ? getRangePaymentMethodSummary(db, dateFrom, dateTo) : [];
    if (filterType === 'trip') return getTripPaymentMethodSummary(db, selectedTripId ? Number(selectedTripId) : null);
    return [];
  }, [db, filterType, selectedMonth, selectedYear, dateFrom, dateTo, selectedTripId]);

  const tripSummary = useMemo(() => getTripSummary(db), [db]);
  const tripDetailSummary = useMemo(
    () => selectedTripId ? getTripDetailSummary(db, Number(selectedTripId)) : [],
    [db, selectedTripId]
  );

  const totalSpend = useMemo(() => categorySummary.reduce((s, r) => s + r.total, 0), [categorySummary]);
  const totalDiscount = useMemo(() => categorySummary.reduce((s, r) => s + (r.discount || 0), 0), [categorySummary]);

  const tripTotalSpend = useMemo(() => tripSummary.reduce((s, r) => s + r.total, 0), [tripSummary]);
  const tripTotalDiscount = useMemo(() => tripSummary.reduce((s, r) => s + (r.discount || 0), 0), [tripSummary]);

  const detailTotalSpend = useMemo(() => tripDetailSummary.reduce((s, r) => s + r.total, 0), [tripDetailSummary]);
  const detailTotalDiscount = useMemo(() => tripDetailSummary.reduce((s, r) => s + (r.discount || 0), 0), [tripDetailSummary]);

  const showFilter = tab === 'category' || tab === 'payment';
  const hasDateFilter = (filterType === 'month' && selectedMonth) ||
    (filterType === 'year' && selectedYear) ||
    (filterType === 'range' && dateFrom && dateTo);

  // 현재 여행 모드의 총액 (전체 또는 특정 여행)
  const tripDisplaySpend = selectedTripId ? detailTotalSpend : tripTotalSpend;
  const tripDisplayDiscount = selectedTripId ? detailTotalDiscount : tripTotalDiscount;
  const tripDisplayForeign = selectedTripId
    ? aggregateForeign(tripDetailSummary)
    : aggregateForeign(tripSummary);

  return (
    <div className="summary-page">
      {/* 메인 탭 */}
      <div className="summary-tabs">
        <button className={tab === 'monthly' ? 'tab active' : 'tab'} onClick={() => onTabChange('monthly')}>월별 추이</button>
        <button className={tab === 'category' ? 'tab active' : 'tab'} onClick={() => onTabChange('category')}>카테고리</button>
        <button className={tab === 'payment' ? 'tab active' : 'tab'} onClick={() => onTabChange('payment')}>결제수단</button>
      </div>

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
              className={`filter-type-btn ${filterType === 'trip' ? 'active' : ''}`}
              onClick={() => { setFilterType('trip'); setSelectedTripId(''); if (drilldownCategory) onDrilldownChange(null); }}
            >
              여행별
            </button>
          </div>

          <div className="filter-inputs">
            {filterType === 'month' && (
              <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}>
                <option value="">전체 기간</option>
                {months.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
            {filterType === 'year' && (
              <select value={selectedYear} onChange={e => setSelectedYear(e.target.value)}>
                {years.map(y => <option key={y} value={y}>{y}년</option>)}
              </select>
            )}
            {filterType === 'range' && (
              <div className="date-range-inputs">
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} placeholder="시작일" />
                <span className="date-separator">~</span>
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} placeholder="종료일" />
              </div>
            )}
            {filterType === 'trip' && trips.length > 0 && (
              <select value={selectedTripId} onChange={e => setSelectedTripId(e.target.value)}>
                <option value="">전체 여행</option>
                {trips.map(t => <option key={t.id} value={String(t.id)}>{t.name}</option>)}
              </select>
            )}
          </div>

          {/* 총액 요약 */}
          {filterType === 'trip' ? (
            (tripSummary.length > 0 || tripDetailSummary.length > 0) && (
              <div className="summary-total-row">
                <span>총액: <strong>{formatAmount(tripDisplaySpend - tripDisplayDiscount)}원</strong></span>
                <span className="amount-secondary">지출 {formatAmount(tripDisplaySpend)}원</span>
                {tripDisplayDiscount > 0 && (
                  <span className="discount-tag">할인 -{formatAmount(tripDisplayDiscount)}원</span>
                )}
                {Object.entries(tripDisplayForeign).map(([c, a]) => (
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
              data={monthlyTotals.map(r => ({ label: r.month, value: r.total - (r.discount || 0) }))}
              maxValue={Math.max(...monthlyTotals.map(r => r.total - (r.discount || 0)))}
              color="#45B7D1"
              formatLabel={v => `${formatAmount(v)}원`}
              currentMonth={currentMonth}
            />
          ) : (
            <table className="summary-table">
              <thead>
                <tr>
                  <th>월</th>
                  <th>건수</th>
                  <th>지출/할인</th>
                  <th>{showGoal ? '총액/목표' : '총액'}</th>
                </tr>
              </thead>
              <tbody>
                {monthlyTotals.map(r => {
                  const isCurrent = r.month === currentMonth;
                  const net = r.total - (r.discount || 0);
                  const diff = r.goal !== null && r.goal !== undefined ? r.goal - net : null;
                  const isSaved = diff !== null && diff >= 0;
                  return (
                    <tr key={r.month} className={isCurrent ? 'current-month-row' : ''}>
                      <td>{r.month}</td>
                      <td>{r.cnt}</td>
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 카테고리별 탭 */}
      {tab === 'category' && (
        <div className="summary-section">
          {filterType === 'trip' ? (
            /* 여행별 모드 */
            selectedTripId ? (
              /* 특정 여행 선택 → 세부카테고리별 */
              tripDetailSummary.length === 0 ? (
                <p className="empty-state">데이터가 없습니다.</p>
              ) : (
                <>
                  <BarChart
                    data={tripDetailSummary.map(r => ({ label: r.sub_category, value: r.total }))}
                    maxValue={tripDetailSummary[0]?.total || 1}
                    color="#F0A500"
                    formatLabel={v => `${formatAmount(v)}원`}
                  />
                  <table className="summary-table">
                    <thead>
                      <tr>
                        <th>세부카테고리</th>
                        <th>건수</th>
                        <th>총액(원)</th>
                        <th>현지 금액</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tripDetailSummary.map(r => (
                        <tr key={r.sub_category}>
                          <td className="nowrap-cell">{r.sub_category}</td>
                          <td>{r.cnt}</td>
                          <td className="total-cell">{formatAmount(r.total - (r.discount || 0))}원</td>
                          <td className="foreign-amounts-cell">
                            <ForeignAmountsCell foreignTotals={r.foreignTotals} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan="2"><strong>합계</strong></td>
                        <td className="total-cell">
                          <strong>{formatAmount(detailTotalSpend - detailTotalDiscount)}원</strong>
                        </td>
                        <td className="foreign-amounts-cell">
                          <ForeignAmountsCell foreignTotals={aggregateForeign(tripDetailSummary)} />
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </>
              )
            ) : (
              /* 전체 여행 → 여행별 */
              tripSummary.length === 0 ? (
                <p className="empty-state">여행 데이터가 없습니다.</p>
              ) : (
                <>
                  <BarChart
                    data={tripSummary.map(r => ({ label: r.trip_name, value: r.total }))}
                    maxValue={tripSummary[0]?.total || 1}
                    color="#F0A500"
                    formatLabel={v => `${formatAmount(v)}원`}
                  />
                  <table className="summary-table">
                    <thead>
                      <tr>
                        <th>여행</th>
                        <th>건수</th>
                        <th>총액(원)</th>
                        <th>현지 금액</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tripSummary.map(r => (
                        <tr key={r.trip_id}>
                          <td className="nowrap-cell">{r.trip_name}</td>
                          <td>{r.cnt}</td>
                          <td className="total-cell">{formatAmount(r.total - (r.discount || 0))}원</td>
                          <td className="foreign-amounts-cell">
                            <ForeignAmountsCell foreignTotals={r.foreignTotals} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan="2"><strong>합계</strong></td>
                        <td className="total-cell">
                          <strong>{formatAmount(tripTotalSpend - tripTotalDiscount)}원</strong>
                        </td>
                        <td className="foreign-amounts-cell">
                          <ForeignAmountsCell foreignTotals={aggregateForeign(tripSummary)} />
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </>
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
                    data={subCategorySummary.map(r => ({ label: r.sub_category || '(미분류)', value: r.total }))}
                    maxValue={subCategorySummary[0]?.total || 1}
                    color={CATEGORY_COLORS[drilldownCategory] || '#AAB7B8'}
                    formatLabel={v => `${formatAmount(v)}원`}
                  />
                  <table className="summary-table">
                    <thead>
                      <tr>
                        <th>세부항목</th>
                        <th>건수</th>
                        <th>지출</th>
                        <th>할인</th>
                        <th>총액</th>
                      </tr>
                    </thead>
                    <tbody>
                      {subCategorySummary.map(r => (
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
                  data={categorySummary.map(r => ({ label: r.budget_category, value: r.total }))}
                  maxValue={categorySummary[0]?.total || 1}
                  color={null}
                  formatLabel={v => `${formatAmount(v)}원`}
                />
                <table className="summary-table">
                  <thead>
                    <tr>
                      <th>카테고리</th>
                      <th>건수</th>
                      <th>지출/할인</th>
                      <th>총액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categorySummary.map(r => (
                      <tr
                        key={r.budget_category}
                        className="clickable-row"
                        onClick={() => onDrilldownChange(r.budget_category)}
                      >
                        <td>
                          <span className="cat-dot" style={{ backgroundColor: CATEGORY_COLORS[r.budget_category] || '#AAB7B8' }} />
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
          {paymentSummary.length === 0 ? (
            <p className="empty-state">데이터가 없습니다.</p>
          ) : (
            <table className="summary-table">
              <thead>
                <tr>
                  <th>결제수단</th>
                  <th>건수</th>
                  <th>지출</th>
                  <th>할인</th>
                  <th>총액</th>
                </tr>
              </thead>
              <tbody>
                {paymentSummary.map(r => (
                  <tr key={r.payment_method}>
                    <td>{r.payment_method}</td>
                    <td>{r.cnt}</td>
                    <td className="amount-cell">{formatAmount(r.total)}원</td>
                    <td className="discount-cell">{r.discount > 0 ? `-${formatAmount(r.discount)}원` : '-'}</td>
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
