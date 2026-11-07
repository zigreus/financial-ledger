/**
 * AI 이미지 분석 클라이언트 — Gemini / Claude API를 브라우저에서 직접 호출한다.
 *
 * 앱에 서버가 없으므로 사용자가 발급받은 API 키로 호출한다.
 * (claude.ai·Gemini 앱 구독 로그인으로 다른 웹앱이 호출하는 방법은 제공되지 않는다)
 * 키는 가족이 함께 쓰는 DB가 아니라 이 기기의 localStorage에만 저장한다.
 */

const CONFIG_KEY = 'ai_receipt_config';

export const PROVIDERS = {
  gemini: {
    label: 'Gemini (Google)',
    keyHelp: 'Google AI Studio → aistudio.google.com/app/apikey 에서 무료 발급',
    keyPlaceholder: 'AIza…',
    // 추천(기본) 모델. 공식 별칭이라 항상 최신 Flash를 가리켜 모델 지원 종료에 영향받지 않는다
    // (가리키는 모델이 바뀌기 2주 전 Google이 이메일로 알림)
    defaultModel: 'gemini-flash-latest',
  },
  claude: {
    label: 'Claude (Anthropic)',
    keyHelp: 'Anthropic Console → console.anthropic.com 의 API Keys 에서 발급 (사용량만큼 과금)',
    keyPlaceholder: 'sk-ant-…',
    defaultModel: 'claude-sonnet-5-5', // 추천(기본) 모델
  },
};

// ── 설정 (기기별) ────────────────────────────────────────────────

export function getAIConfig() {
  let saved = {};
  try { saved = JSON.parse(window.localStorage.getItem(CONFIG_KEY) || '{}') || {}; } catch (e) { saved = {}; }
  const provider = PROVIDERS[saved.provider] ? saved.provider : 'gemini';
  return {
    provider,
    keys: { gemini: '', claude: '', ...(saved.keys || {}) },
    models: { gemini: '', claude: '', ...(saved.models || {}) },
  };
}

export function saveAIConfig(config) {
  try { window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch (e) { /* 저장 불가 환경 */ }
}

/** 이 기기에 저장된 모든 공급자의 API 키를 지운다 (로그아웃 등). 공급자·모델 선택은 남긴다. */
export function clearAIKeys() {
  const config = getAIConfig();
  const keys = Object.fromEntries(Object.keys(config.keys).map(p => [p, '']));
  saveAIConfig({ ...config, keys });
}

/** 지금 선택된 공급자로 바로 호출할 수 있는 상태인지 */
export function activeAI(config = getAIConfig()) {
  const apiKey = (config.keys[config.provider] || '').trim();
  if (!apiKey) return null;
  return {
    provider: config.provider,
    apiKey,
    model: config.models[config.provider] || PROVIDERS[config.provider].defaultModel,
  };
}

// ── 오류 ────────────────────────────────────────────────────────

export class AIError extends Error {
  constructor(message, kind = 'unknown') {
    super(message);
    // 'auth' | 'quota' | 'overloaded' | 'network' | 'parse' | 'model' | 'unknown'
    this.kind = kind;
  }
}

/** 사용자가 취소한 요청 — 호출부는 e.name === 'AbortError'로 구분한다 */
function abortError() {
  const e = new Error('요청을 취소했습니다');
  e.name = 'AbortError';
  return e;
}

/**
 * 서버 혼잡 시 다시 시도하는 간격(ms). 처음 고른 모델은 2번, 대신 쓰는 모델은 1번 더 시도한다.
 * 테스트에서 바꿀 수 있게 객체로 내보낸다.
 */
export const RETRY = { first: [2000, 5000], alternate: [2000] };

// 잠깐 붐비는 것이라 다시 하면 대개 되는 응답 (Gemini 503 "model overloaded", Claude 529 등)
const RETRYABLE = new Set([500, 502, 503, 504, 529]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}

/** Gemini 429 응답에 담긴 권장 대기 시간(초) — 없으면 null */
function retryAfterSeconds(body) {
  const info = (body?.error?.details || []).find(d => String(d['@type'] || '').endsWith('RetryInfo'));
  const sec = parseFloat(String(info?.retryDelay || ''));
  return Number.isFinite(sec) ? sec : null;
}

/**
 * fetch + 오류 해석 + 일시적 혼잡이면 다시 시도.
 * onRetry({ attempt, max }) — 화면에 "다시 시도하는 중"을 보여 줄 때 쓴다.
 */
async function request(url, init, { retryDelays = [], onRetry } = {}) {
  const aborted = () => !!init?.signal?.aborted;
  const server = url.includes('anthropic') ? 'Claude' : 'Gemini';
  let shortWaitUsed = false;

  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (e.name === 'AbortError' || aborted()) throw abortError();
      throw new AIError('네트워크 오류 — 인터넷 연결을 확인하세요', 'network');
    }
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      // 응답 본문을 읽는 도중 취소되면 '해석 실패'가 아니라 취소로 돌려준다
      if (e.name === 'AbortError' || aborted()) throw abortError();
      body = null;
    }
    if (aborted()) throw abortError();
    if (res.ok) return body;

    if (RETRYABLE.has(res.status) && attempt < retryDelays.length) {
      if (onRetry) onRetry({ attempt: attempt + 1, max: retryDelays.length });
      await sleep(retryDelays[attempt], init?.signal);
      continue;
    }
    // 분당 한도: 서버가 짧게 기다리라고 하면 한 번만 기다렸다 다시 한다
    const wait = res.status === 429 ? retryAfterSeconds(body) : null;
    if (wait !== null && wait <= 30 && !shortWaitUsed) {
      shortWaitUsed = true;
      if (onRetry) onRetry({ attempt: 1, max: 1, waitSeconds: Math.ceil(wait) });
      await sleep(Math.ceil(wait) * 1000, init?.signal);
      continue;
    }

    const detail = body?.error?.message || res.statusText || '';
    if (res.status === 401 || res.status === 403) throw new AIError(`API 키를 확인하세요 (${detail})`, 'auth');
    if (res.status === 400 && /api key|API_KEY/i.test(detail)) throw new AIError(`API 키를 확인하세요 (${detail})`, 'auth');
    if (res.status === 404) throw new AIError(`모델을 찾을 수 없습니다 — 설정에서 모델을 다시 고르세요 (${detail})`, 'model');
    if (res.status === 429) {
      throw new AIError('사용 한도를 넘었습니다 — 무료 사용량이면 1분쯤 뒤, 하루 한도면 내일 다시 시도하세요', 'quota');
    }
    if (RETRYABLE.has(res.status)) {
      throw new AIError(`${server} 서버가 지금 붐빕니다 (사용량 문제는 아니에요) — 1~2분 뒤 다시 시도해 주세요`, 'overloaded');
    }
    throw new AIError(`AI 요청 실패 (${res.status}) ${detail}`.trim(), 'unknown');
  }
}

