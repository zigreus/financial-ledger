import React, { useState, useMemo } from 'react';
import {
  getAllPaymentMethods, getAllBudgetCategories, getAllSubCategories,
  setMasterItemHidden, moveItemToPosition,
  addPaymentMethod, addBudgetCategory, addSubCategory,
  cleanupHiddenPaymentMethods,
  setPaymentMethodDiscountRate, bulkApplyShinhanDiscount, bulkApplyWooriDiscount,
  getAllTrips, getTripCountries, addTrip, updateTripName, deleteTrip, reorderTrip,
  addTripCountry, deleteTripCountry,
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

function SettingsView({ db, onChanged }) {
  const [activeSection, setActiveSection] = useState('payment');
  const [drilldownCategory, setDrilldownCategory] = useState(null); // {id, name} | null
  const [addingName, setAddingName] = useState('');
  const [error, setError] = useState('');
  const [dataMsg, setDataMsg] = useState('');
  const [dragId, setDragId] = useState(null);
  const [dropIdx, setDropIdx] = useState(null);
  const [addingTripName, setAddingTripName] = useState('');
  const [selectedTripId, setSelectedTripId] = useState('');
  const [addingCountry, setAddingCountry] = useState('');
  const [addingCurrency, setAddingCurrency] = useState('');
  const [travelSubTab, setTravelSubTab] = useState('list');
  const [editingTripId, setEditingTripId] = useState(null);
  const [editingTripName, setEditingTripName] = useState('');

  const paymentMethods = useMemo(() => getAllPaymentMethods(db), [db]);
  const budgetCategories = useMemo(() => getAllBudgetCategories(db), [db]);
  const subCategories = useMemo(() => getAllSubCategories(db, drilldownCategory?.name || ''), [db, drilldownCategory]);
  const trips = useMemo(() => getAllTrips(db), [db]);
  const tripCountries = useMemo(() => selectedTripId ? getTripCountries(db, Number(selectedTripId)) : [], [db, selectedTripId]);

  const handleToggleHidden = (table, id, currentHidden) => {
    try {
      setMasterItemHidden(db, table, id, !currentHidden);
      if (table === 'payment_methods' && !currentHidden) {
        cleanupHiddenPaymentMethods(db);
      }
      onChanged();
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };

  const handleDrop = (table, items) => {
    if (dragId === null || dropIdx === null) { setDragId(null); setDropIdx(null); return; }
    const dragItem = items.find(i => i.id === dragId);
    if (!dragItem) { setDragId(null); setDropIdx(null); return; }

    // dropIdx 이전에 있는 같은 그룹 아이템 수 (드래그 아이템 제외)
    const targetGroupIdx = items.slice(0, dropIdx).filter(i => i.is_hidden === dragItem.is_hidden && i.id !== dragId).length;

    try {
      moveItemToPosition(db, table, dragId, targetGroupIdx, drilldownCategory?.name);
      onChanged();
      setError('');
    } catch (e) {
      setError(e.message);
    }
    setDragId(null);
    setDropIdx(null);
  };

  const handleRateBlur = (name, inputEl) => {
    const val = parseFloat(inputEl.value);
    if (isNaN(val) || val < 0 || val > 100) return;
    try {
      setPaymentMethodDiscountRate(db, name, val / 100);
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleAddItem = () => {
    if (!addingName.trim()) { setError('항목 이름을 입력해주세요.'); return; }
    try {
      if (activeSection === 'payment') {
        addPaymentMethod(db, addingName);
      } else if (activeSection === 'category') {
        if (drilldownCategory) {
          addSubCategory(db, drilldownCategory.name, addingName);
        } else {
          addBudgetCategory(db, addingName);
        }
      }
      onChanged();
      setAddingName('');
      setError('');
    } catch (e) {
      setError(e.message);
    }
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

  const switchSection = (sec) => {
    setActiveSection(sec);
    setDrilldownCategory(null);
    setAddingName('');
    setAddingTripName('');
    setSelectedTripId('');
    setAddingCountry('');
    setAddingCurrency('');
    setTravelSubTab('list');
    setEditingTripId(null);
    setEditingTripName('');
    setError('');
    setDataMsg('');
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

  const handleReorderTrip = (id, direction) => {
    try {
      reorderTrip(db, id, direction);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleAddTripCountry = () => {
    if (!selectedTripId) return;
    if (!addingCountry.trim()) { setError('나라명을 입력하세요.'); return; }
    if (!addingCurrency.trim()) { setError('화폐 단위를 입력하세요.'); return; }
    try {
      addTripCountry(db, Number(selectedTripId), addingCountry, addingCurrency);
      onChanged();
      setAddingCountry('');
      setAddingCurrency('');
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

  return (
    <div className="settings-page">
      {/* 섹션 탭 */}
      <div className="settings-tabs">
        <button className={activeSection === 'payment' ? 'tab active' : 'tab'} onClick={() => switchSection('payment')}>결제수단</button>
        <button className={activeSection === 'category' ? 'tab active' : 'tab'} onClick={() => switchSection('category')}>카테고리</button>
        <button className={activeSection === 'travel' ? 'tab active' : 'tab'} onClick={() => switchSection('travel')}>여행</button>
        <button className={activeSection === 'data' ? 'tab active' : 'tab'} onClick={() => switchSection('data')}>데이터</button>
      </div>

      {/* 카테고리 드릴다운 뒤로가기 */}
      {activeSection === 'category' && drilldownCategory && (
        <div style={{ padding: '0 0 8px' }}>
          <button className="drilldown-back-btn" onClick={() => { setDrilldownCategory(null); setAddingName(''); setError(''); }}>
            ← {drilldownCategory.name}
          </button>
        </div>
      )}

      <div className="settings-section">
        {error && <div className="error-msg" style={{ marginBottom: '12px' }}>{error}</div>}

        {/* ── 여행 관리 탭 ── */}
        {activeSection === 'travel' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>

            {/* 여행 서브탭 */}
            <div className="settings-tabs" style={{ marginBottom: '12px' }}>
              <button
                className={travelSubTab === 'list' ? 'tab active' : 'tab'}
                onClick={() => { setTravelSubTab('list'); setError(''); }}
              >여행목록</button>
              <button
                className={travelSubTab === 'country' ? 'tab active' : 'tab'}
                onClick={() => { setTravelSubTab('country'); setError(''); }}
              >나라/화폐 관리</button>
            </div>

            {/* 서브탭: 여행목록 */}
            {travelSubTab === 'list' && (
              <>
                {/* 여행 추가 (상단) */}
                <div className="settings-add-row" style={{ marginBottom: '12px' }}>
                  <input
                    type="text"
                    value={addingTripName}
                    onChange={e => setAddingTripName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAddTrip(); }}
                    placeholder="새 여행 이름 (예: 일본 오사카 2026)"
                  />
                  <button className="btn-primary" onClick={handleAddTrip}>+ 추가</button>
                </div>

                {trips.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '16px' }}>등록된 여행이 없습니다.</div>
                ) : (
                  (() => {
                    const sorted = [...trips].sort((a, b) => {
                      if (a.is_hidden !== b.is_hidden) return a.is_hidden ? 1 : -1;
                      return a.sort_order - b.sort_order;
                    });
                    return sorted.map(trip => {
                      const sameGroup = sorted.filter(t => t.is_hidden === trip.is_hidden);
                      const groupIdx = sameGroup.indexOf(trip);
                      const isEditing = editingTripId === trip.id;
                      return (
                        <div key={trip.id} className="settings-item">
                          <div className="reorder-buttons">
                            <button className="btn-reorder" disabled={groupIdx === 0} onClick={() => handleReorderTrip(trip.id, 'up')}>▲</button>
                            <button className="btn-reorder" disabled={groupIdx === sameGroup.length - 1} onClick={() => handleReorderTrip(trip.id, 'down')}>▼</button>
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
                              style={{ flex: 1, marginRight: '6px' }}
                            />
                          ) : (
                            <span className="settings-item-name">{trip.name}</span>
                          )}
                          {isEditing ? (
                            <>
                              <button className="btn-primary" onClick={() => handleUpdateTripName(trip.id)}>저장</button>
                              <button className="btn-outline" style={{ marginLeft: '4px' }} onClick={() => { setEditingTripId(null); setEditingTripName(''); }}>취소</button>
                            </>
                          ) : (
                            <>
                              <button className="btn-outline" onClick={() => { setEditingTripId(trip.id); setEditingTripName(trip.name); setError(''); }}>수정</button>
                              <button className="btn-outline" style={{ marginLeft: '4px', color: 'var(--danger, #e53e3e)' }} onClick={() => handleDeleteTrip(trip.id, trip.name)}>삭제</button>
                            </>
                          )}
                        </div>
                      );
                    });
                  })()
                )}
              </>
            )}

            {/* 서브탭: 나라/화폐 관리 */}
            {travelSubTab === 'country' && (
              <>
                <select
                  value={selectedTripId}
                  onChange={e => { setSelectedTripId(e.target.value); setAddingCountry(''); setAddingCurrency(''); }}
                  style={{ width: '100%', marginBottom: '12px' }}
                >
                  <option value="">여행 선택</option>
                  {trips.filter(t => !t.is_hidden).map(t => (
                    <option key={t.id} value={String(t.id)}>{t.name}</option>
                  ))}
                </select>

                {selectedTripId && (
                  <>
                    {tripCountries.length === 0 ? (
                      <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '8px', fontSize: '13px' }}>등록된 나라가 없습니다.</div>
                    ) : (
                      tripCountries.map(c => (
                        <div key={c.id} className="settings-item">
                          <span className="settings-item-name">{c.country}</span>
                          <span style={{ fontSize: '13px', color: 'var(--text-muted)', marginRight: '8px' }}>{c.currency}</span>
                          <button className="btn-outline" onClick={() => handleDeleteTripCountry(c.id)}>삭제</button>
                        </div>
                      ))
                    )}
                    <div className="settings-add-row" style={{ marginTop: '8px' }}>
                      <input
                        type="text"
                        value={addingCountry}
                        onChange={e => setAddingCountry(e.target.value)}
                        placeholder="나라 (예: 일본)"
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
                )}
              </>
            )}
          </div>

        ) : activeSection === 'data' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
            {dataMsg && <div style={{ fontSize: '13px', color: 'var(--success)', padding: '8px 0 12px' }}>{dataMsg}</div>}

            {/* 신한카드 */}
            <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: '16px', marginBottom: '16px' }}>
              <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px' }}>신한카드 할인 일괄 적용</div>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '10px' }}>
                5,000원 이상 신한카드 거래 → 1,000원 미만 금액을 할인으로 적용
              </div>
              <button className="btn-primary" onClick={() => {
                if (!window.confirm('신한카드 5,000원 이상 거래에 할인금액을 일괄 적용합니다.\n기존 할인금액도 덮어씌워집니다.')) return;
                try {
                  const count = bulkApplyShinhanDiscount(db);
                  onChanged();
                  setDataMsg(`신한카드 ${count}건 할인 적용 완료`);
                } catch (e) { setError(e.message); }
              }}>일괄 적용</button>
            </div>

            {/* 우리카드 */}
            <div>
              <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '4px' }}>우리카드 할인 일괄 적용</div>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '10px' }}>
                2026년 2월 이전 → 30% 할인<br />
                2026년 3월 이후 → 20% 할인<br />
                <span style={{ color: 'var(--primary)' }}>적용 후 우리카드 기본 할인율이 20%로 설정됩니다.</span>
              </div>
              <button className="btn-primary" onClick={() => {
                if (!window.confirm('우리카드 거래에 기간별 할인금액을 일괄 적용합니다.\n기존 할인금액도 덮어씌워집니다.')) return;
                try {
                  const count = bulkApplyWooriDiscount(db);
                  onChanged();
                  setDataMsg(`우리카드 ${count}건 할인 적용 완료 (이후 신규 거래: 20%)`);
                } catch (e) { setError(e.message); }
              }}>일괄 적용</button>
            </div>
          </div>

        /* ── 결제수단 / 카테고리 탭 ── */
        ) : (
          <>
            {currentItems.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 16px' }}>항목이 없습니다.</div>
            ) : (() => {
              const table = activeSection === 'payment' ? 'payment_methods'
                : activeSection === 'category' && drilldownCategory ? 'sub_categories'
                : 'budget_categories';
              const dragItem = dragId ? currentItems.find(i => i.id === dragId) : null;
              return (
                <div
                  onDrop={(e) => { e.preventDefault(); handleDrop(table, currentItems); }}
                  onDragEnd={() => { setDragId(null); setDropIdx(null); }}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropIdx(null); }}
                >
                  {currentItems.map((item, idx) => {
                    const isDragging = dragId === item.id;
                    const sameGroup = dragItem && item.is_hidden === dragItem.is_hidden;
                    const showIndicator = dropIdx === idx && dragId !== null && sameGroup;
                    return (
                      <React.Fragment key={item.id}>
                        {showIndicator && <div className="drop-indicator" />}
                        <div
                          className={`settings-item ${item.is_hidden ? 'settings-item-hidden' : ''} ${isDragging ? 'settings-item-dragging' : ''}`}
                          draggable
                          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragId(item.id); setDropIdx(null); }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            if (!dragItem || item.is_hidden !== dragItem.is_hidden) { setDropIdx(null); return; }
                            const rect = e.currentTarget.getBoundingClientRect();
                            setDropIdx(e.clientY < rect.top + rect.height / 2 ? idx : idx + 1);
                          }}
                        >
                          {/* 드래그 핸들 */}
                          <div className="drag-handle" title="드래그해서 순서 변경">
                            <IconGrip />
                          </div>

                          <span className="settings-item-name">{item.name}</span>

                          {/* 결제수단 탭에서만 할인율 입력 표시 */}
                          {activeSection === 'payment' && (
                            <div className="discount-rate-field">
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="0.1"
                                defaultValue={item.discount_rate ? Math.round(item.discount_rate * 1000) / 10 : 0}
                                onBlur={(e) => handleRateBlur(item.name, e.target)}
                                className="rate-input"
                                title="기본 할인율 (%)"
                              />
                              <span className="rate-unit">%</span>
                            </div>
                          )}

                          {/* 숨기기/표시 아이콘 버튼 */}
                          <button
                            className={`btn-eye-toggle ${item.is_hidden ? 'btn-eye-toggle--hidden' : ''}`}
                            onClick={() => handleToggleHidden(table, item.id, item.is_hidden)}
                            title={item.is_hidden ? '표시' : '숨기기'}
                          >
                            {item.is_hidden ? <IconEyeOff /> : <IconEyeOpen />}
                          </button>

                          {/* 예산카테고리 탭에서 세부카테고리 드릴다운 버튼 */}
                          {activeSection === 'category' && !drilldownCategory && (
                            <button
                              className="btn-drilldown"
                              onClick={() => { setDrilldownCategory({ id: item.id, name: item.name }); setAddingName(''); setError(''); }}
                              title="세부카테고리 설정"
                            >
                              <IconChevronRight />
                            </button>
                          )}
                        </div>
                      </React.Fragment>
                    );
                  })}
                  {/* 마지막 위치 드롭 인디케이터 */}
                  {dropIdx === currentItems.length && dragId !== null && dragItem && (
                    <div className="drop-indicator" />
                  )}
                </div>
              );
            })()}

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
