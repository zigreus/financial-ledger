/**
 * @vitest-environment jsdom
 */
// 표 → 가계부 거래 (I-034, ROADMAP M-7) — 양식 짐작, 날짜·금액 읽기, 수입·이체 건너뛰기, 카테고리별 금액 열, 분류 맞추기, 형식 기억
import {
  parseSheetDate, parseSheetAmount, excelSerialToDate, findHeaderRow, guessMapping, applyMapping, toImportEntries,
  distinctCategories, distinctPayments, categorizesByDetail, appTemplateHeaderRow, templateEntries,
  formatSignature, loadSavedFormat, saveFormat, EMPTY_MAPPING, historyIndex, applyMappingToSheets, findSavedFormat,
} from '../sheetImport';

beforeEach(() => window.localStorage.clear());

describe('값 읽기', () => {
  test('날짜 — 여러 모양, 실제 달력에 없는 날은 null', () => {
    expect(parseSheetDate('2024-03-05')).toBe('2024-03-05');
    expect(parseSheetDate('2024.3.5')).toBe('2024-03-05');
    expect(parseSheetDate('2024/03/05 14:33:00')).toBe('2024-03-05');
    expect(parseSheetDate('2024.03.05(화)')).toBe('2024-03-05');
    expect(parseSheetDate('2024년 3월 5일')).toBe('2024-03-05');
    expect(parseSheetDate('20240305')).toBe('2024-03-05');
    expect(parseSheetDate(20240305)).toBe('2024-03-05');
    expect(parseSheetDate('24.03.05')).toBe('2024-03-05');
    expect(parseSheetDate('3/5/2024')).toBe('2024-03-05');
    expect(parseSheetDate(45356)).toBe('2024-03-05');               // 엑셀 일련번호
    expect(parseSheetDate('45356')).toBe('2024-03-05');
    expect(parseSheetDate(45356, { date1904: true })).toBe('2028-03-06');
    expect(parseSheetDate('3/5')).toBeNull();                       // 연도를 모르면 읽지 않는다
    expect(parseSheetDate('3/5', { year: 2024 })).toBe('2024-03-05');
    expect(parseSheetDate('3월 5일', { year: 2023 })).toBe('2023-03-05');
    expect(parseSheetDate('2024-02-30')).toBeNull();
    expect(parseSheetDate(4500)).toBeNull();                        // 금액 같은 숫자는 날짜가 아니다
    expect(parseSheetDate('합계')).toBeNull();
    expect(excelSerialToDate(45292)).toBe('2024-01-01');
  });

  test('금액 — 쉼표·원·₩·괄호 음수, 비면 null, 글자는 NaN', () => {
    expect(parseSheetAmount('12,300원')).toBe(12300);
    expect(parseSheetAmount('₩ 5,000')).toBe(5000);
    expect(parseSheetAmount('-3,000')).toBe(-3000);
    expect(parseSheetAmount('(1,500)')).toBe(-1500);
    expect(parseSheetAmount('KRW 7000')).toBe(7000);
    expect(parseSheetAmount(4500.4)).toBe(4500);
    expect(parseSheetAmount('')).toBeNull();
    expect(parseSheetAmount('-')).toBeNull();
    expect(Number.isNaN(parseSheetAmount('이천원'))).toBe(true);
  });
});

