/**
 * 저장소(StorageProvider) 계약 — 가계부 파일을 어디에 두든 앱의 나머지는 이 모양만 안다 (ROADMAP F-2, I-018).
 *
 * 지금 구현: OneDrive(./oneDrive.js), 테스트용 메모리(./memory.js).
 * 다른 드라이브(예: Google Drive)를 붙일 때는 같은 모양의 객체를 만들고
 * src/services/__tests__/storage.test.js의 contract(...)를 하나 더 불러 계약 테스트를 함께 돌린다.
 * 단, 아래 두 규칙은 끼어드는 방법이 저장소마다 달라 contract()로는 확인되지 않는다 — 저장소별 테스트를 따로 만든다
 * (OneDrive 예: storage.test.js의 '읽을 때 버전을 먼저 읽는다', backups.test.js의 '내려받기는 백업 파일만').
 *  - read는 버전을 내용보다 먼저 읽는다   - readBackup은 accept가 거짓이면 내용을 받지 않는다
 *
 * 충돌 병합(useLedgerSync)은 "버전이 다르면 저장 거부"에 기댄다. 그래서 write는 반드시
 * 원자적인 조건부 저장이어야 한다 — 확인하고 저장하는 사이에 다른 기기가 끼어들 틈이 있으면 안 된다.
 *
 * 공통 규칙
 *  - 버전은 저장소가 정한 불투명한 문자열이다. 같은 파일 상태라면 read·getVersion·write가 같은 문자열을 돌려줘야 한다
 *    (useLedgerSync는 === 로 비교해 이미 최신이면 다시 받지 않는다).
 *  - 실패는 던진다. ConflictError만 "다른 기기가 먼저 저장함"으로 보고 합친다. 그 밖의 오류로 끝난 write는
 *    "올라갔는지 모르는 저장"으로 다룬다(실제로 올라갔는지는 DB 안의 동기화 표식으로 나중에 가린다).
 *  - 오류 메시지는 "저장 실패: …"처럼 화면에 그대로 보이므로 한국어 안내문으로 쓴다.
 *  - 다시 로그인해야 해서 로그인 화면으로 넘기기 시작했으면 ReauthRedirectError를 던진다(설정 파일 동작은 넘기지 않는다).
 *
 * @typedef {object} LedgerStorage
 * @property {string} accountKey
 *   이 저장소를 쓰는 계정. 기기에 보관하는 미저장 변경·매일 백업 표식·AI 설정을 이 계정에 묶는다. 없으면 ''.
 *
 * ── 가계부 파일 ────────────────────────────────────────────────
 * @property {() => Promise<{ bytes: Uint8Array|null, version: string|null }>} read
 *   파일과 그 시점의 버전. 파일이 없으면 { bytes: null, version: null }.
 *   ⚠ 내용이 버전보다 오래되면 안 된다 — 버전을 먼저(또는 내용과 한 응답에서) 읽는다.
 *     버전을 먼저 읽으면 그 사이 바뀐 경우 내용이 더 새것일 수 있는데, 그러면 다음 저장이 거절되어 다시 합치므로 안전하다.
 *     반대로 내용을 먼저 받고 버전을 나중에 읽으면 { 옛 내용, 새 버전 }이 되어, 그 위에 올린 저장이 다른 기기의 저장을 조용히 지운다.
 * @property {() => Promise<string|null>} getVersion
 *   내용 없이 지금 버전만(이미 최신인지 확인용). 파일이 없으면 null.
 * @property {(bytes: Uint8Array, version: string|null) => Promise<string|null>} write
 *   파일이 version 상태일 때만 저장하고 새 버전을 돌려준다. 그 사이 다른 기기가 저장했으면 ConflictError.
 *   version을 줬는데 파일이 사라졌어도 ConflictError다 — 그래야 동기화가 다시 읽고(파일 없음) 내 DB 전체로 새로 만든다.
 *   version이 null이면 파일이 없을 때만 새로 만든다 — 그 사이 누가 만들었으면 덮어쓰지 않고 ConflictError.
 *
 * ── 백업 폴더 (이름 규칙·정리는 ../backups.js가 맡는다) ─────────
 * @property {() => Promise<Array<{ id: string, name: string, size: number, modified: string }>>} listBackups
 *   백업 폴더의 파일(하위 폴더 제외). 폴더가 아직 없으면 [].
 *   modified는 ISO-8601 UTC 문자열(예: '2026-11-08T03:04:05Z') — 글자 순서가 곧 시간 순서여야 한다
 *   (정리할 때 이 순서로 최근 것을 남기므로, 형식이 다르면 최신 백업이 지워질 수 있다).
 * @property {(name: string, bytes: Uint8Array) => Promise<boolean>} createBackup
 *   새 파일을 만든다. 같은 이름이 이미 있으면 덮어쓰지 않고 false.
 * @property {(id: string, accept: (name: string) => boolean) => Promise<Uint8Array|null>} readBackup
 *   listBackups의 id로 내용을 읽는다. 파일 이름을 먼저 확인해 accept(name)이 거짓이면 내용을 받지 않고 null.
 * @property {(id: string) => Promise<boolean>} deleteBackup
 *   listBackups의 id를 지운다. 지웠거나 이미 없으면 true, 저장소가 거절하면 false. 네트워크·로그인 오류는 던질 수 있다.
 *
 * ── 계정 설정 파일 (가계부와 별도인 작은 JSON, 예: ai-settings.json) ──
 * @property {(name: string) => Promise<{ data: any, version: string|null }>} readSettings
 *   파일이 없으면 { data: null, version: null }. 내용이 JSON이 아니면 data만 null(버전이 있으니 덮어써 고칠 수 있다).
 * @property {(name: string, data: any, version: string|null) => Promise<void>} writeSettings
 *   write와 같은 버전 규칙. 화면 뒤에서 도는 동기화라 다시 로그인해야 해도 로그인 화면으로 넘어가지 않고 실패한다.
 */

/** 다른 기기가 먼저 저장해서 내 저장이 거절됨 — 최신 파일을 받아 합친 뒤 다시 저장해야 한다 */
export class ConflictError extends Error {
  constructor() {
    super('다른 기기에서 가계부가 먼저 저장되었습니다');
    this.name = 'ConflictError';
  }
}

/** 재로그인이 필요해 리다이렉트를 시작함 — 미저장 변경은 브라우저에 보관되어 돌아온 뒤 다시 저장된다 */
export class ReauthRedirectError extends Error {
  constructor() {
    super('로그인이 만료되어 다시 로그인합니다… 저장 안 된 변경은 돌아온 뒤 자동으로 저장됩니다.');
    this.name = 'ReauthRedirectError';
  }
}
