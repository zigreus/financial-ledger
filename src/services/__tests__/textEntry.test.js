// 말로 입력 — 되묻기·덧붙여 말하기 (I-017)
import initSqlJs from 'sql.js';
import { createDatabase, addCalendarEvent, addEventCountry } from '../dbManager';
import { analyzeWithAI, AIError } from '../aiClient';
import { parseTextEntry, buildTextPrompt, cleanFollowUps, UNCLEAR } from '../textEntry';

vi.mock('../aiClient', async (importOriginal) => ({ ...(await importOriginal()), analyzeWithAI: vi.fn() }));

const TODAY = '2026-11-08';
const AI = { provider: 'gemini', apiKey: 'k', model: 'gemini-flash-latest' };
let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => { analyzeWithAI.mockReset(); });

function makeDb() {
  const { db } = createDatabase(SQL, null);
  db.run("INSERT INTO payment_methods (name) VALUES ('현금'),('신한카드')");
  db.run("INSERT INTO budget_categories (name) VALUES ('식비')");
  db.run("INSERT INTO sub_categories (budget_category, name) VALUES ('식비','점심'),('식비','커피')");
  return db;
}
const entry = o => ({
  date: '', merchant: '', detail: '', amount: 0, currency: 'KRW', krw_amount: 0,
  payment_method: '모름', payment_mentioned: false, category: '모름', ...o,
});
const parse = (db, text, followUps) => parseTextEntry({ db, ai: AI, text, followUps, today: TODAY });
const sentPrompt = () => analyzeWithAI.mock.calls[0][0].prompt;

describe('지시문', () => {
  test('덧붙인 말이 없으면 이어서 나눈 말 칸이 없다', () => {
    const p = buildTextPrompt(makeDb(), '점심 김치찌개', TODAY);
    expect(p).toContain('[사용자가 말한 내용]\n점심 김치찌개');
    expect(p).not.toContain('[이어서 나눈 말');
    expect(p).toContain('금액을 말하지 않은 건도 빼지 말고 amount=0');
  });

  test('덧붙인 말은 앱이 물은 것과 함께 순서대로 붙고, 합치는 규칙이 들어간다', () => {
    const p = buildTextPrompt(makeDb(), '점심 김치찌개', TODAY, [
      { asked: '금액·결제수단을 몰라요. 알려 주세요.', said: '9천원' },
      { asked: '결제수단을 몰라요. 알려 주세요.', said: '현금이었어' },
    ]);
    const tail = p.slice(p.indexOf('[사용자가 말한 내용]'));
    expect(tail).toBe([
      '[사용자가 말한 내용]',
      '점심 김치찌개',
      '',
      '[이어서 나눈 말 — 앱이 물은 것과 사용자가 덧붙인 말]',
      '앱: 금액·결제수단을 몰라요. 알려 주세요.',
      '사용자: 9천원',
      '앱: 결제수단을 몰라요. 알려 주세요.',
      '사용자: 현금이었어',
    ].join('\n'));
    expect(p).toContain('같은 건을 따로 또 만들지 말고 하나로 합친다');
    expect(p).toContain('나중에 한 말을 따른다');
  });

  test('빈 덧붙임은 버리고, 많으면 첫 것(되묻기의 답)과 최근 5개만, 한 마디는 500자까지', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ asked: '', said: `말${i}` }));
    expect(cleanFollowUps([...many, { asked: 'x', said: '  ' }, null]).map(f => f.said))
      .toEqual(['말0', '말3', '말4', '말5', '말6', '말7']);
    expect(cleanFollowUps(many.slice(0, 6)).map(f => f.said)).toEqual(['말0', '말1', '말2', '말3', '말4', '말5']);
    expect(cleanFollowUps([{ said: 'a'.repeat(900) }])[0].said).toHaveLength(500);
    expect(cleanFollowUps('nope')).toEqual([]);
  });
});

