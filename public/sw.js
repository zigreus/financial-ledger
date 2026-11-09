/* eslint-disable no-restricted-globals */
/**
 * 지금 가계부 서비스 워커 (I-024, ROADMAP C-4)
 *
 *  1) 연결 없이 열기 — 앱 화면(index.html과 그것이 가리키는 /assets/* 빌드 파일, sql-wasm.wasm, 아이콘)을 이 기기에 둔다.
 *     열 때 불러오는 화면의 파일(I-033)도 빌드가 index.html에 prefetch로 적어 두므로 함께 받아 둔다(vite.config.mjs).
 *     - index.html은 그것이 가리키는 빌드 파일(앱이 바뀌었으면 sql-wasm.wasm도)을 모두 받아 둔 뒤에만 바꾼다
 *       — 둔 화면이 없는 파일을 찾아 흰 화면이 되거나, 새 JS와 옛 wasm이 섞여 열리지 않는 일이 없게.
 *       설치할 때(첫 방문 포함) 한 번, 그리고 페이지를 서버에서 새로 받을 때마다. 지금 index.html이 가리키지 않는 빌드 파일은 지운다.
 *     - 페이지 열기: 먼저 서버에 묻고(4초까지), 안 되면 둔 index.html
 *       (개인정보처리방침·이용약관 페이지는 서버가 먼저, 안 되면 한 번 볼 때 둔 그 페이지 — 앱 화면으로 대신하지 않는다)
 *     - /assets/*: 이름에 내용 해시가 붙어 바뀌지 않으므로 둔 것을 먼저
 *     - sql-wasm.wasm·manifest.json: 서버가 먼저(4초까지), 안 되면 둔 것 — 앱 JS와 버전이 어긋나면 열리지 않는다(B-013)
 *     - 아이콘: 둔 것을 바로 쓰고 뒤에서 새로 받아 둔다
 *     가계부 데이터·로그인(OneDrive·Microsoft)·AI 요청은 건드리지 않는다(다른 주소라 그대로 지나간다).
 *  2) 공유 받기 — 안드로이드에서 사진·글을 이 앱으로 공유하면(manifest의 share_target, POST /share-target)
 *     받은 것을 share-inbox에 넣어 두고 앱을 연다(/?share=1). 앱이 꺼내 AI 입력으로 연다(src/services/shareInbox.js).
 *
 * 캐시 이름을 바꾸면(SHELL_CACHE) 새 워커가 켜질 때 옛 앱 화면 캐시를 지운다.
 */

const SHELL_CACHE = 'shell-v2';
const ASSET_CACHE = 'assets';
const INBOX_CACHE = 'share-inbox';
const NETWORK_TIMEOUT_MS = 4000; // 연결이 약할 때 이만큼만 기다리고 둔 것을 쓴다
const ICONS = ['/favicon_b2.ico', '/logo192_b2.png', '/logo512_b2.png', '/logo192_transparent.png'];
const NETWORK_FIRST = new Set(['/sql-wasm.wasm', '/manifest.json']);
// 앱 화면이 아닌 정적 페이지(개인정보처리방침·이용약관, I-038) — 연결이 없을 때 앱 화면(index.html)을 대신 열지 않고,
// 한 번 본 것이 있으면 그것을 보인다
const DOC_PAGES = new Set(['/privacy.html', '/terms.html']);
const ICON_PATHS = new Set(ICONS);
const ASSET_RE = /\/assets\/[A-Za-z0-9._-]+/g;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll([...NETWORK_FIRST, ...ICONS]);
    const res = await fetch('/index.html', { cache: 'reload' });
    if (!res.ok) throw new Error(`index.html ${res.status}`);
    await keepIndex(res); // 가리키는 빌드 파일을 먼저 받아 둔다 — 첫 방문의 JS·CSS는 워커를 거치지 않았다
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k.startsWith('shell-') && k !== SHELL_CACHE)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // OneDrive·로그인·AI는 그대로

  if (request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate' && DOC_PAGES.has(url.pathname)) {
    event.respondWith(networkFirst(request, url.pathname));
  } else if (request.mode === 'navigate') {
    event.respondWith(openPage(event));
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(assetFirst(request));
  } else if (NETWORK_FIRST.has(url.pathname)) {
    event.respondWith(networkFirst(request, url.pathname));
  } else if (ICON_PATHS.has(url.pathname)) {
    event.respondWith(iconFile(request));
  }
});

