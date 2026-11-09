import React, { useMemo, useState } from 'react';
import {
  isSubscriptionsEnabled, setSubscriptionsEnabled, getSubscriptions, getSubscriptionTotals,
  getRecurringTransactions, setRecurringSubscription, setSubscriptionNote, looksLikeSubscription,
  updateRecurringTransaction, keepSubscriptionAmount, recurringDiscount,
} from '../../../services/dbManager';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import { OptionalFeatureHead } from '../optionalFeatures';

const won = n => `${Math.round(n).toLocaleString()}원`;
const nameOf = r => r.detail || r.sub_category || r.budget_category;
const scheduleOf = r => {
  const day = r.day_of_month === 0 ? '말일' : `${r.day_of_month}일`;
  return r.frequency === 'annual' ? `매년 ${r.month_of_year}월 ${day}` : `매월 ${day}`;
};
const NOTE_MAX = 200;

/**
 * 지출계획 › 정기지출 › 구독 모아보기 (I-027, ROADMAP C-8) — 필요한 사람만 켜는 선택 기능(가족 공통 설정).
 * 정기지출 중 구독으로 표시한 것을 모아 월·연 환산 합계(할인 뺀 금액)를 보이고, 최근 결제액이 등록 금액과 다르면 알린다.
 * 끄면 화면에서만 감추고 구독 표시·해지 메모는 남겨 둔다.
 */
