/**
 * 공유로 받은 사진·글 (I-024, ROADMAP C-4) — 안드로이드에서 이 앱으로 공유하면 서비스 워커(public/sw.js)가
 * Cache Storage의 share-inbox에 넣어 두고 앱을 연다. 앱은 가계부를 연 뒤 한 번 꺼내 AI 입력으로 연다.
 * 로그인을 거치느라 주소의 ?share=1이 사라져도 받아 둔 것은 남아 있어 꺼낼 수 있다. 꺼내면 지운다.
 */

const INBOX = 'share-inbox';
const META = '/__share/meta';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 하루가 지난 것은 버린다 — 무엇을 공유했는지 잊었을 때다

const hasCaches = () => typeof caches !== 'undefined' && !!caches.open;

/** 받아 둔 것을 꺼낸다(꺼내면 지운다) — { text, files: File[] } | null */
export async function takeSharedItems() {
  if (!hasCaches()) return null;
  const cache = await caches.open(INBOX);
  const metaRes = await cache.match(META);
  if (!metaRes) return null;
  let meta = null;
  try { meta = await metaRes.json(); } catch (e) { meta = null; }
  const files = [];
  if (meta && Date.now() - Number(meta.at || 0) <= MAX_AGE_MS) {
    for (const f of Array.isArray(meta.files) ? meta.files : []) {
      // eslint-disable-next-line no-await-in-loop
      const res = await cache.match(f.path);
      if (res) {
        // eslint-disable-next-line no-await-in-loop
        const blob = await res.blob();
        files.push(new File([blob], f.name || 'shared', { type: f.type || blob.type || '' }));
      }
    }
  } else {
    meta = null;
  }
  await clearSharedItems();
  if (!meta) return null;
  const text = String(meta.text || '').trim();
  const images = files.filter(f => /^image\//.test(f.type));
  return images.length || text ? { text, files: images } : null;
}

/** 받아 둔 것을 지운다 (로그아웃할 때도) */
export async function clearSharedItems() {
  if (!hasCaches()) return;
  try { await caches.delete(INBOX); } catch (e) { /* 무시 */ }
}

/** 처음 연 주소의 바로가기·공유 표시 — 'add' | 'ai' | 'share' | null */
export function readLaunchAction(search = typeof window !== 'undefined' ? window.location.search : '') {
  const params = new URLSearchParams(search || '');
  if (params.has('share')) return 'share';
  const action = params.get('action');
  return action === 'add' || action === 'ai' ? action : null;
}
