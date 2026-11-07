import React, { useState } from 'react';
import './SettingsView.css';
import PaymentSection from './sections/PaymentSection';
import DiscountRulesSection from './sections/DiscountRulesSection';
import CategorySection from './sections/CategorySection';
import FavoritesSection from './sections/FavoritesSection';
import RecurringSection from './sections/RecurringSection';
import BudgetSection from './sections/BudgetSection';
import CalendarSection from './sections/CalendarSection';
import AISection from './sections/AISection';

/**
 * 설정 화면 — 섹션 전환과 공통 상태(오류 문구, 서브탭)만 가진다.
 * 각 섹션(sections/*)은 자기 입력·편집 상태를 직접 가지고, DB는 useDbSnapshot(db, dataVersion)으로 읽는다.
 *
 * 탭을 다시 눌렀을 때 폼을 닫던 동작은 섹션의 key를 바꿔 새로 그리는 방식으로 유지한다.
 *  - 결제수단·카테고리: 상단 탭·서브탭을 누를 때마다 (예전 switchSection이 입력·편집·드래그 상태를 비우던 것)
 *  - 즐겨찾기: '즐겨찾기' 서브탭을 누를 때 / 정기지출: '정기지출' 서브탭이나 '지출계획' 탭을 누를 때
 */
function SettingsView({ db, dataVersion, onChanged, activeSection, drilldownCategory, drilldownTrip, drilldownPayment, onSectionChange, onDrilldownCategoryChange, onDrilldownTripChange, onDrilldownPaymentChange }) {
  const [error, setError] = useState('');
  // 지출계획 섹션
  const [financeSubTab, setFinanceSubTab] = useState('favorites');
  // 캘린더 섹션 — 다른 탭에 다녀와도 보던 서브탭 유지
  const [calendarSubTab, setCalendarSubTab] = useState('types');
  // 섹션을 새로 그려 상태를 비우는 key
  const [masterKey, setMasterKey] = useState(0);
  const [favoritesKey, setFavoritesKey] = useState(0);
  const [recurringKey, setRecurringKey] = useState(0);

  const switchSection = (sec) => {
    onSectionChange(sec); // App.js에서 드릴다운 초기화 + history push 처리
    setMasterKey(k => k + 1);
    setError('');
  };

  const drilldownBackLabel = drilldownCategory?.name || drilldownPayment?.name;
  const showDrilldownBack = (activeSection === 'category' && drilldownCategory) || (activeSection === 'payment' && drilldownPayment);
  const sectionProps = { db, dataVersion, onChanged, setError };

  return (
    <div className="settings-page">
      {/* 섹션 탭 */}
      <div className="settings-tabs">
        <button className={activeSection === 'payment' ? 'tab active' : 'tab'} onClick={() => switchSection('payment')}>결제수단</button>
        <button className={activeSection === 'category' ? 'tab active' : 'tab'} onClick={() => switchSection('category')}>카테고리</button>
        <button className={(activeSection === 'budget' || activeSection === 'recurring') ? 'tab active' : 'tab'} onClick={() => { switchSection(financeSubTab); setRecurringKey(k => k + 1); }}>지출계획</button>
        <button className={activeSection === 'calendar' ? 'tab active' : 'tab'} onClick={() => switchSection('calendar')}>캘린더</button>
        <button className={activeSection === 'ai' ? 'tab active' : 'tab'} onClick={() => switchSection('ai')}>AI</button>
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

        {/* ── 지출계획 서브탭 ── */}
        {(activeSection === 'favorites' || activeSection === 'recurring' || activeSection === 'budget') && (
          <div className="settings-subtabs">
            <button
              className={`settings-subtab${activeSection === 'favorites' ? ' active' : ''}`}
              onClick={() => { setFinanceSubTab('favorites'); switchSection('favorites'); setFavoritesKey(k => k + 1); }}
            >즐겨찾기</button>
            <button
              className={`settings-subtab${activeSection === 'recurring' ? ' active' : ''}`}
              onClick={() => { setFinanceSubTab('recurring'); switchSection('recurring'); setRecurringKey(k => k + 1); }}
            >정기지출</button>
            <button
              className={`settings-subtab${activeSection === 'budget' ? ' active' : ''}`}
              onClick={() => { setFinanceSubTab('budget'); switchSection('budget'); }}
            >예산</button>
          </div>
        )}

        {activeSection === 'favorites' && <FavoritesSection key={favoritesKey} {...sectionProps} />}

        {activeSection === 'budget' && <BudgetSection {...sectionProps} />}

        {activeSection === 'ai' && <AISection />}

        {activeSection === 'calendar' && (
          <CalendarSection
            db={db}
            dataVersion={dataVersion}
            onChanged={onChanged}
            subTab={calendarSubTab}
            onSubTabChange={setCalendarSubTab}
          />
        )}

        {activeSection === 'recurring' && <RecurringSection key={recurringKey} {...sectionProps} />}

        {/* ── 결제수단 / 카테고리 탭 ── */}
        {activeSection === 'payment' && drilldownPayment ? (
          <DiscountRulesSection key={drilldownPayment.id} {...sectionProps} drilldownPayment={drilldownPayment} />
        ) : activeSection === 'payment' ? (
          <PaymentSection key={masterKey} {...sectionProps} onDrilldownPaymentChange={onDrilldownPaymentChange} />
        ) : activeSection === 'category' ? (
          <CategorySection
            key={masterKey}
            {...sectionProps}
            drilldownCategory={drilldownCategory}
            onDrilldownCategoryChange={onDrilldownCategoryChange}
          />
        ) : null}
      </div>
    </div>
  );
}

export default SettingsView;
