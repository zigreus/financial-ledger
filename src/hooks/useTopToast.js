import { useState, useRef, useEffect, useCallback } from 'react';
import { isPageHidden, whenVisible } from '../services/pageVisibility';

/** 화면 위 알림이 떠 있는 시간 — 누를 수 있는 알림(되돌리기)은 더 오래 */
export const TOP_TOAST_MS = { action: 10000, plain: 3000 };

/**
 * 화면 위에 띄우는 알림 (I-022) — 입력 창(모달) 위에도 보이고, 일반 알림이 덮지 않는다.
 * 화면이 꺼져 있거나 다른 앱에 가 있는 동안에는 시간을 세지 않는다 — 가려지는 순간 멈추고, 돌아오면 처음부터 센다(I-023).
 * (가려진 동안 타이머가 얼었다가 돌아온 뒤 밀려 실행되는 브라우저도 있어, 가려질 때 타이머를 지운다)
 * 반환: { topToast: { text, action } | null, showTopToast(text, action?), hideTopToast() }
 *   action: { label, onClick } — '되돌리기'처럼 누를 수 있는 알림
 */
export function useTopToast() {
  const [topToast, setTopToast] = useState(null);
  const timerRef = useRef(null);
  const waitRef = useRef(null);  // 화면이 다시 보이기를 기다리는 중이면 그만두는 함수
  const watchRef = useRef(null); // 알림이 떠 있는 동안 가려짐을 지켜보기 — 그만두는 함수

  const stop = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
    if (waitRef.current) { waitRef.current(); waitRef.current = null; }
    if (watchRef.current) { watchRef.current(); watchRef.current = null; }
  }, []);

  const showTopToast = useCallback((text, action = null) => {
    stop();
    setTopToast({ text, action });
    const ms = action ? TOP_TOAST_MS.action : TOP_TOAST_MS.plain;
    const arm = () => {
      waitRef.current = null;
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (isPageHidden()) { pause(); return; }
        stop();
        setTopToast(null);
      }, ms);
    };
    // 가려지면 세던 시간을 버리고 돌아오기를 기다린다
    const pause = () => {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      if (!waitRef.current) waitRef.current = whenVisible(arm);
    };
    if (typeof document !== 'undefined' && document.addEventListener) {
      const onVisibility = () => { if (isPageHidden()) pause(); };
      document.addEventListener('visibilitychange', onVisibility);
      watchRef.current = () => document.removeEventListener('visibilitychange', onVisibility);
    }
    // 가려진 채 뜬 알림(백그라운드에서 분석이 끝남)은 돌아온 뒤부터 센다
    if (isPageHidden()) pause();
    else arm();
  }, [stop]);

  const hideTopToast = useCallback(() => {
    stop();
    setTopToast(null);
  }, [stop]);

  useEffect(() => stop, [stop]);

  return { topToast, showTopToast, hideTopToast };
}
