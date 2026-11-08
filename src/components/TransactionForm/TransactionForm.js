import React, { useState, useEffect, useRef, useMemo } from 'react';
import { getPaymentMethods, getBudgetCategories, getSubCategories, getCalendarEvents, getCalendarEventTypes, getAutoPaymentMethod, getTripDefaultCategory, getSplitGroupTransactions, getMemberNames } from '../../services/dbManager';
import { resolveDeviceMember } from '../../services/deviceMember';
import { evaluateFormula, today, parseForeignAmount } from '../../services/formulaEvaluator';
import './TransactionForm.css';
import ModalOverlay from '../common/ModalOverlay';
import { useStoredToggle } from '../../hooks/useStoredToggle';
import AIEntry from '../AIEntry/AIEntry';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';
import FormulaInput from './FormulaInput';
import BasicFields from './BasicFields';
import FavoritesBar, { FavoriteStar } from './FavoritesBar';
import TripAmountSection from './TripAmountSection';
import SplitPaymentSection from './SplitPaymentSection';
import MemberPicker from './MemberPicker';
import { useFavorites } from './useFavorites';
import { useTripAmounts } from './useTripAmounts';
import { useSplitPayment, splitFromEditingTx } from './useSplitPayment';
import { useDiscountControl, useAutoDiscount } from './useAutoDiscount';
import { round2 } from './txFormUtils';

// 거래 입력 폼 — 폼 상태를 조립하고 제출한다.
// 영역별 상태·계산은 훅(useTripAmounts, useSplitPayment, useAutoDiscount, useFavorites)이,
// 그리기는 영역 컴포넌트(BasicFields, TripAmountSection, SplitPaymentSection, FavoritesBar)가 맡는다.

const EMPTY_FORM = {
  payment_method: '',
  date: today(),
  budget_category: '',
  sub_category: '',
  detail: '',
  amount: '',
  discount_amount: '',
  event_id: '',
  foreign_amounts: {},
  member: '',
};

