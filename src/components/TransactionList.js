import React, { useState, useMemo } from 'react';
import { getTransactions, getAllPaymentMethods, getAllBudgetCategories, getAvailableMonths } from '../services/dbManager';
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

function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || '#AAB7B8';
}

function TransactionList({ db, onAdd, onEdit, onDelete }) {
  const [filters, setFilters] = useState({ month: '', payment_method: '', budget_category: '', search: '' });
  const [showFilters, setShowFilters] = useState(false);

  const months = useMemo(() => getAvailableMonths(db), [db]);
  const paymentMethods = useMemo(() => getAllPaymentMethods(db), [db]);
  const budgetCategories = useMemo(() => getAllBudgetCategories(db), [db]);

  const transactions = useMemo(
    () => getTransactions(db, filters),
    [db, filters]
  );

  const totalAmount = useMemo(() => transactions.reduce((s, t) => s + t.amount, 0), [transactions]);
  const totalDiscount = useMemo(() => transactions.reduce((s, t) => s + (t.discount_amount || 0), 0), [transactions]);

  const setFilter = (key, value) => setFilters(prev => ({ ...prev, [key]: value }));

  const clearFilters = () => setFilters({ month: '', payment_method: '', budget_category: '', search: '' });
  const hasFilters = Object.values(filters).some(v => v !== '');

  const [confirmDelete, setConfirmDelete] = useState(null);

  return (
    <div className="list-page">
      {/* 필터 바 */}
      <div className="filter-bar">
        <div className="filter-top">
          <input
            className="filter-search"
            type="text"
            placeholder="🔍 검색 (세부내역, 카테고리…)"
            value={filters.search}
            onChange={e => setFilter('search', e.target.value)}
          />
          <button
            className={`btn-filter-toggle ${showFilters ? 'active' : ''}`}
            onClick={() => setShowFilters(v => !v)}
          >
            필터 {hasFilters ? '●' : ''}
          </button>
        </div>

        {showFilters && (
          <div className="filter-panel">
            <select value={filters.month} onChange={e => setFilter('month', e.target.value)}>
              <option value="">전체 월</option>
              {months.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <select value={filters.payment_method} onChange={e => setFilter('payment_method', e.target.value)}>
              <option value="">전체 결제수단</option>
              {paymentMethods.map(m => <option key={m.id} value={m.name}>{m.name}{m.is_hidden ? ' (숨김)' : ''}</option>)}
            </select>
            <select value={filters.budget_category} onChange={e => setFilter('budget_category', e.target.value)}>
              <option value="">전체 카테고리</option>
              {budgetCategories.map(c => <option key={c.id} value={c.name}>{c.name}{c.is_hidden ? ' (숨김)' : ''}</option>)}
            </select>
            {hasFilters && (
              <button className="btn-clear-filter" onClick={clearFilters}>초기화</button>
            )}
          </div>
        )}
      </div>

      {/* 요약 바 */}
      <div className="summary-bar">
        <span className="summary-count">{transactions.length}건</span>
        <span className="summary-total">{formatAmount(totalAmount)}원</span>
        {totalDiscount > 0 && (
          <span className="summary-discount">할인 -{formatAmount(totalDiscount)}원</span>
        )}
      </div>

      {/* 거래 목록 */}
      {transactions.length === 0 ? (
        <div className="empty-state">
          <p>거래 내역이 없습니다.</p>
          <button className="btn-primary" onClick={onAdd}>+ 첫 거래 추가하기</button>
        </div>
      ) : (
        <ul className="tx-list">
          {transactions.map(tx => (
            <li key={tx.id} className="tx-item">
              <div
                className="tx-category-bar"
                style={{ backgroundColor: categoryColor(tx.budget_category) }}
              />
              <div className="tx-body">
                <div className="tx-row1">
                  <span className="tx-date">{tx.date}</span>
                  <span className="tx-amount">{formatAmount(tx.amount)}원</span>
                </div>
                <div className="tx-row2">
                  <span
                    className="tx-badge"
                    style={{ backgroundColor: categoryColor(tx.budget_category) + '33', color: categoryColor(tx.budget_category) }}
                  >
                    {tx.budget_category}
                  </span>
                  {tx.sub_category && <span className="tx-sub">{tx.sub_category}</span>}
                  <span className="tx-payment">{tx.payment_method}</span>
                </div>
                {tx.detail && <div className="tx-detail">{tx.detail}</div>}
                {tx.discount_amount > 0 && (
                  <div className="tx-discount">
                    할인 -{formatAmount(tx.discount_amount)}원
                    {tx.discount_note && ` (${tx.discount_note})`}
                  </div>
                )}
              </div>
              <div className="tx-actions">
                <button className="btn-icon" onClick={() => onEdit(tx)} title="수정">✏️</button>
                <button className="btn-icon btn-delete" onClick={() => setConfirmDelete(tx)} title="삭제">🗑️</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 삭제 확인 다이얼로그 */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal-content modal-small" onClick={e => e.stopPropagation()}>
            <h3>거래 삭제</h3>
            <p>
              <strong>{confirmDelete.date}</strong> / {confirmDelete.budget_category}<br />
              <strong>{formatAmount(confirmDelete.amount)}원</strong>을 삭제하시겠습니까?
            </p>
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>취소</button>
              <button
                className="btn-danger"
                onClick={() => { onDelete(confirmDelete.id); setConfirmDelete(null); }}
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TransactionList;
