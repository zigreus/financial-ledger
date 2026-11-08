/**
 * @vitest-environment node
 */
// AI 서버 혼잡(503/529) 시 다시 시도·다른 모델 전환 (B-064)
import { analyzeWithAI, listModels, pickAlternateModels, AIError, RETRY } from '../aiClient';

const GEMINI = { provider: 'gemini', apiKey: 'k', model: 'gemini-flash-latest' };
const CLAUDE = { provider: 'claude', apiKey: 'k', model: 'claude-sonnet-5-5' };
const BASE = { system: 's', prompt: 'p', schema: { type: 'object', properties: {} }, toolName: 't' };

const reply = (status, body, headers = {}) => Promise.resolve({
  ok: status < 400, status, statusText: '', json: async () => body,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
});
const ok = obj => reply(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const overloaded = () => reply(503, { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } });
const claudeBusy = () => reply(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
const claudeOk = input => reply(200, { content: [{ type: 'tool_use', input }] });
const modelList = ids => reply(200, {
  models: ids.map(n => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })),
});
const retryInfo = delay => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay });
const quotaFailure = quotaId => ({ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] });
const limited = (...details) => reply(429, { error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED', details } });

/** URL로 응답을 고르는 가짜 Gemini fetch. handlers: { [모델 이름 | 'list']: (init) => Promise } — 없는 모델은 404 */
function route(handlers) {
  return vi.fn((url, init) => {
    if (url.includes('/models?')) return handlers.list(init);
    const model = decodeURIComponent(url.match(/models\/([^:]+):/)[1]);
    return (handlers[model] || (() => reply(404, { error: { message: 'not found' } })))(init);
  });
}
/** 요청 본문의 model로 응답을 고르는 가짜 Claude fetch */
function claudeRoute(handlers) {
  return vi.fn((url, init) => {
    if (url.includes('/v1/models')) return handlers.list(init);
    return handlers[JSON.parse(init.body).model](init);
  });
}
const calls = (fetch, model) => fetch.mock.calls.filter(([u]) => u.includes(`models/${model}:`)).length;
const listCalls = fetch => fetch.mock.calls.filter(([u]) => u.includes('/models?')).length;
const claudeModels = fetch => fetch.mock.calls.filter(([u]) => u.includes('/v1/messages')).map(([, i]) => JSON.parse(i.body).model);

/** 취소 신호를 받을 때까지 끝나지 않는 응답 (fetch처럼 AbortError로 끝난다) */
const hang = init => new Promise((resolve, reject) => {
  init.signal.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
  }, { once: true });
});

const saved = { ...RETRY };
beforeEach(() => { RETRY.first = [1, 1]; RETRY.alternate = [1]; RETRY.server = [1]; });
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

test('계속 붐비면 이 키로 쓸 수 있는 다른 안정판 모델로 바꿔 시도하고, 어떤 모델이 답했는지 알려 준다', async () => {
  global.fetch = route({
    'gemini-flash-latest': overloaded,
    list: () => modelList(['gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.4-flash']),
    'gemini-3.6-flash': overloaded,
    'gemini-3.4-flash': () => ok({ total: 4500 }),
  });
  const progress = [];
  const infos = [];
  const out = await analyzeWithAI({ ...BASE, ai: GEMINI, onProgress: (m, info) => { progress.push(m); if (info) infos.push(info); } });
  expect(out).toEqual({ total: 4500 });
  expect(calls(fetch, 'gemini-flash-latest')).toBe(3);   // 처음 + 다시 2번
  expect(calls(fetch, 'gemini-3-flash-preview')).toBe(0); // 미리보기는 대신 쓰지 않는다
  expect(calls(fetch, 'gemini-3.8-flash')).toBe(0);       // 별칭이 가리킬 가능성이 큰 최신 안정판은 맨 뒤
  expect(calls(fetch, 'gemini-3.6-flash')).toBe(2);       // 대신 쓰는 모델은 1번만 더
  expect(progress).toContain('gemini-flash-latest이(가) 붐벼서 gemini-3.4-flash(으)로 시도하는 중…');
  expect(infos).toEqual([{ modelUsed: 'gemini-3.4-flash', requestedModel: 'gemini-flash-latest' }]);
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
  expect(err.message).toContain('다른 모델(gemini-3.6-flash)도 붐빕니다');
});

