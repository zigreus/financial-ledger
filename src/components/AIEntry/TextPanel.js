import React, { useState, useRef, useEffect } from 'react';
import { activeAI, PROVIDERS } from '../../services/aiClient';
import { parseTextEntry, UNCLEAR } from '../../services/textEntry';
import { isSuggestionComplete, normalizeName, suggestionToTransaction } from '../../services/receiptAssistant';
import { getPaymentMethods } from '../../services/dbManager';
import { QUICK_REASONS, mayAutoAddText, splitFamiliar } from '../../services/quickEntry';
import SuggestionDetails from './SuggestionCard';
import SuggestionItem, { patchListItem } from './SuggestionItem';
import { FollowUpBox, SaidSoFar, describeGaps, gapQuestion, recordPick, carryChoices } from './TextFollowUp';
import QuickAutoNote from './QuickAutoNote';
import { useQuickBatches } from './useQuickBatches';
import './AIEntry.css';

const EXAMPLE = '예) 어제 점심 김치찌개 9천원 현금, 스타벅스 4500 카카오페이';
// 설정 화면에서 고칠 수 있는 오류 (키·모델·한도·크레딧)
const SETTINGS_KINDS = new Set(['auth', 'model', 'quota', 'billing']);
const PENDING_NOTE = "덧붙여 쓴 말이 있어요 — '덧붙여 정리하기'를 누르거나 지우면 진행할 수 있어요.";
const MERGE_HINT = '앞에서 말한 것과 합쳐 다시 정리합니다.';
// 바로 넣은(또는 되돌린) 거래를 알아보는 열쇠 — 다시 정리하면 같은 건·고쳐 말한 건은 바로 넣지 않고,
// 체크를 끈 채 이유를 붙인다 (I-022). 한 건 화면(이대로 채우기)에도 맞게 '고르세요'라고 쓴다
const keyOf = s => `${s.date}|${s.amount}|${s.detail}|${s.payment_method}`;
const placeOf = s => ({ key: keyOf(s), date: s.date, name: normalizeName(s.detail) });
const mark = (s, kind) => ({ ...s, quickMark: kind, reviewReason: QUICK_REASONS[kind] });

/**
 * 말로 입력 — 문장을 거래로.
 * 한 건이면 확인 후 폼을 채우고, 여러 건이면 목록에서 고쳐 한 번에 추가한다.
 * 정보가 모자라면 무엇이 빠졌는지 알려 주고, 덧붙여 말하면 처음 말과 합쳐 다시 정리한다 (I-017).
 *
 * AI 입력(I-022): initialText·autoRun이면 열리자마자 정리하고, onAutoAdd가 있으면 처음 정리(덧붙인 말 없이)에서
 * 자주 넣던 건은 바로 넣고(onAutoAdd(rows, { remaining }) → { undo }) 나머지만 확인받는다.
 * 취소·예약 같은 말이 있으면 바로 넣지 않는다. 바로 넣은 건은 다시 정리하면 체크를 끈 채 보여 주고, 확인 화면에서 되돌릴 수 있다.
 * AI 응답은 오래 걸릴 수 있어 그 사이 바뀐 db·onAutoAdd(App이 다시 받은 DB, 폼에서 고른 '누가')는 ref로 최신 것을 쓴다.
 */
