/**
 * AI 명령 (I-051) — AI 입력 상자에 무엇이든 말하면 상황에 맞게 처리한다.
 * "어제 스타벅스 지워줘", "넷플릭스 정기지출 17000원으로", "식비 예산 50만원", "이번 달 외식 얼마 썼어?", "어둡게 해 줘"
 *
 * 흐름
 *  1) AI에게 이 가계부의 목록(결제수단·카테고리·입력 습관·정기지출 이름·구성원·선택 기능)과 말한 글을 보내
 *     '할 일' 목록(actions)과 새로 넣을 거래(entries)를 받는다. 거래 내역 자체는 보내지 않는다 —
 *     AI는 "어느 거래인지"를 조건(날짜·가게·금액 등)으로만 말하고, 맞는 거래는 앱이 이 기기에서 찾는다.
 *  2) buildPlan이 할 일마다 목록과 대조해 검증하고, 실제로 무엇이 바뀌는지 화면에 보일 글을 만든다(DB에 쓰지 않는다).
 *     목록에 없는 카테고리·결제수단, 없는 날짜, 잘못된 금액은 그 단계를 막고 이유를 보인다.
 *  3) runPlan이 사용자가 고른 단계를 한 트랜잭션으로 실행하고 되돌리기 기록을 돌려준다. undoPlan이 되돌린다.
 *
 * 바로 하기와 확인받기: 조회·화면 이동·화면 설정·선택 기능·목표·예산·목록 추가처럼 되돌리기 쉬운 것만 있으면 바로 하고
 * (알림의 '되돌리기'), 거래·정기지출을 고치거나 지우는 것은 맞는 거래를 보여 주고 한 번 누르면 한다 (AGENTS §2.3).
 * 새 거래만 말했으면 이 모듈은 아무것도 하지 않고 기존 말로 입력(textEntry·quickEntry)에 넘긴다.
 */
import { analyzeWithAI, AIError } from './aiClient';
import { buildDataContext, isSuggestionComplete, normalizeName, suggestionToTransaction } from './receiptAssistant';
import { buildTextSuggestion } from './textEntry';
import { OPTIONAL_FEATURES } from './optionalFeatures';
import {
  getTransactions, updateTransaction, addTransaction, addedSnapshot, removeAddedTransactions,
  deleteTransactionsForUndo, restoreDeletedTransactions, getSplitGroupTransactions,
  getPaymentMethods, getBudgetCategories, getSubCategories, getMemberNames,
  getRecurringTransactions, getRecurringDateMoves, updateRecurringTransaction, addRecurringTransaction,
  deleteRecurringForUndo, restoreDeletedRecurring, deleteRecurringTransaction,
  snapshotMonthlyGoals, restoreMonthlyGoals, changeDefaultMonthlyGoal, setMonthlyGoal, deleteMonthlyGoal,
  getEffectiveMonthlyGoal,
  snapshotCategoryBudgets, restoreCategoryBudgets, setDefaultCategoryBudget, setMonthCategoryBudget,
  isCategoryBudgetEnabled, setCategoryBudgetEnabled,
  addBudgetCategory, addSubCategory, addPaymentMethod, addMember,
  getAllBudgetCategories, getAllSubCategories, getAllPaymentMethods,
  getBudgetCategoryUsage, deleteBudgetCategory, getSubCategoryUsage, deleteSubCategory,
  getPaymentMethodUsage, deletePaymentMethod, getMemberUsage, deleteMember,
  STARTER_NAME_MAX, withTransaction, hasForeignAmount, getDiscountRules, evaluateDiscountRule,
  setRecurringAmountCheckedOn, countCategoryBudgets,
} from './dbManager';
import {
  FONT_SCALES, THEMES, START_TABS, getFontScale, setFontScale, getTheme, setTheme, getStartTab, setStartTab,
} from './displayPrefs';
import { isValidDateStr, todayStr, currentYearMonth } from './dateUtils';

// ── 말한 글이 '명령'처럼 보이는지 ─────────────────────────────────

// 새 거래 말고 다른 일을 시키는 말 — 이런 말이 있으면 명령으로 읽는다(새 거래만 있으면 말로 입력에 넘긴다).
// 넓게 잡는다: 거래 추가를 명령으로 잘못 보내도 AI가 새 거래로 돌려주어 말로 입력으로 넘어가지만, 명령을 말로 입력에 보내면 못 알아듣는다
const COMMAND_RE = /지워|지우|지운|삭제|없애|빼\s*줘|수정|고쳐|고치|바꿔|바꾸|변경|옮겨|정기\s*지출|정기\s*결제|구독|자동\s*이체|설정|켜\s*(줘|기|주)|꺼\s*(줘|주)|끄기|끄고|목표|예산|얼마나|얼마\s*(썼|나왔|였|야|지|들었|냈)|합계|몇\s*건|보여\s*줘|찾아|카테고리|결제\s*수단|구성원|테마|다크|어둡게|밝게|글씨|화면|열어\s*줘|가\s*줘/;

/** 거래 추가 말고 다른 일을 시키는 글인지 (카드 문자는 먼저 걸러진다) */
export function looksLikeCommand(text) {
  return COMMAND_RE.test(String(text || ''));
}

// ── AI에게 보내는 것 ───────────────────────────────────────────────

export const ACTION_TYPES = [
  'tx_update', 'tx_delete', 'tx_query',
  'recurring_add', 'recurring_update', 'recurring_delete',
  'goal', 'budget', 'feature', 'display',
  'add_category', 'add_sub_category', 'add_payment_method', 'add_member',
  'open', 'unsupported',
];

export const SCREENS = [
  { key: 'list', label: '거래내역' },
  { key: 'summary', label: '요약' },
  { key: 'calendar', label: '캘린더' },
  { key: 'account', label: '계좌' },
  { key: 'settings', label: '설정' },
  { key: 'recurring', label: '정기지출 설정' },
  { key: 'budget', label: '예산 설정' },
  { key: 'features', label: '선택 기능 설정' },
];

const str = d => ({ type: 'string', description: d });
const num = d => ({ type: 'number', description: d });

const ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    date: str('YYYY-MM-DD. 날짜 말이 없으면 빈 문자열'),
    merchant: str('가게·장소 이름. 없으면 빈 문자열'),
    detail: str('가계부 세부내역 (입력 습관의 표기 우선)'),
    amount: num('금액 숫자, 모르면 0'),
    currency: str('ISO 통화 코드, 원화면 KRW'),
    krw_amount: num('외화 결제의 원화 금액을 말했으면 그 값, 아니면 0'),
    payment_method: str('결제수단 목록 중 하나, 모르면 "모름"'),
    payment_mentioned: { type: 'boolean', description: '사용자가 결제수단을 직접 말했으면 true' },
    category: str('"카테고리 > 세부카테고리" 목록 중 하나, 모르면 "모름"'),
  },
  required: ['date', 'merchant', 'detail', 'amount', 'currency', 'krw_amount', 'payment_method', 'payment_mentioned', 'category'],
};

const SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      description: '새 거래 추가가 아닌 할 일들 (말한 순서대로). 없으면 빈 배열',
      items: {
        type: 'object',
        properties: {
          type: str(`할 일 종류: ${ACTION_TYPES.join(' | ')}`),
          summary: str('이 할 일을 한국어 한 문장으로 (예: "어제 스타벅스 거래를 지웁니다")'),
          target: {
            type: 'object',
            description: '어느 거래·정기지출인지 — 거래는 조건으로 찾는다(앱이 맞는 거래를 찾는다). 쓰지 않는 칸은 빈 문자열·0',
            properties: {
              date_from: str('YYYY-MM-DD, 하루면 date_to와 같게. 없으면 빈 문자열'),
              date_to: str('YYYY-MM-DD. 없으면 빈 문자열'),
              keyword: str('세부내역·가게 이름에 들어간 말. 없으면 빈 문자열'),
              amount: num('그 거래의 금액(바꾸기 전), 모르면 0'),
              category: str('카테고리 이름(세부카테고리 말고). 없으면 빈 문자열'),
              sub_category: str('세부카테고리 이름. 없으면 빈 문자열'),
              payment_method: str('결제수단 이름. 없으면 빈 문자열'),
              member: str('구성원 이름. 없으면 빈 문자열'),
              which: str('all(맞는 것 모두) | latest(날짜가 가장 최근인 하나) | last_added(가장 최근에 입력한 하나 — "방금 넣은 것")'),
              recurring_id: num('정기지출이면 정기지출 목록의 번호, 아니면 0'),
            },
            required: ['date_from', 'date_to', 'keyword', 'amount', 'category', 'sub_category', 'payment_method', 'member', 'which', 'recurring_id'],
          },
          changes: {
            type: 'object',
            description: '바꿀 값·새로 만들 값. 바꾸지 않는 칸은 빈 문자열·0',
            properties: {
              date: str('새 날짜 YYYY-MM-DD'),
              amount: num('새 금액(원). 목표·예산·정기지출 금액도 여기'),
              detail: str('새 세부내역'),
              category: str('새 "카테고리 > 세부카테고리" (목록 표기 그대로)'),
              payment_method: str('새 결제수단 (목록 표기 그대로)'),
              member: str('새 구성원 이름, 비우려면 "없음"'),
              day_of_month: num('정기지출 결제일 1~31, 말일이면 31, 모르면 0'),
              month_of_year: num('매년 결제하는 정기지출이면 그 달 1~12, 매월이면 0'),
            },
            required: ['date', 'amount', 'detail', 'category', 'payment_method', 'member', 'day_of_month', 'month_of_year'],
          },
          setting: {
            type: 'object',
            description: '설정·목록·화면에 쓰는 값. 쓰지 않는 칸은 빈 문자열',
            properties: {
              key: str('feature면 선택 기능 키, display면 theme | font | start, open이면 화면 키'),
              value: str('feature: on | off, display: 고를 값의 키, goal·budget을 없애려면 "해제"'),
              month: str('goal·budget을 그 달만 바꾸면 YYYY-MM, 늘 쓰는 값이면 빈 문자열'),
              name: str('add_*로 새로 만들 이름'),
              parent: str('add_sub_category의 카테고리 이름'),
            },
            required: ['key', 'value', 'month', 'name', 'parent'],
          },
        },
        required: ['type', 'summary', 'target', 'changes', 'setting'],
      },
    },
    entries: {
      type: 'array',
      description: '새로 넣을 거래(지출) — 없으면 빈 배열',
      items: ENTRY_SCHEMA,
    },
    reply: str('할 일을 하나도 정할 수 없을 때 되묻거나 안내하는 한 문장, 정했으면 빈 문자열'),
  },
  required: ['actions', 'entries', 'reply'],
};

const SYSTEM = [
  '당신은 한국 가계부 앱의 비서입니다.',
  '사용자가 말한 요청을 앱이 실행할 수 있는 할 일 목록으로 바꿉니다.',
  '앱은 할 일을 사용자에게 보여 주고 실행합니다. 말에 없는 사실은 지어내지 않고, 이름은 주어진 목록의 표기 그대로 씁니다.',
].join(' ');

const won = n => `${Math.round(Number(n) || 0).toLocaleString()}원`;
const dayLabel = d => (Number(d) === 0 || Number(d) >= 31 ? '말일' : `${Number(d)}일`);
const recurringLabel = r => `${r.detail || r.sub_category || r.budget_category} ${won(r.amount)} ${r.frequency === 'annual' ? `매년 ${r.month_of_year}월 ` : '매월 '}${dayLabel(r.day_of_month)} · ${r.payment_method}`;

/** AI에게 보낼 지시문 — 목록·입력 습관(말로 입력과 같은 범위)에 정기지출 이름·구성원·선택 기능을 더한다. 거래 내역은 보내지 않는다 */
export function buildCommandPrompt(db, text, today = todayStr()) {
  const recurring = getRecurringTransactions(db);
  const members = getMemberNames(db);
  const lines = [
    buildDataContext(db, today).text,
    '',
    '[정기지출 목록 — 번호: 내용]',
    ...(recurring.length ? recurring.map(r => `${r.id}: ${recurringLabel(r)}`) : ['(없음)']),
    '',
    `[구성원] ${members.join(', ') || '(없음)'}`,
    '',
    '[선택 기능 — 키: 이름 (지금)]',
    ...OPTIONAL_FEATURES.map(f => `${f.key}: ${f.label} (${f.isOn(db) ? '켜짐' : '꺼짐'})`),
    '',
    `[화면 설정] theme: ${THEMES.map(t => `${t.key}(${t.label})`).join(', ')} / font: ${FONT_SCALES.map(f => `${f.key}(${f.label})`).join(', ')} / start(처음 여는 화면): ${START_TABS.map(t => `${t.key}(${t.label})`).join(', ')}`,
    `[화면 키] ${SCREENS.map(s => `${s.key}(${s.label})`).join(', ')}`,
    '',
    '[할 일 종류]',
    '- tx_update: 거래 고치기 (target으로 찾고 changes에 바꿀 값)',
    '- tx_delete: 거래 지우기 (target으로 찾는다)',
    '- tx_query: 거래 찾아보기·합계 묻기 ("이번 달 외식 얼마 썼어?") — target에 조건',
    '- recurring_add: 정기지출 새로 만들기 (changes에 detail·amount·category·payment_method·day_of_month·month_of_year)',
    '- recurring_update / recurring_delete: 정기지출 고치기·지우기 (target.recurring_id는 정기지출 목록의 번호)',
    '- goal: 월 목표금액 (changes.amount, setting.month — 비우면 늘 쓰는 목표, 없애려면 setting.value "해제")',
    '- budget: 카테고리 예산 (target.category, changes.amount, setting.month, 없애려면 setting.value "해제")',
    '- feature: 선택 기능 켜고 끄기 (setting.key, setting.value on|off)',
    '- display: 이 기기 화면 설정 (setting.key theme|font|start, setting.value)',
    '- add_category / add_sub_category / add_payment_method / add_member: 목록에 새 이름 (setting.name, 세부카테고리는 setting.parent)',
    '- open: 화면 열기 (setting.key 화면 키)',
    '- unsupported: 앱이 할 수 없는 요청 — summary에 무엇을 못 하는지',
    '',
    '[규칙]',
    '- 새 지출을 기록하라는 말은 actions가 아니라 entries에 넣는다 (금액·결제수단을 몰라도 넣는다).',
    '- 날짜는 오늘 기준으로 계산한다: 어제, 지난주 금요일, 이번 달(1일~오늘), 지난달(그 달 1일~말일).',
    '- "방금 넣은 것"은 which=last_added, "가장 최근 스타벅스"는 which=latest, 여러 건이면 all.',
    '- 금액: 9천원=9000, 1만2천원=12000, 50만원=500000.',
    '- 무엇을 할지 정할 수 없으면 actions·entries를 비우고 reply에 되묻는다. 글로만 답하지 말고 정해진 형식으로 답한다.',
    '',
    '[사용자가 말한 내용]',
    String(text || '').trim(),
  ];
  return lines.join('\n');
}

