// 말로 입력 — 빠진 정보 안내와, 다시 정리해도 목록에서 고른 값·끈 체크 남기기 (I-017)
import {
  suggestionGaps, describeGaps, gapQuestion, gapPlaceholder, recordPick, carryChoices,
} from '../TextFollowUp';

const sug = o => ({
  date: '2026-11-08', merchant: '', detail: '', amount: null, currency: 'KRW', foreignAmount: null,
  payment_method: '', budget_category: '', sub_category: '', warnings: [], sources: {}, ...o,
});
const full = o => sug({ detail: '김치찌개', amount: 9000, payment_method: '현금', budget_category: '식비', sub_category: '점심', ...o });

describe('빠진 정보', () => {
  test('저장에 필요한 것과 무엇에 썼는지를 순서대로', () => {
    expect(suggestionGaps(sug({}))).toEqual(['detail', 'amount', 'payment_method', 'budget_category']);
    expect(suggestionGaps(full({ sub_category: '' }))).toEqual(['sub_category']);
    expect(suggestionGaps(full({ detail: '', merchant: '김밥천국' }))).toEqual([]);
    expect(suggestionGaps(full({ amount: 0 }))).toEqual([]);   // 0원은 읽은 금액이다
  });

  test('외화는 읽었는데 원화를 못 구했으면 원화 금액을 묻는다', () => {
    const s = full({ amount: null, currency: 'USD', foreignAmount: 20 });
    expect(suggestionGaps(s)).toEqual(['krw_amount']);
    const list = describeGaps([{ s }]);
    expect(gapQuestion(list, 1)).toBe('원화 금액을(를) 몰라요. 알려 주세요.');
    expect(gapPlaceholder(list)).toBe('예) 원화로 2만7천원이었어요');
  });

  test('한 건이면 이름 없이, 여러 건이면 건마다 묻는다', () => {
    const one = describeGaps([{ s: full({ amount: null, payment_method: '' }) }]);
    expect(gapQuestion(one, 1)).toBe('금액·결제수단을(를) 몰라요. 알려 주세요.');

    const items = [{ s: full({}) }, { s: full({ detail: '스타벅스', payment_method: '' }) }, { s: sug({ amount: 4500 }) }];
    const list = describeGaps(items);
    expect(list.map(g => g.index)).toEqual([1, 2]);
    expect(gapQuestion(list, 3)).toBe('빠진 정보를 알려 주세요 — 스타벅스: 결제수단, 3번째 건: 무엇에 썼는지·결제수단·카테고리');
    expect(gapPlaceholder(list)).toBe('예) 현금으로 냈어요, 점심 김치찌개였어요');
    expect(gapQuestion([], 3)).toBe('');
  });
});

