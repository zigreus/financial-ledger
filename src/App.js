import React, { useState, useCallback, useEffect } from 'react';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import './App.css';

import LoginPage from './components/LoginPage';
import Header from './components/Header';
import TransactionList from './components/TransactionList';
import TransactionForm from './components/TransactionForm';
import SummaryView from './components/SummaryView';
import SettingsView from './components/SettingsView';
import ImportModal from './components/ImportModal';

import { initSQL, createDatabase, exportDatabase, addTransaction, updateTransaction, deleteTransaction } from './services/dbManager';
import { readDbFromOneDrive, writeDbToOneDrive } from './services/oneDriveService';

function App() {
  const isAuthenticated = useIsAuthenticated();
  const { instance, accounts } = useMsal();

  const [db, setDb] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('list'); // 'list' | 'summary' | 'settings'
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editingTx, setEditingTx] = useState(null);
  const [toast, setToast] = useState('');
  const toastTimer = React.useRef(null);

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  }, []);

  // 로그인 후 DB 자동 로드
  useEffect(() => {
    if (isAuthenticated && accounts.length > 0 && !db) {
      loadDb();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, accounts]);

  const loadDb = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      const SQL = await initSQL();
      const data = await readDbFromOneDrive(instance, accounts);
      const { db: newDb, didMigrate } = createDatabase(SQL, data);
      setDb(newDb);
      if (didMigrate) {
        try {
          const bytes = exportDatabase(newDb);
          await writeDbToOneDrive(instance, accounts, bytes);
        } catch (e) {
          setError(`마이그레이션 저장 실패: ${e.message}`);
        }
      }
      setDirty(false);
    } catch (e) {
      setError(`로드 실패: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [loading, instance, accounts]);

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
    const amt = Number(txData.amount).toLocaleString();
    showToast(`저장 중…`);
    await saveAndReload(db);
    showToast(`✓ ${txData.budget_category} ${amt}원 추가됨`);
  }, [db, showToast, saveAndReload]);

  const handleUpdate = useCallback(async (txData) => {
    updateTransaction(db, editingTx.id, txData);
    setShowForm(false);
    setEditingTx(null);
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
    setEditingTx(null);
    setShowForm(true);
  };

  const openEdit = (tx) => {
    setEditingTx(tx);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingTx(null);
  };

  const handleImport = useCallback(async () => {
    setShowImport(false);
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
          />
        )}
        {activeTab === 'summary' && (
          <SummaryView db={db} />
        )}
        {activeTab === 'settings' && (
          <SettingsView
            db={db}
            onChanged={async () => {
              showToast('저장 중…');
              await saveAndReload(db);
              showToast('✓ 설정이 저장됨');
            }}
          />
        )}
      </main>

      {/* 하단 네비게이션 */}
      <nav className="bottom-nav">
        <button
          className={activeTab === 'list' ? 'nav-item active' : 'nav-item'}
          onClick={() => setActiveTab('list')}
        >
          <span className="nav-icon">📋</span>
          <span className="nav-label">거래내역</span>
        </button>
        <button
          className={activeTab === 'summary' ? 'nav-item active' : 'nav-item'}
          onClick={() => { setActiveTab('summary'); document.querySelector('.app-main')?.scrollTo(0, 0); }}
        >
          <span className="nav-icon">📊</span>
          <span className="nav-label">요약</span>
        </button>
        <button className="nav-item nav-add" onClick={openAdd}>
          <span className="nav-icon-add">+</span>
        </button>
        <button className="nav-item" onClick={() => setShowImport(true)}>
          <span className="nav-icon">📥</span>
          <span className="nav-label">가져오기</span>
        </button>
        <button
          className={activeTab === 'settings' ? 'nav-item active' : 'nav-item'}
          onClick={() => { setActiveTab('settings'); document.querySelector('.app-main')?.scrollTo(0, 0); }}
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
          onClose={() => setShowImport(false)}
        />
      )}
    </div>
  );
}

export default App;
