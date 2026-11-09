import React, { useState } from 'react';
import AmountInput from '../common/AmountInput';
import { MEMBER_NONE } from '../../services/dbManager';
import { PERIODS, SAVED_NAME_MAX } from '../../services/txFilters';

/**
 * 거래내역 필터 패널 (ROADMAP C-7, I-021) — 기간, 결제수단·카테고리 여러 개, 금액 범위, 누가, 저장한 필터.
 * 상태는 TransactionList가 들고 있고(filters), 계산·검사는 services/txFilters가 한다. errors: { period, amount }
 * canSave: 저장할 조건이 있는지(이슈 보기만 켠 것은 저장할 것이 없다). resultText·onShowResults: 패널 아래에 붙은 결과 줄
 */
export default function FilterPanel({
  filters, onChange, errors = {}, months = [], paymentMethods = [], budgetCategories = [], members = [],
  saved = [], onSave, onApplySaved, onDeleteSaved, savedNote, hasFilters, canSave, onClear, resultText, onShowResults,
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saveError, setSaveError] = useState('');
  const [showHidden, setShowHidden] = useState(false); // 숨긴 결제수단·카테고리도 보일지

  const set = (key, value) => onChange({ ...filters, [key]: value });
  const toggle = (key, value) => {
    const list = filters[key] || [];
    set(key, list.includes(value) ? list.filter(v => v !== value) : [...list, value]);
  };

  const submitSave = () => {
    const trimmed = name.trim();
    if (trimmed && saved.some(s => s.name === trimmed)
      && !window.confirm(`"${trimmed}" 필터가 이미 있습니다. 지금 조건으로 바꿀까요?`)) return;
    try {
      onSave(name);
      setNaming(false);
      setName('');
      setSaveError('');
    } catch (e) {
      setSaveError(e.message);
    }
  };
  const confirmDelete = (s) => {
    if (window.confirm(`"${s.name}" 필터를 지울까요?`)) onDeleteSaved(s);
  };

  // 숨긴 항목은 '숨긴 항목 보기'를 눌렀거나 이미 고른 것만 보인다 — 휴대폰에서 칩 목록이 길어지지 않게
  const hiddenCount = paymentMethods.filter(m => m.is_hidden).length + budgetCategories.filter(c => c.is_hidden).length;
  const chips = (key, items) => (
    <div className="filter-chips">
      {items.filter(item => !item.is_hidden || showHidden || (filters[key] || []).includes(item.name)).map(item => {
        const on = (filters[key] || []).includes(item.name);
        return (
          <button
            key={item.name}
            type="button"
            className={`filter-chip${on ? ' on' : ''}${item.is_hidden ? ' hidden-item' : ''}`}
            aria-pressed={on}
            onClick={() => toggle(key, item.name)}
          >
            {item.name}{item.is_hidden ? ' (숨김)' : ''}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="filter-panel">
      <div className="filter-row">
        <span className="filter-label">기간</span>
        <select aria-label="기간" value={filters.period} onChange={e => set('period', e.target.value)}>
          {PERIODS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {filters.period === 'month' && (
          <select aria-label="월" value={filters.month} onChange={e => set('month', e.target.value)}>
            <option value="">월을 고르세요</option>
            {months.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
      </div>
      {filters.period === 'custom' && (
        <div className="filter-row">
          <input type="date" aria-label="시작일" value={filters.dateFrom} onChange={e => set('dateFrom', e.target.value)} />
          <span className="filter-sep">~</span>
          <input type="date" aria-label="끝나는 날" value={filters.dateTo} onChange={e => set('dateTo', e.target.value)} />
        </div>
      )}
      {errors.period && <p className="filter-error" role="alert">{errors.period}</p>}

      {paymentMethods.length > 0 && (
        <div className="filter-group">
          <span className="filter-label">결제수단 <small>여러 개 고를 수 있어요</small></span>
          {chips('payment_methods', paymentMethods)}
        </div>
      )}
      {budgetCategories.length > 0 && (
        <div className="filter-group">
          <span className="filter-label">카테고리</span>
          {chips('budget_categories', budgetCategories)}
        </div>
      )}
      {hiddenCount > 0 && (
        <button type="button" className="filter-link" aria-expanded={showHidden} onClick={() => setShowHidden(v => !v)}>
          {showHidden ? '숨긴 결제수단·카테고리 접기' : `숨긴 결제수단·카테고리 ${hiddenCount}개도 보기`}
        </button>
      )}

      <div className="filter-row">
        <span className="filter-label">금액</span>
        <AmountInput
          className="filter-amount"
          containerClassName="filter-amount-wrap"
          words={false}
          allowNegative
          value={filters.amountMin}
          onChange={v => set('amountMin', v)}
          placeholder="최소"
          aria-label="최소 금액"
        />
        <span className="filter-sep">~</span>
        <AmountInput
          className="filter-amount"
          containerClassName="filter-amount-wrap"
          words={false}
          allowNegative
          value={filters.amountMax}
          onChange={v => set('amountMax', v)}
          placeholder="최대"
          aria-label="최대 금액"
        />
      </div>
      {errors.amount && <p className="filter-error" role="alert">{errors.amount}</p>}

      {(members.length > 0 || filters.member) && (
        <div className="filter-row">
          <span className="filter-label">누가</span>
          <select aria-label="누가" value={filters.member} onChange={e => set('member', e.target.value)}>
            <option value="">전체 구성원</option>
            {members.map(m => <option key={m} value={m}>{m}</option>)}
            <option value={MEMBER_NONE}>(누가 없음)</option>
          </select>
        </div>
      )}

      <div className="filter-group">
        <span className="filter-label">저장한 필터 <small>이 기기에만</small></span>
        <div className="filter-chips">
          {saved.map(s => (
            <span key={s.name} className="saved-filter">
              <button type="button" className="filter-chip" onClick={() => onApplySaved(s)}>⭐ {s.name}</button>
              <button type="button" className="saved-filter-del" aria-label={`${s.name} 지우기`} onClick={() => confirmDelete(s)}>✕</button>
            </span>
          ))}
          {!naming && canSave && (
            <button type="button" className="filter-chip filter-chip-add" onClick={() => { setNaming(true); setSaveError(''); }}>
              ＋ 지금 필터 저장
            </button>
          )}
          {!saved.length && !canSave && <span className="filter-hint">조건을 고른 뒤 저장해 두면 다음에 한 번에 걸 수 있어요</span>}
        </div>
        {naming && (
          <div className="filter-row">
            <input
              type="text"
              className="saved-filter-name"
              value={name}
              maxLength={SAVED_NAME_MAX}
              placeholder="이름 (예: 올해 카페)"
              aria-label="필터 이름"
              autoFocus
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitSave(); } }}
            />
            <button type="button" className="btn-filter-sm" onClick={submitSave}>저장</button>
            <button type="button" className="btn-filter-sm btn-filter-cancel" onClick={() => { setNaming(false); setSaveError(''); }}>취소</button>
          </div>
        )}
        {saveError && <p className="filter-error" role="alert">{saveError}</p>}
        {savedNote && <p className="filter-hint">{savedNote}</p>}
      </div>

      {/* 패널을 연 채로도 결과를 알 수 있게 아래에 붙는 줄 — 누르면 닫고 결과를 본다 */}
      <div className="filter-panel-foot">
        <span className="filter-result">{resultText}</span>
        {hasFilters && <button type="button" className="btn-clear-filter" onClick={onClear}>초기화</button>}
        <button type="button" className="btn-filter-sm filter-show-results" onClick={onShowResults}>결과 보기</button>
      </div>
    </div>
  );
}
