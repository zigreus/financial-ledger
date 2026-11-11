/**
 * 휴대폰 사진을 AI로 보내기 좋은 크기의 JPEG로 줄인다.
 * 길쭉한 영수증의 글자가 뭉개지지 않도록 긴 변만이 아니라 전체 픽셀 수로 제한한다.
 * 반환: { base64, mediaType, dataUrl, width, height }
 */
export async function prepareImage(file, { maxEdge = 2000, maxPixels = 2_400_000, quality = 0.85 } = {}) {
  if (!file || !/^image\//.test(file.type || 'image/')) {
    throw new Error('이미지 파일을 선택하세요');
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { naturalWidth: w, naturalHeight: h } = img;
    if (!w || !h) throw new Error('이미지를 읽을 수 없습니다');

    const scale = Math.min(1, maxEdge / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
    const width = Math.max(1, Math.round(w * scale));
    const height = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';               // 투명 PNG 캡처는 흰 바탕으로
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    return { base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', dataUrl, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이 형식의 사진은 열 수 없습니다 — 스크린샷이나 JPEG로 다시 시도하세요'));
    img.src = src;
  });
}

// ── 카드 명세서 (여러 장·긴 캡처·PDF) ─────────────────────────────

const PDF_TYPE = 'application/pdf';

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`${file.name} 파일을 읽을 수 없습니다`));
    reader.readAsDataURL(file);
  });
}

/**
 * 세로로 긴 캡처를 겹치게 잘라 여러 장으로 만든다.
 * 한 장으로 줄이면 글자가 뭉개지고, AI 쪽에서도 큰 이미지는 다시 줄이기 때문이다.
 * 조각 하나는 약 1.15MP 이하 (Claude가 축소하지 않는 크기).
 */
async function imageToTiles(file, { maxAspect = 1.8, overlap = 0.08, maxPixels = 1_150_000, quality = 0.85, prepareOne } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const { naturalWidth: w, naturalHeight: h } = img;
    if (!w || !h) throw new Error('이미지를 읽을 수 없습니다');

    // 세로로 길지 않으면 영수증과 같은 방식으로 한 장
    // (prepareOne이 있으면 그 방식으로 — AI 입력 사진은 예전 영수증과 같은 크기로)
    if (h / w <= maxAspect * 1.15) {
      const one = prepareOne ? await prepareOne() : await prepareImage(file, { maxEdge: 1568, maxPixels });
      return [one];
    }

    const sw = Math.min(w, Math.floor(Math.sqrt(maxPixels / maxAspect)));
    const scale = sw / w;
    const sh = Math.round(h * scale);
    const th = Math.round(sw * maxAspect);
    const step = Math.round(th * (1 - overlap));

    const tiles = [];
    for (let y = 0; ; y += step) {
      const top = Math.min(y, sh - th);         // 마지막 조각은 아래쪽 끝에 맞춘다
      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = th;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, sw, th);
      ctx.drawImage(img, 0, top / scale, w, th / scale, 0, 0, sw, th);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      tiles.push({ base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', dataUrl, width: sw, height: th });
      if (top + th >= sh) break;
    }
    return tiles;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const MAX_PHOTOS = 10;

/**
 * AI 입력의 사진들(영수증·결제 내역 캡처)을 AI 전송용으로 준비한다.
 * 보통 사진은 영수증처럼 한 장으로, 세로로 긴 캡처(스크롤 캡처)는 겹치게 잘라 여러 조각으로.
 * 반환: { parts: [{ base64, mediaType }], previews: [dataUrl] } — previews는 사진마다 하나
 */
export async function preparePhotos(fileList, { maxParts = 24 } = {}) {
  const files = Array.from(fileList || []);
  if (!files.length) throw new Error('사진을 선택하세요');
  if (files.length > MAX_PHOTOS) throw new Error(`사진은 한 번에 ${MAX_PHOTOS}장까지 읽을 수 있어요 — 나눠서 올려 주세요`);
  const parts = [];
  const previews = [];
  for (const file of files) {
    if (!/^image\//.test(file.type || 'image/')) throw new Error('이미지 파일을 선택하세요');
    const tiles = await imageToTiles(file, { prepareOne: () => prepareImage(file) });
    parts.push(...tiles.map(t => ({ base64: t.base64, mediaType: t.mediaType })));
    previews.push(tiles[0].dataUrl);
  }
  if (parts.length > maxParts) {
    throw new Error('사진이 너무 길거나 많아요 — 몇 장씩 나눠서 올려 주세요');
  }
  return { parts, previews };
}

/**
 * 카드 결제 내역 파일들(스크린샷·PDF)을 AI 전송용으로 준비한다.
 * 반환: { parts: [{ base64, mediaType }], previews: [{ name, kind, dataUrl }] }
 */
export async function prepareDocuments(fileList, { maxPdfBytes = 15 * 1024 * 1024, maxParts = 24 } = {}) {
  const parts = [];
  const previews = [];
  for (const file of Array.from(fileList || [])) {
    if (file.type === PDF_TYPE || /\.pdf$/i.test(file.name || '')) {
      if (file.size > maxPdfBytes) throw new Error(`${file.name}: PDF가 너무 큽니다 (15MB 이하)`);
      parts.push({ base64: await readAsBase64(file), mediaType: PDF_TYPE });
      previews.push({ name: file.name, kind: 'pdf', dataUrl: null });
    } else if (/^image\//.test(file.type || '')) {
      const tiles = await imageToTiles(file);
      parts.push(...tiles.map(t => ({ base64: t.base64, mediaType: t.mediaType })));
      previews.push({ name: file.name, kind: 'image', dataUrl: tiles[0].dataUrl, tiles: tiles.length });
    } else {
      throw new Error(`${file.name}: 사진이나 PDF만 올릴 수 있습니다`);
    }
  }
  if (!parts.length) throw new Error('파일을 선택하세요');
  if (parts.length > maxParts) {
    throw new Error(`한 번에 보내기엔 너무 깁니다 (조각 ${parts.length}개) — 기간을 나눠 여러 번 대조하세요`);
  }
  return { parts, previews };
}