test('키 오류는 다시 시도하지 않는다', async () => {
  global.fetch = route({ 'gemini-flash-latest': () => reply(403, { error: { message: 'API key not valid' } }) });
  const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
  expect(err.kind).toBe('auth');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('분당 한도(429)는 서버가 짧게 기다리라고 할 때만 한 번 기다렸다 다시 한다 — 0초여도 한도 문구로 알린다', async () => {
  let n = 0;
  global.fetch = route({ 'gemini-flash-latest': () => (n++ === 0 ? limited(retryInfo('0s')) : ok({ ok: 1 })) });
  const progress = [];
  expect(await analyzeWithAI({ ...BASE, ai: GEMINI, onProgress: m => progress.push(m) })).toEqual({ ok: 1 });
  expect(progress).toEqual(['분당 사용 한도에 걸려 잠깐 기다렸다 다시 보냅니다…']);

  global.fetch = route({ 'gemini-flash-latest': () => reply(429, { error: { message: 'Quota exceeded for today' } }) });
  const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
  expect(err.kind).toBe('quota');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('하루 한도(PerDay)는 RetryInfo가 있어도 기다리지 않고 오늘 한도라고 알린다', async () => {
  global.fetch = route({
    'gemini-flash-latest': () => limited(quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier'), retryInfo('2s')),
  });
  const progress = [];
  const started = Date.now();
  const err = await analyzeWithAI({ ...BASE, ai: GEMINI, onProgress: m => progress.push(m) }).catch(e => e);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(progress).toEqual([]);
  expect(err.kind).toBe('quota');
  expect(err.message).toContain('오늘');
  expect(err.message).not.toContain('1분');
});

test('분당 한도로 30초 넘게 기다리라고 하면 기다리지 않고 몇 초 뒤인지 알린다', async () => {
  global.fetch = route({
    'gemini-flash-latest': () => limited(quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'), retryInfo('41.2s')),
  });
  const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(err.kind).toBe('quota');
  expect(err.message).toContain('분당');
  expect(err.message).toContain('42초쯤');
});

test('연결 확인(listModels)은 한도(429)에 걸려도 기다리지 않고 바로 알린다', async () => {
  global.fetch = route({ list: () => limited(retryInfo('2s')) });
  const started = Date.now();
  const err = await listModels('gemini', 'k').catch(e => e);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(err.kind).toBe('quota');
});

test('429 대기와 붐빔 재시도는 따로 센다', async () => {
  let n = 0;
  global.fetch = route({
    'gemini-flash-latest': () => (n++ === 0 ? limited(retryInfo('0s')) : overloaded()),
    list: () => modelList(['gemini-flash-latest']),
  });
  const progress = [];
  const err = await analyzeWithAI({ ...BASE, ai: GEMINI, onProgress: m => progress.push(m) }).catch(e => e);
  expect(err.kind).toBe('overloaded');
  expect(calls(fetch, 'gemini-flash-latest')).toBe(4); // 429 → 대기 후 다시, 503 → 2번 더
  expect(progress.slice(0, 3)).toEqual([
    '분당 사용 한도에 걸려 잠깐 기다렸다 다시 보냅니다…',
    '서버가 붐벼서 다시 시도하는 중… (1/2)',
    '서버가 붐벼서 다시 시도하는 중… (2/2)',
  ]);
});

describe('대신 쓰는 모델이 혼잡 말고 다른 이유로 실패하면 다음 후보로 넘어간다', () => {
  const AI = { provider: 'gemini', apiKey: 'k', model: 'gemini-3.8-flash' };
  const LIST = () => modelList(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.4-flash']);

  test.each([
    ['429 (한도)', () => limited()],
    ['429 limit: 0 (무료로 못 쓰는 모델)', () => reply(429, { error: { code: 429, message: 'Quota exceeded for metric: ..., limit: 0, model: x' } })],
    ['429 + RetryInfo (기다리지 않는다)', () => limited(retryInfo('3s'))],
    ['400 (지원 안 하는 옵션)', () => reply(400, { error: { message: 'responseSchema not supported', status: 'INVALID_ARGUMENT' } })],
    ['403 (이 모델 권한 없음)', () => reply(403, { error: { message: 'Permission denied on resource' } })],
    ['응답 해석 실패 (JSON이 아님)', () => reply(200, { candidates: [{ content: { parts: [{ text: '죄송합니다, 읽을 수 없어요' }] } }] })],
    ['500 (서버 오류 — 대신 쓰는 모델은 다시 하지 않는다)', () => reply(500, { error: { message: 'internal' } })],
  ])('%s', async (_, failure) => {
    global.fetch = route({ 'gemini-3.8-flash': overloaded, list: LIST, 'gemini-3.6-flash': failure, 'gemini-3.4-flash': () => ok({ total: 1 }) });
    const progress = [];
    const started = Date.now();
    const out = await analyzeWithAI({ ...BASE, ai: AI, onProgress: m => progress.push(m) });
    expect(out).toEqual({ total: 1 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls(fetch, 'gemini-3.6-flash')).toBe(1);
    expect(progress.some(m => m.includes('기다렸다'))).toBe(false);
  });

  test('모두 실패하면 처음 오류(붐빔)를 알리고, 붐빈 모델과 안 된 모델을 구분한다', async () => {
    global.fetch = route({
      'gemini-3.8-flash': overloaded, list: LIST,
      'gemini-3.6-flash': () => limited(),
      'gemini-3.4-flash': () => reply(403, { error: { message: 'Permission denied' } }),
    });
    let err = await analyzeWithAI({ ...BASE, ai: AI }).catch(e => e);
    expect(err.kind).toBe('overloaded');
    expect(err.message).toContain('사용량 문제는 아니에요');
    expect(err.message).toContain('다른 모델(gemini-3.6-flash, gemini-3.4-flash)로도 되지 않았습니다');
    expect(err.message).not.toContain('도 붐빕니다');
    expect(err.message).not.toContain('API 키');

    global.fetch = route({
      'gemini-3.8-flash': overloaded, list: LIST,
      'gemini-3.6-flash': overloaded,
      'gemini-3.4-flash': () => reply(404, { error: { message: 'not found' } }),
    });
    err = await analyzeWithAI({ ...BASE, ai: AI }).catch(e => e);
    expect(err.kind).toBe('overloaded');
    expect(err.message).toContain('다른 모델 중 gemini-3.6-flash도 붐비고, gemini-3.4-flash(으)로는 되지 않았습니다');
  });

  test('모두 실패했는데 그중 답은 했지만 읽지 못한 모델이 있으면 붐빔 대신 그 해석 실패를 알린다', async () => {
    global.fetch = route({
      'gemini-3.8-flash': overloaded, list: LIST,
      'gemini-3.6-flash': () => reply(200, { candidates: [{ content: { parts: [{ text: '읽을 수 없어요' }] } }] }),
      'gemini-3.4-flash': overloaded,
    });
    const err = await analyzeWithAI({ ...BASE, ai: AI }).catch(e => e);
    expect(err.kind).toBe('parse');
    expect(err.message).toBe('AI 응답을 해석하지 못했습니다 — 다시 시도하세요');
  });
});

describe('대신 쓰는 모델이 내용 때문에·인터넷 문제로 실패하면 더 바꾸지 않고 그 오류를 알린다', () => {
  const AI = { provider: 'gemini', apiKey: 'k', model: 'gemini-3.8-flash' };
  const LIST = () => modelList(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.4-flash']);

  test.each([
    ['너무 길어 끊김 (MAX_TOKENS)', () => reply(200, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"rows":[' }] } }] }), 'content', '나눠서'],
    ['요청 차단 (blockReason)', () => reply(200, { promptFeedback: { blockReason: 'SAFETY' } }), 'content', 'SAFETY'],
    ['응답 차단 (finishReason SAFETY)', () => reply(200, { candidates: [{ finishReason: 'SAFETY' }] }), 'content', 'SAFETY'],
    ['인터넷 오류', () => Promise.reject(new TypeError('Failed to fetch')), 'network', '인터넷'],
  ])('%s', async (_, failure, kind, text) => {
    global.fetch = route({ 'gemini-3.8-flash': overloaded, list: LIST, 'gemini-3.6-flash': failure, 'gemini-3.4-flash': () => ok({ total: 1 }) });
    const err = await analyzeWithAI({ ...BASE, ai: AI }).catch(e => e);
    expect(err.kind).toBe(kind);
    expect(err.message).toContain(text);
    expect(calls(fetch, 'gemini-3.4-flash')).toBe(0);
  });
});

describe('처음 고른 모델의 붐빔이 아닌 오류는 모델을 바꾸지 않는다', () => {
  test.each([
    ['404 (모델 없음)', () => reply(404, { error: { message: 'models/x is not found' } }), 'model'],
    ['키와 무관한 400', () => reply(400, { error: { message: 'Invalid JSON payload', status: 'INVALID_ARGUMENT' } }), 'unknown'],
    ['응답 해석 실패', () => reply(200, { candidates: [{ content: { parts: [{ text: 'not json' }] } }] }), 'parse'],
    ['너무 길어 끊김', () => reply(200, { candidates: [{ finishReason: 'MAX_TOKENS' }] }), 'content'],
  ])('%s', async (_, failure, kind) => {
    global.fetch = route({
      'gemini-flash-latest': failure,
      list: () => modelList(['gemini-flash-latest', 'gemini-3.6-flash']),
      'gemini-3.6-flash': () => ok({ total: 1 }),
    });
    const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
    expect(err.kind).toBe(kind);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(listCalls(fetch)).toBe(0);
  });
});

describe('429 안내 문구 (Gemini)', () => {
  test('limit: 0이면 무료로 쓸 수 없는 모델이라고 알리고 기다리지 않는다', async () => {
    global.fetch = route({
      'gemini-flash-latest': () => reply(429, { error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro', details: [retryInfo('3s')] } }),
    });
    const started = Date.now();
    const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err.kind).toBe('quota');
    expect(err.message).toContain('무료로 쓸 수 없습니다');
    expect(err.message).not.toContain('채워집니다');
  });

  test('limit: 20처럼 0이 아니면 무료 등급 문구를 쓰지 않는다', async () => {
    global.fetch = route({ 'gemini-flash-latest': () => reply(429, { error: { message: 'limit: 20, model: x' } }) });
    const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
    expect(err.message).not.toContain('무료로 쓸 수 없습니다');
  });

  test('이유를 모르는 429는 하루 한도 문구와 같은 때(오후 4~5시)를 안내하고 "내일"이라고 하지 않는다', async () => {
    global.fetch = route({ 'gemini-flash-latest': () => reply(429, { error: { message: 'Resource exhausted' } }) });
    const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
    expect(err.message).toContain('오후 4~5시');
    expect(err.message).not.toContain('내일');
  });
});

test('모델 목록을 못 받으면 대신 쓸 모델 없이 처음 오류(붐빔)를 그대로 알린다', async () => {
  global.fetch = route({
    'gemini-flash-latest': overloaded,
    list: () => reply(500, { error: { message: 'internal' } }),
  });
  const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
  expect(err.kind).toBe('overloaded');
  expect(err.message).toBe('Gemini 서버가 지금 붐빕니다 (사용량 문제는 아니에요) — 1~2분 뒤 다시 시도해 주세요');
  expect(calls(fetch, 'gemini-flash-latest')).toBe(3);
  expect(listCalls(fetch)).toBe(1); // 목록은 다시 묻지 않는다
});

describe('서버 오류(500·502·504)는 같은 모델로 한 번만 더 하고 모델을 바꾸지 않는다', () => {
  test.each([
    [500, '서버 오류입니다 (500)'],
    [502, '서버 오류입니다 (502)'],
    [504, '너무 오래 걸려'],
  ])('%i', async (status, text) => {
    global.fetch = route({
      'gemini-flash-latest': () => reply(status, { error: { message: 'x' } }),
      list: () => modelList(['gemini-flash-latest', 'gemini-3.6-flash']),
      'gemini-3.6-flash': () => ok({ total: 1 }),
    });
    const progress = [];
    const err = await analyzeWithAI({ ...BASE, ai: GEMINI, onProgress: m => progress.push(m) }).catch(e => e);
    expect(err.kind).toBe('server');
    expect(err.message).toContain(text);
    expect(err.message).not.toContain('붐빕니다');
    expect(calls(fetch, 'gemini-flash-latest')).toBe(2);
    expect(listCalls(fetch)).toBe(0);
    expect(progress).toEqual([`서버 오류(${status})가 나서 한 번 더 보내는 중…`]);
  });

  test('504는 파일을 줄이거나 나누라고 안내한다', async () => {
    global.fetch = route({ 'gemini-flash-latest': () => reply(504, { error: { message: 'Deadline exceeded' } }) });
    const err = await analyzeWithAI({ ...BASE, ai: GEMINI }).catch(e => e);
    expect(err.message).toContain('나눠서');
  });

  test('다시 하면 되면 그대로 결과를 돌려준다', async () => {
    let n = 0;
    global.fetch = route({ 'gemini-flash-latest': () => (n++ === 0 ? reply(500, {}) : ok({ total: 2 })) });
    expect(await analyzeWithAI({ ...BASE, ai: GEMINI })).toEqual({ total: 2 });
  });
});

describe('취소', () => {
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

  test('다른 모델 목록을 받는 중에 취소하면 취소로 끝난다 (목록 실패로 보지 않는다)', async () => {
    const controller = new AbortController();
    global.fetch = route({ 'gemini-flash-latest': overloaded, list: hang });
    const pending = analyzeWithAI({
      ...BASE, ai: GEMINI, signal: controller.signal,
      onProgress: m => { if (m === '다른 모델을 찾는 중…') setTimeout(() => controller.abort(), 1); },
    }).catch(e => e);
    const err = await pending;
    expect(err.name).toBe('AbortError');
    expect(listCalls(fetch)).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  test('대신 쓰는 모델을 기다리는 중에 취소하면 다음 후보로 넘어가지 않는다', async () => {
    RETRY.alternate = [10000];
    const controller = new AbortController();
    global.fetch = route({
      'gemini-3.8-flash': overloaded,
      list: () => modelList(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.4-flash']),
      'gemini-3.6-flash': overloaded,
      'gemini-3.4-flash': () => ok({ total: 1 }),
    });
    const err = await analyzeWithAI({
      ...BASE, ai: { ...GEMINI, model: 'gemini-3.8-flash' }, signal: controller.signal,
      onProgress: m => { if (m.includes('(1/1')) setTimeout(() => controller.abort(), 1); },
    }).catch(e => e);
    expect(err.name).toBe('AbortError');
    expect(calls(fetch, 'gemini-3.4-flash')).toBe(0);
  });
});

describe('Claude', () => {
  test('529(overloaded)도 같은 방식으로 다시 시도한다', async () => {
    let n = 0;
    global.fetch = vi.fn(() => (n++ === 0 ? claudeBusy() : claudeOk({ total: 1 })));
    const out = await analyzeWithAI({ ...BASE, ai: CLAUDE });
    expect(out).toEqual({ total: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1].body).model).toBe('claude-sonnet-5-5');
  });

  const CLAUDE_MODELS = () => reply(200, { data: [
    { id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }, { id: 'claude-sonnet-5-20260301' },
    { id: 'claude-opus-4-5-20251101' }, { id: 'claude-sonnet-4-5-20250929' }, { id: 'claude-sonnet-4-20250514' },
  ] });

  test('계속 붐비면 같은 계열(Sonnet)의 더 새 버전만 대신 쓴다 — Opus·Haiku·옛 버전으로 바꾸지 않는다', async () => {
    global.fetch = claudeRoute({
      list: CLAUDE_MODELS,
      'claude-sonnet-4-5': claudeBusy,
      'claude-sonnet-5-5': claudeBusy,
      'claude-sonnet-5-20260301': () => claudeOk({ total: 7 }),
    });
    const infos = [];
    const out = await analyzeWithAI({
      ...BASE, ai: { ...CLAUDE, model: 'claude-sonnet-4-5' }, onProgress: (m, info) => { if (info) infos.push(info); },
    });
    expect(out).toEqual({ total: 7 });
    expect(fetch.mock.calls.some(([u]) => u === 'https://api.anthropic.com/v1/models?limit=100')).toBe(true);
    expect(claudeModels(fetch)).toEqual([
      'claude-sonnet-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5',
      'claude-sonnet-5-5', 'claude-sonnet-5-5',
      'claude-sonnet-5-20260301',
    ]);
    expect(infos).toEqual([{ modelUsed: 'claude-sonnet-5-20260301', requestedModel: 'claude-sonnet-4-5' }]);
  });

  test('가장 새 버전을 골랐으면 대신 쓸 모델이 없다 (옛 버전은 더 비싸다) — 붐빔을 그대로 알린다', async () => {
    global.fetch = claudeRoute({ list: CLAUDE_MODELS, 'claude-sonnet-5-5': claudeBusy });
    const err = await analyzeWithAI({ ...BASE, ai: CLAUDE }).catch(e => e);
    expect(err.kind).toBe('overloaded');
    expect(err.message).toBe('Claude 서버가 지금 붐빕니다 (사용량 문제는 아니에요) — 1~2분 뒤 다시 시도해 주세요');
    expect(claudeModels(fetch)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5']);
  });

  test('요청 본문 — 도구는 auto(병렬 호출 막음)로 두고 지시문으로 호출을 요구하며, 생각 몫까지 max_tokens를 넉넉히, temperature·effort는 보내지 않는다', async () => {
    global.fetch = vi.fn(() => claudeOk({ total: 1 }));
    await analyzeWithAI({ ...BASE, ai: CLAUDE });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(body.tools).toEqual([{ name: 't', description: expect.any(String), input_schema: BASE.schema }]);
    expect(body.system).toBe('s\n\n결과는 반드시 t 도구를 한 번 호출해 기록하세요.');
    expect(body.max_tokens).toBe(16000);
    ['temperature', 'top_p', 'top_k', 'effort', 'thinking', 'output_config'].forEach(k => expect(body).not.toHaveProperty(k));

    await analyzeWithAI({ ...BASE, ai: CLAUDE, maxTokens: 20000 });
    expect(JSON.parse(fetch.mock.calls[1][1].body).max_tokens).toBe(20000);
  });

  test('JSON 없이 글로만 답하면 그 글 전체를 reply로 붙인다 (말로 입력의 되묻기, I-017). JSON 모양만 틀린 답에는 붙이지 않는다', async () => {
    global.fetch = vi.fn(() => reply(200, { stop_reason: 'end_turn', content: [
      { type: 'text', text: '김치찌개는\n얼마였나요?' },
    ] }));
    let err = await analyzeWithAI({ ...BASE, ai: CLAUDE }).catch(e => e);
    expect(err.kind).toBe('content');
    expect(err.reply).toBe('김치찌개는 얼마였나요?');

    global.fetch = vi.fn(() => reply(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: '가'.repeat(2500) }] }));
    err = await analyzeWithAI({ ...BASE, ai: CLAUDE }).catch(e => e);
    expect(err.reply).toBe(`${'가'.repeat(2000)}…`);

    global.fetch = vi.fn(() => reply(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"wrong": 1}' }] }));
    const schema = { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] };
    err = await analyzeWithAI({ ...BASE, schema, ai: CLAUDE }).catch(e => e);
    expect(err.message).toBe('AI 답의 형식이 맞지 않아 읽지 못했습니다 — 다시 시도하세요');
    expect(err.reply).toBeUndefined();
  });

  test('생각(thinking) 블록이 섞여도 도구 호출 결과를 읽는다', async () => {
    global.fetch = vi.fn(() => reply(200, { stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: '영수증을 보면…', signature: 'x' },
      { type: 'text', text: '기록하겠습니다.' },
      { type: 'tool_use', id: 'tu_1', name: 't', input: { total: 9 } },
    ] }));
    expect(await analyzeWithAI({ ...BASE, ai: CLAUDE })).toEqual({ total: 9 });
  });

  test('도구를 부르지 않고 글로 JSON을 쓰면 그 JSON을 읽고, 쓸 JSON이 없으면 AI가 쓴 글(앞 200자)을 내용 오류로 보여 준다', async () => {
    global.fetch = vi.fn(() => reply(200, { stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: '…' },
      { type: 'text', text: '결과입니다:\n```json\n{"total": 5}\n```' },
    ] }));
    expect(await analyzeWithAI({ ...BASE, ai: CLAUDE })).toEqual({ total: 5 });

    global.fetch = vi.fn(() => reply(200, { stop_reason: 'end_turn', content: [
      { type: 'text', text: '이 이미지는 영수증이 아닌 것 같아\n기록하지 않았습니다.' },
    ] }));
    let err = await analyzeWithAI({ ...BASE, ai: CLAUDE }).catch(e => e);
    expect(err.kind).toBe('content');
    expect(err.message).toBe('AI가 결과를 기록하지 않고 이렇게 답했습니다 — "이 이미지는 영수증이 아닌 것 같아 기록하지 않았습니다."');
    expect(fetch).toHaveBeenCalledTimes(1);

    global.fetch = vi.fn(() => reply(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: '가'.repeat(300) }] }));
    err = await analyzeWithAI({ ...BASE, ai: CLAUDE }).catch(e => e);
    expect(err.message).toContain(`"${'가'.repeat(200)}…"`);

    // 글도 도구 호출도 없으면 해석 실패
    global.fetch = vi.fn(() => reply(200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '…' }] }));
    err = await analyzeWithAI({ ...BASE, ai: CLAUDE }).catch(e => e);
    expect(err.kind).toBe('parse');
  });

  test('대신 쓰는 모델이 글로만 답하면 다음 모델로 또 보내지 않는다 (시도마다 과금)', async () => {
    global.fetch = claudeRoute({
      list: () => reply(200, { data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-sonnet-5' }] }),
      'claude-sonnet-4-5': claudeBusy,
      'claude-sonnet-5-5': () => reply(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: '영수증이 아닌 것 같아 기록하지 않았습니다.' }] }),
      'claude-sonnet-5': () => claudeOk({ total: 1 }),
    });
    const err = await analyzeWithAI({ ...BASE, ai: { ...CLAUDE, model: 'claude-sonnet-4-5' } }).catch(e => e);
    expect(err.kind).toBe('content');
    expect(err.message).toContain('영수증이 아닌 것 같아');
    expect(claudeModels(fetch)).not.toContain('claude-sonnet-5');
  });

  test('그래도 도구를 여러 번 부르면 하나를 버리지 않고 합친다 — 배열은 이어 붙이고 나머지는 먼저 채워진 값', async () => {
    global.fetch = vi.fn(() => reply(200, { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'a', name: 't', input: { is_card_statement: true, card_name: '', rows: [{ amount: 1 }] } },
      { type: 'tool_use', id: 'b', name: 't', input: { is_card_statement: true, card_name: '신한', rows: [{ amount: 2 }, { amount: 3 }] } },
    ] }));
    expect(await analyzeWithAI({ ...BASE, ai: CLAUDE })).toEqual({
      is_card_statement: true, card_name: '신한', rows: [{ amount: 1 }, { amount: 2 }, { amount: 3 }],
    });
  });

  test('월 지출 한도(enforced_spend_limit_reached) 429는 기다리지 않고 이번 달 한도라고 알린다', async () => {
    const bodies = [
      { type: 'error', error: { type: 'rate_limit_error', message: 'spend limit', details: { error_code: 'enforced_spend_limit_reached' } } },
      { type: 'error', error: { type: 'rate_limit_error', message: 'spend limit', error_code: 'enforced_spend_limit_reached' } },
    ];
    for (const body of bodies) {
      global.fetch = vi.fn(() => reply(429, body, { 'retry-after': '1' }));
      const progress = [];
      const err = await analyzeWithAI({ ...BASE, ai: CLAUDE, onProgress: m => progress.push(m) }).catch(e => e);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(progress).toEqual([]);
      expect(err.kind).toBe('quota');
      expect(err.message).toContain('이번 달 Claude API 사용 한도');
      expect(err.message).toContain('다음 달 1일 오전 9시');
      expect(err.message).not.toContain('분당');
    }
  });

  test.each([
    ['max_tokens', '나눠서'],
    ['model_context_window_exceeded', '나눠서'],
    ['refusal', '처리할 수 없다'],
  ])('stop_reason %s는 내용 때문에 난 오류로 알린다', async (stop, text) => {
    global.fetch = vi.fn(() => reply(200, { stop_reason: stop, content: [{ type: 'text', text: '' }] }));
    const err = await analyzeWithAI({ ...BASE, ai: CLAUDE }).catch(e => e);
    expect(err.kind).toBe('content');
    expect(err.message).toContain(text);
  });

  test('대신 쓰는 모델이 거절(refusal)하면 다음 모델로 또 보내지 않는다 (시도마다 과금)', async () => {
    global.fetch = claudeRoute({
      list: () => reply(200, { data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-sonnet-5' }, { id: 'claude-sonnet-4-6' }] }),
      'claude-sonnet-4-5': claudeBusy,
      'claude-sonnet-5-5': () => reply(200, { stop_reason: 'refusal', content: [] }),
      'claude-sonnet-5': () => claudeOk({ total: 1 }),
    });
    const err = await analyzeWithAI({ ...BASE, ai: { ...CLAUDE, model: 'claude-sonnet-4-5' } }).catch(e => e);
    expect(err.kind).toBe('content');
    expect(claudeModels(fetch)).not.toContain('claude-sonnet-5');
  });

  test('429는 retry-after 헤더만큼 한 번 기다렸다 다시 하고, 안내는 Claude에 맞게 한다', async () => {
    const rateLimited = (sec) => reply(429, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }, { 'retry-after': sec });
    let n = 0;
    global.fetch = vi.fn(() => (n++ === 0 ? rateLimited('0') : claudeOk({ total: 3 })));
    const progress = [];
    expect(await analyzeWithAI({ ...BASE, ai: CLAUDE, onProgress: m => progress.push(m) })).toEqual({ total: 3 });
    expect(progress).toEqual(['분당 사용 한도에 걸려 잠깐 기다렸다 다시 보냅니다…']);

    global.fetch = vi.fn(() => rateLimited('45'));
    const err = await analyzeWithAI({ ...BASE, ai: CLAUDE }).catch(e => e);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err.kind).toBe('quota');
    expect(err.message).toContain('Claude');
    expect(err.message).toContain('45초쯤');
    expect(err.message).not.toMatch(/무료|하루|내일/);
  });
});

