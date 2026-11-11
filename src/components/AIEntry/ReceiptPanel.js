import React, { useState, useRef, useEffect } from 'react';
import { activeAI, PROVIDERS } from '../../services/aiClient';
import { suggestionToTransaction, isSuggestionComplete } from '../../services/receiptAssistant';
import { analyzePhotos } from '../../services/photoEntry';
import { familiarity, splitFamiliar, QUICK_REASONS } from '../../services/quickEntry';
import { preparePhotos } from '../../services/imageUtils';
import { getMemberNames, getPaymentMethods } from '../../services/dbManager';
import SuggestionDetails, { amountText } from './SuggestionCard';
import SuggestionItem, { patchListItem } from './SuggestionItem';
import QuickAutoNote from './QuickAutoNote';
import { useQuickBatches } from './useQuickBatches';
import { todayStr } from '../../services/dateUtils';
import './AIEntry.css';

const CONFIDENCE_LABEL = { high: '잘 읽힘', medium: '대체로 읽힘', low: '흐림 — 확인 필요' };
const DEVICE_MEMBER = '\u0000device'; // '누가' 고르기의 기본값 — 정하지 않음(App이 이 기기 사용자로)

/** 여러 건 목록에서 미리 체크할 것 — 다 채워졌고, 이미 있거나 겹치거나 취소된 결제가 아니며, 날짜를 실제로 읽었고 앞날짜가 아닌 것 */
const preChecked = s => isSuggestionComplete(s) && !s.duplicateOf && !s.batchDuplicate && !s.pairedCancel
  && s.sources.date !== 'today' && s.date <= todayStr();

function flagReason(s) {
  if (s.pairedCancel) return '같은 사진에 이 결제의 취소가 있어요 — 넣을 때만 고르세요';
  if (s.duplicateOf) return QUICK_REASONS.existing;
  if (s.batchDuplicate) return '앞 줄과 같은 결제예요 — 따로 결제한 것일 때만 고르세요';
  return '';
}

function Thumbs({ previews, count }) {
  if (!previews.length) return null;
  const shown = previews.slice(0, 3);
  const more = count - shown.length;
  return (
    <span className="rs-thumbs">
      {shown.map((src, i) => <img key={i} className="rs-thumb" src={src} alt={`사진 ${i + 1}`} />)}
      {more > 0 && <span className="rs-thumb-more">+{more}</span>}
    </span>
  );
}

/**
 * 사진(영수증 여러 장·결제 내역 캡처) → AI 분석 → 확인 → 입력.
 * 사진 선택창은 부모(AIEntry)가 연다 — 모바일 브라우저는 사용자가 누른 순간에만 열어 주기 때문.
 * files가 바뀔 때마다 새로 분석한다.
 *  - 결제가 한 건이면 지금처럼 "이렇게 입력하시겠습니까?" → 폼 채우기(onApply).
 *    onAutoAdd가 있으면(AI 입력, I-022) 자주 넣던 가게의 분명한 영수증은 확인 없이 바로 넣는다.
 *  - 여러 건이면(영수증 여러 장, 카드 앱의 이용내역 캡처) 자주 넣던 건은 바로 넣고, 나머지는 목록에서 골라
 *    한 번에 추가한다(onBulkAdd). 이미 가계부에 있는 결제·겹쳐 찍은 결제·취소된 결제는 체크 없이 보인다.
 *    가족 카드 내역처럼 한 사람 것이면 결제수단·'누가'를 한 번에 정할 수 있다.
 */