describe('양식 짐작', () => {
  test('직접 만든 엑셀 가계부 — 위에 제목·빈 줄이 있어도 제목줄을 찾고, 메모·분류·결제수단을 맞춘다', () => {
    const rows = [
      ['2024년 우리집 가계부'],
      [],
      ['날짜', '분류', '세부', '사용처', '결제', '금액', '비고'],
      ['2024-03-01', '식비', '외식', '김밥천국', '현금', '8,000', ''],
      ['2024-03-02', '교통', '', '지하철', '신한카드', '1,500', '출근'],
      ['', '', '', '', '', '9,500', '합계'],
    ];
    expect(findHeaderRow(rows)).toBe(2);
    const m = guessMapping(rows, { sheetName: '3월' });
    expect(m).toMatchObject({ headerRow: 2, date: 0, category: 1, subCategory: 2, detail: 3, payment: 4, amount: 5, memo: 6, amountMode: 'single', amountSign: 'positive' });
    const { items, skipped } = applyMapping(rows, m);
    expect(items).toEqual([
      { label: '4행', date: '2024-03-01', detail: '김밥천국', memo: '', category: '식비', sub: '외식', payment: '현금', discount: 0, amount: 8000 },
      { label: '5행', date: '2024-03-02', detail: '지하철', memo: '출근', category: '교통', sub: '', payment: '신한카드', discount: 0, amount: 1500 },
    ]);
    // 합계 줄은 날짜 칸이 비어 위 날짜로 채우더라도 거래가 아니다
    expect(skipped).toEqual([{ reason: '합계 줄', count: 1, labels: ['6행'] }]);
    // 가져올 때는 '내용 · 메모'
    expect(toImportEntries(items, m, { defaultPayment: '현금' })[1].raw.detail).toBe('지하철 · 출근');
  });

  test('다른 가계부 앱 내보내기 — 수입·지출·이체 구분이 있으면 지출만', () => {
    const rows = [
      ['날짜', '시간', '타입', '대분류', '소분류', '내용', '금액', '화폐', '결제수단', '메모'],
      ['2024-03-01', '12:00', '지출', '식비', '카페', '스타벅스', -4500, 'KRW', '현대카드', ''],
      ['2024-03-01', '09:00', '수입', '급여', '', '월급', 3000000, 'KRW', '국민은행', ''],
      ['2024-03-02', '10:00', '이체', '이체', '', '적금', -500000, 'KRW', '국민은행', ''],
      ['2024-03-03', '19:00', '지출', '식비', '장보기', '이마트', -52000, 'KRW', '현대카드', '주말'],
    ];
    const m = guessMapping(rows);
    expect(m).toMatchObject({ headerRow: 0, date: 0, type: 2, category: 3, subCategory: 4, detail: 5, amount: 6, payment: 8, memo: 9 });
    expect(m.spendTypes).toEqual(['지출']);
    expect(m.amountSign).toBe('negative');      // 지출이 음수인 내보내기
    const { items, skipped } = applyMapping(rows, m);
    expect(items.map(i => [i.date, i.detail, i.memo, i.amount])).toEqual([['2024-03-01', '스타벅스', '', 4500], ['2024-03-03', '이마트', '주말', 52000]]);
    expect(skipped.map(s => [s.reason, s.count])).toEqual([["'수입' 줄", 1], ["'이체' 줄", 1]]);
  });

  test('은행 내역 — 출금·입금·잔액 중 출금만 금액으로, 입금 줄은 건너뛴다', () => {
    const rows = [
      ['계좌번호', '123-456-789012'],
      ['거래일시', '적요', '출금액', '입금액', '잔액', '거래점'],
      ['2024.03.05 10:11', '관리비', '150,000', '', '1,000,000', '인터넷'],
      ['2024.03.06 09:00', '급여', '', '2,500,000', '3,500,000', ''],
    ];
    const m = guessMapping(rows);
    expect(m).toMatchObject({ headerRow: 1, date: 0, detail: 1, amount: 2 });
    const { items, skipped } = applyMapping(rows, m);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ date: '2024-03-05', detail: '관리비', amount: 150000 });
    expect(skipped[0]).toMatchObject({ reason: '금액 없음(수입·빈 칸 등)', count: 1 });
  });

  test('카테고리마다 금액 열이 나뉜 표 — 합계 열은 카테고리로 보지 않는다', () => {
    const rows = [
      ['일자', '내용', '식비', '교통비', '생활용품', '합계'],
      ['3/1', '점심·버스', '8000', '1500', '', '9500'],
      ['3/2', '다이소', '', '', '12000', '12000'],
    ];
    const m = guessMapping(rows, { sheetName: '2023 가계부' });
    expect(m.amountMode).toBe('perCategory');
    expect(m.categoryColumns).toEqual([2, 3, 4]);
    expect(m.year).toBe(2023);
    const { items, yearless } = applyMapping(rows, m);
    expect(yearless).toBe(true);
    expect(items.map(i => [i.label, i.date, i.category, i.amount])).toEqual([
      ['2행 식비', '2023-03-01', '식비', 8000],
      ['2행 교통비', '2023-03-01', '교통비', 1500],
      ['3행 생활용품', '2023-03-02', '생활용품', 12000],
    ]);
    expect(categorizesByDetail(m)).toBe(false);
  });

  test("'구분' 열의 값이 수입/지출이 아니라 분류면 카테고리로 본다", () => {
    const rows = [['날짜', '구분', '내용', '금액'], ['2024-03-01', '식비', '점심', '9000'], ['2024-03-02', '교통', '택시', '12000']];
    const m = guessMapping(rows);
    expect(m.type).toBe(-1);
    expect(m.category).toBe(1);
  });

  test('제목줄이 없는 CSV — 첫 줄부터 내용, 열은 값 모양으로', () => {
    const rows = [['2024-03-01', '편의점', '3200'], ['2024-03-02', '약국', '15000']];
    const m = guessMapping(rows);
    expect(m.headerRow).toBe(-1);
    expect(m.date).toBe(0);
    expect(m.amount).toBe(2);
    expect(applyMapping(rows, { ...m, detail: 1 }).items).toHaveLength(2);
  });

  test('양수가 지출인데 음수(환불)·0원·글자 금액은 이유와 함께 건너뛴다', () => {
    const rows = [['날짜', '금액'], ['2024-03-01', '-500'], ['2024-03-02', '0'], ['2024-03-03', '오천'], ['2024-03-04', '7000']];
    const { items, skipped } = applyMapping(rows, guessMapping(rows));
    expect(items).toHaveLength(1);
    expect(skipped.map(s => s.reason).sort()).toEqual(['0원', '금액을 읽을 수 없음', '음수 금액(환불·수입)'].sort());
  });
});

