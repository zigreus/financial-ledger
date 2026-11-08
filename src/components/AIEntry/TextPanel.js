import React, { useState, useRef, useEffect } from 'react';
import { activeAI, PROVIDERS } from '../../services/aiClient';
import { parseTextEntry } from '../../services/textEntry';
import { isSuggestionComplete, suggestionToTransaction } from '../../services/receiptAssistant';
import { getPaymentMethods } from '../../services/dbManager';
import SuggestionDetails from './SuggestionCard';
import SuggestionItem, { patchListItem } from './SuggestionItem';
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
  const [progress, setProgress] = useState(''); // 서버가 붐빌 때 "다시 시도하는 중" 등
  const [modelNote, setModelNote] = useState(''); // 고른 모델이 붐벼 다른 모델이 대신 정리했을 때
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
    setProgress('');
    setModelNote('');
    setPhase('analyzing');
    try {
      const list = await parseTextEntry({
        db, ai, text, signal: controller.signal,
        onProgress: (msg, info) => {
          if (controller.signal.aborted) return;
          if (info?.modelUsed) {
            if (info.modelUsed !== ai.model) setModelNote(`${ai.model}이(가) 붐벼서 ${info.modelUsed}(으)로 정리했습니다`);
          } else {
            setProgress(msg);
          }
        },
      });
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
    setItems(list => list.map((it, i) => (i === idx ? patchListItem(it, patch) : it)));
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
          <span className="rs-analyzing-label">
            <span>정리하는 중…{providerLabel && <small> ({providerLabel})</small>}</span>
            {progress && <span className="rs-progress">{progress}</span>}
          </span>
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
        {modelNote && <div className="rs-model-note">{modelNote}</div>}
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
      {modelNote && <div className="rs-model-note">{modelNote}</div>}

      <div className="tp-list">
        {items.map((it, idx) => (
          <SuggestionItem
            key={idx}
            db={db}
            item={it}
            methods={methods}
            onToggle={checked => setItems(list => list.map((x, i) => (i === idx ? { ...x, checked } : x)))}
            onPatch={patch => updateItem(idx, patch)}
            onFillForm={onApply}
          />
        ))}
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
