# AGENTS.md — 지금 가계부 코드 작성 규칙

이 파일은 이 저장소에서 작업하는 모든 AI 코딩 도구와 사람이 **작업을 시작하기 전에 읽는 기준**입니다.
- Claude Code는 `CLAUDE.md`가 이 파일을 불러옵니다.
- Codex·Cursor·Copilot 등 다른 도구는 이 파일을 직접 읽습니다.

규칙마다 괄호 안에 근거가 된 버그 번호(docs/BUGS.md)를 적었습니다. 규칙을 어기면 그 버그가 다시 생깁니다.

## 1. 프로젝트 한눈에

- 가족이 함께 쓰는 가계부 웹앱입니다. 서버가 없습니다.
- 기술: React 18, Vite 6(개발 서버·빌드), Vitest(테스트), sql.js(브라우저 SQLite), Microsoft Graph(MSAL), OneDrive 파일 하나(`Apps/financial-ledger/ledger.db`)
- 모바일 우선, UI 문구는 한국어입니다.

| 위치 | 역할 |
|---|---|
| `src/services/dbManager.js` | DB 함수의 단일 진입점(재내보내기만). 컴포넌트는 여기서 import |
| `src/services/db/*.js` | 실제 구현: schema(스키마·마이그레이션), transactions, masterData, members(가족 구성원), calendar, tripCash, summary, settings, recurring, favorites, patterns, accounts(잔액 예측·위험 알림 포함), discounts. 내부 도우미는 common·recurringDates |
| `src/services/changeLog.js` | 쓰기 기록, 충돌 시 재실행(병합) |
| `src/hooks/useLedgerSync.js` | 불러오기·자동 저장·충돌 병합·미저장 변경 보관 |
| `src/services/storage/provider.js` | 저장소 계약: `read→{bytes,version}`, `write(bytes,version)`(버전이 다르면 `ConflictError`), 백업 폴더·설정 파일. 오류 클래스 |
| `src/services/storage/oneDrive.js` + memory | OneDrive 구현(Graph, eTag 조건부 저장) / 테스트용 메모리 가짜(같은 버전 규칙) |
| `src/services/backups.js` | 백업 이름 규칙·목록·정리(저장소와 무관). 실제 파일은 저장소의 백업 폴더(OneDrive는 `backups/`) |
| `src/services/formulaEvaluator.js` + `components/common/AmountInput.js` | 금액 수식 입력 |
| `src/services/aiClient.js` + receiptAssistant·textEntry·cardStatement | AI 호출(Gemini·Claude, 혼잡 시 재시도·모델 전환), 영수증·말로 입력·카드 대조 |
| `src/services/importHelpers.js` + csv·txValidator | 가져오기 공통(날짜·금액 정규화, 중복 표시, 여행 연결), CSV 파서·작성기, 미등록 카테고리 검사 |
| `src/services/cardSms.js` | 카드 승인 문자 → 거래 추천(AI 없이 규칙으로), 카드→결제수단 기억(기기별) |
| `src/services/exportData.js` + `components/common/download.js` | 거래 CSV 내보내기(가져오기와 같은 칸), 파일 내려받기 |
| `src/data/holidays.js` | 한국 공휴일(연도별) |
| `src/data/starterTemplates.js` + `components/Onboarding` | 첫 실행 기본값(가구 유형별 카테고리·결제수단)과 안내. 빈 가계부(`isBlankLedger`)에만, 확정할 때 `applyStarterSetup`으로 한 번에 넣음 |
| `src/components/*` | 화면 |
| `docs/BUGS.md` | 버그·개선 목록과 수정 기록 |

## 2. 데이터와 저장 — 가장 중요

1. **DB 쓰기는 dbManager 함수로만 합니다.** 새 함수는 `src/services/db/`의 해당 모듈에 추가하고, 모듈 사이 순환 import는 만들지 않습니다(공용 도우미는 `db/common.js`).
   - 컴포넌트에서 쓰기 SQL을 직접 실행하지 않습니다. 읽기도 가능하면 dbManager 함수를 씁니다.
   - 쓰기는 `db.run`으로 합니다. `db.prepare`로 쓰면 변경 기록에 잡히지 않아 저장·병합에서 빠집니다. (B-001)
