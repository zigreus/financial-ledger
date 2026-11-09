/**
 * @vitest-environment jsdom
 */
// 설정 › 데이터 › 다른 계정과 함께 쓰기 (ROADMAP M-2) — 초대·참여 링크·함께 쓰는 사람·공유받은 가계부
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import LedgerShareBlock from '../SettingsView/sections/LedgerShareBlock';

global.IS_REACT_ACT_ENVIRONMENT = true;
let root;
let container;
let errors;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  errors = [];
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); delete navigator.clipboard; });

const REF = { driveId: 'mydrive', itemId: 'MINE!1' };
function makeSharing(members = []) {
  let list = [{ id: 'own', name: '엄마', email: 'mom@outlook.com', owner: true }, ...members];
  return {
    provider: 'ms',
    ownLedgerRef: vi.fn(async () => REF),
    invite: vi.fn(async (email) => { list = [...list, { id: `p-${email}`, name: '', email, owner: false }]; return REF; }),
    listMembers: vi.fn(async () => list),
    removeMember: vi.fn(async (id) => { list = list.filter(m => m.id !== id); }),
  };
}
const ledgersOf = over => ({
  provider: 'microsoft', canShare: true, sharing: makeSharing(), myName: '엄마', current: null, shared: [], switchTo: vi.fn(), leave: vi.fn(), ...over,
});
const show = ledgers => act(async () => {
  root.render(<LedgerShareBlock ledgers={ledgers} setError={(m) => { if (m) errors.push(m); }} />);
  await new Promise(r => setTimeout(r, 0));
});
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const click = el => act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)); });
const type = (input, value) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

test('이메일로 초대하면 참여 링크가 생기고 복사할 수 있다 — 함께 쓰는 사람에 보이고 뺄 수 있다(주인은 빼고 보인다)', async () => {
  const ledgers = ledgersOf();
  await show(ledgers);
  expect(container.textContent).toContain('아직 없어요');
  await type(container.querySelector('input[type="email"]'), '  dad@outlook.com ');
  await click(button('초대'));
  expect(ledgers.sharing.invite).toHaveBeenCalledWith('dad@outlook.com', expect.stringContaining('참여 링크'));
  const link = container.querySelector('.data-share-linktext').textContent;
  expect(link).toBe(`${window.location.origin}/?join=ms&drive=mydrive&item=MINE%211&from=%EC%97%84%EB%A7%88`);
  expect(container.textContent).toContain('dad@outlook.com을(를) 초대했어요');
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await click(button('링크 복사'));
  expect(writeText).toHaveBeenCalledWith(link);
  expect([...container.querySelectorAll('.data-share-member-name')].map(el => el.textContent)).toEqual(['dad@outlook.com']);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await click(button('빼기'));
  expect(ledgers.sharing.removeMember).toHaveBeenCalledWith('p-dad@outlook.com');
  expect(container.textContent).toContain('아직 없어요');
});

test('이메일이 잘못됐으면 초대하지 않고 이유를 알린다 — 이미 초대한 사람에게 보낼 링크는 따로 만들 수 있다', async () => {
  const ledgers = ledgersOf();
  await show(ledgers);
  await type(container.querySelector('input[type="email"]'), 'not-an-email');
  await click(button('초대'));
  expect(ledgers.sharing.invite).not.toHaveBeenCalled();
  expect(errors).toEqual(['초대할 사람의 이메일 주소를 확인하세요']);
  await click(button('이미 초대한 사람에게 보낼 참여 링크'));
  expect(container.querySelector('.data-share-linktext').textContent).toContain('join=ms&drive=mydrive');
});

test('공유받은 가계부를 보는 중이면 누구의 것인지와 돌아가기·목록에서 빼기 — 초대 칸은 없다', async () => {
  const current = { id: 'ms:momdrive:MOM!1', driveId: 'momdrive', itemId: 'MOM!1', ownerName: '엄마' };
  const ledgers = ledgersOf({ current, shared: [current] });
  await show(ledgers);
  expect(container.textContent).toContain('지금 엄마님이 공유한 가계부를 보고 있어요');
  expect(container.querySelector('input[type="email"]')).toBeNull();
  expect(container.textContent).toContain('보는 중');
  await click(button('내 가계부로'));
  expect(ledgers.switchTo).toHaveBeenCalledWith('');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await click(button('목록에서 빼기'));
  expect(ledgers.leave).toHaveBeenCalledWith(current.id);
});

test('공유받은 가계부 목록에서 열 수 있다', async () => {
  const other = { id: 'ms:d2:i2', driveId: 'd2', itemId: 'i2', ownerName: '할머니' };
  const ledgers = ledgersOf({ shared: [other] });
  await show(ledgers);
  await click(button('열기'));
  expect(ledgers.switchTo).toHaveBeenCalledWith('ms:d2:i2');
});

test('Google 계정·회사 계정이면 아직 안 된다고만 안내한다', async () => {
  await show(ledgersOf({ provider: 'google', canShare: false, sharing: null }));
  expect(container.textContent).toContain('Google 계정끼리 함께 쓰기는 다음 단계에서');
  expect(container.querySelector('input[type="email"]')).toBeNull();
  await show(ledgersOf({ canShare: false, sharing: null }));
  expect(container.textContent).toContain('회사·학교 Microsoft 계정은 아직');
});
