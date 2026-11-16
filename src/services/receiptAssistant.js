/**
 * AI 입력 추천 공통 + 영수증 → 거래 입력 추천.
 *
 * 1) AI에게 이 가계부의 결제수단·카테고리 목록, 사용자의 입력 습관, 여행 일정을 함께 보낸다.
 * 2) AI가 읽은 사실(날짜·가맹점·금액·통화·결제 흔적)과 분류 추천을 받는다.
 * 3) 기존 데이터로 다시 맞춘다 — 원문(사진·글)이 말한 것이 먼저이고, 예전 기록("이 가게를 예전에 어떻게 적었나")은
 *    원문이 말하지 않은 것만 채운다(classify, I-062). 목록에 없는 값은 버린다. 외화면 해당 통화의 여행 일정과 환율로 원화를 계산한다.
 * 각 항목에 근거(source)를 붙여 "이렇게 입력하시겠습니까?" 화면에서 보여준다.
 *
 * 영수증·말로 입력·카드 내역 대조가 아래 공통 함수(buildDataContext, classify,
 * pickPaymentMethod, resolveAmount, suggestionToTransaction)를 함께 쓴다.
 */
import {
  getPaymentMethods, getBudgetCategories, getSubCategories,
  getDetailPatterns, getBlankDetailHabits, getAutoPaymentMethod, getDiscountRules, evaluateDiscountRule,
  getCalendarEvents, getCalendarEventTypes, getTripDefaultCategory,
} from './dbManager';
import { today as todayStr } from './formulaEvaluator';
import { normalizeName } from './db/common';
import { isValidDateStr as isValidDate, addDays } from './dateUtils';

const UNKNOWN = '모름';
const PATTERN_LIMIT = 40;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export const SOURCE_LABEL = {
  receipt: '사진',
  text: '입력한 말',
  statement: '카드 내역',
  sms: '카드 문자',
  history: '기존 내역',
  ai: 'AI 추천',
  carried: '추천', // 말로 입력에서 다른 건에 말한 결제수단을 이 건에도 (B-096)
  trip: '여행 일정',
  today: '오늘 날짜',
};

// ── AI에게 보낼 가계부 정보 ──────────────────────────────────────

function tripEventsOf(db) {
  const tripTypes = new Set(getCalendarEventTypes(db).filter(t => t.is_trip_type).map(t => t.value));
  return getCalendarEvents(db).filter(ev => tripTypes.has(ev.event_type) && (ev.countries || []).length);
}

export function categoryPaths(db) {
  const paths = [];
  getBudgetCategories(db).forEach(cat => {
    const subs = getSubCategories(db, cat);
    if (subs.length) subs.forEach(sub => paths.push(`${cat} > ${sub}`));
    else paths.push(cat);
  });
  return paths;
}

const habitLine = p => `${p.detail} → ${p.budget_category}${p.sub_category ? ` > ${p.sub_category}` : ''} / ${p.payment_method} (${p.cnt})`;

// 간편결제·결제대행 이름 — 가게가 아니다. 이 이름만으로는 무엇을 샀는지·어느 카드인지 알 수 없다 (예: 네이버페이)
// (카드 명세서 대조는 '네이버페이 무신사'의 앞말을 떼는 따로 된 목록을 쓴다 — 앞말 떼기에는 '토스'처럼 짧은 이름을 넣을 수 없다)
// 같은 곳의 여러 표기는 한 묶음 — 첫 이름이 대표('N pay' → 네이버페이). '토스'(송금·토스 앱)는 결제대행 토스페이먼츠와 다른 묶음
const GATEWAY_GROUPS = [
  ['네이버페이', '네이버파이낸셜', 'naverpay', 'naverfinancial', 'npay', 'n페이'],
  ['카카오페이', 'kakaopay'],
  ['토스페이', 'tosspay'], ['토스페이먼츠', 'tosspayments'], ['토스', 'toss', '비바리퍼블리카'],
  ['페이코', 'nhn페이코', 'payco'], ['스마일페이', 'smilepay'], ['ssg페이', 'ssgpay'], ['쿠팡페이', 'coupangpay'],
  ['엘페이', 'lpay'], ['11페이', '11pay'], ['삼성페이', 'samsungpay'], ['애플페이', 'applepay'], ['구글페이', 'googlepay'],
  ['페이팔', 'paypal'], ['제로페이', 'zeropay'],
  ['이니시스', 'kg이니시스', '케이지이니시스', 'inicis'], ['한국사이버결제', 'kcp', 'nhnkcp'],
  ['나이스페이', '나이스페이먼츠', 'nicepay', 'nicepayments', '나이스정보통신'], ['다날', 'danal'],
  ['모빌리언스', 'kg모빌리언스'], ['페이레터'], ['헥토파이낸셜'], ['한국정보통신', 'kicc'], ['케이에스넷', 'ksnet'],
  ['스마트로', 'smartro'], ['세틀뱅크', 'settlebank'], ['갤럭시아머니트리'],
];
const GATEWAY_OF = new Map(GATEWAY_GROUPS.flatMap(names => names.map(n => [n, names[0]])));

/**
 * 간편결제·결제대행 이름이면 { spelling, group }, 아니면 null — '(주)카카오페이', '네이버페이 결제'처럼 회사 표시·'결제'가 붙어도.
 * spelling: 회사 표시·'결제'를 뗀 표기('네이버페이결제' → 네이버페이), group: 같은 곳의 대표 이름('N pay' → 네이버페이)
 */
function gatewayKey(name) {
  const n = normalizeName(name);
  if (!n) return null;
  const core = n.replace(/(간편결제|결제)$/, '').replace(/^(주식회사|주)/, '').replace(/(주식회사|주)$/, '');
  if (GATEWAY_OF.has(n)) return { spelling: n, group: GATEWAY_OF.get(n) };
  if (GATEWAY_OF.has(core)) return { spelling: core, group: GATEWAY_OF.get(core) };
  return null;
}

/** 간편결제·결제대행 이름이면 그 대표 이름, 아니면 '' */
const gatewayOf = name => gatewayKey(name)?.group || '';

/** 이름이 간편결제·결제대행 이름뿐인지 */
export function isPaymentGateway(name) {
  return !!gatewayOf(name);
}

/** 이름이 간편결제 이름으로 시작하는지 — '네이버페이 taptap', 'NAVER PAY 무신사' (첫 낱말 또는 첫 두 낱말) */
function startsWithGateway(name) {
  const words = String(name || '').split(/[^0-9a-zA-Z가-힣]+/).filter(Boolean);
  return words.length > 0 && (isPaymentGateway(words[0]) || (words.length > 1 && isPaymentGateway(`${words[0]}${words[1]}`)));
}

// 세부카테고리마다 AI에게 보일 예 — 이 사용자가 어떤 물건·가게를 어디에 넣는지 (I-064)
const CATEGORY_EXAMPLE_LIMIT = 5;
const EXAMPLE_MAX_LENGTH = 20;

