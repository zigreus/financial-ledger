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
  // 앱이 한 번들이라(CRA 때와 동일) 크기 경고 기준을 gzip 전 1MB로 둔다.
  build: { outDir: 'build', chunkSizeWarningLimit: 1000 },
  test: {
    globals: true,
    environment: 'node', // 화면 테스트는 파일 맨 위 @vitest-environment jsdom
    include: ['src/**/*.test.js'],
    css: false,
  },
});
