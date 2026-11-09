/**
 * 가져오기 AI 도우미 (I-034, ROADMAP M-7) — 사람마다 다른 양식을 AI가 읽어 '맞추기'만 추천한다.
 * 실제 변환은 sheetImport.js가 모든 행에 같은 규칙으로 한다 — 행마다 AI에 보내지 않아 빠르고 싸며, 결과가 일정하고,
 * 가계부 내용 전체가 AI 회사로 가지 않는다(AGENTS §7 — 필요한 범위만).
 *
 *  1) suggestSheetMapping: 표의 앞 몇 줄(계좌·카드번호처럼 보이는 긴 숫자는 가림)만 보내 어느 열이 무엇인지 받는다
 *  2) suggestCategoryMatches: 파일의 분류 이름(또는 분류 열이 없을 때 내용·가게 이름) 목록만 보내
 *     내 가계부의 '카테고리 > 세부카테고리' 중 하나를 받는다 — 목록에 없는 답은 버린다(§7)
 *  3) suggestPaymentMatches: 파일의 결제수단 이름 목록 → 내 결제수단
 * 결과는 화면에서 사용자가 고칠 수 있는 추천일 뿐이다.
 */
import { analyzeWithAI } from './aiClient';
import { columnName, sheetWidth, EMPTY_MAPPING } from './sheetImport';

export const SAMPLE_ROWS = 15;           // 양식 읽기에 보내는 앞줄 수(제목줄이 늦게 나오면 그 아래 8줄까지)
const MAX_SAMPLE_ROWS = 30;
const MAX_CELL = 30;
const MATCH_CHUNK = 120;                 // 분류 맞추기 한 번에 보내는 이름 수
export const MAX_DETAIL_MATCHES = 360;   // 내용별 분류는 많이 나온 것부터 이만큼만 AI에 묻는다

// 숫자만 이어 쓴 날짜·시각인지(20240305, 202403051433, 20240305143300) — 실제 달력·시각 범위까지 본다
// (2001013234567 같은 주민번호·20123456789012 같은 계좌번호를 날짜로 보고 그대로 보내지 않게)
function isCompactDateTime(digits) {
  const m = /^((?:19|20)\d{2})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?$/.exec(digits);
  if (!m) return false;
  const [, , mo, d, h = '00', mi = '00', s = '00'] = m;
  return Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31
    && Number(h) < 24 && Number(mi) < 60 && Number(s) < 60;
}
// 구분자로 쓴 날짜(+시각) — 2024-03-05, 2024-03-05 14
const SEPARATED_DATE = /^(19|20)\d{2}[- ]\d{1,2}[- ]\d{1,2}( \d{1,2})?$/;

/**
 * 계좌·카드·전화·주민번호처럼 보이는 숫자(숫자 9개 이상 — 날짜·시각 모양 제외)를 가린다 — 양식을 읽는 데 필요 없다.
 * 엑셀에 숫자로 저장된 번호(110123456789, 1012345678)도 가린다. 금액 쉼표(1,500,000)는 끊겨 남는다
 */
export function maskDigits(text) {
  return String(text ?? '').replace(/\d[\d\- ]{7,}\d/g, (run) => {
    const digits = run.replace(/\D/g, '');
    if (digits.length < 9) return run;
    if (/[ -]/.test(run) ? SEPARATED_DATE.test(run.trim()) : isCompactDateTime(digits)) return run;
    return '#'.repeat(Math.min(digits.length, 12));
  });
}

export function maskCell(value) {
  if (typeof value === 'number') {
    // 엑셀 숫자 칸: 날짜 일련번호·금액은 그대로, 9자리 넘는 정수(번호로 보이는 것)는 가린다
    return Number.isInteger(value) && Math.abs(value) >= 1e8 && !isCompactDateTime(String(value)) ? '#'.repeat(Math.min(String(Math.abs(value)).length, 12)) : String(value);
  }
  const s = maskDigits(String(value ?? '').replace(/\s+/g, ' ').trim());
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
}

