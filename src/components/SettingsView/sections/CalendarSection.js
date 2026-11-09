import React, { useState, useMemo } from 'react';
import {
  getSetting, setSetting, getBudgetCategories, getTripDefaultCategory,
  getCalendarEventTypes, addCalendarEventType, updateCalendarEventType,
  deleteCalendarEventType, moveCalendarEventType,
  getCalendarEventTypeUsageCount, setCalendarEventTypeTripFlag,
  isTripSplitEnabled, setTripSplitEnabled,
} from '../../../services/dbManager';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import { dropTargetIndex } from '../settingsUtils';
import { OptionalFeatureHead } from '../optionalFeatures';
import { IconGrip, IconEdit, IconTrash, IconCheck, IconClose } from '../icons';

/**
 * 캘린더 — 일정 유형(추가·수정·삭제·드래그 정렬·여행 유형)과 표시 설정
 * subTab('types' | 'display')은 다른 탭에 다녀와도 유지되도록 SettingsView가 가진다.
 */
export default function CalendarSection({ db, dataVersion, onChanged, subTab, onSubTabChange }) {
  const live = useDbSnapshot(db, dataVersion);
  const [editingTypeId, setEditingTypeId] = useState(null);
  const [editingTypeLabel, setEditingTypeLabel] = useState('');
  const [editingTypeColor, setEditingTypeColor] = useState('');
  const [deletingTypeId, setDeletingTypeId] = useState(null);
  const [newTypeLabel, setNewTypeLabel] = useState('');
  const [newTypeColor, setNewTypeColor] = useState('#4ECDC4');
  const [typeError, setTypeError] = useState('');
  const [typeDragId, setTypeDragId] = useState(null);
  const [typeDragOver, setTypeDragOver] = useState(null);

  const eventTypes = useMemo(() => getCalendarEventTypes(live.db) || [], [live]);
  const ruleCategories = useMemo(() => getBudgetCategories(live.db), [live]);
  const tripCategory = useMemo(() => getTripDefaultCategory(live.db), [live]);
  const tripSplitOn = useMemo(() => isTripSplitEnabled(live.db), [live]);
  const showCalBtnPc = useMemo(() => getSetting(live.db, 'show_calendar_btn_pc', '1') !== '0', [live]);
  const showCalBtnMobile = useMemo(() => getSetting(live.db, 'show_calendar_btn_mobile', '1') !== '0', [live]);
  const calAmountUnit = useMemo(() => getSetting(live.db, 'calendar_mini_amount_unit', '만'), [live]);
  const calEmptyDateAction = useMemo(() => getSetting(live.db, 'calendar_empty_date_action', 'event'), [live]);

  // 일정 유형 드래그 정렬 (B-026)
  const handleTypeDrop = () => {
    if (typeDragId !== null && typeDragOver !== null) {
      const from = eventTypes.findIndex(t => t.id === typeDragId);
      const target = dropTargetIndex(eventTypes, typeDragId, typeDragOver);
      if (from !== -1 && target !== from) {
        try {
          moveCalendarEventType(db, typeDragId, target);
          onChanged();
          setTypeError('');
        } catch (e) { setTypeError(e.message); }
      }
    }
    setTypeDragId(null);
    setTypeDragOver(null);
  };

  const handleSaveType = (t) => {
    try {
      updateCalendarEventType(db, t.id, { label: editingTypeLabel, color: editingTypeColor });
      onChanged();
      setEditingTypeId(null);
      setTypeError('');
    } catch (err) { setTypeError(err.message); }
  };

  const handleAddType = () => {
    try {
      addCalendarEventType(db, { label: newTypeLabel, color: newTypeColor });
      onChanged();
      setNewTypeLabel('');
      setNewTypeColor('#4ECDC4');
      setTypeError('');
    } catch (err) { setTypeError(err.message); }
  };

  return (
    <div>
      {/* 서브탭 */}
      <div className="settings-subtabs">
        <button
          className={`settings-subtab${subTab === 'types' ? ' active' : ''}`}
          onClick={() => { onSubTabChange('types'); setTypeError(''); }}
        >일정 유형</button>
        <button
          className={`settings-subtab${subTab === 'display' ? ' active' : ''}`}
          onClick={() => onSubTabChange('display')}
        >표시 설정</button>
      </div>

      {/* 일정 유형 서브탭 */}
      {subTab === 'types' && (
        <div>
          {typeError && <div className="error-msg" style={{ marginBottom: '10px' }}>{typeError}</div>}

          {/* 유형 목록 */}
          <div
            style={{ marginBottom: '16px' }}
            onDragOver={e => { e.preventDefault(); if (e.currentTarget === e.target) setTypeDragOver(eventTypes.length); }}
            onDrop={e => { e.preventDefault(); handleTypeDrop(); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setTypeDragOver(null); }}
          >
            {eventTypes.map((t, idx) => {
              const usageCount = deletingTypeId === t.id ? getCalendarEventTypeUsageCount(db, t.value) : 0;
              return (
                <div key={t.id}>
                  {editingTypeId === t.id ? (
                    /* 편집 행 */
                    <div className="settings-item" style={{ gap: '8px' }}>
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: editingTypeColor, cursor: 'pointer', border: '2px solid var(--border)' }} />
                        <input
                          type="color"
                          value={editingTypeColor}
                          onChange={e => setEditingTypeColor(e.target.value)}
                          style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
                        />
                      </div>
                      <input
                        className="settings-inline-input"
                        style={{ width: 80, flexShrink: 0, fontFamily: 'monospace', fontSize: 13 }}
                        value={editingTypeColor}
                        onChange={e => setEditingTypeColor(e.target.value)}
                        onBlur={e => {
                          const v = e.target.value.trim();
                          const hex = v.startsWith('#') ? v : '#' + v;
                          if (/^#[0-9a-fA-F]{6}$/.test(hex)) setEditingTypeColor(hex);
                        }}
                        maxLength={7}
                        placeholder="#000000"
                      />
                      <input
                        className="settings-inline-input"
                        style={{ flex: 1 }}
                        value={editingTypeLabel}
                        onChange={e => setEditingTypeLabel(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveType(t);
                          if (e.key === 'Escape') setEditingTypeId(null);
                        }}
                        autoFocus
                      />
                      <button className="btn-icon btn-icon--success" onClick={() => handleSaveType(t)} title="저장"><IconCheck /></button>
                      <button className="btn-icon" onClick={() => setEditingTypeId(null)} title="취소"><IconClose /></button>
                    </div>
                  ) : deletingTypeId === t.id ? (
                    /* 삭제 확인 행 */
                    <div className="settings-item" style={{ gap: '8px' }}>
                      <span style={{ flex: 1, fontSize: '13px' }}>
                        {usageCount > 0
                          ? `${usageCount}개 일정에서 사용 중 — 삭제 불가`
                          : `"${t.label}" 유형을 삭제할까요?`
                        }
                      </span>
                      {usageCount === 0 && (
                        <button className="btn-icon btn-icon--danger" onClick={() => {
                          try { deleteCalendarEventType(db, t.id); onChanged(); setDeletingTypeId(null); setTypeError(''); }
                          catch(err) { setTypeError(err.message); setDeletingTypeId(null); }
                        }} title="삭제 확인"><IconTrash /></button>
                      )}
                      <button className="btn-icon" onClick={() => setDeletingTypeId(null)} title="취소"><IconClose /></button>
                    </div>
                  ) : (
                    /* 기본 행 */
                    <React.Fragment>
                      {typeDragOver === idx && typeDragId !== null && typeDragId !== t.id && (
                        <div className="drop-indicator" />
                      )}
                      <div
                        className={`settings-item${typeDragId === t.id ? ' settings-item-dragging' : ''}`}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setTypeDragId(t.id); setTypeDragOver(null); }}
                        onDragOver={e => {
                          e.preventDefault();
                          const rect = e.currentTarget.getBoundingClientRect();
                          setTypeDragOver(e.clientY < rect.top + rect.height / 2 ? idx : idx + 1);
                        }}
                        onDragEnd={() => { setTypeDragId(null); setTypeDragOver(null); }}
                      >
                        <span className="drag-handle" style={{ cursor: 'grab', color: 'var(--text-muted)', marginRight: '4px' }}><IconGrip /></span>
                        <span style={{ width: 14, height: 14, borderRadius: '50%', background: t.color, flexShrink: 0, display: 'inline-block' }} />
                        <span style={{ flex: 1, fontSize: '14px' }}>{t.label}</span>
                        {t.value !== 'general' && (
                          <button
                            className={`goal-display-toggle${t.is_trip_type ? ' goal-display-toggle--on' : ''}`}
                            style={{ fontSize: '10px', padding: '0 6px', height: '24px', minWidth: '44px' }}
                            onClick={() => { setCalendarEventTypeTripFlag(db, t.id, !t.is_trip_type); onChanged(); }}
                            title="국가/통화 입력 활성화"
                          >
                            <span className="goal-display-toggle-knob" />
                          </button>
                        )}
                        <button className="btn-icon" onClick={() => { setEditingTypeId(t.id); setEditingTypeLabel(t.label); setEditingTypeColor(t.color); }} title="수정"><IconEdit /></button>
                        {!t.is_system && (
                          <button className="btn-icon btn-icon--danger" onClick={() => setDeletingTypeId(t.id)} title="삭제"><IconTrash /></button>
                        )}
                      </div>
                    </React.Fragment>
                  )}
                </div>
              );
            })}
            {typeDragOver === eventTypes.length && typeDragId !== null && (
              <div className="drop-indicator" />
            )}
          </div>

          {/* 추가 폼 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: newTypeColor, cursor: 'pointer', border: '2px solid var(--border)' }} />
                <input type="color" value={newTypeColor} onChange={e => setNewTypeColor(e.target.value)}
                  style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }} />
              </div>
              <input
                className="settings-inline-input"
                style={{ width: 80, flexShrink: 0, flexGrow: 0, fontFamily: 'monospace', fontSize: 13 }}
                value={newTypeColor}
                onChange={e => {
                  const v = e.target.value;
                  setNewTypeColor(v);
                }}
                onBlur={e => {
                  const v = e.target.value.trim();
                  const hex = v.startsWith('#') ? v : '#' + v;
                  if (/^#[0-9a-fA-F]{6}$/.test(hex)) setNewTypeColor(hex);
                }}
                maxLength={7}
                placeholder="#000000"
              />
              <input
                className="settings-inline-input"
                style={{ flex: 1, minWidth: 0 }}
                value={newTypeLabel}
                onChange={e => setNewTypeLabel(e.target.value)}
                placeholder="새 유형 이름"
                onKeyDown={e => { if (e.key === 'Enter') handleAddType(); }}
              />
            </div>
            <button className="btn-primary" style={{ width: '100%' }} onClick={handleAddType}>+ 추가</button>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
            슬라이더 ON = 해당 유형 일정 선택 시 국가/통화 입력 활성화
          </div>

          {/* 여행 일정 자동 카테고리 */}
          <div style={{ marginTop: '20px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '8px' }}>여행 일정 자동 카테고리</div>
            <select
              className="settings-inline-input"
              style={{ width: '100%' }}
              value={tripCategory}
              onChange={e => {
                setSetting(db, 'trip_default_category', e.target.value);
                onChanged();
              }}
            >
              <option value="">사용 안 함</option>
              {ruleCategories.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
              거래 추가 시 여행 유형 일정을 선택하면 이 카테고리가 자동 선택됩니다.
            </div>
          </div>

          {/* 여행 정산 — 일행 N빵 (I-030) — 선택 기능 */}
          <div className="cb-settings">
            <OptionalFeatureHead
              featureKey="tripSplit"
              enabled={tripSplitOn}
              onToggle={() => { setTripSplitEnabled(db, !tripSplitOn); onChanged(); }}
            />
          </div>
        </div>
      )}

      {/* 표시 설정 서브탭 */}
      {subTab === 'display' && (
        <div>
          <div style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>달력 버튼 표시 (거래내역)</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: '13px' }}>PC</div>
                <button
                  className={`goal-display-toggle${showCalBtnPc ? ' goal-display-toggle--on' : ''}`}
                  onClick={() => { setSetting(db, 'show_calendar_btn_pc', showCalBtnPc ? '0' : '1'); onChanged(); }}
                ><span className="goal-display-toggle-knob" /></button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: '13px' }}>모바일</div>
                <button
                  className={`goal-display-toggle${showCalBtnMobile ? ' goal-display-toggle--on' : ''}`}
                  onClick={() => { setSetting(db, 'show_calendar_btn_mobile', showCalBtnMobile ? '0' : '1'); onChanged(); }}
                ><span className="goal-display-toggle-knob" /></button>
              </div>
            </div>
          </div>

          <div style={{ padding: '16px 0', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: '14px', fontWeight: '600' }}>달력 금액 단위</div>
            <select
              className="rule-form-select"
              style={{ flex: 'none', width: 'auto', minWidth: '100px' }}
              value={calAmountUnit}
              onChange={e => { setSetting(db, 'calendar_mini_amount_unit', e.target.value); onChanged(); }}
            >
              <option value="만">만원</option>
              <option value="k">k (천)</option>
              <option value="hidden">숨김</option>
            </select>
          </div>

          <div style={{ padding: '16px 0', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: '14px', fontWeight: '600' }}>빈 날짜 클릭 시</div>
            <select
              className="rule-form-select"
              style={{ flex: 'none', width: 'auto', minWidth: '120px' }}
              value={calEmptyDateAction}
              onChange={e => { setSetting(db, 'calendar_empty_date_action', e.target.value); onChanged(); }}
            >
              <option value="event">일정 추가</option>
              <option value="transaction">거래내역 추가</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
