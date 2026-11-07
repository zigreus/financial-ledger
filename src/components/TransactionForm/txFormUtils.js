import { formatAmount, parseRate, parseForeignAmount } from '../../services/formulaEvaluator';

/**
 * 환율이 설정된 통화들의 현지 금액을 합산해 원화 금액을 계산합니다.
 * - 환율이 설정된 통화가 하나도 없으면 null (금액 필드를 건드리지 않음)
 * - 입력 중인 미완성 수식이 있어도 null (타이핑 중 금액이 0으로 튀지 않도록)
 * - 환율은 있으나 입력값이 모두 비어 있으면 '' (금액 필드를 비움)
 */
export function krwFromForeign(foreignAmounts, countries) {
  const rated = (countries || []).filter(c => parseRate(c.exchange_rate) > 0);
  if (!rated.length) return null;

  let total = 0;
  let hasInput = false;
  let hasInvalid = false;
  rated.forEach(c => {
    const raw = foreignAmounts[c.currency];
    if (raw === undefined || String(raw).trim() === '') return;
    hasInput = true;
    const parsed = parseForeignAmount(raw);
    if (parsed === null) hasInvalid = true;
    else total += parsed * parseRate(c.exchange_rate);
  });

  if (hasInvalid) return null;
  if (!hasInput) return '';
  return String(Math.round(total));
}

/** 지갑 잔액 표시 — 현지 통화는 소수점 2자리, 원화는 정수 */
export function fmtWallet(value, currency) {
  if (currency === 'KRW') return formatAmount(Math.round(value));
  return (Math.round(value * 100) / 100).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

/** 외화 금액은 소수 둘째 자리까지 — 0.1+0.2 같은 부동소수 찌꺼기가 저장되지 않게 */
export const round2 = (n) => Math.round(n * 100) / 100;

/** 거래에 저장된 foreign_amounts(JSON 문자열)를 객체로 — 비었거나 깨졌으면 {} */
export const parseFa = (raw) => {
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
};
