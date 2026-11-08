/**
 * AI 이미지 분석 클라이언트 — Gemini / Claude API를 브라우저에서 직접 호출한다.
 *
 * 앱에 서버가 없으므로 사용자가 발급받은 API 키로 호출한다.
 * (claude.ai·Gemini 앱 구독 로그인으로 다른 웹앱이 호출하는 방법은 제공되지 않는다)
 * 키는 이 기기의 localStorage에 두고, 같은 계정의 다른 기기와는 aiSettingsSync가
 * OneDrive의 별도 설정 파일로 맞춘다. 가계부 DB(ledger.db)에는 절대 넣지 않는다.
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

// ── 설정 (이 기기 + 같은 계정 기기끼리 공유) ─────────────────────────

/** 기기끼리 맞추는 단위 — 고른 공급자('provider'), 그리고 공급자마다 키·모델 한 묶음 */
export const AI_FIELDS = ['provider', ...Object.keys(PROVIDERS)];

const pickProviders = obj => Object.fromEntries(Object.keys(PROVIDERS).map(p => (
  [p, obj && typeof obj[p] === 'string' ? obj[p] : '']
)));

/** 저장된 설정 모양을 바로잡는다 — 모르는 공급자·문자열이 아닌 값은 버린다 */
export function normalizeAIConfig(saved) {
  const src = saved && typeof saved === 'object' ? saved : {};
  const pending = src.pending && typeof src.pending === 'object' ? src.pending : {};
  return {
    provider: PROVIDERS[src.provider] ? src.provider : 'gemini',
    keys: pickProviders(src.keys),
    models: pickProviders(src.models),
    // 이 설정을 마지막으로 맞춘 Microsoft 계정(homeAccountId). '' = 아직 맞춘 적 없음(예전 버전에서 넣은 키 등)
    owner: typeof src.owner === 'string' ? src.owner : '',
    // 이 기기에서 사용자가 바꿨지만 아직 OneDrive에 올리지 못한 항목 (AI_FIELDS 중)
    pending: Object.fromEntries(AI_FIELDS.filter(f => pending[f] === true).map(f => [f, true])),
    // 이 기기에서만 키를 지울 때(로그아웃·계정 바꿈)마다 1씩 오른다 — 그 전에 시작한 동기화가 키를 되살리지 않게
    epoch: Number.isInteger(src.epoch) && src.epoch > 0 ? src.epoch : 0,
  };
}

export function getAIConfig() {
  let saved = {};
  try { saved = JSON.parse(window.localStorage.getItem(CONFIG_KEY) || '{}') || {}; } catch (e) { saved = {}; }
  return normalizeAIConfig(saved);
}

/** 그대로 저장한다 (동기화 모듈용). 사용자가 바꾼 설정은 updateAIConfig로 저장한다. */
export function storeAIConfig(config) {
  const next = normalizeAIConfig(config);
  try { window.localStorage.setItem(CONFIG_KEY, JSON.stringify(next)); } catch (e) { /* 저장 불가 환경 */ }
  return next;
}

const effectiveModel = (p, m) => m || PROVIDERS[p].defaultModel;

/**
 * 사용자가 바꾼 설정을 저장한다. patch: { provider?, keys?: { [공급자]: 키 }, models?: { [공급자]: 모델 } }
 * 실제로 달라진 항목만 '올릴 것'(pending)으로 표시한다 — 다음 동기화가 OneDrive 파일 위에 그 항목만 덮어써,
 * 다른 기기에서 넣은 다른 공급자의 키는 건드리지 않는다. 키를 ''로 바꾸면 모든 기기에서 지우는 것이다.
 * pickProvider: 사용자가 공급자를 직접 골랐으면 이 기기 값과 같아도 모든 기기의 선택으로 올린다
 * (이 기기만 따로 쓰던 공급자를 함께 쓰는 선택으로 정하는 경우).
 */
export function updateAIConfig(patch = {}, { pickProvider = false } = {}) {
  const cur = getAIConfig();
  const next = { ...cur, keys: { ...cur.keys }, models: { ...cur.models }, pending: { ...cur.pending } };
  if (PROVIDERS[patch.provider] && (patch.provider !== cur.provider || pickProvider)) {
    next.provider = patch.provider;
    next.pending.provider = true;
  }
  for (const p of Object.keys(PROVIDERS)) {
    const key = patch.keys && typeof patch.keys[p] === 'string' ? patch.keys[p].trim() : cur.keys[p];
    const model = patch.models && typeof patch.models[p] === 'string' ? patch.models[p] : cur.models[p];
    if (key !== cur.keys[p] || effectiveModel(p, model) !== effectiveModel(p, cur.models[p])) {
      next.keys[p] = key;
      next.models[p] = model;
      next.pending[p] = true;
    }
  }
  return storeAIConfig(next);
}

/**
 * 이 기기에 저장된 모든 공급자의 API 키를 지운다 (로그아웃). 공급자·모델 선택은 남긴다.
 * 이 기기에서만 지우는 것이라 OneDrive에 알리지 않는다(올릴 것도 비움) — 다시 로그인하면 OneDrive 값을 받아 온다.
 */