/**
 * 세부카테고리마다 자주 적은 세부내역 몇 개 — [{ path, details }] (카테고리 목록 순서)
 * patterns: getDetailPatterns 결과(세부내역·분류·결제수단별 횟수) — 결제수단이 달라도 같은 세부내역은 합쳐 센다.
 * 간편결제 이름뿐인 것·카테고리 이름을 되풀이할 뿐인 것·글자가 없는 것(이모지뿐)은 예가 아니다.
 * skip: 이미 보낸 세부내역(정규화한 이름) — 지시문의 많이 쓴 입력 습관 줄에 분류와 함께 있어 되풀이하지 않는다
 */
export function categoryExamples(patterns, paths, { skip = new Set() } = {}) {
  const known = new Set(paths);
  const byPath = new Map();
  patterns.forEach((p) => {
    const path = p.sub_category ? `${p.budget_category} > ${p.sub_category}` : p.budget_category;
    const detail = String(p.detail || '').trim();
    if (!known.has(path) || !normalizeName(detail) || skip.has(normalizeName(detail))) return;
    if (isPaymentGateway(detail) || repeatsCategory(detail, p.budget_category, p.sub_category)) return;
    if (!byPath.has(path)) byPath.set(path, new Map());
    const counts = byPath.get(path);
    const key = normalizeName(detail);
    const had = counts.get(key);
    counts.set(key, { detail: had ? had.detail : detail, cnt: (had ? had.cnt : 0) + p.cnt });
  });
  return paths.filter(path => byPath.has(path)).map(path => ({
    path,
    details: [...byPath.get(path).values()].sort((a, b) => b.cnt - a.cnt).slice(0, CATEGORY_EXAMPLE_LIMIT).map(x => x.detail),
  }));
}

// 예로 보일 표기 — 길면 줄인다(글자 단위, 이모지를 반으로 자르지 않게)
const exampleText = (d) => {
  const chars = Array.from(d);
  return chars.length > EXAMPLE_MAX_LENGTH ? `${chars.slice(0, EXAMPLE_MAX_LENGTH).join('')}…` : d;
};
const exampleLine = ({ path, details }) => `${path}: ${details.map(exampleText).join(', ')}`;

/** 지시문에 보내는 세부카테고리마다의 예 — 많이 쓴 입력 습관(PATTERN_LIMIT) 줄에 이미 있는 것은 빼고 */
function examplesSent(allPatterns, paths) {
  const skip = new Set(allPatterns.slice(0, PATTERN_LIMIT).map(p => normalizeName(p.detail)));
  return categoryExamples(allPatterns, paths, { skip });
}

/**
 * 사용자가 사전에 동의한 범위(목록·입력 습관·여행 일정)만 담은 지시문 앞부분.
 * 영수증·말로 입력·카드 내역 대조가 함께 쓴다.
 * text(말로 입력·AI 명령의 글, 사진 설명)를 주면 글에 나온 이름의 예전 기록도 함께 보낸다 — AI가 판단 근거로 쓰게 (relatedPatterns, I-062)
 */
export function buildDataContext(db, today = todayStr(), { text = '' } = {}) {
  const methods = getPaymentMethods(db);
  const paths = categoryPaths(db);
  const allPatterns = getDetailPatterns(db);
  const patterns = allPatterns.slice(0, PATTERN_LIMIT);
  const related = text ? relatedIn(allPatterns, text) : [];
  const examples = examplesSent(allPatterns, paths);
  const blankHabits = getBlankDetailHabits(db);
  const trips = tripEventsOf(db).slice(0, 10);
  const dow = WEEKDAYS[new Date(`${today}T00:00:00`).getDay()];

  const lines = [
    `[오늘 날짜] ${today} (${dow}요일)`,
    '',
    `[결제수단 목록] ${methods.join(', ') || '(없음)'}`,
    '',
    '[카테고리 > 세부카테고리 목록]',
    ...paths,
    '',
    '[이 사용자의 입력 습관 — 세부내역 → 카테고리 / 결제수단 (횟수)]',
    ...(patterns.length ? patterns.map(habitLine) : ['(아직 없음)']),
    ...(related.length
      ? ['', '[사용자가 쓴 글에 나온 이름의 예전 기록 — 같은 형식, 위 목록에 없는 것]', ...related.map(habitLine)]
      : []),
    ...(examples.length
      ? ['', '[세부카테고리마다 이 사용자가 자주 적은 세부내역 — 어떤 물건·가게를 어디에 넣는지]', ...examples.map(exampleLine)]
      : []),
    '',
    '[예전 기록은 판단 근거입니다]',
    '같은 가게·물건이면 예전 기록의 표기·분류를 따르되, 사용자가 쓴 글이나 사진에 보이는 것(산 물건·용도)이 다르면 그것을 따른다.',
    ...(examples.length ? ['처음 보는 물건·가게는 세부카테고리마다의 예를 보고 이 사용자가 비슷한 것을 넣는 곳을 참고한다.'] : []),
    '',
    '[세부내역 — 꼭 채우지 않아도 됩니다]',
    '세부내역(detail)이 카테고리·세부카테고리 이름을 되풀이할 뿐이면 빈 문자열로 둔다 (예: 세부카테고리가 저녁인데 세부내역 "저녁"). 가게 이름·산 물건처럼 더 알려 주는 말이 있을 때만 적는다.',
    ...(blankHabits.length
      ? ['이 사용자가 보통 세부내역을 비워 두는 세부카테고리 (비운 횟수/전체):',
        ...blankHabits.map(h => `${h.budget_category} > ${h.sub_category} (${h.blank}/${h.total})`)]
      : []),
  ];
  if (trips.length) {
    lines.push('', '[여행 일정 — 외화 결제면 참고]');
    trips.forEach(ev => {
      const curs = ev.countries.map(c => c.currency).filter(Boolean).join('/');
      lines.push(`${ev.title} ${ev.date_from || ''}${ev.date_to ? `~${ev.date_to}` : ''} (${curs})`);
    });
  }
  return { methods, paths, patterns, text: lines.join('\n') };
}

// ── 기존 데이터로 맞추기 (공통) ──────────────────────────────────

export { normalizeName };

/** 추천 한 건을 가리키는 이름 — 세부내역, 없으면 가게, 그것도 없으면 세부카테고리 (세부내역은 비워 둘 수 있다, I-056) */
export const suggestionName = s => String(s?.detail || s?.merchant || s?.sub_category || '').trim();

// 정확히 같은 이름으로 찾은 습관의 점수 바닥 (matchHistory)
const EXACT_SCORE = 1e9;

// 이름의 낱말 구분 — normalizeName이 지우는 글자(공백·기호)
const NAME_SEPARATOR_RE = /[^0-9a-zA-Z가-힣ぁ-んァ-ン一-龥]+/;

/** 정규화한 이름과 그 안에서 낱말이 시작하는 자리 — '(주)이마트 성수점' → '주이마트성수점', {0, 1, 4} */
function nameWithStarts(raw) {
  const starts = new Set();
  let key = '';
  String(raw || '').split(NAME_SEPARATOR_RE).map(normalizeName).filter(Boolean).forEach((w) => {
    starts.add(key.length);
    key += w;
  });
  return { key, starts };
}

