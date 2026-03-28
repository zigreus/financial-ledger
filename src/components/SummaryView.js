import React, { useState, useMemo } from 'react';
import {
  getMonthlySummary, getMonthlyTotals,
  getPaymentMethodSummary, getAvailableMonths,
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
  const [selectedMonth, setSelectedMonth] = useState('');

  const months = useMemo(() => getAvailableMonths(db), [db]);
  const monthlyTotals = useMemo(() => getMonthlyTotals(db), [db]);
  const categorySummary = useMemo(() => getMonthlySummary(db, selectedMonth), [db, selectedMonth]);
  const paymentSummary = useMemo(() => getPaymentMethodSummary(db, selectedMonth), [db, selectedMonth]);

  const totalSpend = useMemo(() => categorySummary.reduce((s, r) => s + r.total, 0), [categorySummary]);
  const totalDiscount = useMemo(() => categorySummary.reduce((s, r) => s + (r.discount || 0), 0), [categorySummary]);

  return (
    <div className="summary-page">
      {/* 탭 */}
      <div className="summary-tabs">
        <button className={tab === 'monthly' ? 'tab active' : 'tab'} onClick={() => setTab('monthly')}>월별 추이</button>
        <button className={tab === 'category' ? 'tab active' : 'tab'} onClick={() => setTab('category')}>카테고리</button>
        <button className={tab === 'payment' ? 'tab active' : 'tab'} onClick={() => setTab('payment')}>결제수단</button>
      </div>

      {/* 월 필터 (카테고리/결제수단 탭에서만) */}
      {(tab === 'category' || tab === 'payment') && (
        <div className="summary-month-filter">
          <select value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}>
            <option value="">전체 기간</option>
            {months.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          {selectedMonth && (
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
          {monthlyTotals.length === 0 ? (
            <p className="empty-state">데이터가 없습니다.</p>
          ) : (
            <>
              <BarChart
                data={monthlyTotals.map(r => ({ label: r.month, value: r.total }))}
                maxValue={Math.max(...monthlyTotals.map(r => r.total))}
                color="#45B7D1"
                formatLabel={v => `${formatAmount(v)}원`}
              />
              <table className="summary-table">
                <thead>
                  <tr>
                    <th>월</th>
                    <th>건수</th>
                    <th>지출</th>
                    <th>할인</th>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
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
