import React, { useMemo, useState } from 'react';
import { CONTACT_EMAIL } from '../../config';
import { ERROR_LOG_MAX, clearErrorLog, getErrorLog } from '../../services/errorLog';
import { MAIL_ERRORS_MAX, buildProblemReport } from '../../services/problemReport';
import './ProblemReport.css';

const MAIL_SUBJECT = '[지금 가계부] 문제 알리기';

/** 글을 클립보드에 — 클립보드 API가 막혀 있으면 예전 방식(선택해 복사)으로. 됐으면 true */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 아래 방식으로 */ }
  const area = document.createElement('textarea');
  try {
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    return !!document.execCommand?.('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/**
 * 문제 알리기 (I-038, ROADMAP M-5) — 이 기기에 남은 오류 기록(services/errorLog)과 앱 정보를 글로 보여 주고,
 * 사용자가 읽어 본 뒤 직접 복사하거나 메일로 보낸다. 앱이 어디로도 자동으로 보내지 않는다(AGENTS §1, ROADMAP F-4).
 * 설정 › 앱, 가계부를 불러오지 못한 화면(App), 화면을 그리다 멈춘 화면(common/ErrorBoundary)에서 쓴다 —
 * 뒤의 둘은 열 때 불러온다(./lazyProblemReport).
 * drive: 'OneDrive' | 'Google Drive' (모르면 '')
 */
export default function ProblemReport({ drive = '' }) {
  const [errors, setErrors] = useState(getErrorLog);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState(null);   // { text, ok }
  const report = useMemo(() => buildProblemReport({ note, drive, errors }), [note, drive, errors]);

  const copy = async () => {
    setMessage(null);
    const ok = await copyText(report);
    setMessage(ok
      ? { ok, text: '✓ 복사했습니다. 메신저나 메일에 붙여 넣어 보내 주세요.' }
      : { ok, text: '복사하지 못했습니다. 위 글을 길게 눌러 직접 복사해 주세요.' });
  };

  const clear = () => {
    if (!window.confirm(`이 기기에 남은 오류 기록 ${errors.length}건을 지울까요?`)) return;
    clearErrorLog();
    setErrors([]);
    setMessage({ ok: true, text: '✓ 오류 기록을 지웠습니다.' });
  };

  const mailHref = CONTACT_EMAIL
    ? `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(MAIL_SUBJECT)}&body=${encodeURIComponent(
      buildProblemReport({ note, drive, errors, limit: MAIL_ERRORS_MAX }),
    )}`
    : '';

  return (
    <div className="preport">
      <p className="preport-desc">
        앱은 오류를 어디로도 자동으로 보내지 않아요. 문제가 생기면 무슨 일이 있었는지 적고, 아래 글을 읽어 본 뒤 복사해서 직접 보내 주세요.
        {CONTACT_EMAIL ? '' : ' 문의 메일 주소는 준비 중이라, 지금은 앱을 알려 준 분께 메신저로 보내 주세요.'}
      </p>
      <p className="preport-desc">
        오류 기록에는 이 기기에서 난 오류의 메시지·위치·시각만 남아요(최근 {ERROR_LOG_MAX}건).
        거래 내용은 넣지 않고, 이메일·긴 숫자·키처럼 보이는 값은 가려요.
      </p>
      <textarea
        className="preport-note"
        value={note}
        onChange={e => setNote(e.target.value)}
        placeholder="무슨 일이 있었나요? 예: 거래를 저장하려고 하면 오류가 떠요"
        aria-label="무슨 일이 있었나요"
        rows={3}
      />
      <div className="preport-label">보낼 글 미리 보기 · 오류 {errors.length}건</div>
      <pre className="preport-text" aria-label="보낼 글">{report}</pre>
      <div className="preport-actions">
        <button type="button" className="btn-primary" onClick={copy}>복사하기</button>
        {mailHref && <a className="btn-secondary preport-mail" href={mailHref}>메일로 보내기</a>}
        <button type="button" className="btn-secondary" onClick={clear} disabled={!errors.length}>오류 기록 지우기</button>
      </div>
      {mailHref && errors.length > MAIL_ERRORS_MAX && (
        <p className="preport-desc">메일에는 최근 오류 {MAIL_ERRORS_MAX}건만 담겨요. 모두 보내려면 복사하기를 쓰세요.</p>
      )}
      {message && (
        <div className={message.ok ? 'preport-message' : 'preport-message preport-message--fail'} role="status">{message.text}</div>
      )}
    </div>
  );
}