// 가맹점명과 세부내역이 얼마나 구체적으로 맞는지 — 정확히 같으면 가장 높고,
// 짧은 쪽이 긴 쪽의 낱말 첫머리부터 들어 있으면 겹치는 글자 수(= 짧은 쪽 길이)가 길수록 높다. 맞지 않으면 0.
// 낱말 가운데부터 겹치는 것은 다른 이름이다 — '오메가3'의 '메가', '이마트'의 '마트' (B-097)
function nameMatchLength(a, b) {
  if (a.key === b.key) return Infinity;
  const [long, short] = a.key.length >= b.key.length ? [a, b] : [b, a];
  for (let i = long.key.indexOf(short.key); i >= 0; i = long.key.indexOf(short.key, i + 1)) {
    if (long.starts.has(i)) return short.key.length;
  }
  return 0;
}

// 글에 나온 이름의 예전 기록을 AI에게 더 보낼 때의 최대 줄 수 (relatedPatterns)
const RELATED_LIMIT = 20;

/**
 * 사용자가 쓴 글에 나온 이름과 맞는 예전 기록(입력 습관 행) — 지시문의 입력 습관(많이 쓴 PATTERN_LIMIT개)에 없는 것만.
 * 글의 낱말과 이어 쓴 낱말 2~3개('메가 커피')를 matchHistory와 같은 규칙(같음·낱말 첫머리부터 포함)으로 맞춘다.
 * AI가 드문 가게도 예전 기록을 보고 판단하게 한다 (I-062)
 */
export function relatedPatterns(db, text) {
  return relatedIn(getDetailPatterns(db), text);
}

// relatedPatterns — 이미 읽은 입력 습관(patterns)에서
function relatedIn(patterns, text) {
  const words = String(text || '').split(NAME_SEPARATOR_RE).filter(Boolean);
  const keys = [];
  for (let i = 0; i < words.length; i += 1) {
    for (let j = i; j < words.length && j < i + 3; j += 1) {
      const said = words.slice(i, j + 1).join(' ');
      const k = nameWithStarts(said);
      // 간편결제 이름('네이버페이')은 가게가 아니다 — 그것으로 시작하는 다른 가게의 기록을 보내지 않는다 (B-099)
      if (k.key.length >= 2 && !isPaymentGateway(said)) keys.push(k);
    }
  }
  if (!keys.length) return [];
  const shown = new Set(patterns.slice(0, PATTERN_LIMIT).map(p => normalizeName(p.detail)));
  return patterns.slice(PATTERN_LIMIT).filter((p) => {
    const d = nameWithStarts(p.detail);
    // 간편결제 이름뿐인 기록('네이버페이')은 '네이버페이 수건'의 앞말에 걸려도 그 물건의 기록이 아니다
    return d.key.length >= 2 && !shown.has(d.key) && !isPaymentGateway(p.detail) && keys.some(k => nameMatchLength(k, d) > 0);
  }).slice(0, RELATED_LIMIT);
}

/**
 * 가맹점명으로 예전에 적어 둔 세부내역을 찾는다.
 * 더 구체적으로 맞는 것(정확히 같음 > 겹치는 글자가 긴 것)이 먼저이고, 횟수는 같은 수준끼리만 비교한다.
 * 예) "이마트 성수점" → "이마트", "(주)이마트" → "이마트" / "오메가3" → "메가"는 아니다 (낱말 가운데)
 * 반환: 패턴 행 + score (없으면 null)
 */
export function matchHistory(db, ...names) {
  return matchIn(getDetailPatterns(db), names);
}

// matchHistory — 이미 읽은 입력 습관(patterns)에서 (classify가 한 번만 읽게).
// 간편결제 이름뿐인 기록('네이버페이')은 가게가 아니라 '네이버페이 무신사'의 앞말에 걸려도 찾지 않는다 (B-099 — classify가 따로 본다)
function matchIn(patterns, names) {
  const keys = names.map(nameWithStarts).filter(k => k.key.length >= 2);
  if (!keys.length) return null;
  let best = null;
  patterns.forEach(p => {
    const d = nameWithStarts(p.detail);
    if (d.key.length < 2 || isPaymentGateway(p.detail)) return;
    const match = Math.max(...keys.map(k => nameMatchLength(k, d)));
    if (!match) return;
    // 구체성(정확 일치 1순위, 겹친 길이 2순위)을 먼저, 같은 수준이면 많이 쓴 순
    const score = (match === Infinity ? EXACT_SCORE : match * 1e5) + Math.min(p.cnt, 99999);
    if (!best || score > best.score) best = { ...p, score };
  });
  return best;
}

// 로컬 날짜 도우미는 dateUtils에 있다 — 다른 모듈이 이 이름으로 가져다 쓰므로 그대로 내보낸다
export { isValidDate, addDays };

/** 읽은 날짜가 올바르고 미래(하루 넘게)가 아니면 그 날짜, 아니면 오늘 */
export function resolveDate(raw, today, readSource) {
  if (isValidDate(raw) && raw <= addDays(today, 1)) return { date: raw, source: readSource };
  return { date: today, source: 'today' };
}

/** 외화 결제가 속할 여행 일정 — 날짜가 겹치는 일정, 없으면 가장 최근 일정 */
export function findTrip(db, currency, date) {
  const candidates = tripEventsOf(db)
    .map(ev => ({ ev, country: ev.countries.find(c => String(c.currency).trim().toUpperCase() === currency) }))
    .filter(x => x.country);
  if (!candidates.length) return null;
  const inRange = candidates.find(({ ev }) =>
    ev.date_from && date >= ev.date_from && date <= (ev.date_to || ev.date_from));
  if (inRange) return inRange;
  return candidates.sort((a, b) => (b.ev.date_from || '').localeCompare(a.ev.date_from || ''))[0];
}

/** 세부내역이 카테고리·세부카테고리 이름을 되풀이할 뿐인지 (공백·기호 무시) */
export function repeatsCategory(detail, cat, sub) {
  const d = normalizeName(detail);
  return !!d && (d === normalizeName(sub) || d === normalizeName(cat));
}

function splitPath(path, db) {
  const [cat, sub = ''] = String(path || '').split('>').map(s => s.trim());
  if (!cat || cat === UNKNOWN || !getBudgetCategories(db).includes(cat)) return null;
  const subs = getSubCategories(db, cat);
  return { cat, sub: subs.includes(sub) ? sub : '' };
}

/**
 * AI가 지시문(buildDataContext)에서 이 세부내역의 예전 기록을 보았는지 — 많이 쓴 PATTERN_LIMIT개,
 * promptText(말로 입력·AI 명령의 글)에 나온 이름이라 함께 보낸 것, 또는 세부카테고리마다의 예(그 분류로)
 */
