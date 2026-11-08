/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 카드 내역 대조 화면 — 카드 전환·삭제 확인 초기화·주의 행 미체크·0건 안내·모델 안내
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js';
import { createDatabase, addTransaction, getTransactions } from '../../../services/dbManager';
import CardStatementModal from '../CardStatementModal';
import { analyzeStatement, normalizeStatement } from '../../../services/cardStatement';
import { prepareDocuments } from '../../../services/imageUtils';

vi.mock('../../../services/cardStatement', async (importOriginal) => ({ ...(await importOriginal()), analyzeStatement: vi.fn() }));
vi.mock('../../../services/imageUtils', () => ({ prepareDocuments: vi.fn() }));

global.IS_REACT_ACT_ENVIRONMENT = true;

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const TODAY = '2026-11-08';
const CARD = '신한카드';
const row = (date, merchant, amount, extra = {}) => ({
  date, merchant, amount, is_cancel: amount < 0, currency: 'KRW', foreign_amount: 0,
  installment: '', category: '식비 > 점심', detail: merchant, ...extra,
});
const statement = rows => normalizeStatement({ period_from: '2026-11-01', period_to: '2026-11-07', rows }, TODAY);

let db;
let container;
let root;
function makeDb() {
  const { db: d } = createDatabase(SQL, null);
  d.run(`INSERT INTO payment_methods (name) VALUES ('현금'),('${CARD}'),('삼성카드')`);
  d.run("INSERT INTO budget_categories (name) VALUES ('식비'),('쇼핑')");
  d.run("INSERT INTO sub_categories (budget_category, name) VALUES ('식비','점심'),('쇼핑','생활용품')");
  const add = o => addTransaction(d, { payment_method: CARD, budget_category: '식비', sub_category: '점심', ...o });
  add({ date: '2026-11-03', detail: '쿠팡', amount: 30000 });
  add({ date: '2026-11-02', detail: 'GS25', amount: 5000 });
  add({ date: '2026-11-04', detail: '스타벅스', amount: 4500 });
  return d;
}
function Host() {
  const [version, setVersion] = useState(0);
  return <CardStatementModal db={db} dataVersion={version} onChanged={() => setVersion(v => v + 1)} onClose={() => {}} />;
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('ai_receipt_config', JSON.stringify({ provider: 'gemini', keys: { gemini: 'k' }, models: {} }));
  analyzeStatement.mockReset();
  prepareDocuments.mockReset();
  prepareDocuments.mockResolvedValue({
    parts: [{ base64: 'AA', mediaType: 'image/png' }],
    previews: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AA', tiles: 1 }],
  });
  db = makeDb();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = () => act(async () => { await new Promise(res => setTimeout(res, 0)); });
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.includes(text));
const click = async (el) => {
  if (!el) throw new Error('버튼이 없습니다');
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
};
const choose = async (select, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
};
const chooseCard = name => choose(container.querySelector('.cs-field select'), name);
const pickFile = async () => {
  const input = container.querySelector('input[type=file]');
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'a.png', { type: 'image/png' })] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
};
async function openAndAnalyze(rows, onProgressInfo) {
  analyzeStatement.mockImplementationOnce(async ({ onProgress }) => {
    if (onProgressInfo) onProgress('다른 모델로 시도하는 중…', onProgressInfo);
    return statement(rows);
  });
  await click(button('대조하기'));
}
async function start() {
  await act(async () => { root.render(<Host />); });
  await chooseCard(CARD);
  await pickFile();
}
const missingRows = () => [...container.querySelectorAll('.cs-row')].filter(el => el.querySelector('input[type=checkbox]'));
const checkboxes = () => missingRows().map(el => el.querySelector('input[type=checkbox]').checked);

test('카드를 바꾸면 이전 결과 보기를 숨기고, 돌아오면 다시 보인다 — 이전 내역을 다른 카드와 비교하지 않는다', async () => {
  await start();
  await openAndAnalyze([row('2026-11-04', '스타벅스', 4500)]);
  expect(container.textContent).toContain(`${CARD} ·`);
  await click(button('다른 내역 대조'));
  expect(button('이전 결과 보기')).toBeTruthy();

  await chooseCard('삼성카드');
  expect(button('이전 결과 보기')).toBeFalsy();
  await chooseCard(CARD);
  await click(button('이전 결과 보기'));
  expect(container.textContent).toContain(`${CARD} ·`);
  expect(container.textContent).toContain('일치 1');
});

