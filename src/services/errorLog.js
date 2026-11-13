/**
 * 문제 알리기용 오류 기록 (I-038, ROADMAP M-5) — 이 기기에만 남기고 어디로도 보내지 않는다(AGENTS §1, ROADMAP F-4).
 *
 *  - 남기는 것: 처리하지 못한 오류(window 'error'·'unhandledrejection'), 화면을 그리다 난 오류(common/ErrorBoundary),
 *    앱이 화면 위 띠로 알린 오류(App의 error). 오류 메시지와 위치(빌드 파일 이름:줄:칸)·시각만 — 가계부 내용은 담지 않는다.
 *    메시지에 섞일 수 있는 이메일·긴 숫자(전화·계좌·카드·주민번호)·토큰·키처럼 보이는 값은 가린다.
 *  - 최근 ERROR_LOG_MAX개만 둔다. 이미 있는 오류가 또 나면 새로 넣지 않고 횟수를 늘려 맨 뒤(최근)로 옮긴다.
 *  - 오류가 아니라 늘 있는 상태 안내(연결 없음·로그인 시간 끝 등, EXPECTED)는 남기지 않는다 — 자리만 차지해 진짜 오류를 밀어낸다.
 *  - 취소(AbortError)와 다른 사이트 스크립트의 내용 없는 오류('Script error.')도 남기지 않는다.
 *  - 보여 주고 보낼 글은 ./problemReport.js가 만든다(설정 › 앱과 불러오기 실패·화면 오류 화면의 '문제 알리기').
 */
/* global __APP_VERSION__ */
import { toDateStr } from './dateUtils';

export const ERROR_LOG_KEY = 'ledger_error_log';
export const ERROR_LOG_MAX = 20;
const MESSAGE_MAX = 300;
/** 가리기 전에 이만큼만 남긴다 — 아주 긴 글을 가리느라 화면이 멈추지 않게(가린 뒤 MESSAGE_MAX로 다시 자른다) */
const RAW_MAX = 2000;

/**
 * 오류가 아니라 늘 있는 상태 안내 — 남기지 않는다. 화면 문구(useLedgerSync·storage/provider·브라우저)가 바뀌면 함께 고친다
 * (errorLog.test.js의 '늘 있는 상태 안내' 테스트에도 같은 문구가 있다).
 */
const EXPECTED = [
  /^ResizeObserver loop/i,                       // 브라우저가 내는 무해한 경고
  /새로 받지 못했습니다 — 이 기기의 가계부로 계속/, // 연결 없음·로그인 시간 끝 — 이 기기의 사본으로 계속 쓴다(useLedgerSync)
  /^로그인이 만료되어 다시 로그인합니다/,           // 로그인 화면으로 넘어가는 중(ReauthRedirectError)
  /^[\d, ]+년 공휴일 데이터가 없어[^·]*$/,          // 해마다 갱신하라는 안내(useLedgerSync, B-006) — 다른 오류와 함께면 남긴다
];

