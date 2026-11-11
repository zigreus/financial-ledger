/**
 * 사진으로 입력 — 영수증 여러 장, 카드·페이 앱의 결제(이용) 내역 캡처를 한 번에 읽는다.
 *
 *  - 사진 몇 장이든 한 번의 AI 요청으로 보내고, 결제마다 한 건(entries)으로 받는다.
 *    영수증 한 장 = 한 건, 결제 내역 목록 한 장 = 보이는 결제 수만큼.
 *  - 한 건씩 기존 영수증 추천(buildSuggestion)으로 이 가계부에 맞춘다(입력 습관 > AI 추천, 목록에 없는 값은 버림).
 *  - 여러 건이면 확인 목록에서 고른다. 미리 체크하지 않는 것:
 *      · 가계부에 같은 날 같은 금액 거래가 이미 있음(내역을 계속 받아 겹치는 경우) — duplicateOf
 *      · 같은 사진 묶음에 같은 결제가 앞에 또 있음(겹쳐 찍음) — batchDuplicate
 *      · 날짜를 읽지 못했거나 앞날짜인 결제(화면 쪽 preChecked)
 *      · 같은 묶음에 취소 줄이 있는 결제 — pairedCancel
 *    취소·환불 줄은 넣지 않고 cancels로 알린다(이미 넣은 거래면 사용자가 지운다).
 */
import { analyzeWithAI, AIError } from './aiClient';
import { buildDataContext, buildSuggestion, normalizeName, resolveDate } from './receiptAssistant';
import { findExistingTransaction } from './cardSms';
import { todayStr } from './dateUtils';

const ENTRY = {
  type: 'object',
  properties: {
    date: { type: 'string', description: '결제일 YYYY-MM-DD. 보이지 않으면 빈 문자열' },
    merchant: { type: 'string', description: '가맹점(상호)명. 보이는 그대로' },
    total: { type: 'number', description: '이 결제의 최종 금액(할인 후, 부가세 포함). 숫자만, 취소도 양수' },
    currency: { type: 'string', description: 'ISO 4217 통화 코드. 한국 원화는 KRW' },
    is_cancel: { type: 'boolean', description: '취소·환불 건이면 true' },
    payment_hint: { type: 'string', description: '이 결제에 보이는 카드·결제 수단 그대로 (예: 현대카드 EV, 신한카드 1234, 현금). 없으면 빈 문자열' },
    payment_method: { type: 'string', description: '결제수단 목록 중 하나, 판단이 어려우면 "모름"' },
    category: { type: 'string', description: '"카테고리 > 세부카테고리" 목록 중 하나, 판단이 어려우면 "모름"' },
    detail: { type: 'string', description: '가계부 세부내역에 쓸 짧은 이름. 입력 습관에 같은 가게가 있으면 그 표기 그대로' },
    items: {
      type: 'array',
      description: '영수증이면 주요 품목(최대 15개), 결제 내역 목록이면 빈 배열',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, amount: { type: 'number' } },
        required: ['name', 'amount'],
      },
    },
    confidence: { type: 'string', description: 'high | medium | low — 금액·날짜를 확실히 읽었는지' },
  },
  required: ['date', 'merchant', 'total', 'currency', 'is_cancel', 'payment_hint', 'payment_method',
    'category', 'detail', 'items', 'confidence'],
};

const SCHEMA = {
  type: 'object',
  properties: {
    is_payment: { type: 'boolean', description: '영수증이나 결제(이용) 내역 사진이면 true' },
    kind: { type: 'string', description: 'receipt(영수증) | list(카드·은행·페이 앱의 결제 내역 목록) | mixed' },
    entries: { type: 'array', description: '결제 건 — 같은 결제는 한 번만', items: ENTRY },
    note: { type: 'string', description: '사용자에게 알릴 점(흐림, 잘린 화면, 합계 불확실 등). 없으면 빈 문자열' },
  },
  required: ['is_payment', 'kind', 'entries', 'note'],
};

const SYSTEM = [
  '당신은 한국 가계부 앱의 사진 입력 도우미입니다.',
  '영수증·카드 결제 내역 사진에서 실제로 보이는 결제만 빠짐없이, 중복 없이 옮기고, 보이지 않는 값은 지어내지 않습니다.',
  '분류(결제수단·카테고리)는 반드시 주어진 목록 안에서 고르고, 사용자의 기존 입력 습관을 우선합니다.',
].join(' ');

