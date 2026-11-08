import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// CRA → Vite 이전 (I-008)
// - JSX가 들어 있는 .js 파일을 그대로 쓴다 (파일 이름을 .jsx로 바꾸지 않음)
// - 개발 서버는 3000번: Azure 앱 등록의 리디렉션 주소(http://localhost:3000)와 맞춘다
// - 출력 폴더는 CRA와 같은 build: Vercel 설정을 바꾸지 않아도 된다 (vercel.json에도 명시)
export default defineConfig({
  plugins: [react({ include: /\.(js|jsx)$/ })],
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
  // 다시 받지 않는다. 나눈 파일도 index.html이 미리 불러오기(modulepreload)로 가리키므로, 서비스 워커가 index.html이
  // 가리키는 빌드 파일을 모두 받아 두는 방식(연결 없이 열기, I-024)과 맞는다. 늦게 불러오는(dynamic import) 나누기는 쓰지 않는다.
  build: {
    outDir: 'build',
    chunkSizeWarningLimit: 1000,
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
});