test('새 대조를 시작하면 열어 둔 삭제 확인이 닫힌다 — 새 명세서의 같은 id 행이 바로 지울 수 있게 열리지 않게', async () => {
  await start();
  await openAndAnalyze([row('2026-11-03', '쿠팡', 30000), row('2026-11-04', '쿠팡', -30000)]);
  await click(button('가계부에서 삭제…'));
  expect(button('그대로 두기')).toBeTruthy();

  await click(button('다른 내역 대조'));
  await openAndAnalyze([row('2026-11-02', 'GS25', 5000), row('2026-11-02', 'GS25', -5000)]);   // 취소 행 id가 다시 r1
  expect(container.textContent).toContain('GS25');
  expect(button('그대로 두기')).toBeFalsy();
  expect(button('가계부에서 삭제…')).toBeTruthy();
  expect(getTransactions(db, { payment_method: CARD }).map(t => t.detail).sort()).toEqual(['GS25', '스타벅스', '쿠팡']);
});

test('주의가 붙은 "가계부에 없음" 행은 미리 체크하지 않고, 분류를 바꿔도 저절로 체크하지 않는다', async () => {
  await start();
  await openAndAnalyze([
    row('2026-11-05', '김밥천국', 8000),
    row('2026-08-01', '올리브영', 12000, { installment: '3개월' }),   // 기간 밖·할부
    row('2026-11-04', '스타벅스', 4500), row('2026-11-04', '스타벅스', 4500),   // 겹친 캡처
  ]);
  expect(checkboxes()).toEqual([true, false, false]);
  expect(container.textContent).toContain('할부 결제예요');
  expect(container.textContent).toContain('같은 결제가 두 번 읽혔을 수 있어요');

  const select = missingRows()[1].querySelector('.cs-row-fields select');
  await choose(select, '쇼핑 > 생활용품');
  expect(checkboxes()).toEqual([true, false, false]);
  expect(button('선택한 1건 추가')).toBeTruthy();
});

test('읽은 행이 0건이면 "읽은 카드 내역이 없습니다" — "모두 맞습니다"도, 기간 안 가계부 전부의 "카드에 없음"도 띄우지 않는다', async () => {
  await start();
  await openAndAnalyze([]);
  expect(container.textContent).toContain('읽은 카드 내역이 없습니다');
  expect(container.textContent).not.toContain('모두 맞습니다');
  expect(container.textContent).not.toContain('카드에 없음');
});

test('고른 모델이 붐벼 다른 모델이 읽었으면 결과에 알리고, 새 분석 결과에는 남기지 않는다', async () => {
  await start();
  await openAndAnalyze([row('2026-11-04', '스타벅스', 4500)], { modelUsed: 'gemini-2.5-flash', requestedModel: 'gemini-flash-latest' });
  expect(container.querySelector('.rs-model-note').textContent).toContain('gemini-2.5-flash(으)로 읽었습니다');

  await click(button('다른 내역 대조'));
  await openAndAnalyze([row('2026-11-04', '스타벅스', 4500)]);
  expect(container.querySelector('.rs-model-note')).toBeNull();
});

test('확인만 띄운 취소 건은 "그대로 두기"를 누르면 이번 결과에서 확인거리로 세지 않는다 — 같은 날 취소 후 다시 산 경우', async () => {
  await start();
  await openAndAnalyze([
    row('2026-11-03', '쿠팡', 30000), row('2026-11-03', '쿠팡', -30000), row('2026-11-03', '쿠팡', 30000),
    row('2026-11-02', 'GS25', 5000), row('2026-11-04', '스타벅스', 4500),
  ]);
  expect(button('확인 후 삭제…')).toBeTruthy();
  expect(container.textContent).not.toContain('모두 맞습니다');
  await click(button('그대로 두기'));
  expect(button('확인 후 삭제…')).toBeFalsy();
  expect(container.textContent).toContain('모두 맞습니다');
  expect(getTransactions(db, { payment_method: CARD }).map(t => t.detail).sort()).toEqual(['GS25', '스타벅스', '쿠팡']);
});

test('나눠 결제한 묶음의 한 몫이 취소됐으면 묶인 몫을 모두 보여 주고 함께 지운다 (확인 문구와 실제 동작이 같다)', async () => {
  addTransaction(db, { payment_method: CARD, budget_category: '식비', sub_category: '점심', date: '2026-11-05', detail: '올리브영', amount: 20000, split_group_id: 'g1' });
  addTransaction(db, { payment_method: '현금', budget_category: '식비', sub_category: '점심', date: '2026-11-05', detail: '올리브영', amount: 10000, split_group_id: 'g1' });
  await start();
  await openAndAnalyze([row('2026-11-05', '올리브영', 20000), row('2026-11-06', '올리브영', -20000)]);
  await click(button('가계부에서 삭제…'));
  expect(container.textContent).toContain('나눠 결제한 묶음의 한 몫이에요');
  expect(container.textContent).toContain('현금 10,000원');
  await click(button('묶인 2건 모두 삭제'));
  expect(getTransactions(db, {}).filter(t => t.detail === '올리브영')).toEqual([]);
});

