import React, { useState, useMemo } from 'react';
import {
  getAllPaymentMethods, getAllBudgetCategories, getAllSubCategories,
  setMasterItemHidden, reorderMasterItem,
  addPaymentMethod, addBudgetCategory, addSubCategory,
  cleanupHiddenPaymentMethods,
  setPaymentMethodDiscountRate, bulkApplyShinhanDiscount, bulkApplyWooriDiscount,
  getAllTrips, getTripCountries, addTrip, setTripHidden, reorderTrip,
  addTripCountry, deleteTripCountry,
} from '../services/dbManager';

function SettingsView({ db, onChanged }) {
  const [activeSection, setActiveSection] = useState('payment');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [addingName, setAddingName] = useState('');
  const [error, setError] = useState('');
  const [dataMsg, setDataMsg] = useState('');
  const [addingTripName, setAddingTripName] = useState('');
  const [selectedTripId, setSelectedTripId] = useState('');
  const [addingCountry, setAddingCountry] = useState('');
  const [addingCurrency, setAddingCurrency] = useState('');

  const paymentMethods = useMemo(() => getAllPaymentMethods(db), [db]);
  const budgetCategories = useMemo(() => getAllBudgetCategories(db), [db]);
  const subCategories = useMemo(() => getAllSubCategories(db, selectedCategory), [db, selectedCategory]);
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

  const handleReorder = (table, id, direction) => {
    try {
      reorderMasterItem(db, table, id, direction);
      onChanged();
      setError('');
    } catch (e) {
      setError(e.message);
    }
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
        addBudgetCategory(db, addingName);
      } else if (activeSection === 'sub') {
        if (!selectedCategory) { setError('카테고리를 선택해주세요.'); return; }
        addSubCategory(db, selectedCategory, addingName);
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
      : activeSection === 'category' ? budgetCategories
      : subCategories;
    return [...items].sort((a, b) => {
      if (a.is_hidden !== b.is_hidden) return a.is_hidden ? 1 : -1;
      return a.sort_order - b.sort_order;
    });
  }, [activeSection, paymentMethods, budgetCategories, subCategories]);

  const switchSection = (sec) => {
    setActiveSection(sec);
    setSelectedCategory('');
    setAddingName('');
    setAddingTripName('');
    setSelectedTripId('');
    setAddingCountry('');
    setAddingCurrency('');
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

  const handleToggleTripHidden = (id, currentHidden) => {
    try {
      setTripHidden(db, id, !currentHidden);
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
        <button className={activeSection === 'category' ? 'tab active' : 'tab'} onClick={() => switchSection('category')}>예산카테고리</button>
        <button className={activeSection === 'sub' ? 'tab active' : 'tab'} onClick={() => switchSection('sub')}>세부카테고리</button>
        <button className={activeSection === 'travel' ? 'tab active' : 'tab'} onClick={() => switchSection('travel')}>여행</button>
        <button className={activeSection === 'data' ? 'tab active' : 'tab'} onClick={() => switchSection('data')}>데이터</button>
      </div>

      {/* 세부카테고리 섹션 필터 */}
      {activeSection === 'sub' && (
        <div className="settings-filter">
          <select value={selectedCategory} onChange={e => { setSelectedCategory(e.target.value); setAddingName(''); }}>
            <option value="">카테고리 선택</option>
            {budgetCategories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </div>
      )}

      <div className="settings-section">
        {error && <div className="error-msg" style={{ marginBottom: '12px' }}>{error}</div>}

        {/* ── 여행 관리 탭 ── */}
        {activeSection === 'travel' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>

            {/* 여행 목록 */}
            <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '8px' }}>여행 목록</div>
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
                  return (
                    <div key={trip.id} className={`settings-item ${trip.is_hidden ? 'settings-item-hidden' : ''}`}>
                      <div className="reorder-buttons">
                        <button className="btn-reorder" disabled={groupIdx === 0} onClick={() => handleReorderTrip(trip.id, 'up')}>▲</button>
                        <button className="btn-reorder" disabled={groupIdx === sameGroup.length - 1} onClick={() => handleReorderTrip(trip.id, 'down')}>▼</button>
                      </div>
                      <span className="settings-item-name">{trip.name}</span>
                      <button
                        className={trip.is_hidden ? 'btn-secondary' : 'btn-outline'}
                        onClick={() => handleToggleTripHidden(trip.id, trip.is_hidden)}
                      >
                        {trip.is_hidden ? '표시' : '숨기기'}
                      </button>
                    </div>
                  );
                });
              })()
            )}

            {/* 여행 추가 */}
            <div className="settings-add-row">
              <input
                type="text"
                value={addingTripName}
                onChange={e => setAddingTripName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddTrip(); }}
                placeholder="새 여행 이름 (예: 일본 오사카 2026)"
              />
              <button className="btn-primary" onClick={handleAddTrip}>+ 추가</button>
            </div>

            {/* 나라/화폐 관리 */}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: '16px', paddingTop: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '8px' }}>나라 / 화폐 관리</div>
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
            </div>
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

        /* ── 결제수단 / 카테고리 / 세부카테고리 탭 ── */
        ) : (
          <>
            {currentItems.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 16px' }}>항목이 없습니다.</div>
            ) : (
              currentItems.map((item, idx) => {
                const table = activeSection === 'payment' ? 'payment_methods'
                  : activeSection === 'category' ? 'budget_categories'
                  : 'sub_categories';
                const sameGroup = currentItems.filter(x => x.is_hidden === item.is_hidden);
                const groupIdx = sameGroup.indexOf(item);
                const isFirst = groupIdx === 0;
                const isLast = groupIdx === sameGroup.length - 1;
                return (
                  <div key={item.id} className={`settings-item ${item.is_hidden ? 'settings-item-hidden' : ''}`}>
                    {/* 순서 조정 버튼 */}
                    <div className="reorder-buttons">
                      <button
                        className="btn-reorder"
                        disabled={isFirst}
                        onClick={() => handleReorder(table, item.id, 'up')}
                      >▲</button>
                      <button
                        className="btn-reorder"
                        disabled={isLast}
                        onClick={() => handleReorder(table, item.id, 'down')}
                      >▼</button>
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

                    <button
                      className={item.is_hidden ? 'btn-secondary' : 'btn-outline'}
                      onClick={() => handleToggleHidden(table, item.id, item.is_hidden)}
                    >
                      {item.is_hidden ? '표시' : '숨기기'}
                    </button>
                  </div>
                );
              })
            )}

            {activeSection !== 'sub' || selectedCategory ? (
              <div className="settings-add-row">
                <input
                  type="text"
                  value={addingName}
                  onChange={e => setAddingName(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    activeSection === 'payment' ? '새 결제수단...' :
                    activeSection === 'category' ? '새 카테고리...' :
                    '새 세부카테고리...'
                  }
                />
                <button className="btn-primary" onClick={handleAddItem}>+ 추가</button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export default SettingsView;