describe('정리 결과', () => {
  test('결제 건을 못 찾으면 실패가 아니라 AI의 질문을 담은 되묻기(unclear)', async () => {
    analyzeWithAI.mockResolvedValue({ entries: [], question: '무엇을 얼마에 사셨나요?' });
    const err = await parse(makeDb(), '오늘 좀 썼어').catch(e => e);
    expect(err).toBeInstanceOf(AIError);
    expect(err.kind).toBe(UNCLEAR);
    expect(err.message).toBe('무엇을 얼마에 사셨나요?');
  });

  test('질문도 없으면 기본 되묻기, 아무것도 없는 건만 있어도 되묻기', async () => {
    analyzeWithAI.mockResolvedValueOnce({ entries: [], question: '' });
    const e1 = await parse(makeDb(), '음').catch(e => e);
    expect(e1.kind).toBe(UNCLEAR);
    expect(e1.message).toContain('무엇을 얼마에 샀는지');

    analyzeWithAI.mockResolvedValueOnce({ entries: [entry({}), entry({ payment_method: '현금' })], question: '' });
    const e2 = await parse(makeDb(), '현금').catch(e => e);
    expect(e2.kind).toBe(UNCLEAR);
  });

  test('금액을 몰라도 무엇을 샀는지 알면 정리한다 — 금액은 비워 둔다', async () => {
    analyzeWithAI.mockResolvedValue({
      entries: [entry({ detail: '김치찌개', category: '식비 > 점심' }), entry({})],
      question: '',
    });
    const list = await parse(makeDb(), '점심 김치찌개');
    expect(list).toHaveLength(1);                    // 빈 건은 버린다
    expect(list[0]).toMatchObject({ detail: '김치찌개', amount: null, budget_category: '식비', sub_category: '점심', payment_method: '' });
  });

  test('덧붙인 말을 지시문에 넣어 보낸다', async () => {
    analyzeWithAI.mockResolvedValue({ entries: [entry({ detail: '김치찌개', amount: 9000 })], question: '' });
    await parse(makeDb(), '점심 김치찌개', [{ asked: '금액을 몰라요. 알려 주세요.', said: '9천원' }]);
    expect(sentPrompt()).toContain('앱: 금액을 몰라요. 알려 주세요.\n사용자: 9천원');
  });

  test('AI가 형식 없이 글로만 되물으면(Claude) 그 글을 되묻기로 쓴다. JSON 값 한 개·글 없는 내용 오류는 그대로', async () => {
    const spoken = (reply) => {
      const e = new AIError(`AI가 결과를 기록하지 않고 이렇게 답했습니다 — "${reply}"`, 'content');
      if (reply !== undefined) e.reply = reply;
      return e;
    };
    analyzeWithAI.mockRejectedValueOnce(spoken('김치찌개는 얼마였나요?'));
    const e1 = await parse(makeDb(), '점심 김치찌개').catch(e => e);
    expect(e1.kind).toBe(UNCLEAR);
    expect(e1.message).toBe('김치찌개는 얼마였나요?');

    analyzeWithAI.mockRejectedValueOnce(spoken(`${'가'.repeat(400)}?`));
    expect((await parse(makeDb(), '음').catch(e => e)).message).toBe(`${'가'.repeat(300)}…`);

    // 묻는 글이 아니면(정리 결과를 글로만 쓴 것) 되묻기가 아니다
    analyzeWithAI.mockRejectedValueOnce(spoken('김치찌개 9000원 현금으로 정리했습니다.'));
    expect((await parse(makeDb(), '김치찌개 9천원 현금').catch(e => e)).kind).toBe('content');
    analyzeWithAI.mockRejectedValueOnce(spoken('결제수단을 알려 주세요'));
    expect((await parse(makeDb(), '김치찌개').catch(e => e)).kind).toBe(UNCLEAR);

    analyzeWithAI.mockRejectedValueOnce(spoken('null'));
    expect((await parse(makeDb(), '음').catch(e => e)).kind).toBe('content');
    analyzeWithAI.mockRejectedValueOnce(spoken(undefined));     // 안전 기준 차단 등 — reply 없음
    expect((await parse(makeDb(), '음').catch(e => e)).kind).toBe('content');
  });

  test('외화인데 환율이 없을 때 원화 금액을 덧붙이면 외화·여행 연결은 그대로 두고 원화를 채운다', async () => {
    const db = makeDb();
    const trip = addCalendarEvent(db, { title: '하와이', date_from: '2026-11-05', date_to: '2026-11-10', event_type: 'trip' });
    addEventCountry(db, trip, '미국', 'USD', 0);               // 환율을 아직 안 넣었다
    analyzeWithAI.mockResolvedValueOnce({ entries: [entry({ detail: '호텔 조식', amount: 20, currency: 'USD' })], question: '' });
    const [before] = await parse(db, '호텔 조식 20달러');
    expect(before).toMatchObject({ amount: null, foreignAmount: 20, event_id: trip });

    analyzeWithAI.mockResolvedValueOnce({ entries: [entry({ detail: '호텔 조식', amount: 20, currency: 'USD', krw_amount: 27000 })], question: '' });
    const [after] = await parse(db, '호텔 조식 20달러', [{ asked: '원화 금액을(를) 몰라요. 알려 주세요.', said: '원화로 2만7천원' }]);
    expect(after).toMatchObject({ amount: 27000, currency: 'USD', foreignAmount: 20, rate: 1350, event_id: trip, warnings: [] });
    expect(sentPrompt()).toContain('krw_amount');

    // 여행 일정이 없으면 원화만 기록된다고 알린다
    analyzeWithAI.mockResolvedValueOnce({ entries: [entry({ detail: '아마존', amount: 10, currency: 'EUR', krw_amount: 15000 })], question: '' });
    const [eur] = await parse(db, '아마존 10유로, 원화로 만오천원');
    expect(eur).toMatchObject({ amount: 15000, event_id: null, warnings: ['EUR 여행 일정이 없어 원화 금액만 기록됩니다'] });
  });

  test('말한 날짜가 앞날짜·없는 날짜라 오늘로 넣으면 그렇다고 알린다 (I-022 — 예약을 오늘 거래로 바로 넣지 않게)', async () => {
    analyzeWithAI.mockResolvedValueOnce({
      entries: [
        entry({ detail: '미용실', amount: 30000, date: '2026-11-20' }),
        entry({ detail: '김밥', amount: 4000, date: '2026-02-30' }),
        entry({ detail: '점심', amount: 9000, date: '2026-11-07' }),
        entry({ detail: '커피', amount: 2000 }),
      ],
      question: '',
    });
    const list = await parse(makeDb(), '다음 주 미용실 3만원, 김밥 4천원, 어제 점심 9천원, 커피 2천원');
    expect(list.map(s => [s.date, s.warnings])).toEqual([
      [TODAY, ['말한 날짜(2026-11-20)를 쓸 수 없어 오늘로 넣었습니다']],
      [TODAY, ['말한 날짜(2026-02-30)를 쓸 수 없어 오늘로 넣었습니다']],
      ['2026-11-07', []],
      [TODAY, []],
    ]);
  });

  test('네트워크·키 오류는 되묻기로 바꾸지 않고 그대로 전한다', async () => {
    analyzeWithAI.mockRejectedValue(new AIError('네트워크 오류 — 인터넷 연결을 확인하세요', 'network'));
    const err = await parse(makeDb(), '김치찌개 9천원').catch(e => e);
    expect(err.kind).toBe('network');
  });
});

