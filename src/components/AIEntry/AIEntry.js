import React, { useState, useRef, useEffect } from 'react';
import { activeAI } from '../../services/aiClient';
import { buildSmsSuggestions, describeSkipped, looksLikeCardMessage, smsKeyOf } from '../../services/cardSms';
import { suggestionToTransaction } from '../../services/receiptAssistant';
import { QUICK_REASONS, splitFamiliar } from '../../services/quickEntry';
import { useQuickBatches, fullyUndone } from './useQuickBatches';
import AISettingsForm from './AISettingsForm';
import ReceiptPanel from './ReceiptPanel';
import TextPanel from './TextPanel';
import SmsPanel from './SmsPanel';
import { usePasteImages } from '../../hooks/usePasteImages';
import { canReadClipboardImages, readClipboardImages, pasteShortcut } from '../../services/clipboardImage';
import './AIEntry.css';

// 마우스가 있는 기기(PC)에서만 단축키(Ctrl+V·⌘V) 안내를 보인다
const hasFinePointer = () => {
  try { return !!window.matchMedia && window.matchMedia('(pointer: fine)').matches; } catch (e) { return false; }
};

const QUICK_EXAMPLE = '예) 어제 점심 김치찌개 9천원 현금, 스타벅스 4500 — 카드 승인 문자를 그대로 붙여넣어도 돼요';

/**
 * 거래 폼 위의 AI 입력 (I-022) — 사진·카드 문자·말을 한 곳에 넣으면 알아서 읽는다.
 *  - 사진(고르기·붙여넣기) → 영수증(AI) / 카드 승인·취소 문자로 보이는 글 → 규칙(AI 키 없어도 됨) / 그 밖의 글 → 말로 입력(AI)
 *  - 자주 넣던 거래는 바로 추가하고(onQuickAdd — 확인할 것이 없으면 입력 창이 닫히고 '되돌리기' 알림),
 *    처음 보는 곳·빈 칸·취소·외화·중복은 지금처럼 확인받는다(services/quickEntry)
 *
 * 사진 선택창은 여기서 연다. 모바일 브라우저는 사용자가 누른 그 순간에만 선택창을 열어 주고,
 * 입력 요소가 다시 만들어지면 고른 사진이 사라지므로 항상 같은 자리에 둔다.
 * 폼을 채우기만 하거나(onApply), 확인한 여러 건을 한 번에 반영한다(onBulkAdd(rows, { deleteIds })).
 * resetKey가 바뀌면(연속 입력으로 다음 거래로 넘어가면) 처음 상태로 돌아간다.
 * 말로 입력 중에 AI 설정을 열면 그 화면을 숨겨 둔 채 살려 두어, 설정을 마치거나 취소하면 하던 대화로 돌아간다.
 * 캡처한 영수증은 단축키(Ctrl+V·⌘V)나 막대 아래 '캡처한 영수증 붙여넣기' 버튼으로도 넣는다(I-020).
 */