function habitShownToAI(db, patterns, found, promptText) {
  const d = normalizeName(found.detail);
  const seen = p => normalizeName(p.detail) === d;
  if (patterns.slice(0, PATTERN_LIMIT).some(seen) || (!!promptText && relatedIn(patterns, promptText).some(seen))) return true;
  const path = found.sub_category ? `${found.budget_category} > ${found.sub_category}` : found.budget_category;
  // 줄여 보낸 예(EXAMPLE_MAX_LENGTH 넘음)는 AI가 앞부분만 보았다 — 본 것으로 치지 않는다
  return examplesSent(patterns, categoryPaths(db)).some(e => e.path === path
    && e.details.some(x => normalizeName(x) === d && Array.from(x).length <= EXAMPLE_MAX_LENGTH));
}

/**
 * 두 이름이 낱말 하나라도(두 글자 이상) 첫머리부터 겹치는지 — 어느 쪽이 길어도.
 * inside: a의 낱말이 b 안에 들어 있을 때만('LED 센서등' → 'LED 무선 센서등 21CM'), b의 짧은 낱말이 a의 앞머리인 것('김밥천국' ← '김밥')은 아님
 */
function sharesWord(a, b, { inside = false } = {}) {
  const target = nameWithStarts(b);
  if (!target.key) return false;
  return String(a || '').split(NAME_SEPARATOR_RE).some((w) => {
    const k = nameWithStarts(w);
    return k.key.length >= 2 && (!inside || k.key.length <= target.key.length) && nameMatchLength(k, target) > 0;
  });
}

// 가게 이름만 주는 갈래 — 카드 문자(AI 없음)·카드 명세서 대조. 산 것을 알 수 없어 같은 가게의 예전 기록이 판단이다
const NAMES_ONLY_SOURCES = new Set(['sms', 'statement']);

/**
 * 세부내역·카테고리 — 원문(사진·영수증·사용자가 쓴 글)이 말한 것이 예전 기록보다 먼저다 (사용자 결정, I-062).
 * 예전 기록(입력 습관)은 원문이 말하지 않은 것만 채운다:
 *  - 세부내역: 원문이 같은 이름을 말했거나 가게 이름만 말했을 때(카드 문자·카드 내역, 보통의 사진은 세부내역이 가게 이름이다)
 *    그 가게를 예전에 적은 표기로('(주)이마트 성수점' → '이마트'). 원문이 더 말했으면('스타벅스' + '텀블러') 원문 그대로.
 *    사진에서 AI가 세부내역에 산 것을 적었으면(가게가 간편결제 이름뿐인 주문 화면, 품목 이름과 겹침) 그것도 원문이다 (B-099)
 *  - 간편결제 이름('네이버페이')은 가게가 아니라 그 이름으로 예전 기록을 찾지 않는다 — '네이버페이 taptap'은 다른 가게다.
 *    간편결제 이름 말고 아무것도 없으면(카드 문자 등) 예전에 그 이름 그대로 적은 기록만 본다 (B-099)
 *  - 카테고리: AI가 원문을 읽고 고른 것이 먼저. 예전 기록은 AI가 못 골랐을 때, 또는 원문이 같은 곳을 말했는데
 *    AI가 그 습관을 지시문에서 보지 못해 짐작했을 때만. AI가 습관을 보고도 달리 골랐으면 원문 때문이다('영양제', '선물')
 *  - 가게 이름만 주는 갈래(카드 문자·카드 명세서 대조)는 산 것을 알 수 없어 같은 가게의 예전 기록이 판단이다
 *  - 말로 입력에서 가게와 산 것을 함께 말했으면 산 것의 예전 기록을 먼저 찾는다('이마트 우유' → '우유')
 * 여행 일정이면 여행 카테고리 안에서(예전 기록이 여행 카테고리 안이면 그 세부카테고리를 살린다).
 * promptText: 말로 입력·AI 명령의 글, 사진과 함께 보낸 설명 — 지시문에 글에 나온 이름의 예전 기록도 보냈다(relatedPatterns)
 * aiAltCategory: AI가 헷갈릴 때 준 2순위 분류
 * items: 사진에서 읽은 품목 이름들 — 세부내역이 산 것인지 가늠한다
 * 반환: { detail, budget_category, sub_category, history, alternatives, categoryGuess, sources: { detail, category } }
 *  - history: 원문과 같은 것을 가리키는 예전 기록일 때만 (결제수단 습관·바로 넣기·'예전에 N번' 안내가 쓴다)
 *  - alternatives: 다른 후보 [{ kind: first|past|ai|second, detail, budget_category, sub_category, cnt?, ... }]
 *    — 화면이 지금 분류와 다른 것을 '이걸로'와 함께 보인다(otherAlternatives). 후보가 고른 것 하나뿐이면 빈 배열
 *  - categoryGuess: AI가 판단한 분류가 아니라 예전 기록으로 채웠다(AI가 못 골랐거나 습관을 못 봤음) — 바로 넣지 않는다
 */
