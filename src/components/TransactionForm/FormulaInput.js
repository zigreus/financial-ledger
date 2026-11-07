import React from 'react';
import AmountInput from '../common/AmountInput';

// 라벨이 붙은 금액 입력 — 수식·툴바·미리보기는 공통 AmountInput이 처리
export default function FormulaInput({ label, value, onChange, required, placeholder }) {
  return (
    <div className="form-group">
      <label>{label}{required && <span className="required">*</span>}</label>
      <AmountInput
        value={value}
        onChange={onChange}
        placeholder={placeholder || '금액 (예: 12000+3000)'}
      />
    </div>
  );
}