describe('받은 결과의 모양을 확인한다 — 객체 하나, 필수 키가 하나 이상', () => {
  const STATEMENT = {
    ...BASE,
    toolName: 'record_card_statement',
    schema: {
      type: 'object',
      properties: {
        is_card_statement: { type: 'boolean' },
        rows: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, amount: { type: 'number' } } } },
        note: { type: 'string' },
      },
      required: ['is_card_statement', 'rows', 'note'],
    },
  };
  const INNER = { is_card_statement: true, rows: [{ date: '2026-11-01', amount: 5000 }] };
  const claudeText = text => vi.fn(() => reply(200, { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] }));
  const geminiText = text => vi.fn(() => reply(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }));

  test.each([
    ['input', `도구 호출 형식으로 정리했습니다:\n\`\`\`json\n${JSON.stringify({ name: 'record_card_statement', input: INNER })}\n\`\`\``],
    ['arguments', JSON.stringify({ name: 'x', arguments: INNER })],
    ['parameters', JSON.stringify({ type: 'tool_use', parameters: INNER })],
  ])('도구 호출을 흉내 낸 래퍼(%s)는 한 겹 푼다', async (_, text) => {
    global.fetch = claudeText(text);
    expect(await analyzeWithAI({ ...STATEMENT, ai: CLAUDE })).toEqual(INNER);
    global.fetch = geminiText(text);
    expect(await analyzeWithAI({ ...STATEMENT, ai: GEMINI })).toEqual(INNER);
  });

  const WRONG_FORMAT = 'AI 답의 형식이 맞지 않아 읽지 못했습니다 — 다시 시도하세요';
  test.each([
    ['배열', '```json\n[{"date":"2026-11-01","amount":5000},{"date":"2026-11-02","amount":7000}]\n```', WRONG_FORMAT],
    ['설명 속 한 건짜리 배열', '결제 건은 다음과 같습니다: [{"date":"2026-11-01","amount":5000}] 확인 부탁드립니다.', WRONG_FORMAT],
    ['배열 속 행 객체 하나', '{"date":"2026-11-01","amount":5000}', WRONG_FORMAT],
    ['필수 키 없음', '{"foo": 1}', WRONG_FORMAT],
    ['필수 배열 칸을 배열로 맞출 수 없음', '{"is_card_statement": true, "rows": "없음", "note": ""}', WRONG_FORMAT],
    ['null', 'null', 'AI가 결과를 기록하지 않고 이렇게 답했습니다 — "null"'],
    ['숫자', '5000', 'AI가 결과를 기록하지 않고 이렇게 답했습니다 — "5000"'],
  ])('%s — Claude 글 답은 내용 오류(다른 모델로 넘어가지 않음), Gemini는 해석 실패', async (_, text, message) => {
    global.fetch = claudeText(text);
    const err = await analyzeWithAI({ ...STATEMENT, ai: CLAUDE }).catch(e => e);
    expect(err.kind).toBe('content');
    expect(err.message).toBe(message);

    global.fetch = geminiText(text);
    const err2 = await analyzeWithAI({ ...STATEMENT, ai: GEMINI }).catch(e => e);
    expect(err2.kind).toBe('parse');
  });

  test.each([
    ['도구 이름', 'record_card_statement'],
    ['알 수 없는 이름', 'result'],
  ])('키 하나(%s)로 감싼 결과는 한 겹 푼다', async (_, key) => {
    const text = `\`\`\`json\n${JSON.stringify({ [key]: INNER })}\n\`\`\``;
    global.fetch = claudeText(text);
    expect(await analyzeWithAI({ ...STATEMENT, ai: CLAUDE })).toEqual(INNER);
    global.fetch = geminiText(text);
    expect(await analyzeWithAI({ ...STATEMENT, ai: GEMINI })).toEqual(INNER);
  });

  test('키가 둘 이상인 알 수 없는 래퍼는 풀지 않는다 (어느 쪽이 결과인지 모른다)', async () => {
    global.fetch = claudeText(JSON.stringify({ result: INNER, other: INNER }));
    const err = await analyzeWithAI({ ...STATEMENT, ai: CLAUDE }).catch(e => e);
    expect(err.kind).toBe('content');
    expect(err.message).toBe(WRONG_FORMAT);
  });

  test('결과 하나만 담은 배열([{…}])이면 그 원소를 쓴다', async () => {
    global.fetch = claudeText(`[${JSON.stringify(INNER)}]`);
    expect(await analyzeWithAI({ ...STATEMENT, ai: CLAUDE })).toEqual(INNER);
    global.fetch = geminiText(`[${JSON.stringify(INNER)}]`);
    expect(await analyzeWithAI({ ...STATEMENT, ai: GEMINI })).toEqual(INNER);
  });

  test('필수 키 일부만 있어도 정당한 답이면 받는다 (예: 영수증이 아님만 알림)', async () => {
    global.fetch = claudeText('{"is_card_statement": false}');
    expect(await analyzeWithAI({ ...STATEMENT, ai: CLAUDE })).toEqual({ is_card_statement: false });
  });

  test('도구 호출 입력도 같은 검사를 한다 — 모양이 틀리면 해석 실패', async () => {
    global.fetch = vi.fn(() => reply(200, { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'a', name: 'record_card_statement', input: { date: '2026-11-01', amount: 5000 } },
    ] }));
    const err = await analyzeWithAI({ ...STATEMENT, ai: CLAUDE }).catch(e => e);
    expect(err.kind).toBe('parse');

    global.fetch = vi.fn(() => reply(200, { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'a', name: 'record_card_statement', input: { name: 'record_card_statement', input: INNER } },
    ] }));
    expect(await analyzeWithAI({ ...STATEMENT, ai: CLAUDE })).toEqual(INNER);
  });
});