describe('흔한 카드·은행 양식 (리뷰에서 찾은 것)', () => {
  test('카드 명세서 승인구분(정상/취소) — 취소 줄은 빼고 정상만', () => {
    const rows = [['이용일', '가맹점', '이용금액', '승인구분'], ['2024-03-01', '전자랜드', '120,000', '정상'], ['2024-03-02', '전자랜드', '120,000', '취소'], ['2024-03-03', '편의점', '3,000', '정상']];
    const m = guessMapping(rows);
    expect(m.type).toBe(3);
    expect(m.spendTypes).toEqual(['정상']);
    expect(applyMapping(rows, m).items.map(i => i.detail)).toEqual(['전자랜드', '편의점']);
  });

  test('취소여부(Y/빈칸) — 취소된 줄만 뺀다', () => {
    const rows = [['승인일', '가맹점명', '승인금액', '취소여부'], ['2024-03-01', 'A', '1000', ''], ['2024-03-02', 'B', '2000', 'Y'], ['2024-03-03', 'C', '3000', '']];
    const m = guessMapping(rows);
    expect(m.type).toBe(3);
    expect(m.spendTypes).toEqual(['']);
    expect(applyMapping(rows, m).items.map(i => i.detail)).toEqual(['A', 'C']);
  });

  test('이용구분(일시불/할부)은 수입·지출 구분도 카테고리도 아니다 — 모든 줄을 가져온다', () => {
    const rows = [['이용일', '이용가맹점', '이용금액', '이용구분'], ['2024-03-01', 'A', '1000', '일시불'], ['2024-03-02', 'B', '30000', '할부(3개월)']];
    const m = guessMapping(rows);
    expect(m.type).toBe(-1);
    expect(m.category).toBe(-1);
    expect(applyMapping(rows, m).items).toHaveLength(2);
  });

  test('은행 거래구분(체크카드/타행이체/ATM출금)은 쓰지 않고, 내용은 적요보다 보낸분/받는분', () => {
    const rows = [
      ['거래일시', '적요', '보낸분/받는분', '송금메모', '출금액', '입금액', '잔액', '거래구분'],
      ['2024.03.05 10:11', '체크카드', '스타벅스', '', '4,500', '', '995,500', '체크카드'],
      ['2024.03.05 12:00', '타행이체', '김철수', '모임비', '30,000', '', '965,500', '타행이체'],
      ['2024.03.06 09:00', 'ATM출금', '', '', '50,000', '', '915,500', 'ATM출금'],
      ['2024.03.25 09:00', '급여', '(주)회사', '', '', '3,000,000', '3,915,500', '입금'],
    ];
    const m = guessMapping(rows);
    expect(m).toMatchObject({ date: 0, detail: 2, memo: 3, amount: 4, type: -1, category: -1 });
    const { items, skipped } = applyMapping(rows, m);
    expect(items.map(i => [i.detail, i.memo, i.amount])).toEqual([['스타벅스', '', 4500], ['김철수', '모임비', 30000], ['', '', 50000]]);
    expect(skipped[0]).toMatchObject({ reason: '금액 없음(수입·빈 칸 등)', count: 1 });
  });

  test("'구분'이 카드지출/현금지출/월급이면 지출 구분 — 월급은 뺀다", () => {
    const rows = [['날짜', '구분', '내용', '금액'], ['2024-03-01', '카드지출', '마트', '5000'], ['2024-03-02', '현금지출', '시장', '3000'], ['2024-03-25', '월급', '회사', '3000000']];
    const m = guessMapping(rows);
    expect(m.type).toBe(1);
    expect(m.spendTypes.sort()).toEqual(['카드지출', '현금지출'].sort());
    expect(applyMapping(rows, m).items.map(i => i.amount)).toEqual([5000, 3000]);
  });

  test('값이 숫자인 열은 결제수단·내용·분류로 고르지 않는다(결제원금·결제후잔액)', () => {
    const rows = [['이용일자', '이용하신곳', '이용금액', '결제원금', '결제후잔액'], ['2024-03-01', 'A', '4,500', '4,500', '0'], ['2024-03-02', 'B', '10,000', '10,000', '0']];
    const m = guessMapping(rows);
    expect(m.payment).toBe(-1);
    expect(m.amount).toBe(2);
    expect(m.detail).toBe(1);
  });

  test('하루 날짜를 여러 줄에 병합한 가계부 — 빈 날짜는 위 날짜로(끄면 건너뜀)', () => {
    const rows = [['날짜', '내용', '금액'], ['2024-03-01', '점심', '9000'], ['', '커피', '4500'], ['2024-03-02', '버스', '1500'], ['', '', ''], ['', '합계', '15000']];
    const m = guessMapping(rows);
    expect(m.fillDate).toBe(true);
    expect(applyMapping(rows, m).items.map(i => [i.date, i.detail])).toEqual([['2024-03-01', '점심'], ['2024-03-01', '커피'], ['2024-03-02', '버스']]);
    const off = applyMapping(rows, { ...m, fillDate: false });
    expect(off.items).toHaveLength(2);
    expect(off.skipped.map(s => s.reason).sort()).toEqual(['날짜 없음', '합계 줄']);
  });

  test('연도 없는 날짜 — 앱이 정한 해로 미래가 되면 한 해 앞으로, 직접 정한 해는 그대로', () => {
    const rows = [['날짜', '내용', '금액'], ['12/28', '연말', '10000'], ['1/3', '새해', '5000']];
    const m = guessMapping(rows, { today: '2027-01-10' });
    expect(m).toMatchObject({ year: 2027, yearAuto: true });
    expect(applyMapping(rows, m, { today: '2027-01-10' }).items.map(i => i.date)).toEqual(['2026-12-28', '2027-01-03']);
    expect(applyMapping(rows, { ...m, year: 2027, yearAuto: false }, { today: '2027-01-10' }).items[0].date).toBe('2027-12-28');
  });

  test('월별 시트 — 일(日)만 적힌 날짜는 시트 이름의 달로, 같은 모양의 시트를 함께', () => {
    const march = { name: '3월', rows: [['일', '내용', '금액'], [5, '점심', 9000], ['12일', '커피', '4500']] };
    const april = { name: '4월', rows: [['일', '내용', '금액'], [1, '버스', 1500]] };
    const m = guessMapping(march.rows, { sheetName: '2024 3월', today: '2024-06-01' });
    expect(m).toMatchObject({ date: 0, month: 3 });
    const r = applyMappingToSheets([march, april], m, { today: '2024-06-01' });
    expect(r.items.map(i => [i.label, i.date])).toEqual([['3월 2행', '2024-03-05'], ['3월 3행', '2024-03-12'], ['4월 2행', '2024-04-01']]);
    // 시트 하나만이면 줄 이름에 시트 이름을 붙이지 않는다
    expect(applyMappingToSheets([march], m, {}).items[0].label).toBe('2행');
  });

  test('날짜를 위 줄로 채워도 합계 줄은 거래가 아니다 — "3월 합계", "합계(원)", "총 합계", "소계(국내)"', () => {
    const rows = [['날짜', '내용', '결제', '금액'], ['2024-03-01', '점심', '현금', '7000'],
      ['', '3월 합계', '', '7000'], ['', '', '합계(원)', '7000'], ['', '총 합계', '', '7000'], ['', '소계(국내)', '', '7000'],
      ['3월 합계', '', '', '7000'], ['2024-03-02', '일계', '', '7000'], ['2024-03-03', '편의점', '계', '1000']];
    const { items, skipped } = applyMapping(rows, guessMapping(rows));
    // 날짜가 있는 거래의 결제수단이 '계'인 것은 거래로 둔다
    expect(items.map(i => [i.date, i.detail])).toEqual([['2024-03-01', '점심'], ['2024-03-03', '편의점']]);
    expect(skipped).toEqual([expect.objectContaining({ reason: '합계 줄', count: 6 })]);
  });

  test("가게 이름 속 '월계'·'일계'는 합계가 아니다 — '이마트 월계점', '제일계란' / '3월 월계', '일계 5건'은 합계", () => {
    const rows = [['날짜', '내용', '금액'], ['2024-03-01', '이마트 월계점', '50000'], ['', '홈플러스 월계점', '30000'],
      ['2024-03-02', '제일계란', '8000'], ['', '3월 월계', '88000'], ['2024-03-03', '일계 5건', '1000'],
      ['', '3월 계', '88000'], ['', '월계(3월)', '88000']];
    const { items, skipped } = applyMapping(rows, guessMapping(rows));
    expect(items.map(i => [i.date, i.detail])).toEqual([
      ['2024-03-01', '이마트 월계점'], ['2024-03-01', '홈플러스 월계점'], ['2024-03-02', '제일계란'],
    ]);
    expect(skipped).toEqual([expect.objectContaining({ reason: '합계 줄', count: 4 })]);
  });

  test("취소가 없는 달의 '취소여부' 열(모두 빈칸)은 취소 열 — 카테고리로 잡지 않고 모두 가져온다", () => {
    const rows = [['이용일', '가맹점', '금액', '취소여부', '상태'], ['2024-03-01', 'A', '1000', '', ''], ['2024-03-02', 'B', '2000', '', '']];
    const m = guessMapping(rows);
    expect(m).toMatchObject({ type: 3, spendTypes: [''], category: -1 });
    expect(applyMapping(rows, m).items).toHaveLength(2);
  });

  test("'구분'이 식비·자동차·카드값·인터넷 같은 카테고리면 카테고리로(거래 종류로 보지 않는다)", () => {
    const rows = [['날짜', '구분', '내용', '금액'], ['2024-03-01', '식비', '점심', '9000'], ['2024-03-02', '자동차', '주유', '50000'],
      ['2024-03-03', '카드값', '결제', '300000'], ['2024-03-04', '인터넷', '통신비', '30000']];
    const m = guessMapping(rows);
    expect(m.type).toBe(-1);
    expect(m.category).toBe(1);
  });

  test("취소구분 열의 값이 '취소'와 빈칸이면 빈칸을 지출로", () => {
    const rows = [['이용일', '가맹점', '금액', '취소구분'], ['2024-03-01', 'A', '1000', ''], ['2024-03-02', 'B', '2000', '취소'], ['2024-03-03', 'C', '3000', '']];
    const m = guessMapping(rows);
    expect(m.type).toBe(3);
    expect(m.spendTypes).toEqual(['']);
    expect(applyMapping(rows, m).items.map(i => i.detail)).toEqual(['A', 'C']);
  });

  test('금액 기호 — 한국어 엑셀 CSV의 \\, 전각 ￦', () => {
    expect(parseSheetAmount('\\1,234')).toBe(1234);
    expect(parseSheetAmount('￦5,000')).toBe(5000);
  });
});

