/**
 * 금액 입력 공통 규칙: 앱의 모든 금액·환율 입력란은 사칙연산 수식을 받는다.
 * 입력은 components/common/AmountInput 으로, 계산은 이 파일의 함수로 한다.
 *   evaluateFormula    — 원화 등 정수 금액 (반올림)
 *   parseForeignAmount — 외화처럼 소수가 의미 있는 금액
 *   parseRate          — 환율 (0보다 큰 값만)
 */

function normalize(expr) {
  return String(expr)
    .replace(/,/g, '')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .trim();
}

/**
 * 사칙연산 수식을 계산해 소수 그대로 돌려준다. 다른 평가 함수의 기반.
 * 빈 값은 null, 계산할 수 없는 값은 NaN.
 * 단순 음수(-5000)는 항상 허용하고, 수식 결과가 음수인 경우는 allowNegative일 때만 허용한다.
 * 예) "10000+5000" → 15000, "1320/100" → 13.2, "1,000×3" → 3000
 */
export function evaluateExpression(expr, { allowNegative = false } = {}) {
  if (expr === null || expr === undefined) return null;
  const str = normalize(expr);
  if (str === '') return null;

  // 숫자만 있는 경우
  if (/^-?\d+(\.\d+)?$/.test(str)) return parseFloat(str);

  // 허용 문자: 숫자, +, -, *, /, (, ), 소수점, 공백
  const sanitized = str.replace(/[^0-9+\-*/().\s]/g, '').trim();
  if (!sanitized) return NaN;

  try {
    // eslint-disable-next-line no-new-func
    const result = new Function('"use strict"; return (' + sanitized + ')')();
    if (typeof result === 'number' && isFinite(result) && (allowNegative || result >= 0)) {
      return result;
    }
    return NaN;
  } catch {
    return NaN;
  }
}

/**
 * 정수 금액 — 수식을 계산해 반올림한다. 빈 값 null, 잘못된 값 NaN.
 * 예) "10000+5000" → 15000, "34500/2" → 17250
 */
export function evaluateFormula(expr, opts) {
  const n = evaluateExpression(expr, opts);
  return n === null || isNaN(n) ? n : Math.round(n);
}

/**
 * 외화 금액 — 수식 허용, 소수점 유지. 비었거나 잘못됐거나 음수면 null.
 * 예) "12.50" → 12.5, "3000+1500" → 4500
 */
export function parseForeignAmount(v) {
  const n = evaluateExpression(v);
  return n === null || isNaN(n) || n < 0 ? null : n;
}

/**
 * 환율 — 수식 허용. 0보다 큰 값만 유효하고 나머지는 0.
 * 예) "9.5" → 9.5, "1,320" → 1320, "950/100" → 9.5, "" → 0
 */
export function parseRate(v) {
  const n = parseForeignAmount(v);
  return n !== null && n > 0 ? n : 0;
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