export function classify(db, {
  merchant, detail, aiCategory, aiAltCategory = '', eventId, readSource = 'receipt', promptText = '', items = [],
}) {
  const patterns = getDetailPatterns(db);
  // AI가 고른 카테고리 이름을 되풀이한 세부내역('저녁' → 식비 > 저녁)은 가게 이름이 아니다 —
  // 예전에 똑같이 적은 것만 습관으로 보고, 겹치는 글자로는 찾지 않는다('저녁'이 '저녁회식'에 걸리지 않게)
  const aiPath = splitPath(aiCategory, db);
  const generic = name => !!aiPath && repeatsCategory(name, aiPath.cat, aiPath.sub);
  const notGeneric = name => (generic(name) ? '' : name);
  // 가게가 간편결제 이름뿐인 결제(네이버페이 주문 화면·내역 줄)
  const viaGateway = isPaymentGateway(merchant);
  // 예전 기록을 찾는 이름 — 간편결제 이름('네이버페이')은 가게가 아니라 빼고 본다. 사진에서 가게가 간편결제 이름뿐인데
  // 세부내역도 간편결제 이름으로 시작하면('네이버페이 taptap' — AI가 예전 기록을 따라 적은 것) 산 것을 말하지 않는다 (B-099).
  // 말로 입력은 사용자가 쓴 말이라('카카오페이 멜론') 그대로 찾는다
  const echoed = name => readSource === 'receipt' && viaGateway && startsWithGateway(name);
  const named = name => (isPaymentGateway(name) || echoed(name) ? '' : notGeneric(name));
  // 원문이 이 건을 부르는 이름 — 카테고리 이름을 되풀이한 말('스타벅스' + '커피')·간편결제 이름은 빼고 본다
  const ownDetail = normalizeName(named(detail));
  const ownMerchant = normalizeName(named(merchant));
  const itemNames = (Array.isArray(items) ? items : []).map(String).filter(Boolean);
  const inItems = name => itemNames.some(n => sharesWord(name, n, { inside: true }));
  // 사진에서 AI가 세부내역에 가게 대신 산 것을 적었는지 — 가게가 간편결제 이름뿐인 주문 화면이거나(지시문이 그때 상품 이름을 적게 한다),
  // 사용자 설명이 있고('세부내역에는 물품명') 세부내역이 가게 이름과 겹치지 않으며 그 낱말이 품목 이름 안에 있다.
  // 설명이 없으면 지시문대로 상호다 — 'CU' + 품목 'CU 종량제봉투', '김밥천국' + 품목 '김밥'을 산 것으로 보지 않게
  const itemDetail = readSource === 'receipt' && !!ownDetail && (viaGateway
    || (!!String(promptText || '').trim() && !sharesWord(detail, merchant) && inItems(detail)));
  // 간편결제 이름뿐인 결제에서 산 것을 아는지 (사진 화면의 '수정 필요') — known: 세부내역에 산 것을 적음,
  // check: 품목은 보이는데 세부내역이 비었거나 간편결제 이름(으로 시작 — 예전 기록을 따라 적음)뿐, unknown: 아무것도 없음.
  // 짧게 줄인 상품 이름('수건' ← '코튼순면호텔수건', '청소기' ← '무선청소기 V12')은 품목 이름과 글자가 맞지 않아도 산 것이다
  let gatewayBought = '';
  if (viaGateway) gatewayBought = ownDetail ? 'known' : (itemNames.length ? 'check' : 'unknown');
  // 가게와 산 것을 함께 말했으면(말로 입력) 또는 사진의 세부내역이 산 것이면 산 것의 예전 기록이 먼저다 ('이마트 우유' → 예전의 '우유').
  // 산 것 자체이거나 그 안의 낱말인 기록만 — '커피'가 더 긴 다른 기록('커피 원두')을 잡아 가게의 기록을 밀어내지 않게
  const itemNamed = !!ownDetail && ownDetail !== ownMerchant && (itemDetail || (readSource === 'text' && !!normalizeName(merchant)));
  const byItem = itemNamed ? matchIn(patterns, [named(detail)]) : null;
  const itemOk = !!byItem && normalizeName(byItem.detail).length <= ownDetail.length;
  let found = (itemOk && byItem) || matchIn(patterns, [named(merchant), named(detail)]);
  if (!found) {
    const exact = matchIn(patterns, [merchant, detail].filter(generic));
    if (exact && exact.score >= EXACT_SCORE) found = exact;
  }
  // 간편결제 이름 말고 아무것도 없는 건(카드 문자·상품 없는 내역 줄)은 예전에 그 간편결제 이름으로 적은 기록만 —
  // 같은 표기('네이버페이결제' → 네이버페이)가 먼저, 없으면 같은 곳의 다른 표기('N pay').
  // 이름으로 시작하는 다른 가게의 기록('네이버페이 taptap')은 아니다
  const saysNothingElse = [merchant, detail].every(n => !normalizeName(n) || isPaymentGateway(n) || generic(n));
  if (!found && saysNothingElse && !itemNames.length) {
    const keys = [merchant, detail].map(gatewayKey).filter(Boolean);
    const sameAs = (pick) => {
      const k = gatewayKey(pick.detail);
      return k && keys.some(x => x.spelling === k.spelling);
    };
    const sameGroup = (pick) => {
      const k = gatewayKey(pick.detail);
      return k && keys.some(x => x.group === k.group);
    };
    if (keys.length) found = patterns.find(sameAs) || patterns.find(sameGroup) || null;
  }
  const sources = {};

  // 원문이 가게 이름만 말했는지 — 말로 입력은 세부내역이 없거나 가게 이름과 같을 때, 사진은 세부내역이 산 것이 아닐 때
  const placeOnly = readSource === 'text' ? !ownDetail || ownDetail === ownMerchant : !itemDetail;
  // 찾은 예전 기록이 원문이 말한 것과 같은 것인지 — 같은 이름이거나, 원문이 가게 이름만 말했다
  const same = !!found && (placeOnly || normalizeName(found.detail) === ownDetail);

  let outDetail = ((same && found.detail) || notGeneric(detail) || notGeneric(merchant) || '').trim();
  sources.detail = same ? 'history' : readSource;

  const pastCategory = found && getBudgetCategories(db).includes(found.budget_category)
    ? {
      cat: found.budget_category,
      sub: getSubCategories(db, found.budget_category).includes(found.sub_category) ? found.sub_category : '',
    }
    : null;
  const tripCategory = eventId ? getTripDefaultCategory(db) : '';
  const agrees = !!pastCategory && !!aiPath && aiPath.cat === pastCategory.cat && (!aiPath.sub || aiPath.sub === pastCategory.sub);
  const namesOnly = NAMES_ONLY_SOURCES.has(readSource);
  // 여행 일정의 결제인데 AI는 여행 카테고리 밖을 골랐고 예전 기록은 여행 카테고리 안이면 — 그 세부카테고리를 살린다
  const tripPast = !!tripCategory && pastCategory?.cat === tripCategory && aiPath?.cat !== tripCategory;
  let category = null;
  if (pastCategory && (!aiPath || agrees || namesOnly || tripPast || (same && !habitShownToAI(db, patterns, found, promptText)))) {
    category = pastCategory;
    sources.category = 'history';
  } else if (aiPath) {
    category = aiPath;
    sources.category = 'ai';
  }
  // 결제수단 습관·바로 넣기·'예전에 N번'이 쓰는 예전 기록 — 원문과 같은 것, 또는 원문이 그 가게 이름으로 시작하고
  // AI가 고른 분류도 그 가게의 것과 같을 때('스타벅스 아메리카노' + 카페 ↔ 예전 '스타벅스' 카페). 세부내역은 말한 대로 둔다
  const sameStore = !!found && agrees && [ownMerchant, ownDetail].some(n => !!n && n.startsWith(normalizeName(found.detail)));
  const history = same || sameStore ? found : null;
  if (tripCategory && (!category || category.cat !== tripCategory)) {
    const subs = getSubCategories(db, tripCategory);
    category = { cat: tripCategory, sub: category && subs.includes(category.sub) ? category.sub : '' };
    sources.category = 'trip';
  }

  const baseDetail = outDetail;
  // 세부내역은 꼭 채우지 않는다 — 고른 카테고리 이름을 되풀이할 뿐이면 비운다 (I-056)
  if (category && repeatsCategory(outDetail, category.cat, category.sub)) outDetail = '';
  if (!outDetail) delete sources.detail;

  // 가게 이름만 주는 갈래(카드 문자·명세서)는 예전 기록이 곧 판단이다 — AI가 원문을 읽는 갈래에서만 짐작으로 본다
  const categoryGuess = sources.category === 'history' && !agrees && !namesOnly;

  // 다른 후보 — 처음 고른 것(되돌릴 수 있게), 예전 기록, AI의 1순위, AI가 헷갈릴 때 준 2순위. 분류가 같은 것은 앞의 것 하나만.
  // 여행 일정의 결제는 여행 카테고리 안의 것만 (I-062)
  const alternatives = [];
  const add = (kind, path, d, extra) => {
    if (!path || (tripCategory && path.cat !== tripCategory)) return;
    if (alternatives.some(o => o.budget_category === path.cat && o.sub_category === path.sub)) return;
    const shown = repeatsCategory(d, path.cat, path.sub) ? '' : d;
    const o = {
      kind, budget_category: path.cat, sub_category: path.sub, detail: shown,
      historyDetail: history?.detail || '', historyCount: history?.cnt || 0, detailSource: same ? 'history' : readSource, ...extra,
    };
    if (!o.detail) o.detailSource = null;
    alternatives.push(o);
  };
  if (category) add('first', category, outDetail, { categorySource: sources.category, detailSource: sources.detail || null });
  if (pastCategory) {
    add('past', pastCategory, found.detail, {
      cnt: found.cnt, historyDetail: found.detail, historyCount: found.cnt, detailSource: 'history', categorySource: 'history',
    });
  }
  add('ai', aiPath, baseDetail, { categorySource: 'ai' });
  add('second', splitPath(aiAltCategory, db), baseDetail, { categorySource: 'ai' });
  if (!alternatives.some(o => o.kind !== 'first')) alternatives.length = 0;

  return {
    detail: outDetail,
    budget_category: category?.cat || '',
    sub_category: category?.sub || '',
    history,
    alternatives,
    categoryGuess,
    gatewayBought,
    sources,
  };
}

