import React, { useState } from 'react';
import { isSuggestionComplete, isSpokenPaymentWarning } from '../../services/receiptAssistant';
import { evaluateFormula, isIncompleteFormula } from '../../services/formulaEvaluator';
import { isValidDateStr } from '../../services/dateUtils';
import AmountInput from '../common/AmountInput';
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
  // 말한 결제수단을 못 맞췄다는 알림은 결제수단을 고르면 지운다
  if (patch.payment_method && s.warnings) s.warnings = s.warnings.filter(w => !isSpokenPaymentWarning(w));
  if ('budget_category' in patch) delete s.sources.category;
  if ('date' in patch) delete s.sources.date;
  if ('detail' in patch) delete s.sources.detail;
  return { ...it, s, checked: isSuggestionComplete(s) ? (it.checked || !isSuggestionComplete(it.s)) : false };
}

/** 처음 읽은 값과 달라졌는지 — 되돌리기 버튼을 보일지 (날짜·세부내역·금액·결제수단·카테고리) */
const REVERT_FIELDS = ['date', 'detail', 'amount', 'payment_method', 'budget_category', 'sub_category'];
export function changedFrom(s, original) {
  return !!original && REVERT_FIELDS.some(k => (s[k] ?? '') !== (original[k] ?? ''));
}

/** 금액 칸의 글 → 원화 금액(0보다 커야 함). 비었거나 입력 중이거나 잘못됐으면 null */
function amountOf(text) {
  if (isIncompleteFormula(text)) return null;
  const n = evaluateFormula(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function amountProblem(text) {
  if (!String(text).trim()) return '금액을 입력하세요';
  if (isIncompleteFormula(text)) return '수식을 마저 입력하세요';
  return amountOf(text) === null ? '금액을 확인하세요 (0보다 큰 숫자·사칙연산)' : '';
}

/** 날짜·세부내역·금액 고치기 (사진 목록) — 고칠 때마다 onPatch로 바로 반영한다 */
function EditFields({ s, onPatch }) {
  // 금액은 입력한 글을 들고 있다가 계산한다 — "1000+"처럼 입력 중인 수식도 지우지 않게
  const [amountTextValue, setAmountText] = useState(s.amount === null || s.amount === undefined ? '' : String(s.amount));
  const problem = amountProblem(amountTextValue);
  const dateProblem = isValidDateStr(s.date) ? '' : '날짜를 고르세요';
  return (
    <div className="tp-edit">
      <label className="tp-edit-row">
        <span>날짜</span>
        <input type="date" value={s.date || ''} onChange={e => onPatch({ date: e.target.value })} />
      </label>
      {dateProblem && <div className="tp-item-warn">{dateProblem}</div>}
      <label className="tp-edit-row">
        <span>세부내역</span>
        <input type="text" value={s.detail || ''} onChange={e => onPatch({ detail: e.target.value })} placeholder="세부내역" />
      </label>
      <div className="tp-edit-row">
        <span>금액</span>
        <AmountInput
          value={amountTextValue}
          onChange={(v) => {
            setAmountText(v);
            const amount = amountOf(v);
            // 직접 넣은 금액이 맞으면 "금액을 읽지 못했습니다" 안내는 지운다
            onPatch(amount === null ? { amount } : { amount, warnings: s.warnings.filter(w => !w.startsWith('금액을 읽지 못했')) });
          }}
          inputMode="decimal"
          aria-label="금액"
          containerClassName="tp-edit-amount"
        />
      </div>
      {problem && !isIncompleteFormula(amountTextValue) && <div className="tp-item-warn">{problem}</div>}
      {problem && isIncompleteFormula(amountTextValue) && <div className="tp-item-missing">{problem}</div>}
      {s.foreignAmount !== null && s.foreignAmount !== undefined && (
        <div className="tp-item-missing">외화 {amountText({ ...s, amount: null })} — 원화 금액만 고칩니다</div>
      )}
    </div>
  );
}

/**
 * 여러 건 추천 목록의 한 줄 — 체크, 내용·금액, 결제수단·카테고리 고르기, 빈 항목 안내, 경고.
 * subtitle을 주지 않으면 날짜(와 여행 일정)를 보여 준다.
 * editable이면 '고치기'로 날짜·세부내역·금액도 고친다. canCheck: 체크할 수 있는지(기본은 다 채워졌는지)
 * onRevert가 있으면 처음 읽은 값(item.original)과 달라졌을 때 '읽은 값으로'(되돌리기)를 보인다.
 * item.rev가 바뀌면(되돌림) 고치기 칸을 새로 그려 금액 칸의 글도 되돌린 값으로 맞춘다.
 * s.aiNote가 있으면(사진 목록) AI가 그 결제에서 확실하지 않다고 남긴 메모를 보인다.
 * needsFix(이유 글)가 있으면 '수정 필요'를 굵게 드러내고, 바로 고치기를 열 수 있게 한다.
 */
export default function SuggestionItem({
  db, item, methods, subtitle, onToggle, onPatch, onFillForm, onRevert, editable = false, canCheck, needsFix = '',
}) {
  const [editing, setEditing] = useState(false);
  const s = item.s;
  const complete = isSuggestionComplete(s);
  const checkable = canCheck === undefined ? complete : canCheck;
  return (
    <div className={`tp-item${item.checked ? ' checked' : ''}${needsFix ? ' needs-fix' : ''}`}>
      <label className="tp-item-head">
        <input
          type="checkbox"
          checked={item.checked}
          disabled={!checkable}
          onChange={e => onToggle(e.target.checked)}
        />
        <span className="tp-item-main">
          <b>
            {needsFix && <strong className="tp-fix-badge">수정 필요</strong>}
            {s.detail || s.sub_category || '(내용 없음)'}
          </b>
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
        {editable && (
          <button type="button" className="rs-btn-link tp-edit-toggle" aria-expanded={editing} onClick={() => setEditing(v => !v)}>
            {editing ? '고치기 닫기' : '고치기'}
          </button>
        )}
        {onRevert && changedFrom(s, item.original) && (
          <button type="button" className="rs-btn-link tp-edit-toggle" title="고친 것을 사진에서 읽은 값으로 되돌립니다" onClick={onRevert}>
            읽은 값으로
          </button>
        )}
      </div>

      {needsFix && (
        <div className="tp-fix-note">
          <b>{needsFix}</b>
          {editable && !editing && (
            <button type="button" className="rs-btn-link" onClick={() => setEditing(true)}>지금 고치기</button>
          )}
        </div>
      )}

      {editing && <EditFields key={item.rev || 0} s={s} onPatch={onPatch} />}

      {!checkable && !editing && (
        <div className="tp-item-missing">
          {s.amount === null ? '금액을 몰라요 — ' : !complete ? '빈 항목을 고르거나 — ' : '날짜·금액을 확인해 주세요 — '}
          {editable && (
            <>
              <button type="button" className="rs-btn-link" onClick={() => setEditing(true)}>여기서 고치거나</button>
              {' '}
            </>
          )}
          <button type="button" className="rs-btn-link" onClick={() => onFillForm(s)}>폼에 채워서 입력</button>
        </div>
      )}
      {s.aiNote && <div className="tp-item-ai-note">AI 메모: {s.aiNote}</div>}
      {s.warnings.length > 0 && <div className="tp-item-warn">{s.warnings.join(' · ')}</div>}
    </div>
  );
}
