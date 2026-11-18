/**
 * @vitest-environment jsdom
 */
// Esc로 창 닫기 (ROADMAP U-10) — 맨 위 창만, onDismiss가 있는 창만
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ModalOverlay from '../ModalOverlay';

global.IS_REACT_ACT_ENVIRONMENT = true;
let root;
let container;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const esc = () => act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

test('창 위에 입력 창(닫히지 않는 창)이 열려 있으면 Esc로 아래 창도 닫히지 않는다 — 입력 창이 닫히면 아래 창이 Esc로 닫힌다', async () => {
  const outer = vi.fn();
  const render = (withForm) => act(async () => {
    root.render(
      <>
        <ModalOverlay className="outer" onDismiss={outer}><p>상세</p></ModalOverlay>
        {withForm && <ModalOverlay className="form"><input /></ModalOverlay>}
      </>,
    );
  });
  await render(true);
  await esc();
  expect(outer).not.toHaveBeenCalled();
  await render(false);
  await esc();
  expect(outer).toHaveBeenCalledTimes(1);
});

test('둘 다 닫히는 창이면 맨 위 창 하나만 닫는다 — 이미 쓴 Esc(preventDefault)는 건너뛴다', async () => {
  const outer = vi.fn();
  const inner = vi.fn();
  await act(async () => {
    root.render(
      <>
        <ModalOverlay className="outer" onDismiss={outer}><p>바깥</p></ModalOverlay>
        <ModalOverlay className="inner" onDismiss={inner}><p>안</p></ModalOverlay>
      </>,
    );
  });
  await esc();
  expect(inner).toHaveBeenCalledTimes(1);
  expect(outer).not.toHaveBeenCalled();
  const used = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  used.preventDefault();
  await act(async () => { document.dispatchEvent(used); });
  expect(inner).toHaveBeenCalledTimes(1);
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  expect(inner).toHaveBeenCalledTimes(1);
});

