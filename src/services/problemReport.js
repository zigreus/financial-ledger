/**
 * 문제 알리기 글 (I-038, ROADMAP M-5) — 사용자가 읽어 보고 고친 뒤 직접 보낸다. 앱이 보내지 않는다(AGENTS §1).
 * 오류 기록(./errorLog.js)은 앱을 열 때부터 쓰지만 이 글은 '문제 알리기' 화면(common/ProblemReport, 열 때 불러옴)만 쓴다.
 */
import { ERROR_LOG_MAX, appVersion, getErrorLog } from './errorLog';

/** 메일로 보낼 때 담는 오류 수 — 메일 주소(mailto)가 너무 길면 메일 앱이 자르거나 열지 못한다. 모두 보내려면 복사 */
export const MAIL_ERRORS_MAX = 5;

/** 지금 화면 방식 — 홈 화면 앱인지 브라우저인지 */
function displayMode(win) {
  try {
    if (win.matchMedia?.('(display-mode: standalone)').matches || win.navigator?.standalone) return '홈 화면 앱';
  } catch { /* 무시 */ }
  return '브라우저';
}

/**
 * 보낼 글. { note, drive, errors, limit, win }
 *  - note: 사용자가 적은 '무슨 일이 있었나요'   - drive: 'OneDrive' | 'Google Drive' (모르면 '')
 *  - errors: getErrorLog()의 결과(최근 것부터)   - limit: 담을 오류 수(메일은 MAIL_ERRORS_MAX) — 넘으면 몇 건 중 몇 건인지 적는다
 * 브라우저 정보(userAgent)는 휴대폰 기종이 들어 있을 수 있지만 문제를 찾는 데 필요해 그대로 보인다(보내기 전에 화면에서 읽고,
 * 복사한 뒤 지울 수 있다)
 */
export function buildProblemReport({
  note = '', drive = '', errors = getErrorLog(), limit = ERROR_LOG_MAX, win = typeof window !== 'undefined' ? window : {},
} = {}) {
  const nav = win.navigator || {};
  const info = [
    `앱 버전: ${appVersion()}`,
    `화면: ${displayMode(win)}${nav.onLine === false ? ' · 연결 없음' : ''}`,
    ...(drive ? [`저장소: ${drive}`] : []),
    `브라우저: ${nav.userAgent || '알 수 없음'}`,
  ];
  const shown = errors.slice(0, limit);
  const errorLines = shown.length
    ? shown.map((e, i) => `${i + 1}. ${e.at}${e.count > 1 ? ` (${e.count}번)` : ''}${e.kind ? ` [${e.kind}]` : ''} ${e.message}${e.where ? ` — ${e.where}` : ''}`)
    : ['없음'];
  const head = !errors.length ? '' : shown.length < errors.length
    ? ` (${errors.length}건 중 최근 ${shown.length}건)`
    : ` (${errors.length}건, 최근 것부터)`;
  return [
    '[지금 가계부 문제 알리기]',
    '',
    '■ 무슨 일이 있었나요?',
    String(note || '').trim() || '(여기에 적어 주세요)',
    '',
    '■ 앱 정보',
    ...info,
    '',
    `■ 최근 오류${head}`,
    ...errorLines,
  ].join('\n');
}
