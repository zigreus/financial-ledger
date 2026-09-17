import React, { useState, useEffect, useRef } from 'react';
import { getPaymentMethods, getBudgetCategories, getSubCategories, getDiscountRules, evaluateDiscountRule, getCalendarEvents, getCalendarEventTypes, getFavorites, addFavorite, updateFavorite, deleteFavorite, recordFavoriteUse, getAutoPaymentMethod, getTripDefaultCategory, getEventWallets } from '../../services/dbManager';
import { evaluateFormula, formatAmount, today, parseRate, parseForeignAmount, toKrw } from '../../services/formulaEvaluator';
import './TransactionForm.css';


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

const FORMULA_SYMBOLS = ['+', '-', '×', '÷', '(', ')'];

// 수식이 연산자/괄호로 끝나는 미완성 상태 여부
function isIncomplete(v) {
  return /[+\-*/(%]$/.test(v.trim());
}

const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

function FormulaInput({ label, value, onChange, required, placeholder }) {
  const parsed = evaluateFormula(value);
  const isFormula = value && value.trim() && !/^-?\d+$/.test(value.trim());
  const isValid = parsed !== null && !isNaN(parsed);
  const [focused, setFocused] = useState(false);
  const [toolbarBottom, setToolbarBottom] = useState(0);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const touchHandledRef = useRef(false);

  const scrollContainerUp = () => {
    if (!containerRef.current) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const scrollable = containerRef.current.closest('.modal-content');
    if (!scrollable) return;
    const rect = containerRef.current.getBoundingClientRect();
    // rect은 visual viewport 기준 — vv.height에서 툴바+여백을 빼면 실제 보이는 영역 하단
    const visibleBottom = vv.height - 52 - 8;
    if (rect.bottom > visibleBottom) {
      scrollable.scrollTop += rect.bottom - visibleBottom;
    }
  };

  useEffect(() => {
    if (!focused || !isTouchDevice) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const scrollable = containerRef.current?.closest('.modal-content');
    const update = () => {
      const kb = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
      setToolbarBottom(kb);
      // 모달 패딩을 늘려 스크롤 공간 확보
      if (scrollable) {
        scrollable.style.paddingBottom = kb > 0 ? `${kb + 52 + 16}px` : '';
      }
      requestAnimationFrame(scrollContainerUp);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      setToolbarBottom(0);
      if (scrollable) scrollable.style.paddingBottom = '';
    };
  }, [focused]);

  // 타이핑으로 수식 미리보기가 생겼을 때도 스크롤 재조정
  useEffect(() => {
    if (!focused || !isTouchDevice) return;
    const vv = window.visualViewport;
    if (!vv || window.innerHeight - vv.offsetTop - vv.height <= 0) return;
    requestAnimationFrame(scrollContainerUp);
  }, [value, focused]);

  const insertSymbol = (sym) => {
    const input = inputRef.current;
    if (!input) return;
    const actual = sym === '×' ? '*' : sym === '÷' ? '/' : sym;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    const next = value.slice(0, start) + actual + value.slice(end);
    // focus를 onChange 이전에 동기 호출 — Android에서 키보드가 닫히지 않도록
    input.focus();
    onChange(next);
    requestAnimationFrame(() => {
      input.setSelectionRange(start + 1, start + 1);
    });
  };

  const handleBlur = () => {
    // 심볼 버튼 탭 후 focus가 돌아올 시간을 한 프레임 기다림
    requestAnimationFrame(() => {
      if (document.activeElement !== inputRef.current) {
        setFocused(false);
      }
    });
  };

  return (
    <div className="form-group" ref={containerRef}>
      <label>{label}{required && <span className="required">*</span>}</label>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        placeholder={placeholder || '금액 (예: 12000+3000)'}
        className={value && !isValid && !isIncomplete(value) ? 'input-error' : ''}
      />
      {focused && isTouchDevice && (
        <div className="formula-toolbar" style={{ bottom: toolbarBottom }}>
          {FORMULA_SYMBOLS.map(sym => (
            <button
              key={sym}
              type="button"
              className="formula-toolbar-btn"
              onMouseDown={e => e.preventDefault()}
              onTouchStart={e => { e.preventDefault(); touchHandledRef.current = true; insertSymbol(sym); }}
              onClick={() => { if (touchHandledRef.current) { touchHandledRef.current = false; return; } insertSymbol(sym); }}
            >
              {sym}
            </button>
          ))}
        </div>
      )}
      {isFormula && isValid && (
        <span className="formula-preview">= {formatAmount(parsed)}원</span>
      )}
      {value && !isValid && !isIncomplete(value) && (
        <span className="formula-error">올바른 숫자 또는 수식을 입력하세요</span>
      )}
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

function TransactionForm({ db, editingTx, defaultDate, onSave, onCancel }) {
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
  const skipAutoDiscountRef = React.useRef(false);
  const skipSubResetRef = React.useRef(false);

  useEffect(() => {
    setPaymentMethods(getPaymentMethods(db));
    setBudgetCategories(getBudgetCategories(db));
    const types = getCalendarEventTypes(db);
    setEventTypeMap(Object.fromEntries(types.map(t => [t.value, t])));
    const events = getCalendarEvents(db);
    events.sort((a, b) => {
      if (!a.date_from && !b.date_from) return 0;
      if (!a.date_from) return 1;
      if (!b.date_from) return -1;
      return b.date_from.localeCompare(a.date_from);
    });
    setCalendarEvents(events);
    setFavorites(getFavorites(db));
    setTripCategory(getTripDefaultCategory(db));
  }, [db]);

  useEffect(() => {
    if (editingTx) {
      skipAutoDiscountRef.current = true;
      skipSubResetRef.current = true;
      let foreign_amounts = {};
      try { foreign_amounts = editingTx.foreign_amounts ? JSON.parse(editingTx.foreign_amounts) : {}; } catch (e) {}
      setForm({
        payment_method: editingTx.payment_method || '',
        date: editingTx.date || today(),
        budget_category: editingTx.budget_category || '',
        sub_category: editingTx.sub_category || '',
        detail: editingTx.detail || '',
        amount: editingTx.amount != null ? String(editingTx.amount) : '',
        discount_amount: editingTx.discount_amount ? String(editingTx.discount_amount) : '',
        event_id: editingTx.event_id ? String(editingTx.event_id) : '',
        foreign_amounts,
      });
    } else {
      setForm({ ...EMPTY_FORM, date: defaultDate || today() });
    }
  }, [editingTx, defaultDate]);

  useEffect(() => {
    const subs = getSubCategories(db, form.budget_category);
    setSubCategories(subs);
    if (skipSubResetRef.current) {
      skipSubResetRef.current = false;
      return;
    }
    setForm(prev => ({
      ...prev,
      sub_category: subs.includes(prev.sub_category) ? prev.sub_category : '',
    }));
  }, [db, form.budget_category]);

  // 결제수단별 자동 할인 계산 (DB 규칙 기반)
  useEffect(() => {
    if (skipAutoDiscountRef.current) return;
    const pm = form.payment_method;
    if (!pm || pm === '현금') return;

    const amount = evaluateFormula(form.amount);
    if (amount === null || isNaN(amount) || amount <= 0) {
      setForm(prev => ({ ...prev, discount_amount: '' }));
      return;
    }

    const rules = getDiscountRules(db, pm);
    const d = evaluateDiscountRule(rules, form.budget_category, form.sub_category, amount, form.detail);
    setForm(prev => ({ ...prev, discount_amount: d > 0 ? String(d) : '' }));
  }, [db, form.payment_method, form.amount, form.budget_category, form.sub_category, form.detail]);

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
  };

  // 현지 금액 입력 → 여행에 설정된 환율로 원화 금액 자동 계산
  const handleForeignAmountChange = (currency, value, countries) => {
    setForm(prev => {
      const foreign_amounts = { ...prev.foreign_amounts, [currency]: value };
      const krw = krwFromForeign(foreign_amounts, countries);
      return {
        ...prev,
        foreign_amounts,
        ...(krw === null ? {} : { amount: krw }),
      };
    });
    skipAutoDiscountRef.current = false;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const amount = evaluateFormula(form.amount);
    if (amount === null || isNaN(amount)) return;

    const discountAmount = form.discount_amount ? evaluateFormula(form.discount_amount) : 0;

    const foreign_amounts = {};
    if (form.event_id) {
      Object.entries(form.foreign_amounts).forEach(([currency, val]) => {
        const num = parseForeignAmount(val);
        if (num !== null && num > 0) foreign_amounts[currency] = num;
      });
    }

    const base = {
      date: form.date,
      budget_category: form.budget_category,
      sub_category: form.sub_category,
      detail: form.detail,
      event_id: form.event_id ? Number(form.event_id) : null,
    };

    // 분할 결제 — 한 번의 구매를 두 결제수단으로 나눠 2건으로 기록한다
    if (split && splitValid) {
      const groupId = `sg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const primaryForeign = {};
      const secondForeign = {};
      if (splitCurrency !== 'KRW') {
        primaryForeign[splitCurrency] = splitPrimary;
        secondForeign[splitCurrency] = secondaryForeign;
      }

      // 나머지 결제수단의 할인은 그 금액 기준으로 다시 계산
      const secondRules = getDiscountRules(db, splitMethod);
      const secondDiscount = splitMethod === '현금' ? 0 : evaluateDiscountRule(
        secondRules, form.budget_category, form.sub_category, secondaryKrw, form.detail);

      onSave([
        { ...base, payment_method: form.payment_method, amount: primaryKrw,
          discount_amount: discountAmount || 0, foreign_amounts: primaryForeign, split_group_id: groupId },
        { ...base, payment_method: splitMethod, amount: secondaryKrw,
          discount_amount: secondDiscount || 0, foreign_amounts: secondForeign, split_group_id: groupId },
      ]);
      return;
    }

    onSave({
      ...base,
      payment_method: form.payment_method,
      amount,
      discount_amount: discountAmount || 0,
      foreign_amounts,
      split_group_id: editingTx?.split_group_id || '',
    });
  };

  const amountParsed = evaluateFormula(form.amount);

  // ── 여행 현금 지갑 / 분할 결제 ────────────────────────────────
  const selectedEvent = calendarEvents.find(e => String(e.id) === form.event_id);
  const isTripEvent = !!eventTypeMap[selectedEvent?.event_type]?.is_trip_type;
  const wallets = isTripEvent && selectedEvent
    ? getEventWallets(db, selectedEvent.id).filter(w => Math.abs(w.balance) >= 0.005)
    : [];

  // 현지 금액이 한 통화에만 들어있으면 그 통화로, 아니면 원화로 나눈다
  const activeForeign = (selectedEvent?.countries || []).filter(c =>
    (parseForeignAmount(form.foreign_amounts[c.currency]) || 0) > 0);
  const splitCurrency = activeForeign.length === 1 ? activeForeign[0].currency : 'KRW';
  const splitRate = activeForeign.length === 1 ? parseRate(activeForeign[0].exchange_rate) : 0;
  const splitTotalForeign = splitCurrency !== 'KRW'
    ? parseForeignAmount(form.foreign_amounts[splitCurrency]) : null;

  const splitPrimary = parseForeignAmount(splitAmount);
  const primaryKrw = splitPrimary === null ? null
    : splitCurrency === 'KRW' ? Math.round(splitPrimary) : Math.round(splitPrimary * splitRate);
  const secondaryKrw = primaryKrw === null || amountParsed === null || isNaN(amountParsed)
    ? null : amountParsed - primaryKrw;
  const secondaryForeign = splitTotalForeign !== null && splitPrimary !== null
    ? Number((splitTotalForeign - splitPrimary).toFixed(2)) : null;

  const splitValid = !split || (
    splitPrimary !== null && splitPrimary > 0 &&
    primaryKrw > 0 && secondaryKrw > 0 &&
    (secondaryForeign === null || secondaryForeign > 0) &&
    !!splitMethod
  );

  const missingReasons = [
    !form.payment_method && '결제수단을 선택하세요',
    !form.date && '날짜를 입력하세요',
    !form.budget_category && '카테고리를 선택하세요',
    !form.sub_category && '세부카테고리를 선택하세요',
    (amountParsed === null || isNaN(amountParsed)) && '금액을 올바르게 입력하세요',
    split && !splitMethod && '나머지 결제수단을 선택하세요',
    split && !splitValid && !!splitMethod && '분할 금액이 총액보다 작아야 합니다',
  ].filter(Boolean);
  const canSubmit = missingReasons.length === 0;

  // ── 즐겨찾기 로직 ──────────────────────────────────────────────

  const canStar = form.payment_method && form.budget_category && form.sub_category && amountParsed != null;

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
      f.amount === amountParsed
    );
    setStarredFavoriteId(matched ? matched.id : null);
  }, [form, favorites, amountParsed]);

  // 세부카테고리 선택 시 자동 결제수단 선택
  useEffect(() => {
    if (!form.sub_category || form.payment_method) return;
    const suggested = getAutoPaymentMethod(db, form.sub_category);
    console.log('자동 결제수단:', form.sub_category, '→', suggested);
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
        amount: amountParsed,
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
      amount: amountParsed,
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

  const applyFavorite = (fav) => {
    recordFavoriteUse(db, fav.id);
    setFavorites(getFavorites(db));
    setForm(prev => ({
      ...prev,
      payment_method: fav.payment_method,
      budget_category: fav.budget_category,
      sub_category: fav.sub_category,
      detail: fav.detail,
      amount: String(fav.amount),
    }));
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            {editingTx ? '거래 수정' : '거래 추가'}
            <button
              type="button"
              className={`btn-star ${!canStar ? 'disabled' : ''} ${starredFavoriteId ? 'active' : ''}`}
              onClick={handleStarClick}
              disabled={!canStar}
              title={canStar ? '즐겨찾기' : '결제수단, 카테고리, 세부카테고리, 금액 중 2개 이상 입력하세요'}
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

        <form onSubmit={handleSubmit} className="tx-form">
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
                      ? (form.payment_method === '현금' && activeForeign.length === 0 ? (amountParsed || 0) : 0)
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
            const selectedEvent = calendarEvents.find(e => String(e.id) === form.event_id);
            const selectedType = eventTypeMap[selectedEvent?.event_type];
            if (!selectedType?.is_trip_type || !selectedEvent?.countries?.length) return null;
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
                      <input
                        type="text"
                        inputMode="decimal"
                        value={raw}
                        onChange={e => handleForeignAmountChange(c.currency, e.target.value, countries)}
                        placeholder={`${c.currency} 금액`}
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

          {/* 금액 */}
          <FormulaInput
            label="금액"
            value={form.amount}
            onChange={v => set('amount', v)}
            required
          />

          {/* 분할 결제 */}
          {!editingTx && (
            <div className="split-box">
              <label className="split-toggle">
                <input
                  type="checkbox"
                  checked={split}
                  onChange={e => { setSplit(e.target.checked); setSplitAmount(''); }}
                />
                <span>분할 결제 — 한 번의 구매를 두 결제수단으로 나눠 냄</span>
              </label>

              {split && (
                <div className="split-fields">
                  <div className="split-hint">
                    거래 2건으로 나뉘어 저장됩니다. 총액은 위 금액({formatAmount(amountParsed)}원) 기준입니다.
                  </div>

                  <div className="form-group">
                    <label>
                      {form.payment_method || '첫 번째 결제수단'}(으)로 낸 금액
                      <span className="split-cur"> ({splitCurrency})</span>
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={splitAmount}
                      onChange={e => setSplitAmount(e.target.value)}
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
                    </select>
                  </div>

                  {splitValid && splitMethod && (
                    <div className="split-preview">
                      <div>
                        <span>{form.payment_method}</span>
                        <b>{formatAmount(primaryKrw)}원
                          {splitCurrency !== 'KRW' && ` (${fmtWallet(splitPrimary, splitCurrency)} ${splitCurrency})`}
                        </b>
                      </div>
                      <div>
                        <span>{splitMethod}</span>
                        <b>{formatAmount(secondaryKrw)}원
                          {secondaryForeign !== null && ` (${fmtWallet(secondaryForeign, splitCurrency)} ${splitCurrency})`}
                        </b>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 할인/수익 정보 */}
          <div className="form-section-title">
            {form.payment_method === '현금' ? '수익 정보' : '할인/혜택 정보'}
            <span className="optional">(선택)</span>
          </div>
          <div className="form-row">
            <FormulaInput
              label={form.payment_method === '현금' ? '수익금액' : '할인금액'}
              value={form.discount_amount}
              onChange={v => set('discount_amount', v)}
              placeholder="0"
            />
          </div>

          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onCancel}>취소</button>
            <div className="submit-tooltip-wrapper" onClick={e => { if (!canSubmit) e.currentTarget.classList.toggle('tooltip-visible'); }}>
              <button type="submit" className="btn-primary" disabled={!canSubmit}>
                {editingTx ? '수정' : '추가'}
              </button>
              {!canSubmit && (
                <div className="submit-tooltip">
                  {missingReasons.map((r, i) => <span key={i}>• {r}{'\n'}</span>)}
                </div>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export default TransactionForm;
