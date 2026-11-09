import React, { useState } from 'react';
import { formatAmount } from '../../services/formulaEvaluator';
import {
  reportAvgLabel, getBalanceAlerts, isCategoryBudgetEnabled, getCategoryBudgetStatus, isMonthlyReportEnabled,
  getMonthlyReportHeadline, isSubscriptionsEnabled, getUpcomingSubscriptionPayments,
} from '../../services/dbManager';
import { addMonths, todayStr } from '../../services/dateUtils';

/*
 * 확인할 것 (I-036, ROADMAP C-12) — 앱을 열면 거래내역 맨 위에 보이는 알림 카드 하나.
 * 푸시 알림(서버) 대신, 앱을 열 때 이 카드가 먼저 보이게 한다(거래내역이 이번 달로 내려가지 않음 — B-093).
 *  - 잔액 위험(B-066): 닫으면 오늘 하루, 같은 내용으로는 다시 보이지 않는다(날짜·금액이 바뀌면 다시 보인다)
 *  - 카테고리 예산 80%·100%(I-025): 닫은 것은 오늘 다시 보이지 않는다 — 다른 카테고리가 넘거나 주의가 초과로 바뀐 것만 새로
 *  - 구독 결제 예정(I-036): 결제 3일 전부터. 닫은 결제(그 구독의 그 날짜)는 다시 보이지 않는다
 *  - 지난달 리포트(I-028): 매달 1~7일. 열거나 닫으면 이 기기에서는 그 달 알림을 다시 보이지 않는다
 * 새 알림은 띠를 따로 만들지 말고 이 카드에 항목으로 더한다. 닫은 기록은 기기별(localStorage)이다.
 */

const BALANCE_KEY = 'ledger_balance_alert_dismissed';
const BUDGET_KEY = 'ledger_budget_alert_dismissed';
const REPORT_KEY = 'ledger_monthly_report_seen';
const PAYMENT_KEY = 'ledger_subscription_due_dismissed';

/** 달이 바뀐 뒤 며칠 동안 지난달 리포트를 알리는지 */
export const REPORT_BANNER_DAYS = 7;

function readKey(key) {
  try { return window.localStorage.getItem(key) || ''; } catch (e) { return ''; }
}
function writeKey(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* 이번 화면에서만 닫힌다 */ }
}
function readList(key, keep) {
  try {
    const saved = JSON.parse(readKey(key) || 'null');
    return keep(saved) || [];
  } catch (e) {
    return [];
  }
}

/** 이 기기에서 그 달 리포트 알림을 이미 보았는지 — 보았으면 알림용 계산도 하지 않는다 */
export function isReportSeen(ym) {
  return readKey(REPORT_KEY) === ym;
}

/** 이 기기에서 그 달 리포트 알림을 보았다(열었거나 닫았다) */
export function markReportSeen(ym) {
  writeKey(REPORT_KEY, ym);
}

const balanceStamp = (alerts, today) => `${today}#${alerts.map(a => `${a.accountId}:${a.date}:${a.balance}`).join('|')}`;
const budgetKey = a => `${a.category}:${a.level}`;
// 그 구독의 그 날짜 — 거래 번호는 쓰지 않는다(연결 없이 연 동안 등록 전 일정으로 닫은 결제가 연결 뒤 자동등록돼도 다시 뜨지 않게)
const paymentKey = p => `${p.recurringId}@${p.date}`;
// 오늘 닫은 예산 알림들 — 다른 날 닫은 것은 버린다
const readBudgetSeen = () => readList(BUDGET_KEY, s => (s && s.date === todayStr() && Array.isArray(s.keys) ? s.keys : null));
// 닫은 결제 예정 — 지난 결제는 버린다(쓸 때 정리)
const readPaymentSeen = () => readList(PAYMENT_KEY, s => (Array.isArray(s) ? s : null));

/**
 * 오늘 알릴 것 — 거래내역의 이 카드와, 처음 여는 화면을 고를 때(App, U-8) 같은 계산을 쓴다.
 * { balanceAlerts, budgetAlerts, payments, report } — 닫은 기록은 보지 않는다(hasVisibleNotices·카드가 filterVisible로 거른다)
 *  - 지난달 리포트는 월간 리포트를 켰을 때 매달 1~REPORT_BANNER_DAYS일에만, 이 기기에서 이미 본 달이면 계산하지 않는다
 */
