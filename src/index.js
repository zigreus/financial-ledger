import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './components/App/App';
import { MsalProvider } from '@azure/msal-react';
import { msalInstance } from './auth/msalConfig';
import { registerServiceWorker } from './services/serviceWorker';
import {
  completeGoogleRedirect, rememberGoogleResult, shouldReconnectAtStart, startGoogleLogin,
} from './auth/googleAuth';

// 연결 없이 열기·공유 받기 (I-024)
registerServiceWorker();

/**
 * Google 로그인 (M-1) — MSAL보다 먼저 주소의 #access_token을 받는다(MSAL이 남의 해시를 건드리지 않게).
 * 이 기기가 Google 계정을 쓰는데 토큰이 끝났고 실제로 연결되면(짧게 확인), 화면을 그리기 전에 Google에 잠깐 다녀와
 * 새 토큰을 받는다(이미 허락한 계정이면 화면 없이 돌아온다). 연결되지 않으면 그대로 열어 이 기기 사본으로 쓴다.
 * 방금 돌아왔는데 실패했으면 다시 가지 않는다(무한 이동 방지 — 앱이 '다시 연결'과 안내를 보인다). 이동했으면 true.
 */
async function prepareGoogle() {
  const result = await completeGoogleRedirect();
  rememberGoogleResult(result);
  if (result.handled) return false;
  if (await shouldReconnectAtStart()) {
    try {
      startGoogleLogin({ silent: true });
      return true;
    } catch (e) {
      rememberGoogleResult({ handled: true, ok: false, error: e.message });
    }
  }
  return false;
}

prepareGoogle()
  .catch(() => false)
  .then(async (redirecting) => {
    if (redirecting) return; // 페이지가 Google로 넘어가는 중 — 돌아오면 다시 시작한다
    await msalInstance.initialize();
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(
      <React.StrictMode>
        <MsalProvider instance={msalInstance}>
          <App />
        </MsalProvider>
      </React.StrictMode>
    );
  });
