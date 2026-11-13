# AGENTS.md — 지금 가계부 코드 작성 규칙

이 파일은 이 저장소에서 작업하는 모든 AI 코딩 도구와 사람이 **작업을 시작하기 전에 읽는 기준**입니다.
- Claude Code는 `CLAUDE.md`가 이 파일을 불러옵니다.
- Codex·Cursor·Copilot 등 다른 도구는 이 파일을 직접 읽습니다.

규칙마다 괄호 안에 근거가 된 버그 번호(docs/BUGS.md)를 적었습니다. 규칙을 어기면 그 버그가 다시 생깁니다.

## 1. 프로젝트 한눈에

- 가족이 함께 쓰는 가계부 웹앱입니다. 서버가 없습니다.
- **운영자에게 가는 데이터가 없습니다.** 사용 지표·오류도 자동으로 보내지 않습니다(익명이라도, 외부 분석 도구도). 오류 보고가 필요하면 사용자가 내용을 보고 직접 보내는 방식만 씁니다. (사용자 결정, ROADMAP F-4)
  - 오류는 `services/errorLog.js`가 이 기기에만 남기고(가린 메시지·위치·시각), 설정 › 앱의 '문제 알리기'에서 사용자가 보고 직접 복사·메일로 보냅니다. (I-038)
  - **앱이 기기 밖으로 보내는 것(새 외부 서비스, AI로 보내는 범위)이나 기기에 두는 것을 바꾸면 `public/privacy.html`(개인정보처리방침)도 함께 고칩니다.** 운영자 이름·문의 메일은 `src/config.js`와 두 정적 페이지(`privacy.html`·`terms.html`)가 같아야 합니다. (I-038)
- 기술: React 18, Vite 6(개발 서버·빌드), Vitest(테스트), sql.js(브라우저 SQLite), Microsoft Graph(MSAL), OneDrive 파일 하나(`Apps/financial-ledger/ledger.db`). 선택으로 Google 로그인 + Google Drive(`financial-ledger/ledger.db`, M-1·I-031)
- 모바일 우선, UI 문구는 한국어입니다.

