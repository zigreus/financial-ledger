/**
 * @vitest-environment node
 */
// 걸러진 거래 요약 (ROADMAP C-7, I-021) — 합계·구성은 규칙으로, AI에는 집계만
import { analyzeWithAI } from '../aiClient';
import { summarizeTransactions, buildSummaryPrompt, summarizeWithAI, shareOf } from '../txSummary';

vi.mock('../aiClient', () => ({ analyzeWithAI: vi.fn() }));

const tx = (date, budget_category, sub_category, detail, amount, extra = {}) => ({
  date, budget_category, sub_category, detail, amount, discount_amount: 0, payment_method: '신한카드', member: '', ...extra,
});
const sample = () => [
  tx('2026-10-02', '식비', '카페', '스타벅스', 5000),
  tx('2026-10-15', '식비', '카페', '스타벅스', 6000),
  tx('2026-11-01', '식비', '외식', '김밥천국', 9000, { payment_method: '현금', member: '엄마' }),
  tx('2026-11-03', '쇼핑', '생활용품', '쿠팡', 50000, { discount_amount: 5000 }),
  tx('2026-11-05', '식비', '카페', ' 스타벅스 ', 4500),
  tx('2026-11-06', '교통', '택시', '', 12000),
];

beforeEach(() => { analyzeWithAI.mockReset(); });

describe('집계', () => {
  test('순지출 합계·평균·할인·날짜 범위는 월 머리말과 같은 계산(금액 - 할인)', () => {
    const s = summarizeTransactions(sample());
    expect(s.count).toBe(6);
    expect(s.total).toBe(5000 + 6000 + 9000 + 45000 + 4500 + 12000);
    expect(s.discount).toBe(5000);
    expect(s.average).toBe(Math.round(81500 / 6));
    expect([s.dateFrom, s.dateTo]).toEqual(['2026-10-02', '2026-11-06']);
  });

  test('카테고리(세부 포함)·결제수단·월은 많은/이른 순, 내용은 앞뒤 공백을 무시하고 묶으며 빈 내용은 뺀다', () => {
    const s = summarizeTransactions(sample());
    expect(s.categories.map(c => [c.name, c.total, c.count])).toEqual([['쇼핑', 45000, 1], ['식비', 24500, 4], ['교통', 12000, 1]]);
    expect(s.categories[1].subs.map(c => [c.name, c.total])).toEqual([['카페', 15500], ['외식', 9000]]);
    expect(s.paymentMethods.map(p => p.name)).toEqual(['신한카드', '현금']);
    expect(s.months.map(m => [m.name, m.count])).toEqual([['2026-10', 2], ['2026-11', 4]]);
    expect(s.details.map(d => [d.name, d.total, d.count])).toEqual([['쿠팡', 45000, 1], ['스타벅스', 15500, 3], ['김밥천국', 9000, 1]]);
    expect(s.members.map(m => m.name)).toEqual(['(누가 없음)', '엄마']);
    expect(s.biggest.map(b => [b.detail || b.category, b.amount])).toEqual([['쿠팡', 45000], ['교통', 12000], ['김밥천국', 9000]]);
  });

  test('누가를 쓰지 않으면 구성원별은 비우고, 거래가 없으면 0', () => {
    expect(summarizeTransactions(sample().map(t => ({ ...t, member: '' }))).members).toEqual([]);
    expect(summarizeTransactions([])).toMatchObject({ count: 0, total: 0, average: 0, categories: [], biggest: [] });
    expect(shareOf(50, 200)).toBe(25);
    expect(shareOf(5, 0)).toBeNull();
  });
});

