/**
 * @vitest-environment jsdom
 */
// 다른 후보 줄 — 보이는 글이 '이걸로'가 실제로 바꾸는 것과 같아야 한다 (I-062)
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Alternatives } from '../SuggestionCard';

global.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const alt = (kind, sub, detail) => ({
  kind, budget_category: '식비', sub_category: sub, detail, historyDetail: '', historyCount: 0, detailSource: 'text', categorySource: 'ai',
});
const suggestion = detail => ({
  detail, budget_category: '식비', sub_category: '점심',
  alternatives: [alt('first', '점심', '케이크'), alt('second', '간식', '케이크'), alt('past', '커피', '메가')],
});

test('세부내역은 고르면 바뀔 때만 함께 보이고, 직접 고친 세부내역이면 분류만 보인다', () => {
  act(() => root.render(<Alternatives s={suggestion('케이크')} onUse={() => {}} />));
  expect([...container.querySelectorAll('.rs-alt b')].map(b => b.textContent)).toEqual(['식비 > 간식', '메가 · 식비 > 커피']);

  act(() => root.render(<Alternatives s={suggestion('케이크 엄마 생신')} onUse={() => {}} />));
  expect([...container.querySelectorAll('.rs-alt b')].map(b => b.textContent)).toEqual(['식비 > 간식', '식비 > 커피']);
});
