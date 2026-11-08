import React, { useState, useRef, useEffect } from 'react';
import { activeAI } from '../../services/aiClient';
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

/**
 * 거래 폼 위의 빠른 입력 — 영수증 찍기 / 말로 입력 / 카드 문자 붙여넣기(AI 없이, I-012) / 설정.
 *
 * 사진 선택창은 여기서 연다. 모바일 브라우저는 사용자가 누른 그 순간에만 선택창을 열어 주고,
 * 입력 요소가 다시 만들어지면 고른 사진이 사라지므로 항상 같은 자리에 둔다.
 * 폼을 채우기만 하고(onApply), 여러 건을 한 번에 반영할 때만 onBulkAdd(rows, { deleteIds })로 저장한다.
 * resetKey가 바뀌면(연속 입력으로 다음 거래로 넘어가면) 처음 상태로 돌아간다.
 * 말로 입력 중에 AI 설정을 열면 말로 입력 화면을 숨겨 둔 채 살려 두어, 설정을 마치거나 취소하면 하던 대화로 돌아간다.
 * 영수증은 파일 대신 캡처한 이미지를 붙여넣어도 된다(I-020) — 이 막대나 영수증 화면이 보이는 동안 단축키(Ctrl+V·⌘V),
 * 또는 막대 아래 '캡처한 영수증 붙여넣기' 버튼(클립보드를 읽을 수 있는 브라우저). 붙여넣은 이미지는 고른 사진과 같은 흐름으로 읽는다.
 * 카드 문자의 '📋 붙여넣기'(글)와 헷갈리지 않게 막대 안에 두지 않는다.
 */
export default function AIEntry({ db, onApply, onBulkAdd, resetKey }) {
  const [mode, setMode] = useState('idle'); // idle | setup | receipt | text | sms
  const [pending, setPending] = useState(null); // 설정을 마치면 이어서 할 일
  const [file, setFile] = useState(null);
  const [notice, setNotice] = useState('');
  const [textAlive, setTextAlive] = useState(false); // 말로 입력 화면을 (설정 화면 뒤에) 살려 둘지
  const [pasteError, setPasteError] = useState('');
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
    waitingFileRef.current = null;
  }, [resetKey]);

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
  const closeText = () => { setTextAlive(false); setMode('idle'); };
  const startText = () => (activeAI() ? openText() : needSetup('text'));

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

  // 막대나 영수증 화면이 보이는 동안 Ctrl+V로 붙여넣은 캡처 — 영수증 화면에서는 새 이미지로 바꿔 다시 읽는다
  usePasteImages(files => acceptImage(files[0]), mode === 'idle' || mode === 'receipt');

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

  const afterSetup = () => {
    const next = pending;
    setPending(null);
    if (next === 'receipt-file' && waitingFileRef.current) {
      const f = waitingFileRef.current;
      waitingFileRef.current = null;
      setFile(f);
      setMode('receipt');
    } else if (next === 'receipt') { setMode('idle'); openPicker(); }
    else if (next === 'text') openText();
    else setMode('idle');
  };

  const cancelSetup = () => {
    const next = pending;
    setPending(null);
    waitingFileRef.current = null;
    // 말로 입력 중에 연 설정이면 하던 대화로 돌아간다
    setMode(next === 'text' && textAlive ? 'text' : 'idle');
  };

  const apply = (s, label) => {
    onApply(s);
    setMode('idle');
    setTextAlive(false);
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
  } else if (mode === 'receipt') {
    body = (
      <ReceiptPanel
        db={db}
        file={file}
        onApply={s => apply(s, '영수증 내용을 채웠습니다')}
        onRepick={openPicker}
        onClose={() => setMode('idle')}
        onSetup={() => needSetup(null)}
      />
    );
  } else if (mode === 'sms') {
    body = (
      <SmsPanel
        db={db}
        onApply={s => apply(s, '카드 문자 내용을 채웠습니다')}
        onBulkAdd={(rows, opts) => onBulkAdd(rows, opts)}
        onClose={() => setMode('idle')}
      />
    );
  } else if (mode === 'text') {
    body = null; // 아래 textPanel이 보인다
  } else {
    body = (
      <>
        <div className="ai-entry-bar">
          <button type="button" className="ai-entry-btn" onClick={startReceipt}>
            <span className="ai-entry-icon">📷</span>영수증 찍기
          </button>
          <button type="button" className="ai-entry-btn" onClick={startText}>
            <span className="ai-entry-icon">💬</span>말로 입력
          </button>
          <button type="button" className="ai-entry-btn" onClick={() => setMode('sms')}>
            <span className="ai-entry-icon">💳</span>카드 문자
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
        db={db}
        onApply={s => apply(s, '말한 내용을 채웠습니다')}
        onBulkAdd={rows => onBulkAdd(rows)}
        onClose={closeText}
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
