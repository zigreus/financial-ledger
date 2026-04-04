import React, { useState, useMemo } from 'react';
import {
  getAllPaymentMethods, getAllBudgetCategories, getAllSubCategories,
  setMasterItemHidden, moveItemToPosition, moveTripToPosition,
  addPaymentMethod, addBudgetCategory, addSubCategory,
  cleanupHiddenPaymentMethods,
  getAllTrips, getTripCountries, addTrip, updateTripName, deleteTrip,
  addTripCountry, updateTripCountry, deleteTripCountry, moveTripCountryToPosition,
  getSubCategoryTxCount, deleteSubCategory,
  renameBudgetCategory, renameSubCategory,
  getDiscountRules, addDiscountRule, deleteDiscountRule,
  getBudgetCategories, getSubCategories,
  getSetting, setSetting, changeDefaultMonthlyGoal,
  getRecurringTransactions, addRecurringTransaction, updateRecurringTransaction,
  deleteRecurringTransaction, getRegistrationLog,
  evaluateDiscountRule,
} from '../../services/dbManager';
import './SettingsView.css';

const IconEyeOpen = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
);

const IconEyeOff = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

const IconGrip = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="5.5" cy="4" r="1.3"/>
    <circle cx="10.5" cy="4" r="1.3"/>
    <circle cx="5.5" cy="8" r="1.3"/>
    <circle cx="10.5" cy="8" r="1.3"/>
    <circle cx="5.5" cy="12" r="1.3"/>
    <circle cx="10.5" cy="12" r="1.3"/>
  </svg>
);

const IconChevronRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

const IconEdit = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);

const IconTrash = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
    <path d="M10 11v6M14 11v6"/>
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
  </svg>
);

const IconCheck = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

const IconClose = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

