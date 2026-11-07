import { useCallback, useMemo, useState } from 'react';
import { getDiscountRules, evaluateDiscountRule } from '../../services/dbManager';
import { parseRate, parseForeignAmount } from '../../services/formulaEvaluator';
import { round2, parseFa } from './txFormUtils';

/** 분할 결제 칸의 빈 상태 */
export const EMPTY_SPLIT = {
  split: false,
  splitAmount: '',
  // 나눠 낸 금액을 어느 통화로 입력했는지 — 통화가 바뀌면 그 숫자를 다른 통화로 해석하지 않는다
  splitAmountCur: 'KRW',
  splitMethod: '',
  // 수정 중인 분할 거래의 저장된 외화 환율 { currency, rate } — 일정 환율이 바뀌어도 원래 몫을 유지
  splitBasis: null,
  splitSibling: null,
};

/**
 * 수정할 거래(와 분할 짝)에서 폼에 채울 금액·현지 금액과 분할 칸 상태를 만든다.
 * 분할된 거래를 열면 묶음 전체를 합쳐 총액으로 보여주고 분할 칸을 채워 둔다.
 */
export function splitFromEditingTx(editingTx, sibling) {
  const foreign_amounts = parseFa(editingTx.foreign_amounts);
  const amount = editingTx.amount != null ? String(editingTx.amount) : '';
  if (!sibling) return { amount, foreign_amounts, splitState: EMPTY_SPLIT };

  const totals = { ...foreign_amounts };
  Object.entries(parseFa(sibling.foreign_amounts)).forEach(([cur, val]) => {
    totals[cur] = round2((Number(totals[cur]) || 0) + Number(val));
  });

  // 분할 통화·환율은 저장된 값에서 정한다 — 보이는 일정 목록이나 현재 일정 환율에서 다시 구하면
  // 일정을 숨기거나 지웠을 때 ¥3000이 3,000원으로 읽히고, 환율이 바뀌면 원화 몫이 달라진다 (B-033, B-060)
  const ownEntry = Object.entries(parseFa(editingTx.foreign_amounts)).find(([, v]) => Number(v) > 0);
  const totalCurs = Object.keys(totals).filter(cur => Number(totals[cur]) > 0);
  let ownSplit = '';
  let ownSplitCur = 'KRW';
  let basis = null;
  if (ownEntry && totalCurs.length === 1 && totalCurs[0] === ownEntry[0]) {
    ownSplit = String(ownEntry[1]);
    ownSplitCur = ownEntry[0];
    if (editingTx.amount > 0) basis = { currency: ownEntry[0], rate: editingTx.amount / Number(ownEntry[1]) };
  } else if (totalCurs.length === 0) {
    ownSplit = editingTx.amount != null ? String(editingTx.amount) : '';
  }
  // 그 밖(저장된 외화가 엇갈림)은 나눠 낸 금액을 다시 입력받는다

  return {
    amount: String((editingTx.amount || 0) + (sibling.amount || 0)),
    foreign_amounts: totals,
    splitState: {
      split: true,
      splitAmount: ownSplit,
      splitAmountCur: ownSplitCur,
      splitMethod: sibling.payment_method || '',
      splitBasis: basis,
      splitSibling: sibling,
    },
  };
}

/**
 * 분할 결제 — 한 번의 구매를 두 결제수단으로 나눠 2건으로 기록한다.
 * 분할 칸 상태와, 거기서 나오는 몫(원화·외화)·검사 결과·나머지 몫 할인을 계산한다.
 */
