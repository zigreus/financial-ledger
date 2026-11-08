/**
 * @vitest-environment jsdom
 */
// AI 설정(API 키) 기기 간 공유 — OneDrive의 별도 설정 파일 (I-015, B-071)
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { getAIConfig, updateAIConfig, clearAIKeys, activeAI } from '../aiClient';
import { syncAISettings, setAISyncAccount, onAISettingsPulled } from '../aiSettingsSync';
import { ConflictError } from '../storage/provider';
import { createOneDriveStorage } from '../storage/oneDrive';
import { createMemoryStorage } from '../storage/memory';

const KEY = 'ai_receipt_config';

const clone = d => JSON.parse(JSON.stringify(d));

/** OneDrive 설정 파일 대신 쓰는 메모리 파일 — 실제처럼 버전(eTag)이 다르면 저장을 거절한다 */
function cloudFile(initial = null) {
  return {
    data: initial,
    rev: initial ? 1 : 0,
    writes: 0,
    version() { return this.rev ? `e${this.rev}` : null; },
    /** 다른 기기가 직접 저장한 것처럼 바꾼다 */
    replace(d) { this.data = clone(d); this.rev += 1; },
    as(accountId) {
      return {
        account: accountId,
        read: async () => ({ data: this.data ? clone(this.data) : null, version: this.version() }),
        write: async (d, version) => {
          if (version !== this.version()) throw new ConflictError();
          this.writes += 1;
          this.replace(d);
        },
      };
    },
  };
}

/** 기기 바꾸기 — 기기마다 localStorage를 따로 둔다 */
const devices = {};
let current = null;
function onDevice(name) {
  if (current) devices[current] = window.localStorage.getItem(KEY);
  window.localStorage.clear();
  if (devices[name]) window.localStorage.setItem(KEY, devices[name]);
  current = name;
}

/** 이 기능 전 버전에서 넣어 둔 키 — 계정·올릴 것 표시가 없다 */
const legacyKey = (provider, key) => window.localStorage.setItem(KEY, JSON.stringify({
  provider, keys: { [provider]: key }, models: {},
}));

/** read가 끝나기 전에 끼어들 수 있는 파일 */
function slowFile(file, account) {
  const io = file.as(account);
  let release;
  const gate = new Promise(r => { release = r; });
  return { io: { ...io, read: async () => { await gate; return io.read(); } }, release };
}

beforeEach(() => {
  window.localStorage.clear();
  for (const k of Object.keys(devices)) delete devices[k];
  current = null;
  setAISyncAccount(null);
});

test('예전에 PC에만 넣어 둔 키는 앱을 열면 OneDrive로 올라가고, 휴대폰은 받아 와 바로 쓴다', async () => {
  const file = cloudFile();
  onDevice('pc');
  legacyKey('gemini', 'AIza-PC');
  expect(await syncAISettings(file.as('me'))).toBe('pushed');
  expect(file.data.keys.gemini).toBe('AIza-PC');
  expect(await syncAISettings(file.as('me'))).toBe('same');
  expect(file.writes).toBe(1);

  onDevice('phone');
  expect(activeAI()).toBe(null);
  expect(await syncAISettings(file.as('me'))).toBe('pulled');
  expect(activeAI()).toMatchObject({ provider: 'gemini', apiKey: 'AIza-PC' });
  expect(file.writes).toBe(1);
});

test('기기마다 다른 공급자 키를 넣어 두었으면 둘 다 남는다 (공급자별로 맞춤)', async () => {
  const file = cloudFile();
  onDevice('pc');
  legacyKey('gemini', 'G');
  await syncAISettings(file.as('me'));
  onDevice('phone');
  legacyKey('claude', 'C');
  await syncAISettings(file.as('me'));
  expect(getAIConfig().keys).toEqual({ gemini: 'G', claude: 'C' });
  expect(file.data.keys).toEqual({ gemini: 'G', claude: 'C' });

  // 오래 열어 둔 PC에서 Gemini 모델만 바꿔 저장해도 휴대폰의 Claude 키를 지우지 않는다
  onDevice('pc');
  updateAIConfig({ models: { gemini: 'gemini-pro-latest' } });
  await syncAISettings(file.as('me'));
  expect(file.data.keys).toEqual({ gemini: 'G', claude: 'C' });
  expect(file.data.models.gemini).toBe('gemini-pro-latest');
  expect(getAIConfig().keys.claude).toBe('C');
});

