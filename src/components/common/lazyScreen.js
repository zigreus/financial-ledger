import React, { lazy, useEffect, useState } from 'react';
import ModalOverlay from './ModalOverlay';
import './lazyScreen.css';

const RETRY_AFTER_MS = 1000;      // 이보다 전에 실패했으면 다시 연 화면에서 저절로 다시 받아 본다
const LOADING_CLOSE_MS = 3000;    // 창을 이만큼 기다려도 안 열리면 '닫기'를 보인다

/**
 * 열 때 불러오는 화면 (I-033, ROADMAP Q-3) — 첫 화면(거래내역)에 필요 없는 화면의 코드를 따로 나눠,
 * 앱을 열 때 읽고 실행할 양을 줄인다. App은 로그인 뒤 쉬는 틈에 preload()로 미리 불러 둔다.
 *
 *  - 이미 불러온 화면은 기다림 없이 바로 그린다(그 화면을 처음 그릴 때 정해 그 화면이 닫힐 때까지 유지 —
 *    도중에 바꾸면 화면이 새로 그려져 입력하던 것이 사라진다).
 *  - 아직이면 React.lazy로 불러오는 동안 Suspense의 fallback을 보인다(창이면 ModalLoading).
 *  - 불러오지 못하면(연결 없음, 새 배포로 옛 파일이 사라짐) 흰 화면 대신 '다시 시도'·'새로 고침'을 보인다.
 *    창(모달) 화면이면(onClose를 받음) 창으로 보이고 '닫기'도 둔다. 한 번 실패한 화면을 다시 열면 바로 다시 받아 본다.
 *
 * load: () => import('...') — 모듈의 default가 화면 컴포넌트
 * options.inlineRetry: inline에서 다시 시도도 실패했을 때 덧붙이는 문구(입력할 것이 없는 곳이면 그에 맞게)
 * options.inline: 다른 화면 안에 들어가는 부분(예: 입력 창의 AI 입력)이면 실패할 때 보일 짧은 문구 —
 *   '새로 고침'을 두지 않는다(누르면 그 화면에 입력하던 것이 사라진다)
 */
export function lazyScreen(load, { inline = '', inlineRetry = '계속 안 되면 입력을 마친 뒤 앱을 새로 고쳐 주세요.' } = {}) {
  let loaded = null;        // 불러온 화면 컴포넌트
  let pending = null;       // 불러오는 중인 약속 — 실패하면 비워 다음에 다시 시도한다
  let failedAt = 0;         // 마지막으로 불러오지 못한 시각
  const start = () => {
    if (!pending) {
      pending = load().then(
        (m) => { loaded = m.default; return m; },
        (e) => { pending = null; failedAt = Date.now(); throw e; },
      );
    }
    return pending;
  };

  function LoadFailed(props) {
    const [Comp, setComp] = useState(null);
    const [state, setState] = useState('idle');   // idle | busy | failed

    // 방금 실패한 것이 아니면(실패한 화면을 다시 열었음 — 연결이 돌아왔을 수 있음) 누르지 않아도 한 번 다시 받아 본다.
    // 시각으로 가린다 — 방금 실패해 처음 보이는 실패 화면에서 곧바로 또 받지 않게(개발 모드의 effect 두 번 실행에도 같게)
    useEffect(() => {
      if (Date.now() - failedAt < RETRY_AFTER_MS) return undefined;
      let alive = true;
      setState('busy');
      start().then(
        () => { if (alive) setComp(() => loaded); },
        () => { if (alive) setState('idle'); },
      );
      return () => { alive = false; };
    }, []);

    if (Comp) return <Comp {...props} />;
    const busy = state === 'busy';
    const retry = () => {
      setState('busy');
      start().then(() => setComp(() => loaded), () => setState('failed'));
    };
    const retryButton = (
      <button type="button" className={inline ? 'btn-secondary' : 'btn-primary'} disabled={busy} onClick={retry}>
        {busy ? '불러오는 중…' : '다시 시도'}
      </button>
    );

    if (inline) {
      return (
        <div className="screen-load-failed screen-load-failed--inline" role="alert">
          <p>{inline}</p>
          {state === 'failed' && <p>{inlineRetry}</p>}
          <div className="screen-load-failed-actions">{retryButton}</div>
        </div>
      );
    }
    const body = (
      <div className="screen-load-failed" role="alert">
        <p>화면을 불러오지 못했습니다. 연결을 확인하고 다시 시도해 주세요.</p>
        {state === 'failed' && <p>계속 안 되면 앱이 새로 바뀌었을 수 있어요 — &apos;새로 고침&apos;을 눌러 주세요.</p>}
        <div className="screen-load-failed-actions">
          {retryButton}
          <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>새로 고침</button>
          {typeof props.onClose === 'function' && (
            <button type="button" className="btn-secondary" onClick={props.onClose}>닫기</button>
          )}
        </div>
      </div>
    );
    return typeof props.onClose === 'function'
      ? <ModalOverlay className="modal-overlay" panelClassName="modal-content modal-small">{body}</ModalOverlay>
      : body;
  }

  const Lazy = lazy(() => start().catch(() => ({ default: LoadFailed })));

  function Screen(props) {
    const [Ready] = useState(() => loaded);
    return Ready ? <Ready {...props} /> : <Lazy {...props} />;
  }
  /** 미리 불러 둔다 — 실패해도 오류를 내지 않는다(열 때 다시 시도). 반환: 불러왔는지 */
  Screen.preload = () => start().then(() => true, () => false);
  return Screen;
}

/**
 * 창(모달) 화면을 불러오는 동안 보이는 창 — 뒤 화면을 가려 다시 누르지 않게 한다
 * (같은 버튼을 또 누르면 history가 한 번 더 쌓여 닫은 뒤 뒤로가기에서 창이 다시 열린다).
 * 연결이 느려 오래 걸리면 '닫기'를 보인다 — 뒤로가기 버튼이 없는 기기(iOS 홈 화면 앱)에서도 빠져나오게
 */
export function ModalLoading({ onClose }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), LOADING_CLOSE_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <ModalOverlay className="modal-overlay" panelClassName="modal-content modal-small screen-modal-loading">
      <div className="spinner" role="status" aria-label="불러오는 중" />
      {slow && typeof onClose === 'function' && (
        <button type="button" className="btn-secondary" onClick={onClose}>닫기</button>
      )}
    </ModalOverlay>
  );
}