// 키보드 위 보이는 곳에 맞추기 (B-100) — 휴대폰 브라우저는 키보드가 열려도 고정 창을 줄이지 않고 화면을 끌어올린다
describe('fitKeyboard', () => {
  let vv;
  const H = window.innerHeight;
  beforeEach(() => {
    vv = new EventTarget();
    Object.assign(vv, { height: H, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  });
  afterEach(() => { delete window.visualViewport; });

  const viewport = (props) => act(async () => { Object.assign(vv, props); vv.dispatchEvent(new Event('resize')); });
  const overlayEl = () => container.querySelector('.modal-overlay');
  // 판은 inset: 0 — 레이아웃 뷰포트 전체(jsdom은 배치를 하지 않아 사각형을 정해 준다)
  const layOut = () => { overlayEl().getBoundingClientRect = () => ({ top: 0, bottom: H, height: H }); };
  const show = (ui) => act(async () => { root.render(ui); });
  const padding = () => [overlayEl().style.paddingTop, overlayEl().style.paddingBottom];

  test('키보드가 열리면 보이는 곳 바깥(끌어올린 위·키보드 밑)을 판의 안쪽 여백으로 비우고, 닫히면 원래대로(CSS) 둔다', async () => {
    await show(<ModalOverlay className="modal-overlay" panelClassName="panel" fitKeyboard><textarea /></ModalOverlay>);
    layOut();
    expect(overlayEl().className).toBe('modal-overlay modal-fit-keyboard');
    expect(padding()).toEqual(['', '']);
    await viewport({ height: H - 330, offsetTop: 120 });
    expect(padding()).toEqual(['120px', '210px']);
    await act(async () => { Object.assign(vv, { offsetTop: 40 }); vv.dispatchEvent(new Event('scroll')); });
    expect(padding()).toEqual(['40px', '290px']);
    await viewport({ height: H, offsetTop: 0 });
    expect(padding()).toEqual(['', '']);
  });

  test('두 손가락으로 확대해 보이는 곳이 작아진 것은 맞추지 않는다 — fitKeyboard가 없는 창도 그대로', async () => {
    await show(<ModalOverlay className="modal-overlay" panelClassName="panel" fitKeyboard><textarea /></ModalOverlay>);
    layOut();
    await viewport({ height: H / 2, offsetTop: 100, scale: 2 });
    expect(padding()).toEqual(['', '']);
    await show(<ModalOverlay className="modal-overlay" panelClassName="panel"><textarea /></ModalOverlay>);
    layOut();
    await viewport({ height: H - 330, offsetTop: 0, scale: 1 });
    expect(overlayEl().className).toBe('modal-overlay');
    expect(padding()).toEqual(['', '']);
  });

  test('키보드가 열린 채 fitKeyboard를 끄면(또는 창이 닫히면) 맞춘 여백을 지우고 더 따라가지 않는다', async () => {
    await show(<ModalOverlay className="modal-overlay" panelClassName="panel" fitKeyboard><textarea /></ModalOverlay>);
    layOut();
    await viewport({ height: H - 330, offsetTop: 0 });
    expect(padding()).toEqual(['0px', '330px']);
    await show(<ModalOverlay className="modal-overlay" panelClassName="panel"><textarea /></ModalOverlay>);
    expect(padding()).toEqual(['', '']);
    await viewport({ height: H - 300 });
    expect(padding()).toEqual(['', '']);
  });

  describe('창이 작아져 입력 칸이 밀리면', () => {
    let panel;
    let box;
    let rect;
    const render = async (wrapped = false) => {
      const field = <textarea />;
      await show(
        <ModalOverlay className="modal-overlay" panelClassName="panel" fitKeyboard>
          <div className="head" style={{ position: 'sticky' }}>머리</div>
          {wrapped ? <div className="wrap" style={{ overflowY: 'auto' }}>{field}</div> : field}
        </ModalOverlay>,
      );
      layOut();
      panel = container.querySelector('.panel');
      box = container.querySelector('textarea');
      panel.style.overflowY = 'auto';
      Object.defineProperty(panel, 'scrollHeight', { value: 900 });
      Object.defineProperty(panel, 'clientHeight', { value: 400 });
      Object.defineProperty(panel, 'scrollTop', { value: 100, writable: true });
      Object.defineProperty(container.querySelector('.head'), 'offsetHeight', { value: 60 });
      panel.getBoundingClientRect = () => ({ top: 300, bottom: 700 });
      box.getBoundingClientRect = () => rect;
    };

    test('창의 스크롤 영역 안에서만 스크롤해 보이게 한다 — 위에 붙은 머리글에 가리지 않게', async () => {
      await render();
      rect = { top: 640, bottom: 730 };   // 아래 끝(700-8)보다 38 아래
      box.focus();
      await viewport({ height: H - 330, offsetTop: 0 });
      expect(panel.scrollTop).toBe(138);

      // 칸이 보이는 높이보다 크면 윗부분이 머리글 아래에 오도록까지만
      panel.scrollTop = 0;
      rect = { top: 400, bottom: 1000 };
      await viewport({ height: H - 340 });
      expect(panel.scrollTop).toBe(400 - (300 + 60 + 8));

      // 머리글 밑에 가려 있으면 그만큼 올린다 / 보이는 높이가 그대로(화면만 밀림)면 건드리지 않는다
      panel.scrollTop = 100;
      rect = { top: 320, bottom: 400 };
      await act(async () => { vv.dispatchEvent(new Event('scroll')); });
      expect(panel.scrollTop).toBe(100);
      await viewport({ height: H - 350 });
      expect(panel.scrollTop).toBe(100 - (368 - 320));
    });

    test('키보드를 닫았다가 같은 높이로 다시 열어도 밀린 칸을 다시 보이게 한다', async () => {
      await render();
      rect = { top: 640, bottom: 730 };
      box.focus();
      await viewport({ height: H - 330, offsetTop: 0 });
      expect(panel.scrollTop).toBe(138);
      await viewport({ height: H });
      expect(padding()).toEqual(['', '']);
      panel.scrollTop = 100;
      await viewport({ height: H - 330 });
      expect(panel.scrollTop).toBe(138);
    });

    test('스크롤하지 않는 overflow 칸은 건너뛰고 창을 스크롤한다', async () => {
      await render(true);
      const wrap = container.querySelector('.wrap');
      Object.defineProperty(wrap, 'scrollHeight', { value: 90 });
      Object.defineProperty(wrap, 'clientHeight', { value: 90 });
      wrap.getBoundingClientRect = () => ({ top: 640, bottom: 730 });
      rect = { top: 640, bottom: 730 };
      box.focus();
      await viewport({ height: H - 330, offsetTop: 0 });
      expect(panel.scrollTop).toBe(138);
    });

    test('초점이 창 밖(뒤 화면의 스크롤 칸)에 있으면 아무것도 스크롤하지 않는다', async () => {
      await render();
      const page = document.createElement('div');
      page.style.overflowY = 'auto';
      Object.defineProperty(page, 'scrollHeight', { value: 900 });
      Object.defineProperty(page, 'clientHeight', { value: 400 });
      Object.defineProperty(page, 'scrollTop', { value: 0, writable: true });
      page.getBoundingClientRect = () => ({ top: 300, bottom: 700 });
      const outside = document.createElement('input');
      outside.getBoundingClientRect = () => ({ top: 640, bottom: 730 });
      page.appendChild(outside);
      document.body.appendChild(page);
      outside.focus();
      await viewport({ height: H - 330, offsetTop: 0 });
      expect(page.scrollTop).toBe(0);
      expect(panel.scrollTop).toBe(100);
      page.remove();
    });
  });
});
