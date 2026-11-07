/**
 * @vitest-environment jsdom
 */
// AI 설정(API 키) 기기 간 공유 — OneDrive의 별도 설정 파일 (I-015)
import { getAIConfig, saveAIConfig, clearAIKeys, activeAI } from '../aiClient';
import { syncAISettings, pushAISettings, setAISyncAccount } from '../aiSettingsSync';

/** OneDrive 설정 파일 대신 쓰는 메모리 파일 */
function memoryFile(initial = null) {
  const io = {
    data: initial,
    writes: 0,
    read: async () => (io.data ? JSON.parse(JSON.stringify(io.data)) : null),
    write: async (d) => { io.writes += 1; io.data = JSON.parse(JSON.stringify(d)); },
  };
  return io;
}
const legacyPcKey = () => {
  // 이 기능 전에 PC에서 넣어 둔 키 — 수정 시각이 없다
  window.localStorage.setItem('ai_receipt_config', JSON.stringify({
    provider: 'gemini', keys: { gemini: 'AIza-PC' }, models: { gemini: 'gemini-flash-latest' },
  }));
};

beforeEach(() => { window.localStorage.clear(); setAISyncAccount(null); });

test('예전에 PC에만 넣어 둔 키는 앱을 열면 OneDrive로 올라간다', async () => {
  legacyPcKey();
  const file = memoryFile();
  expect(await syncAISettings(file)).toBe('pushed');
  expect(file.data.keys.gemini).toBe('AIza-PC');
  expect(file.data.updatedAt).toBeGreaterThan(0);
  expect(getAIConfig().updatedAt).toBe(file.data.updatedAt);  // 이 기기와 같은 시각으로 맞춤
  expect(await syncAISettings(file)).toBe('same');
  expect(file.writes).toBe(1);
});

test('휴대폰은 키가 없어도 OneDrive에서 받아 와 바로 쓴다', async () => {
  const file = memoryFile({ version: 1, provider: 'gemini', keys: { gemini: 'AIza-PC', claude: '' }, models: { gemini: '', claude: '' }, updatedAt: 1000 });
  expect(activeAI()).toBe(null);
  expect(await syncAISettings(file)).toBe('pulled');
  expect(activeAI()).toMatchObject({ provider: 'gemini', apiKey: 'AIza-PC' });
  expect(file.writes).toBe(0);
});

test('인터넷이 끊긴 채 이 기기에서 바꿨으면 다음에 열 때 올린다', async () => {
  const file = memoryFile({ provider: 'gemini', keys: { gemini: 'OLD' }, models: {}, updatedAt: 1000 });
  saveAIConfig({ provider: 'gemini', keys: { gemini: 'NEW' }, models: {} });   // 지금 시각
  expect(await syncAISettings(file)).toBe('pushed');
  expect(file.data.keys.gemini).toBe('NEW');
});

test('다른 기기에서 "키 삭제(모든 기기)"를 하면 이 기기에서도 지워진다', async () => {
  saveAIConfig({ provider: 'gemini', keys: { gemini: 'AIza' }, models: {} }, { touch: false });
  window.localStorage.setItem('ai_receipt_config', JSON.stringify({ ...getAIConfig(), updatedAt: 1000 }));
  const file = memoryFile({ provider: 'gemini', keys: { gemini: '' }, models: {}, updatedAt: 2000 });
  expect(await syncAISettings(file)).toBe('pulled');
  expect(activeAI()).toBe(null);
});

test('로그아웃 때 이 기기에서만 지운 키는 다시 로그인하면 돌아온다', async () => {
  legacyPcKey();
  const file = memoryFile();
  await syncAISettings(file);                     // 올림
  clearAIKeys();                                  // 로그아웃 — 이 기기만
  expect(activeAI()).toBe(null);
  expect(await syncAISettings(file)).toBe('pulled');
  expect(activeAI()).toMatchObject({ apiKey: 'AIza-PC' });
  expect(file.data.keys.gemini).toBe('AIza-PC');  // OneDrive 쪽은 그대로
});

test('설정 파일이 망가져 수정 시각이 없으면 믿지 않고 이 기기 키를 올린다', async () => {
  legacyPcKey();
  const file = memoryFile({ keys: 'garbage' });
  expect(await syncAISettings(file)).toBe('pushed');
  expect(file.data.keys.gemini).toBe('AIza-PC');
});

test('어디에도 키가 없으면 아무것도 쓰지 않는다 / 로그인 정보가 없으면 건너뛴다', async () => {
  const file = memoryFile();
  expect(await syncAISettings(file)).toBe('none');
  expect(file.writes).toBe(0);
  expect(await syncAISettings()).toBe('offline');
  expect(await pushAISettings()).toBe(false);
});

test('실제 OneDrive 경로: 가계부 파일과 별도인 Apps/financial-ledger/ai-settings.json만 읽고 쓴다', async () => {
  legacyPcKey();
  const instance = { acquireTokenSilent: async () => ({ accessToken: 'TOKEN' }) };
  setAISyncAccount(instance, [{ username: 'me' }]);
  let stored = null;
  global.fetch = vi.fn(async (url, init = {}) => {
    const reply = (status, body) => ({ ok: status < 400, status, statusText: '', json: async () => body, text: async () => JSON.stringify(body) });
    if (url === 'https://download/ai') return reply(200, stored);
    if (init.method === 'PUT') { stored = JSON.parse(init.body); return reply(201, {}); }
    return stored ? reply(200, { '@microsoft.graph.downloadUrl': 'https://download/ai' }) : reply(404, {});
  });

  expect(await syncAISettings()).toBe('pushed');
  const urls = fetch.mock.calls.map(([u]) => u);
  expect(urls.every(u => !u.includes('ledger.db'))).toBe(true);
  expect(urls).toContain('https://graph.microsoft.com/v1.0/me/drive/root:/Apps/financial-ledger/ai-settings.json:/content');
  expect(fetch.mock.calls.find(([, i]) => i?.method === 'PUT')[1].headers.Authorization).toBe('Bearer TOKEN');

  // 다른 기기(로컬 비어 있음)에서 열면 받아 온다
  window.localStorage.clear();
  expect(await syncAISettings()).toBe('pulled');
  expect(activeAI()).toMatchObject({ apiKey: 'AIza-PC' });
});
