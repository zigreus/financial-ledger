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
    this.kind = kind; // 'auth' | 'quota' | 'network' | 'parse' | 'model' | 'unknown'
  }
}

async function request(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new AIError('네트워크 오류 — 인터넷 연결을 확인하세요', 'network');
  }
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok) {
    const detail = body?.error?.message || res.statusText || '';
    if (res.status === 401 || res.status === 403) throw new AIError(`API 키를 확인하세요 (${detail})`, 'auth');
    if (res.status === 400 && /api key|API_KEY/i.test(detail)) throw new AIError(`API 키를 확인하세요 (${detail})`, 'auth');
    if (res.status === 404) throw new AIError(`모델을 찾을 수 없습니다 — 설정에서 모델을 다시 고르세요 (${detail})`, 'model');
    if (res.status === 429) throw new AIError('사용 한도를 넘었습니다 — 잠시 후 다시 시도하세요', 'quota');
    if (res.status === 529 || res.status === 503) throw new AIError('AI 서버가 혼잡합니다 — 잠시 후 다시 시도하세요', 'quota');
    throw new AIError(`AI 요청 실패 (${res.status}) ${detail}`.trim(), 'unknown');
  }
  return body;
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
 * 이미지 1장과 지시문을 보내 schema 모양의 객체를 받는다.
 * image: { base64, mediaType }
 */
export async function analyzeImage({ ai, system, prompt, schema, toolName, image, signal }) {
  if (ai.provider === 'claude') {
    const body = await request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: claudeHeaders(ai.apiKey),
      signal,
      body: JSON.stringify({
        model: ai.model,
        max_tokens: 2048,
        system,
        // 도구 호출을 강제해 정해진 모양의 JSON으로 받는다
        tools: [{ name: toolName, description: '영수증에서 읽은 내용을 기록한다', input_schema: schema }],
        tool_choice: { type: 'tool', name: toolName },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    const block = (body?.content || []).find(b => b.type === 'tool_use');
    if (!block?.input) throw new AIError('AI 응답을 해석하지 못했습니다 — 다시 시도하세요', 'parse');
    return block.input;
  }

  const body = await request(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`,
    {
      method: 'POST',
      headers: geminiHeaders(ai.apiKey),
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: image.mediaType, data: image.base64 } },
            { text: prompt },
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(schema),
        },
      }),
    }
  );
  const candidate = body?.candidates?.[0];
  if (!candidate) {
    const reason = body?.promptFeedback?.blockReason;
    throw new AIError(reason ? `AI가 이미지를 처리하지 않았습니다 (${reason})` : 'AI 응답이 비어 있습니다', 'parse');
  }
  const text = (candidate.content?.parts || []).map(p => p.text || '').join('');
  return parseJsonText(text);
}
