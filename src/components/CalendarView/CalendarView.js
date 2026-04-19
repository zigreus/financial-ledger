import React, { useState, useMemo, useRef, useEffect } from 'react';
import './CalendarView.css';
import {
  getCalendarEventsInRange,
  getUndatedCalendarEvents,
  getDailyTotals,
  getTransactions,
  addCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  addEventCountry,
  updateEventCountry,
  deleteEventCountry,
  deleteTransaction,
  getCalendarEventTypes,
} from '../../services/dbManager';

// ── 카테고리 컬러 ──────────────────────────────────────────
const DEFAULT_CATEGORY_COLORS = {
  '식비': '#FF6B6B',
  '쇼핑': '#4ECDC4',
  '차량교통비': '#45B7D1',
  '의류/미용': '#F7DC6F',
  '의료/건강': '#82E0AA',
  '교육': '#BB8FCE',
  '여행/문화': '#F0A500',
  '반려동물': '#A3C4F3',
  '기타': '#AAB7B8',
};
function stringToHue(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}
function categoryColor(cat) {
  if (!cat) return '#AAB7B8';
  if (DEFAULT_CATEGORY_COLORS[cat]) return DEFAULT_CATEGORY_COLORS[cat];
  return `hsl(${stringToHue(cat)}, 55%, 52%)`;
}

// ── 상수 ───────────────────────────────────────────────────
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDateKo(dateStr) {
  if (!dateStr) return '';
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}월 ${Number(d)}일`;
}

function eventDateRange(ev) {
  if (!ev.date_from) return '날짜 미정';
  if (!ev.date_to || ev.date_to === ev.date_from) return formatDateKo(ev.date_from);
  return `${formatDateKo(ev.date_from)} ~ ${formatDateKo(ev.date_to)}`;
}

function resolveEventColor(ev, eventTypeMap) {
  if (ev.color) return ev.color;
  return eventTypeMap[ev.event_type]?.color ?? '#9CA3AF';
}

// ── 주 행 레이아웃 계산 ────────────────────────────────────
function buildWeekRows(year, mon, days, firstDow) {
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) {
    cells.push(`${year}-${String(mon).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i+7));
  return rows;
}

function assignEventBars(weekDates, events) {
  const bars = [];
  events.forEach(ev => {
    const eFrom = ev.date_from || '';
    const eTo   = ev.date_to   || ev.date_from || '';
    if (!eFrom) return;
    let startCol = -1, endCol = -1;
    weekDates.forEach((date, col) => {
      if (!date) return;
      if (date >= eFrom && date <= eTo) {
        if (startCol === -1) startCol = col;
        endCol = col;
      }
    });
    if (startCol === -1) return;
    bars.push({ ev, startCol, endCol, lane: -1 });
  });
  bars.sort((a, b) => a.startCol - b.startCol || (b.endCol - b.startCol) - (a.endCol - a.startCol));
  const laneEnds = [];
  bars.forEach(bar => {
    let lane = 0;
    while (laneEnds[lane] !== undefined && laneEnds[lane] >= bar.startCol) lane++;
    bar.lane = lane;
    laneEnds[lane] = bar.endCol;
  });
  return bars;
}

// ── 이벤트 폼 ─────────────────────────────────────────────
const EMPTY_FORM = {
  title: '', date_from: '', date_to: '',
  event_type: 'general', color: '', note: '',
  countries: [], // [{id, country, currency}]
};

