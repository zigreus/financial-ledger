import React, { useEffect, useRef, useState } from 'react';
import { activeAI, PROVIDERS } from '../../services/aiClient';
import { parseCommand, buildPlan, isRunnable } from '../../services/aiCommand';
import './AIEntry.css';

// 설정 화면에서 고칠 수 있는 오류 (키·모델·한도·크레딧)
const SETTINGS_KINDS = new Set(['auth', 'model', 'quota', 'billing']);

/**
 * AI 명령 (I-051) — 말한 글을 할 일로 읽어 보여 주고 실행한다.
 *  - 새 거래만 말했으면 onAddOnly()로 말로 입력(바로 넣기·되묻기)에 넘긴다
 *  - 되돌리기 쉬운 것(조회·화면·설정·목록 추가)만이면 바로 한다(onRun — 알림에 '되돌리기'). 조회 결과가 있으면 보여 준다
 *  - 거래·정기지출을 고치거나 지우는 것은 맞는 거래를 보여 주고 '실행'을 누르면 한다
 * onRun(steps, { close }) → { error } | 결과 — App이 실행하고(그 순간의 DB) 알림·되돌리기·화면 이동을 맡는다.
 * AI 응답을 기다리는 사이 DB가 바뀔 수 있어(다른 기기와 합침) 계획은 응답이 온 뒤의 DB(dbRef)로 만든다.
 */
export default function CommandPanel({ db, text, onRun, onAddOnly, onBack, onClose, onSetup }) {
  const [phase, setPhase] = useState('analyzing'); // analyzing | plan | done | ask | error
  const [plan, setPlan] = useState(null);
  const [checked, setChecked] = useState([]);
  const [message, setMessage] = useState('');
  const [settingsError, setSettingsError] = useState(false);
  const [progress, setProgress] = useState('');
  const [running, setRunning] = useState(false);
  const dbRef = useRef(db);
  dbRef.current = db;
  const abortRef = useRef(null);
  const planDbRef = useRef(null); // 계획을 만든 가계부 — 실행할 때 바뀌었으면 App이 막는다

  const run = (steps, { close }) => {
    const result = onRun(steps, { close, planDb: planDbRef.current });
    if (result && result.error) {
      setMessage(`실행하지 못했어요 — ${result.error}`);
      setPhase('error');
      setSettingsError(false);
      return false;
    }
    return true;
  };

  useEffect(() => {
    const ai = activeAI();
    if (!ai) { onSetup(); return undefined; }
    const controller = new AbortController();
    abortRef.current = controller;
    (async () => {
      try {
        const parsed = await parseCommand({
          db: dbRef.current, ai, text, signal: controller.signal,
          onProgress: (msg, info) => { if (!controller.signal.aborted && !info?.modelUsed) setProgress(msg); },
        });
        if (controller.signal.aborted) return;
        planDbRef.current = dbRef.current;
        const next = buildPlan(dbRef.current, parsed);
        if (next.addOnly) { onAddOnly(); return; }
        if (!next.steps.length) {
          setMessage(next.reply);
          setPhase('ask');
          return;
        }
        const hasQuery = next.steps.some(x => x.kind === 'tx_query');
        if (next.auto) {
          // 바로 한다 — 조회 결과가 있으면 이 화면에 남아 보여 준다
          const runnable = next.steps.filter(isRunnable);
          if (runnable.length && !run(next.steps, { close: !hasQuery })) return;
          if (!hasQuery) return;
          setPlan(next);
          setPhase('done');
          return;
        }
        setPlan(next);
        setChecked(next.steps.map(isRunnable));
        setPhase('plan');
      } catch (e) {
        if (controller.signal.aborted || e.name === 'AbortError') return;
        setMessage(e.message || '처리하지 못했어요');
        setSettingsError(SETTINGS_KINDS.has(e.kind));
        setPhase('error');
      }
    })();
    return () => controller.abort();
  // 글 하나마다 새로 연다(AIEntry가 key를 바꾼다)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = () => {
    if (abortRef.current) abortRef.current.abort();
    onBack();
  };

  const execute = () => {
    if (running || !plan) return;
    const steps = plan.steps.filter((st, i) => checked[i] && isRunnable(st));
    if (!steps.length) return;
    setRunning(true);
    if (!run(steps, { close: true })) setRunning(false);
  };

  if (phase === 'analyzing') {
    const providerLabel = activeAI() ? PROVIDERS[activeAI().provider]?.label : '';
    return (
      <div className="rs-box rs-analyzing">
        <div className="rs-analyzing-text">
          <span className="rs-spinner" />
          <span className="rs-analyzing-label">
            <span>
              무엇을 할지 읽는 중…
              {providerLabel && <small> ({providerLabel})</small>}
            </span>
            {progress && <span className="rs-progress">{progress}</span>}
          </span>
        </div>
        <button type="button" className="rs-btn-link" onClick={cancel}>취소</button>
      </div>
    );
  }

  if (phase === 'ask' || phase === 'error') {
    return (
      <div className="rs-box">
        <div className="rs-setup-title">AI 입력</div>
        <div className="cmd-said">“{text}”</div>
        <div className={phase === 'ask' ? 'quick-reason' : 'rs-error-text'}>{message}</div>
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={onClose}>닫기</button>
          {settingsError && <button type="button" className="rs-btn-secondary" onClick={onSetup}>AI 설정</button>}
          <button type="button" className="rs-btn-primary" onClick={onBack}>고쳐 쓰기</button>
        </div>
      </div>
    );
  }

  const done = phase === 'done';
  const count = plan.steps.filter((st, i) => checked[i] && isRunnable(st)).length;
  return (
    <div className="rs-box">
      <div className="rs-setup-title">{done ? '찾아봤어요' : '이렇게 할게요'}</div>
      <div className="cmd-said">“{text}”</div>
      <ul className="cmd-steps">
        {plan.steps.map((st, i) => {
          const selectable = !done && isRunnable(st);
          return (
            <li key={i} className={`cmd-step${st.ok ? '' : ' cmd-step--blocked'}`}>
              <label className="cmd-step-head">
                {selectable && (
                  <input
                    type="checkbox"
                    checked={!!checked[i]}
                    onChange={e => setChecked(c => c.map((v, k) => (k === i ? e.target.checked : v)))}
                  />
                )}
                <span className="cmd-step-title">{st.title}</span>
              </label>
              {st.lines.length > 0 && (
                <ul className="cmd-step-lines">
                  {st.lines.map((line, k) => <li key={k}>{line}</li>)}
                </ul>
              )}
              {st.warnings.map((w, k) => <div key={`w${k}`} className="quick-reason">{w}</div>)}
              {!st.ok && <div className="rs-error-text">{st.error}</div>}
            </li>
          );
        })}
      </ul>
      {plan.reply && <div className="quick-reason">{plan.reply}</div>}
      <div className="rs-actions">
        <button type="button" className="rs-btn-secondary" onClick={onClose}>닫기</button>
        <button type="button" className="rs-btn-secondary" onClick={onBack}>고쳐 쓰기</button>
        {!done && (
          <button type="button" className="rs-btn-primary" disabled={!count || running} onClick={execute}>
            {count > 1 ? `${count}가지 실행` : '실행'}
          </button>
        )}
      </div>
    </div>
  );
}
