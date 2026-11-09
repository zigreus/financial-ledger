import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 앱 버전 (I-038) — 설정 › 정보와 '문제 알리기'에 보인다. 빌드한 시각(한국 시각)과 커밋 앞 7자리.
 * Vercel은 커밋을 환경값(VERCEL_GIT_COMMIT_SHA)으로 주고, 내 PC에서는 git에 묻는다(없으면 시각만).
 */
function appVersion() {
  const built = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date());
  let commit = process.env.VERCEL_GIT_COMMIT_SHA || '';
  if (!commit) {
    try {
      commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch { /* git이 없으면 시각만 */ }
  }
  return commit ? `${built} (${commit.slice(0, 7)})` : built;
}

// CRA → Vite 이전 (I-008)
// - JSX가 들어 있는 .js 파일을 그대로 쓴다 (파일 이름을 .jsx로 바꾸지 않음)
// - 개발 서버는 3000번: Azure 앱 등록의 리디렉션 주소(http://localhost:3000)와 맞춘다
// - 출력 폴더는 CRA와 같은 build: Vercel 설정을 바꾸지 않아도 된다 (vercel.json에도 명시)

/**
 * 열 때 불러오는 화면(I-033, src/components/App/screens.js)의 빌드 파일을 index.html에 미리 받기(prefetch)로 적는다.
 * 서비스 워커(public/sw.js)는 index.html이 가리키는 /assets/* 파일만 받아 두므로(연결 없이 열기, I-024),
 * 여기 적어야 나눈 파일도 함께 받아 둔다. prefetch는 받아만 두고 실행하지 않아 첫 화면을 늦추지 않는다.
 */
function prefetchLazyChunks() {
  let base = '/';
  return {
    name: 'prefetch-lazy-chunks',
    apply: 'build',
    configResolved(config) { base = config.base; },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html;
        return Object.keys(ctx.bundle)
          // 소스맵(.map)은 사용자에게 받게 하지 않는다(sourcemap을 켜도)
          .filter(name => name.startsWith('assets/') && !name.endsWith('.map') && !html.includes(name))
          .sort()
          .map(name => ({ tag: 'link', attrs: { rel: 'prefetch', href: `${base}${name}` }, injectTo: 'head' }));
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react({ include: /\.(js|jsx)$/ }), prefetchLazyChunks()],
  // 빌드에만 적는다 — 개발 서버·테스트는 'dev'(services/errorLog.js의 appVersion)
  define: command === 'build' ? { __APP_VERSION__: JSON.stringify(appVersion()) } : {},
  esbuild: {
    loader: 'jsx',
    include: /src\/.*\.jsx?$/,
    exclude: [],
    jsx: 'automatic',
  },
  optimizeDeps: {
    esbuildOptions: { loader: { '.js': 'jsx' } },
  },
  server: { port: 3000, strictPort: true },
  preview: { port: 3000, strictPort: true },
  // sql.js는 Node 전용 분기에서 fs·path·crypto를 require한다 — 브라우저에서는 실행되지 않아
  // 빌드 시 'externalized for browser compatibility' 경고가 나와도 무해하다.
  // 크기 경고 기준은 gzip 전 1MB. 라이브러리(React·MSAL·sql.js)는 따로 묶는다 — 앱 코드만 바뀐 배포는 라이브러리 파일을
  // 다시 받지 않는다. 첫 화면에 필요 없는 화면은 열 때 불러오는(dynamic import) 파일로 나누고(I-033), 위 플러그인이
  // index.html에 prefetch로 적어 서비스 워커가 index.html이 가리키는 빌드 파일을 모두 받아 두는 방식(I-024)과 맞춘다.
  // CSS는 나누지 않는다(cssCodeSplit: false) — 화면끼리 함께 쓰는 클래스가 있어, 나누면 아직 열지 않은 화면의 CSS가
  // 없어 다른 화면이 깨져 보일 수 있다. CSS는 한 파일(gzip 약 20kB)로 처음부터 불러온다.
  // 한 파일 안의 순서는 앱과 함께 불러오는 화면의 CSS → 나눈 화면의 CSS 순이다. 화면 CSS는 자기 접두어 클래스로 쓰고
  // 다른 화면의 같은 선택자를 덮어쓰지 않는다(순서에 기대지 않게).
  build: {
    outDir: 'build',
    chunkSizeWarningLimit: 1000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-dom/client', '@azure/msal-browser', '@azure/msal-react', 'sql.js'],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'node', // 화면 테스트는 파일 맨 위 @vitest-environment jsdom
    include: ['src/**/*.test.js'],
    css: false,
  },
}));