export default function AIEntry({ db, onApply, onBulkAdd, onQuickAdd, resetKey }) {
  const [mode, setMode] = useState('idle'); // idle | quick | setup | receipt | text | sms
  const [pending, setPending] = useState(null); // 설정을 마치면 이어서 할 일
  const [file, setFile] = useState(null);
  const [notice, setNotice] = useState('');
  const [textAlive, setTextAlive] = useState(false); // 말로 입력 화면을 (설정 화면 뒤에) 살려 둘지
  const [pasteError, setPasteError] = useState('');
  const [quickText, setQuickText] = useState('');   // AI 입력 상자에 쓴 글
  const [quickError, setQuickError] = useState('');
  const [textInit, setTextInit] = useState('');     // 말로 입력으로 넘긴 글 — 그 화면이 열리자마자 정리한다
  const [textKey, setTextKey] = useState(0);        // 새 글을 넘길 때마다 말로 입력 화면을 새로 연다
  const [textAuto, setTextAuto] = useState(true);   // 말로 입력이 늘 넣던 건을 바로 넣어도 되는지(카드 문자처럼 보인 글은 아님)
  const [smsInit, setSmsInit] = useState(null);     // 카드 문자로 읽고 남은 확인거리
  // 카드 문자에서 바로 넣은 묶음 — '다시 붙여넣기'로 오가도 되돌릴 수 있게 입력 창을 닫을 때까지 지킨다
  const { batches: smsBatches, add: addSmsBatch, undoAll: undoSmsBatches, reset: resetSmsBatches } = useQuickBatches();
  const fileRef = useRef(null);
  const firstRef = useRef(true);
  const waitingFileRef = useRef(null); // AI 설정을 마치면 읽을, 붙여넣은 이미지
  const pasteTokenRef = useRef(0);      // 클립보드를 읽는 동안 화면이 바뀌면 늦게 온 결과를 버린다
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // 다른 화면으로 가면 붙여넣기 오류를 지우고, 읽고 있던 클립보드 결과도 버린다
  useEffect(() => {
    setPasteError('');
    pasteTokenRef.current += 1;
  }, [mode, resetKey]);

  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    setMode('idle');
    setFile(null);
    setNotice('');
    setPasteError('');
    setTextAlive(false);
    setQuickText('');
    setQuickError('');
    setSmsInit(null);
    resetSmsBatches();
    waitingFileRef.current = null;
  }, [resetKey, resetSmsBatches]);

  const openPicker = () => {
    if (!fileRef.current) return;
    fileRef.current.value = '';
    fileRef.current.click();
  };

  const needSetup = (next) => {
    setPending(next);
    setMode('setup');
  };

  const startReceipt = () => (activeAI() ? openPicker() : needSetup('receipt'));
  const openText = () => { setTextAlive(true); setMode('text'); };
  /** 막대로 돌아간다 — 다음에 열면 처음부터(쓰던 글·말로 입력 대화를 버린다) */
  const closeAll = () => {
    setMode('idle');
    setTextAlive(false);
    setQuickText('');
    setQuickError('');
    setSmsInit(null);
    resetSmsBatches();
  };
  const openQuick = () => { setNotice(''); setQuickError(''); setMode('quick'); };

  /**
   * 자주 넣던 거래를 바로 넣는다 — remaining: 아직 확인받을 것의 수. 남은 것이 없으면 입력 창이 닫힌다(App).
   * 반환: { undo } | null — 확인 화면 안의 되돌리기 버튼이 쓴다
   */
  const autoAdd = (rows, { remaining = 0 } = {}) => {
    if (!rows.length) return null;
    const result = onQuickAdd(rows, { done: remaining === 0 });
    if (remaining === 0) closeAll();
    return result || null;
  };

  /** 고르거나 붙여넣은 영수증 이미지를 읽는다 — AI 설정 전이면 설정을 마친 뒤 이어서 읽는다 */
  const acceptImage = (f) => {
    setNotice('');
    setPasteError('');
    if (!activeAI()) {
      waitingFileRef.current = f;
      needSetup('receipt-file');
      return;
    }
    setFile(f);
    setMode('receipt');
  };

  const onFile = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) acceptImage(f);
  };

  // 막대·AI 입력 상자·영수증 화면이 보이는 동안 Ctrl+V로 붙여넣은 캡처 — 영수증 화면에서는 새 이미지로 바꿔 다시 읽는다
  usePasteImages(files => acceptImage(files[0]), mode === 'idle' || mode === 'quick' || mode === 'receipt');

  const pasteFromClipboard = async () => {
    setPasteError('');
    const token = ++pasteTokenRef.current;
    const stillHere = () => token === pasteTokenRef.current && modeRef.current === 'idle';
    try {
      const files = await readClipboardImages();
      if (stillHere()) acceptImage(files[0]);
    } catch (e) {
      if (stillHere()) setPasteError(e.message);
    }
  };

  /** AI 입력 상자의 글 — 카드 문자면 규칙으로 읽어 바로 넣을 것은 넣고, 아니면 말로 입력(AI)으로 넘긴다 */
  const submitQuick = () => {
    const text = quickText.trim();
    if (!text) return;
    setQuickError('');
    let cardLike = false;
    if (looksLikeCardMessage(text)) {
      cardLike = true;
      const { items, skipped } = buildSmsSuggestions(db, text);
      const approvals = items.filter(x => x.kind === 'approve');
      const cancels = items.filter(x => x.kind === 'cancel');
      // 금액을 하나도 읽지 못했으면 카드 문자가 아니라 말일 수 있다("신한카드 1.5만원 결제 12:30") — AI에 맡긴다
      const readable = approvals.some(s => s.amount !== null || s.foreignAmount !== null);
      if (readable || cancels.length) {
        // 앞에서 바로 넣었다가 되돌린 문자는 다시 바로 넣지 않는다 — 체크 없이 확인 목록에
        const undoneKeys = smsBatches.filter(fullyUndone).flatMap(b => b.suggestions.map(smsKeyOf));
        const held = approvals.filter(s => {
          const i = undoneKeys.indexOf(smsKeyOf(s));
          if (i < 0) return false;
          undoneKeys.splice(i, 1);
          return true;
        });
        const { familiar, review } = splitFamiliar(db, approvals.filter(s => !held.includes(s)), 'sms');
        // 금액을 읽지 못해 건너뛴 문자도 알려야 한다 — 바로 넣고 창을 닫으면 그 결제를 놓친다
        const unread = skipped.filter(x => x.reason === 'unread').length;
        const remaining = review.length + held.length + cancels.length + unread;
        // 카드 → 결제수단 기억은 사용자가 확인한 것만 한다(카드 문자 화면의 추가). 바로 넣은 건은 이미 기억했거나 카드사로 고른 것
        const handle = familiar.length ? autoAdd(familiar.map(s => suggestionToTransaction(db, s)), { remaining }) : null;
        if (!remaining) return;
        if (familiar.length) addSmsBatch(familiar, handle);
        const reasons = new Map(review.map(r => [r.s, r.reason]));
        const reviewList = approvals.filter(s => !familiar.includes(s)).map(s => (held.includes(s)
          ? { s, reason: QUICK_REASONS.undone, checked: false }
          : { s, reason: reasons.get(s) }));
        setSmsInit({ text, review: reviewList, cancels, skipped });
        setMode('sms');
        return;
      }
      // 승인 거절·청구 안내만 있으면 넣을 것이 없다 — AI로 넘기면 결제로 읽을 수 있다
      if (skipped.some(x => x.reason !== 'unread')) {
        setQuickError(`넣을 결제가 없습니다 — ${describeSkipped(skipped)}`);
        return;
      }
      // 카드 문자처럼 보였지만 읽을 결제가 없다 — 말로 입력으로 넘겨 AI가 읽게 한다(바로 넣지 않고 확인받는다)
    }
    setTextInit(text);
    setTextAuto(!cardLike);
    setTextKey(k => k + 1);
    if (!activeAI()) { needSetup('quick-text'); return; }
    openText();
  };

  const afterSetup = () => {
    const next = pending;
    setPending(null);
    if (next === 'receipt-file' && waitingFileRef.current) {
      const f = waitingFileRef.current;
      waitingFileRef.current = null;
      setFile(f);
      setMode('receipt');
    } else if (next === 'receipt') { setMode('idle'); openPicker(); }
    else if (next === 'text' || next === 'quick-text') openText();
    else setMode('idle');
  };

  const cancelSetup = () => {
    const next = pending;
    setPending(null);
    waitingFileRef.current = null;
    // 말로 입력 중에 연 설정이면 하던 대화로, AI 입력 상자에서 왔으면 쓰던 글로 돌아간다
    if (next === 'quick-text') setMode('quick');
    else setMode(next === 'text' && textAlive ? 'text' : 'idle');
  };

  const apply = (s, label) => {
    onApply(s);
    closeAll();
    setNotice(label);
  };

  const canPasteButton = canReadClipboardImages();
  const showShortcut = hasFinePointer();
  let body;
  if (mode === 'setup') {
    body = (
      <div className="rs-box">
        <div className="rs-setup-title">AI 입력 설정</div>
        <div className="rs-setup-desc">
          한 번만 설정하면 됩니다. 영수증 사진이나 말로 적은 내용을 읽고, 예전 입력 습관에 맞춰 분류를 추천합니다.
        </div>
        <AISettingsForm compact onSaved={afterSetup} onCancel={cancelSetup} />
      </div>
    );
  } else if (mode === 'quick') {
    body = (
      <div className="rs-box quick-box">
        <div className="rs-setup-title">AI 입력</div>
        <textarea
          className="tp-textarea"
          rows={3}
          value={quickText}
          autoFocus
          onChange={e => setQuickText(e.target.value)}
          placeholder={QUICK_EXAMPLE}
        />
        <div className="tp-hint">
          말하듯 적거나 카드 문자를 붙여넣거나 영수증 사진을 올리세요. 늘 넣던 가게는 바로 추가하고, 처음 보는 건 확인을 받아요.
          카드 문자는 AI 키 없이도 읽어요.
        </div>
        {quickError && <div className="rs-error-text">{quickError}</div>}
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={closeAll}>닫기</button>
          <button type="button" className="rs-btn-secondary" onClick={startReceipt}>📷 사진</button>
          <button type="button" className="rs-btn-primary" disabled={!quickText.trim()} onClick={submitQuick}>정리하기</button>
        </div>
      </div>
    );
  } else if (mode === 'receipt') {
    body = (
      <ReceiptPanel
        db={db}
        file={file}
        onApply={s => apply(s, '영수증 내용을 채웠습니다')}
        onAutoAdd={autoAdd}
        onRepick={openPicker}
        onClose={closeAll}
        onSetup={() => needSetup(null)}
      />
    );
  } else if (mode === 'sms') {
    body = (
      <SmsPanel
        db={db}
        initial={smsInit}
        batches={smsBatches}
        onUndoAuto={undoSmsBatches}
        onApply={s => apply(s, '카드 문자 내용을 채웠습니다')}
        onBulkAdd={(rows, opts) => onBulkAdd(rows, opts)}
        onBack={() => setMode('quick')}
        onClose={closeAll}
      />
    );
  } else if (mode === 'text') {
    body = null; // 아래 textPanel이 보인다
  } else {
    body = (
      <>
        <div className="ai-entry-bar">
          <button type="button" className="ai-entry-btn ai-entry-main" onClick={openQuick}>
            <span className="ai-entry-icon">✨</span>
            <span className="ai-entry-main-label">
              AI 입력
              <small>사진·카드 문자·말 무엇이든</small>
            </span>
          </button>
          <button type="button" className="rs-gear" onClick={() => needSetup(null)} title="AI 설정">⚙</button>
        </div>
        {notice && <div className="ai-entry-notice">✓ {notice} — 확인 후 추가하세요</div>}
        {(canPasteButton || showShortcut) && (
          <div className="ai-entry-paste-row">
            {canPasteButton && (
              <button type="button" className="ai-entry-paste" onClick={pasteFromClipboard}>🖼️ 캡처한 영수증 붙여넣기</button>
            )}
            {showShortcut && (
              <span className="ai-entry-hint">
                {canPasteButton ? `또는 ${pasteShortcut()}` : `캡처한 영수증은 ${pasteShortcut()}로 바로 붙여넣을 수 있어요`}
              </span>
            )}
          </div>
        )}
        {pasteError && <div className="ai-entry-error" role="alert">{pasteError}</div>}
      </>
    );
  }

  const textPanel = textAlive && (
    <div hidden={mode !== 'text'}>
      <TextPanel
        key={textKey}
        db={db}
        title="AI 입력"
        initialText={textInit}
        autoRun={!!textInit}
        onAutoAdd={textAuto ? autoAdd : undefined}
        onApply={s => apply(s, '말한 내용을 채웠습니다')}
        onBulkAdd={rows => onBulkAdd(rows)}
        onClose={closeAll}
        onSetup={() => needSetup('text')}
      />
    </div>
  );

  return (
    <>
      <input ref={fileRef} type="file" accept="image/*" onChange={onFile} style={{ display: 'none' }} />
      {body}
      {textPanel}
    </>
  );
}