/** 표의 앞부분을 보낼 글로 — '행 | A | B | …' */
export function sheetSampleText(rows, { headerRow = -1 } = {}) {
  const width = Math.min(sheetWidth(rows), 40);
  const upto = Math.min(rows.length, MAX_SAMPLE_ROWS, Math.max(SAMPLE_ROWS, headerRow + 9));
  const lines = [`행 | ${Array.from({ length: width }, (_, i) => columnName(i)).join(' | ')}`];
  for (let i = 0; i < upto; i += 1) {
    const row = rows[i] || [];
    lines.push(`${i + 1} | ${Array.from({ length: width }, (_, j) => maskCell(row[j])).join(' | ')}`);
  }
  return { text: lines.join('\n'), rowsSent: upto, width };
}

const MAPPING_SYSTEM = [
  '당신은 가계부 앱의 가져오기 도우미입니다. 사용자가 올린 표(엑셀·CSV·은행/카드 내역·다른 가계부 앱 내보내기)의 앞부분을 보고 각 열이 무엇인지 알려 줍니다.',
  '이 가계부에는 지출만 넣습니다. 수입·이체·입금 줄은 빼야 합니다.',
  '- header_row: 열 이름이 적힌 제목줄의 행 번호. 제목줄 없이 첫 줄부터 내용이면 0.',
  '- 열은 열 글자(A, B, …)로 답하고, 없으면 빈 문자열로 둡니다.',
  '- date: 거래 날짜, amount: 지출 금액(출금·사용·이용금액), detail: 내용(가게·사용처·적요·품목), memo: 내용 뒤에 덧붙일 메모·비고,',
  '  category: 분류(대분류), sub_category: 세부 분류(소분류), payment: 결제수단(카드·계좌·현금 등), discount: 할인 금액,',
  '  type: 수입·지출·이체를 구분하는 열(값이 지출/수입/이체 같은 것일 때만).',
  '- 금액이 한 열이면 amount_mode는 single. 식비|교통비|… 처럼 카테고리마다 금액 열이 따로 있으면 per_category로 하고 그 열들을 category_columns에 적습니다(합계 열은 빼기).',
  '- amount_sign: 지출이 양수로 적혀 있으면 positive, 지출이 음수(은행 내역처럼 입금은 양수)면 negative.',
  '- type 열이 있으면 spend_type_values에 지출로 가져올 값을 표에 적힌 그대로 적습니다(예: 지출, 출금).',
  '- 입금·잔액·수입 금액 열은 amount로 고르지 마세요.',
  '- notes: 사용자에게 보여 줄 한두 문장(한국어 존댓말) — 어떻게 읽었는지, 확인할 점.',
].join('\n');

const COL = { type: 'string', description: '열 글자(A, B, …) 또는 빈 문자열' };
const MAPPING_SCHEMA = {
  type: 'object',
  properties: {
    header_row: { type: 'integer', description: '제목줄 행 번호(1부터), 없으면 0' },
    date: COL,
    amount: COL,
    detail: COL,
    memo: COL,
    category: COL,
    sub_category: COL,
    payment: COL,
    discount: COL,
    type: COL,
    amount_mode: { type: 'string', enum: ['single', 'per_category'] },
    amount_sign: { type: 'string', enum: ['positive', 'negative'] },
    category_columns: { type: 'array', items: { type: 'string' }, description: 'per_category일 때 금액이 든 열 글자들' },
    spend_type_values: { type: 'array', items: { type: 'string' }, description: 'type 열에서 지출로 가져올 값들' },
    notes: { type: 'string' },
  },
  required: ['header_row', 'date', 'amount_mode'],
};

const colOf = (letter, width) => {
  const s = typeof letter === 'string' ? letter.trim().toUpperCase() : '';
  if (!/^[A-Z]{1,2}$/.test(s)) return -1;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1 < width ? n - 1 : -1;
};

/**
 * AI가 읽은 열 맞추기 — sheetImport의 mapping 모양으로, 범위·종류를 검사한 것만.
 * 반환: { mapping, notes }. 답이 쓸모없으면(날짜·금액을 못 찾음) 오류
 */