describe('배열 칸 바로잡기 — Claude 도구 입력은 배열을 JSON 문자열·객체 하나로 보내기도 한다', () => {
  // 실제 스키마처럼: 영수증은 items(필수), 명세서는 rows(필수), tags는 필수가 아닌 부가 배열 칸
  const SCHEMA = {
    type: 'object',
    properties: {
      is_receipt: { type: 'boolean' }, total: { type: 'number' },
      items: { type: 'array', items: { type: 'object' } },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['is_receipt', 'total', 'items'],
  };
  const tool = input => vi.fn(() => reply(200, { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 't', input }] }));
  const run = input => { global.fetch = tool(input); return analyzeWithAI({ ...BASE, schema: SCHEMA, ai: CLAUDE }).catch(e => e); };
  const ITEM = { name: '아메리카노', amount: 4500 };

  test.each([
    ['JSON 문자열', JSON.stringify([ITEM]), [ITEM]],
    ['객체 하나', ITEM, [ITEM]],
    ['객체 하나를 담은 JSON 문자열', JSON.stringify(ITEM), [ITEM]],
    ['빈 문자열', '', []],
  ])('%s는 배열로 바꿔 받는다 — 금액·날짜를 잃지 않는다', async (_, items, expected) => {
    expect(await run({ is_receipt: true, total: 4500, items })).toEqual({ is_receipt: true, total: 4500, items: expected });
  });

  test('비어 있는(null) 배열 칸은 없는 것으로 보고 그대로 받는다', async () => {
    expect(await run({ is_receipt: true, total: 4500, items: null })).toEqual({ is_receipt: true, total: 4500, items: null });
  });

  test('필수가 아닌 부가 배열 칸을 맞출 수 없으면 그 칸만 지우고 받는다', async () => {
    expect(await run({ is_receipt: true, total: 4500, items: [ITEM], tags: '카페' })).toEqual({ is_receipt: true, total: 4500, items: [ITEM] });
  });

  test.each([
    ['글', '아메리카노 1잔 4500원'],
    ['숫자', 0],
  ])('영수증 items처럼 핵심이 아닌 배열 칸은 맞출 수 없어도(%s) 그 칸만 지우고 금액·날짜는 받는다', async (_, items) => {
    expect(await run({ is_receipt: true, total: 4500, items })).toEqual({ is_receipt: true, total: 4500 });
  });

  describe('핵심 배열 칸(명세서 rows·말로 입력 entries)을 맞출 수 없으면 답 전체를 믿지 않는다 ("0건"이 되지 않게)', () => {
    const runWith = (schema, input) => {
      global.fetch = tool(input);
      return analyzeWithAI({ ...BASE, schema, ai: CLAUDE }).catch(e => e);
    };
    const STATEMENT = { type: 'object', properties: { is_card_statement: { type: 'boolean' }, card_name: { type: 'string' }, rows: { type: 'array' } }, required: ['is_card_statement', 'card_name', 'rows'] };
    const TEXT = { type: 'object', properties: { entries: { type: 'array' }, question: { type: 'string' } }, required: ['entries', 'question'] };

    test('명세서 rows', async () => {
      expect((await runWith(STATEMENT, { is_card_statement: true, card_name: '', rows: '없음' })).kind).toBe('parse');
    });
    test('말로 입력 entries', async () => {
      expect((await runWith(TEXT, { entries: '김치찌개 9천원', question: '' })).kind).toBe('parse');
    });
    test('이름이 rows면 최상위에 숫자 칸이 있어도 핵심이다', async () => {
      const schema = { ...STATEMENT, properties: { ...STATEMENT.properties, total: { type: 'number' } }, required: [...STATEMENT.required, 'total'] };
      expect((await runWith(schema, { is_card_statement: true, card_name: '', total: 0, rows: '없음' })).kind).toBe('parse');
    });
    test('이름과 상관없이 최상위에 필수 숫자 칸이 없으면(금액이 배열에만 있으면) 핵심이다', async () => {
      const schema = { type: 'object', properties: { ok: { type: 'boolean' }, payments: { type: 'array' } }, required: ['ok', 'payments'] };
      expect((await runWith(schema, { ok: true, payments: '없음' })).kind).toBe('parse');
    });
    test('필수가 아닌 배열 칸은 핵심이 아니다', async () => {
      const schema = { type: 'object', properties: { ok: { type: 'boolean' }, payments: { type: 'array' } }, required: ['ok'] };
      expect(await runWith(schema, { ok: true, payments: '없음' })).toEqual({ ok: true });
    });
  });

  describe('원소가 객체여야 하는 배열 칸의 원소가 JSON 문자열로 오면', () => {
    const ROW = { date: '2026-11-01', merchant: 'A', amount: 5000 };
    const STATEMENT = {
      type: 'object',
      properties: { is_card_statement: { type: 'boolean' }, rows: { type: 'array', items: { type: 'object' } } },
      required: ['is_card_statement', 'rows'],
    };
    const RECEIPT = {
      type: 'object',
      properties: { total: { type: 'number' }, items: { type: 'array', items: { type: 'object' } }, tags: { type: 'array', items: { type: 'string' } } },
      required: ['total', 'items'],
    };
    const runWith = (schema, input) => {
      global.fetch = tool(input);
      return analyzeWithAI({ ...BASE, schema, ai: CLAUDE }).catch(e => e);
    };

    test('풀어서 객체로 넣고, 객체가 안 되는 원소는 버린다', async () => {
      const out = await runWith(STATEMENT, { is_card_statement: true, rows: [JSON.stringify(ROW), ROW, '깨진 행', 5, null, '[1]'] });
      expect(out).toEqual({ is_card_statement: true, rows: [ROW, ROW] });
    });

    test('핵심 배열이 원소가 있었는데 다 버려져 비면 형식 오류로 본다', async () => {
      const err = await runWith(STATEMENT, { is_card_statement: true, rows: ['깨진 행', 7] });
      expect(err.kind).toBe('parse');
    });

    test('처음부터 빈 배열은 정상 답이라 그대로 받는다', async () => {
      expect(await runWith(STATEMENT, { is_card_statement: true, rows: [] })).toEqual({ is_card_statement: true, rows: [] });
    });

    test('핵심이 아닌 배열(영수증 items)은 다 버려져도 빈 배열로 두고 받는다', async () => {
      expect(await runWith(RECEIPT, { total: 4500, items: ['아메리카노'] })).toEqual({ total: 4500, items: [] });
    });

    test('원소가 객체가 아닌 배열 칸(문자열 목록)은 건드리지 않는다', async () => {
      expect(await runWith(RECEIPT, { total: 4500, items: [], tags: ['카페', '아침'] })).toEqual({ total: 4500, items: [], tags: ['카페', '아침'] });
    });

    test('칸 전체가 JSON 문자열이고 그 안의 원소도 JSON 문자열이어도 풀린다', async () => {
      const out = await runWith(STATEMENT, { is_card_statement: true, rows: JSON.stringify([JSON.stringify(ROW)]) });
      expect(out).toEqual({ is_card_statement: true, rows: [ROW] });
    });
  });

  test('Gemini 경로도 같다', async () => {
    global.fetch = vi.fn(() => reply(200, { candidates: [{ finishReason: 'STOP', content: { parts: [
      { text: '영수증을 보니…', thought: true },
      { text: JSON.stringify({ is_receipt: true, total: 4500, items: JSON.stringify([ITEM]) }) },
    ] } }] }));
    expect(await analyzeWithAI({ ...BASE, schema: SCHEMA, ai: GEMINI })).toEqual({ is_receipt: true, total: 4500, items: [ITEM] });
  });
});

