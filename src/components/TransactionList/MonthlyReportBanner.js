import React, { useState } from 'react';
import { formatAmount } from '../../services/formulaEvaluator';
import { reportAvgLabel } from '../../services/dbManager';

const SEEN_KEY = 'ledger_monthly_report_seen';
/** 달이 바뀐 뒤 며칠 동안 지난달 리포트를 알리는지 */
export const REPORT_BANNER_DAYS = 7;

function readSeen() {
  try {
    return window.localStorage.getItem(SEEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

/** 이 기기에서 그 달 리포트 알림을 이미 보았는지 — 보았으면 알림용 계산도 하지 않는다 */
export function isReportSeen(ym) {
  return readSeen() === ym;
}

/** 이 기기에서 그 달 리포트 알림을 보았다(열었거나 닫았다) */
export function markReportSeen(ym) {
  try { window.localStorage.setItem(SEEN_KEY, ym); } catch (e) { /* 이번 화면에서만 닫힌다 */ }
}

const won = n => `${formatAmount(Math.round(n))}원`;

/**
 * 지난달 리포트 알림 (I-028, ROADMAP C-9) — 월간 리포트를 켰을 때, 매달 1~7일에 거래내역 첫 화면에 보인다.
 * 열거나 닫으면 이 기기에서는 그 달 알림을 다시 보이지 않는다(리포트는 요약 › 리포트에서 언제든 볼 수 있다).
 * report: 지난달 getMonthlyReportHeadline 결과(거래가 있을 때만), onOpen(ym)
 */
export default function MonthlyReportBanner({ report, onOpen }) {
  const [seen, setSeen] = useState(readSeen);
  if (!report || !report.count || seen === report.month) return null;

  const close = () => {
    markReportSeen(report.month);
    setSeen(report.month);
  };
  const open = () => {
    close();
    if (onOpen) onOpen(report.month);
  };
  const diff = report.avg ? report.total - report.avg.total : 0;
  const compare = report.avg && diff !== 0
    ? `, ${reportAvgLabel(report)}보다 ${won(Math.abs(diff))} ${diff > 0 ? '더' : '덜'} 썼어요`
    : '';

  return (
    <div className="balance-alert report-alert" role="status">
      <span className="balance-alert-icon" aria-hidden="true">📊</span>
      <ul className="balance-alert-list">
        <li>
          <button type="button" className="balance-alert-link" onClick={open}>
            <b>{Number(report.month.slice(5, 7))}월 리포트</b>가 나왔어요 — 순지출 {won(report.total)}{compare}
            <span className="balance-alert-more"> 보기 ›</span>
          </button>
        </li>
      </ul>
      <button type="button" className="balance-alert-close" onClick={close} aria-label="리포트 알림 닫기">✕</button>
    </div>
  );
}
