/**
 * 월간 리포트 AI 한마디 (I-028, ROADMAP C-9) — 숫자는 규칙으로 계산하고(db/monthlyReport.js), AI는 문장만 다듬는다.
 *
 * 보내는 것(AGENTS §7 — 필요한 만큼만): 달·진행 여부·가계부를 쓰기 시작한 날(그 달이 첫 달일 때), 순지출 합계·건수·예정 거래 합계,
 * 비교한 앞 달 평균, 카테고리 이름과 합계·평균(상위 8개), 크게 늘거나 줄어든 카테고리,
 * 가장 큰 지출 3건의 카테고리·금액(가게·메모 같은 내용은 보내지 않음), 무지출일,
 * 월 목표(이 기기에서 목표금액을 보일 때)·카테고리 예산 결과, 수입·남은 돈·저축률(켰을 때).
 * 화면은 AI 문장과 별도로 계산한 숫자를 함께 보여, AI가 숫자를 틀려도 기준이 남는다.
 */
import { analyzeWithAI } from './aiClient';
import { formatAmount } from './formulaEvaluator';
import { reportAvgLabel, reportSoFarLabel } from './dbManager';

const won = n => `${formatAmount(Math.round(n))}원`;
const TOP_CATEGORIES = 8;

function clip(s, n) {
  const t = typeof s === 'string' ? s.trim() : '';
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * AI 지시문 — 리포트의 집계 숫자만 담는다.
 * showGoal: 이 기기에서 월 목표금액을 보이는지 — 끈 기기에서는 목표를 보내지 않는다(화면에 없는 목표를 AI가 말하지 않게)
 */
export function buildReportPrompt(report, { showGoal = true } = {}) {
  const r = report;
  const sofarWord = reportSoFarLabel(r).trim();                        // '지금까지' / '예정 포함' / ''
  const goalLine = () => {
    if (!r.goal || !showGoal) return '';
    const pct = Math.round(r.goal.ratio * 100);
    if (r.goal.over) {
      return `월 목표 ${won(r.goal.amount)} — ${r.inProgress ? `진행 중이라 ${sofarWord} ` : ''}${won(r.goal.spent - r.goal.amount)} 넘음`;
    }
    return r.inProgress
      ? `월 목표 ${won(r.goal.amount)} — 진행 중, ${sofarWord} ${pct}% 씀(남은 ${won(r.goal.amount - r.goal.spent)}), 달성 여부는 아직 모름`
      : `월 목표 ${won(r.goal.amount)} — 지킴(${pct}% 씀)`;
  };
  const rows = [
    `달: ${r.month}${r.inProgress ? ' (진행 중 — 아직 끝나지 않은 달)' : ''}${r.partialFrom ? ` (가계부를 ${r.partialFrom}부터 씀)` : ''}`,
    `순지출 합계 ${won(r.total)} · 거래 ${r.count}건${r.discount > 0 ? ` · 할인 ${won(r.discount)}` : ''}`
      + `${r.upcoming ? ` · 이 중 오늘 뒤 미리 등록된 예정 ${won(r.upcoming)}` : ''}`,
    r.avg
      ? `비교 기준: ${reportAvgLabel(r)} ${won(r.avg.total)} (${r.avg.months.join(', ')})`
      : '비교할 앞 달 기록 없음',
    `카테고리(많은 순): ${r.categories.slice(0, TOP_CATEGORIES)
      .map(c => `${clip(c.name, 20)} ${won(c.total)}${r.avg ? `(평균 ${won(c.avg)})` : ''}`).join(' | ')}`,
    r.rises.length ? `평균보다 크게 늘어난 카테고리: ${r.rises.map(c => `${clip(c.name, 20)} ${won(c.total)}(평균 ${won(c.avg)})`).join(' | ')}` : '',
    r.drops.length ? `평균보다 크게 줄어든 카테고리: ${r.drops.map(c => `${clip(c.name, 20)} ${won(c.total)}(평균 ${won(c.avg)})`).join(' | ')}` : '',
    r.biggest.length ? `가장 큰 지출: ${r.biggest.map(b => `${clip(b.category, 20) || '카테고리 없음'} ${won(b.amount)}`).join(' | ')}` : '',
    `무지출일: ${r.noSpend.days}일/${r.noSpend.of}일${r.noSpend.prevDays !== null ? ` (지난달 ${r.noSpend.prevDays}일/${r.noSpend.prevOf}일)` : ''}`,
    goalLine(),
    r.budgets
      ? `카테고리 예산${r.inProgress ? `(진행 중, ${sofarWord})` : ''}: 넘음 ${r.budgets.over.map(b => `${clip(b.category, 20)}(예산 ${won(b.budget)}, 씀 ${won(b.spent)})`).join(', ') || '없음'}`
        + ` · 80% 이상 ${r.budgets.warn.map(b => clip(b.category, 20)).join(', ') || '없음'}`
        + ` · 80% 안 ${r.budgets.okCount}개${r.inProgress ? '(달이 끝나지 않아 지켰는지는 아직 모름)' : ''}`
      : '',
    r.balance
      ? `수입 ${won(r.balance.income)} · 남은 돈 ${won(r.balance.left)}${r.balance.rate !== null ? ` · 저축률 ${Math.round(r.balance.rate * 100)}%` : ''}`
      : '',
  ];
  return rows.filter(Boolean).join('\n');
}

const SYSTEM = [
  '당신은 가족이 함께 쓰는 가계부의 월간 리포트 도우미입니다.',
  '한 달의 집계를 받아, 이 집계만 근거로 한국어 존댓말로 짧게 정리합니다.',
  '- 숫자는 주어진 값을 그대로 인용하세요. 새로 계산하거나 짐작한 숫자를 쓰지 마세요.',
  '- headline: 이 달을 한 문장으로(평균과 견주어 많이·적게 썼는지 등).',
  '- points: 눈에 띄는 점 2~4개(크게 늘거나 줄어든 카테고리, 큰 지출, 무지출일, 목표·예산 결과 등). 한 문장씩 짧게.',
  "- '진행 중'인 달은 아직 끝나지 않았습니다. 평균보다 적다고 아꼈다고, 목표·예산을 지켰다고 단정하지 마세요.",
  '- tip: 다음 달에 해 볼 만한 것이 분명하면 한 문장, 아니면 빈 문자열. 비난하거나 단정하지 마세요.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: '이 달 한 문장 요약' },
    points: { type: 'array', items: { type: 'string' }, description: '눈에 띄는 점 2~4개' },
    tip: { type: 'string', description: '다음 달 제안 한 문장 또는 빈 문자열' },
  },
  required: ['headline', 'points'],
};

/** AI가 쓴 한마디 { headline, points, tip } — 거래가 없는 달은 부르지 않는다(오류) */
export async function polishReportWithAI({ ai, report, showGoal = true, signal, onProgress }) {
  if (!report || !report.count) throw new Error('정리할 거래가 없습니다');
  const raw = await analyzeWithAI({
    ai, system: SYSTEM, prompt: buildReportPrompt(report, { showGoal }), schema: SCHEMA,
    toolName: 'write_monthly_report', description: '가계부 한 달 집계를 사람이 읽는 짧은 리포트 문장으로 정리한다',
    maxTokens: 800, signal, onProgress,
  });
  const headline = clip(raw?.headline, 200);
  const points = (Array.isArray(raw?.points) ? raw.points : []).map(p => clip(p, 200)).filter(Boolean).slice(0, 5);
  if (!headline && !points.length) throw new Error('AI가 리포트 문장을 만들지 못했습니다 — 다시 시도해 주세요');
  return { headline, points, tip: clip(raw?.tip, 200) };
}