describe('글 속 JSON 찾기', () => {
  const SCHEMA = { type: 'object', properties: { is_receipt: { type: 'boolean' }, total: { type: 'number' }, note: { type: 'string' } }, required: ['is_receipt', 'total'] };
  const REC = { is_receipt: true, total: 5000, note: '괄호 {이름: 금액} 와 [메모]는 글자 그대로' };
  const read = text => {
    global.fetch = vi.fn(() => reply(200, { stop_reason: 'end_turn', content: [{ type: 'text', text }] }));
    return analyzeWithAI({ ...BASE, schema: SCHEMA, ai: CLAUDE }).catch(e => e);
  };

  test.each([
    ['대괄호 제목이 앞에 있음', `[영수증 분석 결과]\n${JSON.stringify(REC)}`],
    ['코드 블록 뒤 설명에 } 가 있음', `\`\`\`json\n${JSON.stringify(REC)}\n\`\`\`\n참고: 형식은 {이름: 금액} 입니다.`],
    ['설명 + 코드 블록 + 설명', `정리했습니다.\n\`\`\`\n${JSON.stringify(REC)}\n\`\`\`\n확인해 주세요.`],
    ['예시 JSON 뒤에 실제 JSON', `예시: {"이름": "금액"}\n실제 결과: ${JSON.stringify(REC)}`],
    ['모양이 틀린 코드 블록 뒤에 맞는 JSON', `\`\`\`json\n{"foo": 1}\n\`\`\`\n${JSON.stringify(REC)}`],
    ['문자열 속 괄호·이스케이프', `결과 → ${JSON.stringify({ ...REC, note: '따옴표 \\" 와 } ] 괄호' })} 끝`],
  ])('%s', async (_, text) => {
    const out = await read(text);
    expect(out.is_receipt).toBe(true);
    expect(out.total).toBe(5000);
  });

  test('긴 글에 짝 없는 { 가 많아도 금방 끝난다', async () => {
    const started = Date.now();
    const err = await read('{'.repeat(5000) + ' 영수증이 아닙니다');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(err.kind).toBe('content');
  });
});

