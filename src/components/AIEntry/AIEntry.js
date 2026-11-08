import React, { useState, useRef, useEffect } from 'react';
import { activeAI } from '../../services/aiClient';
import { buildSmsSuggestions, describeSkipped, looksLikeCardMessage, smsKeyOf } from '../../services/cardSms';
import { suggestionToTransaction } from '../../services/receiptAssistant';
import { QUICK_REASONS, splitFamiliar } from '../../services/quickEntry';
import { useQuickBatches, fullyUndone } from './useQuickBatches';
import { clearAIDraft, loadAIDraft, saveAIDraft } from '../../services/aiDraft';
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
export default function AIEntry({ db, start = null, onApply, onBulkAdd, onQuickAdd, resetKey }) {
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
  // 앱이 닫히기 전에 정리하던 글(I-023) — 막대에서 이어서 하거나 버린다. 이어서 정리할 때는 바로 넣지 않고,
  // 그때 이미 넣은 거래가 있을 수 있어 같은 날 같은 금액 거래는 체크 없이 보인다
  const [draft, setDraft] = useState(() => loadAIDraft());
  const [restored, setRestored] = useState('');     // 이어서 정리하려고 상자에 채운 글
  const [fromDraft, setFromDraft] = useState(false); // 지금 말로 입력 화면이 이어서 정리하는 글인지
  // 기기에 적어 둔 글이 이 창에서 시작한 정리의 것인지 — 그 정리를 끝낼 때만 지운다(관련 없는 닫기로 남은 글을 잃지 않게)
  const ownsDraftRef = useRef(false);
  const [sharedText, setSharedText] = useState(''); // 공유로 받은 글 (I-024) — 상자에 채우고 안내한다
  const [startNote, setStartNote] = useState('');   // 공유로 받은 사진을 읽을 때의 안내(여러 장·함께 온 글)
  const startedRef = useRef(false);
  const [smsInit, setSmsInit] = useState(null);     // 카드 문자로 읽고 남은 확인거리
  // 카드 문자에서 바로 넣은 묶음 — '다시 붙여넣기'로 오가도 되돌릴 수 있게 입력 창을 닫을 때까지 지킨다
  const { batches: smsBatches, add: addSmsBatch, undoAll: undoSmsBatches, reset: resetSmsBatches } = useQuickBatches();
  const fileRef = useRef(null);
  // 처음 그린 때의 resetKey — 실제로 바뀌었을 때만 처음 상태로 돌린다(StrictMode가 효과를 다시 실행해도 시작 정보를 지우지 않게)
  const prevResetKeyRef = useRef(resetKey);
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
    if (prevResetKeyRef.current === resetKey) return;
    prevResetKeyRef.current = resetKey;
    setMode('idle');
    setFile(null);
    setNotice('');
    setPasteError('');
    setTextAlive(false);
    setQuickText('');
    setQuickError('');
    setSmsInit(null);
    resetSmsBatches();
    // 다음 거래로 넘어갔다 — 이 창에서 정리하던 글은 끝난 것으로 보고 지운다. 막대는 기기 기록과 맞춘다
    if (ownsDraftRef.current) { clearAIDraft(); ownsDraftRef.current = false; }
    setRestored('');
    setDraft(loadAIDraft());
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
  /** 남은 글 버리기 (막대의 '버리기') */
  const dropDraft = () => {
    clearAIDraft();
    ownsDraftRef.current = false;
    setDraft('');
    setRestored('');
  };
  /** 이 창에서 시작한 정리를 끝냈다 — 그 글만 지우고, 막대는 기기 기록과 맞춘다(다른 남은 글은 그대로 보인다) */
  const finishDraft = () => {
    if (ownsDraftRef.current) { clearAIDraft(); ownsDraftRef.current = false; }
    setRestored('');
    setDraft(loadAIDraft());
  };
  /** 정리를 시작했다 — 그 글을 기기에 적어 두고, 막대의 옛 남은 글을 대신한다 */
  const noteAnalyzing = (t) => {
    saveAIDraft(t);
    ownsDraftRef.current = true;
    setDraft('');
  };
  /** 막대로 돌아간다 — 다음에 열면 처음부터(쓰던 글·말로 입력 대화를 버리고, 이 창에서 정리하던 글 기록도 지운다) */
  const closeAll = () => {
    setMode('idle');
    setTextAlive(false);
    setQuickText('');
    setQuickError('');
    setSmsInit(null);
    resetSmsBatches();
    setStartNote('');
    finishDraft();
  };
  const openQuick = () => { setNotice(''); setQuickError(''); setMode('quick'); };
  const resumeDraft = () => {
    setQuickText(draft);
    setRestored(draft);
    setDraft('');
    openQuick();
  };

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
    if (f) { setStartNote(''); acceptImage(f); }
  };

  // 홈 화면 바로가기('AI 입력')·안드로이드 공유 받기로 연 입력 창 (I-024) — 처음 한 번만.
  // 사진은 영수증으로 바로 읽고, 글은 상자에 채워 확인하고 '정리하기'를 누르게 한다
  useEffect(() => {
    if (startedRef.current || !start) return;
    startedRef.current = true;
    if (start.files && start.files.length) {
      // 영수증은 한 장씩 읽는다 — 여러 장이면 첫 장만 읽는다고, 함께 온 글이 있으면 그 글을 알린다
      const notes = [];
      if (start.files.length > 1) notes.push(`공유한 사진 ${start.files.length}장 중 첫 장만 읽어요 — 나머지는 한 장씩 공유하거나 붙여넣어 주세요`);
      const caption = String(start.text || '').trim();
      if (caption) notes.push(`함께 온 글: “${caption.length > 40 ? `${caption.slice(0, 40)}…` : caption}”`);
      setStartNote(notes.join(' · '));
      acceptImage(start.files[0]);
      return;
    }
    if (start.text) { setQuickText(start.text); setSharedText(start.text); }
    setMode('quick');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 막대·AI 입력 상자·영수증 화면이 보이는 동안 Ctrl+V로 붙여넣은 캡처 — 영수증 화면에서는 새 이미지로 바꿔 다시 읽는다
  usePasteImages(files => { setStartNote(''); acceptImage(files[0]); }, mode === 'idle' || mode === 'quick' || mode === 'receipt');

  const pasteFromClipboard = async () => {
    setPasteError('');
    const token = ++pasteTokenRef.current;
    const stillHere = () => token === pasteTokenRef.current && modeRef.current === 'idle';
    try {
      const files = await readClipboardImages();
      if (stillHere()) { setStartNote(''); acceptImage(files[0]); }
    } catch (e) {
      if (stillHere()) setPasteError(e.message);
    }
  };

  /** AI 입력 상자의 글 — 카드 문자면 규칙으로 읽어 바로 넣을 것은 넣고, 아니면 말로 입력(AI)으로 넘긴다 */
  const submitQuick = () => {
    const text = quickText.trim();
    if (!text) return;
    setQuickError('');
    // 앱이 닫히기 전에 정리하던 글을 그대로 이어서 하면, 어느 갈래로 읽든 바로 넣지 않고 모두 확인받는다
    const resuming = !!restored && text === restored.trim();
    // 남은 글을 꺼내 정리를 시작했다(고쳐 썼어도) — 이제 이 창의 정리다. 끝내면 기기 기록도 지운다
    if (restored) ownsDraftRef.current = true;
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
        const rest = approvals.filter(s => !held.includes(s));
        const { familiar, review } = resuming
          ? { familiar: [], review: rest.map(s => ({ s, reason: '' })) }
          : splitFamiliar(db, rest, 'sms');
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
    setTextAuto(!cardLike && !resuming);
    setFromDraft(resuming);
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
        {restored && quickText.trim() === restored.trim() && (
          <div className="quick-reason">앱이 닫히기 전에 정리하던 글이에요 — 이번에는 바로 넣지 않고 모두 확인을 받아요</div>
        )}
        {sharedText && quickText === sharedText && (
          <div className="quick-reason">공유받은 글이에요 — 확인하고 '정리하기'를 누르세요</div>
        )}
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
      <>
        {startNote && <div className="quick-reason ai-start-note">{startNote}</div>}
        <ReceiptPanel
          db={db}
          file={file}
          onApply={s => apply(s, '영수증 내용을 채웠습니다')}
          onAutoAdd={autoAdd}
          onRepick={openPicker}
          onClose={closeAll}
          onSetup={() => needSetup(null)}
        />
      </>
    );
  } else if (mode === 'sms') {
    body = (
      <SmsPanel
        db={db}
        initial={smsInit}
        batches={smsBatches}
        onUndoAuto={undoSmsBatches}
        onApply={s => apply(s, '카드 문자 내용을 채웠습니다')}
        onBulkAdd={(rows, opts) => {
          // 남은 글을 이어서 정리해 카드 문자 화면에서 추가했으면 그 글도 끝났다 (창은 App이 닫는다)
          if (ownsDraftRef.current) { clearAIDraft(); ownsDraftRef.current = false; }
          onBulkAdd(rows, opts);
        }}
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
        {draft && (
          <div className="ai-entry-draft">
            <span className="ai-entry-draft-text">정리하다 만 글이 있어요: “{draft.length > 30 ? `${draft.slice(0, 30)}…` : draft}”</span>
            <button type="button" className="rs-btn-link" onClick={resumeDraft}>이어서 정리</button>
            <button type="button" className="rs-btn-link" onClick={dropDraft}>버리기</button>
          </div>
        )}
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
        onAnalyze={noteAnalyzing}
        checkExisting={fromDraft}
        onApply={s => apply(s, '말한 내용을 채웠습니다')}
        onBulkAdd={rows => {
          if (ownsDraftRef.current) { clearAIDraft(); ownsDraftRef.current = false; }
          onBulkAdd(rows);
        }}
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