export function clearAIKeys() {
  const config = getAIConfig();
  storeAIConfig({ ...config, keys: pickProviders({}), pending: {}, epoch: config.epoch + 1 });
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
    // 'auth' | 'billing' | 'quota' | 'overloaded' | 'server' | 'network' | 'parse' | 'content' | 'model' | 'unknown'
    // (billing: 크레딧 부족 등 계정 결제 문제, content: 보낸 내용 때문에 난 오류 — 너무 길어 끊김·안전 차단·거절)
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
 * 다시 시도하는 간격(ms). 테스트에서 바꿀 수 있게 객체로 내보낸다.
 * first: 처음 고른 모델이 붐빌 때(503·529) — 2번 더
 * alternate: 대신 쓰는 모델이 붐빌 때 — 1번 더
 * server: 서버 오류(500·502·504) — 같은 모델로 1번만 더 (입력 탓일 수 있어 모델은 바꾸지 않는다)
 */
export const RETRY = { first: [2000, 5000], alternate: [2000], server: [3000] };

// 잠깐 붐비는 것이라 다시 하거나 다른 모델로 하면 대개 되는 응답 (Gemini 503 UNAVAILABLE, Claude 529 overloaded_error)
const OVERLOADED = new Set([503, 529]);
// 서버 오류 — 일시적일 수도, 보낸 내용(큰 PDF 등) 탓일 수도 있다. 다른 모델로 바꿔도 대개 같다
const SERVER_ERROR = new Set([500, 502, 504]);
// 사용 한도(429)에 서버가 이보다 오래 기다리라고 하면 기다리지 않고 바로 알린다
const MAX_QUOTA_WAIT_SECONDS = 30;

const serverName = url => (url.includes('anthropic') ? 'Claude' : 'Gemini');
const overloadedText = server => `${server} 서버가 지금 붐빕니다 (사용량 문제는 아니에요)`;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  });
}

/**
 * 429 응답 해석 — daily: 하루 한도(Gemini QuotaFailure의 quotaId에 PerDay),
 * noFreeTier: 무료 등급 한도가 0인 모델(Gemini 문구의 "limit: 0" — 기다려도 채워지지 않는다),
 * spendLimit: Claude 월 지출 한도에 닿음(error_code 'enforced_spend_limit_reached' — 다음 달 1일 UTC 0시까지 막힌다.
 *   코드가 오는 자리가 확실하지 않아 본문 어디에 있든 찾는다),
 * wait: 서버가 알려 준 대기 시간(초, 없으면 null). Gemini는 본문 RetryInfo, Claude는 retry-after 헤더로 알려 준다.
 */
function quotaInfo(res, body) {
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const ofType = suffix => details.filter(d => String(d?.['@type'] || '').endsWith(suffix));
  const daily = ofType('QuotaFailure')
    .flatMap(d => (Array.isArray(d.violations) ? d.violations : []))
    .some(v => /per_?day/i.test(`${v?.quotaId || ''} ${v?.quotaMetric || ''}`));
  const noFreeTier = /limit:\s*0(?![\d.])/.test(String(body?.error?.message || ''));
  const spendLimit = JSON.stringify(body ?? null).includes('enforced_spend_limit_reached');
  let wait = parseFloat(String(ofType('RetryInfo')[0]?.retryDelay || ''));
  if (!Number.isFinite(wait)) {
    let header = null;
    try { header = res.headers?.get?.('retry-after') ?? null; } catch (e) { header = null; }
    wait = parseFloat(String(header ?? ''));
  }
  return { daily, noFreeTier, spendLimit, wait: Number.isFinite(wait) && wait >= 0 ? wait : null };
}

// Gemini 하루 한도는 미국 태평양 시간 자정(한국 시간 오후 4~5시)에 다시 채워지고, 모델마다 따로 센다
const GEMINI_DAILY_RESET = '한국 시간 오후 4~5시쯤 다시 채워집니다';

function quotaError(server, { daily, noFreeTier, spendLimit, wait }) {
  const after = wait !== null && wait > 0 ? `${Math.ceil(wait)}초쯤` : '1분쯤';
  if (server === 'Claude' && spendLimit) {
    return new AIError(
      '이번 달 Claude API 사용 한도에 도달했습니다 — Console(console.anthropic.com)에서 한도를 올리거나 다음 달 1일 오전 9시(한국 시간)부터 다시 쓸 수 있습니다',
      'quota'
    );
  }
  if (server === 'Claude') {
    // Anthropic의 429는 분당 요청·토큰 한도다 (크레딧 부족은 402·400으로 따로 온다 — request에서 'billing'으로 안내)
    return new AIError(`Claude 사용 속도 한도(분당)를 넘었습니다 — ${after} 뒤 다시 시도해 주세요`, 'quota');
  }
  if (noFreeTier) {
    return new AIError('이 모델은 무료로 쓸 수 없습니다 — AI 설정에서 다른 모델(flash 등)을 고르세요', 'quota');
  }
  if (daily) {
    return new AIError(
      `이 모델의 오늘 Gemini 사용 한도를 다 썼습니다 — ${GEMINI_DAILY_RESET}. 급하면 AI 설정에서 다른 모델을 고르세요`,
      'quota'
    );
  }
  if (wait !== null) {
    return new AIError(`Gemini 분당 사용 한도를 넘었습니다 — ${after} 뒤 다시 시도해 주세요`, 'quota');
  }
  return new AIError(
    `Gemini 사용 한도를 넘었습니다 — 1분쯤 뒤 다시 시도해 주세요. 계속되면 오늘 한도를 다 쓴 것일 수 있습니다(${GEMINI_DAILY_RESET})`,
    'quota'
  );
}