export function mappingFromAI(raw, rows, { year = null } = {}) {
  const width = sheetWidth(rows);
  if (!raw || typeof raw !== 'object') throw new Error('AI가 양식을 읽지 못했습니다 — 다시 시도하거나 직접 골라 주세요');
  const headerRow = Number.isInteger(raw.header_row) && raw.header_row >= 1 && raw.header_row <= rows.length ? raw.header_row - 1 : -1;
  const m = { ...EMPTY_MAPPING, headerRow, categoryColumns: [], spendTypes: [], year };
  const used = new Set();
  [['date', 'date'], ['amount', 'amount'], ['detail', 'detail'], ['memo', 'memo'], ['category', 'category'],
    ['sub_category', 'subCategory'], ['payment', 'payment'], ['discount', 'discount'], ['type', 'type']].forEach(([from, to]) => {
    const col = colOf(raw[from], width);
    if (col >= 0 && !used.has(col)) { m[to] = col; used.add(col); }
  });
  m.amountSign = raw.amount_sign === 'negative' ? 'negative' : 'positive';
  if (raw.amount_mode === 'per_category') {
    const cols = (Array.isArray(raw.category_columns) ? raw.category_columns : [])
      .map(c => colOf(c, width)).filter(c => c >= 0 && !used.has(c));
    if (cols.length) { m.amountMode = 'perCategory'; m.categoryColumns = [...new Set(cols)]; m.amount = -1; }
  }
  if (m.type >= 0) {
    m.spendTypes = (Array.isArray(raw.spend_type_values) ? raw.spend_type_values : [])
      .filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean);
  }
  if (m.date < 0 || (m.amountMode === 'single' && m.amount < 0)) {
    throw new Error('AI가 날짜·금액 열을 찾지 못했습니다 — 직접 골라 주세요');
  }
  const notes = typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 300) : '';
  return { mapping: m, notes };
}

/** AI로 양식 읽기 — 표의 앞부분만 보낸다. 반환: { mapping, notes, rowsSent } */
export async function suggestSheetMapping({ ai, rows, sheetName = '', headerRow = -1, year = null, signal, onProgress }) {
  const { text, rowsSent } = sheetSampleText(rows, { headerRow });
  const prompt = [
    `[시트 이름] ${String(sheetName).slice(0, 40)}`,
    `[전체 행 수] ${rows.length}`,
    '[표의 앞부분 — 긴 숫자(계좌·카드번호 등)는 #으로 가림]',
    text,
  ].join('\n');
  const raw = await analyzeWithAI({
    ai, system: MAPPING_SYSTEM, prompt, schema: MAPPING_SCHEMA,
    toolName: 'read_sheet_layout', description: '가계부로 가져올 표의 각 열이 무엇인지 알려 준다',
    maxTokens: 1200, signal, onProgress,
  });
  return { ...mappingFromAI(raw, rows, { year }), rowsSent };
}

// ── 분류·결제수단 맞추기 ──────────────────────────────────────────────

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer', description: '목록 번호' },
          target: { type: 'string', description: '내 목록에 있는 이름 그대로, 알맞은 것이 없으면 빈 문자열' },
        },
        required: ['n', 'target'],
      },
    },
  },
  required: ['matches'],
};

async function matchInChunks({ ai, system, header, values, targets, toolName, description, signal, onProgress }) {
  const allowed = new Set(targets);
  const result = {};
  for (let start = 0; start < values.length; start += MATCH_CHUNK) {
    const chunk = values.slice(start, start + MATCH_CHUNK);
    const prompt = [
      header,
      ...targets,
      '',
      '[맞출 이름 — 번호. 이름 (건수)]',
      // 이름 속 카드·계좌번호 같은 긴 숫자도 가린다(예: 신한(1234-5678-9012-3456))
      ...chunk.map((v, i) => `${i + 1}. ${maskDigits(v.label).slice(0, 60)} (${v.count})`),
    ].join('\n');
    if (values.length > MATCH_CHUNK && onProgress) {
      onProgress(`맞추는 중… (${Math.min(start + MATCH_CHUNK, values.length)}/${values.length})`);
    }
    // eslint-disable-next-line no-await-in-loop
    const raw = await analyzeWithAI({ ai, system, prompt, schema: MATCH_SCHEMA, toolName, description, maxTokens: 4000, signal, onProgress });
    (Array.isArray(raw?.matches) ? raw.matches : []).forEach((mt) => {
      const v = Number.isInteger(mt?.n) ? chunk[mt.n - 1] : null;
      const target = typeof mt?.target === 'string' ? mt.target.trim() : '';
      if (v && allowed.has(target)) result[v.key] = target;   // 목록에 없는 답은 버린다 (AGENTS §7)
    });
  }
  return result;
}

