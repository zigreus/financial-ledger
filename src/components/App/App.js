import React, { useState, useCallback, useEffect } from 'react';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import './App.css';

import LoginPage from '../LoginPage/LoginPage';
import Header from '../Header/Header';
import TransactionList from '../TransactionList/TransactionList';
import TransactionForm from '../TransactionForm/TransactionForm';
import SummaryView from '../SummaryView/SummaryView';
import SettingsView from '../SettingsView/SettingsView';
import ImportModal from '../ImportModal/ImportModal';
import CalendarView from '../CalendarView/CalendarView';

import { initSQL, createDatabase, exportDatabase, addTransaction, updateTransaction, deleteTransaction, runAutoRegister } from '../../services/dbManager';
import { readDbFromOneDrive, writeDbToOneDrive } from '../../services/oneDriveService';

function App() {
  const isAuthenticated = useIsAuthenticated();
  const { instance, accounts } = useMsal();

  const [db, setDb] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('list'); // 'list' | 'summary' | 'calendar' | 'settings'
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showEventForm, setShowEventForm] = useState(false);
  const [editingTx, setEditingTx] = useState(null);
  const [toast, setToast] = useState('');
  const toastTimer = React.useRef(null);

  // SummaryView 내비게이션 state
  const [summaryTab, setSummaryTab] = useState('monthly');
  const [summaryDrilldown, setSummaryDrilldown] = useState(null);
  // SettingsView 내비게이션 state
  const [settingsSection, setSettingsSection] = useState('payment');
  const [settingsDrilldownCategory, setSettingsDrilldownCategory] = useState(null);
  const [settingsDrilldownTrip, setSettingsDrilldownTrip] = useState(null);
  const [settingsDrilldownPayment, setSettingsDrilldownPayment] = useState(null);

  const navRef = React.useRef({
    activeTab: 'list', showForm: false, showImport: false, showEventForm: false, editingTx: null,
    summaryTab: 'monthly', summaryDrilldown: null,
    settingsSection: 'payment',
    settingsDrilldownCategory: null, settingsDrilldownTrip: null, settingsDrilldownPayment: null,
  });
  const historyInitialized = React.useRef(false);

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  }, []);

  const applyNavState = useCallback((s) => {
    if ('activeTab' in s) setActiveTab(s.activeTab);
    if ('showForm' in s) setShowForm(s.showForm);
    if ('showImport' in s) setShowImport(s.showImport);
    if ('showEventForm' in s) setShowEventForm(s.showEventForm);
    if ('editingTx' in s) setEditingTx(s.editingTx);
    if ('summaryTab' in s) setSummaryTab(s.summaryTab);
    if ('summaryDrilldown' in s) setSummaryDrilldown(s.summaryDrilldown);
    if ('settingsSection' in s) setSettingsSection(s.settingsSection);
    if ('settingsDrilldownCategory' in s) setSettingsDrilldownCategory(s.settingsDrilldownCategory);
    if ('settingsDrilldownTrip' in s) setSettingsDrilldownTrip(s.settingsDrilldownTrip);
    if ('settingsDrilldownPayment' in s) setSettingsDrilldownPayment(s.settingsDrilldownPayment);
  }, []);

  const navigate = useCallback((updates) => {
    const newState = { ...navRef.current, ...updates };
    navRef.current = newState;
    window.history.pushState(newState, '');
    applyNavState(updates);
  }, [applyNavState]);

  useEffect(() => {
    const onPopState = (e) => {
      if (e.state) {
        navRef.current = e.state;
        applyNavState(e.state);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyNavState]);

  // 로그인 후 DB 자동 로드
  useEffect(() => {
    if (isAuthenticated && accounts.length > 0 && !db) {
      loadDb();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, accounts]);

  // DB 최초 로드 완료 시 브라우저 히스토리 초기화
  useEffect(() => {
    if (!db || historyInitialized.current) return;
    historyInitialized.current = true;
    window.history.replaceState(navRef.current, '');
  }, [db]);

  const loadDb = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      const SQL = await initSQL();
      const data = await readDbFromOneDrive(instance, accounts);
      const { db: newDb, didMigrate } = createDatabase(SQL, data);

      // 자동등록 실행 (매 로그인 시)
      const { count, targetYearMonth } = runAutoRegister(newDb);

      const needsSave = didMigrate || count > 0;
      if (needsSave) {
        try {
          const bytes = exportDatabase(newDb);
          await writeDbToOneDrive(instance, accounts, bytes);
        } catch (e) {
          setError(`저장 실패: ${e.message}`);
        }
        if (count > 0) {
          showToast(`✓ ${targetYearMonth} 정기지출 ${count}건 자동 등록됨`);
        }
      }

      setDb(newDb);
      setDirty(false);
    } catch (e) {
      setError(`로드 실패: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [loading, instance, accounts, showToast]);

  const saveDb = useCallback(async () => {
    if (!db || saving) return;
    setSaving(true);
    setError('');
    try {
      const bytes = exportDatabase(db);
      await writeDbToOneDrive(instance, accounts, bytes);
      setDirty(false);
    } catch (e) {
      setError(`저장 실패: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }, [db, saving, instance, accounts]);

  // 저장 후 OneDrive에서 즉시 새로고침 (수정 시 자동 호출)
  const saveAndReload = useCallback(async (currentDb) => {
    setSaving(true);
    setError('');
    try {
      const bytes = exportDatabase(currentDb);
      await writeDbToOneDrive(instance, accounts, bytes);
      setDirty(false);
    } catch (e) {
      setError(`저장 실패: ${e.message}`);
      setSaving(false);
      return;
    }
    setSaving(false);
    setLoading(true);
    try {
      const SQL = await initSQL();
      const data = await readDbFromOneDrive(instance, accounts);
      const { db: newDb, didMigrate } = createDatabase(SQL, data);
      setDb(newDb);
      setDirty(didMigrate);
    } catch (e) {
      setError(`새로고침 실패: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [instance, accounts]);

  const handleAdd = useCallback(async (txData) => {
    addTransaction(db, txData);
    setShowForm(false);
    setEditingTx(null);
    window.history.back();
    const amt = Number(txData.amount).toLocaleString();
    showToast(`저장 중…`);
    await saveAndReload(db);
    showToast(`✓ ${txData.budget_category} ${amt}원 추가됨`);
  }, [db, showToast, saveAndReload]);

  const handleUpdate = useCallback(async (txData) => {
    updateTransaction(db, editingTx.id, txData);
    setShowForm(false);
    setEditingTx(null);
    window.history.back();
    const amt = Number(txData.amount).toLocaleString();
    showToast(`저장 중…`);
    await saveAndReload(db);
    showToast(`✓ ${txData.budget_category} ${amt}원 수정 및 저장됨`);
  }, [db, editingTx, showToast, saveAndReload]);

  const handleDelete = useCallback(async (id) => {
    deleteTransaction(db, id);
    showToast('저장 중…');
    await saveAndReload(db);
    showToast('✓ 거래가 삭제되었습니다');
  }, [db, showToast, saveAndReload]);

  const openAdd = () => {
    navigate({ showForm: true, editingTx: null });
  };

  const openEdit = (tx) => {
    navigate({ showForm: true, editingTx: tx });
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingTx(null);
    window.history.back();
  };

  const handleImport = useCallback(async () => {
    setShowImport(false);
    window.history.back();
    showToast('저장 중…');
    await saveAndReload(db);
    showToast('✓ 가져오기 완료 및 저장됨');
  }, [db, showToast, saveAndReload]);

  if (!isAuthenticated) return <LoginPage />;

  if (!db) {
    return (
      <div className="loading-page">
        {loading ? (
          <>
            <div className="spinner" />
            <p>OneDrive에서 가계부를 불러오는 중…</p>
          </>
        ) : (
          <>
            {error && <p className="error-msg">{error}</p>}
            <button className="btn-primary" onClick={loadDb}>가계부 불러오기</button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="app-container">
      <Header
        onRefresh={loadDb}
        onSave={saveDb}
        loading={loading}
        saving={saving}
        dirty={dirty}
      />

      {toast && (
        <div className="toast-banner">
          {toast}
        </div>
      )}

      {error && (
        <div className="error-banner" onClick={() => setError('')}>
          ⚠️ {error} (탭하여 닫기)
        </div>
      )}

<main className="app-main">
        {activeTab === 'list' && (
          <TransactionList
            db={db}
            onAdd={openAdd}
            onEdit={openEdit}
            onDelete={handleDelete}
            onChanged={async () => {
              await saveAndReload(db);
            }}
          />
        )}
        {activeTab === 'summary' && (
          <SummaryView
            db={db}
            tab={summaryTab}
            drilldownCategory={summaryDrilldown}
            onTabChange={(t) => navigate({ summaryTab: t, summaryDrilldown: null })}
            onDrilldownChange={(d) => navigate({ summaryDrilldown: d })}
          />
        )}
        {activeTab === 'calendar' && (
          <CalendarView
            db={db}
            onChanged={async () => {
              showToast('저장 중…');
              await saveAndReload(db);
              showToast('✓ 저장됨');
            }}
            showEventForm={showEventForm}
            onOpenEventForm={() => navigate({ showEventForm: true })}
            onCloseEventForm={() => { setShowEventForm(false); window.history.back(); }}
            onAddTransaction={openAdd}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsView
            db={db}
            onChanged={async () => {
              showToast('저장 중…');
              await saveAndReload(db);
              showToast('✓ 설정이 저장됨');
            }}
            activeSection={settingsSection}
            drilldownCategory={settingsDrilldownCategory}
            drilldownTrip={settingsDrilldownTrip}
            drilldownPayment={settingsDrilldownPayment}
            onSectionChange={(sec) => navigate({
              settingsSection: sec,
              settingsDrilldownCategory: null,
              settingsDrilldownTrip: null,
              settingsDrilldownPayment: null,
            })}
            onDrilldownCategoryChange={(v) => navigate({ settingsDrilldownCategory: v })}
            onDrilldownTripChange={(v) => navigate({ settingsDrilldownTrip: v })}
            onDrilldownPaymentChange={(v) => navigate({ settingsDrilldownPayment: v })}
          />
        )}
      </main>

      {/* 하단 네비게이션 */}
      <nav className="bottom-nav">
        <button
          className={activeTab === 'list' ? 'nav-item active' : 'nav-item'}
          onClick={() => navigate({ activeTab: 'list' })}
        >
          <span className="nav-icon">📋</span>
          <span className="nav-label">거래내역</span>
        </button>
        <button
          className={activeTab === 'summary' ? 'nav-item active' : 'nav-item'}
          onClick={() => { navigate({ activeTab: 'summary' }); document.querySelector('.app-main')?.scrollTo(0, 0); }}
        >
          <span className="nav-icon">📊</span>
          <span className="nav-label">요약</span>
        </button>
        <button
          className={`nav-item nav-add${activeTab === 'calendar' ? ' nav-add--event' : ''}`}
          onClick={activeTab === 'calendar' ? () => navigate({ showEventForm: true }) : openAdd}
        >
          <span className="nav-icon-add">{activeTab === 'calendar' ? '📅' : '+'}</span>
        </button>
        <button
          className={activeTab === 'calendar' ? 'nav-item active' : 'nav-item'}
          onClick={() => { navigate({ activeTab: 'calendar' }); document.querySelector('.app-main')?.scrollTo(0, 0); }}
        >
          <span className="nav-icon">🗓️</span>
          <span className="nav-label">캘린더</span>
        </button>
        <button
          className={activeTab === 'settings' ? 'nav-item active' : 'nav-item'}
          onClick={() => { navigate({ activeTab: 'settings' }); document.querySelector('.app-main')?.scrollTo(0, 0); }}
        >
          <span className="nav-icon">⚙️</span>
          <span className="nav-label">설정</span>
        </button>
      </nav>

      {/* 거래 추가/수정 모달 */}
      {showForm && (
        <TransactionForm
          db={db}
          editingTx={editingTx}
          onSave={editingTx ? handleUpdate : handleAdd}
          onCancel={closeForm}
        />
      )}

      {/* CSV 가져오기 모달 */}
      {showImport && (
        <ImportModal
          db={db}
          onImport={handleImport}
          onClose={() => { setShowImport(false); window.history.back(); }}
        />
      )}
    </div>
  );
}

export default App;
