/**
 * 말로 입력 — "어제 점심 김치찌개 9천원 현금, 스타벅스 4500 카카오페이" 같은 문장을
 * 거래 추천 목록으로 바꾼다. 분류는 영수증과 같은 규칙(예전 습관 > AI 추천)으로 다시 맞춘다.
 *
 * 정보가 모자라면 되묻고 덧붙여 말하게 한다 (I-017).
 * - 결제 건을 하나도 못 찾으면 kind 'unclear' 오류로 AI의 질문을 돌려준다. 화면은 이것을 실패가 아니라 되묻기로 보여 준다.
 *   AI가 형식 없이 글로만 되물은 경우(Claude)도 그 글을 질문으로 쓴다.
 * - 덧붙인 말(followUps)은 처음 말과 합쳐 처음부터 다시 정리한다. 앱이 물은 것도 함께 보내 "9천원" 같은 짧은 답도 알아듣게 한다.
 */
import { analyzeWithAI, AIError } from './aiClient';
import { buildDataContext, classify, pickPaymentMethod, resolveAmount, resolveDate } from './receiptAssistant';
import { today as todayStr } from './formulaEvaluator';

const SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      description: '문장에 나온 결제 건들 (한 건이면 1개). 금액·결제수단을 몰라도 무엇을 샀는지 알면 넣는다',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD. 날짜 말이 없으면 빈 문자열' },
          merchant: { type: 'string', description: '가게·장소 이름. 없으면 빈 문자열' },
          detail: { type: 'string', description: '가계부 세부내역 (입력 습관의 표기 우선, 없으면 짧게)' },
          amount: { type: 'number', description: '금액 숫자. "9천원"=9000, "1만2천"=12000. 모르면 0' },
          currency: { type: 'string', description: 'ISO 통화 코드. 원화면 KRW, "엔"이면 JPY, "달러"면 USD' },
          krw_amount: { type: 'number', description: '외화 결제인데 원화로 얼마였는지도 말했으면 그 원화 금액, 아니면 0' },
          payment_method: { type: 'string', description: '결제수단 목록 중 하나, 판단 어려우면 "모름"' },
          payment_mentioned: { type: 'boolean', description: '사용자가 결제수단을 직접 말했으면 true' },
          category: { type: 'string', description: '"카테고리 > 세부카테고리" 목록 중 하나, 판단 어려우면 "모름"' },
        },
        required: ['date', 'merchant', 'detail', 'amount', 'currency', 'krw_amount', 'payment_method', 'payment_mentioned', 'category'],
      },
    },
    question: {
      type: 'string',
      description: '결제 건을 하나도 정리할 수 없을 때 무엇이 부족한지 되묻는 한 문장, 정리했으면 빈 문자열',
    },
  },
  required: ['entries', 'question'],
};

const SYSTEM = [
  '당신은 한국 가계부 앱의 입력 도우미입니다.',
  '사용자가 말로 적은 지출을 거래 기록으로 정리합니다.',
  '말에 없는 사실(금액·가게)은 지어내지 않고, 분류는 주어진 목록 안에서 사용자의 입력 습관을 우선해 고릅니다.',
].join(' ');

// 결제 건을 하나도 못 찾았을 때 — 화면은 이 kind를 실패가 아니라 되묻기로 보여 준다
export const UNCLEAR = 'unclear';
const DEFAULT_QUESTION = '어떤 지출인지 알아듣지 못했어요 — 무엇을 얼마에 샀는지 말해 주세요';
// 덧붙인 말은 이만큼만 보낸다 (지시문이 끝없이 길어지지 않게) — 첫 덧붙임(되묻기의 답이라 사실이 많이 담긴다)과 최근 것
const MAX_FOLLOW_UPS = 6;
const MAX_TURN_LENGTH = 500;

const clip = s => String(s || '').trim().slice(0, MAX_TURN_LENGTH);

/** 덧붙인 말 목록을 고른다 — 덧붙인 말이 빈 것은 버리고, 너무 많으면 첫 것과 최근 것만 남긴다 */
export function cleanFollowUps(followUps) {
  if (!Array.isArray(followUps)) return [];
  const turns = followUps
    .map(f => ({ asked: clip(f && f.asked), said: clip(f && f.said) }))
    .filter(f => f.said);
  return turns.length > MAX_FOLLOW_UPS ? [turns[0], ...turns.slice(-(MAX_FOLLOW_UPS - 1))] : turns;
}

