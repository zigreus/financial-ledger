import React from 'react';
import { isSuggestionComplete } from '../../services/receiptAssistant';
import {
  SourceBadge, amountText, categoryText, CategoryPathSelect, splitCategoryPath,
} from './SuggestionCard';
import './AIEntry.css';

/**
 * 목록에서 고친 값을 추천에 반영한다 (말로 입력·카드 문자 공통).
 * 사용자가 직접 고른 항목은 근거 표시를 지우고, 이번 수정으로 다 채워지면 자동으로 체크한다.
 */
export function patchListItem(it, patch) {
  const s = { ...it.s, ...patch, sources: { ...it.s.sources } };
  if ('payment_method' in patch) delete s.sources.payment_method;
  if ('budget_category' in patch) delete s.sources.category;
  return { ...it, s, checked: isSuggestionComplete(s) ? (it.checked || !isSuggestionComplete(it.s)) : false };
}

/**
 * 여러 건 추천 목록의 한 줄 — 체크, 내용·금액, 결제수단·카테고리 고르기, 빈 항목 안내, 경고.
 * subtitle을 주지 않으면 날짜(와 여행 일정)를 보여 준다.
 */
export default function SuggestionItem({ db, item, methods, subtitle, onToggle, onPatch, onFillForm }) {
  const s = item.s;
  const complete = isSuggestionComplete(s);
  return (
    <div className={`tp-item${item.checked ? ' checked' : ''}`}>
      <label className="tp-item-head">
        <input
          type="checkbox"
          checked={item.checked}
          disabled={!complete}
          onChange={e => onToggle(e.target.checked)}
        />
        <span className="tp-item-main">
          <b>{s.detail || '(내용 없음)'}</b>
          <small>{subtitle ?? `${s.date}${s.eventTitle ? ` · ${s.eventTitle}` : ''}`}</small>
        </span>
        <span className={`tp-item-amount${s.amount === null ? ' missing' : ''}`}>{amountText(s)}</span>
      </label>

      <div className="tp-item-fields">
        <span className="tp-field">
          <select value={s.payment_method} onChange={e => onPatch({ payment_method: e.target.value })}>
            <option value="">결제수단 선택</option>
            {methods.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <SourceBadge source={s.sources.payment_method} />
        </span>
        <span className="tp-field">
          <CategoryPathSelect
            db={db}
            value={categoryText(s)}
            onChange={v => onPatch(splitCategoryPath(v))}
          />
          <SourceBadge source={s.sources.category} />
        </span>
      </div>

      {!complete && (
        <div className="tp-item-missing">
          {s.amount === null ? '금액을 몰라요 — ' : '빈 항목을 고르거나 — '}
          <button type="button" className="rs-btn-link" onClick={() => onFillForm(s)}>폼에 채워서 입력</button>
        </div>
      )}
      {s.warnings.length > 0 && <div className="tp-item-warn">{s.warnings.join(' · ')}</div>}
    </div>
  );
}
