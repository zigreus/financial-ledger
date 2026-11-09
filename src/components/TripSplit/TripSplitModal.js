import React, { useMemo, useState } from 'react';
import {
  getTripParticipants, ensureTripMe, addTripParticipant, setTripParticipantWeight, renameTripParticipant,
  deleteTripParticipant, countTripEntriesFor, addTripPayment, updateTripPayment, deleteTripPayment, setTripTxSplit,
  getTripSettlement, tripSettlementText, reassignTripName, setTripPaymentExcluded,
} from '../../services/dbManager';
import { evaluateFormula, isIncompleteFormula, formatAmount } from '../../services/formulaEvaluator';
import { isValidDateStr } from '../../services/dateUtils';
import ModalOverlay from '../common/ModalOverlay';
import AmountInput from '../common/AmountInput';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';
import './TripSplitModal.css';

const won = n => `${formatAmount(Math.round(n))}원`;
const shortDate = d => (d && d.length >= 10 ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');

/** 나눌 사람 고르기 — 아무도 고르지 않으면 모두. 목록에 없는 이름은 체크 상태에 넣지 않는다 */
function SharePicker({ people, value, onChange }) {
  const known = (value || []).filter(n => people.some(p => p.name === n));
  const chosen = known.length ? known : people.map(p => p.name);
  const toggle = (name) => {
    const next = chosen.includes(name) ? chosen.filter(n => n !== name) : [...chosen, name];
    if (!next.length) return;   // 한 사람은 남긴다
    onChange(next.length === people.length ? [] : next);
  };
  return (
    <div className="ts-picker" role="group" aria-label="나눌 사람">
      {people.map(p => (
        <label key={p.name} className={`ts-pick${chosen.includes(p.name) ? ' ts-pick--on' : ''}`}>
          <input type="checkbox" checked={chosen.includes(p.name)} onChange={() => toggle(p.name)} />
          {p.name}
        </label>
      ))}
    </div>
  );
}

/**
 * 여행 정산 — 일행 N빵 (I-030, ROADMAP C-11). 여행 일정에서 연다.
 * 가계부의 여행 거래는 '우리'가 낸 돈으로 보고, 일행이 낸 돈은 따로 적어, 몫대로 나눈 정산표와 공유용 텍스트를 만든다.
 */
export default function TripSplitModal({ db, dataVersion, event, onClose, onChanged }) {
  const live = useDbSnapshot(db, dataVersion);
  const settlement = useMemo(() => getTripSettlement(live.db, event.id), [live, event.id]);
  const people = useMemo(() => {
    const list = getTripParticipants(live.db, event.id);
    return list.length ? list : [{ name: '우리', isMe: true, weight: 1 }];
  }, [live, event.id]);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [newName, setNewName] = useState('');
  const [editingName, setEditingName] = useState(null);    // { from, to }
  const [openItem, setOpenItem] = useState(null);           // 나눌 사람을 고르는 지출 key
  const [form, setForm] = useState(null);                   // 일행이 낸 돈 { id?, payer, title, date, amount, sharedBy }
  const [copied, setCopied] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);

  // quiet: 몫 +/−처럼 자주 누르는 것은 바로 올리지 않고 자동 저장에 맡긴다
  const run = (fn, { quiet = false, onError = setError } = {}) => {
    try {
      fn();
      onError('');
      if (!quiet && onChanged) onChanged();
      return true;
    } catch (e) {
      onError(e.message || '저장하지 못했습니다');
      return false;
    }
  };

  const addPerson = (name = newName) => {
    if (run(() => addTripParticipant(db, event.id, name)) && name === newName) setNewName('');
  };
  const changeWeight = (p, delta) => run(() => {
    ensureTripMe(db, event.id);
    setTripParticipantWeight(db, event.id, p.name, p.weight + delta);
  }, { quiet: true });
  const saveRename = () => {
    if (editingName.to.trim() === editingName.from) { setEditingName(null); return; }
    if (run(() => { ensureTripMe(db, event.id); renameTripParticipant(db, event.id, editingName.from, editingName.to); })) setEditingName(null);
  };
  const removePerson = (p) => {
    const { paid, onlyFor } = countTripEntriesFor(db, event.id, p.name);
    const msg = `${p.name}님을 일행에서 뺄까요?`
      + (paid ? `\n· ${p.name}님이 낸 돈 기록 ${paid}건이 함께 지워집니다.` : '')
      + (onlyFor ? `\n· ${p.name}님 몫으로만 나눈 지출 ${onlyFor}건은 정산에서 빠집니다.` : '')
      + '\n· 다른 지출의 나눌 사람에서도 빠집니다.';
    if (!window.confirm(msg)) return;
    run(() => deleteTripParticipant(db, event.id, p.name));
  };

  const setItemShare = (it, sharedBy) => run(() => {
    if (it.kind === 'tx') setTripTxSplit(db, event.id, it.transactionId, { sharedBy, excluded: it.excluded });
    else updateTripPayment(db, it.id, { payer: it.payer, title: it.title, date: it.date, amount: it.amount, sharedBy });
  });
  const toggleExcluded = (it) => run(() => {
    if (it.kind === 'tx') setTripTxSplit(db, event.id, it.transactionId, { sharedBy: it.sharedBy || [], excluded: !it.excluded });
    else setTripPaymentExcluded(db, it.id, !it.excluded);
  });
  const [reassign, setReassign] = useState({});   // 목록에 없는 이름 → 바꿔 이을 일행
  const reassignName = (from) => run(() => reassignTripName(db, event.id, from, reassign[from] || ''));
  const removePayment = (it) => {
    if (!window.confirm(`"${it.title || '지출'}" ${won(it.amount)} 기록을 지울까요?`)) return;
    run(() => deleteTripPayment(db, it.id));
  };

  const openForm = (it = null) => {
    if (it) {
      setForm({ id: it.id, payer: it.payer, title: it.title, date: it.date, amount: String(it.amount), sharedBy: it.sharedBy || [], excluded: it.excluded });
    } else {
      const other = people.find(p => !p.isMe);
      setForm({ id: null, payer: (other || people[0]).name, title: '', date: event.date_from || '', amount: '', sharedBy: [] });
    }
    setFormError('');
  };
  const payerKnown = form ? people.some(p => p.name === form.payer) : true;
  const saveForm = () => {
    const amountValue = evaluateFormula(form.amount);
    if (!payerKnown) { setFormError('낸 사람이 일행에 없습니다 — 낸 사람을 다시 고르세요'); return; }
    if (form.amount.trim() === '' || amountValue === null || Number.isNaN(amountValue) || amountValue <= 0) {
      setFormError(isIncompleteFormula(form.amount)
        ? '수식을 마저 입력하세요'
        : '금액을 0보다 크게 올바르게 입력하세요 — 돌려받은 돈은 낸 돈을 줄여 적으세요');
      return;
    }
    if (form.date && !isValidDateStr(form.date)) { setFormError('날짜를 올바르게 입력하세요'); return; }
    const data = { payer: form.payer, title: form.title, date: form.date, amount: amountValue, sharedBy: form.sharedBy };
    const ok = run(() => {
      if (form.id) updateTripPayment(db, form.id, data);
      else addTripPayment(db, event.id, data);
    }, { onError: setFormError });
    if (ok) setForm(null);
  };

  const text = useMemo(() => tripSettlementText(event.title, settlement, won), [event.title, settlement]);
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('복사했어요 — 메신저에 붙여 넣으세요');
    } catch (e) {
      setPreviewOpen(true);
      setCopied('복사하지 못했어요 — 아래 펼친 글을 길게 눌러 복사하세요');
    }
  };
  const shareText = async () => {
    try {
      await navigator.share({ title: `${event.title} 정산`, text });
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // 공유 창을 닫았다
      copyText();
    }
  };
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const shareLabel = it => {
    if (!it.sharedBy || !it.sharedBy.length) return '모두';
    const known = it.sharedBy.filter(n => people.some(p => p.name === n));
    return known.length ? known.join(', ') : '모두';
  };

  return (
    <ModalOverlay className="ts-overlay" panelClassName="ts-modal">
      <div className="ts-header">
        <div className="ts-header-left">
          <span className="ts-title">일행 정산</span>
          <span className="ts-subtitle">{event.title}</span>
        </div>
        <button type="button" className="ts-close" onClick={onClose} aria-label="닫기">✕</button>
      </div>

      <div className="ts-body">
        <div className="ts-result">
          <div className="ts-result-total">함께 쓴 돈 <strong>{won(settlement.total)}</strong></div>
          {settlement.transfers.length ? (
            <ul className="ts-transfers">
              {settlement.transfers.map(t => (
                <li key={`${t.from}-${t.to}`}><b>{t.from}</b> → <b>{t.to}</b> <span>{won(t.amount)}</span></li>
              ))}
            </ul>
          ) : (
            <div className="ts-muted">주고받을 돈이 없어요{people.length < 2 ? ' — 아래에 일행을 더하세요' : ''}.</div>
          )}
          <div className="ts-actions">
            <button type="button" className="ts-btn" onClick={copyText}>정산 내용 복사</button>
            {canShare && <button type="button" className="ts-btn" onClick={shareText}>공유</button>}
          </div>
          {copied && <div className="ts-muted" role="status">{copied}</div>}
        </div>
        <div className="ts-muted">
          정산하며 보낸 돈을 가계부에 이 여행의 거래로 적었다면, 그 거래는 아래에서 &apos;정산에서 빼기&apos;를 눌러 주세요 — 그대로 두면 다시 나눠집니다.
        </div>

        {settlement.unknownNames.length > 0 && (
          <div className="ts-warn" role="alert">
            일행 목록에 없는 이름이 적힌 지출이 있어 나누지 않았어요(다른 기기에서 이름을 바꾸거나 뺀 사이 적은 것일 수 있어요).
            이름을 바꾼 사람이면 &apos;바꿔 잇기&apos;로, 일행에서 뺀 사람이면 &apos;다시 더하기&apos;로 바로잡으세요.
            {settlement.unknownNames.map(n => (
              <span key={n} className="ts-unknown">
                <b>{n}</b>
                <select
                  value={reassign[n] || ''}
                  onChange={e => setReassign({ ...reassign, [n]: e.target.value })}
                  aria-label={`${n}을(를) 바꿔 이을 일행`}
                >
                  <option value="">일행 고르기</option>
                  {people.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
                <button type="button" className="ts-btn" onClick={() => reassignName(n)} disabled={!reassign[n]}>바꿔 잇기</button>
                <button type="button" className="ts-btn" onClick={() => addPerson(n)}>{n} 다시 더하기</button>
              </span>
            ))}
          </div>
        )}

        {error && <div className="ts-error" role="alert">{error}</div>}

        <section className="ts-section">
          <div className="ts-section-title">일행 <small>몫: 한 사람이 몇 사람 몫을 내는지(예: 우리 집 4명이면 4)</small></div>
          <ul className="ts-list">
            {settlement.people.map(p => (
              <li key={p.name} className="ts-person">
                {editingName?.from === p.name ? (
                  <span className="ts-rename">
                    <input
                      className="ts-input"
                      value={editingName.to}
                      maxLength={30}
                      onChange={e => setEditingName({ ...editingName, to: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setEditingName(null); }}
                      aria-label={`${p.name} 새 이름`}
                    />
                    <button type="button" className="ts-btn" onClick={() => setEditingName(null)}>취소</button>
                    <button type="button" className="ts-btn ts-btn--primary" onClick={saveRename}>저장</button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="ts-person-name"
                    onClick={() => setEditingName({ from: p.name, to: p.name })}
                    aria-label={`${p.name} 이름 바꾸기`}
                  >
                    {p.name}
                  </button>
                )}
                <span className="ts-weight" role="group" aria-label={`${p.name} 몫`}>
                  <button type="button" onClick={() => changeWeight(p, -1)} disabled={p.weight <= 1} aria-label={`${p.name} 몫 줄이기`}>−</button>
                  <span>{p.weight}몫</span>
                  <button type="button" onClick={() => changeWeight(p, 1)} disabled={p.weight >= 99} aria-label={`${p.name} 몫 늘리기`}>+</button>
                </span>
                <span className={`ts-balance${p.balance > 0 ? ' ts-balance--plus' : p.balance < 0 ? ' ts-balance--minus' : ''}`}>
                  {p.balance > 0 ? `${won(p.balance)} 받음` : p.balance < 0 ? `${won(-p.balance)} 보냄` : '0원'}
                  <small> 낸 돈 {won(p.paid)} · 몫 {won(p.owed)}</small>
                </span>
                {!p.isMe && (
                  <button type="button" className="ts-remove" onClick={() => removePerson(p)} aria-label={`${p.name} 일행에서 빼기`}>✕</button>
                )}
              </li>
            ))}
          </ul>
          <div className="ts-add">
            <input
              className="ts-input"
              value={newName}
              maxLength={30}
              placeholder="일행 이름 (예: 민수네)"
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addPerson(); }}
              aria-label="일행 이름"
            />
            <button type="button" className="ts-btn ts-btn--primary" onClick={() => addPerson()} disabled={!newName.trim()}>추가</button>
          </div>
        </section>

        <section className="ts-section">
          <div className="ts-section-title">나눌 지출 <small>가계부의 여행 거래는 우리가 낸 돈이에요</small></div>
          {settlement.items.length === 0 && <div className="ts-muted">아직 이 여행에 연결된 거래나 일행이 낸 돈이 없어요.</div>}
          <ul className="ts-list">
            {settlement.items.map(it => (
              <li key={it.key} className={`ts-item${it.excluded ? ' ts-item--off' : ''}`}>
                <div className="ts-item-main">
                  <span className="ts-item-title">
                    {it.title || '(내용 없음)'}
                    <small> {shortDate(it.date)} · {it.payer} 냄</small>
                  </span>
                  <span className="ts-item-amount">{won(it.amount)}</span>
                </div>
                {it.unknown.length > 0 && !it.excluded && (
                  <div className="ts-item-warn">일행 목록에 없는 이름({it.unknown.join(', ')})이 있어 나누지 않았어요.</div>
                )}
                <div className="ts-item-sub">
                  {it.excluded ? (
                    <span className="ts-muted">정산에서 뺐어요</span>
                  ) : (
                    <button
                      type="button"
                      className="ts-link"
                      onClick={() => setOpenItem(openItem === it.key ? null : it.key)}
                      aria-expanded={openItem === it.key}
                    >
                      나눔: {shareLabel(it)}
                    </button>
                  )}
                  {it.kind === 'tx' ? (
                    <button type="button" className="ts-link" onClick={() => toggleExcluded(it)}>
                      {it.excluded ? '다시 나누기' : '정산에서 빼기'}
                    </button>
                  ) : (
                    <>
                      <button type="button" className="ts-link" onClick={() => toggleExcluded(it)}>
                        {it.excluded ? '다시 나누기' : '정산에서 빼기'}
                      </button>
                      <button type="button" className="ts-link" onClick={() => openForm(it)}>고치기</button>
                      <button type="button" className="ts-link ts-link--danger" onClick={() => removePayment(it)}>지우기</button>
                    </>
                  )}
                </div>
                {openItem === it.key && !it.excluded && (
                  <SharePicker people={people} value={it.sharedBy} onChange={v => setItemShare(it, v)} />
                )}
              </li>
            ))}
          </ul>

          {form ? (
            <div className="ts-form">
              <div className="ts-form-title">{form.id ? '일행이 낸 돈 고치기' : '일행이 낸 돈 적기'}</div>
              {form.excluded && <div className="ts-muted">이 지출은 정산에서 빠져 있어요 — 고쳐도 빠진 채로 두고, 목록의 &apos;다시 나누기&apos;로 넣을 수 있어요.</div>}
              <div className="ts-form-row">
                <label htmlFor="ts-payer">낸 사람</label>
                <select id="ts-payer" value={payerKnown ? form.payer : ''} onChange={e => setForm({ ...form, payer: e.target.value })}>
                  {!payerKnown && <option value="">다시 고르세요</option>}
                  {people.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
              </div>
              <div className="ts-form-row">
                <label htmlFor="ts-title">내용</label>
                <input id="ts-title" className="ts-input" value={form.title} maxLength={60} placeholder="예: 저녁 식사" onChange={e => setForm({ ...form, title: e.target.value })} />
              </div>
              <div className="ts-form-row">
                <label htmlFor="ts-date">날짜</label>
                <input id="ts-date" className="ts-input" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
              </div>
              <div className="ts-form-row">
                <label htmlFor="ts-amount">금액(원)</label>
                <AmountInput
                  id="ts-amount"
                  className="ts-input"
                  value={form.amount}
                  onChange={v => setForm({ ...form, amount: v })}
                  placeholder="외화면 환율을 곱해 원화로 (예: 5000*9.1)"
                />
              </div>
              <div className="ts-form-row ts-form-row--top">
                <span>나눌 사람</span>
                <SharePicker people={people} value={form.sharedBy} onChange={v => setForm({ ...form, sharedBy: v })} />
              </div>
              {formError && <div className="ts-error" role="alert">{formError}</div>}
              <div className="ts-actions">
                <button type="button" className="ts-btn" onClick={() => { setForm(null); setFormError(''); }}>취소</button>
                <button type="button" className="ts-btn ts-btn--primary" onClick={saveForm}>{form.id ? '저장' : '추가'}</button>
              </div>
            </div>
          ) : (
            <button type="button" className="ts-btn ts-add-payment" onClick={() => openForm()}>+ 일행이 낸 돈 적기</button>
          )}
        </section>

        <details className="ts-preview" open={previewOpen} onToggle={e => setPreviewOpen(e.currentTarget.open)}>
          <summary>공유할 글 보기</summary>
          <pre>{text}</pre>
        </details>
      </div>
    </ModalOverlay>
  );
}
