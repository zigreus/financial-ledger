import React, { useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { loginRequest } from '../../auth/msalConfig';
import { AZURE_CLIENT_ID } from '../../config';
import './LoginPage.css';

function LoginPage() {
  const { instance, inProgress } = useMsal();
  const [error, setError] = useState('');
  const busy = inProgress !== InteractionStatus.None;

  // 모바일 홈 화면 앱에서는 팝업이 막힐 수 있어 리다이렉트로 로그인한다 (B-016).
  // 토큰 재인증(oneDriveService)도 리다이렉트라 방식이 하나로 통일된다.
  const handleLogin = async () => {
    if (busy) return;
    setError('');
    try {
      await instance.loginRedirect(loginRequest);
    } catch (e) {
      setError('로그인에 실패했습니다. 다시 시도해주세요.');
      console.error(e);
    }
  };

  const isConfigured = AZURE_CLIENT_ID !== 'YOUR_CLIENT_ID_HERE';

  return (
    <div className="login-page">
      <div className="login-card">
        <img src="/favicon_b2.ico" alt="" className="login-icon" />
        <h1>지금 가계부</h1>
        <p className="login-subtitle">가족 모두가 함께 쓰는 스마트 가계부</p>

        {isConfigured ? (
          <>
            <button className="btn-login" onClick={handleLogin} disabled={busy}>
              <span className="ms-icon">⊞</span>
              {busy ? '로그인 중…' : 'Microsoft 계정으로 로그인'}
            </button>
            {error && <p className="login-error">{error}</p>}
          </>
        ) : (
          <div className="config-warning">
            <p>⚠️ <strong>설정 필요</strong></p>
            <p><code>src/config.js</code>에서<br /><code>AZURE_CLIENT_ID</code>를 입력해주세요.</p>
            <a
              className="btn-outline"
              href="https://portal.azure.com"
              target="_blank"
              rel="noreferrer"
            >
              Azure Portal 열기
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export default LoginPage;
