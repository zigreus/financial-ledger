/**
 * @vitest-environment jsdom
 */
// Google 로그인 (M-1, I-031) — 페이지 이동으로 받은 토큰을 세션으로, 다시 연결할 때 다른 계정 막기, 만료·로그아웃
import {
  isGoogleConfigured, startGoogleLogin, completeGoogleRedirect, getGoogleSession, isGoogleTokenValid,
  markGoogleTokenExpired, googleLogout, rememberGoogleResult, takeGoogleNotice, GOOGLE_SCOPE,
  shouldReconnectAtStart, probeGoogle,
} from '../../auth/googleAuth';

const userinfo = (sub = 'u1', email = 'mom@gmail.com') => vi.fn(async () => ({ ok: true, json: async () => ({ sub, email }) }));
let navigated;
const go = () => startGoogleLogin({ navigate: (url) => { navigated = new URL(url); } });
const goSilent = () => startGoogleLogin({ silent: true, navigate: (url) => { navigated = new URL(url); } });
/** Google에서 돌아온 주소처럼 #… 를 붙인다 */
const returnWith = (params) => window.history.replaceState(null, '', `/#${new URLSearchParams(params)}`);

beforeEach(() => {
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'cid.apps.googleusercontent.com');
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/?share=1');
  navigated = null;
});
afterEach(() => { vi.unstubAllEnvs(); });

test('설정이 없으면 Google 로그인을 쓰지 않는다', () => {
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', '');
  expect(isGoogleConfigured()).toBe(false);
  expect(() => go()).toThrow('설정되지 않았습니다');
});

