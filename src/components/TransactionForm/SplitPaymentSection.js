import React from 'react';
import AmountInput from '../common/AmountInput';
import { formatAmount } from '../../services/formulaEvaluator';
import { fmtWallet } from './txFormUtils';

/**
 * 분할 결제 영역 — 켜기/끄기, 첫 번째 결제수단이 낸 금액, 나머지 결제수단, 몫 미리보기.
 * 상태와 계산은 useSplitPayment(sp)가 맡고, 여기는 그리기만 한다.
 */
export default function SplitPaymentSection({ sp, form, editingTx, paymentMethods, amountParsed, discountParsed, onToggle }) {
  const {
    split, splitAmount, splitMethod, setSplitMethod, splitSibling, splitCurrency,
    splitPrimary, primaryKrw, secondaryKrw, secondaryForeign, splitValid, secondDiscount, changeAmount,
  } = sp;

  return (
    <div className="split-box">
      <label className="split-toggle">
        <input
          type="checkbox"
          checked={split}
          onChange={e => onToggle(e.target.checked)}
        />
        <span>분할 결제 — 한 번의 구매를 두 결제수단으로 나눠 냄</span>
      </label>

      {!split && splitSibling && (
        <div className="split-unlink-warn">
          분할을 해제하고 저장하면 나머지 1건
          ({splitSibling.payment_method} {formatAmount(splitSibling.amount)}원)이 삭제되고
          이 거래 하나로 합쳐집니다.
        </div>
      )}

      {split && (
        <div className="split-fields">
          <div className="split-hint">
            거래 2건으로 {editingTx ? '저장' : '나뉘어 저장'}됩니다. 총액은 위 금액({formatAmount(amountParsed)}원) 기준입니다.
          </div>

          <div className="form-group">
            <label>
              {form.payment_method || '첫 번째 결제수단'}(으)로 낸 금액
              <span className="split-cur"> ({splitCurrency})</span>
            </label>
            <AmountInput
              decimal={splitCurrency !== 'KRW'}
              unit={splitCurrency === 'KRW' ? '원' : splitCurrency}
              value={splitAmount}
              onChange={changeAmount}
              placeholder={splitCurrency === 'KRW' ? '예: 30000' : `예: 10000 (${splitCurrency})`}
            />
            {primaryKrw > 0 && splitCurrency !== 'KRW' && (
              <span className="formula-preview">≈ {formatAmount(primaryKrw)}원</span>
            )}
          </div>

          <div className="form-group">
            <label>나머지 결제수단<span className="required">*</span></label>
            <select value={splitMethod} onChange={e => setSplitMethod(e.target.value)}>
              <option value="">선택</option>
              {paymentMethods.filter(m => m !== form.payment_method).map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
              {splitMethod && !paymentMethods.includes(splitMethod) && (
                <option value={splitMethod}>{splitMethod} (숨김)</option>
              )}
            </select>
          </div>

          {splitValid && splitMethod && (
            <div className="split-preview">
              <div>
                <span>{form.payment_method}</span>
                <b>{formatAmount(primaryKrw)}원
                  {splitCurrency !== 'KRW' && ` (${fmtWallet(splitPrimary, splitCurrency)} ${splitCurrency})`}
                  {discountParsed > 0 && ` · 할인 ${formatAmount(discountParsed)}원`}
                </b>
              </div>
              <div>
                <span>{splitMethod}</span>
                <b>{formatAmount(secondaryKrw)}원
                  {secondaryForeign !== null && ` (${fmtWallet(secondaryForeign, splitCurrency)} ${splitCurrency})`}
                  {secondDiscount > 0 && ` · 할인 ${formatAmount(secondDiscount)}원`}
                </b>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
