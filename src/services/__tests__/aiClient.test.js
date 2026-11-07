/**
 * @vitest-environment node
 */
// AI 서버 혼잡(503/529) 시 다시 시도·다른 모델 전환 (B-064)
import { analyzeWithAI, AIError, RETRY } from '../aiClient';

const GEMINI = { provider: 'gemini', apiKey: 'k', model: 'gemini-flash-latest' };
const BASE = { system: 's', prompt: 'p', schema: { type: 'object', properties: {} }, toolName: 't' };

const reply = (status, body) => Promise.resolve({ ok: status < 400, status, statusText: '', json: async () => body });
const ok = obj => reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const overloaded = () => reply(503, { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } });
const modelList = ids => reply(200, {
  models: ids.map(n => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })),
});

/** URL로 응답을 고르는 가짜 fetch. handlers: { [모델 이름 | 'list']: () => Promise } */
function route(handlers) {
  return vi.fn((url) => {
    if (url.includes('/models?')) return handlers.list();
    const model = decodeURIComponent(url.match(/models\/([^:]+):/)[1]);
    return handlers[model]();
  });
}
const calls = (fetch, model) => fetch.mock.calls.filter(([u]) => u.includes(`models/${model}:`)).length;

const saved = { ...RETRY };
beforeEach(() => { RETRY.first = [1, 1]; RETRY.alternate = [1]; });
afterEach(() => { Object.assign(RETRY, saved); });

test('한 번 붐볐다가 다시 하면 되는 경우 — 사용자는 진행 문구만 본다', async () => {
  let n = 0;
  global.fetch = route({ 'gemini-flash-latest': () => (n++ === 0 ? overloaded() : ok({ total: 6300 })) });
  const progress = [];
  const out = await analyzeWithAI({ ...BASE, ai: GEMINI, onProgress: m => progress.push(m) });
  expect(out).toEqual({ total: 6300 });
  expect(calls(fetch, 'gemini-flash-latest')).toBe(2);
  expect(progress).toEqual(['서버가 붐벼서 다시 시도하는 중… (1/2)']);
});

test('계속 붐비면 이 키로 쓸 수 있는 다른 안정판 모델로 바꿔 시도한다', async () => {
  global.fetch = route({
    'gemini-flash-latest': overloaded,
    list: () => modelList(['gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-3.8-flash', 'gemini-3.6-flash']),
    'gemini-3.8-flash': overloaded,
    'gemini-3.6-flash': () => ok({ total: 4500 }),
  });
  const progress = [];
  const out = await analyzeWithAI({ ...BASE, ai: GEMINI, onProgress: m => progress.push(m) });
  expect(out).toEqual({ total: 4500 });
  expect(calls(fetch, 'gemini-flash-latest')).toBe(3);   // 처음 + 다시 2번
  expect(calls(fetch, 'gemini-3-flash-preview')).toBe(0); // 미리보기는 대신 쓰지 않는다
  expect(calls(fetch, 'gemini-3.8-flash')).toBe(2);       // 대신 쓰는 모델은 1번만 더
  expect(progress).toContain('gemini-flash-latest이(가) 붐벼서 gemini-3.6-flash(으)로 시도하는 중…');
});

test('모두 붐비면 사용량 문제가 아니라고 알려 준다', async () => {
  global.fetch = route({
    'gemini-flash-latest': overloaded,
    list: () => modelList(['gemini-flash-latest', 'gemini-3.6-flash']),
    'gemini-3.6-flash': overloaded,
  });
  const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
  expect(err).toBeInstanceOf(AIError);
  expect(err.kind).toBe('overloaded');
  expect(err.message).toContain('사용량 문제는 아니에요');
  expect(err.message).toContain('gemini-3.6-flash');
});

test('키 오류는 다시 시도하지 않는다', async () => {
  global.fetch = route({ 'gemini-flash-latest': () => reply(403, { error: { message: 'API key not valid' } }) });
  const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
  expect(err.kind).toBe('auth');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('분당 한도(429)는 서버가 짧게 기다리라고 할 때만 한 번 기다렸다 다시 한다', async () => {
  let n = 0;
  const limited = () => reply(429, { error: { message: 'Resource exhausted', details: [
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0s' },
  ] } });
  global.fetch = route({ 'gemini-flash-latest': () => (n++ === 0 ? limited() : ok({ ok: 1 })) });
  expect(await analyzeWithAI({ ...BASE, ai: GEMINI })).toEqual({ ok: 1 });

  global.fetch = route({ 'gemini-flash-latest': () => reply(429, { error: { message: 'Quota exceeded for today' } }) });
  const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
  expect(err.kind).toBe('quota');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('기다리는 중에 취소하면 더 보내지 않고 취소로 끝난다', async () => {
  RETRY.first = [10000, 10000];
  const controller = new AbortController();
  global.fetch = route({ 'gemini-flash-latest': overloaded });
  const pending = analyzeWithAI({ ...BASE, ai: GEMINI, signal: controller.signal }).catch(e => e);
  await new Promise(r => setTimeout(r, 5));
  controller.abort();
  const err = await pending;
  expect(err.name).toBe('AbortError');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('Claude 529(overloaded)도 같은 방식으로 다시 시도한다', async () => {
  let n = 0;
  global.fetch = vi.fn(() => (n++ === 0
    ? reply(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
    : reply(200, { content: [{ type: 'tool_use', input: { total: 1 } }] })));
  const out = await analyzeWithAI({ ...BASE, ai: { provider: 'claude', apiKey: 'k', model: 'claude-sonnet-5-5' } });
  expect(out).toEqual({ total: 1 });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[1][1].body).model).toBe('claude-sonnet-5-5');
});
