import React, { useState, useMemo } from 'react';
import {
  getAllPaymentMethods, getBudgetCategories, getSubCategories,
  getDiscountRules, evaluateDiscountRule,
  getRecurringTransactions, addRecurringTransaction, updateRecurringTransaction,
  deleteRecurringTransaction, getRegistrationLog,
} from '../../../services/dbManager';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import { evaluateFormula, parseOptionalAmount } from '../../../services/formulaEvaluator';
import AmountInput from '../../common/AmountInput';
import { IconEdit, IconTrash } from '../icons';

const emptyRecurringForm = {
  payment_method: '', budget_category: '', sub_category: '',
  detail: '', amount: '', frequency: 'monthly',
  day_of_month: '1', month_of_year: '1', note: '',
  discount_amount: '', discount_note: '',
};

/** 지출계획 › 정기지출 — 목록과 추가/수정 폼 (결제수단 할인규칙으로 할인 자동 계산) */
export default function RecurringSection({ db, dataVersion, onChanged, setError }) {
  const live = useDbSnapshot(db, dataVersion);
  const [showRecurringForm, setShowRecurringForm] = useState(false);
  const [editingRecurringId, setEditingRecurringId] = useState(null);
  const [recurringForm, setRecurringForm] = useState(emptyRecurringForm);
  const skipAutoDiscountRef = React.useRef(false);

  const paymentMethods = useMemo(() => getAllPaymentMethods(live.db), [live]);
  const ruleCategories = useMemo(() => getBudgetCategories(live.db), [live]);
  const recurringList = useMemo(() => getRecurringTransactions(live.db), [live]);
  const registrationLog = useMemo(() => getRegistrationLog(live.db), [live]);
  const recurringFormSubCategories = useMemo(
    () => recurringForm.budget_category ? getSubCategories(live.db, recurringForm.budget_category) : [],
    [live, recurringForm.budget_category]
  );

  // 정기지출 폼 - 자동 할인 계산 (결제수단/금액/카테고리/세부내역 변경 시)
  React.useEffect(() => {
    if (!showRecurringForm) return;
    if (skipAutoDiscountRef.current) return;
    const { payment_method, budget_category, sub_category, amount, detail } = recurringForm;
    if (!payment_method || payment_method === '현금') {
      setRecurringForm(f => ({ ...f, discount_amount: '' }));
      return;
    }
    const amt = evaluateFormula(amount);
    if (!amt || amt <= 0) {
      setRecurringForm(f => ({ ...f, discount_amount: '' }));
      return;
    }
    const rules = getDiscountRules(db, payment_method);
    const d = evaluateDiscountRule(rules, budget_category, sub_category, amt, detail);
    setRecurringForm(f => ({ ...f, discount_amount: d > 0 ? String(d) : '' }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRecurringForm, recurringForm.payment_method, recurringForm.amount, recurringForm.budget_category, recurringForm.sub_category, recurringForm.detail]);

  const openRecurringForm = (item = null) => {
    skipAutoDiscountRef.current = false;
    if (item) {
      setEditingRecurringId(item.id);
      // 기존 항목에 할인값이 있으면 수동 모드 유지
      if (item.discount_amount > 0) skipAutoDiscountRef.current = true;
      setRecurringForm({
        payment_method: item.payment_method,
        budget_category: item.budget_category,
        sub_category: item.sub_category || '',
        detail: item.detail || '',
        amount: String(item.amount),
        frequency: item.frequency,
        day_of_month: String(item.day_of_month),
        month_of_year: String(item.month_of_year || 1),
        note: item.note || '',
        discount_amount: item.discount_amount > 0 ? String(item.discount_amount) : '',
        discount_note: item.discount_note || '',
      });
    } else {
      setEditingRecurringId(null);
      setRecurringForm(emptyRecurringForm);
    }
    setShowRecurringForm(true);
    setError('');
  };

  const handleSaveRecurring = () => {
    if (!recurringForm.payment_method) { setError('결제수단을 선택하세요.'); return; }
    if (!recurringForm.budget_category) { setError('카테고리를 선택하세요.'); return; }
    const amount = evaluateFormula(recurringForm.amount);
    if (amount === null || isNaN(amount) || amount <= 0) { setError('금액을 올바르게 입력하세요.'); return; }
    const dayOfMonth = parseInt(recurringForm.day_of_month, 10);
    if (isNaN(dayOfMonth) || dayOfMonth < 0 || dayOfMonth > 31) { setError('납부일은 0(말일)~31 사이로 입력하세요.'); return; }
    // 할인은 빈 칸만 0원 — 잘못된 금액·음수는 막는다 (B-065)
    const discountAmount = parseOptionalAmount(recurringForm.discount_amount);
    if (isNaN(discountAmount)) { setError('할인을 올바르게 입력하세요.'); return; }
    const data = {
      ...recurringForm,
      amount,
      day_of_month: dayOfMonth,
      month_of_year: recurringForm.frequency === 'annual' ? parseInt(recurringForm.month_of_year, 10) : null,
      discount_amount: discountAmount,
    };
    try {
      if (editingRecurringId !== null) {
        updateRecurringTransaction(db, editingRecurringId, data);
      } else {
        addRecurringTransaction(db, data);
      }
      onChanged();
      setShowRecurringForm(false);
      setEditingRecurringId(null);
      setRecurringForm(emptyRecurringForm);
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleDeleteRecurring = (id) => {
    if (!window.confirm('정기지출을 삭제하시겠습니까?\n(자동등록된 거래내역은 삭제되지 않습니다)')) return;
    try {
      deleteRecurringTransaction(db, id);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  return (
    <div>
      {!showRecurringForm ? (
        <>
          <button className="btn-primary" style={{ width: '100%', marginBottom: '16px' }} onClick={() => openRecurringForm()}>
            + 정기지출 추가
          </button>

          {recurringList.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px', fontSize: '13px' }}>
              등록된 정기지출이 없습니다.
            </div>
          ) : (
            <>
              {['monthly', 'annual'].map(freq => {
                const items = recurringList.filter(r => r.frequency === freq);
                if (items.length === 0) return null;
                return (
                  <div key={freq} style={{ marginBottom: '16px' }}>
                    <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      {freq === 'monthly' ? '📋 월별 반복' : '📅 연간 반복'}
                    </div>
                    {items.map(r => {
                      const logMonths = registrationLog[r.id];
                      const lastRegistered = logMonths ? [...logMonths].sort().reverse()[0] : null;
                      const dayLabel = r.day_of_month === 0 ? '말일' : `${r.day_of_month}일`;
                      const scheduleLabel = freq === 'annual'
                        ? `${r.month_of_year}월 ${dayLabel}`
                        : dayLabel;
                      return (
                        <div key={r.id} className="settings-item">
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                              <span style={{ fontWeight: '600', fontSize: '14px', flexShrink: 0, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.detail || r.sub_category || r.budget_category}</span>
                              <span style={{ fontSize: '12px', color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.budget_category}{r.sub_category ? ` / ${r.sub_category}` : ''}</span>
                              {lastRegistered && <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>최근 {lastRegistered}</span>}
                            </div>
                            <div style={{ fontSize: '13px', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                              <span style={{ color: 'var(--primary)', fontWeight: '600', flexShrink: 0 }}>{r.amount.toLocaleString()}원</span>
                              {r.discount_amount > 0 && (
                                <span style={{ fontSize: '12px', color: '#16A34A', flexShrink: 0 }}>-{r.discount_amount.toLocaleString()}원 할인</span>
                              )}
                              <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.payment_method} · {scheduleLabel}</span>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                            <button className="btn-icon" onClick={() => openRecurringForm(r)} title="수정"><IconEdit /></button>
                            <button className="btn-icon btn-icon--danger" onClick={() => handleDeleteRecurring(r.id)} title="삭제"><IconTrash /></button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </>
          )}
        </>
      ) : (
        /* 추가/편집 폼 */
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ fontWeight: '600', fontSize: '15px', marginBottom: '4px' }}>
            {editingRecurringId !== null ? '정기지출 수정' : '정기지출 추가'}
          </div>

          <div className="rule-form-row">
            <label className="rule-form-label">결제수단</label>
            <select
              className="rule-form-select"
              value={recurringForm.payment_method}
              onChange={e => setRecurringForm(f => ({ ...f, payment_method: e.target.value }))}
            >
              <option value="">선택</option>
              {paymentMethods.filter(p => !p.is_hidden).map(p => (
                <option key={p.id} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="rule-form-row">
            <label className="rule-form-label">카테고리</label>
            <select
              className="rule-form-select"
              value={recurringForm.budget_category}
              onChange={e => setRecurringForm(f => ({ ...f, budget_category: e.target.value, sub_category: '' }))}
            >
              <option value="">선택</option>
              {ruleCategories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {recurringForm.budget_category && recurringFormSubCategories.length > 0 && (
            <div className="rule-form-row">
              <label className="rule-form-label">세부카테고리</label>
              <select
                className="rule-form-select"
                value={recurringForm.sub_category}
                onChange={e => setRecurringForm(f => ({ ...f, sub_category: e.target.value }))}
              >
                <option value="">없음</option>
                {recurringFormSubCategories.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          )}

          <div className="rule-form-row">
            <label className="rule-form-label">내용</label>
            <input
              className="rule-form-input"
              type="text"
              value={recurringForm.detail}
              onChange={e => setRecurringForm(f => ({ ...f, detail: e.target.value }))}
              placeholder="예: 넷플릭스 월정액"
            />
          </div>

          <div className="rule-form-row">
            <label className="rule-form-label">금액 (원)</label>
            <AmountInput
              className="rule-form-input"
              value={recurringForm.amount}
              onChange={v => {
                skipAutoDiscountRef.current = false;
                setRecurringForm(f => ({ ...f, amount: v }));
              }}
              placeholder="예: 13500"
            />
          </div>

          <div className="rule-form-row">
            <label className="rule-form-label">할인 (원)</label>
            <div style={{ display: 'flex', gap: '6px', flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
              <AmountInput
                className="rule-form-input"
                containerStyle={{ flex: '1 1 80px' }}
                value={recurringForm.discount_amount}
                onChange={v => {
                  skipAutoDiscountRef.current = true;
                  setRecurringForm(f => ({ ...f, discount_amount: v }));
                }}
                placeholder="자동계산 (0=없음)"
              />
              <input
                className="rule-form-input"
                type="text"
                style={{ flex: '1 1 80px' }}
                value={recurringForm.discount_note}
                onChange={e => setRecurringForm(f => ({ ...f, discount_note: e.target.value }))}
                placeholder="할인 메모 (선택)"
              />
              {skipAutoDiscountRef.current && (
                <button
                  className="month-goal-btn"
                  title="자동계산으로 되돌리기"
                  onClick={() => {
                    skipAutoDiscountRef.current = false;
                    setRecurringForm(f => ({ ...f, discount_amount: '', discount_note: '' }));
                  }}
                >↺</button>
              )}
            </div>
          </div>

          <div className="rule-form-row">
            <label className="rule-form-label">반복주기</label>
            <div style={{ display: 'flex', gap: '12px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '14px' }}>
                <input type="radio" name="freq" value="monthly" checked={recurringForm.frequency === 'monthly'} onChange={() => setRecurringForm(f => ({ ...f, frequency: 'monthly' }))} />
                월별
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '14px' }}>
                <input type="radio" name="freq" value="annual" checked={recurringForm.frequency === 'annual'} onChange={() => setRecurringForm(f => ({ ...f, frequency: 'annual' }))} />
                연간
              </label>
            </div>
          </div>

          {recurringForm.frequency === 'annual' && (
            <div className="rule-form-row">
              <label className="rule-form-label">납부 월</label>
              <select
                className="rule-form-select"
                value={recurringForm.month_of_year}
                onChange={e => setRecurringForm(f => ({ ...f, month_of_year: e.target.value }))}
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                  <option key={m} value={m}>{m}월</option>
                ))}
              </select>
            </div>
          )}

          <div className="rule-form-row">
            <label className="rule-form-label">납부일</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                className="rule-form-input"
                type="number"
                min="0"
                max="31"
                value={recurringForm.day_of_month}
                onChange={e => setRecurringForm(f => ({ ...f, day_of_month: e.target.value }))}
                placeholder="1~31, 0=말일"
                style={{ width: '90px' }}
              />
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>일 (0 = 말일)</span>
            </div>
          </div>

          <div className="rule-form-row">
            <label className="rule-form-label">메모 (선택)</label>
            <input
              className="rule-form-input"
              type="text"
              value={recurringForm.note}
              onChange={e => setRecurringForm(f => ({ ...f, note: e.target.value }))}
              placeholder="예: 가족 구독"
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <button className="btn-primary" style={{ flex: 1 }} onClick={handleSaveRecurring}>
              {editingRecurringId !== null ? '수정 저장' : '추가'}
            </button>
            <button
              className="btn-secondary"
              style={{ flex: 1 }}
              onClick={() => { setShowRecurringForm(false); setEditingRecurringId(null); setError(''); }}
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
