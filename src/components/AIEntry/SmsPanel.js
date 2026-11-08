import React, { useState, useRef, useEffect } from 'react';
import { buildSmsSuggestions, describeSkipped as skippedText, rememberCards, smsKeyOf } from '../../services/cardSms';
import { isSuggestionComplete, suggestionToTransaction } from '../../services/receiptAssistant';
import { formatAmount } from '../../services/formulaEvaluator';
import { getPaymentMethods } from '../../services/dbManager';
import SuggestionItem, { patchListItem } from './SuggestionItem';
import { amountText } from './SuggestionCard';
import QuickAutoNote from './QuickAutoNote';
import { fullyUndone } from './useQuickBatches';
import { QUICK_REASONS } from '../../services/quickEntry';
import './AIEntry.css';

const EXAMPLE = '[Web발신]\n신한카드(1234)승인 홍*동 12,500원(일시불)11/08 12:34 스타벅스 누적…';

/** 미리 체크할 승인 — 다 채워졌고, 중복·취소 짝이 아니며, 날짜를 실제로 읽은 것 */
const preChecked = s => isSuggestionComplete(s) && !s.duplicateOf && !s.pairedCancel && s.sources.date !== 'today';

/**
 * 카드 승인 문자 붙여넣기 (I-012) — AI 없이 규칙으로 읽는다.
 * 승인 문자는 거래 추천으로, 승인 취소 문자는 가계부에서 지울 거래 후보로 보여 주고,
 * 사용자가 고른 것만 한 번에 반영한다(확정 전에는 DB에 쓰지 않음 — AGENTS.md §2-3).
 *
 * AI 입력(I-022)에서는 이미 읽고 자주 넣던 건을 바로 넣은 뒤 남은 확인거리를 initial로 받아 확인 화면부터 연다:
 *   initial = { text, review: [{ s, reason, checked? }], cancels, skipped } — reason은 확인이 필요한 이유
 *   batches·onUndoAuto: AI 입력이 바로 넣은 묶음(useQuickBatches)과 되돌리기. 이 화면이 열린 뒤 어디서든(알림·버튼)
 *   모두 되돌려진 묶음은 목록에 다시 올려(체크 없이) 고쳐 넣게 한다.
 * onBack이 있으면 '다시 붙여넣기'는 AI 입력 상자로 돌아간다.
 */
