/**
 * AI 설정(공급자·API 키·모델)을 같은 Microsoft 계정의 기기끼리 맞춘다 (I-015, B-071).
 *
 * - 저장 위치: 저장소의 계정 설정 파일 ai-settings.json (가계부 DB와 별도 파일, OneDrive는 Apps/financial-ledger/ai-settings.json)
 * - 기기 시계로 어느 쪽이 최신인지 가리지 않는다. 대신 이 기기에서 사용자가 바꾼 항목(pending)만 기억해 두고,
 *   동기화할 때 OneDrive 파일을 먼저 읽어 그 위에 그 항목만 덮어쓴다. 나머지는 OneDrive 값을 받는다.
 *     · 공급자마다 따로 맞춘다 — PC에서 Gemini 키를 저장해도 휴대폰에서 넣은 Claude 키는 그대로다
 *     · 키를 지운 것도 '바뀐 항목'으로 올라가 다른 기기에서도 지워지고, 지운 시각(changedAt)을 남겨 되살리지 않는다
 * - OneDrive에 그 공급자 키가 없고 지운 기록도 없으면 이 기기 키로 채운다 — 예전 버전에서 PC에 넣어 둔 키도 이렇게 퍼진다
 * - 설정은 마지막으로 맞춘 계정(owner)에 묶인다. 다른 계정으로 로그인하면 이 기기 설정을 올리지 않고 버린다
 * - 동기화는 한 번에 하나씩(줄 세움). 기다리는 사이 사용자가 저장한 것은 덮어쓰지 않고 다음 차례에 올린다.
 *   기다리는 사이 이 기기에서만 키를 지웠으면(로그아웃·계정 바꿈, epoch) 받아 온 값으로 되살리지 않는다
 * - OneDrive에는 읽을 때의 버전(eTag)으로만 저장한다 — 그 사이 다른 기기가 저장했으면 다시 읽어 합친다
 * - 로그인 화면으로 넘어가지 않고 응답이 없으면 포기한다 — 실패하면 올릴 것을 남겨 두고 다음에 다시 한다
 *
 * 같은 계정으로 로그인하는 사람(가족)은 모두 이 키를 쓰게 된다 — 가계부 파일과 같은 범위다.
 */
import { PROVIDERS, AI_FIELDS, getAIConfig, storeAIConfig, normalizeAIConfig } from './aiClient';
import { ConflictError } from './storage/provider';

const FILE = 'ai-settings.json';
const PROVIDER_NAMES = Object.keys(PROVIDERS);
let storage = null;
let queue = Promise.resolve();
const listeners = new Set();

/**
 * App이 로그인한 계정의 저장소(storage/provider.js)를 알려 준다 (로그아웃하면 null).
 * 이 기기 설정을 그 계정(storage.accountKey)에 묶는다 — 다른 계정이 쓰던 설정이 남아 있으면 바로 버려,
 * 그 계정의 키를 이 계정에서 쓰거나 이 계정 OneDrive에 올리지 않는다.
 */
export function setAISyncAccount(nextStorage) {
  storage = nextStorage && nextStorage.accountKey ? nextStorage : null;
  if (storage) bindToAccount(storage.accountKey);
}

/** 동기화로 이 기기 설정이 바뀌면 알려 준다 — 열려 있는 설정 화면이 새 값을 보이게. 반환: 구독 해제 */
export function onAISettingsPulled(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function defaultIO() {
  if (!storage) return null;
  const s = storage;
  return {
    account: s.accountKey,
    read: () => s.readSettings(FILE),                                  // → { data, version }
    write: (data, version) => s.writeSettings(FILE, data, version),    // 버전이 다르면 ConflictError
  };
}

function bindToAccount(id) {
  const local = getAIConfig();
  if (!id || local.owner === id) return local;
  if (!local.owner) return storeAIConfig({ ...local, owner: id });   // 처음 맞추는 기기(예전에 넣은 키) — 이 계정 것으로
  return storeAIConfig({ provider: local.provider, owner: id, epoch: local.epoch + 1 }); // 다른 계정 것 — 버린다
}

const blank = () => Object.fromEntries(PROVIDER_NAMES.map(p => [p, '']));
const zeros = () => Object.fromEntries(PROVIDER_NAMES.map(p => [p, 0]));

/** OneDrive 파일 → { provider, keys, models, changedAt }. 알아볼 수 없으면 null — 없는 것으로 본다 */
function fromFile(raw) {
  if (!raw || typeof raw !== 'object' || !raw.keys || typeof raw.keys !== 'object') return null;
  const c = normalizeAIConfig(raw);
  const at = raw.changedAt && typeof raw.changedAt === 'object' ? raw.changedAt : {};
  return {
    provider: c.provider,
    keys: c.keys,
    models: c.models,
    changedAt: Object.fromEntries(PROVIDER_NAMES.map(p => [p, Number(at[p]) > 0 ? Number(at[p]) : 0])),
  };
}

// updatedAt은 이 기능의 첫 버전(시각 비교)을 아직 쓰는 기기가 이 파일을 최신으로 보고 받아 가도록 남긴다
const toFile = s => ({
  version: 2, provider: s.provider, keys: s.keys, models: s.models, changedAt: s.changedAt, updatedAt: Date.now(),
});

const valueOf = (c, f) => (f === 'provider' ? c.provider : `${c.keys[f]}\n${c.models[f]}`);
const hasKey = c => PROVIDER_NAMES.some(p => c.keys[p]);
const sameFile = (a, b) => AI_FIELDS.every(f => valueOf(a, f) === valueOf(b, f))
  && PROVIDER_NAMES.every(p => a.changedAt[p] === b.changedAt[p]);

/**
 * 이 기기와 OneDrive 설정을 맞춘다 — 앱을 열 때, 앱으로 돌아올 때, 설정을 저장·삭제한 뒤에 부른다.
 * 반환: 'pulled'(이 기기 설정이 바뀜) | 'pushed'(OneDrive만 바뀜) | 'same' | 'none'(어디에도 없음)
 *     | 'offline'(로그인 정보 없음) | 'cancelled'(그 사이 이 기기에서 키를 지우거나 계정이 바뀌어 받아 온 값을 버림)
 */
export function syncAISettings(io = defaultIO()) {
  if (!io) return Promise.resolve('offline');
  // 부른 때의 epoch — 줄을 기다리는 중·읽는 중·다시 하는 중 어느 때든 이 기기에서 키를 지우면 받아 온 값을 버린다
  const epoch = bindToAccount(io.account).epoch;
  const run = queue.then(() => runSync(io, epoch));
  queue = run.catch(() => {});
  return run;
}

const MAX_TRIES = 3;

async function runSync(io, epoch) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await syncOnce(io, epoch);
    } catch (e) {
      // 읽은 뒤 다른 기기가 먼저 저장함 — 다시 읽어 그 위에 합친다
      if (!(e instanceof ConflictError) || attempt >= MAX_TRIES) throw e;
    }
  }
}

