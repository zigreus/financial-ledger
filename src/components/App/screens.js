import { lazyScreen } from '../common/lazyScreen';
import AIEntry from '../AIEntry/lazyAIEntry';
import ProblemReport from '../common/lazyProblemReport';

/**
 * 열 때 불러오는 화면들 (I-033, ROADMAP Q-3) — 첫 화면(거래내역)과 입력 창은 앱과 함께 불러오고,
 * 나머지 탭(요약·캘린더·계좌·설정)과 창(가져오기·카드 대조·첫 실행 안내)은 따로 나눈다.
 * App이 로그인 뒤 쉬는 틈에 preloadScreens()로 모두 미리 불러 두므로, 보통은 처음 열 때도 기다리지 않는다.
 * 나눈 파일은 빌드가 index.html에 미리 받기(prefetch)로 적어, 서비스 워커가 연결 없이 열기용으로 함께 받아 둔다(vite.config.mjs).
 */
export const SummaryView = lazyScreen(() => import('../SummaryView/SummaryView'));
export const SettingsView = lazyScreen(() => import('../SettingsView/SettingsView'));
export const CalendarView = lazyScreen(() => import('../CalendarView/CalendarView'));
export const AccountManagement = lazyScreen(() => import('../AccountManagement/AccountManagement'));
export const ImportModal = lazyScreen(() => import('../ImportModal/ImportModal'));
export const CardStatementModal = lazyScreen(() => import('../CardStatement/CardStatementModal'));
export const Onboarding = lazyScreen(() => import('../Onboarding/Onboarding'));
// AI 창(I-051) — 어느 화면에서나 ✨ AI 버튼으로 연다
export const AIAssistant = lazyScreen(() => import('../AIEntry/AIAssistant'));

// 입력 창의 AI 입력(TransactionForm이 AIEntry/lazyAIEntry로 쓴다)을 먼저 — 가장 자주 여는 곳
// 문제 알리기(I-038)는 가계부를 불러오지 못했거나 화면이 멈췄을 때 쓴다 — 그때 연결이 없어도 열리게 함께 불러 둔다
const SCREENS = [AIEntry, AIAssistant, SummaryView, CalendarView, AccountManagement, SettingsView, ImportModal, CardStatementModal, Onboarding, ProblemReport];

/** 모든 화면을 미리 불러 둔다 — 반환: 모두 불러왔는지 */
export function preloadScreens() {
  return Promise.all(SCREENS.map(s => s.preload())).then(results => results.every(Boolean));
}
