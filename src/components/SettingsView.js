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
} from '../services/dbManager';

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

  const paymentMethods = useMemo(() => getAllPaymentMethods(db), [db]);
  const budgetCategories = useMemo(() => getAllBudgetCategories(db), [db]);
  const subCategories = useMemo(() => getAllSubCategories(db, drilldownCategory?.name || ''), [db, drilldownCategory]);
  const trips = useMemo(() => getAllTrips(db), [db]);
  const tripCountries = useMemo(() => drilldownTrip ? getTripCountries(db, drilldownTrip.id) : [], [db, drilldownTrip]);
  const discountRules = useMemo(() => drilldownPayment ? getDiscountRules(db, drilldownPayment.name) : [], [db, drilldownPayment]);
  const ruleCategories = useMemo(() => getBudgetCategories(db), [db]);
  const ruleSubCategories = useMemo(() => addingRuleCategory ? getSubCategories(db, addingRuleCategory) : [], [db, addingRuleCategory]);

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

        ) : (
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
        )}
      </div>
    </div>
  );
}

export default SettingsView;