describe('여러 도구 호출 합치기', () => {
  const SCHEMA = { type: 'object', properties: { is_receipt: { type: 'boolean' }, total: { type: 'number' }, merchant: { type: 'string' }, rows: { type: 'array' } }, required: ['is_receipt', 'total'] };
  const calls = (...inputs) => vi.fn(() => reply(200, { stop_reason: 'tool_use', content: inputs.map((input, i) => ({ type: 'tool_use', id: `t${i}`, name: 't', input })) }));
  const run = () => analyzeWithAI({ ...BASE, schema: SCHEMA, ai: CLAUDE });

  test('참·거짓 칸은 참을 우선한다 — 앞 호출의 is_receipt:false가 뒤 호출의 실제 데이터를 이기지 않는다', async () => {
    global.fetch = calls({ is_receipt: false }, { is_receipt: true, total: 5000, merchant: 'A' });
    expect(await run()).toEqual({ is_receipt: true, total: 5000, merchant: 'A' });
  });

  test('앞 호출에 이미 있는 같은 행은 다시 넣지 않고, 한 호출 안의 같은 행은 그대로 둔다', async () => {
    const r1 = { date: '2026-11-01', amount: 1 };
    const r2 = { date: '2026-11-02', amount: 2 };
    global.fetch = calls({ is_receipt: true, total: 3, rows: [r1, r1] }, { is_receipt: true, total: 3, rows: [r1, r2] });
    expect((await run()).rows).toEqual([r1, r1, r2]);
  });

  test('모양이 틀린 호출은 빼고 합친다', async () => {
    global.fetch = calls({ foo: 1 }, { is_receipt: true, total: 7 });
    expect(await run()).toEqual({ is_receipt: true, total: 7 });
  });
});