describe('분류 맞추기 → 가져오기 행', () => {
  const rows = [
    ['날짜', '분류', '내용', '결제수단', '금액'],
    ['2024-03-01', '식료품', '이마트', '신한(1234)', '50000'],
    ['2024-03-02', '식료품', '홈플러스', '신한(1234)', '30000'],
    ['2024-03-03', '외식', '김밥', '', '7000'],
  ];
  const m = guessMapping(rows);
  const { items } = applyMapping(rows, m);

  test('맞출 목록은 많은 순, 내용 예시와 함께', () => {
    expect(distinctCategories(items, false).map(c => [c.category, c.count, c.examples])).toEqual([['식료품', 2, ['이마트', '홈플러스']], ['외식', 1, ['김밥']]]);
    expect(distinctPayments(items)).toEqual([{ key: '신한(1234)', count: 2 }]);
  });

  test('맞춘 이름으로 바꾸고, 맞추지 않은 것은 파일 이름 그대로, 빈 결제수단은 기본값', () => {
    const cats = distinctCategories(items, false);
    const entries = toImportEntries(items, m, {
      categoryTargets: { [cats[0].key]: '식비 > 장보기' },
      paymentTargets: { '신한(1234)': '신한카드' },
      defaultPayment: '현금',
    });
    expect(entries.map(e => [e.label, e.raw.budget_category, e.raw.sub_category, e.raw.payment_method, e.raw.amount])).toEqual([
      ['2행', '식비', '장보기', '신한카드', 50000],
      ['3행', '식비', '장보기', '신한카드', 30000],
      ['4행', '외식', '', '현금', 7000],
    ]);
  });

  test('분류 열이 없으면 내용별로 맞추고, 맞추지 않은 내용은 기본 카테고리', () => {
    const noCat = guessMapping([['날짜', '가맹점', '이용금액'], ['2024-03-01', '스타벅스', '4500'], ['2024-03-02', '쿠팡', '30000']]);
    expect(categorizesByDetail(noCat)).toBe(true);
    const r = applyMapping([['날짜', '가맹점', '이용금액'], ['2024-03-01', '스타벅스', '4500'], ['2024-03-02', '쿠팡', '30000']], noCat);
    const keys = distinctCategories(r.items, true).map(c => c.key);
    expect(keys).toEqual(['d:스타벅스', 'd:쿠팡']);
    const entries = toImportEntries(r.items, noCat, { categoryTargets: { 'd:스타벅스': '식비 > 카페' }, defaultCategory: '기타', defaultPayment: '카드' });
    expect(entries.map(e => [e.raw.budget_category, e.raw.sub_category, e.raw.payment_method])).toEqual([['식비', '카페', '카드'], ['기타', '', '카드']]);
  });
});