export function buildTextPrompt(db, text, today = todayStr(), followUps = []) {
  const turns = cleanFollowUps(followUps);
  const lines = [
    buildDataContext(db, today).text,
    '',
    '[규칙]',
    '- 한 문장에 여러 건이 있으면 각각 나눈다. "둘 다 현금"처럼 묶어 말한 건 각 건에 적용한다.',
    '- 날짜는 오늘 기준으로 계산한다: 어제, 그저께, 지난주 금요일, 3일 전, 11/3 등. 날짜 말이 없으면 빈 문자열.',
    '- 금액: 9천원=9000, 1만2천원=12000, 만오천=15000, 4.5만=45000.',
    '- 금액을 말하지 않은 건도 빼지 말고 amount=0으로 넣는다. 빠진 정보는 앱이 사용자에게 다시 묻는다.',
    '- 외화 결제에 원화 금액도 말하면(덧붙인 말 포함) amount·currency는 외화 그대로 두고 krw_amount에 원화 금액을 넣는다.',
    '- 결제수단을 말하지 않았으면 입력 습관으로 추정하되 payment_mentioned=false.',
    '- 결제수단·카테고리는 위 목록의 표기 그대로, 애매하면 "모름".',
    '- 결제 건을 하나도 정리할 수 없을 때만 entries를 비우고, question에 무엇이 부족한지 한 문장으로 되묻는다.',
    '- 되물을 때도 글로만 답하지 말고 정해진 형식(entries·question)으로 답한다.',
  ];
  if (turns.length) {
    lines.push(
      '- 이어서 나눈 말은 처음 말한 건의 빠진 정보를 채우거나 고친 것이다. 같은 건을 따로 또 만들지 말고 하나로 합친다.',
      '- 이어서 한 말이 분명히 다른 결제를 말하면 새 건으로 더한다. 앞뒤 말이 다르면 나중에 한 말을 따른다.',
      '- entries에는 처음 말과 이어서 한 말을 모두 반영한 전체 목록을 담는다.',
    );
  }
  lines.push('', '[사용자가 말한 내용]', String(text || '').trim());
  if (turns.length) {
    lines.push('', '[이어서 나눈 말 — 앱이 물은 것과 사용자가 덧붙인 말]');
    turns.forEach((t) => {
      if (t.asked) lines.push(`앱: ${t.asked}`);
      lines.push(`사용자: ${t.said}`);
    });
  }
  return lines.join('\n');
}

const MAX_QUESTION_LENGTH = 300;
// 되묻는 글로 볼 표시 — 물음표나 "알려/말해/적어 주세요" 같은 부탁
const ASKING = /[?？]|(알려|말씀해|말해|적어|입력해)\s*주/;

/**
 * AI가 형식 없이 글로만 답한 오류에서 되묻는 말을 꺼낸다 (Claude는 도구를 강제할 수 없어 글로 되묻기도 한다, B-072).
 * aiClient가 JSON 없는 글에만 reply를 붙인다. 묻는 글이 아니면(정리 결과를 글로 쓴 것 등) 되묻기로 보지 않는다. 없으면 ''
 */
function spokenQuestion(e) {
  if (!(e instanceof AIError) || e.kind !== 'content' || typeof e.reply !== 'string') return '';
  const reply = e.reply.trim();
  if (!reply || !ASKING.test(reply)) return '';
  return reply.length > MAX_QUESTION_LENGTH ? `${reply.slice(0, MAX_QUESTION_LENGTH)}…` : reply;
}

// 무엇을 샀는지도, 얼마인지도 없는 건 — 정리했다고 보기 어렵다
const isEmptyEntry = e => !(Number(e.amount) > 0) && !String(e.merchant || '').trim() && !String(e.detail || '').trim();

/**
 * 말한 내용(과 덧붙인 말)을 거래 추천 목록으로.
 * followUps: [{ asked: 앱이 물은 것, said: 사용자가 덧붙인 말 }] — 처음 말과 합쳐 다시 정리한다.
 * 결제 건을 하나도 못 찾으면 AIError(질문, 'unclear')를 던진다.
 */
export async function parseTextEntry({ db, ai, text, followUps = [], signal, onProgress, today = todayStr() }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new AIError('입력할 내용을 적어 주세요', 'parse');

  let raw;
  try {
    raw = await analyzeWithAI({
      ai, system: SYSTEM, prompt: buildTextPrompt(db, trimmed, today, followUps), schema: SCHEMA,
      toolName: 'record_entries', description: '사용자가 말한 지출을 거래 기록으로 정리한다', signal, onProgress,
    });
  } catch (e) {
    const question = spokenQuestion(e);
    if (question) throw new AIError(question, UNCLEAR);
    throw e;
  }
  const entries = (Array.isArray(raw?.entries) ? raw.entries : [])
    .filter(e => e && typeof e === 'object' && !isEmptyEntry(e));
  if (!entries.length) {
    const question = typeof raw?.question === 'string' ? raw.question.trim() : '';
    throw new AIError(question || DEFAULT_QUESTION, UNCLEAR);
  }
  return entries.slice(0, 20).map(e => buildTextSuggestion(db, e, today));
}

/**
 * 외화 결제인데 환율·여행 일정이 없어 원화를 못 구했을 때, 사용자가 말한 원화 금액을 쓴다.
 * 외화 금액·여행 일정은 그대로 두어 외화 기록과 여행 연결이 남는다.
 */
function withSpokenKrw(money, krwAmount) {
  const krw = Number(krwAmount);
  if (money.amount !== null || money.foreignAmount === null || !(krw > 0)) return money;
  const amount = Math.round(krw);
  return {
    ...money,
    amount,
    rate: money.foreignAmount > 0 ? Math.round((amount / money.foreignAmount) * 100) / 100 : 0,
    // 원화를 직접 입력하라는 안내는 지운다. 여행 일정이 없으면 외화는 기록되지 않는다는 것만 알린다
    warnings: money.event_id ? [] : [`${money.currency} 여행 일정이 없어 원화 금액만 기록됩니다`],
  };
}

/** AI가 나눈 한 건을 이 가계부 데이터에 맞춘 추천으로 */
export function buildTextSuggestion(db, e, today = todayStr()) {
  const { date, source: dateSource } = resolveDate(e.date, today, 'text');
  const money = withSpokenKrw(resolveAmount(db, { total: e.amount, currency: e.currency, date }), e.krw_amount);
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
