/**
 * @vitest-environment node
 */
// 금액 수식 입력 규칙 (B-041)
import { evaluateFormula, evaluateExpression, parseForeignAmount, parseRate, parseOptionalAmount } from '../formulaEvaluator';

describe('비워 둘 수 있는 금액 칸 (B-065)', () => {
  test('빈 칸만 0이고, 수식은 계산한다', () => {
    expect(parseOptionalAmount('')).toBe(0);
    expect(parseOptionalAmount('  ')).toBe(0);
    expect(parseOptionalAmount(null)).toBe(0);
    expect(parseOptionalAmount('1,000+500')).toBe(1500);
    expect(parseOptionalAmount('0')).toBe(0);
  });

  test.each(['100만', '3만원', 'abc', '1000+'])('잘못된 값 %s은 0이 아니라 NaN', (input) => {
    expect(Number.isNaN(parseOptionalAmount(input))).toBe(true);
  });

  test('음수는 allowNegative일 때만 받는다', () => {
    expect(Number.isNaN(parseOptionalAmount('-5000'))).toBe(true);
    expect(Number.isNaN(parseOptionalAmount('1000-5000'))).toBe(true);
    expect(parseOptionalAmount('-5000', { allowNegative: true })).toBe(-5000);
    expect(parseOptionalAmount('1000-5000', { allowNegative: true })).toBe(-4000);
  });
});

describe('evaluateFormula', () => {
  test.each([
    ['10000+5000', 15000],
    ['1,000×3', 3000],
    ['9000÷3', 3000],
    ['4500원', 4500],
    ['(1000+500)*2', 3000],
  ])('%s → %d', (input, expected) => {
    expect(evaluateFormula(input)).toBe(expected);
  });

  test('빈 값은 null', () => {
    expect(evaluateFormula('')).toBeNull();
    expect(evaluateFormula('   ')).toBeNull();
  });

  test.each(['3만', '1e5', 'abc', '2**10', '1000+'])('허용되지 않는 입력 %s은 NaN (조용히 다른 값이 되지 않음)', (input) => {
    expect(Number.isNaN(evaluateFormula(input))).toBe(true);
  });
});

describe('외화·환율', () => {
  test('외화는 소수를 유지한다', () => {
    expect(parseForeignAmount('12.5+0.25')).toBeCloseTo(12.75);
  });

  test('환율은 쉼표가 있어도 읽는다', () => {
    expect(parseRate('1,320')).toBe(1320);
    expect(evaluateExpression('1320/100')).toBeCloseTo(13.2);
  });
});
