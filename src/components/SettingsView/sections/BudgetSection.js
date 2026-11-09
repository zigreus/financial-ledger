import React, { useState, useMemo } from 'react';
import { getSetting, setSetting, changeDefaultMonthlyGoal } from '../../../services/dbManager';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import { evaluateFormula } from '../../../services/formulaEvaluator';
import AmountInput from '../../common/AmountInput';
import { IconEdit, IconTrash, IconCheck, IconClose } from '../icons';
import CategoryBudgetSettings from './CategoryBudgetSettings';
import MonthlyBalanceSettings from './MonthlyBalanceSettings';
import MonthlyReportSettings from './MonthlyReportSettings';
import TaxSummarySettings from './TaxSummarySettings';

/** 지출계획 › 예산 — 목표금액 표시 여부와 상시 월 목표금액 */
export default function BudgetSection({ db, dataVersion, onChanged, setError }) {
  const live = useDbSnapshot(db, dataVersion);
  const [editingDefaultGoal, setEditingDefaultGoal] = useState(false);
  const [defaultGoalInput, setDefaultGoalInput] = useState('');
  const showGoalPc = useMemo(() => getSetting(live.db, 'show_goal_display_pc', '1') !== '0', [live]);
  const showGoalMobile = useMemo(() => getSetting(live.db, 'show_goal_display_mobile', '1') !== '0', [live]);
  const defaultGoal = useMemo(() => getSetting(live.db, 'default_monthly_goal', ''), [live]);

  const handleSaveDefaultGoal = () => {
    const val = evaluateFormula(defaultGoalInput);
    if (val === null || isNaN(val) || val <= 0) { setError('올바른 금액을 입력하세요.'); return; }
    try {
      changeDefaultMonthlyGoal(db, val);
      onChanged();
      setEditingDefaultGoal(false);
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleClearDefaultGoal = () => {
    try {
      // 해제 전에도 기존 월을 현재 기본값으로 스냅샷 (changeDefaultMonthlyGoal이 처리)
      changeDefaultMonthlyGoal(db, null);
      onChanged();
      setEditingDefaultGoal(false);
      setError('');
    } catch (e) { setError(e.message); }
  };

  return (
    <div>
      <div style={{ marginBottom: '20px', paddingBottom: '16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 'calc(14px * var(--fs))', fontWeight: '600', marginBottom: '12px' }}>목표금액 표시</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 'calc(13px * var(--fs))' }}>PC</div>
              <div style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-muted)' }}>화면 너비 640px 초과</div>
            </div>
            <button
              className={`goal-display-toggle${showGoalPc ? ' goal-display-toggle--on' : ''}`}
              onClick={() => { setSetting(db, 'show_goal_display_pc', showGoalPc ? '0' : '1'); onChanged(); }}
              title={showGoalPc ? 'PC 목표금액 표시 끄기' : 'PC 목표금액 표시 켜기'}
            >
              <span className="goal-display-toggle-knob" />
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 'calc(13px * var(--fs))' }}>모바일</div>
              <div style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-muted)' }}>화면 너비 640px 이하</div>
            </div>
            <button
              className={`goal-display-toggle${showGoalMobile ? ' goal-display-toggle--on' : ''}`}
              onClick={() => { setSetting(db, 'show_goal_display_mobile', showGoalMobile ? '0' : '1'); onChanged(); }}
              title={showGoalMobile ? '모바일 목표금액 표시 끄기' : '모바일 목표금액 표시 켜기'}
            >
              <span className="goal-display-toggle-knob" />
            </button>
          </div>
        </div>
      </div>
      <div style={{ marginBottom: '20px', opacity: (showGoalPc || showGoalMobile) ? 1 : 0.4, pointerEvents: (showGoalPc || showGoalMobile) ? 'auto' : 'none', transition: 'opacity .2s' }}>
        <div style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--text-muted)', marginBottom: '8px' }}>
          상시 월 목표금액 — 개별 월에서 덮어쓰기 가능합니다.
        </div>
        {editingDefaultGoal ? (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <AmountInput
              className="settings-inline-input"
              containerStyle={{ flex: 1 }}
              words={false}
              value={defaultGoalInput}
              onChange={setDefaultGoalInput}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveDefaultGoal(); if (e.key === 'Escape') setEditingDefaultGoal(false); }}
              autoFocus
              placeholder="예: 1500000"
            />
            <button className="btn-icon btn-icon--success" onClick={handleSaveDefaultGoal} title="저장"><IconCheck /></button>
            <button className="btn-icon" onClick={() => setEditingDefaultGoal(false)} title="취소"><IconClose /></button>
            {defaultGoal !== '' && (
              <button className="btn-icon btn-icon--danger" onClick={handleClearDefaultGoal} title="목표 해제"><IconTrash /></button>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: 'calc(20px * var(--fs))', fontWeight: '700', color: 'var(--primary-text)' }}>
              {defaultGoal !== '' ? `${Number(defaultGoal).toLocaleString()}원` : '미설정'}
            </span>
            <button
              className="btn-icon"
              onClick={() => { setDefaultGoalInput(defaultGoal); setEditingDefaultGoal(true); }}
              title="수정"
            >
              <IconEdit />
            </button>
          </div>
        )}
      </div>
      <div style={{ fontSize: 'calc(13px * var(--fs))', color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
        개별 월 목표금액은 거래내역 화면의 월 헤더에서 설정할 수 있습니다.
      </div>

      {/* 카테고리별 예산 (I-025) — 선택 기능 */}
      <CategoryBudgetSettings db={db} dataVersion={dataVersion} onChanged={onChanged} setError={setError} />
      {/* 수입·월 수지 (I-026) — 선택 기능 */}
      <MonthlyBalanceSettings db={db} dataVersion={dataVersion} onChanged={onChanged} />
      <MonthlyReportSettings db={db} dataVersion={dataVersion} onChanged={onChanged} />
      <TaxSummarySettings db={db} dataVersion={dataVersion} onChanged={onChanged} />
    </div>
  );
}
