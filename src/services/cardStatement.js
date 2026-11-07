/**
 * 카드 결제 내역 대조 — 카드 앱 캡처·명세서 PDF를 AI로 읽어 가계부와 비교한다.
 *
 *   일치          : 금액이 같고 날짜가 ±3일 안 (한 건은 한 건하고만 짝지음)
 *   일치(묶음)    : 같은 가게·±1일에서 여러 건의 합이 같음 — 데이터는 고치지 않는다
 *                   · 나눠 적음: 카드 1건 = 가계부 여러 건 (카테고리별로 나눠 적은 경우)
 *                   · 합쳐 적음: 카드 여러 건 = 가계부 1건
 *   금액 차이     : 날짜·가게는 맞는데 금액이 다름 → 가계부가 1건일 때만 카드 금액으로 수정 가능
 *   가계부에 없음 : 카드에만 있음 → 분류를 추천해 바로 추가
 *   카드에 없음   : 그 기간 이 결제수단으로 적었는데 카드에 없음 → 결제수단 확인 필요
 *   취소된 결제   : 카드에 승인과 취소가 함께 있음 → 가계부에 승인만 남아 있으면 알림
 *
 * 비교는 AI 없이 로컬에서 한다 — 추가·수정 후 다시 계산하면 바로 반영된다.
 */
import { analyzeWithAI, AIError } from './aiClient';
import {
  buildDataContext, classify, findTrip, normalizeName, matchHistory, suggestionToTransaction,
} from './receiptAssistant';
import { addTransaction, withTransaction } from './dbManager';
import { todayStr, addDays, isValidDateStr, parseDateStr } from './dateUtils';

export const TOLERANCE_DAYS = 3;
/** 묶음 일치는 같은 가게·이 날짜 차이 안에서만, 이 건수까지만 본다 (아무 금액이나 더해 맞추는 오탐 방지) */
export const GROUP_DAYS = 1;
export const GROUP_MAX = 4;

const SCHEMA = {
  type: 'object',
  properties: {
    is_card_statement: { type: 'boolean', description: '카드 결제(승인) 내역이나 명세서이면 true' },
    card_name: { type: 'string', description: '보이는 카드 이름. 없으면 빈 문자열' },
    period_from: { type: 'string', description: '내역 기간 시작 YYYY-MM-DD. 안 보이면 빈 문자열' },
    period_to: { type: 'string', description: '내역 기간 끝 YYYY-MM-DD. 안 보이면 빈 문자열' },
    rows: {
      type: 'array',
      description: '결제·취소 건 (같은 건은 한 번만)',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '결제일 YYYY-MM-DD' },
          merchant: { type: 'string', description: '가맹점명 (보이는 그대로)' },
          amount: { type: 'number', description: '원화 결제 금액. 취소·환불은 음수' },
          is_cancel: { type: 'boolean', description: '취소·환불 건이면 true' },
          currency: { type: 'string', description: '해외결제면 현지 통화 코드, 아니면 KRW' },
          foreign_amount: { type: 'number', description: '해외결제 현지 금액, 아니면 0' },
          installment: { type: 'string', description: '할부 표시 (예: 3개월). 일시불이면 빈 문자열' },
          category: { type: 'string', description: '"카테고리 > 세부카테고리" 목록 중 하나, 애매하면 "모름"' },
          detail: { type: 'string', description: '가계부 세부내역 추천 (입력 습관 표기 우선)' },
        },
        required: ['date', 'merchant', 'amount', 'is_cancel', 'currency', 'foreign_amount', 'installment', 'category', 'detail'],
      },
    },
    note: { type: 'string', description: '사용자에게 알릴 점 (잘린 화면, 흐린 부분 등). 없으면 빈 문자열' },
  },
  required: ['is_card_statement', 'card_name', 'period_from', 'period_to', 'rows', 'note'],
};