/**
 * 말한 글을 AI로 읽는다 — { actions, entries, reply } (모양을 바로잡은 것).
 * 할 일·새 거래가 하나도 없고 되묻는 말도 없으면 기본 질문을 reply로 둔다.
 */
export async function parseCommand({ db, ai, text, signal, onProgress, today = todayStr() }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new AIError('할 일을 적어 주세요', 'parse');
  const raw = await analyzeWithAI({
    ai, system: SYSTEM, prompt: buildCommandPrompt(db, trimmed, today), schema: SCHEMA,
    toolName: 'plan_actions', description: '사용자의 요청을 가계부 앱의 할 일 목록으로 정리한다', signal, onProgress,
  });
  const actions = (Array.isArray(raw?.actions) ? raw.actions : []).filter(a => a && typeof a === 'object').slice(0, 10);
  const entries = (Array.isArray(raw?.entries) ? raw.entries : []).filter(e => e && typeof e === 'object').slice(0, 20);
  let reply = typeof raw?.reply === 'string' ? raw.reply.trim().slice(0, 300) : '';
  if (!actions.length && !entries.length && !reply) reply = '무엇을 할지 알아듣지 못했어요 — 조금 더 자세히 말해 주세요';
  return { actions, entries, reply };
}

// ── 계획: 할 일마다 검증하고 화면에 보일 글을 만든다 (DB에 쓰지 않음) ─────────

// 바로 해도 되는 것 — 되돌리기 쉽고 거래를 바꾸지 않는다
const AUTO_KINDS = new Set([
  'tx_query', 'open', 'display', 'feature', 'goal', 'budget',
  'add_category', 'add_sub_category', 'add_payment_method', 'add_member',
]);
const MAX_TARGETS = 100;
const LIST_LIMIT = 8;

const s = v => (typeof v === 'string' ? v.trim() : '');
const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fail = (step, error) => ({ ...step, ok: false, error });

const txLine = t => `${t.date.slice(5).replace('-', '/')} ${t.detail || t.sub_category || t.budget_category} ${won(t.amount - (t.discount_amount || 0))} · ${t.payment_method}${t.member ? ` · ${t.member}` : ''}`;
const listLines = rows => [
  ...rows.slice(0, LIST_LIMIT).map(txLine),
  ...(rows.length > LIST_LIMIT ? [`… 외 ${rows.length - LIST_LIMIT}건`] : []),
];

/** "카테고리 > 세부" → { category, sub } — 목록에 있을 때만. 세부카테고리 없이 카테고리만 말해도 된다. 없으면 null */
function resolveCategoryPath(db, path) {
  const text = s(path);
  if (!text || text === '모름') return null;
  const [catRaw, subRaw = ''] = text.split('>').map(x => x.trim());
  const category = getBudgetCategories(db).find(c => c === catRaw);
  if (!category) return null;
  if (!subRaw) return { category, sub: '' };
  const sub = getSubCategories(db, category).find(x => x === subRaw);
  return sub ? { category, sub } : null;
}

const pathText = (cat, sub) => (sub ? `${cat} > ${sub}` : cat);

/** 거래를 고를 조건 → { rows } | { error } (현금 정리 행은 빼고, 날짜 최신순) */
export function findTargetTransactions(db, target = {}, today = todayStr()) {
  const filters = {};
  const crit = [];
  const from = s(target.date_from);
  const to = s(target.date_to) || from;
  if (from || to) {
    if ((from && !isValidDateStr(from)) || (to && !isValidDateStr(to))) return { error: `날짜(${from || to})를 알 수 없어요` };
    if (from && to && to < from) return { error: '끝 날짜가 시작 날짜보다 앞이에요' };
    if (from) filters.dateFrom = from;
    if (to) filters.dateTo = to;
    crit.push('date');
  }
  const category = s(target.category);
  if (category) {
    if (!getBudgetCategories(db).includes(category)) return { error: `'${category}' 카테고리가 없어요` };
    filters.budget_category = category;
    crit.push('category');
  }
  const method = s(target.payment_method);
  if (method) {
    if (!getPaymentMethods(db).includes(method)) return { error: `'${method}' 결제수단이 없어요` };
    filters.payment_method = method;
    crit.push('payment');
  }
  const member = s(target.member);
  if (member) {
    if (!getMemberNames(db).includes(member)) return { error: `'${member}' 구성원이 없어요` };
    filters.member = member;
    crit.push('member');
  }
  const sub = s(target.sub_category);
  const keyword = normalizeName(target.keyword);
  const amount = Math.round(n(target.amount));
  if (sub) crit.push('sub');
  if (keyword) crit.push('keyword');
  if (amount > 0) crit.push('amount');
  const which = ['latest', 'last_added'].includes(s(target.which)) ? s(target.which) : 'all';
  if (!crit.length && which !== 'last_added') return { error: '어떤 거래인지 알 수 없어요 — 날짜·가게·금액을 함께 말해 주세요' };

  let rows = getTransactions(db, filters).filter(t => !t.is_cash_adjustment);
  if (sub) rows = rows.filter(t => (t.sub_category || '') === sub);
  if (keyword) {
    rows = rows.filter(t => normalizeName(`${t.detail || ''}${t.sub_category || ''}`).includes(keyword)
      || normalizeName(t.detail).includes(keyword));
  }
  if (amount > 0) rows = rows.filter(t => Number(t.amount) === amount || Number(t.amount) - Number(t.discount_amount || 0) === amount);
  // 가장 최근 = 오늘까지 중 가장 최근 — 미리 등록된 다음 달 정기지출을 고르지 않게. 앞날짜만 있으면 그중 가장 가까운 것
  if (which === 'latest') {
    const past = rows.find(t => t.date <= today);
    rows = past ? [past] : rows.slice(-1);
  }
  if (which === 'last_added') rows = rows.length ? [rows.reduce((a, b) => (b.id > a.id ? b : a))] : [];
  return { rows };
}

