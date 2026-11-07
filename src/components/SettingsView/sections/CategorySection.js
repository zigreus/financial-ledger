import React, { useState, useMemo } from 'react';
import {
  getAllBudgetCategories, getAllSubCategories, addBudgetCategory, addSubCategory,
  getSubCategoryUsage, deleteSubCategory, getBudgetCategoryUsage, deleteBudgetCategory,
  renameBudgetCategory, renameSubCategory,
} from '../../../services/dbManager';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import MasterItemList, { AddItemRow } from '../MasterItemList';
import { usageText } from '../settingsUtils';

/** 카테고리 목록과 세부카테고리 드릴다운 — 정렬·숨기기·이름 변경·삭제·추가 */
export default function CategorySection({ db, dataVersion, onChanged, setError, drilldownCategory, onDrilldownCategoryChange }) {
  const live = useDbSnapshot(db, dataVersion);
  const [addingName, setAddingName] = useState('');
  const [editingCategoryId, setEditingCategoryId] = useState(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  const [editingSubCategoryId, setEditingSubCategoryId] = useState(null);
  const [editingSubCategoryName, setEditingSubCategoryName] = useState('');

  const budgetCategories = useMemo(() => getAllBudgetCategories(live.db), [live]);
  const subCategories = useMemo(() => getAllSubCategories(live.db, drilldownCategory?.name || ''), [live, drilldownCategory]);

  // 브라우저 뒤로가기로 드릴다운이 닫힐 때 내부 form state 초기화
  React.useEffect(() => {
    if (!drilldownCategory) {
      setAddingName('');
      setEditingCategoryId(null);
      setEditingCategoryName('');
      setEditingSubCategoryId(null);
      setEditingSubCategoryName('');
    }
  }, [drilldownCategory]);

  const handleAddItem = () => {
    if (!addingName.trim()) { setError('항목 이름을 입력해주세요.'); return; }
    try {
      if (drilldownCategory) addSubCategory(db, drilldownCategory.name, addingName);
      else addBudgetCategory(db, addingName);
      onChanged();
      setAddingName('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  // 확인창 문구 = 실제 동작 (B-020): 거래·정기지출·즐겨찾기의 세부카테고리는 비우고, 전용 할인규칙은 지운다
  const handleDeleteSubCategory = (name) => {
    try {
      const { transactions, recurring, favorites, discountRules } = getSubCategoryUsage(db, drilldownCategory.name, name);
      const lines = [`"${name}"을(를) 삭제하시겠습니까?`];
      const cleared = usageText({ transactions, recurring, favorites });
      if (cleared) {
        lines.push(`· ${cleared}의 세부카테고리가 비워집니다.`);
        // 다른 세부카테고리가 남아 있으면 비워진 거래는 거래내역 '이슈'로 잡힌다 (txValidator requireFields)
        if (transactions > 0 && subCategories.length > 1) lines.push('  (비워진 거래는 거래내역의 이슈 필터에서 다시 분류할 수 있습니다)');
      }
      if (discountRules > 0) lines.push(`· 이 세부카테고리 전용 할인규칙 ${discountRules}건이 삭제됩니다.`);
      if (!window.confirm(lines.join('\n'))) return;
      deleteSubCategory(db, drilldownCategory.name, name);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  // 사용 중인 대분류는 지우지 않는다 — 이름 변경이나 숨기기를 안내 (B-020)
  const handleDeleteBudgetCategory = (item) => {
    try {
      const used = usageText(getBudgetCategoryUsage(db, item.name));
      if (used) {
        setError(`"${item.name}"은(는) ${used}에서 사용 중이라 삭제할 수 없습니다. 이름을 바꾸거나, 목록에서 감추려면 숨기기(눈 아이콘)를 사용하세요.`);
        return;
      }
      if (!window.confirm(`"${item.name}"과(와) 그 세부카테고리를 삭제하시겠습니까?`)) return;
      deleteBudgetCategory(db, item.name);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleRenameBudgetCategory = (item) => {
    if (!editingCategoryName.trim()) { setError('이름을 입력하세요.'); return; }
    try {
      renameBudgetCategory(db, item.name, editingCategoryName);
      onChanged();
      setEditingCategoryId(null);
      setEditingCategoryName('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleRenameSubCategory = (item) => {
    if (!editingSubCategoryName.trim()) { setError('이름을 입력하세요.'); return; }
    try {
      renameSubCategory(db, drilldownCategory.name, item.name, editingSubCategoryName);
      onChanged();
      setEditingSubCategoryId(null);
      setEditingSubCategoryName('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  return (
    <>
      {drilldownCategory ? (
        /* 세부카테고리 (드릴다운) */
        <MasterItemList
          db={db}
          onChanged={onChanged}
          setError={setError}
          items={subCategories}
          table="sub_categories"
          onStartEdit={(item) => { setEditingSubCategoryId(item.id); setEditingSubCategoryName(item.name); setError(''); }}
          editingId={editingSubCategoryId}
          editingName={editingSubCategoryName}
          onEditingNameChange={setEditingSubCategoryName}
          onRenameSubmit={handleRenameSubCategory}
          onEditCancel={() => { setEditingSubCategoryId(null); setEditingSubCategoryName(''); }}
          onDelete={(item) => handleDeleteSubCategory(item.name)}
        />
      ) : (
        /* 대분류 */
        <MasterItemList
          db={db}
          onChanged={onChanged}
          setError={setError}
          items={budgetCategories}
          table="budget_categories"
          onItemClick={(item) => { onDrilldownCategoryChange({ id: item.id, name: item.name }); setAddingName(''); setError(''); }}
          drilldownTitle="세부카테고리 설정"
          onStartEdit={(item) => { setEditingCategoryId(item.id); setEditingCategoryName(item.name); setError(''); }}
          editingId={editingCategoryId}
          editingName={editingCategoryName}
          onEditingNameChange={setEditingCategoryName}
          onRenameSubmit={handleRenameBudgetCategory}
          onEditCancel={() => { setEditingCategoryId(null); setEditingCategoryName(''); }}
          onDelete={handleDeleteBudgetCategory}
        />
      )}
      <AddItemRow
        value={addingName}
        onChange={setAddingName}
        onSubmit={handleAddItem}
        placeholder={drilldownCategory ? '새 세부카테고리...' : '새 카테고리...'}
      />
    </>
  );
}
