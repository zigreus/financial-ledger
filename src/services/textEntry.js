/**
 * 말로 입력 — "어제 점심 김치찌개 9천원 현금, 스타벅스 4500 카카오페이" 같은 문장을
 * 거래 추천 목록으로 바꾼다. 분류는 영수증과 같은 규칙(말한 것 > 예전 기록, classify)으로 다시 맞춘다.
 *
 * 정보가 모자라면 되묻고 덧붙여 말하게 한다 (I-017).
 * - 결제 건을 하나도 못 찾으면 kind 'unclear' 오류로 AI의 질문을 돌려준다. 화면은 이것을 실패가 아니라 되묻기로 보여 준다.
 *   AI가 형식 없이 글로만 되물은 경우(Claude)도 그 글을 질문으로 쓴다.
 * - 덧붙인 말(followUps)은 처음 말과 합쳐 처음부터 다시 정리한다. 앱이 물은 것도 함께 보내 "9천원" 같은 짧은 답도 알아듣게 한다.
 */
import { analyzeWithAI, AIError } from './aiClient';
import {
  buildDataContext, classify, normalizeName, paymentMatch, pickPaymentMethod, pickSpokenPayment, resolveAmount, resolveDate,
  saidInText, suggestionName, CATEGORY_ALT_DESCRIPTION, CATEGORY_ALT_RULE, DETAIL_SAID_DESCRIPTION, PAYMENT_SAID_DESCRIPTION, PAYMENT_SAID_RULE,
} from './receiptAssistant';
import { getBudgetCategories, getPaymentMethods } from './dbManager';
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
          detail: { type: 'string', description: DETAIL_SAID_DESCRIPTION },
          amount: { type: 'number', description: '금액 숫자. "9천원"=9000, "1만2천"=12000. 모르면 0' },
          currency: { type: 'string', description: 'ISO 통화 코드. 원화면 KRW, "엔"이면 JPY, "달러"면 USD' },
          krw_amount: { type: 'number', description: '외화 결제인데 원화로 얼마였는지도 말했으면 그 원화 금액, 아니면 0' },
          payment_method: { type: 'string', description: '결제수단 목록 중 하나, 판단 어려우면 "모름"' },
          payment_mentioned: { type: 'boolean', description: '사용자가 결제수단을 직접 말했으면 true' },
          payment_said: { type: 'string', description: PAYMENT_SAID_DESCRIPTION },
          category: { type: 'string', description: '"카테고리 > 세부카테고리" 목록 중 하나, 판단 어려우면 "모름"' },
          category_alt: { type: 'string', description: CATEGORY_ALT_DESCRIPTION },
        },
        required: ['date', 'merchant', 'detail', 'amount', 'currency', 'krw_amount', 'payment_method', 'payment_mentioned', 'payment_said', 'category', 'category_alt'],
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
  '말에 없는 사실(금액·가게)은 지어내지 않고, 분류는 주어진 목록 안에서 고르되 사용자가 말한 물건·용도가 먼저이고 입력 습관은 판단 근거로 씁니다.',
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

/** 사용자가 쓴 글 전체 — 처음 말과 덧붙인 말 (지시문의 '글에 나온 이름의 예전 기록'과 결제수단 확인이 함께 쓴다) */
export function spokenTextOf(text, followUps = []) {
  return [String(text || '').trim(), ...cleanFollowUps(followUps).map(f => f.said)].join('\n');
}

