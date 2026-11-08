/**
 * 걸러진 거래 요약 (ROADMAP C-7, I-021) — 합계·구성은 규칙으로 계산하고, 사람이 읽는 요약 문장만 AI가 쓴다.
 *
 *  - summarizeTransactions: 건수·순지출 합계·평균, 월별·카테고리별·결제수단별·구성원별, 많이 쓴 내용, 가장 큰 지출 3건
 *    (순지출 = amount - discount_amount, 월 머리말의 합계와 같은 값 — AGENTS §4)
 *  - summarizeWithAI: 위 집계를 보낸다(AGENTS §7 — 필요한 만큼만). 보내는 것: 조건(검색어 포함), 합계·평균, 월별·카테고리
 *    (세부 상위 3)·결제수단별, 구성원별(2명 이상일 때), 많이 쓴 내용 상위 10(30자까지), 가장 큰 지출 3건(달·내용·금액).
 *    결과가 몇 건뿐이면 그 거래들의 내용·금액이 사실상 전해진다 — SETUP.md에 같은 범위를 적어 두었다.
 *    화면은 AI 문장과 별도로 계산한 숫자를 함께 보여, AI가 숫자를 틀려도 기준이 남는다
 */
import { analyzeWithAI } from './aiClient';
import { formatAmount } from './formulaEvaluator';
import { todayStr } from './dateUtils';

const net = t => (Number(t.amount) || 0) - (Number(t.discount_amount) || 0);
const NO_MEMBER = '(누가 없음)';
const won = n => `${formatAmount(n)}원`;

function grouped(txs, keyOf) {
  const map = new Map();
  txs.forEach(t => {
    const key = keyOf(t);
    if (key === null) return;
    const g = map.get(key) || { name: key, total: 0, count: 0 };
    g.total += net(t);
    g.count += 1;
    map.set(key, g);
  });
  return [...map.values()];
}
const byTotalDesc = (a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name);

/** 걸러진 거래의 집계 */
export function summarizeTransactions(txs) {
  const list = Array.isArray(txs) ? txs : [];
  const total = list.reduce((s, t) => s + net(t), 0);
  const discount = list.reduce((s, t) => s + (Number(t.discount_amount) || 0), 0);
  const dates = list.map(t => t.date).filter(Boolean).sort();

  const categories = grouped(list, t => t.budget_category || '(카테고리 없음)').sort(byTotalDesc).map(c => ({
    ...c,
    subs: grouped(list.filter(t => (t.budget_category || '(카테고리 없음)') === c.name), t => t.sub_category || '(세부 없음)')
      .sort(byTotalDesc),
  }));

  return {
    count: list.length,
    total,
    discount,
    average: list.length ? Math.round(total / list.length) : 0,
    dateFrom: dates[0] || '',
    dateTo: dates[dates.length - 1] || '',
    months: grouped(list, t => (t.date || '').slice(0, 7) || null).sort((a, b) => a.name.localeCompare(b.name)),
    categories,
    paymentMethods: grouped(list, t => t.payment_method || '(결제수단 없음)').sort(byTotalDesc),
    members: list.some(t => t.member) ? grouped(list, t => t.member || NO_MEMBER).sort(byTotalDesc) : [],
    details: grouped(list, t => String(t.detail || '').trim() || null).sort(byTotalDesc),
    biggest: [...list].sort((a, b) => net(b) - net(a) || String(b.date).localeCompare(String(a.date))).slice(0, 3)
      .map(t => ({ date: t.date, detail: String(t.detail || '').trim(), category: t.budget_category, amount: net(t) })),
  };
}

/** 전체에서 차지하는 비율(%) — 합계가 0 이하면 null */
export function shareOf(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : null;
}

// AI에 보내는 항목 수·길이 — 요약에 필요한 만큼만
export const LIMITS = { months: 24, categories: 8, subs: 3, paymentMethods: 8, members: 6, details: 10, detailLength: 30 };

/**
 * AI 요약 지시문 — 집계 숫자만 담는다. today: 이번 달은 '진행 중', 앞으로의 달은 '예정 거래만'(정기지출 자동등록)으로 표시해
 * 덜 찬 달을 '크게 줄었다'고 해석하지 않게 한다.
 */