| 위치 | 역할 |
|---|---|
| `src/services/dbManager.js` | DB 함수의 단일 진입점(재내보내기만). 컴포넌트는 여기서 import |
| `src/services/db/*.js` | 실제 구현: schema(스키마·마이그레이션), transactions, masterData, members(가족 구성원), calendar, tripCash, summary, settings, recurring, favorites, patterns, accounts(잔액 예측·위험 알림 포함), discounts, categoryBudgets(카테고리별 예산, 선택 기능), monthlyBalance(수입·월 수지, 선택 기능 — 수입은 고른 계좌의 입금, 지출은 가계부 순지출), subscriptions(구독 모아보기, 선택 기능 — 정기지출 중 구독 표시한 것, 결제 예정), monthlyReport(월간 리포트, 선택 기능 — 규칙으로 계산, 문장 다듬기는 services/monthlyReportAI), taxSummary(연말정산 참고 합계, 선택 기능 — 결제수단 유형·카테고리 항목, 공제액은 계산하지 않음), tripSplit(여행 일행 정산, 선택 기능 — 사람은 이름으로 참조). 내부 도우미는 common·recurringDates |
| `src/services/changeLog.js` | 쓰기 기록, 충돌 시 재실행(병합) |
| `src/hooks/useLedgerSync.js` | 불러오기·자동 저장·충돌 병합·미저장 변경 보관 |
| `src/services/storage/provider.js` | 저장소 계약: `read→{bytes,version}`, `write(bytes,version)`(버전이 다르면 `ConflictError`), 백업 폴더·설정 파일. 오류 클래스 |
| `src/services/storage/oneDrive.js` + memory | OneDrive 구현(Graph, eTag 조건부 저장) / 테스트용 메모리 가짜(같은 버전 규칙) |
| `src/services/storage/stall.js` + `src/auth/msalNetwork.js` | 멈춘 요청 끊기: 가계부 받기·저장은 걸린 시간이 아니라 멈춤(25초 동안 아무것도 안 옴)으로 끊어 `StalledError`(= OfflineError)로 / MSAL 토큰 통신은 30초 제한(멈춘 요청에 다음 시도가 묶이지 않게). 처음 받기가 3초를 넘기면 useLedgerSync가 사본으로 먼저 열고 '맞추는 중'(`catchingUp`)으로 이어 받는다 (B-094, I-057) |
| `src/services/storage/googleDrive.js` + `src/auth/googleAuth.js` | Google Drive 구현(Drive v3, 버전은 headRevisionId — 원자적 조건부 저장이 없어 저장 직전 확인 + 저장 뒤 리비전 확인·되돌리기로 대신) / Google 로그인(서버 없는 토큰 방식, 약 1시간마다 만료 → `ReconnectRequiredError`, 앱의 '다시 연결'). 테스트는 `__tests__/fakeDrive.js` |
| `src/services/backups.js` | 백업 이름 규칙·목록·정리(저장소와 무관). 실제 파일은 저장소의 백업 폴더(OneDrive는 `backups/`) |
| `src/services/ledgers.js` + `App/LedgerDialogs.js` + `SettingsView/sections/LedgerShareBlock.js` | 다른 계정과 함께 쓰기(M-2 1단계 Microsoft 개인 계정): 참여 링크(`?join=ms&drive&item`, index.js가 받아 둠)·공유받은 가계부 목록(기기 + 내 앱 폴더 `ledgers.json`, 항목마다 나중 것)·지금 보는 가계부. 초대·구성원은 `createOneDriveStorage(...).sharing`, 공유받은 가계부는 `createOneDriveStorage(…, { ledger })`(`ledgerKey`·`isShared`, 백업 없음) (I-050) |
| `src/services/ledgerFile.js` | 가계부 파일로 바꾸기 전 살피기(이 앱의 가계부인지·더 새 버전인지, 거래 수·기간 등). 바꾸기는 useLedgerSync의 `replaceWithFile` (I-035) |
| `src/services/offlineCache.js` + `public/sw.js` | 연결 없이 열기: 저장소와 맞춘 가계부 사본(IndexedDB, 가계부별 — `ledgerKey || accountKey`) / 서비스 워커(앱 화면 보관, 안드로이드 공유 받기 → `shareInbox.js`). 바로가기·공유 대상은 `public/manifest.json` |
| `src/services/formulaEvaluator.js` + `components/common/AmountInput.js` | 금액 수식 입력 |
| `src/services/aiClient.js` + receiptAssistant·photoEntry·textEntry·cardStatement | AI 호출(Gemini·Claude, 혼잡 시 재시도·모델 전환), 영수증 추천 공통·사진 입력(여러 장, 카드 이용내역 캡처의 여러 결제 — I-052)·말로 입력·카드 대조 |
| `src/services/importHelpers.js` + csv·txValidator | 가져오기 공통(날짜·금액 정규화, 중복 표시, 여행 연결), CSV 파서·작성기, 미등록 카테고리 검사 |
| `src/services/sheetFile.js` + sheetImport·importAI + `components/ImportModal/SheetMapper.js` | 아무 양식의 표 가져오기(I-034): 파일 읽기(CSV 인코딩·구분 문자, xlsx는 내장 압축 풀기, HTML 표 .xls) / 열·분류 맞추기(규칙 짐작·입력 습관·기기에 기억한 양식) → ImportModal의 기존 검사·가져오기 / AI는 맞추기 추천만(앞줄·이름 목록만 보냄) |
| `src/services/cardSms.js` | 카드 승인 문자 → 거래 추천(AI 없이 규칙으로), 카드→결제수단 기억(기기별) |
| `src/services/quickEntry.js` + `components/AIEntry` | 'AI 입력' 하나로 사진·카드 문자·말을 갈래 지어 읽고, 늘 넣던 거래만 바로 넣기(`familiarity`). 바로 넣은 것은 App 알림·확인 화면의 되돌리기(`removeAddedTransactions`, 그 순간의 DB에서 넣은 그대로인 행만) |
| `src/services/aiCommand.js` + `AIEntry/CommandPanel.js`·`AIAssistant.js` | AI 명령(I-051): 어느 화면에서나 ✨ AI 버튼으로 연 AI 창(또는 입력 창의 AI 입력)에 말한 글 중 명령처럼 보이는 것(`looksLikeCommand`)을 AI가 정해진 할 일(`ACTION_TYPES`)로 돌려주면, `buildPlan`이 목록과 대조해 검증하고(거래는 AI에 보내지 않고 조건으로 이 기기에서 찾음, DB에 쓰지 않음) App의 `handleCommand`가 `runPlan`(한 트랜잭션)·`undoPlan`(알림의 되돌리기)으로 실행한다. 되돌리기 쉬운 것(`AUTO_KINDS`)만이면 바로, 거래·정기지출을 바꾸면 한 번 확인. 새 거래만 말했으면 말로 입력으로 넘긴다. 새 할 일은 `ACTION_TYPES`·지시문·`PLANNERS`·`runPlan`·`undoPlan`에 함께 더한다 |
| `src/services/txFilters.js` + txSummary | 거래내역 필터(기간·여러 개 선택·순지출 금액 범위·저장한 필터)와 걸러진 결과의 집계·AI 요약(집계만 보냄) |
| `src/services/exportData.js` + `components/common/download.js` | 거래 CSV 내보내기(가져오기와 같은 칸), 파일 내려받기 |
| `src/services/errorLog.js` + problemReport + `components/common/ProblemReport.js` | 문제 알리기: 처리 못 한 오류·화면 오류(`common/ErrorBoundary`)·화면에 알린 오류를 이 기기에만 남김(최근 20건, 가림, 늘 있는 상태 안내는 뺌) / 보낼 글 / 미리 보기와 복사·메일. 설정 › 앱(`SettingsView/sections/AboutSection.js`), 가계부를 불러오지 못한 화면, 화면 오류 화면에서 쓴다(뒤의 둘은 `common/lazyProblemReport`). 앱 버전은 빌드가 적는다(`__APP_VERSION__`, vite.config.mjs) (I-038) |
| `src/services/displayPrefs.js` + `SettingsView/sections/DisplaySettings.js` | 이 기기 화면: 글씨 크기(`--fs`)·화면 테마(`data-theme`, 기본 밝게)·처음 여는 화면·열 때 가리기(`App/PrivacyCurtain`) — 설정 › 앱. 글씨 크기·테마는 앱을 열 때 `index.html`의 스크립트가 먼저 적용 (U-1·U-2·U-7·U-8, I-039·I-040·I-045·I-046) |
| `public/privacy.html` + `terms.html` + `src/config.js` | 개인정보처리방침·이용약관(로그인 없이 열리는 정적 페이지, 서비스 워커는 앱 화면으로 대신하지 않음) / 설정값: Azure 클라이언트 ID(`VITE_AZURE_CLIENT_ID`로 덮어씀), 운영자 이름·문의 메일(정하기 전: 앱 이름·빈 값) (I-038) |
| `src/data/holidays.js` | 한국 공휴일(연도별) |
| `src/data/starterTemplates.js` + `components/Onboarding` | 첫 실행 기본값(가구 유형별 카테고리·결제수단)과 안내. 빈 가계부(`isBlankLedger`)에만, 확정할 때 `applyStarterSetup`으로 한 번에 넣음 |
| `src/components/*` | 화면 |
| `src/components/TransactionList/OpenNotices.js` | 확인할 것: 앱을 열면 거래내역 맨 위에 보이는 알림 카드 하나(잔액 위험·예산·구독 결제 예정·지난달 리포트, 닫은 기록은 기기별). 거래내역은 이 카드가 있으면 이번 달 대신 이 카드로 열린다 (I-036, B-093). 무엇을 알릴지는 `collectOpenNotices`, 닫은 것을 뺀 결과는 `hasVisibleNotices` — 처음 여는 화면(U-8)도 같은 계산을 쓴다 |
| `src/components/App/screens.js` + `common/lazyScreen.js` | 열 때 불러오는 화면(요약·캘린더·계좌·설정·창들, 입력 창의 AI 입력은 `AIEntry/lazyAIEntry.js`)과 미리 불러오기(`preloadScreens`), 못 불러왔을 때의 다시 시도 (I-033) |
| `docs/BUGS.md` | 버그·개선 목록과 수정 기록 |

