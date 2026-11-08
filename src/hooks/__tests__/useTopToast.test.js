/**
 * @vitest-environment jsdom
 */
// 화면 위 알림(되돌리기) — 다른 앱에 가 있거나 화면이 꺼진 동안에는 시간을 세지 않는다 (I-023)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useTopToast, TOP_TOAST_MS } from '../useTopToast';

global.IS_REACT_ACT_ENVIRONMENT = true;

let visibility = 'visible';
beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
const setVisibility = (v) => act(() => { visibility = v; document.dispatchEvent(new Event('visibilitychange')); });

let api;
function Probe() {
  api = useTopToast();
  return <div className="toast">{api.topToast ? api.topToast.text : ''}</div>;
}

let container;
let root;
beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const text = () => container.querySelector('.toast').textContent;
const advance = ms => act(() => { vi.advanceTimersByTime(ms); });
const undo = { label: '되돌리기', onClick: () => {} };

test('보이는 동안에는 정한 시간 뒤에 사라진다 — 누를 수 있는 알림은 더 오래', () => {
  act(() => api.showTopToast('그냥 알림'));
  advance(TOP_TOAST_MS.plain - 1);
  expect(text()).toBe('그냥 알림');
  advance(1);
  expect(text()).toBe('');

  act(() => api.showTopToast('바로 추가됨', undo));
  advance(TOP_TOAST_MS.action - 1);
  expect(text()).toBe('바로 추가됨');
  advance(1);
  expect(text()).toBe('');
});

test('잠깐 다녀와도 돌아온 뒤 처음부터 센다 — 가려진 시간을 세지 않는다', () => {
  act(() => api.showTopToast('바로 추가됨', undo));
  advance(1000);
  setVisibility('hidden');
  advance(8000);                                      // 은행 앱에 8초 (보이던 1초 + 8초 < 10초)
  setVisibility('visible');
  advance(TOP_TOAST_MS.action - 1);
  expect(text()).toBe('바로 추가됨');
  advance(1);
  expect(text()).toBe('');
});

test('가려진 동안 타이머가 얼었다가 돌아온 뒤 밀려 실행되는 브라우저에서도, 돌아오자마자 사라지지 않는다', () => {
  act(() => api.showTopToast('바로 추가됨', undo));
  advance(9000);
  setVisibility('hidden');                            // 여기서 세던 타이머를 지운다
  setVisibility('visible');                           // (얼었던 시간 동안 실제 시계는 흘렀다)
  advance(1000);                                      // 옛 타이머가 남아 있었다면 지금 사라졌을 것
  expect(text()).toBe('바로 추가됨');
  advance(TOP_TOAST_MS.action - 1000);
  expect(text()).toBe('');
});

test('가려진 동안에는 시간을 세지 않고, 돌아온 뒤 처음부터 센다', () => {
  act(() => api.showTopToast('바로 추가됨', undo));
  advance(5000);
  setVisibility('hidden');
  advance(60000);                                     // 다른 앱에 1분
  expect(text()).toBe('바로 추가됨');
  setVisibility('visible');
  advance(TOP_TOAST_MS.action - 1);
  expect(text()).toBe('바로 추가됨');
  advance(1);
  expect(text()).toBe('');
});

test('가려진 채 알림이 뜨면(백그라운드에서 분석이 끝남) 돌아온 뒤부터 센다', () => {
  setVisibility('hidden');
  act(() => api.showTopToast('바로 추가됨', undo));
  advance(60000);
  expect(text()).toBe('바로 추가됨');
  setVisibility('visible');
  advance(TOP_TOAST_MS.action);
  expect(text()).toBe('');
});

test('새 알림이 뜨거나 닫으면 앞 알림의 시간·기다리기를 그만둔다', () => {
  setVisibility('hidden');
  act(() => api.showTopToast('첫째', undo));
  setVisibility('visible');
  act(() => api.showTopToast('둘째'));
  advance(TOP_TOAST_MS.plain);
  expect(text()).toBe('');
  act(() => api.showTopToast('셋째', undo));
  act(() => api.hideTopToast());
  expect(text()).toBe('');
});