/** 다른 후보의 이름표 */
export const ALTERNATIVE_LABEL = { first: '처음 추천', past: '예전 기록', ai: 'AI 추천', second: '2순위' };

/** 지금 분류와 다른 후보만 — 화면에 보일 것 */
export function otherAlternatives(s) {
  return (s?.alternatives || []).filter(o => o.budget_category !== s.budget_category || o.sub_category !== s.sub_category);
}

/**
 * 후보로 바꿀 값 (목록의 고치기와 같은 patch) — 후보 목록은 그대로 두어 다시 바꾸거나 되돌릴 수 있다.
 * 세부내역은 사용자가 직접 고치지 않았을 때(지금 세부내역이 후보 중 하나의 것)만 그 후보의 것으로 바꾼다
 */
export function alternativePatch(s, o) {
  const patch = { budget_category: o.budget_category, sub_category: o.sub_category, categoryGuess: false };
  const untouched = (s.alternatives || []).some(a => (a.detail || '') === (s.detail || ''));
  if (untouched) Object.assign(patch, { detail: o.detail, historyDetail: o.historyDetail, historyCount: o.historyCount });
  return patch;
}

/** 한 건 추천을 후보로 바꾼다 — 근거 표시도 그 후보의 것으로 */
export function applyAlternative(s, o) {
  const patch = alternativePatch(s, o);
  const sources = { ...s.sources, category: o.categorySource };
  if (!sources.category) delete sources.category;
  if ('detail' in patch) {
    if (o.detailSource) sources.detail = o.detailSource;
    else delete sources.detail;
  }
  return { ...s, ...patch, sources };
}

/** 결제수단 — 원문에 드러난 것 > 예전 습관 > 세부카테고리 패턴 */
export function pickPaymentMethod(db, { aiMethod, evident, history, sub, readSource = 'receipt' }) {
  const methods = getPaymentMethods(db);
  if (methods.includes(aiMethod)) return { payment_method: aiMethod, source: evident ? readSource : 'ai' };
  if (history && methods.includes(history.payment_method)) return { payment_method: history.payment_method, source: 'history' };
  if (sub) {
    const auto = getAutoPaymentMethod(db, sub);
    if (auto) return { payment_method: auto, source: 'history' };
  }
  return { payment_method: '', source: null };
}

// 결제수단 이름 끝의 흔한 말 — '현대카드'를 '현대'로 줄여 목록의 '현대M'과도 맞춰 본다
const PAYMENT_SUFFIX_RE = /(체크카드|신용카드|카드|체크|페이|pay)$/;
// 간편결제(삼성페이·카카오페이)는 어느 카드로도 낼 수 있어 줄여 맞추지 않는다 — '삼성페이'를 삼성카드로 보지 않게
const PAY_APP_RE = /(페이|pay)$/;
const paymentWords = name => String(name || '').split(/[^0-9a-zA-Z가-힣]+/).map(normalizeName).filter(Boolean);
// 이름을 가르는 낱말 — '카드'·'체크' 같은 종류 말과 한 글자는 빼고 센다 ('신한 카드'는 낱말 하나 '신한')
const GENERIC_WORD_RE = /^(체크카드|신용카드|카드|체크|페이|pay)$/;
const nameWords = name => paymentWords(name).filter(w => w.length >= 2 && !GENERIC_WORD_RE.test(w));

/**
 * 말한 표현과 결제수단 이름이 얼마나 맞는지 (B-096)
 *  3: 같음 / 2.5: 낱말이 여럿인 이름의 낱말이 모두 말에 있음('아내 신한카드' ↔ '신한카드(아내)', 순서는 상관없음 —
 *     '카드' 같은 종류 말은 낱말로 세지 않는다: '신한 카드'는 '신한체크카드'와 낱말이 다 맞는 것이 아니다)
 *  2: 한쪽이 다른 쪽을 통째로 품음('현대카드' ↔ '현대카드M', '신한' ↔ '신한카드')
 *  1: 줄인 이름(두 글자 이상)만 겹침('국민카드' ↔ '국민행복카드', '현대카드' ↔ '현대M') / 0: 아님
 * '카드'처럼 이름 없이 종류만 있는 결제수단은 말한 표현에 들어 있어도 맞는다고 보지 않는다.
 * 간편결제('삼성페이')는 간편결제 이름만 품는다 — 목록의 '삼성'·'삼성카드'가 아니다.
 */
export function paymentMatch(said, method) {
  const s = normalizeName(said);
  const m = normalizeName(method);
  if (!s || !m) return 0;
  if (s === m) return 3;
  const sw = nameWords(said);
  const mw = nameWords(method);
  if ((mw.length > 1 && mw.every(w => s.includes(w))) || (sw.length > 1 && sw.every(w => m.includes(w)))) return 2.5;
  const sCore = s.replace(PAYMENT_SUFFIX_RE, '');
  const mCore = m.replace(PAYMENT_SUFFIX_RE, '');
  const payApp = PAY_APP_RE.test(s);
  if ((sCore && m.includes(s)) || (mCore && s.includes(m) && (!payApp || PAY_APP_RE.test(m)))) return 2;
  if (payApp) return 0;
  return (sCore.length >= 2 && m.includes(sCore)) || (mCore.length >= 2 && s.includes(mCore)) ? 1 : 0;
}

/** 글에 그 결제수단 표현이 있는지 — 낱말(붙여 쓴 것 포함)이 그 표현과 2 이상 맞을 때. AI가 지어낸 표현을 믿지 않게 */
export function saidInText(text, phrase) {
  const p = normalizeName(phrase);
  if (!p) return false;
  if (normalizeName(text).includes(p)) return true;
  const words = paymentWords(text);
  for (let i = 0; i < words.length; i += 1) {
    let joined = '';
    for (let j = i; j < words.length && j < i + 3; j += 1) {
      joined += words[j];
      if (joined.replace(PAYMENT_SUFFIX_RE, '').length >= 2 && paymentMatch(joined, phrase) >= 2) return true;
    }
  }
  return false;
}