test('바뀌지 않은 저장은 올릴 것이 없다 — 받아 온 설정으로 "저장하고 계속"을 눌러도 다시 올리지 않는다', async () => {
  const file = cloudFile({ provider: 'gemini', keys: { gemini: 'G' }, models: { gemini: 'gemini-flash-latest' } });
  await syncAISettings(file.as('me'));
  const { provider, keys, models } = getAIConfig();
  updateAIConfig({ provider, keys: { gemini: keys.gemini }, models: { gemini: models.gemini } });
  expect(getAIConfig().pending).toEqual({});
  expect(await syncAISettings(file.as('me'))).toBe('same');
  expect(file.writes).toBe(0);
});

test('키 삭제는 다른 기기에서도 지워지고, 예전 키를 가진 기기가 되살리지 않는다', async () => {
  const file = cloudFile();
  onDevice('pc');
  legacyKey('gemini', 'G');
  await syncAISettings(file.as('me'));
  onDevice('phone');
  await syncAISettings(file.as('me'));
  expect(activeAI()).toMatchObject({ apiKey: 'G' });

  onDevice('pc');
  updateAIConfig({ keys: { gemini: '' } });
  expect(await syncAISettings(file.as('me'))).toBe('pushed');
  expect(file.data.keys.gemini).toBe('');

  onDevice('phone');
  expect(await syncAISettings(file.as('me'))).toBe('pulled');
  expect(activeAI()).toBe(null);

  onDevice('old-tablet');      // 이 기능 전부터 같은 키를 갖고 있던 기기
  legacyKey('gemini', 'G');
  await syncAISettings(file.as('me'));
  expect(file.data.keys.gemini).toBe('');
  expect(activeAI()).toBe(null);
});

test('기기 시계가 틀려도 나중에 저장한 키가 이긴다 (시각으로 비교하지 않음)', async () => {
  const file = cloudFile();
  const realNow = Date.now;
  try {
    onDevice('pc');
    Date.now = () => realNow() + 24 * 3600 * 1000;   // PC 시계가 하루 빠름
    updateAIConfig({ keys: { gemini: 'K1' } });
    await syncAISettings(file.as('me'));
    Date.now = realNow;

    onDevice('phone');
    updateAIConfig({ keys: { gemini: 'K2' } });
    await syncAISettings(file.as('me'));

    onDevice('pc');
    expect(await syncAISettings(file.as('me'))).toBe('pulled');
    expect(getAIConfig().keys.gemini).toBe('K2');
    expect(file.data.keys.gemini).toBe('K2');
  } finally {
    Date.now = realNow;
  }
});

test('로그아웃 때 이 기기에서만 지운 키는 다시 로그인하면 돌아오고, OneDrive는 그대로다', async () => {
  const file = cloudFile();
  updateAIConfig({ keys: { gemini: 'G' } });
  await syncAISettings(file.as('me'));
  clearAIKeys();
  expect(activeAI()).toBe(null);
  expect(await syncAISettings(file.as('me'))).toBe('pulled');
  expect(activeAI()).toMatchObject({ apiKey: 'G' });
  expect(file.data.keys.gemini).toBe('G');
});

test('올리지 못한 변경이 있는 채로 로그아웃해 키를 지워도 OneDrive의 키를 지우지 않는다', async () => {
  const file = cloudFile();
  updateAIConfig({ keys: { gemini: 'OLD' } });
  await syncAISettings(file.as('me'));
  updateAIConfig({ keys: { gemini: 'NEW' } });
  const failing = { ...file.as('me'), write: async () => { throw new Error('offline'); } };
  await expect(syncAISettings(failing)).rejects.toThrow('offline');
  expect(getAIConfig().pending).toEqual({ gemini: true });     // 올릴 것은 남는다

  clearAIKeys();
  expect(await syncAISettings(file.as('me'))).toBe('pulled');
  expect(file.data.keys.gemini).toBe('OLD');
  expect(activeAI()).toMatchObject({ apiKey: 'OLD' });
});

