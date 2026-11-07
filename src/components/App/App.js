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
import { initSQL, createDatabase, exportDatabase, addTransaction, updateTransaction, deleteTransaction, getSplitGroupTransactions, runAutoRegister, runAccountAutoRegister } from '../../services/dbManager';
import { readDbFromOneDrive, writeDbToOneDrive } from '../../services/oneDriveService';

function App() {
  const isAuthenticated = useIsAuthenticated();
  const { instance, accounts } = useMsal();

  const [db, setDb] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
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
  // 저장 큐 (saveAndReload 참고)
  const changeSeqRef = React.useRef(0);
  const latestDbRef = React.useRef(null);
  const saveLoopRef = React.useRef(null);

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
    // 저장이 진행 중이면 끝날 때 어차피 새로고침된다 — 겹쳐 읽으면 방금 넣은 내용이 사라질 수 있음
    if (saveLoopRef.current) {
      showToast('저장 중입니다 — 끝나면 자동으로 새로고침됩니다');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const SQL = await initSQL();
      const data = await readDbFromOneDrive(instance, accounts);
      const { db: newDb, didMigrate } = createDatabase(SQL, data);

      // 자동등록 실행 (매 로그인 시)
      const { count, targetYearMonth } = runAutoRegister(newDb);
      const accountAutoCount = runAccountAutoRegister(newDb);

      const needsSave = didMigrate || count > 0 || accountAutoCount > 0;
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
    if (saveLoopRef.current) return saveLoopRef.current;
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

  // ── 저장 후 OneDrive에서 새로고침 (수정 시 자동 호출) ───────────────
  // 저장(쓰기 → 다시 읽기)이 여러 번 겹치면, 늦게 끝난 '다시 읽기'가 그 사이에
  // 추가한 거래를 덮어써 사라지게 할 수 있다. 그래서 한 줄로 세워 처리한다.
  //  - 변경이 들어올 때마다 번호(changeSeq)를 올린다
  //  - 쓰는 동안 새 변경이 오면 최신 DB로 다시 쓴다
  //  - 다시 읽는 동안 새 변경이 오면 읽은 결과를 버리고 다시 쓴다
  // 진행 중인 저장이 있으면 새 호출은 그 저장에 합류한다 (같은 Promise를 돌려줌).
  const saveAndReload = useCallback((currentDb) => {
    changeSeqRef.current += 1;
    latestDbRef.current = currentDb;
    if (saveLoopRef.current) return saveLoopRef.current;

    const run = async () => {
      setError('');
      for (;;) {
        const seq = changeSeqRef.current;

        setSaving(true);
        try {
          await writeDbToOneDrive(instance, accounts, exportDatabase(latestDbRef.current));
        } catch (e) {
          setError(`저장 실패: ${e.message}`);
          return;
        } finally {
          setSaving(false);
        }
        if (seq !== changeSeqRef.current) continue;
        setDirty(false);

        setLoading(true);
        try {
          const SQL = await initSQL();
          const data = await readDbFromOneDrive(instance, accounts);
          if (seq !== changeSeqRef.current) continue;
          const { db: newDb, didMigrate } = createDatabase(SQL, data);
          if (didMigrate) {
            try {
              await writeDbToOneDrive(instance, accounts, exportDatabase(newDb));
            } catch (e) {
              setError(`저장 실패: ${e.message}`);
            }
          }
          if (seq !== changeSeqRef.current) continue;
          setDb(newDb);
          return;
        } catch (e) {
          setError(`새로고침 실패: ${e.message}`);
          return;
        } finally {
          setLoading(false);
        }
      }
    };

    saveLoopRef.current = run().finally(() => { saveLoopRef.current = null; });
    return saveLoopRef.current;
  }, [instance, accounts]);

  const handleAdd = useCallback(async (txData, { keepOpen = false } = {}) => {
    // 분할 결제는 거래 2건으로 들어온다
    const rows = Array.isArray(txData) ? txData : [txData];
    rows.forEach(row => addTransaction(db, row));

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
    showToast(keepOpen ? `✓ ${label} 추가 — 저장 중…` : '저장 중…');
    await saveAndReload(db);
    showToast(`✓ ${label} 추가됨`);
  }, [db, showToast, saveAndReload]);

  // 말로 입력한 여러 건을 한 번에 추가
  const handleBulkAdd = useCallback(async (rows) => {
    if (!rows.length) return;
    rows.forEach(row => addTransaction(db, row));
    setShowForm(false);
    setEditingTx(null);
    window.history.back();
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    showToast('저장 중…');
    await saveAndReload(db);
    showToast(`✓ ${rows.length}건 ${total.toLocaleString()}원 추가됨`);
  }, [db, showToast, saveAndReload]);

  const handleUpdate = useCallback(async (txData) => {
    // 분할 결제는 묶음 전체를 한 번에 반영한다.
    // id가 있으면 갱신, 없으면 새로 만들고, 묶음에 있었는데 빠진 건 삭제한다.
    const rows = Array.isArray(txData) ? txData : [txData];
    const priorIds = editingTx.split_group_id
      ? getSplitGroupTransactions(db, editingTx.split_group_id).map(t => t.id)
      : [editingTx.id];

    const keptIds = new Set(rows.map(r => r.id).filter(Boolean));
    rows.forEach(row => {
      if (row.id) updateTransaction(db, row.id, row);
      else addTransaction(db, row);
    });
    priorIds.filter(id => !keptIds.has(id)).forEach(id => deleteTransaction(db, id));

    setShowForm(false);
    setEditingTx(null);
    window.history.back();
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const amt = total.toLocaleString();
    showToast(`저장 중…`);
    await saveAndReload(db);
    showToast(rows.length > 1
      ? `✓ ${rows[0].budget_category} ${amt}원 분할 ${rows.length}건 수정됨`
      : `✓ ${rows[0].budget_category} ${amt}원 수정 및 저장됨`);
  }, [db, editingTx, showToast, saveAndReload]);

  const handleDelete = useCallback(async (id) => {
    deleteTransaction(db, id);
    showToast('저장 중…');
    await saveAndReload(db);
    showToast('✓ 거래가 삭제되었습니다');
  }, [db, showToast, saveAndReload]);

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
            goTodayKey={listGoTodayKey}
            onAdd={openAdd}
            onEdit={openEdit}
            onDelete={handleDelete}
            onChanged={async () => {
              await saveAndReload(db);
            }}
            onOpenImport={() => navigate({ showImport: true })}
            onOpenCardCheck={() => navigate({ showCardCheck: true })}
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
            goTodayKey={calendarGoTodayKey}
            onChanged={async () => {
              showToast('저장 중…');
              await saveAndReload(db);
              showToast('✓ 저장됨');
            }}
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
            drilldown={accountDrilldown}
            detailTab={accountDetailTab}
            showForm={showAccountForm}
            onDrilldownChange={(v) => navigate({ accountDrilldown: v })}
            onDetailTabChange={(t) => navigate({ accountDetailTab: t })}
            onCloseForm={() => setShowAccountForm(false)}
            onChanged={async () => {
              showToast('저장 중…');
              runAccountAutoRegister(db);
              await saveAndReload(db);
              showToast('✓ 저장됨');
            }}
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
          onChanged={() => saveAndReload(db)}
          onClose={() => { setShowCardCheck(false); window.history.back(); }}
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
