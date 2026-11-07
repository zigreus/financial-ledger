/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 카드 문자 붙여넣기 화면 (I-012) — 확정하기 전에는 DB에 쓰지 않고, 고른 것만 한 번에 넘긴다
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import SmsPanel from '../SmsPanel';
import * as M from '../../../services/dbManager';
import { loadCardMap } from '../../../services/cardSms';

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => {
  window.localStorage.clear();
  // 연도 없는 문자 날짜를 '오늘' 기준으로 읽으므로 날짜를 고정한다 (Date만 가짜 — React 타이머는 그대로)
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 8, 12, 0) });
});
afterEach(() => vi.useRealTimers());

function makeDb() {
  const { db } = M.createDatabase(SQL);
  ['신한카드', '현금'].forEach((n, i) => db.run('INSERT INTO payment_methods (name, sort_order) VALUES (?, ?)', [n, i]));
  db.run("INSERT INTO budget_categories (name, sort_order) VALUES ('식비', 0)");
  db.run("INSERT INTO sub_categories (budget_category, name, sort_order) VALUES ('식비', '카페', 0), ('식비', '외식', 1)");
  M.addTransaction(db, { payment_method: '신한카드', date: '2026-10-01', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 5000 });
  return db;
}

async function render(db) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onBulkAdd = vi.fn();
  const onApply = vi.fn();
  await act(async () => { root.render(<SmsPanel db={db} onApply={onApply} onBulkAdd={onBulkAdd} onClose={() => {}} />); });
  return { container, onBulkAdd, onApply };
}
const typeText = (el, value) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const button = (c, text) => [...c.querySelectorAll('button')].find(b => b.textContent.includes(text));

test('읽은 문자 중 고른 것만 추가하고, 승인 취소는 확인을 받아 지운다. 카드→결제수단을 기억한다', async () => {
  const db = makeDb();
  const cancelTarget = M.addTransaction(db, { payment_method: '신한카드', date: '2026-10-01', budget_category: '식비', sub_category: '외식', detail: '김밥천국', amount: 7000 });
  const before = M.getTransactions(db).length;
  const { container, onBulkAdd } = await render(db);

  typeText(container.querySelector('textarea'), [
    '[Web발신]',
    '신한카드(1234)승인 홍*동 12,500원(일시불)11/08 12:34 스타벅스 누적1,234,567원',
    '[Web발신]',
    '신한카드(1234)승인취소 홍*동 7,000원(일시불)10/01 13:00 김밥천국',
  ].join('\n'));
  act(() => button(container, '읽기').click());

  // 승인 1건(습관으로 다 채워져 체크됨) + 취소 1건(지울 후보 찾음)
  const items = [...container.querySelectorAll('.tp-item')];
  expect(items).toHaveLength(2);
  expect(items[0].textContent).toContain('스타벅스');
  expect(items[1].textContent).toContain('김밥천국');
  expect(M.getTransactions(db)).toHaveLength(before); // 아직 아무것도 쓰지 않았다

  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  act(() => button(container, '1건 추가').click());
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][0]).toContain('1건을 가계부에서 삭제');
  const [rows, opts] = onBulkAdd.mock.calls[0];
  expect(rows).toEqual([expect.objectContaining({
    payment_method: '신한카드', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 12500,
  })]);
  expect(opts).toEqual({ deleteIds: [cancelTarget] });
  expect(loadCardMap()['신한카드 1234']).toBe('신한카드');
  confirm.mockRestore();
});

test('삭제 확인을 취소하면 아무것도 넘기지 않는다', async () => {
  const db = makeDb();
  M.addTransaction(db, { payment_method: '신한카드', date: '2026-10-01', budget_category: '식비', sub_category: '외식', detail: '김밥천국', amount: 7000 });
  const { container, onBulkAdd } = await render(db);
  typeText(container.querySelector('textarea'), '신한카드(1234)승인취소 홍*동 7,000원(일시불)10/01 13:00 김밥천국');
  act(() => button(container, '읽기').click());
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  act(() => button(container, '1건 삭제').click());
  expect(onBulkAdd).not.toHaveBeenCalled();
  confirm.mockRestore();
});

test('중복·날짜를 못 읽은 승인은 미리 체크하지 않고, 승인 거절은 건너뛴 글로 알린다', async () => {
  const db = makeDb();
  M.addTransaction(db, { payment_method: '신한카드', date: '2026-11-08', budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 12500 });
  const { container } = await render(db);
  typeText(container.querySelector('textarea'), [
    '[Web발신]', '신한카드(1234)승인 홍*동 12,500원(일시불)11/08 12:34 스타벅스',
    '[Web발신]', '신한카드(1234)승인 홍*동 4,000원(일시불) 스타벅스',
    '[Web발신]', '신한카드(1234)승인거절 홍*동 9,000원(일시불)11/08 13:00 스타벅스 한도초과',
  ].join('\n'));
  act(() => button(container, '읽기').click());
  const boxes = [...container.querySelectorAll('.tp-item input[type="checkbox"]')];
  expect(boxes).toHaveLength(2);
  expect(boxes.map(b => b.checked)).toEqual([false, false]); // 이미 있음 / 날짜 못 읽음
  expect(container.textContent).toContain('건너뛴 글 1개 (승인 거절 1)');
});

test('승인 거절만 붙여넣으면 넣을 결제가 없다고 알린다', async () => {
  const { container } = await render(makeDb());
  typeText(container.querySelector('textarea'), '신한카드(1234)승인거절 홍*동 9,000원 11/08 13:00 스타벅스 잔액부족');
  act(() => button(container, '읽기').click());
  expect(container.querySelector('.rs-error-text').textContent).toContain('넣을 결제가 없습니다 — 건너뛴 글 1개 (승인 거절 1)');
});

test('카드 문자가 아니면 오류를 보여 주고 입력 화면에 머문다', async () => {
  const { container } = await render(makeDb());
  typeText(container.querySelector('textarea'), '안녕하세요');
  act(() => button(container, '읽기').click());
  expect(container.querySelector('.rs-error-text').textContent).toMatch(/카드 승인 문자를 찾지 못했습니다/);
  expect(container.querySelector('textarea')).not.toBeNull();
});
