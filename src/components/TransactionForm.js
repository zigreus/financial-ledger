import React, { useState, useEffect, useRef } from 'react';
import { getPaymentMethods, getBudgetCategories, getSubCategories, getPaymentMethodDiscountRates, getTrips } from '../services/dbManager';
import { evaluateFormula, formatAmount, today } from '../services/formulaEvaluator';

const EMPTY_FORM = {
  payment_method: '',
  date: today(),
  budget_category: '',
  sub_category: '',
  detail: '',
  amount: '',
  discount_amount: '',
  trip_id: '',
  foreign_amounts: {},
};

const FORMULA_SYMBOLS = ['+', '-', '×', '÷', '(', ')'];

// 수식이 연산자/괄호로 끝나는 미완성 상태 여부
function isIncomplete(v) {
  return /[+\-*/(%]$/.test(v.trim());
}

function FormulaInput({ label, value, onChange, required, placeholder }) {
  const parsed = evaluateFormula(value);
  const isFormula = value && value.trim() && !/^-?\d+$/.test(value.trim());
  const isValid = parsed !== null && !isNaN(parsed);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);
  const touchHandledRef = useRef(false);

  const insertSymbol = (sym) => {
    const input = inputRef.current;
    if (!input) return;
    const actual = sym === '×' ? '*' : sym === '÷' ? '/' : sym;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    const next = value.slice(0, start) + actual + value.slice(end);
    // focus를 onChange 이전에 동기 호출 — Android에서 키보드가 닫히지 않도록
    input.focus();
    onChange(next);
    requestAnimationFrame(() => {
      input.setSelectionRange(start + 1, start + 1);
    });
  };

  const handleBlur = () => {
    // 심볼 버튼 탭 후 focus가 돌아올 시간을 한 프레임 기다림
    requestAnimationFrame(() => {
      if (document.activeElement !== inputRef.current) {
        setFocused(false);
      }
    });
  };

  return (
    <div className="form-group">
      <label>{label}{required && <span className="required">*</span>}</label>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        placeholder={placeholder || '금액 (예: 12000+3000)'}
        className={value && !isValid && !isIncomplete(value) ? 'input-error' : ''}
      />
      {focused && (
        <div className="formula-toolbar">
          {FORMULA_SYMBOLS.map(sym => (
            <button
              key={sym}
              type="button"
              className="formula-toolbar-btn"
              onMouseDown={e => e.preventDefault()}
              onTouchStart={e => { e.preventDefault(); touchHandledRef.current = true; insertSymbol(sym); }}
              onClick={() => { if (touchHandledRef.current) { touchHandledRef.current = false; return; } insertSymbol(sym); }}
            >
              {sym}
            </button>
          ))}
        </div>
      )}
      {isFormula && isValid && (
        <span className="formula-preview">= {formatAmount(parsed)}원</span>
      )}
      {value && !isValid && !isIncomplete(value) && (
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
  const [discountRates, setDiscountRates] = useState({});
  const [trips, setTrips] = useState([]);
  const skipAutoDiscountRef = React.useRef(false);
  const skipSubResetRef = React.useRef(false);

  useEffect(() => {
    setPaymentMethods(getPaymentMethods(db));
    setBudgetCategories(getBudgetCategories(db));
    setDiscountRates(getPaymentMethodDiscountRates(db));
    setTrips(getTrips(db));
  }, [db]);

  useEffect(() => {
    if (editingTx) {
      skipAutoDiscountRef.current = true;
      skipSubResetRef.current = true;
      let foreign_amounts = {};
      try { foreign_amounts = editingTx.foreign_amounts ? JSON.parse(editingTx.foreign_amounts) : {}; } catch (e) {}
      setForm({
        payment_method: editingTx.payment_method || '',
        date: editingTx.date || today(),
        budget_category: editingTx.budget_category || '',
        sub_category: editingTx.sub_category || '',
        detail: editingTx.detail || '',
        amount: editingTx.amount != null ? String(editingTx.amount) : '',
        discount_amount: editingTx.discount_amount ? String(editingTx.discount_amount) : '',
        trip_id: editingTx.trip_id ? String(editingTx.trip_id) : '',
        foreign_amounts,
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [editingTx]);

  useEffect(() => {
    const subs = getSubCategories(db, form.budget_category);
    setSubCategories(subs);
    if (skipSubResetRef.current) {
      skipSubResetRef.current = false;
      return;
    }
    setForm(prev => ({
      ...prev,
      sub_category: subs.includes(prev.sub_category) ? prev.sub_category : '',
    }));
  }, [db, form.budget_category]);

  // 결제수단별 자동 할인 계산
  useEffect(() => {
    if (skipAutoDiscountRef.current) {
      return;
    }
    const pm = form.payment_method;
    const amount = evaluateFormula(form.amount);
    const setDiscount = (v) => setForm(prev => ({ ...prev, discount_amount: v }));

    if (!pm || pm === '현금') return;

    // 신한카드: 5,000원 이상이면 1,000원 미만 금액 할인
    if (pm === '신한카드') {
      if (amount !== null && !isNaN(amount) && amount >= 5000) {
        const d = amount % 1000;
        setDiscount(d > 0 ? String(d) : '');
      } else {
        setDiscount('');
      }
      return;
    }

    // 하나카드: 특정 세부내역/카테고리 오버라이드 후 DB 설정 기본율 적용
    if (pm === '하나카드') {
      if (amount === null || isNaN(amount) || amount <= 0) { setDiscount(''); return; }
      const detail = (form.detail || '').toLowerCase();
      const sub = form.sub_category || '';
      let rate;
      if (detail.includes('스타벅스') || detail.includes('youtube')) {
        rate = 0.5;
      } else if (sub === '주유' || sub === '세차') {
        rate = 0.012;
      } else {
        rate = discountRates[pm] || 0.01; // DB 설정값, 없으면 1%
      }
      const d = Math.round(amount * rate);
      setDiscount(d > 0 ? String(d) : '');
      return;
    }

    // 기타 카드: DB 설정 할인율 적용
    const rate = discountRates[pm] || 0;
    if (rate <= 0 || amount === null || isNaN(amount) || amount <= 0) {
      setDiscount('');
      return;
    }
    const d = Math.round(amount * rate);
    setDiscount(d > 0 ? String(d) : '');
  }, [form.payment_method, form.amount, form.sub_category, form.detail, discountRates]);

  const set = (key, value) => {
    if (key === 'payment_method') {
      skipAutoDiscountRef.current = false;
    }
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const handleCategoryChange = (value) => {
    setForm(prev => ({
      ...prev,
      budget_category: value,
      sub_category: '',
      ...(value !== '여행' ? { trip_id: '', foreign_amounts: {} } : {}),
    }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const amount = evaluateFormula(form.amount);
    if (amount === null || isNaN(amount)) return;

    const discountAmount = form.discount_amount ? evaluateFormula(form.discount_amount) : 0;

    const foreign_amounts = {};
    if (form.trip_id) {
      Object.entries(form.foreign_amounts).forEach(([currency, val]) => {
        const num = parseFloat(val);
        if (!isNaN(num) && num > 0) foreign_amounts[currency] = num;
      });
    }

    onSave({
      payment_method: form.payment_method,
      date: form.date,
      budget_category: form.budget_category,
      sub_category: form.sub_category,
      detail: form.detail,
      amount,
      discount_amount: discountAmount || 0,
      trip_id: form.trip_id ? Number(form.trip_id) : null,
      foreign_amounts,
    });
  };

  const amountParsed = evaluateFormula(form.amount);
  const missingReasons = [
    !form.payment_method && '결제수단을 선택하세요',
    !form.date && '날짜를 입력하세요',
    !form.budget_category && '카테고리를 선택하세요',
    !form.sub_category && '세부카테고리를 선택하세요',
    (amountParsed === null || isNaN(amountParsed)) && '금액을 올바르게 입력하세요',
  ].filter(Boolean);
  const canSubmit = missingReasons.length === 0;

  return (
    <div className="modal-overlay">
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

          {/* 여행 정보 (카테고리가 여행일 때만 표시) */}
          {form.budget_category === '여행' && trips.length > 0 && (
            <div className="form-group">
              <label>여행 <span className="optional">(선택)</span></label>
              <select
                value={form.trip_id}
                onChange={e => setForm(prev => ({ ...prev, trip_id: e.target.value, foreign_amounts: {} }))}
              >
                <option value="">선택 안함</option>
                {trips.map(t => (
                  <option key={t.id} value={String(t.id)}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* 현지 금액 (여행 선택 시 나라별 화폐 입력) */}
          {form.budget_category === '여행' && form.trip_id && (() => {
            const selectedTrip = trips.find(t => String(t.id) === form.trip_id);
            if (!selectedTrip?.countries.length) return null;
            return (
              <>
                <div className="form-section-title">
                  현지 금액 <span className="optional">(선택)</span>
                </div>
                {selectedTrip.countries.map(c => (
                  <div key={c.id} className="form-group">
                    <label>{c.country} ({c.currency})</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={form.foreign_amounts[c.currency] || ''}
                      onChange={e => setForm(prev => ({
                        ...prev,
                        foreign_amounts: { ...prev.foreign_amounts, [c.currency]: e.target.value },
                      }))}
                      placeholder={`${c.currency} 금액`}
                    />
                  </div>
                ))}
              </>
            );
          })()}

          {/* 금액 */}
          <FormulaInput
            label="금액"
            value={form.amount}
            onChange={v => set('amount', v)}
            required
          />

          {/* 할인/수익 정보 */}
          <div className="form-section-title">
            {form.payment_method === '현금' ? '수익 정보' : '할인/혜택 정보'}
            <span className="optional">(선택)</span>
          </div>
          <div className="form-row">
            <FormulaInput
              label={form.payment_method === '현금' ? '수익금액' : '할인금액'}
              value={form.discount_amount}
              onChange={v => set('discount_amount', v)}
              placeholder="0"
            />
          </div>

          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onCancel}>취소</button>
            <div className="submit-tooltip-wrapper" onClick={e => { if (!canSubmit) e.currentTarget.classList.toggle('tooltip-visible'); }}>
              <button type="submit" className="btn-primary" disabled={!canSubmit}>
                {editingTx ? '수정' : '추가'}
              </button>
              {!canSubmit && (
                <div className="submit-tooltip">
                  {missingReasons.map((r, i) => <span key={i}>• {r}{'\n'}</span>)}
                </div>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export default TransactionForm;
