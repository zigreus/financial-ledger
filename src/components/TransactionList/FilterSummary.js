import React, { useEffect, useMemo, useRef, useState } from 'react';
import { activeAI } from '../../services/aiClient';
import { formatAmount } from '../../services/formulaEvaluator';
import { summarizeTransactions, summarizeWithAI, shareOf } from '../../services/txSummary';
import { categoryColor } from '../common/categoryColor';

const won = n => `${formatAmount(n)}원`;

/**
 * 걸러진 거래의 요약 (ROADMAP C-7, I-021) — 필터나 검색어를 걸었을 때 목록 위에 보인다.
 *  - 건수·순지출 합계(월 머리말과 같은 계산), '구성 보기'로 카테고리·많이 쓴 곳 상위 5
 *  - '✨ AI 요약': 집계만 보내 문장으로 요약한다. 필터나 가계부가 바뀌면 받던 요약을 버리고 다시 받게 한다(AGENTS §6)
 * filterKey: 걸어 둔 조건을 나타내는 값 — 조건이나 걸러진 결과가 바뀌면 요약을 새로 받아야 한다
 */
export default function FilterSummary({ transactions, filterText, filterKey, onOpenSettings }) {
  const stats = useMemo(() => summarizeTransactions(transactions), [transactions]);
  const [open, setOpen] = useState(false);
  const [ai, setAi] = useState({ status: 'idle' }); // idle | needKey | loading | done | error
  const abortRef = useRef(null);

  // 조건이나 걸러진 결과(집계)가 바뀌면 받던 요약을 버린다 — 늦게 온 답이 다른 결과의 요약으로 보이지 않게.
  // 상관없는 거래를 고치거나 다른 기기 변경이 합쳐져도 이 결과가 그대로면 요약을 그대로 둔다(AI 호출은 과금될 수 있다)
  const resetKey = useMemo(() => `${filterKey}|${JSON.stringify(stats)}`, [filterKey, stats]);
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
      const result = await summarizeWithAI({
        ai: config, stats, filterText, signal: controller.signal,
        onProgress: (msg, info) => {
          if (controller.signal.aborted) return;
          if (info?.modelUsed) {
            if (info.modelUsed !== config.model) setAi(s => ({ ...s, modelNote: `${config.model}이(가) 붐벼서 ${info.modelUsed}(으)로 요약했습니다` }));
          } else {
            setAi(s => ({ ...s, progress: msg }));
          }
        },
      });
      if (controller.signal.aborted) return;
      setAi(s => ({ status: 'done', result, modelNote: s.modelNote }));
    } catch (e) {
      if (controller.signal.aborted || e.name === 'AbortError') return; // 취소는 오류가 아니다
      setAi({ status: 'error', error: e.message || '요약하지 못했습니다' });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };
  const cancelAI = () => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = null;
    setAi({ status: 'idle' });
  };

  const topCategories = stats.categories.slice(0, 5);
  const topDetails = stats.details.slice(0, 5);

  return (
    <div className="fsum">
      <div className="fsum-head">
        <div className="fsum-totals">
          <strong>{stats.count}건 · {won(stats.total)}</strong>
          <span className="fsum-filter">{filterText}</span>
        </div>
        <div className="fsum-actions">
          <button type="button" className="btn-filter-sm" aria-expanded={open} onClick={() => setOpen(v => !v)}>
            구성 {open ? '닫기' : '보기'}
          </button>
          {ai.status !== 'loading' && (
            <button type="button" className="btn-filter-sm fsum-ai-btn" onClick={runAI}>
              ✨ {ai.status === 'done' ? '다시 요약' : 'AI 요약'}
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="fsum-breakdown">
          <div className="fsum-col">
            <span className="fsum-col-title">카테고리</span>
            {topCategories.map(c => {
              const share = shareOf(c.total, stats.total);
              return (
                <div key={c.name} className="fsum-bar-row">
                  <span className="fsum-bar-label">{c.name}</span>
                  <span className="fsum-bar-track">
                    <span className="fsum-bar" style={{ width: `${Math.max(share || 0, 2)}%`, background: categoryColor(c.name) }} />
                  </span>
                  <span className="fsum-bar-value">{won(c.total)}{share !== null ? ` · ${share}%` : ''}</span>
                </div>
              );
            })}
          </div>
          {topDetails.length > 0 && (
            <div className="fsum-col">
              <span className="fsum-col-title">많이 쓴 곳</span>
              {topDetails.map(d => (
                <div key={d.name} className="fsum-detail-row">
                  <span className="fsum-detail-name">{d.name}</span>
                  <span className="fsum-bar-value">{won(d.total)} · {d.count}건</span>
                </div>
              ))}
            </div>
          )}
          {stats.months.length > 1 && (
            <div className="fsum-col">
              <span className="fsum-col-title">월별</span>
              {stats.months.slice(-6).map(m => (
                <div key={m.name} className="fsum-detail-row">
                  <span className="fsum-detail-name">{m.name}</span>
                  <span className="fsum-bar-value">{won(m.total)} · {m.count}건</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {ai.status === 'loading' && (
        <div className="fsum-ai fsum-ai-loading" role="status">
          <span>AI가 요약하는 중…{ai.progress ? ` ${ai.progress}` : ''}</span>
          <button type="button" className="btn-filter-sm btn-filter-cancel" onClick={cancelAI}>취소</button>
        </div>
      )}
      {ai.status === 'needKey' && (
        <div className="fsum-ai">
          <p>AI 요약을 보려면 AI 키를 먼저 설정해 주세요. 합계·구성은 키 없이도 볼 수 있어요.</p>
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
            AI가 위 합계를 바탕으로 쓴 요약이에요. 숫자는 위 합계·구성이 기준입니다.{ai.modelNote ? ` ${ai.modelNote}` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
