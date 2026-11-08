/**
 * @vitest-environment jsdom
 */
// 화면이 꺼지거나 다른 앱에 간 사이 끊긴 AI 요청 (I-023) — 돌아오면 다시 보내고, 분석하는 동안 화면을 켜 둔다
import { analyzeWithAI, AIError, RESUME } from '../aiClient';
import { keepScreenOn } from '../wakeLock';

const GEMINI = { provider: 'gemini', apiKey: 'k', model: 'gemini-flash-latest' };
const BASE = { system: 's', prompt: 'p', schema: { type: 'object', properties: {} }, toolName: 't' };
const ok = obj => Promise.resolve({
  ok: true, status: 200, statusText: '', headers: { get: () => null },
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }),
});
const dropped = () => Promise.reject(new TypeError('Load failed'));

let visibility = 'visible';
let online = true;
beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
});
const savedResume = { ...RESUME };
beforeEach(() => {
  visibility = 'visible'; online = true; delete navigator.wakeLock;
  RESUME.settleMs = 1;
});
afterEach(() => { Object.assign(RESUME, savedResume); });
const setVisibility = (v) => { visibility = v; document.dispatchEvent(new Event('visibilitychange')); };
const flush = () => new Promise(r => setTimeout(r, 0));

/** 앱이 가려진 채 끊긴 요청 — 가려지고 나서 연결이 끊긴다 */
const hiddenThenDropped = () => { setVisibility('hidden'); return dropped(); };