describe('다른 계정으로 로그인한 기기', () => {
  test('키를 지우지 않고 로그아웃했어도 그 키를 새 계정 OneDrive에 올리지 않는다', async () => {
    const fileA = cloudFile();
    const fileB = cloudFile();
    updateAIConfig({ keys: { gemini: 'A-KEY' } });
    await syncAISettings(fileA.as('A'));

    expect(await syncAISettings(fileB.as('B'))).toBe('none');
    expect(fileB.writes).toBe(0);
    expect(activeAI()).toBe(null);
  });

  test('지우고 로그아웃했어도 새 계정의 키를 지우지 않고 받아 온다', async () => {
    const fileA = cloudFile();
    const fileB = cloudFile({ provider: 'claude', keys: { claude: 'B-KEY' }, models: {} });
    updateAIConfig({ keys: { gemini: 'A-KEY' } });
    await syncAISettings(fileA.as('A'));
    clearAIKeys();

    expect(await syncAISettings(fileB.as('B'))).toBe('pulled');
    expect(fileB.data.keys.claude).toBe('B-KEY');
    expect(fileB.writes).toBe(0);
    expect(activeAI()).toMatchObject({ provider: 'claude', apiKey: 'B-KEY' });
  });

  test('로그인하는 순간(동기화 전) 다른 계정의 키를 쓰지 않는다', async () => {
    updateAIConfig({ keys: { gemini: 'A-KEY' } });
    await syncAISettings(cloudFile().as('A'));
    setAISyncAccount(createMemoryStorage({ accountKey: 'B' }));
    expect(activeAI()).toBe(null);
  });
});

