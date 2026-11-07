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
