/**
 * MSAL이 로그인 서버와 주고받는 통신 — 기본(FetchClient)과 같고, 응답이 오지 않으면 끊는다 (B-094).
 *
 * MSAL은 같은 계정·권한의 토큰 요청을 하나로 묶어 두고 그 요청이 끝나야 풀어 준다. 기본 통신에는 제한 시간이 없어,
 * 약한 LTE에서 토큰 갱신 요청이 멈추면 그 뒤의 모든 토큰 요청(가계부 받기·저장·다시 시도)이 같은 멈춘 요청에 붙어
 * 앱을 다시 열 때까지 '오프라인'에서 풀리지 않는다. 여기서 끊으면 그 요청이 실패로 끝나 묶음이 풀리고, 다음 시도는 새로 보낸다.
 * 토큰 응답은 작아 걸린 시간으로 끊는다(가계부 파일처럼 조각을 셀 것이 없다).
 * 실패는 기본과 같은 오류 코드로 돌려준다 — 저장소가 연결 없음으로 알아본다(oneDrive.js MSAL_NETWORK_ERRORS).
 */
import { BrowserAuthError, BrowserAuthErrorCodes } from '@azure/msal-browser';

export const MSAL_REQUEST_TIMEOUT_MS = 30000;

const headersOf = (options) => {
  const headers = new Headers();
  Object.entries(options?.headers || {}).forEach(([k, v]) => headers.append(k, v));
  return headers;
};

const dictOf = (headers) => {
  const out = {};
  headers.forEach((v, k) => { out[k] = v; });
  return out;
};

export function createTimedNetworkClient({ timeoutMs = MSAL_REQUEST_TIMEOUT_MS, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));

  async function send(method, url, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await doFetch(url, {
          method,
          headers: headersOf(options),
          ...(method === 'POST' ? { body: options?.body || '' } : {}),
          signal: ctrl.signal,
        });
      } catch (e) {
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        // 제한 시간으로 끊은 것은 subError로 구별한다 — 문제 알리기 기록에서 '응답 없음'과 '바로 실패'를 가를 수 있게 (B-095)
        throw new BrowserAuthError(offline ? BrowserAuthErrorCodes.noNetworkConnectivity
          : method === 'POST' ? BrowserAuthErrorCodes.postRequestFailed : BrowserAuthErrorCodes.getRequestFailed,
        ctrl.signal.aborted ? `timeout ${Math.round(timeoutMs / 1000)}s` : `${e?.name || 'Error'}: ${e?.message || ''}`.slice(0, 120));
      }
      const headers = dictOf(res.headers);
      let body;
      try {
        body = await res.json();
      } catch (e) {
        // 받다가 끊었으면 연결 문제로 — 내용이 JSON이 아니면 기본과 같은 오류
        if (ctrl.signal.aborted) throw new BrowserAuthError(method === 'POST' ? BrowserAuthErrorCodes.postRequestFailed : BrowserAuthErrorCodes.getRequestFailed, `timeout ${Math.round(timeoutMs / 1000)}s`);
        throw new BrowserAuthError(BrowserAuthErrorCodes.failedToParseResponse);
      }
      return { headers, body, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    sendGetRequestAsync: (url, options) => send('GET', url, options),
    sendPostRequestAsync: (url, options) => send('POST', url, options),
  };
}
