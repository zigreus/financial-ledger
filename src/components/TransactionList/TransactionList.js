import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { getTransactions, getAllPaymentMethods, getAllBudgetCategories, getAvailableMonths, getAllMonthlyGoals, setMonthlyGoal, getSetting, getDailyTotals, getCalendarEvents, getSplitGroupTransactions, getMemberNames, getBalanceAlerts, MEMBER_NONE } from '../../services/dbManager';
import { buildValidationContext, hasIssue, hasSubCategoryIssue } from '../../services/txValidator';
import { formatAmount, evaluateFormula, isIncompleteFormula } from '../../services/formulaEvaluator';
import CalendarMini from './CalendarMini';
import BalanceAlertBanner from './BalanceAlertBanner';
import './TransactionList.css';
import ModalOverlay from '../common/ModalOverlay';
import AmountInput from '../common/AmountInput';
import { categoryColor, categoryColorAlpha } from '../common/categoryColor';
import { currentYearMonth, todayStr as todayDateStr } from '../../services/dateUtils';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';

const EMPTY_FILTERS = { month: '', payment_method: '', budget_category: '', member: '', search: '' };

function TransactionList({ db, dataVersion = 0, goTodayKey, onAdd, onEdit, onDelete, onChanged, onOpenImport, onOpenCardCheck, onOpenAccount }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [showIssueOnly, setShowIssueOnly] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedForDelete, setSelectedForDelete] = useState(new Set());
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [editingGoalMonth, setEditingGoalMonth] = useState(null);
  const [editingGoalValue, setEditingGoalValue] = useState('');
  const [goalError, setGoalError] = useState('');

  const saveMonthGoal = (month) => {
    const amt = evaluateFormula(editingGoalValue);
    // 잘못된 값("50만")·음수·입력 중인 수식은 조용히 버리고 닫지 않는다 — 이유를 보여 주고 고치게 둔다 (B-069)
    if (Number.isNaN(amt) || amt < 0) {
      setGoalError(isIncompleteFormula(editingGoalValue) ? '수식을 마저 입력하세요' : '0 이상의 금액을 입력하세요');
      return;
    }
    if (amt !== null && amt > 0) {
      setMonthlyGoal(db, month, amt);
      onChanged && onChanged();
    }
    setEditingGoalMonth(null);
  };

  const [calendarOpenMonths, setCalendarOpenMonths] = useState(new Set());
  const [focusedDate, setFocusedDate] = useState(null);
  const txDateRefs = useRef({}); // { 'YYYY-MM-DD': [domNode, ...] }

  const currentMonthRef = useRef(null);
  const filterBarRef = useRef(null);
  const [filterBarHeight, setFilterBarHeight] = useState(58);

  // 현재 월 (YYYY-MM 형식)
  const currentMonth = useMemo(() => currentYearMonth(), []);

  // sql.js DB는 같은 객체가 제자리에서 바뀌므로, db만으로는 변경을 알 수 없다.
  // App이 쓰기마다 올리는 dataVersion을 의존성에 넣어 다시 읽는다.
  // db 내용이 바뀔 때마다(dataVersion) 새 참조가 되는 스냅샷 — db를 읽는 memo·effect는 live에 의존한다 (B-014, I-010)
  const live = useDbSnapshot(db, dataVersion);
  const months = useMemo(() => getAvailableMonths(live.db), [live]);
  const monthlyGoalsMap = useMemo(() => getAllMonthlyGoals(live.db), [live]);
  const defaultGoal = useMemo(() => {
    const v = getSetting(live.db, 'default_monthly_goal', '');
    return v !== '' ? parseInt(v, 10) : null;
  }, [live]);
  const isMobile = useIsMobile();
  const showGoal = useMemo(
    () => getSetting(live.db, isMobile ? 'show_goal_display_mobile' : 'show_goal_display_pc', '1') !== '0',
    [live, isMobile]
  );
  const showCalendarBtn = useMemo(
    () => getSetting(live.db, isMobile ? 'show_calendar_btn_mobile' : 'show_calendar_btn_pc', '1') !== '0',
    [live, isMobile]
  );
  const calendarAmountUnit = useMemo(
    () => getSetting(live.db, 'calendar_mini_amount_unit', '만'),
    [live]
  );

  const getGoalForMonth = (yearMonth) => {
    if (monthlyGoalsMap[yearMonth] !== undefined) return monthlyGoalsMap[yearMonth];
    return defaultGoal;
  };

  // 결제수단 필터: 비숨김 먼저, 그 다음 숨김 (sort_order 기준)
  const paymentMethods = useMemo(() => {
    const all = getAllPaymentMethods(live.db);
    return [...all].sort((a, b) => {
      if (a.is_hidden !== b.is_hidden) return a.is_hidden ? 1 : -1;
      return a.sort_order - b.sort_order;
    });
  }, [live]);

  const budgetCategories = useMemo(() => getAllBudgetCategories(live.db), [live]);
  const members = useMemo(() => getMemberNames(live.db), [live]);
  // 계좌 잔액이 위험선 아래로 내려가는 날 (B-066)
  const balanceAlerts = useMemo(() => getBalanceAlerts(live.db), [live]);
  const eventMap = useMemo(() => {
    const map = {};
    getCalendarEvents(live.db).forEach(ev => { map[ev.id] = { name: ev.title, schedule: ev.date_from || '' }; });
    return map;
  }, [live]);


  // 이슈 감지용 공통 컨텍스트 (ImportModal과 동일한 로직)
  const validationCtx = useMemo(() => buildValidationContext(live.db), [live]);

  const allTransactions = useMemo(
    () => getTransactions(live.db, filters),
    [live, filters]
  );

  const hasAnyIssue = useMemo(
    () => allTransactions.some(tx => hasIssue(tx, validationCtx)),
    [allTransactions, validationCtx]
  );

  // 이슈 필터: 존재하지 않는 메인카테고리 또는 세부카테고리가 설정된 거래
  const transactions = useMemo(() => {
    if (!showIssueOnly) return allTransactions;
    return allTransactions.filter(tx => hasIssue(tx, validationCtx));
  }, [allTransactions, showIssueOnly, validationCtx]);

  // 월별로 그룹화된 거래내역 (월 내에서 날짜 내림차순 정렬)
  // firstOfDate: 각 날짜의 첫 번째 거래 id — 달력에서 날짜를 누르면 이 행으로 스크롤한다
  const { groupedTransactions, firstOfDate } = useMemo(() => {
    const groups = {};
    transactions.forEach(tx => {
      const month = tx.date.substring(0, 7);
      if (!groups[month]) groups[month] = [];
      groups[month].push(tx);
    });
    Object.values(groups).forEach(arr => arr.sort((a, b) => b.date.localeCompare(a.date)));
    const firsts = new Set();
    Object.values(groups).forEach(arr => arr.forEach((tx, i) => {
      if (i === 0 || arr[i - 1].date !== tx.date) firsts.add(tx.id);
    }));
    return { groupedTransactions: groups, firstOfDate: firsts };
  }, [transactions]);

  // 펼침 상태를 sessionStorage에 저장해 탭 전환 후에도 유지
  const [expandedMonths, setExpandedMonths] = useState(() => {
    try {
      const saved = sessionStorage.getItem('fl_expanded_months');
      if (saved) return new Set(JSON.parse(saved));
    } catch (e) {}
    // 첫 방문 기본값: 현재 월 (또는 데이터가 없으면 가장 최신 월)
    const cur = currentYearMonth();
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

  // 거래내역 탭 버튼 재클릭 시 오늘 날짜로 포커스
  useEffect(() => {
    if (goTodayKey === 0) return;
    const todayStr = todayDateStr();
    setFilters(f => ({ ...f, month: '' }));
    setFocusedDate(todayStr);
    setExpandedMonths(prev => prev.has(currentMonth) ? prev : new Set([...prev, currentMonth]));
    setTimeout(() => {
      const node = txDateRefs.current[todayStr];
      if (node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (currentMonthRef.current) {
        currentMonthRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 80);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goTodayKey]);

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

  const toggleCalendar = (month) => {
    setCalendarOpenMonths(prev => {
      const next = new Set(prev);
      if (next.has(month)) next.delete(month); else next.add(month);
      return next;
    });
  };

  // 날짜별 지출 합계 (열려 있는 달력 월만 계산)
  const dailyTotalsCache = useMemo(() => {
    const cache = {};
    calendarOpenMonths.forEach(month => {
      cache[month] = getDailyTotals(live.db, month);
    });
    return cache;
  }, [live, calendarOpenMonths]);

  const handleCalendarDateClick = useCallback((dateStr) => {
    setFocusedDate(dateStr);
    const month = dateStr.substring(0, 7);
    // 해당 월이 닫혀 있으면 열기
    setExpandedMonths(prev => {
      if (prev.has(month)) return prev;
      return new Set([...prev, month]);
    });
    // DOM에서 해당 날짜 첫 번째 거래 항목으로 스크롤
    setTimeout(() => {
      const node = txDateRefs.current[dateStr];
      if (node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 80);
  }, []);


  const setFilter = (key, value) => setFilters(prev => ({ ...prev, [key]: value }));

  const clearFilters = () => { setFilters(EMPTY_FILTERS); setShowIssueOnly(false); };
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

  // 분할 결제로 묶인 거래는 한쪽만 지우면 짝이 분할 표시를 단 채 고아로 남는다.
  // 지울 때는 묶음 전체를 함께 지운다. partners: 선택하지 않았지만 함께 지워지는 거래
  const withSplitPartners = (ids, txs) => {
    const all = new Set(ids);
    const partners = [];
    txs.forEach(tx => {
      if (!tx.split_group_id) return;
      getSplitGroupTransactions(db, tx.split_group_id).forEach(p => {
        if (!all.has(p.id)) { all.add(p.id); partners.push(p); }
      });
    });
    return { ids: [...all], partners };
  };

  const handleBulkDelete = () => {
    const selectedTxs = allTransactions.filter(tx => selectedForDelete.has(tx.id));
    const { ids, partners } = withSplitPartners(selectedForDelete, selectedTxs);
    const msg = partners.length
      ? `${selectedForDelete.size}개의 거래를 삭제하시겠습니까?\n분할 결제로 묶인 ${partners.length}건도 함께 삭제됩니다 (총 ${ids.length}건).`
      : `${selectedForDelete.size}개의 거래를 삭제하시겠습니까?`;
    if (!window.confirm(msg)) return;
    onDelete(ids);
    setSelectedForDelete(new Set());
    setDeleteMode(false);
  };

  const handleDetailDelete = (tx) => {
    const { ids, partners } = withSplitPartners([tx.id], [tx]);
    const msg = partners.length
      ? `이 거래는 분할 결제로 묶여 있습니다. 묶인 ${ids.length}건을 모두 삭제하시겠습니까?\n`
        + [tx, ...partners].map(t => `· ${t.payment_method} ${formatAmount(t.amount)}원`).join('\n')
      : '이 거래를 삭제하시겠습니까?';
    if (!window.confirm(msg)) return;
    onDelete(ids.length === 1 ? ids[0] : ids);
    setSelectedDetail(null);
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
                {hasAnyIssue && (
                  <button
                    className={`btn-filter-toggle ${showIssueOnly ? 'active' : ''}`}
                    onClick={() => setShowIssueOnly(v => !v)}
                    title="카테고리 이슈 거래만 보기"
                  >
                    이슈<span className="issue-dot" />
                  </button>
                )}
                <button
                  className={`btn-filter-toggle ${showFilters ? 'active' : ''}`}
                  onClick={() => setShowFilters(v => !v)}
                >
                  필터 {hasFilters ? '●' : ''}
                </button>
                <button className="btn-filter-toggle" onClick={() => setDeleteMode(true)}>
                  삭제
                </button>
                {onOpenCardCheck && (
                  <button className="btn-filter-toggle" onClick={onOpenCardCheck}>
                    카드 대조
                  </button>
                )}
                {onOpenImport && (
                  <button className="btn-filter-toggle" onClick={onOpenImport}>
                    불러오기
                  </button>
                )}
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
            {(members.length > 0 || filters.member) && (
              <select value={filters.member} onChange={e => setFilter('member', e.target.value)}>
                <option value="">전체 구성원</option>
                {members.map(m => <option key={m} value={m}>{m}</option>)}
                <option value={MEMBER_NONE}>(누가 없음)</option>
              </select>
            )}
            {hasFilters && (
              <button className="btn-clear-filter" onClick={clearFilters}>초기화</button>
            )}
          </div>
        )}
      </div>

      {!deleteMode && <BalanceAlertBanner alerts={balanceAlerts} onOpenAccount={onOpenAccount} />}

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
                  {month === currentMonth && ' 📍'}
                </span>
                {showCalendarBtn && (
                  <button
                    className={`cal-toggle-btn${calendarOpenMonths.has(month) ? ' active' : ''}`}
                    title="달력 보기"
                    onClick={e => { e.stopPropagation(); toggleCalendar(month); }}
                  >
                    📅
                  </button>
                )}
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
                      {showGoal && (editingGoalMonth === month ? (
                        <div className="month-goal-edit" onClick={e => e.stopPropagation()}>
                          <AmountInput
                            className="month-goal-input"
                            containerStyle={{ flex: '0 0 100px' }}
                            value={editingGoalValue}
                            onChange={v => { setEditingGoalValue(v); setGoalError(''); }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveMonthGoal(month);
                              if (e.key === 'Escape') setEditingGoalMonth(null);
                            }}
                            autoFocus
                            placeholder="목표금액"
                          />
                          <button
                            className="month-goal-btn month-goal-btn-ok"
                            onClick={() => saveMonthGoal(month)}
                          >✓</button>
                          <button
                            className="month-goal-btn"
                            onClick={() => setEditingGoalMonth(null)}
                          >✕</button>
                          {goalError && <span className="month-goal-error" role="alert">{goalError}</span>}
                        </div>
                      ) : (
                        <div className="month-goal-stack" onClick={e => e.stopPropagation()}>
                          {diff !== null && (
                            <span className={`month-goal-diff-text ${isSaved ? 'month-goal-saved' : 'month-goal-over'}`}>
                              {isSaved ? `+${formatAmount(diff)}` : `-${formatAmount(Math.abs(diff))}`}
                            </span>
                          )}
                          <button
                            className="month-goal-set-btn"
                            title={goal !== null ? `목표: ${formatAmount(goal)}원 (수정)` : '이 달 목표 설정'}
                            onClick={e => {
                              e.stopPropagation();
                              setEditingGoalMonth(month);
                              setEditingGoalValue(goal !== null ? String(goal) : '');
                              setGoalError('');
                            }}
                          >
                            {goal !== null ? `목표 ${formatAmount(goal)}` : '목표 설정'}
                          </button>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
              {expandedMonths.has(month) && calendarOpenMonths.has(month) && (
                <CalendarMini
                  month={month}
                  dailyTotals={dailyTotalsCache[month] || {}}
                  onDateClick={handleCalendarDateClick}
                  focusedDate={focusedDate}
                  amountUnit={calendarAmountUnit}
                />
              )}
              {expandedMonths.has(month) && (
                <ul className="tx-list-items">
                  {groupedTransactions[month].map(tx => (
                    <li
                      key={tx.id}
                      ref={el => {
                        // 각 날짜의 첫 번째 거래만 ref에 등록
                        if (el && firstOfDate.has(tx.id)) txDateRefs.current[tx.date] = el;
                      }}
                      className={`tx-item${deleteMode && selectedForDelete.has(tx.id) ? ' tx-item-selected' : ''}${hasIssue(tx, validationCtx) ? ' tx-item-issue' : ''}${focusedDate === tx.date ? ' tx-item-date-focused' : ''}`}
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
                            style={{ backgroundColor: categoryColorAlpha(tx.budget_category, 0.2), color: categoryColor(tx.budget_category) }}
                          >
                            {tx.budget_category}
                          </span>
                          {tx.is_recurring ? (
                            <span className="tx-recurring-badge">
                              🔄{tx.recurring_frequency === 'annual' ? '연' : '월'}
                            </span>
                          ) : null}
                          {tx.event_id && eventMap[tx.event_id] && (
                            <span className="tx-trip-badge">
                              {eventMap[tx.event_id].name}
                            </span>
                          )}
                          {tx.split_group_id ? (
                            <span className="tx-split-badge" title="분할 결제">🔗</span>
                          ) : null}
                          {tx.sub_category && (
                            <span
                              className="tx-sub"
                              style={hasSubCategoryIssue(tx, validationCtx) ? { textDecoration: 'underline' } : {}}
                            >
                              {tx.sub_category}
                            </span>
                          )}
                          {tx.detail && <span className="tx-detail-inline">{tx.sub_category ? `· ${tx.detail}` : tx.detail}</span>}
                          <span className="tx-spacer" />
                          {tx.member && <span className="tx-member">{tx.member}</span>}
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
        <ModalOverlay className="modal-overlay" panelClassName="modal-content modal-small" onDismiss={() => setSelectedDetail(null)}>
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
                  {selectedDetail.event_id && eventMap[selectedDetail.event_id] && (
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                      / {eventMap[selectedDetail.event_id].name}
                    </span>
                  )}
                  {selectedDetail.sub_category && (
                    <span style={{
                      fontSize: '13px',
                      color: 'var(--text-muted)',
                      textDecoration: hasSubCategoryIssue(selectedDetail, validationCtx) ? 'underline' : 'none'
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
              {selectedDetail.member && (
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>누가</div>
                  <div style={{ fontSize: '15px' }}>{selectedDetail.member}</div>
                </div>
              )}
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
              <button
                className="btn-danger"
                style={{ marginRight: 'auto', flex: 'none', padding: '8px 14px', fontSize: '13px' }}
                onClick={() => handleDetailDelete(selectedDetail)}
              >
                삭제
              </button>
              <button className="btn-secondary" onClick={() => setSelectedDetail(null)}>닫기</button>
              <button className="btn-primary" onClick={() => { onEdit(selectedDetail); setSelectedDetail(null); }}>
                수정
              </button>
            </div>
        </ModalOverlay>
      )}
    </div>
  );
}

export default TransactionList;
