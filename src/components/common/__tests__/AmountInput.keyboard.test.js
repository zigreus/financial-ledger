/**
 * @vitest-environment jsdom
 */
// 금액 칸이 키보드에 가리지 않게 (B-100) — getBoundingClientRect는 레이아웃 뷰포트 기준이라
// 브라우저가 화면을 끌어올린 만큼(visualViewport.offsetTop) 보이는 곳의 아래 끝도 아래에 있다
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

global.IS_REACT_ACT_ENVIRONMENT = true;
const H = window.innerHeight;
const KB = 330;
const TOOLBAR = 52 + 16;   // 툴바(아직 잴 수 없으면 52) + 여유

let AmountInput;
let root;
let container;
let vv;
let scroller;
beforeAll(async () => {
  // 터치 기기에서만 하는 처리 — 모듈을 불러올 때 정하므로 먼저 꾸민다
  window.matchMedia = (q) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame = (cb) => { cb(); return 0; };
  ({ default: AmountInput } = await import('../AmountInput'));
});
beforeEach(() => {
  vv = new EventTarget();
  Object.assign(vv, { height: H, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete window.visualViewport;
});

// 스크롤 칸(바닥 scrollerBottom) 안의 금액 칸(600~650)에 초점을 두고 키보드를 연다
async function focusWithKeyboard({ offsetTop, scrollerBottom }) {
  await act(async () => {
    root.render(<div className="scroller" style={{ overflowY: 'auto' }}><AmountInput value="" onChange={() => {}} /></div>);
  });
  scroller = container.querySelector('.scroller');
  Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: scrollerBottom });
  // 스크롤하면 칸이 그만큼 올라간다(두 번째로 맞출 때 더 스크롤하지 않게)
  container.querySelector('.amount-input').getBoundingClientRect = () => ({ top: 600 - scroller.scrollTop, bottom: 650 - scroller.scrollTop });
  Object.assign(vv, { height: H - KB, offsetTop });
  await act(async () => { container.querySelector('input').focus(); });
}

test('끌어올리지 않았으면 가린 높이(키보드)만큼 여백을 두고 툴바 위까지 스크롤한다 — 전과 같다', async () => {
  await focusWithKeyboard({ offsetTop: 0, scrollerBottom: H });
  expect(scroller.style.paddingBottom).toBe(`${KB + TOOLBAR}px`);
  expect(scroller.scrollTop).toBe(650 - (H - KB - 52 - 8));
});

test('브라우저가 화면을 끌어올렸으면 그만큼 덜 스크롤한다(더 하면 칸이 창 머리 밑에 숨는다)', async () => {
  await focusWithKeyboard({ offsetTop: 200, scrollerBottom: H });
  expect(scroller.style.paddingBottom).toBe(`${KB - 200 + TOOLBAR}px`);
  expect(scroller.scrollTop).toBe(Math.max(0, 650 - (200 + H - KB - 52 - 8)));
});

test('키보드 위에 맞춘 창(ModalOverlay fitKeyboard)이면 가린 곳이 없어 툴바 자리만 둔다', async () => {
  await focusWithKeyboard({ offsetTop: 0, scrollerBottom: H - KB });
  expect(scroller.style.paddingBottom).toBe(`${TOOLBAR}px`);
});

test('키보드 높이만큼 다 끌어올렸어도(아래 끝이 레이아웃과 같음) 키보드가 열려 있으면 툴바 자리를 둔다', async () => {
  await focusWithKeyboard({ offsetTop: KB, scrollerBottom: H });
  expect(scroller.style.paddingBottom).toBe(`${TOOLBAR}px`);
});