describe('동기화와 저장이 겹칠 때', () => {
  test('OneDrive를 읽는 동안 저장한 키를 되돌리지 않고 올린다', async () => {
    const file = cloudFile({ provider: 'gemini', keys: { gemini: 'OLD' }, models: {} });
    const { io, release } = slowFile(file, 'me');
    const run = syncAISettings(io);            // 앱을 열 때의 동기화
    updateAIConfig({ keys: { gemini: 'NEW' } }); // 그 사이 첫 설정 화면에서 저장
    release();
    await run;
    expect(getAIConfig().keys.gemini).toBe('NEW');
    expect(file.data.keys.gemini).toBe('NEW');
    expect(getAIConfig().pending).toEqual({});
  });

  test('올리는 동안 또 바꾼 키는 남겨 두었다가 다음 동기화에서 올린다', async () => {
    const file = cloudFile();
    const io = file.as('me');
    updateAIConfig({ keys: { gemini: 'FIRST' } });
    const writing = {
      ...io,
      write: async (d, version) => { updateAIConfig({ keys: { gemini: 'SECOND' } }); await io.write(d, version); },
    };
    await syncAISettings(writing);
    expect(file.data.keys.gemini).toBe('FIRST');
    expect(getAIConfig().keys.gemini).toBe('SECOND');
    expect(getAIConfig().pending).toEqual({ gemini: true });
    await syncAISettings(io);
    expect(file.data.keys.gemini).toBe('SECOND');
    expect(getAIConfig().pending).toEqual({});
  });

  test('로그아웃하며 키를 지우는 동안 돌던 동기화가 키를 되살리지 않는다', async () => {
    const file = cloudFile({ provider: 'gemini', keys: { gemini: 'G' }, models: {} });
    await syncAISettings(file.as('me'));
    const { io, release } = slowFile(file, 'me');
    const run = syncAISettings(io);            // 앱으로 돌아올 때의 동기화
    clearAIKeys();                             // 그 사이 로그아웃 — 키 지움
    release();
    expect(await run).toBe('cancelled');
    expect(activeAI()).toBe(null);
    expect(file.data.keys.gemini).toBe('G');
  });

  test('두 기기가 거의 동시에 저장해도 둘 다 남는다 (eTag로 거절되면 다시 읽어 합침)', async () => {
    const file = cloudFile({ provider: 'gemini', keys: { gemini: 'G', claude: '' }, models: {} });
    await syncAISettings(file.as('me'));
    updateAIConfig({ keys: { gemini: 'G2' } });
    const io = file.as('me');
    let phoneWroteFirst = false;
    const racing = {
      ...io,
      write: async (d, version) => {
        if (!phoneWroteFirst) {                // PC가 읽은 뒤, 쓰기 전에 휴대폰이 Claude 키를 저장
          phoneWroteFirst = true;
          file.replace({ ...file.data, keys: { ...file.data.keys, claude: 'C' }, changedAt: { claude: 5 } });
        }
        return io.write(d, version);
      },
    };
    await syncAISettings(racing);
    expect(file.data.keys).toEqual({ gemini: 'G2', claude: 'C' });
    expect(getAIConfig().keys).toEqual({ gemini: 'G2', claude: 'C' });
    expect(getAIConfig().pending).toEqual({});
  });

  test('계속 거절되면 몇 번만 다시 하고 실패한다 — 올릴 것은 남긴다', async () => {
    const file = cloudFile({ provider: 'gemini', keys: { gemini: 'G' }, models: {} });
    updateAIConfig({ keys: { gemini: 'G2' } });
    const io = { ...file.as('me'), write: async () => { throw new ConflictError(); } };
    await expect(syncAISettings(io)).rejects.toBeInstanceOf(ConflictError);
    expect(getAIConfig().pending).toEqual({ gemini: true });
  });

  test('동시에 부르면 하나씩 차례로 돈다', async () => {
    const file = cloudFile({ provider: 'gemini', keys: { gemini: 'G' }, models: {} });
    const order = [];
    const { io: slow, release } = slowFile(file, 'me');
    const a = syncAISettings({ ...slow, read: () => { order.push('a'); return slow.read(); } });
    const plain = file.as('me');
    const b = syncAISettings({ ...plain, read: () => { order.push('b'); return plain.read(); } });
    await new Promise(r => setTimeout(r, 0));
    expect(order).toEqual(['a']);              // a가 끝나기 전에는 b가 읽지 않는다
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
  });
});

test('이 기기 설정이 바뀌면 열려 있는 화면에 알린다', async () => {
  const file = cloudFile({ provider: 'gemini', keys: { gemini: 'G' }, models: {} });
  let calls = 0;
  const off = onAISettingsPulled(() => { calls += 1; });
  await syncAISettings(file.as('me'));
  await syncAISettings(file.as('me'));       // 바뀐 것 없음
  off();
  expect(calls).toBe(1);
});

test('설정 파일이 망가졌으면 없는 것으로 보고 이 기기 키를 다시 올린다 (이 기기 키는 지우지 않음)', async () => {
  const file = cloudFile();
  updateAIConfig({ keys: { gemini: 'G' } });
  await syncAISettings(file.as('me'));
  file.data = { keys: 'garbage' };
  expect(await syncAISettings(file.as('me'))).toBe('pushed');
  expect(file.data.keys.gemini).toBe('G');
  expect(activeAI()).toMatchObject({ apiKey: 'G' });
});

test('고른 공급자의 키가 OneDrive에 없으면 이 기기에서 키가 있는 공급자를 쓴다', async () => {
  const file = cloudFile({ provider: 'gemini', keys: { gemini: '' }, models: {} });
  legacyKey('claude', 'C');
  await syncAISettings(file.as('me'));
  expect(activeAI()).toMatchObject({ provider: 'claude', apiKey: 'C' });
  expect(file.data.provider).toBe('claude');
});

test('고른 공급자의 키를 일부러 지우면 다른 공급자로 몰래 바꾸지 않는다 (과금 공급자로 넘어가지 않게)', async () => {
  const file = cloudFile();
  updateAIConfig({ keys: { gemini: 'G', claude: 'C' } });
  await syncAISettings(file.as('me'));
  updateAIConfig({ keys: { gemini: '' } });
  await syncAISettings(file.as('me'));
  expect(file.data.provider).toBe('gemini');
  expect(getAIConfig().provider).toBe('gemini');
  expect(activeAI()).toBe(null);
});

