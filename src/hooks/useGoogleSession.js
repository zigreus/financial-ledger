import { useEffect, useState } from 'react';
import { getGoogleSession, isGoogleTokenValid, onGoogleSessionChange } from '../auth/googleAuth';

/**
 * 이 기기의 Google 세션 (M-1, I-031) — { session, tokenValid }.
 * session은 토큰이 만료돼도 남는다(계정·이 기기 사본을 알기 위해). tokenValid가 거짓이면 앱이 '다시 연결'을 보인다.
 * 로그인·로그아웃·만료 표시가 있을 때와, 앱으로 돌아오거나 1분마다 다시 확인한다(토큰은 시간이 지나면 저절로 만료된다).
 */
export function useGoogleSession() {
  const read = () => {
    const session = getGoogleSession();
    return { session, tokenValid: isGoogleTokenValid(session) };
  };
  const [state, setState] = useState(read);

  useEffect(() => {
    const refresh = () => setState(prev => {
      const next = read();
      return prev.session?.sub === next.session?.sub && prev.session?.accessToken === next.session?.accessToken
        && prev.tokenValid === next.tokenValid ? prev : next;
    });
    const off = onGoogleSessionChange(refresh);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(refresh, 60 * 1000);
    return () => { off(); document.removeEventListener('visibilitychange', onVisible); clearInterval(timer); };
  }, []);

  return state;
}