describe('끊긴 요청 다시 보내기', () => {
  test('가려진 사이 끊기면 오류 대신 기다렸다가, 화면이 다시 보이면 같은 요청을 보내 결과를 받는다', async () => {
    let n = 0;
    global.fetch = vi.fn(() => (n++ === 0 ? hiddenThenDropped() : ok({ total: 4500 })));
    const progress = [];
    const run = analyzeWithAI({ ...BASE, ai: GEMINI, onProgress: m => progress.push(m) });
    let settled = false;
    run.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);                               // 가려진 동안은 기다린다
    expect(progress.join('\n')).toContain('끊긴 요청을 다시 보내는 중… (1/2)');

    setVisibility('visible');
    expect(await run).toEqual({ total: 4500 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][1].body).toBe(global.fetch.mock.calls[0][1].body); // 같은 요청
  });

  test('계속 보이던 중에 끊긴 것은 지금처럼 바로 네트워크 오류다', async () => {
    global.fetch = vi.fn(dropped);
    const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
    expect(err).toBeInstanceOf(AIError);
    expect(err.kind).toBe('network');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('응답 본문을 받는 도중 가려져 끊겨도 다시 보낸다', async () => {
    let n = 0;
    global.fetch = vi.fn(() => (n++ === 0
      ? Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => { setVisibility('hidden'); throw new TypeError('Load failed'); } })
      : ok({ total: 1 })));
    const run = analyzeWithAI({ ...BASE, ai: GEMINI });
    await flush();
    setVisibility('visible');
    expect(await run).toEqual({ total: 1 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('다시 보내기는 두 번까지 — 그래도 끊기면 네트워크 오류', async () => {
    global.fetch = vi.fn(hiddenThenDropped);
    const run = analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
    for (let i = 0; i < 3; i += 1) { await flush(); setVisibility('visible'); }
    const err = await run;
    expect(err.kind).toBe('network');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('돌아오기를 기다리는 동안 취소하면 취소로 끝난다(오류가 아님)', async () => {
    global.fetch = vi.fn(hiddenThenDropped);
    const controller = new AbortController();
    const run = analyzeWithAI({ ...BASE, ai: GEMINI, signal: controller.signal }).catch(e => e);
    await flush();
    controller.abort();
    const err = await run;
    expect(err.name).toBe('AbortError');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('돌아와 다시 보낸 요청이 곧바로 또 끊기면(망이 아직 안 붙음) 잠깐 기다렸다 한 번 더 보낸다', async () => {
    let n = 0;
    global.fetch = vi.fn(() => {
      n += 1;
      if (n === 1) return hiddenThenDropped();
      if (n === 2) return dropped();                         // 화면을 켠 직후 — 보이는 채로 끊김 (onLine은 true)
      return ok({ total: 7 });
    });
    const progress = [];
    const run = analyzeWithAI({ ...BASE, ai: GEMINI, onProgress: m => progress.push(m) });
    await flush();
    setVisibility('visible');
    expect(await run).toEqual({ total: 7 });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(progress.join('\n')).toContain('(2/2)');
  });

  test('처음부터 보이는 채로 끊긴 요청은 기다리지 않는다 — 돌아와서 다시 보낸 것만 한 번 더', async () => {
    let n = 0;
    global.fetch = vi.fn(() => (n++ === 0 ? ok({ total: 1 }) : dropped()));
    expect(await analyzeWithAI({ ...BASE, ai: GEMINI })).toEqual({ total: 1 });
    const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
    expect(err.kind).toBe('network');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('느리지만 멀쩡한 요청은 잠깐 다녀와도 끊거나 다시 보내지 않는다 (두 번 과금되지 않게)', async () => {
    global.fetch = vi.fn(() => {
      setVisibility('hidden');
      return new Promise(resolve => setTimeout(() => resolve(ok({ total: 8 })), 60));   // Claude처럼 오래 걸린다
    });
    const run = analyzeWithAI({ ...BASE, ai: GEMINI });
    await flush();
    setVisibility('visible');                                // 3초쯤 다른 앱을 보고 돌아왔다
    expect(await run).toEqual({ total: 8 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('돌아온 뒤 기다리는 동안 사용자가 취소하면 취소로 끝난다', async () => {
    global.fetch = vi.fn((url, init) => {
      setVisibility('hidden');
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      });
    });
    const controller = new AbortController();
    const run = analyzeWithAI({ ...BASE, ai: GEMINI, signal: controller.signal }).catch(e => e);
    await flush();
    setVisibility('visible');
    controller.abort();
    expect((await run).name).toBe('AbortError');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('보이는 채로 페이지가 멈췄다 끊긴 경우(pagehide)도 가려진 것으로 보고 다시 보낸다', async () => {
    let n = 0;
    global.fetch = vi.fn(() => {
      n += 1;
      if (n > 1) return ok({ total: 5 });
      window.dispatchEvent(new Event('pagehide'));
      return dropped();
    });
    expect(await analyzeWithAI({ ...BASE, ai: GEMINI })).toEqual({ total: 5 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('돌아왔는데 아직 연결이 없으면 다시 이어질 때까지 잠깐 기다렸다 보낸다', async () => {
    let n = 0;
    global.fetch = vi.fn(() => (n++ === 0 ? hiddenThenDropped() : ok({ total: 2 })));
    const run = analyzeWithAI({ ...BASE, ai: GEMINI });
    await flush();
    online = false;
    setVisibility('visible');
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);            // 연결을 기다린다
    online = true;
    window.dispatchEvent(new Event('online'));
    expect(await run).toEqual({ total: 2 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('분석하는 동안 화면 켜 두기 (Wake Lock)', () => {
  function fakeWakeLock() {
    const locks = [];
    navigator.wakeLock = {
      request: vi.fn(async () => {
        const listeners = [];
        const lock = {
          released: false,
          release: vi.fn(async () => { lock.released = true; listeners.forEach(fn => fn()); }),
          addEventListener: (type, fn) => { if (type === 'release') listeners.push(fn); },
          fire: () => { lock.released = true; listeners.forEach(fn => fn()); }, // 브라우저가 풀었다
        };
        locks.push(lock);
        return lock;
      }),
    };
    return locks;
  }

  test('분석하는 동안 화면 꺼짐을 막고, 끝나거나 실패하면 놓는다', async () => {
    const locks = fakeWakeLock();
    global.fetch = vi.fn(() => ok({ total: 1 }));
    await analyzeWithAI({ ...BASE, ai: GEMINI });
    expect(navigator.wakeLock.request).toHaveBeenCalledWith('screen');
    expect(locks[0].release).toHaveBeenCalledTimes(1);

    global.fetch = vi.fn(dropped);
    await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(() => {});
    expect(locks[1].release).toHaveBeenCalledTimes(1);
  });

  test('여럿이 잡아도 잠금은 하나, 모두 놓을 때 푼다. 가려졌다 돌아오면 아직 필요할 때 다시 건다', async () => {
    const locks = fakeWakeLock();
    const a = keepScreenOn();
    const b = keepScreenOn();
    await flush();
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(1);
    a();
    a();                                                       // 두 번 불러도 한 번만
    expect(locks[0].release).not.toHaveBeenCalled();

    locks[0].fire();                                           // 화면이 가려지면 브라우저가 푼다
    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(2);
    b();
    expect(locks[1].release).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(2); // 다 놓은 뒤에는 다시 걸지 않는다
  });

  test('지원하지 않거나 거절되면 조용히 넘어간다', async () => {
    const release = keepScreenOn();                            // wakeLock 없음
    expect(() => release()).not.toThrow();
    navigator.wakeLock = { request: vi.fn(async () => { throw new Error('NotAllowedError'); }) };
    global.fetch = vi.fn(() => ok({ total: 3 }));
    expect(await analyzeWithAI({ ...BASE, ai: GEMINI })).toEqual({ total: 3 });
  });
});
