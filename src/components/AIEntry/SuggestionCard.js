import React, { useState } from 'react';
import { SOURCE_LABEL, categoryPaths, normalizeName } from '../../services/receiptAssistant';
import { formatAmount } from '../../services/formulaEvaluator';
import './AIEntry.css';

export function fmtForeign(n) {
  return (Math.round(n * 100) / 100).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

export function SourceBadge({ source }) {
  if (!source || !SOURCE_LABEL[source]) return null;
  return <span className={`rs-src rs-src-${source}`}>{SOURCE_LABEL[source]}</span>;
}

function Row({ label, value, source, hint, missing }) {
  return (
    <div className="rs-row">
      <span className="rs-row-label">{label}</span>
      <span className={`rs-row-value${missing ? ' missing' : ''}`}>
        {value}
        {hint && <small>{hint}</small>}
      </span>
      <SourceBadge source={source} />
    </div>
  );
}

/** 금액 한 줄 표기 — 외화면 "1,200 JPY ≈ 10,536원" */
export function amountText(s) {
  if (s.foreignAmount !== null && s.foreignAmount !== undefined) {
    return `${fmtForeign(s.foreignAmount)} ${s.currency}` + (s.amount !== null ? ` ≈ ${formatAmount(s.amount)}원` : '');
  }
  return s.amount !== null ? `${formatAmount(s.amount)}원` : '읽지 못함';
}

/** 말로 입력에서 말한 결제수단 표현이 고른 이름과 다를 때 보인다 — '현대카드'라고 했는데 목록 표기가 '현대카드M'이거나 못 맞췄을 때 */
function saidPaymentHint(s) {
  const said = String(s.paymentSaid || '').trim();
  return said && normalizeName(said) !== normalizeName(s.payment_method) ? `말한 것: ${said}` : '';
}

export function categoryText(s) {
  return s.budget_category ? `${s.budget_category}${s.sub_category ? ` > ${s.sub_category}` : ''}` : '';
}

/**
 * 추천 한 건의 항목별 내용과 근거.
 * amountSource: 금액 근거 (영수증/입력한 말/카드 내역)
 */
export default function SuggestionDetails({ suggestion: s, amountSource = 'receipt' }) {
  const [showItems, setShowItems] = useState(false);
  const sources = s.sources || {};
  return (
    <>
      <div className="rs-rows">
        <Row label="날짜" value={s.date} source={sources.date} />
        <Row
          label="세부내역"
          value={s.detail || '비워 둠'}
          source={sources.detail}
          hint={s.historyDetail && s.detail
            ? `예전에 ${s.historyCount}번 이렇게 적었어요${s.merchant && s.merchant !== s.detail ? ` · 원문: ${s.merchant}` : ''}`
            : ''}
        />
        <Row
          label="금액"
          value={amountText(s)}
          missing={s.amount === null}
          source={s.amount !== null || s.foreignAmount !== null ? amountSource : null}
          hint={s.foreignAmount !== null && s.rate > 0 ? `1 ${s.currency} = ${Math.round(s.rate * 100) / 100}원` : ''}
        />
        {s.event_id && <Row label="일정" value={s.eventTitle} source={sources.event} />}
        <Row
          label="결제수단"
          value={s.payment_method || '직접 선택'}
          missing={!s.payment_method}
          source={sources.payment_method}
          hint={s.paymentHint ? `영수증: ${s.paymentHint}` : saidPaymentHint(s)}
        />
        <Row label="카테고리" value={categoryText(s) || '직접 선택'} missing={!s.budget_category} source={sources.category} />
      </div>

      {s.warnings && s.warnings.length > 0 && (
        <ul className="rs-warnings">
          {s.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}

      {s.items && s.items.length > 0 && (
        <div className="rs-items">
          <button type="button" className="rs-btn-link" onClick={() => setShowItems(v => !v)}>
            품목 {s.items.length}개 {showItems ? '접기' : '보기'}
          </button>
          {showItems && (
            <ul>
              {s.items.map((it, i) => (
                <li key={i}>
                  <span>{it.name}</span>
                  <b>{s.currency === 'KRW' ? `${formatAmount(it.amount)}원` : `${fmtForeign(it.amount)} ${s.currency}`}</b>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/** "카테고리 > 세부카테고리" 하나로 고르는 선택 상자 (목록에서 빠르게 바꿀 때) */
export function CategoryPathSelect({ db, value, onChange, className }) {
  const paths = categoryPaths(db);
  return (
    <select className={className} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">카테고리 선택</option>
      {paths.map(p => <option key={p} value={p}>{p}</option>)}
    </select>
  );
}

/** 선택 상자 값 → { budget_category, sub_category } */
export function splitCategoryPath(path) {
  const [cat = '', sub = ''] = String(path || '').split('>').map(x => x.trim());
  return { budget_category: cat, sub_category: sub };
}
