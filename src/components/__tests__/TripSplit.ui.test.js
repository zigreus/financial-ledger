/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 여행 정산 화면 (I-030, ROADMAP C-11) — 일행 추가·몫, 일행이 낸 돈 적기, 나눔·빼기, 정산 결과·복사, 캘린더 설정 켜고 끄기
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../services/dbManager';
import TripSplitModal from '../TripSplit/TripSplitModal';
import CalendarSection from '../SettingsView/sections/CalendarSection';

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

let db;
let trip;
let event;
let container;
let root;
let version = 0;
beforeEach(() => {
  ({ db } = M.createDatabase(SQL, null));
  trip = M.addCalendarEvent(db, { title: '제주 여행', date_from: '2026-10-01', date_to: '2026-10-03', event_type: 'trip' });
  event = { id: trip, title: '제주 여행', date_from: '2026-10-01' };
  M.addTransaction(db, { payment_method: '카드', date: '2026-10-01', budget_category: '여행', detail: '숙소', amount: 120000, event_id: trip });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

const show = () => act(async () => {
  root.render(<TripSplitModal db={db} dataVersion={version += 1} event={event} onClose={() => {}} onChanged={() => {}} />);
});
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text || b.getAttribute('aria-label') === text || b.title === text);
const click = async el => { await act(async () => { el.click(); }); await show(); };
const type = (el, value) => act(async () => {
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});

test('처음에는 우리만 — 일행을 더하면 우리가 낸 여행 거래를 나눠 보낼 돈을 알려 준다', async () => {
  await show();
  expect(container.querySelector('.ts-result').textContent).toContain('주고받을 돈이 없어요 — 아래에 일행을 더하세요');
  await type(container.querySelector('input[aria-label="일행 이름"]'), '민수네');
  await click(button('추가'));
  expect(container.querySelector('.ts-transfers').textContent).toBe('민수네 → 우리 60,000원');
  await click(button('민수네 몫 늘리기'));
  expect(container.querySelector('.ts-transfers').textContent).toBe('민수네 → 우리 80,000원');
  expect(M.getTripParticipants(db, trip).map(p => [p.name, p.weight])).toEqual([['우리', 1], ['민수네', 2]]);
});

test('일행이 낸 돈 적기 — 잘못된 금액은 막고, 수식은 계산한다', async () => {
  M.addTripParticipant(db, trip, '민수');
  await show();
  await click(button('+ 일행이 낸 돈 적기'));
  await type(container.querySelector('#ts-title'), '렌터카');
  await type(container.querySelector('#ts-amount'), '3만');
  await click([...container.querySelectorAll('.ts-form button')].find(b => b.textContent === '추가'));
  expect(container.querySelector('.ts-form .ts-error').textContent).toContain('금액을 0보다 크게 올바르게 입력하세요');
  await type(container.querySelector('#ts-amount'), '45000*2');
  await click([...container.querySelectorAll('.ts-form button')].find(b => b.textContent === '추가'));
  expect(container.querySelector('.ts-error')).toBeNull();
  const s = M.getTripSettlement(db, trip);
  expect(s.items.find(i => i.kind === 'payment')).toMatchObject({ payer: '민수', title: '렌터카', amount: 90000, date: '2026-10-01' });
  expect(s.transfers).toEqual([{ from: '민수', to: '우리', amount: 15000 }]);
});

test('거래마다 나눌 사람을 고르거나 정산에서 뺀다', async () => {
  M.addTripParticipant(db, trip, '민수');
  await show();
  await click(button('나눔: 모두'));
  const mine = [...container.querySelectorAll('.ts-pick')].find(l => l.textContent === '우리').querySelector('input');
  await click(mine);                                                     // 우리를 빼면 민수 몫만
  expect(M.getTripSettlement(db, trip).transfers).toEqual([{ from: '민수', to: '우리', amount: 120000 }]);
  await click(button('정산에서 빼기'));
  expect(M.getTripSettlement(db, trip).total).toBe(0);
  expect(container.textContent).toContain('정산에서 뺐어요');
});

test('일행에서 빼면 확인하고, 그 사람이 낸 돈도 지운다고 알린다', async () => {
  M.addTripParticipant(db, trip, '민수');
  M.addTripPayment(db, trip, { payer: '민수', title: '택시', date: '2026-10-01', amount: 20000, sharedBy: [] });
  await show();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  await click(button('민수 일행에서 빼기'));
  expect(confirm.mock.calls[0][0]).toContain('민수님이 낸 돈 기록 1건이 함께 지워집니다');
  expect(M.getTripParticipants(db, trip).map(p => p.name)).toEqual(['우리']);
});

test('낸 돈 폼을 연 채 그 사람 이름을 바꾸면 다시 고르라고 막는다', async () => {
  M.addTripParticipant(db, trip, '민수');
  await show();
  await click(button('+ 일행이 낸 돈 적기'));
  await click(button('민수 이름 바꾸기'));
  await type(container.querySelector('input[aria-label="민수 새 이름"]'), '민수네');
  await click(button('저장'));
  await type(container.querySelector('#ts-amount'), '90000');
  await click([...container.querySelectorAll('.ts-form button')].find(b => b.textContent === '추가'));
  expect(container.querySelector('.ts-form .ts-error').textContent).toContain('낸 사람을 다시 고르세요');
  expect(M.getTripSettlement(db, trip).items.filter(i => i.kind === 'payment')).toHaveLength(0);
  await type(container.querySelector('#ts-payer'), '민수네');
  await click([...container.querySelectorAll('.ts-form button')].find(b => b.textContent === '추가'));
  expect(M.getTripSettlement(db, trip).items.find(i => i.kind === 'payment')).toMatchObject({ payer: '민수네', amount: 90000 });
});

test('일행이 낸 돈 고치기, 나눌 사람 바꾸기', async () => {
  M.addTripParticipant(db, trip, '민수');
  M.addTripParticipant(db, trip, '지영');
  M.addTripPayment(db, trip, { payer: '민수', title: '택시', date: '2026-10-02', amount: 20000, sharedBy: [] });
  await show();
  await click(button('고치기'));
  await type(container.querySelector('#ts-amount'), '24000');
  await click([...container.querySelectorAll('.ts-form button')].find(b => b.textContent === '저장'));
  expect(M.getTripSettlement(db, trip).items.find(i => i.kind === 'payment').amount).toBe(24000);
  await click([...container.querySelectorAll('.ts-link')].filter(b => b.textContent === '나눔: 모두')[1]);
  const jy = [...container.querySelectorAll('.ts-pick')].find(l => l.textContent === '지영').querySelector('input');
  await click(jy);
  expect(M.getTripSettlement(db, trip).items.find(i => i.kind === 'payment').sharedBy).toEqual(['우리', '민수']);
});

test('일행 목록에 없는 이름이 적힌 지출은 알리고, 다시 더할 수 있다', async () => {
  M.addTripParticipant(db, trip, '민수');
  db.run("INSERT INTO trip_split_entries (event_id, transaction_id, payer, title, date, amount, shared_by) VALUES (?, NULL, '철수', '렌터카', '2026-10-01', 60000, '')", [trip]);
  await show();
  expect(container.querySelector('.ts-warn').textContent).toContain('일행 목록에 없는 이름');
  expect(container.querySelector('.ts-item-warn').textContent).toContain('철수');
  await click(button('철수 다시 더하기'));
  expect(container.querySelector('.ts-warn')).toBeNull();
  expect(M.getTripSettlement(db, trip).total).toBe(180000);
});

test('이름을 바꾼 사람의 옛 이름은 일행 중 한 사람으로 바꿔 잇는다(같은 사람이 둘이 되지 않게)', async () => {
  M.addTripParticipant(db, trip, '민수네');
  db.run("INSERT INTO trip_split_entries (event_id, transaction_id, payer, title, date, amount, shared_by) VALUES (?, NULL, '민수', '렌터카', '2026-10-01', 90000, '[\"민수\",\"우리\"]')", [trip]);
  await show();
  await type(container.querySelector('select[aria-label="민수을(를) 바꿔 이을 일행"]'), '민수네');
  await click(button('바꿔 잇기'));
  const s = M.getTripSettlement(db, trip);
  expect(s.unknownNames).toEqual([]);
  expect(s.people.map(p => p.name)).toEqual(['우리', '민수네']);
  expect(s.items.find(i => i.kind === 'payment')).toMatchObject({ payer: '민수네', sharedBy: ['민수네', '우리'] });
});

test('정산에서 뺀 일행 지출은 고쳐도 빠진 채로, 다시 나누기로 넣는다', async () => {
  M.addTripParticipant(db, trip, '민수');
  M.addTripPayment(db, trip, { payer: '민수', title: '선물', date: '2026-10-02', amount: 30000, sharedBy: [] });
  await show();
  const sub = () => [...container.querySelectorAll('.ts-item')].find(li => li.textContent.includes('선물'));
  await click([...sub().querySelectorAll('button')].find(b => b.textContent === '정산에서 빼기'));
  await click([...sub().querySelectorAll('button')].find(b => b.textContent === '고치기'));
  expect(container.querySelector('.ts-form').textContent).toContain('정산에서 빠져 있어요');
  await type(container.querySelector('#ts-title'), '선물(포장)');
  await click([...container.querySelectorAll('.ts-form button')].find(b => b.textContent === '저장'));
  expect(M.getTripSettlement(db, trip).items.find(i => i.kind === 'payment')).toMatchObject({ title: '선물(포장)', excluded: true });
  await click([...sub().querySelectorAll('button')].find(b => b.textContent === '다시 나누기'));
  expect(M.getTripSettlement(db, trip).items.find(i => i.kind === 'payment').excluded).toBe(false);
});

test('복사하지 못하면 공유할 글을 펼쳐 직접 복사하게 한다', async () => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
  await show();
  expect(container.querySelector('.ts-preview').open).toBe(false);
  await click(button('정산 내용 복사'));
  expect(container.querySelector('.ts-preview').open).toBe(true);
  expect(container.textContent).toContain('아래 펼친 글을 길게 눌러 복사하세요');
});

test('정산 내용 복사', async () => {
  M.addTripParticipant(db, trip, '민수');
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await show();
  await click(button('정산 내용 복사'));
  expect(writeText.mock.calls[0][0]).toContain('· 민수 → 우리 60,000원');
  expect(container.textContent).toContain('복사했어요');
});

test('캘린더 설정에서 켜고 끈다', async () => {
  await act(async () => {
    root.render(<CalendarSection db={db} dataVersion={version += 1} onChanged={() => {}} subTab="types" onSubTabChange={() => {}} />);
  });
  await act(async () => { button('일행 정산 (N빵) 켜기').click(); });
  expect(M.isTripSplitEnabled(db)).toBe(true);
});