/** 거래 행을 updateTransaction에 넘길 모양으로 (외화는 객체로) */
function txData(row) {
  let foreign = {};
  try { foreign = row.foreign_amounts ? JSON.parse(row.foreign_amounts) || {} : {}; } catch (e) { foreign = {}; }
  return {
    payment_method: row.payment_method, date: row.date, budget_category: row.budget_category,
    sub_category: row.sub_category || '', detail: row.detail || '', amount: Number(row.amount),
    discount_amount: Number(row.discount_amount || 0), event_id: row.event_id || null,
    foreign_amounts: foreign, split_group_id: row.split_group_id || '', member: row.member || '',
  };
}

const TX_FIELDS = ['payment_method', 'date', 'budget_category', 'sub_category', 'detail', 'amount', 'member'];
const sameTx = (row, data) => TX_FIELDS.every(k => (k === 'amount'
  ? Number(row[k]) === Number(data[k]) : String(row[k] ?? '') === String(data[k] ?? '')));
/** 행이 계획할 때(또는 실행한 뒤) 모습 그대로인지 — 할인·여행·외화·분할까지 본다 (다른 기기와 합쳐 바뀐 행을 옛 값으로 덮지 않게) */
const sameFull = (row, data) => !!row && sameTx(row, data)
  && Number(row.discount_amount || 0) === Number(data.discount_amount || 0)
  && String(row.event_id || '') === String(data.event_id || '')
  && String(row.split_group_id || '') === String(data.split_group_id || '')
  && JSON.stringify(txData(row).foreign_amounts) === JSON.stringify(data.foreign_amounts || {});
const rowById = (db, id, date) => getTransactions(db, { dateFrom: date, dateTo: date }).find(t => t.id === id) || null;
/** 그 번호의 행(날짜를 모르면 전체에서) */
const rowByIdAny = (db, id) => getTransactions(db).find(t => t.id === id) || null;

/** 거래 고칠 값 → { changes, labels } | { error } */
function txChanges(db, c = {}) {
  const changes = {};
  const labels = [];
  const date = s(c.date);
  if (date) {
    if (!isValidDateStr(date)) return { error: `날짜(${date})를 알 수 없어요` };
    changes.date = date;
    labels.push(`날짜 ${date}`);
  }
  const amount = n(c.amount);
  if (amount) {
    if (!(amount > 0) || !Number.isInteger(amount)) return { error: `금액(${c.amount})을 확인해 주세요` };
    changes.amount = amount;
    labels.push(`금액 ${won(amount)}`);
  }
  const detail = s(c.detail).slice(0, 100);
  if (detail) { changes.detail = detail; labels.push(`내용 '${detail}'`); }
  if (s(c.category) && s(c.category) !== '모름') {
    const path = resolveCategoryPath(db, c.category);
    if (!path) return { error: `'${s(c.category)}' 카테고리가 목록에 없어요` };
    changes.budget_category = path.category;
    changes.sub_category = path.sub;
    labels.push(`분류 ${pathText(path.category, path.sub)}`);
  }
  const method = s(c.payment_method);
  if (method && method !== '모름') {
    if (!getPaymentMethods(db).includes(method)) return { error: `'${method}' 결제수단이 목록에 없어요` };
    changes.payment_method = method;
    labels.push(`결제수단 ${method}`);
  }
  const member = s(c.member);
  if (member) {
    if (member === '없음') { changes.member = ''; labels.push('누가 비우기'); } else {
      if (!getMemberNames(db).includes(member)) return { error: `'${member}' 구성원이 없어요` };
      changes.member = member;
      labels.push(`누가 ${member}`);
    }
  }
  if (!labels.length) return { error: '무엇을 바꿀지 알 수 없어요' };
  return { changes, labels };
}

function planTxUpdate(db, a, step) {
  const found = findTargetTransactions(db, a.target);
  if (found.error) return fail(step, found.error);
  if (!found.rows.length) return fail(step, '맞는 거래가 없어요');
  if (found.rows.length > MAX_TARGETS) return fail(step, `맞는 거래가 ${found.rows.length}건이에요 — 범위를 좁혀 주세요`);
  const ch = txChanges(db, a.changes);
  if (ch.error) return fail(step, ch.error);
  const edits = [];
  const skipped = [];
  found.rows.forEach(row => {
    const { changes } = ch;
    if (row.split_group_id && (changes.amount || changes.date || changes.payment_method)) {
      skipped.push(`${txLine(row)} — 분할 결제는 거래 화면에서 고쳐 주세요`); return;
    }
    if (changes.amount && (hasForeignAmount(row.foreign_amounts) || row.event_id)) {
      skipped.push(`${txLine(row)} — 외화·여행 거래의 금액은 거래 화면에서 고쳐 주세요`); return;
    }
    const touchesDiscount = changes.amount || changes.payment_method || changes.budget_category;
    // 할인이 있는 거래는 금액·결제수단·분류를 바꾸면 할인을 다시 정해야 한다 — 직접 적은 할인일 수 있어 화면에서 (AGENTS §4)
    if (touchesDiscount && Number(row.discount_amount || 0) > 0) {
      skipped.push(`${txLine(row)} — 할인이 있는 거래는 거래 화면에서 고쳐 주세요`); return;
    }
    const before = txData(row);
    const after = { ...before, ...changes };
    if (touchesDiscount) {
      // 할인 없던 거래 — 새 결제수단·분류·금액에 할인 규칙이 있으면 입력 창과 같게 할인을 넣는다
      const auto = evaluateDiscountRule(getDiscountRules(db, after.payment_method), after.budget_category, after.sub_category, after.amount, after.detail);
      if (auto > 0) after.discount_amount = Math.min(auto, after.amount);
    }
    if (sameTx(row, after)) { skipped.push(`${txLine(row)} — 이미 그 값이에요`); return; }
    edits.push({ id: row.id, before, after });
  });
  if (!edits.length) return fail({ ...step, lines: skipped }, '고칠 수 있는 거래가 없어요');
  return {
    ...step,
    title: `거래 ${edits.length}건 고치기 — ${ch.labels.join(', ')}`,
    lines: listLines(found.rows.filter(r => edits.some(e => e.id === r.id))),
    warnings: skipped,
    data: { edits },
  };
}