/** 말로 입력·AI 명령의 세부내역 칸 — 가게 이름만 말했을 때만 습관 표기, 산 물건·용도를 말했으면 그 말 (I-062) */
export const DETAIL_SAID_DESCRIPTION = '가계부 세부내역 — 가게 이름만 말했으면 입력 습관의 표기로, 산 물건·용도도 말했으면 가게와 함께 짧게 (예: "스타벅스 텀블러"). 카테고리 이름을 되풀이할 뿐이면 빈 문자열';

/** 2순위 카테고리 칸(category_alt) — 헷갈릴 때만. 앱이 화면에 '2순위'로 보여 고르게 한다 (말로 입력·사진, I-062) */
export const CATEGORY_ALT_DESCRIPTION = '카테고리가 헷갈리면 두 번째로 맞을 만한 "카테고리 > 세부카테고리"(목록 표기 그대로, category와 다른 것). 확실하면 빈 문자열';
/** 지시문의 2순위 규칙 */
export const CATEGORY_ALT_RULE = '- category는 가장 맞는 것 하나. 두 가지 사이에서 헷갈리면 category_alt에 두 번째로 맞을 만한 것을 적고, 확실하면 빈 문자열.';

/** 말한 결제수단 표현 칸(payment_said) — 앱이 목록과 직접 맞춘다 (말로 입력·AI 명령의 새 거래) */
export const PAYMENT_SAID_DESCRIPTION = '사용자가 결제수단을 말했으면 말한 그대로 (예: "현대카드", "신한", "현금"). 말하지 않았으면 빈 문자열';
/** 지시문의 결제수단 규칙 (말로 입력·AI 명령) */
export const PAYMENT_SAID_RULE = '- 결제수단을 말했으면 payment_said에 말한 그대로 적고, payment_method는 그 말에 맞는 목록 표기를 고른다. 말한 결제수단을 입력 습관의 결제수단으로 바꾸지 않고, 맞는 것이 없으면 "모름".';

// 말한 결제수단에 대한 알림 머리말 (isSpokenPaymentWarning)
const SPOKEN_PAYMENT_WARNING = '말한 결제수단';

/**
 * 사용자가 결제수단을 말했을 때(말로 입력) — 말한 것이 예전 습관보다 먼저다 (B-096).
 * 말한 표현(said)을 앱이 목록과 직접 맞추고(paymentMatch), AI가 고른 것·습관은 그 말과 맞을 때만 쓴다
 * — AI가 습관의 카드를 골랐거나 목록 표기와 달라 못 맞췄어도 다른 카드로 채우지 않게.
 *  - AI가 고른 것이 가장 잘 맞거나, 같은 이름이 따로 없고 늘 쓰던 것도 아니면: 그것 (여럿 중에서는 AI가 글의 앞뒤를 보고 고른다)
 *  - 가장 잘 맞는 이름이 하나면 그것. 줄인 이름만 겹치는데 AI가 다른 것을 골랐으면 AI가 고른 것('국민카드' → KB카드일 수 있다)
 *  - 여럿('신한' → 신한카드·신한체크): 통째로 맞는 것 중 늘 쓰던 것 > 비우고 묻는다
 *  - 맞는 이름이 없으면: AI가 고른 것은 이름이 달라도 그것일 수 있어('농협' → NH체크) 그것, 늘 쓰던 것이면 비운다
 *  - 고른 것이 말과 통째로 맞지 않으면(위의 짐작들) 'ai'와 '확인해 주세요' 알림을 붙인다
 *  - '카드'처럼 어느 것인지 말하지 않았으면 그런 이름 중에서 짐작하고(AI > 습관) 확인받는다
 * 바로 넣기는 말한 표현과 통째로 맞는(2 이상) 결제수단만 한다 — quickEntry.
 * 반환: { payment_method, source, warning? }
 */
export function pickSpokenPayment(db, { said, aiMethod, history, sub }) {
  const methods = getPaymentMethods(db);
  const label = String(said || '').trim();
  const word = normalizeName(label);
  const blank = why => ({ payment_method: '', source: null, warning: `${SPOKEN_PAYMENT_WARNING}${label ? ` '${label}'` : ''}${why} — 골라 주세요` });
  const unsure = method => ({ payment_method: method, source: 'ai', warning: `${SPOKEN_PAYMENT_WARNING} '${label}'에 맞는지 확인해 주세요` });
  if (!word) return blank('을 알아듣지 못했어요');
  const aiPick = methods.includes(aiMethod) ? aiMethod : '';
  const habits = [history?.payment_method, sub ? getAutoPaymentMethod(db, sub) : null].filter(m => m && methods.includes(m));

  if (!word.replace(PAYMENT_SUFFIX_RE, '') && !methods.some(m => normalizeName(m) === word)) {
    const pool = methods.filter(m => normalizeName(m).includes(word));
    if (pool.includes(aiPick)) return { payment_method: aiPick, source: 'ai' };
    const habit = habits.find(h => pool.includes(h));
    if (habit) return { payment_method: habit, source: 'history' };
    if (pool.length === 1) return { payment_method: pool[0], source: 'ai' };
    return blank(pool.length ? '에 맞는 것이 여럿이에요' : '에 맞는 것이 목록에 없어요');
  }

  const score = new Map(methods.map(m => [m, paymentMatch(label, m)]));
  const best = Math.max(0, ...score.values());
  const top = best ? methods.filter(m => score.get(m) === best) : [];
  const aiScore = aiPick ? score.get(aiPick) : 0;
  const aiIsHabit = habits.includes(aiPick);
  let pick;
  if (aiScore && (aiIsHabit ? aiScore === best && best >= 2 : aiScore === best || best < 3)) pick = aiPick;
  else if (top.length === 1) pick = best < 2 && aiPick && !aiIsHabit ? aiPick : top[0];
  else if (top.length > 1) {
    const habit = best >= 2 && habits.find(h => top.includes(h));
    return habit ? { payment_method: habit, source: 'history' } : blank('에 맞는 것이 여럿이에요');
  } else if (aiPick && !aiIsHabit) pick = aiPick;
  else return blank('에 맞는 것이 목록에 없어요');
  // 통째로 맞지 않으면(줄인 이름만 겹치거나 AI가 다른 이름으로 고름) 그 말을 가리키는지 확실하지 않다 — 확인받는다
  return score.get(pick) >= 2 ? { payment_method: pick, source: 'text' } : unsure(pick);
}

/** 말한 결제수단에 대한 알림인지 — 목록에서 결제수단을 고르면 지운다 */
export const isSpokenPaymentWarning = w => String(w || '').startsWith(SPOKEN_PAYMENT_WARNING);

