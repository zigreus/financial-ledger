import React, { useState, useRef, useEffect } from 'react';
import { activeAI, PROVIDERS } from '../../services/aiClient';
import { parseTextEntry, UNCLEAR } from '../../services/textEntry';
import { isSuggestionComplete, suggestionToTransaction } from '../../services/receiptAssistant';
import { getPaymentMethods } from '../../services/dbManager';
import SuggestionDetails from './SuggestionCard';
import SuggestionItem, { patchListItem } from './SuggestionItem';
import { FollowUpBox, SaidSoFar, describeGaps, gapQuestion, recordPick, carryChoices } from './TextFollowUp';
import './AIEntry.css';

const EXAMPLE = '예) 어제 점심 김치찌개 9천원 현금, 스타벅스 4500 카카오페이';
// 설정 화면에서 고칠 수 있는 오류 (키·모델·한도·크레딧)
const SETTINGS_KINDS = new Set(['auth', 'model', 'quota', 'billing']);
const PENDING_NOTE = "덧붙여 쓴 말이 있어요 — '덧붙여 정리하기'를 누르거나 지우면 진행할 수 있어요.";
const MERGE_HINT = '앞에서 말한 것과 합쳐 다시 정리합니다.';

/**
 * 말로 입력 — 문장을 거래로.
 * 한 건이면 확인 후 폼을 채우고, 여러 건이면 목록에서 고쳐 한 번에 추가한다.
 * 정보가 모자라면 무엇이 빠졌는지 알려 주고, 덧붙여 말하면 처음 말과 합쳐 다시 정리한다 (I-017).
 */