test('명세서 기간 밖 기록은 화면에 "기간 밖"으로 표시한다', async () => {
  addTransaction(db, { payment_method: CARD, budget_category: '식비', sub_category: '점심', date: '2026-10-31', detail: '맘스터치', amount: 9000 });
  await start();
  await openAndAnalyze([row('2026-11-01', '맘스터치', 9000)]);
  expect(checkboxes()).toEqual([false]);                         // 앞 명세서의 기록일 수 있어 짝짓지도, 미리 체크하지도 않는다
  expect(missingRows()[0].textContent).toContain('기간 밖');
});

// ── 5차 리뷰 (J2·J3·J5·J6) ──

test('할부 금액 차이는 고치기 버튼 대신 안내와 "그래도 카드 금액으로 수정" 링크만 보인다', async () => {
  const id = addTransaction(db, { payment_method: CARD, budget_category: '쇼핑', sub_category: '생활용품', date: '2026-11-03', detail: '삼성디지털프라자 노트북', amount: 400000 });
  await start();
  await openAndAnalyze([row('2026-11-03', '삼성디지털프라자 성수점', 1200000, { installment: '3개월' })]);
  expect(container.textContent).toContain('할부를 달마다 나눠 적고 있다면 고치지 마세요');
  expect([...container.querySelectorAll('button')].filter(b => b.textContent === '카드 금액으로 수정')).toEqual([]);
  await click(button('그래도 카드 금액으로 수정'));
  expect(getTransactions(db, {}).find(t => t.id === id).amount).toBe(1200000);
});

test('환불 행 — 원래 결제 기록이 있으면 안내하고 미리 체크, 없으면 주의를 띄우고 체크하지 않는다', async () => {
  await start();
  await openAndAnalyze([row('2026-11-05', '쿠팡(주)', -30000), row('2026-11-06', '무신사', -20000)]);
  expect(checkboxes()).toEqual([true, false]);
  expect(missingRows()[0].textContent).toContain('원래 결제(쿠팡 30,000원, 11/3)의 환불이에요');
  expect(missingRows()[1].textContent).toContain('원래 결제 기록을 찾지 못했어요 — 결제를 지웠거나 적지 않았다면 추가하지 마세요');
});

test('부분취소는 "부분취소 반영"으로 일치에 보이고, 취소 행을 추가하라고 하지 않는다', async () => {
  addTransaction(db, { payment_method: CARD, budget_category: '식비', sub_category: '점심', date: '2026-11-05', detail: 'GS칼텍스 주유', amount: 52300 });
  await start();
  await openAndAnalyze([row('2026-11-05', 'GS칼텍스 성수주유소', 100000), row('2026-11-05', 'GS칼텍스 성수주유소', -47700)]);
  expect(missingRows()).toEqual([]);
  expect(container.textContent).not.toContain('금액 차이');
  await click([...container.querySelectorAll('.cs-section-head')].find(b => b.textContent.startsWith('일치')));
  expect(container.textContent).toContain('부분취소 반영');
  expect(container.textContent).toContain('카드 100,000원 − 취소 47,700원 = 가계부 52,300원');
});

test('청구할인 줄을 읽었으면 비교에서 빼고 알린다', async () => {
  await start();
  await openAndAnalyze([row('2026-11-04', '스타벅스', 4500), row('2026-11-04', '스타벅스 청구할인', -500)]);
  expect(container.textContent).toContain('청구할인·캐시백·포인트 차감 1건은 결제·취소가 아니라서 비교에서 뺐습니다');
  expect(missingRows()).toEqual([]);
});

test('부분취소일 수 있는 환불 행은 "원래 결제 기록을 찾지 못했어요" 대신 부분취소 안내를 띄운다', async () => {
  addTransaction(db, { payment_method: CARD, budget_category: '쇼핑', sub_category: '생활용품', date: '2026-10-20', detail: '무신사', amount: 50000 });
  await start();
  await openAndAnalyze([row('2026-11-05', '무신사', -10000)]);
  expect(checkboxes()).toEqual([false]);
  expect(missingRows()[0].textContent).toContain('부분취소일 수 있어요 — 원래 결제(무신사 50,000원, 10/20 · 기간 밖)의 금액을 확인하세요');
  expect(missingRows()[0].textContent).not.toContain('원래 결제 기록을 찾지 못했어요');
});