const SYSTEM = [
  '당신은 한국 가계부 앱의 카드 내역 정리 도우미입니다.',
  '카드 결제 내역·명세서에 실제로 보이는 결제 건만 빠짐없이, 중복 없이 옮겨 적습니다.',
  '분류는 주어진 목록 안에서 사용자의 입력 습관을 우선해 고릅니다.',
].join(' ');

export function buildStatementPrompt(db, paymentMethod, today = todayStr()) {
  return [
    buildDataContext(db, today).text,
    '',
    `[대조할 결제수단] ${paymentMethod}`,
    '',
    '첨부 파일은 이 카드의 결제(승인) 내역이나 명세서입니다.',
    '여러 장이면 한 목록을 이어 찍었거나 길게 잘라 보낸 것이라 겹치는 부분이 있습니다 — 같은 결제는 한 번만 적으세요.',
    '',
    '[규칙]',
    '- rows에는 실제 결제·취소 건만. 소계·합계·결제예정액·포인트·안내 문구는 제외.',
    '- amount는 원화 금액. 취소·환불은 음수로 적고 is_cancel=true.',
    '- 해외결제는 currency·foreign_amount에 현지 통화와 금액, amount에 원화 금액.',
    '- 할부는 결제한 총액을 amount에, installment에 "3개월" 같은 표시.',
    '- 날짜에 연도가 없으면 오늘 기준 가장 가까운 과거 날짜.',
    '- category·detail은 입력 습관에 같은 가게가 있으면 그 분류·표기를 따른다.',
  ].join('\n');
}

/** 파일들을 AI로 읽어 카드 결제 행 목록을 만든다 */
export async function analyzeStatement({ db, ai, files, paymentMethod, signal, today = todayStr() }) {
  const raw = await analyzeWithAI({
    ai, system: SYSTEM, prompt: buildStatementPrompt(db, paymentMethod, today), schema: SCHEMA,
    toolName: 'record_card_statement', description: '카드 결제 내역을 행 단위로 기록한다',
    files, signal, maxTokens: 16000,
  });
  if (raw && raw.is_card_statement === false) {
    throw new AIError('카드 결제 내역으로 보이지 않습니다 — 카드 앱의 이용내역이나 명세서를 올려 주세요', 'parse');
  }
  return normalizeStatement(raw || {}, today);
}

export function normalizeStatement(raw, today = todayStr()) {
  const rows = [];
  let unreadable = 0;
  (Array.isArray(raw.rows) ? raw.rows : []).forEach((r, i) => {
    const amount = Math.round(Number(r.amount) || 0);
    if (!amount) return;
    if (!isValidDateStr(r.date) || r.date > addDays(today, 1)) { unreadable += 1; return; }
    const currency = /^[A-Za-z]{3}$/.test(String(r.currency || '').trim()) ? String(r.currency).trim().toUpperCase() : 'KRW';
    rows.push({
      id: `r${i}`,
      date: r.date,
      merchant: String(r.merchant || '').trim(),
      amount,
      isCancel: !!r.is_cancel || amount < 0,
      currency,
      foreignAmount: currency !== 'KRW' && Number(r.foreign_amount) > 0 ? Math.round(Number(r.foreign_amount) * 100) / 100 : null,
      installment: String(r.installment || '').trim(),
      aiCategory: r.category,
      aiDetail: r.detail,
    });
  });
  return {
    cardName: String(raw.card_name || '').trim(),
    periodFrom: isValidDateStr(raw.period_from) ? raw.period_from : '',
    periodTo: isValidDateStr(raw.period_to) ? raw.period_to : '',
    rows,
    unreadable,
    note: String(raw.note || '').trim(),
  };
}

// ── 대조 ────────────────────────────────────────────────────────

function dayDiff(a, b) {
  return Math.round(Math.abs(parseDateStr(a) - parseDateStr(b)) / 86400000);
}