async function syncOnce(io, epoch) {
  const { data, version } = await io.read();
  const cloud = fromFile(data);
  // 읽는 동안 사용자가 저장했을 수 있으니 이 기기 설정은 읽은 뒤에 가져온다.
  // 그 사이 키를 지웠거나 다른 계정으로 바뀌었으면 이 동기화는 버린다(계정은 부를 때 이미 묶었다)
  const local = getAIConfig();
  if (local.epoch !== epoch || (io.account && local.owner !== io.account)) return 'cancelled';

  const base = cloud || { provider: local.provider, keys: blank(), models: blank(), changedAt: zeros() };
  const merged = { provider: base.provider, keys: { ...base.keys }, models: { ...base.models }, changedAt: { ...base.changedAt } };
  const now = Date.now();
  for (const p of PROVIDER_NAMES) {
    if (local.pending[p]) {
      merged.keys[p] = local.keys[p];
      merged.models[p] = local.models[p];
      merged.changedAt[p] = now;
    } else if (local.keys[p] && !base.keys[p] && !base.changedAt[p]) {
      // OneDrive에 이 공급자 키가 없고 일부러 지운 기록도 없을 때만 채운다
      merged.keys[p] = local.keys[p];
      merged.models[p] = local.models[p];
    }
  }
  if (local.pending.provider) merged.provider = local.provider;
  if (!merged.keys[merged.provider] && !merged.changedAt[merged.provider]) {
    // 고른 공급자에 키를 넣은 적이 없으면 키가 있는 공급자로 (예전 버전에서 기기마다 다른 공급자를 쓰던 경우).
    // 일부러 지운 경우(changedAt)는 바꾸지 않는다 — 사용량만큼 과금되는 다른 공급자로 몰래 넘어가지 않게
    const withKey = PROVIDER_NAMES.find(p => merged.keys[p]);
    if (withKey) merged.provider = withKey;
  }

  const write = cloud ? !sameFile(merged, cloud) : hasKey(merged) || Object.keys(local.pending).length > 0;
  if (write) await io.write(toFile(merged), version);

  const latest = getAIConfig();
  // 그 사이 로그아웃하며 키를 지웠거나 다른 계정으로 바뀌었으면 받아 온 값을 이 기기에 넣지 않는다
  if (latest.epoch !== epoch || (io.account && latest.owner !== io.account)) return 'cancelled';

  // 함께 고른 공급자에 키가 없는데(일부러 지움) 이 기기에서 쓰던 공급자에 키가 있으면, 이 기기에서만 그대로 쓴다.
  // 파일에는 쓰지 않는다 — 다른 기기를 과금 공급자로 몰래 넘기지도, 이 기기를 갑자기 못 쓰게 하지도 않게
  const here = !merged.keys[merged.provider] && merged.keys[local.provider] ? local.provider : merged.provider;

  // 맞춘 값으로 바꾸되, 기다리는 사이 사용자가 또 바꾼 항목은 그대로 두고 다음 동기화에서 올린다
  const next = {
    provider: here, keys: { ...merged.keys }, models: { ...merged.models },
    owner: io.account || latest.owner, pending: {}, epoch: latest.epoch,
  };
  for (const f of AI_FIELDS) {
    if (!latest.pending[f] || valueOf(latest, f) === valueOf(local, f)) continue;
    if (f === 'provider') next.provider = latest.provider;
    else { next.keys[f] = latest.keys[f]; next.models[f] = latest.models[f]; }
    next.pending[f] = true;
  }
  storeAIConfig(next);

  if (AI_FIELDS.some(f => valueOf(next, f) !== valueOf(latest, f))) {
    listeners.forEach(fn => { try { fn(); } catch (e) { /* 화면 쪽 오류가 동기화를 막지 않게 */ } });
    return 'pulled';
  }
  if (write) return 'pushed';
  return cloud ? 'same' : 'none';
}
