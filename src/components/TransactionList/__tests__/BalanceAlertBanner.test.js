/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 잔액 위험 알림 배너 (B-066)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import BalanceAlertBanner from '../BalanceAlertBanner';

global.IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => window.localStorage.clear());

const alert = (over = {}) => ({
  accountId: 3, accountName: '생활비', threshold: 500000, date: '2026-11-25', balance: 400000, daysUntil: 17, isNow: false, ...over,
});

async function render(alerts, onOpenAccount = vi.fn()) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => { root.render(<BalanceAlertBanner alerts={alerts} onOpenAccount={onOpenAccount} />); });
  return { container, root, onOpenAccount };
}

test('내려가는 날·금액·위험선을 보여 주고, 누르면 그 계좌로 간다', async () => {
  const { container, onOpenAccount } = await render([alert()]);
  expect(container.textContent).toContain('생활비');
  expect(container.textContent).toContain('11월 25일(17일 뒤) 잔액이 400,000원으로 위험선(500,000원) 아래로 내려가요');
  act(() => container.querySelector('.balance-alert-link').click());
  expect(onOpenAccount).toHaveBeenCalledWith(3);
});

test('이미 아래면 지금 잔액으로 알린다', async () => {
  const { container } = await render([alert({ isNow: true, balance: 300000, daysUntil: 0 })]);
  expect(container.textContent).toContain('잔액 300,000원 — 위험선(500,000원)보다 적어요');
});

test('닫으면 같은 내용은 다시 안 보이고, 날짜나 금액이 바뀌면 다시 보인다', async () => {
  const first = await render([alert()]);
  act(() => first.container.querySelector('.balance-alert-close').click());
  expect(first.container.querySelector('.balance-alert')).toBeNull();
  act(() => first.root.unmount());

  const same = await render([alert()]);
  expect(same.container.querySelector('.balance-alert')).toBeNull();

  const changed = await render([alert({ balance: 350000 })]);
  expect(changed.container.querySelector('.balance-alert')).not.toBeNull();
});

test('알림이 없으면 아무것도 그리지 않는다', async () => {
  const { container } = await render([]);
  expect(container.innerHTML).toBe('');
});