describe('Gemini temperature', () => {
  const sent = async (model) => {
    global.fetch = vi.fn(() => ok({ total: 1 }));
    await analyzeWithAI({ ...BASE, ai: { ...GEMINI, model } });
    return JSON.parse(fetch.mock.calls[0][1].body).generationConfig;
  };
  test.each([
    ['gemini-2.5-flash', 0.1],
    ['gemini-2.0-flash-001', 0.1],
    ['gemini-3-flash', undefined],
    ['gemini-3.1-pro-preview', undefined],
    ['gemini-flash-latest', undefined],
  ])('%s → %s (3 이상·별칭은 기본값을 쓰도록 보내지 않는다)', async (model, temperature) => {
    const config = await sent(model);
    expect(config.temperature).toBe(temperature);
    expect(config.responseMimeType).toBe('application/json');
  });
});

describe('Gemini maxOutputTokens — 생각 토큰 몫까지 Claude처럼 넉넉히', () => {
  const sent = async (model, maxTokens) => {
    global.fetch = vi.fn(() => ok({ total: 1 }));
    await analyzeWithAI({ ...BASE, ai: { ...GEMINI, model }, ...(maxTokens ? { maxTokens } : {}) });
    return JSON.parse(fetch.mock.calls[0][1].body).generationConfig.maxOutputTokens;
  };
  test.each([
    ['gemini-flash-latest', undefined, 16000],
    ['gemini-3-flash', 20000, 20000],
    ['gemini-2.5-flash', undefined, 16000],
    ['gemini-2.0-flash', 16000, 8192], // 2.5 이전 모델은 출력 상한(8192)까지만
  ])('%s (요청 %s) → %i', async (model, maxTokens, expected) => {
    expect(await sent(model, maxTokens)).toBe(expected);
  });
});