/**
 * fetch + 오류 해석 + 일시적인 문제면 다시 시도. 기본값은 다시 시도하지 않는 것(모델 목록·연결 확인).
 * overloadDelays: 붐빔(503·529) 때 기다릴 간격들, serverDelays: 서버 오류(500·502·504) 때 간격들 — 횟수는 따로 센다.
 * quotaWait: 분당 한도(429)에 서버가 짧게 기다리라고 하면 한 번 기다렸다 다시 한다 (처음 고른 모델의 분석에만).
 * onRetry({ reason: 'overloaded' | 'server' | 'quota', attempt, max, status, waitSeconds }) — 화면에 진행 상황을 보여 줄 때.
 */
async function request(url, init, {
  overloadDelays = [], serverDelays = [], quotaWait = false, onRetry,
} = {}) {
  const signal = init?.signal;
  const aborted = () => !!signal?.aborted;
  const server = serverName(url);
  const notify = info => { if (onRetry) onRetry(info); };
  let overloadTries = 0;
  let serverTries = 0;
  let quotaWaited = false;

  for (;;) {
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
    const { status } = res;

    if (OVERLOADED.has(status) && overloadTries < overloadDelays.length) {
      overloadTries += 1;
      notify({ reason: 'overloaded', status, attempt: overloadTries, max: overloadDelays.length });
      await sleep(overloadDelays[overloadTries - 1], signal);
      continue;
    }
    if (SERVER_ERROR.has(status) && serverTries < serverDelays.length) {
      serverTries += 1;
      notify({ reason: 'server', status, attempt: serverTries, max: serverDelays.length });
      await sleep(serverDelays[serverTries - 1], signal);
      continue;
    }
    if (status === 429) {
      const quota = quotaInfo(res, body);
      // 하루 한도·무료 등급 0·월 지출 한도는 기다려도 소용없다 — 분당 한도이고 서버가 짧게 기다리라고 할 때만 한 번 기다린다
      const waitable = !quota.daily && !quota.noFreeTier && !quota.spendLimit
        && quota.wait !== null && quota.wait <= MAX_QUOTA_WAIT_SECONDS;
      if (quotaWait && !quotaWaited && waitable) {
        quotaWaited = true;
        const waitSeconds = Math.ceil(quota.wait);
        notify({ reason: 'quota', status, attempt: 1, max: 1, waitSeconds });
        await sleep(waitSeconds * 1000, signal);
        continue;
      }
      throw quotaError(server, quota);
    }

    const detail = body?.error?.message || res.statusText || '';
    // 크레딧 부족 — Anthropic은 402(billing_error)나 400("credit balance is too low")으로 알린다.
    // 계정 전체의 문제라 다른 모델로 바꿔도 같다 (analyzeWithAI가 대신 쓰는 모델로 넘어가지 않는다)
    if (status === 402 || (status === 400 && /credit balance/i.test(detail))) {
      throw new AIError(server === 'Claude'
        ? 'Anthropic 크레딧이 부족합니다 — Console(console.anthropic.com)의 Billing에서 충전하세요'
        : `${server} 요금 결제에 문제가 있습니다 — 결제 설정을 확인하세요 (${detail})`, 'billing');
    }
    if (status === 401 || status === 403) throw new AIError(`API 키를 확인하세요 (${detail})`, 'auth');
    if (status === 400 && /api key|API_KEY/i.test(detail)) throw new AIError(`API 키를 확인하세요 (${detail})`, 'auth');
    if (status === 404) throw new AIError(`모델을 찾을 수 없습니다 — 설정에서 모델을 다시 고르세요 (${detail})`, 'model');
    if (OVERLOADED.has(status)) {
      throw new AIError(`${overloadedText(server)} — 1~2분 뒤 다시 시도해 주세요`, 'overloaded');
    }
    if (status === 504) {
      throw new AIError(
        `${server} 응답이 너무 오래 걸려 끊겼습니다 (504) — 사진·파일이 크거나 많으면 줄이거나 나눠서 다시 시도해 주세요`,
        'server'
      );
    }
    if (SERVER_ERROR.has(status)) {
      throw new AIError(
        `${server} 서버 오류입니다 (${status}) — 잠시 뒤 다시 시도해 주세요. 계속되면 사진·파일을 줄이거나 나눠서 보내 보세요`,
        'server'
      );
    }
    throw new AIError(`AI 요청 실패 (${status}) ${detail}`.trim(), 'unknown');
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

/**
 * 이미지 분석에 쓸 수 있는 모델 목록. 추천 순서로 정렬해 돌려준다.
 * 연결 확인에도 쓰므로 다시 시도·대기 없이 한 번만 묻는다 (한도에 걸리면 바로 알린다).
 */
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

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const unreadable = () => new AIError('AI 응답을 해석하지 못했습니다 — 다시 시도하세요', 'parse');

/**
 * 배열이어야 할 칸의 값을 배열로 맞춘다 — Claude 도구 입력은 배열을 JSON 문자열로 보내거나 원소 하나를 객체로 보내기도 한다.
 * 빈 문자열은 빈 배열, JSON 문자열은 풀어서, 객체 하나는 [객체]로. 맞출 수 없으면 undefined
 */
function asArray(value) {
  if (Array.isArray(value)) return value;
  let v = value;
  if (typeof v === 'string') {
    if (!v.trim()) return [];
    try { v = JSON.parse(v); } catch (e) { return undefined; }
    if (Array.isArray(v)) return v;
  }
  return isPlainObject(v) ? [v] : undefined;
}

/**
 * 결과의 핵심 배열 칸인지 — 이 칸이 망가졌으면 답 전체를 믿지 않는다 (명세서 rows가 망가져 "0건 · 모두 맞습니다"가 되지 않게).
 * 호출부(스키마)를 고치지 않고 정하는 규칙: 필수(required) 배열 칸이면서
 *   (1) 이름이 rows·entries이거나 (명세서 행·말로 입력 건), 또는
 *   (2) 스키마 최상위에 필수 숫자 칸이 없을 때 — 금액이 그 배열 안에만 있다는 뜻이다.
 * 영수증 items는 최상위에 total(숫자)이 있어 부가 칸으로 본다 — 품목을 못 읽어도 금액·날짜로 추천을 만든다.
 * (스키마에 x-로 시작하는 표시를 붙이는 방법은 Gemini가 모르는 칸을 400으로 거부해 쓰지 않는다)
 */
function isCriticalArray(key, schema) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const props = isPlainObject(schema?.properties) ? schema.properties : {};
  if (!required.includes(key) || props[key]?.type !== 'array') return false;
  if (key === 'rows' || key === 'entries') return true;
  return !required.some(k => props[k]?.type === 'number' || props[k]?.type === 'integer');
}

/**
 * AI가 준 값이 schema 모양의 결과인지 확인한다 — 쓸 수 있으면 그 객체(배열 칸은 바로잡은 것), 아니면 null.
 * - 결과는 객체 하나다. 배열·null·숫자 등은 안 된다 (배열 속 행 하나만 꺼낸 것도 필수 키가 없어 걸러진다).
 * - 결과를 한 겹 감싼 래퍼는 푼다 — 도구 호출을 글로 흉내 낸 { name, input|parameters|arguments: {…} },
 *   그리고 키가 하나뿐인 { "record_receipt": {…} }·{ "result": {…} } (바깥에 schema 키가 없고 안쪽에 있을 때만).
 * - schema.required 키가 하나 이상 있어야 한다. 절반 이상을 요구하지 않는 것은 {"is_receipt": false}나
 *   {"question": "…"}처럼 키 몇 개만으로 정당한 답이 있어서다.
 * - 배열 칸은 asArray로 맞춘다. 그래도 안 되면 핵심 배열 칸(isCriticalArray — 명세서 rows·말로 입력 entries)이면
 *   답 전체를 믿지 않고, 나머지(영수증 items 같은 부가 칸)는 그 칸만 지운다. 비어 있는(null) 칸은 없는 것으로 보고 그대로 둔다.
 */
function usableResult(value, schema, toolName) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const props = isPlainObject(schema?.properties) ? schema.properties : {};
  const keys = required.length ? required : Object.keys(props);
  const hits = o => keys.filter(k => Object.prototype.hasOwnProperty.call(o, k)).length;
  let out = value;
  const looksWrapped = o => (keys.length
    ? hits(o) === 0
    : o.name === toolName || Object.prototype.hasOwnProperty.call(o, toolName));
  if (isPlainObject(out) && looksWrapped(out)) {
    const own = Object.keys(out);
    const candidates = ['input', 'parameters', 'arguments'].map(k => out[k]);
    if (own.length === 1) candidates.push(out[own[0]]);
    const inner = candidates.find(v => isPlainObject(v) && (!keys.length || hits(v) > 0));
    if (inner) out = inner;
  }
  if (!isPlainObject(out)) return null;
  if (required.length && hits(out) === 0) return null;

  let fixed = out;
  const arrayKeys = Object.keys(props).filter(k => props[k]?.type === 'array' && out[k] != null && !Array.isArray(out[k]));
  for (const k of arrayKeys) {
    const arr = asArray(out[k]);
    if (!arr && isCriticalArray(k, schema)) return null;
    if (fixed === out) fixed = { ...out };
    if (arr) fixed[k] = arr;
    else delete fixed[k];
  }

  // 원소가 객체여야 하는 배열 칸 — 원소를 JSON 문자열로 보내기도 해서 풀어 넣고, 객체가 안 되는 원소는 버린다.
  // 핵심 배열이 원래 원소가 있었는데 다 버려져 비면 형식 오류로 본다 (처음부터 빈 배열은 정상 답이라 그대로 둔다)
  const objectArrayKeys = Object.keys(props)
    .filter(k => props[k]?.items?.type === 'object' && Array.isArray(fixed[k]) && fixed[k].some(x => !isPlainObject(x)));
  for (const k of objectArrayKeys) {
    const rows = fixed[k].map((x) => {
      if (isPlainObject(x)) return x;
      if (typeof x !== 'string') return null;
      try {
        const v = JSON.parse(x);
        return isPlainObject(v) ? v : null;
      } catch (e) { return null; }
    }).filter(Boolean);
    if (!rows.length && isCriticalArray(k, schema)) return null;
    if (fixed === out) fixed = { ...out };
    fixed[k] = rows;
  }
  return fixed;
}

