/**
 * Google 로그인 (M-1, I-031) — 서버 없이 브라우저만으로 Google Drive에 가계부를 둔다.
 *
 * 방식: OAuth 2.0 '클라이언트 측 웹 앱' 흐름(response_type=token, 전체 페이지 이동). 웹 애플리케이션 클라이언트는
 *  코드 교환에 비밀값(client secret)이 필요해 서버 없이 PKCE 코드 흐름을 쓸 수 없어 토큰 흐름을 쓴다.
 *  - 범위는 drive.file(이 앱이 만든 파일만) + 계정 표시용 openid·email. 사용자의 다른 Drive 파일은 보지 못한다.
 *  - 서버가 없어 갱신 토큰(refresh token)을 받지 못한다. 접근 토큰은 약 1시간 — 만료되면
 *    · 앱을 열 때: 실제로 연결될 때만 Google에 잠깐 다녀온다(prompt=none — 이미 허락했으면 화면 없이 바로 돌아온다).
 *    · 쓰는 중에: 저장소가 ReconnectRequiredError(연결 없음과 같은 처리 — 이 기기 사본으로 이어 쓰고 변경은 보관)를 던지고,
 *      앱이 '다시 연결' 버튼을 보인다. 입력 중인 화면을 갑자기 떠나지 않도록 저절로 이동하지 않는다.
 *  - 토큰은 이 기기의 localStorage에 둔다(MSAL과 같은 수준). 로그아웃하면 이 기기에서만 지운다(폐기 요청은 하지 않는다 — googleLogout).
 * 설정: Vite 환경값 VITE_GOOGLE_CLIENT_ID(Google Cloud의 'OAuth 클라이언트 ID — 웹 애플리케이션').
 *       승인된 JavaScript 원본·리디렉션 URI에 앱 주소(끝에 '/')를 넣는다. 없으면 Google 로그인 버튼이 보이지 않는다.
 */

const clientId = () => (import.meta.env && import.meta.env.VITE_GOOGLE_CLIENT_ID) || '';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
export const GOOGLE_SCOPE = 'openid email https://www.googleapis.com/auth/drive.file';

const SESSION_KEY = 'ledger_google_session';      // { accessToken, expiresAt, sub, email }
const STATE_KEY = 'ledger_google_oauth_state';    // sessionStorage — 돌아왔을 때 내가 보낸 요청인지
const EVENT = 'ledger-google-session';
/** 이만큼 남았으면 만료된 것으로 본다 — 저장 도중 끊기지 않게 */
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

export function isGoogleConfigured() {
  return !!clientId();
}

const store = {
  get(key, area = 'local') {
    try { return JSON.parse((area === 'local' ? window.localStorage : window.sessionStorage).getItem(key) || 'null'); } catch (e) { return null; }
  },
  set(key, value, area = 'local') {
    try { (area === 'local' ? window.localStorage : window.sessionStorage).setItem(key, JSON.stringify(value)); } catch (e) { /* 저장 못 하면 이번 화면에서만 */ }
  },
  remove(key, area = 'local') {
    try { (area === 'local' ? window.localStorage : window.sessionStorage).removeItem(key); } catch (e) { /* 없음 */ }
  },
};

/** 이 기기의 Google 세션 — 토큰이 만료됐어도 계정 정보는 남는다(다시 연결할 계정·이 기기 사본을 알려고). 없으면 null */
export function getGoogleSession() {
  const s = store.get(SESSION_KEY);
  return s && s.sub ? s : null;
}

export function isGoogleTokenValid(session = getGoogleSession(), now = Date.now()) {
  return !!session?.accessToken && session.expiresAt - EXPIRY_MARGIN_MS > now;
}

function notify() {
  try { window.dispatchEvent(new Event(EVENT)); } catch (e) { /* 없음 */ }
}

