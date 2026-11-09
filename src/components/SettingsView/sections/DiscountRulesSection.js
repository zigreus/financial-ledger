import React, { useState, useMemo } from 'react';
import {
  getDiscountRules, addDiscountRule, deleteDiscountRule, getBudgetCategories, getSubCategories,
} from '../../../services/dbManager';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import { parseOptionalAmount, parseForeignAmount } from '../../../services/formulaEvaluator';
import AmountInput from '../../common/AmountInput';
import { IconTrash } from '../icons';

/** 결제수단 드릴다운 — 할인규칙 목록과 추가 폼 */
export default function DiscountRulesSection({ db, dataVersion, onChanged, setError, drilldownPayment }) {
  const live = useDbSnapshot(db, dataVersion);
  const [addingRuleType, setAddingRuleType] = useState('percent');
  const [addingRuleCategory, setAddingRuleCategory] = useState('');
  const [addingRuleSub, setAddingRuleSub] = useState('');
  const [addingRuleValue, setAddingRuleValue] = useState('');
  const [addingRuleMinAmount, setAddingRuleMinAmount] = useState('');
  const [addingRuleDetailKeyword, setAddingRuleDetailKeyword] = useState('');
  const [addingRuleNote, setAddingRuleNote] = useState('');

  const discountRules = useMemo(() => drilldownPayment ? getDiscountRules(live.db, drilldownPayment.name) : [], [live, drilldownPayment]);
  const ruleCategories = useMemo(() => getBudgetCategories(live.db), [live]);
  const ruleSubCategories = useMemo(() => addingRuleCategory ? getSubCategories(live.db, addingRuleCategory) : [], [live, addingRuleCategory]);

  const handleDeleteDiscountRule = (id) => {
    try {
      deleteDiscountRule(db, id);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleAddDiscountRule = () => {
    const val = parseForeignAmount(addingRuleValue);
    if (val === null || val <= 0) { setError('값을 올바르게 입력하세요.'); return; }
    const storedValue = addingRuleType === 'percent' ? val / 100 : val;
    // 빈 칸만 0원 — 잘못된 금액·음수를 조용히 0(조건 없음)으로 저장하지 않는다 (B-065)
    const minAmt = parseOptionalAmount(addingRuleMinAmount);
    if (isNaN(minAmt)) { setError('최소 금액을 올바르게 입력하세요.'); return; }
    try {
      addDiscountRule(db, {
        payment_method_name: drilldownPayment.name,
        budget_category: addingRuleCategory,
        sub_category: addingRuleSub,
        detail_keyword: addingRuleDetailKeyword,
        rule_type: addingRuleType,
        value: storedValue,
        min_amount: minAmt,
        note: addingRuleNote,
      });
      onChanged();
      setAddingRuleValue('');
      setAddingRuleMinAmount('');
      setAddingRuleDetailKeyword('');
      setAddingRuleNote('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  return (
    <>
      <div className="rule-section-info">
        규칙 우선순위: 카테고리+세부카테고리 &gt; 카테고리 &gt; 기본(전체)
      </div>

      {discountRules.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '16px', fontSize: 'calc(13px * var(--fs))' }}>등록된 할인규칙이 없습니다.</div>
      ) : (
        discountRules.map(rule => {
          const scopeParts = [];
          if (rule.budget_category) scopeParts.push(rule.budget_category);
          if (rule.sub_category) scopeParts.push(rule.sub_category);
          if (rule.detail_keyword) scopeParts.push(`"${rule.detail_keyword}"`);
          const scopeLabel = scopeParts.length > 0 ? scopeParts.join(' > ') : '기본 (전체)';
          let valueLabel;
          if (rule.rule_type === 'percent') valueLabel = `${Math.round(rule.value * 1000) / 10}%`;
          else if (rule.rule_type === 'fixed') valueLabel = `${rule.value.toLocaleString()}원 고정`;
          else valueLabel = `${rule.value.toLocaleString()}원 단위 잔액${rule.min_amount > 0 ? ` (최소 ${rule.min_amount.toLocaleString()}원)` : ''}`;
          return (
            <div key={rule.id} className="settings-item">
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="rule-scope">{scopeLabel}</span>
                <span className="rule-value-badge">{valueLabel}</span>
                {rule.note ? <span className="rule-note">{rule.note}</span> : null}
              </div>
              <button
                className="btn-icon btn-icon--danger"
                onClick={() => { if (window.confirm(`"${scopeLabel}: ${valueLabel}" 규칙을 삭제하시겠습니까?`)) handleDeleteDiscountRule(rule.id); }}
                title="삭제"
              >
                <IconTrash />
              </button>
            </div>
          );
        })
      )}

      {/* 규칙 추가 폼 */}
      <div className="rule-add-form">
        <div className="rule-add-title">규칙 추가</div>

        <div className="rule-form-row">
          <label className="rule-form-label">규칙 유형</label>
          <select value={addingRuleType} onChange={e => { setAddingRuleType(e.target.value); setAddingRuleValue(''); setAddingRuleMinAmount(''); }} className="rule-form-select">
            <option value="percent">비율 (%)</option>
            <option value="fixed">정액 (원)</option>
            <option value="remainder">잔액 포인트</option>
          </select>
        </div>

        <div className="rule-form-row">
          <label className="rule-form-label">카테고리</label>
          <select value={addingRuleCategory} onChange={e => { setAddingRuleCategory(e.target.value); setAddingRuleSub(''); }} className="rule-form-select">
            <option value="">전체 (기본)</option>
            {ruleCategories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {addingRuleCategory && (
          <div className="rule-form-row">
            <label className="rule-form-label">세부카테고리</label>
            <select value={addingRuleSub} onChange={e => setAddingRuleSub(e.target.value)} className="rule-form-select">
              <option value="">전체</option>
              {ruleSubCategories.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        <div className="rule-form-row">
          <label className="rule-form-label">세부내역 키워드</label>
          <input
            type="text"
            value={addingRuleDetailKeyword}
            onChange={e => setAddingRuleDetailKeyword(e.target.value)}
            placeholder="예: 스타벅스 (비워두면 전체)"
            className="rule-form-input"
          />
        </div>

        <div className="rule-form-row">
          <label className="rule-form-label">
            {addingRuleType === 'percent' ? '할인율 (%)' : addingRuleType === 'fixed' ? '할인 금액 (원)' : '단위 (원)'}
          </label>
          <AmountInput
            decimal={addingRuleType === 'percent'}
            unit={addingRuleType === 'percent' ? '%' : '원'}
            value={addingRuleValue}
            onChange={setAddingRuleValue}
            placeholder={addingRuleType === 'percent' ? '예: 1.2' : addingRuleType === 'fixed' ? '예: 500' : '예: 1000'}
            className="rule-form-input"
          />
        </div>

        {addingRuleType === 'remainder' && (
          <div className="rule-form-row">
            <label className="rule-form-label">최소 금액 (원)</label>
            <AmountInput
              value={addingRuleMinAmount}
              onChange={setAddingRuleMinAmount}
              placeholder="예: 5000"
              className="rule-form-input"
            />
          </div>
        )}

        <div className="rule-form-row">
          <label className="rule-form-label">메모 (선택)</label>
          <input
            type="text"
            value={addingRuleNote}
            onChange={e => setAddingRuleNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAddDiscountRule(); }}
            placeholder="예: 주유 1.2% 적립"
            className="rule-form-input"
          />
        </div>

        <button className="btn-primary" style={{ width: '100%', marginTop: '4px' }} onClick={handleAddDiscountRule}>+ 규칙 추가</button>
      </div>
    </>
  );
}