test('입력 습관 — 같은 내용이 먼저, 없으면 내용 안에 든 가장 긴 예전 내용(3자 이상), 여러 분류면 많이 쓴 것', () => {
  const find = historyIndex([
    { detail: '스타벅스', budget_category: '식비', sub_category: '카페', cnt: 5 },
    { detail: '스타벅스', budget_category: '여행', sub_category: '', cnt: 1 },
    { detail: '이마트', budget_category: '식비', sub_category: '장보기', cnt: 2 },
    { detail: '마트', budget_category: '생활', sub_category: '', cnt: 9 },
    { detail: 'GS', budget_category: '교통', sub_category: '주유', cnt: 3 },
  ]);
  expect(find('스타벅스')).toBe('식비 > 카페');
  expect(find('스타벅스 강남점')).toBe('식비 > 카페');
  expect(find('이마트 성수점')).toBe('식비 > 장보기');      // '마트'(2자)보다 '이마트'(3자)
  expect(find('마트')).toBe('생활');
  expect(find('GS25 역삼점')).toBeNull();                   // 2자 이름은 같을 때만
  expect(find('')).toBeNull();
});

describe('이 앱의 양식·형식 기억', () => {
  test('앱 내보내기 양식이면 그대로 읽는다', () => {
    const rows = [['_no', 'payment_method', 'date', 'budget_category', 'sub_category', 'detail', 'amount'], [1, '현금', '2024-03-01', '식비', '', '점심', 9000]];
    expect(appTemplateHeaderRow(rows)).toBe(0);
    expect(templateEntries(rows, 0)).toEqual([{ label: '2행', raw: { _no: 1, payment_method: '현금', date: '2024-03-01', budget_category: '식비', sub_category: '', detail: '점심', amount: 9000 } }]);
    expect(appTemplateHeaderRow([['날짜', '금액']])).toBe(-1);
  });

  test('양식을 엑셀에서 채워 xlsx로 저장하면 날짜가 일련번호 — 날짜로 바꿔 넘긴다', () => {
    const rows = [['payment_method', 'date', 'budget_category', 'amount'], ['현금', 45356, '식비', 9000]];
    expect(templateEntries(rows, 0)[0].raw.date).toBe('2024-03-05');
    expect(templateEntries(rows, 0, { date1904: true })[0].raw.date).toBe('2028-03-06');
  });

  test('기억한 양식은 기억할 때의 제목줄로 찾고(짐작이 달라도), 해·달은 남기지 않으며, 없는 기본값은 버린다', () => {
    const rows = [['우리집'], ['메모 줄', '', ''], ['언제', '얼마', '무엇']];
    saveFormat(formatSignature(rows, 2), {
      mapping: { ...EMPTY_MAPPING, headerRow: 2, date: 0, amount: 1, detail: 2, year: 2020, yearAuto: false, month: 5 },
      categoryTargets: {}, paymentTargets: {}, defaultCategory: '지운 것', defaultPayment: '현금',
    });
    const stored = JSON.parse(window.localStorage.getItem('ledger_import_formats'))[0];
    expect(stored.mapping).not.toHaveProperty('year');
    expect(stored.mapping).not.toHaveProperty('month');
    const found = findSavedFormat(rows, { isPath: () => false, isMethod: m => m === '현금' });
    expect(found.mapping).toMatchObject({ headerRow: 2, date: 0, amount: 1 });
    expect(found.defaultCategory).toBe('');
    expect(found.defaultPayment).toBe('현금');
    expect(findSavedFormat([['다른', '양식']])).toBeNull();
  });

  test('같은 제목줄이면 맞춘 형식을 다시 쓰고, 지금 가계부에 없는 이름은 버린다', () => {
    const rows = [['날짜', '분류', '금액']];
    const sig = formatSignature(rows, 0);
    expect(sig).toBe(formatSignature([['날짜 ', '분류', '금액']], 0));
    saveFormat(sig, {
      mapping: { ...EMPTY_MAPPING, date: 0, category: 1, amount: 2 },
      categoryTargets: { 'c:식료품\u0001': '식비 > 장보기', 'c:옛날\u0001': '지운 카테고리' },
      paymentTargets: { 신한: '신한카드' },
      defaultCategory: '',
      defaultPayment: '현금',
    });
    const loaded = loadSavedFormat(sig, { isPath: p => p === '식비 > 장보기', isMethod: () => true });
    expect(loaded.mapping).toMatchObject({ date: 0, category: 1, amount: 2, amountMode: 'single' });
    expect(loaded.categoryTargets).toEqual({ 'c:식료품\u0001': '식비 > 장보기' });
    expect(loaded.defaultPayment).toBe('현금');
    expect(loadSavedFormat('다른양식')).toBeNull();
  });
});
