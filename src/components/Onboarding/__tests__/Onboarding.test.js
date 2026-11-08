/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 첫 실행 안내 화면 (F-3, I-019) — 고르고 다듬는 동안은 가계부에 쓰지 않고, 확정할 때 한 번에 넣는다
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import Onboarding from '../Onboarding';
import * as M from '../../../services/dbManager';
import { attachChangeLog, getChangeLog } from '../../../services/changeLog';

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const roots = [];
afterEach(() => {
  roots.splice(0).forEach(({ root, container }) => { act(() => root.unmount()); container.remove(); });
});

async function render(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => { root.render(<Onboarding {...props} />); });
  return container;
}
const buttons = (c) => [...c.querySelectorAll('button')];
const button = (c, text) => buttons(c).find(b => b.textContent.includes(text));
const chip = (c, text) => [...c.querySelectorAll('.onb-chip')].find(b => b.textContent === text);
const click = (el) => act(async () => { el.click(); });
function type(el, value) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setup() {
  const { db } = M.createDatabase(SQL, null);
  attachChangeLog(db);
  const props = { db, onDone: vi.fn(), onClose: vi.fn(), onLater: vi.fn(), onOpenImport: vi.fn() };
  return { db, props };
}

test('가구 유형을 고르고 다듬는 동안은 가계부에 쓰지 않고, 확정하면 고른 것만 한 번에 넣는다', async () => {
  const { db, props } = setup();
  const c = await render(props);
  expect(c.textContent).toContain('가계부를 시작해요');
  expect(buttons(c).filter(b => b.className === 'onb-template').map(b => b.querySelector('strong').textContent))
    .toEqual(['1인 가구', '맞벌이', '아이 있는 집']);

  await click(button(c, '아이 있는 집'));
  expect(c.textContent).toContain('육아');
  // 카테고리 하나 빼기, 세부카테고리 하나 빼기, 결제수단 하나 빼고 카드 하나 더하기
  const finance = [...c.querySelectorAll('.onb-cat')].find(el => el.textContent.startsWith('금융'));
  await click(finance.querySelector('input[type="checkbox"]'));
  await click(chip(c, '배달'));
  await click(chip(c, '계좌이체'));
  const input = c.querySelector('.onb-add input');
  await act(async () => { type(input, ' 신한카드 '); });
  await click(button(c, '추가'));
  expect(input.value).toBe('');
  expect(getChangeLog(db).entries).toHaveLength(0); // 아직 아무것도 쓰지 않았다

  await click(button(c, '이대로 시작하기'));
  expect(props.onDone).toHaveBeenCalledTimes(1);
  const counts = props.onDone.mock.calls[0][0];
  expect(M.getBudgetCategories(db)).not.toContain('금융');
  expect(M.getBudgetCategories(db)).toEqual(expect.arrayContaining(['육아', '교육']));
  expect(counts.categories).toBe(M.getBudgetCategories(db).length);
  expect(M.getSubCategories(db, '식비')).toEqual(['장보기', '외식', '카페·간식']);
  expect(M.getPaymentMethods(db)).toEqual(['신용카드', '체크카드', '현금', '신한카드']);
  expect(counts.paymentMethods).toBe(4);
});

test('카테고리의 세부카테고리를 모두 빼면 이유를 보여 주고 시작할 수 없다 — 다시 고르면 풀린다', async () => {
  const { db, props } = setup();
  const c = await render(props);
  await click(button(c, '1인 가구'));
  await click(chip(c, '기타'));
  const start = button(c, '이대로 시작하기');
  expect(start.disabled).toBe(true);
  expect(c.querySelector('.onb-problem').textContent).toContain("'기타'의 세부카테고리를 하나 이상");
  // 이유는 긴 목록 끝이 아니라 화면 아래에 붙은 시작 버튼 바로 위에 보인다
  expect(c.querySelector('.onb-footer .onb-problem')).not.toBeNull();
  expect(c.querySelector('.onb-footer').contains(start)).toBe(true);
  await click(start);
  expect(props.onDone).not.toHaveBeenCalled();
  expect(M.isBlankLedger(db)).toBe(true);

  await click(chip(c, '기타'));
  expect(button(c, '이대로 시작하기').disabled).toBe(false);
  expect(c.querySelector('.onb-problem')).toBeNull();
});

test('결제수단을 모두 빼면 시작할 수 없다, 이미 있는 이름을 더하면 다시 켜기만 한다', async () => {
  const { props } = setup();
  const c = await render(props);
  await click(button(c, '맞벌이'));
  for (const name of ['신용카드', '체크카드', '현금', '계좌이체']) await click(chip(c, name));
  expect(button(c, '이대로 시작하기').disabled).toBe(true);
  expect(c.querySelector('.onb-problem').textContent).toContain('결제수단을 하나 이상');

  await act(async () => { type(c.querySelector('.onb-add input'), '현금'); });
  await click(button(c, '추가'));
  expect([...c.querySelectorAll('.onb-chip')].filter(b => b.textContent === '현금')).toHaveLength(1);
  expect(chip(c, '현금').getAttribute('aria-pressed')).toBe('true');
  expect(button(c, '이대로 시작하기').disabled).toBe(false);
});

test('나중에·✕·가져오기는 가계부에 아무것도 쓰지 않는다 — ✕는 이번만 닫고, 나중에는 다음부터 저절로 열지 않는다', async () => {
  const { db, props } = setup();
  const c = await render(props);
  await click(button(c, '나중에 할게요'));
  expect(props.onLater).toHaveBeenCalledTimes(1);
  await click(c.querySelector('.modal-close'));
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(props.onLater).toHaveBeenCalledTimes(1);
  await click(button(c, '가져오기'));
  expect(props.onOpenImport).toHaveBeenCalledTimes(1);

  await click(button(c, '1인 가구'));
  expect(c.textContent).toContain('자기계발');
  await click(button(c, '이전'));
  await click(button(c, '아이 있는 집'));
  expect(c.textContent).toContain('육아');
  expect(c.textContent).not.toContain('자기계발');
  expect(getChangeLog(db).entries).toHaveLength(0);
});

test('그 사이 다른 기기가 카테고리를 넣었으면 덮어쓰지 않고 이유를 보여 준다', async () => {
  const { db, props } = setup();
  const c = await render(props);
  await click(button(c, '1인 가구'));
  M.addPaymentMethod(db, '다른 기기 카드'); // 다른 기기의 변경이 합쳐져 들어옴
  await click(button(c, '이대로 시작하기'));
  expect(props.onDone).not.toHaveBeenCalled();
  expect(c.querySelector('.onb-problem').textContent).toMatch(/이미 카테고리·결제수단이나 거래가 있는/);
  expect(M.getBudgetCategories(db)).toEqual([]);
});

test('어느 계정의 저장소에 새 가계부가 만들어졌는지 알려 준다 — 다른 계정으로 잘못 로그인한 가족이 알아채게', async () => {
  const { props } = setup();
  const c = await render({ ...props, accountLabel: 'kid@outlook.com의 OneDrive' });
  const note = c.querySelector('.onb-account');
  expect(note.textContent).toContain('kid@outlook.com의 OneDrive에 새 가계부가 만들어졌어요');
  expect(note.textContent).toContain('가족이 쓰는 계정으로 다시 로그인');

  const plain = await render(props);
  expect(plain.querySelector('.onb-account')).toBeNull();
});
