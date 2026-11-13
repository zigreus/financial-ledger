import React from 'react';
import { useMsal } from '@azure/msal-react';
import { currentDriveName } from '../../services/storage/driveName';
import './Header.css';

// userLabel: Microsoft가 아닌 계정(Google, M-1)으로 로그인했을 때 보일 이름
// offlineLabel·offlineTitle: 저장소에 닿지 못하는 이유가 연결이 아니라 로그인 만료일 때(Google, M-1) 바꿔 보인다
// catchingUp: 받기가 느려 이 기기의 사본으로 먼저 열고 뒤에서 받는 중 — '오프라인'이 아니다(받으면 사라진다)
// onCover: '가계부를 열 때 가리기'(U-7)를 켰을 때 — 지금 바로 화면을 가리는 버튼
// ledgerName·onSwitchLedger: 다른 계정이 공유한 가계부(M-2) — 제목 자리에 지금 가계부 이름, 누르면 가계부 바꾸기
function Header({
  onRefresh, onSave, onLogout, onCover, ledgerName = '', onSwitchLedger = null, loading, saving, dirty, offline = false, catchingUp = false, pendingCount = 0, onSettings, settingsActive, userLabel,
  offlineLabel = '오프라인', offlineTitle = '연결이 없습니다 — 입력한 내용은 이 기기에 보관했다가 연결되면 저장합니다',
}) {
  const { accounts } = useMsal();
  const userName = userLabel || accounts[0]?.name || accounts[0]?.username?.split('@')[0] || '';
  const drive = currentDriveName();

  return (
    <header className="app-header">
      <div className="header-left">
        <img src="/favicon_b2.ico" alt="" className="header-logo" />
        {onSwitchLedger ? (
          <button type="button" className="header-title header-title-btn" onClick={onSwitchLedger} title="가계부 바꾸기">
            {ledgerName || '지금 가계부'} <span className="header-title-caret" aria-hidden="true">▾</span>
          </button>
        ) : (
          <span className="header-title">{ledgerName || '지금 가계부'}</span>
        )}
      </div>
      <div className="header-right">
        {offline && (
          // 연결이 없어 OneDrive에 닿지 못하는 중 (I-024) — 입력은 이 기기에 보관했다가 연결되면 저장한다
          <span className="header-offline" title={offlineTitle}>
            {offlineLabel}
          </span>
        )}
        {catchingUp && !offline && (
          <span className="header-offline header-catching-up" title={`이 기기에 둔 가계부로 먼저 열었습니다 — ${drive}에서 최신 가계부를 받는 중이고, 받으면 바로 바꿉니다`}>
            맞추는 중
          </span>
        )}
        {(dirty || saving) && (
          <button
            className="btn-header btn-save"
            onClick={onSave}
            disabled={saving}
            title={saving ? `${drive}에 저장 중` : `저장 안 된 변경 ${pendingCount}건 — 눌러서 다시 저장`}
          >
            {saving ? '저장 중…' : `저장 안 됨${pendingCount ? ` ${pendingCount}` : ''}`}
          </button>
        )}
        {/* 오프라인과 저장 안 됨 표시가 함께 있으면 자리가 모자라 숨긴다(설정에서 켜 둔 가리기는 그대로).
            거래를 넣은 직후(저장 중)에도 바로 가릴 수 있게 하나만 있을 때는 둔다 */}
        {onCover && !(offline && (dirty || saving)) && (
          <button className="btn-header btn-cover" onClick={onCover} title="화면 가리기" aria-label="화면 가리기">🔒</button>
        )}
        <button
          className="btn-header btn-refresh"
          onClick={onRefresh}
          disabled={loading}
          title={`${drive}에서 새로고침`}
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
