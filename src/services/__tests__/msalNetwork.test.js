// MSAL 통신에 제한 시간 (auth/msalNetwork.js, B-094) — 멈춘 토큰 요청이 MSAL의 묶음에 남아 다음 시도들을 붙잡지 않게
import { createTimedNetworkClient } from '../../auth/msalNetwork';

const okResponse = (body, status = 200) => ({
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => body,
});

test('응답은 기본 통신과 같은 모양 { headers, body, status }로 돌려준다', async () => {
  const fetchImpl = vi.fn(async () => okResponse({ access_token: 't' }, 200));
  const client = createTimedNetworkClient({ fetchImpl });
  const res = await client.sendPostRequestAsync('https://login.example/token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  expect(res).toMatchObject({ status: 200, body: { access_token: 't' } });
  expect(res.headers['content-type']).toBe('application/json');
  const [, init] = fetchImpl.mock.calls[0];
  expect(init.method).toBe('POST');
  expect(init.body).toBe('a=1');
  expect(init.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
});

test('응답이 오지 않으면 끊고 MSAL의 연결 오류 코드로 실패한다(저장소가 연결 없음으로 알아본다)', async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const client = createTimedNetworkClient({ fetchImpl, timeoutMs: 30 });
  await expect(client.sendPostRequestAsync('https://login.example/token', {})).rejects.toMatchObject({ errorCode: 'post_request_failed' });
  await expect(client.sendGetRequestAsync('https://login.example/meta', {})).rejects.toMatchObject({ errorCode: 'get_request_failed' });
});

test('내용이 JSON이 아니면 기본과 같은 오류', async () => {
  const fetchImpl = async () => ({ status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('x'); } });
  const client = createTimedNetworkClient({ fetchImpl });
  await expect(client.sendGetRequestAsync('https://login.example/meta')).rejects.toMatchObject({ errorCode: 'failed_to_parse_response' });
});
