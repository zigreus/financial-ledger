import React, { useState, useMemo } from 'react';
import {
  getAllPaymentMethods, addPaymentMethod, getPaymentMethodUsage, deletePaymentMethod,
} from '../../../services/dbManager';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import MasterItemList, { AddItemRow } from '../MasterItemList';
import { usageText } from '../settingsUtils';

/** 결제수단 목록 — 정렬·숨기기·삭제·추가, 누르면 할인규칙 드릴다운 */
export default function PaymentSection({ db, dataVersion, onChanged, setError, onDrilldownPaymentChange }) {
  const live = useDbSnapshot(db, dataVersion);
  const [addingName, setAddingName] = useState('');
  const paymentMethods = useMemo(() => getAllPaymentMethods(live.db), [live]);

  const handleDeletePaymentMethod = (item) => {
    try {
      const usage = getPaymentMethodUsage(db, item.name);
      const used = usageText(usage);
      if (used) {
        setError(`"${item.name}"은(는) ${used}에서 사용 중이라 삭제할 수 없습니다. 목록에서 감추려면 숨기기(눈 아이콘)를 사용하세요.`);
        return;
      }
      if (!window.confirm(`"${item.name}"을(를) 삭제하시겠습니까?`)) return;
      deletePaymentMethod(db, item.id);
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleAddItem = () => {
    if (!addingName.trim()) { setError('항목 이름을 입력해주세요.'); return; }
    try {
      addPaymentMethod(db, addingName);
      onChanged();
      setAddingName('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  return (
    <>
      <MasterItemList
        db={db}
        onChanged={onChanged}
        setError={setError}
        items={paymentMethods}
        table="payment_methods"
        onItemClick={(item) => { onDrilldownPaymentChange({ id: item.id, name: item.name }); setError(''); }}
        drilldownTitle="할인규칙 설정"
        onDelete={handleDeletePaymentMethod}
      />
      <AddItemRow value={addingName} onChange={setAddingName} onSubmit={handleAddItem} placeholder="새 결제수단..." />
    </>
  );
}
