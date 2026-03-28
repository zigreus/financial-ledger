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

  // 로그인 후 DB 자동 로드
  useEffect(() => {
    if (isAuthenticated && accounts.length > 0 && !db) {
      loadDb();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, accounts]);

  const loadDb = useCallback(async () => {
    if (loading) return;
    if (dirty) {
      const ok = window.confirm('저장하지 않은 변경사항이 있습니다. 새로고침하면 변경사항이 사라집니다. 계속하시겠습니까?');
      if (!ok) return;
    }
    setLoading(true);
    setError('');
    try {
      const SQL = await initSQL();
      const data = await readDbFromOneDrive(instance, accounts);
      const newDb = createDatabase(SQL, data);
      setDb(newDb);
      setDirty(false);
    } catch (e) {
      setError(`로드 실패: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [loading, dirty, instance, accounts]);

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

  const handleAdd = useCallback((txData) => {
    addTransaction(db, txData);
    setDb(db); // 같은 참조지만 리렌더 트리거용
    setDirty(true);
    setShowForm(false);
    setEditingTx(null);
    // 강제 리렌더를 위해 db 상태 재설정
    setDb(prev => prev);
  }, [db]);

  const handleUpdate = useCallback((txData) => {
    updateTransaction(db, editingTx.id, txData);
    setDirty(true);
    setShowForm(false);
    setEditingTx(null);
    setDb(prev => prev);
  }, [db, editingTx]);

  const handleDelete = useCallback((id) => {
    deleteTransaction(db, id);
    setDirty(true);
    setDb(prev => prev);
  }, [db]);

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

  const handleImport = useCallback(() => {
    setDirty(true);
    setDb(prev => prev);
    setShowImport(false);
  }, []);

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

      {error && (
        <div className="error-banner" onClick={() => setError('')}>
          ⚠️ {error} (탭하여 닫기)
        </div>
      )}

      {dirty && (
        <div className="unsaved-banner">
          저장되지 않은 변경사항이 있습니다 — 저장 버튼을 눌러 OneDrive에 동기화하세요.
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
            onChanged={() => { setDirty(true); setDb(prev => prev); }}
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
          onClick={() => setActiveTab('summary')}
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
          onClick={() => setActiveTab('settings')}
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