## 2. 데이터와 저장 — 가장 중요

1. **DB 쓰기는 dbManager 함수로만 합니다.** 새 함수는 `src/services/db/`의 해당 모듈에 추가하고, 모듈 사이 순환 import는 만들지 않습니다(공용 도우미는 `db/common.js`).
   - 컴포넌트에서 쓰기 SQL을 직접 실행하지 않습니다. 읽기도 가능하면 dbManager 함수를 씁니다.
   - 쓰기는 `db.run`으로 합니다. `db.prepare`로 쓰면 변경 기록에 잡히지 않아 저장·병합에서 빠집니다. (B-001)
2. **저장은 자동입니다.**
   - useLedgerSync가 모든 쓰기를 기록하고 잠시 뒤 저장소(OneDrive 또는 Google Drive)에 저장합니다. 다른 기기와 충돌하면 최신 파일에 내 변경을 다시 실행해 합칩니다.
   - 컴포넌트는 OneDrive·Google Drive(저장소)를 직접 부르지 않습니다. App이 로그인한 계정에 맞춰 `createOneDriveStorage`·`createGoogleDriveStorage`로 만든 저장소를 useLedgerSync·aiSettingsSync에 넘깁니다. 화면 문구의 드라이브 이름은 `storage/driveName.js`를 씁니다.
   - 동기화 코드는 어느 저장소인지 모릅니다. 저장소별 코드는 `services/storage/`에만 두고, 새 저장소는 `storage.test.js`의 계약 테스트를 함께 통과해야 합니다. (I-018)
   - 이 기기에 두는 것(미저장 변경·연결 없이 열 사본·백업 표식)은 `storage.ledgerKey || storage.accountKey`로 가계부마다 따로 둡니다. AI 설정·온보딩처럼 계정에 묶이는 것은 `accountKey`. 공유받은 가계부(M-2)는 열쇠가 달라 바꾸면 useLedgerSync가 지금 DB를 버리고 새로 엽니다. (I-050)
   - **다른 계정에는 가계부 파일(`ledger.db`) 하나만 공유합니다.** 앱 폴더(AI 키가 든 `ai-settings.json`)·백업 폴더는 공유하지 않고, 파일 번호가 바뀌지 않게 가계부 파일을 지우고 다시 만들지 않습니다. (M-2)
   - `onChanged()`는 "지금 저장하고 토스트를 보여 줘"라는 뜻입니다. 부르지 않아도 저장은 됩니다. (B-001, B-003, B-037)
   - 저장소에 연결이 없으면 `OfflineError`를 던집니다(그때는 로그인 화면으로 넘기지 않음). useLedgerSync는 이 기기의 사본(`offlineCache`)으로 열고, 연결되면 사본 버전으로 저장해 기존 병합 경로로 합칩니다. 저장소와 맞춘 순간(불러오기·저장·병합·되돌리기)마다 사본을 새로 남기고, 로그아웃하면 지웁니다. 사본으로 연 동안에는 자동등록을 하지 않습니다. (I-024, B-004)
   - 가계부를 다른 파일로 통째로 바꾸면(`replaceWithFile`) SQLite 머리의 `application_id`에 새 **세대**를 찍습니다. 저장 안 된 변경(병합·다시 열기·바꾸는 동안 입력)은 바탕 가계부와 세대가 같을 때만 다시 실행하고, 다르면 넣지 않고 알립니다 — 바뀐 가계부의 같은 번호 행은 다른 거래입니다. 세대는 파일 바이트에서 읽습니다(`generationOfBytes`, 쓰기 경로에서 DB에 질의하지 않게). `application_id`는 세대 전용, `user_version`은 스키마 버전입니다. (I-035)