export function buildTextPrompt(db, text, today = todayStr(), followUps = []) {
  const turns = cleanFollowUps(followUps);
  const lines = [
    buildDataContext(db, today, { text: spokenTextOf(text, followUps) }).text,
    '',
    '[규칙]',
    '- 한 문장에 여러 건이 있으면 각각 나눈다. "둘 다 현금"처럼 묶어 말한 건 각 건에 적용한다.',
    '- 앞에서 한 번 말한 대상·용도·가게와 날짜는 다른 것을 말하기 전까지 뒤에 금액만 말한 건에도 이어진다. 그 건들의 merchant·detail·category도 똑같이 채운다 (예: "아버지 23일 5000, 25일 7000, 8000" → 세 건 모두 아버지, 7000·8000은 25일).',
    '- 금액만 늘어놓은 끝에 "N건"이라고 했고 N이 늘어놓은 금액의 수와 같으면 그 금액들이 N건이다 ("25일 7000, 8000 2건" → 7000 한 건과 8000 한 건). 금액 하나에 붙은 "5000원 2건"은 같은 금액 두 건이다.',
    '- 날짜는 오늘 기준으로 계산한다: 어제, 그저께, 지난주 금요일, 3일 전, 11/3 등. 날짜 말이 없으면 빈 문자열.',
    '- 금액: 9천원=9000, 1만2천원=12000, 만오천=15000, 4.5만=45000.',
    '- 금액을 말하지 않은 건도 빼지 말고 amount=0으로 넣는다. 빠진 정보는 앱이 사용자에게 다시 묻는다.',
    '- 외화 결제에 원화 금액도 말하면(덧붙인 말 포함) amount·currency는 외화 그대로 두고 krw_amount에 원화 금액을 넣는다.',
    PAYMENT_SAID_RULE,
    '- 결제수단을 말하지 않았으면 입력 습관으로 추정하되 payment_mentioned=false, payment_said는 빈 문자열.',
    '- 결제수단·카테고리는 위 목록의 표기 그대로, 애매하면 "모름".',
    CATEGORY_ALT_RULE,
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
  const spokenText = spokenTextOf(trimmed, followUps);
  const list = entries.slice(0, 20);
  // 한 건인데 AI가 결제수단을 말하지 않았다고 보면 — 글에 목록의 결제수단이 또렷이 있는지 앱이 한 번 더 본다 (B-096)
  const lone = list.length === 1 && !list[0].payment_mentioned && !String(list[0].payment_said || '').trim();
  const foundPayment = lone ? paymentWordIn(db, spokenText, list[0]) : '';
  const build = (e, more) => buildTextSuggestion(db, e, today, { spokenText, foundPayment, ...more });
  const first = list.map(e => build(e));
  // 여러 건 중 무엇인지 말하지 않은 건 — 다른 건에서 말한 대상을 잇는다('아버지 23일 5000, 25일 7000, 8000'의 뒤 두 건, B-101)
  const carried = carriedSubjects(db, list, first);
  const raws = list.map((e, i) => (carried[i] ? carried[i].raw : e));
  const out = raws.map((e, i) => (carried[i] ? build(e) : first[i]));
  // 여러 건 중 결제수단을 말하지 않은 건 — 다른 건에 말한 결제수단을 추천한다('현대카드로 병원 9천원, 약국 5천원'의 약국).
  // 앞 건에 말한 것이 먼저, 없으면 뒤 건. 짐작이라 바로 넣지 않고 확인받는다
  const told = out.map((s, i) => (s.paymentMentioned && s.paymentSaid && s.payment_method ? i : -1)).filter(i => i >= 0);
  return out.map((s, i) => {
    let next = s;
    if (!s.paymentMentioned && told.length) {
      const from = [...told].reverse().find(j => j < i) ?? told.find(j => j > i);
      next = build(raws[i], { carriedPayment: out[from].paymentSaid });
    }
    return carried[i] ? markCarriedSubject(next, out[carried[i].from], carried[i].from < i, carried[i].detail) : next;
  });
}

// ── 다른 건에서 말한 대상 잇기 (B-101) ──────────────────────────

/** 건을 부르는 이름 — 세부내역, 없으면 가게 (정규화) */
const nameOf = e => normalizeName(e.detail) || normalizeName(e.merchant);
/** AI가 목록의 카테고리를 골랐는지 ('모름'·목록에 없는 것은 못 고른 것) */
const pickedCategory = (cats, e) => cats.includes(String(e.category || '').split('>')[0].trim());

/**
 * 여러 건 중 무엇인지 분류하지 못한 건에 다른 건에서 말한 대상을 잇는다 — 한 번 말한 대상은 뒤의 건에도 이어진다.
 * '아버지 23일 5000, 25일 7000, 8000 2건'에서 AI가 '아버지'를 첫 건에만 붙였으면 뒤의 두 건에도.
 *  1) 이름은 있는데 분류만 못 한 건(예전 기록도 없음): 이름(세부내역, 없으면 가게)이 똑같은 다른 건을 AI가 분류했으면 그 분류.
 *     '편의점 커피'와 '편의점'처럼 이름이 다르면 잇지 않는다
 *  2) 무엇인지 아무것도 말하지 않은 건(가게·세부내역 없음, AI도 분류 못 함): 앞(없으면 뒤)의 가장 가까운,
 *     무엇인지 말한 건의 가게·세부내역·분류 — 그 건이 1)에서 이은 분류까지
 * AI가 분류한 건과 예전 기록으로 분류한 건은 건드리지 않는다.
 * 반환: 건마다 { raw: 이은 AI 결과, from: 이어 준 건, detail: 가게·세부내역도 이었는지 } 또는 null
 */
function carriedSubjects(db, list, built) {
  const out = list.map(() => null);
  if (list.length < 2) return out;
  const cats = getBudgetCategories(db);
  const picked = e => pickedCategory(cats, e);
  const open = list.map((e, i) => !picked(e) && built[i].sources.category !== 'history');
  const nearest = (i, fits) => {
    const others = list.map((_, j) => j).filter(j => j !== i && fits(j));
    return [...others].reverse().find(j => j < i) ?? others.find(j => j > i);
  };
  list.forEach((e, i) => {
    const name = nameOf(e);
    if (!open[i] || !name) return;
    const from = nearest(i, j => picked(list[j]) && nameOf(list[j]) === name);
    if (from !== undefined) {
      out[i] = { raw: { ...e, category: list[from].category, category_alt: list[from].category_alt }, from, detail: false };
    }
  });
  const raws = list.map((e, i) => (out[i] ? out[i].raw : e));
  list.forEach((e, i) => {
    if (!open[i] || nameOf(e)) return;
    const from = nearest(i, j => !!nameOf(raws[j]) || picked(raws[j]));
    if (from === undefined) return;
    const d = raws[from];
    out[i] = {
      raw: { ...e, merchant: d.merchant, detail: d.detail, category: d.category, category_alt: d.category_alt }, from, detail: true,
    };
  });
  return out;
}

/**
 * 앱이 다른 건에서 말한 대상을 이은 추천인지 — 이름을 빌렸을 뿐이라, 같은 이름의 다른 건(바로 넣은 것 등)과
 * 같은 거래라는 근거가 아니다. 따로 확인받는다
 */
export const isCarriedSubject = s => s?.sources?.detail === 'carried' || s?.sources?.category === 'carried';

/** 다른 건에서 말한 대상을 이었다는 알림인지 — 분류를 직접 고르면 지운다 (앞머리만 본다 — 이름에 무엇이 있든) */
export const isCarriedSubjectWarning = w => /^(앞|뒤)에 말한 '/.test(String(w || ''));

/** 이은 건에 근거 '추천'과 확인 알림을 붙인다 — 짐작이라 바로 넣지 않는다. donor: 이어 준 건의 추천 */
function markCarriedSubject(s, donor, before, detail) {
  const name = (suggestionName(donor) || donor.budget_category || '').replace(/\s+/g, ' ');
  const sources = { ...s.sources };
  if (s.budget_category && sources.category !== 'trip') sources.category = 'carried';
  if (detail && s.detail) sources.detail = 'carried';
  return {
    ...s,
    sources,
    warnings: [...s.warnings, `${before ? '앞' : '뒤'}에 말한 '${name}' 추천 — 이 건도 맞는지 확인해 주세요`],
  };
}

// 결제수단 낱말 끝에 붙는 말 — '현대카드로', '현금으로', '신한카드 결제'
const PAYMENT_PARTICLE_RE = /(으로|로|결제|계산|이요|요|이랑|랑|하고)$/;

/**
 * 글에서 결제수단 낱말을 찾는다 — 카드·체크·페이로 끝나는 이름('현대카드', '엄마 카드')이나 '현금'이고 목록의 결제수단과
 * 통째로 맞는(paymentMatch 2 이상) 것만. '우리 아이'·'하나'·'엄마' 같은 보통 말과 가게·세부내역 이름 속 글자('현대백화점')는 보지 않는다.
 * 짧은 낱말부터 보고, 없으면 ''
 */
function paymentWordIn(db, text, e) {
  const methods = getPaymentMethods(db);
  const names = [e.merchant, e.detail].map(normalizeName).filter(Boolean);
  const words = String(text || '').split(/[^0-9a-zA-Z가-힣]+/).map(normalizeName).filter(Boolean);
  for (let size = 1; size <= 2; size += 1) {
    for (let i = 0; i + size <= words.length; i += 1) {
      const w = words.slice(i, i + size).join('').replace(PAYMENT_PARTICLE_RE, '');
      const core = w.replace(/(체크카드|신용카드|카드|체크|페이|pay)$/, '');
      const payWord = (core !== w && core.length >= 2) || w === '현금';
      if (!payWord || names.some(n => n.includes(w) || w.includes(n))) continue;
      if (methods.some(m => paymentMatch(w, m) >= 2)) return w;
    }
  }
  return '';
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

/**
 * 사용자가 말한 결제수단 표현 — 말하지 않았으면 null.
 * payment_said가 비었어도 말했다고 하면(payment_mentioned) AI가 고른 이름을 말한 것으로 본다.
 * 말했다는데 무엇인지 모르거나, 사용자가 쓴 글(spokenText)에 그 표현이 없으면(AI가 습관의 카드로 바꿔 적었을 수 있다)
 * 빈 문자열 — 습관으로 채우지 않고 묻는다 (B-096)
 */
function spokenPayment(e, spokenText) {
  const mentioned = String(e.payment_said || '').trim()
    || (e.payment_mentioned ? String(e.payment_method || '').trim().replace(/^모름$/, '') : '');
  if (!mentioned) return e.payment_mentioned || String(e.payment_said || '').trim() ? '' : null;
  return spokenText === undefined || saidInText(spokenText, mentioned) ? mentioned : '';
}

/**
 * AI가 나눈 한 건을 이 가계부 데이터에 맞춘 추천으로.
 * spokenText: 사용자가 쓴 글(덧붙인 말 포함) — 있으면 AI가 짚은 결제수단 표현이 정말 글에 있는지 본다
 * foundPayment: AI는 결제수단을 말하지 않았다고 했는데 앱이 글에서 찾은 결제수단 낱말 — 그것으로 고르되 바로 넣지는 않는다(확인받는다)
 * carriedPayment: 이 건은 결제수단을 말하지 않았고 다른 건에 말한 결제수단 표현 — 맞는 것이 있으면 '추천'으로 채운다(확인받는다)
 */
export function buildTextSuggestion(db, e, today = todayStr(), { spokenText, foundPayment = '', carriedPayment = '' } = {}) {
  const { date, source: dateSource } = resolveDate(e.date, today, 'text');
  const money = withSpokenKrw(resolveAmount(db, { total: e.amount, currency: e.currency, date }), e.krw_amount);
  const cls = classify(db, {
    merchant: e.merchant, detail: e.detail, aiCategory: e.category, aiAltCategory: e.category_alt, eventId: money.event_id,
    readSource: 'text', promptText: spokenText,
  });
  const said = foundPayment || spokenPayment(e, spokenText);
  let pay = said === null
    ? pickPaymentMethod(db, {
      aiMethod: e.payment_method, evident: false, history: cls.history, sub: cls.sub_category, readSource: 'text',
    })
    : pickSpokenPayment(db, { said, aiMethod: e.payment_method, history: cls.history, sub: cls.sub_category });
  if (foundPayment && pay.source && pay.source !== 'ai') pay = { ...pay, source: 'ai' };
  if (said === null && carriedPayment) {
    const carried = pickSpokenPayment(db, { said: carriedPayment, aiMethod: '', history: cls.history, sub: cls.sub_category });
    if (carried.payment_method) {
      pay = {
        payment_method: carried.payment_method,
        source: 'carried',
        warning: `말한 결제수단 '${carriedPayment}' 추천 — 이 건도 맞는지 확인해 주세요`,
      };
    }
  }

  const sources = { date: dateSource, ...cls.sources };
  if (money.event_id) sources.event = 'trip';
  if (pay.source) sources.payment_method = pay.source;

  // 말한 날짜를 쓸 수 없으면(앞날짜·없는 날짜) 오늘로 넣되 알린다 — 예약·예정을 오늘 거래로 조용히 넣지 않게 (I-022)
  const warnings = [...money.warnings];
  if (pay.warning) warnings.push(pay.warning);
  const spokenDate = String(e.date || '').trim();
  if (spokenDate && dateSource === 'today' && spokenDate !== date) {
    warnings.push(`말한 날짜(${spokenDate})를 쓸 수 없어 오늘로 넣었습니다`);
  }

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
    paymentSaid: said || '',
    paymentMentioned: said !== null, // 결제수단을 말했다 — 못 맞춰 비웠으면 입력 창도 습관으로 채우지 않는다
    budget_category: cls.budget_category,
    sub_category: cls.sub_category,
    items: [],
    historyDetail: cls.history?.detail || '',
    historyCount: cls.history?.cnt || 0,
    alternatives: cls.alternatives,
    categoryGuess: cls.categoryGuess,
    confidence: 'high',
    warnings,
    sources,
  };
}