describe('목록에서 고른 값 남기기', () => {
  const picked = (s, patch) => ({ s: { ...s, ...patch }, checked: true, picks: recordPick({ s }, patch) });

  test('다시 정리해도 새로 알게 된 것이 없으면 고른 값을 쓴다', () => {
    const old = [picked(full({ payment_method: '신한카드' }), { payment_method: '현금' }), { s: full({ detail: '스타벅스' }), checked: true }];
    // 덧붙인 말은 다른 건 얘기 — 첫 건은 예전 습관대로 다시 신한카드로 나왔다
    const { items, dropped } = carryChoices(old, [full({ payment_method: '신한카드', sources: { payment_method: 'history' } }), full({ detail: '스타벅스' })]);
    expect(items[0].s.payment_method).toBe('현금');
    expect(items[0].s.sources.payment_method).toBeUndefined();
    expect(items[0].checked).toBe(true);
    expect(items[1].picks).toBeUndefined();
    expect(dropped).toEqual([]);
  });

  test('덧붙인 말로 다른 값이 나오면 그 말을 따른다', () => {
    const old = [picked(full({ payment_method: '신한카드' }), { payment_method: '현금' })];
    const { items } = carryChoices(old, [full({ payment_method: '카카오페이', sources: { payment_method: 'text' } })]);
    expect(items[0].s.payment_method).toBe('카카오페이');
  });

  test('같은 칸을 여러 번 바꿔도 처음 값과 비교하고, 카테고리도 남긴다', () => {
    const s = full({ budget_category: '', sub_category: '' });
    const first = { s, checked: false, picks: recordPick({ s }, { budget_category: '식비', sub_category: '커피' }) };
    const second = { s: { ...s, budget_category: '식비', sub_category: '커피' }, checked: true,
      picks: recordPick(first, { budget_category: '식비', sub_category: '점심' }) };
    expect(second.picks.category).toEqual({ from: '', to: '식비 > 점심' });
    const { items } = carryChoices([second], [full({ budget_category: '', sub_category: '' })]);
    expect(items[0].s).toMatchObject({ budget_category: '식비', sub_category: '점심' });
  });

  test('AI가 순서를 바꿔도 이름이 같은 건에 얹는다', () => {
    const old = [picked(full({ payment_method: '' }), { payment_method: '신한카드' }), { s: full({ detail: '스타벅스', payment_method: '' }), checked: false }];
    const { items } = carryChoices(old, [full({ detail: '스타벅스', payment_method: '' }), full({ payment_method: '' })]);
    expect(items.map(it => [it.s.detail, it.s.payment_method])).toEqual([['스타벅스', ''], ['김치찌개', '신한카드']]);
  });

  test('이름이 조금 바뀐 건("김치찌개" → "점심 김치찌개")도 같은 건으로 본다', () => {
    const old = [picked(full({ payment_method: '' }), { payment_method: '현금' }), picked(full({ detail: '스타벅스', budget_category: '' }), { budget_category: '식비', sub_category: '커피' })];
    const { items, dropped } = carryChoices(old, [full({ detail: '스타벅스 강남점', budget_category: '' }), full({ detail: '점심 김치찌개', payment_method: '' })]);
    expect(items[0].s).toMatchObject({ budget_category: '식비', sub_category: '커피' });
    expect(items[1].s.payment_method).toBe('현금');
    expect(dropped).toEqual([]);
  });

  test('이름이 아주 바뀐 한 건은 금액이 같을 때만 같은 건으로 보고, 결제수단만 이어받는다', () => {
    const lunch = full({ detail: '점심', payment_method: '', budget_category: '' });
    const old = [{ s: { ...lunch, payment_method: '현금', budget_category: '식비', sub_category: '커피' }, checked: true,
      picks: { payment_method: { from: '', to: '현금' }, category: { from: '', to: '식비 > 커피' } } }, { s: full({ detail: '스타벅스' }), checked: true }];
    const { items, dropped } = carryChoices(old, [full({ detail: '스타벅스' }), full({ detail: '부대찌개', payment_method: '', budget_category: '' })]);
    expect(items[1].s).toMatchObject({ payment_method: '현금', budget_category: '' });
    expect(items[1].picks).toEqual({ payment_method: { from: '', to: '현금' } });
    expect(dropped).toEqual([]);
  });

  test('체크를 끈 건은 다시 정리해도 끈 채로', () => {
    const old = [{ s: full({}), checked: true }, { s: full({ detail: '스타벅스' }), checked: false, off: true }];
    const { items } = carryChoices(old, [full({}), full({ detail: '스타벅스', amount: 4500 })]);
    expect(items.map(it => it.checked)).toEqual([true, false]);
    expect(items[1].off).toBe(true);
  });

  test('새 목록에서 짝을 못 찾은 건은 dropped로 알려 준다 — 엉뚱한 건에 고른 값을 얹지 않는다', () => {
    const old = [picked(full({ payment_method: '' }), { payment_method: '신한카드' }), { s: full({ detail: '스타벅스' }), checked: true }];
    const { items, dropped } = carryChoices(old, [full({ detail: '스타벅스' })]);
    expect(items).toHaveLength(1);
    expect(dropped.map(it => it.s.detail)).toEqual(['김치찌개']);

    // "편의점 3천원도 있었어"에 AI가 김치찌개를 빼고 돌려줬다 — 편의점이 김치찌개의 결제수단을 가져가지 않는다
    const r = carryChoices(old, [full({ detail: '스타벅스' }), full({ detail: '편의점', amount: 3000, payment_method: '' })]);
    expect(r.items[1].s.payment_method).toBe('');
    expect(r.items[1].checked).toBe(false);
    expect(r.dropped.map(it => it.s.detail)).toEqual(['김치찌개']);

    // 두 건의 이름이 다 바뀌면 이름을 고친 것으로 보지 않는다
    const r2 = carryChoices(old, [full({ detail: '떡볶이', payment_method: '' }), full({ detail: '라면', payment_method: '' })]);
    expect(r2.items.map(it => it.s.payment_method)).toEqual(['', '']);
    expect(r2.dropped).toHaveLength(2);
  });

  test('짧은 새 이름이 다른 긴 이름에 걸리지 않는다 ("커피"는 "커피빈 케이크"가 아니다)', () => {
    const old = [
      picked(full({ detail: '점심', payment_method: '', budget_category: '' }), { payment_method: '신한카드' }),
      picked(full({ detail: '커피빈 케이크', amount: 6000, budget_category: '' }), { budget_category: '식비', sub_category: '커피' }),
    ];
    const { items } = carryChoices(old, [full({ detail: '점심 김밥', payment_method: '' }), full({ detail: '커피', amount: 4500, budget_category: '' })]);
    expect(items[0].s.payment_method).toBe('신한카드');        // "점심 김밥"은 "점심"을 품는다
    expect(items[1].s.budget_category).toBe('');
  });
});
