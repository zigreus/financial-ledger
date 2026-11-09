// 가져오기 AI 도우미 (I-034, ROADMAP M-7) — 보내는 범위(앞줄·긴 숫자 가림), 답 검사(열 범위·목록에 있는 이름만), 나눠 묻기
import { analyzeWithAI } from '../aiClient';
import {
  maskCell, sheetSampleText, mappingFromAI, suggestSheetMapping, suggestCategoryMatches, suggestPaymentMatches, SAMPLE_ROWS,
} from '../importAI';

vi.mock('../aiClient', () => ({ analyzeWithAI: vi.fn() }));
const ai = { provider: 'gemini', apiKey: 'k', model: 'm' };
// 중괄호로 감싼다 — 돌려준 함수(가짜 AI)를 Vitest가 정리용 함수로 알고 테스트 뒤에 부르지 않게
beforeEach(() => { analyzeWithAI.mockReset(); });

describe('보내는 범위', () => {
  test('계좌·카드번호처럼 긴 숫자는 가리고, 날짜·금액·짧은 번호는 그대로', () => {
    expect(maskCell('123-456-789012')).toBe('############');
    expect(maskCell('1234-5678-9012-3456')).toBe('############');
    expect(maskCell('110123456789')).toBe('############');
    expect(maskCell('20240305143300')).toBe('20240305143300');
    expect(maskCell('2024-03-05')).toBe('2024-03-05');
    expect(maskCell('1,500,000')).toBe('1,500,000');
    expect(maskCell('010-1234-5678 홍길동')).toBe('########### 홍길동');
    expect(maskCell(45356)).toBe('45356');
    expect(maskCell('가'.repeat(40))).toBe(`${'가'.repeat(30)}…`);
  });

  test('빈틈 없이 — 숫자로 저장된 번호, 19·20으로 시작하는 번호, 9자리 유선 전화, 주민번호', () => {
    expect(maskCell(110123456789)).toBe('############');          // 엑셀 숫자 칸의 계좌번호
    expect(maskCell(1012345678)).toBe('##########');              // 숫자로 저장된 휴대폰 번호
    expect(maskCell(1500000)).toBe('1500000');                    // 금액은 그대로
    expect(maskCell(20240305)).toBe('20240305');                  // 날짜 숫자
    expect(maskCell('20123456789012')).toBe('############');      // 20으로 시작하는 계좌번호(달이 34)
    expect(maskCell('2001013234567')).toBe('############');       // 2000년대생 주민번호
    expect(maskCell('900101-1234567')).toBe('############');
    expect(maskCell('02-123-4567')).toBe('#########');            // 9자리 유선 전화
    expect(maskCell('2024-03-05 14:33:00')).toBe('2024-03-05 14:33:00');
    expect(maskCell('202403051433')).toBe('202403051433');
    expect(maskCell('1234 5678 9012 3456')).toBe('############');
  });

  test('앞 15줄만 — 제목줄이 아래에 있으면 그 아래 8줄까지(최대 30줄)', () => {
    const rows = Array.from({ length: 100 }, (_, i) => [`r${i + 1}`, i]);
    const a = sheetSampleText(rows);
    expect(a.rowsSent).toBe(SAMPLE_ROWS);
    expect(a.text.split('\n')[0]).toBe('행 | A | B');
    expect(a.text.split('\n')[1]).toBe('1 | r1 | 0');
    expect(sheetSampleText(rows, { headerRow: 12 }).rowsSent).toBe(21);
    expect(sheetSampleText(rows, { headerRow: 40 }).rowsSent).toBe(30);
  });
});

