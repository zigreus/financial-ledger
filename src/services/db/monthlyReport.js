// 월간 리포트 (I-028, ROADMAP C-9) — 선택 기능: 설정에서 켜야 화면에 보인다(가족 공통 설정).
//
// 한 달을 규칙으로 정리한다(AI는 문장 다듬기에만, services/monthlyReportAI.js).
//  - 순지출 합계 = amount - discount_amount (AGENTS §4) — 요약의 '총액'과 같다.
//  - 비교 기준: 앞 세 달 중 거래가 있는 달만으로 낸 평균(가계부를 쓰기 전 달을 0원으로 치지 않게).
//    가계부를 달 중간(8일 이후)에 쓰기 시작한 첫 달은 며칠 치뿐이라 비교에서 뺀다.
//    평균은 0 아래로 내려가지 않는다(앞 달에 환불만 있던 카테고리).
//  - 카테고리마다 그 평균보다 크게 늘거나 줄었으면 알린다 — 차이가 3만 원 이상이면서 평균의 30% 이상일 때.
//    늘었다는 이 달에 쓴 돈이 있을 때만(평균이 0이면 '새 지출'), 줄었다는 앞 달 중 두 달 이상(앞 달이 한 달뿐이면 그 달) 쓴
//    카테고리만 — 한 번뿐인 큰 지출(여행 등) 뒤 석 달 내내 '줄었다'고 하지 않게.
//    진행 중인 달(이번 달)은 아직 덜 썼으므로 '줄었다'는 알리지 않는다.
//  - 가장 큰 지출 3건: 분할 결제는 몫을 합쳐 한 건으로 본다. 진행 중인 달은 오늘 뒤의 미리 등록된 거래(정기지출)를 뺀다.
//  - 무지출일: 순지출이 있는 거래가 하나도 없는 날. 이번 달은 오늘까지, 첫 달은 쓰기 시작한 날부터 센다.
//  - 목표·예산: 월 목표금액이 있으면 달성 여부(진행 중이면 지금까지), 카테고리별 예산(I-025)을 켰으면 넘은·주의 카테고리,
//    수입·월 수지(I-026)를 켰으면 수입·남은 돈·저축률.
// 거래 표에는 인덱스가 없어, 달 조건은 strftime 대신 날짜 범위(date >= 첫날 AND date < 다음 달 첫날)로 쓴다.

import { getSetting, setSetting, getEffectiveMonthlyGoal } from './settings';
import { isCategoryBudgetEnabled, getCategoryBudgetStatus } from './categoryBudgets';
import { isMonthlyBalanceEnabled, getMonthlyBalance } from './monthlyBalance';
import { addMonths, todayStr } from '../dateUtils';

export const MONTHLY_REPORT_SETTING = 'monthly_report_enabled';
export const REPORT_AVG_MONTHS = 3;
export const REPORT_CHANGE_MIN = 30000;
export const REPORT_CHANGE_RATIO = 0.3;
/** 가계부를 그 달 이 날 뒤에 쓰기 시작했으면 그 달은 며칠 치뿐인 첫 달로 본다 */
export const REPORT_PARTIAL_START_DAY = 7;

const NO_CATEGORY = '(카테고리 없음)';

export function isMonthlyReportEnabled(db) {
  return !!db && getSetting(db, MONTHLY_REPORT_SETTING, '0') === '1';
}

export function setMonthlyReportEnabled(db, enabled) {
  setSetting(db, MONTHLY_REPORT_SETTING, enabled ? '1' : '0');
}

const first = ym => `${ym}-01`;
const scalar = (db, sql, params) => db.exec(sql, params)[0]?.values[0]?.[0];
const netOf = r => (Number(r.amount) || 0) - (Number(r.discount_amount) || 0);

/** 리포트를 볼 수 있는 달 — 거래가 있는 달 중 이번 달까지(새 것부터) */
export function getReportMonths(db, today = todayStr()) {
  const res = db.exec(
    'SELECT DISTINCT substr(date, 1, 7) AS m FROM transactions WHERE date < ? ORDER BY m DESC',
    [first(addMonths(today.slice(0, 7), 1))],
  );
  return res.length ? res[0].values.map(r => r[0]) : [];
}

/** 가계부의 첫 거래 날짜(오늘까지 — 앞날짜로 미리 넣은 거래는 시작으로 보지 않는다) — 없으면 null */
function ledgerStart(db, today) {
  return scalar(db, 'SELECT MIN(date) FROM transactions WHERE date <= ?', [today]) || null;
}

/** 그 달이 가계부를 달 중간에 쓰기 시작한 첫 달이면 시작한 날('YYYY-MM-DD'), 아니면 null */
function partialStartIn(start, ym) {
  return start && start.slice(0, 7) === ym && Number(start.slice(8, 10)) > REPORT_PARTIAL_START_DAY ? start : null;
}

function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/**
 * 앞 세 달(거래가 있고 며칠 치뿐인 첫 달이 아닌 달)의 달별·카테고리별 순지출 — 한 번의 GROUP BY로
 * { months: ['YYYY-MM'..], total: 평균, cats: Map(이름 → { avg, spentMonths }) }
 */
