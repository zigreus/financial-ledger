/**
 * 도는 이모지를 그림 중심으로 돌리기 (I-060).
 *
 * 이모지는 기본 글꼴에 없어 다른 글꼴(삼성·애플·구글·윈도 이모지)에서 빌려 그려지고, 줄 자리는 기본 글꼴로 잡혀
 * 그림이 글자 상자 가운데에서 기기마다 조금씩 벗어난다 — 상자를 돌리면 미묘하게 흔들린다.
 * 그래서 이 기기의 글꼴로 이모지를 캔버스에 그려 칠해진 부분만 잘라 정사각형 한가운데에 다시 그린다. 그 캔버스를 돌리면
 * 축이 정확히 그림 중심이다(모양은 같은 이모지 그대로).
 *
 * canvas: 화면에 보일 캔버스(CSS로 1em 정사각형), source: 같은 글꼴·크기의 글자 요소. 그렸으면 true,
 * 그릴 수 없으면(OffscreenCanvas·2d가 없는 환경) false — 그때는 글자를 그대로 돌린다.
 */
export function drawCenteredEmoji(canvas, source, dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1) {
  if (!canvas || !source || typeof OffscreenCanvas === 'undefined' || typeof getComputedStyle !== 'function') return false;
  try {
    const cs = getComputedStyle(source);
    const text = source.textContent || '';
    const sizeCss = parseFloat(cs.fontSize);
    if (!text || !sizeCss) return false;
    const px = Math.max(8, Math.round(sizeCss * dpr));     // 화면 픽셀 그대로 — 흐려지지 않게
    const work = new OffscreenCanvas(px * 3, px * 3);
    const wctx = work.getContext('2d', { willReadFrequently: true });
    const vctx = canvas.getContext && canvas.getContext('2d');
    if (!wctx || !vctx) return false;
    wctx.font = `${cs.fontStyle} ${cs.fontWeight} ${px}px ${cs.fontFamily}`;
    wctx.textBaseline = 'middle';
    wctx.fillText(text, px, px * 1.5);
    const { data, width, height } = wctx.getImageData(0, 0, work.width, work.height);
    let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        // 눈에 보이는 진한 부분만 — 가장자리 번짐·옅은 그림자까지 치면 중심이 그쪽으로 끌린다
        if (data[(y * width + x) * 4 + 3] > 128) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return false;
    let inkW = maxX - minX + 1;
    let inkH = maxY - minY + 1;
    // 정사각형 한 변 = 글자 크기(그림이 더 크면 그만큼). 그림을 정수 픽셀에 한가운데 놓으려면 여백이 짝수여야 한다 —
    // 한 변을 그림 가로와 짝을 맞추고, 세로가 짝이 다르면 잘라 낼 칸을 투명한 한 줄만큼 늘린다(반 픽셀 번짐·치우침 없이)
    let side = Math.max(px, inkW, inkH);
    if ((side - inkW) % 2) side += 1;
    if ((side - inkH) % 2) inkH += 1;
    canvas.width = side;
    canvas.height = side;
    vctx.clearRect(0, 0, side, side);
    vctx.drawImage(work, minX, minY, inkW, inkH, (side - inkW) / 2, (side - inkH) / 2, inkW, inkH);
    // 캔버스 한 칸 = 화면 한 픽셀(흐려지지 않게)
    canvas.style.width = `${side / dpr}px`;
    canvas.style.height = `${side / dpr}px`;
    return true;
  } catch (e) {
    return false;
  }
}