// ── 모델 목록 (연결 확인 겸용) ────────────────────────────────────

const claudeHeaders = (apiKey) => ({
  'content-type': 'application/json',
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
  // 서버 없이 브라우저에서 직접 호출하기 위한 헤더 (키는 사용자 본인 것)
  'anthropic-dangerous-direct-browser-access': 'true',
});

const geminiHeaders = (apiKey) => ({
  'content-type': 'application/json',
  'x-goog-api-key': apiKey,
});

/** 이미지 분석에 쓸 수 있는 모델 목록. 추천 순서로 정렬해 돌려준다. */
export async function listModels(provider, apiKey, { signal } = {}) {
  if (provider === 'claude') {
    const body = await request('https://api.anthropic.com/v1/models?limit=100', {
      headers: claudeHeaders(apiKey), signal,
    });
    const ids = (body?.data || []).map(m => m.id);
    // 목록은 최신순 — Sonnet을 기본으로 앞에 둔다 (정확도와 비용의 균형)
    return [...ids.filter(id => /sonnet/i.test(id)), ...ids.filter(id => !/sonnet/i.test(id))];
  }

  const body = await request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
    headers: geminiHeaders(apiKey), signal,
  });
  const ids = (body?.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name).replace(/^models\//, ''))
    .filter(id => /^gemini/i.test(id) && !/embedding|tts|image|live|audio|native/i.test(id));
  // 추천 모델 → 안정판 → flash(lite 제외) → 높은 버전 순
  const rank = id => (id === PROVIDERS.gemini.defaultModel ? -10 : 0)
    + (/preview|exp/i.test(id) ? 2 : 0)
    + (/flash/i.test(id) && !/lite/i.test(id) ? 0 : 1);
  return ids.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true }));
}

// ── 이미지 + 지시문 → JSON ───────────────────────────────────────

// Gemini 응답 스키마는 OpenAPI 형식의 대문자 타입을 쓴다
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  Object.entries(schema).forEach(([k, v]) => {
    if (k === 'type') out.type = String(v).toUpperCase();
    else if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === 'items') out.items = toGeminiSchema(v);
    else out[k] = v;
  });
  return out;
}

function parseJsonText(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {
    throw new AIError('AI 응답을 해석하지 못했습니다 — 다시 시도하세요', 'parse');
  }
}

/**
 * 고른 모델이 계속 붐빌 때 대신 쓸 모델 — 이 키로 실제 쓸 수 있는 목록에서 고른다.
 * 미리보기·실험판은 빼고(대개 더 붐빔), 추천 순서대로 최대 3개.
 */
