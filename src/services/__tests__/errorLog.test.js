/**
 * @vitest-environment jsdom
 */
// 문제 알리기용 오류 기록 (I-038, ROADMAP M-5) — 이 기기에만 남기고, 개인 정보처럼 보이는 값은 가린다
import {
  ERROR_LOG_KEY, ERROR_LOG_MAX, appVersion, clearErrorLog, getErrorLog,
  installErrorLog, maskSensitive, recordError, resetErrorLogInstall,
} from '../errorLog';
import { MAIL_ERRORS_MAX, buildProblemReport } from '../problemReport';
import { ReauthRedirectError } from '../storage/provider';

beforeEach(() => {
  window.localStorage.clear();
});

describe('가리기', () => {
  test('이메일·토큰·키·긴 숫자(전화·계좌·카드·주민번호)는 가리고, 날짜·시각·짧은 숫자는 남긴다', () => {
    expect(maskSensitive('mom@gmail.com 계정의 파일')).toBe('(이메일) 계정의 파일');
    expect(maskSensitive('GET /me?access_token=abc.def&x=1')).toBe('GET /me?access_token=(가림)&x=1');
    expect(maskSensitive('Authorization: Bearer eyJhbGciOi.xyz')).toBe('Authorization: Bearer (가림)');
    expect(maskSensitive('키 sk-ant-api03-abcdefgh 오류')).toBe('키 (키) 오류');
    expect(maskSensitive('키 AIzaSyA1234567890abcdefghij 오류')).toBe('키 (키) 오류');
    expect(maskSensitive('카드 1234-5678-9012-3456 결제')).toBe('카드 (숫자) 결제');
    expect(maskSensitive('전화 010-1234-5678')).toBe('전화 (숫자)');
    expect(maskSensitive('계좌 110 123 456789')).toBe('계좌 (숫자)');
    expect(maskSensitive('번호 900101-1234567')).toBe('번호 (숫자)');
    // 날짜 모양이 들어 있는 계좌번호도 가린다(카카오뱅크 4-2-7, 국민 6-2-6, 기업 3-6-2-3)
    expect(maskSensitive('계좌 3333-01-1234567 입금')).toBe('계좌 (숫자) 입금');
    expect(maskSensitive('계좌 123456-78-901234')).toBe('계좌 (숫자)');
    expect(maskSensitive('계좌 123-456789-01-234')).toBe('계좌 (숫자)');
    expect(maskSensitive('2026-11-09 거래 13,500원 저장 실패 (412)')).toBe('2026-11-09 거래 13,500원 저장 실패 (412)');
    expect(maskSensitive('Timestamp: 2026-11-09 03:12:45Z')).toBe('Timestamp: 2026-11-09 03:12:45Z');
    expect(maskSensitive('ledger-2026-11-09-143000.db')).toBe('ledger-2026-11-09-143000.db');
    expect(maskSensitive('2026-11-09 2026-11-10 사이')).toBe('2026-11-09 2026-11-10 사이');
    expect(maskSensitive('id ' + 'a'.repeat(40))).toBe('id (가림)');
  });

  test('아주 긴 오류도 오래 걸리지 않는다(가리기 전에 자른다)', () => {
    const started = Date.now();
    recordError(`${'a'.repeat(60000)}@`);
    expect(Date.now() - started).toBeLessThan(500);
    expect(getErrorLog()[0].message.length).toBeLessThanOrEqual(300);
  });
});

