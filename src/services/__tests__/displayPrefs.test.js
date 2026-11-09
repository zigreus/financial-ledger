/**
 * @vitest-environment jsdom
 */
// 이 기기의 화면 설정 (ROADMAP U-1 글씨 크기, U-2 화면 테마) — 설정 적용과, 화면 코드가 규칙을 지키는지(글씨는 배율, 색은 토큰)
import fs from 'node:fs';
import path from 'node:path';
import {
  DARK_BAR_COLOR, FONT_SCALES, FONT_SCALE_KEY, THEMES, THEME_KEY, applyDisplayPrefs, getFontScale, getTheme, isDarkNow,
  resetDisplayPrefsWatch, setFontScale, setTheme,
} from '../displayPrefs';

const ROOT = path.resolve(__dirname, '../../..');
const SRC = path.join(ROOT, 'src');
function walk(dir, ext, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) { if (d.name !== '__tests__') walk(p, ext, out); } else if (p.endsWith(ext)) out.push(p);
  });
  return out;
}
const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');
const cssFiles = walk(SRC, '.css');
const jsFiles = walk(SRC, '.js');
const read = p => fs.readFileSync(p, 'utf8');

let darkMatches = false;
let mqListeners = [];
beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('--fs');
  document.head.innerHTML = '<meta name="theme-color" content="#38BDF8">';
  darkMatches = false;
  mqListeners = [];
  window.matchMedia = () => ({
    get matches() { return darkMatches; },
    addEventListener: (_e, fn) => mqListeners.push(fn),
  });
  resetDisplayPrefsWatch();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('설정 적용', () => {
  const root = () => document.documentElement;
  const bar = () => document.querySelector('meta[name="theme-color"]').getAttribute('content');

  test('기본은 보통·밝게 — 아무것도 바꾸지 않는다(예전 화면 그대로)', () => {
    expect(getFontScale()).toBe('normal');
    expect(getTheme()).toBe('light');
    applyDisplayPrefs();
    expect(root().style.getPropertyValue('--fs')).toBe('');
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(bar()).toBe('#38BDF8');
  });

  test('글씨 크기를 고르면 배율이 바로 바뀌고 기억한다 — 보통으로 돌리면 지운다', () => {
    setFontScale('xlarge');
    expect(root().style.getPropertyValue('--fs')).toBe('1.3');
    expect(window.localStorage.getItem(FONT_SCALE_KEY)).toBe('xlarge');
    setFontScale('small');
    expect(root().style.getPropertyValue('--fs')).toBe('0.9');
    setFontScale('normal');
    expect(root().style.getPropertyValue('--fs')).toBe('');
    expect(window.localStorage.getItem(FONT_SCALE_KEY)).toBeNull();
  });

  test('어둡게는 늘, 기기 설정 따라는 기기가 어두운 모드일 때만 — 위쪽 막대 색도 따라간다', () => {
    setTheme('dark');
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(isDarkNow()).toBe(true);
    expect(bar()).toBe(DARK_BAR_COLOR);
    setTheme('system');
    expect(root().getAttribute('data-theme')).toBe('system');
    expect(bar()).toBe('#38BDF8');
    darkMatches = true;   // 휴대폰을 다크 모드로
    mqListeners.forEach(fn => fn());
    expect(bar()).toBe(DARK_BAR_COLOR);
    setTheme('light');
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(bar()).toBe('#38BDF8');
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
  });

  test('index.html이 먼저 어둡게 바꿔 둔 위쪽 막대 색(data-light)도 밝게로 돌아간다', () => {
    const meta = document.querySelector('meta[name="theme-color"]');
    meta.setAttribute('data-light', '#38BDF8');
    meta.setAttribute('content', DARK_BAR_COLOR);
    setTheme('light');
    expect(bar()).toBe('#38BDF8');
  });

  test('모르는 값은 기본값', () => {
    window.localStorage.setItem(FONT_SCALE_KEY, 'huge');
    window.localStorage.setItem(THEME_KEY, 'neon');
    expect(getFontScale()).toBe('normal');
    expect(getTheme()).toBe('light');
  });

  test('저장소가 막혀 있어도(비공개 모드) 고른 것은 이번에 적용되고 고른 것으로 보인다', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(getFontScale()).toBe('normal');
    setFontScale('large');
    setTheme('dark');
    expect(getFontScale()).toBe('large');
    expect(getTheme()).toBe('dark');
    expect(root().style.getPropertyValue('--fs')).toBe('1.15');
    expect(root().getAttribute('data-theme')).toBe('dark');
  });
});

