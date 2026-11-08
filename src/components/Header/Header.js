import React from 'react';
import { useMsal } from '@azure/msal-react';
import './Header.css';

function Header({ onRefresh, onSave, onLogout, loading, saving, dirty, offline = false, pendingCount = 0, onSettings, settingsActive }) {
  const { accounts } = useMsal();
  const userName = accounts[0]?.name || accounts[0]?.username?.split('@')[0] || '';

  return (
    <header className="app-header">
      <div className="header-left">
        <img src="/favicon_b2.ico" alt="" className="header-logo" />
        <span className="header-title">지금 가계부</span>
      </div>
      <div className="header-right">
        {offline && (
          // 연결이 없어 OneDrive에 닿지 못하는 중 (I-024) — 입력은 이 기기에 보관했다가 연결되면 저장한다
          <span className="header-offline" title="연결이 없습니다 — 입력한 내용은 이 기기에 보관했다가 연결되면 저장합니다">
            오프라인
          </span>
        )}
        {(dirty || saving) && (
          <button
            className="btn-header btn-save"
            onClick={onSave}
            disabled={saving}
            title={saving ? 'OneDrive에 저장 중' : `저장 안 된 변경 ${pendingCount}건 — 눌러서 다시 저장`}
          >
            {saving ? '저장 중…' : `저장 안 됨${pendingCount ? ` ${pendingCount}` : ''}`}
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
        <button className="btn-header btn-user" onClick={onLogout} title="로그아웃">
          {userName || '로그아웃'}
        </button>
      </div>
    </header>
  );
}

export default Header;
