import { lazyScreen } from '../common/lazyScreen';

/**
 * 입력 창의 AI 입력(사진·카드 문자·말) — 열 때 불러온다 (I-033). App이 로그인 뒤 쉬는 틈에 다른 화면과 함께 미리 불러 둔다
 * (App/screens.js의 preloadScreens). 입력 창은 이 부분이 늦어도 바로 열리고 직접 입력할 수 있다 —
 * 불러오지 못하면 입력 창 안에 짧게 알리고 '다시 시도'만 둔다(새로 고침은 입력하던 것을 지운다).
 */
const AIEntry = lazyScreen(() => import('./AIEntry'), {
  inline: 'AI 입력을 불러오지 못했습니다 — 직접 입력은 그대로 할 수 있어요.',
});
export default AIEntry;