export default function SmsPanel({ db, initial, batches = [], onUndoAuto, onApply, onBulkAdd, onBack, onClose }) {
  const [phase, setPhase] = useState(initial ? 'review' : 'compose'); // compose | review
  const [text, setText] = useState(initial?.text || '');
  const [items, setItems] = useState(() => (initial
    ? initial.review.map(({ s, reason, checked }) => ({ s, checked: checked ?? preChecked(s), reason }))
    : []));                                   // 승인: [{ s, checked, reason? }]
  const [cancels, setCancels] = useState(() => (initial
    ? initial.cancels.map(c => ({ c, checked: !!c.match?.strong }))
    : []));                                   // 취소: [{ c, checked }]
  const [skipped, setSkipped] = useState(initial?.skipped || []);
  const [error, setError] = useState('');
  const textRef = useRef(null);
  // 열릴 때 이미 되돌려져 있던 묶음은 AI 입력이 확인 목록에 넣어 보냈다 — 그 뒤에 되돌려진 것만 다시 올린다
  const restoredRef = useRef(null);
  if (restoredRef.current === null) restoredRef.current = new Set(batches.filter(fullyUndone).map(b => b.id));

  useEffect(() => { if (textRef.current) textRef.current.focus(); }, []);

  // 되돌린 건을 다시 올린다 — 같은 문자가 이미 목록에 있으면(다시 붙여넣어 '이미 있는 것 같아요'로 보이던 줄) 그 줄을 바꾼다
  useEffect(() => {
    const fresh = batches.filter(b => fullyUndone(b) && !restoredRef.current.has(b.id));
    if (!fresh.length) return;
    fresh.forEach(b => restoredRef.current.add(b.id));
    const back = fresh.flatMap(b => b.suggestions).map(s => ({ s, checked: false, reason: QUICK_REASONS.undone }));
    setItems(list => {
      const next = [...list];
      back.forEach(item => {
        const i = next.findIndex(it => it.reason !== QUICK_REASONS.undone && smsKeyOf(it.s) === smsKeyOf(item.s));
        if (i >= 0) next[i] = item;
        else next.push(item);
      });
      return next;
    });
  }, [batches]);

  const canReadClipboard = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;

  const pasteFromClipboard = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) setText(prev => (prev.trim() ? `${prev}\n\n${clip}` : clip));
      setError('');
    } catch (e) {
      setError('클립보드를 읽지 못했습니다 — 입력란을 길게 눌러 붙여넣어 주세요');
    }
  };

  const read = () => {
    const { items: list, skipped: skippedList } = buildSmsSuggestions(db, text);
    const approvals = list.filter(x => x.kind === 'approve');
    const cancelList = list.filter(x => x.kind === 'cancel');
    if (!approvals.length && !cancelList.length) {
      setError(skippedList.some(x => x.reason !== 'unread')
        ? `넣을 결제가 없습니다 — ${skippedText(skippedList)}`
        : '카드 승인 문자를 찾지 못했습니다 — 금액(…원)이 들어 있는 문자를 붙여넣어 주세요');
      return;
    }
    setItems(approvals.map(s => ({ s, checked: preChecked(s) })));
    setCancels(cancelList.map(c => ({ c, checked: !!c.match?.strong })));
    setSkipped(skippedList);
    setError('');
    setPhase('review');
  };

  if (phase === 'compose') {
    return (
      <div className="rs-box">
        <div className="rs-setup-title">카드 문자 붙여넣기</div>
        <textarea
          ref={textRef}
          className="tp-textarea"
          rows={4}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={EXAMPLE}
        />
        <div className="tp-hint">
          카드사 승인·취소 문자를 여러 개 한꺼번에 붙여넣어도 됩니다. AI를 쓰지 않아 키가 없어도 됩니다.
        </div>
        {error && <div className="rs-error-text">{error}</div>}
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={onClose}>닫기</button>
          {canReadClipboard && (
            <button type="button" className="rs-btn-secondary" onClick={pasteFromClipboard}>📋 붙여넣기</button>
          )}
          <button type="button" className="rs-btn-primary" disabled={!text.trim()} onClick={read}>읽기</button>
        </div>
      </div>
    );
  }

  const methods = getPaymentMethods(db);
  const selected = items.filter(it => it.checked);
  const selectedTotal = selected.reduce((sum, it) => sum + (it.s.amount || 0), 0);
  const toDelete = cancels.filter(x => x.checked && x.c.match);

  const confirm = () => {
    if (toDelete.length) {
      const lines = toDelete.map(({ c }) => `· ${c.match.date} ${c.match.detail || c.match.payment_method} ${formatAmount(c.match.amount)}원`);
      if (!window.confirm(`승인이 취소된 거래 ${toDelete.length}건을 가계부에서 삭제합니다.\n${lines.join('\n')}`)) return;
    }
    rememberCards(selected.filter(it => it.s.cardKey && it.s.payment_method).map(it => [it.s.cardKey, it.s.payment_method]));
    onBulkAdd(
      selected.map(it => suggestionToTransaction(db, it.s)),
      { deleteIds: toDelete.map(({ c }) => c.match.id) },
    );
  };

  const label = [
    selected.length ? `${selected.length}건 추가 (${selectedTotal.toLocaleString()}원)` : '',
    toDelete.length ? `${toDelete.length}건 삭제` : '',
  ].filter(Boolean).join(' · ');

  const unread = skipped.filter(x => x.reason === 'unread').length;
  return (
    <div className="rs-box rs-review">
      <div className="rs-review-title">
        <b>
          {!items.length && !cancels.length
            ? '읽지 못한 카드 문자가 있어요'
            : `${batches.length ? '확인이 필요한 ' : ''}카드 문자 ${items.length}건${cancels.length ? ` · 승인 취소 ${cancels.length}건` : ''}`}
        </b>
        <QuickAutoNote batches={batches} onUndo={onUndoAuto} />
        {skipped.length > 0 && (
          <span className="tp-hint">{skippedText(skipped)}{unread > 0 ? ' — 금액을 읽지 못한 문자는 직접 입력해 주세요' : ''}</span>
        )}
      </div>

      <div className="tp-list">
        {items.map((it, idx) => (
          <SuggestionItem
            key={idx}
            db={db}
            item={it}
            methods={methods}
            subtitle={[`${it.s.date}${it.s.time ? ` ${it.s.time}` : ''}`, it.s.cardLabel, it.s.eventTitle, it.reason].filter(Boolean).join(' · ')}
            onToggle={checked => setItems(list => list.map((x, i) => (i === idx ? { ...x, checked } : x)))}
            onPatch={patch => setItems(list => list.map((x, i) => (i === idx ? patchListItem(x, patch) : x)))}
            onFillForm={onApply}
          />
        ))}

        {cancels.map(({ c, checked }, idx) => (
          <label key={`c${idx}`} className={`tp-item sms-cancel${checked ? ' checked' : ''}`}>
            <span className="tp-item-head">
              <input
                type="checkbox"
                checked={checked}
                disabled={!c.match}
                onChange={e => setCancels(list => list.map((x, i) => (i === idx ? { ...x, checked: e.target.checked } : x)))}
              />
              <span className="tp-item-main">
                <b>승인 취소 · {c.merchant || '가맹점 모름'}</b>
                <small>{[`${c.date}${c.time ? ` ${c.time}` : ''}`, c.cardLabel].filter(Boolean).join(' · ')}</small>
              </span>
              <span className="tp-item-amount">-{amountText(c)}</span>
            </span>
            <span className="sms-cancel-note">
              {c.pairedInPaste
                ? '붙여넣은 승인 문자와 짝이 맞아 둘 다 건너뜁니다'
                : c.match
                  ? `체크하면 가계부에서 지웁니다: ${c.match.date}${c.match.daysBefore > 0 ? `(${c.match.daysBefore}일 전)` : ''} ${c.match.detail || ''} (${c.match.payment_method}) ${formatAmount(c.match.amount)}원`
                  : '가계부에서 같은 거래를 찾지 못했습니다 — 직접 확인하세요'}
            </span>
          </label>
        ))}
      </div>

      <div className="rs-actions">
        <button type="button" className="rs-btn-secondary" onClick={onClose}>취소</button>
        <button type="button" className="rs-btn-secondary" onClick={() => (onBack ? onBack() : setPhase('compose'))}>다시 붙여넣기</button>
        <button type="button" className="rs-btn-primary" disabled={!label} onClick={confirm}>
          {label || '추가할 건 선택'}
        </button>
      </div>
    </div>
  );
}