function previousMonths(db, ym, start) {
  const rows = db.exec(
    `SELECT substr(date, 1, 7) AS m, COALESCE(NULLIF(budget_category, ''), ?) AS c,
            COALESCE(SUM(amount), 0) - COALESCE(SUM(discount_amount), 0) AS t
     FROM transactions WHERE date >= ? AND date < ?
     GROUP BY m, c`,
    [NO_CATEGORY, first(addMonths(ym, -REPORT_AVG_MONTHS)), first(ym)],
  )[0]?.values || [];
  const months = [...new Set(rows.map(r => r[0]))].filter(m => !partialStartIn(start, m)).sort();
  const n = months.length;
  const cats = new Map();
  let sum = 0;
  rows.forEach(([m, c, t]) => {
    if (!months.includes(m)) return;
    const v = Number(t) || 0;
    sum += v;
    const g = cats.get(c) || { sum: 0, spentMonths: 0 };
    g.sum += v;
    if (v > 0) g.spentMonths += 1;
    cats.set(c, g);
  });
  const avgCats = new Map([...cats].map(([c, g]) => [c, { avg: n ? Math.max(0, Math.round(g.sum / n)) : 0, spentMonths: g.spentMonths }]));
  return { months, total: n ? Math.max(0, Math.round(sum / n)) : 0, cats: avgCats };
}

const monthTotals = (db, ym) => {
  const [amount, discount, count] = db.exec(
    'SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(discount_amount), 0), COUNT(*) FROM transactions WHERE date >= ? AND date < ?',
    [first(ym), first(addMonths(ym, 1))],
  )[0].values[0];
  return { total: (Number(amount) || 0) - (Number(discount) || 0), discount: Number(discount) || 0, count: Number(count) || 0 };
};

/**
 * 알림용 가벼운 요약 — { month, total, count, avg: { months, total } | null } (getMonthlyReport와 같은 값)
 */
export function getMonthlyReportHeadline(db, ym, today = todayStr()) {
  const { total, count } = monthTotals(db, ym);
  if (!count) return { month: ym, total, count, avg: null };
  const prev = previousMonths(db, ym, ledgerStart(db, today));
  return { month: ym, total, count, avg: prev.months.length ? { months: prev.months, total: prev.total } : null };
}

const isSignificant = (diff, avg) => Math.abs(diff) >= REPORT_CHANGE_MIN && (avg <= 0 || Math.abs(diff) >= avg * REPORT_CHANGE_RATIO);

/**
 * 그 달 리포트
 * {
 *   month, inProgress, total, discount, count,
 *   upcoming: 진행 중인 달의 오늘 뒤(미리 등록된) 순지출 — 합계에 들어 있다,
 *   partialFrom: 가계부를 그 달 중간에 쓰기 시작했으면 그 날('YYYY-MM-DD'), 아니면 null,
 *   avg: { months: ['YYYY-MM'..], total } | null — 비교할 앞 달이 없으면 null,
 *   categories: [{ name, total, avg, diff }] (이 달 많이 쓴 순, 이 달 0원이어도 평균이 있으면 포함),
 *   rises, drops: 크게 늘거나 줄어든 카테고리(차이가 큰 순, 3개까지) — avg가 없으면 빈 배열,
 *   biggest: [{ date, detail, category, amount, split }] 3건,
 *   noSpend: { days, of, prevDays, prevOf } — 지난달을 비교할 수 없으면 prevDays·prevOf가 null,
 *   goal: { amount, spent, ratio, over, achieved } | null — 진행 중이면 achieved는 null(넘었으면 over),
 *   budgets: { over: [..], warn: [..], okCount } | null (카테고리별 예산을 켰고 예산이 있을 때),
 *   balance: getMonthlyBalance 결과 | null (수입·월 수지를 켰을 때)
 * }
 */