export function buildSummaryPrompt(stats, filterText, today = todayStr()) {
  const ym = today.slice(0, 7);
  const name = (s) => clip(s, LIMITS.detailLength);
  const line = (g) => `${name(g.name)} ${won(g.total)}(${g.count}건)`;
  const monthLine = (g) => `${line(g)}${g.name === ym ? ' (진행 중)' : g.name > ym ? ' (예정 거래만)' : ''}`;
  const rows = [
    `오늘: ${today}`,
    `조건: ${filterText}`,
    `거래 ${stats.count}건 · 순지출 합계 ${won(stats.total)} · 할인 합계 ${won(stats.discount)} · 한 건 평균 ${won(stats.average)}`,
    `월별: ${stats.months.slice(-LIMITS.months).map(monthLine).join(' | ')}`,
    `카테고리별(많은 순): ${stats.categories.slice(0, LIMITS.categories).map(c => {
      const share = shareOf(c.total, stats.total);
      const subs = c.subs.slice(0, LIMITS.subs).map(line).join(', ');
      return `${line(c)}${share !== null ? ` ${share}%` : ''} [${subs}]`;
    }).join(' | ')}`,
    `결제수단별: ${stats.paymentMethods.slice(0, LIMITS.paymentMethods).map(line).join(' | ')}`,
    // 한 사람만 걸러 봤거나 '누가'를 쓰지 않으면 보내지 않는다
    stats.members.filter(m => m.name !== NO_MEMBER).length >= 2 ? `누가 쓴 것: ${stats.members.slice(0, LIMITS.members).map(line).join(' | ')}` : '',
    stats.details.length ? `많이 쓴 내용(가게·메모, 많은 순): ${stats.details.slice(0, LIMITS.details).map(line).join(' | ')}` : '',
    `가장 큰 지출: ${stats.biggest.map(b => `${String(b.date || '').slice(0, 7)} ${name(b.detail || b.category)} ${won(b.amount)}`).join(' | ')}`,
  ];
  return rows.filter(Boolean).join('\n');
}

const SYSTEM = [
  '당신은 가족이 함께 쓰는 가계부의 요약 도우미입니다.',
  '사용자가 거래내역을 조건으로 걸러 본 결과의 집계를 받습니다. 이 집계만 근거로 한국어 존댓말 요약을 씁니다.',
  '- 숫자는 주어진 값을 그대로 인용하세요. 새로 계산하거나 짐작한 숫자를 쓰지 마세요.',
  '- headline: 무엇에 얼마를 썼는지 한 문장.',
  '- points: 눈에 띄는 점 2~4개(가장 큰 비중, 자주 쓴 곳, 월별 흐름, 특이하게 큰 지출 등). 한 문장씩 짧게.',
  "- '진행 중'인 달은 아직 끝나지 않았고 '예정 거래만'인 달은 미리 넣어 둔 정기지출뿐입니다. 이런 달을 다른 달과 비교해 늘었다·줄었다고 하지 마세요.",
  '- tip: 아낄 만한 곳이 분명하면 한 문장, 아니면 빈 문자열. 비난하거나 단정하지 마세요.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: '한 문장 요약' },
    points: { type: 'array', items: { type: 'string' }, description: '눈에 띄는 점 2~4개' },
    tip: { type: 'string', description: '아낄 만한 곳 한 문장 또는 빈 문자열' },
  },
  required: ['headline', 'points'],
};

/** 글자만 받아 앞뒤 공백을 지우고 n자로 자른다 — 글자가 아니면(객체 등) 빈 문자열 */
function clip(s, n) {
  const t = typeof s === 'string' ? s.trim() : '';
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * AI가 쓴 요약 { headline, points: [..], tip } — 집계만 보낸다.
 * 거래가 없으면 부르지 않는다(오류). 취소는 signal, 진행 문구는 onProgress(aiClient와 같음).
 */
export async function summarizeWithAI({ ai, stats, filterText, signal, onProgress, today = todayStr() }) {
  if (!stats || !stats.count) throw new Error('요약할 거래가 없습니다');
  const raw = await analyzeWithAI({
    ai, system: SYSTEM, prompt: buildSummaryPrompt(stats, filterText, today), schema: SCHEMA,
    toolName: 'summarize_spending', description: '걸러진 가계부 거래의 집계를 사람이 읽는 요약으로 정리한다',
    maxTokens: 800, signal, onProgress,
  });
  const headline = clip(raw?.headline, 200);
  const points = (Array.isArray(raw?.points) ? raw.points : []).map(p => clip(p, 200)).filter(Boolean).slice(0, 5);
  if (!headline && !points.length) throw new Error('AI가 요약을 만들지 못했습니다 — 다시 시도해 주세요');
  return { headline, points, tip: clip(raw?.tip, 200) };
}
