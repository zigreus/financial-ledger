import React, { useState, useMemo } from 'react';
import {
  getAllPaymentMethods, getAllBudgetCategories, getSubCategories,
  getFavorites, addFavorite, updateFavorite, deleteFavorite, reorderFavorite,
  getDetectedPatterns, toggleAutoPattern, deleteAutoPattern,
} from '../../../services/dbManager';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import { evaluateFormula } from '../../../services/formulaEvaluator';
import AmountInput from '../../common/AmountInput';
import { dropTargetIndex } from '../settingsUtils';
import { IconEdit, IconTrash } from '../icons';

const emptyFavoriteForm = {
  name: '', payment_method: '', budget_category: '', sub_category: '', detail: '', amount: '',
};

/** 지출계획 › 즐겨찾기 — 목록(드래그 정렬)·추가/수정 폼·자동 결제수단 패턴 */
export default function FavoritesSection({ db, dataVersion, onChanged, setError }) {
  const live = useDbSnapshot(db, dataVersion);
  const [dragId, setDragId] = useState(null);
  const [dropIdx, setDropIdx] = useState(null);
  const [showFavoriteForm, setShowFavoriteForm] = useState(false);
  const [editingFavoriteId, setEditingFavoriteId] = useState(null);
  const [favoriteForm, setFavoriteForm] = useState(emptyFavoriteForm);

  const paymentMethods = useMemo(() => getAllPaymentMethods(live.db), [live]);
  const budgetCategories = useMemo(() => getAllBudgetCategories(live.db), [live]);
  const favoriteList = useMemo(() => getFavorites(live.db), [live]);
  const favoriteFormSubCategories = useMemo(
    () => favoriteForm.budget_category ? getSubCategories(live.db, favoriteForm.budget_category) : [],
    [live, favoriteForm.budget_category]
  );
  const detectedPatterns = useMemo(() => getDetectedPatterns(live.db), [live]);

  // 즐겨찾기 드래그 정렬 (B-018)
  const handleFavoriteDrop = () => {
    if (dragId !== null && dropIdx !== null) {
      const from = favoriteList.findIndex(f => f.id === dragId);
      const target = dropTargetIndex(favoriteList, dragId, dropIdx);
      if (from !== -1 && target !== from) {
        try {
          reorderFavorite(db, dragId, target);
          onChanged();
          setError('');
        } catch (e) { setError(e.message); }
      }
    }
    setDragId(null);
    setDropIdx(null);
  };

  const openFavoriteForm = (item = null) => {
    if (item) {
      setEditingFavoriteId(item.id);
      setFavoriteForm({
        name: item.name,
        payment_method: item.payment_method,
        budget_category: item.budget_category,
        sub_category: item.sub_category || '',
        detail: item.detail || '',
        amount: item.amount == null ? '' : String(item.amount),
      });
    } else {
      setEditingFavoriteId(null);
      setFavoriteForm(emptyFavoriteForm);
    }
    setShowFavoriteForm(true);
    setError('');
  };

  const handleSaveFavorite = () => {
    if (!favoriteForm.name.trim()) { setError('이름을 입력하세요.'); return; }
    if (!favoriteForm.payment_method) { setError('결제수단을 선택하세요.'); return; }
    if (!favoriteForm.budget_category) { setError('카테고리를 선택하세요.'); return; }
    if (!favoriteForm.sub_category) { setError('세부카테고리를 선택하세요.'); return; }
    // 금액은 선택 — 비워두면 거래 추가 시 직접 입력한다
    const hasAmount = String(favoriteForm.amount).trim() !== '';
    const amount = hasAmount ? evaluateFormula(favoriteForm.amount) : null;
    if (hasAmount && (amount === null || isNaN(amount) || amount <= 0)) { setError('금액을 올바르게 입력하세요.'); return; }
    const data = { ...favoriteForm, amount };
    try {
      if (editingFavoriteId !== null) {
        updateFavorite(db, editingFavoriteId, data);
      } else {
        addFavorite(db, data);
      }
      onChanged();
      setShowFavoriteForm(false);
      setEditingFavoriteId(null);
      setFavoriteForm(emptyFavoriteForm);
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleDeleteFavorite = (id) => {
    if (!window.confirm('즐겨찾기를 삭제하시겠습니까?')) return;
    try {
      deleteFavorite(db, id);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleToggleAutoPattern = (subCategory, isDisabled) => {
    try {
      toggleAutoPattern(db, subCategory, !isDisabled);
      onChanged();
    } catch (e) { setError(e.message); }
  };

  const handleDeleteAutoPattern = (subCategory) => {
    try {
      deleteAutoPattern(db, subCategory);
      onChanged();
    } catch (e) { setError(e.message); }
  };

  return (
    <div>
      {!showFavoriteForm ? (
        <div>
          {favoriteList.length > 0 ? (
            <div
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); handleFavoriteDrop(); }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropIdx(null); }}
            >
              {favoriteList.map((item, idx) => {
                const isDragging = dragId === item.id;
                const showIndicator = dropIdx === idx && dragId !== null && !isDragging;
                return (
                  <React.Fragment key={item.id}>
                    {showIndicator && <div className="drop-indicator" />}
                    <div
                      className={`settings-item ${isDragging ? 'settings-item-dragging' : ''}`}
                      draggable
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragId(item.id); setDropIdx(null); }}
                      onDragOver={e => {
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        setDropIdx(e.clientY < rect.top + rect.height / 2 ? idx : idx + 1);
                      }}
                      onDragEnd={() => { setDragId(null); setDropIdx(null); }}
                    >
                      <span className="drag-handle">≡</span>
                      <div style={{ flex: 1, overflow: 'hidden' }}>
                        <div style={{ fontWeight: '600', fontSize: '14px' }}>{item.name}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{item.payment_method} · {item.budget_category}{item.sub_category ? `/${item.sub_category}` : ''}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{item.amount == null ? '금액 직접 입력' : `${item.amount.toLocaleString()}원`} · {item.use_count}회 사용</div>
                      </div>
                      <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                        <button className="btn-icon" onClick={() => openFavoriteForm(item)} title="수정"><IconEdit /></button>
                        <button className="btn-icon btn-icon--danger" onClick={() => handleDeleteFavorite(item.id)} title="삭제"><IconTrash /></button>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
              {dropIdx === favoriteList.length && dragId !== null && <div className="drop-indicator" />}
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '24px' }}>등록된 즐겨찾기가 없습니다.</div>
          )}
          <button className="btn-secondary" style={{ width: '100%', marginTop: '12px' }} onClick={() => openFavoriteForm()}>+ 새 즐겨찾기 추가</button>
        </div>
      ) : (
        <form style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div className="form-group">
            <label>이름 *</label>
            <input type="text" value={favoriteForm.name} onChange={e => setFavoriteForm({...favoriteForm, name: e.target.value})} placeholder="예: 출퇴근 교통비" required />
          </div>
          <div className="form-group">
            <label>결제수단 *</label>
            <select value={favoriteForm.payment_method} onChange={e => setFavoriteForm({...favoriteForm, payment_method: e.target.value})} required>
              <option value="">선택</option>
              {paymentMethods.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div className="form-group">
              <label>카테고리 *</label>
              <select value={favoriteForm.budget_category} onChange={e => { setFavoriteForm({...favoriteForm, budget_category: e.target.value, sub_category: ''}); }} required>
                <option value="">선택</option>
                {budgetCategories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>세부카테고리 *</label>
              <select value={favoriteForm.sub_category} onChange={e => setFavoriteForm({...favoriteForm, sub_category: e.target.value})} required>
                <option value="">선택</option>
                {favoriteFormSubCategories.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>세부내역</label>
            <input type="text" value={favoriteForm.detail} onChange={e => setFavoriteForm({...favoriteForm, detail: e.target.value})} placeholder="선택사항" />
          </div>
          <div className="form-group">
            <label>금액 <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '12px' }}>(선택)</span></label>
            <AmountInput value={favoriteForm.amount ?? ''} onChange={v => setFavoriteForm({...favoriteForm, amount: v})} placeholder="비워두면 거래 추가 시 직접 입력" />
          </div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
            <button type="button" className="btn-secondary" onClick={() => { setShowFavoriteForm(false); setEditingFavoriteId(null); setFavoriteForm(emptyFavoriteForm); setError(''); }} style={{ flex: 1 }}>취소</button>
            <button type="button" className="btn-primary" onClick={handleSaveFavorite} style={{ flex: 1 }}>{editingFavoriteId !== null ? '수정' : '추가'}</button>
          </div>
        </form>
      )}

      {/* 자동 패턴 섹션 */}
      {detectedPatterns.length > 0 && (
        <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>자동 결제수단 패턴</div>
          {detectedPatterns.map(pat => (
            <div key={pat.sub_category} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px', marginBottom: '8px', background: 'var(--bg)', borderRadius: '8px' }}>
              <div style={{ flex: 1, fontSize: '13px' }}>
                <div>{pat.sub_category} → {pat.payment_method}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>({pat.count}건, {Math.round(pat.count / pat.total * 100)}%)</div>
              </div>
              <button type="button" className={`goal-display-toggle${pat.is_disabled ? '' : ' goal-display-toggle--on'}`} onClick={() => handleToggleAutoPattern(pat.sub_category, pat.is_disabled)} title={pat.is_disabled ? '켜기' : '끄기'} style={{ marginRight: '8px' }}>
                <span className="goal-display-toggle-knob" />
              </button>
              <button type="button" className="btn-icon" onClick={() => handleDeleteAutoPattern(pat.sub_category)} title="삭제">🗑</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