// 글에서 JSON을 찾을 때 시도할 { · [ 위치 수 상한 (긴 글에서 너무 오래 걸리지 않게)
const MAX_JSON_STARTS = 50;

/** src[start]의 { 또는 [와 짝이 맞는 닫는 괄호 위치. 문자열 속 괄호·이스케이프는 건너뛴다. 없으면 -1 */
function closingIndex(src, start) {
  const stack = [];
  let inString = false;
  for (let j = start; j < src.length; j += 1) {
    const c = src[j];
    if (inString) {
      if (c === '\\') j += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']');
    } else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return j;
    }
  }
  return -1;
}

/**
 * 글로 온 답에서 schema 모양의 결과를 찾는다 → { out, sawJson }.
 * 코드 블록(```) 안쪽 → 글 전체 → 괄호 짝이 맞는 { … }·[ … ] 구간 순으로, usableResult를 통과하는 첫 후보를 쓴다
 * (대괄호 제목·뒤쪽 설명의 괄호·앞에 나온 예시 JSON에 걸리지 않게). 결과 하나만 담은 배열([{…}])이면 그 원소를 쓴다.
 * sawJson: 객체·배열 JSON은 읽었지만 모양이 맞지 않았는지 (안내 문구를 고를 때 쓴다)
 */