export default function TextPanel({ db, onApply, onBulkAdd, onClose, onSetup }) {
  const [phase, setPhase] = useState('compose'); // compose | analyzing | review | ask | error
  const [text, setText] = useState('');
  const [followUps, setFollowUps] = useState([]); // 덧붙인 말 [{ asked, said }]
  const [addition, setAddition] = useState('');   // 덧붙여 말하는 중인 글
  const [boxOpen, setBoxOpen] = useState(false);  // 빠진 정보가 없어도 덧붙이기 상자를 열었는지
  const [question, setQuestion] = useState('');   // 결제 건을 못 찾았을 때 되묻는 말 (ask)
  const [items, setItems] = useState([]);       // [{ s, checked, picks?, off? }]
  const [restore, setRestore] = useState(null); // 다시 정리하며 빠진 건이 있을 때 되돌릴 이전 목록
  const [error, setError] = useState('');       // 처음 정리가 실패했을 때 (error)
  const [followError, setFollowError] = useState(null); // 덧붙여 정리가 실패했을 때 { message, settings }
  const [progress, setProgress] = useState(''); // 서버가 붐빌 때 "다시 시도하는 중" 등
  const [modelNote, setModelNote] = useState(''); // 고른 모델이 붐벼 다른 모델이 대신 정리했을 때
  const abortRef = useRef(null);
  const backRef = useRef('compose'); // 정리를 취소하거나 실패하면 돌아갈 화면
  const textRef = useRef(null);

  useEffect(() => {
    if (textRef.current) textRef.current.focus();
    return () => { if (abortRef.current) abortRef.current.abort(); };
  }, []);

  /** AI 설정으로 — 다녀오는 동안 이 화면은 남는다(AIEntry). 설정을 고치러 가므로 이전 오류는 지운다 */
  const openSetup = () => {
    setError('');
    setFollowError(null);
    setPhase(p => (p === 'error' ? 'compose' : p));
    onSetup();
  };

  /** rounds: 이번에 함께 보낼 덧붙인 말, back: 정리를 시작한 화면 */
  const run = async (rounds, back) => {
    const ai = activeAI();
    if (!ai) { openSetup(); return; }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    backRef.current = back;
    // 정리하는 동안에는 목록이 보이지 않아 바뀌지 않는다 — 시작할 때의 목록·대화를 기준으로 맞춘다
    const before = { items: back === 'review' ? items : [], followUps };
    setError('');
    setFollowError(null);
    setProgress('');
    setModelNote('');
    setPhase('analyzing');
    try {
      const list = await parseTextEntry({
        db, ai, text, followUps: rounds, signal: controller.signal,
        onProgress: (msg, info) => {
          if (controller.signal.aborted) return;
          if (info?.modelUsed) {
            if (info.modelUsed !== ai.model) setModelNote(`${ai.model}이(가) 붐벼서 ${info.modelUsed}(으)로 정리했습니다`);
          } else {
            setProgress(msg);
          }
        },
      });
      if (controller.signal.aborted) return;
      // 목록에서 고른 값·체크를 끈 것은 덧붙여 정리할 때만 이어받는다 (다시 쓰기·처음 정리는 새로)
      const { items: next, dropped } = carryChoices(before.items, list);
      setRestore(dropped.length
        ? { items: before.items, followUps: before.followUps, said: rounds[rounds.length - 1].said, dropped }
        : null);
      setFollowUps(rounds);
      setAddition('');
      setBoxOpen(false);
      setItems(next);
      setPhase('review');
    } catch (e) {
      // 취소한 요청은 어떤 오류로 끝나든 화면을 바꾸지 않는다 — cancelAnalysis가 이미 이전 화면으로 돌렸고,
      // 그 사이 다시 시작한 분석의 화면을 덮어쓰면 안 된다
      if (controller.signal.aborted) return;
      if (e.name === 'AbortError') { setPhase(back); return; }
      const message = e.message || '분석에 실패했습니다';
      if (e.kind === UNCLEAR && back !== 'review') {
        // 결제 건을 못 찾음 — 실패가 아니라 되묻기. 덧붙인 말을 대화에 남기고 다음 말을 기다린다
        setFollowUps(rounds);
        setAddition('');
        setItems([]);
        setRestore(null);
        setQuestion(message);
        setPhase('ask');
      } else if (back === 'compose') {
        setError(message);
        setPhase('error');
      } else {
        // 덧붙여 정리하다 실패 — 이전 결과·되묻기와 덧붙이던 글은 그대로 두고 이유만 보여 준다
        setFollowError({
          message: e.kind === UNCLEAR ? `덧붙인 말을 반영하지 못했어요 — ${message}` : message,
          settings: SETTINGS_KINDS.has(e.kind),
        });
        setPhase(back);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const analyze = () => run([], 'compose');

  /** 덧붙여 말한 것을 처음 말과 합쳐 다시 정리 */
  const addMore = (asked) => {
    const said = addition.trim();
    if (!said) return;
    run([...followUps, { asked, said }], phase);
  };

  const cancelAnalysis = () => {
    if (abortRef.current) abortRef.current.abort();
    setPhase(backRef.current);
  };

  /** 다시 쓰기 — 지금까지 말한 것(덧붙이던 글 포함)을 한 글로 모아 고쳐 쓰게 한다 */
  const rewrite = () => {
    setText([text.trim(), ...followUps.map(f => f.said), addition.trim()].filter(Boolean).join('\n'));
    setFollowUps([]);
    setAddition('');
    setBoxOpen(false);
    setRestore(null);
    setFollowError(null);
    setPhase('compose');
  };

  /** 덧붙여 정리하며 빠진 건이 있을 때 — 이전 목록으로 돌리고, 덧붙였던 말은 고쳐 쓸 수 있게 상자에 돌려놓는다 */
  const undoFollowUp = () => {
    setItems(restore.items);
    setFollowUps(restore.followUps);
    setAddition(restore.said);
    setBoxOpen(true);
    setRestore(null);
  };

  const updateItem = (idx, patch) => {
    setItems(list => list.map((it, i) => {
      if (i !== idx) return it;
      const next = patchListItem(it, patch);
      // 끈 체크(off)는 다 채워진 채로 꺼져 있을 때만 유지한다 — 비웠다가 다시 채워 자동으로 체크되면 지운다
      return { ...next, picks: recordPick(it, patch), off: !next.checked && !!it.off && isSuggestionComplete(next.s) };
    }));
  };

  const ai = activeAI();
  const providerLabel = ai ? PROVIDERS[ai.provider].label.split(' ')[0] : '';

  if (phase === 'compose' || phase === 'error') {
    return (
      <div className="rs-box">
        <div className="rs-setup-title">말로 입력</div>
        <textarea
          ref={textRef}
          className="tp-textarea"
          rows={3}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={EXAMPLE}
        />
        <div className="tp-hint">여러 건을 한 번에 적어도 됩니다. 키보드의 마이크 버튼으로 말해도 돼요.</div>
        {phase === 'error' && <div className="rs-error-text">{error}</div>}
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={onClose}>닫기</button>
          {phase === 'error' && <button type="button" className="rs-btn-secondary" onClick={openSetup}>AI 설정</button>}
          <button type="button" className="rs-btn-primary" disabled={!text.trim()} onClick={analyze}>정리하기</button>
        </div>
      </div>
    );
  }

  if (phase === 'analyzing') {
    return (
      <div className="rs-box rs-analyzing">
        <div className="rs-analyzing-text">
          <span className="rs-spinner" />
          <span className="rs-analyzing-label">
            <span>
              {backRef.current === 'compose' ? '정리하는 중…' : '덧붙인 말과 합쳐 정리하는 중…'}
              {providerLabel && <small> ({providerLabel})</small>}
            </span>
            {progress && <span className="rs-progress">{progress}</span>}
          </span>
        </div>
        <button type="button" className="rs-btn-link" onClick={cancelAnalysis}>취소</button>
      </div>
    );
  }

  const followErrorProps = {
    error: followError ? followError.message : '',
    onSetup: followError && followError.settings ? openSetup : undefined,
  };

  // 결제 건을 못 찾음 — 무엇이 부족한지 되묻고 덧붙여 말하게 한다
  if (phase === 'ask') {
    return (
      <div className="rs-box">
        <div className="rs-review-title">
          <b>조금 더 알려 주세요</b>
          <SaidSoFar text={text} followUps={followUps} />
        </div>
        <FollowUpBox
          question={question}
          value={addition}
          onChange={setAddition}
          onSubmit={() => addMore(question)}
          {...followErrorProps}
          hint={`${MERGE_HINT} 키보드의 마이크 버튼으로 말해도 돼요.`}
          autoFocus
        />
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={onClose}>닫기</button>
          <button type="button" className="rs-btn-secondary" onClick={rewrite}>다시 쓰기</button>
        </div>
      </div>
    );
  }

  // review — 빠진 정보가 있으면 덧붙이기 상자를 바로 보여 주고, 없으면 열 수 있는 링크만
  const gaps = describeGaps(items);
  const pending = addition.trim() !== '';
  const showBox = gaps.length > 0 || boxOpen || pending || !!followError;
  let followArea;
  if (showBox) {
    followArea = (
      <FollowUpBox
        gaps={gaps}
        total={items.length}
        value={addition}
        onChange={setAddition}
        onSubmit={() => addMore(gapQuestion(gaps, items.length))}
        {...followErrorProps}
        hint={items.length === 1
          ? `${MERGE_HINT} '이대로 채우기'로 폼에서 직접 채워도 돼요.`
          : `${MERGE_HINT} 결제수단·카테고리는 목록에서 바로 골라도 돼요.`}
        pendingNote={PENDING_NOTE}
        autoFocus={boxOpen}
      />
    );
  } else {
    followArea = (
      <button type="button" className="rs-btn-link tp-followup-open" onClick={() => setBoxOpen(true)}>
        + 말로 덧붙이거나 고치기
      </button>
    );
  }
  const restoreNote = restore && (
    <div className="tp-restore">
      덧붙여 다시 정리하면서 빠진 건이 있어요: {restore.dropped.map(it => it.s.detail || it.s.merchant || '이름 없는 건').join(', ')}
      <button type="button" className="rs-btn-link" onClick={undoFollowUp}>이전 목록으로 되돌리기</button>
    </div>
  );

  // review — 한 건
  if (items.length === 1) {
    const s = items[0].s;
    return (
      <div className="rs-box rs-review">
        <div className="rs-review-title">
          <b>이렇게 입력하시겠습니까?</b>
          <SaidSoFar text={text} followUps={followUps} />
        </div>
        {modelNote && <div className="rs-model-note">{modelNote}</div>}
        {restoreNote}
        <SuggestionDetails suggestion={s} amountSource="text" />
        {followArea}
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={onClose}>취소</button>
          <button type="button" className="rs-btn-secondary" onClick={rewrite}>다시 쓰기</button>
          <button type="button" className="rs-btn-primary" disabled={pending} onClick={() => onApply(s)}>이대로 채우기</button>
        </div>
      </div>
    );
  }

  // review — 여러 건
  const methods = getPaymentMethods(db);
  const selected = items.filter(it => it.checked);
  const selectedTotal = selected.reduce((sum, it) => sum + (it.s.amount || 0), 0);

  return (
    <div className="rs-box rs-review">
      <div className="rs-review-title">
        <b>{items.length}건으로 정리했어요</b>
        <SaidSoFar text={text} followUps={followUps} />
      </div>
      {modelNote && <div className="rs-model-note">{modelNote}</div>}
      {restoreNote}

      <div className="tp-list">
        {items.map((it, idx) => (
          <SuggestionItem
            key={idx}
            db={db}
            item={it}
            methods={methods}
            // 다 채워진 건의 체크를 끈 것(off)은 덧붙여 다시 정리해도 끈 채로 둔다
            onToggle={checked => setItems(list => list.map((x, i) => (i === idx ? { ...x, checked, off: !checked } : x)))}
            onPatch={patch => updateItem(idx, patch)}
            onFillForm={onApply}
          />
        ))}
      </div>

      {followArea}

      <div className="rs-actions">
        <button type="button" className="rs-btn-secondary" onClick={onClose}>취소</button>
        <button type="button" className="rs-btn-secondary" onClick={rewrite}>다시 쓰기</button>
        <button
          type="button"
          className="rs-btn-primary"
          disabled={!selected.length || pending}
          onClick={() => onBulkAdd(selected.map(it => suggestionToTransaction(db, it.s)))}
        >
          {selected.length ? `${selected.length}건 추가 (${selectedTotal.toLocaleString()}원)` : '추가할 건 선택'}
        </button>
      </div>
    </div>
  );
}
