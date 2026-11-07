/**
 * 파일 내려받기 (가져오기 양식·내보내기·DB 파일 공통).
 * 글자(CSV·JSON)는 엑셀이 한글을 바로 읽도록 앞에 BOM을 붙인다. 바이너리(Uint8Array)는 그대로 내려받는다.
 */
export function downloadText(content, filename, mime = 'text/csv') {
  downloadBlob(new Blob(['﻿' + content], { type: `${mime};charset=utf-8;` }), filename);
}

export function downloadBytes(bytes, filename, mime = 'application/octet-stream') {
  downloadBlob(new Blob([bytes], { type: mime }), filename);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 바로 해제하면 일부 브라우저에서 내려받기가 취소된다
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
