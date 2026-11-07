import React, { useState } from 'react';
import { formatAmount } from '../../services/formulaEvaluator';
import { todayStr } from '../../services/dateUtils';

const DISMISS_KEY = 'ledger_balance_alert_dismissed';

function readDismissed() {
  try { return window.localStorage.getItem(DISMISS_KEY) || ''; } catch (e) { return ''; }
}

const md = (dateStr) => {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}월 ${d}일`;
};

/**
 * 잔액 위험 알림 (B-066) — 계좌 잔액이 위험 임계값 아래로 내려가는 날을 거래내역 첫 화면에 알린다.
 * 닫으면 오늘 하루, 같은 내용으로는 다시 보이지 않는다(날짜·금액이 바뀌면 다시 보인다).
 */
export default function BalanceAlertBanner({ alerts, onOpenAccount }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!alerts.length) return null;
  const stamp = `${todayStr()}#${alerts.map(a => `${a.accountId}:${a.date}:${a.balance}`).join('|')}`;
  if (dismissed === stamp) return null;

  const dismiss = () => {
    setDismissed(stamp);
    try { window.localStorage.setItem(DISMISS_KEY, stamp); } catch (e) { /* 이번 화면에서만 닫힌다 */ }
  };

  return (
    <div className="balance-alert" role="alert">
      <span className="balance-alert-icon" aria-hidden="true">⚠️</span>
      <ul className="balance-alert-list">
        {alerts.map(a => (
          <li key={a.accountId}>
            <button type="button" className="balance-alert-link" onClick={() => onOpenAccount && onOpenAccount(a.accountId)}>
              <b>{a.accountName}</b>{' '}
              {a.isNow
                ? `잔액 ${formatAmount(a.balance)}원 — 위험선(${formatAmount(a.threshold)}원)보다 적어요`
                : `${md(a.date)}(${a.daysUntil}일 뒤) 잔액이 ${formatAmount(a.balance)}원으로 위험선(${formatAmount(a.threshold)}원) 아래로 내려가요`}
              <span className="balance-alert-more"> 보기 ›</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="balance-alert-close" onClick={dismiss} aria-label="오늘 그만 보기">✕</button>
    </div>
  );
}
