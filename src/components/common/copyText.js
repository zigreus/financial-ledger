/**
 * 글을 클립보드에 넣는다 — 클립보드 API가 막혀 있으면 예전 방식(선택해 복사)으로. 됐으면 true.
 * 문제 알리기(I-038)·참여 링크 복사(M-2)가 함께 쓴다.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 아래 방식으로 */ }
  const area = document.createElement('textarea');
  try {
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    return !!document.execCommand?.('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
