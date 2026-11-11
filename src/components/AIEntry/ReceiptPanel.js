import React, { useState, useRef, useEffect } from 'react';
import { activeAI, PROVIDERS } from '../../services/aiClient';
import { suggestionToTransaction, isSuggestionComplete } from '../../services/receiptAssistant';
import { analyzePhotos, markDuplicates } from '../../services/photoEntry';
import { familiarity, splitFamiliar, QUICK_REASONS } from '../../services/quickEntry';
import { preparePhotos } from '../../services/imageUtils';
import { getMemberNames, getPaymentMethods } from '../../services/dbManager';
import SuggestionDetails, { amountText } from './SuggestionCard';
import SuggestionItem, { patchListItem } from './SuggestionItem';
import QuickAutoNote from './QuickAutoNote';
import { useQuickBatches } from './useQuickBatches';
import { isValidDateStr } from '../../services/dateUtils';
import { formatAmount } from '../../services/formulaEvaluator';
import './AIEntry.css';

const CONFIDENCE_LABEL = { high: '잘 읽힘', medium: '대체로 읽힘', low: '흐림 — 확인 필요' };
const DEVICE_MEMBER = '\u0000device'; // '누가' 고르기의 기본값 — 정하지 않음(App이 이 기기 사용자로)

/**
 * 직접 고쳐야 할 줄의 이유 — s.needsFix([{ text, fields }], photoEntry) 중 아직 고치지 않은 것.
 * 그 점의 칸(fields — 간편결제면 세부내역·카테고리, 날짜를 못 읽었으면 날짜)을 고치면 풀리고, 읽은 값으로 되돌리면 다시 보인다.
 * 이미 있거나 겹친 결제는 넣을 줄이 아니라 고칠 것도 없다
 */
const needsFixOf = (it) => {
  if (flagReason(it.s)) return '';
  const changed = k => (it.s[k] ?? '') !== (it.original[k] ?? '');
  return (it.s.needsFix || []).filter(f => !f.fields.some(changed)).map(f => f.text).join(' · ');
};

/** 넣을 수 있는 줄 — 빈 칸 없이, 올바른 날짜와 0보다 큰 금액 */
const addable = s => isSuggestionComplete(s) && isValidDateStr(s.date) && Number(s.amount) > 0;

/**
 * 여러 건 목록에서 미리 체크할 것 — 넣을 수 있고, 이미 있거나 겹치거나 취소된 결제가 아닌 것(사용자 요청: 중복이 아니면 기본 선택).
 * 날짜를 못 읽었거나 잘 안 읽힌 결제도 체크해 두고, 그 사실은 줄의 날짜·경고·AI 메모로 알린다
 */
const preChecked = s => addable(s) && !flagReason(s);

/** 겹친 결제의 이유 — 목록을 고칠 때마다 다시 따진다(markDuplicates) */
function flagReason(s) {
  if (s.pairedCancel) return '같은 사진에 이 결제의 취소가 있어요 — 넣을 때만 고르세요';
  if (s.duplicateOf) {
    const d = s.duplicateOf;
    return `이미 넣은 거래가 있어요(${d.detail || '내용 없음'} ${formatAmount(d.amount)}원 · ${d.payment_method}) — 또 넣을 때만 고르세요`;
  }
  if (s.batchDuplicate) return '앞 줄과 같은 결제예요 — 따로 결제한 것일 때만 고르세요';
  return '';
}

/** 어떤 겹침인지 — 같은 겹침에 대해 사용자가 정한 체크는 지킨다 */
const flagKey = s => (s.pairedCancel ? 'cancel' : s.duplicateOf ? `tx${s.duplicateOf.id}` : s.batchDuplicate ? 'batch' : '');

/**
 * 목록 한 줄 — checked는 사용자의 뜻(넣을 수 없는 동안에는 빠진다), decided는 그 체크를 정할 때의 겹침,
 * ever는 넣을 수 있던 적이 있는지, original·originalReason은 되돌리기용 처음 읽은 값, rev는 되돌린 횟수
 */
const listItem = (s, checked, reason = '') => ({
  s, checked, reason, decided: flagKey(s), ever: addable(s), original: s, originalReason: reason, rev: 0,
});

/** 실제로 넣을 줄 */
const isSelected = it => it.checked && addable(it.s);

/**
 * 목록을 고친 뒤(또는 넣기 직전에) 겹친 결제를 다시 따지고 체크를 맞춘다. 체크는 겹침이 달라질 때만 건드린다.
 *  - 입력 중이라 넣을 수 없는 줄(빈 금액·"1000+")은 그대로 둔다 — 넣을 때만 빠지고, 다 고치면 사용자의 체크가 살아 있다
 *  - 처음으로 넣을 수 있게 된 줄(결제수단을 고름 등)은 미리 체크할 만한지 본다
 *  - 새로 겹치면(이미 있는 거래·앞 줄과 같아짐) 끈다
 *  - 겹침이 풀리면 고친 그 줄(edited)만 미리 체크할 만한지 다시 본다. 다른 줄은 저절로 켜지 않는다
 *    (한 줄을 고쳐 겹친 짝이 풀려도 그 짝이 켜져 같은 결제가 두 번 들어가지 않게)
 * confirming: 넣기 직전 — 끄기만 한다. claimed: 이 화면에서 바로 넣은 추천 — 그 거래는 목록과 짝짓지 않는다
 */
