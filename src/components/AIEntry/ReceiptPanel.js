import React, { useState, useRef, useEffect } from 'react';
import { activeAI, PROVIDERS } from '../../services/aiClient';
import { analyzeReceipt } from '../../services/receiptAssistant';
import { prepareImage } from '../../services/imageUtils';
import SuggestionDetails from './SuggestionCard';
import './AIEntry.css';

const CONFIDENCE_LABEL = { high: '잘 읽힘', medium: '대체로 읽힘', low: '흐림 — 확인 필요' };

/**
 * 영수증 사진 → AI 분석 → "이렇게 입력하시겠습니까?" → 폼 채우기.
 * 사진 선택창은 부모(AIEntry)가 연다 — 모바일 브라우저는 사용자가 누른 순간에만 열어 주기 때문.
 * file이 바뀔 때마다 새로 분석한다.
 */
export default function ReceiptPanel({ db, file, onApply, onRepick, onClose, onSetup }) {
  const [phase, setPhase] = useState('analyzing'); // analyzing | review | error
  const [image, setImage] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [error, setError] = useState('');
  const abortRef = useRef(null);
  const dbRef = useRef(db);
  dbRef.current = db;

  const run = async (img) => {
    const ai = activeAI();
    if (!ai) { onSetup(); return; }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    setSuggestion(null);
    setPhase('analyzing');
    try {
      const s = await analyzeReceipt({ db: dbRef.current, ai, image: img, signal: controller.signal });
      setSuggestion(s);
      setPhase('review');
    } catch (e) {
      if (e.name === 'AbortError') return;
      setError(e.message || '분석에 실패했습니다');
      setPhase('error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  useEffect(() => {
    if (!file) return undefined;
    let cancelled = false;
    (async () => {
      try {
        setPhase('analyzing');
        const img = await prepareImage(file);
        if (cancelled) return;
        setImage(img);
        await run(img);
      } catch (e) {
        if (!cancelled) { setError(e.message); setPhase('error'); }
      }
    })();
    return () => { cancelled = true; if (abortRef.current) abortRef.current.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const ai = activeAI();
  const providerLabel = ai ? PROVIDERS[ai.provider].label.split(' ')[0] : '';

  if (phase === 'analyzing') {
    return (
      <div className="rs-box rs-analyzing">
        {image && <img className="rs-thumb" src={image.dataUrl} alt="영수증" />}
        <div className="rs-analyzing-text">
          <span className="rs-spinner" />
          영수증 읽는 중…{providerLabel && <small> ({providerLabel})</small>}
        </div>
        <button type="button" className="rs-btn-link" onClick={onClose}>취소</button>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="rs-box rs-error">
        <div className="rs-error-text">{error}</div>
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={onClose}>닫기</button>
          <button type="button" className="rs-btn-secondary" onClick={onSetup}>AI 설정</button>
          <button type="button" className="rs-btn-secondary" onClick={onRepick}>다른 사진</button>
          {image && <button type="button" className="rs-btn-primary" onClick={() => run(image)}>다시 시도</button>}
        </div>
      </div>
    );
  }

  const s = suggestion;
  return (
    <div className="rs-box rs-review">
      <div className="rs-review-head">
        {image && <img className="rs-thumb" src={image.dataUrl} alt="영수증" />}
        <div className="rs-review-title">
          <b>이렇게 입력하시겠습니까?</b>
          <span>{s.merchant || '가맹점 미확인'} · {CONFIDENCE_LABEL[s.confidence]}</span>
        </div>
      </div>
      <SuggestionDetails suggestion={s} amountSource="receipt" />
      <div className="rs-actions">
        <button type="button" className="rs-btn-secondary" onClick={onClose}>취소</button>
        <button type="button" className="rs-btn-secondary" onClick={onRepick}>다시 찍기</button>
        <button type="button" className="rs-btn-primary" onClick={() => onApply(s)}>이대로 채우기</button>
      </div>
    </div>
  );
}
