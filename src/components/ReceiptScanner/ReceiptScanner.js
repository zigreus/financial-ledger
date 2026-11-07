import React, { useState, useRef, useEffect } from 'react';
import { activeAI, PROVIDERS } from '../../services/aiClient';
import { analyzeReceipt, SOURCE_LABEL } from '../../services/receiptAssistant';
import { prepareImage } from '../../services/imageUtils';
import { formatAmount } from '../../services/formulaEvaluator';
import AISettingsForm from './AISettingsForm';
import './ReceiptScanner.css';

const CONFIDENCE_LABEL = { high: '잘 읽힘', medium: '대체로 읽힘', low: '흐림 — 확인 필요' };

function fmtForeign(n) {
  return (Math.round(n * 100) / 100).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

function SourceBadge({ source }) {
  if (!source) return null;
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

/**
 * 영수증 사진 → AI 분석 → "이렇게 입력하시겠습니까?" 확인 → 폼 채우기.
 * 저장은 하지 않는다 — 채운 뒤 사용자가 폼에서 확인하고 직접 추가한다.
 * resetKey가 바뀌면(연속 입력으로 다음 거래로 넘어가면) 처음 상태로 돌아간다.
 */
export default function ReceiptScanner({ db, onApply, resetKey }) {
  const [phase, setPhase] = useState('idle'); // idle | setup | analyzing | review | applied | error
  const [image, setImage] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [error, setError] = useState('');
  const [showItems, setShowItems] = useState(false);
  const fileRef = useRef(null);
  const abortRef = useRef(null);
  const firstResetRef = useRef(true);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  useEffect(() => {
    if (firstResetRef.current) { firstResetRef.current = false; return; }
    if (abortRef.current) abortRef.current.abort();
    setPhase('idle');
    setImage(null);
    setSuggestion(null);
    setError('');
  }, [resetKey]);

  // 사진 고르기 — 설정이 없으면 설정부터
  const pick = () => {
    if (!activeAI()) { setPhase('setup'); return; }
    if (fileRef.current) {
      fileRef.current.value = '';
      fileRef.current.click();
    }
  };

  const run = async (img) => {
    const ai = activeAI();
    if (!ai) { setPhase('setup'); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    setSuggestion(null);
    setShowItems(false);
    setPhase('analyzing');
    try {
      const s = await analyzeReceipt({ db, ai, image: img, signal: controller.signal });
      setSuggestion(s);
      setPhase('review');
    } catch (e) {
      if (e.name === 'AbortError') { setPhase('idle'); return; }
      setError(e.message || '분석에 실패했습니다');
      setPhase('error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      setPhase('analyzing');
      const img = await prepareImage(file);
      setImage(img);
      await run(img);
    } catch (err) {
      setError(err.message);
      setPhase('error');
    }
  };

  const cancelAnalysis = () => {
    if (abortRef.current) abortRef.current.abort();
    setPhase('idle');
  };

  const apply = () => {
    onApply(suggestion);
    setPhase('applied');
  };

  const providerLabel = (() => {
    const ai = activeAI();
    return ai ? PROVIDERS[ai.provider].label.split(' ')[0] : '';
  })();

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*"
      onChange={onFile}
      style={{ display: 'none' }}
    />
  );

  let body;
  if (phase === 'setup') {
    body = (
      <div className="rs-box">
        <div className="rs-setup-title">AI 영수증 분석 설정</div>
        <div className="rs-setup-desc">
          한 번만 설정하면 됩니다. 사진만 찍으면 날짜·금액·가게를 읽고, 예전 입력 습관에 맞춰 분류를 추천합니다.
        </div>
        <AISettingsForm compact onSaved={() => { setPhase('idle'); pick(); }} onCancel={() => setPhase('idle')} />
      </div>
    );
  } else if (phase === 'analyzing') {
    body = (
      <div className="rs-box rs-analyzing">
        {image && <img className="rs-thumb" src={image.dataUrl} alt="영수증" />}
        <div className="rs-analyzing-text">
          <span className="rs-spinner" />
          영수증 읽는 중…{providerLabel && <small> ({providerLabel})</small>}
        </div>
        <button type="button" className="rs-btn-link" onClick={cancelAnalysis}>취소</button>
      </div>
    );
  } else if (phase === 'error') {
    body = (
      <div className="rs-box rs-error">
        <div className="rs-error-text">{error}</div>
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={() => setPhase('setup')}>AI 설정</button>
          <button type="button" className="rs-btn-secondary" onClick={pick}>다른 사진</button>
          {image && <button type="button" className="rs-btn-primary" onClick={() => run(image)}>다시 시도</button>}
        </div>
      </div>
    );
  } else if (phase === 'review' && suggestion) {
    const s = suggestion;
    const sources = s.sources;
    let amountValue;
    if (s.foreignAmount !== null) {
      amountValue = `${fmtForeign(s.foreignAmount)} ${s.currency}`
        + (s.amount !== null ? ` ≈ ${formatAmount(s.amount)}원` : '');
    } else {
      amountValue = s.amount !== null ? `${formatAmount(s.amount)}원` : '읽지 못함';
    }
    const categoryValue = s.budget_category
      ? `${s.budget_category}${s.sub_category ? ` > ${s.sub_category}` : ''}`
      : '직접 선택';

    body = (
      <div className="rs-box rs-review">
        <div className="rs-review-head">
          {image && <img className="rs-thumb" src={image.dataUrl} alt="영수증" />}
          <div className="rs-review-title">
            <b>이렇게 입력하시겠습니까?</b>
            <span>
              {s.merchant || '가맹점 미확인'} · {CONFIDENCE_LABEL[s.confidence]}
            </span>
          </div>
        </div>

        <div className="rs-rows">
          <Row label="날짜" value={s.date} source={sources.date} />
          <Row
            label="세부내역"
            value={s.detail || '직접 입력'}
            missing={!s.detail}
            source={sources.detail}
            hint={s.historyDetail
              ? `예전에 ${s.historyCount}번 이렇게 적었어요${s.merchant && s.merchant !== s.detail ? ` · 영수증: ${s.merchant}` : ''}`
              : ''}
          />
          <Row
            label="금액"
            value={amountValue}
            missing={s.amount === null}
            source={s.amount !== null || s.foreignAmount !== null ? 'receipt' : null}
            hint={s.foreignAmount !== null && s.rate > 0 ? `1 ${s.currency} = ${Math.round(s.rate * 100) / 100}원` : ''}
          />
          {s.event_id && <Row label="일정" value={s.eventTitle} source={sources.event} />}
          <Row
            label="결제수단"
            value={s.payment_method || '직접 선택'}
            missing={!s.payment_method}
            source={sources.payment_method}
            hint={s.paymentHint ? `영수증: ${s.paymentHint}` : ''}
          />
          <Row label="카테고리" value={categoryValue} missing={!s.budget_category} source={sources.category} />
        </div>

        {s.warnings.length > 0 && (
          <ul className="rs-warnings">
            {s.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}

        {s.items.length > 0 && (
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

        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={() => setPhase('idle')}>취소</button>
          <button type="button" className="rs-btn-secondary" onClick={pick}>다시 찍기</button>
          <button type="button" className="rs-btn-primary" onClick={apply}>이대로 채우기</button>
        </div>
      </div>
    );
  } else {
    // idle / applied
    body = (
      <div className="rs-idle">
        <button type="button" className="rs-scan-btn" onClick={pick}>
          <span className="rs-scan-icon">📷</span>
          <span className="rs-scan-text">
            {phase === 'applied' ? '다른 영수증으로 다시 채우기' : '영수증 찍어서 입력'}
            <small>
              {phase === 'applied'
                ? '✓ 영수증 내용을 채웠습니다 — 확인 후 추가하세요'
                : 'AI가 읽고 예전 입력 습관에 맞춰 채워 드려요'}
            </small>
          </span>
        </button>
        <button type="button" className="rs-gear" onClick={() => setPhase('setup')} title="AI 설정">⚙</button>
      </div>
    );
  }

  // 파일 입력은 항상 같은 자리에 둔다 — 단계가 바뀌어도 다시 만들어지지 않아야
  // 설정 직후 연 사진 선택창의 결과가 사라지지 않는다
  return (
    <>
      {fileInput}
      {body}
    </>
  );
}
