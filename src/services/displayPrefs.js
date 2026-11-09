/**
 * 이 기기의 화면 설정 (ROADMAP U-1 글씨 크기, U-2 화면 테마) — 기기마다 따로(localStorage). 가계부 DB에 두지 않는다
 * (가족이 각자 편한 대로, AGENTS §6). 설정 › 앱 › 이 기기 화면에서 고른다.
 *
 *  - 글씨 크기: <html>의 --fs(배율). 화면의 글씨는 모두 calc(Npx * var(--fs))로 쓴다(src/index.css, displayPrefs.test.js가 지킨다).
 *  - 화면 테마: <html data-theme="dark|system">. 밝게(기본)는 속성을 두지 않는다 — 예전 화면 그대로.
 *    색은 index.css의 토큰(--c-* 등)이 테마에 따라 바뀐다.
 *  - 앱을 열 때는 index.html의 짧은 스크립트가 그리기 전에 먼저 적용한다(어두운 테마가 밝게 번쩍이지 않게) —
 *    같은 열쇠·값을 쓴다(displayPrefs 테스트가 둘이 같은지 본다). 바꿀 때는 applyDisplayPrefs가 바로 적용한다.
 */

export const FONT_SCALE_KEY = 'ledger_font_scale';
export const THEME_KEY = 'ledger_theme';

export const FONT_SCALES = [
  { key: 'small', label: '작게', scale: 0.9 },
  { key: 'normal', label: '보통', scale: 1 },
  { key: 'large', label: '크게', scale: 1.15 },
  { key: 'xlarge', label: '아주 크게', scale: 1.3 },
];
export const THEMES = [
  { key: 'light', label: '밝게' },
  { key: 'dark', label: '어둡게' },
  { key: 'system', label: '기기 설정 따라' },
];
/** 브라우저 위쪽 막대 색(meta theme-color) — 어두운 테마면 화면 머리글과 같은 색 */
export const DARK_BAR_COLOR = '#1E293B';
const DARK_QUERY = '(prefers-color-scheme: dark)';

// 이번에 고른 값 — 저장소가 막혀 있어도(비공개 모드 등) 앱을 닫을 때까지는 고른 대로 보이게
const chosen = new Map();
function read(key) {
  if (chosen.has(key)) return chosen.get(key);
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  chosen.set(key, value);
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* 저장하지 못하면 이번에만 적용된다(다음에 열면 기본값) */ }
}

export function getFontScale() {
  const k = read(FONT_SCALE_KEY);
  return FONT_SCALES.some(f => f.key === k) ? k : 'normal';
}
export function getTheme() {
  const k = read(THEME_KEY);
  return THEMES.some(t => t.key === k) ? k : 'light';
}

/** 지금 어두운 화면인지 — '기기 설정 따라'면 기기의 모드를 본다 */
export function isDarkNow(win = typeof window !== 'undefined' ? window : null) {
  const theme = getTheme();
  if (theme === 'dark') return true;
  if (theme !== 'system' || !win?.matchMedia) return false;
  try { return win.matchMedia(DARK_QUERY).matches; } catch { return false; }
}

let watching = false;
/** 지금 설정을 화면에 적용한다. '기기 설정 따라'면 기기 모드가 바뀔 때 위쪽 막대 색도 따라간다 */
export function applyDisplayPrefs(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return;
  const root = doc.documentElement;
  const scale = FONT_SCALES.find(f => f.key === getFontScale()).scale;
  if (scale === 1) root.style.removeProperty('--fs');
  else root.style.setProperty('--fs', String(scale));
  const theme = getTheme();
  if (theme === 'light') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  const win = doc.defaultView;
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) {
    if (!meta.dataset.light) meta.dataset.light = meta.getAttribute('content') || '';
    meta.setAttribute('content', isDarkNow(win) ? DARK_BAR_COLOR : meta.dataset.light);
  }
  if (!watching && win?.matchMedia) {
    try {
      const mq = win.matchMedia(DARK_QUERY);
      const onChange = () => applyDisplayPrefs(doc);
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
      watching = true;
    } catch { /* 지원하지 않으면 위쪽 막대 색만 따라가지 않는다 */ }
  }
}

/** 보통·밝게는 지운다 — 기본값은 저장하지 않아 나중에 기본을 바꿔도 따라간다 */
export function setFontScale(key) {
  write(FONT_SCALE_KEY, key === 'normal' ? null : key);
  applyDisplayPrefs();
}
export function setTheme(key) {
  write(THEME_KEY, key === 'light' ? null : key);
  applyDisplayPrefs();
}

/** 테스트용 — 기기 모드 듣기를 다시 걸 수 있게, 이번에 고른 값도 잊게 */
export function resetDisplayPrefsWatch() {
  watching = false;
  chosen.clear();
}
