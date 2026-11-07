/**
 * 말로 입력 — "어제 점심 김치찌개 9천원 현금, 스타벅스 4500 카카오페이" 같은 문장을
 * 거래 추천 목록으로 바꾼다. 분류는 영수증과 같은 규칙(예전 습관 > AI 추천)으로 다시 맞춘다.
 */
import { analyzeWithAI, AIError } from './aiClient';
import { buildDataContext, classify, pickPaymentMethod, resolveAmount, resolveDate } from './receiptAssistant';
import { today as todayStr } from './formulaEvaluator';

const SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      description: '문장에 나온 결제 건들 (한 건이면 1개)',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD. 날짜 말이 없으면 빈 문자열' },
          merchant: { type: 'string', description: '가게·장소 이름. 없으면 빈 문자열' },
          detail: { type: 'string', description: '가계부 세부내역 (입력 습관의 표기 우선, 없으면 짧게)' },
          amount: { type: 'number', description: '금액 숫자. "9천원"=9000, "1만2천"=12000. 모르면 0' },
          currency: { type: 'string', description: 'ISO 통화 코드. 원화면 KRW, "엔"이면 JPY, "달러"면 USD' },
          payment_method: { type: 'string', description: '결제수단 목록 중 하나, 판단 어려우면 "모름"' },
          payment_mentioned: { type: 'boolean', description: '사용자가 결제수단을 직접 말했으면 true' },
          category: { type: 'string', description: '"카테고리 > 세부카테고리" 목록 중 하나, 판단 어려우면 "모름"' },
        },
        required: ['date', 'merchant', 'detail', 'amount', 'currency', 'payment_method', 'payment_mentioned', 'category'],
      },
    },
    question: { type: 'string', description: '금액·내용을 전혀 알 수 없어 되물어야 하면 그 질문, 아니면 빈 문자열' },
  },
  required: ['entries', 'question'],
};

const SYSTEM = [
  '당신은 한국 가계부 앱의 입력 도우미입니다.',
  '사용자가 말로 적은 지출을 거래 기록으로 정리합니다.',
  '말에 없는 사실(금액·가게)은 지어내지 않고, 분류는 주어진 목록 안에서 사용자의 입력 습관을 우선해 고릅니다.',
].join(' ');

export function buildTextPrompt(db, text, today = todayStr()) {
  return [
    buildDataContext(db, today).text,
    '',
    '[규칙]',
    '- 한 문장에 여러 건이 있으면 각각 나눈다. "둘 다 현금"처럼 묶어 말한 건 각 건에 적용한다.',
    '- 날짜는 오늘 기준으로 계산한다: 어제, 그저께, 지난주 금요일, 3일 전, 11/3 등. 날짜 말이 없으면 빈 문자열.',
    '- 금액: 9천원=9000, 1만2천원=12000, 만오천=15000, 4.5만=45000.',
    '- 결제수단을 말하지 않았으면 입력 습관으로 추정하되 payment_mentioned=false.',
    '- 결제수단·카테고리는 위 목록의 표기 그대로, 애매하면 "모름".',
    '',
    '[사용자가 말한 내용]',
    String(text || '').trim(),
  ].join('\n');
}

/** 문장 하나를 거래 추천 목록으로 */
export async function parseTextEntry({ db, ai, text, signal, today = todayStr() }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new AIError('입력할 내용을 적어 주세요', 'parse');

  const raw = await analyzeWithAI({
    ai, system: SYSTEM, prompt: buildTextPrompt(db, trimmed, today), schema: SCHEMA,
    toolName: 'record_entries', description: '사용자가 말한 지출을 거래 기록으로 정리한다', signal,
  });
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  if (!entries.length) {
    throw new AIError(raw?.question || '거래 내용을 찾지 못했습니다 — 무엇을 얼마에 샀는지 적어 주세요', 'parse');
  }
  return entries.slice(0, 20).map(e => buildTextSuggestion(db, e, today));
}

/** AI가 나눈 한 건을 이 가계부 데이터에 맞춘 추천으로 */
export function buildTextSuggestion(db, e, today = todayStr()) {
  const { date, source: dateSource } = resolveDate(e.date, today, 'text');
  const money = resolveAmount(db, { total: e.amount, currency: e.currency, date });
  const cls = classify(db, {
    merchant: e.merchant, detail: e.detail, aiCategory: e.category, eventId: money.event_id, readSource: 'text',
  });
  const pay = pickPaymentMethod(db, {
    aiMethod: e.payment_method, evident: !!e.payment_mentioned, history: cls.history,
    sub: cls.sub_category, readSource: 'text',
  });

  const sources = { date: dateSource, ...cls.sources };
  if (money.event_id) sources.event = 'trip';
  if (pay.source) sources.payment_method = pay.source;

  return {
    date,
    merchant: String(e.merchant || '').trim(),
    detail: cls.detail,
    amount: money.amount,
    currency: money.currency,
    foreignAmount: money.foreignAmount,
    rate: money.rate,
    event_id: money.event_id,
    eventTitle: money.eventTitle,
    payment_method: pay.payment_method,
    paymentHint: '',
    budget_category: cls.budget_category,
    sub_category: cls.sub_category,
    items: [],
    historyDetail: cls.history?.detail || '',
    historyCount: cls.history?.cnt || 0,
    confidence: 'high',
    warnings: money.warnings,
    sources,
  };
}
