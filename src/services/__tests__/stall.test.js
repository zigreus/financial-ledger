// 멈춘 요청 끊기 (storage/stall.js) — 느려도 오고 있으면 기다리고, 아무것도 오지 않을 때만 끊는다
import { OfflineError } from '../storage/provider';
import { StalledError, poke, readBody, stallSignal, stopStall, untilStalled, uploadStallMs } from '../storage/stall';

const wait = ms => new Promise(r => setTimeout(r, ms));

/** 조각을 gapMs 간격으로 보내는 응답 */
function slowResponse(chunks, gapMs) {
  let i = 0;
  return {
    body: {
      getReader: () => ({
        read: async () => {
          await wait(gapMs);
          return i < chunks.length ? { done: false, value: new Uint8Array(chunks[i++]) } : { done: true };
        },
      }),
    },
  };
}

test('멈춤 시계가 다 가면 signal이 StalledError로 끊긴다(연결 없음과 같은 갈래)', async () => {
  const signal = stallSignal('가계부 받기', 30);
  await wait(60);
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBeInstanceOf(StalledError);
  expect(signal.reason).toBeInstanceOf(OfflineError);
  expect(signal.reason.message).toMatch(/가계부 받기.*멈춰/);
});

test('poke가 오는 동안은 끊지 않고, 멈추면 끊지 않는다(stopStall)', async () => {
  const signal = stallSignal('x', 40);
  for (let i = 0; i < 5; i += 1) { await wait(20); poke(signal); }   // 모두 100ms — 시계(40ms)보다 길지만 계속 온다
  expect(signal.aborted).toBe(false);
  stopStall(signal);
  await wait(60);
  expect(signal.aborted).toBe(false);
});

test('느려도 조각이 계속 오면 끝까지 받는다', async () => {
  const signal = stallSignal('x', 40);
  const bytes = await readBody(slowResponse([[1, 2], [3], [4, 5]], 25), signal);  // 모두 100ms
  expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
  stopStall(signal);
});

test('받다가 멈추면 StalledError', async () => {
  const signal = stallSignal('x', 30);
  const res = { body: { getReader: () => ({ read: () => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); }) }) } };
  await expect(readBody(res, signal)).rejects.toBeInstanceOf(StalledError);
});

test('signal을 받지 않는 일(로그인 토큰)도 멈추면 끊는다', async () => {
  const signal = stallSignal('토큰', 30);
  await expect(untilStalled(new Promise(() => {}), signal)).rejects.toBeInstanceOf(StalledError);
  const ok = stallSignal('토큰', 30);
  await expect(untilStalled(Promise.resolve('t'), ok)).resolves.toBe('t');
  stopStall(ok);
});

test('올리기는 크기만큼 더 기다린다', () => {
  expect(uploadStallMs(null, 1000)).toBe(1000);
  expect(uploadStallMs(new Uint8Array(16 * 1024 * 10), 1000)).toBe(11000);
});
