import React from 'react';
import { useMsal } from '@azure/msal-react';
import './Header.css';

function Header({ onRefresh, onSave, loading, saving, dirty, onSettings, settingsActive }) {
  const { accounts, instance } = useMsal();
  const userName = accounts[0]?.name || accounts[0]?.username?.split('@')[0] || '';

  const handleLogout = () => {
    instance.logoutPopup().catch(console.error);
  };

  return (
    <header className="app-header">
      <div className="header-left">
        <img src="/favicon_b2.ico" alt="" className="header-logo" />
        <span className="header-title">지금 가계부</span>
      </div>
      <div className="header-right">
        {dirty && (
          <button
            className="btn-header btn-save"
            onClick={onSave}
            disabled={saving}
            title="OneDrive에 저장"
          >
            {saving ? '저장 중…' : '저장'}
          </button>
        )}
        <button
          className="btn-header btn-refresh"
          onClick={onRefresh}
          disabled={loading}
          title="OneDrive에서 새로고침"
        >
          {loading ? '⏳' : '🔄'}
        </button>
        <button
          className={`btn-header btn-settings${settingsActive ? ' active' : ''}`}
          onClick={onSettings}
          title="설정"
        >
          ⚙️
        </button>
        <button className="btn-header btn-user" onClick={handleLogout} title="로그아웃">
          {userName || '로그아웃'}
        </button>
      </div>
    </header>
  );
}

export default Header;
