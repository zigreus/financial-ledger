import React, { useState, useRef, useEffect } from 'react';
import { activeAI, PROVIDERS } from '../../services/aiClient';
import { parseTextEntry } from '../../services/textEntry';
import { isSuggestionComplete, suggestionToTransaction } from '../../services/receiptAssistant';
import { getPaymentMethods } from '../../services/dbManager';
import SuggestionDetails, {
  SourceBadge, amountText, categoryText, CategoryPathSelect, splitCategoryPath,
} from './SuggestionCard';
import './AIEntry.css';

const EXAMPLE = '예) 어제 점심 김치찌개 9천원 현금, 스타벅스 4500 카카오페이';

/**
 * 말로 입력 — 문장을 거래로.
 * 한 건이면 확인 후 폼을 채우고, 여러 건이면 목록에서 고쳐 한 번에 추가한다.
 */
export default function TextPanel({ db, onApply, onBulkAdd, onClose, onSetup }) {
  const [phase, setPhase] = useState('compose'); // compose | analyzing | review | error
  const [text, setText] = useState('');
  const [items, setItems] = useState([]);       // [{ s, checked }]
  const [error, setError] = useState('');
  const abortRef = useRef(null);
  const textRef = useRef(null);

  useEffect(() => {
    if (textRef.current) textRef.current.focus();
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, []);

  const analyze = async () => {
    const ai = activeAI();
    if (!ai) { onSetup(); return; }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    setPhase('analyzing');
    try {
      const list = await parseTextEntry({ db, ai, text, signal: controller.signal });
      if (controller.signal.aborted) return;
      setItems(list.map(s => ({ s, checked: isSuggestionComplete(s) })));
      setPhase('review');
    } catch (e) {
      // 취소한 요청은 어떤 오류로 끝나든 화면을 바꾸지 않는다 — cancelAnalysis가 이미 입력 화면으로 돌렸고,
      // 그 사이 다시 시작한 분석의 화면을 덮어쓰면 안 된다
      if (controller.signal.aborted) return;
      if (e.name === 'AbortError') { setPhase('compose'); return; }
      setError(e.message || '분석에 실패했습니다');
      setPhase('error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const cancelAnalysis = () => {
    if (abortRef.current) abortRef.current.abort();
    setPhase('compose');
  };

  const updateItem = (idx, patch) => {
    setItems(list => list.map((it, i) => {
      if (i !== idx) return it;
      const s = { ...it.s, ...patch, sources: { ...it.s.sources } };
      if ('payment_method' in patch) delete s.sources.payment_method;
      if ('budget_category' in patch) delete s.sources.category;
      return { s, checked: isSuggestionComplete(s) ? (it.checked || !isSuggestionComplete(it.s)) : false };
    }));
  };

  const ai = activeAI();
  const providerLabel = ai ? PROVIDERS[ai.provider].label.split(' ')[0] : '';

  if (phase === 'compose' || phase === 'error') {
    return (
      <div className="rs-box">
        <div className="rs-setup-title">말로 입력</div>
        <textarea
          ref={textRef}
          className="tp-textarea"
          rows={3}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={EXAMPLE}
        />
        <div className="tp-hint">여러 건을 한 번에 적어도 됩니다. 키보드의 마이크 버튼으로 말해도 돼요.</div>
        {phase === 'error' && <div className="rs-error-text">{error}</div>}
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={onClose}>닫기</button>
          {phase === 'error' && <button type="button" className="rs-btn-secondary" onClick={onSetup}>AI 설정</button>}
          <button type="button" className="rs-btn-primary" disabled={!text.trim()} onClick={analyze}>정리하기</button>
        </div>
      </div>
    );
  }

  if (phase === 'analyzing') {
    return (
      <div className="rs-box rs-analyzing">
        <div className="rs-analyzing-text">
          <span className="rs-spinner" />
          정리하는 중…{providerLabel && <small> ({providerLabel})</small>}
        </div>
        <button type="button" className="rs-btn-link" onClick={cancelAnalysis}>취소</button>
      </div>
    );
  }

  // review — 한 건
  if (items.length === 1) {
    const s = items[0].s;
    return (
      <div className="rs-box rs-review">
        <div className="rs-review-title">
          <b>이렇게 입력하시겠습니까?</b>
          <span className="tp-quote">“{text.trim()}”</span>
        </div>
        <SuggestionDetails suggestion={s} amountSource="text" />
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={onClose}>취소</button>
          <button type="button" className="rs-btn-secondary" onClick={() => setPhase('compose')}>다시 쓰기</button>
          <button type="button" className="rs-btn-primary" onClick={() => onApply(s)}>이대로 채우기</button>
        </div>
      </div>
    );
  }

  // review — 여러 건
  const methods = getPaymentMethods(db);
  const selected = items.filter(it => it.checked);
  const selectedTotal = selected.reduce((sum, it) => sum + (it.s.amount || 0), 0);

  return (
    <div className="rs-box rs-review">
      <div className="rs-review-title">
        <b>{items.length}건으로 정리했어요</b>
        <span className="tp-quote">“{text.trim()}”</span>
      </div>

      <div className="tp-list">
        {items.map((it, idx) => {
          const s = it.s;
          const complete = isSuggestionComplete(s);
          return (
            <div key={idx} className={`tp-item${it.checked ? ' checked' : ''}`}>
              <label className="tp-item-head">
                <input
                  type="checkbox"
                  checked={it.checked}
                  disabled={!complete}
                  onChange={e => setItems(list => list.map((x, i) => (i === idx ? { ...x, checked: e.target.checked } : x)))}
                />
                <span className="tp-item-main">
                  <b>{s.detail || '(내용 없음)'}</b>
                  <small>{s.date}{s.eventTitle ? ` · ${s.eventTitle}` : ''}</small>
                </span>
                <span className={`tp-item-amount${s.amount === null ? ' missing' : ''}`}>{amountText(s)}</span>
              </label>

              <div className="tp-item-fields">
                <span className="tp-field">
                  <select
                    value={s.payment_method}
                    onChange={e => updateItem(idx, { payment_method: e.target.value })}
                  >
                    <option value="">결제수단 선택</option>
                    {methods.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <SourceBadge source={s.sources.payment_method} />
                </span>
                <span className="tp-field">
                  <CategoryPathSelect
                    db={db}
                    value={categoryText(s)}
                    onChange={v => updateItem(idx, splitCategoryPath(v))}
                  />
                  <SourceBadge source={s.sources.category} />
                </span>
              </div>

              {!complete && (
                <div className="tp-item-missing">
                  {s.amount === null ? '금액을 몰라요 — ' : '빈 항목을 고르거나 — '}
                  <button type="button" className="rs-btn-link" onClick={() => onApply(s)}>폼에 채워서 입력</button>
                </div>
              )}
              {s.warnings.length > 0 && <div className="tp-item-warn">{s.warnings.join(' · ')}</div>}
            </div>
          );
        })}
      </div>

      <div className="rs-actions">
        <button type="button" className="rs-btn-secondary" onClick={onClose}>취소</button>
        <button type="button" className="rs-btn-secondary" onClick={() => setPhase('compose')}>다시 쓰기</button>
        <button
          type="button"
          className="rs-btn-primary"
          disabled={!selected.length}
          onClick={() => onBulkAdd(selected.map(it => suggestionToTransaction(db, it.s)))}
        >
          {selected.length ? `${selected.length}건 추가 (${selectedTotal.toLocaleString()}원)` : '추가할 건 선택'}
        </button>
      </div>
    </div>
  );
}