3. **확정 전에는 DB에 쓰지 않습니다.**
   - 미리보기, 마법사 중간 단계, 취소 가능한 화면에서 쓰면 바로 저장됩니다.
   - 사용자가 확정할 때 한 번에 씁니다. (B-029)
4. **db를 읽는 useMemo/useEffect는 `dataVersion`이 바뀌면 다시 계산되게 합니다.**
   - sql.js는 같은 객체를 제자리에서 바꾸므로 `[db]`만으로는 화면이 갱신되지 않습니다.
   - App이 모든 화면에 `dataVersion` prop을 넘깁니다. (B-014)
   - `useDbSnapshot`을 씁니다(I-010에서 통일). eslint 예외 주석이 필요 없습니다.
     ```js
     const live = useDbSnapshot(db, dataVersion);
     const items = useMemo(() => getItems(live.db), [live]);
     ```
5. **여러 문장으로 된 변경은 `withTransaction(db, () => { ... })`로 감쌉니다.**
   - 중간에 실패하면 전부 되돌립니다. SAVEPOINT 기반이라 중첩해도 안전합니다. (B-019)
6. **다른 테이블의 id를 담는 컬럼을 새로 만들면** `changeLog.js`의 `FK_COLUMNS`에 `컬럼: 테이블`을 추가합니다.
   - 충돌 병합 때 새로 추가한 행의 id가 바뀌면, 이 목록으로 참조를 고칩니다. (B-001)
7. **자동 생성 로직(자동등록 등)은 멱등이어야 합니다.**
   - 여러 번 실행해도 결과가 같아야 하고, 사용자가 지운 것은 되살리지 않습니다.
   - "이미 만들었는지"는 실제 날짜가 아니라 고정된 키(항목 id + 대상 월 등)로 판단하고, 가능하면 UNIQUE 인덱스로 막습니다. (B-007, B-008)
   - 정기지출 자동등록(`runAutoRegister`)은 불러온 직후, 변경 기록을 붙이기 전에만 실행합니다.
