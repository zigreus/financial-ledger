/**
 * @vitest-environment jsdom
 */
// 공유 받기 (I-024) — 서비스 워커가 share-inbox에 넣어 둔 사진·글을 앱이 한 번 꺼낸다
import { takeSharedItems, clearSharedItems, readLaunchAction } from '../shareInbox';

/** Cache Storage 가짜 — 서비스 워커가 넣는 모양(meta JSON + 파일)만 흉내 낸다 */
function fakeCaches() {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async key => m.get(key) || undefined,
      put: async (key, res) => { m.set(key, res); },
      keys: async () => [...m.keys()],
      delete: async key => m.delete(key),
    };
  };
  return { open, delete: async name => stores.delete(name), has: name => stores.has(name) && stores.get(name).size > 0 };
}
const jsonRes = obj => ({ json: async () => obj });
const blobRes = (bytes, type) => ({ blob: async () => new Blob([new Uint8Array(bytes)], { type }) });

async function share({ at = Date.now(), text = '', files = [] } = {}) {
  const cache = await global.caches.open('share-inbox');
  const meta = { at, text, files: files.map((f, i) => ({ path: `/__share/file-${i}`, name: f.name, type: f.type })) };
  await Promise.all(files.map((f, i) => cache.put(meta.files[i].path, blobRes(f.bytes, f.type))));
  await cache.put('/__share/meta', jsonRes(meta));
}

beforeEach(() => { global.caches = fakeCaches(); });
afterEach(() => { delete global.caches; });

test('공유받은 사진(이미지만)과 글을 꺼내고, 꺼내면 지운다', async () => {
  await share({ text: '스타벅스 영수증', files: [{ name: 'r.jpg', type: 'image/jpeg', bytes: [1, 2, 3] }, { name: 'a.pdf', type: 'application/pdf', bytes: [9] }] });
  const got = await takeSharedItems();
  expect(got.text).toBe('스타벅스 영수증');
  expect(got.files.map(f => [f.name, f.type, f.size])).toEqual([['r.jpg', 'image/jpeg', 3]]);
  expect(global.caches.has('share-inbox')).toBe(false);
  expect(await takeSharedItems()).toBeNull();
});

test('글만 공유받아도 꺼낸다 (카드 문자)', async () => {
  await share({ text: '[Web발신]\n신한카드(1234)승인 12,500원' });
  expect(await takeSharedItems()).toEqual({ text: '[Web발신]\n신한카드(1234)승인 12,500원', files: [] });
});

test('하루가 지난 것·비어 있는 것은 버린다', async () => {
  await share({ at: Date.now() - 25 * 60 * 60 * 1000, text: '어제 공유' });
  expect(await takeSharedItems()).toBeNull();
  expect(global.caches.has('share-inbox')).toBe(false);
  await share({ text: '   ' });
  expect(await takeSharedItems()).toBeNull();
});

test('Cache Storage가 없으면(지원 안 함) 조용히 없음', async () => {
  delete global.caches;
  expect(await takeSharedItems()).toBeNull();
  await expect(clearSharedItems()).resolves.toBeUndefined();
});

test('처음 연 주소의 바로가기·공유 표시', () => {
  expect(readLaunchAction('?action=add')).toBe('add');
  expect(readLaunchAction('?action=ai')).toBe('ai');
  expect(readLaunchAction('?share=1')).toBe('share');
  expect(readLaunchAction('?action=delete-all')).toBeNull();
  expect(readLaunchAction('')).toBeNull();
});
