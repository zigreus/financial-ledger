import React, { useMemo, useState } from 'react';
import {
  isCategoryBudgetEnabled, getCategoryBudgetStatus, setMonthCategoryBudget,
} from '../../services/dbManager';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';
import { evaluateFormula, isIncompleteFormula, formatAmount } from '../../services/formulaEvaluator';
import { categoryColor } from '../common/categoryColor';
import AmountInput from '../common/AmountInput';
import { currentYearMonth } from '../../services/dateUtils';
import './CategoryBudgetPanel.css';

const LEVEL_TEXT = { ok: '', warn: '거의 다 썼어요', over: '넘었어요' };
const SOURCE_TAG = { month: '이 달만', kept: '그때 예산' };

/** "34만" 같은 짧은 금액 — 막대 옆 좁은 칸용 (만 원 아래는 그대로). 반올림한 뒤 소수점을 정한다(99,999 → "10만") */
export function shortWon(n) {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) < 10000) return `${formatAmount(v)}원`;
  const man = Math.round((v / 10000) * 10) / 10;
  return `${Number.isInteger(man) ? man : man.toFixed(1)}만`;
}

/**
 * 요약 › 카테고리(월) — 예산 대비 (I-025, ROADMAP C-5). 카테고리별 예산을 켰을 때만, 달을 고른 때만 보인다.
 * 예산이 있는 카테고리마다 순지출/예산 막대(80% 이상 주의, 100% 넘으면 초과)와 남은·넘은 금액을 보이고,
 * 줄을 누르면 이 달만 예산을 바꾸거나, 그 달 줄을 지워 상시 예산으로 돌린다(상시 예산이 없으면 그 달 예산을 없앤다).
 * 달이 바뀌면 부르는 쪽이 key로 새로 그린다(열려 있던 편집 칸이 다른 달에 남지 않게).
 */
export default function CategoryBudgetPanel({ db, dataVersion, month }) {
  const live = useDbSnapshot(db, dataVersion);
  const enabled = useMemo(() => isCategoryBudgetEnabled(live.db), [live]);
  const status = useMemo(() => (enabled && month ? getCategoryBudgetStatus(live.db, month) : []), [live, enabled, month]);
  const [editing, setEditing] = useState(null); // 이 달 예산을 고치는 카테고리
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  if (!enabled || !month) return null;
  if (!status.length) {
    // 상시 예산은 정한 달부터 쓴다 — 지난 달에는 설정에서 정해도 적용되지 않으니 그렇게 알린다
    return (
      <div className="cb-panel cb-panel--empty">
        {month < currentYearMonth()
          ? '이 달에는 정해 둔 예산이 없었어요 (상시 예산은 정한 달부터 적용돼요).'
          : '이 달 카테고리 예산이 없어요 — 설정 › 지출계획 › 예산에서 카테고리별 예산을 정할 수 있어요.'}
      </div>
    );
  }

  const totalBudget = status.reduce((s, r) => s + r.budget, 0);
  const totalSpent = status.reduce((s, r) => s + r.spent, 0);

  const startEdit = (r) => {
    setEditing(r.category);
    setInput(String(r.budget));
    setError('');
  };
  const save = (r) => {
    if (isIncompleteFormula(input)) { setError('수식을 마저 입력하세요'); return; }
    const val = evaluateFormula(input);
    if (val === null || Number.isNaN(val) || val <= 0) { setError('올바른 금액을 입력하세요'); return; }
    setMonthCategoryBudget(db, r.category, month, val);
    setEditing(null);
    setError('');
  };
  const removeMonth = (r) => {
    setMonthCategoryBudget(db, r.category, month, null);
    setEditing(null);
    setError('');
  };

  return (
    <div className="cb-panel">
      <div className="cb-head">
        <b>예산 대비</b>
        <span className="cb-head-total">
          {shortWon(totalSpent)} / {shortWon(totalBudget)}
          {' '}({totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0}%)
        </span>
      </div>
      <ul className="cb-list">
        {status.map((r) => {
          const pct = Number.isFinite(r.ratio) ? Math.round(r.ratio * 100) : 100;
          const left = r.budget - r.spent;
          const open = editing === r.category;
          const label = `${month} ${r.category} 예산`;
          return (
            <li key={r.category} className={`cb-row cb-row--${r.level}`}>
              <button
                type="button"
                className="cb-row-main"
                aria-expanded={open}
                onClick={() => (open ? setEditing(null) : startEdit(r))}
              >
                <span className="cb-row-top">
                  <span className="cb-name">
                    <span className="cat-dot" style={{ backgroundColor: categoryColor(r.category) }} />
                    {r.category}
                    {r.hidden && <span className="cb-tag cb-tag--hidden">숨김</span>}
                    {SOURCE_TAG[r.source] && <span className="cb-tag">{SOURCE_TAG[r.source]}</span>}
                  </span>
                  <span className="cb-amounts">
                    {shortWon(r.spent)} / {shortWon(r.budget)} <b>{pct}%</b>
                  </span>
                </span>
                <span className="cb-bar" aria-hidden="true">
                  <span className="cb-bar-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
                </span>
                <span className="cb-row-note">
                  {left >= 0 ? `${formatAmount(left)}원 남음` : `${formatAmount(-left)}원 초과`}
                  {LEVEL_TEXT[r.level] && <span className="cb-level"> · {LEVEL_TEXT[r.level]}</span>}
                </span>
              </button>
              {open && (
                <div className="cb-edit">
                  <span className="cb-edit-label">{label}</span>
                  <AmountInput
                    className="cb-edit-input"
                    value={input}
                    onChange={setInput}
                    onKeyDown={e => { if (e.key === 'Enter') save(r); if (e.key === 'Escape') setEditing(null); }}
                    aria-label={label}
                    autoFocus
                  />
                  <div className="cb-edit-actions">
                    <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>닫기</button>
                    {r.source !== 'default' && (
                      <button type="button" className="btn-secondary" onClick={() => removeMonth(r)}>
                        {r.hasDefault ? '상시 예산으로' : '이 달 예산 없애기'}
                      </button>
                    )}
                    <button type="button" className="btn-primary" onClick={() => save(r)}>이 달만 바꾸기</button>
                  </div>
                  {error && <div className="cb-error" role="alert">{error}</div>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