const CATEGORY_SYSTEM = [
  '당신은 가계부 가져오기 도우미입니다. 다른 가계부·엑셀에서 온 분류 이름을 사용자의 가계부 카테고리에 맞춥니다.',
  '- target은 [내 카테고리] 목록에 있는 줄을 글자 그대로 하나 고릅니다. 알맞은 것이 없으면 빈 문자열.',
  '- 뜻이 같거나 포함되면 맞춥니다(예: 식료품 → 식비 > 장보기, 커피 → 식비 > 카페). 억지로 맞추지 마세요.',
].join('\n');

const DETAIL_SYSTEM = [
  '당신은 가계부 가져오기 도우미입니다. 카드·은행 내역의 가게·내용 이름을 보고 사용자의 가계부 카테고리를 고릅니다.',
  '- target은 [내 카테고리] 목록에 있는 줄을 글자 그대로 하나 고릅니다. 무엇인지 알 수 없으면 빈 문자열.',
  '- 잘 알려진 가게·서비스 이름(스타벅스, 쿠팡, GS25, 카카오T 등)으로 판단하고, 모르면 짐작하지 마세요.',
].join('\n');

/**
 * 분류 맞추기 — values: [{ key, label, count }] (분류 이름 또는 내용), paths: 내 '카테고리 > 세부카테고리' 목록.
 * byDetail이면 내용(가게 이름)으로 고른다. 반환: { key → path } (목록에 있는 것만)
 */
export function suggestCategoryMatches({ ai, values, paths, byDetail = false, signal, onProgress }) {
  if (!values.length || !paths.length) return Promise.resolve({});
  return matchInChunks({
    ai,
    system: byDetail ? DETAIL_SYSTEM : CATEGORY_SYSTEM,
    header: '[내 카테고리 — 이 중 하나를 그대로]',
    values: byDetail ? values.slice(0, MAX_DETAIL_MATCHES) : values,
    targets: paths,
    toolName: 'match_categories',
    description: '가져올 분류·내용 이름을 사용자의 가계부 카테고리에 맞춘다',
    signal,
    onProgress,
  });
}

const PAYMENT_SYSTEM = [
  '당신은 가계부 가져오기 도우미입니다. 다른 가계부·엑셀·카드 내역의 결제수단 이름을 사용자의 결제수단에 맞춥니다.',
  '- target은 [내 결제수단] 목록에 있는 이름을 글자 그대로 하나 고릅니다. 같은 카드·계좌로 보이지 않으면 빈 문자열.',
  '- 카드 끝자리·괄호 표시는 무시하고 카드사·이름으로 맞춥니다(예: 신한(1234) → 신한카드). 다른 카드사끼리 맞추지 마세요.',
].join('\n');

/** 결제수단 맞추기 — values: [{ key, label, count }], methods: 내 결제수단 이름. 반환: { key → name } */
export function suggestPaymentMatches({ ai, values, methods, signal, onProgress }) {
  if (!values.length || !methods.length) return Promise.resolve({});
  return matchInChunks({
    ai,
    system: PAYMENT_SYSTEM,
    header: '[내 결제수단 — 이 중 하나를 그대로]',
    values,
    targets: methods,
    toolName: 'match_payment_methods',
    description: '가져올 결제수단 이름을 사용자의 결제수단에 맞춘다',
    signal,
    onProgress,
  });
}
