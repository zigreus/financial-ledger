import { useEffect, useMemo, useRef } from 'react';
import { getDiscountRules, evaluateDiscountRule } from '../../services/dbManager';
import { evaluateFormula } from '../../services/formulaEvaluator';

/**
 * 자동할인 제어 — 폼 여러 곳(수정 불러오기, 결제수단·현지 금액 변경, 분할 토글, 연속 입력 초기화 …)에서 쓴다.
 * 자동 계산 effect(useAutoDiscount)보다 먼저 만들어 두어야 하므로 따로 둔다.
 *  keepStored  : 자동 계산을 멈춘다 — 수정 화면에서 저장된 할인을 유지
 *  recalc      : 다음 입력 변화부터 다시 자동 계산
 *  markEdited  : 사용자가 할인/수익 칸을 직접 고쳤다 — 현금으로 바꿔도 비우지 않는다
 *  resetEdited : 직접 고친 표시를 지운다
 */
export function useDiscountControl() {
  const skipRef = useRef(false);
  const touchedRef = useRef(false);
  return useMemo(() => ({
    skipRef,
    touchedRef,
    keepStored: () => { skipRef.current = true; },
    recalc: () => { skipRef.current = false; },
    markEdited: () => { touchedRef.current = true; },
    resetEdited: () => { touchedRef.current = false; },
  }), []);
}

/**
 * 결제수단별 자동 할인 계산 (DB 규칙 기반).
 * 분할 결제면 첫 번째 결제수단이 실제로 낸 몫(primaryKrw)에만 할인을 계산한다 (B-030)
 */
export function useAutoDiscount({ control, form, setForm, split, primaryKrw, dbRef }) {
  useEffect(() => {
    if (control.skipRef.current) return;
    const pm = form.payment_method;
    if (!pm || pm === '현금') {
      // 카드 기준으로 자동 계산해 둔 할인은 현금 '수익'이 아니다 — 직접 입력한 값이 아니면 비운다 (B-032)
      if (!control.touchedRef.current) {
        setForm(prev => (prev.discount_amount ? { ...prev, discount_amount: '' } : prev));
      }
      return;
    }

    control.touchedRef.current = false;
    const base = split ? primaryKrw : evaluateFormula(form.amount);
    if (base === null || isNaN(base) || base <= 0) {
      setForm(prev => ({ ...prev, discount_amount: '' }));
      return;
    }

    const rules = getDiscountRules(dbRef.current, pm);
    const d = evaluateDiscountRule(rules, form.budget_category, form.sub_category, base, form.detail);
    setForm(prev => ({ ...prev, discount_amount: d > 0 ? String(d) : '' }));
  }, [form.payment_method, form.amount, form.budget_category, form.sub_category, form.detail, split, primaryKrw,
    control, setForm, dbRef]);
}
