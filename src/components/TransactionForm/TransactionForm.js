import React, { useState, useEffect, useRef, useMemo } from 'react';
import { getPaymentMethods, getBudgetCategories, getSubCategories, getDiscountRules, evaluateDiscountRule, getCalendarEvents, getCalendarEventTypes, getFavorites, addFavorite, updateFavorite, deleteFavorite, recordFavoriteUse, getAutoPaymentMethod, getTripDefaultCategory, getEventWallets, getSplitGroupTransactions } from '../../services/dbManager';
import { evaluateFormula, formatAmount, today, parseRate, parseForeignAmount, toKrw } from '../../services/formulaEvaluator';
import './TransactionForm.css';
import ModalOverlay from '../common/ModalOverlay';
import AmountInput from '../common/AmountInput';
import { useStoredToggle } from '../../hooks/useStoredToggle';
import AIEntry from '../AIEntry/AIEntry';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';


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
};

// 라벨이 붙은 금액 입력 — 수식·툴바·미리보기는 공통 AmountInput이 처리
function FormulaInput({ label, value, onChange, required, placeholder }) {
  return (
    <div className="form-group">
      <label>{label}{required && <span className="required">*</span>}</label>
      <AmountInput
        value={value}
        onChange={onChange}
        placeholder={placeholder || '금액 (예: 12000+3000)'}
      />
    </div>
  );
}

/**
 * 환율이 설정된 통화들의 현지 금액을 합산해 원화 금액을 계산합니다.
 * - 환율이 설정된 통화가 하나도 없으면 null (금액 필드를 건드리지 않음)
 * - 입력 중인 미완성 수식이 있어도 null (타이핑 중 금액이 0으로 튀지 않도록)
 * - 환율은 있으나 입력값이 모두 비어 있으면 '' (금액 필드를 비움)
 */
function krwFromForeign(foreignAmounts, countries) {
  const rated = (countries || []).filter(c => parseRate(c.exchange_rate) > 0);
  if (!rated.length) return null;

  let total = 0;
  let hasInput = false;
  let hasInvalid = false;
  rated.forEach(c => {
    const raw = foreignAmounts[c.currency];
    if (raw === undefined || String(raw).trim() === '') return;
    hasInput = true;
    const parsed = parseForeignAmount(raw);
    if (parsed === null) hasInvalid = true;
    else total += parsed * parseRate(c.exchange_rate);
  });

  if (hasInvalid) return null;
  if (!hasInput) return '';
  return String(Math.round(total));
}

