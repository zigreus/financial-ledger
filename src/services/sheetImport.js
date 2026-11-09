/**
 * 표 → 가계부 거래 (I-034, ROADMAP M-7) — 사람마다 다른 양식의 표를 '열 맞추기'로 가계부 거래로 바꾼다.
 *
 * 흐름: 시트(sheetFile.js) → 열 맞추기(mapping: 규칙으로 짐작 → 사용자가 고침, AI 추천은 importAI.js)
 *   → applyMapping: 모든 행에 같은 규칙을 적용해 '원본 값' 거래(items)와 건너뛴 줄(skipped)
 *   → 분류 맞추기(파일의 카테고리·결제수단 이름 → 내 가계부 이름, 분류 열이 없으면 내용별로)
 *   → toImportEntries: ImportModal의 기존 검사·중복 표시·없는 항목 추가·가져오기로 넘길 행
 * DB에는 쓰지 않는다(확정은 ImportModal의 '가져오기', B-029). 가계부에는 지출만 넣는다 — 수입·이체 줄은 건너뛴다.
 */
import { ymd, isValidDateStr, addDays } from './dateUtils';

// ── 열 맞추기 ────────────────────────────────────────────────────────

export const COLUMN_FIELDS = ['date', 'amount', 'detail', 'memo', 'category', 'subCategory', 'payment', 'discount', 'type'];

export const FIELD_LABELS = {
  date: '날짜',
  amount: '금액',
  detail: '내용',
  memo: '메모(내용 뒤에 붙임)',
  category: '카테고리',
  subCategory: '세부카테고리',
  payment: '결제수단',
  discount: '할인',
  type: '수입·지출 구분',
};

export const EMPTY_MAPPING = {
  headerRow: 0,            // 제목줄 행(0부터). -1이면 제목줄 없이 첫 줄부터 내용
  date: -1, amount: -1, detail: -1, memo: -1, category: -1, subCategory: -1, payment: -1, discount: -1, type: -1,
  amountMode: 'single',    // 'single' 금액이 한 열 | 'perCategory' 카테고리마다 금액 열(열 제목이 카테고리)
  amountSign: 'positive',  // 'positive' 양수가 지출 | 'negative' 음수가 지출(은행 내역처럼 입금이 양수)
  categoryColumns: [],     // perCategory일 때 금액이 든 열들
  spendTypes: [],          // 구분 열에서 지출로 가져올 값들
  year: null,              // 연도가 없는 날짜(3/5, 3월 5일)에 붙일 해
  yearAuto: true,          // 해를 앱이 정했는지 — 그러면 오늘보다 일주일 넘게 미래가 되는 날짜는 한 해 앞으로(1월에 받은 12월 내역)
  month: null,             // 일(日)만 적힌 날짜에 붙일 달 — 시트 이름(3월)에서
  fillDate: true,          // 날짜 칸이 빈 줄은 위 줄의 날짜로(하루 날짜를 여러 줄에 병합한 가계부)
};