test('어디에도 키가 없으면 아무것도 쓰지 않는다 / 로그인 정보가 없으면 건너뛴다', async () => {
  const file = cloudFile();
  expect(await syncAISettings(file.as('me'))).toBe('none');
  expect(file.writes).toBe(0);
  expect(await syncAISettings()).toBe('offline');
});

describe('실제 OneDrive 호출', () => {
  const reply = (status, body) => ({
    ok: status < 400, status, statusText: '', json: async () => body, text: async () => JSON.stringify(body),
  });

  test('가계부 파일과 별도인 Apps/financial-ledger/ai-settings.json만 읽고 쓴다', async () => {
    legacyKey('gemini', 'AIza-PC');
    const instance = { acquireTokenSilent: async () => ({ accessToken: 'TOKEN' }) };
    setAISyncAccount(createOneDriveStorage(instance, [{ homeAccountId: 'me' }]));
    let stored = null;
    global.fetch = vi.fn(async (url, init = {}) => {
      if (url === 'https://download/ai') return reply(200, stored);
      if (init.method === 'PUT') { stored = JSON.parse(init.body); return reply(201, {}); }
      return stored ? reply(200, { eTag: 'E1', '@microsoft.graph.downloadUrl': 'https://download/ai' }) : reply(404, {});
    });

    expect(await syncAISettings()).toBe('pushed');
    const urls = fetch.mock.calls.map(([u]) => u);
    expect(urls.every(u => !u.includes('ledger.db'))).toBe(true);
    const put = fetch.mock.calls.find(([, i]) => i?.method === 'PUT');
    // 파일이 없을 때는 새로 만들되, 그 사이 다른 기기가 만들었으면 덮어쓰지 않는다
    expect(put[0]).toBe('https://graph.microsoft.com/v1.0/me/drive/root:/Apps/financial-ledger/ai-settings.json:/content?@microsoft.graph.conflictBehavior=fail');
    expect(put[1].headers.Authorization).toBe('Bearer TOKEN');
    // 응답이 없으면 포기하도록 모든 요청에 시간 제한을 건다
    expect(fetch.mock.calls.every(([, i]) => i && i.signal)).toBe(true);

    // 있는 파일은 읽을 때의 eTag로만 고친다
    updateAIConfig({ keys: { gemini: 'NEW' } });
    expect(await syncAISettings()).toBe('pushed');
    expect(fetch.mock.calls.filter(([, i]) => i?.method === 'PUT')[1][1].headers['If-Match']).toBe('E1');

    // 다른 기기(로컬 비어 있음)에서 열면 받아 온다
    window.localStorage.clear();
    expect(await syncAISettings()).toBe('pulled');
    expect(activeAI()).toMatchObject({ apiKey: 'NEW' });
  });

  test('다른 기기가 먼저 저장해 412가 오면 충돌로 보고 다시 읽는다', async () => {
    updateAIConfig({ keys: { gemini: 'G' } });
    setAISyncAccount(createOneDriveStorage({ acquireTokenSilent: async () => ({ accessToken: 'T' }) }, [{ homeAccountId: 'me' }]));
    let puts = 0;
    global.fetch = vi.fn(async (url, init = {}) => {
      if (url === 'https://download/ai') return reply(200, { provider: 'gemini', keys: { gemini: 'OLD' }, models: {} });
      if (init.method === 'PUT') { puts += 1; return puts === 1 ? reply(412, {}) : reply(200, {}); }
      return reply(200, { eTag: `E${puts}`, '@microsoft.graph.downloadUrl': 'https://download/ai' });
    });
    expect(await syncAISettings()).toBe('pushed');
    expect(puts).toBe(2);
  });

  test('다시 로그인해야 하는 상태여도 로그인 화면으로 넘어가지 않고 실패만 한다', async () => {
    updateAIConfig({ keys: { gemini: 'G' } });
    const instance = {
      acquireTokenSilent: async () => { throw new InteractionRequiredAuthError('interaction_required'); },
      acquireTokenRedirect: vi.fn(async () => {}),
    };
    setAISyncAccount(createOneDriveStorage(instance, [{ homeAccountId: 'me' }]));
    global.fetch = vi.fn();
    await expect(syncAISettings()).rejects.toThrow('다시 로그인');
    expect(instance.acquireTokenRedirect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(getAIConfig().pending).toEqual({ gemini: true });   // 다음에 다시 올린다
  });
});

test('올리는 중에 로그아웃하며 키를 지워도, 올린 것은 OneDrive에 남고 이 기기 키는 되살아나지 않는다', async () => {
  const file = cloudFile({ provider: 'gemini', keys: { gemini: 'G' }, models: {} });
  await syncAISettings(file.as('me'));
  updateAIConfig({ keys: { gemini: 'G2' } });
  const io = file.as('me');
  const clearing = { ...io, write: async (d, version) => { clearAIKeys(); return io.write(d, version); } };
  expect(await syncAISettings(clearing)).toBe('cancelled');
  expect(file.data.keys.gemini).toBe('G2');
  expect(activeAI()).toBe(null);
  expect(getAIConfig().pending).toEqual({});
});

test('두 기기가 동시에 처음 만들면 늦은 쪽은 덮어쓰지 않고 다시 읽어 합친다', async () => {
  const file = cloudFile();
  updateAIConfig({ keys: { gemini: 'G' } });
  const io = file.as('me');
  let otherCreated = false;
  const racing = {
    ...io,
    write: async (d, version) => {
      if (!otherCreated) {                    // 읽을 때는 없었는데, 쓰기 직전에 다른 기기가 만듦
        otherCreated = true;
        file.replace({ provider: 'claude', keys: { claude: 'C' }, models: {}, changedAt: { claude: 3 } });
      }
      return io.write(d, version);
    },
  };
  await syncAISettings(racing);
  expect(file.data.keys).toEqual({ gemini: 'G', claude: 'C' });
});

test('함께 쓰던 공급자 키를 지워도, 예전부터 다른 공급자를 쓰던 기기는 그대로 쓴다 (다른 기기는 바꾸지 않음)', async () => {
  const file = cloudFile();
  onDevice('pc');
  legacyKey('gemini', 'G');
  await syncAISettings(file.as('me'));
  updateAIConfig({ keys: { gemini: '' } });          // PC에서 Gemini 키 삭제 — 고른 공급자는 Gemini 그대로
  await syncAISettings(file.as('me'));

  onDevice('phone');                                  // 이 기능 전부터 Claude를 쓰던 휴대폰
  legacyKey('claude', 'C');
  await syncAISettings(file.as('me'));
  expect(activeAI()).toMatchObject({ provider: 'claude', apiKey: 'C' });
  expect(file.data.provider).toBe('gemini');          // 함께 쓰는 선택은 그대로 — PC가 몰래 Claude로 넘어가지 않는다
  expect(await syncAISettings(file.as('me'))).toBe('same');

  onDevice('pc');
  await syncAISettings(file.as('me'));
  expect(getAIConfig().provider).toBe('gemini');
  expect(activeAI()).toBe(null);
});

test('이 기기만 따로 쓰던 공급자를 직접 골라 저장하면 모든 기기의 선택이 된다', async () => {
  const file = cloudFile({ provider: 'gemini', keys: { gemini: '', claude: 'C' }, models: {}, changedAt: { gemini: 7 } });
  legacyKey('claude', 'C');
  await syncAISettings(file.as('me'));
  expect(getAIConfig().provider).toBe('claude');           // 이 기기에서만 Claude
  expect(file.data.provider).toBe('gemini');

  updateAIConfig({ provider: 'claude' });                  // 고르지 않고 저장 — 올릴 것 없음
  expect(getAIConfig().pending).toEqual({});
  updateAIConfig({ provider: 'claude' }, { pickProvider: true });   // 공급자 버튼을 직접 누르고 저장
  await syncAISettings(file.as('me'));
  expect(file.data.provider).toBe('claude');
});
