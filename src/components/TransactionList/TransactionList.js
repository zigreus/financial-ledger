import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { getTransactions, getAllPaymentMethods, getAllBudgetCategories, getAvailableMonths, getAllMonthlyGoals, setMonthlyGoal, getSetting, getDailyTotals, getCalendarEvents, getSplitGroupTransactions, getMemberNames, isBlankLedger, getAllSubCategories } from '../../services/dbManager';
import { buildValidationContext, hasIssue, hasSubCategoryIssue } from '../../services/txValidator';
import { formatAmount, evaluateFormula, isIncompleteFormula } from '../../services/formulaEvaluator';
import CalendarMini from './CalendarMini';
import OpenNotices, { collectOpenNotices } from './OpenNotices';
import FirstEntryGuide from './FirstEntryGuide';
import FilterPanel from './FilterPanel';
import FilterSummary from './FilterSummary';
import {
  EMPTY_FILTERS, toQuery, isFiltered, describeFilters,
  loadSavedFilters, saveFilter, deleteSavedFilter, fitSavedFilters,
  loadSessionFilters, storeSessionFilters, excludesToday, withoutPeriod,
} from '../../services/txFilters';
import './TransactionList.css';
import ModalOverlay from '../common/ModalOverlay';
import AmountInput from '../common/AmountInput';
import { categoryColor, categoryColorAlpha } from '../common/categoryColor';
import { currentYearMonth, todayStr as todayDateStr } from '../../services/dateUtils';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';


/** 모두 펼치기에서 이보다 많은 거래를 한꺼번에 펼치면 먼저 묻는다 (U-11) */
const EXPAND_ALL_CONFIRM = 1000;