function EventForm({ db, editingEvent, initialDateFrom, onSave, onDelete, onCancel, eventTypes = [], eventTypeMap = {} }) {
  const [form, setForm] = useState(() => {
    if (editingEvent) {
      return {
        title:      editingEvent.title || '',
        date_from:  editingEvent.date_from || '',
        date_to:    editingEvent.date_to || '',
        event_type: editingEvent.event_type || 'general',
        color:      editingEvent.color || '',
        note:       editingEvent.note || '',
        countries:  (editingEvent.countries || []).map(c => ({ ...c })),
      };
    }
    return {
      ...EMPTY_FORM,
      date_from: initialDateFrom || '',
      countries: [],
    };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const colorRef = useRef(null);

  const typeInfo = eventTypeMap[form.event_type] || eventTypeMap['general'] || { color: '#9CA3AF' };
  const displayColor = form.color || typeInfo.color;

  function setField(key, val) {
    setForm(f => ({ ...f, [key]: val }));
  }

  function handleTypeChange(t) {
    const tc = eventTypeMap[t];
    setForm(f => ({ ...f, event_type: t, color: tc ? tc.color : '' }));
  }

  function addCountry() {
    setForm(f => ({ ...f, countries: [...f.countries, { id: null, country: '', currency: '' }] }));
  }
  function updateCountryField(idx, key, val) {
    setForm(f => {
      const c = f.countries.map((r, i) => i === idx ? { ...r, [key]: val } : r);
      return { ...f, countries: c };
    });
  }
  function removeCountry(idx) {
    setForm(f => ({ ...f, countries: f.countries.filter((_, i) => i !== idx) }));
  }

  async function handleSave() {
    if (!form.title.trim()) { setError('제목을 입력하세요'); return; }
    setSaving(true);
    setError('');
    try {
      const payload = {
        title: form.title.trim(),
        date_from: form.date_from,
        date_to: form.date_to,
        event_type: form.event_type,
        color: form.color,
        note: form.note,
        is_hidden: editingEvent?.is_hidden || 0,
      };
      if (editingEvent) {
        updateCalendarEvent(db, editingEvent.id, payload);
        // sync countries
        const oldCountries = editingEvent.countries || [];
        const keepIds = new Set(form.countries.filter(c => c.id).map(c => c.id));
        oldCountries.forEach(oc => { if (!keepIds.has(oc.id)) deleteEventCountry(db, oc.id); });
        form.countries.forEach(c => {
          if (!c.country.trim()) return;
          if (c.id) updateEventCountry(db, c.id, c.country, c.currency);
          else addEventCountry(db, editingEvent.id, c.country, c.currency);
        });
      } else {
        const newId = addCalendarEvent(db, payload);
        form.countries.forEach(c => {
          if (c.country.trim()) addEventCountry(db, newId, c.country, c.currency);
        });
      }
      onSave();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editingEvent) return;
    if (!window.confirm(`"${editingEvent.title}" 일정을 삭제할까요?`)) return;
    deleteCalendarEvent(db, editingEvent.id);
    onDelete();
  }

  return (
    <div className="cv-form-overlay" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="cv-form">
        <div className="cv-form-header">
          <span className="cv-form-title">{editingEvent ? '일정 수정' : '일정 추가'}</span>
          <button className="cv-bs-close" onClick={onCancel}>✕</button>
        </div>
        <div className="cv-form-body">
          {error && <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>}

          <div className="cv-form-field">
            <label className="cv-form-label">제목 *</label>
            <input className="cv-form-input" value={form.title} onChange={e => setField('title', e.target.value)} placeholder="일정 제목" />
          </div>

          <div className="cv-form-field">
            <label className="cv-form-label">유형</label>
            <div className="cv-form-type-chips">
              {eventTypes.map(t => (
                <button
                  key={t.value}
                  className={`cv-form-type-chip${form.event_type === t.value ? ' active' : ''}`}
                  style={form.event_type === t.value ? { background: t.color } : {}}
                  onClick={() => handleTypeChange(t.value)}
                >{t.label}</button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <div className="cv-form-field" style={{ flex: 1 }}>
              <label className="cv-form-label">시작일</label>
              <input type="date" className="cv-form-input" value={form.date_from} onChange={e => setField('date_from', e.target.value)} />
            </div>
            <div className="cv-form-field" style={{ flex: 1 }}>
              <label className="cv-form-label">종료일</label>
              <input type="date" className="cv-form-input" value={form.date_to} onChange={e => setField('date_to', e.target.value)} />
            </div>
          </div>

          <div className="cv-form-field">
            <label className="cv-form-label">색상</label>
            <div className="cv-form-color-row">
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <div className="cv-form-color-swatch" style={{ background: displayColor }} />
                <input
                  ref={colorRef}
                  type="color"
                  className="cv-form-color-input"
                  value={displayColor}
                  onChange={e => setField('color', e.target.value)}
                  style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }}
                />
              </div>
              <input
                className="cv-form-input cv-form-color-hex"
                value={form.color || typeInfo.color}
                onChange={e => setField('color', e.target.value)}
                placeholder={typeInfo.color}
                maxLength={7}
              />
            </div>
          </div>

          {eventTypeMap[form.event_type]?.is_trip_type === 1 && (
            <div className="cv-form-field">
              <label className="cv-form-label">여행 국가/화폐</label>
              {form.countries.map((c, i) => (
                <div className="cv-form-country-row" key={i}>
                  <input
                    className="cv-form-input" placeholder="국가 (예: 일본)"
                    value={c.country} onChange={e => updateCountryField(i, 'country', e.target.value)}
                  />
                  <input
                    className="cv-form-input" placeholder="통화 (예: JPY)"
                    value={c.currency} onChange={e => updateCountryField(i, 'currency', e.target.value)}
                    style={{ width: 80, flex: 'none' }}
                  />
                  <button className="cv-form-country-remove" onClick={() => removeCountry(i)}>✕</button>
                </div>
              ))}
              <button className="cv-form-add-country-btn" onClick={addCountry}>+ 국가 추가</button>
            </div>
          )}

          <div className="cv-form-field">
            <label className="cv-form-label">메모</label>
            <textarea
              className="cv-form-textarea"
              value={form.note}
              onChange={e => setField('note', e.target.value)}
              placeholder="메모 (선택)"
              rows={3}
            />
          </div>
        </div>

        <div className="cv-form-footer">
          {editingEvent && (
            <button className="cv-form-delete-btn" onClick={handleDelete}>삭제</button>
          )}
          <button className="cv-form-cancel-btn" onClick={onCancel}>취소</button>
          <button className="cv-form-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 메인 컴포넌트 ──────────────────────────────────────────
export default function CalendarView({ db, goTodayKey, onChanged, showEventForm, onOpenEventForm, onCloseEventForm, onAddTransaction, onEditTransaction }) {
  const today = todayStr();
  const [currentMonth, setCurrentMonth] = useState(() => today.slice(0, 7));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null);
  const [internalEventForm, setInternalEventForm] = useState(false);
  const [formInitialDate, setFormInitialDate] = useState('');
  const [selectedTx, setSelectedTx] = useState(null);

  useEffect(() => {
    if (goTodayKey > 0) {
      setCurrentMonth(today.slice(0, 7));
      setSelectedDate(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goTodayKey]);

  const { year, mon, days, firstDow } = useMemo(() => {
    const [y, m] = currentMonth.split('-').map(Number);
    const firstDay = new Date(y, m - 1, 1);
    const lastDay  = new Date(y, m, 0);
    return { year: y, mon: m, days: lastDay.getDate(), firstDow: firstDay.getDay() };
  }, [currentMonth]);

  const monthStart = currentMonth + '-01';
  const monthEnd   = `${currentMonth}-${String(days).padStart(2,'0')}`;

  const eventTypes = useMemo(() => getCalendarEventTypes(db), [db]);
  const eventTypeMap = useMemo(
    () => Object.fromEntries(eventTypes.map(t => [t.value, t])),
    [eventTypes]
  );

  const events = useMemo(() => db ? getCalendarEventsInRange(db, monthStart, monthEnd) : [], [db, monthStart, monthEnd]);
  const undatedEvents = useMemo(() => db ? getUndatedCalendarEvents(db) : [], [db]);
  const dailyTotals   = useMemo(() => db ? getDailyTotals(db, currentMonth) : {}, [db, currentMonth]);

  const weekRows = useMemo(() => buildWeekRows(year, mon, days, firstDow), [year, mon, days, firstDow]);

  // max total for heatmap intensity
  const maxTotal = useMemo(() => {
    const vals = Object.values(dailyTotals).map(d => d.total - d.discount);
    return vals.length ? Math.max(...vals) : 0;
  }, [dailyTotals]);

  // per-week event bar layout
  const weekBarData = useMemo(() =>
    weekRows.map(row => assignEventBars(row, events)),
  [weekRows, events]);

  // bottom sheet transactions
  const bottomSheetTx = useMemo(() => {
    if (!selectedDate || !db) return [];
    return getTransactions(db, { dateFrom: selectedDate, dateTo: selectedDate });
  }, [db, selectedDate]);

  const bottomSheetEvents = useMemo(() => {
    if (!selectedDate) return [];
    return events.filter(ev => {
      const f = ev.date_from || '', t = ev.date_to || ev.date_from || '';
      return selectedDate >= f && selectedDate <= (t || f);
    });
  }, [selectedDate, events]);

  function prevMonth() {
    const [y, m] = currentMonth.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }
  function nextMonth() {
    const [y, m] = currentMonth.split('-').map(Number);
    const d = new Date(y, m, 1);
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }
  function pickYearMonth(y, m) {
    setCurrentMonth(`${y}-${String(m).padStart(2,'0')}`);
    setPickerOpen(false);
  }

  function handleDateClick(dateStr) {
    const hasTx = !!dailyTotals[dateStr];
    const hasEv = events.some(ev => {
      const f = ev.date_from || '', t = ev.date_to || ev.date_from || '';
      return dateStr >= f && dateStr <= (t || f);
    });
    if (!hasTx && !hasEv) {
      if (onAddTransaction) onAddTransaction(dateStr);
      return;
    }
    setSelectedDate(dateStr);
  }

  function handleEventBarClick(ev, e) {
    e.stopPropagation();
    setEditingEvent(ev);
    setInternalEventForm(true);
  }

  function handleUndatedClick(ev) {
    setEditingEvent(ev);
    setInternalEventForm(true);
  }

  function openAddFromSheet() {
    const date = selectedDate;
    setSelectedDate(null);
    if (onAddTransaction) onAddTransaction(date);
  }

  function openAddEventFromSheet(date) {
    setSelectedDate(null);
    setFormInitialDate(date || '');
    setEditingEvent(null);
    setInternalEventForm(true);
  }

  async function handleTxDelete(txId) {
    if (!window.confirm('이 거래를 삭제할까요?')) return;
    deleteTransaction(db, txId);
    setSelectedTx(null);
    await onChanged();
  }

  const showForm = showEventForm || internalEventForm;

  async function handleFormSave() {
    setInternalEventForm(false);
    setEditingEvent(null);
    if (showEventForm && onCloseEventForm) onCloseEventForm();
    await onChanged();
  }

  function handleFormCancel() {
    setInternalEventForm(false);
    setEditingEvent(null);
    if (showEventForm && onCloseEventForm) onCloseEventForm();
  }

  async function handleFormDelete() {
    setInternalEventForm(false);
    setEditingEvent(null);
    await onChanged();
  }

  // when App.js sets showEventForm=true, treat as adding new event
  useEffect(() => {
    if (showEventForm && !internalEventForm) {
      setEditingEvent(null);
      setFormInitialDate('');
    }
  }, [showEventForm, internalEventForm]);

  const [pickerYear, setPickerYear] = useState(year);
  const [yearRangeBase, setYearRangeBase] = useState(year);
  useEffect(() => {
    setPickerYear(year);
    setYearRangeBase(year);
  }, [year, pickerOpen]);

  // picker years: yearRangeBase 중심 ±4 (9개)
  const pickerYears = useMemo(() => {
    const arr = [];
    for (let y = yearRangeBase - 4; y <= yearRangeBase + 4; y++) arr.push(y);
    return arr;
  }, [yearRangeBase]);

  function handlePickerYear(y) {
    setPickerYear(y);
    setYearRangeBase(y);
  }

  return (
    <div className="cv-wrap">
      {/* ── 헤더 ── */}
      <div className="cv-header">
        <button className="cv-header-btn" onClick={prevMonth}>‹</button>
        <span className="cv-header-title" onClick={() => setPickerOpen(p => !p)}>
          {year}년 {mon}월 {pickerOpen ? '▴' : '▾'}
        </span>
        <button className="cv-header-btn" onClick={nextMonth}>›</button>
      </div>

      {/* ── 연·월 피커 ── */}
      {pickerOpen && (
        <div className="cv-picker">
          <div className="cv-picker-year-row">
            <span className="cv-picker-year-label">연도</span>
            <button className="cv-picker-year-nav" onClick={() => setYearRangeBase(b => b - 9)}>‹</button>
            <div className="cv-picker-years">
              {pickerYears.map(y => (
                <button
                  key={y}
                  className={`cv-picker-year-btn${pickerYear === y ? ' active' : ''}`}
                  onClick={() => handlePickerYear(y)}
                >{y}</button>
              ))}
            </div>
            <button className="cv-picker-year-nav" onClick={() => setYearRangeBase(b => b + 9)}>›</button>
          </div>
          <div className="cv-picker-months">
            {[1,2,3,4,5,6,7,8,9,10,11,12].map(m => (
              <button
                key={m}
                className={`cv-picker-month-btn${pickerYear === year && m === mon ? ' active' : ''}`}
                onClick={() => pickYearMonth(pickerYear, m)}
              >{m}월</button>
            ))}
          </div>
        </div>
      )}

      {/* ── 달력 그리드 ── */}
      <div className="cv-grid">
        <div className="cv-weekdays">
          {WEEKDAYS.map((wd, i) => (
            <div key={wd} className={`cv-wd${i===0?' cv-sun':i===6?' cv-sat':''}`}>{wd}</div>
          ))}
        </div>

        {weekRows.map((row, wi) => {
          const bars = weekBarData[wi];
          const maxLane = bars.length ? Math.max(...bars.map(b => b.lane)) : -1;
          const barsHeight = Math.max((maxLane + 1) * 16 + 4, 20);

          return (
            <div className="cv-week-row" key={wi}>
              {/* 날짜 셀 */}
              <div className="cv-dates">
                {row.map((dateStr, ci) => {
                  if (!dateStr) return <div key={`e-${wi}-${ci}`} className="cv-cell cv-cell-empty" />;
                  const dow = (firstDow + parseInt(dateStr.slice(8)) - 1) % 7;
                  const isToday    = dateStr === today;
                  const isSelected = dateStr === selectedDate;
                  const info = dailyTotals[dateStr];
                  const net  = info ? info.total - info.discount : 0;
                  const ratio = maxTotal > 0 && net > 0 ? net / maxTotal : 0;
                  const cls = [
                    'cv-cell',
                    dow === 0 ? 'cv-sun' : dow === 6 ? 'cv-sat' : '',
                    isToday    ? 'cv-cell-today'    : '',
                    isSelected ? 'cv-cell-selected' : '',
                  ].filter(Boolean).join(' ');

                  return (
                    <div key={dateStr} className={cls} onClick={() => handleDateClick(dateStr)}>
                      <span className="cv-cell-day-num">
                        {parseInt(dateStr.slice(8))}
                        {info && <div className="cv-cell-heat" style={{ '--heat': ratio }} />}
                      </span>
                    </div>
                  );
                })}
              </div>
              {/* 이벤트 바 */}
              <div className="cv-event-bars" style={{ height: barsHeight }}>
                  {bars.map(({ ev, startCol, endCol, lane }, bi) => {
                    const colW = 100 / 7;
                    const left = `${startCol * colW}%`;
                    const width = `${(endCol - startCol + 1) * colW}%`;
                    const top = lane * 16 + 2;
                    const color = resolveEventColor(ev, eventTypeMap);
                    return (
                      <div
                        key={bi}
                        className="cv-event-bar"
                        style={{ left, width, top, background: color }}
                        onClick={e => handleEventBarClick(ev, e)}
                      >
                        <span className="cv-event-bar-label">{ev.title}</span>
                      </div>
                    );
                  })}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 날짜 미정 이벤트 ── */}
      {undatedEvents.length > 0 && (
        <div className="cv-undated">
          <div className="cv-undated-title">날짜 미정</div>
          {undatedEvents.map(ev => (
            <div key={ev.id} className="cv-undated-item" onClick={() => handleUndatedClick(ev)}>
              <div className="cv-event-dot" style={{ background: resolveEventColor(ev, eventTypeMap) }} />
              <span className="cv-undated-item-title">{ev.title}</span>
              <span className="cv-undated-item-type">{eventTypeMap[ev.event_type]?.label || ''}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── 바텀 시트 ── */}
      {selectedDate && (
        <div className="cv-bs-overlay" onClick={() => setSelectedDate(null)}>
          <div className="cv-bs" onClick={e => e.stopPropagation()}>
            <div className="cv-bs-header">
              <div className="cv-bs-header-left">
                <span className="cv-bs-title">
                  {formatDateKo(selectedDate)} ({WEEKDAYS[new Date(selectedDate + 'T00:00:00').getDay()]})
                </span>
                {bottomSheetTx.length > 0 && (
                  <span className="cv-bs-header-total">
                    {bottomSheetTx.reduce((s, t) => s + t.amount - (t.discount_amount||0), 0).toLocaleString()}원
                  </span>
                )}
              </div>
              <button className="cv-bs-close" onClick={() => setSelectedDate(null)}>✕</button>
            </div>
            <div className="cv-bs-body">
              {/* 이벤트 */}
              {bottomSheetEvents.length > 0 && (
                <>
                  <div className="cv-bs-section-title">일정</div>
                  {bottomSheetEvents.map(ev => (
                    <div key={ev.id} className="cv-bs-event-item" onClick={() => { setSelectedDate(null); setEditingEvent(ev); setInternalEventForm(true); }}>
                      <div className="cv-bs-event-bar" style={{ background: resolveEventColor(ev, eventTypeMap) }} />
                      <div className="cv-bs-event-info">
                        <div className="cv-bs-event-title">{ev.title}</div>
                        <div className="cv-bs-event-dates">{eventDateRange(ev)}</div>
                      </div>
                      <span className="cv-bs-event-arrow">›</span>
                    </div>
                  ))}
                </>
              )}

              {/* 거래 */}
              {bottomSheetTx.length > 0 ? (
                <>
                  <div className="cv-bs-section-title">거래 {bottomSheetTx.length}건</div>
                  {bottomSheetTx.map(tx => (
                    <div key={tx.id} className="cv-bs-tx-item" onClick={() => setSelectedTx(tx)}>
                      <div className="cv-bs-tx-dot" style={{ background: categoryColor(tx.budget_category) }} />
                      <div className="cv-bs-tx-info">
                        <div className="cv-bs-tx-top">
                          <span className="cv-bs-tx-cat">{tx.budget_category}</span>
                          {tx.payment_method && <span className="cv-bs-tx-pay">{tx.payment_method}</span>}
                        </div>
                        {tx.detail && <div className="cv-bs-tx-detail">{tx.detail}</div>}
                      </div>
                      <div className="cv-bs-tx-right">
                        <div className="cv-bs-tx-amount">{tx.amount.toLocaleString()}</div>
                        {tx.discount_amount > 0 && (
                          <div className="cv-bs-tx-discount">-{tx.discount_amount.toLocaleString()}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <div className="cv-bs-empty">거래 내역 없음</div>
              )}
            </div>
            <div className="cv-bs-footer">
              <button className="cv-bs-add-btn cv-bs-add-btn-secondary" onClick={() => openAddEventFromSheet(selectedDate)}>+ 일정</button>
              <button className="cv-bs-add-btn" onClick={openAddFromSheet}>+ 거래 추가</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 거래 세부 모달 ── */}
      {selectedTx && (
        <div className="cv-tx-modal-overlay" onClick={() => setSelectedTx(null)}>
          <div className="cv-tx-modal" onClick={e => e.stopPropagation()}>
            <div className="cv-tx-modal-header">
              <div className="cv-tx-modal-cat-badge" style={{ background: categoryColor(selectedTx.budget_category) + '22', color: categoryColor(selectedTx.budget_category) }}>
                <span className="cv-tx-modal-cat-dot" style={{ background: categoryColor(selectedTx.budget_category) }} />
                {selectedTx.budget_category}
                {selectedTx.sub_category && ` / ${selectedTx.sub_category}`}
              </div>
              <button className="cv-bs-close" onClick={() => setSelectedTx(null)}>✕</button>
            </div>
            <div className="cv-tx-modal-body">
              <div className="cv-tx-modal-amount">
                {selectedTx.amount.toLocaleString()}<span className="cv-tx-modal-unit">원</span>
              </div>
              {selectedTx.discount_amount > 0 && (
                <div className="cv-tx-modal-discount">
                  할인 -{selectedTx.discount_amount.toLocaleString()}원
                  {selectedTx.discount_note && ` (${selectedTx.discount_note})`}
                </div>
              )}
              {selectedTx.detail && (
                <div className="cv-tx-modal-row">
                  <span className="cv-tx-modal-label">내용</span>
                  <span className="cv-tx-modal-value">{selectedTx.detail}</span>
                </div>
              )}
              {selectedTx.payment_method && (
                <div className="cv-tx-modal-row">
                  <span className="cv-tx-modal-label">결제수단</span>
                  <span className="cv-tx-modal-value">{selectedTx.payment_method}</span>
                </div>
              )}
            </div>
            <div className="cv-tx-modal-footer">
              <button className="cv-form-delete-btn" onClick={() => handleTxDelete(selectedTx.id)}>삭제</button>
              <button className="cv-form-cancel-btn" onClick={() => setSelectedTx(null)}>닫기</button>
              {onEditTransaction && (
                <button className="cv-form-save-btn" onClick={() => { setSelectedTx(null); setSelectedDate(null); onEditTransaction(selectedTx); }}>수정</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── 이벤트 폼 ── */}
      {showForm && (
        <EventForm
          db={db}
          editingEvent={editingEvent}
          initialDateFrom={formInitialDate}
          onSave={handleFormSave}
          onDelete={handleFormDelete}
          onCancel={handleFormCancel}
          eventTypes={eventTypes}
          eventTypeMap={eventTypeMap}
        />
      )}
    </div>
  );
}