describe('세부내역은 꼭 채우지 않는다 (I-056)', () => {
  const withDinner = () => {
    const db = makeDb();
    db.run("INSERT INTO sub_categories (budget_category, name) VALUES ('식비','저녁')");
    return db;
  };
  const addTx = (db, detail, n, sub = '저녁') => {
    for (let i = 0; i < n; i++) {
      db.run(
        "INSERT INTO transactions (date, payment_method, budget_category, sub_category, detail, amount) VALUES (?, '현금', '식비', ?, ?, 10000)",
        [TODAY, sub, detail],
      );
    }
  };

  test('세부카테고리 이름을 되풀이한 세부내역은 비운다', async () => {
    const db = withDinner();
    analyzeWithAI.mockResolvedValue({ entries: [entry({ detail: '저녁', amount: 20000, category: '식비 > 저녁' })], question: '' });
    const [s] = await parse(db, '저녁 2만원');
    expect(s).toMatchObject({ detail: '', budget_category: '식비', sub_category: '저녁', amount: 20000 });
    expect(s.sources.detail).toBeUndefined();
  });

  test('더 알려 주는 말(가게·음식)은 남긴다', async () => {
    const db = withDinner();
    analyzeWithAI.mockResolvedValue({ entries: [entry({ detail: '김치찌개', amount: 9000, category: '식비 > 저녁' })], question: '' });
    const [s] = await parse(db, '저녁 김치찌개 9천원');
    expect(s.detail).toBe('김치찌개');
  });

  test('카테고리 이름은 예전 세부내역 찾기에 쓰지 않는다', async () => {
    const db = withDinner();
    addTx(db, '저녁회식', 5);
    analyzeWithAI.mockResolvedValue({ entries: [entry({ detail: '저녁', amount: 20000, category: '식비 > 저녁' })], question: '' });
    const [s] = await parse(db, '저녁 2만원');
    expect(s.detail).toBe('');
    expect(s.historyDetail).toBe('');
  });

  test('예전에 똑같이 적은 이름이면 습관(카테고리·결제수단)은 쓰고, 세부내역은 비운다', async () => {
    const db = withDinner();
    db.run("INSERT INTO transactions (date, payment_method, budget_category, sub_category, detail, amount) VALUES (?, '신한카드', '식비', '저녁', '저녁', 10000)", [TODAY]);
    analyzeWithAI.mockResolvedValue({ entries: [entry({ detail: '저녁', amount: 20000, category: '식비 > 저녁' })], question: '' });
    const [s] = await parse(db, '저녁 2만원');
    expect(s).toMatchObject({ detail: '', historyDetail: '저녁', payment_method: '신한카드', sub_category: '저녁' });
    expect(s.sources.category).toBe('history');
  });

  test('가나·한자 세부내역은 비운 것으로 세지 않는다', () => {
    const db = withDinner();
    addTx(db, 'ラーメン', 3);
    addTx(db, '一蘭', 2);
    expect(buildTextPrompt(db, '저녁', TODAY)).not.toContain('식비 > 저녁 (');
  });

  test('세부내역을 비워 두는 습관을 지시문에 알려 준다', () => {
    const db = withDinner();
    addTx(db, '', 4);
    addTx(db, '저녁', 1);
    addTx(db, '스타벅스', 3, '커피');
    const p = buildTextPrompt(db, '저녁 2만원', TODAY);
    expect(p).toContain('[세부내역 — 꼭 채우지 않아도 됩니다]');
    expect(p).toContain('식비 > 저녁 (5/5)');
    expect(p).not.toContain('식비 > 커피 (');
  });
});