describe('index.html의 그리기 전 스크립트가 같은 열쇠·값을 쓴다', () => {
  const html = read(path.join(ROOT, 'index.html'));
  test('글씨 배율·테마·위쪽 막대 색', () => {
    const map = html.match(/var scale = \{([^}]*)\}\[localStorage\.getItem\('([a-z_]+)'\)\]/);
    expect(map[2]).toBe(FONT_SCALE_KEY);
    const pairs = Object.fromEntries(map[1].split(',').map(s => s.split(':').map(x => x.trim())).map(([k, v]) => [k, Number(v)]));
    expect(pairs).toEqual(Object.fromEntries(FONT_SCALES.filter(f => f.scale !== 1).map(f => [f.key, f.scale])));
    expect(html).toContain(`localStorage.getItem('${THEME_KEY}')`);
    const themes = THEMES.map(t => t.key).filter(k => k !== 'light');
    themes.forEach(k => expect(html).toContain(`theme === '${k}'`));
    expect(html).toContain(`bar.setAttribute('content', '${DARK_BAR_COLOR}')`);
    expect(html).toContain("bar.setAttribute('data-light'");
  });
});

/** CSS를 규칙(선택자·선언·줄)으로 — 주석은 지운다(줄 번호는 그대로) */
function cssRules(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  const rules = [];
  const re = /([^{}]*)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    const line = clean.slice(0, m.index + m[1].length).split('\n').length;
    const decls = [...m[2].matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)].map(d => ({ prop: d[1], value: d[2].trim() }));
    rules.push({ selector: m[1].trim(), decls, line });
  }
  return rules;
}
const RAW_COLOR = /#[0-9A-Fa-f]{8}\b|#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3,4}\b|\bwhite\b|\bblack\b|\b(?:rgb|hsl)a?\([^)]*\)/g;
const normHex = (c) => {
  if (/^white$/i.test(c)) return '#FFFFFF';
  if (/^black$/i.test(c)) return '#000000';
  const u = c.toUpperCase();
  return u.length === 4 ? `#${[...u.slice(1)].map(x => x + x).join('')}` : u;
};

