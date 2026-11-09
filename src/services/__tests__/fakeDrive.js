// 테스트용 가짜 Google Drive(v3) — googleDrive.js가 쓰는 요청만 흉내 낸다 (M-1, I-031).
// 파일마다 리비전 목록을 두고 headRevisionId는 마지막 리비전이다. 조건부 저장은 없다(실제 Drive처럼 — 저장소가 확인으로 대신한다).
// 실제 Drive의 동작을 증명하지는 않는다.
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

export function fakeDrive({ token = 'T' } = {}) {
  const files = new Map(); // id → { id, name, parent, mime, created, modified, revisions: [{ id, bytes }] }
  let n = 0;
  let clock = 0;
  // beforeUpload(f): 다음 올리기 직전에 한 번(다른 기기가 끼어든 것처럼)
  // revisionList(list): 리비전 목록 응답을 바꿔 보낸다(순서 섞기 등) / failNext(matcher): 그 요청 하나를 실패시킨다
  const hooks = { beforeUpload: null, revisionList: null, failNext: null };
  const tick = () => new Date(Date.UTC(2026, 0, 1) + (clock += 1) * 1000).toISOString();
  const nextId = p => `${p}${n += 1}`;

  const reply = (status, body = {}, bytes = null) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => new TextDecoder().decode(bytes || new Uint8Array()),
    arrayBuffer: async () => (bytes || new Uint8Array()).slice().buffer,
  });
  const meta = f => ({
    id: f.id, name: f.name, mimeType: f.mime, createdTime: f.created, modifiedTime: f.modified,
    size: f.mime === FOLDER ? undefined : String(f.revisions.at(-1)?.bytes.length || 0),
    headRevisionId: f.mime === FOLDER ? undefined : f.revisions.at(-1)?.id,
  });
  const toBytes = async (body) => {
    if (body instanceof Uint8Array) return body;
    if (typeof body === 'string') return new TextEncoder().encode(body);
    if (body && typeof body.arrayBuffer === 'function') return new Uint8Array(await body.arrayBuffer());
    return new Uint8Array(body || []);
  };

  function add(parent, name, mime, bytes = null) {
    const f = { id: nextId(mime === FOLDER ? 'fold' : 'file'), name, parent, mime, created: tick(), modified: '', revisions: [] };
    if (bytes) f.revisions.push({ id: nextId('rev'), bytes, modifiedTime: f.created });
    f.modified = f.created;
    files.set(f.id, f);
    return f;
  }
  function addRevision(f, bytes) {
    f.modified = tick();
    f.revisions.push({ id: nextId('rev'), bytes, modifiedTime: f.modified });
  }

  // q 해석: name = 'x' / 'P' in parents / mimeType = | != 'folder' (trashed는 늘 false)
  function query(q) {
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    const mimeOp = /mimeType (=|!=) '/.exec(q)?.[1];
    return [...files.values()]
      .filter(f => (name === undefined || f.name === name) && (!parent || f.parent === parent)
        && (!mimeOp || (mimeOp === '=' ? f.mime === FOLDER : f.mime !== FOLDER)))
      .sort((a, b) => a.created.localeCompare(b.created));
  }

  const fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || 'GET';
    if (init.headers?.Authorization !== `Bearer ${token}`) return reply(401);
    if (hooks.failNext && hooks.failNext.match(url, method)) {
      const { status } = hooks.failNext;
      hooks.failNext = null;
      if (status === 'offline') throw new TypeError('Failed to fetch');
      return reply(status);
    }
    const u = new URL(url);
    const path = u.origin + u.pathname;

    if (path === `${API}/files` && method === 'GET') {
      return reply(200, { files: query(u.searchParams.get('q') || '').map(meta) });
    }
    if (path === `${API}/files` && method === 'POST') {
      const body = JSON.parse(init.body);
      return reply(200, meta(add(body.parents[0], body.name, body.mimeType)));
    }
    if (path === `${UPLOAD}/files` && method === 'POST') {
      const all = await toBytes(init.body);
      const raw = Array.from(all, b => String.fromCharCode(b)).join('');   // 바이트 그대로(latin1)
      const boundary = /boundary=(\S+)/.exec(init.headers['Content-Type'])[1];
      const parts = raw.split(`--${boundary}`).slice(1, -1).map(p => p.replace(/^\r\n/, '').replace(/\r\n$/, ''));
      const metaText = new TextDecoder().decode(Uint8Array.from(parts[0].split('\r\n\r\n').slice(1).join('\r\n\r\n'), c => c.charCodeAt(0)));
      const metaPart = JSON.parse(metaText);
      const content = parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n');
      const bytes = Uint8Array.from(content, c => c.charCodeAt(0));
      return reply(200, meta(add(metaPart.parents[0], metaPart.name, metaPart.mimeType, bytes)));
    }
    const up = new RegExp(`^${UPLOAD}/files/([^/]+)$`).exec(path);
    if (up && method === 'PATCH') {
      const f = files.get(decodeURIComponent(up[1]));
      if (!f) return reply(404);
      if (hooks.beforeUpload) { const h = hooks.beforeUpload; hooks.beforeUpload = null; h(f); }
      addRevision(f, await toBytes(init.body));
      return reply(200, meta(f));
    }
    const rev = new RegExp(`^${API}/files/([^/]+)/revisions(?:/([^/]+))?$`).exec(path);
    if (rev) {
      const f = files.get(decodeURIComponent(rev[1]));
      if (!f) return reply(404);
      if (!rev[2]) {
        const list = f.revisions.map(r => ({ id: r.id, modifiedTime: r.modifiedTime }));
        return reply(200, { revisions: hooks.revisionList ? hooks.revisionList(list) : list });
      }
      const r = f.revisions.find(x => x.id === decodeURIComponent(rev[2]));
      return r ? reply(200, {}, r.bytes) : reply(404);
    }
    const one = new RegExp(`^${API}/files/([^/]+)$`).exec(path);
    if (one) {
      const f = files.get(decodeURIComponent(one[1]));
      if (method === 'DELETE') { if (f) files.delete(f.id); return reply(f ? 204 : 404); }
      if (!f) return reply(404);
      if (u.searchParams.get('alt') === 'media') return reply(200, {}, f.revisions.at(-1)?.bytes || new Uint8Array());
      return reply(200, meta(f));
    }
    return reply(400);
  });

  const appFolder = () => query("name = 'financial-ledger' and 'root' in parents and mimeType = '")[0]
    || add('root', 'financial-ledger', FOLDER);
  const fileIn = (name) => query(`name = '${name}' and '${appFolder().id}' in parents and mimeType != '`)[0] || null;

  return {
    fetch,
    hooks,
    files,
    /** 다른 기기가 저장한 것처럼(파일이 없으면 만든다) */
    put(name, body) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      const f = fileIn(name);
      if (f) addRevision(f, bytes);
      else add(appFolder().id, name, 'application/octet-stream', bytes);
    },
    /** 다른 기기가 같은 이름의 파일을 따로 만든 것처럼 */
    addDuplicate(name, body) { return add(appFolder().id, name, 'application/octet-stream', body); },
    remove(name) { const f = fileIn(name); if (f) files.delete(f.id); },
    revisionsOf(name) { return fileIn(name)?.revisions.map(r => Array.from(r.bytes)) || []; },
    countNamed(name) { return query(`name = '${name}' and '${appFolder().id}' in parents and mimeType != '`).length; },
  };
}