function TransactionList({ db, dataVersion = 0, goTodayKey, onAdd, onEdit, onCopy, onDelete, onChanged, onOpenImport, onOpenCardCheck, onOpenAccount, onOpenBudget, onOpenReport, onOpenOnboarding, onOpenSettings }) {
  // 탭을 옮겼다 와도(설정 › AI에 다녀오는 등) 걸던 조건을 이어 쓴다 — 그사이 없어진 이름은 뺀다
  const [filters, setFilters] = useState(() => fitSavedFilters(loadSessionFilters(), {
    paymentMethods: getAllPaymentMethods(db).map(m => m.name),
    categories: getAllBudgetCategories(db).map(c => c.name),
    members: getMemberNames(db),
  }).filters);
  useEffect(() => { storeSessionFilters(filters); }, [filters]);
  // 화면 필터 → 조회 조건 (잘못된 기간·금액은 errors에 이유, 그 조건은 걸지 않음) — I-021
  const { query, errors: filterErrors } = useMemo(() => toQuery(filters), [filters]);
  const queryRef = useRef(query); // 오늘로 가기(effect)가 그때의 조건을 읽는다
  queryRef.current = query;
  const [savedFilters, setSavedFilters] = useState(() => loadSavedFilters());
  const [savedNote, setSavedNote] = useState('');
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
  const noticesRef = useRef(null);
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
  // 새 가계부(카테고리·결제수단·거래가 하나도 없음)면 빈 화면에서 첫 실행 안내를 연다 (F-3)
  const blankLedger = useMemo(() => isBlankLedger(live.db), [live]);
  // 거래 입력 폼에서 고를 것이 없는 항목 — 결제수단, 카테고리, (보이는 카테고리에 딸린) 세부카테고리 (F-3)
  const missingForEntry = useMemo(() => {
    const visibleCats = budgetCategories.filter(c => !c.is_hidden).map(c => c.name);
    const subs = getAllSubCategories(live.db).filter(s => !s.is_hidden);
    return [
      !paymentMethods.some(m => !m.is_hidden) && '결제수단',
      !visibleCats.length && '카테고리',
      visibleCats.length > 0 && !subs.some(s => visibleCats.includes(s.budget_category)) && '세부카테고리',
    ].filter(Boolean);
  }, [live, paymentMethods, budgetCategories]);
  const members = useMemo(() => getMemberNames(live.db), [live]);
  // 확인할 것 — 잔액 위험(B-066)·카테고리 예산(I-025)·지난달 리포트(I-028)·곧 결제될 구독(I-036).
  // 날짜가 바뀌면(앱을 켜 둔 채 8일·다음 달이 되면) 다음 그리기에서 다시 판단한다
  const reportDay = todayDateStr();
  const notices = useMemo(() => collectOpenNotices(live.db, reportDay), [live, reportDay]);
  const eventMap = useMemo(() => {
    const map = {};
    getCalendarEvents(live.db).forEach(ev => { map[ev.id] = { name: ev.title, schedule: ev.date_from || '' }; });
    return map;
  }, [live]);


  // 이슈 감지용 공통 컨텍스트 (ImportModal과 동일한 로직)
  const validationCtx = useMemo(() => buildValidationContext(live.db), [live]);

  const allTransactions = useMemo(
    () => getTransactions(live.db, query),
    [live, query]
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

  // 마운트 시 현재 월로 스크롤 — 확인할 것(알림 카드)이 있으면 그 카드로. 이번 달로 내리면 맨 위의 카드가
  // 화면 밖으로 밀려 앱을 열어도 알림이 보이지 않는다 (B-093). 카드 바로 아래가 (접힌 앞으로의 달과) 이번 달이다
  useEffect(() => {
    const timer = setTimeout(() => {
      const target = noticesRef.current || currentMonthRef.current;
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  // 거래내역 탭 버튼 재클릭 시 오늘 날짜로 포커스
  // goTodayKey는 App에서 늘기만 하므로, 다른 탭에 다녀와 새로 그려질 때도 0이 아니다 — 기간을 푸는 것은
  // 이 화면이 열린 뒤 실제로 다시 눌렀을 때만 한다(탭을 옮겨도 이어 온 조건이 풀리지 않게)
  const goTodayAtMountRef = useRef(goTodayKey);
  useEffect(() => {
    if (goTodayKey === 0) return;
    const todayStr = todayDateStr();
    // 기간 조건이 오늘을 빼고 있으면 기간만 푼다 — 다른 조건(결제수단·검색어 등)은 그대로
    if (goTodayKey !== goTodayAtMountRef.current && excludesToday(queryRef.current, todayStr)) setFilters(withoutPeriod);
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

  // 기간 조건을 바꾸면 그 결과에 있는 달을 펼친다 — 지난달·작년·직접 입력을 골라도 하나씩 누르지 않게.
  // 기간을 바꿀 때만 펼치고, 그 뒤 사용자가 접은 달은 그대로 둔다(결과가 바뀔 때·탭에 돌아올 때 다시 펼치지 않음)
  const resultMonthsRef = useRef([]);
  resultMonthsRef.current = Object.keys(groupedTransactions);
  const periodKey = `${query.month || ''}|${query.dateFrom || ''}|${query.dateTo || ''}`;
  const periodKeyAtMountRef = useRef(periodKey);
  useEffect(() => {
    if (periodKey === '||' || periodKey === periodKeyAtMountRef.current) return;
    periodKeyAtMountRef.current = null; // 한 번 바꾼 뒤로는 처음 값으로 돌아와도 펼친다
    const monthsToOpen = query.month ? [query.month] : resultMonthsRef.current;
    setExpandedMonths(prev => new Set([...prev, ...monthsToOpen]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodKey]);

  const monthKeys = useMemo(() => Object.keys(groupedTransactions).sort().reverse(), [groupedTransactions]);
  const allMonthsOpen = monthKeys.every(m => expandedMonths.has(m));
  // 모두 접기는 지금 목록의 달만(필터로 가려진 달의 펼침은 그대로), 모두 펼치기는 거래가 아주 많으면 먼저 묻는다(한꺼번에 그리느라 느려질 수 있다)
  const toggleAllMonths = () => {
    if (allMonthsOpen) {
      setExpandedMonths(prev => new Set([...prev].filter(m => !monthKeys.includes(m))));
      return;
    }
    const closedCount = monthKeys.filter(m => !expandedMonths.has(m)).reduce((n, m) => n + groupedTransactions[m].length, 0);
    if (closedCount > EXPAND_ALL_CONFIRM && !window.confirm(`거래 ${formatAmount(closedCount)}건을 한꺼번에 펼칩니다. 기기에 따라 잠시 느려질 수 있어요. 펼칠까요?`)) return;
    setExpandedMonths(prev => new Set([...prev, ...monthKeys]));
  };

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

  const clearFilters = () => { setFilters(EMPTY_FILTERS); setShowIssueOnly(false); setSavedNote(''); };
  const hasFilters = isFiltered(filters) || showIssueOnly;
  const filterText = `${describeFilters(filters, query)}${showIssueOnly ? ' · 이슈 거래만' : ''}`;
  // 걸러진 거래의 순지출 합계 — 월 머리말·요약 카드와 같은 계산(금액 - 할인)
  const filteredTotal = transactions.reduce((s, t) => s + (Number(t.amount) || 0) - (Number(t.discount_amount) || 0), 0);

  // 저장한 필터 (이 기기) — 꺼낼 때 지금 가계부에 없는 결제수단·카테고리·구성원은 뺀다
  const applySavedFilter = (s) => {
    const { filters: fitted, dropped } = fitSavedFilters(s.filters, {
      paymentMethods: paymentMethods.map(m => m.name),
      categories: budgetCategories.map(c => c.name),
      members,
    });
    setFilters(fitted);
    setSavedNote(dropped.length ? `지금 가계부에 없는 ${dropped.map(n => `"${n}"`).join(', ')}은(는) 빼고 걸었어요` : '');
  };

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
      {/* 필터 패널을 열면 붙박이(sticky)를 풀어 패널이 목록을 덮지 않게 한다 — 스크롤하면 결과가 보인다 */}
      <div className={`filter-bar${showFilters && !deleteMode ? ' panel-open' : ''}`} ref={filterBarRef}>
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
          <FilterPanel
            filters={filters}
            onChange={(next) => { setFilters(next); setSavedNote(''); }}
            errors={filterErrors}
            months={months}
            paymentMethods={paymentMethods}
            budgetCategories={budgetCategories}
            members={members}
            saved={savedFilters}
            // 저장은 상태 갱신 함수 밖에서 계산한다 — saveFilter가 던지는 이유(이름 없음·개수 초과)를 패널이 받아 보이게.
            // 갱신 함수 안에서 던지면 렌더 중 오류가 되어 화면 전체가 내려간다
            onSave={(name) => setSavedFilters(saveFilter(savedFilters, name, filters))}
            onApplySaved={applySavedFilter}
            onDeleteSaved={(s) => setSavedFilters(deleteSavedFilter(savedFilters, s.name))}
            savedNote={savedNote}
            hasFilters={hasFilters}
            canSave={isFiltered(filters)}
            resultText={`${transactions.length}건 · ${formatAmount(filteredTotal)}원`}
            onShowResults={() => {
              setShowFilters(false);
              document.querySelector('.app-main')?.scrollTo(0, 0);
            }}
            onClear={clearFilters}
          />
        )}
      </div>

      {/* 걸러진 거래의 합계·구성·AI 요약 (I-021) */}
      {!deleteMode && hasFilters && transactions.length > 0 && (
        <FilterSummary
          transactions={transactions}
          filterText={filterText}
          filterKey={`${JSON.stringify(query)}|${showIssueOnly}`}
          onOpenSettings={onOpenSettings}
        />
      )}

      {/* 확인할 것 — 잔액 위험·예산·구독 결제 예정·지난달 리포트를 한 카드에 (I-036) */}
      {!deleteMode && (
        <OpenNotices
          anchorRef={noticesRef}
          scrollMargin={(showFilters ? 0 : filterBarHeight) + 8}
          balanceAlerts={notices.balanceAlerts}
          budgetAlerts={notices.budgetAlerts}
          payments={notices.payments}
          report={notices.report}
          onOpenAccount={onOpenAccount}
          onOpenBudget={() => onOpenBudget && onOpenBudget(reportDay.slice(0, 7))}
          onOpenSubscriptions={() => onOpenSettings && onOpenSettings('recurring')}
          onOpenReport={ym => onOpenReport && onOpenReport(ym)}
        />
      )}

      {/* 거래 목록 */}
      {transactions.length === 0 && !hasFilters ? (
        // 거래가 하나도 없다 — 새 가계부면 기본값 넣기, 아니면 첫 거래 입력 안내 (F-3)
        <FirstEntryGuide
          blank={blankLedger}
          missing={missingForEntry}
          onOpenOnboarding={onOpenOnboarding}
          onOpenImport={onOpenImport}
          onOpenSettings={onOpenSettings}
          onAdd={onAdd}
        />
      ) : transactions.length === 0 ? (
        // 조건에 맞는 거래가 없다 — "올해 ○○ 총 얼마"의 답이 0원인 경우도 여기
        <div className="empty-state">
          <p>조건에 맞는 거래가 없습니다 (0건 · 0원)</p>
          <p className="empty-state-sub">{filterText}</p>
          <button className="btn-secondary" onClick={clearFilters}>조건 모두 풀기</button>
        </div>
      ) : (
        <div className="tx-list">
          {/* 월 묶음 모두 접기·펼치기 (ROADMAP U-11) — 몇 년 치 목록에서 달을 하나씩 접지 않게 */}
          {monthKeys.length > 1 && (
            <div className="tx-month-all">
              <button
                type="button"
                className="tx-month-all-btn"
                onClick={toggleAllMonths}
              >
                {allMonthsOpen ? '모두 접기' : '모두 펼치기'}
              </button>
            </div>
          )}
          {monthKeys.map(month => (
            <div
              key={month}
              className="month-group"
              ref={month === currentMonth ? currentMonthRef : null}
            >
              <div
                className="month-header"
                onClick={() => { if (editingGoalMonth !== month) toggleMonth(month); }}
                style={{ top: `${showFilters && !deleteMode ? 0 : filterBarHeight}px` }}
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
                            words={false}
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
                <div style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-muted)', marginBottom: '4px' }}>날짜</div>
                <div style={{ fontSize: 'calc(16px * var(--fs))', fontWeight: '600' }}>{selectedDetail.date}</div>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-muted)', marginBottom: '4px' }}>카테고리</div>
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
                  <span style={{ fontSize: 'calc(15px * var(--fs))' }}>{selectedDetail.budget_category}</span>
                  {selectedDetail.event_id && eventMap[selectedDetail.event_id] && (
                    <span style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--text-muted)' }}>
                      / {eventMap[selectedDetail.event_id].name}
                    </span>
                  )}
                  {selectedDetail.sub_category && (
                    <span style={{
                      fontSize: 'calc(13px * var(--fs))',
                      color: 'var(--text-muted)',
                      textDecoration: hasSubCategoryIssue(selectedDetail, validationCtx) ? 'underline' : 'none'
                    }}>
                      / {selectedDetail.sub_category}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-muted)', marginBottom: '4px' }}>결제수단</div>
                <div style={{ fontSize: 'calc(15px * var(--fs))' }}>{selectedDetail.payment_method}</div>
              </div>
              {selectedDetail.member && (
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-muted)', marginBottom: '4px' }}>누가</div>
                  <div style={{ fontSize: 'calc(15px * var(--fs))' }}>{selectedDetail.member}</div>
                </div>
              )}
              {selectedDetail.detail && (
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-muted)', marginBottom: '4px' }}>세부내역</div>
                  <div style={{ fontSize: 'calc(15px * var(--fs))' }}>{selectedDetail.detail}</div>
                </div>
              )}
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-muted)', marginBottom: '4px' }}>금액</div>
                <div style={{ fontSize: 'calc(18px * var(--fs))', fontWeight: '700', color: 'var(--primary-text)' }}>
                  {formatAmount(selectedDetail.amount)}원
                  {(() => {
                    try {
                      const fa = selectedDetail.foreign_amounts ? JSON.parse(selectedDetail.foreign_amounts) : {};
                      const entries = Object.entries(fa).filter(([, v]) => v > 0);
                      if (!entries.length) return null;
                      const text = entries.map(([cur, v]) => `${Number(v).toLocaleString()} ${cur}`).join(', ');
                      return <span style={{ fontSize: 'calc(14px * var(--fs))', fontWeight: '400', color: 'var(--text-muted)', marginLeft: '6px' }}>({text})</span>;
                    } catch { return null; }
                  })()}
                </div>
              </div>
              {selectedDetail.discount_amount > 0 && (
                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: 'calc(12px * var(--fs))', color: 'var(--text-muted)', marginBottom: '4px' }}>할인</div>
                  <div style={{ fontSize: 'calc(15px * var(--fs))', color: 'var(--success)' }}>
                    -{formatAmount(selectedDetail.discount_amount)}원
                    {selectedDetail.discount_note && ` (${selectedDetail.discount_note})`}
                  </div>
                </div>
              )}
            </div>
            <div className="form-actions" style={{ padding: '0 20px 20px', flexWrap: 'wrap' }}>
              <button
                className="btn-danger"
                style={{ marginRight: 'auto', flex: 'none', padding: '8px 14px', fontSize: 'calc(13px * var(--fs))' }}
                onClick={() => handleDetailDelete(selectedDetail)}
              >
                삭제
              </button>
              <button className="btn-secondary" onClick={() => setSelectedDetail(null)}>닫기</button>
              {onCopy && (
                <button
                  className="btn-secondary"
                  style={{ padding: '8px 12px', fontSize: 'calc(13px * var(--fs))' }}
                  title="이 거래의 내용·분류·결제수단·금액으로 오늘 날짜의 새 거래를 입력합니다"
                  onClick={() => { onCopy(selectedDetail); setSelectedDetail(null); }}
                >
                  복사해 입력
                </button>
              )}
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
