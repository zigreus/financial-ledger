import React, { useState } from 'react';
import { formatAmount } from '../../services/formulaEvaluator';
import { todayStr } from '../../services/dateUtils';

const DISMISS_KEY = 'ledger_budget_alert_dismissed';
const keyOf = a => `${a.category}:${a.level}`;

/** 오늘 닫은 알림들 (카테고리:주의|초과) — 다른 날 닫은 것은 버린다 */
function readDismissed() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(DISMISS_KEY) || 'null');
    return saved && saved.date === todayStr() && Array.isArray(saved.keys) ? saved.keys : [];
  } catch (e) {
    return [];
  }
}

/**
 * 카테고리 예산 알림 (I-025, ROADMAP C-5) — 이번 달 예산의 80% 이상을 썼거나 넘은 카테고리를 거래내역 첫 화면에 알린다.
 * 카테고리별 예산을 켰을 때만(alerts가 오면) 보인다. 누르면 요약의 예산 대비로 간다.
 * 닫으면 그 알림들은 오늘 다시 보이지 않는다 — 다른 카테고리가 넘거나 주의가 초과로 바뀐 것만 새로 보인다.
 * alerts: getCategoryBudgetStatus 중 level이 warn·over인 것
 */
export default function BudgetAlertBanner({ alerts, onOpenBudget }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const shown = alerts.filter(a => !dismissed.includes(keyOf(a)));
  if (!shown.length) return null;

  const dismiss = () => {
    const keys = [...new Set([...dismissed, ...shown.map(keyOf)])];
    setDismissed(keys);
    try { window.localStorage.setItem(DISMISS_KEY, JSON.stringify({ date: todayStr(), keys })); } catch (e) { /* 이번 화면에서만 닫힌다 */ }
  };

  return (
    <div className="balance-alert budget-alert" role="alert">
      <span className="balance-alert-icon" aria-hidden="true">{shown.some(a => a.level === 'over') ? '🚨' : '💡'}</span>
      <ul className="balance-alert-list">
        {shown.map(a => (
          <li key={a.category}>
            <button type="button" className="balance-alert-link" onClick={() => onOpenBudget && onOpenBudget()}>
              <b>{a.category}</b>{' '}
              {a.level === 'over'
                ? `이번 달 예산 ${formatAmount(a.budget)}원을 ${formatAmount(a.spent - a.budget)}원 넘었어요`
                : `이번 달 예산의 ${Math.round(a.ratio * 100)}%를 썼어요 (${formatAmount(a.budget - a.spent)}원 남음)`}
              <span className="balance-alert-more"> 보기 ›</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="balance-alert-close" onClick={dismiss} aria-label="오늘 그만 보기">✕</button>
    </div>
  );
}
