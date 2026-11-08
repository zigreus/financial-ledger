/**
 * 서비스 워커 등록 (I-024) — 배포한 앱에서만. 개발 서버(npm start)에서는 등록하지 않는다(캐시가 고친 코드를 가리지 않게).
 * 워커는 public/sw.js: 연결 없이 열기(앱 화면 보관)와 안드로이드 공유 받기를 맡는다.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 지원하지 않거나 막힘 — 연결이 있을 때처럼 쓸 수 있다 */ });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