/** 같은 결제수단 표현인지 — '신한'과 '신한카드'처럼 끝말만 다르면 같다 (덧붙여 다시 정리할 때 말이 바뀌었는지 본다) */
export const samePaymentPhrase = (a, b) => normalizeName(a).replace(PAYMENT_SUFFIX_RE, '') === normalizeName(b).replace(PAYMENT_SUFFIX_RE, '');

/**
 * 금액·통화 → 원화 금액, 외화면 여행 일정·환율까지.
 * 반환: { amount, currency, foreignAmount, rate, event_id, eventTitle, warnings }
 */
export function resolveAmount(db, { total, currency: rawCurrency, date }) {
  const warnings = [];
  const currency = /^[A-Za-z]{3}$/.test(String(rawCurrency || '').trim())
    ? String(rawCurrency).trim().toUpperCase() : 'KRW';
  const value = Number(total) > 0 ? Number(total) : null;
  const out = { amount: null, currency, foreignAmount: null, rate: 0, event_id: null, eventTitle: '', warnings };

  if (value === null) {
    warnings.push('금액을 읽지 못했습니다 — 직접 입력하세요');
  } else if (currency === 'KRW') {
    out.amount = Math.round(value);
  } else {
    out.foreignAmount = Math.round(value * 100) / 100;
    const trip = findTrip(db, currency, date);
    if (trip) {
      out.event_id = trip.ev.id;
      out.eventTitle = trip.ev.title;
      out.rate = Number(trip.country.exchange_rate) || 0;
      if (out.rate > 0) out.amount = Math.round(out.foreignAmount * out.rate);
      else warnings.push(`'${out.eventTitle}' 일정에 ${currency} 환율이 없어 원화 금액은 직접 입력해야 합니다`);
    } else {
      warnings.push(`${currency} 결제지만 이 통화의 여행 일정이 없습니다 — 원화 금액을 직접 입력하세요`);
    }
  }
  return out;
}

/** 바로 저장할 수 있을 만큼 채워졌는지 (폼의 필수 항목과 같음) */
export function isSuggestionComplete(s) {
  return !!(s && s.payment_method && s.budget_category && s.sub_category && s.amount !== null && s.amount !== undefined);
}

/** 추천을 저장용 거래로 — 할인은 폼과 같은 결제수단 규칙으로 계산 */
export function suggestionToTransaction(db, s) {
  const discount = s.payment_method && s.payment_method !== '현금'
    ? evaluateDiscountRule(getDiscountRules(db, s.payment_method), s.budget_category, s.sub_category, s.amount, s.detail)
    : 0;
  return {
    payment_method: s.payment_method,
    date: s.date,
    budget_category: s.budget_category,
    sub_category: s.sub_category,
    detail: s.detail || '',
    amount: s.amount,
    discount_amount: discount > 0 ? discount : 0,
    event_id: s.event_id || null,
    foreign_amounts: s.event_id && s.foreignAmount !== null ? { [s.currency]: s.foreignAmount } : {},
  };
}

// ── 영수증 (사진 읽기는 services/photoEntry) ─────────────────────

/** AI가 금액·날짜를 확실히 읽지 못했다고 할 때(confidence low)의 알림 */
export const LOW_CONFIDENCE_WARNING = '확실히 읽지 못한 값이 있어요 — 금액과 날짜를 꼭 확인하세요';

/**
 * 영수증 AI 응답을 이 가계부 데이터에 맞춘 입력 추천으로 바꾼다.
 * 반환값의 sources는 항목별 근거 (SOURCE_LABEL 키).
 * promptText: 사진과 함께 보낸 사용자 설명(I-063) — 지시문에 설명에 나온 이름의 예전 기록도 보냈다(classify 참고)
 * 간편결제(네이버페이 등)로 낸 결제인데 연결한 카드가 사진에 없으면 결제수단을 짐작하지 않고 비워 둔다 —
 * unseenCard(간편결제 이름)로 알려 사진 화면이 결제수단만 묻게 한다 (B-099)
 */
export function buildSuggestion(db, raw, { today = todayStr(), promptText = '' } = {}) {
  const { date, source: dateSource } = resolveDate(raw.date, today, 'receipt');
  const money = resolveAmount(db, { total: raw.total, currency: raw.currency, date });
  const items = Array.isArray(raw.items)
    ? raw.items.filter(i => i && i.name).slice(0, 15).map(i => ({ name: String(i.name), amount: Number(i.amount) || 0 }))
    : [];
  const cls = classify(db, {
    merchant: raw.merchant, detail: raw.detail, aiCategory: raw.category, aiAltCategory: raw.category_alt, eventId: money.event_id,
    promptText, items: items.map(i => i.name),
  });
  const hint = String(raw.payment_hint || '').trim();
  let pay = pickPaymentMethod(db, {
    aiMethod: raw.payment_method, evident: !!hint, history: cls.history, sub: cls.sub_category,
  });
  // 보이는 결제 흔적이 간편결제 이름뿐이면(또는 아무것도 없는데 가게가 간편결제) 어느 카드인지 모른다 —
  // AI가 그 간편결제 자체인 결제수단(목록의 '네이버페이' 등 — 'N pay'를 보고)을 고른 게 아니면 비운다.
  // '네이버페이 현대카드'처럼 카드 이름이 붙은 결제수단은 간편결제 자체가 아니라 카드 짐작이다
  const via = isPaymentGateway(hint) ? hint : (!hint && isPaymentGateway(raw.merchant) ? String(raw.merchant).trim() : '');
  const payItself = !!via && !!pay.payment_method && gatewayOf(pay.payment_method) === gatewayOf(via);
  const unseenCard = via && !payItself ? via : '';
  if (unseenCard) pay = { payment_method: '', source: null };

  const sources = { date: dateSource, ...cls.sources };
  if (money.event_id) sources.event = 'trip';
  if (pay.source) sources.payment_method = pay.source;

  const warnings = [...money.warnings];
  const confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium';
  // AI가 확실히 읽지 못했다고 한 것 — 흐림·잘림만이 아니라 화면에 없는 날짜를 짐작한 때도 (B-099)
  if (confidence === 'low') warnings.push(LOW_CONFIDENCE_WARNING);
  if (raw.note) warnings.push(String(raw.note));

  return {
    date,
    merchant: String(raw.merchant || '').trim(),
    detail: cls.detail,
    amount: money.amount,
    currency: money.currency,
    foreignAmount: money.foreignAmount,
    rate: money.rate,
    event_id: money.event_id,
    eventTitle: money.eventTitle,
    payment_method: pay.payment_method,
    paymentHint: hint,
    unseenCard,
    gatewayBought: cls.gatewayBought,
    budget_category: cls.budget_category,
    sub_category: cls.sub_category,
    items,
    historyDetail: cls.history?.detail || '',
    historyCount: cls.history?.cnt || 0,
    alternatives: cls.alternatives,
    categoryGuess: cls.categoryGuess,
    confidence,
    warnings,
    sources,
  };
}
