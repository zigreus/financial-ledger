/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 설정 › 데이터 › 가계부 파일로 바꾸기 (I-035, ROADMAP F-5) — 고르면 살펴 견줘 보이고, 확정할 때만 바꾼다
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../services/dbManager';
import DataSection from '../SettingsView/sections/DataSection';

vi.mock('../../services/dbManager', async (importOriginal) => {
  const actual = await importOriginal();
  const initSqlJs = (await import('sql.js/dist/sql-asm.js')).default;
  let SQL = null;
  return { ...actual, initSQL: async () => (SQL ||= await initSqlJs()) };
});

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

let db;
let container;
let root;
let backup;
beforeEach(() => {
  ({ db } = M.createDatabase(SQL, null));
  M.addTransaction(db, { payment_method: '현금', date: '2026-11-01', budget_category: '식비', detail: '지금', amount: 1000 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  backup = { list: vi.fn(async () => []), create: vi.fn(), restore: vi.fn(), replaceWithFile: vi.fn(async () => {}) };
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

const render = () => act(async () => { root.render(<DataSection db={db} dataVersion={1} onChanged={() => {}} setError={() => {}} backup={backup} />); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const button = text => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === text);
async function pick(name, bytes) {
  const input = container.querySelector('input[aria-label="가계부 파일 고르기"]');
  Object.defineProperty(input, 'files', { value: [new File([bytes], name)], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
  await flush();
}
function otherLedger() {
  const { db: other } = M.createDatabase(SQL, null);
  ['a', 'b', 'c'].forEach((d, i) => M.addTransaction(other, { payment_method: '카드', date: `2025-0${i + 1}-01`, budget_category: '식비', detail: d, amount: 1 }));
  const bytes = other.export();
  other.close();
  return bytes;
}

test('고른 파일과 지금 가계부를 견줘 보이고, 확인을 거쳐 바꾼다', async () => {
  await render();
  const bytes = otherLedger();
  await pick('옛계정.db', bytes);
  expect(container.textContent).toContain('고른 파일거래 3건 (2025-01-01 ~ 2025-03-01)');
  expect(container.textContent).toContain('지금 가계부거래 1건');

  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
  await act(async () => { button('이 파일로 바꾸기').click(); });
  expect(confirm.mock.calls[0][0]).toContain('지금 가계부(거래 1건)는 바꾸기 전에 백업 목록에 남깁니다');
  expect(backup.replaceWithFile).not.toHaveBeenCalled();     // 취소하면 아무것도 바뀌지 않는다

  confirm.mockReturnValueOnce(true);
  await act(async () => { button('이 파일로 바꾸기').click(); });
  await flush();
  expect(backup.replaceWithFile).toHaveBeenCalledTimes(1);
  expect(Array.from(backup.replaceWithFile.mock.calls[0][0])).toEqual(Array.from(bytes));
  expect(container.textContent).toContain('✓ 가계부를 "옛계정.db"로 바꿨습니다');
  expect(button('이 파일로 바꾸기')).toBeUndefined();
});

test('이 앱의 가계부 파일이 아니면 이유를 보이고 바꾸기 버튼이 없다', async () => {
  await render();
  await pick('메모.db', new TextEncoder().encode('not a sqlite file'.repeat(20)));
  expect(container.textContent).toContain('가계부 파일(.db)이 아니거나 손상된 파일입니다');
  expect(button('이 파일로 바꾸기')).toBeUndefined();
});

test('바꾸기 기능이 없는 저장소(테스트·옛 연결)에서는 보이지 않는다', async () => {
  delete backup.replaceWithFile;
  await render();
  expect(container.querySelector('input[aria-label="가계부 파일 고르기"]')).toBeNull();
});