function refresh(db, list, { edited = -1, confirming = false, claimed = [] } = {}) {
  const marked = markDuplicates(db, list.map(it => it.s), { claimed });
  return list.map((it, i) => {
    const s = marked[i];
    if (!addable(s)) return { ...it, s };
    const key = flagKey(s);
    if (!it.ever) {
      const checked = !confirming && preChecked(s) && it.reason !== QUICK_REASONS.undone;
      return { ...it, s, ever: true, decided: key, checked };
    }
    if (key === it.decided) return { ...it, s };
    if (key) return { ...it, s, decided: key, checked: false };
    const recheck = !confirming && i === edited && preChecked(s) && it.reason !== QUICK_REASONS.undone;
    return { ...it, s, decided: '', checked: recheck || it.checked };
  });
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
  const [items, setItems] = useState([]);          // 여러 건: listItem들
  const [listNote, setListNote] = useState('');    // 넣으려다 멈춘 이유 (그사이 같은 거래가 들어옴)
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
  const batchesRef = useRef([]);
  /** 이 화면에서 바로 넣고 아직 되돌리지 않은 추천 — 그 거래를 목록의 '이미 있는 거래'로 보지 않는다 */
  const claimedNow = (exceptId) => batchesRef.current
    .filter(b => b.removed === null && b.id !== exceptId).flatMap(b => b.suggestions);
  const { batches, add: addBatch, undoAll, reset: resetBatches } = useQuickBatches(({ id, suggestions, removed }) => {
    if (removed !== suggestions.length) return;
    // 되돌려 가계부에서 빠졌다 — 체크 없이 목록에 다시 올리고 겹친 결제를 다시 따진다
    setItems(list => refresh(dbRef.current,
      [...list, ...suggestions.map(s => ({ ...listItem(s, false, QUICK_REASONS.undone), ever: true }))],
      { claimed: claimedNow(id) }));
  });
  batchesRef.current = batches;

  const clearResult = () => {
    setSuggestion(null);
    setItems([]);
    setListNote('');
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
      // 겹친 결제, AI가 확실하지 않다고 메모를 남긴 결제, 직접 고쳐야 할 결제는 바로 넣지 않는다
      const flagged = suggestions.filter(s => flagReason(s) || s.aiNote || (s.needsFix && s.needsFix.length));
      const candidates = suggestions.filter(s => !flagged.includes(s));
      const reasons = new Map();
      let familiar = [];
      // 바로 넣지 않고 모두 확인받는 때: AI가 알릴 점(흐림·잘림)을 남겼거나, '누가'를 적는 가계부라 한 번에 정해야 할 때
      // (가족 카드 내역 — 바로 넣으면 이 기기 사용자로 들어가 '누가'가 갈린다)
      const holdAll = !!aiNote || getMemberNames(cur).length > 0;
      if (autoAddRef.current && !holdAll) {
        const split = splitFamiliar(cur, candidates, 'receipt');
        familiar = split.familiar;
        // 이미 있는 거래는 목록이 한 거래에 한 줄씩 따로 따진다(markDuplicates) — 여기서는 그 밖의 이유만
        split.review.forEach(r => { if (!/^같은 날 같은 금액 거래가 이미 있어요/.test(r.reason)) reasons.set(r.s, r.reason); });
      }
      const rest = suggestions.filter(s => !familiar.includes(s));
      const remaining = rest.length + cancelList.filter(c => !c.paired).length;
      if (familiar.length) {
        const handle = autoAddRef.current(familiar.map(s => suggestionToTransaction(cur, s)), { remaining });
        if (!remaining) return; // 모두 넣었다 — 입력 창이 닫힌다
        addBatch(familiar, handle);
      }
      setItems(rest.map(s => listItem(s, preChecked(s), reasons.get(s) || '')));
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
  const selected = items.filter(isSelected);
  const fixCount = items.filter(needsFixOf).length;
  const unfixedSelected = selected.filter(needsFixOf).length;
  const selectedTotal = selected.reduce((sum, it) => sum + (it.s.amount || 0), 0);
  const unpaired = cancels.filter(c => !c.paired);
  /** 고친 값을 반영한다 — idx가 null이면 모든 줄에 (결제수단 모두 바꾸기). 한 줄을 고치면 그 줄의 예전 이유는 지운다 */
  const edit = (idx, p) => {
    setListNote('');
    const claimed = claimedNow();
    setItems(list => refresh(dbRef.current,
      list.map((x, i) => {
        // 체크는 refresh가 정한다 — patchListItem의 체크(빈 칸이면 끔)는 쓰지 않아 입력 중에도 사용자의 체크가 남는다
        if (idx === null) return { ...patchListItem(x, p), checked: x.checked };
        return i === idx ? { ...patchListItem(x, p), checked: x.checked, reason: '' } : x;
      }),
      { edited: idx === null ? -1 : idx, claimed }));
  };
  const setAllPayment = (method) => { if (method) edit(null, { payment_method: method }); };
  /**
   * 한 줄을 처음 읽은 값으로 되돌린다 — 근거·이유·경고도 함께. 겹침은 다시 따지고,
   * 체크는 처음 읽었을 때처럼 다시 정한다(고친 값에 준 체크가 잘못 읽은 값에 남지 않게, 되돌린 거래는 체크 없이)
   */
  const revert = (idx) => {
    setListNote('');
    const claimed = claimedNow();
    setItems(list => refresh(dbRef.current,
      list.map((x, i) => (i === idx ? { ...x, s: x.original, reason: x.originalReason, rev: x.rev + 1 } : x)),
      { claimed }).map((x, i) => (i === idx
      ? { ...x, decided: flagKey(x.s), checked: preChecked(x.s) && x.reason !== QUICK_REASONS.undone }
      : x)));
  };
  const checkable = items.filter(it => addable(it.s));
  // '모두'는 이미 있거나 겹친 결제를 뺀 줄 기준 — 그런 줄을 안 골랐어도 나머지를 다 골랐으면 '모두 빼기'
  const pickable = checkable.filter(it => !flagReason(it.s));
  const allChecked = pickable.length > 0 && pickable.every(it => it.checked);
  // 모두 고르기는 이미 있거나 겹친 결제는 빼고 고른다 — 그런 줄은 한 줄씩 직접 고른다
  const toggleAll = () => setItems(list => list.map(it => ({
    ...it,
    decided: flagKey(it.s),
    checked: allChecked ? false : (it.checked || (addable(it.s) && !flagReason(it.s))),
  })));
  const confirm = () => {
    const cur = dbRef.current;
    // 누른 순간 다시 대조한다 — 그사이 다른 기기에서 같은 거래가 들어왔을 수 있다. 이때는 끄기만 한다
    const now = refresh(cur, items, { confirming: true, claimed: claimedNow() });
    const dropped = items.filter((it, i) => isSelected(it) && !isSelected(now[i])).length;
    if (dropped) {
      setItems(now);
      setListNote(`그사이 가계부에 같은 거래가 들어와 ${dropped}건을 뺐어요 — 확인하고 다시 눌러 주세요`);
      return;
    }
    onBulkAdd(now.filter(isSelected).map(it => {
      const row = suggestionToTransaction(cur, it.s);
      return member === DEVICE_MEMBER ? row : { ...row, member };
    }));
  };
  // 사용자가 직접 고른 체크는 지금의 겹침에 대해 정한 것 — 같은 겹침이면 고쳐도 그대로 둔다
  const toggle = (idx, checked) => setItems(list => list.map((x, i) => (i === idx ? { ...x, checked, decided: flagKey(x.s) } : x)));

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
          {fixCount > 0 && <strong className="rs-fix-count">수정 필요 {fixCount}건 — 노란 줄을 고쳐 주세요</strong>}
          {items.length > 0 && <span>줄마다 '고치기'로 날짜·내용·금액을 고친 뒤 추가하세요</span>}
        </div>
      </div>
      {modelNote && <div className="rs-model-note">{modelNote}</div>}
      {note && <div className="tp-item-warn">{note}</div>}
      {listNote && <div className="rs-error-text" role="alert">{listNote}</div>}

      {items.length > 1 && (
        <div className="tp-item-fields rs-bulk">
          <span className="tp-field">
            <select value="" onChange={e => setAllPayment(e.target.value)} aria-label="결제수단 모두 바꾸기">
              <option value="">결제수단 모두 바꾸기</option>
              {methods.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </span>
          {pickable.length > 1 && (
            <button type="button" className="rs-btn-link" onClick={toggleAll}>{allChecked ? '모두 빼기' : '모두 고르기'}</button>
          )}
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
            item={{ ...it, checked: isSelected(it) }}
            methods={methods}
            subtitle={[it.s.date, it.s.paymentHint, it.s.eventTitle, flagReason(it.s) || it.reason].filter(Boolean).join(' · ')}
            onToggle={checked => toggle(idx, checked)}
            onPatch={p => edit(idx, p)}
            onRevert={() => revert(idx)}
            needsFix={needsFixOf(it)}
            onFillForm={onApply}
            editable
            canCheck={addable(it.s)}
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

      {unfixedSelected > 0 && (
        <div className="rs-fix-pending"><b>수정 필요 {unfixedSelected}건을 고치지 않은 채 골랐어요</b> — 그대로 넣어도 되지만 세부내역·카테고리를 확인해 주세요</div>
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