/** 세션이 바뀌면(로그인·로그아웃·만료 표시) 불린다 — 해제 함수를 돌려준다 */
export function onGoogleSessionChange(fn) {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

function randomState() {
  const a = new Uint8Array(16);
  (window.crypto || {}).getRandomValues?.(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('') || String(Math.random()).slice(2);
}

const redirectUri = () => `${window.location.origin}/`;

/**
 * Google 로그인으로 이동한다. 돌아오면 completeGoogleRedirect가 토큰을 받는다.
 *  - silent: 앱을 열 때 저절로 — 이미 허락한 계정이면 화면 없이 바로 돌아오게(prompt=none). 직접 로그인해야 하면 실패로 돌아온다.
 *  - reconnect: 이 기기에 계정이 있을 때('다시 연결', 저절로 다녀오기) — 다른 계정으로 돌아오면 받지 않는다(보관한 변경이
 *    다른 사람 Drive로 가지 않게). '다시 연결' 버튼은 사용자가 누른 것이라 화면을 띄울 수 있게 prompt를 두지 않는다
 *    (Google이 필요하면 계정 확인·동의 화면을 보인다).
 *  - 처음 로그인은 계정을 고르게(select_account).
 */
export function startGoogleLogin({ silent = false, reconnect = false, navigate = url => window.location.assign(url) } = {}) {
  if (!clientId()) throw new Error('Google 로그인이 설정되지 않았습니다');
  const state = randomState();
  const session = getGoogleSession();
  // 돌아올 주소 — 공유 받기(/?share=1)·바로가기처럼 주소에 담긴 시작 동작을 잃지 않게
  store.set(STATE_KEY, { state, silent, reconnect: reconnect || silent, returnTo: window.location.pathname + window.location.search }, 'session');
  // 저장하지 못했으면 돌아와도 내 요청인지 알 수 없어(그러면 또 저절로 이동한다) 가지 않는다
  if (store.get(STATE_KEY, 'session')?.state !== state) {
    throw new Error('이 브라우저에서 로그인 정보를 잠시 저장할 수 없습니다 — 사생활 보호 모드를 끄거나 다른 브라우저로 열어 주세요');
  }
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: GOOGLE_SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  if (silent) params.set('prompt', 'none');
  else if (!reconnect) params.set('prompt', 'select_account');
  if (session?.email) params.set('login_hint', session.email);
  navigate(`${AUTH_URL}?${params}`);
}

/**
 * 앱을 열 때 맨 먼저 부른다(MSAL보다 먼저) — 주소의 #access_token=…을 받아 세션으로 바꾸고 주소에서 지운다.
 * 반환: { handled: false } — Google에서 돌아온 것이 아님
 *       { handled: true, ok: true } — 로그인됨
 *       { handled: true, ok: false, needLogin: true } — 화면 없이 다시 받으려 했지만 직접 로그인해야 함
 *       { handled: true, ok: false, error } — 거절·오류(화면에 알린다)
 */
export async function completeGoogleRedirect(fetchImpl = (...a) => window.fetch(...a)) {
  const hash = window.location.hash || '';
  if (!/[#&](access_token|error)=/.test(hash)) return { handled: false };
  const params = new URLSearchParams(hash.slice(1));
  const sent = store.get(STATE_KEY, 'session');
  if (!sent || params.get('state') !== sent.state) {
    // 내가 보낸 요청이 아니다(MSAL 등). 그래도 접근 토큰이 주소에 남지 않게 지운다(MSAL은 토큰을 해시로 받지 않는다)
    if (params.has('access_token')) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    return { handled: false };
  }
  store.remove(STATE_KEY, 'session');
  const returnTo = typeof sent.returnTo === 'string' && sent.returnTo.startsWith('/') && !sent.returnTo.startsWith('//')
    ? sent.returnTo : window.location.pathname + window.location.search;
  window.history.replaceState(window.history.state, '', returnTo);

  const error = params.get('error');
  if (error) {
    if (['interaction_required', 'login_required', 'consent_required', 'account_selection_required'].includes(error)) {
      return { handled: true, ok: false, needLogin: true };
    }
    return { handled: true, ok: false, error: error === 'access_denied' ? 'Google 로그인을 취소했습니다' : `Google 로그인 오류: ${error}` };
  }
  const accessToken = params.get('access_token');
  const scopes = (params.get('scope') || '').split(' ');
  if (!scopes.some(s => s.endsWith('/auth/drive.file'))) {
    return { handled: true, ok: false, error: 'Google Drive 사용을 허락해야 가계부를 저장할 수 있습니다 — 다시 로그인하며 Drive 권한에 체크하세요' };
  }
  const expiresIn = Number(params.get('expires_in')) || 3600;
  let info;
  try {
    const res = await fetchImpl(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(String(res.status));
    info = await res.json();
  } catch (e) {
    return { handled: true, ok: false, error: 'Google 계정 정보를 받지 못했습니다 — 연결을 확인하고 다시 로그인하세요' };
  }
  const prev = getGoogleSession();
  if ((sent.reconnect || sent.silent) && prev && prev.sub !== info.sub) {
    // 다시 연결하는데 다른 계정으로 돌아왔다 — 이 기기의 보관된 변경이 다른 사람 Drive로 가지 않게 로그아웃 후 다시 고르게 한다
    store.remove(SESSION_KEY);
    notify();
    return { handled: true, ok: false, error: '다른 Google 계정으로 연결되었습니다 — 다시 로그인해 원래 계정을 고르세요' };
  }
  store.set(SESSION_KEY, { accessToken, expiresAt: Date.now() + expiresIn * 1000, sub: info.sub, email: info.email || '' });
  notify();
  return { handled: true, ok: true };
}

let lastNotice = '';
/** completeGoogleRedirect가 남긴 안내(오류·직접 로그인 필요)를 받아 간다 — 로그인 화면이나 '다시 연결' 안내가 보인다 */
export function peekGoogleNotice() {
  return lastNotice;
}
/** 안내를 보였으면 지운다 */
export function clearGoogleNotice() {
  lastNotice = '';
}
/** 예전 이름 — 받아 가며 지운다 */
export function takeGoogleNotice() {
  const n = lastNotice;
  lastNotice = '';
  return n;
}
/** 앱 시작 때 completeGoogleRedirect 결과를 화면이 보일 안내로 남긴다 */
export function rememberGoogleResult(result) {
  if (!result?.handled || result.ok) return;
  lastNotice = result.error
    || (result.needLogin ? 'Google에 다시 로그인해야 합니다 — 버튼을 눌러 계정을 확인해 주세요' : '');
}

/**
 * 저장소가 401을 받았을 때 — 토큰만 버리고 계정은 남긴다(다시 연결 버튼이 보이게).
 * token: 401을 받은 요청의 토큰 — 그 사이 다른 탭이 다시 연결해 받은 새 토큰은 지우지 않는다
 */
export function markGoogleTokenExpired(token) {
  const s = getGoogleSession();
  if (!s || !s.accessToken) return;
  if (token && s.accessToken !== token) return;
  store.set(SESSION_KEY, { ...s, accessToken: '', expiresAt: 0 });
  notify();
}

/**
 * 로그아웃 — 이 기기에서만 지운다. Google에 토큰 폐기(revoke)는 요청하지 않는다:
 * 폐기는 토큰 하나가 아니라 이 앱에 준 허락 전체를 지워, 같은 계정을 쓰는 가족 기기가 모두 끊기고
 * drive.file로 만든 가계부에 다시 허락해도 접근하지 못할 수 있다. 토큰은 1시간 안에 저절로 끝난다.
 */
export async function googleLogout() {
  store.remove(SESSION_KEY);
  notify();
}

/**
 * 앱을 열 때 Google에 저절로 다녀올지 — 이 기기가 Google 계정을 쓰는데 토큰이 끝났고, 실제로 연결될 때만.
 * navigator.onLine은 망에 붙어 있기만 하면 참이라(약한 신호·와이파이 로그인 페이지) 짧게 연결을 확인한다.
 * 연결되지 않으면 이동하지 않고 그대로 열어 이 기기 사본으로 쓰게 한다(ReconnectRequiredError → 연결 없음 처리).
 */
export async function shouldReconnectAtStart({ probe = probeGoogle } = {}) {
  if (!isGoogleConfigured()) return false;
  const session = getGoogleSession();
  if (!session || isGoogleTokenValid(session)) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return probe();
}

/** Google(www.googleapis.com/generate_204)까지 닿는지 3초 안에 확인 — 응답 내용은 볼 수 없어도(no-cors) 닿으면 참 */
export async function probeGoogle(fetchImpl = (...a) => window.fetch(...a), timeoutMs = 3000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => controller && controller.abort(), timeoutMs);
  try {
    await fetchImpl('https://www.googleapis.com/generate_204', { mode: 'no-cors', cache: 'no-store', signal: controller?.signal });
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
