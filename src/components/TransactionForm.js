import React, { useState, useEffect } from 'react';
import { getPaymentMethods, getBudgetCategories, getSubCategories } from '../services/dbManager';
import { evaluateFormula, formatAmount, today } from '../services/formulaEvaluator';

const EMPTY_FORM = {
  payment_method: '',
  date: today(),
  budget_category: '',
  sub_category: '',
  detail: '',
  amount: '',
  discount_amount: '',
  discount_note: '',
};

function FormulaInput({ label, value, onChange, required, placeholder }) {
  const parsed = evaluateFormula(value);
  const isFormula = value && value.trim() && !/^-?\d+$/.test(value.trim());
  const isValid = parsed !== null && !isNaN(parsed);

  return (
    <div className="form-group">
      <label>{label}{required && <span className="required">*</span>}</label>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || '금액 (예: 12000+3000)'}
        className={value && !isValid ? 'input-error' : ''}
      />
      {isFormula && isValid && (
        <span className="formula-preview">= {formatAmount(parsed)}원</span>
      )}
      {value && !isValid && (
        <span className="formula-error">올바른 숫자 또는 수식을 입력하세요</span>
      )}
    </div>
  );
}

function TransactionForm({ db, editingTx, onSave, onCancel }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [budgetCategories, setBudgetCategories] = useState([]);
  const [subCategories, setSubCategories] = useState([]);

  useEffect(() => {
    setPaymentMethods(getPaymentMethods(db));
    setBudgetCategories(getBudgetCategories(db));
  }, [db]);

  useEffect(() => {
    if (editingTx) {
      setForm({
        payment_method: editingTx.payment_method || '',
        date: editingTx.date || today(),
        budget_category: editingTx.budget_category || '',
        sub_category: editingTx.sub_category || '',
        detail: editingTx.detail || '',
        amount: String(editingTx.amount || ''),
        discount_amount: editingTx.discount_amount ? String(editingTx.discount_amount) : '',
        discount_note: editingTx.discount_note || '',
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [editingTx]);

  useEffect(() => {
    setSubCategories(getSubCategories(db, form.budget_category));
  }, [db, form.budget_category]);

  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  const handleCategoryChange = (value) => {
    setForm(prev => ({ ...prev, budget_category: value, sub_category: '' }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const amount = evaluateFormula(form.amount);
    if (!amount || isNaN(amount)) return;

    const discountAmount = form.discount_amount ? evaluateFormula(form.discount_amount) : 0;

    onSave({
      payment_method: form.payment_method,
      date: form.date,
      budget_category: form.budget_category,
      sub_category: form.sub_category,
      detail: form.detail,
      amount,
      discount_amount: discountAmount || 0,
      discount_note: form.discount_note,
    });
  };

  const amountParsed = evaluateFormula(form.amount);
  const canSubmit =
    form.payment_method &&
    form.date &&
    form.budget_category &&
    form.sub_category &&
    amountParsed !== null &&
    !isNaN(amountParsed) &&
    amountParsed > 0;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{editingTx ? '거래 수정' : '거래 추가'}</h2>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>

        <form onSubmit={handleSubmit} className="tx-form">
          {/* 날짜 */}
          <div className="form-group">
            <label>날짜<span className="required">*</span></label>
            <input
              type="date"
              value={form.date}
              onChange={e => set('date', e.target.value)}
              required
            />
          </div>

          {/* 결제수단 */}
          <div className="form-group">
            <label>결제수단<span className="required">*</span></label>
            <select
              value={form.payment_method}
              onChange={e => set('payment_method', e.target.value)}
              required
            >
              <option value="">선택</option>
              {paymentMethods.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {/* 카테고리 */}
          <div className="form-row">
            <div className="form-group">
              <label>카테고리<span className="required">*</span></label>
              <select
                value={form.budget_category}
                onChange={e => handleCategoryChange(e.target.value)}
                required
              >
                <option value="">선택</option>
                {budgetCategories.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>세부카테고리<span className="required">*</span></label>
              <select
                value={form.sub_category}
                onChange={e => set('sub_category', e.target.value)}
                required
                disabled={!form.budget_category}
              >
                <option value="">선택</option>
                {subCategories.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          {/* 세부내역 */}
          <div className="form-group">
            <label>세부내역 <span className="optional">(선택)</span></label>
            <input
              type="text"
              value={form.detail}
              onChange={e => set('detail', e.target.value)}
              placeholder="예: 김치찌개, 스타벅스 아메리카노"
            />
          </div>

          {/* 금액 */}
          <FormulaInput
            label="금액"
            value={form.amount}
            onChange={v => set('amount', v)}
            required
          />

          {/* 할인 정보 */}
          <div className="form-section-title">할인/혜택 정보 <span className="optional">(선택)</span></div>
          <div className="form-row">
            <FormulaInput
              label="할인금액"
              value={form.discount_amount}
              onChange={v => set('discount_amount', v)}
              placeholder="0"
            />
            <div className="form-group">
              <label>할인내역</label>
              <input
                type="text"
                value={form.discount_note}
                onChange={e => set('discount_note', e.target.value)}
                placeholder="예: 스프링클러 커버 할인"
              />
            </div>
          </div>

          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onCancel}>취소</button>
            <button type="submit" className="btn-primary" disabled={!canSubmit}>
              {editingTx ? '수정' : '추가'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default TransactionForm;