8. **스키마는 이렇게 바꿉니다.** (B-002, B-015, I-009)
   - 새 컬럼은 `db/schema.js`의 `COLUMN_MIGRATIONS`에 한 줄 추가합니다.
   - 새 테이블은 `SCHEMA`에 `CREATE TABLE IF NOT EXISTS`로 추가합니다.
   - 데이터 변환은 `createDatabase`의 `step()`으로 작성하고, **실제로 바꿨을 때만 true를 돌려줍니다.**
   - `didMigrate = true`를 조건 없이 설정하지 않습니다. 매번 OneDrive 전체 업로드가 일어납니다.
   - 스키마를 바꾸면 `SCHEMA_VERSION`을 올립니다.
   - 쓰지 않게 된 테이블을 `SCHEMA`에 남겨 두지 않습니다.
9. **SQL 값은 항상 `?` 파라미터로 바인딩합니다.** 테이블·컬럼 이름을 보간해야 하면 허용 목록으로 검사합니다.

## 3. 이름 변경·삭제는 모든 참조와 함께

카테고리·세부카테고리·결제수단은 id가 아니라 **이름(문자열)으로 참조**됩니다.
이름을 바꾸거나 지우면 아래 참조를 모두 처리하고, 하나의 트랜잭션으로 묶습니다. (B-019, B-020, B-021)
- 이 규칙은 `db/masterData.js`의 `CATEGORY_REF_TABLES`, `rename*`, `get*Usage`, `delete*` 함수에 구현되어 있습니다.
- 카테고리를 참조하는 테이블을 새로 만들면 이 목록과 함수들에 추가합니다.

- `transactions`(budget_category, sub_category, payment_method)
- `recurring_transactions`, `favorite_transactions`
- `payment_method_discount_rules`(payment_method_name, budget_category, sub_category)
- `auto_pattern_settings`(sub_category)
- `settings`의 `trip_default_category`
- `account_recurring_items.auto_payment_method`(결제수단)
- `category_budgets`(budget_category) — 카테고리별 예산(I-025). 이름 변경은 따라가고, 카테고리를 지우면 함께 지운다

가족 구성원도 이름으로 참조합니다: `transactions.member` → `members.name`. `db/members.js`의 `renameMember`·`deleteMember`가 거래 참조를 함께 고칩니다(삭제하면 '누가'를 비우고 거래는 남깁니다). 기기별 '이 기기 사용자'(localStorage)와 카드 문자→결제수단 기억은 DB 밖에 있으므로, 쓸 때마다 DB 목록과 대조해 없는 이름은 버립니다. (I-012, I-013)

다음 규칙도 함께 지킵니다.
- **확인창 문구는 실제 동작과 정확히 일치해야 합니다.** 예: "거래가 비워집니다"라고 썼으면 실제로 비웁니다.
- **연결된 기록은 함께 정리합니다.** 예: 현금 흐름 ↔ 계좌 거래, 이월 짝, 분할 결제 짝, 일정 ↔ 현금 흐름. (B-038, B-044, B-053)
- **화면에서 거래를 지우는 것은 `deleteTransactionsForUndo`로 하고 알림에 되돌리기를 둡니다.** 거래를 가리키는 칸(`transaction_id`·`linked_tx_id` 등)을 새로 만들면 `restoreDeletedTransactions`가 되살릴 때 그 연결도 새 번호로 잇게 함께 고칩니다. (ROADMAP U-3, I-041)

## 4. 금액

- **모든 금액·환율 입력은 `AmountInput` + `formulaEvaluator`를 씁니다.** `parseInt`·`parseFloat`·`Number()`로 직접 읽지 않습니다. (B-025)
  - `evaluateFormula`: 원화(정수)
  - `parseOptionalAmount`: 비워 둘 수 있는 원화 칸(빈 칸만 0, 잘못된 값은 NaN, 음수는 `allowNegative`일 때만)
  - `parseForeignAmount`: 외화(소수)
  - `parseRate`: 환율
- **잘못된 입력은 NaN으로 보고 오류를 보여 줍니다.**
  - `|| 0`으로 조용히 0을 만들지 않고, 잘못된 값을 저장에서 조용히 빼지도 않습니다. 저장을 막고 이유를 보여 줍니다. (B-036, B-041, B-065, B-067~B-069)
  - 입력 중인 수식("1000+")은 오류 대신 "수식을 마저 입력하세요"로 안내합니다(`isIncompleteFormula`). 화면에 보이지 않는 칸 때문에 저장을 막지 않습니다.
  - 허용 문자는 숫자, 사칙연산, 괄호, 쉼표, ×, ÷, 끝의 '원'입니다.
