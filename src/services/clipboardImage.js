/**
 * 클립보드의 이미지 (I-020) — 캡처한 영수증·카드 내역을 파일로 저장했다 고르지 않고 바로 붙여넣는다.
 *
 *  - 단축키 붙여넣기(Ctrl+V·⌘V): imagesFromPaste — 화면에 열린 입력 영역이 문서의 paste 이벤트에서 부른다
 *  - 붙여넣기 버튼(휴대폰, 입력 칸 밖에서는 단축키가 안 먹는 Safari 등): readClipboardImages — 사용자가 누른 순간에만 부른다
 * 얻은 것은 일반 File이라 파일을 고른 것과 같은 흐름(prepareImage·prepareDocuments)으로 보낸다.
 */
import { toDateStr } from './dateUtils';

const pad2 = n => String(n).padStart(2, '0');
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };
const IMAGE = /^image\//;
// 캡처 도구·브라우저가 붙이는 뜻 없는 이름 — 이런 이름은 시각이 붙은 이름으로 바꾼다
const GENERIC_NAME = /^(image|blob|clipboard|screenshot|unknown)?\.?(png|jpe?g|gif|webp|bmp|heic)?$/i;
// 그림에 딸려 오는 글 — 이미지 주소(Firefox·Safari '이미지 복사')나 파일 이름(Mac Finder 파일 복사)뿐이면 그림 붙여넣기로 본다
// (파일 이름에는 경로 구분자·콜론이 없다 — '영수증 보세요 https://…/a.png' 같은 문장은 글로 둔다)
const SIDE_TEXT_LINE = /^(?:(?:https?|file|data|blob):\S+|[^\t/\\:]+\.(?:png|jpe?g|gif|webp|bmp|heic|heif|tiff?|pdf))$/i;

/** 글을 입력하는 자리인지 — 그곳에서는 글이 함께 오면 늘 글로 붙여넣는다 */
function isTextField(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  const type = (el.type || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'file', 'submit', 'reset', 'range', 'color', 'image'].includes(type);
}

/** 이 붙여넣기의 글을 글로 붙여넣어야 하는지 — 글 입력 칸이면 늘, 그 밖에서는 주소·파일 이름이 아닌 글일 때 */
function textWins(text, target) {
  if (!text) return false;
  if (isTextField(target)) return true;
  return !text.split(/\r\n|\r|\n/).every(line => SIDE_TEXT_LINE.test(line.trim()));
}

/** 캡처 이미지는 이름이 없거나 'image.png' 같은 이름이라 시각을 붙인다(탐색기에서 복사한 파일은 원래 이름 그대로). seq: 여러 장일 때 1부터 */
function named(blob, seq, now = new Date()) {
  const original = typeof blob.name === 'string' ? blob.name.trim() : '';
  if (original && !GENERIC_NAME.test(original)) return blob;
  const type = blob.type || 'image/png';
  const time = `${toDateStr(now).replace(/-/g, '')}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const name = `캡처-${time}${seq ? `-${seq}` : ''}.${EXT[type] || 'png'}`;
  try {
    return new File([blob], name, { type, lastModified: now.getTime() });
  } catch (e) {
    return blob; // File 생성자가 없는 오래된 브라우저 — 이름 없이 그대로
  }
}

/**
 * 붙여넣기 이벤트에서 이미지 파일을 꺼낸다. 이미지로 다룰 것이 없으면 [] — 그때는 원래대로 글이 붙여넣어지게 둔다.
 * 클립보드에 글도 있으면(엑셀·워드·웹 페이지 복사는 글과 그림을 함께 담는다) 글 붙여넣기로 본다 — 캡처 도구가 담는 것은
 * 그림뿐이다. 다만 글 입력 칸 밖에서, 함께 온 글이 이미지 주소·파일 이름뿐이면(브라우저 '이미지 복사', Mac 파일 복사) 그림으로 읽는다.
 * accept: 받을 파일 형식(기본: 이미지). 카드 명세서처럼 PDF도 받으면 /^(image\/|application\/pdf$)/
 */
export function imagesFromPaste(event, { accept = IMAGE } = {}) {
  const data = event && event.clipboardData;
  if (!data) return [];
  const text = typeof data.getData === 'function' ? String(data.getData('text/plain') || '').trim() : '';
  if (textWins(text, event.target)) return [];
  const blobs = [];
  Array.from(data.items || []).forEach(item => {
    if (item.kind === 'file' && accept.test(item.type || '')) {
      const f = item.getAsFile();
      if (f) blobs.push(f);
    }
  });
  if (!blobs.length) {
    Array.from(data.files || []).forEach(f => { if (accept.test(f.type || '')) blobs.push(f); });
  }
  const now = new Date();
  return blobs.map((b, i) => named(b, blobs.length > 1 ? i + 1 : 0, now));
}

/** 이 브라우저가 버튼으로 클립보드 이미지를 읽을 수 있는지 (보안 연결에서만 있다) */
export function canReadClipboardImages() {
  return typeof navigator !== 'undefined' && !!navigator.clipboard && typeof navigator.clipboard.read === 'function';
}

/** 이 기기의 붙여넣기 단축키 이름 — Mac·iPad는 ⌘V */
export function pasteShortcut() {
  const platform = typeof navigator !== 'undefined' ? `${navigator.platform || ''} ${navigator.userAgent || ''}` : '';
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘V' : 'Ctrl+V';
}

/**
 * 붙여넣기 버튼 — 클립보드의 이미지를 읽는다. 사용자가 누른 순간에 불러야 한다.
 * 이미지가 없거나 읽을 수 없으면 이유를 담은 오류를 던진다(화면에 그대로 보인다).
 */
export async function readClipboardImages() {
  if (!canReadClipboardImages()) {
    throw new Error('이 브라우저는 버튼으로 붙여넣기를 지원하지 않습니다 — 파일로 골라 주세요');
  }
  const blobs = [];
  try {
    const items = await navigator.clipboard.read();
    for (const item of items || []) {
      const type = (item.types || []).find(t => IMAGE.test(t));
      if (type) blobs.push(await item.getType(type));
    }
  } catch (e) {
    if (e && e.name === 'NotAllowedError') {
      throw new Error('클립보드를 읽지 못했습니다 — 브라우저가 묻는 \'붙여넣기\'·\'허용\'을 누르거나, 파일로 골라 주세요');
    }
    throw new Error('클립보드를 읽지 못했습니다 — 다시 캡처해 보거나 파일로 골라 주세요');
  }
  if (!blobs.length) throw new Error('클립보드에 이미지가 없습니다 — 화면을 캡처하거나 이미지를 복사한 뒤 다시 눌러 주세요');
  const now = new Date();
  return blobs.map((b, i) => named(b, blobs.length > 1 ? i + 1 : 0, now));
}