export function getMonthlyReport(db, ym, today = todayStr()) {
  const thisMonth = today.slice(0, 7);
  const inProgress = ym === thisMonth;
  const start = ledgerStart(db, today);
  const partialFrom = partialStartIn(start, ym);

  const rows = db.exec(
    `SELECT id, date, detail, budget_category, amount, discount_amount, COALESCE(split_group_id, '') AS split_group_id
     FROM transactions WHERE date >= ? AND date < ?
     ORDER BY date, id`,
    [first(ym), first(addMonths(ym, 1))],
  )[0]?.values.map(([id, date, detail, category, amount, discount, split]) => ({
    id, date, detail, category: category || '', amount, discount_amount: discount, split,
  })) || [];

  let total = 0;
  let discount = 0;
  let upcoming = 0;
  const cur = new Map();
  rows.forEach(r => {
    const v = netOf(r);
    total += v;
    discount += Number(r.discount_amount) || 0;
    if (inProgress && r.date > today) upcoming += v;
    const c = r.category || NO_CATEGORY;
    cur.set(c, (cur.get(c) || 0) + v);
  });

  const prev = previousMonths(db, ym, start);
  const n = prev.months.length;
  const avg = n ? { months: prev.months, total: prev.total } : null;

  const names = new Set([...cur.keys(), ...prev.cats.keys()]);
  const categories = [...names]
    .map(name => {
      const t = cur.get(name) || 0;
      const a = prev.cats.get(name)?.avg || 0;
      return { name, total: t, avg: a, diff: t - a };
    })
    .filter(c => c.total !== 0 || c.avg !== 0)
    .sort((a, b) => b.total - a.total || b.avg - a.avg || a.name.localeCompare(b.name));

  const byDiff = (a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.name.localeCompare(b.name);
  const rises = avg
    ? categories.filter(c => c.total > 0 && c.diff > 0 && isSignificant(c.diff, c.avg)).sort(byDiff).slice(0, 3)
    : [];
  const drops = avg && !inProgress
    ? categories.filter(c => c.avg > 0 && c.diff < 0 && isSignificant(c.diff, c.avg)
      && (prev.cats.get(c.name)?.spentMonths || 0) >= Math.min(2, n)).sort(byDiff).slice(0, 3)
    : [];

  // 가장 큰 지출 3건 — 분할 결제는 몫을 합친다. 진행 중인 달은 오늘 뒤(미리 등록된) 거래를 뺀다
  const groups = new Map();
  rows.forEach(r => {
    if (inProgress && r.date > today) return;
    const key = r.split ? `g:${r.split}` : `t:${r.id}`;
    const g = groups.get(key);
    if (g) {
      g.amount += netOf(r);
      g.split = true;
    } else {
      groups.set(key, { date: r.date, detail: String(r.detail || '').trim(), category: r.category, amount: netOf(r), split: false });
    }
  });
  const biggest = [...groups.values()]
    .filter(g => g.amount > 0)
    .sort((a, b) => b.amount - a.amount || b.date.localeCompare(a.date))
    .slice(0, 3);

  // 무지출일 — 순지출이 있는 거래가 없는 날 (이번 달은 오늘까지, 첫 달은 시작한 날부터)
  const fromDay = partialFrom ? Number(partialFrom.slice(8, 10)) : 1;
  const toDay = inProgress ? Number(today.slice(8, 10)) : (ym > thisMonth ? 0 : daysInMonth(ym));
  const spendDays = new Set(rows
    .filter(r => netOf(r) > 0)
    .map(r => Number(r.date.slice(8, 10)))
    .filter(d => d >= fromDay && d <= toDay));
  const of = Math.max(0, toDay - fromDay + 1);
  const prevMonth = addMonths(ym, -1);
  let prevDays = null;
  let prevOf = null;
  if (prev.months.includes(prevMonth)) {
    prevOf = daysInMonth(prevMonth);
    const spent = Number(scalar(db,
      `SELECT COUNT(DISTINCT date) FROM transactions
       WHERE date >= ? AND date < ? AND amount - COALESCE(discount_amount, 0) > 0`,
      [first(prevMonth), first(ym)])) || 0;
    prevDays = Math.max(0, prevOf - spent);
  }
  const noSpend = { days: Math.max(0, of - spendDays.size), of, prevDays, prevOf };

  const goalAmount = Number(getEffectiveMonthlyGoal(db, ym));
  const goal = goalAmount > 0
    ? {
      amount: goalAmount, spent: total, ratio: total / goalAmount,
      over: total > goalAmount, achieved: inProgress ? null : total <= goalAmount,
    }
    : null;

  let budgets = null;
  if (isCategoryBudgetEnabled(db)) {
    const status = getCategoryBudgetStatus(db, ym);
    if (status.length) {
      budgets = {
        over: status.filter(s => s.level === 'over'),
        warn: status.filter(s => s.level === 'warn'),
        okCount: status.filter(s => s.level === 'ok').length,
      };
    }
  }

  const balance = isMonthlyBalanceEnabled(db) ? getMonthlyBalance(db, ym, today) : null;

  return {
    month: ym, inProgress, total, discount, count: rows.length, upcoming, partialFrom,
    avg, categories, rises, drops, biggest, noSpend, goal, budgets, balance,
  };
}

/**
 * 진행 중인 달의 목표·예산 비율 앞에 붙이는 말 — 합계에는 오늘 뒤 미리 등록된 거래도 들어 있어,
 * 그런 거래가 있으면 '예정 포함', 없으면 '지금까지'. 끝난 달은 ''.
 */
export function reportSoFarLabel(report) {
  if (!report?.inProgress) return '';
  return report.upcoming ? '예정 포함 ' : '지금까지 ';
}

/** '앞 3개월 평균' / '지난달' / '9월' — 리포트·알림 문구에서 비교 기준을 부르는 말 */
export function reportAvgLabel(report) {
  const months = report?.avg?.months || [];
  if (months.length !== 1) return `앞 ${months.length}개월 평균`;
  return months[0] === addMonths(report.month, -1) ? '지난달' : `${Number(months[0].slice(5, 7))}월`;
}
