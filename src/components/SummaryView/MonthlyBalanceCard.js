import React, { useMemo } from 'react';
import { isMonthlyBalanceEnabled, getMonthlyBalance } from '../../services/dbManager';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';
import { formatAmount } from '../../services/formulaEvaluator';
import './MonthlyBalanceCard.css';

/** 저축률 문구 — 수입이 없으면 없음 */
export function rateText(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '-';
  return `${Math.round(rate * 100)}%`;
}

/**
 * 요약 › 월별 추이 — 이 달 수지 (I-026, ROADMAP C-6). 수입·월 수지를 켰을 때만 보인다.
 * 수입(고른 계좌의 입금, 예정 포함) · 지출(가계부 순지출 = 목록의 '총액') · 남은 돈 · 저축률.
 * 아직 들어오지 않은 예정 수입과, 날짜가 지났지만 금액을 고치지 않은 예정 입금을 따로 알린다.
 */
export default function MonthlyBalanceCard({ db, dataVersion, month }) {
  const live = useDbSnapshot(db, dataVersion);
  const enabled = useMemo(() => isMonthlyBalanceEnabled(live.db), [live]);
  const bal = useMemo(() => (enabled ? getMonthlyBalance(live.db, month) : null), [live, enabled, month]);
  if (!enabled || !bal) return null;

  return (
    <div className="mb-card">
      <div className="mb-card-head">
        <b>{month} 수지</b>
      </div>
      <dl className="mb-card-grid">
        <div><dt>수입</dt><dd>{formatAmount(bal.income)}원</dd></div>
        <div><dt>지출(할인 뺀)</dt><dd>{formatAmount(bal.spend)}원</dd></div>
        <div className={bal.left >= 0 ? 'mb-left mb-left--plus' : 'mb-left mb-left--minus'}>
          <dt>남은 돈</dt><dd>{bal.left < 0 ? '-' : ''}{formatAmount(Math.abs(bal.left))}원</dd>
        </div>
        <div><dt>저축률</dt><dd>{rateText(bal.rate)}</dd></div>
      </dl>
      {bal.upcoming > 0 && (
        <div className="mb-card-note">아직 들어오지 않은 예정 수입 {formatAmount(bal.upcoming)}원이 포함돼 있어요.</div>
      )}
      {bal.unconfirmed > 0 && (
        <div className="mb-card-note">
          금액을 고치지 않은 예정 입금 {formatAmount(bal.unconfirmed)}원이 포함돼 있어요 — 실제 들어온 금액이 다르면 계좌 탭에서 고치고,
          맞으면 그 내역을 열어 그대로 저장하면 확정돼요.
        </div>
      )}
      {bal.income === 0 && (
        <div className="mb-card-note">이 달 수입이 없어요 — 설정 › 지출계획 › 예산의 '수입·월 수지'에서 수입으로 셀 계좌를 고르세요.</div>
      )}
    </div>
  );
}
