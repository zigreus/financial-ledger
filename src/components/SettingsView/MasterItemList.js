import React, { useState, useMemo } from 'react';
import { setMasterItemHidden, moveItemToPosition } from '../../services/dbManager';
import { dropTargetIndex } from './settingsUtils';
import {
  IconEyeOpen, IconEyeOff, IconGrip, IconChevronRight, IconEdit, IconTrash, IconCheck, IconClose,
} from './icons';

/**
 * 드래그로 순서를 바꾸는 마스터 항목 목록 (결제수단 / 카테고리 / 세부카테고리 공용)
 * 정렬(드래그)과 숨기기는 여기서 처리하고, 이름 수정·삭제·드릴다운은 섹션이 넘긴 콜백으로 처리한다.
 *
 * props
 *  - items, table: 목록과 해당 테이블 ('payment_methods' | 'budget_categories' | 'sub_categories')
 *  - onItemClick(item), drilldownTitle: 있으면 행을 눌러 드릴다운하고 > 버튼을 보여 준다
 *  - onStartEdit(item): 있으면 이름 수정 버튼을 보여 준다
 *  - editingId, editingName, onEditingNameChange, onRenameSubmit(item), onEditCancel: 이름 수정 중 상태
 *  - onDelete(item): 삭제 버튼
 */
export default function MasterItemList({
  db, onChanged, setError, items, table,
  onItemClick, drilldownTitle,
  onStartEdit, editingId, editingName, onEditingNameChange, onRenameSubmit, onEditCancel,
  onDelete,
}) {
  const [dragId, setDragId] = useState(null);
  const [dropIdx, setDropIdx] = useState(null);

  // 표시 항목 먼저, 그 안에서는 sort_order 순
  const sortedItems = useMemo(() => [...items].sort((a, b) => {
    if (a.is_hidden !== b.is_hidden) return a.is_hidden ? 1 : -1;
    return a.sort_order - b.sort_order;
  }), [items]);

  // 숨기기는 숨기기만 한다 — 삭제는 휴지통 버튼으로 따로 (B-021)
  const handleToggleHidden = (id, currentHidden) => {
    try {
      setMasterItemHidden(db, table, id, !currentHidden);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleDrop = () => {
    if (dragId === null || dropIdx === null) { setDragId(null); setDropIdx(null); return; }
    const dragItem = sortedItems.find(i => i.id === dragId);
    if (!dragItem) { setDragId(null); setDropIdx(null); return; }
    const targetGroupIdx = dropTargetIndex(sortedItems, dragId, dropIdx, i => i.is_hidden === dragItem.is_hidden);
    try {
      moveItemToPosition(db, table, dragId, targetGroupIdx);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
    setDragId(null);
    setDropIdx(null);
  };

  if (sortedItems.length === 0) {
    return <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 16px' }}>항목이 없습니다.</div>;
  }

  const dragItem = dragId ? sortedItems.find(i => i.id === dragId) : null;
  const isClickable = !!onItemClick;

  return (
    <div
      onDrop={(e) => { e.preventDefault(); handleDrop(); }}
      onDragEnd={() => { setDragId(null); setDropIdx(null); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropIdx(null); }}
    >
      {sortedItems.map((item, idx) => {
        const isDragging = dragId === item.id;
        const sameGroup = dragItem && item.is_hidden === dragItem.is_hidden;
        const showIndicator = dropIdx === idx && dragId !== null && sameGroup;
        const isEditing = editingId != null && editingId === item.id;
        return (
          <React.Fragment key={item.id}>
            {showIndicator && <div className="drop-indicator" />}
            <div
              className={`settings-item ${item.is_hidden ? 'settings-item-hidden' : ''} ${isDragging ? 'settings-item-dragging' : ''} ${isClickable && !isEditing ? 'settings-item-clickable' : ''}`}
              draggable={!isEditing}
              onDragStart={(e) => { if (isEditing) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; setDragId(item.id); setDropIdx(null); }}
              onDragOver={(e) => {
                e.preventDefault();
                if (isEditing || !dragItem || item.is_hidden !== dragItem.is_hidden) { setDropIdx(null); return; }
                const rect = e.currentTarget.getBoundingClientRect();
                setDropIdx(e.clientY < rect.top + rect.height / 2 ? idx : idx + 1);
              }}
              onClick={isClickable && !isEditing ? () => onItemClick(item) : undefined}
            >
              <div className="drag-handle" title="드래그해서 순서 변경" onClick={(e) => e.stopPropagation()}>
                <IconGrip />
              </div>

              {isEditing ? (
                <input
                  type="text"
                  value={editingName}
                  onChange={e => onEditingNameChange(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') onRenameSubmit(item);
                    if (e.key === 'Escape') onEditCancel();
                  }}
                  autoFocus
                  className="settings-inline-input"
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="settings-item-name">{item.name}</span>
              )}

              {isEditing ? (
                <div style={{ display: 'flex', gap: '4px' }} onClick={(e) => e.stopPropagation()}>
                  <button className="btn-icon btn-icon--success" onClick={() => onRenameSubmit(item)} title="저장">
                    <IconCheck />
                  </button>
                  <button className="btn-icon" onClick={onEditCancel} title="취소">
                    <IconClose />
                  </button>
                </div>
              ) : (
                <>
                  {/* 숨기기 (결제수단·카테고리·세부카테고리) — 입력 목록에서만 빠지고 기존 내역은 그대로 */}
                  <button
                    className={`btn-eye-toggle ${item.is_hidden ? 'btn-eye-toggle--hidden' : ''}`}
                    onClick={(e) => { e.stopPropagation(); handleToggleHidden(item.id, item.is_hidden); }}
                    title={item.is_hidden ? '표시' : '숨기기'}
                  >
                    {item.is_hidden ? <IconEyeOff /> : <IconEyeOpen />}
                  </button>

                  {/* 카테고리 / 세부카테고리 이름 수정 버튼 */}
                  {onStartEdit && (
                    <button
                      className="btn-icon"
                      onClick={(e) => { e.stopPropagation(); onStartEdit(item); }}
                      title="이름 수정"
                      style={{ marginLeft: '4px' }}
                    >
                      <IconEdit />
                    </button>
                  )}

                  {/* 삭제 (결제수단·대분류는 쓰지 않을 때만, 세부카테고리는 참조를 비우고) */}
                  {onDelete && (
                    <button
                      className="btn-icon btn-icon--danger"
                      onClick={(e) => { e.stopPropagation(); onDelete(item); }}
                      title="삭제"
                      style={{ marginLeft: '4px' }}
                    >
                      <IconTrash />
                    </button>
                  )}

                  {/* 드릴다운 버튼 (카테고리 / 결제수단 공용) */}
                  {isClickable && (
                    <button
                      className="btn-drilldown"
                      onClick={(e) => { e.stopPropagation(); onItemClick(item); }}
                      title={drilldownTitle}
                    >
                      <IconChevronRight />
                    </button>
                  )}
                </>
              )}
            </div>
          </React.Fragment>
        );
      })}
      {dropIdx === sortedItems.length && dragId !== null && dragItem && (
        <div className="drop-indicator" />
      )}
    </div>
  );
}

/** 목록 아래 '새 항목 추가' 입력줄 (결제수단 / 카테고리 / 세부카테고리 공용) */
export function AddItemRow({ value, onChange, onSubmit, placeholder }) {
  return (
    <div className="settings-add-row">
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onSubmit(); }}
        placeholder={placeholder}
      />
      <button className="btn-primary" onClick={onSubmit}>+ 추가</button>
    </div>
  );
}