2. **저장은 자동입니다.**
   - useLedgerSync가 모든 쓰기를 기록하고 잠시 뒤 OneDrive에 저장합니다. 다른 기기와 충돌하면 최신 파일에 내 변경을 다시 실행해 합칩니다.
   - 컴포넌트는 OneDrive(저장소)를 직접 부르지 않습니다. App이 `createOneDriveStorage`로 만든 저장소를 useLedgerSync·aiSettingsSync에 넘깁니다.
   - 동기화 코드는 어느 저장소인지 모릅니다. 저장소별 코드는 `services/storage/`에만 두고, 새 저장소는 `storage.test.js`의 계약 테스트를 함께 통과해야 합니다. (I-018)
   - `onChanged()`는 "지금 저장하고 토스트를 보여 줘"라는 뜻입니다. 부르지 않아도 저장은 됩니다. (B-001, B-003, B-037)
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

가족 구성원도 이름으로 참조합니다: `transactions.member` → `members.name`. `db/members.js`의 `renameMember`·`deleteMember`가 거래 참조를 함께 고칩니다(삭제하면 '누가'를 비우고 거래는 남깁니다). 기기별 '이 기기 사용자'(localStorage)와 카드 문자→결제수단 기억은 DB 밖에 있으므로, 쓸 때마다 DB 목록과 대조해 없는 이름은 버립니다. (I-012, I-013)

다음 규칙도 함께 지킵니다.
- **확인창 문구는 실제 동작과 정확히 일치해야 합니다.** 예: "거래가 비워집니다"라고 썼으면 실제로 비웁니다.
- **연결된 기록은 함께 정리합니다.** 예: 현금 흐름 ↔ 계좌 거래, 이월 짝, 분할 결제 짝, 일정 ↔ 현금 흐름. (B-038, B-044, B-053)

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
- 모달은 `common/ModalOverlay`를 쓰고, 뒤로가기는 App의 `navigate`/history 흐름을 따릅니다.
- 모달 안의 터치·스와이프가 뒤 화면으로 새지 않게 합니다. (B-048)
- `dangerouslySetInnerHTML`은 쓰지 않습니다. AI 응답과 사용자 입력은 텍스트로만 렌더링합니다.
- 비동기 요청(AI·네트워크)은 `AbortController`로 취소할 수 있게 하고, 취소는 오류로 표시하지 않습니다.
- 늦게 도착한 응답이 현재 화면 상태와 맞는지 확인합니다. (B-049, B-052)
- 같은 로직을 복사하지 않습니다. 카테고리 색은 `common/categoryColor`, CSV는 공통 파서를 씁니다. (B-054, I-005)

## 7. AI 연동

- API 키는 **가계부 DB(ledger.db)에 절대 저장하지 않습니다.** DB는 변경 기록·병합·내보내기로 여기저기 복사됩니다.
  - 키는 기기의 localStorage에 두고, 같은 Microsoft 계정의 기기끼리는 OneDrive의 별도 설정 파일(`Apps/financial-ledger/ai-settings.json`)로만 맞춥니다(`aiSettingsSync`). (I-015)
  - 사용자가 바꾼 설정은 `updateAIConfig`로 저장합니다. 실제로 달라진 항목(고른 공급자, 공급자별 키·모델)만 '올릴 것'으로 표시됩니다. (B-071)
  - 동기화는 OneDrive 파일을 먼저 읽고 그 위에 올릴 것만 덮어써, 읽을 때의 eTag로 저장합니다. 기기 시계로 비교하지 않고, 설정 전체를 통째로 덮어쓰지 않습니다.
  - 이 기기 설정은 로그인 계정(homeAccountId)에 묶습니다. 다른 계정으로 로그인하면 올리지 않고 버립니다.
  - 로그아웃 때 이 기기에서만 지우는 것(`clearAIKeys`)은 올리지 않아, 다시 로그인하면 OneDrive 값이 돌아옵니다.
- AI가 고른 결제수단·카테고리는 DB 목록과 대조해 검증합니다. 목록에 없으면 버립니다.
- **AI 호출 규칙 (aiClient.js):**
  - Claude 요청에는 `tool_choice: {type:'auto', disable_parallel_tool_use:true}`만 씁니다. 강제 도구 호출(`tool`/`any`)과 temperature·top_p는 보내지 않습니다. Sonnet·Opus 5.5는 400을 냅니다. (B-072)
  - AI 결과는 `usableResult`로 스키마 모양을 검사한 뒤에만 씁니다. (B-077)
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
