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
import CardStatementModal from '../CardStatement/CardStatementModal';
import CalendarView from '../CalendarView/CalendarView';

import AccountManagement from '../AccountManagement/AccountManagement';
import { addTransaction, updateTransaction, deleteTransaction, getSplitGroupTransactions, runAccountAutoRegister, withTransaction } from '../../services/dbManager';
import { getAIConfig, clearAIKeys, activeAI } from '../../services/aiClient';
import { setAISyncAccount, syncAISettings } from '../../services/aiSettingsSync';
import useLedgerSync from '../../hooks/useLedgerSync';

function App() {
  const isAuthenticated = useIsAuthenticated();
  const { instance, accounts } = useMsal();

  // DB 불러오기·자동 저장·충돌 병합은 useLedgerSync가 맡는다.
  // 컴포넌트는 db에 쓰기만 하면 자동으로 저장된다. 화면은 dataVersion으로 갱신한다.
  const {
    db, dataVersion, loading, saving, error, setError, notice,
    dirty, pendingCount, loadDb, saveNow, resetForLogout,
  } = useLedgerSync({ instance, accounts });
  const [activeTab, setActiveTab] = useState('list'); // 'list' | 'summary' | 'calendar' | 'account' | 'settings'
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showCardCheck, setShowCardCheck] = useState(false);
  const [showEventForm, setShowEventForm] = useState(false);
  const [editingTx, setEditingTx] = useState(null);
  const [defaultFormDate, setDefaultFormDate] = useState(null);
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
  // AccountManagement 내비게이션 state
  const [accountDrilldown, setAccountDrilldown] = useState(null); // null=list, {id}=detail
  const [accountDetailTab, setAccountDetailTab] = useState('transactions');
  const [showAccountForm, setShowAccountForm] = useState(false); // 계좌탭 ➕ 버튼용
  const [calendarGoTodayKey, setCalendarGoTodayKey] = useState(0);
  const [listGoTodayKey, setListGoTodayKey] = useState(0);

  const navRef = React.useRef({
    activeTab: 'list', showForm: false, showImport: false, showCardCheck: false, showEventForm: false, editingTx: null,
    summaryTab: 'monthly', summaryDrilldown: null,
    settingsSection: 'payment',
    settingsDrilldownCategory: null, settingsDrilldownTrip: null, settingsDrilldownPayment: null,
    accountDrilldown: null, accountDetailTab: 'transactions', showAccountForm: false,
  });
  const historyInitialized = React.useRef(false);
  const loadAttemptedRef = React.useRef(false);
  const aiSyncedRef = React.useRef(false); // 이번 로그인에서 AI 설정을 맞췄는지

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  }, []);

  const applyNavState = useCallback((s) => {
    if ('activeTab' in s) setActiveTab(s.activeTab);
    if ('showForm' in s) setShowForm(s.showForm);
    if ('showImport' in s) setShowImport(s.showImport);
    if ('showCardCheck' in s) setShowCardCheck(s.showCardCheck);
    if ('showEventForm' in s) setShowEventForm(s.showEventForm);
    if ('editingTx' in s) setEditingTx(s.editingTx);
    if ('summaryTab' in s) setSummaryTab(s.summaryTab);
    if ('summaryDrilldown' in s) setSummaryDrilldown(s.summaryDrilldown);
    if ('settingsSection' in s) setSettingsSection(s.settingsSection);
    if ('settingsDrilldownCategory' in s) setSettingsDrilldownCategory(s.settingsDrilldownCategory);
    if ('settingsDrilldownTrip' in s) setSettingsDrilldownTrip(s.settingsDrilldownTrip);
    if ('settingsDrilldownPayment' in s) setSettingsDrilldownPayment(s.settingsDrilldownPayment);
    if ('accountDrilldown' in s) setAccountDrilldown(s.accountDrilldown);
    if ('accountDetailTab' in s) setAccountDetailTab(s.accountDetailTab);
    if ('showAccountForm' in s) setShowAccountForm(s.showAccountForm);
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

  // 로그인 후 DB 자동 로드 (실패하면 버튼으로 다시 시도)
  useEffect(() => {
    if (!isAuthenticated || accounts.length === 0) { loadAttemptedRef.current = false; return; }
    if (!db && !loadAttemptedRef.current) {
      loadAttemptedRef.current = true;
      loadDb();
    }
  }, [isAuthenticated, accounts, db, loadDb]);

  // AI 설정(API 키)을 같은 계정의 기기끼리 맞춘다 — 가계부를 불러온 뒤 한 번.
  // 다른 기기에서 넣은 키가 있으면 이 기기에서 다시 입력하지 않아도 된다.
  useEffect(() => {
    setAISyncAccount(isAuthenticated ? instance : null, accounts);
    if (!isAuthenticated) aiSyncedRef.current = false;
  }, [isAuthenticated, instance, accounts]);

  useEffect(() => {
    if (!db || aiSyncedRef.current) return;
    aiSyncedRef.current = true;
    const hadKey = !!activeAI();
    syncAISettings()
      .then(result => {
        if (result === 'pulled' && !hadKey && activeAI()) showToast('✓ 다른 기기에서 저장한 AI 설정을 불러왔습니다');
      })
      .catch(() => { aiSyncedRef.current = false; /* 다음에 다시 시도 */ });
  }, [db, showToast]);

  // 동기화 안내(병합·자동등록 등)는 토스트로 보여준다
  useEffect(() => {
    if (notice) showToast(notice.text);
  }, [notice, showToast]);

  // DB 최초 로드 완료 시 브라우저 히스토리 초기화
  useEffect(() => {
    if (!db || historyInitialized.current) return;
    historyInitialized.current = true;
    window.history.replaceState(navRef.current, '');
  }, [db]);

  // 저장은 자동으로 된다 — 여기서는 DB에 반영하고 결과만 알린다.
  // 저장 실패는 헤더의 '저장 안 됨' 표시와 오류 배너로 따로 보여준다 (B-003).
  const handleAdd = useCallback((txData, { keepOpen = false } = {}) => {
    // 분할 결제는 거래 2건으로 들어온다
    const rows = Array.isArray(txData) ? txData : [txData];
    withTransaction(db, () => rows.forEach(row => addTransaction(db, row)));

    // 연속 입력 중이면 폼을 열어둔 채 뒤에서 저장한다
    if (!keepOpen) {
      setShowForm(false);
      setEditingTx(null);
      window.history.back();
    }
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const label = rows.length > 1
      ? `${rows[0].budget_category} ${total.toLocaleString()}원 분할 ${rows.length}건`
      : `${rows[0].budget_category} ${total.toLocaleString()}원`;
    showToast(`✓ ${label} 추가됨`);
  }, [db, showToast]);

  // 말로 입력한 여러 건을 한 번에 추가
  const handleBulkAdd = useCallback((rows) => {
    if (!rows.length) return;
    withTransaction(db, () => rows.forEach(row => addTransaction(db, row)));
    setShowForm(false);
    setEditingTx(null);
    window.history.back();
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    showToast(`✓ ${rows.length}건 ${total.toLocaleString()}원 추가됨`);
  }, [db, showToast]);

  const handleUpdate = useCallback((txData) => {
    // 분할 결제는 묶음 전체를 한 번에 반영한다.
    // id가 있으면 갱신, 없으면 새로 만들고, 묶음에 있었는데 빠진 건 삭제한다.
    const rows = Array.isArray(txData) ? txData : [txData];
    const priorIds = editingTx.split_group_id
      ? getSplitGroupTransactions(db, editingTx.split_group_id).map(t => t.id)
      : [editingTx.id];

    const keptIds = new Set(rows.map(r => r.id).filter(Boolean));
    withTransaction(db, () => {
      rows.forEach(row => {
        if (row.id) updateTransaction(db, row.id, row);
        else addTransaction(db, row);
      });
      priorIds.filter(id => !keptIds.has(id)).forEach(id => deleteTransaction(db, id));
    });

    setShowForm(false);
    setEditingTx(null);
    window.history.back();
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const amt = total.toLocaleString();
    showToast(rows.length > 1
      ? `✓ ${rows[0].budget_category} ${amt}원 분할 ${rows.length}건 수정됨`
      : `✓ ${rows[0].budget_category} ${amt}원 수정됨`);
  }, [db, editingTx, showToast]);

  // id 하나 또는 id 배열(분할 묶음 전체 삭제 등)
  const handleDelete = useCallback((idOrIds) => {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    withTransaction(db, () => ids.forEach(id => deleteTransaction(db, id)));
    showToast(ids.length > 1 ? `✓ 거래 ${ids.length}건이 삭제되었습니다` : '✓ 거래가 삭제되었습니다');
  }, [db, showToast]);

  /** 화면이 변경 후 부르는 콜백 — 바로 저장하고, 성공하면 안내한다 */
  const saveWithToast = useCallback(async (msg = '✓ 저장됨') => {
    const ok = await saveNow();
    if (ok) showToast(msg);
    return ok;
  }, [saveNow, showToast]);

  const handleLogout = useCallback(async () => {
    if (dirty) {
      const ok = await saveNow();
      if (!ok && !window.confirm(`저장되지 않은 변경 ${pendingCount}건이 있습니다.\n로그아웃하면 이 변경은 사라집니다. 그래도 로그아웃할까요?`)) return;
    }
    const hasAIKey = Object.values(getAIConfig().keys).some(k => String(k || '').trim());
    if (hasAIKey && window.confirm('이 기기에 저장된 AI API 키도 지울까요?\n(다른 사람도 쓰는 기기라면 지우는 것을 권장합니다. 다시 로그인하면 OneDrive에서 자동으로 불러옵니다)')) {
      clearAIKeys();
    }
    resetForLogout();
    instance.logoutRedirect({ account: accounts[0] }).catch(e => setError(`로그아웃 실패: ${e.message}`));
  }, [dirty, pendingCount, saveNow, resetForLogout, instance, accounts, setError]);

  const openAdd = (date) => {
    setDefaultFormDate(typeof date === 'string' ? date : null);
    navigate({ showForm: true, editingTx: null });
  };

  const openEdit = (tx) => {
    navigate({ showForm: true, editingTx: tx });
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingTx(null);
    setDefaultFormDate(null);
    window.history.back();
  };

  const handleImport = useCallback(async () => {
    setShowImport(false);
    window.history.back();
    await saveWithToast('✓ 가져오기 완료 및 저장됨');
  }, [saveWithToast]);

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
            <button className="btn-primary" onClick={() => loadDb()}>가계부 불러오기</button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="app-container">
      <Header
        onRefresh={() => loadDb()}
        onSave={() => saveNow()}
        onLogout={handleLogout}
        loading={loading}
        saving={saving}
        dirty={dirty}
        pendingCount={pendingCount}
        onSettings={() => { navigate({ activeTab: 'settings' }); document.querySelector('.app-main')?.scrollTo(0, 0); }}
        settingsActive={activeTab === 'settings'}
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
            dataVersion={dataVersion}
            goTodayKey={listGoTodayKey}
            onAdd={openAdd}
            onEdit={openEdit}
            onDelete={handleDelete}
            onChanged={() => saveWithToast()}
            onOpenImport={() => navigate({ showImport: true })}
            onOpenCardCheck={() => navigate({ showCardCheck: true })}
          />
        )}
        {activeTab === 'summary' && (
          <SummaryView
            db={db}
            dataVersion={dataVersion}
            tab={summaryTab}
            drilldownCategory={summaryDrilldown}
            onTabChange={(t) => navigate({ summaryTab: t, summaryDrilldown: null })}
            onDrilldownChange={(d) => navigate({ summaryDrilldown: d })}
          />
        )}
        {activeTab === 'calendar' && (
          <CalendarView
            db={db}
            dataVersion={dataVersion}
            goTodayKey={calendarGoTodayKey}
            onChanged={() => saveWithToast()}
            showEventForm={showEventForm}
            onOpenEventForm={() => navigate({ showEventForm: true })}
            onCloseEventForm={() => { setShowEventForm(false); window.history.back(); }}
            onAddTransaction={openAdd}
            onEditTransaction={openEdit}
          />
        )}
        {activeTab === 'account' && (
          <AccountManagement
            db={db}
            dataVersion={dataVersion}
            drilldown={accountDrilldown}
            detailTab={accountDetailTab}
            showForm={showAccountForm}
            onDrilldownChange={(v) => navigate({ accountDrilldown: v })}
            onDetailTabChange={(t) => navigate({ accountDetailTab: t })}
            onCloseForm={() => setShowAccountForm(false)}
            onChanged={() => {
              runAccountAutoRegister(db);
              return saveWithToast();
            }}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsView
            db={db}
            dataVersion={dataVersion}
            onChanged={() => saveWithToast('✓ 설정이 저장됨')}
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
          onClick={() => {
            if (activeTab === 'list') {
              setListGoTodayKey(k => k + 1);
            } else {
              navigate({ activeTab: 'list' });
            }
          }}
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
          className={`nav-item nav-add${activeTab === 'calendar' ? ' nav-add--event' : activeTab === 'account' ? ' nav-add--account' : ''}`}
          onClick={
            activeTab === 'calendar'
              ? () => navigate({ showEventForm: true })
              : activeTab === 'account'
                ? () => { setShowAccountForm(true); }
                : openAdd
          }
        >
          <span className="nav-icon-add">{activeTab === 'calendar' ? '📅' : activeTab === 'account' ? '💳' : '+'}</span>
        </button>
        <button
          className={activeTab === 'calendar' ? 'nav-item active' : 'nav-item'}
          onClick={() => {
            if (activeTab === 'calendar') {
              setCalendarGoTodayKey(k => k + 1);
              document.querySelector('.app-main')?.scrollTo(0, 0);
            } else {
              navigate({ activeTab: 'calendar' });
              document.querySelector('.app-main')?.scrollTo(0, 0);
            }
          }}
        >
          <span className="nav-icon">🗓️</span>
          <span className="nav-label">캘린더</span>
        </button>
        <button
          className={activeTab === 'account' ? 'nav-item active' : 'nav-item'}
          onClick={() => { navigate({ activeTab: 'account', accountDrilldown: null }); document.querySelector('.app-main')?.scrollTo(0, 0); }}
        >
          <span className="nav-icon">🏦</span>
          <span className="nav-label">계좌</span>
        </button>
      </nav>

      {/* 거래 추가/수정 모달 */}
      {showForm && (
        <TransactionForm
          db={db}
          dataVersion={dataVersion}
          editingTx={editingTx}
          defaultDate={defaultFormDate}
          onSave={editingTx ? handleUpdate : handleAdd}
          onBulkAdd={handleBulkAdd}
          onCancel={closeForm}
        />
      )}

      {/* 카드 내역 대조 */}
      {showCardCheck && (
        <CardStatementModal
          db={db}
          dataVersion={dataVersion}
          onChanged={() => saveNow()}
          onClose={() => { setShowCardCheck(false); window.history.back(); }}
        />
      )}

      {/* CSV 가져오기 모달 */}
      {showImport && (
        <ImportModal
          db={db}
          dataVersion={dataVersion}
          onImport={handleImport}
          onClose={() => { setShowImport(false); window.history.back(); }}
        />
      )}
    </div>
  );
}

export default App;