const norm = s => String(s ?? '').toLowerCase().replace(/[\s_\-()[\]{}·.,:;/\\'"*※#]/g, '');

// 열 제목으로 짐작할 때 쓰는 낱말(공백·기호를 뺀 모양)
const SYNONYMS = {
  date: ['날짜', '일자', '일시', '거래일', '거래일자', '거래일시', '거래날짜', '사용일', '사용일자', '사용일시', '사용날짜', '이용일',
    '이용일자', '이용일시', '승인일', '승인일자', '승인일시', '결제일', '결제일자', '매출일', '매출일자', 'date', '년월일', '날자', '일'],
  amount: ['금액', '지출', '지출금액', '지출액', '출금', '출금액', '출금금액', '찾으신금액', '사용금액', '사용액', '이용금액', '승인금액',
    '결제금액', '결제액', '매출금액', 'amount', '가격', '비용', '원화금액', '이용금액원', '금액원'],
  detail: ['내용', '내역', '사용내역', '이용내역', '사용처', '이용처', '가맹점', '가맹점명', '이용가맹점', '이용하신곳', '적요', '거래내용',
    '상호', '상호명', '품목', '항목명', 'description', '거래처', '사용처명', '기재내용', '받는분', '보낸분'],
  memo: ['메모', '비고', '참고', 'note', 'memo', '설명'],
  category: ['분류', '카테고리', '대분류', '지출분류', '분류명', 'category', '대항목', '항목', '지출항목', '용도'],
  subCategory: ['소분류', '세부분류', '세부카테고리', '중분류', '세부항목', '소항목', '하위분류', 'subcategory', '세부'],
  payment: ['결제수단', '결제방법', '지불수단', '지불방법', '자산', '카드', '카드명', '카드종류', '카드구분', '계좌', '출금계좌', '결제',
    '수단', 'payment', '결제카드', '사용카드', '이용카드'],
  discount: ['할인', '할인금액', '할인액', '혜택금액', '즉시할인', '청구할인'],
  type: ['타입', '구분', '거래구분', '수입지출', '유형', '종류', 'type', '입출금구분', '거래유형', '입출구분', '수입지출구분',
    '승인구분', '취소여부', '취소구분', '거래상태', '승인상태', '상태', '매출구분'],
};
// 뜻이 넓어 다른 제목이 있으면 그쪽을 먼저 고르는 낱말 — 은행 '적요'(체크카드·타행이체)보다 '받는분'(가게·사람 이름)
const WEAK = { detail: ['적요', '내역'] };
// 금액 열로 보면 안 되는 제목(입금·잔액 등)
const NOT_AMOUNT = ['입금', '수입', '맡기신', '받은', '적립', '잔액', '잔고', '포인트', '수수료', '할부', '개월', '회차', '번호'];
// 합계 열 — 카테고리마다 금액 열이 나뉜 표에서 카테고리로 보지 않는다(두 번 세게 된다)
const TOTAL_HEADER = /^(합계|합|계|총계|소계|총액|월합계|일합계|total|sum)$/;
// 수입·지출 구분 열의 값으로 보이는 것(공백을 뺀 값 전체가 이 낱말) — 카드 명세서의 승인구분(정상/취소)도
const TYPE_WORD = /^(지출|수입|이체|출금|입금|사용|결제|승인|정상|취소|승인취소|매입취소|부분취소|환불|입금취소|출금취소|소비|저축|카드지출|현금지출|카드결제|현금결제)$/;
const SPEND_WORD = /(지출|출금|사용|결제|승인|소비|정상)/;
const NOT_SPEND_WORD = /(취소|수입|입금|환불|이체|저축)/;
// 취소 여부 열(취소여부: Y/빈칸)의 값
const YES_NO = /^(y|n|o|x|예|아니오|아니요)$/i;
const CANCELLED = /^(y|o|예)$/i;
// 거래 종류 값(일시불·할부·체크카드·타행이체·ATM출금 …) — 구분 열의 값 대부분이 이것과 같으면 수입·지출 구분도 카테고리도 아니다.
// 값 전체가 같을 때만 본다 — '자동차'·'카드값'·'인터넷' 같은 카테고리 이름을 거래 종류로 보지 않게
const KIND_VALUE = /^(일시불|할부|할부\d*개월|\d+개월|체크|체크카드|신용|신용카드|타행이체|당행이체|이체|자동이체|대체|atm|atm출금|atm입금|현금출금|인터넷뱅킹|모바일뱅킹|폰뱅킹|창구|cms|펌뱅킹|오픈뱅킹|간편결제|송금)$/i;
const kindValue = v => KIND_VALUE.test(String(v).replace(/[\s()]/g, ''));
// 합계 줄 — 그 줄은 거래가 아니다.
//  - 합계·총계·소계·누계·총액: 날짜가 빈 줄은 칸에 품기만 해도('3월 합계', '소계(국내)'), 날짜가 있는 줄은 그 낱말로 시작·끝날 때만
//  - 계·월계·일계: 값 전체가 기간 합계 모양일 때만('3월 계', '3월 월계', '월계(3월)', '일계 5건') — '이마트 월계점'·'제일계란' 같은
//    가게 이름을 건너뛰지 않게
//  - 합·계·total·sum: 날짜가 빈 줄에서 칸 값 자체일 때만
const TOTAL_WORD = /(합계|총계|소계|누계|총액)/;
const TOTAL_EDGE = /^(합계|총계|소계|누계|총액)|(합계|총계|소계|누계|총액)$/;
const PERIOD_TOTAL = /^(\d+(월|일))?(월|일)?계(\d+(건|월|일))?$/;
const TOTAL_CELL = /^(합|계|total|sum)$/;
function totalLike(c, dated) {
  if (typeof c !== 'string') return false;
  const n = norm(c);
  if (PERIOD_TOTAL.test(n)) return true;
  return dated ? TOTAL_EDGE.test(n) : (TOTAL_WORD.test(n) || TOTAL_CELL.test(n));
}

function headerScore(field, header) {
  const h = norm(header);
  if (!h) return 0;
  if (field === 'amount' && NOT_AMOUNT.some(w => h.includes(w)) && !SYNONYMS.amount.includes(h)) return 0;
  if (WEAK[field]?.some(w => h === w || h.includes(w))) return 1;
  if (SYNONYMS[field].includes(h)) return 3;
  // 제목이 낱말을 품으면(예: '이용금액(원)') — 두 글자 이상 낱말만
  return SYNONYMS[field].some(w => w.length >= 2 && h.includes(w)) ? 2 : 0;
}

const isEmptyCell = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const cellText = v => (isEmptyCell(v) ? '' : String(v).trim());
export const rowIsEmpty = row => !row || row.every(isEmptyCell);

/** 시트의 열 수(가장 긴 행) */
export const sheetWidth = rows => rows.reduce((w, r) => Math.max(w, r ? r.length : 0), 0);

/** 제목줄 행(0부터)을 찾는다 — 앞 30줄에서 열 이름 같은 칸이 가장 많은 줄. 없으면 첫 줄이 내용 같으면 -1 */
export function findHeaderRow(rows) {
  let best = -1;
  let bestScore = 1;
  rows.slice(0, 30).forEach((row, i) => {
    if (!row) return;
    const fields = new Set();
    row.forEach((cell) => {
      if (typeof cell !== 'string') return;
      COLUMN_FIELDS.forEach((f) => { if (headerScore(f, cell) > 0) fields.add(f); });
    });
    if (fields.size > bestScore) { best = i; bestScore = fields.size; }
  });
  if (best >= 0) return best;
  const first = rows.findIndex(r => r && r.filter(v => !isEmptyCell(v)).length >= 2);
  if (first < 0) return 0;
  // 첫 줄부터 날짜가 있으면 제목줄 없는 표
  return rows[first].some(v => parseSheetDate(v, { year: 2000 })) ? -1 : first;
}

/** 열 제목 — 제목줄이 없거나 비었으면 열 글자(A, B, …) */
export function headerCells(rows, headerRow) {
  const width = sheetWidth(rows);
  const header = headerRow >= 0 ? rows[headerRow] || [] : [];
  return Array.from({ length: width }, (_, i) => cellText(header[i]) || columnName(i));
}

export function columnName(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** 제목줄 아래의 내용 행들 { index(0부터), row } — 빈 줄은 뺀다 */
export function dataRows(rows, headerRow) {
  const out = [];
  for (let i = headerRow + 1; i < rows.length; i += 1) {
    if (!rowIsEmpty(rows[i])) out.push({ index: i, row: rows[i] });
  }
  return out;
}

// 열의 값들이 대부분 날짜·숫자인지
function ratio(values, test) {
  const filled = values.filter(v => !isEmptyCell(v));
  if (!filled.length) return 0;
  return filled.filter(test).length / filled.length;
}

/**
 * 열 맞추기를 짐작한다(규칙) — 열 제목의 낱말과 값의 모양(날짜·숫자)으로.
 * sheetName에 연도(2024 등)가 있으면 연도 없는 날짜에 그 해를 붙인다. today: 연도를 모를 때의 기본 해
 */
/** 시트 이름의 해·달(2024 가계부 → 2024, 3월 → 3). today: 해를 모를 때의 기본 해 */
export function sheetDateHints(sheetName, today = '') {
  const s = String(sheetName ?? '');
  const y = /(19|20)\d{2}/.exec(s);
  const mo = /(?:^|[^\d])(\d{1,2})\s*월/.exec(s);
  const month = mo && Number(mo[1]) >= 1 && Number(mo[1]) <= 12 ? Number(mo[1]) : null;
  return {
    year: y ? Number(y[0]) : (Number(String(today).slice(0, 4)) || new Date().getFullYear()),
    yearAuto: !y,
    month,
  };
}

export function guessMapping(rows, { sheetName = '', today = '' } = {}) {
  const headerRow = findHeaderRow(rows);
  const headers = headerCells(rows, headerRow);
  const sample = dataRows(rows, headerRow).slice(0, 200).map(d => d.row);
  const column = i => sample.map(r => r[i]);
  const hints = sheetDateHints(sheetName, today);
  const { year, month } = hints;
  const m = { ...EMPTY_MAPPING, headerRow, categoryColumns: [], spendTypes: [], ...hints };

  // 제목 점수가 높은 것부터 한 열에 한 항목씩
  const candidates = [];
  if (headerRow >= 0) {
    COLUMN_FIELDS.forEach((field, fi) => headers.forEach((h, col) => {
      const score = headerScore(field, rows[headerRow]?.[col]);
      if (score) candidates.push({ field, col, score, fi });
    }));
  }
  candidates.sort((a, b) => b.score - a.score || a.fi - b.fi || a.col - b.col);
  const used = new Set();
  candidates.forEach(({ field, col }) => {
    if (m[field] >= 0 || used.has(col)) return;
    m[field] = col;
    used.add(col);
  });

  // 날짜 열은 제목이 맞을 때만 일(日) 숫자도 날짜로 본다 — 값만으로 찾을 때는 수량 같은 작은 숫자 열을 날짜로 잘못 보지 않게
  const isDate = v => !!parseSheetDate(v, { year, month });
  const isFullDate = v => !!parseSheetDate(v, { year });
  const isNumber = v => { const n = parseSheetAmount(v); return n !== null && !Number.isNaN(n); };
  const unassign = (field) => { used.delete(m[field]); m[field] = -1; };

  // 값으로 확인 — 제목만 맞고 값이 아니면 놓고, 못 찾았으면 값으로 찾는다
  if (m.date >= 0 && ratio(column(m.date), isDate) < 0.5) unassign('date');
  if (m.date < 0) {
    const col = headers.findIndex((_, i) => !used.has(i) && ratio(column(i), isFullDate) >= 0.8);
    if (col >= 0) { m.date = col; used.add(col); }
  }
  if (m.amount >= 0 && ratio(column(m.amount), isNumber) < 0.5) unassign('amount');
  if (m.discount >= 0 && ratio(column(m.discount), isNumber) < 0.5) unassign('discount');
  // 글자여야 하는 열의 값이 대부분 숫자면 놓는다(예: '결제원금'·'결제후잔액'이 결제수단으로 잡힘)
  ['detail', 'memo', 'category', 'subCategory', 'payment'].forEach((f) => {
    if (m[f] >= 0 && ratio(column(m[f]), isNumber) >= 0.5) unassign(f);
  });
  if (m.type >= 0) {
    const values = column(m.type).map(v => cellText(v).replace(/\s/g, ''));
    const filled = values.filter(Boolean);
    const cancelFlag = isCancelColumn(headers[m.type], values);
    const typeLike = cancelFlag || (filled.length && filled.filter(v => TYPE_WORD.test(v)).length / filled.length >= 0.6);
    if (!typeLike) {
      const col = m.type;
      unassign('type');
      // '구분' 같은 제목인데 값이 식비·교통처럼 분류면 카테고리로 — 일시불·체크카드·타행이체 같은 거래 종류면 놓아 둔다
      const kindLike = filled.length && filled.filter(kindValue).length / filled.length >= 0.6;
      // 값이 모두 빈 열(취소가 없는 달의 '상태' 열 등)은 카테고리로 옮기지 않는다
      if (filled.length && !kindLike && m.category < 0 && ratio(column(col), isNumber) < 0.5) { m.category = col; used.add(col); }
    }
  }
  if (m.amount < 0) {
    const numeric = headers
      .map((h, i) => i)
      .filter(i => !used.has(i) && ratio(column(i), isNumber) >= 0.6 && !NOT_AMOUNT.some(w => norm(headers[i]).includes(w))
        && !TOTAL_HEADER.test(norm(headers[i])));
    if (numeric.length === 1) {
      m.amount = numeric[0];
      used.add(numeric[0]);
    } else if (numeric.length >= 2 && headerRow >= 0) {
      // 금액 열이 없고 숫자 열이 여럿 — 식비|교통비|… 처럼 카테고리마다 열이 나뉜 표로 본다
      m.amountMode = 'perCategory';
      m.categoryColumns = numeric;
    }
  }
  if (m.amountMode === 'single' && m.amount >= 0) {
    const nums = column(m.amount).map(parseSheetAmount).filter(n => n !== null && !Number.isNaN(n) && n !== 0);
    if (nums.length && nums.filter(n => n < 0).length > nums.length / 2) m.amountSign = 'negative';
  }
  if (m.type >= 0) m.spendTypes = defaultSpendTypes(typeValues(rows, m), headers[m.type]);
  return m;
}

// 취소 여부 열 — 제목에 '취소'가 있고 값이 Y/N·빈칸·'취소' 같은 표시뿐(취소가 없는 달은 모두 빈칸 — 그래도 취소 열)
function isCancelColumn(header, values) {
  const vs = values.map(v => String(v ?? '').replace(/\s/g, ''));
  return norm(header).includes('취소') && vs.every(v => !v || YES_NO.test(v) || v.includes('취소'));
}

/**
 * 구분 값 중 지출로 볼 것 — 지출·출금·사용·결제·승인·정상… 이면서 취소·수입·이체가 아닌 것.
 * 취소 여부 열(제목에 '취소', 값이 Y/N·'취소'·빈칸)이면 취소되지 않은 것(N·빈칸)
 */
export function defaultSpendTypes(values, header = '') {
  if (isCancelColumn(header, values)) {
    return values.filter((v) => { const t = String(v).replace(/\s/g, ''); return !CANCELLED.test(t) && !t.includes('취소'); });
  }
  return values.filter(v => SPEND_WORD.test(v) && !NOT_SPEND_WORD.test(v));
}

/** 구분 열에 나오는 값들(많은 순) */
export function typeValues(rows, mapping) {
  if (mapping.type < 0) return [];
  const counts = new Map();
  dataRows(rows, mapping.headerRow).forEach(({ row }) => {
    const v = cellText(row[mapping.type]);
    counts.set(v, (counts.get(v) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

// ── 값 읽기 ─────────────────────────────────────────────────────────

const dateOf = (y, m, d) => {
  const s = ymd(y, m, d);
  return isValidDateStr(s) ? s : null;
};

/** 엑셀 날짜 일련번호 → 'YYYY-MM-DD' (1970~2100년만 — 금액 같은 숫자를 날짜로 잘못 읽지 않게) */
export function excelSerialToDate(serial, date1904 = false) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  const days = Math.floor(n) + (date1904 ? 1462 : 0);
  if (days < 25569 || days > 73050) return null;
  // 엑셀은 1900-02-29가 있다고 셈하므로 1899-12-30부터 세면 1900-03-01 이후가 맞다
  const d = new Date(Date.UTC(1899, 11, 30 + days));
  return dateOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * 칸 값 → 'YYYY-MM-DD' (실제 달력에 없으면 null).
 * 2024-03-05 · 2024.3.5 · 2024/03/05 14:33 · 2024년 3월 5일 · 20240305 · 24.03.05 · 3/5/2024(미국식) · 엑셀 일련번호,
 * 연도 없는 3/5 · 3월 5일은 year가 있을 때만, 일(日)만 적힌 5 · 5일은 year와 month(시트 이름의 3월)가 있을 때만
 */
export function parseSheetDate(value, { date1904 = false, year = null, month = null } = {}) {
  if (isEmptyCell(value)) return null;
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 1 && value <= 31) return year && month ? dateOf(Number(year), Number(month), value) : null;
    if (value >= 19000101 && value <= 21001231 && Number.isInteger(value)) {
      return dateOf(Math.floor(value / 10000), Math.floor(value / 100) % 100, value % 100);
    }
    return excelSerialToDate(value, date1904);
  }
  const s = String(value).trim();
  let m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})(?!\d)/.exec(s);
  if (m) return dateOf(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{4})(\d{2})(\d{2})(?!\d)/.exec(s);
  if (m) return dateOf(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/.exec(s);
  if (m) return dateOf(Number(m[3]), Number(m[1]), Number(m[2]));
  m = /^(\d{2})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/.exec(s);
  if (m) return dateOf(2000 + Number(m[1]), Number(m[2]), Number(m[3]));
  if (/^\d{5}(\.\d+)?$/.test(s)) return excelSerialToDate(Number(s), date1904);
  m = /^(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?(?![\d/.-])/.exec(s);
  if (m && year) return dateOf(Number(year), Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})\s*일?$/.exec(s);
  if (m && year && month) return dateOf(Number(year), Number(month), Number(m[1]));
  return null;
}

/** 연도가 없는 날짜인지(3/5, 3월 5일, 일만 적힌 5) — 연도 칸을 보일지 정할 때 */
export const isYearlessDate = v => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 31)
  || (typeof v === 'string' && (/^(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?(?![\d/.-])/.test(v.trim()) || /^(\d{1,2})\s*일?$/.test(v.trim())));

/**
 * 칸 값 → 원 단위 정수. 비었으면 null, 숫자가 아니면 NaN.
 * 쉼표·공백·원·₩·￦·KRW는 무시하고(한국어 엑셀 CSV에서 원 기호가 \로 읽히는 것도), (1,000)은 음수로 읽는다
 */
export function parseSheetAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : NaN;
  let s = String(value).trim();
  if (s === '' || s === '-') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/KRW/gi, '').replace(/[,\s원₩￦\\]/g, '');
  if (s === '') return null;
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return NaN;
  const n = Math.round(Number(s));
  return negative ? -n : n;
}

// ── 적용 ────────────────────────────────────────────────────────────

/**
 * 모든 행에 열 맞추기를 적용한다.
 * 반환: { items: [{ label, date, amount, detail, memo, category, sub, payment, discount }], skipped: [{ reason, count, labels }], yearless }
 *  - items의 분류·결제수단은 파일에 적힌 값 그대로(분류 맞추기 전). 메모는 내용과 따로(가져올 때 '내용 · 메모'로 붙인다 —
 *    내용별 분류 맞추기·AI에는 내용만 쓴다)
 *  - yearless: 연도 없는 날짜 칸이 있었는지
 *  - today: 앱이 정한 해(yearAuto)로 읽은 연도 없는 날짜가 오늘보다 일주일 넘게 미래면 한 해 앞으로 본다
 *  - sheetName: 여러 시트를 함께 가져올 때 줄 이름 앞에 붙인다
 */
export function applyMapping(rows, mapping, { date1904 = false, today = '', sheetName = '' } = {}) {
  const headers = headerCells(rows, mapping.headerRow);
  const items = [];
  const skippedMap = new Map();
  let yearless = false;
  let lastDate = null;
  const skip = (reason, label) => {
    const s = skippedMap.get(reason) || { reason, count: 0, labels: [] };
    s.count += 1;
    if (s.labels.length < 5) s.labels.push(label);
    skippedMap.set(reason, s);
  };
  const at = (row, col) => (col >= 0 ? row[col] : undefined);
  const spend = new Set(mapping.spendTypes || []);
  const limit = today && isValidDateStr(today) ? addDays(today, 7) : '';
  const readDate = (raw) => {
    const opts = { date1904, year: mapping.year, month: mapping.month };
    const d = parseSheetDate(raw, opts);
    if (d && limit && mapping.yearAuto && mapping.year && isYearlessDate(raw) && d > limit) {
      return parseSheetDate(raw, { ...opts, year: Number(mapping.year) - 1 }) || d;
    }
    return d;
  };

  dataRows(rows, mapping.headerRow).forEach(({ index, row }) => {
    const label = `${sheetName ? `${sheetName} ` : ''}${index + 1}행`;
    // 합계·소계 줄 — 날짜 칸이 비어 위 날짜로 채우더라도 거래가 아니다.
    // 날짜가 빈 줄은 어느 칸이든('3월 합계', 결제수단 칸의 '합계'), 날짜가 있는 줄은 날짜·내용·분류 칸만 본다
    // (날짜가 있는 거래의 결제수단·메모가 '계'라고 건너뛰지 않게 — 일계 줄은 내용 칸에 '일계')
    const dateCell = at(row, mapping.date);
    const total = isEmptyCell(dateCell)
      ? row.some(c => totalLike(c, false))
      : [mapping.date, mapping.detail, mapping.category].some(col => col >= 0 && totalLike(row[col], true));
    if (total) { skip('합계 줄', label); return; }
    if (mapping.type >= 0) {
      const t = cellText(row[mapping.type]);
      if (!spend.has(t)) { skip(`'${t || '빈 칸'}' 줄`, label); return; }
    }
    const rawDate = at(row, mapping.date);
    if (isYearlessDate(rawDate)) yearless = true;
    let date = readDate(rawDate);
    // 하루 날짜를 여러 줄에 병합한 가계부 — 날짜 칸이 빈 줄은 위 줄의 날짜로
    if (!date && isEmptyCell(rawDate) && mapping.fillDate !== false && lastDate) date = lastDate;
    if (!date) { skip(isEmptyCell(rawDate) ? '날짜 없음' : '날짜를 읽을 수 없음', label); return; }
    lastDate = date;

    const rawDiscount = at(row, mapping.discount);
    const discountNum = parseSheetAmount(rawDiscount);
    const base = {
      label,
      date,
      detail: cellText(at(row, mapping.detail)),
      memo: cellText(at(row, mapping.memo)),
      category: cellText(at(row, mapping.category)),
      sub: cellText(at(row, mapping.subCategory)),
      payment: cellText(at(row, mapping.payment)),
      // 읽을 수 없는 할인은 글자 그대로 넘겨 가져오기 검사가 그 줄을 알린다
      discount: discountNum === null ? 0 : (Number.isNaN(discountNum) ? cellText(rawDiscount) : Math.abs(discountNum)),
    };

    if (mapping.amountMode === 'perCategory') {
      let any = false;
      (mapping.categoryColumns || []).forEach((col) => {
        const a = parseSheetAmount(row[col]);
        if (a === null || Number.isNaN(a) || a === 0) return;
        const value = mapping.amountSign === 'negative' ? -a : a;
        if (value <= 0) return;
        any = true;
        items.push({ ...base, label: `${label} ${headers[col]}`, category: headers[col], sub: '', amount: value, discount: 0 });
      });
      if (!any) skip('금액 없음', label);
      return;
    }

    const a = parseSheetAmount(at(row, mapping.amount));
    if (a === null) { skip('금액 없음(수입·빈 칸 등)', label); return; }
    if (Number.isNaN(a)) { skip('금액을 읽을 수 없음', label); return; }
    const value = mapping.amountSign === 'negative' ? -a : a;
    if (value === 0) { skip('0원', label); return; }
    if (value < 0) { skip(mapping.amountSign === 'negative' ? '양수 금액(입금·수입)' : '음수 금액(환불·수입)', label); return; }
    items.push({ ...base, amount: value });
  });

  return { items, skipped: [...skippedMap.values()].sort((x, y) => y.count - x.count), yearless };
}

/**
 * 같은 모양의 시트 여러 개(1월·2월… 시트로 나눈 가계부)에 같은 열 맞추기를 적용해 합친다.
 * 시트마다 이름의 해·달을 쓴다(사용자가 해를 정했으면 그 해). 줄 이름 앞에 시트 이름을 붙인다
 */
export function applyMappingToSheets(sheets, mapping, { date1904 = false, today = '' } = {}) {
  const skippedMap = new Map();
  const items = [];
  let yearless = false;
  sheets.forEach((sheet) => {
    const hints = sheetDateHints(sheet.name, today);
    const m = {
      ...mapping,
      year: mapping.yearAuto && !hints.yearAuto ? hints.year : mapping.year,
      month: hints.month ?? mapping.month,
    };
    const r = applyMapping(sheet.rows, m, { date1904, today, sheetName: sheets.length > 1 ? sheet.name : '' });
    items.push(...r.items);
    yearless = yearless || r.yearless;
    r.skipped.forEach((s) => {
      const t = skippedMap.get(s.reason) || { reason: s.reason, count: 0, labels: [] };
      t.count += s.count;
      t.labels = [...t.labels, ...s.labels].slice(0, 5);
      skippedMap.set(s.reason, t);
    });
  });
  return { items, skipped: [...skippedMap.values()].sort((x, y) => y.count - x.count), yearless };
}

// ── 분류 맞추기 ──────────────────────────────────────────────────────

/** 분류 열이 없으면(카테고리별 금액 열도 아니면) 내용으로 카테고리를 맞춘다 */
export const categorizesByDetail = mapping => mapping.category < 0 && mapping.amountMode !== 'perCategory';

export const detailKey = s => String(s ?? '').replace(/\s+/g, ' ').trim();
export const categoryKeyOf = (item, byDetail) => (byDetail ? `d:${detailKey(item.detail)}` : `c:${item.category}\u0001${item.sub}`);

const nameKey = s => String(s ?? '').toLowerCase().replace(/[^0-9a-z가-힣ぁ-んァ-ン一-龥]/g, '');

/**
 * 입력 습관으로 내용 → 'cat > sub' 찾기 — patterns: getDetailPatterns의 행들(한 번만 읽어 넘긴다).
 * 같은 내용(공백·기호 무시)이 먼저, 없으면 내용 안에 든 가장 긴 예전 내용(3자 이상, 예: '스타벅스 강남점' ← '스타벅스').
 * 같은 내용이 여러 분류로 들어갔으면 가장 많이 쓴 분류
 */
export function historyIndex(patterns) {
  const counts = new Map();
  (patterns || []).forEach((p) => {
    const k = nameKey(p.detail);
    if (k.length < 2 || !p.budget_category) return;
    const path = joinCategoryPath(p.budget_category, p.sub_category || '');
    const m = counts.get(k) || new Map();
    m.set(path, (m.get(path) || 0) + (Number(p.cnt) || 1));
    counts.set(k, m);
  });
  const best = new Map([...counts.entries()].map(([k, m]) => [k, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]]));
  // 내용 안에 든 예전 내용은 내용의 부분 글자를 긴 것부터 찾아본다 — 예전 내용 수와 상관없이 빠르게(내용 길이²)
  return (detail) => {
    const k = nameKey(detail).slice(0, 40);
    if (!k) return null;
    if (best.has(k)) return best.get(k);
    for (let len = k.length - 1; len >= 3; len -= 1) {
      for (let i = 0; i + len <= k.length; i += 1) {
        const hit = best.get(k.slice(i, i + len));
        if (hit) return hit;
      }
    }
    return null;
  };
}

/** 맞출 분류 목록(많은 순) — [{ key, category, sub, detail, count, examples }] */
export function distinctCategories(items, byDetail) {
  const map = new Map();
  items.forEach((it) => {
    const key = categoryKeyOf(it, byDetail);
    const g = map.get(key) || { key, category: it.category, sub: it.sub, detail: detailKey(it.detail), count: 0, examples: [] };
    g.count += 1;
    if (!byDetail && it.detail && g.examples.length < 3 && !g.examples.includes(it.detail)) g.examples.push(it.detail);
    map.set(key, g);
  });
  return [...map.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** 맞출 결제수단 목록(많은 순) — [{ key, count }] */
export function distinctPayments(items) {
  const map = new Map();
  items.forEach((it) => { if (it.payment) map.set(it.payment, (map.get(it.payment) || 0) + 1); });
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** 'cat > sub' → { cat, sub } */
export function splitCategoryPath(path) {
  const [cat, ...rest] = String(path || '').split(' > ');
  return { cat: cat.trim(), sub: rest.join(' > ').trim() };
}
export const joinCategoryPath = (cat, sub) => (sub ? `${cat} > ${sub}` : cat);

/**
 * ImportModal로 넘길 행 [{ label, raw }] — raw는 가져오기 양식과 같은 칸(payment_method, date, budget_category, …).
 *  - categoryTargets: { 분류 key → 'cat > sub' } — 없으면 파일 이름 그대로(분류 열), 내용별이면 기본 카테고리
 *  - paymentTargets: { 파일 결제수단 → 내 결제수단 } — 없으면 파일 이름 그대로
 *  - defaultCategory('cat > sub'), defaultPayment: 칸이 없거나 비었을 때
 */
export function toImportEntries(items, mapping, { categoryTargets = {}, paymentTargets = {}, defaultCategory = '', defaultPayment = '' } = {}) {
  const byDetail = categorizesByDetail(mapping);
  const fallback = splitCategoryPath(defaultCategory);
  return items.map((it) => {
    const target = categoryTargets[categoryKeyOf(it, byDetail)];
    let cat;
    let sub;
    if (target) ({ cat, sub } = splitCategoryPath(target));
    else if (!byDetail && it.category) { cat = it.category; sub = it.sub; }
    else ({ cat, sub } = fallback);
    const payment = it.payment ? (paymentTargets[it.payment] || it.payment) : defaultPayment;
    return {
      label: it.label,
      raw: {
        payment_method: payment,
        date: it.date,
        budget_category: cat,
        sub_category: sub || '',
        detail: [it.detail, it.memo].filter(Boolean).join(' · '),
        amount: it.amount,
        discount_amount: it.discount,
        discount_note: '',
        trip_name: '',
        trip_schedule: '',
      },
    };
  });
}

// ── 이 앱의 가져오기 양식 ────────────────────────────────────────────

const TEMPLATE_HEADERS = ['payment_method', 'date', 'budget_category', 'amount'];

/** 제목줄이 이 앱의 가져오기 양식(내보내기와 같은 칸)이면 그 행(0부터), 아니면 -1 */
export function appTemplateHeaderRow(rows) {
  const i = rows.findIndex(r => r && r.some(v => !isEmptyCell(v)));
  if (i < 0) return -1;
  const cells = rows[i].map(cellText);
  return TEMPLATE_HEADERS.every(h => cells.includes(h)) ? i : -1;
}

/**
 * 앱 양식 시트 → [{ label, raw: { 제목: 값 } }] (CSV 가져오기와 같은 모양).
 * 양식을 엑셀에서 채워 xlsx로 저장하면 날짜 칸이 엑셀 일련번호(숫자)가 된다 — 날짜로 바꿔 넘긴다
 */
export function templateEntries(rows, headerRow, { date1904 = false } = {}) {
  const headers = (rows[headerRow] || []).map(cellText);
  return dataRows(rows, headerRow).map(({ index, row }) => {
    const raw = {};
    headers.forEach((h, j) => {
      if (!h) return;
      const v = row[j];
      if (isEmptyCell(v)) raw[h] = '';
      else if (typeof v === 'number') raw[h] = h === 'date' ? (parseSheetDate(v, { date1904 }) || v) : v;
      else raw[h] = String(v).trim();
    });
    return { label: `${index + 1}행`, raw };
  });
}

// ── 맞춘 형식 기억(기기별) ──────────────────────────────────────────

const FORMATS_KEY = 'ledger_import_formats';
const MAX_FORMATS = 10;

/** 같은 양식인지 알아보는 표시 — 제목줄 칸들(제목줄이 없으면 열 수) */
export function formatSignature(rows, headerRow) {
  if (headerRow < 0) return `no-header:${sheetWidth(rows)}`;
  return (rows[headerRow] || []).map(v => norm(v)).join('|');
}

function readFormats() {
  try {
    const list = JSON.parse(window.localStorage.getItem(FORMATS_KEY) || '[]');
    return Array.isArray(list) ? list.filter(f => f && typeof f.signature === 'string' && f.mapping) : [];
  } catch (e) {
    return [];
  }
}

function savedFormatOf(found, { isPath, isMethod }) {
  const pick = (obj, ok) => Object.fromEntries(Object.entries(obj && typeof obj === 'object' ? obj : {})
    .filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && ok(v)));
  const str = v => (typeof v === 'string' ? v : '');
  return {
    mapping: { ...EMPTY_MAPPING, ...found.mapping },
    categoryTargets: pick(found.categoryTargets, isPath),
    paymentTargets: pick(found.paymentTargets, isMethod),
    defaultCategory: isPath(str(found.defaultCategory)) ? str(found.defaultCategory) : '',
    defaultPayment: isMethod(str(found.defaultPayment)) ? str(found.defaultPayment) : '',
  };
}

/**
 * 같은 양식으로 맞춰 둔 것 — { mapping, categoryTargets, paymentTargets, defaultCategory, defaultPayment } 또는 null.
 * 기기에 둔 이름은 지금 가계부에 없을 수 있어(지웠거나 이름을 바꿈) isPath/isMethod로 걸러 쓴다(기본값 포함, AGENTS §3)
 */
export function loadSavedFormat(signature, { isPath = () => true, isMethod = () => true } = {}) {
  const found = readFormats().find(f => f.signature === signature);
  return found ? savedFormatOf(found, { isPath, isMethod }) : null;
}

/**
 * 이 시트에 맞는 기억한 양식 — 기억할 때의 제목줄(사용자가 고친 것일 수 있음)로 이 시트의 표시를 만들어 견준다.
 * 같은 양식을 다시 올리면 짐작한 제목줄이 달라도 찾는다
 */
export function findSavedFormat(rows, { isPath = () => true, isMethod = () => true } = {}) {
  const found = readFormats().find(f => Number.isInteger(f.mapping.headerRow)
    && f.mapping.headerRow < rows.length && formatSignature(rows, f.mapping.headerRow) === f.signature);
  return found ? savedFormatOf(found, { isPath, isMethod }) : null;
}

/** 맞춘 양식을 기억한다 — 해·달은 파일마다 다르므로 남기지 않는다(다음에 올린 파일의 시트 이름·오늘로 다시 정한다) */
export function saveFormat(signature, data) {
  try {
    const list = readFormats().filter(f => f.signature !== signature);
    const { year, yearAuto, month, ...mapping } = data.mapping || {};
    list.unshift({ signature, savedAt: Date.now(), ...data, mapping });
    window.localStorage.setItem(FORMATS_KEY, JSON.stringify(list.slice(0, MAX_FORMATS)));
  } catch (e) {
    // 저장하지 못해도 가져오기는 그대로 된다
  }
}