function planTxDelete(db, a, step) {
  const found = findTargetTransactions(db, a.target);
  if (found.error) return fail(step, found.error);
  if (!found.rows.length) return fail(step, '맞는 거래가 없어요');
  if (found.rows.length > MAX_TARGETS) return fail(step, `맞는 거래가 ${found.rows.length}건이에요 — 범위를 좁혀 주세요`);
  // 분할 결제는 묶음을 함께 지운다 — 한 몫만 남지 않게
  const ids = new Set();
  const warnings = [];
  found.rows.forEach(row => {
    if (row.split_group_id) {
      const group = getSplitGroupTransactions(db, row.split_group_id);
      if (group.length > 1 && group.some(g => !ids.has(g.id) && g.id !== row.id)) warnings.push(`${txLine(row)} — 분할 결제라 나머지 몫도 함께 지워요`);
      group.forEach(g => ids.add(g.id));
    }
    ids.add(row.id);
  });
  return {
    ...step,
    title: `거래 ${ids.size}건 지우기`,
    lines: listLines(found.rows),
    warnings: [...new Set(warnings)],
    // 지울 때의 모습 — 실행할 때 그새 바뀐(다른 기기와 합쳐 번호가 다른 거래가 된) 행이면 지우지 않는다
    data: { rows: [...ids].map(id => ({ id, ...txData(rowByIdAny(db, id)) })) },
  };
}

