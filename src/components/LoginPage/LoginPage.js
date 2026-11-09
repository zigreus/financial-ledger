import React, { useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { loginRequest } from '../../auth/msalConfig';
import { AZURE_CLIENT_ID } from '../../config';
import { isGoogleConfigured, startGoogleLogin, peekGoogleNotice, clearGoogleNotice } from '../../auth/googleAuth';
import './LoginPage.css';

function LoginPage() {
  const { instance, inProgress } = useMsal();
  // Google에서 돌아왔는데 실패한 이유 — 보기만 하고(개발 모드에서 두 번 그려도 사라지지 않게) 다음 동작 때 지운다
  const [error, setError] = useState(() => peekGoogleNotice());
  const [googleBusy, setGoogleBusy] = useState(false);
  const busy = inProgress !== InteractionStatus.None || googleBusy;

  // Google 화면에서 뒤로 와(bfcache) 버튼이 '이동 중'으로 굳지 않게
  useEffect(() => {
    const onShow = () => setGoogleBusy(false);
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  // 모바일 홈 화면 앱에서는 팝업이 막힐 수 있어 리다이렉트로 로그인한다 (B-016).
  // 토큰 재인증(services/storage/oneDrive.js)도 리다이렉트라 방식이 하나로 통일된다.
  const handleLogin = async () => {
    if (busy) return;
    setError('');
    clearGoogleNotice();
    try {
      await instance.loginRedirect(loginRequest);
    } catch (e) {
      setError('로그인에 실패했습니다. 다시 시도해주세요.');
      console.error(e);
    }
  };

  // Google도 페이지 이동으로 로그인한다(M-1) — 돌아오면 index.js가 토큰을 받는다
  const handleGoogleLogin = () => {
    if (busy) return;
    setError('');
    clearGoogleNotice();
    setGoogleBusy(true);
    try {
      startGoogleLogin();
    } catch (e) {
      setGoogleBusy(false);
      setError(e.message || 'Google 로그인을 시작하지 못했습니다');
    }
  };

  const isConfigured = AZURE_CLIENT_ID !== 'YOUR_CLIENT_ID_HERE';
  const googleOn = isGoogleConfigured();

  return (
    <div className="login-page">
      <div className="login-card">
        <img src="/favicon_b2.ico" alt="" className="login-icon" />
        <h1>지금 가계부</h1>
        <p className="login-subtitle">가족 모두가 함께 쓰는 스마트 가계부</p>

        {isConfigured || googleOn ? (
          <>
            {isConfigured && (
              <button className="btn-login" onClick={handleLogin} disabled={busy}>
                <span className="ms-icon">⊞</span>
                {inProgress !== InteractionStatus.None ? '로그인 중…' : 'Microsoft 계정으로 로그인'}
              </button>
            )}
            {googleOn && (
              <>
                <button className="btn-login btn-login--google" onClick={handleGoogleLogin} disabled={busy}>
                  <span className="g-icon" aria-hidden="true">G</span>
                  {googleBusy ? 'Google로 이동 중…' : 'Google 계정으로 로그인'}
                </button>
                <p className="login-hint">
                  가계부는 고른 계정의 드라이브(OneDrive 또는 Google Drive)에만 저장돼요.
                  Google은 이 앱이 만든 파일만 볼 수 있게 허락을 받습니다.
                </p>
              </>
            )}
            {error && <p className="login-error" role="alert">{error}</p>}
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
