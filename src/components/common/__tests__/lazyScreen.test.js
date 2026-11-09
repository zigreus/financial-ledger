/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 열 때 불러오는 화면 (I-033, ROADMAP Q-3) — 불러오는 동안·불러온 뒤·불러오지 못했을 때
import React, { Suspense, useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { lazyScreen, ModalLoading } from '../lazyScreen';

global.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
// 테스트가 중간에 실패해도 Date.now 가짜 값이 다음 테스트에 남지 않게
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

const render = el => act(async () => { root.render(el); });
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const click = el => act(async () => { el.click(); });

// 직접 풀어 주는 불러오기 — 몇 번 불렀는지 센다
function controlledLoad() {
  const calls = [];
  const load = () => new Promise((resolve, reject) => { calls.push({ resolve, reject }); });
  return { load, calls };
}

function Counter({ label }) {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>{label} {n}</button>;
}

test('불러오는 동안 fallback, 불러오면 화면 — 같은 화면을 다시 열면 기다리지 않는다', async () => {
  const { load, calls } = controlledLoad();
  const Screen = lazyScreen(load);
  await render(<Suspense fallback={<p>기다리는 중</p>}><Screen label="화면" /></Suspense>);
  expect(container.textContent).toBe('기다리는 중');
  expect(calls).toHaveLength(1);
  await act(async () => { calls[0].resolve({ default: Counter }); });
  expect(container.textContent).toBe('화면 0');

  // 닫았다가 다시 열면 fallback 없이 바로 그린다
  await render(<Suspense fallback={<p>기다리는 중</p>}>{null}</Suspense>);
  await render(<Suspense fallback={<p>기다리는 중</p>}><Screen label="다시" /></Suspense>);
  expect(container.textContent).toBe('다시 0');
  expect(calls).toHaveLength(1);
});

test('미리 불러 두면 처음 열 때도 기다리지 않고, 다시 그려도 상태가 남는다', async () => {
  const { load, calls } = controlledLoad();
  const Screen = lazyScreen(load);
  const ready = Screen.preload();
  expect(Screen.preload()).not.toBe(undefined);
  calls[0].resolve({ default: Counter });
  expect(await ready).toBe(true);
  expect(calls).toHaveLength(1);    // 두 번 미리 불러도 한 번만 받는다

  await render(<Suspense fallback={<p>기다리는 중</p>}><Screen label="화면" /></Suspense>);
  expect(container.textContent).toBe('화면 0');
  await click(button('화면 0'));
  await render(<Suspense fallback={<p>기다리는 중</p>}><Screen label="화면" /></Suspense>);
  expect(container.textContent).toBe('화면 1');
});

test('불러오던 중에 열어 둔 화면은 불러온 뒤에도 같은 화면으로 남는다(새로 그려 입력이 사라지지 않음)', async () => {
  const { load, calls } = controlledLoad();
  const Screen = lazyScreen(load);
  await render(<Suspense fallback={<p>기다리는 중</p>}><Screen label="화면" /></Suspense>);
  await act(async () => { calls[0].resolve({ default: Counter }); });
  await click(button('화면 0'));
  // 불러온 뒤 다시 그려도(부모가 다시 그림) 상태가 그대로
  await render(<Suspense fallback={<p>기다리는 중</p>}><Screen label="화면" /></Suspense>);
  expect(container.textContent).toBe('화면 1');
});

test('미리 불러오기에 실패해도 오류를 내지 않고, 열 때 다시 받는다', async () => {
  const { load, calls } = controlledLoad();
  const Screen = lazyScreen(load);
  const ready = Screen.preload();
  calls[0].reject(new Error('offline'));
  expect(await ready).toBe(false);

  await render(<Suspense fallback={<p>기다리는 중</p>}><Screen label="화면" /></Suspense>);
  expect(calls).toHaveLength(2);
  await act(async () => { calls[1].resolve({ default: Counter }); });
  expect(container.textContent).toBe('화면 0');
});

test('불러오지 못하면 다시 시도·새로 고침 — 다시 시도로 불러오면 화면을 그린다', async () => {
  const { load, calls } = controlledLoad();
  const Screen = lazyScreen(load);
  await render(<Suspense fallback={<p>기다리는 중</p>}><Screen label="화면" /></Suspense>);
  await act(async () => { calls[0].reject(new Error('404')); });
  expect(container.querySelector('[role="alert"]').textContent).toContain('화면을 불러오지 못했습니다');
  expect(button('새로 고침')).toBeDefined();
  expect(button('닫기')).toBeUndefined();     // 창 화면이 아니면 닫기가 없다

  // 다시 시도도 실패 — 새로 고침을 권한다
  await click(button('다시 시도'));
  expect(button('불러오는 중…').disabled).toBe(true);
  await act(async () => { calls[1].reject(new Error('404')); });
  expect(container.textContent).toContain('새로 고침');
  expect(container.textContent).toContain('앱이 새로 바뀌었을 수 있어요');

  await click(button('다시 시도'));
  await act(async () => { calls[2].resolve({ default: Counter }); });
  expect(container.textContent).toBe('화면 0');
});

test('실패한 화면을 닫았다가 다시 열면 누르지 않아도 한 번 다시 받아 본다', async () => {
  let now = 10000;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { load, calls } = controlledLoad();
  const Screen = lazyScreen(load);
  const open = () => render(<Suspense fallback={<p>기다리는 중</p>}><Screen label="화면" /></Suspense>);
  const close = () => render(<Suspense fallback={<p>기다리는 중</p>}>{null}</Suspense>);
  await open();
  await act(async () => { calls[0].reject(new Error('offline')); });
  expect(calls).toHaveLength(1);              // 처음 실패 화면에서는 다시 받지 않는다(방금 실패했다)
  expect(container.textContent).toContain('화면을 불러오지 못했습니다');

  // 곧바로(1초 안에) 닫았다 다시 열면 아직 다시 받지 않는다
  now += 500;
  await close();
  await open();
  expect(calls).toHaveLength(1);

  // 시간이 지나 다시 열었는데 또 실패 — 기본 안내 그대로(새로 고침 권유는 직접 다시 시도했을 때만)
  now += 5000;
  await close();
  await open();
  expect(calls).toHaveLength(2);
  expect(button('불러오는 중…').disabled).toBe(true);
  await act(async () => { calls[1].reject(new Error('offline')); });
  expect(button('다시 시도')).toBeDefined();
  expect(container.textContent).not.toContain('앱이 새로 바뀌었을 수 있어요');

  // 연결이 돌아온 뒤 다시 열면 그대로 화면이 열린다
  now += 5000;
  await close();
  await open();
  expect(calls).toHaveLength(3);
  await act(async () => { calls[2].resolve({ default: Counter }); });
  expect(container.textContent).toBe('화면 0');
  spy.mockRestore();
});

test('다른 화면 안에 들어가는 부분(inline)은 짧은 문구와 다시 시도만 — 새로 고침은 없다', async () => {
  const { load, calls } = controlledLoad();
  const Part = lazyScreen(load, { inline: 'AI 입력을 불러오지 못했습니다 — 직접 입력은 그대로 할 수 있어요.' });
  await render(<Suspense fallback={null}><Part label="AI" onClose={() => {}} /></Suspense>);
  await act(async () => { calls[0].reject(new Error('offline')); });
  const alert = container.querySelector('[role="alert"]');
  expect(alert.textContent).toContain('AI 입력을 불러오지 못했습니다');
  expect(button('새로 고침')).toBeUndefined();
  expect(button('닫기')).toBeUndefined();
  expect(container.querySelector('.modal-overlay')).toBeNull();
  expect(button('다시 시도').type).toBe('button');   // 입력 창의 form 안에서 눌러도 제출되지 않게

  await click(button('다시 시도'));
  await act(async () => { calls[1].reject(new Error('offline')); });
  expect(container.textContent).toContain('계속 안 되면 입력을 마친 뒤 앱을 새로 고쳐 주세요');
  await click(button('다시 시도'));
  await act(async () => { calls[2].resolve({ default: Counter }); });
  expect(container.textContent).toBe('AI 0');
});

test('창을 불러오는 동안에는 뒤 화면을 가리는 창을 보이고, 오래 걸리면 닫기를 보인다', async () => {
  vi.useFakeTimers();
  try {
    const onClose = vi.fn();
    await render(<ModalLoading onClose={onClose} />);
    expect(container.querySelector('.modal-overlay [role="status"]')).not.toBeNull();
    expect(button('닫기')).toBeUndefined();
    await act(async () => { vi.advanceTimersByTime(3000); });
    await click(button('닫기'));
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test('창 화면(onClose를 받음)이면 창으로 보이고 닫기를 둔다', async () => {
  const { load, calls } = controlledLoad();
  const Screen = lazyScreen(load);
  const onClose = vi.fn();
  await render(<Suspense fallback={null}><Screen onClose={onClose} /></Suspense>);
  await act(async () => { calls[0].reject(new Error('offline')); });
  expect(container.querySelector('.modal-overlay [role="alert"]')).not.toBeNull();
  await click(button('닫기'));
  expect(onClose).toHaveBeenCalledTimes(1);
});
