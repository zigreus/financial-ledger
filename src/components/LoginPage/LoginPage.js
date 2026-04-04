import React, { useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../../auth/msalConfig';
import { AZURE_CLIENT_ID } from '../../config';
import './LoginPage.css';

function LoginPage() {
  const { instance } = useMsal();
  const [error, setError] = useState('');

  const handleLogin = async () => {
    setError('');
    try {
      await instance.loginPopup(loginRequest);
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
            <button className="btn-login" onClick={handleLogin}>
              <span className="ms-icon">⊞</span>
              Microsoft 계정으로 로그인
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
