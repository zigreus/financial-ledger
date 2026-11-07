/**
 * AI 설정(공급자·API 키·모델)을 같은 Microsoft 계정의 기기끼리 맞춘다.
 *
 * - 저장 위치: OneDrive의 Apps/financial-ledger/ai-settings.json (가계부 DB와 별도 파일)
 * - 앱을 열 때 한 번 syncAISettings(): 이 기기와 OneDrive 중 최신 쪽으로 맞춘다
 *     · OneDrive에 없고 이 기기에 키가 있으면 올린다 (예전에 PC에서 넣어 둔 키도 이렇게 퍼진다)
 *     · 이 기기에서 더 나중에 바꿨으면 올린다 (저장할 때 인터넷이 끊겼던 경우)
 *     · 그 밖에는 OneDrive 값을 받아 온다 (다른 기기에서 저장·삭제한 것)
 * - 설정 화면에서 저장·삭제하면 pushAISettings()로 바로 올린다
 * - 로그아웃 때 이 기기에서만 지운 키는 수정 시각이 그대로라 다시 로그인하면 돌아온다
 *
 * 같은 계정으로 로그인하는 사람(가족)은 모두 이 키를 쓰게 된다 — 가계부 파일과 같은 범위다.
 */
import { getAIConfig, saveAIConfig, normalizeAIConfig } from './aiClient';
import { readSettingsFile, writeSettingsFile } from './oneDriveService';

const FILE = 'ai-settings.json';
let account = null;

/** App이 로그인 정보를 알려 준다 (로그아웃하면 null) */
export function setAISyncAccount(instance, accounts) {
  account = instance && accounts && accounts.length ? { instance, accounts } : null;
}

function defaultIO() {
  if (!account) return null;
  const { instance, accounts } = account;
  return {
    read: () => readSettingsFile(instance, accounts, FILE),
    write: data => writeSettingsFile(instance, accounts, FILE, data),
  };
}

const hasKey = c => Object.values(c.keys).some(k => String(k || '').trim());
const toFile = c => ({ version: 1, provider: c.provider, keys: c.keys, models: c.models, updatedAt: c.updatedAt });
const sameConfig = (a, b) => JSON.stringify(toFile(a)) === JSON.stringify(toFile(b));

/**
 * 앱을 열 때 한 번 — 이 기기와 OneDrive 설정 중 최신 쪽으로 맞춘다.
 * 반환: 'pulled'(받아 옴) | 'pushed'(올림) | 'same' | 'none'(어디에도 없음) | 'offline'(로그인 정보 없음)
 */
export async function syncAISettings(io = defaultIO()) {
  if (!io) return 'offline';
  const local = getAIConfig();
  const raw = await io.read();

  // 파일이 없거나 수정 시각이 없으면(손상·직접 편집) 믿지 않고 이 기기 것을 올린다
  if (!raw || !(Number(raw.updatedAt) > 0)) {
    if (!hasKey(local)) return 'none';
    // 예전 버전에서 넣어 둔 키는 수정 시각이 없다 — 지금으로 찍어 이 기기와 OneDrive를 같게 둔다
    const stamped = local.updatedAt ? local : saveAIConfig(local, { touch: true });
    await io.write(toFile(stamped));
    return 'pushed';
  }

  const cloud = normalizeAIConfig(raw);
  if (local.updatedAt > cloud.updatedAt) {
    await io.write(toFile(local));
    return 'pushed';
  }
  if (sameConfig(local, cloud)) return 'same';
  saveAIConfig(cloud, { touch: false });
  return 'pulled';
}

/** 설정 화면에서 저장·삭제했을 때 — 같은 계정의 다른 기기에도 반영. 로그인 정보가 없으면 false */
export async function pushAISettings(io = defaultIO()) {
  if (!io) return false;
  await io.write(toFile(getAIConfig()));
  return true;
}
