/**
 * sql.js의 WASM 파일을 public/에 복사한다 (B-013).
 * 앱은 실행 중 외부 CDN이 아니라 같은 버전의 이 파일을 쓴다 — npm start / build 전에 자동 실행된다.
 */
const fs = require('fs');
const path = require('path');

const src = require.resolve('sql.js/dist/sql-wasm.wasm');
const dest = path.join(__dirname, '..', 'public', 'sql-wasm.wasm');
fs.copyFileSync(src, dest);
console.log(`[copy-sql-wasm] ${path.relative(process.cwd(), src)} → public/sql-wasm.wasm`);