describe('양식 읽기 답 검사', () => {
  const rows = [['날짜', '분류', '내용', '금액', '구분'], ['2024-03-01', '식비', '점심', '9000', '지출']];

  test('열 글자 → 번호, 범위 밖·겹치는 열은 버린다', () => {
    const { mapping, notes } = mappingFromAI({
      header_row: 1, date: 'A', category: 'B', detail: 'C', amount: 'D', type: 'E', payment: 'Z', memo: 'A',
      amount_mode: 'single', amount_sign: 'positive', spend_type_values: ['지출', 3], notes: '날짜와 금액을 찾았어요.',
    }, rows, { year: 2024 });
    expect(mapping).toMatchObject({ headerRow: 0, date: 0, category: 1, detail: 2, amount: 3, type: 4, payment: -1, memo: -1, year: 2024 });
    expect(mapping.spendTypes).toEqual(['지출']);
    expect(notes).toBe('날짜와 금액을 찾았어요.');
  });

  test('카테고리별 금액 열', () => {
    const wide = [['일자', '식비', '교통', '합계'], ['2024-03-01', '1000', '2000', '3000']];
    const { mapping } = mappingFromAI({ header_row: 1, date: 'A', amount_mode: 'per_category', category_columns: ['B', 'C', 'Q'] }, wide);
    expect(mapping).toMatchObject({ amountMode: 'perCategory', categoryColumns: [1, 2], amount: -1 });
  });

  test('날짜·금액을 못 찾은 답은 쓰지 않는다', () => {
    expect(() => mappingFromAI({ header_row: 1, date: '', amount_mode: 'single' }, rows)).toThrow('날짜·금액 열을 찾지 못했습니다');
    expect(() => mappingFromAI({ header_row: 1, date: 'A', amount: '', amount_mode: 'single' }, rows)).toThrow();
    expect(() => mappingFromAI(null, rows)).toThrow();
  });

  test('suggestSheetMapping은 앞부분만 보낸다', async () => {
    analyzeWithAI.mockResolvedValue({ header_row: 1, date: 'A', amount: 'D', amount_mode: 'single' });
    const many = [...rows, ...Array.from({ length: 50 }, () => ['2024-03-02', '교통', '버스', '1500', '지출'])];
    const r = await suggestSheetMapping({ ai, rows: many, sheetName: '3월' });
    expect(r.mapping).toMatchObject({ date: 0, amount: 3 });
    const { prompt } = analyzeWithAI.mock.calls[0][0];
    expect(prompt).toContain('[시트 이름] 3월');
    expect(prompt.split('\n').filter(l => /^\d+ \|/.test(l))).toHaveLength(SAMPLE_ROWS);
  });
});

describe('분류·결제수단 맞추기', () => {
  const paths = ['식비 > 장보기', '식비 > 카페', '교통'];

  test('목록에 있는 이름만 받고, 번호가 틀리거나 없는 이름은 버린다', async () => {
    analyzeWithAI.mockResolvedValue({ matches: [
      { n: 1, target: '식비 > 장보기' }, { n: 2, target: '식비 > 디저트' }, { n: 9, target: '교통' }, { n: 3, target: '' },
    ] });
    const values = [{ key: 'c:식료품', label: '식료품', count: 5 }, { key: 'c:간식', label: '간식', count: 2 }, { key: 'c:기타', label: '기타', count: 1 }];
    expect(await suggestCategoryMatches({ ai, values, paths })).toEqual({ 'c:식료품': '식비 > 장보기' });
    const { prompt, system } = analyzeWithAI.mock.calls[0][0];
    expect(prompt).toContain('식비 > 카페');
    expect(prompt).toContain('1. 식료품 (5)');
    expect(system).toContain('분류 이름');
  });

  test('이름이 많으면 나눠 묻고, 내용별은 많이 나온 것부터 정한 수까지만', async () => {
    analyzeWithAI.mockImplementation(async ({ prompt }) => ({
      matches: prompt.split('\n').filter(l => /^\d+\. /.test(l)).map(l => ({ n: Number(l.split('.')[0]), target: '교통' })),
    }));
    const values = Array.from({ length: 400 }, (_, i) => ({ key: `d:${i}`, label: `가게${i}`, count: 1 }));
    const r = await suggestCategoryMatches({ ai, values, paths, byDetail: true });
    expect(analyzeWithAI).toHaveBeenCalledTimes(3);             // 360개를 120개씩
    expect(Object.keys(r)).toHaveLength(360);
    expect(analyzeWithAI.mock.calls[0][0].system).toContain('가게');
  });

  test('목록이 비면 묻지 않는다', async () => {
    expect(await suggestCategoryMatches({ ai, values: [{ key: 'a', label: 'a', count: 1 }], paths: [] })).toEqual({});
    expect(await suggestPaymentMatches({ ai, values: [], methods: ['현금'] })).toEqual({});
    expect(analyzeWithAI).not.toHaveBeenCalled();
  });

  test('결제수단 — 이름 속 카드번호는 가려서 보낸다', async () => {
    analyzeWithAI.mockResolvedValue({ matches: [{ n: 1, target: '신한카드' }, { n: 2, target: '롯데카드' }] });
    const r = await suggestPaymentMatches({ ai, values: [{ key: '신한(1234-5678-9012-3456)', label: '신한(1234-5678-9012-3456)', count: 3 }, { key: '롯데', label: '롯데', count: 1 }], methods: ['신한카드', '현금'] });
    expect(r).toEqual({ '신한(1234-5678-9012-3456)': '신한카드' });
    expect(analyzeWithAI.mock.calls[0][0].prompt).toContain('1. 신한(############) (3)');
    expect(analyzeWithAI.mock.calls[0][0].prompt).not.toContain('5678');
  });
});
