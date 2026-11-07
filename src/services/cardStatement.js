/**
 * 카드 결제 내역 대조 — 카드 앱 캡처·명세서 PDF를 AI로 읽어 가계부와 비교한다.
 *
 *   일치          : 금액이 같고 날짜가 ±3일 안 (한 건은 한 건하고만 짝지음)
 *   금액 차이     : 날짜·가게는 맞는데 금액이 다름 → 카드 금액으로 수정 가능
 *   가계부에 없음 : 카드에만 있음 → 분류를 추천해 바로 추가
 *   카드에 없음   : 그 기간 이 결제수단으로 적었는데 카드에 없음 → 결제수단 확인 필요
 *   취소된 결제   : 카드에 승인과 취소가 함께 있음 → 가계부에 승인만 남아 있으면 알림
 *
 * 비교는 AI 없이 로컬에서 한다 — 추가·수정 후 다시 계산하면 바로 반영된다.
 */
import { analyzeWithAI, AIError } from './aiClient';
import {
  buildDataContext, classify, findTrip, normalizeName, matchHistory, isValidDate, addDays,
} from './receiptAssistant';
import { today as todayStr } from './formulaEvaluator';

export const TOLERANCE_DAYS = 3;

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
    if (!isValidDate(r.date) || r.date > addDays(today, 1)) { unreadable += 1; return; }
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
    periodFrom: isValidDate(raw.period_from) ? raw.period_from : '',
    periodTo: isValidDate(raw.period_to) ? raw.period_to : '',
    rows,
    unreadable,
    note: String(raw.note || '').trim(),
  };
}

// ── 대조 ────────────────────────────────────────────────────────

function dayDiff(a, b) {
  return Math.round(Math.abs(new Date(`${a}T00:00:00`) - new Date(`${b}T00:00:00`)) / 86400000);
}

/** 카드 가맹점명과 가계부 세부내역이 같은 곳을 가리키는지 */
function sameMerchant(db, row, tx) {
  const m = normalizeName(row.merchant);
  const d = normalizeName(tx.detail);
  if (m.length >= 2 && d.length >= 2 && (m.includes(d) || d.includes(m))) return true;
  const hist = matchHistory(db, row.merchant);
  return !!(hist && tx.detail && hist.detail === tx.detail);
}

function amountMatches(row, tx) {
  const amount = Number(tx.amount) || 0;
  const discount = Number(tx.discount_amount) || 0;
  return row.amount === amount || (discount > 0 && row.amount === amount - discount);
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
 * 반환: { period, matched, mismatched, missing, notOnCard, cancelled }
 */
export function reconcileStatement(db, { paymentMethod, rows, periodFrom, periodTo, toleranceDays = TOLERANCE_DAYS }) {
  const dates = rows.map(r => r.date).sort();
  const from = periodFrom || dates[0] || '';
  const to = periodTo || dates[dates.length - 1] || '';
  const empty = { period: { from, to }, matched: [], mismatched: [], missing: [], notOnCard: [], cancelled: [] };
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

  // 3) 금액만 다른 건 — 날짜 ±1일, 같은 가게
  const mismatched = [];
  comparable.forEach(row => {
    if (usedRows.has(row.id) || row.isCancel) return;
    const tx = ledger.find(t => !usedTx.has(t.id) && dayDiff(row.date, t.date) <= 1
      && Number(t.amount) > 0 && sameMerchant(db, row, t));
    if (tx) {
      usedRows.add(row.id);
      usedTx.add(tx.id);
      mismatched.push({ row, tx });
    }
  });

  // 4) 취소 짝 — 승인 건이 가계부에 남아 있으면 알린다
  const cancelled = [];
  pairedApproval.forEach((cancelRow, approvalId) => {
    const approval = rows.find(r => r.id === approvalId);
    const hit = matched.find(m => m.row.id === approvalId);
    cancelled.push({ approval, cancel: cancelRow, tx: hit ? hit.tx : null });
  });
  const matchedOut = matched.filter(m => !pairedApproval.has(m.row.id));

  // 5) 남은 것
  const missing = comparable
    .filter(r => !usedRows.has(r.id) && !pairedApproval.has(r.id))
    .map(row => ({ row, suggestion: rowSuggestion(db, row, paymentMethod) }));
  const notOnCard = ledger.filter(t => !usedTx.has(t.id) && t.date >= from && t.date <= to);

  return { period: { from, to }, matched: matchedOut, mismatched, missing, notOnCard, cancelled };
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