function findResult(text, schema, toolName) {
  const src = String(text || '');
  let sawJson = false;
  // 못 읽으면 undefined, 읽었지만 모양이 틀리면 null, 쓸 수 있으면 그 객체
  const attempt = (t) => {
    let v;
    try { v = JSON.parse(t); } catch (e) { return undefined; }
    if (v !== null && typeof v === 'object') sawJson = true;
    return usableResult(v, schema, toolName)
      || (Array.isArray(v) && v.length === 1 ? usableResult(v[0], schema, toolName) : null);
  };
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(src); m; m = fence.exec(src)) {
    const out = attempt(m[1].trim());
    if (out) return { out, sawJson };
  }
  const whole = attempt(src.trim());
  if (whole) return { out: whole, sawJson };
  let starts = 0;
  for (let i = 0; i < src.length && starts < MAX_JSON_STARTS;) {
    if (src[i] !== '{' && src[i] !== '[') { i += 1; continue; }
    starts += 1;
    const end = closingIndex(src, i);
    const out = end > i ? attempt(src.slice(i, end + 1)) : undefined;
    if (out) return { out, sawJson };
    // 읽히는 JSON이었으면(예시 등) 그 구간을 건너뛰고, 아니면 다음 글자부터 다시 찾는다
    i = out === null ? end + 1 : i + 1;
  }
  return { out: null, sawJson };
}

/**
 * 도구 호출이 여러 번 오면(파일마다 따로 부른 경우 등) 하나로 합친다. inputs는 usableResult를 통과한 것들.
 * 배열 칸은 이어 붙이되 앞 호출에 이미 있는 원소(JSON이 같은 것)는 다시 넣지 않고(한 호출 안의 같은 원소는 그대로),
 * 참·거짓 칸(is_receipt 등)은 참을 우선하고, 나머지는 먼저 채워진 값을 쓴다.
 */
function mergeToolInputs(inputs) {
  const seen = {}; // 칸 → 앞 호출들에서 넣은 원소의 JSON
  return inputs.reduce((out, input) => {
    Object.entries(input).forEach(([k, v]) => {
      if (Array.isArray(v)) {
        if (!seen[k]) seen[k] = new Set((Array.isArray(out[k]) ? out[k] : []).map(x => JSON.stringify(x)));
        const fresh = v.filter(x => !seen[k].has(JSON.stringify(x)));
        v.forEach(x => seen[k].add(JSON.stringify(x)));
        out[k] = [...(Array.isArray(out[k]) ? out[k] : []), ...fresh];
      } else if (typeof v === 'boolean') {
        out[k] = out[k] === true || v;
      } else if (out[k] === undefined || out[k] === null || out[k] === '') {
        out[k] = v;
      }
    });
    return out;
  }, {});
}

