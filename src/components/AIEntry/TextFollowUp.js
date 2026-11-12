import React, { useEffect, useRef } from 'react';
import { isSuggestionComplete, normalizeName, suggestionName } from '../../services/receiptAssistant';
import './AIEntry.css';

/**
 * 말로 입력의 되묻기·덧붙여 말하기 (I-017).
 * 정리한 건마다 빠진 정보를 알려 주고, 덧붙인 말을 처음 말과 합쳐 다시 정리하게 한다.
 * 목록에서 직접 고른 값·체크를 끈 건은 다시 정리해도 남긴다(carryChoices).
 */

export const GAP_LABEL = {
  detail: '무엇에 썼는지',
  amount: '금액',
  krw_amount: '원화 금액',
  payment_method: '결제수단',
  budget_category: '카테고리',
  sub_category: '세부카테고리',
};

// 덧붙여 말할 때 예시 — 빠진 정보 순서대로 두 개까지
const GAP_EXAMPLE = {
  detail: '점심 김치찌개였어요',
  amount: '9천원이었어요',
  krw_amount: '원화로 2만7천원이었어요',
  payment_method: '현금으로 냈어요',
  budget_category: '식비예요',
  sub_category: '식비 중 점심이에요',
};

/**
 * 추천 한 건에서 빠진 정보 — 저장에 꼭 필요한 것(금액·결제수단·카테고리)과, 무엇에 썼는지.
 * 세부내역은 꼭 채우지 않는다 — 카테고리를 알면(예: 식비 > 저녁) 무엇에 썼는지 묻지 않는다 (I-056).
 * 외화 금액은 읽었는데 환율·여행 일정이 없어 원화를 못 구했으면 '원화 금액'을 묻는다 (외화를 다시 말해도 소용없다).
 */
export function suggestionGaps(s) {
  const gaps = [];
  if (!s.detail && !s.merchant && !s.budget_category) gaps.push('detail');
  if (s.amount === null || s.amount === undefined) {
    gaps.push(s.foreignAmount !== null && s.foreignAmount !== undefined ? 'krw_amount' : 'amount');
  }
  if (!s.payment_method) gaps.push('payment_method');
  if (!s.budget_category) gaps.push('budget_category');
  else if (!s.sub_category) gaps.push('sub_category');
  return gaps;
}

const itemName = (s, index) => suggestionName(s) || `${index + 1}번째 건`;

/** 빠진 정보가 있는 건 목록 — [{ index, name, gaps }] */
export function describeGaps(items) {
  return items
    .map((it, index) => ({ index, name: itemName(it.s, index), gaps: suggestionGaps(it.s) }))
    .filter(g => g.gaps.length);
}

const gapWords = gaps => gaps.map(g => GAP_LABEL[g]).join('·');

/** 앱이 물은 것 — 다시 정리할 때 AI에게 덧붙인 말과 함께 보낸다 */
export function gapQuestion(list, total) {
  if (!list.length) return '';
  if (total === 1) return `${gapWords(list[0].gaps)}을(를) 몰라요. 알려 주세요.`;
  return `빠진 정보를 알려 주세요 — ${list.map(g => `${g.name}: ${gapWords(g.gaps)}`).join(', ')}`;
}

export function gapPlaceholder(list) {
  const seen = [];
  list.forEach(g => g.gaps.forEach((k) => { if (!seen.includes(k)) seen.push(k); }));
  const examples = seen.slice(0, 2).map(k => GAP_EXAMPLE[k]);
  return examples.length ? `예) ${examples.join(', ')}` : '예) 스타벅스는 카드로 냈어요';
}

// ── 목록에서 고른 값 남기기 ─────────────────────────────────────

const categoryOf = s => (s.budget_category ? `${s.budget_category} > ${s.sub_category || ''}` : '');

/**
 * 목록에서 고친 값을 기억한다 → { payment_method: { from, to }, category: { from, to } }.
 * from은 처음 고치기 전 값(같은 칸을 여러 번 바꿔도 처음 값), to는 마지막으로 고른 값이다.
 */
export function recordPick(item, patch) {
  const picks = { ...(item.picks || {}) };
  if ('payment_method' in patch) {
    picks.payment_method = {
      from: picks.payment_method ? picks.payment_method.from : item.s.payment_method,
      to: patch.payment_method,
    };
  }
  if ('budget_category' in patch) {
    picks.category = {
      from: picks.category ? picks.category.from : categoryOf(item.s),
      to: categoryOf({ budget_category: patch.budget_category, sub_category: patch.sub_category }),
    };
  }
  return picks;
}

/**
 * 고른 값을 새로 정리한 건에 다시 얹는다.
 * 새 값이 비었거나 고치기 전 값과 같으면(새로 알게 된 것이 없으면) 고른 값을 쓰고,
 * 덧붙인 말로 다른 값이 나왔으면 그 말을 따른다.
 * 한계: 덧붙인 말이 마침 고치기 전 값과 같으면(습관으로 신한카드 → 목록에서 현금 → "신한카드였어") 고른 값이 남는다.
 * 처음 말에 있던 값과 구별할 수 없어서다 — 드물고, 목록에서 다시 고르면 된다.
 */
function applyPicks(s, picks) {
  const out = { ...s, sources: { ...s.sources } };
  const pay = picks.payment_method;
  if (pay && (!s.payment_method || s.payment_method === pay.from)) {
    out.payment_method = pay.to;
    delete out.sources.payment_method;
  }
  const cat = picks.category;
  if (cat && (!s.budget_category || categoryOf(s) === cat.from)) {
    const [budget = '', sub = ''] = cat.to.split('>').map(x => x.trim());
    out.budget_category = budget;
    out.sub_category = sub;
    delete out.sources.category;
  }
  return out;
}