export function collectOpenNotices(db, today = todayStr()) {
  if (!db) return { balanceAlerts: [], budgetAlerts: [], payments: [], report: null };
  const month = today.slice(0, 7);
  let report = null;
  if (Number(today.slice(8, 10)) <= REPORT_BANNER_DAYS && isMonthlyReportEnabled(db)) {
    const ym = addMonths(month, -1);
    if (!isReportSeen(ym)) {
      const headline = getMonthlyReportHeadline(db, ym);
      report = headline.count ? headline : null;
    }
  }
  return {
    // 계좌 잔액이 위험선 아래로 내려가는 날 (B-066)
    balanceAlerts: getBalanceAlerts(db),
    // 이번 달 카테고리 예산 80% 이상·초과 (I-025) — 카테고리별 예산을 켰을 때만
    budgetAlerts: isCategoryBudgetEnabled(db) ? getCategoryBudgetStatus(db, month).filter(r => r.level !== 'ok') : [],
    // 곧 결제될 구독 (I-036) — 구독 모아보기를 켰을 때만
    payments: isSubscriptionsEnabled(db) ? getUpcomingSubscriptionPayments(db, today) : [],
    report,
  };
}

/** 이 기기에서 닫은 기록 */
function readSeen() {
  return { balance: readKey(BALANCE_KEY), budget: readBudgetSeen(), payment: readPaymentSeen(), report: readKey(REPORT_KEY) };
}

/** 닫은 것을 뺀, 카드에 보일 항목 — { balances, budgets, dues, showReport, stamp } */
function filterVisible({ balanceAlerts = [], budgetAlerts = [], payments = [], report = null }, seen, today) {
  const stamp = balanceStamp(balanceAlerts, today);
  return {
    stamp,
    balances: balanceAlerts.length && seen.balance !== stamp ? balanceAlerts : [],
    budgets: budgetAlerts.filter(a => !seen.budget.includes(budgetKey(a))),
    dues: payments.filter(p => !seen.payment.includes(paymentKey(p))),
    showReport: !!report && !!report.count && seen.report !== report.month,
  };
}

/** 지금 '확인할 것' 카드가 보일지 — 닫은 기록까지 따진다 (U-8: 다른 화면을 먼저 열기로 했어도 이때는 거래내역부터) */
export function hasVisibleNotices(notices, today = todayStr()) {
  const v = filterVisible(notices, readSeen(), today);
  return v.balances.length > 0 || v.budgets.length > 0 || v.dues.length > 0 || v.showReport;
}

