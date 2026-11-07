/**
 * @vitest-environment node
 */
// 금액 수식 입력 규칙 (B-041)
import { evaluateFormula, evaluateExpression, parseForeignAmount, parseRate } from '../formulaEvaluator';

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