const nameOf = suggestionName;

/**
 * 다시 정리한 결과를 목록으로 → { items, dropped }.
 * 예전 목록의 같은 건에서 고른 값(picks)과 체크를 끈 것(off)을 이어받는다.
 * - 이름(세부내역·가게)이 같은 건끼리 먼저, 다음으로 새 이름이 예전 이름을 품는 건끼리 맞춘다
 *   ("김치찌개" → "점심 김치찌개"). 반대 방향은 보지 않는다 — 짧은 새 이름("커피")이 다른 긴 이름("커피빈 케이크")에 걸리지 않게.
 *   AI가 순서를 바꿔도 엉뚱한 건에 얹지 않는다.
 * - 그래도 못 맞춘 건이 양쪽에 하나씩만 남고 금액이 같으면 이름을 고친 같은 건으로 본다 ("점심" → "김치찌개").
 *   이때는 확신이 약해 결제수단만 이어받는다 (다른 건에 카테고리까지 얹지 않게).
 * dropped: 예전 목록에 있었는데 새 목록에서 짝을 못 찾은 건 (AI가 덧붙인 말 얘기만 돌려주는 경우 등)
 */
export function carryChoices(oldItems, suggestions) {
  const match = new Array(suggestions.length).fill(-1);
  const weak = new Set(); // 금액만 같아 짝지은 새 건
  const used = new Set();
  const pair = (same) => {
    suggestions.forEach((s, i) => {
      const name = normalizeName(nameOf(s));
      if (match[i] >= 0 || !name) return;
      const k = oldItems.findIndex((it, j) => !used.has(j) && same(normalizeName(nameOf(it.s)), name));
      if (k >= 0) { match[i] = k; used.add(k); }
    });
  };
  pair((a, b) => a === b);
  pair((oldName, newName) => oldName.length >= 2 && newName.includes(oldName));
  const freeNew = match.map((k, i) => (k < 0 ? i : -1)).filter(i => i >= 0);
  const freeOld = oldItems.map((_, j) => j).filter(j => !used.has(j));
  if (freeNew.length === 1 && freeOld.length === 1) {
    const a = suggestions[freeNew[0]].amount;
    const b = oldItems[freeOld[0]].s.amount;
    if (a !== null && a !== undefined && a === b) {
      match[freeNew[0]] = freeOld[0];
      used.add(freeOld[0]);
      weak.add(freeNew[0]);
    }
  }

  const items = suggestions.map((s, i) => {
    const old = match[i] >= 0 ? oldItems[match[i]] : null;
    let picks = old && old.picks ? old.picks : null;
    if (picks && weak.has(i)) picks = picks.payment_method ? { payment_method: picks.payment_method } : null;
    const next = picks ? applyPicks(s, picks) : s;
    const item = { s: next, checked: isSuggestionComplete(next) && !(old && old.off) };
    if (picks) item.picks = picks;
    if (old && old.off) item.off = true;
    return item;
  });
  // matched[i]: 새 건 i가 이어받은 예전 줄의 번호(-1이면 새로 나타난 건)
  return { items, dropped: oldItems.filter((_, j) => !used.has(j)), matched: match };
}

// ── 화면 ──────────────────────────────────────────────────────

/** 지금까지 말한 것 — 처음 말과 덧붙인 말 */
export function SaidSoFar({ text, followUps }) {
  return (
    <span className="tp-quote">
      “{String(text || '').trim()}”
      {followUps.map((f, i) => <span key={i} className="tp-quote-more">+ “{f.said}”</span>)}
    </span>
  );
}

/**
 * 덧붙여 말하기 상자.
 * question: 되묻는 말(결제 건을 못 찾았을 때), gaps: describeGaps 결과(정리한 건에 빠진 정보가 있을 때).
 * onSetup을 주면 오류 아래에 AI 설정 버튼을 보여 준다 (키·모델 문제일 때).
 * autoFocus는 상자가 처음 나타날 때만 본다 — 사용자가 열었을 때 한 번만 키보드를 띄우고, 나중에 값이 바뀌어도 다시 띄우지 않는다.
 */
export function FollowUpBox({
  question, gaps = [], total = 0, value, onChange, onSubmit, error, onSetup, hint, pendingNote, autoFocus = false,
}) {
  const ref = useRef(null);
  const focusOnOpen = useRef(autoFocus);
  useEffect(() => {
    if (focusOnOpen.current && ref.current) ref.current.focus();
  }, []);

  let title = null;
  if (question) title = <div className="tp-ask">{question}</div>;
  else if (gaps.length) title = <div className="tp-followup-title">빠진 정보가 있어요 — 덧붙여 말해 주세요</div>;
  else title = <div className="tp-followup-title">덧붙이거나 고칠 것을 말해 주세요</div>;

  let placeholder = gapPlaceholder(gaps);
  if (question) placeholder = '예) 점심에 김치찌개 9천원, 현금으로 냈어요';

  return (
    <div className="tp-followup">
      {title}
      {!question && gaps.length > 0 && (
        <ul className="tp-gaps">
          {gaps.map(g => (
            <li key={g.index}>
              {total > 1 && <b>{g.name}</b>}
              <span>{gapWords(g.gaps)}</span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        className="tp-textarea"
        rows={2}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {hint && <div className="tp-hint">{hint}</div>}
      {pendingNote && value.trim() && <div className="tp-pending">{pendingNote}</div>}
      {error && <div className="rs-error-text">{error}</div>}
      <div className="tp-followup-actions">
        {error && onSetup && <button type="button" className="rs-btn-secondary" onClick={onSetup}>AI 설정</button>}
        <button type="button" className="rs-btn-primary" disabled={!value.trim()} onClick={onSubmit}>
          덧붙여 정리하기
        </button>
      </div>
    </div>
  );
}