- **순지출은 `amount - discount_amount`입니다.** 화면 막대·합계·정렬이 같은 값을 써야 합니다. (B-051)
  - 예외로, 계좌의 카드 결제 자동 금액(`getCardPaymentTotal`)은 할인을 빼지 않은 `amount` 합계를 씁니다. (I-016)
  - 카드 할인은 대부분 캐시백이라 결제일에는 할인 전 금액이 빠져나갑니다. 할인을 빼면 출금이 적게 잡혀 잔액 부족을 늦게 알게 됩니다.
  - 같은 이유로 연말정산 참고 합계(`getTaxSummary`, I-029)도 할인 전 `amount`를 씁니다(카드사가 국세청에 알리는 금액). 할인 합계는 따로 보입니다.
- **분할 결제는 몫마다 한 행이고 `split_group_id`로 묶습니다.**
  - 할인은 몫의 금액 기준으로 계산합니다. (B-030)
  - 수정할 때는 저장된 몫·환율을 유지합니다. (B-033)
- **외화는 `foreign_amounts`(JSON `{통화: 금액}`)에 기록합니다.** 원화 `amount`는 별도로 저장합니다.

## 5. 날짜

- 날짜는 로컬 `'YYYY-MM-DD'` 문자열로 다루고, `src/services/dateUtils.js`의 함수를 씁니다(직접 포맷하지 않음, I-006).
- **금지:** `toISOString()`(UTC라 한국에서 하루 전 날짜가 나옴), `new Date('YYYY-MM-DD')`(UTC 자정으로 해석). (B-011)
- 문자열을 Date로 바꿀 때는 `new Date(y, m - 1, d)`를 씁니다.
- 날짜 입력은 실제 달력 기준으로 검증합니다. 2월 30일, 종료일 < 시작일은 막습니다. (B-029, B-050)
- **공휴일:** 매년 하반기에 `src/data/holidays.js`에 다음 해를 추가합니다(대체공휴일 포함). 데이터가 없는 연도는 앱이 경고합니다. (B-006)

## 6. 화면(React)

- 모바일 우선입니다. UI 문구는 한국어로 쓰고 존댓말 안내체를 씁니다.
- **모든 가족이 쓰지 않을 기능은 선택 기능으로 만듭니다.** 설정에서 켜고 끄고(기본은 꺼짐), 꺼 두면 그 기능의 화면이 보이지 않습니다. 끄면 화면만 감추고 정해 둔 값은 남깁니다. 가족 공통이면 가계부 DB의 `settings`, 기기별 취향이면 localStorage에 둡니다. (사용자 요청, I-025)
  - 새 선택 기능은 `services/optionalFeatures.js`의 `OPTIONAL_FEATURES`에 한 줄 더해(AI 명령도 이 목록으로 켜고 끈다) 설정 › 선택 기능에 나오게 하고, 원래 자리의 스위치는 `OptionalFeatureHead`를 씁니다(이름·설명이 두 곳에서 같게). (I-032)
- **알림은 앱을 열 때 거래내역의 '확인할 것' 카드 한 곳에만 보입니다.** 새 알림은 `TransactionList/OpenNotices.js`에 항목으로 더하고 띠를 따로 만들지 않습니다. 앱이 꺼져 있을 때의 푸시 알림은 쓰지 않습니다. (사용자 결정, I-036, B-093)
- 모달은 `common/ModalOverlay`를 쓰고, 뒤로가기는 App의 `navigate`/history 흐름을 따릅니다.
- 모달 안의 터치·스와이프가 뒤 화면으로 새지 않게 합니다. (B-048)
  - 가로로 밀어 넘기기는 `common/useHorizontalSwipe`를 씁니다(캘린더·요약 — 세로 스크롤·입력 칸·가로 스크롤 칸은 거름). Esc는 `ModalOverlay`가 맨 위 창의 `onDismiss`로 처리합니다(입력 창은 onDismiss를 넘기지 않아 닫히지 않음). (U-9, U-10)
