import React from 'react';

/**
 * 거래의 기본 칸 — 날짜, 결제수단, 카테고리·세부카테고리, 세부내역, 일정 연결.
 * 숨긴 결제수단·카테고리·세부카테고리로 기록된 거래를 수정할 때도 현재 값이 "(숨김)"으로 보이게 한다 (B-043).
 */
export default function BasicFields({
  form, onChange, onCategoryChange, onEventChange,
  paymentMethods, budgetCategories, subCategories, calendarEvents, eventTypeMap,
}) {
  return (
    <>
      {/* 날짜 */}
      <div className="form-group">
        <label>날짜<span className="required">*</span></label>
        <input
          type="date"
          value={form.date}
          onChange={e => onChange('date', e.target.value)}
          required
        />
      </div>

      {/* 결제수단 */}
      <div className="form-group">
        <label>결제수단<span className="required">*</span></label>
        <select
          value={form.payment_method}
          onChange={e => onChange('payment_method', e.target.value)}
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
            onChange={e => onCategoryChange(e.target.value)}
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
            onChange={e => onChange('sub_category', e.target.value)}
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
          onChange={e => onChange('detail', e.target.value)}
          placeholder="예: 김치찌개, 스타벅스 아메리카노"
        />
      </div>

      {/* 일정 연결 */}
      {calendarEvents.length > 0 && (
        <div className="form-group">
          <label>일정 <span className="optional">(선택)</span></label>
          <select
            value={form.event_id}
            onChange={e => onEventChange(e.target.value)}
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
    </>
  );
}