const md = (dateStr) => {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}월 ${d}일`;
};
const won = n => `${formatAmount(Math.round(n))}원`;
const WHEN = ['오늘', '내일', '모레'];

function balanceText(a) {
  return a.isNow
    ? `잔액 ${won(a.balance)} — 위험선(${won(a.threshold)})보다 적어요`
    : `${md(a.date)}(${a.daysUntil}일 뒤) 잔액이 ${won(a.balance)}으로 위험선(${won(a.threshold)}) 아래로 내려가요`;
}

function budgetText(a) {
  return a.level === 'over'
    ? `이번 달 예산 ${won(a.budget)}을 ${won(a.spent - a.budget)} 넘었어요`
    : `이번 달 예산의 ${Math.round(a.ratio * 100)}%를 썼어요 (${won(a.budget - a.spent)} 남음)`;
}

function paymentText(p) {
  const when = p.daysUntil === 0 ? '오늘' : `${WHEN[p.daysUntil] || `${p.daysUntil}일 뒤`}(${md(p.date)})`;
  return `${when} ${won(p.amount)}이 결제돼요`;
}

function reportText(report) {
  const diff = report.avg ? report.total - report.avg.total : 0;
  const compare = report.avg && diff !== 0
    ? `, ${reportAvgLabel(report)}보다 ${won(Math.abs(diff))} ${diff > 0 ? '더' : '덜'} 썼어요`
    : '';
  return `가 나왔어요 — 순지출 ${won(report.total)}${compare}`;
}

/**
 * balanceAlerts: getBalanceAlerts, budgetAlerts: getCategoryBudgetStatus 중 warn·over,
 * payments: getUpcomingSubscriptionPayments, report: 지난달 getMonthlyReportHeadline(거래가 있을 때만)
 * anchorRef: 카드가 보일 때 그 요소 — 거래내역이 처음 열릴 때 이번 달 대신 이 카드로 스크롤한다
 * scrollMargin: 그 스크롤에서 카드 위에 남길 높이(붙박이 필터바 + 여백, px) — 카드가 필터바 밑에 가리지 않게
 */
export default function OpenNotices({
  balanceAlerts = [], budgetAlerts = [], payments = [], report = null, anchorRef, scrollMargin = 0,
  onOpenAccount, onOpenBudget, onOpenSubscriptions, onOpenReport,
}) {
  const [balanceSeen, setBalanceSeen] = useState(() => readKey(BALANCE_KEY));
  const [budgetSeen, setBudgetSeen] = useState(readBudgetSeen);
  const [paymentSeen, setPaymentSeen] = useState(readPaymentSeen);
  const [reportSeen, setReportSeen] = useState(() => readKey(REPORT_KEY));

  const today = todayStr();
  const {
    stamp, balances, budgets, dues, showReport,
  } = filterVisible({ balanceAlerts, budgetAlerts, payments, report }, {
    balance: balanceSeen, budget: budgetSeen, payment: paymentSeen, report: reportSeen,
  }, today);
  if (!balances.length && !budgets.length && !dues.length && !showReport) return null;

  const closeReport = () => {
    markReportSeen(report.month);
    setReportSeen(report.month);
  };
  const close = () => {
    if (balances.length) {
      setBalanceSeen(stamp);
      writeKey(BALANCE_KEY, stamp);
    }
    if (budgets.length) {
      const keys = [...new Set([...budgetSeen, ...budgets.map(budgetKey)])];
      setBudgetSeen(keys);
      writeKey(BUDGET_KEY, JSON.stringify({ date: today, keys }));
    }
    if (dues.length) {
      const keys = [...new Set([...paymentSeen, ...dues.map(paymentKey)])]
        .filter(k => (k.split('@')[1] || '') >= today);
      setPaymentSeen(keys);
      writeKey(PAYMENT_KEY, JSON.stringify(keys));
    }
    if (showReport) closeReport();
  };

  const urgent = balances.length > 0 || budgets.some(a => a.level === 'over');
  const item = (key, kind, icon, onClick, children) => (
    <li key={key} className={`open-notice open-notice-${kind}`}>
      <span className="open-notice-icon" aria-hidden="true">{icon}</span>
      <button type="button" className="balance-alert-link" onClick={onClick}>
        {children}
        <span className="balance-alert-more"> 보기 ›</span>
      </button>
    </li>
  );

  return (
    <div
      className="balance-alert open-notices"
      role={urgent ? 'alert' : 'status'}
      aria-labelledby="open-notices-title"
      ref={anchorRef}
      style={{ scrollMarginTop: `${scrollMargin}px` }}
    >
      <div className="open-notices-body">
        <h3 className="open-notices-title" id="open-notices-title">확인할 것</h3>
        <ul className="open-notices-list">
          {balances.map(a => item(`balance-${a.accountId}`, 'balance', '⚠️',
            () => onOpenAccount && onOpenAccount(a.accountId),
            <><b>{a.accountName}</b> {balanceText(a)}</>))}
          {budgets.map(a => item(`budget-${a.category}`, 'budget', a.level === 'over' ? '🚨' : '💡',
            () => onOpenBudget && onOpenBudget(),
            <><b>{a.category}</b> {budgetText(a)}</>))}
          {dues.map(p => item(`due-${p.id}`, 'due', '🔔',
            () => onOpenSubscriptions && onOpenSubscriptions(),
            <><b>{p.name}</b> {paymentText(p)}</>))}
          {showReport && item('report', 'report', '📊',
            () => { closeReport(); if (onOpenReport) onOpenReport(report.month); },
            <><b>{Number(report.month.slice(5, 7))}월 리포트</b>{reportText(report)}</>)}
        </ul>
      </div>
      <button type="button" className="balance-alert-close" onClick={close} aria-label="알림 닫기" title="알림 닫기">✕</button>
    </div>
  );
}