describe('화면 코드의 규칙', () => {
  test('글씨 크기는 모두 배율을 따른다 — px를 그대로 쓰지 않는다(CSS·인라인 style)', () => {
    const bad = [];
    cssFiles.forEach((p) => {
      read(p).split('\n').forEach((line, i) => {
        if (/font-size:\s*[\d.]+px/.test(line) || /\bfont:[^;]*\b\d+px/.test(line)) bad.push(`${rel(p)}:${i + 1}`);
      });
    });
    jsFiles.forEach((p) => {
      read(p).split('\n').forEach((line, i) => {
        if (/fontSize:\s*('[\d.]+px'|"[\d.]+px"|\d)/.test(line)) bad.push(`${rel(p)}:${i + 1}`);
      });
    });
    expect(bad).toEqual([]);
  });

  const indexCss = read(path.join(SRC, 'index.css'));
  const block = (re) => {
    const m = indexCss.match(re);
    return m ? m[1] : '';
  };
  const decls = text => Object.fromEntries([...text.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  const light = decls(block(/^:root \{([\s\S]*?)\n\}/m));
  const dark = decls(block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/));
  const system = decls(block(/:root\[data-theme="system"\] \{([\s\S]*?)\n {2}\}/));

  test('어두운 테마 두 블록(어둡게·기기 설정 따라)은 같은 값', () => {
    expect(Object.keys(dark).length).toBeGreaterThan(50);
    expect(system).toEqual(dark);
  });

  test('화면이 쓰는 색 토큰(--c-*·--primary-text*)은 모두 밝게·어둡게 둘 다 정해져 있다', () => {
    const used = new Set();
    [...cssFiles, ...jsFiles].forEach(p => [...read(p).matchAll(/var\((--(?:c-[a-z0-9-]+|primary-text[a-z-]*))\)/g)].forEach(m => used.add(m[1])));
    const missing = [...used].filter(t => !light[t] || !dark[t]);
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(50);
  });

  // 흰 글씨를 얹는 채움 색(버튼·배지·오늘 표시 배경) — 어두운 테마에서도 그대로 보인다
  const FILLS = new Set(['#059669', '#10B981', '#60A5FA', '#7C3AED', '#E53935', '#EF4444', '#F59E0B', '#2563EB', '#1E3A5F']);
  const LOGIN = 'src/components/LoginPage/LoginPage.css';   // 로그인 화면의 Google 버튼(브랜드 — 흰 버튼에 어두운 글씨)

  test('배경에 밝은 색을 그대로 쓰지 않는다 — 어두운 테마에서 흰 판이 남지 않게(채움 색·스위치 손잡이만 예외)', () => {
    const bad = [];
    cssFiles.forEach((p) => {
      if (rel(p) === LOGIN || p.endsWith('index.css')) return;
      cssRules(read(p)).forEach((r) => {
        r.decls.filter(d => d.prop === 'background' || d.prop === 'background-color').forEach((d) => {
          (d.value.match(RAW_COLOR) || []).forEach((c) => {
            if (/^rgba?\(\s*0\s*,\s*0\s*,\s*0/i.test(c)) return;                       // 검은 반투명(가림막)
            if (/^rgba\(/i.test(c) && !/255\s*,\s*255\s*,\s*255/.test(c)) return;     // 색이 있는 반투명 물들임
            // 옅은 반투명 흰색(채움 머리글 위 칩·버튼) — 어두운 화면에서도 흰 판이 되지 않는다
            if (/^rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*(0?\.[0-4]\d*)\s*\)$/i.test(c)) return;
            const h = /^#|white|black/i.test(c) ? normHex(c) : c;
            if (FILLS.has(h)) return;
            if (h === '#FFFFFF' && /knob/.test(r.selector)) return;
            bad.push(`${rel(p)}:${r.line} ${r.selector} → ${c}`);
          });
        });
      });
    });
    expect(bad).toEqual([]);
  });

  test('글씨 색을 그대로 쓰는 것은 채움 위 글씨뿐 — 나머지는 토큰(어두운 테마에서 글씨가 사라지지 않게)', () => {
    // 파일|색: 채움(파란 머리글·오늘 동그라미·요약의 주황 강조) 위 글씨
    const ALLOWED = new Set([
      'src/components/AccountManagement/AccountManagement.css|#FDE68A',
      'src/components/CalendarView/CalendarView.css|#1E293B',
      'src/components/SummaryView/SummaryView.css|#FF8C42',
    ]);
    const bad = [];
    cssFiles.forEach((p) => {
      if (rel(p) === LOGIN || p.endsWith('index.css')) return;
      cssRules(read(p)).forEach((r) => {
        r.decls.filter(d => d.prop === 'color').forEach((d) => {
          (d.value.match(RAW_COLOR) || []).forEach((c) => {
            const h = /^#|white|black/i.test(c) ? normHex(c) : c;
            if (h === '#FFFFFF' || /^rgba\(\s*255\s*,\s*255\s*,\s*255/i.test(c)) return;   // 채움 위 흰 글씨
            if (ALLOWED.has(`${rel(p)}|${h}`)) return;
            bad.push(`${rel(p)}:${r.line} ${r.selector} → ${c}`);
          });
        });
      });
    });
    expect(bad).toEqual([]);
  });

  test('화면 코드(JS)의 style에도 배경색을 그대로 쓰지 않는다 — 데이터 색(카테고리·일정)은 변수로 온다', () => {
    const bad = [];
    jsFiles.forEach((p) => {
      read(p).split('\n').forEach((line, i) => {
        if (/background(?:Color)?:\s*['"`](#[0-9A-Fa-f]{3,8}|white|rgb)/.test(line)) bad.push(`${rel(p)}:${i + 1}`);
      });
    });
    expect(bad).toEqual([]);
  });
});