export function useSplitPayment({ form, amountParsed, activeCurrencies, selectedEvent, editingTx, dbRef }) {
  const [split, setSplit] = useState(false);
  const [splitAmount, setSplitAmount] = useState('');
  const [splitMethod, setSplitMethod] = useState('');
  const [splitSibling, setSplitSibling] = useState(null);
  const [splitAmountCur, setSplitAmountCur] = useState('KRW');
  const [splitBasis, setSplitBasis] = useState(null);

  const load = useCallback((s) => {
    setSplit(s.split);
    setSplitAmount(s.splitAmount);
    setSplitAmountCur(s.splitAmountCur);
    setSplitMethod(s.splitMethod);
    setSplitBasis(s.splitBasis);
    setSplitSibling(s.splitSibling);
  }, []);
  const reset = useCallback(() => load(EMPTY_SPLIT), [load]);
  const clearBasis = useCallback(() => setSplitBasis(null), []);

  // 한 통화에만 들어있으면 그 통화로 나누고, 없으면 원화로 나눈다.
  // 두 통화 이상이면 몫을 정할 수 없으므로 분할을 막는다 — 외화가 버려지지 않게 (B-034)
  const multiCurrency = activeCurrencies.length > 1;
  const splitCurrency = activeCurrencies.length === 1 ? activeCurrencies[0] : 'KRW';
  const splitTotalForeign = splitCurrency !== 'KRW'
    ? parseForeignAmount(form.foreign_amounts[splitCurrency]) : null;

  // 환율: 수정 중인 분할 거래는 저장된 환율 → 일정 환율 → 이번 거래가 함축하는 환율(총 원화 ÷ 총 현지금액)
  const basisRate = splitBasis && splitBasis.currency === splitCurrency ? splitBasis.rate : 0;
  const eventRate = parseRate((selectedEvent?.countries || []).find(c => c.currency === splitCurrency)?.exchange_rate);
  const impliedRate = splitTotalForeign > 0 && amountParsed > 0
    ? amountParsed / splitTotalForeign : 0;
  const effectiveSplitRate = basisRate || eventRate || impliedRate;

  // 나눠 낸 금액은 입력할 때의 통화로만 해석한다 — 통화가 바뀌었으면 다시 입력받는다
  const splitCurrencyChanged = split && splitAmount.trim() !== '' && splitAmountCur !== splitCurrency;
  const splitPrimary = splitCurrencyChanged ? null : parseForeignAmount(splitAmount);
  const primaryKrw = splitPrimary === null ? null
    : splitCurrency === 'KRW' ? Math.round(splitPrimary) : Math.round(splitPrimary * effectiveSplitRate);
  const secondaryKrw = primaryKrw === null || amountParsed === null || isNaN(amountParsed)
    ? null : amountParsed - primaryKrw;
  const secondaryForeign = splitTotalForeign !== null && splitPrimary !== null
    ? Number((splitTotalForeign - splitPrimary).toFixed(2)) : null;

  const splitAmountsOk = splitPrimary !== null && splitPrimary > 0 &&
    primaryKrw > 0 && secondaryKrw > 0 &&
    (secondaryForeign === null || secondaryForeign > 0);
  const splitValid = !split || (!multiCurrency && splitAmountsOk && !!splitMethod);
  const splitProblem = !split ? null
    : multiCurrency ? '현지 금액이 두 통화 이상이면 분할할 수 없습니다'
    : splitCurrencyChanged ? `분할 통화가 ${splitCurrency}(으)로 바뀌었습니다 — 나눠 낸 금액을 다시 입력하세요`
    : splitPrimary === null ? '나눠 낸 금액을 입력하세요'
    : !splitAmountsOk ? '분할 금액이 총액보다 작아야 합니다'
    : null;

  // 나머지 몫의 할인 — 그 결제수단·그 금액 기준으로 계산한다.
  // 수정 중인 짝의 결제수단·금액·분류가 그대로면 저장된 할인을 유지한다 (직접 고친 값 보존)
  const ruleSecondDiscount = useMemo(() => {
    if (!split || !splitMethod || splitMethod === '현금' || !(secondaryKrw > 0)) return 0;
    return evaluateDiscountRule(getDiscountRules(dbRef.current, splitMethod),
      form.budget_category, form.sub_category, secondaryKrw, form.detail) || 0;
  }, [split, splitMethod, secondaryKrw, form.budget_category, form.sub_category, form.detail, dbRef]);
  const siblingUnchanged = !!splitSibling && splitMethod === splitSibling.payment_method
    && secondaryKrw === splitSibling.amount
    && form.budget_category === (editingTx?.budget_category || '')
    && form.sub_category === (editingTx?.sub_category || '')
    && form.detail === (editingTx?.detail || '');
  const secondDiscount = siblingUnchanged ? (splitSibling.discount_amount || 0) : ruleSecondDiscount;

  return {
    split,
    splitAmount,
    splitMethod,
    setSplitMethod,
    splitSibling,
    splitCurrency,
    splitPrimary,
    primaryKrw,
    secondaryKrw,
    secondaryForeign,
    splitValid,
    splitProblem,
    secondDiscount,
    load,
    reset,
    clearBasis,
    // 분할 켜기/끄기 — 나눠 낸 금액은 비운다
    toggle: (checked) => { setSplit(checked); setSplitAmount(''); },
    // 나눠 낸 금액 입력 — 지금 분할 통화로 입력한 것으로 기록한다
    changeAmount: (v) => { setSplitAmount(v); setSplitAmountCur(splitCurrency); },
  };
}
