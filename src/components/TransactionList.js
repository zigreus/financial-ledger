import React, { useState, useMemo, useRef, useEffect } from 'react';
import { getTransactions, getAllPaymentMethods, getAllBudgetCategories, getAllSubCategories, getAvailableMonths, getTrips, getAllMonthlyGoals, setMonthlyGoal, getSetting } from '../services/dbManager';
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

function stringToHue(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function categoryColor(cat) {
  if (!cat) return '#AAB7B8';
  if (DEFAULT_CATEGORY_COLORS[cat]) return DEFAULT_CATEGORY_COLORS[cat];
  const hue = stringToHue(cat);
  return `hsl(${hue}, 55%, 52%)`;
}

function TransactionList({ db, onAdd, onEdit, onDelete, onChanged }) {
  const [filters, setFilters] = useState({ month: '', payment_method: '', budget_category: '', search: '' });
  const [showFilters, setShowFilters] = useState(false);
  const [showIssueOnly, setShowIssueOnly] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedForDelete, setSelectedForDelete] = useState(new Set());
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [editingGoalMonth, setEditingGoalMonth] = useState(null);
  const [editingGoalValue, setEditingGoalValue] = useState('');

  const currentMonthRef = useRef(null);
  const filterBarRef = useRef(null);
  const [filterBarHeight, setFilterBarHeight] = useState(58);

  // 현재 월 (YYYY-MM 형식)
  const currentMonth = useMemo(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  const months = useMemo(() => getAvailableMonths(db), [db]);
  const monthlyGoalsMap = useMemo(() => getAllMonthlyGoals(db), [db]);
  const defaultGoal = useMemo(() => {
    const v = getSetting(db, 'default_monthly_goal', '');
    return v !== '' ? parseInt(v, 10) : null;
  }, [db]);

  const getGoalForMonth = (yearMonth) => {
    if (monthlyGoalsMap[yearMonth] !== undefined) return monthlyGoalsMap[yearMonth];
    return defaultGoal;
  };

  // 결제수단 필터: 비숨김 먼저, 그 다음 숨김 (sort_order 기준)
  const paymentMethods = useMemo(() => {
    const all = getAllPaymentMethods(db);
    return [...all].sort((a, b) => {
      if (a.is_hidden !== b.is_hidden) return a.is_hidden ? 1 : -1;
      return a.sort_order - b.sort_order;
    });
  }, [db]);

  const budgetCategories = useMemo(() => getAllBudgetCategories(db), [db]);
  const tripMap = useMemo(() => {
    const map = {};
    getTrips(db).forEach(t => { map[t.id] = t.name; });
    return map;
  }, [db]);

  // 유효한 메인카테고리 Set
  const validBudgetCategoryNames = useMemo(
    () => new Set(budgetCategories.map(c => c.name)),
    [budgetCategories]
  );

  // 유효한 서브카테고리 Set: "메인카테고리|서브카테고리" 조합으로 확인
  const validSubCategories = useMemo(() => {
    const all = getAllSubCategories(db);
    return new Set(all.map(s => `${s.budget_category}|${s.name}`));
  }, [db]);

  const allTransactions = useMemo(
    () => getTransactions(db, filters),
    [db, filters]
  );

  // 이슈 필터: 존재하지 않는 메인카테고리 또는 서브카테고리가 설정된 거래
  const transactions = useMemo(() => {
    if (!showIssueOnly) return allTransactions;
    return allTransactions.filter(tx => {
      const invalidMain = tx.budget_category && !validBudgetCategoryNames.has(tx.budget_category);
      const invalidSub = tx.sub_category && !validSubCategories.has(`${tx.budget_category}|${tx.sub_category}`);
      return invalidMain || invalidSub;
    });
  }, [allTransactions, showIssueOnly, validBudgetCategoryNames, validSubCategories]);

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

  // 펼침 상태를 sessionStorage에 저장해 탭 전환 후에도 유지
  const [expandedMonths, setExpandedMonths] = useState(() => {
    try {
      const saved = sessionStorage.getItem('fl_expanded_months');
      if (saved) return new Set(JSON.parse(saved));
    } catch (e) {}
    // 첫 방문 기본값: 현재 월 (또는 데이터가 없으면 가장 최신 월)
    const now = new Date();
    const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const available = getAvailableMonths(db);
    const hasCurrentMonth = available.includes(cur);
    const defaultMonth = hasCurrentMonth ? cur : (available.length > 0 ? available[0] : cur);
    return new Set([defaultMonth]);
  });

  // expandedMonths 변경 시 sessionStorage에 저장
  useEffect(() => {
    try {
      sessionStorage.setItem('fl_expanded_months', JSON.stringify([...expandedMonths]));
    } catch (e) {}
  }, [expandedMonths]);

  // 마운트 시 현재 월로 스크롤
  useEffect(() => {
    const timer = setTimeout(() => {
      if (currentMonthRef.current) {
        currentMonthRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  // 필터바 높이 측정 (스티키 월 헤더 offset용)
  useEffect(() => {
    const el = filterBarRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setFilterBarHeight(el.offsetHeight));
    observer.observe(el);
    setFilterBarHeight(el.offsetHeight);
    return () => observer.disconnect();
  }, []);

  // 월 필터 선택 시 해당 월 자동 펼침
  useEffect(() => {
    if (filters.month) {
      setExpandedMonths(prev => new Set([...prev, filters.month]));
    }
  }, [filters.month]);

  const toggleMonth = (month) => {
    const newExpanded = new Set(expandedMonths);
    if (newExpanded.has(month)) {
      newExpanded.delete(month);
    } else {
      newExpanded.add(month);
    }
    setExpandedMonths(newExpanded);
  };


  const setFilter = (key, value) => setFilters(prev => ({ ...prev, [key]: value }));

  const clearFilters = () => { setFilters({ month: '', payment_method: '', budget_category: '', search: '' }); setShowIssueOnly(false); };
  const hasFilters = Object.values(filters).some(v => v !== '') || showIssueOnly;

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
      <div className="filter-bar" ref={filterBarRef}>
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

              <div className="filter-btn-row">
                <button
                  className={`btn-filter-toggle ${showIssueOnly ? 'active' : ''}`}
                  onClick={() => setShowIssueOnly(v => !v)}
                  title="카테고리 이슈 거래만 보기"
                >
                  이슈
                </button>
                <button
                  className={`btn-filter-toggle ${showFilters ? 'active' : ''}`}
                  onClick={() => setShowFilters(v => !v)}
                >
                  필터 {hasFilters ? '●' : ''}
                </button>
                <button className="btn-filter-toggle" onClick={() => setDeleteMode(true)}>
                  삭제
                </button>
              </div>
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
                onClick={() => { if (editingGoalMonth !== month) toggleMonth(month); }}
                style={{ top: `${filterBarHeight}px` }}
              >
                <span className="month-toggle">
                  {expandedMonths.has(month) ? '▼' : '▶'}
                </span>
                <span className="month-label">
                  {month}
                  {month === currentMonth && ' (이번 달)'}
                </span>
                {(() => {
                  const txs = groupedTransactions[month];
                  const spend = txs.reduce((s, t) => s + t.amount, 0);
                  const discount = txs.reduce((s, t) => s + (t.discount_amount || 0), 0);
                  const net = spend - discount;
                  const goal = getGoalForMonth(month);
                  const diff = goal !== null ? goal - net : null;
                  const isSaved = diff !== null && diff >= 0;
                  return (
                    <div className="month-stats" onClick={e => e.stopPropagation()}>
                      <span className="month-stats-count">{txs.length}건</span>
                      <span className="month-stats-net">{formatAmount(net)}원</span>
                      {goal !== null && (
                        <span
                          className={`month-goal-diff ${isSaved ? 'month-goal-saved' : 'month-goal-over'}`}
                          title={`목표: ${formatAmount(goal)}원`}
                        >
                          {isSaved ? `+${formatAmount(diff)}↓` : `-${formatAmount(Math.abs(diff))}↑`}
                        </span>
                      )}
                      {editingGoalMonth === month ? (
                        <div className="month-goal-edit" onClick={e => e.stopPropagation()}>
                          <input
                            className="month-goal-input"
                            type="number"
                            value={editingGoalValue}
                            onChange={e => setEditingGoalValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                const amt = parseInt(editingGoalValue, 10);
                                if (!isNaN(amt) && amt > 0) {
                                  setMonthlyGoal(db, month, amt);
                                  onChanged && onChanged();
                                }
                                setEditingGoalMonth(null);
                              }
                              if (e.key === 'Escape') setEditingGoalMonth(null);
                            }}
                            autoFocus
                            placeholder="목표금액"
                          />
                          <button
                            className="month-goal-btn month-goal-btn-ok"
                            onClick={() => {
                              const amt = parseInt(editingGoalValue, 10);
                              if (!isNaN(amt) && amt > 0) {
                                setMonthlyGoal(db, month, amt);
                                onChanged && onChanged();
                              }
                              setEditingGoalMonth(null);
                            }}
                          >✓</button>
                          <button
                            className="month-goal-btn"
                            onClick={() => setEditingGoalMonth(null)}
                          >✕</button>
                        </div>
                      ) : (
                        <button
                          className="month-goal-set-btn"
                          title={goal !== null ? `목표: ${formatAmount(goal)}원 (수정)` : '이 달 목표 설정'}
                          onClick={e => {
                            e.stopPropagation();
                            setEditingGoalMonth(month);
                            setEditingGoalValue(goal !== null ? String(goal) : '');
                          }}
                        >
                          {goal !== null ? `목표 ${formatAmount(goal)}` : '목표 설정'}
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>
              {expandedMonths.has(month) && (
                <ul className="tx-list-items">
                  {groupedTransactions[month].map(tx => (
                    <li
                      key={tx.id}
                      className={`tx-item ${deleteMode && selectedForDelete.has(tx.id) ? 'tx-item-selected' : ''} ${
                        (tx.budget_category && !validBudgetCategoryNames.has(tx.budget_category)) ||
                        (tx.sub_category && !validSubCategories.has(`${tx.budget_category}|${tx.sub_category}`))
                          ? 'tx-item-issue' : ''
                      }`}
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
                        style={{ backgroundColor: categoryColor(tx.budget_category) }}
                      />
                      <div className="tx-body">
                        <div className="tx-row-single">
                          <span className="tx-date">{tx.date.substring(5).replace('-', '/')}</span>
                          <span
                            className="tx-badge"
                            style={{ backgroundColor: categoryColor(tx.budget_category) + '33', color: categoryColor(tx.budget_category) }}
                          >
                            {tx.budget_category}
                          </span>
                          {tx.is_recurring ? (
                            <span className="tx-recurring-badge">🔄 정기</span>
                          ) : null}
                          {tx.trip_id && tripMap[tx.trip_id] && (
                            <span className="tx-trip-badge">{tripMap[tx.trip_id]}</span>
                          )}
                          {tx.sub_category && (
                            <span
                              className="tx-sub"
                              style={!validSubCategories.has(`${tx.budget_category}|${tx.sub_category}`) ? { textDecoration: 'underline' } : {}}
                            >
                              {tx.sub_category}
                            </span>
                          )}
                          {tx.detail && <span className="tx-detail-inline">{tx.sub_category ? `· ${tx.detail}` : tx.detail}</span>}
                          <span className="tx-spacer" />
                          <span className="tx-payment">{tx.payment_method}</span>
                          {(() => {
                              let foreignEntries = [];
                              try {
                                const fa = tx.foreign_amounts ? JSON.parse(tx.foreign_amounts) : {};
                                foreignEntries = Object.entries(fa).filter(([, v]) => v > 0);
                              } catch {}
                              const hasForeign = foreignEntries.length > 0;
                              return (
                                <div className="tx-amount-col">
                                  <span className="tx-amount">
                                    {tx.payment_method === '현금' && tx.discount_amount > 0 && !hasForeign
                                      ? `${formatAmount(tx.amount - tx.discount_amount)}원`
                                      : `${formatAmount(tx.amount)}원`}
                                  </span>
                                  {!hasForeign && tx.discount_amount > 0 && tx.payment_method !== '현금' && (
                                    <span className="tx-discount-inline">-{formatAmount(tx.discount_amount)}원</span>
                                  )}
                                  {hasForeign && (
                                    <span className="tx-foreign-amount">
                                      ({foreignEntries.map(([cur, v]) => `${Number(v).toLocaleString()} ${cur}`).join(', ')})
                                    </span>
                                  )}
                                </div>
                              );
                            })()}
                        </div>
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
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      flexShrink: 0,
                      backgroundColor: categoryColor(selectedDetail.budget_category)
                    }}
                  />
                  <span style={{ fontSize: '15px' }}>{selectedDetail.budget_category}</span>
                  {selectedDetail.trip_id && tripMap[selectedDetail.trip_id] && (
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>/ {tripMap[selectedDetail.trip_id]}</span>
                  )}
                  {selectedDetail.sub_category && (
                    <span style={{
                      fontSize: '13px',
                      color: 'var(--text-muted)',
                      textDecoration: !validSubCategories.has(`${selectedDetail.budget_category}|${selectedDetail.sub_category}`) ? 'underline' : 'none'
                    }}>
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
                  {(() => {
                    try {
                      const fa = selectedDetail.foreign_amounts ? JSON.parse(selectedDetail.foreign_amounts) : {};
                      const entries = Object.entries(fa).filter(([, v]) => v > 0);
                      if (!entries.length) return null;
                      const text = entries.map(([cur, v]) => `${Number(v).toLocaleString()} ${cur}`).join(', ');
                      return <span style={{ fontSize: '14px', fontWeight: '400', color: 'var(--text-muted)', marginLeft: '6px' }}>({text})</span>;
                    } catch { return null; }
                  })()}
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
