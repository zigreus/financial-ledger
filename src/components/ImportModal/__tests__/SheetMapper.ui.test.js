/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 아무 양식의 표 가져오기 (I-034, ROADMAP M-7) — 올리기 → 열 맞추기 → 분류 맞추기 → 검사·가져오기, 양식 기억, AI 추천
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../../services/dbManager';
import { analyzeWithAI, activeAI } from '../../../services/aiClient';
import ImportModal from '../ImportModal';
import { todayStr } from '../../../services/dateUtils';

vi.mock('../../../services/aiClient', async (orig) => ({ ...(await orig()), analyzeWithAI: vi.fn(), activeAI: vi.fn(() => null) }));

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

let db;
let container;
let root;
let imported;
beforeEach(() => {
  window.localStorage.clear();
  analyzeWithAI.mockReset();
  activeAI.mockReset();
  activeAI.mockReturnValue(null);
  ({ db } = M.createDatabase(SQL, null));
  M.addBudgetCategory(db, '식비');
  M.addSubCategory(db, '식비', '장보기');
  M.addSubCategory(db, '식비', '카페');
  M.addBudgetCategory(db, '기타');
  M.addPaymentMethod(db, '신한카드');
  M.addPaymentMethod(db, '현금');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  imported = 0;
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const render = () => act(async () => {
  root.render(<ImportModal db={db} dataVersion={1} onImport={() => { imported += 1; }} onClose={() => {}} />);
});
const buttons = () => [...container.querySelectorAll('button')];
const button = text => buttons().find(b => b.textContent.trim() === text);
const buttonStarting = text => buttons().find(b => b.textContent.trim().startsWith(text));
const click = el => act(async () => { el.click(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const choose = (select, value) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
});
const fieldSelect = label => [...container.querySelectorAll('.sm-field')].find(f => f.querySelector('.sm-field-label')?.textContent.replace(' 필수', '') === label)?.querySelector('select');
async function upload(name, text) {
  const input = container.querySelector('input[type="file"]');
  const file = new File([text], name);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
  await flush();
}
const txs = () => M.getTransactions(db).map(t => [t.date, t.budget_category, t.sub_category, t.payment_method, t.detail, t.amount]);

const MY_EXCEL = '우리집 가계부\n\n날짜,분류,사용처,결제,금액\n2024-03-01,식료품,이마트,신한(1234),"50,000"\n2024-03-02,외식,김밥천국,,8000\n,,,합계,58000\n';

test('직접 만든 가계부 CSV — 열을 짐작하고, 분류·결제수단을 맞춰 가져오며, 같은 양식은 다음에 바로 맞춘다', async () => {
  await render();
  await upload('가계부.csv', MY_EXCEL);
  // 1단계: 열 맞추기 — 제목줄(3행)과 열을 짐작했다
  expect(fieldSelect('제목줄').value).toBe('2');
  expect(fieldSelect('날짜').value).toBe('0');
  expect(fieldSelect('금액').value).toBe('4');
  expect(fieldSelect('카테고리').value).toBe('1');
  expect(fieldSelect('결제수단').value).toBe('3');
  expect(container.textContent).toContain('가져올 지출 2건');
  expect(container.textContent).toContain('합계 줄 1줄');
  expect(button('✨ AI로 양식 읽기').disabled).toBe(true);    // AI 키 없음
  expect(container.textContent).toContain('AI 키를 설정하면');

  await click(button('다음: 분류 맞추기'));
  // 2단계: 분류 맞추기 — 파일의 이름이 내 목록에 없으면 '그대로 새로 만들기'
  const catSelect = container.querySelector('select[aria-label="식료품 카테고리"]');
  expect(catSelect.value).toBe('');
  expect(catSelect.options[0].textContent).toBe('그대로 새로 만들기');
  await choose(catSelect, '식비 > 장보기');
  await choose(container.querySelector('select[aria-label="신한(1234) 결제수단"]'), '신한카드');
  // 결제수단이 빈 줄은 기본값(현금이 있으면 현금)
  expect(fieldSelect('결제수단이 빈 줄').value).toBe('현금');

  await click(buttonStarting('2건 검사하기'));
  // 외식은 새 카테고리로 함께 추가된다고 알린다 → 미리보기 → 가져오기
  expect(container.textContent).toContain('외식');
  expect(button('← 다시 맞추기')).toBeDefined();
  await click(button('미리보기'));
  await click(buttonStarting('2건 가져오기'));
  expect(imported).toBe(1);
  expect(txs()).toEqual([
    ['2024-03-02', '외식', '', '현금', '김밥천국', 8000],
    ['2024-03-01', '식비', '장보기', '신한카드', '이마트', 50000],
  ]);

  // 같은 양식을 다시 올리면 맞춘 그대로 — 이미 가져온 2건은 중복으로 빠진다
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  await upload('가계부-4월.csv', MY_EXCEL);
  expect(container.textContent).toContain('지난번에 맞춘 같은 양식');
  await click(button('다음: 분류 맞추기'));
  expect(container.querySelector('select[aria-label="식료품 카테고리"]').value).toBe('식비 > 장보기');
  expect(container.querySelector('select[aria-label="신한(1234) 결제수단"]').value).toBe('신한카드');
});

test('검사 단계에서 돌아가 다시 맞출 수 있다 — 맞춘 것은 남아 있다', async () => {
  await render();
  await upload('가계부.csv', MY_EXCEL);
  await click(button('다음: 분류 맞추기'));
  await choose(container.querySelector('select[aria-label="식료품 카테고리"]'), '식비 > 장보기');
  await click(buttonStarting('2건 검사하기'));
  await click(button('← 다시 맞추기'));
  expect(container.querySelector('select[aria-label="식료품 카테고리"]').value).toBe('식비 > 장보기');
  expect(M.getTransactions(db)).toHaveLength(0);           // 확정 전에는 DB에 쓰지 않는다
});

test('이 앱의 양식(내보내기 CSV)은 맞추기 없이 바로 검사한다', async () => {
  await render();
  await upload('거래.csv', 'payment_method,date,budget_category,sub_category,detail,amount\n현금,2024-03-01,식비,카페,커피,4500\n');
  expect(container.querySelector('.sm-field')).toBeNull();
  expect(buttonStarting('1건 가져오기')).toBeDefined();
});

test('분류 열이 없는 카드 내역 — 예전 입력 습관으로 먼저 맞추고, 나머지는 기본 카테고리', async () => {
  M.addTransaction(db, { payment_method: '신한카드', date: todayStr(), budget_category: '식비', sub_category: '카페', detail: '스타벅스', amount: 4500 });
  await render();
  await upload('카드.csv', '이용일,가맹점,이용금액\n2024-03-01,스타벅스,5000\n2024-03-02,알수없는가게,12000\n');
  expect(fieldSelect('카테고리').value).toBe('-1');
  await click(button('다음: 분류 맞추기'));
  expect(container.textContent).toContain('내용별 카테고리');
  const star = container.querySelector('select[aria-label="스타벅스 카테고리"]');
  expect(star.value).toBe('식비 > 카페');
  expect(star.closest('li').textContent).toContain('습관');
  expect(container.querySelector('select[aria-label="알수없는가게 카테고리"]').value).toBe('');
  expect(fieldSelect('기본 카테고리').value).toBe('기타');
  expect(fieldSelect('모두 이 결제수단으로').value).toBe('현금');
  await choose(fieldSelect('모두 이 결제수단으로'), '신한카드');
  await click(buttonStarting('2건 검사하기'));
  await click(buttonStarting('2건 가져오기'));
  expect(txs().filter(t => t[0] < '2025-01-01')).toEqual([
    ['2024-03-02', '기타', '', '신한카드', '알수없는가게', 12000],
    ['2024-03-01', '식비', '카페', '신한카드', '스타벅스', 5000],
  ]);
});

test('AI로 양식 읽기·카테고리 맞추기 — 앞부분만 보내고, 목록에 있는 답만 쓴다', async () => {
  activeAI.mockReturnValue({ provider: 'gemini', apiKey: 'k', model: 'm' });
  await render();
  // 규칙으로는 알기 어려운 제목(A·B·C 열 이름이 엉뚱함)
  await upload('이상한양식.csv', '언제,무엇,얼마,어디서\n2024-03-01,간식,3000,편의점\n2024-03-02,간식,2000,빵집\n');
  analyzeWithAI.mockResolvedValueOnce({
    header_row: 1, date: 'A', category: 'B', amount: 'C', detail: 'D', amount_mode: 'single', amount_sign: 'positive', notes: '날짜·금액 열을 찾았어요.',
  });
  await click(button('✨ AI로 양식 읽기'));
  await flush();
  expect(analyzeWithAI.mock.calls[0][0].prompt).toContain('언제 | 무엇 | 얼마 | 어디서');
  expect(container.textContent).toContain('날짜·금액 열을 찾았어요.');
  expect(container.textContent).toContain('AI에 보냈어요');
  expect(fieldSelect('카테고리').value).toBe('1');
  expect(fieldSelect('내용').value).toBe('3');

  await click(button('다음: 분류 맞추기'));
  analyzeWithAI.mockResolvedValueOnce({ matches: [{ n: 1, target: '식비 > 디저트' }] });   // 목록에 없는 답
  await click(button('✨ AI로 카테고리 맞추기'));
  await flush();
  expect(container.querySelector('select[aria-label="간식 카테고리"]').value).toBe('');
  expect(container.textContent).toContain('1개 중 0개를 맞췄어요');
  analyzeWithAI.mockResolvedValueOnce({ matches: [{ n: 1, target: '식비 > 카페' }] });
  await click(button('✨ AI로 카테고리 맞추기'));
  await flush();
  const sel = container.querySelector('select[aria-label="간식 카테고리"]');
  expect(sel.value).toBe('식비 > 카페');
  expect(sel.closest('li').textContent).toContain('AI');
  expect(analyzeWithAI.mock.calls[2][0].prompt).toContain('1. 간식 (2)');
});

test('같은 모양의 시트를 함께 가져오면 그 시트에만 있는 구분 값도 고를 수 있고 지출이면 골라 둔다', async () => {
  const table = rows => `<table><tr><th>날짜</th><th>구분</th><th>내용</th><th>금액</th></tr>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
  const html = `<html><body>${table([['2024-03-01', '지출', '점심', '9000'], ['2024-03-25', '수입', '월급', '3000000']])}${table([['2024-04-01', '카드지출', '마트', '50000']])}</body></html>`;
  await render();
  await upload('월별.html', html);
  expect(container.textContent).toContain('가져올 지출 1건');
  const together = [...container.querySelectorAll('label.sm-check')].find(l => l.textContent.includes('같은 모양의 시트 1개(표 2)도 함께 가져오기'));
  await click(together.querySelector('input'));
  expect(container.textContent).toContain('가져올 지출 2건');
  const card = [...container.querySelectorAll('label.sm-check')].find(l => l.textContent.trim() === '카드지출');
  expect(card.querySelector('input').checked).toBe(true);
  expect(container.textContent).toContain('표 2 2행');   // 시트 이름이 붙은 줄 이름
});

test('예전 엑셀 형식은 안내하고, 빈 파일은 알린다', async () => {
  await render();
  const input = container.querySelector('input[type="file"]');
  const xls = new File([new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 1, 2, 3, 4])], 'old.xls');
  Object.defineProperty(input, 'files', { value: [xls], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
  expect(container.textContent).toContain('예전 엑셀 형식(.xls)은 읽을 수 없습니다');
  await upload('empty.csv', '\n\n');
  expect(container.textContent).toContain('파일에 내용이 없습니다');
});
