/**
 * 금액 입력에서 사칙연산 수식을 안전하게 계산합니다.
 * 예) "10000+5000" → 15000, "34500/2" → 17250
 */
export function evaluateFormula(expr) {
  if (expr === null || expr === undefined || expr === '') return null;
  const str = String(expr).trim();
  if (str === '') return null;

  // 숫자만 있는 경우
  if (/^-?\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str));

  // 허용 문자: 숫자, +, -, *, /, (, ), 소수점, 공백
  const sanitized = str.replace(/[^0-9+\-*/().\s]/g, '').trim();
  if (!sanitized) return NaN;

  try {
    // eslint-disable-next-line no-new-func
    const result = new Function('"use strict"; return (' + sanitized + ')')();
    if (typeof result === 'number' && isFinite(result) && result >= 0) {
      return Math.round(result);
    }
    return NaN;
  } catch {
    return NaN;
  }
}

/**
 * 환율 입력값을 숫자로 변환합니다. 잘못된 값은 0을 반환합니다.
 * 예) "9.5" → 9.5, "1,320" → 1320, "" → 0
 */
export function parseRate(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return isFinite(n) && n > 0 ? n : 0;
}

/**
 * 현지 금액 입력값(수식 허용)을 숫자로 변환합니다. 잘못된 값은 null을 반환합니다.
 * evaluateFormula와 달리 소수점을 반올림하지 않습니다(예: 12.50 USD).
 */
export function parseForeignAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  const str = String(v).replace(/,/g, '').trim();
  if (str === '') return null;
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);

  const sanitized = str.replace(/[^0-9+\-*/().\s]/g, '').trim();
  if (!sanitized) return null;
  try {
    // eslint-disable-next-line no-new-func
    const result = new Function('"use strict"; return (' + sanitized + ')')();
    if (typeof result === 'number' && isFinite(result) && result >= 0) return result;
    return null;
  } catch {
    return null;
  }
}

/** 환율을 곱해 원화 금액(정수)으로 변환합니다. */
export function toKrw(foreignAmount, rate) {
  if (foreignAmount === null || !rate) return null;
  return Math.round(foreignAmount * rate);
}

export function formatAmount(amount) {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = Number(amount);
  if (isNaN(n)) return '';
  return n.toLocaleString('ko-KR');
}

/** 오늘 날짜를 YYYY-MM-DD 형식으로 반환 */
export function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
