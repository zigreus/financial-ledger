import React, { useMemo, useState } from 'react';
import {
  getAllBudgetCategories, getDefaultCategoryBudgets, isCategoryBudgetEnabled, countCategoryBudgets,
  setCategoryBudgetEnabled, setDefaultCategoryBudget, getOrphanCategoryBudgetNames, deleteCategoryBudgets,
} from '../../../services/dbManager';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import { evaluateFormula, isIncompleteFormula, formatAmount } from '../../../services/formulaEvaluator';
import { categoryColor } from '../../common/categoryColor';
import AmountInput from '../../common/AmountInput';
import { IconEdit, IconTrash, IconCheck, IconClose } from '../icons';
import { OptionalFeatureHead } from '../optionalFeatures';

/**
 * 지출계획 › 예산 › 카테고리별 예산 (I-025, ROADMAP C-5) — 필요한 사람만 켜는 선택 기능(가족 공통 설정).
 * 켜면 카테고리마다 상시 예산을 정하고, 요약 › 카테고리(월)의 '예산 대비'와 거래내역의 80%·100% 알림이 보인다.
 * 상시 예산을 바꾸면 이번 달부터 적용되고 지난 달은 그때 예산 그대로 남는다. 이 달만 다르게 하려면 요약에서 바꾼다.
 * 끄면 화면에서만 감추고 정해 둔 예산은 남겨 둔다(다시 켜면 그대로).
 * 숨긴 카테고리도 예산이 있으면 '숨김' 표시와 함께 보인다(예산 대비에 잡히므로 고치거나 없앨 수 있어야 한다).
 * 카테고리 목록에 없는 이름의 예산(다른 기기가 카테고리를 지운 사이 정한 것 등)은 따로 보여 지울 수 있게 한다.
 */
export default function CategoryBudgetSettings({ db, dataVersion, onChanged, setError }) {
  const live = useDbSnapshot(db, dataVersion);
  const enabled = useMemo(() => isCategoryBudgetEnabled(live.db), [live]);
  const categories = useMemo(() => getAllBudgetCategories(live.db)
    .filter(c => !c.is_hidden || countCategoryBudgets(live.db, c.name) > 0)
    .map(c => ({ name: c.name, hidden: !!c.is_hidden })), [live]);
  const budgets = useMemo(() => getDefaultCategoryBudgets(live.db), [live]);
  const orphans = useMemo(() => getOrphanCategoryBudgetNames(live.db), [live]);
  const [editing, setEditing] = useState(null);
  const [input, setInput] = useState('');

  const toggle = () => {
    setCategoryBudgetEnabled(db, !enabled);
    onChanged();
  };

  const startEdit = (cat) => {
    setEditing(cat);
    setInput(budgets[cat] !== undefined ? String(budgets[cat]) : '');
    setError('');
  };

  const save = (cat) => {
    if (isIncompleteFormula(input)) { setError('수식을 마저 입력하세요.'); return; }
    const val = evaluateFormula(input);
    if (val === null || Number.isNaN(val) || val <= 0) { setError('올바른 금액을 입력하세요.'); return; }
    try {
      setDefaultCategoryBudget(db, cat, val);
      onChanged();
      setEditing(null);
      setError('');
    } catch (e) { setError(e.message); }
  };

  const clear = (cat) => {
    try {
      setDefaultCategoryBudget(db, cat, null);
      onChanged();
      setEditing(null);
      setError('');
    } catch (e) { setError(e.message); }
  };

  const removeOrphan = (name) => {
    if (!window.confirm(`목록에 없는 카테고리 "${name}"의 예산(상시·월별)을 모두 지웁니다.`)) return;
    try {
      deleteCategoryBudgets(db, name);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="cb-settings">
      <OptionalFeatureHead featureKey="categoryBudget" enabled={enabled} onToggle={toggle} />

      {enabled && (
        <>
          {categories.length === 0 ? (
            <div className="cb-settings-note">카테고리가 없습니다 — 먼저 카테고리를 만드세요.</div>
          ) : (
            <ul className="cb-settings-list">
              {categories.map(({ name: cat, hidden }) => (
                <li key={cat} className="cb-settings-row">
                  <span className="cb-settings-name">
                    <span className="cat-dot" style={{ backgroundColor: categoryColor(cat) }} />
                    {cat}
                    {hidden && <span className="cb-settings-hidden">숨김</span>}
                  </span>
                  {editing === cat ? (
                    <span className="cb-settings-edit">
                      <AmountInput
                        className="settings-inline-input"
                        containerStyle={{ flex: 1, minWidth: 0 }}
                        words={false}
                        value={input}
                        onChange={setInput}
                        onKeyDown={e => { if (e.key === 'Enter') save(cat); if (e.key === 'Escape') setEditing(null); }}
                        autoFocus
                        placeholder="예: 400000"
                      />
                      <button className="btn-icon btn-icon--success" onClick={() => save(cat)} title="저장"><IconCheck /></button>
                      <button className="btn-icon" onClick={() => setEditing(null)} title="취소"><IconClose /></button>
                      {budgets[cat] !== undefined && (
                        <button className="btn-icon btn-icon--danger" onClick={() => clear(cat)} title="예산 없애기"><IconTrash /></button>
                      )}
                    </span>
                  ) : (
                    <span className="cb-settings-value">
                      <span className={budgets[cat] !== undefined ? 'cb-settings-amount' : 'cb-settings-unset'}>
                        {budgets[cat] !== undefined ? `${formatAmount(budgets[cat])}원` : '미설정'}
                      </span>
                      <button className="btn-icon" onClick={() => startEdit(cat)} title={`${cat} 예산 수정`}><IconEdit /></button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {orphans.length > 0 && (
            <div className="cb-settings-orphans">
              <div className="cb-settings-note">목록에 없는 카테고리의 예산 — 예산 대비에는 나오지 않아요.</div>
              <ul className="cb-settings-list">
                {orphans.map(name => (
                  <li key={name} className="cb-settings-row">
                    <span className="cb-settings-name">{name}</span>
                    <button className="btn-icon btn-icon--danger" onClick={() => removeOrphan(name)} title={`${name} 예산 지우기`}><IconTrash /></button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="cb-settings-note">
            바꾸면 이번 달부터 적용돼요(그 전에 쓰던 달은 그때 예산 그대로). 이 달만 다르게 하려면 요약 › 카테고리의 예산 대비에서 바꾸세요.
          </div>
        </>
      )}
    </div>
  );
}