// 카드 가맹점명 앞뒤의 법인 표기는 비교에서 뺀다 — "(주)이마트 성수점" → "이마트성수점"
const merchantKey = s => normalizeName(String(s || '').replace(/\(주\)|㈜|주식회사|\(유\)|유한회사/g, ''));

/** 두 문자열에서 연속으로 같은 가장 긴 부분의 길이 */
function longestCommonRun(a, b) {
  let best = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      let k = 0;
      while (a[i + k] && a[i + k] === b[j + k]) k += 1;
      if (k > best) best = k;
    }
  }
  return best;
}

/**
 * 카드 가맹점명과 가계부 세부내역이 같은 곳을 가리키는지.
 * 가계부는 "이마트 장보기"처럼 설명을 덧붙여 적는 경우가 많아,
 * 한쪽이 다른 쪽을 포함하거나 3글자 이상 이어서 같으면 같은 곳으로 본다.
 * (2글자만 같은 건 인정하지 않는다 — 스타벅스/스타필드, 롯데마트/롯데리아)
 */
function sameMerchant(db, row, tx) {
  const m = merchantKey(row.merchant);
  const d = merchantKey(tx.detail);
  if (m.length >= 2 && d.length >= 2) {
    if (m.includes(d) || d.includes(m)) return true;
    if (longestCommonRun(m, d) >= 3) return true;
  }
  const hist = matchHistory(db, row.merchant);
  return !!(hist && tx.detail && hist.detail === tx.detail);
}

const gross = tx => Number(tx.amount) || 0;
const net = tx => gross(tx) - (Number(tx.discount_amount) || 0);

function amountMatches(row, tx) {
  return row.amount === gross(tx) || (net(tx) !== gross(tx) && row.amount === net(tx));
}

/**
 * items 중 2~GROUP_MAX개를 골라 value 합이 target인 조합 (건수가 적은 것 먼저).
 * 후보는 같은 가게·가까운 날짜로 이미 걸러져 있어 몇 개 안 된다.
 */
function findCombination(items, value, target) {
  const pool = items.slice(0, 10);
  for (let size = 2; size <= Math.min(GROUP_MAX, pool.length); size += 1) {
    const pick = [];
    const search = (start, sum) => {
      if (pick.length === size) return sum === target;
      for (let i = start; i < pool.length; i += 1) {
        pick.push(pool[i]);
        if (search(i + 1, sum + value(pool[i]))) return true;
        pick.pop();
      }
      return false;
    };
    if (search(0, 0)) return [...pick];
  }
  return null;
}