- `dangerouslySetInnerHTML`은 쓰지 않습니다. AI 응답과 사용자 입력은 텍스트로만 렌더링합니다.
- 비동기 요청(AI·네트워크)은 `AbortController`로 취소할 수 있게 하고, 취소는 오류로 표시하지 않습니다.
- 늦게 도착한 응답이 현재 화면 상태와 맞는지 확인합니다. (B-049, B-052)
- 같은 로직을 복사하지 않습니다. 카테고리 색은 `common/categoryColor`, CSV는 공통 파서를 씁니다. (B-054, I-005)
- **첫 화면(거래내역)에 필요 없는 새 탭·창은 `App/screens.js`에 `lazyScreen`으로 추가합니다** — 열 때 불러오고 로그인 뒤 미리 불러 둡니다. App에서 그 화면 모듈을 직접 import하면 다시 첫 화면 코드에 섞입니다. (I-033)
  - 창은 `<Suspense fallback={<ModalLoading />}>`로 감쌉니다. 빌드는 나눈 파일을 index.html에 prefetch로 적어 서비스 워커가 함께 받아 둡니다(vite.config.mjs).
  - CSS는 한 파일입니다(`cssCodeSplit: false`). 순서는 첫 화면과 함께 불러오는 화면 → 나눈 화면이므로, 화면 CSS는 자기 접두어 클래스로 쓰고 다른 화면의 같은 선택자를 덮어쓰지 않습니다.
- **글씨 크기는 `calc(Npx * var(--fs))`로 씁니다** (CSS의 `font-size`, 인라인 `fontSize: 'calc(13px * var(--fs))'`). 설정 › 앱의 글씨 크기가 `--fs`(배율)를 바꿉니다. px를 그대로 쓰면 그 글씨만 커지지 않습니다. (ROADMAP U-1, I-039 — `displayPrefs.test.js`가 지킵니다)
  - 한 줄에 다 보여야 하는 곳(설정 탭, 머리글 제목)은 `calc(14px * min(var(--fs), 1))`처럼 배율에 상한을 둡니다 — 크게 고르면 탭이 밀려나 그 설정으로 돌아갈 수 없게 되지 않게.
- **색은 `src/index.css`의 토큰을 씁니다** (`var(--text)`·`var(--surface)`·`var(--c-amber-100)` 등). 어두운 테마(설정 › 앱 › 화면 테마)가 토큰 값만 바꾸므로, 배경에 밝은 색(`#fff`·`#FEF3C7` 등)을 그대로 쓰면 어두운 화면에 흰 판이 남습니다. 흰 글씨를 얹는 채움 색(버튼·배지 배경)과 그 위의 글씨는 그대로 써도 됩니다. 강조색을 글씨로 쓸 때는 `var(--primary-text)`(채움은 `var(--primary)`)를 씁니다 — 어두운 테마에서 글씨만 밝아집니다. 새 색은 `:root`와 두 어두운 블록에 함께 더합니다. (ROADMAP U-2, I-040 — 같은 테스트)
- 이 기기의 화면 설정(글씨 크기·테마)은 `services/displayPrefs.js`(localStorage)에 두고, 앱을 열 때 `index.html`의 짧은 스크립트가 그리기 전에 먼저 적용합니다(같은 열쇠·값 — 테스트가 봅니다).

## 7. AI 연동

- API 키는 **가계부 DB(ledger.db)에 절대 저장하지 않습니다.** DB는 변경 기록·병합·내보내기로 여기저기 복사됩니다.
  - 키는 기기의 localStorage에 두고, 같은 계정의 기기끼리는 드라이브의 별도 설정 파일(OneDrive `Apps/financial-ledger/ai-settings.json`, Google Drive `financial-ledger/ai-settings.json`)로만 맞춥니다(`aiSettingsSync`). (I-015)
  - 사용자가 바꾼 설정은 `updateAIConfig`로 저장합니다. 실제로 달라진 항목(고른 공급자, 공급자별 키·모델)만 '올릴 것'으로 표시됩니다. (B-071)
  - 동기화는 OneDrive 파일을 먼저 읽고 그 위에 올릴 것만 덮어써, 읽을 때의 eTag로 저장합니다. 기기 시계로 비교하지 않고, 설정 전체를 통째로 덮어쓰지 않습니다.
  - 이 기기 설정은 로그인 계정(저장소의 accountKey — Microsoft는 homeAccountId, Google은 `google:<sub>`)에 묶습니다. 다른 계정으로 로그인하면 올리지 않고 버립니다.
  - 로그아웃 때 이 기기에서만 지우는 것(`clearAIKeys`)은 올리지 않아, 다시 로그인하면 OneDrive 값이 돌아옵니다.