export default function SubscriptionPanel({ db, dataVersion, onChanged }) {
  const live = useDbSnapshot(db, dataVersion);
  const enabled = useMemo(() => isSubscriptionsEnabled(live.db), [live]);
  const subs = useMemo(() => (enabled ? getSubscriptions(live.db) : []), [live, enabled]);
  const totals = useMemo(() => getSubscriptionTotals(subs), [subs]);
  const recurring = useMemo(() => (enabled ? getRecurringTransactions(live.db) : []), [live, enabled]);
  const [picking, setPicking] = useState(false);
  const [noteEdit, setNoteEdit] = useState(null);   // { id, text }

  // 구독 고르기: 구독으로 표시한 것 → 구독 같아 보이는 것 → 나머지 (금액은 구독 목록과 같은 할인 뺀 금액)
  const pickList = useMemo(() => {
    const rank = r => (r.is_subscription ? 0 : looksLikeSubscription(r) ? 1 : 2);
    return [...recurring]
      .sort((a, b) => rank(a) - rank(b))
      .map(r => ({ ...r, net: r.amount - recurringDiscount(live.db, r) }));
  }, [recurring, live]);

  const toggle = () => {
    setSubscriptionsEnabled(db, !enabled);
    setPicking(false);
    setNoteEdit(null);
    onChanged();
  };
  const togglePick = (r) => {
    setRecurringSubscription(db, r.id, !r.is_subscription);
    onChanged();
  };
  const saveNote = () => {
    setSubscriptionNote(db, noteEdit.id, noteEdit.text);
    setNoteEdit(null);
    onChanged();
  };
  const applyAmount = (s) => {
    const next = s.lastPaid.amount;
    if (!window.confirm(
      `"${nameOf(s)}" 등록 금액을 ${won(s.amount)}에서 ${won(next)}으로 바꿀까요?\n`
      + '미리 등록해 둔 앞으로의 거래도 금액·할인·결제수단을 고치지 않았으면 새 금액으로 바뀌고 할인도 다시 계산됩니다.',
    )) return;
    updateRecurringTransaction(db, s.id, { ...s, amount: next });
    onChanged();
  };
  const keepAmount = (s) => {
    keepSubscriptionAmount(db, s.id, s.lastPaid.date);
    onChanged();
  };
  const noteKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveNote(); }
    if (e.key === 'Escape') setNoteEdit(null);
  };

  return (
    <div className="sub-panel">
      <OptionalFeatureHead featureKey="subscriptions" enabled={enabled} onToggle={toggle} />

      {enabled && (
        <>
          {subs.length > 0 && (
            <div className="sub-totals">
              <div><span>월 환산</span><strong>{won(totals.monthly)}</strong></div>
              <div><span>연 환산</span><strong>{won(totals.annual)}</strong></div>
              <div><span>구독</span><strong>{totals.count}개</strong></div>
            </div>
          )}

          {subs.length === 0 ? (
            <div className="cb-settings-note">
              {recurring.length === 0
                ? '정기지출이 없어요 — 아래에서 넷플릭스 같은 구독을 정기지출로 추가한 뒤 구독으로 표시하세요.'
                : '구독으로 표시한 정기지출이 없어요 — \'구독 고르기\'에서 고르세요.'}
            </div>
          ) : (
            <ul className="sub-list">
              {subs.map(s => (
                <li key={s.id} className={`sub-row${s.changed ? ' sub-row--changed' : ''}`}>
                  <div className="sub-main">
                    <span className="sub-name">{nameOf(s)}</span>
                    <span className="sub-amount">
                      {won(s.net)}<span className="sub-per">/{s.frequency === 'annual' ? '년' : '월'}</span>
                    </span>
                  </div>
                  <div className="sub-meta">
                    {s.payment_method} · {scheduleOf(s)}
                    {s.frequency === 'annual' ? ` · 월 ${won(s.monthly)}꼴` : ` · 1년 ${won(s.annual)}`}
                    {s.discount > 0 && ` · 할인 ${won(s.discount)} 뺀 금액`}
                  </div>
                  {s.changed && (
                    <div className="sub-changed">
                      최근 결제 {won(s.lastPaid.amount)}({s.lastPaid.date}{s.lastPaid.split ? ', 나눠 결제한 합계' : ''})이
                      등록 금액 {won(s.amount)}과 달라요.
                      <span className="sub-changed-actions">
                        {s.lastPaid.amount > 0 && (
                          <button type="button" className="sub-link" onClick={() => applyAmount(s)}>
                            등록 금액 {won(s.lastPaid.amount)}으로 바꾸기
                          </button>
                        )}
                        <button type="button" className="sub-link" onClick={() => keepAmount(s)}>이대로 두기</button>
                      </span>
                    </div>
                  )}
                  {noteEdit?.id === s.id ? (
                    <div className="sub-note-edit">
                      <input
                        className="rule-form-input"
                        type="text"
                        value={noteEdit.text}
                        maxLength={NOTE_MAX}
                        onChange={e => setNoteEdit({ id: s.id, text: e.target.value })}
                        onKeyDown={noteKeyDown}
                        placeholder="예: 3월에 해지 · 앱 › 계정 › 멤버십 해지"
                        aria-label={`${nameOf(s)} 해지 메모`}
                      />
                      <button type="button" className="btn-primary sub-note-btn" onClick={saveNote}>저장</button>
                      <button type="button" className="btn-secondary sub-note-btn" onClick={() => setNoteEdit(null)}>취소</button>
                    </div>
                  ) : (
                    <div className="sub-note">
                      {s.cancel_note && <span>해지 메모: {s.cancel_note}</span>}
                      <button
                        type="button"
                        className="sub-link"
                        onClick={() => setNoteEdit({ id: s.id, text: s.cancel_note || '' })}
                      >
                        {s.cancel_note ? '메모 고치기' : '해지 메모 남기기'}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {recurring.length > 0 && (
            <button type="button" className="sub-link sub-pick-toggle" onClick={() => setPicking(p => !p)} aria-expanded={picking}>
              {picking ? '구독 고르기 닫기' : '구독 고르기'}
            </button>
          )}
          {picking && (
            <ul className="cb-settings-list sub-pick-list">
              {pickList.map(r => (
                <li key={r.id} className="cb-settings-row">
                  <span className="cb-settings-name mb-account-name">
                    {nameOf(r)}
                    <span className="mb-account-hint">
                      {won(r.net)} · {scheduleOf(r)}
                      {!r.is_subscription && looksLikeSubscription(r) && <span className="sub-hint"> · 구독 같아요</span>}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={`goal-display-toggle${r.is_subscription ? ' goal-display-toggle--on' : ''}`}
                    onClick={() => togglePick(r)}
                    title={r.is_subscription ? `${nameOf(r)} 구독에서 빼기` : `${nameOf(r)} 구독으로 표시`}
                    aria-pressed={!!r.is_subscription}
                  >
                    <span className="goal-display-toggle-knob" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