test('카드 안의 결제와 금액이 다른 취소는 그 결제의 부분취소로 안내한다 — 둘 다 없으면 둘 다 미리 체크, 결제를 적었으면 안내만', async () => {
  await start();
  await openAndAnalyze([row('2026-11-03', '쿠팡(주)', 30000), row('2026-11-05', '쿠팡(주)', -10000), row('2026-11-06', '올리브영', 20000), row('2026-11-07', '올리브영', -5000)]);
  expect(checkboxes()).toEqual([false, true, true]);
  const text = missingRows().map(el => el.textContent).join(' | ');
  expect(text).toContain('카드의 11/3 결제(30,000원)의 부분취소예요 — 그 결제를 가계부에 원래 금액으로 적었다면 추가하세요.');
  expect(text).toContain('카드의 11/6 결제(20,000원)의 부분취소예요. 결제와 함께 추가하면 합계가 맞습니다.');
  expect(text).toContain('11/7에 5,000원이 취소된 결제예요 — 취소 행과 함께 추가하면 합계가 맞습니다.');
});

test('다른 결제수단으로 적은 환불 기록이 있으면 "추가하면 합계가 맞습니다" 안내를 함께 띄우지 않는다', async () => {
  addTransaction(db, { payment_method: '삼성카드', budget_category: '식비', sub_category: '점심', date: '2026-11-04', detail: '쿠팡 환불', amount: -30000 });
  await start();
  await openAndAnalyze([row('2026-11-05', '쿠팡(주)', -30000)]);
  expect(checkboxes()).toEqual([false]);
  expect(missingRows()[0].textContent).toContain('삼성카드(으)로 적은 기록이 있어요');
  expect(missingRows()[0].textContent).not.toContain('추가하면 합계가 맞습니다');
});

test('확인만 띄우는 취소 건은 의심의 근거인 환불 기록을 보여 준다', async () => {
  const put = o => addTransaction(db, { payment_method: CARD, budget_category: '식비', sub_category: '점심', ...o });
  put({ date: '2026-11-03', detail: '캐치테이블 예약금', amount: 10000 });
  put({ date: '2026-11-08', detail: '캐치테이블 예약금', amount: 10000 });
  put({ date: '2026-11-09', detail: '캐치테이블 예약금 환불', amount: -10000 });
  await start();
  await openAndAnalyze([row('2026-11-03', '캐치테이블', 10000), row('2026-11-04', '캐치테이블', -10000)]);
  expect(container.textContent).toContain('11/9에 같은 금액 환불 기록(캐치테이블 예약금 환불');
  expect(container.textContent).toContain('그 기록이 이 취소의 것이면 지우지 마세요');
  expect(button('확인 후 삭제…')).toBeTruthy();
});

test('수수료를 뗀 취소를 가계부에 전액으로 적었으면 서로 반대되는 안내 대신 하나로 알린다', async () => {
  const put = o => addTransaction(db, { payment_method: CARD, budget_category: '식비', sub_category: '점심', ...o });
  put({ date: '2026-11-02', detail: 'KTX', amount: 59800 });
  put({ date: '2026-11-04', detail: 'KTX 환불', amount: -59800 });
  await start();
  await openAndAnalyze([row('2026-11-04', '코레일 KTX', -59400), row('2026-11-02', '코레일 KTX', 59800)]);
  expect(checkboxes()).toEqual([false]);
  const text = missingRows()[0].textContent;
  expect(text).toContain('같은 가게 환불 기록(KTX 환불');
  expect(text).toContain('카드 취소액(-59,400원)과 다르면 그 기록의 금액을 확인하세요');
  expect(text).not.toContain('비슷한 기록이 있어요');
  expect(text).not.toContain('원래 금액으로 적었다면 추가하세요');
});

test('해외결제 취소가 거의 전액이면 "부분취소" 대신 "취소"로 안내한다', async () => {
  await start();
  await openAndAnalyze([
    row('2026-11-03', 'AMAZON.COM', 135200, { currency: 'USD', foreign_amount: 100 }),
    row('2026-11-05', 'AMAZON.COM', -136500),
  ]);
  expect(checkboxes()).toEqual([true, true]);
  expect(container.textContent).toContain('카드의 11/3 결제(135,200원)의 취소예요. 결제와 함께 추가하면 합계가 맞습니다.');
});
