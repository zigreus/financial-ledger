import React, { useState, useMemo, useRef, useEffect } from 'react';
import { getTransactions, getAllPaymentMethods, getAllBudgetCategories, getAvailableMonths, getCategoryColor } from '../services/dbManager';
import { formatAmount } from '../services/formulaEvaluator';

const DEFAULT_CATEGORY_COLORS = {
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

function categoryColor(db, cat) {
  const customColor = getCategoryColor(db, cat);
  return customColor || DEFAULT_CATEGORY_COLORS[cat] || '#AAB7B8';
}

function TransactionList({ db, onAdd, onEdit, onDelete }) {
  const [filters, setFilters] = useState({ month: '', payment_method: '', budget_category: '', search: '' });
  const [showFilters, setShowFilters] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedForDelete, setSelectedForDelete] = useState(new Set());
  const [selectedDetail, setSelectedDetail] = useState(null);

  const currentMonthRef = useRef(null);

  const months = useMemo(() => getAvailableMonths(db), [db]);
  const paymentMethods = useMemo(() => getAllPaymentMethods(db), [db]);
  const budgetCategories = useMemo(() => getAllBudgetCategories(db), [db]);

  const transactions = useMemo(
    () => getTransactions(db, filters),
    [db, filters]
  );

  // 현재 월 (YYYY-MM 형식)
  const currentMonth = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  // 월별로 그룹화된 거래내역
  const groupedTransactions = useMemo(() => {
    const groups = {};
    transactions.forEach(tx => {
      const month = tx.date.substring(0, 7);
      if (!groups[month]) groups[month] = [];
      groups[month].push(tx);
    });
    return groups;
  }, [transactions]);

  // 확장된 월들 (현재 월만 기본으로 열림)
  const [expandedMonths, setExpandedMonths] = useState(new Set([currentMonth]));

  // 마운트 시 현재 월로 스크롤
  useEffect(() => {
    const timer = setTimeout(() => {
      if (currentMonthRef.current) {
        currentMonthRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  const toggleMonth = (month) => {
    const newExpanded = new Set(expandedMonths);
    if (newExpanded.has(month)) {
      newExpanded.delete(month);
    } else {
      newExpanded.add(month);
    }
    setExpandedMonths(newExpanded);
  };

  const totalAmount = useMemo(() => transactions.reduce((s, t) => s + t.amount, 0), [transactions]);
  const totalDiscount = useMemo(() => transactions.reduce((s, t) => s + (t.discount_amount || 0), 0), [transactions]);

  const setFilter = (key, value) => setFilters(prev => ({ ...prev, [key]: value }));

  const clearFilters = () => setFilters({ month: '', payment_method: '', budget_category: '', search: '' });
  const hasFilters = Object.values(filters).some(v => v !== '');

  const toggleSelectForDelete = (txId) => {
    const newSet = new Set(selectedForDelete);
    if (newSet.has(txId)) {
      newSet.delete(txId);
    } else {
      newSet.add(txId);
    }
    setSelectedForDelete(newSet);
  };

  const handleBulkDelete = () => {
    if (!window.confirm(`${selectedForDelete.size}개의 거래를 삭제하시겠습니까?`)) return;
    selectedForDelete.forEach(id => onDelete(id));
    setSelectedForDelete(new Set());
    setDeleteMode(false);
  };

  return (
    <div className="list-page">
      {/* 필터 바 + 요약 정보 통합 */}
      <div className="filter-bar">
        <div className="filter-top">
          {deleteMode ? (
            <>
              <span className="filter-summary-info">{selectedForDelete.size}개 선택됨</span>
              <button
                className="btn-filter-sm btn-filter-cancel"
                onClick={() => { setDeleteMode(false); setSelectedForDelete(new Set()); }}
              >
                취소
              </button>
              {selectedForDelete.size > 0 && (
                <button className="btn-filter-sm btn-filter-danger" onClick={handleBulkDelete}>
                  삭제
                </button>
              )}
            </>
          ) : (
            <>
              <input
                className="filter-search"
                type="text"
                placeholder="🔍 검색 (세부내역, 카테고리…)"
                value={filters.search}
                onChange={e => setFilter('search', e.target.value)}
              />
              <span className="filter-summary-info">
                {transactions.length}건 · {formatAmount(totalAmount)}원
                {totalDiscount > 0 && ` · 할인 -${formatAmount(totalDiscount)}원`}
              </span>
              <button
                className={`btn-filter-toggle ${showFilters ? 'active' : ''}`}
                onClick={() => setShowFilters(v => !v)}
              >
                필터 {hasFilters ? '●' : ''}
              </button>
              <button className="btn-filter-sm" onClick={() => setDeleteMode(true)}>
                삭제
              </button>
            </>
          )}
        </div>

        {showFilters && !deleteMode && (
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

      {/* 거래 목록 */}
      {transactions.length === 0 ? (
        <div className="empty-state">
          <p>거래 내역이 없습니다.</p>
          <button className="btn-primary" onClick={onAdd}>+ 첫 거래 추가하기</button>
        </div>
      ) : (
        <div className="tx-list">
          {Object.keys(groupedTransactions).sort().reverse().map(month => (
            <div
              key={month}
              className="month-group"
              ref={month === currentMonth ? currentMonthRef : null}
            >
              <div
                className="month-header"
                onClick={() => toggleMonth(month)}
              >
                <span className="month-toggle">
                  {expandedMonths.has(month) ? '▼' : '▶'}
                </span>
                <span className="month-label">
                  {month}
                  {month === currentMonth && ' (이번 달)'}
                </span>
                <span className="month-stats">
                  {groupedTransactions[month].length}건 / {formatAmount(
                    groupedTransactions[month].reduce((s, t) => s + t.amount, 0)
                  )}원
                </span>
              </div>
              {expandedMonths.has(month) && (
                <ul className="tx-list-items">
                  {groupedTransactions[month].map(tx => (
                    <li
                      key={tx.id}
                      className={`tx-item ${deleteMode && selectedForDelete.has(tx.id) ? 'tx-item-selected' : ''}`}
                      onClick={() => {
                        if (deleteMode) {
                          toggleSelectForDelete(tx.id);
                        } else {
                          setSelectedDetail(tx);
                        }
                      }}
                    >
                      {deleteMode && (
                        <input
                          type="checkbox"
                          className="tx-checkbox"
                          checked={selectedForDelete.has(tx.id)}
                          onChange={() => toggleSelectForDelete(tx.id)}
                          onClick={e => e.stopPropagation()}
                        />
                      )}
                      <div
                        className="tx-category-bar"
                        style={{ backgroundColor: categoryColor(db, tx.budget_category) }}
                      />
                      <div className="tx-body">
                        <div className="tx-row1">
                          <span className="tx-date">{tx.date}</span>
                          <span className="tx-amount">{formatAmount(tx.amount)}원</span>
                        </div>
                        <div className="tx-row2">
                          <span
                            className="tx-badge"
                            style={{ backgroundColor: categoryColor(db, tx.budget_category) + '33', color: categoryColor(db, tx.budget_category) }}
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
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 세부내역 모달 */}
      {selectedDetail && (
        <div className="modal-overlay" onClick={() => setSelectedDetail(null)}>
          <div className="modal-content modal-small" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>거래 세부내역</h3>
              <button className="modal-close" onClick={() => setSelectedDetail(null)}>✕</button>
            </div>
            <div style={{ padding: '16px 20px' }}>
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>날짜</div>
                <div style={{ fontSize: '16px', fontWeight: '600' }}>{selectedDetail.date}</div>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>카테고리</div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span
                    style={{
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      backgroundColor: categoryColor(db, selectedDetail.budget_category)
                    }}
                  />
                  <span style={{ fontSize: '15px' }}>{selectedDetail.budget_category}</span>
                  {selectedDetail.sub_category && (
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      / {selectedDetail.sub_category}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>결제수단</div>
                <div style={{ fontSize: '15px' }}>{selectedDetail.payment_method}</div>
              </div>
              {selectedDetail.detail && (
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>세부내역</div>
                  <div style={{ fontSize: '15px' }}>{selectedDetail.detail}</div>
                </div>
              )}
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>금액</div>
                <div style={{ fontSize: '18px', fontWeight: '700', color: 'var(--primary)' }}>
                  {formatAmount(selectedDetail.amount)}원
                </div>
              </div>
              {selectedDetail.discount_amount > 0 && (
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>할인</div>
                  <div style={{ fontSize: '15px', color: 'var(--success)' }}>
                    -{formatAmount(selectedDetail.discount_amount)}원
                    {selectedDetail.discount_note && ` (${selectedDetail.discount_note})`}
                  </div>
                </div>
              )}
            </div>
            <div className="form-actions" style={{ padding: '0 20px 20px' }}>
              <button className="btn-secondary" onClick={() => setSelectedDetail(null)}>닫기</button>
              <button className="btn-primary" onClick={() => { onEdit(selectedDetail); setSelectedDetail(null); }}>
                수정
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TransactionList;
