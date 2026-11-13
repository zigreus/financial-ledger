/**
 * @vitest-environment jsdom
 */
// 머리글의 맞추는 중 표시 (B-095, I-057) — 글자 대신 🔄이 돌고, 오프라인 배지는 그대로
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import Header from '../Header';

vi.mock('@azure/msal-react', () => ({ useMsal: () => ({ accounts: [] }) }));

global.IS_REACT_ACT_ENVIRONMENT = true;

function render(props) {
  const el = document.createElement('div');
  const root = createRoot(el);
  act(() => { root.render(<Header onRefresh={() => {}} onSettings={() => {}} onLogout={() => {}} {...props} />); });
  return { el, unmount: () => act(() => root.unmount()) };
}
const refresh = el => el.querySelector('.btn-refresh');

test('평소에는 🔄이 멈춰 있다', () => {
  const { el, unmount } = render({});
  expect(refresh(el).classList.contains('is-syncing')).toBe(false);
  expect(el.querySelector('.header-offline')).toBeNull();
  unmount();
});

test('사본으로 먼저 열고 받는 중이면 글자 배지 없이 🔄이 돈다', () => {
  const { el, unmount } = render({ catchingUp: true });
  expect(refresh(el).classList.contains('is-syncing')).toBe(true);
  expect(el.querySelector('.header-offline')).toBeNull();
  expect(el.textContent).not.toMatch(/맞추는 중/);
  expect(refresh(el).disabled).toBe(false);                 // 누르면 그 받기에 합류한다
  unmount();
});

test('오프라인이어도 뒤에서 다시 시도하는 동안은 오프라인 배지와 함께 🔄이 돈다', () => {
  const { el, unmount } = render({ offline: true, syncing: true });
  expect(el.querySelector('.header-offline').textContent).toBe('오프라인');
  expect(refresh(el).classList.contains('is-syncing')).toBe(true);
  unmount();
});
