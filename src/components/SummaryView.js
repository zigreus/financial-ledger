import React, { useState, useMemo } from 'react';
import {
  getMonthlySummary, getMonthlyTotals,
  getPaymentMethodSummary, getAvailableMonths,
  getYearlySummary, getYearlyPaymentMethodSummary,
  getRangeSummary, getRangePaymentMethodSummary,
  getAvailableYears,
} from '../services/dbManager';
import { formatAmount } from '../services/formulaEvaluator';

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

function BarChart({ data, maxValue, color, formatLabel }) {
  return (
    <div className="bar-chart">
      {data.map((item, i) => (
        <div key={i} className="bar-row">
          <span className="bar-label">{item.label}</span>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                width: maxValue ? `${(item.value / maxValue) * 100}%` : '0%',
                backgroundColor: color || '#4ECDC4',
              }}
            />
          </div>
          <span className="bar-value">{formatLabel ? formatLabel(item.value) : item.value}</span>
        </div>
      ))}
    </div>
  );
}

function SummaryView({ db }) {
  const [tab, setTab] = useState('monthly'); // 'monthly' | 'category' | 'payment'
  const [monthlySubTab, setMonthlySubTab] = useState('list'); // 'list' | 'chart'
  const [filterType, setFilterType] = useState('month'); // 'month' | 'year' | 'range'
  const [selectedYear, setSelectedYear] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const currentMonth = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  const [selectedMonth, setSelectedMonth] = useState(currentMonth);

  const months = useMemo(() => getAvailableMonths(db), [db]);
  const years = useMemo(() => getAvailableYears(db), [db]);
  const monthlyTotals = useMemo(() => getMonthlyTotals(db), [db]);

  const categorySummary = useMemo(() => {
    if (filterType === 'month') {
      return getMonthlySummary(db, selectedMonth);
    } else if (filterType === 'year') {
      return selectedYear ? getYearlySummary(db, selectedYear) : [];
    } else if (filterType === 'range') {
      return dateFrom && dateTo ? getRangeSummary(db, dateFrom, dateTo) : [];
    }
    return [];
  }, [db, filterType, selectedMonth, selectedYear, dateFrom, dateTo]);

  const paymentSummary = useMemo(() => {
    if (filterType === 'month') {
      return getPaymentMethodSummary(db, selectedMonth);
    } else if (filterType === 'year') {
      return selectedYear ? getYearlyPaymentMethodSummary(db, selectedYear) : [];
    } else if (filterType === 'range') {
      return dateFrom && dateTo ? getRangePaymentMethodSummary(db, dateFrom, dateTo) : [];
    }
    return [];
  }, [db, filterType, selectedMonth, selectedYear, dateFrom, dateTo]);

  const totalSpend = useMemo(() => categorySummary.reduce((s, r) => s + r.total, 0), [categorySummary]);
  const totalDiscount = useMemo(() => categorySummary.reduce((s, r) => s + (r.discount || 0), 0), [categorySummary]);

  return (
    <div className="summary-page">
      {/* 메인 탭 */}
      <div className="summary-tabs">
        <button className={tab === 'monthly' ? 'tab active' : 'tab'} onClick={() => setTab('monthly')}>월별 추이</button>
        <button className={tab === 'category' ? 'tab active' : 'tab'} onClick={() => setTab('category')}>카테고리</button>
        <button className={tab === 'payment' ? 'tab active' : 'tab'} onClick={() => setTab('payment')}>결제수단</button>
      </div>

      {/* 필터 (카테고리/결제수단 탭에서만) */}
      {(tab === 'category' || tab === 'payment') && (
        <div className="summary-filter">
          <div className="filter-type-buttons">
            <button
              className={`filter-type-btn ${filterType === 'month' ? 'active' : ''}`}
              onClick={() => {
                setFilterType('month');
                setSelectedMonth(currentMonth);
              }}
            >
              월별
            </button>
            <button
              className={`filter-type-btn ${filterType === 'year' ? 'active' : ''}`}
              onClick={() => {
                setFilterType('year');
                setSelectedYear('');
              }}
            >
              연도별
            </button>
            <button
              className={`filter-type-btn ${filterType === 'range' ? 'active' : ''}`}
              onClick={() => {
                setFilterType('range');
                setDateFrom('');
                setDateTo('');
              }}
            >
              기간별
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
                <option value="">연도 선택</option>
                {years.map(y => <option key={y} value={y}>{y}년</option>)}
              </select>
            )}
            {filterType === 'range' && (
              <div className="date-range-inputs">
                <input
                  type="date"
                  value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)}
                  placeholder="시작일"
                />
                <span className="date-separator">~</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={e => setDateTo(e.target.value)}
                  placeholder="종료일"
                />
              </div>
            )}
          </div>

          {((filterType === 'month' && selectedMonth) || (filterType === 'year' && selectedYear) || (filterType === 'range' && dateFrom && dateTo)) && (
            <div className="summary-total-row">
              <span>합계: <strong>{formatAmount(totalSpend)}원</strong></span>
              {totalDiscount > 0 && (
                <span className="discount-tag">할인 -{formatAmount(totalDiscount)}원</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* 월별 추이 탭 */}
      {tab === 'monthly' && (
        <div className="summary-section">
          {/* 서브탭 */}
          <div className="summary-sub-tabs">
            <button
              className={monthlySubTab === 'list' ? 'sub-tab active' : 'sub-tab'}
              onClick={() => setMonthlySubTab('list')}
            >
              목록
            </button>
            <button
              className={monthlySubTab === 'chart' ? 'sub-tab active' : 'sub-tab'}
              onClick={() => setMonthlySubTab('chart')}
            >
              그래프
            </button>
          </div>

          {monthlyTotals.length === 0 ? (
            <p className="empty-state">데이터가 없습니다.</p>
          ) : monthlySubTab === 'chart' ? (
            <BarChart
              data={[...monthlyTotals].reverse().map(r => ({ label: r.month, value: r.total }))}
              maxValue={Math.max(...monthlyTotals.map(r => r.total))}
              color="#45B7D1"
              formatLabel={v => `${formatAmount(v)}원`}
            />
          ) : (
            <table className="summary-table">
              <thead>
                <tr>
                  <th>월</th>
                  <th>건수</th>
                  <th>지출</th>
                  <th>할인</th>
                  <th>총액</th>
                </tr>
              </thead>
              <tbody>
                {monthlyTotals.map(r => (
                  <tr key={r.month}>
                    <td>{r.month}</td>
                    <td>{r.cnt}</td>
                    <td className="amount-cell">{formatAmount(r.total)}원</td>
                    <td className="discount-cell">
                      {r.discount > 0 ? `-${formatAmount(r.discount)}원` : '-'}
                    </td>
                    <td className="total-cell">{formatAmount(r.total - (r.discount || 0))}원</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 카테고리별 탭 */}
      {tab === 'category' && (
        <div className="summary-section">
          {categorySummary.length === 0 ? (
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
                    <th>지출</th>
                    <th>할인</th>
                    <th>총액</th>
                  </tr>
                </thead>
                <tbody>
                  {categorySummary.map(r => (
                    <tr key={r.budget_category}>
                      <td>
                        <span
                          className="cat-dot"
                          style={{ backgroundColor: CATEGORY_COLORS[r.budget_category] || '#AAB7B8' }}
                        />
                        {r.budget_category}
                      </td>
                      <td>{r.cnt}</td>
                      <td className="amount-cell">{formatAmount(r.total)}원</td>
                      <td className="discount-cell">
                        {r.discount > 0 ? `-${formatAmount(r.discount)}원` : '-'}
                      </td>
                      <td className="total-cell">{formatAmount(r.total - (r.discount || 0))}원</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan="2"><strong>합계</strong></td>
                    <td className="amount-cell"><strong>{formatAmount(totalSpend)}원</strong></td>
                    <td className="discount-cell">
                      {totalDiscount > 0 ? <strong>-{formatAmount(totalDiscount)}원</strong> : '-'}
                    </td>
                    <td className="total-cell"><strong>{formatAmount(totalSpend - totalDiscount)}원</strong></td>
                  </tr>
                </tfoot>
              </table>
            </>
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
                    <td className="discount-cell">
                      {r.discount > 0 ? `-${formatAmount(r.discount)}원` : '-'}
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