function planTxQuery(db, a, step) {
  const found = findTargetTransactions(db, a.target);
  if (found.error) return fail(step, found.error);
  const rows = found.rows;
  const net = rows.reduce((sum, t) => sum + Number(t.amount) - Number(t.discount_amount || 0), 0);
  const byCat = new Map();
  rows.forEach(t => byCat.set(t.budget_category, (byCat.get(t.budget_category) || 0) + Number(t.amount) - Number(t.discount_amount || 0)));
  const top = [...byCat.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
  return {
    ...step,
    title: rows.length ? `${rows.length}건 · 순지출 ${won(net)}` : '맞는 거래가 없어요',
    lines: [
      ...(top.length > 1 ? [`카테고리별: ${top.map(([c, v]) => `${c} ${won(v)}`).join(', ')}`] : []),
      ...listLines(rows),
    ],
    data: { count: rows.length, net },
  };
}

function findRecurring(db, a) {
  const id = Math.round(n(a.target?.recurring_id));
  return id > 0 ? getRecurringTransactions(db).find(r => r.id === id) || null : null;
}

/** 정기지출 값 검증 — 고칠 때는 old에 덮어쓴 모습, 만들 때는 빈 것에서. → { data, labels } | { error } */
function recurringData(db, c = {}, old = null) {
  const data = old ? { ...old } : { frequency: 'monthly', day_of_month: 1, month_of_year: null, detail: '', discount_amount: 0, discount_note: '', note: '' };
  const labels = [];
  const amount = n(c.amount);
  if (amount) {
    if (!(amount > 0) || !Number.isInteger(amount)) return { error: `금액(${c.amount})을 확인해 주세요` };
    data.amount = amount;
    labels.push(`금액 ${won(amount)}`);
  }
  const day = Math.round(n(c.day_of_month));
  if (day) {
    if (day < 1 || day > 31) return { error: `결제일(${c.day_of_month})을 확인해 주세요` };
    data.day_of_month = day >= 31 ? 0 : day;
    labels.push(`결제일 ${dayLabel(day)}`);
  }
  const month = Math.round(n(c.month_of_year));
  if (month) {
    if (month < 1 || month > 12) return { error: `결제 달(${c.month_of_year})을 확인해 주세요` };
    data.frequency = 'annual';
    data.month_of_year = month;
    labels.push(`매년 ${month}월`);
  }
  const detail = s(c.detail).slice(0, 100);
  if (detail) { data.detail = detail; labels.push(`내용 '${detail}'`); }
  if (s(c.category) && s(c.category) !== '모름') {
    const path = resolveCategoryPath(db, c.category);
    if (!path) return { error: `'${s(c.category)}' 카테고리가 목록에 없어요` };
    data.budget_category = path.category;
    data.sub_category = path.sub;
    labels.push(`분류 ${pathText(path.category, path.sub)}`);
  }
  const method = s(c.payment_method);
  if (method && method !== '모름') {
    if (!getPaymentMethods(db).includes(method)) return { error: `'${method}' 결제수단이 목록에 없어요` };
    data.payment_method = method;
    labels.push(`결제수단 ${method}`);
  }
  return { data, labels };
}

function planRecurringUpdate(db, a, step) {
  const old = findRecurring(db, a);
  if (!old) return fail(step, '어느 정기지출인지 찾지 못했어요 — 정기지출 이름을 함께 말해 주세요');
  // 주기(매월↔매년)를 바꾸는 것은 화면에서 — 날짜 옮기기 규칙이 주기가 같을 때만 맞다
  if (n(a.changes?.month_of_year) && old.frequency !== 'annual') return fail(step, '매월 정기지출을 매년으로 바꾸는 것은 설정 › 정기지출에서 해 주세요');
  const r = recurringData(db, a.changes, old);
  if (r.error) return fail(step, r.error);
  if (!r.labels.length) return fail(step, '무엇을 바꿀지 알 수 없어요');
  const moves = getRecurringDateMoves(db, old.id, r.data);
  const lines = [`지금: ${recurringLabel(old)}`, `바꾼 뒤: ${recurringLabel(r.data)}`];
  if (moves.moves.length) lines.push(`앞으로 등록된 거래 ${moves.moves.length}건도 새 결제일로 옮겨요`);
  else if (moves.amountFollows) lines.push('앞으로 등록된 거래의 금액도 함께 바꿔요');
  return { ...step, title: `정기지출 고치기 — ${r.labels.join(', ')}`, lines, data: { id: old.id, before: old, after: r.data } };
}

function planRecurringAdd(db, a, step) {
  const r = recurringData(db, a.changes);
  if (r.error) return fail(step, r.error);
  const d = r.data;
  const missing = [];
  if (!(d.amount > 0)) missing.push('금액');
  if (!d.budget_category) missing.push('카테고리');
  if (!d.payment_method) missing.push('결제수단');
  if (!n(a.changes?.day_of_month)) missing.push('결제일');
  if (missing.length) return fail({ ...step, title: '정기지출 만들기' }, `${missing.join('·')}을(를) 함께 말해 주세요`);
  return { ...step, title: '정기지출 만들기', lines: [recurringLabel(d), '다음에 가계부를 열 때 이번 달 몫부터 자동으로 등록돼요'], data: { row: d } };
}

function planRecurringDelete(db, a, step) {
  const old = findRecurring(db, a);
  if (!old) return fail(step, '어느 정기지출인지 찾지 못했어요 — 정기지출 이름을 함께 말해 주세요');
  return { ...step, title: '정기지출 지우기', lines: [recurringLabel(old), '이미 등록된 거래는 그대로 둬요'], data: { id: old.id } };
}

const clearWords = new Set(['해제', '없애기', '삭제', 'off', '없음']);

function amountOrClear(a) {
  if (clearWords.has(s(a.setting?.value))) return { amount: null };
  const amount = n(a.changes?.amount);
  if (!(amount > 0) || !Number.isInteger(amount)) return { error: '금액을 확인해 주세요' };
  return { amount };
}

function planGoal(db, a, step) {
  const month = s(a.setting?.month);
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail(step, `달(${month})을 알 수 없어요`);
  const v = amountOrClear(a);
  if (v.error) return fail(step, v.error);
  const now = getEffectiveMonthlyGoal(db, month || currentYearMonth());
  const what = month ? `${month} 목표` : '월 목표(늘)';
  return {
    ...step,
    title: v.amount === null ? `${what} 없애기` : `${what} ${won(v.amount)}`,
    lines: now !== null ? [`지금: ${won(now)}`] : [],
    data: { month, amount: v.amount },
  };
}

function planBudget(db, a, step) {
  const category = s(a.target?.category) || s(a.changes?.category).split('>')[0].trim();
  if (!getBudgetCategories(db).includes(category)) return fail(step, category ? `'${category}' 카테고리가 없어요` : '어느 카테고리 예산인지 알 수 없어요');
  const month = s(a.setting?.month);
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail(step, `달(${month})을 알 수 없어요`);
  const v = amountOrClear(a);
  if (v.error) return fail(step, v.error);
  const lines = [];
  const enable = !isCategoryBudgetEnabled(db) && v.amount !== null;
  if (enable) lines.push("'카테고리별 예산' 선택 기능도 켜요");
  return {
    ...step,
    title: `${category} 예산${month ? `(${month})` : ''} ${v.amount === null ? '없애기' : won(v.amount)}`,
    lines,
    data: { category, month, amount: v.amount, enable },
  };
}

function planFeature(db, a, step) {
  const f = OPTIONAL_FEATURES.find(x => x.key === s(a.setting?.key));
  if (!f) return fail(step, '어느 선택 기능인지 알 수 없어요');
  const value = s(a.setting?.value);
  if (value !== 'on' && value !== 'off') return fail(step, '켤지 끌지 알 수 없어요');
  const on = value === 'on';
  if (!!f.isOn(db) === on) return fail({ ...step, title: `${f.label} ${on ? '켜기' : '끄기'}` }, `이미 ${on ? '켜져' : '꺼져'} 있어요`);
  return { ...step, title: `${f.label} ${on ? '켜기' : '끄기'}`, lines: on ? [f.desc] : [], data: { key: f.key, on } };
}

const DISPLAY = {
  theme: { label: '화면 테마', list: THEMES, get: getTheme, set: setTheme },
  font: { label: '글씨 크기', list: FONT_SCALES, get: getFontScale, set: setFontScale },
  start: { label: '처음 여는 화면', list: START_TABS, get: getStartTab, set: setStartTab },
};

function planDisplay(db, a, step) {
  const d = DISPLAY[s(a.setting?.key)];
  if (!d) return fail(step, '어떤 화면 설정인지 알 수 없어요');
  const opt = d.list.find(x => x.key === s(a.setting?.value));
  if (!opt) return fail(step, `${d.label}을(를) 무엇으로 할지 알 수 없어요`);
  if (d.get() === opt.key) return fail({ ...step, title: `${d.label}: ${opt.label}` }, '이미 그렇게 되어 있어요');
  return { ...step, title: `${d.label}: ${opt.label} (이 기기)`, data: { key: s(a.setting.key), value: opt.key } };
}

function planAddName(db, a, step) {
  const name = s(a.setting?.name);
  if (!name) return fail(step, '새 이름을 알 수 없어요');
  if (name.length > STARTER_NAME_MAX) return fail(step, `이름은 ${STARTER_NAME_MAX}자까지예요`);
  const kind = a.type;
  if (kind === 'add_category') {
    if (getAllBudgetCategories(db).some(c => c.name === name)) return fail({ ...step, title: `카테고리 '${name}' 만들기` }, '이미 있어요(숨긴 것 포함)');
    return { ...step, title: `카테고리 '${name}' 만들기`, data: { name } };
  }
  if (kind === 'add_sub_category') {
    const parent = s(a.setting?.parent);
    if (!getBudgetCategories(db).includes(parent)) return fail(step, parent ? `'${parent}' 카테고리가 없어요` : '어느 카테고리 아래에 만들지 알 수 없어요');
    if (getAllSubCategories(db, parent).some(x => x.name === name)) return fail({ ...step, title: `세부카테고리 '${parent} > ${name}' 만들기` }, '이미 있어요(숨긴 것 포함)');
    return { ...step, title: `세부카테고리 '${parent} > ${name}' 만들기`, data: { name, parent } };
  }
  if (kind === 'add_payment_method') {
    if (getAllPaymentMethods(db).some(m => m.name === name)) return fail({ ...step, title: `결제수단 '${name}' 만들기` }, '이미 있어요(숨긴 것 포함)');
    return { ...step, title: `결제수단 '${name}' 만들기`, data: { name } };
  }
  if (getMemberNames(db).includes(name)) return fail({ ...step, title: `구성원 '${name}' 더하기` }, '이미 있어요');
  return { ...step, title: `구성원 '${name}' 더하기`, data: { name } };
}

function planOpen(db, a, step) {
  const screen = SCREENS.find(x => x.key === s(a.setting?.key));
  if (!screen) return fail(step, '어느 화면인지 알 수 없어요');
  return { ...step, title: `${screen.label} 열기`, data: { screen: screen.key } };
}

const PLANNERS = {
  tx_update: planTxUpdate,
  tx_delete: planTxDelete,
  tx_query: planTxQuery,
  recurring_add: planRecurringAdd,
  recurring_update: planRecurringUpdate,
  recurring_delete: planRecurringDelete,
  goal: planGoal,
  budget: planBudget,
  feature: planFeature,
  display: planDisplay,
  add_category: planAddName,
  add_sub_category: planAddName,
  add_payment_method: planAddName,
  add_member: planAddName,
  open: planOpen,
};

/** AI의 할 일 하나 → 단계 { kind, title, summary, lines, warnings, ok, error, auto, data } */
export function planAction(db, a) {
  const kind = ACTION_TYPES.includes(s(a?.type)) ? s(a.type) : 'unsupported';
  const summary = s(a?.summary).slice(0, 200);
  const base = { kind, summary, title: summary || '할 일', lines: [], warnings: [], ok: true, error: '', auto: AUTO_KINDS.has(kind), data: null };
  if (kind === 'unsupported') return fail({ ...base, title: summary || '할 수 없는 요청' }, '아직 말로는 할 수 없어요 — 해당 화면에서 직접 해 주세요');
  try {
    return PLANNERS[kind](db, a || {}, base);
  } catch (e) {
    return fail(base, e.message || '처리하지 못했어요');
  }
}

/** 새 거래(entries) 하나 → 추가 단계 — 빈 칸이 있으면 막는다(그런 건은 말로 입력에서 되묻는다) */
function planEntry(db, e, today) {
  const sug = buildTextSuggestion(db, e, today);
  const step = {
    kind: 'tx_add', summary: '', title: `거래 넣기 — ${sug.detail || sug.merchant || '새 거래'} ${sug.amount ? won(sug.amount) : ''}`.trim(),
    lines: [`${sug.date} · ${pathText(sug.budget_category, sug.sub_category) || '분류 모름'} · ${sug.payment_method || '결제수단 모름'}`],
    warnings: sug.warnings || [], ok: true, error: '', auto: false, data: null,
  };
  if (!isSuggestionComplete(sug) || !(Number(sug.amount) > 0)) return fail(step, '빈 칸이 있어요 — 이 거래는 따로 말해 주세요');
  return { ...step, data: { row: suggestionToTransaction(db, sug) } };
}

/**
 * AI 결과 → 계획 { steps, reply, addOnly }.
 *  - addOnly: 새 거래만 말했다 — 화면은 말로 입력(바로 넣기·되묻기가 있는 기존 흐름)으로 넘긴다
 *  - steps에는 할 일 단계와(할 일이 있으면) 새 거래 단계가 함께 있다
 *  - auto(계획): 모든 단계가 바로 해도 되는 것이고 막힌 단계가 없다
 */
export function buildPlan(db, parsed, today = todayStr()) {
  const actions = parsed?.actions || [];
  const entries = parsed?.entries || [];
  if (!actions.length && entries.length) return { steps: [], reply: '', addOnly: true, auto: false };
  const steps = actions.map(a => planAction(db, a));
  // 한 문장에서 만든 이름을 바로 쓰는 단계는 만든 뒤에야 검증할 수 있다 — 막힌 이유에 그렇게 알린다
  const newNames = steps.filter(st => st.ok && st.kind.startsWith('add_')).map(st => st.data.name);
  steps.forEach((st, i) => {
    if (!st.ok && newNames.some(nm => st.error.includes(`'${nm}'`))) {
      steps[i] = { ...st, error: `${st.error} — 먼저 만든 뒤 다시 말해 주세요` };
    }
  });
  entries.forEach(e => steps.push(planEntry(db, e, today)));
  const auto = steps.length > 0 && steps.every(x => x.ok && x.auto);
  return { steps, reply: parsed?.reply || '', addOnly: false, auto };
}

/** 실행할 수 있는 단계인지 (조회는 쓸 것이 없어 실행 대상이 아니다) */
export const isRunnable = step => step.ok && step.kind !== 'tx_query';

// ── 실행과 되돌리기 ───────────────────────────────────────────────

/**
 * 고른 단계를 실행한다 — DB 쓰기는 하나의 트랜잭션(중간에 실패하면 모두 되돌리고 오류를 던진다).
 * 계획한 뒤 그사이 바뀐 거래·정기지출(다른 기기와 합침·직접 고침)은 건드리지 않고 skipped로 센다 — 옛 값으로 덮거나 다른 거래를 지우지 않게.
 * 화면 설정(이 기기)은 DB가 아니라서 트랜잭션이 끝난 뒤에 적용하고, 화면 열기는 결과의 open으로 돌려준다(App이 연다).
 * 반환: { records: 되돌리기 기록(실행 순서), open: 화면 키 | null, done: 실행한 단계 수, skipped, dbChanged }
 */
export function runPlan(db, steps) {
  const records = [];
  const display = [];
  let open = null;
  let dbChanged = false;
  let skipped = 0;
  const runnable = steps.filter(isRunnable);
  withTransaction(db, () => {
    runnable.forEach(step => {
      const d = step.data;
      switch (step.kind) {
        case 'tx_update': {
          const edits = d.edits.filter(e => sameFull(rowById(db, e.id, e.before.date), e.before));
          skipped += d.edits.length - edits.length;
          edits.forEach(e => updateTransaction(db, e.id, e.after));
          records.push({ kind: 'tx_update', edits });
          break;
        }
        case 'tx_delete': {
          const ids = d.rows.filter(r => sameFull(rowById(db, r.id, r.date), r)).map(r => r.id);
          skipped += d.rows.length - ids.length;
          if (ids.length) records.push({ kind: 'tx_delete', undo: deleteTransactionsForUndo(db, ids) });
          break;
        }
        case 'tx_add': {
          const id = addTransaction(db, d.row);
          records.push({ kind: 'tx_add', snapshot: addedSnapshot(id, d.row) });
          break;
        }
        case 'recurring_add':
          records.push({ kind: 'recurring_add', id: addRecurringTransaction(db, d.row) });
          break;
        case 'recurring_update': {
          const now = getRecurringTransactions(db).find(x => x.id === d.id);
          if (!sameRecurring(now, d.before)) { skipped += 1; return; }
          updateRecurringTransaction(db, d.id, d.after, { moveDates: true });
          records.push({ kind: 'recurring_update', id: d.id, before: now, after: d.after });
          break;
        }
        case 'recurring_delete': {
          const undo = deleteRecurringForUndo(db, d.id);
          if (!undo) { skipped += 1; return; }
          records.push({ kind: 'recurring_delete', undo });
          break;
        }
        case 'goal': {
          const snap = snapshotMonthlyGoals(db);
          if (!d.month) changeDefaultMonthlyGoal(db, d.amount);
          else if (d.amount === null) deleteMonthlyGoal(db, d.month);
          else setMonthlyGoal(db, d.month, d.amount);
          records.push({ kind: 'goal', snap, after: snapshotMonthlyGoals(db) });
          break;
        }
        case 'budget': {
          const snap = snapshotCategoryBudgets(db, d.category);
          if (d.enable) setCategoryBudgetEnabled(db, true);
          if (!d.month) setDefaultCategoryBudget(db, d.category, d.amount);
          else setMonthCategoryBudget(db, d.category, d.month, d.amount);
          records.push({ kind: 'budget', category: d.category, snap, after: snapshotCategoryBudgets(db, d.category), enabled: d.enable });
          break;
        }
        case 'feature': {
          const f = OPTIONAL_FEATURES.find(x => x.key === d.key);
          f.setOn(db, d.on);
          records.push({ kind: 'feature', key: d.key, on: d.on });
          break;
        }
        case 'add_category': addBudgetCategory(db, d.name); records.push({ kind: step.kind, name: d.name }); break;
        case 'add_sub_category': addSubCategory(db, d.parent, d.name); records.push({ kind: step.kind, name: d.name, parent: d.parent }); break;
        case 'add_payment_method': addPaymentMethod(db, d.name); records.push({ kind: step.kind, name: d.name }); break;
        case 'add_member': addMember(db, d.name); records.push({ kind: step.kind, name: d.name }); break;
        case 'display': display.push(d); return;
        case 'open': open = d.screen; return;
        default: return;
      }
      dbChanged = true;
    });
  });
  // 이 기기 화면 설정 — DB가 모두 된 뒤에만 바꾼다(DB가 실패해 되돌렸는데 화면만 바뀌어 남지 않게)
  display.forEach(d => {
    const prev = DISPLAY[d.key].get();
    DISPLAY[d.key].set(d.value);
    records.push({ kind: 'display', key: d.key, prev, value: d.value });
  });
  return { records, open, done: runnable.length - skipped, skipped, dbChanged };
}

const RECURRING_FIELDS = ['amount', 'day_of_month', 'payment_method', 'budget_category', 'sub_category', 'detail', 'frequency'];
function sameRecurring(now, data) {
  return !!now && RECURRING_FIELDS.every(k => String(now[k] ?? '') === String(data[k] ?? ''))
    && (data.frequency !== 'annual' || Number(now.month_of_year) === Number(data.month_of_year));
}

/**
 * 실행한 것을 거꾸로 되돌린다 — 하나의 트랜잭션. 그사이 사용자가 다시 바꾼 것(거래·정기지출·목표·예산·선택 기능·화면 설정·
 * 쓰기 시작한 목록 이름)은 건드리지 않는다.
 * 반환: { undone, kept } — 되돌린 것 / 그사이 바뀌어 그대로 둔 것의 수
 */
export function undoPlan(db, records) {
  let undone = 0;
  let kept = 0;
  const tally = (ok) => { if (ok) undone += 1; else kept += 1; };
  withTransaction(db, () => {
    [...records].reverse().forEach(r => {
      switch (r.kind) {
        case 'tx_update':
          r.edits.forEach(e => {
            const ok = sameFull(rowById(db, e.id, e.after.date), e.after);
            if (ok) updateTransaction(db, e.id, e.before);
            tally(ok);
          });
          break;
        case 'tx_delete': undone += restoreDeletedTransactions(db, r.undo); break;
        case 'tx_add': tally(removeAddedTransactions(db, [r.snapshot]) === 1); break;
        case 'recurring_add': {
          const exists = getRecurringTransactions(db).some(x => x.id === r.id);
          if (exists) deleteRecurringTransaction(db, r.id);
          tally(exists);
          break;
        }
        case 'recurring_update': {
          const ok = sameRecurring(getRecurringTransactions(db).find(x => x.id === r.id), r.after);
          if (ok) {
            updateRecurringTransaction(db, r.id, r.before, { moveDates: true });
            // 금액을 확인한 날도 그때대로 — 되돌리면서 오늘로 찍혀 '금액이 바뀐 구독' 알림이 묻히지 않게 (I-027)
            setRecurringAmountCheckedOn(db, r.id, r.before.amount_checked_on || '');
          }
          tally(ok);
          break;
        }
        case 'recurring_delete': tally(!!restoreDeletedRecurring(db, r.undo)); break;
        case 'goal': {
          const ok = JSON.stringify(snapshotMonthlyGoals(db)) === JSON.stringify(r.after);
          if (ok) restoreMonthlyGoals(db, r.snap);
          tally(ok);
          break;
        }
        case 'budget': {
          const ok = JSON.stringify(snapshotCategoryBudgets(db, r.category)) === JSON.stringify(r.after);
          if (ok) {
            restoreCategoryBudgets(db, r.category, r.snap);
            if (r.enabled && isCategoryBudgetEnabled(db)) setCategoryBudgetEnabled(db, false);
          }
          tally(ok);
          break;
        }
        case 'feature': {
          const f = OPTIONAL_FEATURES.find(x => x.key === r.key);
          const ok = !!f.isOn(db) === r.on;
          if (ok) f.setOn(db, !r.on);
          tally(ok);
          break;
        }
        case 'add_category': {
          const ok = Object.values(getBudgetCategoryUsage(db, r.name)).every(x => x === 0)
            && getAllSubCategories(db, r.name).length === 0 && countCategoryBudgets(db, r.name) === 0;
          if (ok) deleteBudgetCategory(db, r.name);
          tally(ok);
          break;
        }
        case 'add_sub_category': {
          const ok = Object.values(getSubCategoryUsage(db, r.parent, r.name)).every(x => x === 0);
          if (ok) deleteSubCategory(db, r.parent, r.name);
          tally(ok);
          break;
        }
        case 'add_payment_method': {
          const m = getAllPaymentMethods(db).find(x => x.name === r.name);
          const ok = !!m && Object.values(getPaymentMethodUsage(db, r.name)).every(x => x === 0);
          if (ok) deletePaymentMethod(db, m.id);
          tally(ok);
          break;
        }
        case 'add_member': {
          const ok = getMemberNames(db).includes(r.name) && getMemberUsage(db, r.name) === 0;
          if (ok) deleteMember(db, r.name);
          tally(ok);
          break;
        }
        default: break;
      }
    });
  });
  // 화면 설정은 DB를 되돌린 뒤에 — 그사이 사용자가 다시 바꿨으면 그대로
  records.filter(r => r.kind === 'display').forEach(r => {
    const ok = DISPLAY[r.key].get() === r.value;
    if (ok) DISPLAY[r.key].set(r.prev);
    tally(ok);
  });
  return { undone, kept };
}

/** 실행 결과 알림 글 */
export function describeRun(steps) {
  const runnable = steps.filter(isRunnable).filter(x => x.kind !== 'open');
  if (!runnable.length) return '';
  if (runnable.length === 1) return `✓ ${runnable[0].title}`;
  return `✓ ${runnable.length}가지를 했어요 — ${runnable.map(x => x.title).join(' · ').slice(0, 80)}`;
}
