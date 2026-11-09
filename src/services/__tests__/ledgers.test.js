/**
 * @vitest-environment jsdom
 */
// 가계부 목록·참여 링크 (ROADMAP M-2) — 내 가계부 + 다른 계정이 공유한 가계부
import {
  LEDGERS_FILE, OWN_LEDGER, addSharedLedger, buildJoinLink, capturePendingJoin, clearPendingJoin, getCurrentLedgerId,
  getSharedLedgers, ledgerIdOf, mergeLedgerLists, peekPendingJoin, removeSharedLedger, setCurrentLedgerId, syncLedgerList,
} from '../ledgers';
import { createMemoryStorage } from '../storage/memory';

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

const REF = { driveId: 'abc123', itemId: 'ABC123!45' };

describe('참여 링크', () => {
  test('만든 링크를 열면 이 기기에 받아 두고 주소에서 지운다 — 다른 주소 값은 남긴다', () => {
    const link = buildJoinLink('https://app.example', REF, '엄마');
    expect(link).toBe('https://app.example/?join=ms&drive=abc123&item=ABC123%2145&from=%EC%97%84%EB%A7%88');
    window.history.replaceState(null, '', `${new URL(link).search}&action=add`);
    const join = capturePendingJoin(window);
    expect(join).toMatchObject({ provider: 'ms', driveId: 'abc123', itemId: 'ABC123!45', from: '엄마' });
    expect(window.location.search).toBe('?action=add');
    expect(peekPendingJoin()).toMatchObject({ driveId: 'abc123', itemId: 'ABC123!45' });
    clearPendingJoin();
    expect(peekPendingJoin()).toBeNull();
  });

  test('참여 링크가 아니거나 번호가 빠졌으면 받지 않는다 — 오래된 것은 버린다', () => {
    window.history.replaceState(null, '', '/?action=ai');
    expect(capturePendingJoin(window)).toBeNull();
    expect(window.location.search).toBe('?action=ai');
    window.history.replaceState(null, '', '/?join=ms&drive=abc');
    expect(capturePendingJoin(window)).toBeNull();
    expect(window.location.search).toBe('');   // 망가진 링크도 주소에서는 지운다
    window.history.replaceState(null, '', '/?join=ms&drive=..&item=.');   // 번호 모양이 아니다(주소 조각)
    expect(capturePendingJoin(window)).toBeNull();
    expect(peekPendingJoin()).toBeNull();
    window.history.replaceState(null, '', `/${new URL(buildJoinLink('https://x', REF)).search}`);
    const join = capturePendingJoin(window);
    expect(peekPendingJoin(join.at + 8 * 24 * 60 * 60 * 1000)).toBeNull();
    expect(peekPendingJoin()).toBeNull();
  });
});

describe('목록과 지금 보는 가계부', () => {
  test('넣고·고르고·빼면 — 뺀 것을 보고 있었으면 내 가계부로, 목록에 없는 번호는 내 가계부', () => {
    expect(getSharedLedgers('me')).toEqual([]);
    expect(getCurrentLedgerId('me')).toBe(OWN_LEDGER);
    const id = addSharedLedger('me', { ...REF, ownerName: '엄마' }, 1000);
    addSharedLedger('me', { driveId: 'd2', itemId: 'i2', ownerName: '아빠' }, 2000);
    expect(id).toBe(ledgerIdOf(REF));
    expect(getSharedLedgers('me').map(l => l.ownerName)).toEqual(['엄마', '아빠']);
    expect(getSharedLedgers('other')).toEqual([]);   // 계정마다 따로
    setCurrentLedgerId('me', id);
    expect(getCurrentLedgerId('me')).toBe(id);
    removeSharedLedger('me', id, 3000);
    expect(getSharedLedgers('me').map(l => l.ownerName)).toEqual(['아빠']);
    expect(getCurrentLedgerId('me')).toBe(OWN_LEDGER);
    setCurrentLedgerId('me', 'ms:없는:번호');
    expect(getCurrentLedgerId('me')).toBe(OWN_LEDGER);
    // 다시 넣으면 되살아난다
    addSharedLedger('me', { ...REF }, 4000);
    expect(getSharedLedgers('me').map(l => l.ownerName)).toEqual(['아빠', '엄마']);
  });

  test('기기끼리 합치기 — 항목마다 더 나중에 바꾼 것(뺀 기록 포함)', () => {
    const a = { entries: { x: { id: 'x', at: 10, removed: false, ownerName: '엄마' }, y: { id: 'y', at: 30, removed: true } } };
    const b = { entries: { x: { id: 'x', at: 20, removed: true }, y: { id: 'y', at: 25, removed: false }, z: { id: 'z', at: 5, removed: false } } };
    const merged = mergeLedgerLists(a, b);
    expect(merged.entries.x.removed).toBe(true);
    expect(merged.entries.y.removed).toBe(true);
    expect(merged.entries.z.removed).toBe(false);
  });

  test('계정 드라이브의 ledgers.json과 맞춘다 — 다른 기기가 넣은 것이 보이고, 내 것은 올라간다', async () => {
    const storage = createMemoryStorage({ accountKey: 'me' });
    await storage.writeSettings(LEDGERS_FILE, { entries: { 'ms:d9:i9': { id: 'ms:d9:i9', driveId: 'd9', itemId: 'i9', ownerName: '할머니', at: 50, removed: false } } }, null);
    addSharedLedger('me', { ...REF, ownerName: '엄마' }, 100);
    expect(await syncLedgerList(storage)).toBe(true);
    expect(getSharedLedgers('me').map(l => l.ownerName).sort()).toEqual(['엄마', '할머니']);
    const { data } = await storage.readSettings(LEDGERS_FILE);
    expect(Object.keys(data.entries).sort()).toEqual([ledgerIdOf(REF), 'ms:d9:i9'].sort());
    expect(await syncLedgerList(storage)).toBe(false);   // 이미 같다
  });

  test('받는 사이 이 기기에서 넣은 것도 잃지 않는다(참여 링크로 열기가 맞추기와 겹침)', async () => {
    const storage = createMemoryStorage({ accountKey: 'me' });
    const realRead = storage.readSettings;
    storage.readSettings = async (name) => {
      const got = await realRead(name);
      addSharedLedger('me', { ...REF, ownerName: '엄마' }, 500);   // 받는 사이 넣었다
      return got;
    };
    await syncLedgerList(storage);
    expect(getSharedLedgers('me').map(l => l.ownerName)).toEqual(['엄마']);
    const { data } = await realRead(LEDGERS_FILE);
    expect(Object.keys(data.entries)).toEqual([ledgerIdOf(REF)]);
  });

  test('그 사이 다른 기기가 저장했으면 다시 읽어 합친다', async () => {
    const storage = createMemoryStorage({ accountKey: 'me' });
    addSharedLedger('me', { ...REF, ownerName: '엄마' }, 100);
    const realWrite = storage.writeSettings;
    let raced = false;
    storage.writeSettings = async (name, data, version) => {
      if (!raced) {
        raced = true;
        await realWrite(name, { entries: { 'ms:dz:iz': { id: 'ms:dz:iz', driveId: 'dz', itemId: 'iz', ownerName: '아빠', at: 70, removed: false } } }, version);
      }
      return realWrite(name, data, version);
    };
    await syncLedgerList(storage);
    const { data } = await storage.readSettings(LEDGERS_FILE);
    expect(Object.keys(data.entries).sort()).toEqual([ledgerIdOf(REF), 'ms:dz:iz'].sort());
    expect(getSharedLedgers('me').map(l => l.ownerName).sort()).toEqual(['아빠', '엄마']);
  });
});
