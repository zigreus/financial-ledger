import React, { useEffect, useState } from 'react';
import { startGoogleLogin, peekGoogleNotice, clearGoogleNotice } from '../../auth/googleAuth';
import { allowNextUnload } from '../../hooks/useLedgerSync';
import './GoogleReconnectBanner.css';

/**
 * Google 연결 시간이 끝났을 때 (M-1, I-031) — 서버 없이 쓰는 Google 로그인은 약 1시간마다 토큰이 끝난다.
 * 입력한 내용은 이 기기에 보관되고(연결 없음과 같은 처리), 누르면 Google에 다녀와(이미 허락한 계정이면 화면 없이,
 * Google이 확인을 원하면 계정 확인 화면) 돌아온 뒤 보관한 변경을 저장한다. 입력 중인 화면을 저절로 떠나지 않는다.
 * pending: 아직 저장하지 못한 변경 수(보관 중)
 */
export default function GoogleReconnectBanner({ email, pending = 0 }) {
  const [busy, setBusy] = useState(false);
  const [notice] = useState(() => peekGoogleNotice());   // 방금 다녀왔는데 실패한 이유(직접 로그인 필요 등)
  const [problem, setProblem] = useState('');

  // 뒤로 가기로 돌아와(bfcache) 버튼이 '이동 중'으로 굳지 않게
  useEffect(() => {
    const onShow = () => setBusy(false);
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  const reconnect = () => {
    if (busy) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setProblem('지금은 연결이 없어요 — 연결된 뒤 다시 눌러 주세요. 입력한 내용은 이 기기에 보관 중이에요.');
      return;
    }
    setBusy(true);
    setProblem('');
    clearGoogleNotice();
    try {
      // 보관한 변경은 이미 이 기기에 있다 — 떠날 때 브라우저의 '저장되지 않을 수 있음' 경고를 띄우지 않는다
      allowNextUnload();
      startGoogleLogin({ reconnect: true });
    } catch (e) {
      setBusy(false);
      setProblem(e.message || 'Google로 이동하지 못했습니다');
    }
  };
  return (
    <div className="g-reconnect" role="status">
      <span className="g-reconnect-text">
        Google 연결 시간이 끝났어요{email ? `(${email})` : ''}.
        {pending > 0 ? ` 저장 안 된 변경 ${pending}건은 이 기기에 보관 중이에요.` : ' 새로 입력한 내용은 이 기기에 보관했다가 저장해요.'}
        {notice && <span className="g-reconnect-notice"> {notice}</span>}
        {problem && <span className="g-reconnect-notice"> {problem}</span>}
      </span>
      <button type="button" className="g-reconnect-btn" onClick={reconnect} disabled={busy}>
        {busy ? '이동 중…' : '다시 연결'}
      </button>
    </div>
  );
}