async function alternateModels(ai, signal) {
  let list = [];
  try { list = await listModels(ai.provider, ai.apiKey, { signal }); } catch (e) {
    if (e.name === 'AbortError') throw e;
    return [];
  }
  return list
    .filter(id => id !== ai.model && !/preview|exp|-latest$/i.test(id))
    .slice(0, 3);
}

/**
 * 파일(이미지·PDF, 0개 이상)과 지시문을 보내 schema 모양의 객체를 받는다.
 * files: [{ base64, mediaType }] — 비어 있으면 글만 보낸다 (말로 입력).
 * description은 Claude 도구 설명, maxTokens는 응답 길이 상한 (명세서처럼 행이 많으면 크게).
 *
 * 서버가 붐비면(503 등) 잠깐 기다렸다 다시 하고, 그래도 안 되면 다른 모델로 바꿔 시도한다.
 * onProgress(문구) — "다시 시도하는 중" 같은 진행 상황을 화면에 보여 줄 때 쓴다.
 */
export async function analyzeWithAI(opts) {
  const { ai, signal, onProgress } = opts;
  const say = msg => { if (onProgress) onProgress(msg); };
  const retryNotice = model => ({ attempt, max, waitSeconds }) => say(waitSeconds
    ? `요청이 몰려 ${waitSeconds}초 기다렸다 다시 보냅니다…`
    : `서버가 붐벼서 다시 시도하는 중… (${attempt}/${max}${model ? ` · ${model}` : ''})`);

  try {
    return await callModel(opts, ai.model, { retryDelays: RETRY.first, onRetry: retryNotice('') });
  } catch (e) {
    if (!(e instanceof AIError) || e.kind !== 'overloaded') throw e;
    say('다른 모델을 찾는 중…');
    const alternates = await alternateModels(ai, signal);
    for (const model of alternates) {
      say(`${ai.model}이(가) 붐벼서 ${model}(으)로 시도하는 중…`);
      try {
        return await callModel(opts, model, { retryDelays: RETRY.alternate, onRetry: retryNotice(model) });
      } catch (e2) {
        if (!(e2 instanceof AIError) || !['overloaded', 'model'].includes(e2.kind)) throw e2;
      }
    }
    throw new AIError(
      alternates.length
        ? `${e.message.split(' — ')[0]} — 다른 모델(${alternates.join(', ')})도 붐빕니다. 1~2분 뒤 다시 시도해 주세요`
        : e.message,
      'overloaded'
    );
  }
}

/** 모델 하나로 한 번 요청 (혼잡하면 request가 retryDelays만큼 다시 시도) */
async function callModel({
  ai, system, prompt, schema, toolName, files = [], signal,
  description = '읽은 내용을 정해진 형식으로 기록한다', maxTokens = 2048,
}, model, retry) {
  if (ai.provider === 'claude') {
    const fileBlocks = files.map(f => (f.mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: f.mediaType, data: f.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.base64 } }));
    const body = await request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: claudeHeaders(ai.apiKey),
      signal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        // 도구 호출을 강제해 정해진 모양의 JSON으로 받는다
        tools: [{ name: toolName, description, input_schema: schema }],
        tool_choice: { type: 'tool', name: toolName },
        messages: [{ role: 'user', content: [...fileBlocks, { type: 'text', text: prompt }] }],
      }),
    }, retry);
    if (body?.stop_reason === 'max_tokens') {
      throw new AIError('내용이 너무 많아 끝까지 읽지 못했습니다 — 나눠서 다시 시도하세요', 'parse');
    }
    const block = (body?.content || []).find(b => b.type === 'tool_use');
    if (!block?.input) throw new AIError('AI 응답을 해석하지 못했습니다 — 다시 시도하세요', 'parse');
    return block.input;
  }

  const body = await request(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: geminiHeaders(ai.apiKey),
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{
          role: 'user',
          parts: [
            ...files.map(f => ({ inline_data: { mime_type: f.mediaType, data: f.base64 } })),
            { text: prompt },
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: Math.max(maxTokens, 8192),
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(schema),
        },
      }),
    },
    retry
  );
  const candidate = body?.candidates?.[0];
  if (!candidate) {
    const reason = body?.promptFeedback?.blockReason;
    throw new AIError(reason ? `AI가 요청을 처리하지 않았습니다 (${reason})` : 'AI 응답이 비어 있습니다', 'parse');
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new AIError('내용이 너무 많아 끝까지 읽지 못했습니다 — 나눠서 다시 시도하세요', 'parse');
  }
  const text = (candidate.content?.parts || []).map(p => p.text || '').join('');
  return parseJsonText(text);
}

/** 이미지 1장 분석 (영수증) */
export function analyzeImage({ image, ...rest }) {
  return analyzeWithAI({ ...rest, files: [image], description: '영수증에서 읽은 내용을 기록한다' });
}
