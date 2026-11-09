/**
 * @vitest-environment jsdom
 */
/* eslint-disable */
// 설정 › 선택 기능 (I-032, ROADMAP Q-2) — 모든 선택 기능을 한 화면에서 켜고 끄고, 세부 설정 자리로 간다
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import * as M from '../../services/dbManager';
import SettingsView from '../SettingsView/SettingsView';
import { OPTIONAL_FEATURES, featureAnchorId } from '../SettingsView/optionalFeatures';

global.IS_REACT_ACT_ENVIRONMENT = true;
let SQL;
beforeAll(async () => {
  SQL = await initSqlJs();
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  if (!window.ResizeObserver) window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

let db;
let container;
let root;
let changed;
let sections;
let scrolled;
beforeEach(() => {
  ({ db } = M.createDatabase(SQL, null));
  M.addBudgetCategory(db, '식비');
  M.addPaymentMethod(db, '신한카드');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  changed = 0;
  sections = [];
  scrolled = [];
  Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.id); };
});
afterEach(() => { act(() => root.unmount()); container.remove(); delete Element.prototype.scrollIntoView; });

// App처럼 설정 섹션과 dataVersion을 들고 있는 틀
function Harness({ initial }) {
  const [section, setSection] = useState(initial);
  const [version, setVersion] = useState(0);
  return (
    <SettingsView
      db={db}
      dataVersion={version}
      onChanged={() => { changed += 1; setVersion(v => v + 1); }}
      backup={{ list: async () => [], create: async () => {}, restore: async () => {} }}
      activeSection={section}
      onSectionChange={(s) => { sections.push(s); setSection(s); }}
      onDrilldownCategoryChange={() => {}}
      onDrilldownTripChange={() => {}}
      onDrilldownPaymentChange={() => {}}
    />
  );
}

const render = el => act(async () => { root.render(el); });
const buttons = () => [...container.querySelectorAll('button')];
const button = text => buttons().find(b => b.textContent.trim() === text || b.title === text);
const click = el => act(async () => { el.click(); });

test('목록의 켜기·끄기 함수가 제 기능의 설정을 바꾼다 — 기본은 모두 꺼짐', () => {
  expect(new Set(OPTIONAL_FEATURES.map(f => f.key)).size).toBe(OPTIONAL_FEATURES.length);
  OPTIONAL_FEATURES.forEach((f) => {
    expect(f.isOn(db)).toBe(false);
    f.setOn(db, true);
    expect(f.isOn(db)).toBe(true);
    // 다른 기능은 켜지지 않는다
    OPTIONAL_FEATURES.filter(o => o.key !== f.key).forEach(o => expect(o.isOn(db)).toBe(false));
    f.setOn(db, false);
    expect(f.isOn(db)).toBe(false);
  });
});

test('선택 기능 탭 — 모든 기능이 보이고, 켜면 저장되며 켜 둔 수가 바뀐다', async () => {
  await render(<Harness initial="features" />);
  expect(button('선택 기능').className).toContain('active');
  expect(container.textContent).toContain('지금 켜 둔 기능 없음');
  OPTIONAL_FEATURES.forEach(f => expect(button(`${f.label} 켜기`)).toBeDefined());
  // 꺼 두면 세부 설정으로 가는 버튼이 없다
  expect(buttons().some(b => b.textContent.includes('지출계획 › 예산 ›'))).toBe(false);

  await click(button('월간 리포트 켜기'));
  expect(M.isMonthlyReportEnabled(db)).toBe(true);
  expect(changed).toBe(1);
  expect(container.textContent).toContain('지금 1개 켜 둠');
  expect(button('월간 리포트 끄기')).toBeDefined();
  // 세부 설정이 없는 기능은 가는 버튼이 없다
  expect(buttons().some(b => b.textContent.includes('›') && b.className === 'features-place')).toBe(false);

  await click(button('일행 정산 (N빵) 켜기'));
  expect(M.isTripSplitEnabled(db)).toBe(true);
  expect(container.textContent).toContain('지금 2개 켜 둠');

  await click(button('월간 리포트 끄기'));
  expect(M.isMonthlyReportEnabled(db)).toBe(false);
  expect(container.textContent).toContain('지금 1개 켜 둠');
});

test('세부 설정이 있는 기능은 켜면 그 자리로 가는 버튼이 생기고, 누르면 그 섹션의 기능 머리로 스크롤한다', async () => {
  await render(<Harness initial="features" />);
  await click(button('수입·월 수지 켜기'));
  const go = button('수입으로 셀 계좌 고르기 — 지출계획 › 예산 ›');
  expect(go).toBeDefined();
  await click(go);
  expect(sections).toEqual(['budget']);
  expect(button('예산').className).toContain('active');      // 지출계획의 '예산' 서브탭
  expect(document.getElementById(featureAnchorId('monthlyBalance'))).not.toBeNull();
  expect(scrolled).toEqual([featureAnchorId('monthlyBalance')]);
  // 원래 자리의 스위치도 같은 값(켜짐)을 보인다
  expect(button('수입·월 수지 끄기')).toBeDefined();
});

test('구독 모아보기 → 지출계획 › 정기지출의 구독 머리', async () => {
  await render(<Harness initial="features" />);
  await click(button('구독 모아보기 켜기'));
  await click(button('구독 고르기 — 지출계획 › 정기지출 ›'));
  expect(sections).toEqual(['recurring']);
  expect(button('정기지출').className).toContain('active');
  expect(scrolled).toEqual([featureAnchorId('subscriptions')]);
  expect(button('구독 모아보기 끄기')).toBeDefined();
});

test('원래 자리에서 끈 것이 선택 기능 탭에도 그대로 보인다', async () => {
  M.setCategoryBudgetEnabled(db, true);
  await render(<Harness initial="budget" />);
  await click(button('카테고리별 예산 끄기'));
  expect(M.isCategoryBudgetEnabled(db)).toBe(false);
  await click(button('선택 기능'));
  expect(button('카테고리별 예산 켜기')).toBeDefined();
  expect(container.textContent).toContain('지금 켜 둔 기능 없음');
});

test('모든 선택 기능은 원래 자리에도 같은 이름의 머리(앵커)가 하나씩 있다', async () => {
  const anchors = new Map();
  for (const sec of ['budget', 'recurring', 'calendar']) {
    // eslint-disable-next-line no-await-in-loop
    await render(<Harness key={sec} initial={sec} />);
    OPTIONAL_FEATURES.forEach((f) => {
      const el = document.getElementById(featureAnchorId(f.key));
      if (el) {
        expect(el.textContent).toContain(f.label);
        anchors.set(f.key, (anchors.get(f.key) || []).concat(sec));
      }
    });
  }
  OPTIONAL_FEATURES.forEach(f => expect(anchors.get(f.key)).toHaveLength(1));
  // 세부 설정 자리(place)를 적은 기능은 그 섹션에 머리가 있다
  OPTIONAL_FEATURES.filter(f => f.place).forEach(f => expect(anchors.get(f.key)).toEqual([f.place.section]));
});