describe('남기기', () => {
  test('메시지·위치·시각·갈래 — 최근 것부터, 이미 있는 오류는 횟수를 늘려 맨 앞(최근)으로', () => {
    const err = new TypeError('x is undefined');
    err.stack = 'TypeError: x is undefined\n    at f (https://app.example/assets/index-Ab12.js:1:234567)\n    at g (https://app.example/assets/vendor-Cd.js:2:3)';
    expect(recordError(err)).toBe(true);
    recordError('저장 실패: 연결이 끊겼습니다', { kind: '화면에 알린 오류' });
    recordError(err);   // 사이에 다른 오류가 있어도 같은 오류면 합친다
    const list = getErrorLog();
    expect(list.map(e => [e.message, e.where, e.kind, e.count])).toEqual([
      ['TypeError: x is undefined', 'index-Ab12.js:1:234567', '', 2],   // 칸 번호(여섯 자리)는 가리지 않는다
      ['저장 실패: 연결이 끊겼습니다', '', '화면에 알린 오류', 1],
    ]);
    expect(list[0].at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test(`최근 ${ERROR_LOG_MAX}건만 둔다`, () => {
    for (let i = 0; i < ERROR_LOG_MAX + 5; i += 1) recordError(`오류 ${i}`);
    const list = getErrorLog();
    expect(list).toHaveLength(ERROR_LOG_MAX);
    expect(list[0].message).toBe(`오류 ${ERROR_LOG_MAX + 4}`);
    expect(list[ERROR_LOG_MAX - 1].message).toBe('오류 5');
  });

  test('취소·내용 없는 다른 사이트 오류·빈 값은 남기지 않고, 객체는 내용을 풀어 쓰지 않는다', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(recordError(abort)).toBe(false);
    expect(recordError('Script error.')).toBe(false);
    expect(recordError('')).toBe(false);
    expect(recordError(null)).toBe(false);
    recordError({ detail: '스타벅스', amount: 4500 });
    recordError({ message: '요청 실패' });
    expect(getErrorLog().map(e => e.message)).toEqual(['요청 실패', '알 수 없는 오류 (객체)']);
    expect(window.localStorage.getItem(ERROR_LOG_KEY)).not.toContain('스타벅스');
  });

  test('늘 있는 상태 안내(연결 없음·로그인 시간 끝·다시 로그인·공휴일 갱신·브라우저 경고)는 남기지 않는다', () => {
    // 앞의 둘·공휴일 안내는 useLedgerSync.js의 문구를 옮겨 적었다 — 그 문구를 바꾸면 errorLog.js의 EXPECTED와 함께 고친다
    const expected = [
      "로그인 시간이 끝나 새로 받지 못했습니다 — 이 기기의 가계부로 계속 쓸 수 있고, '다시 연결'을 누르면 저장합니다",
      '연결이 없어 새로 받지 못했습니다 — 이 기기의 가계부로 계속 쓸 수 있고, 연결되면 저장합니다',
      new ReauthRedirectError().message,
      '2027년 공휴일 데이터가 없어 계좌 자동등록의 휴일 보정이 주말만 반영됩니다 — src/data/holidays.js를 갱신하세요',
      'ResizeObserver loop completed with undelivered notifications.',
    ];
    expected.forEach(m => expect(recordError(m, { kind: '화면에 알린 오류' })).toBe(false));
    // 다른 오류와 함께 온 공휴일 안내는 남긴다
    expect(recordError('DB 업데이트 일부 실패: x · 2027년 공휴일 데이터가 없어 …', { kind: '화면에 알린 오류' })).toBe(true);
    expect(getErrorLog()).toHaveLength(1);
  });

  test('메시지는 가려서 남긴다', () => {
    recordError(new Error('mom@gmail.com 의 토큰 access_token=SECRET 이 끝났습니다'));
    expect(getErrorLog()[0].message).toBe('(이메일) 의 토큰 access_token=(가림) 이 끝났습니다');
  });

  test('기록이 깨져 있어도 빈 목록으로 다시 시작하고, 지우면 비워진다', () => {
    window.localStorage.setItem(ERROR_LOG_KEY, '{깨짐');
    expect(getErrorLog()).toEqual([]);
    recordError('하나');
    expect(getErrorLog()).toHaveLength(1);
    clearErrorLog();
    expect(getErrorLog()).toEqual([]);
  });

  test('처리하지 못한 오류(error·unhandledrejection)를 남긴다 — 한 번만 건다, 내용 없는 다른 사이트 오류는 뺀다', () => {
    resetErrorLogInstall();
    installErrorLog(window);
    installErrorLog(window);
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', filename: 'https://app.example/assets/index-Ab12.js?v=1', lineno: 3, colno: 7 }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.', filename: '', lineno: 0, colno: 0 }));
    const withError = new TypeError('y is null');
    withError.stack = 'TypeError: y is null\n    at h (https://app.example/assets/SettingsView-Zz.js:1:99)';
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught TypeError: y is null', error: withError, filename: 'https://app.example/assets/x.js', lineno: 5, colno: 5 }));
    const rejection = new Event('unhandledrejection');
    rejection.reason = new RangeError('too far');
    window.dispatchEvent(rejection);
    expect(getErrorLog().map(e => [e.message, e.where, e.kind, e.count])).toEqual([
      ['RangeError: too far', '', '처리 못 한 오류', 1],
      ['TypeError: y is null', 'SettingsView-Zz.js:1:99', '처리 못 한 오류', 1],   // 오류 객체가 있으면 스택에서 위치를
      ['boom', 'index-Ab12.js:3:7', '처리 못 한 오류', 1],
    ]);
  });
});

describe('문제 알리기 글', () => {
  const win = { navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S918N) Chrome/130', onLine: false }, matchMedia: () => ({ matches: true }) };

  test('적은 내용·앱 정보·최근 오류를 담는다', () => {
    recordError('첫 오류');
    recordError('둘째 오류');
    recordError('둘째 오류');
    const text = buildProblemReport({ note: '  저장이 안 돼요  ', drive: 'Google Drive', win });
    expect(text).toBe([
      '[지금 가계부 문제 알리기]',
      '',
      '■ 무슨 일이 있었나요?',
      '저장이 안 돼요',
      '',
      '■ 앱 정보',
      `앱 버전: ${appVersion()}`,
      '화면: 홈 화면 앱 · 연결 없음',
      '저장소: Google Drive',
      '브라우저: Mozilla/5.0 (Linux; Android 14; SM-S918N) Chrome/130',
      '',
      '■ 최근 오류 (2건, 최근 것부터)',
      `1. ${getErrorLog()[0].at} (2번) 둘째 오류`,
      `2. ${getErrorLog()[1].at} 첫 오류`,
    ].join('\n'));
    expect(appVersion()).toBe('dev');   // 테스트·개발 서버에는 빌드 버전이 없다
  });

  test('적은 것·오류가 없으면 안내 문구와 "없음"', () => {
    const text = buildProblemReport({ win: { navigator: {}, matchMedia: () => ({ matches: false }) } });
    expect(text).toContain('■ 무슨 일이 있었나요?\n(여기에 적어 주세요)');
    expect(text).toContain('화면: 브라우저\n브라우저: 알 수 없음');
    expect(text).not.toContain('저장소:');
    expect(text.endsWith('■ 최근 오류\n없음')).toBe(true);
  });

  test('메일용(limit)은 최근 몇 건만 담고 몇 건 중인지 적는다', () => {
    for (let i = 1; i <= MAIL_ERRORS_MAX + 2; i += 1) recordError(`오류 ${i}`);
    const text = buildProblemReport({ win, limit: MAIL_ERRORS_MAX });
    expect(text).toContain(`■ 최근 오류 (${MAIL_ERRORS_MAX + 2}건 중 최근 ${MAIL_ERRORS_MAX}건)`);
    expect(text).toContain(`1. ${getErrorLog()[0].at} 오류 ${MAIL_ERRORS_MAX + 2}`);
    expect(text).not.toContain('오류 1\n');
    expect(text.endsWith(' 오류 3')).toBe(true);
  });
});