describe('크레딧 부족 (Claude)', () => {
  test.each([
    ['402 billing_error', () => reply(402, { type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low to access the Anthropic API.' } })],
    ['400 credit balance', () => reply(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } })],
  ])('%s는 한국어로 충전을 안내하고 다시 시도하지 않는다', async (_, response) => {
    global.fetch = vi.fn(response);
    const err = await analyzeWithAI({ ...BASE, ai: CLAUDE }).catch(e => e);
    expect(err.kind).toBe('billing');
    expect(err.message).toBe('Anthropic 크레딧이 부족합니다 — Console(console.anthropic.com)의 Billing에서 충전하세요');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('대신 쓰는 모델에서 크레딧 부족이 나면 다음 모델로 넘어가지 않는다', async () => {
    global.fetch = claudeRoute({
      list: () => reply(200, { data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-sonnet-5' }] }),
      'claude-sonnet-4-5': claudeBusy,
      'claude-sonnet-5-5': () => reply(402, { type: 'error', error: { type: 'billing_error', message: 'credit balance is too low' } }),
      'claude-sonnet-5': () => claudeOk({ total: 1 }),
    });
    const err = await analyzeWithAI({ ...BASE, ai: { ...CLAUDE, model: 'claude-sonnet-4-5' } }).catch(e => e);
    expect(err.kind).toBe('billing');
    expect(claudeModels(fetch)).not.toContain('claude-sonnet-5');
  });
});

describe('pickAlternateModels — 대신 쓸 모델 고르기', () => {
  test('같은 모델의 별칭·고정판은 한 번만(짧은 이름으로), 고른 모델의 고정판은 빼고, 미리보기·별칭은 쓰지 않는다', () => {
    const ai = { provider: 'gemini', model: 'gemini-2.5-flash' };
    const list = [
      'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-001', 'gemini-2.0-flash-001', 'gemini-2.0-flash',
      'gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite-001', 'gemini-2.0-flash-lite',
    ];
    expect(pickAlternateModels(ai, list, 10)).toEqual(['gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite']);
  });

  test('Gemini는 더 비싼 등급(pro)으로 올라가지 않고, 같은 등급을 먼저 쓴다', () => {
    const list = ['gemini-3-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'];
    expect(pickAlternateModels({ provider: 'gemini', model: 'gemini-3.5-flash' }, list)).toEqual(['gemini-3-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
    expect(pickAlternateModels({ provider: 'gemini', model: 'gemini-3-pro' }, list)).toEqual(['gemini-2.5-pro', 'gemini-3-flash', 'gemini-2.5-flash']);
    expect(pickAlternateModels({ provider: 'gemini', model: 'gemini-2.5-flash-lite' }, list)).toEqual([]);
  });

  test('별칭을 골랐으면 같은 등급의 가장 새 안정판(별칭이 가리킬 가능성이 큼)은 맨 뒤로 보낸다', () => {
    const list = ['gemini-flash-latest', 'gemini-3-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
    expect(pickAlternateModels(GEMINI, list, 10)).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash']);
    expect(pickAlternateModels(GEMINI, ['gemini-flash-latest', 'gemini-3-flash'])).toEqual(['gemini-3-flash']);
  });

  test('Claude는 같은 계열의 더 새 버전만(옛 버전은 더 비싸다), 날짜판·별칭은 한 번만', () => {
    const list = [
      'claude-sonnet-5-5-20260801', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-5', 'claude-3-5-sonnet-latest',
      'claude-3-5-sonnet-20241022', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5-20251001',
    ];
    const claude = model => ({ provider: 'claude', model });
    expect(pickAlternateModels(CLAUDE, list, 10)).toEqual([]); // 가장 새 Sonnet을 골랐다
    expect(pickAlternateModels(claude('claude-sonnet-4-5'), list, 10)).toEqual(['claude-sonnet-5-5-20260801']);
    expect(pickAlternateModels(claude('claude-3-5-sonnet-20241022'), list, 10)).toEqual(['claude-sonnet-5-5-20260801', 'claude-sonnet-4-5']);
    expect(pickAlternateModels(claude('claude-haiku-4-5'), list, 10)).toEqual(['claude-haiku-5-5']);
    expect(pickAlternateModels(claude('claude-opus-5-5'), list)).toEqual([]);
    expect(pickAlternateModels(claude('my-custom-model'), list)).toEqual([]);
  });
});