test('로그인 주소 — drive.file 범위, 토큰 방식, 계정 고르기, 돌아올 주소는 앱 첫 화면', () => {
  go();
  expect(navigated.origin + navigated.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  const p = navigated.searchParams;
  expect([p.get('client_id'), p.get('response_type'), p.get('scope'), p.get('prompt'), p.get('redirect_uri')])
    .toEqual(['cid.apps.googleusercontent.com', 'token', GOOGLE_SCOPE, 'select_account', `${window.location.origin}/`]);
  expect(p.get('state')).toMatch(/^[0-9a-f]{32}$/);
});

test('돌아오면 토큰을 세션으로 받고 주소의 토큰을 지운다 — 처음 주소(/?share=1)로 되돌린다', async () => {
  go();
  const state = navigated.searchParams.get('state');
  returnWith({ access_token: 'AT', expires_in: '3599', scope: `email ${GOOGLE_SCOPE}`, state });
  const fetchImpl = userinfo();
  expect(await completeGoogleRedirect(fetchImpl)).toEqual({ handled: true, ok: true });
  expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer AT');
  expect(window.location.hash).toBe('');
  expect(window.location.pathname + window.location.search).toBe('/?share=1');
  const s = getGoogleSession();
  expect(s).toMatchObject({ accessToken: 'AT', sub: 'u1', email: 'mom@gmail.com' });
  expect(isGoogleTokenValid(s)).toBe(true);
  expect(isGoogleTokenValid(s, Date.now() + 3599 * 1000)).toBe(false);   // 끝나기 2분 전부터는 만료로 본다
});

test('내가 보낸 요청이 아니면(state가 다르거나 없음) 건드리지 않는다', async () => {
  returnWith({ access_token: 'AT', state: 'nope' });
  expect(await completeGoogleRedirect(userinfo())).toEqual({ handled: false });
  expect(getGoogleSession()).toBeNull();
  window.history.replaceState(null, '', '/');
  expect(await completeGoogleRedirect(userinfo())).toEqual({ handled: false });
});

test('Drive 권한을 허락하지 않았거나 취소했으면 로그인하지 않고 알린다', async () => {
  go();
  returnWith({ access_token: 'AT', scope: 'email openid', state: navigated.searchParams.get('state') });
  const r = await completeGoogleRedirect(userinfo());
  expect(r).toMatchObject({ handled: true, ok: false });
  expect(r.error).toContain('Drive 사용을 허락');
  expect(getGoogleSession()).toBeNull();

  go();
  returnWith({ error: 'access_denied', state: navigated.searchParams.get('state') });
  const denied = await completeGoogleRedirect(userinfo());
  rememberGoogleResult(denied);
  expect(takeGoogleNotice()).toBe('Google 로그인을 취소했습니다');
  expect(takeGoogleNotice()).toBe('');
});

test('다시 연결(화면 없이) — 직접 로그인해야 하면 안내하고, 다른 계정으로 돌아오면 받지 않는다', async () => {
  go();
  returnWith({ access_token: 'AT', scope: GOOGLE_SCOPE, state: navigated.searchParams.get('state') });
  await completeGoogleRedirect(userinfo('u1'));
  markGoogleTokenExpired();
  expect(getGoogleSession()).toMatchObject({ sub: 'u1', accessToken: '' });

  goSilent();
  expect(navigated.searchParams.get('prompt')).toBe('none');
  expect(navigated.searchParams.get('login_hint')).toBe('mom@gmail.com');
  returnWith({ error: 'interaction_required', state: navigated.searchParams.get('state') });
  expect(await completeGoogleRedirect(userinfo('u1'))).toEqual({ handled: true, ok: false, needLogin: true });

  goSilent();
  returnWith({ access_token: 'AT2', scope: GOOGLE_SCOPE, state: navigated.searchParams.get('state') });
  const other = await completeGoogleRedirect(userinfo('u2', 'dad@gmail.com'));
  expect(other.error).toContain('다른 Google 계정');
  expect(getGoogleSession()).toBeNull();                                   // 보관된 변경이 다른 사람 Drive로 가지 않게
});

test('로그아웃 — 이 기기에서만 지우고 Google에 폐기를 요청하지 않는다(가족 기기 허락까지 지우지 않게)', async () => {
  go();
  returnWith({ access_token: 'AT', scope: GOOGLE_SCOPE, state: navigated.searchParams.get('state') });
  await completeGoogleRedirect(userinfo());
  const fetchSpy = vi.spyOn(window, 'fetch').mockImplementation(async () => ({ ok: true }));
  await googleLogout();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(getGoogleSession()).toBeNull();
  fetchSpy.mockRestore();
});

test("'다시 연결'은 화면을 띄울 수 있게(prompt 없음) 보내고, 다른 계정으로 돌아오면 받지 않는다", async () => {
  go();
  returnWith({ access_token: 'AT', scope: GOOGLE_SCOPE, state: navigated.searchParams.get('state') });
  await completeGoogleRedirect(userinfo('u1'));
  markGoogleTokenExpired();
  startGoogleLogin({ reconnect: true, navigate: (url) => { navigated = new URL(url); } });
  expect(navigated.searchParams.has('prompt')).toBe(false);
  expect(navigated.searchParams.get('login_hint')).toBe('mom@gmail.com');
  returnWith({ access_token: 'AT2', scope: GOOGLE_SCOPE, state: navigated.searchParams.get('state') });
  const other = await completeGoogleRedirect(userinfo('u2', 'dad@gmail.com'));
  expect(other.error).toContain('다른 Google 계정');
});

test('401을 받은 토큰일 때만 만료로 표시한다 — 다른 탭이 다시 연결해 받은 새 토큰은 지우지 않는다', async () => {
  go();
  returnWith({ access_token: 'NEW', scope: GOOGLE_SCOPE, state: navigated.searchParams.get('state') });
  await completeGoogleRedirect(userinfo());
  markGoogleTokenExpired('OLD');
  expect(getGoogleSession().accessToken).toBe('NEW');
  markGoogleTokenExpired('NEW');
  expect(getGoogleSession().accessToken).toBe('');
});

test('내 요청이 아닌데 주소에 접근 토큰이 있으면 지운다, 로그인 정보를 저장할 수 없으면 이동하지 않는다', async () => {
  returnWith({ access_token: 'LEAK', state: 'x' });
  await completeGoogleRedirect(userinfo());
  expect(window.location.hash).toBe('');
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  expect(() => go()).toThrow('로그인 정보를 잠시 저장할 수 없습니다');
  expect(navigated).toBeNull();
  setItem.mockRestore();
});

test('앱을 열 때 저절로 다녀오기 — Google 계정이고 토큰이 끝났고 실제로 연결될 때만', async () => {
  expect(await shouldReconnectAtStart({ probe: async () => true })).toBe(false);   // 세션 없음
  go();
  returnWith({ access_token: 'AT', scope: GOOGLE_SCOPE, state: navigated.searchParams.get('state') });
  await completeGoogleRedirect(userinfo());
  expect(await shouldReconnectAtStart({ probe: async () => true })).toBe(false);   // 토큰이 아직 쓸 만함
  markGoogleTokenExpired();
  expect(await shouldReconnectAtStart({ probe: async () => false })).toBe(false);  // 연결 확인 실패 — 사본으로 연다
  expect(await shouldReconnectAtStart({ probe: async () => true })).toBe(true);
  expect(await probeGoogle(async () => { throw new TypeError('offline'); })).toBe(false);
  expect(await probeGoogle(async () => ({ type: 'opaque' }))).toBe(true);
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', '');
  expect(await shouldReconnectAtStart({ probe: async () => true })).toBe(false);
});