function TransactionForm({ db, dataVersion = 0, editingTx, defaultDate, aiStart = null, onSave, onBulkAdd, onQuickAdd, onCancel }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [budgetCategories, setBudgetCategories] = useState([]);
  const [subCategories, setSubCategories] = useState([]);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [eventTypeMap, setEventTypeMap] = useState({});
  const [tripCategory, setTripCategory] = useState('');
  const [continuous, setContinuous] = useStoredToggle('tx_form_continuous');
  const [addedCount, setAddedCount] = useState(0);
  const discount = useDiscountControl();
  // 수정 화면을 처음 채울 때의 카테고리 — 이 카테고리로 바뀔 때는 세부카테고리를 지우지 않는다
  const skipSubResetRef = useRef(null);
  const formRef = useRef(null);

  // 저장 후 백그라운드 새로고침으로 db 객체가 바뀌어도 입력 중인 폼은 건드리지 않는다.
  // 폼 값에만 반응해야 하는 effect는 db를 의존성에 넣지 않고 이 ref로 읽는다.
  const dbRef = useRef(db);
  dbRef.current = db;

  // db 내용이 바뀔 때마다(dataVersion) 새 참조가 되는 스냅샷 — db를 읽는 memo·effect는 live에 의존한다 (B-014, I-010)
  const live = useDbSnapshot(db, dataVersion);
  const members = useMemo(() => getMemberNames(live.db), [live]);

  const amountParsed = evaluateFormula(form.amount);
  // 할인·수익 — 빈칸은 null(=0). 잘못된 수식·음수는 조용히 0으로 바꾸지 않고 막는다 (B-036)
  const discountParsed = evaluateFormula(form.discount_amount);
  const discountInvalid = discountParsed !== null && (isNaN(discountParsed) || discountParsed < 0);
  // 현지 금액 — 빈 칸은 저장하지 않지만, 잘못된 값("1만")을 조용히 빼고 원화만 저장하지 않는다 (B-067)
  const foreignInvalid = Object.values(form.foreign_amounts)
    .some(v => String(v ?? '').trim() !== '' && parseForeignAmount(v) === null);

  // ── 여행 현금 지갑 / 분할 결제 ────────────────────────────────
  const trip = useTripAmounts({ live, form, setForm, calendarEvents, eventTypeMap });
  const sp = useSplitPayment({
    form, amountParsed, activeCurrencies: trip.activeCurrencies, selectedEvent: trip.selectedEvent, editingTx, dbRef,
  });
  const { load: loadSplit, reset: resetSplit, clearBasis: clearSplitBasis } = sp;

  useEffect(() => {
    setPaymentMethods(getPaymentMethods(live.db));
    setBudgetCategories(getBudgetCategories(live.db));
    const types = getCalendarEventTypes(live.db);
    setEventTypeMap(Object.fromEntries(types.map(t => [t.value, t])));
    const events = getCalendarEvents(live.db);
    events.sort((a, b) => {
      if (!a.date_from && !b.date_from) return 0;
      if (!a.date_from) return 1;
      if (!b.date_from) return -1;
      return b.date_from.localeCompare(a.date_from);
    });
    setCalendarEvents(events);
    setTripCategory(getTripDefaultCategory(live.db));
  }, [live]);

  useEffect(() => {
    discount.resetEdited();
    if (editingTx) {
      discount.keepStored();
      skipSubResetRef.current = editingTx.budget_category || null;

      // 분할된 거래면 묶음 전체를 합쳐 총액으로 보여주고 분할 칸을 채워 둔다
      const group = editingTx.split_group_id
        ? getSplitGroupTransactions(dbRef.current, editingTx.split_group_id) : [];
      const sibling = group.find(t => t.id !== editingTx.id) || null;
      const { amount, foreign_amounts, splitState } = splitFromEditingTx(editingTx, sibling);
      loadSplit(splitState);

      setForm({
        payment_method: editingTx.payment_method || '',
        date: editingTx.date || today(),
        budget_category: editingTx.budget_category || '',
        sub_category: editingTx.sub_category || '',
        detail: editingTx.detail || '',
        amount,
        discount_amount: editingTx.discount_amount ? String(editingTx.discount_amount) : '',
        event_id: editingTx.event_id ? String(editingTx.event_id) : '',
        foreign_amounts,
        member: editingTx.member || '',
      });
    } else {
      skipSubResetRef.current = null;
      resetSplit();
      // 새 거래의 '누가'는 이 기기 사용자 (I-013)
      setForm({ ...EMPTY_FORM, date: defaultDate || today(), member: resolveDeviceMember(dbRef.current) });
    }
    setAddedCount(0);
  }, [editingTx, defaultDate, discount, loadSplit, resetSplit]);

  // 세부카테고리 목록 — 앱 어디서든 DB가 바뀌면(dataVersion) 다시 읽는다
  useEffect(() => {
    setSubCategories(getSubCategories(live.db, form.budget_category));
  }, [live, form.budget_category]);

  // 카테고리가 바뀌면 그 카테고리에 없는 세부카테고리를 비운다 (즐겨찾기·AI 입력 등).
  // 수정 화면을 처음 채울 때는 건너뛴다 — 숨긴 세부카테고리도 그대로 남아야 한다 (B-043).
  // 마운트 직후 빈 카테고리로 한 번 도는 실행이 건너뛰기를 소모하지 않도록 카테고리 값으로 비교하고,
  // 대기 중인 상태가 다른 카테고리면(이 실행이 이미 낡았으면) 손대지 않는다.
  useEffect(() => {
    const category = form.budget_category;
    if (skipSubResetRef.current && skipSubResetRef.current === category) {
      skipSubResetRef.current = null;
      return;
    }
    const subs = getSubCategories(dbRef.current, category);
    setForm(prev => (prev.budget_category !== category || !prev.sub_category || subs.includes(prev.sub_category)
      ? prev
      : { ...prev, sub_category: '' }));
  }, [form.budget_category]);

  useAutoDiscount({ control: discount, form, setForm, split: sp.split, primaryKrw: sp.primaryKrw, dbRef });

  // ── 즐겨찾기 ──────────────────────────────────────────────────
  const starAmount = amountParsed === null || isNaN(amountParsed) ? null : amountParsed;
  const favs = useFavorites({ live, form, starAmount });

  const set = (key, value) => {
    if (key === 'payment_method') {
      discount.recalc();
    }
    setForm(prev => ({ ...prev, [key]: value }));
  };

  // 세부카테고리 선택 시 자동 결제수단 선택
  useEffect(() => {
    if (!form.sub_category || form.payment_method) return;
    const suggested = getAutoPaymentMethod(db, form.sub_category);
    if (suggested) {
      discount.recalc();
      setForm(prev => ({ ...prev, payment_method: suggested }));
    }
  }, [db, form.sub_category, form.payment_method, discount]);

  const handleCategoryChange = (value) => {
    setForm(prev => ({ ...prev, budget_category: value, sub_category: '' }));
  };

  // 선택한 일정이 여행 유형이고 카테고리가 비어 있으면 여행 카테고리를 자동 선택
  const handleEventChange = (value) => {
    const ev = calendarEvents.find(e => String(e.id) === value);
    const isTrip = !!eventTypeMap[ev?.event_type]?.is_trip_type;
    setForm(prev => ({
      ...prev,
      event_id: value,
      foreign_amounts: {},
      budget_category: isTrip && tripCategory && !prev.budget_category
        ? tripCategory
        : prev.budget_category,
    }));
    clearSplitBasis();
  };

  // 현지 금액을 고치면 원화가 바뀔 수 있으므로 할인을 다시 계산한다
  const handleForeignAmountChange = (currency, value, countries) => {
    trip.changeForeignAmount(currency, value, countries);
    discount.recalc();
  };

  // 분할을 켜고 끄면 첫 번째 결제수단이 내는 금액이 바뀌므로 할인을 다시 계산한다
  const handleSplitToggle = (checked) => {
    discount.recalc();
    sp.toggle(checked);
  };

  // ── 검사·제출 ────────────────────────────────────────────────
  const discountLabel = form.payment_method === '현금' ? '수익금액' : '할인금액';
  const missingReasons = [
    !form.payment_method && '결제수단을 선택하세요',
    !form.date && '날짜를 입력하세요',
    !form.budget_category && '카테고리를 선택하세요',
    !form.sub_category && '세부카테고리를 선택하세요',
    (amountParsed === null || isNaN(amountParsed)) && '금액을 올바르게 입력하세요',
    discountInvalid && `${discountLabel}을 올바르게 입력하세요`,
    foreignInvalid && '현지 금액을 올바르게 입력하세요',
    sp.splitProblem,
    sp.split && !sp.splitMethod && '나머지 결제수단을 선택하세요',
  ].filter(Boolean);
  const canSubmit = missingReasons.length === 0;

  const handleSubmit = (e) => {
    e.preventDefault();
    // 버튼이 비활성이어도 다른 경로로 제출될 수 있으니 같은 검사를 한 번 더 한다
    if (!canSubmit) return;

    const discountAmount = discountParsed || 0;

    // 폼에 있는 현지 금액은 일정 연결 여부와 상관없이 저장한다.
    // 일정을 바꾸거나 풀면 handleEventChange가 비우므로, 여기 남은 값은 사용자가 보고 있는 칸의 값이다.
    // (일정이 지워져 event_id가 없는 거래도 외화 금액을 잃지 않게 — B-060)
    const foreign_amounts = {};
    Object.entries(form.foreign_amounts).forEach(([currency, val]) => {
      const num = parseForeignAmount(val);
      if (num !== null && num > 0) foreign_amounts[currency] = round2(num);
    });

    const base = {
      date: form.date,
      budget_category: form.budget_category,
      sub_category: form.sub_category,
      detail: form.detail,
      event_id: form.event_id ? Number(form.event_id) : null,
      member: form.member || '',
    };

    // 분할 결제 — 한 번의 구매를 두 결제수단으로 나눠 2건으로 기록한다.
    // 수정 중이면 기존 건을 첫 번째 몫으로 갱신하고, 나머지 몫은
    // 짝이 있으면 갱신 / 없으면 새로 만든다 (id 유무로 구분).
    // 할인 메모(discount_note)는 폼에서 고치지 않으므로 저장된 값을 그대로 넘긴다 (B-031)
    if (sp.split) {
      const groupId = editingTx?.split_group_id
        || `sg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const primaryForeign = {};
      const secondForeign = {};
      if (sp.splitCurrency !== 'KRW') {
        primaryForeign[sp.splitCurrency] = round2(sp.splitPrimary);
        secondForeign[sp.splitCurrency] = sp.secondaryForeign;
      }

      submit([
        { ...base, id: editingTx?.id, payment_method: form.payment_method, amount: sp.primaryKrw,
          discount_amount: discountAmount, discount_note: editingTx?.discount_note || '',
          foreign_amounts: primaryForeign, split_group_id: groupId },
        { ...base, id: sp.splitSibling?.id, payment_method: sp.splitMethod, amount: sp.secondaryKrw,
          discount_amount: sp.secondDiscount, discount_note: sp.splitSibling?.discount_note || '',
          foreign_amounts: secondForeign, split_group_id: groupId },
      ]);
      return;
    }

    // 분할을 해제한 경우 — 짝은 App에서 정리된다 (rows에 없는 묶음 멤버는 삭제)
    submit({
      ...base,
      id: editingTx?.id,
      payment_method: form.payment_method,
      amount: amountParsed,
      discount_amount: discountAmount,
      discount_note: editingTx?.discount_note || '',
      foreign_amounts,
      split_group_id: '',
    });
  };

  // 연속 입력이면 창을 닫지 않고 저장은 뒤에서 진행, 폼은 다음 거래용으로 비운다
  const submit = (payload) => {
    const keepOpen = continuous && !editingTx;
    onSave(payload, { keepOpen });
    if (keepOpen) resetForNext();
  };

  // 다음 거래 입력용 초기화 — 날짜·결제수단·카테고리·일정·누가는 유지한다
  const resetForNext = () => {
    discount.recalc();
    discount.resetEdited();
    setForm(prev => ({
      ...EMPTY_FORM,
      date: prev.date,
      payment_method: prev.payment_method,
      budget_category: prev.budget_category,
      event_id: prev.event_id,
      member: prev.member,
    }));
    resetSplit();
    setAddedCount(c => c + 1);
    const scroller = formRef.current?.closest('.modal-content');
    if (scroller) scroller.scrollTop = 0;
  };

  // AI(영수증·말로 입력) 결과로 폼을 채운다 — 저장은 사용자가 확인한 뒤 직접 한다
  const applyReceipt = (s) => {
    discount.recalc();
    discount.resetEdited();
    resetSplit();
    setForm(prev => {
      const next = {
        ...prev,
        date: s.date || prev.date,
        detail: s.detail || prev.detail,
        payment_method: s.payment_method || prev.payment_method,
        budget_category: s.budget_category || prev.budget_category,
        sub_category: s.budget_category ? s.sub_category : prev.sub_category,
      };
      if (s.event_id) {
        next.event_id = String(s.event_id);
        next.foreign_amounts = s.foreignAmount !== null ? { [s.currency]: String(s.foreignAmount) } : {};
      }
      if (s.amount !== null) next.amount = String(s.amount);
      return next;
    });
  };

  // 영수증·말로 입력·카드 문자로 여러 건을 한 번에 넣을 때도 폼에서 고른 '누가'를 쓴다
  const withFormMember = rows => rows.map(r => (r.member === undefined ? { ...r, member: form.member || '' } : r));
  const bulkAdd = (rows, opts) => onBulkAdd(withFormMember(rows), opts);
  // AI 입력이 자주 넣던 거래를 바로 넣을 때 (I-022) — 확인할 것이 없으면(done) 입력 창을 닫는다
  const quickAdd = (rows, opts) => (onQuickAdd ? onQuickAdd(withFormMember(rows), opts) : onBulkAdd(withFormMember(rows)));

  const applyFavorite = (fav) => {
    favs.recordUse(fav);
    setForm(prev => ({
      ...prev,
      payment_method: fav.payment_method,
      budget_category: fav.budget_category,
      sub_category: fav.sub_category,
      detail: fav.detail,
      // 금액이 없는 즐겨찾기는 직접 입력하도록 기존 값을 그대로 둔다
      ...(fav.amount == null ? {} : { amount: String(fav.amount) }),
    }));
  };

  return (
    <ModalOverlay className="modal-overlay" panelClassName="modal-content">
        <div className="modal-header">
          <h2>
            {editingTx ? '거래 수정' : '거래 추가'}
            {addedCount > 0 && (
              <span className="continuous-count">{addedCount}건 추가됨</span>
            )}
            <FavoriteStar fav={favs} />
          </h2>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>

        <form onSubmit={handleSubmit} className="tx-form" ref={formRef}>
          {/* AI 입력 — 영수증 사진 / 말로 입력 */}
          {!editingTx && (
            <AIEntry db={db} start={aiStart} onApply={applyReceipt} onBulkAdd={bulkAdd} onQuickAdd={quickAdd} resetKey={addedCount} />
          )}

          {/* 즐겨찾기 칩 */}
          <FavoritesBar
            favorites={favs.favorites}
            starredFavoriteId={favs.starredFavoriteId}
            onApply={applyFavorite}
          />

          <BasicFields
            form={form}
            onChange={set}
            onCategoryChange={handleCategoryChange}
            onEventChange={handleEventChange}
            paymentMethods={paymentMethods}
            budgetCategories={budgetCategories}
            subCategories={subCategories}
            calendarEvents={calendarEvents}
            eventTypeMap={eventTypeMap}
          />

          <MemberPicker members={members} value={form.member} onChange={v => set('member', v)} />

          {/* 남은 현금 · 현지 금액 */}
          <TripAmountSection
            form={form}
            trip={trip}
            amountParsed={amountParsed}
            onForeignChange={handleForeignAmountChange}
            onStoredForeignChange={trip.changeStoredForeign}
          />

          {/* 금액 */}
          <FormulaInput
            label="금액"
            value={form.amount}
            onChange={v => set('amount', v)}
            required
          />

          {/* 분할 결제 */}
          <SplitPaymentSection
            sp={sp}
            form={form}
            editingTx={editingTx}
            paymentMethods={paymentMethods}
            amountParsed={amountParsed}
            discountParsed={discountParsed}
            onToggle={handleSplitToggle}
          />

          {/* 할인/수익 정보 */}
          <div className="form-section-title">
            {form.payment_method === '현금' ? '수익 정보' : '할인/혜택 정보'}
            <span className="optional">(선택)</span>
          </div>
          <div className="form-row">
            <FormulaInput
              label={sp.split && form.payment_method !== '현금'
                ? `${discountLabel} (${form.payment_method || '첫 번째 결제수단'} 몫)`
                : discountLabel}
              value={form.discount_amount}
              onChange={v => { discount.markEdited(); set('discount_amount', v); }}
              placeholder="0"
            />
          </div>

          {!editingTx && (
            <label className="continuous-toggle">
              <input
                type="checkbox"
                checked={continuous}
                onChange={e => setContinuous(e.target.checked)}
              />
              <span>
                <b>연속 입력</b>
                <small>추가 후 창을 닫지 않고 바로 다음 거래 입력 (날짜·결제수단·카테고리·일정·누가 유지)</small>
              </span>
            </label>
          )}

          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onCancel}>
              {addedCount > 0 ? '닫기' : '취소'}
            </button>
            <div className="submit-tooltip-wrapper" onClick={e => { if (!canSubmit) e.currentTarget.classList.toggle('tooltip-visible'); }}>
              <button type="submit" className="btn-primary" disabled={!canSubmit}>
                {editingTx ? '수정' : continuous ? '추가하고 계속' : '추가'}
              </button>
              {!canSubmit && (
                <div className="submit-tooltip">
                  {missingReasons.map((r, i) => <span key={i}>• {r}{'\n'}</span>)}
                </div>
              )}
            </div>
          </div>
        </form>
    </ModalOverlay>
  );
}

export default TransactionForm;
