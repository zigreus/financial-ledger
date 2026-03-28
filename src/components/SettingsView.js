import React, { useState, useMemo } from 'react';
import { getAllPaymentMethods, getAllBudgetCategories, getAllSubCategories, setMasterItemHidden, addPaymentMethod, addBudgetCategory, addSubCategory, cleanupHiddenPaymentMethods, setCategoryColor } from '../services/dbManager';

function SettingsView({ db, onChanged }) {
  const [activeSection, setActiveSection] = useState('payment');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [addingName, setAddingName] = useState('');
  const [error, setError] = useState('');

  const paymentMethods = useMemo(() => getAllPaymentMethods(db), [db]);
  const budgetCategories = useMemo(() => getAllBudgetCategories(db), [db]);
  const subCategories = useMemo(() => getAllSubCategories(db, selectedCategory), [db, selectedCategory]);

  const handleToggleHidden = (table, id, currentHidden) => {
    try {
      setMasterItemHidden(db, table, id, !currentHidden);
      // 결제수단을 숨길 때, 사용되지 않는 숨겨진 항목 정리
      if (table === 'payment_methods' && !currentHidden) {
        cleanupHiddenPaymentMethods(db);
      }
      onChanged();
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };

  const handleAddItem = () => {
    if (!addingName.trim()) {
      setError('항목 이름을 입력해주세요.');
      return;
    }

    try {
      if (activeSection === 'payment') {
        addPaymentMethod(db, addingName);
      } else if (activeSection === 'category') {
        addBudgetCategory(db, addingName);
      } else if (activeSection === 'sub') {
        if (!selectedCategory) {
          setError('카테고리를 선택해주세요.');
          return;
        }
        addSubCategory(db, selectedCategory, addingName);
      }
      onChanged();
      setAddingName('');
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleAddItem();
    }
  };

  const currentItems = useMemo(() => {
    if (activeSection === 'colors') return budgetCategories;
    const items = activeSection === 'payment' ? paymentMethods : activeSection === 'category' ? budgetCategories : subCategories;
    return [...items].sort((a, b) => {
      if (a.is_hidden !== b.is_hidden) {
        return a.is_hidden ? 1 : -1;
      }
      return a.sort_order - b.sort_order;
    });
  }, [activeSection, paymentMethods, budgetCategories, subCategories]);

  return (
    <div className="settings-page">
      {/* 섹션 탭 */}
      <div className="settings-tabs">
        <button
          className={activeSection === 'payment' ? 'tab active' : 'tab'}
          onClick={() => { setActiveSection('payment'); setSelectedCategory(''); setAddingName(''); setError(''); }}
        >
          결제수단
        </button>
        <button
          className={activeSection === 'category' ? 'tab active' : 'tab'}
          onClick={() => { setActiveSection('category'); setSelectedCategory(''); setAddingName(''); setError(''); }}
        >
          예산카테고리
        </button>
        <button
          className={activeSection === 'sub' ? 'tab active' : 'tab'}
          onClick={() => { setActiveSection('sub'); setAddingName(''); setError(''); }}
        >
          세부카테고리
        </button>
        <button
          className={activeSection === 'colors' ? 'tab active' : 'tab'}
          onClick={() => { setActiveSection('colors'); setSelectedCategory(''); setAddingName(''); setError(''); }}
        >
          색상
        </button>
      </div>

      {/* 세부카테고리 섹션의 카테고리 선택 */}
      {activeSection === 'sub' && (
        <div className="settings-filter">
          <select value={selectedCategory} onChange={e => { setSelectedCategory(e.target.value); setAddingName(''); }}>
            <option value="">카테고리 선택</option>
            {budgetCategories.map(c => (
              <option key={c.id} value={c.name}>{c.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* 항목 목록 / 색상 설정 */}
      <div className="settings-section">
        {error && <div className="error-msg" style={{ marginBottom: '12px' }}>{error}</div>}

        {activeSection === 'colors' ? (
          <>
            {budgetCategories.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 16px' }}>
                카테고리가 없습니다.
              </div>
            ) : (
              budgetCategories.map(cat => (
                <div key={cat.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '15px', fontWeight: '500' }}>{cat.name}</span>
                  <input
                    type="color"
                    value={cat.color || '#AAB7B8'}
                    onChange={(e) => {
                      try {
                        setCategoryColor(db, cat.id, e.target.value);
                        onChanged();
                        setError('');
                      } catch (err) {
                        setError(err.message);
                      }
                    }}
                    style={{ width: '50px', height: '40px', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
                  />
                </div>
              ))
            )}
          </>
        ) : (
          <>
            {currentItems.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 16px' }}>
            항목이 없습니다.
          </div>
        ) : (
          currentItems.map(item => (
            <div key={item.id} className={`settings-item ${item.is_hidden ? 'settings-item-hidden' : ''}`}>
              <span className="settings-item-name">{item.name}</span>
              <button
                className={item.is_hidden ? 'btn-secondary' : 'btn-outline'}
                onClick={() => handleToggleHidden(
                  activeSection === 'payment' ? 'payment_methods' : activeSection === 'category' ? 'budget_categories' : 'sub_categories',
                  item.id,
                  item.is_hidden
                )}
              >
                {item.is_hidden ? '표시' : '숨기기'}
              </button>
            </div>
          ))
        )}

            {/* 추가 입력 행 */}
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