function ledgerFor(db, paymentMethod, from, to) {
  const res = db.exec(
    `SELECT * FROM transactions
     WHERE payment_method = ? AND date >= ? AND date <= ? AND COALESCE(is_cash_adjustment, 0) = 0
     ORDER BY date, id`,
    [paymentMethod, from, to]
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

/** 카드에만 있는 건을 가계부 추가용 추천으로 */
export function rowSuggestion(db, row, paymentMethod) {
  const trip = row.currency !== 'KRW' ? findTrip(db, row.currency, row.date) : null;
  const eventId = trip ? trip.ev.id : null;
  const cls = classify(db, {
    merchant: row.merchant, detail: row.aiDetail, aiCategory: row.aiCategory, eventId, readSource: 'statement',
  });
  const sources = { date: 'statement', payment_method: 'statement', ...cls.sources };
  if (eventId) sources.event = 'trip';
  return {
    date: row.date,
    merchant: row.merchant,
    detail: cls.detail + (row.isCancel && !/취소|환불/.test(cls.detail) ? ' (취소)' : ''),
    amount: row.amount,
    currency: row.currency,
    foreignAmount: row.foreignAmount,
    rate: trip ? Number(trip.country.exchange_rate) || 0 : 0,
    event_id: eventId,
    eventTitle: trip ? trip.ev.title : '',
    payment_method: paymentMethod,
    paymentHint: '',
    budget_category: cls.budget_category,
    sub_category: cls.sub_category,
    items: [],
    historyDetail: cls.history?.detail || '',
    historyCount: cls.history?.cnt || 0,
    confidence: 'high',
    warnings: [],
    sources,
  };
}

/**
 * 카드 행 목록과 가계부를 비교한다.
 * 반환: { period, matched, grouped, mismatched, missing, notOnCard, cancelled }
 *   grouped:    [{ kind: 'split' | 'merged', rows, txs }] — 나눠 적음 / 합쳐 적음 (일치로 본다)
 *   mismatched: [{ rows, txs, cardTotal, ledgerTotal }] — txs가 1건일 때만 자동 수정 가능
 */
export function reconcileStatement(db, { paymentMethod, rows, periodFrom, periodTo, toleranceDays = TOLERANCE_DAYS }) {
  const dates = rows.map(r => r.date).sort();
  const from = periodFrom || dates[0] || '';
  const to = periodTo || dates[dates.length - 1] || '';
  const empty = { period: { from, to }, matched: [], grouped: [], mismatched: [], missing: [], notOnCard: [], cancelled: [] };
  if (!from || !to) return empty;

  // 1) 카드 안에서 승인·취소 짝 — 가계부에 둘 다 없으면 서로 상쇄되므로 비교에서 뺀다
  const pairedApproval = new Map();   // approval row id → cancel row
  const pairedCancel = new Set();
  rows.filter(r => r.isCancel).forEach(c => {
    const a = rows.find(r => !r.isCancel && !pairedApproval.has(r.id) && r.amount === -c.amount && r.date <= c.date
      && (normalizeName(r.merchant) === normalizeName(c.merchant)
        || normalizeName(r.merchant).includes(normalizeName(c.merchant))
        || normalizeName(c.merchant).includes(normalizeName(r.merchant))));
    if (a) { pairedApproval.set(a.id, c); pairedCancel.add(c.id); }
  });
  const comparable = rows.filter(r => !pairedCancel.has(r.id));

  // 2) 같은 금액·±N일 후보를 점수 순으로 1:1 짝짓기
  const ledger = ledgerFor(db, paymentMethod, addDays(from, -toleranceDays), addDays(to, toleranceDays));
  const candidates = [];
  comparable.forEach(row => {
    ledger.forEach(tx => {
      if (!amountMatches(row, tx)) return;
      const dd = dayDiff(row.date, tx.date);
      if (dd > toleranceDays) return;
      candidates.push({ row, tx, dd, score: 1000 - dd * 100 + (sameMerchant(db, row, tx) ? 50 : 0) });
    });
  });
  candidates.sort((a, b) => b.score - a.score);

  const usedRows = new Set();
  const usedTx = new Set();
  const matched = [];
  candidates.forEach(c => {
    if (usedRows.has(c.row.id) || usedTx.has(c.tx.id)) return;
    usedRows.add(c.row.id);
    usedTx.add(c.tx.id);
    matched.push({ row: c.row, tx: c.tx, dayDiff: c.dd });
  });

  // 3) 묶음 일치 — 같은 가게·±1일에서 여러 건의 합이 같으면 맞게 적은 것으로 본다
  const freeRow = r => !usedRows.has(r.id) && !r.isCancel && !pairedApproval.has(r.id);
  const freeTx = t => !usedTx.has(t.id) && gross(t) > 0;
  const grouped = [];

  // 3-1) 나눠 적음: 카드 1건 = 가계부 여러 건 (예: 이마트 50,000 → 식비 30,000 + 생활용품 20,000)
  comparable.filter(freeRow).forEach(row => {
    const pool = ledger.filter(t => freeTx(t) && dayDiff(row.date, t.date) <= GROUP_DAYS && sameMerchant(db, row, t));
    const txs = findCombination(pool, gross, row.amount) || findCombination(pool, net, row.amount);
    if (!txs) return;
    usedRows.add(row.id);
    txs.forEach(t => usedTx.add(t.id));
    grouped.push({ kind: 'split', rows: [row], txs });
  });

  // 3-2) 합쳐 적음: 카드 여러 건 = 가계부 1건 (예: 커피 4,500 두 번 → 9,000 한 번)
  ledger.filter(freeTx).forEach(tx => {
    const pool = comparable.filter(r => freeRow(r) && dayDiff(r.date, tx.date) <= GROUP_DAYS && sameMerchant(db, r, tx));
    const picked = findCombination(pool, r => r.amount, gross(tx))
      || (net(tx) !== gross(tx) ? findCombination(pool, r => r.amount, net(tx)) : null);
    if (!picked) return;
    usedTx.add(tx.id);
    picked.forEach(r => usedRows.add(r.id));
    grouped.push({ kind: 'merged', rows: picked, txs: [tx] });
  });

  // 4) 금액 차이 — 같은 가게·±1일인데 합이 다름.
  //    가계부가 여러 건이면 한 건만 카드 금액으로 고치면 이중 계산되므로 묶어서 보여주기만 한다
  const mismatched = [];
  comparable.filter(freeRow).forEach(row => {
    const txs = ledger.filter(t => freeTx(t) && dayDiff(row.date, t.date) <= GROUP_DAYS && sameMerchant(db, row, t));
    if (!txs.length) return;
    usedRows.add(row.id);
    txs.forEach(t => usedTx.add(t.id));
    mismatched.push({ rows: [row], txs, cardTotal: row.amount, ledgerTotal: txs.reduce((sum, t) => sum + gross(t), 0) });
  });

  // 5) 취소 짝 — 승인 건이 가계부에 남아 있으면 알린다
  const cancelled = [];
  pairedApproval.forEach((cancelRow, approvalId) => {
    const approval = rows.find(r => r.id === approvalId);
    const hit = matched.find(m => m.row.id === approvalId);
    cancelled.push({ approval, cancel: cancelRow, tx: hit ? hit.tx : null });
  });
  const matchedOut = matched.filter(m => !pairedApproval.has(m.row.id));

  // 6) 남은 것
  const missing = comparable
    .filter(r => !usedRows.has(r.id) && !pairedApproval.has(r.id))
    .map(row => ({ row, suggestion: rowSuggestion(db, row, paymentMethod) }));
  const notOnCard = ledger.filter(t => !usedTx.has(t.id) && t.date >= from && t.date <= to);

  return { period: { from, to }, matched: matchedOut, grouped, mismatched, missing, notOnCard, cancelled };
}

/**
 * "가계부에 없음"에서 고른 건을 한 번에 추가한다. 중간에 실패하면 전부 되돌린다.
 * picks: [{ suggestion, budget_category, sub_category }] — 화면에서 바꾼 분류를 덮어쓴다.
 */
export function addMissingRows(db, picks) {
  withTransaction(db, () => {
    picks.forEach(({ suggestion, budget_category, sub_category }) => {
      addTransaction(db, suggestionToTransaction(db, { ...suggestion, budget_category, sub_category }));
    });
  });
  return picks.length;
}

/** "카드 금액으로 수정"에 쓸 갱신 데이터 — DB 행을 updateTransaction 형식으로 */
export function txWithAmount(tx, amount) {
  let foreign = {};
  try { foreign = tx.foreign_amounts ? JSON.parse(tx.foreign_amounts) : {}; } catch (e) { foreign = {}; }
  return {
    payment_method: tx.payment_method,
    date: tx.date,
    budget_category: tx.budget_category,
    sub_category: tx.sub_category,
    detail: tx.detail,
    amount,
    discount_amount: tx.discount_amount || 0,
    discount_note: tx.discount_note || '',
    event_id: tx.event_id,
    foreign_amounts: foreign,
    split_group_id: tx.split_group_id || '',
  };
}
