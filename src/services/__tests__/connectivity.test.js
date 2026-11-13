// 인터넷이 되는지 (services/connectivity.js, I-058) — 이 앱 사이트에 HEAD 하나, 외부 서비스에 묻지 않는다
import { internetReachable } from '../connectivity';

test('이 앱 사이트에서 응답이 오면(상태와 관계없이) 인터넷은 된다 — 캐시를 쓰지 않는 HEAD 요청', async () => {
  const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }));
  expect(await internetReachable({ fetchImpl })).toBe(true);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toMatch(/^\/robots\.txt\?reach=\d+$/);       // 같은 사이트(상대 주소)
  expect(init).toMatchObject({ method: 'HEAD', cache: 'no-store' });
});

test('요청이 실패하거나 응답이 없으면 인터넷이 안 된다', async () => {
  expect(await internetReachable({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } })).toBe(false);
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  expect(await internetReachable({ fetchImpl: hang, timeoutMs: 20 })).toBe(false);
});
