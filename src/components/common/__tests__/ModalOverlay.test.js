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