/** 글로 온 답의 앞부분 (오류 안내에 그대로 보여 준다 — 화면은 글자로만 그린다) */
const excerpt = (text) => {
  const s = String(text).replace(/```(?:json)?/gi, ' ').replace(/\s+/g, ' ').trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

/** 보낸 내용 때문에 난 오류 — 너무 길어 끊김·안전 기준 차단·거절. 다른 모델로 해도 대개 같다 */
const contentError = message => new AIError(message, 'content');
const TOO_LONG = '내용이 너무 많아 끝까지 읽지 못했습니다 — 나눠서 다시 시도하세요';
// Gemini가 내용 때문에 응답을 멈춘 이유 (finishReason)
const GEMINI_BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);
// 출력 토큰 상한의 최소값 (Claude max_tokens·Gemini maxOutputTokens) — 생각 토큰도 이 안에서 쓰여 넉넉히 준다.
// 실제로 쓴 만큼만 과금된다. 스트리밍 없이 보내는 요청의 권장 범위다
const MIN_OUTPUT_TOKENS = 16000;
// Gemini 2.5 이전 모델(1.5·2.0)의 출력 상한 — 이보다 크게 요청하면 거부될 수 있다
const OLD_GEMINI_MAX_OUTPUT = 8192;
/** 모델 id의 Gemini 버전 (gemini-2.5-flash → 2.5). 별칭(-latest) 등 알 수 없으면 null */
function geminiVersion(model) {
  const m = String(model).match(/^gemini-(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
}
/** Gemini에 보낼 temperature — 버전이 3 미만(예: gemini-2.5-flash)일 때만 0.1, 그 밖(3 이상·별칭)은 보내지 않음(undefined) */
function geminiTemperature(model) {
  const v = geminiVersion(model);
  return v !== null && v < 3 ? 0.1 : undefined;
}
/** Gemini maxOutputTokens — 최소 MIN_OUTPUT_TOKENS, 2.5 이전 모델은 그 모델의 상한까지만 */
function geminiMaxOutput(model, maxTokens) {
  const want = Math.max(maxTokens, MIN_OUTPUT_TOKENS);
  const v = geminiVersion(model);
  return v !== null && v < 2.5 ? Math.min(want, OLD_GEMINI_MAX_OUTPUT) : want;
}

// ── 붐빌 때 대신 쓸 모델 ─────────────────────────────────────────

// 같은 모델의 다른 이름을 하나로 본다 — 별칭(-latest), 고정판(Gemini -001), 날짜판(Claude -20250929)
const modelKey = id => String(id).toLowerCase().replace(/-latest$/, '').replace(/-(\d{3}|\d{8})$/, '');
// Gemini 등급 (값이 클수록 비싸다). 모르는 등급은 null
const geminiTier = (id) => {
  if (/flash-lite/i.test(id)) return 0;
  if (/flash/i.test(id)) return 1;
  if (/pro/i.test(id)) return 2;
  return null;
};
const claudeFamily = id => (String(id).match(/opus|sonnet|haiku|fable/i)?.[0] || '').toLowerCase() || null;
// Claude 버전 숫자 — claude-sonnet-4-5(-20250929) → [4, 5], 옛 이름 claude-3-5-sonnet → [3, 5]. 숫자가 없으면 null
const claudeVersion = (id) => {
  const nums = modelKey(id).match(/\d+/g);
  return nums ? nums.map(Number) : null;
};
const isNewerVersion = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
};

/**
 * 고른 모델(ai.model)이 계속 붐빌 때 대신 쓸 모델을 list(listModels 결과, 추천 순)에서 최대 max개 고른다.
 * - 미리보기·실험판·별칭은 빼고(대개 더 붐비거나 다른 모델과 같다), 같은 모델의 다른 이름은 한 번만 넣는다.
 * - 고른 모델보다 비싼 모델로는 바꾸지 않는다.
 *   Gemini는 같은 등급 → 더 싼 등급 순(flash면 flash·flash-lite, pro는 빼고).
 *   Claude는 같은 계열(Sonnet이면 Sonnet)이면서 고른 것보다 새 버전만 — 지금 Claude는 새 버전이 같거나 더 싸고
 *   (예: Haiku 4.5보다 5.5가, Sonnet 4.5보다 5.5가 싸다) 옛 버전은 값이 더 비싸다. 최신을 골랐으면 대신 쓸 모델이 없다.
 * - 고른 모델이 별칭(gemini-flash-latest 등)이면 같은 등급의 가장 새 안정판은 그 별칭이 가리키는 모델일 가능성이 커서
 *   맨 뒤로 보낸다(다른 후보가 모자랄 때만 시도). 별칭이 미리보기를 가리킬 때도 있어 아예 빼지는 않는다.
 */
export function pickAlternateModels(ai, list, max = 3) {
  const ownKey = modelKey(ai.model);
  const indexOf = new Map(); // 같은 모델 → unique 안의 위치
  const unique = [];
  (list || []).forEach((id) => {
    if (/preview|exp|-latest$/i.test(id)) return;
    const key = modelKey(id);
    if (key === ownKey) return;
    if (indexOf.has(key)) {
      // 같은 모델이면 짧은 이름(고정판 번호·날짜가 없는 쪽)으로 부른다 — 화면 안내에도 그 이름이 나온다
      const i = indexOf.get(key);
      if (id.length < unique[i].length) unique[i] = id;
      return;
    }
    indexOf.set(key, unique.length);
    unique.push(id);
  });

  if (ai.provider === 'claude') {
    const family = claudeFamily(ai.model);
    const version = claudeVersion(ai.model);
    if (!family || !version) return [];
    return unique
      .filter(id => claudeFamily(id) === family && claudeVersion(id) && isNewerVersion(claudeVersion(id), version))
      .slice(0, max);
  }

  const tier = geminiTier(ai.model) ?? 1;
  const order = id => tier - geminiTier(id); // 0 = 같은 등급, 클수록 더 싼 등급
  const allowed = unique
    .filter(id => geminiTier(id) !== null && geminiTier(id) <= tier)
    .sort((a, b) => order(a) - order(b)); // 같은 등급 안에서는 list 순서(새 버전 먼저)를 지킨다
  if (/-latest$/i.test(ai.model)) {
    const same = allowed.findIndex(id => geminiTier(id) === tier);
    if (same >= 0) allowed.push(...allowed.splice(same, 1));
  }
  return allowed.slice(0, max);
}

/** 이 키로 실제 쓸 수 있는 목록에서 대신 쓸 모델을 고른다. 목록을 못 받으면 없음(취소만 그대로 알린다) */
async function alternateModels(ai, signal) {
  let list = [];
  try { list = await listModels(ai.provider, ai.apiKey, { signal }); } catch (e) {
    if (e.name === 'AbortError' || signal?.aborted) throw abortError();
    return [];
  }
  return pickAlternateModels(ai, list);
}

/**
 * 파일(이미지·PDF, 0개 이상)과 지시문을 보내 schema 모양의 객체를 받는다.
 * files: [{ base64, mediaType }] — 비어 있으면 글만 보낸다 (말로 입력).
 * description은 Claude 도구 설명, maxTokens는 응답 길이 상한 (명세서처럼 행이 많으면 크게).
 *
 * 고른 모델이 붐비면(503·529) 잠깐 기다렸다 다시 하고, 그래도 안 되면 다른 모델로 바꿔 시도한다.
 * 대신 쓰는 모델이 내용 때문에(너무 김·차단·거절) 또는 인터넷 문제로 실패하면 더 바꾸지 않고 그 오류를 알린다.
 * 서버 오류(500·502·504)는 같은 모델로 한 번만 더 하고 모델은 바꾸지 않는다.
 * onProgress(문구, 정보) — "다시 시도하는 중" 같은 진행 상황을 화면에 보여 줄 때 쓴다.
 *   다른 모델이 대신 답했으면 마지막에 정보 { modelUsed, requestedModel }와 함께 한 번 더 불린다
 *   (영수증·말로 입력 화면이 "붐벼서 ○○로 읽었습니다"를 보여 준다. 문구만 쓰는 호출부는 무시해도 된다).
 */
export async function analyzeWithAI(opts) {
  const { ai, signal, onProgress } = opts;
  const say = (msg, info) => { if (onProgress) onProgress(msg, info); };
  const retryNotice = model => ({ reason, attempt, max, status, waitSeconds }) => {
    if (reason === 'quota') {
      const wait = waitSeconds != null && waitSeconds > 0 ? `${waitSeconds}초` : '잠깐';
      say(`분당 사용 한도에 걸려 ${wait} 기다렸다 다시 보냅니다…`);
    } else if (reason === 'server') {
      say(`서버 오류(${status})가 나서 한 번 더 보내는 중…`);
    } else {
      say(`서버가 붐벼서 다시 시도하는 중… (${attempt}/${max}${model ? ` · ${model}` : ''})`);
    }
  };

  let busy;
  try {
    return await callModel(opts, ai.model, {
      overloadDelays: RETRY.first, serverDelays: RETRY.server, quotaWait: true, onRetry: retryNotice(''),
    });
  } catch (e) {
    if (!(e instanceof AIError) || e.kind !== 'overloaded') throw e;
    busy = e;
  }

  say('다른 모델을 찾는 중…');
  const alternates = await alternateModels(ai, signal);
  const stillBusy = [];
  const failed = [];
  let unreadable = null; // 대신 쓴 모델이 답은 했지만 읽지 못한 마지막 오류
  for (const model of alternates) {
    say(`${ai.model}이(가) 붐벼서 ${model}(으)로 시도하는 중…`);
    try {
      // 대신 쓰는 모델은 사용자가 고르지 않았으므로 한도(429) 대기·서버 오류 재시도 없이 짧게만 시도한다
      const out = await callModel(opts, model, { overloadDelays: RETRY.alternate, onRetry: retryNotice(model) });
      say(`${ai.model}이(가) 붐벼서 ${model}(으)로 답을 받았습니다`, { modelUsed: model, requestedModel: ai.model });
      return out;
    } catch (e2) {
      if (signal?.aborted) throw abortError();
      if (!(e2 instanceof AIError)) throw e2; // 취소(AbortError)·예상 못 한 오류는 그대로
      // 보낸 내용 때문에 난 오류(너무 김·차단·거절)·인터넷 오류·크레딧 부족은 다른 모델로 해도 같다 — 바로 알린다
      // (Claude는 시도할 때마다 과금된다)
      if (e2.kind === 'content' || e2.kind === 'network' || e2.kind === 'billing') throw e2;
      // 그 밖의 한도·권한·형식 오류 등은 사용자 키나 입력 문제가 아니다 — 다음 후보로 넘어간다
      if (e2.kind === 'parse') unreadable = e2;
      (e2.kind === 'overloaded' ? stillBusy : failed).push(model);
    }
  }
  if (!alternates.length) throw busy;
  // 대신 쓴 모델이 답은 했는데 읽지 못했으면 '붐빔'보다 그 사실을 알리는 것이 정확하다
  if (unreadable) throw unreadable;

  let tried;
  if (!failed.length) tried = `다른 모델(${stillBusy.join(', ')})도 붐빕니다`;
  else if (!stillBusy.length) tried = `다른 모델(${failed.join(', ')})로도 되지 않았습니다`;
  else tried = `다른 모델 중 ${stillBusy.join(', ')}도 붐비고, ${failed.join(', ')}(으)로는 되지 않았습니다`;
  throw new AIError(
    `${overloadedText(ai.provider === 'claude' ? 'Claude' : 'Gemini')} — ${tried}. 1~2분 뒤 다시 시도해 주세요`,
    'overloaded'
  );
}

/** 모델 하나로 요청 (붐빔·서버 오류·한도 때 다시 시도할지는 retry가 정한다 — request 참고) */
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
      // temperature·top_p·effort는 보내지 않는다 — 새 모델은 temperature·top_p를, 옛 모델은 effort를 400으로 거부한다
      body: JSON.stringify({
        model,
        // 새 모델은 생각(adaptive thinking)이 기본으로 켜져 있고 생각 토큰도 max_tokens에 들어가 넉넉히 준다
        // (실제로 쓴 만큼만 과금된다). 한계: 생각이 길면 명세서처럼 긴 출력의 몫이 그만큼 준다 — 스트리밍 없이
        // 이보다 키우면 응답을 너무 오래 기다리게 되어 그대로 둔다
        max_tokens: Math.max(maxTokens, MIN_OUTPUT_TOKENS),
        system: [system, `결과는 반드시 ${toolName} 도구를 한 번 호출해 기록하세요.`].filter(Boolean).join('\n\n'),
        tools: [{ name: toolName, description, input_schema: schema }],
        // 생각이 켜진 모델은 도구 강제(tool_choice tool·any)를 400으로 거부한다 — auto로 두고 지시문으로 호출을 요구한다.
        // 병렬 호출을 막아 도구를 많아야 한 번만 부르게 한다 (파일마다 따로 불러 결과가 쪼개지지 않게)
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages: [{ role: 'user', content: [...fileBlocks, { type: 'text', text: prompt }] }],
      }),
    }, retry);
    const stop = body?.stop_reason;
    if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') throw contentError(TOO_LONG);
    if (stop === 'refusal') {
      throw contentError('AI가 이 내용은 처리할 수 없다고 했습니다 — 다른 사진·내용으로 시도하세요');
    }
    // 응답에는 생각(thinking) 블록이 섞여 올 수 있다
    const blocks = Array.isArray(body?.content) ? body.content : [];
    const calls = blocks.filter(b => b.type === 'tool_use' && isPlainObject(b.input));
    const named = calls.filter(b => b.name === toolName);
    const picked = named.length ? named : calls;
    if (picked.length) {
      // 그래도 여러 번 불렀으면 하나를 버리지 않고 합친다 (모양이 맞는 호출만)
      const usable = picked.map(b => usableResult(b.input, schema, toolName)).filter(Boolean);
      if (!usable.length) throw unreadable();
      return usable.length === 1 ? usable[0] : mergeToolInputs(usable);
    }
    // auto는 도구 호출을 보장하지 않는다 — 글로 쓴 JSON을 읽는다. 다른 모델로 보내도 같은 답일 가능성이 커
    // 실패는 '내용' 오류로 다룬다 (시도마다 과금)
    const text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
    if (!text) throw unreadable();
    const { out, sawJson } = findResult(text, schema, toolName);
    if (out) return out;
    // JSON은 썼지만 모양이 틀렸으면 형식 문제로, JSON이 없으면 AI가 쓴 글(대개 기록하지 않은 이유)을 그대로 보여 준다
    if (sawJson) throw contentError('AI 답의 형식이 맞지 않아 읽지 못했습니다 — 다시 시도하세요');
    throw contentError(`AI가 결과를 기록하지 않고 이렇게 답했습니다 — "${excerpt(text)}"`);
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
          // Gemini 3 이상은 temperature를 기본값(1.0)으로 두라고 권장한다 — 낮추면 같은 말을 되풀이하다 MAX_TOKENS로
          // 끊길 수 있다. 버전을 알 수 없는 별칭(-latest)도 최신 모델을 가리키므로 보내지 않는다. 2.x 이하에만 낮춘다
          ...(geminiTemperature(model) !== undefined ? { temperature: geminiTemperature(model) } : {}),
          // 생각 토큰도 이 상한에 들어갈 수 있어 Claude처럼 넉넉히 준다 (쓴 만큼만 과금)
          maxOutputTokens: geminiMaxOutput(model, maxTokens),
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
    if (reason) throw contentError(`AI가 이 내용은 처리하지 않았습니다 (${reason}) — 다른 사진·내용으로 시도하세요`);
    throw new AIError('AI 응답이 비어 있습니다 — 다시 시도하세요', 'parse');
  }
  if (candidate.finishReason === 'MAX_TOKENS') throw contentError(TOO_LONG);
  if (GEMINI_BLOCKED.has(candidate.finishReason)) {
    throw contentError(`AI가 안전 기준 등으로 응답을 멈췄습니다 (${candidate.finishReason}) — 다른 사진·내용으로 시도하세요`);
  }
  const text = (candidate.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  const { out } = findResult(text, schema, toolName);
  if (!out) throw unreadable();
  return out;
}

/** 이미지 1장 분석 (영수증) */
export function analyzeImage({ image, ...rest }) {
  return analyzeWithAI({ ...rest, files: [image], description: '영수증에서 읽은 내용을 기록한다' });
}