describe('AI 요약', () => {
  const lineOf = (prompt, head) => prompt.split('\n').find(l => l.startsWith(head));

  test('지시문에는 집계만 담는다 — 조건, 합계, 상위 목록, 가장 큰 3건(날짜 대신 달)', () => {
    const many = Array.from({ length: 40 }, (_, i) => tx(`2026-11-${String((i % 28) + 1).padStart(2, '0')}`, `카테고리${i % 12}`, '세부', `가게${i}`, 1000 + i));
    const prompt = buildSummaryPrompt(summarizeTransactions(many), '기간 2026-11 · 검색어 "가게"', '2026-11-08');
    expect(prompt).toContain('조건: 기간 2026-11 · 검색어 "가게"');
    expect(prompt).toContain('거래 40건 · 순지출 합계');
    // 카테고리는 상위 8개, 내용은 상위 10개까지만 — 거래 하나하나를 보내지 않는다
    expect(lineOf(prompt, '카테고리별').split(' | ')).toHaveLength(8);
    expect(lineOf(prompt, '많이 쓴 내용').split(' | ')).toHaveLength(10);
    expect(lineOf(prompt, '가장 큰 지출').split(' | ')).toHaveLength(3);
    expect(lineOf(prompt, '가장 큰 지출')).not.toMatch(/2026-11-\d\d/);
    expect(lineOf(prompt, '가장 큰 지출')).toContain('2026-11 가게');
    expect(prompt).not.toContain('가게0 ');
  });

  test('오늘 날짜를 알리고, 이번 달은 진행 중·앞으로의 달은 예정 거래만이라고 표시해 비교하지 않게 한다', () => {
    const txs = [
      tx('2026-09-10', '식비', '', '마트', 100000),
      tx('2026-11-03', '식비', '', '마트', 20000),
      tx('2026-12-25', '주거/통신', '', '관리비', 150000), // 자동등록이 미리 넣은 정기지출
    ];
    const prompt = buildSummaryPrompt(summarizeTransactions(txs), '전체 거래', '2026-11-08');
    expect(prompt.split('\n')[0]).toBe('오늘: 2026-11-08');
    expect(lineOf(prompt, '월별')).toBe('월별: 2026-09 100,000원(1건) | 2026-11 20,000원(1건) (진행 중) | 2026-12 150,000원(1건) (예정 거래만)');
  });

  test('가게·메모는 30자까지만, 구성원별은 두 명 이상일 때만 보낸다', () => {
    const long = '아주 긴 메모 '.repeat(10);
    const txs = [tx('2026-11-01', '식비', '', long, 5000, { member: '엄마' }), tx('2026-11-02', '식비', '', '김밥', 3000, { member: '엄마' })];
    const one = buildSummaryPrompt(summarizeTransactions(txs), '누가 엄마', '2026-11-08');
    expect(one).not.toContain('누가 쓴 것');                       // 한 사람만 걸러 봄
    expect(lineOf(one, '많이 쓴 내용')).toContain(`${long.trim().slice(0, 30)}…`);
    expect(one).not.toContain(long.trim());
    // 이름 있는 구성원이 한 명뿐이면 '누가 없음'이 섞여 있어도 보내지 않는다
    const oneNamed = buildSummaryPrompt(summarizeTransactions([...txs, tx('2026-11-03', '식비', '', '빵', 2000)]), '전체', '2026-11-08');
    expect(oneNamed).not.toContain('누가 쓴 것');
    const two = buildSummaryPrompt(summarizeTransactions([...txs, tx('2026-11-03', '식비', '', '빵', 2000, { member: '아빠' })]), '전체', '2026-11-08');
    expect(lineOf(two, '누가 쓴 것')).toBe('누가 쓴 것: 엄마 8,000원(2건) | 아빠 2,000원(1건)');
  });

  test('집계를 보내 요약을 받고, 길이·개수를 다듬는다', async () => {
    analyzeWithAI.mockResolvedValue({
      headline: '  이번 조건에서는 쇼핑에 가장 많이 썼어요. ',
      points: ['쿠팡 45,000원이 가장 큰 지출입니다', '', '스타벅스에 3번 15,500원', 'x'.repeat(300), '다섯째', '여섯째', '일곱째'],
      tip: '',
    });
    const controller = new AbortController();
    const onProgress = vi.fn();
    const result = await summarizeWithAI({ ai: { provider: 'gemini' }, stats: summarizeTransactions(sample()), filterText: '전체 거래', signal: controller.signal, onProgress });
    expect(result.headline).toBe('이번 조건에서는 쇼핑에 가장 많이 썼어요.');
    expect(result.points).toHaveLength(5);
    expect(result.points[2]).toHaveLength(201); // 200자 + …
    expect(result.tip).toBe('');
    const call = analyzeWithAI.mock.calls[0][0];
    expect(call.toolName).toBe('summarize_spending');
    expect(call.schema.required).toEqual(['headline', 'points']);
    expect(call.signal).toBe(controller.signal);
    expect(call.onProgress).toBe(onProgress);
    expect(call.files).toBeUndefined(); // 글만 보낸다
    expect(call.system).toContain('주어진 값을 그대로 인용');
  });

  test('글자가 아닌 칸(객체 등)은 버린다 — "[object Object]"가 화면에 나오지 않게', async () => {
    analyzeWithAI.mockResolvedValue({ headline: { text: 'x' }, points: ['좋아요', { a: 1 }, 3], tip: ['x'] });
    const result = await summarizeWithAI({ ai: {}, stats: summarizeTransactions(sample()), filterText: '' });
    expect(result).toEqual({ headline: '', points: ['좋아요'], tip: '' });
  });

  test('빈 답이면 다시 시도하라고, 거래가 없으면 부르지 않는다', async () => {
    analyzeWithAI.mockResolvedValue({ headline: ' ', points: [] });
    await expect(summarizeWithAI({ ai: {}, stats: summarizeTransactions(sample()), filterText: '' })).rejects.toThrow('다시 시도');
    await expect(summarizeWithAI({ ai: {}, stats: summarizeTransactions([]), filterText: '' })).rejects.toThrow('요약할 거래가 없습니다');
    expect(analyzeWithAI).toHaveBeenCalledTimes(1);
  });
});
