/**
 * 화면이 꺼지거나 다른 앱으로 갔다 돌아오는 것 (I-023).
 * 휴대폰 브라우저(특히 홈 화면에 추가한 앱)는 화면이 가려지면 페이지를 멈추고, 그동안 보내던 요청을 끊기도 한다.
 * 요청하는 동안 가려진 적이 있는지 지켜보고, 돌아오면 다시 보낼 수 있게 기다리는 도우미.
 */

const hasDocument = () => typeof document !== 'undefined' && !!document.addEventListener;

/** 지금 화면이 가려져 있는지 (꺼짐·다른 앱·다른 탭) */
export function isPageHidden() {
  return hasDocument() && document.visibilityState === 'hidden';
}

/**
 * 지금부터 화면이 가려진 적이 있는지 지켜본다 — { wasHidden(), stop() }.
 * 지켜보기 시작할 때 이미 가려져 있었어도 가려진 것으로 본다.
 */
export function watchHidden() {
  let hidden = isPageHidden();
  if (!hasDocument()) return { wasHidden: () => false, stop: () => {} };
  const onVisibility = () => { if (isPageHidden()) hidden = true; };
  // pagehide·freeze: 보이는 상태 그대로 페이지를 멈추는(그 사이 요청을 끊는) 브라우저도 있다 — 조건 없이 가려진 것으로 본다
  const onSuspend = () => { hidden = true; };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onSuspend);
  document.addEventListener('freeze', onSuspend);
  const stop = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onSuspend);
    document.removeEventListener('freeze', onSuspend);
  };
  return { wasHidden: () => hidden || isPageHidden(), stop };
}

function abortError() {
  const e = new Error('요청을 취소했습니다');
  e.name = 'AbortError';
  return e;
}

/** 화면이 다시 보일 때까지 기다린다 (이미 보이면 바로). signal로 취소하면 AbortError */
export function waitUntilVisible(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    if (!isPageHidden()) { resolve(); return; }
    const done = () => {
      document.removeEventListener('visibilitychange', onChange);
      signal?.removeEventListener('abort', onAbort);
    };
    const onChange = () => { if (!isPageHidden()) { done(); resolve(); } };
    const onAbort = () => { done(); reject(abortError()); };
    document.addEventListener('visibilitychange', onChange);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 연결이 끊겨 있으면(navigator.onLine === false) 다시 이어질 때까지 최대 ms만 기다린다.
 * 화면을 켠 직후에는 휴대폰이 망에 다시 붙는 데 잠깐 걸린다. 기다려도 안 되면 그냥 돌아간다(다음 요청이 오류를 알린다)
 */
export function waitForOnline(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    if (typeof navigator === 'undefined' || navigator.onLine !== false || typeof window === 'undefined') { resolve(); return; }
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('online', onOnline);
      signal?.removeEventListener('abort', onAbort);
    };
    const onOnline = () => { done(); resolve(); };
    const onAbort = () => { done(); reject(abortError()); };
    timer = setTimeout(() => { done(); resolve(); }, ms);
    window.addEventListener('online', onOnline);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 화면이 보일 때 fn을 한 번 부른다(지금 보이면 바로). 반환: 기다리기를 그만두는 함수
 * — 다른 앱에 가 있는 동안에는 알림의 시간을 세지 않을 때 쓴다
 */
export function whenVisible(fn) {
  if (!isPageHidden()) { fn(); return () => {}; }
  const onChange = () => {
    if (isPageHidden()) return;
    document.removeEventListener('visibilitychange', onChange);
    fn();
  };
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}
