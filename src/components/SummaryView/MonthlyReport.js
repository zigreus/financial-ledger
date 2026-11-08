import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getMonthlyReport, reportAvgLabel, reportSoFarLabel } from '../../services/dbManager';
import { activeAI } from '../../services/aiClient';
import { polishReportWithAI } from '../../services/monthlyReportAI';
import { formatAmount } from '../../services/formulaEvaluator';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';
import { categoryColor } from '../common/categoryColor';
import './MonthlyReport.css';

const won = n => `${formatAmount(Math.round(n))}원`;
const signedWon = n => `${n > 0 ? '+' : n < 0 ? '-' : ''}${formatAmount(Math.abs(Math.round(n)))}원`;
const monthLabel = ym => `${ym.slice(0, 4)}년 ${Number(ym.slice(5, 7))}월`;
const percentOf = (diff, avg) => (avg > 0 ? `${diff > 0 ? '+' : ''}${Math.round((diff / avg) * 100)}%` : '새 지출');
const dayLabel = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

function ChangeList({ title, items, kind }) {
  if (!items.length) return null;
  return (
    <div className="mr-block">
      <div className="mr-block-title">{title}</div>
      <ul className="mr-list">
        {items.map(c => (
          <li key={c.name} className="mr-row">
            <span className="mr-dot" style={{ background: categoryColor(c.name) }} aria-hidden="true" />
            <span className="mr-row-name">{c.name}</span>
            <span className="mr-row-value">
              {won(c.total)}
              <span className={`mr-diff mr-diff--${kind}`}> {signedWon(c.diff)} ({percentOf(c.diff, c.avg)})</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 요약 › 리포트 (I-028, ROADMAP C-9) — 한 달 리포트. 숫자는 규칙으로 계산하고, '✨ AI 한마디'는 집계만 보내 문장으로 다듬는다.
 * months: 고를 수 있는 달(새 것부터), month: 보는 달, onMonthChange(ym)
 * showGoal: 이 기기에서 월 목표금액을 보이는지(설정 › 예산의 목표금액 표시), onOpenSettings(section): AI 키가 없을 때 설정 열기
 */
export default function MonthlyReport({ db, dataVersion, month, months, onMonthChange, showGoal = true, onOpenSettings }) {
  const live = useDbSnapshot(db, dataVersion);
  const report = useMemo(() => getMonthlyReport(live.db, month), [live, month]);
  const [ai, setAi] = useState({ status: 'idle' }); // idle | needKey | loading | done | error
  const abortRef = useRef(null);

  // 달이나 리포트 숫자가 바뀌면 받던 문장을 버린다 — 늦게 온 답이 다른 달 리포트로 보이지 않게(AGENTS §6)
  const resetKey = useMemo(() => JSON.stringify(report), [report]);
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = null;
    setAi({ status: 'idle' });
  }, [resetKey]);
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  const runAI = async () => {
    const config = activeAI();
    if (!config) { setAi({ status: 'needKey' }); return; }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAi({ status: 'loading', progress: '' });
    try {
      const result = await polishReportWithAI({
        ai: config, report, showGoal, signal: controller.signal,
        onProgress: (msg, info) => {
          if (controller.signal.aborted) return;
          if (info?.modelUsed) {
            if (info.modelUsed !== config.model) setAi(s => ({ ...s, modelNote: `${config.model}이(가) 붐벼서 ${info.modelUsed}(으)로 정리했습니다` }));
          } else {
            setAi(s => ({ ...s, progress: msg }));
          }
        },
      });
      if (controller.signal.aborted) return;
      setAi(s => ({ status: 'done', result, modelNote: s.modelNote }));
    } catch (e) {
      if (controller.signal.aborted || e.name === 'AbortError') return; // 취소는 오류가 아니다
      setAi({ status: 'error', error: e.message || '정리하지 못했습니다' });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };
  const cancelAI = () => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = null;
    setAi({ status: 'idle' });
  };

  const list = months.includes(month) ? months : [...months, month].sort().reverse();
  const idx = list.indexOf(month);
  const older = idx < list.length - 1 ? list[idx + 1] : null;
  const newer = idx > 0 ? list[idx - 1] : null;
  const r = report;
  const avgDiff = r.avg ? r.total - r.avg.total : 0;
  const avgLabel = reportAvgLabel(r);
  const sofar = reportSoFarLabel(r);

  return (
    <div className="mr">
      <div className="mr-nav">
        <button type="button" className="mr-nav-btn" disabled={!older} onClick={() => older && onMonthChange(older)} aria-label="이전 달 리포트">‹</button>
        <h3 className="mr-title">
          {monthLabel(month)} 리포트
          {r.inProgress && <span className="mr-badge">진행 중</span>}
        </h3>
        <button type="button" className="mr-nav-btn" disabled={!newer} onClick={() => newer && onMonthChange(newer)} aria-label="다음 달 리포트">›</button>
      </div>

      {r.count === 0 ? (
        <div className="mr-empty">이 달에는 거래가 없어요.</div>
      ) : (
        <>
          <div className="mr-total">
            <div className="mr-total-amount">{won(r.total)}<span className="mr-total-cnt"> · {r.count}건</span></div>
            <div className="mr-total-note">
              {r.avg
                ? (avgDiff === 0
                  ? `${avgLabel}(${won(r.avg.total)})과 같아요`
                  : `${avgLabel} ${won(r.avg.total)}보다 ${won(Math.abs(avgDiff))} ${avgDiff > 0 ? '더' : '덜'} 썼어요`)
                : '비교할 앞 달 기록이 없어요'}
              {r.inProgress && ' (아직 끝나지 않은 달이에요)'}
            </div>
            {r.upcoming !== 0 && (
              <div className="mr-total-note">오늘 뒤에 미리 등록된 예정 거래 {won(r.upcoming)}이 들어 있어요.</div>
            )}
            {r.partialFrom && (
              <div className="mr-total-note">이 달은 {dayLabel(r.partialFrom)}부터 가계부를 썼어요.</div>
            )}
          </div>

          {r.avg && (
            <>
              <ChangeList title={`${avgLabel}보다 크게 늘었어요`} items={r.rises} kind="up" />
              <ChangeList title={`${avgLabel}보다 크게 줄었어요`} items={r.drops} kind="down" />
              {!r.rises.length && !r.drops.length && (
                <div className="mr-block mr-muted">
                  {r.inProgress ? `${avgLabel}보다 크게 늘어난 카테고리는 아직 없어요.` : `${avgLabel}과 크게 다른 카테고리는 없어요.`}
                </div>
              )}
            </>
          )}

          {r.biggest.length > 0 && (
            <div className="mr-block">
              <div className="mr-block-title">가장 큰 지출</div>
              <ol className="mr-list mr-biggest">
                {r.biggest.map((b, i) => (
                  <li key={`${b.date}-${i}`} className="mr-row">
                    <span className="mr-rank">{i + 1}</span>
                    <span className="mr-row-name">
                      {b.detail || b.category || '(내용 없음)'}
                      <span className="mr-row-sub">
                        {' '}{dayLabel(b.date)}{b.detail && b.category ? ` · ${b.category}` : ''}{b.split ? ' · 나눠 결제' : ''}
                      </span>
                    </span>
                    <span className="mr-row-value">{won(b.amount)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="mr-grid">
            <div className="mr-stat">
              <span>무지출일</span>
              <strong>{r.noSpend.days}일<small> / {r.noSpend.of}일</small></strong>
              {r.noSpend.prevDays !== null && <em>지난달 {r.noSpend.prevDays}일</em>}
            </div>
            {r.goal && showGoal && (
              <div className={`mr-stat${r.goal.over ? ' mr-stat--bad' : r.goal.achieved ? ' mr-stat--good' : ''}`}>
                <span>월 목표 {won(r.goal.amount)}</span>
                <strong>
                  {r.goal.over
                    ? `${won(r.goal.spent - r.goal.amount)} 넘음`
                    : r.inProgress ? `${won(r.goal.amount - r.goal.spent)} 남음` : '지켰어요'}
                </strong>
                <em>{sofar}{Math.round(r.goal.ratio * 100)}% 썼어요</em>
              </div>
            )}
            {r.balance && (
              <div className={`mr-stat${r.balance.left >= 0 ? ' mr-stat--good' : ' mr-stat--bad'}`}>
                <span>수입 {won(r.balance.income)}</span>
                <strong>남은 돈 {signedWon(r.balance.left)}</strong>
                <em>{r.balance.rate !== null && Number.isFinite(r.balance.rate) ? `저축률 ${Math.round(r.balance.rate * 100)}%` : '저축률 -'}</em>
              </div>
            )}
          </div>

          {r.budgets && (
            <div className="mr-block">
              <div className="mr-block-title">카테고리 예산</div>
              {r.budgets.over.length === 0 && r.budgets.warn.length === 0 ? (
                <div className="mr-muted">
                  {r.inProgress
                    ? `예산을 정한 카테고리 ${r.budgets.okCount}개 모두 ${sofar}80% 안이에요.`
                    : `예산을 정한 카테고리 ${r.budgets.okCount}개 모두 80% 안으로 지켰어요.`}
                </div>
              ) : (
                <ul className="mr-list">
                  {r.budgets.over.map(b => (
                    <li key={b.category} className="mr-row">
                      <span className="mr-dot" style={{ background: categoryColor(b.category) }} aria-hidden="true" />
                      <span className="mr-row-name">{b.category}</span>
                      <span className="mr-row-value mr-diff--up">예산 {won(b.budget)}을 {won(b.spent - b.budget)} 넘었어요</span>
                    </li>
                  ))}
                  {r.budgets.warn.map(b => (
                    <li key={b.category} className="mr-row">
                      <span className="mr-dot" style={{ background: categoryColor(b.category) }} aria-hidden="true" />
                      <span className="mr-row-name">{b.category}</span>
                      <span className="mr-row-value">{sofar}예산의 {Math.round(b.ratio * 100)}%</span>
                    </li>
                  ))}
                  {r.budgets.okCount > 0 && (
                    <li className="mr-muted">
                      {r.inProgress
                        ? `그 밖의 ${r.budgets.okCount}개 카테고리는 ${sofar}80% 안이에요.`
                        : `그 밖의 ${r.budgets.okCount}개 카테고리는 80% 안으로 지켰어요.`}
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          <div className="mr-ai-box">
            {ai.status !== 'loading' && (
              <button type="button" className="btn-filter-sm fsum-ai-btn" onClick={runAI}>
                ✨ {ai.status === 'done' ? '다시 정리' : 'AI 한마디'}
              </button>
            )}
            {ai.status === 'loading' && (
              <div className="fsum-ai fsum-ai-loading" role="status">
                <span>AI가 정리하는 중…{ai.progress ? ` ${ai.progress}` : ''}</span>
                <button type="button" className="btn-filter-sm btn-filter-cancel" onClick={cancelAI}>취소</button>
              </div>
            )}
            {ai.status === 'needKey' && (
              <div className="fsum-ai">
                <p>AI 한마디를 보려면 AI 키를 먼저 설정해 주세요. 리포트 숫자는 키 없이도 볼 수 있어요.</p>
                {onOpenSettings && <button type="button" className="btn-filter-sm" onClick={() => onOpenSettings('ai')}>설정 › AI 열기</button>}
              </div>
            )}
            {ai.status === 'error' && (
              <div className="fsum-ai fsum-ai-error" role="alert">
                <p>{ai.error}</p>
                <button type="button" className="btn-filter-sm" onClick={runAI}>다시 시도</button>
              </div>
            )}
            {ai.status === 'done' && (
              <div className="fsum-ai">
                <p className="fsum-ai-headline">{ai.result.headline}</p>
                {ai.result.points.length > 0 && (
                  <ul className="fsum-ai-points">
                    {ai.result.points.map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                )}
                {ai.result.tip && <p className="fsum-ai-tip">💡 {ai.result.tip}</p>}
                <p className="fsum-ai-note">
                  AI가 위 숫자(합계 수준만 보냄)를 바탕으로 쓴 문장이에요. 숫자는 위 리포트가 기준입니다.{ai.modelNote ? ` ${ai.modelNote}` : ''}
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
