import React, { useState, useRef, useEffect } from 'react';
import { activeAI } from '../../services/aiClient';
import AISettingsForm from './AISettingsForm';
import ReceiptPanel from './ReceiptPanel';
import TextPanel from './TextPanel';
import SmsPanel from './SmsPanel';
import './AIEntry.css';

/**
 * 거래 폼 위의 빠른 입력 — 영수증 찍기 / 말로 입력 / 카드 문자 붙여넣기(AI 없이, I-012) / 설정.
 *
 * 사진 선택창은 여기서 연다. 모바일 브라우저는 사용자가 누른 그 순간에만 선택창을 열어 주고,
 * 입력 요소가 다시 만들어지면 고른 사진이 사라지므로 항상 같은 자리에 둔다.
 * 폼을 채우기만 하고(onApply), 여러 건을 한 번에 반영할 때만 onBulkAdd(rows, { deleteIds })로 저장한다.
 * resetKey가 바뀌면(연속 입력으로 다음 거래로 넘어가면) 처음 상태로 돌아간다.
 * 말로 입력 중에 AI 설정을 열면 말로 입력 화면을 숨겨 둔 채 살려 두어, 설정을 마치거나 취소하면 하던 대화로 돌아간다.
 */
export default function AIEntry({ db, onApply, onBulkAdd, resetKey }) {
  const [mode, setMode] = useState('idle'); // idle | setup | receipt | text | sms
  const [pending, setPending] = useState(null); // 설정을 마치면 이어서 할 일
  const [file, setFile] = useState(null);
  const [notice, setNotice] = useState('');
  const [textAlive, setTextAlive] = useState(false); // 말로 입력 화면을 (설정 화면 뒤에) 살려 둘지
  const fileRef = useRef(null);
  const firstRef = useRef(true);

  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    setMode('idle');
    setFile(null);
    setNotice('');
    setTextAlive(false);
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

  const onFile = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setNotice('');
    setFile(f);
    setMode('receipt');
  };

  const afterSetup = () => {
    const next = pending;
    setPending(null);
    if (next === 'receipt') { setMode('idle'); openPicker(); }
    else if (next === 'text') openText();
    else setMode('idle');
  };

  const cancelSetup = () => {
    const next = pending;
    setPending(null);
    // 말로 입력 중에 연 설정이면 하던 대화로 돌아간다
    setMode(next === 'text' && textAlive ? 'text' : 'idle');
  };

  const apply = (s, label) => {
    onApply(s);
    setMode('idle');
    setTextAlive(false);
    setNotice(label);
  };

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
