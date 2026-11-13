/**
 * 인터넷이 되는지 — 저장소(OneDrive·Google Drive)에 닿지 못했을 때, 이 기기의 연결 문제인지 저장소 쪽 문제(장애)인지 가른다 (I-058).
 *
 * 이 앱 자신의 사이트에 아주 작은 요청(HEAD)을 보낸다 — 외부 서비스에 묻지 않는다(운영자·제3자에게 가는 데이터 없음, AGENTS §1).
 * 서비스 워커는 GET만 다루므로 HEAD는 언제나 실제 네트워크로 나간다(public/sw.js). 응답이 오면(상태와 관계없이) 인터넷은 된다.
 */
const PROBE_TIMEOUT_MS = 5000;

export async function internetReachable({ fetchImpl, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const doFetch = fetchImpl || (typeof fetch === 'function' ? (...a) => fetch(...a) : null);
  if (!doFetch) return false;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    await doFetch(`/robots.txt?reach=${Date.now()}`, { method: 'HEAD', cache: 'no-store', signal: ctrl?.signal });
    return true;
  } catch (e) {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