/** 사진 AI 지시문 (테스트·디버깅용으로 노출) */
export function buildPhotoPrompt(db, { photos = 1, today = todayStr() } = {}) {
  return [
    buildDataContext(db, today).text,
    '',
    `[첨부] 사진 ${photos}장. 세로로 긴 사진은 겹치게 잘라 여러 조각으로 보냈습니다.`,
    '',
    '[규칙]',
    '- 영수증이면 영수증 한 장이 entries 한 건. 긴 영수증을 여러 장·조각으로 나눠 찍었으면 한 건으로.',
    '- 카드사·은행·페이 앱의 결제(이용) 내역 목록이면 보이는 결제마다 한 건씩 빠짐없이. 겹쳐 찍은 부분의 같은 결제는 한 번만.',
    '- 소계·합계·결제예정금액·누적·포인트·청구할인·캐시백·안내 문구 줄은 넣지 않는다.',
    '- 카드 앱 위쪽 달력(주간·월간)의 날짜별 합계와 "결제일" 금액, 광고 배너는 결제가 아니다 — 넣지 않는다.',
    '- 목록은 날짜 머리글(예: "11. 8(일)") 아래에 그날 결제가 이어진다. 시각(20:26)·할부 표시는 날짜가 아니다.',
    '- 맨 위 결제들의 날짜 머리글이 스크롤로 잘려 안 보이면, 위쪽 달력에서 고른 날(동그라미 표시)의 날짜를 쓴다. 그것도 없으면 빈 문자열.',
    '- 가맹점이 "카카오페이 - 한살림서울협동조합"처럼 간편결제 이름과 함께 나오면 merchant는 실제 가게(한살림서울협동조합). "네이버페이"만 있으면 그대로.',
    '- 취소·환불 건은 is_cancel=true, total은 취소 금액(양수).',
    '- total은 실제로 낸 최종 금액. 할부는 결제한 총액. 쉼표·통화 기호 없이 숫자만.',
    '- 해외결제는 원화 청구 금액이 보이면 그 금액을 KRW로, 현지 금액만 보이면 그 통화와 금액으로.',
    '- 날짜가 안 보이면 빈 문자열. 연도가 없으면 오늘 기준 가장 가까운 과거 날짜.',
    '- 목록 위에 카드 이름이 한 번만 보이면 그 카드를 모든 결제의 payment_hint로.',
    '- payment_method·category는 위 목록의 표기 그대로, 애매하면 "모름". 카드 이름이 결제수단 목록의 하나와 같은 카드로 보이면 그 결제수단.',
    '- detail은 입력 습관에 같은 가게가 있으면 그 표기를 그대로, 없으면 짧은 상호명.',
    '- 영수증·결제 내역이 아니면 is_payment=false.',
  ].join('\n');
}

/**
 * 사진들(prepared.parts — imageUtils.preparePhotos)을 AI로 읽어 입력 추천을 만든다.
 * 반환: buildPhotoSuggestions 참고
 */
export async function analyzePhotos({ db, ai, parts, photos = 1, signal, onProgress, today = todayStr() }) {
  const raw = await analyzeWithAI({
    ai, system: SYSTEM, prompt: buildPhotoPrompt(db, { photos, today }), schema: SCHEMA,
    toolName: 'record_payments', description: '사진에서 읽은 결제를 기록한다',
    files: parts, signal, onProgress, maxTokens: 16000,
  });
  if (raw && raw.is_payment === false) {
    throw new AIError('영수증이나 결제 내역으로 보이지 않습니다 — 잘 보이게 다시 찍어 주세요', 'parse');
  }
  return buildPhotoSuggestions(db, raw || {}, { today });
}

const sameMerchant = (a, b) => {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return true; // 한쪽 이름을 못 읽었으면 금액·날짜로만 본다
  return x === y || (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x)));
};

/**
 * AI 응답 → { suggestions, cancels, kind, note }
 *  - suggestions: buildSuggestion 결과에 duplicateOf·batchDuplicate·pairedCancel을 붙인 것(원래 순서)
 *  - cancels: [{ date, merchant, amount, currency, paired }] — paired: 같은 묶음의 결제와 짝이 맞음
 * 결제 건 칸(entries)이 아예 없으면 오류 — 0건이면 "넣을 것 없음"으로 잘못 보인다.
 */
export function buildPhotoSuggestions(db, raw, { today = todayStr() } = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) {
    throw new AIError('사진 내용을 읽지 못했습니다 — 다시 시도해 주세요', 'parse');
  }
  const note = String(raw.note || '').trim();
  const entries = raw.entries.filter(e => e && typeof e === 'object');
  const approvals = entries.filter(e => !e.is_cancel && !(Number(e.total) < 0));
  const single = approvals.length === 1 && approvals.length === entries.length;

  const cancels = entries.filter(e => !approvals.includes(e)).map(e => {
    const { date } = resolveDate(e.date, today, 'receipt');
    const currency = /^[A-Za-z]{3}$/.test(String(e.currency || '').trim()) ? String(e.currency).trim().toUpperCase() : 'KRW';
    const value = Math.abs(Number(e.total)) || null;
    return {
      date,
      merchant: String(e.merchant || '').trim(),
      amount: currency === 'KRW' && value !== null ? Math.round(value) : null,
      foreignAmount: currency !== 'KRW' && value !== null ? value : null,
      currency,
      paired: false,
    };
  });

  const suggestions = approvals.map(e => {
    // 한 건만 읽었을 때만 알릴 점을 그 건의 경고로 — 여러 건이면 화면 위에 한 번만 보인다
    const s = buildSuggestion(db, { ...e, note: single ? note : '' }, { today });
    // 결제 내역 목록에는 품목이 없다 — AI가 넣었어도 여러 건이면 보이지 않는다
    if (!single) s.items = [];
    return s;
  });

  // 같은 묶음의 취소와 짝짓기 — 금액이 같고 가게가 같으며 취소보다 앞선(같은 날 포함) 결제, 한 건은 한 건하고만
  cancels.forEach(c => {
    if (c.amount === null) return;
    const hit = suggestions.find(s => !s.pairedCancel && s.amount === c.amount && s.date <= c.date && sameMerchant(s.merchant, c.merchant));
    if (hit) { hit.pairedCancel = true; c.paired = true; }
  });

  // 겹쳐 찍은 같은 결제 — 앞의 것만 미리 체크한다 (가게 이름이 같거나, 맞춘 세부내역·결제수단이 같으면 같은 결제로 본다)
  const seen = new Set();
  suggestions.forEach(s => {
    const keys = [
      ['m', s.date, s.amount, normalizeName(s.merchant || s.detail)].join('|'),
      ['d', s.date, s.amount, normalizeName(s.detail), s.payment_method].join('|'),
    ];
    if (s.amount !== null && keys.some(k => seen.has(k))) s.batchDuplicate = true;
    keys.forEach(k => seen.add(k));
    s.duplicateOf = findExistingTransaction(db, s);
  });

  return { suggestions, cancels, kind: String(raw.kind || ''), note };
}
