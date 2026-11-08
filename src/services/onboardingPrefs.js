/**
 * 첫 실행 안내(F-3, I-019)를 '나중에' 한 기기 표시 — 가계부 DB가 아니라 이 기기 localStorage에 계정별로 둔다.
 * 안내를 미뤄도 가계부에는 아무것도 쓰지 않는다. 거래내역 화면의 빈 화면 버튼으로 언제든 다시 열 수 있다.
 */
const KEY = 'ledger_onboarding_later:';

export function isOnboardingPostponed(accountKey) {
  try {
    return window.localStorage.getItem(KEY + (accountKey || '')) === '1';
  } catch (e) {
    return false; // 비공개 모드 등 — 다음에 열 때 다시 보여 줄 뿐
  }
}

export function postponeOnboarding(accountKey) {
  try {
    window.localStorage.setItem(KEY + (accountKey || ''), '1');
  } catch (e) { /* 저장하지 못하면 다음에 다시 보여 줄 뿐 */ }
}