function SettingsView({ db, onChanged, activeSection, drilldownCategory, drilldownTrip, drilldownPayment, onSectionChange, onDrilldownCategoryChange, onDrilldownTripChange, onDrilldownPaymentChange }) {
  const [addingName, setAddingName] = useState('');
  const [error, setError] = useState('');
const [dragId, setDragId] = useState(null);
  const [dropIdx, setDropIdx] = useState(null);
  const [addingTripName, setAddingTripName] = useState('');
  const [addingCountry, setAddingCountry] = useState('');
  const [addingCurrency, setAddingCurrency] = useState('');
  const [editingTripId, setEditingTripId] = useState(null);
  const [editingTripName, setEditingTripName] = useState('');
  const [editingCountryId, setEditingCountryId] = useState(null);
  const [editingCountryName, setEditingCountryName] = useState('');
  const [editingCountryCurrency, setEditingCountryCurrency] = useState('');
  const [countryDragId, setCountryDragId] = useState(null);
  const [countryDropIdx, setCountryDropIdx] = useState(null);
  const [editingCategoryId, setEditingCategoryId] = useState(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  const [editingSubCategoryId, setEditingSubCategoryId] = useState(null);
  const [editingSubCategoryName, setEditingSubCategoryName] = useState('');
  const [addingRuleType, setAddingRuleType] = useState('percent');
  const [addingRuleCategory, setAddingRuleCategory] = useState('');
  const [addingRuleSub, setAddingRuleSub] = useState('');
  const [addingRuleValue, setAddingRuleValue] = useState('');
  const [addingRuleMinAmount, setAddingRuleMinAmount] = useState('');
  const [addingRuleDetailKeyword, setAddingRuleDetailKeyword] = useState('');
  const [addingRuleNote, setAddingRuleNote] = useState('');

  // 예산 섹션
  const [editingDefaultGoal, setEditingDefaultGoal] = useState(false);
  const [defaultGoalInput, setDefaultGoalInput] = useState('');
  const showGoalPc = useMemo(() => getSetting(db, 'show_goal_display_pc', '1') !== '0', [db]);
  const showGoalMobile = useMemo(() => getSetting(db, 'show_goal_display_mobile', '1') !== '0', [db]);

  // 정기지출 섹션
  const emptyRecurringForm = {
    payment_method: '', budget_category: '', sub_category: '',
    detail: '', amount: '', frequency: 'monthly',
    day_of_month: '1', month_of_year: '1', note: '',
    discount_amount: '', discount_note: '',
  };
  const [showRecurringForm, setShowRecurringForm] = useState(false);
  const [editingRecurringId, setEditingRecurringId] = useState(null);
  const [recurringForm, setRecurringForm] = useState(emptyRecurringForm);
  const skipAutoDiscountRef = React.useRef(false);

  const paymentMethods = useMemo(() => getAllPaymentMethods(db), [db]);
  const budgetCategories = useMemo(() => getAllBudgetCategories(db), [db]);
  const subCategories = useMemo(() => getAllSubCategories(db, drilldownCategory?.name || ''), [db, drilldownCategory]);
  const trips = useMemo(() => getAllTrips(db), [db]);
  const tripCountries = useMemo(() => drilldownTrip ? getTripCountries(db, drilldownTrip.id) : [], [db, drilldownTrip]);
  const discountRules = useMemo(() => drilldownPayment ? getDiscountRules(db, drilldownPayment.name) : [], [db, drilldownPayment]);
  const ruleCategories = useMemo(() => getBudgetCategories(db), [db]);
  const ruleSubCategories = useMemo(() => addingRuleCategory ? getSubCategories(db, addingRuleCategory) : [], [db, addingRuleCategory]);

  const defaultGoal = useMemo(() => getSetting(db, 'default_monthly_goal', ''), [db]);
  const recurringList = useMemo(() => getRecurringTransactions(db), [db]);
  const registrationLog = useMemo(() => getRegistrationLog(db), [db]);
  const recurringFormSubCategories = useMemo(
    () => recurringForm.budget_category ? getSubCategories(db, recurringForm.budget_category) : [],
    [db, recurringForm.budget_category]
  );

  // 정기지출 폼 - 자동 할인 계산 (결제수단/금액/카테고리/세부내역 변경 시)
  React.useEffect(() => {
    if (!showRecurringForm) return;
    if (skipAutoDiscountRef.current) return;
    const { payment_method, budget_category, sub_category, amount, detail } = recurringForm;
    if (!payment_method || payment_method === '현금') {
      setRecurringForm(f => ({ ...f, discount_amount: '' }));
      return;
    }
    const amt = parseInt(amount, 10);
    if (!amt || amt <= 0) {
      setRecurringForm(f => ({ ...f, discount_amount: '' }));
      return;
    }
    const rules = getDiscountRules(db, payment_method);
    const d = evaluateDiscountRule(rules, budget_category, sub_category, amt, detail);
    setRecurringForm(f => ({ ...f, discount_amount: d > 0 ? String(d) : '' }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRecurringForm, recurringForm.payment_method, recurringForm.amount, recurringForm.budget_category, recurringForm.sub_category, recurringForm.detail]);

  // 브라우저 뒤로가기로 드릴다운이 닫힐 때 내부 form state 초기화
  React.useEffect(() => {
    if (!drilldownCategory) {
      setAddingName('');
      setEditingCategoryId(null);
      setEditingCategoryName('');
      setEditingSubCategoryId(null);
      setEditingSubCategoryName('');
    }
  }, [drilldownCategory]);

  React.useEffect(() => {
    if (!drilldownTrip) {
      setAddingCountry('');
      setAddingCurrency('');
    }
  }, [drilldownTrip]);

  const handleToggleHidden = (table, id, currentHidden) => {
    try {
      setMasterItemHidden(db, table, id, !currentHidden);
      if (table === 'payment_methods' && !currentHidden) cleanupHiddenPaymentMethods(db);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleDrop = (table, items) => {
    if (dragId === null || dropIdx === null) { setDragId(null); setDropIdx(null); return; }
    const dragItem = items.find(i => i.id === dragId);
    if (!dragItem) { setDragId(null); setDropIdx(null); return; }
    const targetGroupIdx = items.slice(0, dropIdx).filter(i => i.is_hidden === dragItem.is_hidden && i.id !== dragId).length;
    try {
      moveItemToPosition(db, table, dragId, targetGroupIdx, drilldownCategory?.name);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
    setDragId(null);
    setDropIdx(null);
  };

  const handleTripDrop = (items) => {
    if (dragId === null || dropIdx === null) { setDragId(null); setDropIdx(null); return; }
    const dragItem = items.find(i => i.id === dragId);
    if (!dragItem) { setDragId(null); setDropIdx(null); return; }
    const targetGroupIdx = items.slice(0, dropIdx).filter(i => i.is_hidden === dragItem.is_hidden && i.id !== dragId).length;
    try {
      moveTripToPosition(db, dragId, targetGroupIdx);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
    setDragId(null);
    setDropIdx(null);
  };

  const handleDeleteDiscountRule = (id) => {
    try {
      deleteDiscountRule(db, id);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleAddDiscountRule = () => {
    const val = parseFloat(addingRuleValue);
    if (isNaN(val) || val <= 0) { setError('값을 올바르게 입력하세요.'); return; }
    const storedValue = addingRuleType === 'percent' ? val / 100 : val;
    const minAmt = parseInt(addingRuleMinAmount) || 0;
    try {
      addDiscountRule(db, {
        payment_method_name: drilldownPayment.name,
        budget_category: addingRuleCategory,
        sub_category: addingRuleSub,
        detail_keyword: addingRuleDetailKeyword,
        rule_type: addingRuleType,
        value: storedValue,
        min_amount: minAmt,
        note: addingRuleNote,
      });
      onChanged();
      setAddingRuleValue('');
      setAddingRuleMinAmount('');
      setAddingRuleDetailKeyword('');
      setAddingRuleNote('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleAddItem = () => {
    if (!addingName.trim()) { setError('항목 이름을 입력해주세요.'); return; }
    try {
      if (activeSection === 'payment') {
        addPaymentMethod(db, addingName);
      } else if (activeSection === 'category') {
        if (drilldownCategory) addSubCategory(db, drilldownCategory.name, addingName);
        else addBudgetCategory(db, addingName);
      }
      onChanged();
      setAddingName('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleKeyDown = (e) => { if (e.key === 'Enter') handleAddItem(); };

  const currentItems = useMemo(() => {
    const items = activeSection === 'payment' ? paymentMethods
      : activeSection === 'category' && drilldownCategory ? subCategories
      : activeSection === 'category' ? budgetCategories
      : [];
    return [...items].sort((a, b) => {
      if (a.is_hidden !== b.is_hidden) return a.is_hidden ? 1 : -1;
      return a.sort_order - b.sort_order;
    });
  }, [activeSection, drilldownCategory, paymentMethods, budgetCategories, subCategories]);

  const sortedTrips = useMemo(() => [...trips].sort((a, b) => {
    if (a.is_hidden !== b.is_hidden) return a.is_hidden ? 1 : -1;
    return a.sort_order - b.sort_order;
  }), [trips]);

  const switchSection = (sec) => {
    onSectionChange(sec); // App.js에서 드릴다운 초기화 + history push 처리
    setAddingName('');
    setAddingTripName('');
    setAddingCountry('');
    setAddingCurrency('');
    setEditingTripId(null);
    setEditingTripName('');
    setEditingCategoryId(null);
    setEditingCategoryName('');
    setEditingSubCategoryId(null);
    setEditingSubCategoryName('');
    setDragId(null);
    setDropIdx(null);
    setError('');
  };

  // ── 예산 핸들러 ──
  const handleSaveDefaultGoal = () => {
    const val = parseInt(defaultGoalInput, 10);
    if (isNaN(val) || val <= 0) { setError('올바른 금액을 입력하세요.'); return; }
    try {
      changeDefaultMonthlyGoal(db, val);
      onChanged();
      setEditingDefaultGoal(false);
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleClearDefaultGoal = () => {
    try {
      // 해제 전에도 기존 월을 현재 기본값으로 스냅샷
      const oldDefault = getSetting(db, 'default_monthly_goal', '');
      if (oldDefault !== '') {
        const oldVal = parseInt(oldDefault, 10);
        const monthsRes = db.exec(
          "SELECT DISTINCT strftime('%Y-%m', date) as month FROM transactions ORDER BY month"
        );
        const months = monthsRes.length ? monthsRes[0].values.map(r => r[0]) : [];
        months.forEach(ym => {
          db.run('INSERT OR IGNORE INTO monthly_goals (year_month, goal_amount) VALUES (?, ?)', [ym, oldVal]);
        });
      }
      setSetting(db, 'default_monthly_goal', '');
      onChanged();
      setEditingDefaultGoal(false);
      setError('');
    } catch (e) { setError(e.message); }
  };

  // ── 정기지출 핸들러 ──
  const openRecurringForm = (item = null) => {
    skipAutoDiscountRef.current = false;
    if (item) {
      setEditingRecurringId(item.id);
      // 기존 항목에 할인값이 있으면 수동 모드 유지
      if (item.discount_amount > 0) skipAutoDiscountRef.current = true;
      setRecurringForm({
        payment_method: item.payment_method,
        budget_category: item.budget_category,
        sub_category: item.sub_category || '',
        detail: item.detail || '',
        amount: String(item.amount),
        frequency: item.frequency,
        day_of_month: String(item.day_of_month),
        month_of_year: String(item.month_of_year || 1),
        note: item.note || '',
        discount_amount: item.discount_amount > 0 ? String(item.discount_amount) : '',
        discount_note: item.discount_note || '',
      });
    } else {
      setEditingRecurringId(null);
      setRecurringForm(emptyRecurringForm);
    }
    setShowRecurringForm(true);
    setError('');
  };

  const handleSaveRecurring = () => {
    if (!recurringForm.payment_method) { setError('결제수단을 선택하세요.'); return; }
    if (!recurringForm.budget_category) { setError('카테고리를 선택하세요.'); return; }
    const amount = parseInt(recurringForm.amount, 10);
    if (isNaN(amount) || amount <= 0) { setError('금액을 올바르게 입력하세요.'); return; }
    const dayOfMonth = parseInt(recurringForm.day_of_month, 10);
    if (isNaN(dayOfMonth) || dayOfMonth < 0 || dayOfMonth > 31) { setError('납부일은 0(말일)~31 사이로 입력하세요.'); return; }
    const discountAmount = recurringForm.discount_amount ? parseInt(recurringForm.discount_amount, 10) : 0;
    const data = {
      ...recurringForm,
      amount,
      day_of_month: dayOfMonth,
      month_of_year: recurringForm.frequency === 'annual' ? parseInt(recurringForm.month_of_year, 10) : null,
      discount_amount: isNaN(discountAmount) ? 0 : discountAmount,
    };
    try {
      if (editingRecurringId !== null) {
        updateRecurringTransaction(db, editingRecurringId, data);
      } else {
        addRecurringTransaction(db, data);
      }
      onChanged();
      setShowRecurringForm(false);
      setEditingRecurringId(null);
      setRecurringForm(emptyRecurringForm);
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleDeleteRecurring = (id) => {
    if (!window.confirm('정기지출을 삭제하시겠습니까?\n(자동등록된 거래내역은 삭제되지 않습니다)')) return;
    try {
      deleteRecurringTransaction(db, id);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleAddTrip = () => {
    if (!addingTripName.trim()) { setError('여행 이름을 입력하세요.'); return; }
    try {
      addTrip(db, addingTripName);
      onChanged();
      setAddingTripName('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleUpdateTripName = (id) => {
    if (!editingTripName.trim()) { setError('여행 이름을 입력하세요.'); return; }
    try {
      updateTripName(db, id, editingTripName);
      onChanged();
      setEditingTripId(null);
      setEditingTripName('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleDeleteTrip = (id, name) => {
    try {
      const res = db.exec('SELECT COUNT(*) FROM transactions WHERE trip_id = ?', [id]);
      const count = res[0]?.values[0][0] || 0;
      const msg = count > 0
        ? `"${name}"을(를) 삭제하면 연결된 거래 ${count}건의 여행 태그가 해제됩니다.\n정말 삭제하시겠습니까?`
        : `"${name}"을(를) 삭제하시겠습니까?`;
      if (!window.confirm(msg)) return;
      deleteTrip(db, id);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleAddTripCountry = () => {
    if (!drilldownTrip) return;
    if (!addingCurrency.trim()) { setError('화폐 단위를 입력하세요.'); return; }
    try {
      addTripCountry(db, drilldownTrip.id, addingCountry, addingCurrency);
      onChanged();
      setAddingCountry('');
      setAddingCurrency('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleDeleteSubCategory = (name) => {
    try {
      const count = getSubCategoryTxCount(db, drilldownCategory.name, name);
      const msg = count > 0
        ? `"${name}"을(를) 삭제하면 연결된 거래 ${count}건의 세부카테고리가 비워집니다.\n정말 삭제하시겠습니까?`
        : `"${name}"을(를) 삭제하시겠습니까?`;
      if (!window.confirm(msg)) return;
      deleteSubCategory(db, drilldownCategory.name, name);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleRenameBudgetCategory = (item) => {
    if (!editingCategoryName.trim()) { setError('이름을 입력하세요.'); return; }
    try {
      renameBudgetCategory(db, item.name, editingCategoryName);
      onChanged();
      setEditingCategoryId(null);
      setEditingCategoryName('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleRenameSubCategory = (item) => {
    if (!editingSubCategoryName.trim()) { setError('이름을 입력하세요.'); return; }
    try {
      renameSubCategory(db, drilldownCategory.name, item.name, editingSubCategoryName);
      onChanged();
      setEditingSubCategoryId(null);
      setEditingSubCategoryName('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleCountryDrop = (countries) => {
    if (countryDragId === null || countryDropIdx === null) { setCountryDragId(null); setCountryDropIdx(null); return; }
    const targetIdx = countries.slice(0, countryDropIdx).filter(c => c.id !== countryDragId).length;
    try {
      moveTripCountryToPosition(db, countryDragId, drilldownTrip.id, targetIdx);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
    setCountryDragId(null);
    setCountryDropIdx(null);
  };

  const handleUpdateTripCountry = (id) => {
    try {
      updateTripCountry(db, id, editingCountryName, editingCountryCurrency);
      onChanged();
      setEditingCountryId(null);
      setEditingCountryName('');
      setEditingCountryCurrency('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleDeleteTripCountry = (id) => {
    try {
      deleteTripCountry(db, id);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  // 드래그 가능한 아이템 리스트 렌더 (결제수단/카테고리 공용)
  const renderDraggableList = (items, table) => {
    const dragItem = dragId ? items.find(i => i.id === dragId) : null;
    const isCategoryList = activeSection === 'category' && !drilldownCategory;
    const isPaymentList = activeSection === 'payment' && !drilldownPayment;
    const isClickable = isCategoryList || isPaymentList;
    const handleDrilldown = (item) => {
      if (isCategoryList) { onDrilldownCategoryChange({ id: item.id, name: item.name }); setAddingName(''); }
      if (isPaymentList) { onDrilldownPaymentChange({ id: item.id, name: item.name }); setAddingRuleType('percent'); setAddingRuleCategory(''); setAddingRuleSub(''); setAddingRuleDetailKeyword(''); setAddingRuleValue(''); setAddingRuleMinAmount(''); setAddingRuleNote(''); }
      setError('');
    };
    return (
      <div
        onDrop={(e) => { e.preventDefault(); handleDrop(table, items); }}
        onDragEnd={() => { setDragId(null); setDropIdx(null); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropIdx(null); }}
      >
        {items.map((item, idx) => {
          const isDragging = dragId === item.id;
          const sameGroup = dragItem && item.is_hidden === dragItem.is_hidden;
          const showIndicator = dropIdx === idx && dragId !== null && sameGroup;
          const isEditingCat = isCategoryList && editingCategoryId === item.id;
          const isEditingSub = activeSection === 'category' && drilldownCategory && editingSubCategoryId === item.id;
          const isEditing = isEditingCat || isEditingSub;
          return (
            <React.Fragment key={item.id}>
              {showIndicator && <div className="drop-indicator" />}
              <div
                className={`settings-item ${item.is_hidden ? 'settings-item-hidden' : ''} ${isDragging ? 'settings-item-dragging' : ''} ${isClickable && !isEditing ? 'settings-item-clickable' : ''}`}
                draggable={!isEditing}
                onDragStart={(e) => { if (isEditing) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; setDragId(item.id); setDropIdx(null); }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (isEditing || !dragItem || item.is_hidden !== dragItem.is_hidden) { setDropIdx(null); return; }
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDropIdx(e.clientY < rect.top + rect.height / 2 ? idx : idx + 1);
                }}
                onClick={isClickable && !isEditing ? () => handleDrilldown(item) : undefined}
              >
                <div className="drag-handle" title="드래그해서 순서 변경" onClick={(e) => e.stopPropagation()}>
                  <IconGrip />
                </div>

                {isEditing ? (
                  <input
                    type="text"
                    value={isEditingCat ? editingCategoryName : editingSubCategoryName}
                    onChange={e => isEditingCat ? setEditingCategoryName(e.target.value) : setEditingSubCategoryName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') isEditingCat ? handleRenameBudgetCategory(item) : handleRenameSubCategory(item);
                      if (e.key === 'Escape') {
                        if (isEditingCat) { setEditingCategoryId(null); setEditingCategoryName(''); }
                        else { setEditingSubCategoryId(null); setEditingSubCategoryName(''); }
                      }
                    }}
                    autoFocus
                    className="settings-inline-input"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="settings-item-name">{item.name}</span>
                )}

                {isEditing ? (
                  <div style={{ display: 'flex', gap: '4px' }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn-icon btn-icon--success" onClick={() => isEditingCat ? handleRenameBudgetCategory(item) : handleRenameSubCategory(item)} title="저장">
                      <IconCheck />
                    </button>
                    <button className="btn-icon" onClick={() => {
                      if (isEditingCat) { setEditingCategoryId(null); setEditingCategoryName(''); }
                      else { setEditingSubCategoryId(null); setEditingSubCategoryName(''); }
                    }} title="취소">
                      <IconClose />
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      className={`btn-eye-toggle ${item.is_hidden ? 'btn-eye-toggle--hidden' : ''}`}
                      onClick={(e) => { e.stopPropagation(); handleToggleHidden(table, item.id, item.is_hidden); }}
                      title={item.is_hidden ? '표시' : '숨기기'}
                    >
                      {item.is_hidden ? <IconEyeOff /> : <IconEyeOpen />}
                    </button>

                    {/* 카테고리 / 세부카테고리 이름 수정 버튼 */}
                    {activeSection === 'category' && (isCategoryList || drilldownCategory) && (
                      <button
                        className="btn-icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isCategoryList) { setEditingCategoryId(item.id); setEditingCategoryName(item.name); setError(''); }
                          else { setEditingSubCategoryId(item.id); setEditingSubCategoryName(item.name); setError(''); }
                        }}
                        title="이름 수정"
                        style={{ marginLeft: '4px' }}
                      >
                        <IconEdit />
                      </button>
                    )}

                    {/* 드릴다운 버튼 (카테고리 / 결제수단 공용) */}
                    {isClickable && (
                      <button
                        className="btn-drilldown"
                        onClick={(e) => { e.stopPropagation(); handleDrilldown(item); }}
                        title={isCategoryList ? '세부카테고리 설정' : '할인규칙 설정'}
                      >
                        <IconChevronRight />
                      </button>
                    )}

                    {/* 세부카테고리 삭제 */}
                    {activeSection === 'category' && drilldownCategory && (
                      <button
                        className="btn-icon btn-icon--danger"
                        onClick={(e) => { e.stopPropagation(); handleDeleteSubCategory(item.name); }}
                        title="삭제"
                        style={{ marginLeft: '4px' }}
                      >
                        <IconTrash />
                      </button>
                    )}
                  </>
                )}
              </div>
            </React.Fragment>
          );
        })}
        {dropIdx === items.length && dragId !== null && dragItem && (
          <div className="drop-indicator" />
        )}
      </div>
    );
  };

  // 여행 목록 (드래그 가능)
  const renderTripList = () => {
    const dragItem = dragId ? sortedTrips.find(i => i.id === dragId) : null;
    return (
      <div
        onDrop={(e) => { e.preventDefault(); handleTripDrop(sortedTrips); }}
        onDragEnd={() => { setDragId(null); setDropIdx(null); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropIdx(null); }}
      >
        {sortedTrips.map((trip, idx) => {
          const isDragging = dragId === trip.id;
          const sameGroup = dragItem && trip.is_hidden === dragItem.is_hidden;
          const showIndicator = dropIdx === idx && dragId !== null && sameGroup;
          const isEditing = editingTripId === trip.id;
          return (
            <React.Fragment key={trip.id}>
              {showIndicator && <div className="drop-indicator" />}
              <div
                className={`settings-item ${isDragging ? 'settings-item-dragging' : ''} ${!isEditing ? 'settings-item-clickable' : ''}`}
                draggable={!isEditing}
                onDragStart={(e) => { if (isEditing) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; setDragId(trip.id); setDropIdx(null); }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (isEditing || !dragItem || trip.is_hidden !== dragItem.is_hidden) { setDropIdx(null); return; }
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDropIdx(e.clientY < rect.top + rect.height / 2 ? idx : idx + 1);
                }}
                onClick={!isEditing ? () => { onDrilldownTripChange({ id: trip.id, name: trip.name }); setAddingCountry(''); setAddingCurrency(''); setError(''); } : undefined}
              >
                <div className="drag-handle" title="드래그해서 순서 변경" onClick={(e) => e.stopPropagation()}>
                  <IconGrip />
                </div>

                {isEditing ? (
                  <input
                    type="text"
                    value={editingTripName}
                    onChange={e => setEditingTripName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleUpdateTripName(trip.id);
                      if (e.key === 'Escape') { setEditingTripId(null); setEditingTripName(''); }
                    }}
                    autoFocus
                    className="settings-inline-input"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="settings-item-name">{trip.name}</span>
                )}

                {isEditing ? (
                  <div style={{ display: 'flex', gap: '4px' }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn-icon btn-icon--success" onClick={() => handleUpdateTripName(trip.id)} title="저장">
                      <IconCheck />
                    </button>
                    <button className="btn-icon" onClick={() => { setEditingTripId(null); setEditingTripName(''); }} title="취소">
                      <IconClose />
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '4px' }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn-icon" onClick={() => { setEditingTripId(trip.id); setEditingTripName(trip.name); setError(''); }} title="이름 수정">
                      <IconEdit />
                    </button>
                    <button className="btn-icon btn-icon--danger" onClick={() => handleDeleteTrip(trip.id, trip.name)} title="삭제">
                      <IconTrash />
                    </button>
                    <button className="btn-drilldown" onClick={() => { onDrilldownTripChange({ id: trip.id, name: trip.name }); setAddingCountry(''); setAddingCurrency(''); setError(''); }} title="나라/화폐 관리">
                      <IconChevronRight />
                    </button>
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
        {dropIdx === sortedTrips.length && dragId !== null && dragItem && (
          <div className="drop-indicator" />
        )}
      </div>
    );
  };

  const drilldownBackLabel = drilldownCategory?.name || drilldownTrip?.name || drilldownPayment?.name;
  const showDrilldownBack = (activeSection === 'category' && drilldownCategory) || (activeSection === 'travel' && drilldownTrip) || (activeSection === 'payment' && drilldownPayment);

  return (
    <div className="settings-page">
      {/* 섹션 탭 */}
      <div className="settings-tabs">
        <button className={activeSection === 'payment' ? 'tab active' : 'tab'} onClick={() => switchSection('payment')}>결제수단</button>
        <button className={activeSection === 'category' ? 'tab active' : 'tab'} onClick={() => switchSection('category')}>카테고리</button>
        <button className={activeSection === 'travel' ? 'tab active' : 'tab'} onClick={() => switchSection('travel')}>여행</button>
        <button className={activeSection === 'budget' ? 'tab active' : 'tab'} onClick={() => switchSection('budget')}>예산</button>
        <button className={activeSection === 'recurring' ? 'tab active' : 'tab'} onClick={() => { switchSection('recurring'); setShowRecurringForm(false); }}>정기지출</button>
      </div>

      {/* 드릴다운 뒤로가기 */}
      {showDrilldownBack && (
        <div style={{ padding: '0 0 8px' }}>
          <button
            className="drilldown-back-btn"
            onClick={() => {
              window.history.back();
              setError('');
            }}
          >
            ← {drilldownBackLabel}
          </button>
        </div>
      )}

      <div className="settings-section">
        {error && <div className="error-msg" style={{ marginBottom: '12px' }}>{error}</div>}

        {/* ── 예산 탭 ── */}
        {activeSection === 'budget' && (
          <div>
            <div style={{ marginBottom: '20px', paddingBottom: '16px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>목표금액 표시</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: '13px' }}>PC</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>화면 너비 640px 초과</div>
                  </div>
                  <button
                    className={`goal-display-toggle${showGoalPc ? ' goal-display-toggle--on' : ''}`}
                    onClick={() => { setSetting(db, 'show_goal_display_pc', showGoalPc ? '0' : '1'); onChanged(); }}
                    title={showGoalPc ? 'PC 목표금액 표시 끄기' : 'PC 목표금액 표시 켜기'}
                  >
                    <span className="goal-display-toggle-knob" />
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: '13px' }}>모바일</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>화면 너비 640px 이하</div>
                  </div>
                  <button
                    className={`goal-display-toggle${showGoalMobile ? ' goal-display-toggle--on' : ''}`}
                    onClick={() => { setSetting(db, 'show_goal_display_mobile', showGoalMobile ? '0' : '1'); onChanged(); }}
                    title={showGoalMobile ? '모바일 목표금액 표시 끄기' : '모바일 목표금액 표시 켜기'}
                  >
                    <span className="goal-display-toggle-knob" />
                  </button>
                </div>
              </div>
            </div>
            <div style={{ marginBottom: '20px', opacity: (showGoalPc || showGoalMobile) ? 1 : 0.4, pointerEvents: (showGoalPc || showGoalMobile) ? 'auto' : 'none', transition: 'opacity .2s' }}>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                상시 월 목표금액 — 개별 월에서 덮어쓰기 가능합니다.
              </div>
              {editingDefaultGoal ? (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="number"
                    className="settings-inline-input"
                    style={{ flex: 1 }}
                    value={defaultGoalInput}
                    onChange={e => setDefaultGoalInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveDefaultGoal(); if (e.key === 'Escape') setEditingDefaultGoal(false); }}
                    autoFocus
                    placeholder="예: 1500000"
                  />
                  <button className="btn-icon btn-icon--success" onClick={handleSaveDefaultGoal} title="저장"><IconCheck /></button>
                  <button className="btn-icon" onClick={() => setEditingDefaultGoal(false)} title="취소"><IconClose /></button>
                  {defaultGoal !== '' && (
                    <button className="btn-icon btn-icon--danger" onClick={handleClearDefaultGoal} title="목표 해제"><IconTrash /></button>
                  )}
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ fontSize: '20px', fontWeight: '700', color: 'var(--primary)' }}>
                    {defaultGoal !== '' ? `${Number(defaultGoal).toLocaleString()}원` : '미설정'}
                  </span>
                  <button
                    className="btn-icon"
                    onClick={() => { setDefaultGoalInput(defaultGoal); setEditingDefaultGoal(true); }}
                    title="수정"
                  >
                    <IconEdit />
                  </button>
                </div>
              )}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
              개별 월 목표금액은 거래내역 화면의 월 헤더에서 설정할 수 있습니다.
            </div>
          </div>
        )}

        {/* ── 정기지출 탭 ── */}
        {activeSection === 'recurring' && (
          <div>
            {!showRecurringForm ? (
              <>
                <button className="btn-primary" style={{ width: '100%', marginBottom: '16px' }} onClick={() => openRecurringForm()}>
                  + 정기지출 추가
                </button>

                {recurringList.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px', fontSize: '13px' }}>
                    등록된 정기지출이 없습니다.
                  </div>
                ) : (
                  <>
                    {['monthly', 'annual'].map(freq => {
                      const items = recurringList.filter(r => r.frequency === freq);
                      if (items.length === 0) return null;
                      return (
                        <div key={freq} style={{ marginBottom: '16px' }}>
                          <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            {freq === 'monthly' ? '📋 월별 반복' : '📅 연간 반복'}
                          </div>
                          {items.map(r => {
                            const logMonths = registrationLog[r.id];
                            const lastRegistered = logMonths ? [...logMonths].sort().reverse()[0] : null;
                            const dayLabel = r.day_of_month === 0 ? '말일' : `${r.day_of_month}일`;
                            const scheduleLabel = freq === 'annual'
                              ? `${r.month_of_year}월 ${dayLabel}`
                              : dayLabel;
                            return (
                              <div key={r.id} className="settings-item">
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                                    <span style={{ fontWeight: '600', fontSize: '14px', flexShrink: 0, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.detail || r.sub_category || r.budget_category}</span>
                                    <span style={{ fontSize: '12px', color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.budget_category}{r.sub_category ? ` / ${r.sub_category}` : ''}</span>
                                    {lastRegistered && <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>최근 {lastRegistered}</span>}
                                  </div>
                                  <div style={{ fontSize: '13px', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                                    <span style={{ color: 'var(--primary)', fontWeight: '600', flexShrink: 0 }}>{r.amount.toLocaleString()}원</span>
                                    {r.discount_amount > 0 && (
                                      <span style={{ fontSize: '12px', color: '#16A34A', flexShrink: 0 }}>-{r.discount_amount.toLocaleString()}원 할인</span>
                                    )}
                                    <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.payment_method} · {scheduleLabel}</span>
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                                  <button className="btn-icon" onClick={() => openRecurringForm(r)} title="수정"><IconEdit /></button>
                                  <button className="btn-icon btn-icon--danger" onClick={() => handleDeleteRecurring(r.id)} title="삭제"><IconTrash /></button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            ) : (
              /* 추가/편집 폼 */
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ fontWeight: '600', fontSize: '15px', marginBottom: '4px' }}>
                  {editingRecurringId !== null ? '정기지출 수정' : '정기지출 추가'}
                </div>

                <div className="rule-form-row">
                  <label className="rule-form-label">결제수단</label>
                  <select
                    className="rule-form-select"
                    value={recurringForm.payment_method}
                    onChange={e => setRecurringForm(f => ({ ...f, payment_method: e.target.value }))}
                  >
                    <option value="">선택</option>
                    {paymentMethods.filter(p => !p.is_hidden).map(p => (
                      <option key={p.id} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                </div>

                <div className="rule-form-row">
                  <label className="rule-form-label">카테고리</label>
                  <select
                    className="rule-form-select"
                    value={recurringForm.budget_category}
                    onChange={e => setRecurringForm(f => ({ ...f, budget_category: e.target.value, sub_category: '' }))}
                  >
                    <option value="">선택</option>
                    {ruleCategories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>

                {recurringForm.budget_category && recurringFormSubCategories.length > 0 && (
                  <div className="rule-form-row">
                    <label className="rule-form-label">세부카테고리</label>
                    <select
                      className="rule-form-select"
                      value={recurringForm.sub_category}
                      onChange={e => setRecurringForm(f => ({ ...f, sub_category: e.target.value }))}
                    >
                      <option value="">없음</option>
                      {recurringFormSubCategories.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                )}

                <div className="rule-form-row">
                  <label className="rule-form-label">내용</label>
                  <input
                    className="rule-form-input"
                    type="text"
                    value={recurringForm.detail}
                    onChange={e => setRecurringForm(f => ({ ...f, detail: e.target.value }))}
                    placeholder="예: 넷플릭스 월정액"
                  />
                </div>

                <div className="rule-form-row">
                  <label className="rule-form-label">금액 (원)</label>
                  <input
                    className="rule-form-input"
                    type="number"
                    value={recurringForm.amount}
                    onChange={e => {
                      skipAutoDiscountRef.current = false;
                      setRecurringForm(f => ({ ...f, amount: e.target.value }));
                    }}
                    placeholder="예: 13500"
                  />
                </div>

                <div className="rule-form-row">
                  <label className="rule-form-label">할인 (원)</label>
                  <div style={{ display: 'flex', gap: '6px', flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
                    <input
                      className="rule-form-input"
                      type="number"
                      style={{ flex: '1 1 80px' }}
                      value={recurringForm.discount_amount}
                      onChange={e => {
                        skipAutoDiscountRef.current = true;
                        setRecurringForm(f => ({ ...f, discount_amount: e.target.value }));
                      }}
                      placeholder="자동계산 (0=없음)"
                    />
                    <input
                      className="rule-form-input"
                      type="text"
                      style={{ flex: '1 1 80px' }}
                      value={recurringForm.discount_note}
                      onChange={e => setRecurringForm(f => ({ ...f, discount_note: e.target.value }))}
                      placeholder="할인 메모 (선택)"
                    />
                    {skipAutoDiscountRef.current && (
                      <button
                        className="month-goal-btn"
                        title="자동계산으로 되돌리기"
                        onClick={() => {
                          skipAutoDiscountRef.current = false;
                          setRecurringForm(f => ({ ...f, discount_amount: '', discount_note: '' }));
                        }}
                      >↺</button>
                    )}
                  </div>
                </div>

                <div className="rule-form-row">
                  <label className="rule-form-label">반복주기</label>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '14px' }}>
                      <input type="radio" name="freq" value="monthly" checked={recurringForm.frequency === 'monthly'} onChange={() => setRecurringForm(f => ({ ...f, frequency: 'monthly' }))} />
                      월별
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '14px' }}>
                      <input type="radio" name="freq" value="annual" checked={recurringForm.frequency === 'annual'} onChange={() => setRecurringForm(f => ({ ...f, frequency: 'annual' }))} />
                      연간
                    </label>
                  </div>
                </div>

                {recurringForm.frequency === 'annual' && (
                  <div className="rule-form-row">
                    <label className="rule-form-label">납부 월</label>
                    <select
                      className="rule-form-select"
                      value={recurringForm.month_of_year}
                      onChange={e => setRecurringForm(f => ({ ...f, month_of_year: e.target.value }))}
                    >
                      {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                        <option key={m} value={m}>{m}월</option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="rule-form-row">
                  <label className="rule-form-label">납부일</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      className="rule-form-input"
                      type="number"
                      min="0"
                      max="31"
                      value={recurringForm.day_of_month}
                      onChange={e => setRecurringForm(f => ({ ...f, day_of_month: e.target.value }))}
                      placeholder="1~31, 0=말일"
                      style={{ width: '90px' }}
                    />
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>일 (0 = 말일)</span>
                  </div>
                </div>

                <div className="rule-form-row">
                  <label className="rule-form-label">메모 (선택)</label>
                  <input
                    className="rule-form-input"
                    type="text"
                    value={recurringForm.note}
                    onChange={e => setRecurringForm(f => ({ ...f, note: e.target.value }))}
                    placeholder="예: 가족 구독"
                  />
                </div>

                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button className="btn-primary" style={{ flex: 1 }} onClick={handleSaveRecurring}>
                    {editingRecurringId !== null ? '수정 저장' : '추가'}
                  </button>
                  <button
                    className="btn-secondary"
                    style={{ flex: 1 }}
                    onClick={() => { setShowRecurringForm(false); setEditingRecurringId(null); setError(''); }}
                  >
                    취소
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── 여행 탭 ── */}
        {activeSection === 'travel' ? (
          drilldownTrip ? (
            /* 나라/화폐 목록 */
            <>
              <div className="trip-country-info">
                국내 여행의 경우, 나라를 입력하지 않아도 됩니다.
              </div>
              {tripCountries.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '16px', fontSize: '13px' }}>등록된 나라가 없습니다.</div>
              ) : (
                <div
                  onDrop={(e) => { e.preventDefault(); handleCountryDrop(tripCountries); }}
                  onDragEnd={() => { setCountryDragId(null); setCountryDropIdx(null); }}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setCountryDropIdx(null); }}
                >
                  {tripCountries.map((c, idx) => {
                    const isEditingThis = editingCountryId === c.id;
                    const isDragging = countryDragId === c.id;
                    const showIndicator = countryDropIdx === idx && countryDragId !== null;
                    return (
                      <React.Fragment key={c.id}>
                        {showIndicator && <div className="drop-indicator" />}
                        <div
                          className={`settings-item ${isDragging ? 'settings-item-dragging' : ''}`}
                          draggable={!isEditingThis}
                          onDragStart={(e) => { if (isEditingThis) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; setCountryDragId(c.id); setCountryDropIdx(null); }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            if (isEditingThis) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            setCountryDropIdx(e.clientY < rect.top + rect.height / 2 ? idx : idx + 1);
                          }}
                        >
                          {isEditingThis ? (
                            <>
                              <input
                                type="text"
                                value={editingCountryName}
                                onChange={e => setEditingCountryName(e.target.value)}
                                placeholder="나라 (예: 일본)"
                                className="settings-inline-input"
                                style={{ flex: 2 }}
                              />
                              <input
                                type="text"
                                value={editingCountryCurrency}
                                onChange={e => setEditingCountryCurrency(e.target.value.toUpperCase())}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') handleUpdateTripCountry(c.id);
                                  if (e.key === 'Escape') { setEditingCountryId(null); }
                                }}
                                placeholder="화폐 (예: JPY)"
                                className="settings-inline-input"
                                style={{ flex: 1 }}
                                autoFocus
                              />
                              <button className="btn-icon btn-icon--success" onClick={() => handleUpdateTripCountry(c.id)} title="저장">
                                <IconCheck />
                              </button>
                              <button className="btn-icon" onClick={() => setEditingCountryId(null)} title="취소" style={{ marginLeft: '4px' }}>
                                <IconClose />
                              </button>
                            </>
                          ) : (
                            <>
                              <div className="drag-handle" title="드래그해서 순서 변경">
                                <IconGrip />
                              </div>
                              <span className="settings-item-name">{c.country || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>국내</span>}</span>
                              <span style={{ fontSize: '13px', color: 'var(--text-muted)', marginRight: '8px' }}>{c.currency}</span>
                              <button className="btn-icon" onClick={() => { setEditingCountryId(c.id); setEditingCountryName(c.country); setEditingCountryCurrency(c.currency); setError(''); }} title="수정">
                                <IconEdit />
                              </button>
                              <button className="btn-icon btn-icon--danger" onClick={() => handleDeleteTripCountry(c.id)} title="삭제" style={{ marginLeft: '4px' }}>
                                <IconTrash />
                              </button>
                            </>
                          )}
                        </div>
                      </React.Fragment>
                    );
                  })}
                  {countryDropIdx === tripCountries.length && countryDragId !== null && (
                    <div className="drop-indicator" />
                  )}
                </div>
              )}
              <div className="settings-add-row" style={{ marginTop: '8px' }}>
                <input
                  type="text"
                  value={addingCountry}
                  onChange={e => setAddingCountry(e.target.value)}
                  placeholder="나라 (예: 일본, 비워두면 국내)"
                  style={{ flex: 2 }}
                />
                <input
                  type="text"
                  value={addingCurrency}
                  onChange={e => setAddingCurrency(e.target.value.toUpperCase())}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddTripCountry(); }}
                  placeholder="화폐 (예: JPY)"
                  style={{ flex: 1 }}
                />
                <button className="btn-primary" onClick={handleAddTripCountry}>+ 추가</button>
              </div>
            </>
          ) : (
            /* 여행 목록 */
            <>
              <div className="settings-add-row" style={{ marginBottom: '4px' }}>
                <input
                  type="text"
                  value={addingTripName}
                  onChange={e => setAddingTripName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddTrip(); }}
                  placeholder="새 여행 이름 (예: 일본 오사카 2026)"
                />
                <button className="btn-primary" onClick={handleAddTrip}>+ 추가</button>
              </div>
              {sortedTrips.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '16px' }}>등록된 여행이 없습니다.</div>
              ) : renderTripList()}
            </>
          )

/* ── 결제수단 / 카테고리 탭 ── */
        ) : activeSection === 'payment' && drilldownPayment ? (
          /* ── 결제수단 할인규칙 드릴다운 ── */
          <>
            <div className="rule-section-info">
              규칙 우선순위: 카테고리+세부카테고리 &gt; 카테고리 &gt; 기본(전체)
            </div>

            {discountRules.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '16px', fontSize: '13px' }}>등록된 할인규칙이 없습니다.</div>
            ) : (
              discountRules.map(rule => {
                const scopeParts = [];
                if (rule.budget_category) scopeParts.push(rule.budget_category);
                if (rule.sub_category) scopeParts.push(rule.sub_category);
                if (rule.detail_keyword) scopeParts.push(`"${rule.detail_keyword}"`);
                const scopeLabel = scopeParts.length > 0 ? scopeParts.join(' > ') : '기본 (전체)';
                let valueLabel;
                if (rule.rule_type === 'percent') valueLabel = `${Math.round(rule.value * 1000) / 10}%`;
                else if (rule.rule_type === 'fixed') valueLabel = `${rule.value.toLocaleString()}원 고정`;
                else valueLabel = `${rule.value.toLocaleString()}원 단위 잔액${rule.min_amount > 0 ? ` (최소 ${rule.min_amount.toLocaleString()}원)` : ''}`;
                return (
                  <div key={rule.id} className="settings-item">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span className="rule-scope">{scopeLabel}</span>
                      <span className="rule-value-badge">{valueLabel}</span>
                      {rule.note ? <span className="rule-note">{rule.note}</span> : null}
                    </div>
                    <button
                      className="btn-icon btn-icon--danger"
                      onClick={() => { if (window.confirm(`"${scopeLabel}: ${valueLabel}" 규칙을 삭제하시겠습니까?`)) handleDeleteDiscountRule(rule.id); }}
                      title="삭제"
                    >
                      <IconTrash />
                    </button>
                  </div>
                );
              })
            )}

            {/* 규칙 추가 폼 */}
            <div className="rule-add-form">
              <div className="rule-add-title">규칙 추가</div>

              <div className="rule-form-row">
                <label className="rule-form-label">규칙 유형</label>
                <select value={addingRuleType} onChange={e => { setAddingRuleType(e.target.value); setAddingRuleValue(''); setAddingRuleMinAmount(''); }} className="rule-form-select">
                  <option value="percent">비율 (%)</option>
                  <option value="fixed">정액 (원)</option>
                  <option value="remainder">잔액 포인트</option>
                </select>
              </div>

              <div className="rule-form-row">
                <label className="rule-form-label">카테고리</label>
                <select value={addingRuleCategory} onChange={e => { setAddingRuleCategory(e.target.value); setAddingRuleSub(''); }} className="rule-form-select">
                  <option value="">전체 (기본)</option>
                  {ruleCategories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              {addingRuleCategory && (
                <div className="rule-form-row">
                  <label className="rule-form-label">세부카테고리</label>
                  <select value={addingRuleSub} onChange={e => setAddingRuleSub(e.target.value)} className="rule-form-select">
                    <option value="">전체</option>
                    {ruleSubCategories.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              )}

              <div className="rule-form-row">
                <label className="rule-form-label">세부내역 키워드</label>
                <input
                  type="text"
                  value={addingRuleDetailKeyword}
                  onChange={e => setAddingRuleDetailKeyword(e.target.value)}
                  placeholder="예: 스타벅스 (비워두면 전체)"
                  className="rule-form-input"
                />
              </div>

              <div className="rule-form-row">
                <label className="rule-form-label">
                  {addingRuleType === 'percent' ? '할인율 (%)' : addingRuleType === 'fixed' ? '할인 금액 (원)' : '단위 (원)'}
                </label>
                <input
                  type="number"
                  min="0"
                  step={addingRuleType === 'percent' ? '0.01' : '1'}
                  value={addingRuleValue}
                  onChange={e => setAddingRuleValue(e.target.value)}
                  placeholder={addingRuleType === 'percent' ? '예: 1.2' : addingRuleType === 'fixed' ? '예: 500' : '예: 1000'}
                  className="rule-form-input"
                />
              </div>

              {addingRuleType === 'remainder' && (
                <div className="rule-form-row">
                  <label className="rule-form-label">최소 금액 (원)</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={addingRuleMinAmount}
                    onChange={e => setAddingRuleMinAmount(e.target.value)}
                    placeholder="예: 5000"
                    className="rule-form-input"
                  />
                </div>
              )}

              <div className="rule-form-row">
                <label className="rule-form-label">메모 (선택)</label>
                <input
                  type="text"
                  value={addingRuleNote}
                  onChange={e => setAddingRuleNote(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddDiscountRule(); }}
                  placeholder="예: 주유 1.2% 적립"
                  className="rule-form-input"
                />
              </div>

              <button className="btn-primary" style={{ width: '100%', marginTop: '4px' }} onClick={handleAddDiscountRule}>+ 규칙 추가</button>
            </div>
          </>

        ) : (activeSection === 'payment' || activeSection === 'category') ? (
          <>
            {currentItems.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 16px' }}>항목이 없습니다.</div>
            ) : renderDraggableList(currentItems, activeSection === 'payment' ? 'payment_methods' : drilldownCategory ? 'sub_categories' : 'budget_categories')}

            <div className="settings-add-row">
              <input
                type="text"
                value={addingName}
                onChange={e => setAddingName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  activeSection === 'payment' ? '새 결제수단...' :
                  drilldownCategory ? '새 세부카테고리...' :
                  '새 카테고리...'
                }
              />
              <button className="btn-primary" onClick={handleAddItem}>+ 추가</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default SettingsView;