/** 서버 응답이 제한 시간 안에 오면 그 응답, 실패하거나 늦으면 null */
async function within(network) {
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS); });
  try {
    return await Promise.race([network.catch(() => null), slow]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * index.html을 둔다 — 그것이 가리키는 빌드 파일을 모두 받아 둔 뒤에만. 하나라도 못 받으면 옛 것을 그대로 둔다.
 * 그다음 새 index.html과 바로 전 index.html이 가리키지 않는 빌드 파일은 지운다(배포마다 쌓이지 않게, 쓰는 파일은 남게).
 * 바로 전 것도 남기는 이유: 연결이 느려 둔 옛 화면으로 열린 사이 새 화면이 받아지면, 열려 있는 옛 화면이
 * 아직 불러오지 않은 화면 파일(I-033)을 찾을 수 있어야 한다. 그다음 열 때(두 index.html이 같아지면) 지워진다
 */
async function keepIndex(res) {
  const type = res.headers.get('content-type') || '';
  if (!res.ok || res.redirected || res.type !== 'basic' || !type.includes('text/html')) return;
  const html = await res.clone().text();
  const refs = [...new Set(html.match(ASSET_RE) || [])];
  const assets = await caches.open(ASSET_CACHE);
  for (const path of refs) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await assets.match(path, { ignoreVary: true }))) {
      // eslint-disable-next-line no-await-in-loop
      const got = await fetch(path);
      if (!got.ok) return;
      // eslint-disable-next-line no-await-in-loop
      await assets.put(path, got);
    }
  }
  const shell = await caches.open(SHELL_CACHE);
  // 앱이 바뀌었으면(새 배포) sql-wasm.wasm도 함께 새로 받아 둔다 — wasm은 HTML에 나오지 않지만 앱 JS와 버전이 맞아야 한다(B-013)
  const old = await shell.match('/index.html');
  const oldHtml = old ? await old.text() : '';
  if (oldHtml !== html) {
    const wasm = await fetch('/sql-wasm.wasm', { cache: 'reload' });
    if (!wasm.ok) return;
    await shell.put('/sql-wasm.wasm', wasm);
  }
  await shell.put('/index.html', new Response(html, { headers: { 'Content-Type': type } }));
  const keep = new Set([...refs, ...(oldHtml.match(ASSET_RE) || [])]);
  const keys = await assets.keys();
  await Promise.all(keys.filter(k => !keep.has(new URL(k.url).pathname)).map(k => assets.delete(k)));
}

/**
 * 페이지 열기 — 서버가 먼저, 안 되면(또는 너무 느리면) 둔 index.html.
 * 앱 화면 주소(/, /index.html)의 응답은 늦게 와도 새 index.html로 둔다(그것이 가리키는 빌드 파일을 받은 뒤).
 * waitUntil은 이벤트를 받은 그 자리에서 건다 — 응답을 돌려준 뒤에는 걸 수 없다
 */
function openPage(event) {
  const { request } = event;
  const isApp = ['/', '/index.html'].includes(new URL(request.url).pathname);
  const network = fetch(request).then((res) => {
    if (isApp) event.waitUntil(keepIndex(res.clone()).catch(() => {}));
    return res;
  });
  if (isApp) event.waitUntil(network.catch(() => {}));
  return (async () => {
    const res = await within(network);
    if (res) return res;
    const shell = await caches.open(SHELL_CACHE);
    const cached = await shell.match('/index.html');
    return cached || network; // 둔 것이 없으면 서버를 끝까지 기다린다(실패하면 브라우저 오류 화면)
  })();
}

/**
 * 빌드 파일 — 둔 것이 먼저, 없으면 받아서 둔다.
 * Vary는 보지 않는다(ignoreVary) — 이름에 내용 해시가 붙어 바뀌지 않는 파일이다. 서버가 'Vary: Origin'을 붙이면
 * Origin 없이 받아 둔 것(미리 받기·keepIndex)을 Origin을 보내는 요청(늦게 불러오는 import, crossorigin 스크립트)이
 * 찾지 못해 연결이 없을 때 화면을 열 수 없다 (I-033에서 확인 — vite preview가 그렇게 응답한다)
 */
async function assetFirst(request) {
  const assets = await caches.open(ASSET_CACHE);
  const cached = await assets.match(request, { ignoreVary: true });
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) await assets.put(request, res.clone());
  return res;
}

/** sql-wasm.wasm·manifest.json·정적 페이지(DOC_PAGES) — 서버가 먼저(받으면 둔다), 안 되면(또는 너무 느리면) 둔 것 */
async function networkFirst(request, path) {
  const shell = await caches.open(SHELL_CACHE);
  const network = fetch(request).then((res) => {
    if (res.ok) shell.put(path, res.clone()).catch(() => {});
    return res;
  });
  const res = await within(network);
  if (res && res.ok) return res;
  const cached = await shell.match(path);
  return cached || res || network;
}

/** 아이콘 — 둔 것을 바로 쓰고 뒤에서 새로 받아 둔다 */
async function iconFile(request) {
  const shell = await caches.open(SHELL_CACHE);
  const cached = await shell.match(request);
  const network = fetch(request)
    .then((res) => { if (res.ok) shell.put(request, res.clone()); return res; })
    .catch(() => null);
  if (cached) return cached;
  return (await network) || Response.error();
}

/** 공유로 받은 사진·글을 넣어 두고 앱을 연다 — 앞서 받아 둔 것은 지운다(마지막 공유만) */
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter(f => f && typeof f === 'object' && f.size > 0).slice(0, 5);
    const title = String(form.get('title') || '').trim();
    const body = String(form.get('text') || '').trim();
    const link = String(form.get('url') || '').trim();
    const text = [body || title, link && !body.includes(link) ? link : ''].filter(Boolean).join('\n');
    const cache = await caches.open(INBOX_CACHE);
    const old = await cache.keys();
    await Promise.all(old.map(k => cache.delete(k)));
    const meta = {
      at: Date.now(),
      text,
      files: files.map((f, i) => ({ path: `/__share/file-${i}`, name: f.name || `shared-${i}`, type: f.type || '' })),
    };
    await Promise.all(files.map((f, i) => cache.put(meta.files[i].path, new Response(f, {
      headers: { 'Content-Type': f.type || 'application/octet-stream' },
    }))));
    await cache.put('/__share/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {
    // 받지 못했다 — 앱만 연다
  }
  return Response.redirect('/?share=1', 303);
}
