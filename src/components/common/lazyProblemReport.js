import { lazyScreen } from './lazyScreen';

/**
 * 문제 알리기(./ProblemReport) — 열 때 불러온다 (I-038, I-033). 가계부를 불러오지 못한 화면(App)과
 * 화면을 그리다 멈춘 화면(./ErrorBoundary)에서 쓴다. 설정 › 앱은 설정 화면과 함께 불러온다.
 * App이 로그인 뒤 쉬는 틈에 다른 화면과 함께 미리 불러 둔다(App/screens.js의 preloadScreens).
 */
const ProblemReport = lazyScreen(() => import('./ProblemReport'), {
  inline: '문제 알리기를 불러오지 못했습니다 — 연결을 확인하고 다시 시도해 주세요.',
  inlineRetry: '계속 안 되면 연결된 뒤 앱을 새로 고쳐 주세요.',
});
export default ProblemReport;