- AI가 고른 결제수단·카테고리는 DB 목록과 대조해 검증합니다. 목록에 없으면 버립니다.
- **AI 호출 규칙 (aiClient.js):**
  - Claude 요청에는 `tool_choice: {type:'auto', disable_parallel_tool_use:true}`만 씁니다. 강제 도구 호출(`tool`/`any`)과 temperature·top_p는 보내지 않습니다. Sonnet·Opus 5.5는 400을 냅니다. (B-072)
  - AI 결과는 `usableResult`로 스키마 모양을 검사한 뒤에만 씁니다. (B-077)
  - AI 요청은 `analyzeWithAI`(안의 `request`)로만 보냅니다. 휴대폰에서 화면이 가려진 사이 끊긴 요청은 돌아와서 다시 보내고, 분석하는 동안 화면 꺼짐을 막습니다(`pageVisibility`·`wakeLock`). 직접 `fetch`하면 이 처리가 빠집니다. (I-023)
  - 혼잡(503·529) 때만 다른 모델로 바꾸고, 더 비싼 모델로는 바꾸지 않습니다. (B-073, B-075, B-076)
- AI에게 보내는 가계부 정보는 결제수단·카테고리 목록과 입력 습관처럼 필요한 범위로 제한합니다.

## 8. 버그 기록 — docs/BUGS.md

버그를 찾거나 고치면 `docs/BUGS.md`에 기록합니다.
- **번호:** 버그는 `B-xxx`, 개선은 `I-xxx`입니다. 파일 상단의 "다음 번호"를 쓰고, 번호는 재사용하지 않습니다.
- **항목 키:** `상태 / 심각도 / 영역 / 문제 / 원인 / 해결 / 파일`이고, 문제·원인·해결은 **각 1줄**입니다.
- **갱신:** 상태가 바뀌면 요약표와 상세 항목을 둘 다 고칩니다.

## 9. 테스트와 검증

- dbManager·changeLog·formulaEvaluator 같은 로직을 바꾸면 `src/services/__tests__/`에 테스트를 추가합니다.
  - 테스트는 Vitest입니다. `describe/test/expect/vi`는 전역으로 씁니다.
  - sql.js는 Node에서 바로 돌아갑니다(기본 환경 node).
  - 화면 테스트는 파일 맨 위에 `@vitest-environment jsdom`을 두고 `react`의 `act`를 씁니다. 예: `src/components/TransactionForm/__tests__/`
  - App을 그리는 테스트는 `beforeAll`에서 `await preloadScreens()`를, 입력 창의 AI 입력을 쓰는 테스트는 `await AIEntry.preload()`(`AIEntry/lazyAIEntry`)를 합니다 — 나눈 화면이 기다림 없이 그려지게. (I-033)
  - 카드 대조(cardStatement.js)를 고치면 무작위 테스트를 큰 표본으로도 돌려 봅니다. 예: `CARD_PROPERTY_N=1000`, `CARD_REFUND_N=1000`
    - 확인할 것: 조용한 오류(합계가 틀린데 화면에 확인거리 없음) 0, 해로운 권장 0, 평범한 달 "모두 맞습니다" 비율 유지
    - 본질적으로 모호한 경우는 테스트 머리말의 제외 목록에 이유를 적습니다. (B-079~B-087)
- 커밋 전에 아래를 확인합니다.
  - `npm test`: 전부 통과 (반복 실행은 `npm run test:watch`)
  - `npm run lint`: 경고 0
  - `npm run build`: 성공 (결과는 `build/`)
- **빌드 환경 (Vite)**
  - JSX는 `.js` 파일에 그대로 씁니다. vite.config.mjs가 처리합니다.
  - 환경값은 `import.meta.env`를 씁니다. `process.env`는 브라우저에 없습니다.
  - 개발 서버는 3000번 고정입니다. Azure 앱 등록의 리디렉션 주소와 맞추기 위해서입니다.
  - 배포 설정은 `vercel.json`에 있습니다.
- sql.js WASM은 `scripts/copy-sql-wasm.js`가 `npm start`·`npm run build` 전에 `public/`으로 복사합니다. CDN URL을 쓰지 않습니다. (B-013)

## 10. Git

- 사용자가 "커밋해줘"라고 하면 main에 직접 커밋하고 푸시까지 합니다.
- 여러 AI 세션이 같은 저장소에서 동시에 작업할 수 있습니다.
  - `git add -A`나 `git add .` 대신 내가 바꾼 파일만 지정합니다.
  - 작업을 시작할 때 `git status`로 다른 사람의 미커밋 변경이 있는지 확인합니다.
- 커밋 메시지는 한국어로, 무엇을 왜 바꿨는지 요약합니다.