export default function TextPanel({ db, title = '말로 입력', initialText = '', autoRun = false, onAutoAdd, onApply, onBulkAdd, onClose, onSetup }) {
  const [phase, setPhase] = useState(autoRun && initialText ? 'analyzing' : 'compose'); // compose | analyzing | review | ask | error
  const [text, setText] = useState(initialText);
  const autoAddedRef = useRef([]);               // 바로 넣은 건 [{ key, date, name }] (같은 건이 둘이면 둘)
  const undoneRef = useRef([]);                  // 바로 넣었다가 되돌린 건 — 다시 정리해도 바로 넣지 않는다
  const dbRef = useRef(db);
  dbRef.current = db;
  const onAutoAddRef = useRef(onAutoAdd);
  onAutoAddRef.current = onAutoAdd;
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

  /**
   * 바로 넣은 묶음이 되돌려졌다(화면 위 알림이든 이 화면의 버튼이든) — 모두 지웠으면 그 건을 '되돌린 거래'로 옮겨
   * 다시 정리해도 바로 넣지 않게 하고, 목록에 다시 올린다(체크 없이). 이미 목록에 '바로 넣은 거래'로 보이던 같은 건은
   * 그 줄을 바꾸고, 고쳐 말한 건이 보이면 원래 건은 올리지 않는다(둘 다 넣지 않게)
   */
  const quick = useQuickBatches(({ suggestions, removed }) => {
    if (removed !== suggestions.length) return;
    const places = suggestions.map(placeOf);
    places.forEach(p => {
      const i = autoAddedRef.current.findIndex(a => a.key === p.key);
      if (i >= 0) autoAddedRef.current.splice(i, 1);
      undoneRef.current.push(p);
    });
    setItems(list => {
      const rest = suggestions.map((_, k) => k);
      const claim = (match) => {
        const i = rest.findIndex(k => match(places[k]));
        if (i < 0) return false;
        rest.splice(i, 1);
        return true;
      };
      const next = list.map(it => {
        if (it.s.quickMark === 'again' && claim(p => p.key === keyOf(it.s))) return { ...it, s: mark(it.s, 'undone') };
        if (it.s.quickMark === 'similar' && claim(p => p.date === it.s.date && p.name === normalizeName(it.s.detail))) {
          return { ...it, s: mark(it.s, 'fixed') };
        }
        return it;
      });
      return [...next, ...rest.map(k => ({ s: mark(suggestions[k], 'undone'), checked: false, off: true }))];
    });
  });

  useEffect(() => {
    if (textRef.current) textRef.current.focus();
    // AI 입력에서 넘어온 글은 바로 정리한다. 닫히면(StrictMode의 시험 닫기 포함) 진행 중인 정리를 취소하므로
    // 바로 넣기는 끝까지 간 한 번만 일어난다
    if (autoRun && initialText.trim()) run([], 'compose');
    return () => { if (abortRef.current) abortRef.current.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** AI 설정으로 — 다녀오는 동안 이 화면은 남는다(AIEntry). 설정을 고치러 가므로 이전 오류는 지운다 */
  const openSetup = () => {
    setError('');
    setFollowError(null);
    setPhase(p => (p === 'error' || p === 'analyzing' ? 'compose' : p)); // 바로 정리하려다 키가 없으면 쓰던 글로
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
      let list = await parseTextEntry({
        db: dbRef.current, ai, text, followUps: rounds, signal: controller.signal,
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
      const curDb = dbRef.current;
      // 앞에서 바로 넣은 건·되돌린 건(또는 날짜·내용이 같아 고쳐 말한 것 같은 건)은 바로 넣지 않고 체크를 끈 채 이유를 보인다
      const added = [...autoAddedRef.current];
      const undone = [...undoneRef.current];
      const take = (pool, sug) => {
        const i = pool.findIndex(a => a.key === keyOf(sug));
        if (i < 0) return false;
        pool.splice(i, 1);
        return true;
      };
      const near = (pool, sug) => pool.some(a => a.date === sug.date && a.name === normalizeName(sug.detail));
      list = list.map(sug => {
        if (take(added, sug)) return mark(sug, 'again');
        if (near(autoAddedRef.current, sug)) return mark(sug, 'similar');
        if (take(undone, sug)) return mark(sug, 'undone');
        if (near(undoneRef.current, sug)) return mark(sug, 'fixed');
        return sug;
      });
      const autoAdd = onAutoAddRef.current;
      if (autoAdd && back === 'compose' && !rounds.length && mayAutoAddText(text)) {
        const { familiar, review } = splitFamiliar(curDb, list.filter(sug => !sug.quickMark), 'text', { said: text });
        if (familiar.length) {
          const remaining = list.length - familiar.length;
          const handle = autoAdd(familiar.map(sug => suggestionToTransaction(curDb, sug)), { remaining });
          // 넣은 뒤에 기록한다 — 넣다가 실패하면(오류) 다시 정리할 때 숨기지 않게
          familiar.forEach(sug => autoAddedRef.current.push(placeOf(sug)));
          if (!remaining) return; // 모두 바로 넣었다 — 입력 창이 닫힌다
          quick.add(familiar, handle);
        }
        const reasons = new Map(review.map(r => [r.s, r.reason]));
        list = list.filter(sug => !familiar.includes(sug));
        list.forEach(sug => { if (reasons.has(sug)) sug.reviewReason = reasons.get(sug); });
      }
      if (!list.length) {
        const message = '넣을 거래를 찾지 못했어요 — 무엇을 얼마에 샀는지 적어 주세요';
        // 처음 정리면 쓰던 글 아래에, 덧붙여 정리하던 중이면 그 화면(목록·되묻기)에 이유를 보인다
        if (back === 'compose') {
          setError(message);
          setPhase('error');
        } else {
          setFollowError({ message, settings: false });
          setPhase(back);
        }
        return;
      }
      // 목록에서 고른 값·체크를 끈 것은 덧붙여 정리할 때만 이어받는다 (다시 쓰기·처음 정리는 새로)
      const { items: next, dropped: droppedByName, matched } = carryChoices(before.items, list);
      // 바로 넣은·되돌린 건이 금액만 같은 다른 줄과 짝지어졌으면 그 예전 줄은 빠진 것으로 알린다(체크도 이어받지 않는다)
      const sameDetail = (a, b) => normalizeName(a.detail) === normalizeName(b.detail);
      const oldOf = i => (matched[i] >= 0 ? before.items[matched[i]] : null);
      const pairedByAmount = next
        .map((it, i) => (it.s.quickMark && oldOf(i) && !sameDetail(oldOf(i).s, it.s) ? oldOf(i) : null))
        .filter(Boolean);
      const dropped = [...droppedByName, ...pairedByAmount];
      setRestore(dropped.length
        ? { items: before.items, followUps: before.followUps, said: rounds[rounds.length - 1].said, dropped }
        : null);
      setFollowUps(rounds);
      setAddition('');
      setBoxOpen(false);
      // 바로 넣은·되돌린 건은 체크를 끈 채 보인다 — 단, 같은 줄(같은 내용의 표시 줄)을 사용자가 직접 체크해 두었으면 그대로.
      // 금액만 같은 다른 줄과 짝지어졌으면 그 줄에서 고른 값도 이어받지 않는다
      setItems(next.map((it, i) => {
        if (!it.s.quickMark) return it;
        const old = oldOf(i);
        if (old && !sameDetail(old.s, it.s)) return { s: list[i], checked: false, off: true };
        if (old && old.s.quickMark && old.checked && old.off === false) return it;
        return { ...it, checked: false, off: true };
      }));
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
        <div className="rs-setup-title">{title}</div>
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

  const autoNote = <QuickAutoNote batches={quick.batches} onUndo={quick.undoAll} />;
  const hasAuto = quick.batches.length > 0;

  // review — 한 건
  if (items.length === 1) {
    const s = items[0].s;
    return (
      <div className="rs-box rs-review">
        <div className="rs-review-title">
          <b>이렇게 입력하시겠습니까?</b>
          <SaidSoFar text={text} followUps={followUps} />
          {autoNote}
          {s.reviewReason && <span className="quick-reason">확인이 필요한 이유: {s.reviewReason}</span>}
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
        <b>{hasAuto ? `확인이 필요한 ${items.length}건이에요` : `${items.length}건으로 정리했어요`}</b>
        <SaidSoFar text={text} followUps={followUps} />
        {autoNote}
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
            subtitle={it.s.reviewReason ? [it.s.date, it.s.eventTitle, it.s.reviewReason].filter(Boolean).join(' · ') : undefined}
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