/** 지갑 잔액 표시 — 현지 통화는 소수점 2자리, 원화는 정수 */
function fmtWallet(value, currency) {
  if (currency === 'KRW') return formatAmount(Math.round(value));
  return (Math.round(value * 100) / 100).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

/** 외화 금액은 소수 둘째 자리까지 — 0.1+0.2 같은 부동소수 찌꺼기가 저장되지 않게 */
const round2 = (n) => Math.round(n * 100) / 100;

const parseFa = (raw) => {
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
};

function TransactionForm({ db, dataVersion = 0, editingTx, defaultDate, onSave, onBulkAdd, onCancel }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [budgetCategories, setBudgetCategories] = useState([]);
  const [subCategories, setSubCategories] = useState([]);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [eventTypeMap, setEventTypeMap] = useState({});
  const [favorites, setFavorites] = useState([]);
  const [starredFavoriteId, setStarredFavoriteId] = useState(null);
  const [showStarPopup, setShowStarPopup] = useState(false);
  const [starName, setStarName] = useState('');
  const [tripCategory, setTripCategory] = useState('');
  const [split, setSplit] = useState(false);
  const [splitAmount, setSplitAmount] = useState('');
  const [splitMethod, setSplitMethod] = useState('');
  const [splitSibling, setSplitSibling] = useState(null);
  // 나눠 낸 금액을 어느 통화로 입력했는지 — 통화가 바뀌면 그 숫자를 다른 통화로 해석하지 않는다
  const [splitAmountCur, setSplitAmountCur] = useState('KRW');
  // 수정 중인 분할 거래의 저장된 외화 환율 { currency, rate } — 일정 환율이 바뀌어도 원래 몫을 유지
  const [splitBasis, setSplitBasis] = useState(null);
  const [continuous, setContinuous] = useStoredToggle('tx_form_continuous');
  const [addedCount, setAddedCount] = useState(0);
  const skipAutoDiscountRef = useRef(false);
  // 수정 화면을 처음 채울 때의 카테고리 — 이 카테고리로 바뀔 때는 세부카테고리를 지우지 않는다
  const skipSubResetRef = useRef(null);
  // 사용자가 할인/수익 칸을 직접 고쳤는지 — 자동 계산값만 결제수단 변경 시 비운다
  const discountTouchedRef = useRef(false);
  const formRef = useRef(null);

  // 저장 후 백그라운드 새로고침으로 db 객체가 바뀌어도 입력 중인 폼은 건드리지 않는다.
  // 폼 값에만 반응해야 하는 effect는 db를 의존성에 넣지 않고 이 ref로 읽는다.
  const dbRef = useRef(db);
  dbRef.current = db;

  // db 내용이 바뀔 때마다(dataVersion) 새 참조가 되는 스냅샷 — db를 읽는 memo·effect는 live에 의존한다 (B-014, I-010)
  const live = useDbSnapshot(db, dataVersion);
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
    setFavorites(getFavorites(live.db));
    setTripCategory(getTripDefaultCategory(live.db));
  }, [live]);

  useEffect(() => {
    discountTouchedRef.current = false;
    if (editingTx) {
      skipAutoDiscountRef.current = true;
      skipSubResetRef.current = editingTx.budget_category || null;
      let foreign_amounts = parseFa(editingTx.foreign_amounts);
      let amount = editingTx.amount != null ? String(editingTx.amount) : '';

      // 분할된 거래를 열면 묶음 전체를 합쳐 총액으로 보여주고 분할 칸을 채워 둔다
      const group = editingTx.split_group_id
        ? getSplitGroupTransactions(dbRef.current, editingTx.split_group_id) : [];
      const sibling = group.find(t => t.id !== editingTx.id) || null;

      let basis = null;
      if (sibling) {
        const totals = { ...foreign_amounts };
        Object.entries(parseFa(sibling.foreign_amounts)).forEach(([cur, val]) => {
          totals[cur] = round2((Number(totals[cur]) || 0) + Number(val));
        });
        foreign_amounts = totals;
        amount = String((editingTx.amount || 0) + (sibling.amount || 0));

        // 분할 통화·환율은 저장된 값에서 정한다 — 보이는 일정 목록이나 현재 일정 환율에서 다시 구하면
        // 일정을 숨기거나 지웠을 때 ¥3000이 3,000원으로 읽히고, 환율이 바뀌면 원화 몫이 달라진다 (B-033, B-060)
        const ownEntry = Object.entries(parseFa(editingTx.foreign_amounts)).find(([, v]) => Number(v) > 0);
        const totalCurs = Object.keys(totals).filter(cur => Number(totals[cur]) > 0);
        let ownSplit = '';
        let ownSplitCur = 'KRW';
        if (ownEntry && totalCurs.length === 1 && totalCurs[0] === ownEntry[0]) {
          ownSplit = String(ownEntry[1]);
          ownSplitCur = ownEntry[0];
          if (editingTx.amount > 0) basis = { currency: ownEntry[0], rate: editingTx.amount / Number(ownEntry[1]) };
        } else if (totalCurs.length === 0) {
          ownSplit = editingTx.amount != null ? String(editingTx.amount) : '';
        }
        // 그 밖(저장된 외화가 엇갈림)은 나눠 낸 금액을 다시 입력받는다
        setSplit(true);
        setSplitAmount(ownSplit);
        setSplitAmountCur(ownSplitCur);
        setSplitMethod(sibling.payment_method || '');
      } else {
        setSplit(false);
        setSplitAmount('');
        setSplitAmountCur('KRW');
        setSplitMethod('');
      }
      setSplitBasis(basis);
      setSplitSibling(sibling);

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
      });
    } else {
      skipSubResetRef.current = null;
      setSplit(false);
      setSplitAmount('');
      setSplitAmountCur('KRW');
      setSplitMethod('');
      setSplitBasis(null);
      setSplitSibling(null);
      setForm({ ...EMPTY_FORM, date: defaultDate || today() });
    }
    setAddedCount(0);
  }, [editingTx, defaultDate]);

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

  const set = (key, value) => {
    if (key === 'payment_method') {
      skipAutoDiscountRef.current = false;
    }
    setForm(prev => ({ ...prev, [key]: value }));
  };

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
    setSplitBasis(null);
  };

  // 현지 금액 입력 → 여행에 설정된 환율로 원화 금액 자동 계산.
  // 환율이 없는 통화 칸은 원화 금액을 건드리지 않는다 — 먼저 입력한 원화가 지워지지 않게 (B-035)
  const handleForeignAmountChange = (currency, value, countries) => {
    const rated = countries.some(c => c.currency === currency && parseRate(c.exchange_rate) > 0);
    setForm(prev => {
      const foreign_amounts = { ...prev.foreign_amounts, [currency]: value };
      const krw = rated ? krwFromForeign(foreign_amounts, countries) : null;
      return {
        ...prev,
        foreign_amounts,
        ...(krw === null ? {} : { amount: krw }),
      };
    });
    skipAutoDiscountRef.current = false;
  };

  // 일정에 없는 통화로 저장된 현지 금액 — 환율을 모르므로 원화는 다시 계산하지 않고 값만 고친다 (B-060)
  const handleStoredForeignChange = (currency, value) => {
    setForm(prev => ({ ...prev, foreign_amounts: { ...prev.foreign_amounts, [currency]: value } }));
  };

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
    };

    // 분할 결제 — 한 번의 구매를 두 결제수단으로 나눠 2건으로 기록한다.
    // 수정 중이면 기존 건을 첫 번째 몫으로 갱신하고, 나머지 몫은
    // 짝이 있으면 갱신 / 없으면 새로 만든다 (id 유무로 구분).
    // 할인 메모(discount_note)는 폼에서 고치지 않으므로 저장된 값을 그대로 넘긴다 (B-031)
    if (split) {
      const groupId = editingTx?.split_group_id
        || `sg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const primaryForeign = {};
      const secondForeign = {};
      if (splitCurrency !== 'KRW') {
        primaryForeign[splitCurrency] = round2(splitPrimary);
        secondForeign[splitCurrency] = secondaryForeign;
      }

      submit([
        { ...base, id: editingTx?.id, payment_method: form.payment_method, amount: primaryKrw,
          discount_amount: discountAmount, discount_note: editingTx?.discount_note || '',
          foreign_amounts: primaryForeign, split_group_id: groupId },
        { ...base, id: splitSibling?.id, payment_method: splitMethod, amount: secondaryKrw,
          discount_amount: secondDiscount, discount_note: splitSibling?.discount_note || '',
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

  // 다음 거래 입력용 초기화 — 날짜·결제수단·카테고리·일정은 유지한다
  const resetForNext = () => {
    skipAutoDiscountRef.current = false;
    discountTouchedRef.current = false;
    setForm(prev => ({
      ...EMPTY_FORM,
      date: prev.date,
      payment_method: prev.payment_method,
      budget_category: prev.budget_category,
      event_id: prev.event_id,
    }));
    setSplit(false);
    setSplitAmount('');
    setSplitAmountCur('KRW');
    setSplitMethod('');
    setSplitBasis(null);
    setSplitSibling(null);
    setAddedCount(c => c + 1);
    const scroller = formRef.current?.closest('.modal-content');
    if (scroller) scroller.scrollTop = 0;
  };


  const amountParsed = evaluateFormula(form.amount);
  // 할인·수익 — 빈칸은 null(=0). 잘못된 수식·음수는 조용히 0으로 바꾸지 않고 막는다 (B-036)
  const discountParsed = evaluateFormula(form.discount_amount);
  const discountInvalid = discountParsed !== null && (isNaN(discountParsed) || discountParsed < 0);

  // ── 여행 현금 지갑 / 분할 결제 ────────────────────────────────
  const selectedEvent = calendarEvents.find(e => String(e.id) === form.event_id);
  const selectedEventId = selectedEvent?.id;
  const isTripEvent = !!eventTypeMap[selectedEvent?.event_type]?.is_trip_type;
  // 지갑 계산은 SQL 여러 번이라 키 입력마다 돌리지 않는다 — 일정이나 DB가 바뀔 때만 (B-046)
  const wallets = useMemo(
    () => (isTripEvent && selectedEventId
      ? getEventWallets(live.db, selectedEventId).filter(w => Math.abs(w.balance) >= 0.005)
      : []),
    [live, isTripEvent, selectedEventId]
  );

  // 현지 금액이 입력된 통화 — 저장될 값(foreign_amounts) 기준으로 센다.
  // 보이는 일정 목록에서 구하면 일정을 숨기거나 지웠을 때 외화가 사라진 것처럼 보인다 (B-033, B-060)
  const activeCurrencies = Object.keys(form.foreign_amounts)
    .filter(cur => (parseForeignAmount(form.foreign_amounts[cur]) || 0) > 0);
  // 연결된 여행 일정의 통화 칸에 없는, 저장된 현지 금액 — 따로 칸을 보여 줘 값을 확인·수정할 수 있게 한다
  const eventCurrencies = isTripEvent ? (selectedEvent?.countries || []).map(c => c.currency) : [];
  const storedOnlyCurrencies = Object.keys(form.foreign_amounts).filter(cur => !eventCurrencies.includes(cur));
  // 한 통화에만 들어있으면 그 통화로 나누고, 없으면 원화로 나눈다.
  // 두 통화 이상이면 몫을 정할 수 없으므로 분할을 막는다 — 외화가 버려지지 않게 (B-034)
  const multiCurrency = activeCurrencies.length > 1;
  const splitCurrency = activeCurrencies.length === 1 ? activeCurrencies[0] : 'KRW';
  const splitTotalForeign = splitCurrency !== 'KRW'
    ? parseForeignAmount(form.foreign_amounts[splitCurrency]) : null;

  // 환율: 수정 중인 분할 거래는 저장된 환율 → 일정 환율 → 이번 거래가 함축하는 환율(총 원화 ÷ 총 현지금액)
  const basisRate = splitBasis && splitBasis.currency === splitCurrency ? splitBasis.rate : 0;
  const eventRate = parseRate((selectedEvent?.countries || []).find(c => c.currency === splitCurrency)?.exchange_rate);
  const impliedRate = splitTotalForeign > 0 && amountParsed > 0
    ? amountParsed / splitTotalForeign : 0;
  const effectiveSplitRate = basisRate || eventRate || impliedRate;

  // 나눠 낸 금액은 입력할 때의 통화로만 해석한다 — 통화가 바뀌었으면 다시 입력받는다
  const splitCurrencyChanged = split && splitAmount.trim() !== '' && splitAmountCur !== splitCurrency;
  const splitPrimary = splitCurrencyChanged ? null : parseForeignAmount(splitAmount);
  const primaryKrw = splitPrimary === null ? null
    : splitCurrency === 'KRW' ? Math.round(splitPrimary) : Math.round(splitPrimary * effectiveSplitRate);
  const secondaryKrw = primaryKrw === null || amountParsed === null || isNaN(amountParsed)
    ? null : amountParsed - primaryKrw;
  const secondaryForeign = splitTotalForeign !== null && splitPrimary !== null
    ? Number((splitTotalForeign - splitPrimary).toFixed(2)) : null;

  const splitAmountsOk = splitPrimary !== null && splitPrimary > 0 &&
    primaryKrw > 0 && secondaryKrw > 0 &&
    (secondaryForeign === null || secondaryForeign > 0);
  const splitValid = !split || (!multiCurrency && splitAmountsOk && !!splitMethod);
  const splitProblem = !split ? null
    : multiCurrency ? '현지 금액이 두 통화 이상이면 분할할 수 없습니다'
    : splitCurrencyChanged ? `분할 통화가 ${splitCurrency}(으)로 바뀌었습니다 — 나눠 낸 금액을 다시 입력하세요`
    : splitPrimary === null ? '나눠 낸 금액을 입력하세요'
    : !splitAmountsOk ? '분할 금액이 총액보다 작아야 합니다'
    : null;

  // 나머지 몫의 할인 — 그 결제수단·그 금액 기준으로 계산한다.
  // 수정 중인 짝의 결제수단·금액·분류가 그대로면 저장된 할인을 유지한다 (직접 고친 값 보존)
  const ruleSecondDiscount = useMemo(() => {
    if (!split || !splitMethod || splitMethod === '현금' || !(secondaryKrw > 0)) return 0;
    return evaluateDiscountRule(getDiscountRules(dbRef.current, splitMethod),
      form.budget_category, form.sub_category, secondaryKrw, form.detail) || 0;
  }, [split, splitMethod, secondaryKrw, form.budget_category, form.sub_category, form.detail]);
  const siblingUnchanged = !!splitSibling && splitMethod === splitSibling.payment_method
    && secondaryKrw === splitSibling.amount
    && form.budget_category === (editingTx?.budget_category || '')
    && form.sub_category === (editingTx?.sub_category || '')
    && form.detail === (editingTx?.detail || '');
  const secondDiscount = siblingUnchanged ? (splitSibling.discount_amount || 0) : ruleSecondDiscount;

  // 결제수단별 자동 할인 계산 (DB 규칙 기반).
  // 분할 결제면 첫 번째 결제수단이 실제로 낸 몫(primaryKrw)에만 할인을 계산한다 (B-030)
  useEffect(() => {
    if (skipAutoDiscountRef.current) return;
    const pm = form.payment_method;
    if (!pm || pm === '현금') {
      // 카드 기준으로 자동 계산해 둔 할인은 현금 '수익'이 아니다 — 직접 입력한 값이 아니면 비운다 (B-032)
      if (!discountTouchedRef.current) {
        setForm(prev => (prev.discount_amount ? { ...prev, discount_amount: '' } : prev));
      }
      return;
    }

    discountTouchedRef.current = false;
    const base = split ? primaryKrw : evaluateFormula(form.amount);
    if (base === null || isNaN(base) || base <= 0) {
      setForm(prev => ({ ...prev, discount_amount: '' }));
      return;
    }

    const rules = getDiscountRules(dbRef.current, pm);
    const d = evaluateDiscountRule(rules, form.budget_category, form.sub_category, base, form.detail);
    setForm(prev => ({ ...prev, discount_amount: d > 0 ? String(d) : '' }));
  }, [form.payment_method, form.amount, form.budget_category, form.sub_category, form.detail, split, primaryKrw]);

  const discountLabel = form.payment_method === '현금' ? '수익금액' : '할인금액';
  const missingReasons = [
    !form.payment_method && '결제수단을 선택하세요',
    !form.date && '날짜를 입력하세요',
    !form.budget_category && '카테고리를 선택하세요',
    !form.sub_category && '세부카테고리를 선택하세요',
    (amountParsed === null || isNaN(amountParsed)) && '금액을 올바르게 입력하세요',
    discountInvalid && `${discountLabel}을 올바르게 입력하세요`,
    splitProblem,
    split && !splitMethod && '나머지 결제수단을 선택하세요',
  ].filter(Boolean);
  const canSubmit = missingReasons.length === 0;

  // ── 즐겨찾기 로직 ──────────────────────────────────────────────

  // 금액은 선택 — 결제수단/카테고리/세부카테고리 3개만 있으면 즐겨찾기 가능
  const canStar = !!(form.payment_method && form.budget_category && form.sub_category);
  const starAmount = amountParsed === null || isNaN(amountParsed) ? null : amountParsed;

  // 현재 폼이 기존 즐겨찾기와 일치하는지 확인
  useEffect(() => {
    if (!form.payment_method || !form.budget_category || !form.sub_category) {
      setStarredFavoriteId(null);
      return;
    }
    const matched = favorites.find(f =>
      f.payment_method === form.payment_method &&
      f.budget_category === form.budget_category &&
      f.sub_category === form.sub_category &&
      f.detail === form.detail &&
      (f.amount ?? null) === starAmount
    );
    setStarredFavoriteId(matched ? matched.id : null);
  }, [form, favorites, starAmount]);

  // 세부카테고리 선택 시 자동 결제수단 선택
  useEffect(() => {
    if (!form.sub_category || form.payment_method) return;
    const suggested = getAutoPaymentMethod(db, form.sub_category);
    if (suggested) {
      skipAutoDiscountRef.current = false;
      set('payment_method', suggested);
    }
  }, [db, form.sub_category, form.payment_method]);

  const autoFavoriteName = () => form.detail || `${form.payment_method}-${form.sub_category}`;

  const handleStarClick = () => {
    if (!canStar) return;
    if (starredFavoriteId) {
      setShowStarPopup(true);
      setStarName(favorites.find(f => f.id === starredFavoriteId)?.name || '');
    } else {
      const newName = autoFavoriteName();
      addFavorite(db, {
        name: newName,
        payment_method: form.payment_method,
        budget_category: form.budget_category,
        sub_category: form.sub_category,
        detail: form.detail,
        amount: starAmount,
      });
      setFavorites(getFavorites(db));
      setStarName(newName);
      setShowStarPopup(true);
    }
  };

  const handleStarPopupClose = () => {
    if (!starredFavoriteId || !starName.trim()) {
      setShowStarPopup(false);
      return;
    }
    updateFavorite(db, starredFavoriteId, {
      name: starName,
      payment_method: form.payment_method,
      budget_category: form.budget_category,
      sub_category: form.sub_category,
      detail: form.detail,
      amount: starAmount,
    });
    setFavorites(getFavorites(db));
    setShowStarPopup(false);
  };

  const handleStarRemove = () => {
    if (starredFavoriteId) {
      deleteFavorite(db, starredFavoriteId);
      setFavorites(getFavorites(db));
      setStarredFavoriteId(null);
    }
    setShowStarPopup(false);
  };

  // AI(영수증·말로 입력) 결과로 폼을 채운다 — 저장은 사용자가 확인한 뒤 직접 한다
  const applyReceipt = (s) => {
    skipAutoDiscountRef.current = false;
    discountTouchedRef.current = false;
    setSplit(false);
    setSplitAmount('');
    setSplitAmountCur('KRW');
    setSplitMethod('');
    setSplitBasis(null);
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

  const applyFavorite = (fav) => {
    recordFavoriteUse(db, fav.id);
    setFavorites(getFavorites(db));
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
            <button
              type="button"
              className={`btn-star ${!canStar ? 'disabled' : ''} ${starredFavoriteId ? 'active' : ''}`}
              onClick={handleStarClick}
              disabled={!canStar}
              title={canStar ? '즐겨찾기' : '결제수단, 카테고리, 세부카테고리를 모두 선택하세요'}
            >
              {starredFavoriteId ? '★' : '☆'}
            </button>
            {showStarPopup && (
              <div className="star-popup">
                <input
                  type="text"
                  value={starName}
                  onChange={e => setStarName(e.target.value)}
                  placeholder={autoFavoriteName()}
                  autoFocus
                />
                <div className="star-popup-buttons">
                  {starredFavoriteId && (
                    <button type="button" className="btn-secondary" onClick={handleStarRemove}>
                      해제
                    </button>
                  )}
                  <button type="button" className="btn-primary" onClick={handleStarPopupClose}>
                    완료
                  </button>
                </div>
              </div>
            )}
          </h2>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>

        <form onSubmit={handleSubmit} className="tx-form" ref={formRef}>
          {/* AI 입력 — 영수증 사진 / 말로 입력 */}
          {!editingTx && (
            <AIEntry db={db} onApply={applyReceipt} onBulkAdd={onBulkAdd} resetKey={addedCount} />
          )}

          {/* 즐겨찾기 칩 */}
          {favorites.length > 0 && (
            <div className="favorite-chips">
              {favorites.map(fav => (
                <button
                  key={fav.id}
                  type="button"
                  className={`favorite-chip ${starredFavoriteId === fav.id ? 'active' : ''}`}
                  onClick={() => applyFavorite(fav)}
                >
                  ★ {fav.name}
                </button>
              ))}
            </div>
          )}

          {/* 날짜 */}
          <div className="form-group">
            <label>날짜<span className="required">*</span></label>
            <input
              type="date"
              value={form.date}
              onChange={e => set('date', e.target.value)}
              required
            />
          </div>

          {/* 결제수단 */}
          <div className="form-group">
            <label>결제수단<span className="required">*</span></label>
            <select
              value={form.payment_method}
              onChange={e => set('payment_method', e.target.value)}
              required
            >
              <option value="">선택</option>
              {paymentMethods.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
              {/* 숨긴 결제수단으로 기록된 거래를 수정할 때도 현재 값이 보이도록 */}
              {form.payment_method && !paymentMethods.includes(form.payment_method) && (
                <option value={form.payment_method}>{form.payment_method} (숨김)</option>
              )}
            </select>
          </div>

          {/* 카테고리 */}
          <div className="form-row">
            <div className="form-group">
              <label>카테고리<span className="required">*</span></label>
              <select
                value={form.budget_category}
                onChange={e => handleCategoryChange(e.target.value)}
                required
              >
                <option value="">선택</option>
                {budgetCategories.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
                {form.budget_category && !budgetCategories.includes(form.budget_category) && (
                  <option value={form.budget_category}>{form.budget_category} (숨김)</option>
                )}
              </select>
            </div>

            <div className="form-group">
              <label>세부카테고리<span className="required">*</span></label>
              <select
                value={form.sub_category}
                onChange={e => set('sub_category', e.target.value)}
                required
                disabled={!form.budget_category}
              >
                <option value="">선택</option>
                {subCategories.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
                {/* 숨긴 세부카테고리를 가진 거래를 수정할 때 값이 그대로 보이게 (B-043) */}
                {form.sub_category && !subCategories.includes(form.sub_category) && (
                  <option value={form.sub_category}>{form.sub_category} (숨김)</option>
                )}
              </select>
            </div>
          </div>

          {/* 세부내역 */}
          <div className="form-group">
            <label>세부내역 <span className="optional">(선택)</span></label>
            <input
              type="text"
              value={form.detail}
              onChange={e => set('detail', e.target.value)}
              placeholder="예: 김치찌개, 스타벅스 아메리카노"
            />
          </div>

          {/* 일정 연결 */}
          {calendarEvents.length > 0 && (
            <div className="form-group">
              <label>일정 <span className="optional">(선택)</span></label>
              <select
                value={form.event_id}
                onChange={e => handleEventChange(e.target.value)}
              >
                <option value="">없음</option>
                {calendarEvents.map(ev => {
                  const color = ev.color || eventTypeMap[ev.event_type]?.color || '#9CA3AF';
                  const dateLabel = ev.date_from
                    ? ev.date_to && ev.date_to !== ev.date_from
                      ? ` (${ev.date_from.slice(0, 4)}, ${ev.date_from.slice(5)} ~ ${ev.date_to.slice(5)})`
                      : ` (${ev.date_from.slice(0, 4)}, ${ev.date_from.slice(5)})`
                    : '';
                  return (
                    <option key={ev.id} value={String(ev.id)} style={{ color }}>
                      {ev.title}{dateLabel}
                    </option>
                  );
                })}
              </select>
            </div>
          )}

          {/* 남은 현금 (여행 지갑) */}
          {wallets.length > 0 && (
            <div className={`wallet-badge${form.payment_method === '현금' ? ' active' : ''}`}>
              <span className="wallet-badge-icon">💰</span>
              <div className="wallet-badge-body">
                <div className="wallet-badge-title">남은 현금</div>
                <div className="wallet-badge-list">
                  {wallets.map(w => {
                    const used = w.currency === 'KRW'
                      ? (form.payment_method === '현금' && activeCurrencies.length === 0 ? (amountParsed || 0) : 0)
                      : (form.payment_method === '현금'
                          ? (parseForeignAmount(form.foreign_amounts[w.currency]) || 0) : 0);
                    const after = w.balance - used;
                    return (
                      <span key={w.currency} className="wallet-badge-item">
                        {fmtWallet(w.balance, w.currency)} {w.currency}
                        {used > 0 && (
                          <b className={after < 0 ? 'neg' : ''}> → {fmtWallet(after, w.currency)}</b>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* 현지 금액 (여행 유형 일정 선택 시) */}
          {form.event_id && (() => {
            if (!isTripEvent || !selectedEvent?.countries?.length) return null;
            const countries = selectedEvent.countries;
            const hasAnyRate = countries.some(c => parseRate(c.exchange_rate) > 0);
            return (
              <>
                <div className="form-section-title">
                  현지 금액 <span className="optional">(선택)</span>
                </div>
                {hasAnyRate && (
                  <div className="fx-note">환율이 설정된 통화는 금액(원)이 자동 계산됩니다.</div>
                )}
                {countries.map(c => {
                  const rate = parseRate(c.exchange_rate);
                  const raw = form.foreign_amounts[c.currency] || '';
                  const converted = rate > 0 ? toKrw(parseForeignAmount(raw), rate) : null;
                  return (
                    <div key={c.id} className="form-group">
                      <label>
                        {c.country} ({c.currency})
                        {rate > 0 && (
                          <span className="fx-rate">1 {c.currency} = {formatAmount(rate)}원</span>
                        )}
                      </label>
                      <AmountInput
                        decimal
                        unit={c.currency}
                        value={raw}
                        onChange={v => handleForeignAmountChange(c.currency, v, countries)}
                        placeholder={`${c.currency} 금액 (예: 1200+800)`}
                      />
                      {converted !== null && (
                        <span className="formula-preview">≈ {formatAmount(converted)}원</span>
                      )}
                    </div>
                  );
                })}
              </>
            );
          })()}

          {/* 저장된 현지 금액 — 일정이 지워졌거나 숨겨졌거나, 일정에 그 통화가 없을 때 (B-060) */}
          {storedOnlyCurrencies.length > 0 && (
            <>
              <div className="form-section-title">
                저장된 현지 금액 <span className="optional">(선택)</span>
              </div>
              <div className="fx-note">
                {!form.event_id ? '연결된 일정이 없어' : !selectedEvent ? '연결된 일정이 숨겨져 있어' : '연결된 일정에 이 통화가 없어'}
                {' '}원화 금액은 자동으로 다시 계산하지 않습니다. 칸을 비우고 저장하면 이 현지 금액은 지워집니다.
              </div>
              {storedOnlyCurrencies.map(cur => (
                <div key={cur} className="form-group">
                  <label>{cur}</label>
                  <AmountInput
                    decimal
                    unit={cur}
                    value={form.foreign_amounts[cur] ?? ''}
                    onChange={v => handleStoredForeignChange(cur, v)}
                    placeholder={`${cur} 금액`}
                  />
                </div>
              ))}
            </>
          )}

          {/* 금액 */}
          <FormulaInput
            label="금액"
            value={form.amount}
            onChange={v => set('amount', v)}
            required
          />

          {/* 분할 결제 */}
          <div className="split-box">
            <label className="split-toggle">
              <input
                type="checkbox"
                checked={split}
                onChange={e => {
                  // 분할을 켜고 끄면 첫 번째 결제수단이 내는 금액이 바뀌므로 할인을 다시 계산한다
                  skipAutoDiscountRef.current = false;
                  setSplit(e.target.checked);
                  setSplitAmount('');
                }}
              />
              <span>분할 결제 — 한 번의 구매를 두 결제수단으로 나눠 냄</span>
            </label>

            {!split && splitSibling && (
              <div className="split-unlink-warn">
                분할을 해제하고 저장하면 나머지 1건
                ({splitSibling.payment_method} {formatAmount(splitSibling.amount)}원)이 삭제되고
                이 거래 하나로 합쳐집니다.
              </div>
            )}

            {split && (
              <div className="split-fields">
                <div className="split-hint">
                  거래 2건으로 {editingTx ? '저장' : '나뉘어 저장'}됩니다. 총액은 위 금액({formatAmount(amountParsed)}원) 기준입니다.
                </div>

                <div className="form-group">
                  <label>
                    {form.payment_method || '첫 번째 결제수단'}(으)로 낸 금액
                    <span className="split-cur"> ({splitCurrency})</span>
                  </label>
                  <AmountInput
                    decimal={splitCurrency !== 'KRW'}
                    unit={splitCurrency === 'KRW' ? '원' : splitCurrency}
                    value={splitAmount}
                    onChange={v => { setSplitAmount(v); setSplitAmountCur(splitCurrency); }}
                    placeholder={splitCurrency === 'KRW' ? '예: 30000' : `예: 10000 (${splitCurrency})`}
                  />
                  {primaryKrw > 0 && splitCurrency !== 'KRW' && (
                    <span className="formula-preview">≈ {formatAmount(primaryKrw)}원</span>
                  )}
                </div>

                <div className="form-group">
                  <label>나머지 결제수단<span className="required">*</span></label>
                  <select value={splitMethod} onChange={e => setSplitMethod(e.target.value)}>
                    <option value="">선택</option>
                    {paymentMethods.filter(m => m !== form.payment_method).map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                    {splitMethod && !paymentMethods.includes(splitMethod) && (
                      <option value={splitMethod}>{splitMethod} (숨김)</option>
                    )}
                  </select>
                </div>

                {splitValid && splitMethod && (
                  <div className="split-preview">
                    <div>
                      <span>{form.payment_method}</span>
                      <b>{formatAmount(primaryKrw)}원
                        {splitCurrency !== 'KRW' && ` (${fmtWallet(splitPrimary, splitCurrency)} ${splitCurrency})`}
                        {discountParsed > 0 && ` · 할인 ${formatAmount(discountParsed)}원`}
                      </b>
                    </div>
                    <div>
                      <span>{splitMethod}</span>
                      <b>{formatAmount(secondaryKrw)}원
                        {secondaryForeign !== null && ` (${fmtWallet(secondaryForeign, splitCurrency)} ${splitCurrency})`}
                        {secondDiscount > 0 && ` · 할인 ${formatAmount(secondDiscount)}원`}
                      </b>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 할인/수익 정보 */}
          <div className="form-section-title">
            {form.payment_method === '현금' ? '수익 정보' : '할인/혜택 정보'}
            <span className="optional">(선택)</span>
          </div>
          <div className="form-row">
            <FormulaInput
              label={split && form.payment_method !== '현금'
                ? `${discountLabel} (${form.payment_method || '첫 번째 결제수단'} 몫)`
                : discountLabel}
              value={form.discount_amount}
              onChange={v => { discountTouchedRef.current = true; set('discount_amount', v); }}
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
                <small>추가 후 창을 닫지 않고 바로 다음 거래 입력 (날짜·결제수단·카테고리·일정 유지)</small>
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
