/**
 * @vitest-environment jsdom
 */
// 설정 › 정보 (I-038, ROADMAP M-5) — 버전·운영·문의, 처리방침·약관 링크, 문제 알리기(보고 직접 복사·메일, 자동으로 보내지 않음)
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import AboutSection from '../SettingsView/sections/AboutSection';
import { getErrorLog, recordError } from '../../services/errorLog';
import { setCurrentDrive } from '../../services/storage/driveName';

const cfg = vi.hoisted(() => ({ email: '' }));
vi.mock('../../config', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, get CONTACT_EMAIL() { return cfg.email; } };
});

global.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;
beforeEach(() => {
  window.localStorage.clear();
  cfg.email = '';
  setCurrentDrive('google');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
const realExecCommand = document.execCommand;
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  setCurrentDrive('onedrive');
  delete navigator.clipboard;
  document.execCommand = realExecCommand;
});

const show = () => act(async () => { root.render(<AboutSection />); });
const button = label => [...container.querySelectorAll('button, a')].find(b => b.textContent === label);
const report = () => container.querySelector('.preport-text').textContent;
const typeNote = (value) => {
  const area = container.querySelector('textarea.preport-note');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  act(() => {
    setter.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

test('버전·운영(앱 이름)·문의 준비 중, 처리방침·약관은 새 창 링크', async () => {
  await show();
  const facts = container.querySelector('.about-facts').textContent;
  expect(facts).toContain('버전dev');
  expect(facts).toContain('운영지금 가계부');
  expect(facts).toContain('문의 메일 주소는 준비 중이에요');
  expect(container.textContent).toContain('로그인한 계정의 Google Drive에 저장되고');
  const links = [...container.querySelectorAll('.about-links a')].map(a => [a.textContent, a.getAttribute('href'), a.getAttribute('target')]);
  expect(links).toEqual([['개인정보처리방침', '/privacy.html', '_blank'], ['이용약관', '/terms.html', '_blank']]);
});

test('문제 알리기 — 적은 내용과 오류가 미리 보기에 담기고, 복사하기는 그 글을 클립보드에 넣는다(메일 주소가 없으면 메일 버튼 없음)', async () => {
  recordError('저장 실패: 연결이 끊겼습니다', { kind: '화면에 알린 오류' });
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await show();
  expect(container.querySelector('.preport-label').textContent).toContain('오류 1건');
  expect(report()).toContain('(여기에 적어 주세요)');
  expect(report()).toContain('저장소: Google Drive');
  expect(report()).toContain('[화면에 알린 오류] 저장 실패: 연결이 끊겼습니다');
  typeNote('거래를 저장하면 오류가 떠요');
  expect(report()).toContain('■ 무슨 일이 있었나요?\n거래를 저장하면 오류가 떠요');
  expect(button('메일로 보내기')).toBeUndefined();
  expect(container.textContent).toContain('앱을 알려 준 분께 메신저로 보내 주세요');
  await act(async () => { button('복사하기').click(); });
  expect(writeText).toHaveBeenCalledWith(report());
  expect(container.querySelector('.preport-message').textContent).toContain('복사했습니다');
});

test('복사가 막히면 직접 복사하라고 알린다', async () => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
  document.execCommand = vi.fn(() => false);
  await show();
  await act(async () => { button('복사하기').click(); });
  const msg = container.querySelector('.preport-message');
  expect(msg.textContent).toContain('직접 복사해 주세요');
  expect(msg.classList.contains('preport-message--fail')).toBe(true);
  expect(document.querySelectorAll('textarea[readonly]')).toHaveLength(0);   // 복사하려고 만든 칸은 남기지 않는다
});

test('오류 기록 지우기 — 묻고 지운다, 기록이 없으면 누를 수 없다', async () => {
  recordError('하나');
  recordError('둘');
  await show();
  vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  act(() => { button('오류 기록 지우기').click(); });
  expect(getErrorLog()).toHaveLength(2);
  expect(window.confirm).toHaveBeenLastCalledWith('이 기기에 남은 오류 기록 2건을 지울까요?');
  act(() => { button('오류 기록 지우기').click(); });
  expect(getErrorLog()).toEqual([]);
  expect(container.querySelector('.preport-label').textContent).toContain('오류 0건');
  expect(report().endsWith('■ 최근 오류\n없음')).toBe(true);
  expect(button('오류 기록 지우기').disabled).toBe(true);
});

test('문의 메일을 정하면 문의 링크와 메일로 보내기(제목·본문 = 미리 보기 글)가 생긴다', async () => {
  cfg.email = 'help@example.com';
  await show();
  expect(container.textContent).not.toContain('최근 오류 5건만 담겨요');
  expect(container.querySelector('.about-facts a').getAttribute('href')).toBe('mailto:help@example.com');
  typeNote('알려 드려요');
  const href = button('메일로 보내기').getAttribute('href');
  expect(href.startsWith('mailto:help@example.com?subject=')).toBe(true);
  const params = new URLSearchParams(href.split('?')[1]);
  expect(params.get('subject')).toBe('[지금 가계부] 문제 알리기');
  expect(params.get('body')).toBe(report());
  expect(container.textContent).not.toContain('앱을 알려 준 분께');
});

test('메일에는 최근 오류 5건만 담고, 그보다 많으면 복사하라고 알린다', async () => {
  cfg.email = 'help@example.com';
  for (let i = 1; i <= 7; i += 1) recordError(`오류 ${i}`);
  await show();
  expect(report()).toContain('(7건, 최근 것부터)');
  const body = new URLSearchParams(button('메일로 보내기').getAttribute('href').split('?')[1]).get('body');
  expect(body).toContain('(7건 중 최근 5건)');
  expect(body).not.toContain(' 오류 1\n');
  expect(container.textContent).toContain('메일에는 최근 오류 5건만 담겨요');
});