const pad2 = n => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${toDateStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/** 앱 버전 — 빌드할 때 vite.config.mjs가 적는다(빌드 시각·커밋). 개발 서버·테스트는 'dev' */
export function appVersion() {
  return typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';
}

/** 숫자·띄어쓰기·하이픈 덩어리에서 숫자가 이만큼 넘으면(전화·계좌·카드·주민번호) 가린다 — 날짜(YYYY-MM-DD)는 세지 않는다 */
const LONG_NUMBER_DIGITS = 10;
// 앞뒤가 숫자가 아닌 날짜만 — 계좌번호 속의 같은 모양(카카오뱅크 3333-01-1234567의 '3333-01-12')은 날짜로 보지 않는다
const DATE_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g;

/** 오류 글에서 개인 정보처럼 보이는 값을 가린다 */
export function maskSensitive(text) {
  return String(text ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '(이메일)')
    .replace(/\b(access_token|id_token|refresh_token|token|key|api[-_]?key|code|state|sig)=([^&\s#"']+)/gi, '$1=(가림)')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 (가림)')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,})/g, '(키)')
    .replace(/[A-Za-z0-9_-]{32,}/g, '(가림)')
    .replace(/\d[\d -]*\d/g, m => (m.replace(DATE_RE, '').replace(/\D/g, '').length >= LONG_NUMBER_DIGITS ? '(숫자)' : m));
}

/** 스택에서 처음 나오는 이 앱 파일의 위치 — 'index-abc123.js:1:2345' */
function locationFromStack(stack) {
  const lines = String(stack || '').split('\n');
  for (const line of lines) {
    const m = line.match(/(?:https?:\/\/[^/\s)]+)?\/((?:assets|src)\/[^\s)?#]+?):(\d+):(\d+)/);
    if (m) return `${m[1].split('/').pop()}:${m[2]}:${m[3]}`;
  }
  return '';
}

function locationFromEvent(filename, line, col) {
  if (!filename) return '';
  const name = String(filename).split(/[?#]/)[0].split('/').pop();
  return name ? `${name}${line ? `:${line}` : ''}${col ? `:${col}` : ''}` : '';
}

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(ERROR_LOG_KEY) || '[]');
    return Array.isArray(list) ? list.filter(e => e && typeof e.message === 'string') : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(list.slice(-ERROR_LOG_MAX)));
  } catch { /* 저장소가 막혀 있으면 남기지 않는다 */ }
}

/**
 * 오류 하나를 남긴다. error: Error·문자열·그 밖의 값, opts.where: 위치를 직접 줄 때(없으면 스택에서), opts.kind: 갈래 이름
 * opts.latestOnly: 같은 갈래는 가장 최근 것 하나만 둔다 — 매번 글이 달라지는 기록(느린 연결의 걸린 시간)이 쌓여 진짜 오류를 밀어내지 않게
 * 남겼으면 true
 */
export function recordError(error, { where = '', kind = '', latestOnly = false } = {}) {
  if (error == null || error === '') return false;
  if (error?.name === 'AbortError') return false;
  // Error가 아닌 값(객체)은 내용을 풀어 쓰지 않는다 — 거래 같은 데이터가 그대로 담길 수 있다
  const raw = (error instanceof Error
    ? `${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${error.message || ''}`
    : typeof error === 'object'
      ? (typeof error.message === 'string' ? error.message : `알 수 없는 오류 (${Array.isArray(error) ? '목록' : '객체'})`)
      : String(error)).trim().slice(0, RAW_MAX);
  if (!raw || /^Script error\.?$/i.test(raw) || EXPECTED.some(re => re.test(raw))) return false;
  const message = maskSensitive(raw).slice(0, MESSAGE_MAX);
  // 위치는 빌드 파일 이름·줄·칸뿐이라 가리지 않는다(칸 번호가 여섯 자리를 넘기도 한다)
  const place = String(where || (error instanceof Error ? locationFromStack(error.stack) : '')).slice(0, 120);
  let list = read();
  let count = 1;
  if (latestOnly && kind) {
    const prev = list.filter(e => e.kind === kind);
    count = prev.reduce((n, e) => n + (e.count || 1), 0) + 1;   // 몇 번째인지는 이어 센다
    list = list.filter(e => e.kind !== kind);
  } else {
    const same = list.findIndex(e => e.message === message && e.where === place && e.kind === kind);
    count = same >= 0 ? (list[same].count || 1) + 1 : 1;
    if (same >= 0) list.splice(same, 1);
  }
  list.push({ at: stamp(), message, where: place, kind, count });
  write(list);
  return true;
}

/** 남은 오류 — 최근 것부터 */
export function getErrorLog() {
  return read().reverse();
}

export function clearErrorLog() {
  try { localStorage.removeItem(ERROR_LOG_KEY); } catch { /* 무시 */ }
}

let installed = false;
/** 처리하지 못한 오류를 남기기 시작한다(앱을 열 때 한 번). 다시 불러도 한 번만 건다 */
export function installErrorLog(win = typeof window !== 'undefined' ? window : null) {
  if (!win || installed) return;
  installed = true;
  // 이미지·스크립트를 못 받은 것(리소스 오류)은 퍼지지 않아 여기(캡처 없이 건 듣기)에 오지 않는다
  win.addEventListener('error', (e) => {
    if (!e) return;
    recordError(e.error || e.message, { where: e.error ? '' : locationFromEvent(e.filename, e.lineno, e.colno), kind: '처리 못 한 오류' });
  });
  win.addEventListener('unhandledrejection', (e) => {
    recordError(e?.reason, { kind: '처리 못 한 오류' });
  });
}

/** 테스트용 — 다시 걸 수 있게 */
export function resetErrorLogInstall() {
  installed = false;
}