export default function ReceiptPanel({ db, files, onApply, onAutoAdd, onBulkAdd, onRepick, onClose, onSetup }) {
  const [phase, setPhase] = useState('analyzing'); // analyzing | review | list | error
  const [prepared, setPrepared] = useState(null);  // { parts, previews }
  const [suggestion, setSuggestion] = useState(null);
  const [items, setItems] = useState([]);          // 여러 건: [{ s, checked, reason }]
  const [cancels, setCancels] = useState([]);
  const [note, setNote] = useState('');
  const [member, setMember] = useState(DEVICE_MEMBER);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(''); // 서버가 붐빌 때 "다시 시도하는 중" 등
  const [modelNote, setModelNote] = useState(''); // 고른 모델이 붐벼 다른 모델이 대신 읽었을 때
  const [reviewReason, setReviewReason] = useState(''); // 바로 넣지 않고 확인받는 이유
  const abortRef = useRef(null);
  const autoAddRef = useRef(onAutoAdd);
  autoAddRef.current = onAutoAdd;
  const dbRef = useRef(db);
  dbRef.current = db;
  // 여러 건 중 바로 넣은 것 — 되돌리면 목록에 체크 없이 다시 올려 고쳐 넣게 한다
  const { batches, add: addBatch, undoAll, reset: resetBatches } = useQuickBatches(({ suggestions, removed }) => {
    if (removed !== suggestions.length) return;
    setItems(list => [...list, ...suggestions.map(s => ({ s, checked: false, reason: QUICK_REASONS.undone }))]);
  });

  const clearResult = () => {
    setSuggestion(null);
    setItems([]);
    setCancels([]);
    setNote('');
    setReviewReason('');
    setError('');
    setProgress('');
    setModelNote('');
  };

  // 취소(닫기·연속 입력으로 다음 거래·다른 사진)는 언제 하든 같은 컨트롤러를 abort한다.
  // 이미지 준비 단계부터 컨트롤러를 만들어 두어야 그 사이의 취소도 API 호출 전에 막힌다.
  const run = async (photos, controller = new AbortController()) => {
    const ai = activeAI();
    if (!ai) { onSetup(); return; }
    if (abortRef.current && abortRef.current !== controller) abortRef.current.abort();
    abortRef.current = controller;
    if (controller.signal.aborted) return;
    clearResult();
    setPhase('analyzing');
    try {
      const { suggestions, cancels: cancelList, note: aiNote } = await analyzePhotos({
        db: dbRef.current, ai, parts: photos.parts, photos: photos.previews.length, signal: controller.signal,
        onProgress: (msg, info) => {
          if (controller.signal.aborted) return;
          if (info?.modelUsed) {
            if (info.modelUsed !== ai.model) setModelNote(`${ai.model}이(가) 붐벼서 ${info.modelUsed}(으)로 읽었습니다`);
          } else {
            setProgress(msg);
          }
        },
      });
      if (controller.signal.aborted) return;
      const cur = dbRef.current;
      if (!suggestions.length && !cancelList.length) {
        setError('사진에서 결제를 찾지 못했습니다 — 금액이 잘 보이게 다시 찍어 주세요');
        setPhase('error');
        return;
      }

      // 한 건 — 영수증 한 장
      if (suggestions.length === 1 && !cancelList.length) {
        const s = suggestions[0];
        if (autoAddRef.current) {
          const f = familiarity(cur, s, 'receipt');
          if (f.familiar) {
            autoAddRef.current([suggestionToTransaction(cur, s)], { remaining: 0 });
            return; // 바로 넣었다 — 입력 창이 닫힌다
          }
          setReviewReason(f.reason);
        }
        setSuggestion(s);
        setPhase('review');
        return;
      }

      // 여러 건 — 자주 넣던 것은 바로, 나머지는 목록에서 고른다
      const flagged = suggestions.filter(s => flagReason(s));
      const candidates = suggestions.filter(s => !flagged.includes(s));
      const reasons = new Map();
      let familiar = [];
      // 바로 넣지 않고 모두 확인받는 때: AI가 알릴 점(흐림·잘림)을 남겼거나, '누가'를 적는 가계부라 한 번에 정해야 할 때
      // (가족 카드 내역 — 바로 넣으면 이 기기 사용자로 들어가 '누가'가 갈린다)
      const holdAll = !!aiNote || getMemberNames(cur).length > 0;
      if (autoAddRef.current && !holdAll) {
        const split = splitFamiliar(cur, candidates, 'receipt');
        familiar = split.familiar;
        split.review.forEach(r => reasons.set(r.s, r.reason));
      }
      const rest = suggestions.filter(s => !familiar.includes(s));
      const remaining = rest.length + cancelList.filter(c => !c.paired).length;
      if (familiar.length) {
        const handle = autoAddRef.current(familiar.map(s => suggestionToTransaction(cur, s)), { remaining });
        if (!remaining) return; // 모두 넣었다 — 입력 창이 닫힌다
        addBatch(familiar, handle);
      }
      setItems(rest.map(s => ({ s, checked: preChecked(s), reason: flagReason(s) || reasons.get(s) || '' })));
      setCancels(cancelList);
      setNote(aiNote);
      setPhase('list');
    } catch (e) {
      // 취소된 요청은 어떤 오류로 끝나든 화면을 바꾸지 않는다 (취소한 쪽이 이미 화면을 정했다)
      if (controller.signal.aborted || e.name === 'AbortError') return;
      setError(e.message || '분석에 실패했습니다');
      setPhase('error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  useEffect(() => {
    if (!files || !files.length) return undefined;
    const controller = new AbortController();
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = controller;
    // 새 사진 — 이전 사진·결과를 지운다 (준비에 실패했을 때 '다시 시도'가 이전 사진을 보내지 않도록)
    setPrepared(null);
    clearResult(); // 이전 사진의 "붐벼서 다시 시도하는 중…"이 새 사진을 준비하는 동안 남지 않게
    resetBatches();
    setMember(DEVICE_MEMBER);
    setPhase('analyzing');
    (async () => {
      try {
        const photos = await preparePhotos(files);
        if (controller.signal.aborted) return;
        setPrepared(photos);
        await run(photos, controller);
      } catch (e) {
        if (!controller.signal.aborted) { setError(e.message); setPhase('error'); }
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  // 패널이 닫히면 진행 중인 요청을 모두 취소한다 ('다시 시도'로 시작한 요청 포함)
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  const ai = activeAI();
  const providerLabel = ai ? PROVIDERS[ai.provider].label.split(' ')[0] : '';
  const count = files ? files.length : 0;
  const previews = prepared ? prepared.previews : [];

  if (phase === 'analyzing') {
    return (
      <div className="rs-box rs-analyzing">
        <Thumbs previews={previews} count={count} />
        <div className="rs-analyzing-text">
          <span className="rs-spinner" />
          <span className="rs-analyzing-label">
            <span>{count > 1 ? `사진 ${count}장 읽는 중…` : '사진 읽는 중…'}{providerLabel && <small> ({providerLabel})</small>}</span>
            {progress && <span className="rs-progress">{progress}</span>}
          </span>
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
          {prepared && <button type="button" className="rs-btn-primary" onClick={() => run(prepared)}>다시 시도</button>}
        </div>
      </div>
    );
  }

  if (phase === 'review') {
    const s = suggestion;
    return (
      <div className="rs-box rs-review">
        <div className="rs-review-head">
          <Thumbs previews={previews} count={count} />
          <div className="rs-review-title">
            <b>이렇게 입력하시겠습니까?</b>
            <span>{s.merchant || '가맹점 미확인'} · {CONFIDENCE_LABEL[s.confidence]}</span>
            {reviewReason && <span className="quick-reason">확인이 필요한 이유: {reviewReason}</span>}
          </div>
        </div>
        {modelNote && <div className="rs-model-note">{modelNote}</div>}
        <SuggestionDetails suggestion={s} amountSource="receipt" />
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={onClose}>취소</button>
          <button type="button" className="rs-btn-secondary" onClick={onRepick}>다시 찍기</button>
          <button type="button" className="rs-btn-primary" onClick={() => onApply(s)}>이대로 채우기</button>
        </div>
      </div>
    );
  }

  // 여러 건
  const methods = getPaymentMethods(db);
  const members = getMemberNames(db);
  const selected = items.filter(it => it.checked);
  const selectedTotal = selected.reduce((sum, it) => sum + (it.s.amount || 0), 0);
  const unpaired = cancels.filter(c => !c.paired);
  const setAllPayment = (method) => {
    if (!method) return;
    // 이미 있거나 겹치거나 되돌린 결제는 다 채워져도 체크하지 않는다 — 한 줄씩 직접 고른다
    setItems(list => list.map(it => {
      const next = patchListItem(it, { payment_method: method });
      // 이번에 다 채워진 줄도 미리 체크할 만한 것(날짜를 읽음·겹치지 않음 등)만 체크한다
      const fresh = !isSuggestionComplete(it.s) && preChecked(next.s) && it.reason !== QUICK_REASONS.undone;
      return { ...next, checked: it.checked || fresh };
    }));
  };
  const confirm = () => {
    const cur = dbRef.current;
    onBulkAdd(selected.map(it => {
      const row = suggestionToTransaction(cur, it.s);
      return member === DEVICE_MEMBER ? row : { ...row, member };
    }));
  };
  const toggle = (idx, checked) => setItems(list => list.map((x, i) => (i === idx ? { ...x, checked } : x)));
  const patch = (idx, p) => setItems(list => list.map((x, i) => (i === idx ? patchListItem(x, p) : x)));

  return (
    <div className="rs-box rs-review">
      <div className="rs-review-head">
        <Thumbs previews={previews} count={count} />
        <div className="rs-review-title">
          <b>
            {!items.length ? '취소·환불 내역을 확인해 주세요'
              : batches.length ? `확인이 필요한 결제 ${items.length}건` : `사진에서 결제 ${items.length}건을 찾았어요`}
          </b>
          <QuickAutoNote batches={batches} onUndo={undoAll} />
        </div>
      </div>
      {modelNote && <div className="rs-model-note">{modelNote}</div>}
      {note && <div className="tp-item-warn">{note}</div>}

      {items.length > 1 && (
        <div className="tp-item-fields rs-bulk">
          <span className="tp-field">
            <select value="" onChange={e => setAllPayment(e.target.value)} aria-label="결제수단 모두 바꾸기">
              <option value="">결제수단 모두 바꾸기</option>
              {methods.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </span>
          {members.length > 0 && (
            <span className="tp-field">
              <select value={member} onChange={e => setMember(e.target.value)} aria-label="누가">
                <option value={DEVICE_MEMBER}>누가: 이 기기 사용자</option>
                {members.map(m => <option key={m} value={m}>누가: {m}</option>)}
              </select>
            </span>
          )}
        </div>
      )}

      <div className="tp-list">
        {items.map((it, idx) => (
          <SuggestionItem
            key={idx}
            db={db}
            item={it}
            methods={methods}
            subtitle={[it.s.date, it.s.paymentHint, it.s.eventTitle, it.reason].filter(Boolean).join(' · ')}
            onToggle={checked => toggle(idx, checked)}
            onPatch={p => patch(idx, p)}
            onFillForm={onApply}
          />
        ))}
      </div>

      {cancels.length > 0 && (
        <div className="rs-cancels">
          <b>취소·환불 {cancels.length}건은 넣지 않아요</b>
          {cancels.map((c, i) => (
            <span key={i}>
              {c.date} {c.merchant || '가맹점 모름'}{c.amount !== null || c.foreignAmount !== null ? ` -${amountText(c)}` : ''}
              {c.paired ? ' (위 결제와 짝)' : ''}
            </span>
          ))}
          {unpaired.length > 0 && <small>이미 가계부에 넣은 결제의 취소라면 거래내역에서 지워 주세요</small>}
        </div>
      )}

      <div className="rs-actions">
        <button type="button" className="rs-btn-secondary" onClick={onClose}>취소</button>
        <button type="button" className="rs-btn-secondary" onClick={onRepick}>다른 사진</button>
        <button type="button" className="rs-btn-primary" disabled={!selected.length} onClick={confirm}>
          {selected.length ? `${selected.length}건 추가 (${selectedTotal.toLocaleString()}원)` : '추가할 건 선택'}
        </button>
      </div>
    </div>
  );
}
