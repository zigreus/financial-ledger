# 버그·개선 목록

이 파일 하나로 해야 할 일과 수정 기록을 함께 관리한다.

## 작성 규칙

- **번호:** 버그는 `B-xxx`, 개선은 `I-xxx`로 붙인다. 한 번 쓴 번호는 다시 쓰지 않는다. 새 항목은 마지막 번호 다음부터 붙인다.
- **상태:** ⬜ 대기 · 🔧 진행 중 · ✅ 해결 · ⏸ 보류. 보류는 사유를 같이 적는다.
- **항목 형식:** 각 항목은 아래 키를 이 순서대로 쓴다. `문제`·`원인`·`해결`은 각 1줄이다.
  - `상태`, `심각도`(치명/높음/중간/낮음), `영역`, `문제`, `원인`, `해결`, `파일`
- **갱신:** 상태가 바뀌면 요약표와 상세 항목을 둘 다 고친다.

다음 번호: B-062, I-011

## 요약표

| ID | 상태 | 심각도 | 영역 | 제목 |
|---|---|---|---|---|
| B-001 | ✅ | 치명 | 저장·동기화 | 가족이 동시에 쓰면 나중에 저장한 쪽이 상대 입력을 덮어씀 |
| B-002 | ✅ | 높음 | 저장·동기화 | 변경이 없어도 열 때마다 DB 전체 업로드, 저장마다 2번 업로드 |
| B-003 | ✅ | 치명 | 저장·동기화 | 저장 실패를 알 수 없음, 새로고침 시 미저장 변경 유실 |
| B-004 | ✅ | 치명 | 인증 | 로그아웃 후 이전 DB가 남아 다른 계정 OneDrive에 덮어쓸 수 있음 |
| B-005 | ✅ | 높음 | 인증 | 토큰 갱신 실패·네트워크 오류 시 즉시 리다이렉트되어 변경 유실 |
| B-006 | ✅ | 높음 | 공휴일 | 공휴일 데이터가 2026년뿐 |
| B-007 | ✅ | 높음 | 계좌 자동등록 | 휴일 보정으로 다른 달로 넘어가면 실행마다 중복 생성 |
| B-008 | ✅ | 중간 | 계좌 자동등록 | 자동생성 내역을 지우거나 날짜를 옮기면 다시 생성됨 |
| B-009 | ✅ | 중간 | 계좌 자동등록 | 고정항목 수정·삭제가 이미 만든 미래 내역에 반영 안 됨 |
| B-010 | ✅ | 중간 | 정기지출 | 앱을 한 달 넘게 안 열면 그 달 정기지출이 영영 누락 |
| B-011 | ✅ | 중간 | 공휴일 | 날짜 문자열을 UTC로 해석해 음수 시간대에서 하루 밀림 |
| B-012 | ✅ | 중간 | 성능 | 저장할 때마다 이전 sql.js DB를 해제하지 않아 메모리 누수 |
| B-013 | ✅ | 중간 | 인프라 | sql.js WASM을 실행 중 unpkg CDN에서 받음 |
| B-014 | ✅ | 중간 | 화면 갱신 | 변경 직후 화면이 저장 왕복이 끝날 때까지 옛 상태 |
| B-015 | ✅ | 낮음 | DB 마이그레이션 | 마이그레이션 오류를 조용히 무시 |
| B-016 | ✅ | 낮음 | 인증 | 로그인·로그아웃이 팝업 방식, 중복 클릭 시 오류 |
| B-017 | ✅ | 치명 | 가져오기 | 거래 가져오기가 항상 실패, 여행 연결 유실 |
| B-018 | ✅ | 중간 | 설정 | 즐겨찾기 드래그 정렬이 항상 예외 |
| B-019 | ✅ | 높음 | 설정 | 카테고리 이름 변경이 정기지출·즐겨찾기·할인규칙·설정에 반영 안 됨 |
| B-020 | ✅ | 중간 | 설정 | 카테고리 삭제 확인 문구와 실제 동작 불일치 |
| B-021 | ✅ | 중간 | 설정 | 결제수단을 숨기면 사용 중이어도 삭제될 수 있음 |
| B-022 | ✅ | 중간 | 계좌 | 잔액 기준일 미사용 → 과거 내역을 불러오면 잔액 이중 계산 |
| B-023 | ✅ | 낮음 | 계좌 | 기본 계좌가 여러 개가 될 수 있음 |
| B-024 | ✅ | 중간 | 계좌 | 계좌 내역 불러오기 완료 화면을 ✕로 닫으면 저장 안 됨 |
| B-025 | ✅ | 중간 | 가져오기 | 중복 검사 없음, 계좌 CSV 금액 parseInt·음수 출금 오류 |
| B-026 | ✅ | 낮음 | 설정 | 일정 유형 드래그가 한 칸 더 내려가고, 목록 끝 드롭은 무시 |
| B-027 | ✅ | 낮음 | 설정 | 정렬 시 숨김·표시 그룹 간 sort_order 겹침 |
| B-028 | ✅ | 낮음 | 설정 | 자동 패턴 비율이 항상 100% |
| B-029 | ✅ | 낮음 | 가져오기 | 취소해도 자동 추가 카테고리가 남고, 오류 행 번호·날짜 검증이 틀림 |
| B-030 | ✅ | 높음 | 거래 입력 | 분할 결제 첫 몫의 할인을 총액 기준으로 계산 |
| B-031 | ✅ | 중간 | 거래 입력 | 거래 수정 시 할인 메모(discount_note) 삭제 |
| B-032 | ✅ | 중간 | 거래 입력 | 결제수단을 현금으로 바꿔도 이전 카드 자동할인이 남음 |
| B-033 | ✅ | 높음 | 거래 입력 | 분할 거래 수정 시 현재 환율로 재계산, 일정을 숨기면 외화가 원화로 해석 |
| B-034 | ✅ | 중간 | 거래 입력 | 두 통화 이상일 때 분할하면 외화 금액이 버려짐 |
| B-035 | ✅ | 중간 | 거래 입력 | 환율 없는 통화 칸 입력 시 직접 입력한 원화 금액이 지워짐 |
| B-036 | ✅ | 중간 | 거래 입력 | 할인 수식 오류 시 조용히 0으로 저장 |
| B-037 | ✅ | 중간 | 거래 입력 | 폼에서 바꾼 즐겨찾기가 저장되지 않음 |
| B-038 | ✅ | 높음 | 여행 현금 | 현금 흐름 삭제 시 연결 기록이 남고, 확인 없이 삭제 |
| B-039 | ✅ | 높음 | 여행 현금 | 재환전 종료 시 원가 기준 불일치로 원치 않는 환차손익, 음수 지갑 |
| B-040 | ✅ | 중간 | 여행 현금 | 정산 지출·환차손익 거래가 카테고리 없이 생성되고 이슈로도 안 잡힘 |
| B-041 | ✅ | 중간 | 금액 입력 | 허용 안 되는 문자를 지우고 계산("3만"→3원) |
| B-042 | ✅ | 낮음 | 금액 입력 | 입력란 사이 포커스 이동 시 하단 여백이 복원 안 됨 |
| B-043 | ✅ | 낮음 | 거래 입력 | 숨긴 세부카테고리 거래를 수정하면 세부카테고리가 지워짐 |
| B-044 | ✅ | 낮음 | 거래 목록 | 분할 거래 한쪽만 삭제하면 짝이 고아로 남음 |
| B-045 | ✅ | 낮음 | 여행 현금 | 현금 내역 정렬 비교 함수가 일관되지 않음 |
| B-046 | ✅ | 낮음 | 성능 | 키 입력마다 지갑 SQL 재계산, 목록 ref O(n²), console.log 잔존 |
| B-047 | ✅ | 중간 | 요약 | 일정별 결제수단 탭이 유형 필터를 무시 |
| B-048 | ✅ | 중간 | 캘린더 | 대각선 스크롤·바텀시트 안 스와이프에도 달이 바뀜 |
| B-049 | ✅ | 중간 | AI 입력 | 영수증 분석 취소가 일부 구간에서 무시되고, 취소 시 오류 화면 |
| B-050 | ✅ | 낮음 | 캘린더 | 종료일이 시작일보다 빠른 일정이 저장되어 달력에서 사라짐 |
| B-051 | ✅ | 낮음 | 요약 | 막대 그래프가 할인 전 금액 사용, 음수면 100%로 그려짐 |
| B-052 | ✅ | 낮음 | AI 설정 | 연결 확인 중 공급자를 바꾸면 이전 공급자 모델 목록이 섞임 |
| B-053 | ✅ | 낮음 | 캘린더 | 일정 삭제 시 현금 흐름이 고아로 남고, 연결 거래 해제 안내 없음 |
| B-054 | ✅ | 낮음 | 화면 | 카테고리 색 정의가 두 곳이라 화면마다 색이 다름 |
| B-055 | ✅ | 낮음 | 요약 | 이번 달 거래가 없으면 월 선택이 빈칸 |
| B-056 | ✅ | 낮음 | AI 입력 | 가맹점 매칭이 빈도 우선이라 짧은 일반 이름이 구체적 이름을 이김 |
| B-057 | ✅ | 낮음 | 거래 목록 | 사용자 카테고리 배지 배경이 보이지 않음 |
| B-058 | ✅ | 중간 | 거래 입력 | 자동 결제수단 패턴을 꺼도 계속 적용되고, 설정 목록과 실제 기준이 다름 |
| B-059 | ✅ | 낮음 | 계좌 | 계좌 일괄 삽입을 다른 트랜잭션 안에서 부르면 실패 |
| B-060 | ✅ | 낮음 | 캘린더 | 일정을 지운 뒤 그 거래를 수정하면 외화 금액이 빠짐 |
| B-061 | ✅ | 낮음 | 설정 | 여행 기본 카테고리를 '사용 안 함'으로 골라도 다시 선택됨 |
| I-001 | ✅ | - | 테스트 | 자동 테스트 0개 → dbManager 핵심 로직 테스트 추가 |
| I-002 | ✅ | - | 정리 | 죽은 코드(trips 테이블·함수, holidays 테이블, 미사용 함수) 정리 |
| I-003 | ✅ | - | 구조 | 요약 SQL 함수 9개 복붙 → 공통 함수 |
| I-004 | ✅ | - | 구조 | SettingsView·TransactionForm·dbManager 파일 분리 |
| I-005 | ✅ | - | 구조 | CSV 파서 중복, 따옴표 안 줄바꿈 미지원 |
| I-006 | ✅ | - | 구조 | 로컬 날짜 포맷 함수 5벌 이상 중복 |
| I-007 | ✅ | - | 정리 | README가 CRA 기본 문서, 0바이트 sqlite 파일이 커밋됨 |
| I-008 | ✅ | - | 인프라 | CRA(react-scripts 5) 지원 종료 → Vite 이전 |
| I-009 | ✅ | - | DB | 스키마 버전 관리 없음 |
| I-010 | ✅ | - | 구조 | dataVersion 반영 방식이 두 가지(eslint-disable vs useDbSnapshot) |


## 상세

### B-001 가족이 동시에 쓰면 나중에 저장한 쪽이 상대 입력을 덮어씀
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 치명
- 영역: 저장·동기화
- 문제: A 기기가 열어 둔 사이 B 기기가 거래를 추가하면, 나중에 A가 저장할 때 B의 거래가 사라진다.
- 원인: OneDrive에 DB 파일 전체를 PUT하면서 그 사이 파일이 바뀌었는지(eTag) 확인하지 않는다.
- 해결: 저장을 eTag 조건부(If-Match) PUT으로 바꾸고, 412 충돌이면 최신 파일을 받아 변경 기록(changeLog)을 다시 실행해 합친 뒤 저장한다. 새 행 id가 달라지면 참조 파라미터를 새 id로 바꿔 끼운다.
- 파일: src/services/changeLog.js(신규), src/hooks/useLedgerSync.js(신규), src/services/oneDriveService.js, src/components/App/App.js

### B-002 변경이 없어도 열 때마다 DB 전체 업로드, 저장마다 2번 업로드
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 높음
- 영역: 저장·동기화
- 문제: 앱을 열기만 해도 DB 전체를 다시 올리고, 거래 하나를 저장할 때도 쓰기·읽기·쓰기로 업로드가 두 번 일어난다.
- 원인: createDatabase의 trips·일정유형 블록이 `didMigrate = true`를 조건 없이 설정한다. SCHEMA가 trips 테이블을 만들고 마이그레이션이 매번 DROP하는 구조다.
- 해결: 컬럼 마이그레이션을 '없을 때만 추가'(ensureColumn)로 바꾸고 각 단계가 실제로 바꿨을 때만 didMigrate를 켠다. SCHEMA에서 trips·holidays를 빼고, 저장 후 다시 읽기(업로드 2번)를 없앴다.
- 파일: src/services/dbManager.js, src/hooks/useLedgerSync.js

### B-003 저장 실패를 알 수 없음, 새로고침 시 미저장 변경 유실
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 치명
- 영역: 저장·동기화
- 문제: 저장에 실패해도 "✓ 추가됨" 토스트가 뜬다. 이후 🔄를 누르면 확인 없이 메모리의 변경을 버린다.
- 원인: `setDirty(true)`가 어디에도 없다. saveAndReload가 오류를 삼켜서 호출부가 성공으로 처리한다.
- 해결: 헤더에 '저장 안 됨 N'을 계속 표시하고 실패는 오류 배너로 알린다. 🔄는 미저장 변경을 먼저 저장(필요하면 병합)한 뒤에만 불러오고, 미저장 상태로 페이지를 닫으면 경고한다.
- 파일: src/hooks/useLedgerSync.js, src/components/App/App.js, src/components/Header/Header.js

### B-004 로그아웃 후 이전 DB가 남아 다른 계정 OneDrive에 덮어쓸 수 있음
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 치명
- 영역: 인증
- 문제: 로그아웃한 뒤 다른 계정으로 로그인하면 이전 사용자의 가계부가 보이고, 저장 시 새 계정 OneDrive를 덮어쓴다.
- 원인: logoutPopup 후 db 상태를 비우지 않는다. 자동 로드 조건 `!db` 때문에 다시 불러오지도 않는다.
- 해결: 로그아웃 시 미저장 변경을 먼저 저장(실패하면 확인)하고 메모리 DB·보관 기록을 지운 뒤 logoutRedirect로 떠난다. 계정이 바뀌면 이전 DB를 즉시 버리고, 기기의 AI 키 삭제 여부도 묻는다.
- 파일: src/components/App/App.js, src/components/Header/Header.js, src/hooks/useLedgerSync.js

### B-005 토큰 갱신 실패·네트워크 오류 시 즉시 리다이렉트되어 변경 유실
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 높음
- 영역: 인증
- 문제: 저장 중 토큰 갱신이 실패하거나 일시적 네트워크 오류가 나면 페이지가 로그인으로 이동해 메모리의 변경이 사라진다.
- 원인: acquireTokenSilent의 모든 오류에서 acquireTokenRedirect를 호출하고, 이동 전에 미저장 변경을 보관하지 않는다.
- 해결: InteractionRequiredAuthError일 때만 리다이렉트한다. 미저장 변경 기록은 localStorage에 항상 보관했다가 돌아온 뒤 되살려 저장하고, 이미 반영된 업로드는 동기화 표식(sync_write_id)으로 걸러 중복을 막는다.
- 파일: src/services/oneDriveService.js, src/services/changeLog.js, src/hooks/useLedgerSync.js

### B-006 공휴일 데이터가 2026년뿐
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 높음
- 영역: 공휴일
- 문제: 2027년 일정의 휴일 보정이 전혀 되지 않는다(2027-01-01 신정을 영업일로 처리). 한 번 등록된 날짜는 나중에 고쳐지지도 않는다.
- 원인: HOLIDAYS_BY_YEAR에 2026년만 있고, 데이터가 없는 연도를 경고하지 않는다.
- 해결: 2027년 공휴일(대체공휴일 포함)을 추가했다. 자동등록이 사용자가 고치지 않은 미래 내역의 처리일을 공휴일 데이터에 맞춰 다시 계산하고, 데이터가 없는 연도는 불러올 때 경고한다.
- 파일: src/data/holidays.js, src/services/dbManager.js, src/hooks/useLedgerSync.js

### B-007 휴일 보정으로 다른 달로 넘어가면 실행마다 중복 생성
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 높음
- 영역: 계좌 자동등록
- 문제: 31일+다음 영업일, 1일+이전 영업일 같은 항목이 앱을 열 때마다 1건씩 중복된다. 넘어간 달의 원래 몫은 오히려 누락된다.
- 원인: 이미 등록했는지를 실제 날짜의 월(`strftime('%Y-%m', date)`)로 확인하는데, 휴일 보정으로 실제 날짜가 다른 달이 된다.
- 해결: 자동 생성 내역을 (고정항목, 대상 월 recurring_month)로 식별하고 UNIQUE 인덱스로 막는다. 기존 중복은 로드 시 대상 월을 역산해 하나만 남긴다.
- 파일: src/services/dbManager.js

### B-008 자동생성 내역을 지우거나 날짜를 옮기면 다시 생성됨
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 계좌 자동등록
- 문제: 자동 생성된 계좌 내역을 삭제하면 바로 되살아나고, 날짜를 다른 달로 옮기면 원래 달에 하나가 더 생긴다.
- 원인: 건너뛴 달을 기록하지 않고, 존재 여부를 실제 날짜 기준으로 확인한다.
- 해결: 자동 생성 내역을 지우면 그 달을 account_recurring_skips에 기록해 다시 만들지 않는다. 대상 월 기준이라 날짜를 옮겨도 추가 생성되지 않는다.
- 파일: src/services/dbManager.js

### B-009 고정항목 수정·삭제가 이미 만든 미래 내역에 반영 안 됨
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 계좌 자동등록
- 문제: 고정 입출금 항목의 금액을 바꾸거나 삭제해도, 이미 만들어진 미래 내역은 예전 값 그대로 잔액 예측에 남는다.
- 원인: updateRecurringItem·deleteRecurringItem이 항목 행만 바꾸고 생성된 내역은 건드리지 않는다.
- 해결: 고정항목을 수정하면 고치지 않은 미래 자동 내역을 지우고 새 조건으로 다시 만든다. 삭제할 때도 함께 지운다.
- 파일: src/services/dbManager.js

### B-010 앱을 한 달 넘게 안 열면 그 달 정기지출이 영영 누락
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 정기지출
- 문제: 어떤 달에 앱을 한 번도 열지 않으면, 그때 등록됐어야 할 달(두 달 뒤)의 정기지출이 다시는 등록되지 않는다.
- 원인: runAutoRegister가 "오늘 기준 두 달 뒤" 한 달만 등록하고, 지나간 대상 월을 메우지 않는다.
- 해결: 마지막으로 등록한 달 다음부터 목표 달(두 달 뒤)까지 빠진 달을 모두 채운다(최대 12개월). 처음 등록하는 항목은 지금처럼 목표 달만 등록한다.
- 파일: src/services/dbManager.js

### B-011 날짜 문자열을 UTC로 해석해 음수 시간대에서 하루 밀림
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 공휴일
- 문제: 미국 등 음수 시간대에서 앱을 열면 영업일 계산과 주말 판정이 하루씩 어긋난다.
- 원인: holidays.js가 `new Date('YYYY-MM-DD')`(UTC 자정)로 만든 뒤 로컬 getter로 읽는다.
- 해결: 'YYYY-MM-DD'를 new Date(y, m-1, d)로 로컬 해석하도록 바꿨다(서울·LA 시간대 결과 동일 확인).
- 파일: src/data/holidays.js

### B-012 저장할 때마다 이전 sql.js DB를 해제하지 않아 메모리 누수
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 성능
- 문제: 저장·새로고침할 때마다 DB 사본이 WASM 메모리에 쌓여, 모바일에서 오래 쓰면 느려지거나 멈출 수 있다.
- 원인: 새 DB로 교체할 때 이전 Database의 `close()`를 호출하지 않는다.
- 해결: DB를 교체할 때 옛 DB로 늦게 들어온 쓰기는 새 DB로 넘기고, 30초 뒤 close()로 해제한다. 저장 후 다시 읽기를 없애 사본 생성 자체도 줄였다.
- 파일: src/hooks/useLedgerSync.js, src/services/changeLog.js

### B-013 sql.js WASM을 실행 중 unpkg CDN에서 받음
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 인프라
- 문제: unpkg가 느리거나 막히면 앱이 열리지 않는다. 패키지가 1.12.x 이상으로 올라가면 JS와 WASM 버전이 어긋난다.
- 원인: initSQL의 locateFile이 `unpkg.com/sql.js@1.12.0` 고정 URL을 쓰고, package.json은 `^1.12.0` 범위다.
- 해결: sql.js를 1.12.0으로 고정하고, prestart/prebuild/pretest에서 node_modules의 WASM을 public/에 복사해 같은 출처에서 읽는다.
- 파일: src/services/dbManager.js, scripts/copy-sql-wasm.js(신규), package.json, package-lock.json, .gitignore

### B-014 변경 직후 화면이 저장 왕복이 끝날 때까지 옛 상태
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 화면 갱신
- 문제: 추가·삭제·설정 변경 직후 목록·캘린더·설정이 이전 상태로 보인다. 저장이 실패하면 계속 옛 화면이고, 삭제한 거래를 수정하면 "수정됨"이 뜨지만 아무것도 바뀌지 않는다.
- 원인: 화면의 useMemo가 `[db]`에만 의존하는데, sql.js는 같은 객체를 제자리에서 바꾸므로 참조가 바뀌지 않는다.
- 해결: App이 쓰기마다 올라가는 dataVersion을 모든 화면에 넘기고, 각 화면의 DB 읽기 memo·effect가 이 값으로 다시 계산한다(설정·계좌는 useDbSnapshot 훅).
- 파일: src/hooks/useLedgerSync.js, src/hooks/useDbSnapshot.js(신규), src/components/App/App.js 및 각 화면 컴포넌트

### B-015 마이그레이션 오류를 조용히 무시
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: DB 마이그레이션
- 문제: 테이블 재생성 마이그레이션이 중간에 실패해도 아무도 알 수 없다.
- 원인: 모든 마이그레이션이 `try { } catch (e) {}`로 감싸져 있다.
- 해결: 마이그레이션을 단계별로 실행해 실패를 migrationErrors로 모아 콘솔과 오류 배너에 보여 준다. 실패하면 스키마 버전을 올리지 않아 다음 로드에 다시 시도한다.
- 파일: src/services/dbManager.js, src/hooks/useLedgerSync.js

### B-016 로그인·로그아웃이 팝업 방식, 중복 클릭 시 오류
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 인증
- 문제: 모바일 홈 화면 앱에서 팝업이 막힐 수 있고, 로그인 버튼을 두 번 누르면 알 수 없는 오류가 뜬다.
- 원인: 로그인·로그아웃은 popup, 토큰 재인증은 redirect로 방식이 섞여 있고, 진행 중 상태를 막지 않는다.
- 해결: 로그인을 loginRedirect, 로그아웃을 logoutRedirect로 통일하고, 진행 중에는 로그인 버튼을 막는다.
- 파일: src/components/LoginPage/LoginPage.js, src/components/App/App.js

### B-017 거래 가져오기가 항상 실패, 여행 연결 유실
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 치명
- 영역: 가져오기
- 문제: 엑셀·JSON 가져오기에서 어떤 파일을 골라도 "no such table: trips" 오류가 난다.
- 원인: 매 로드마다 DROP되는 trips 테이블을 조회한다. addTransaction도 trip_id를 저장하지 않아 여행 연결이 버려진다.
- 해결: trips 조회를 없애고 trip_name·trip_schedule을 여행 유형 캘린더 일정에 연결한다. 없으면 '가져오기'를 누를 때 일정을 만들고 거래의 event_id로 저장한다.
- 파일: src/components/ImportModal/ImportModal.js, src/services/importHelpers.js(신규), src/services/dbManager.js

### B-018 즐겨찾기 드래그 정렬이 항상 예외
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 설정
- 문제: 설정에서 즐겨찾기를 드래그해 순서를 바꾸면 아무 일도 일어나지 않고 콘솔에 예외가 난다.
- 원인: reorderFavorite가 moveItemToPosition을 쓰는데, 허용 테이블 목록에 favorite_transactions가 없고 is_hidden 컬럼도 없다.
- 해결: reorderFavorite를 즐겨찾기 전용(0..n 재번호, 트랜잭션)으로 다시 만들고, 화면은 '옮길 항목을 뺀 위치'를 넘기며 목록 끝 드롭과 예외를 처리한다.
- 파일: src/services/dbManager.js, src/components/SettingsView/SettingsView.js

### B-019 카테고리 이름 변경이 정기지출·즐겨찾기·할인규칙·설정에 반영 안 됨
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 높음
- 영역: 설정
- 문제: 카테고리 이름을 바꾸면 정기지출은 옛 이름으로 계속 등록되고, 할인규칙은 조용히 멈추고, 여행 기본 카테고리 설정이 풀린다.
- 원인: rename 함수가 transactions·sub_categories만 갱신하고, 여러 UPDATE를 트랜잭션 없이 실행한다.
- 해결: 이름 변경이 거래·정기지출·즐겨찾기·할인규칙·여행 기본 카테고리·자동 패턴 설정까지 함께 바꾸고, 전체를 withTransaction으로 묶었다.
- 파일: src/services/dbManager.js

### B-020 카테고리 삭제 확인 문구와 실제 동작 불일치
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 설정
- 문제: 확인창은 "연결된 거래 N건의 카테고리가 비워집니다"라고 하지만, 실제로는 거래가 없는 카테고리를 가리킨 채 남는다.
- 원인: delete 함수가 마스터 행만 지우고 거래·정기지출·즐겨찾기·할인규칙은 그대로 둔다.
- 해결: 세부카테고리 삭제는 거래·정기지출·즐겨찾기에서 비우고 전용 할인규칙을 지우며, 확인창에 쓰는 곳별 건수를 보여 준다. 사용 중인 대분류는 삭제를 막고 이름 변경·숨기기를 안내한다.
- 파일: src/services/dbManager.js, src/components/SettingsView/SettingsView.js

### B-021 결제수단을 숨기면 사용 중이어도 삭제될 수 있음
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 설정
- 문제: 거래는 없지만 할인규칙·정기지출·즐겨찾기에서 쓰는 결제수단을 숨기면 삭제되어, 다시 표시할 수 없다.
- 원인: 숨기는 즉시 cleanupHiddenPaymentMethods가 거래 0건인 숨김 결제수단을 지우고, 거래 외 테이블의 사용 여부는 보지 않는다.
- 해결: 숨기기는 숨기기만 하고(cleanupHiddenPaymentMethods 삭제), 휴지통 버튼은 거래·할인규칙·정기지출·즐겨찾기·계좌 고정항목 어디에도 쓰이지 않을 때만 지운다.
- 파일: src/services/dbManager.js, src/components/SettingsView/SettingsView.js

### B-022 잔액 기준일 미사용 → 과거 내역을 불러오면 잔액 이중 계산
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 계좌
- 문제: 오늘 잔액을 입력한 뒤 지난 은행 내역을 불러오면, 과거 거래가 잔액에 한 번 더 더해진다.
- 원인: balance_date를 저장만 하고, 잔액 계산은 오늘까지의 모든 거래를 current_balance에 더한다.
- 해결: current_balance를 '기준일이 시작될 때 잔액'으로 정의하고 기준일(당일 포함)부터 오늘까지의 거래만 더한다. 기준일이 빈 예전 계좌는 전부 더한다. 폼 문구도 '기준 잔액'으로 바꿨다.
- 파일: src/services/dbManager.js, src/components/AccountManagement/AccountManagement.js

### B-023 기본 계좌가 여러 개가 될 수 있음
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 계좌
- 문제: 새 계좌를 기본 계좌로 체크해도 기존 기본 계좌가 그대로 기본으로 쓰인다.
- 원인: addAccount·updateAccount가 is_default=1만 쓰고 다른 계좌를 해제하지 않는다.
- 해결: addAccount·updateAccount가 기본 계좌로 지정하면 나머지 계좌의 기본 표시를 해제하고, getDefaultAccount는 정렬 순서로 고른다.
- 파일: src/services/dbManager.js

### B-024 계좌 내역 불러오기 완료 화면을 ✕로 닫으면 저장 안 됨
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 계좌
- 문제: 계좌 CSV 불러오기 완료 화면에서 ✕로 닫으면 가져온 내역이 OneDrive에 저장되지 않는다.
- 원인: ✕ 버튼이 onClose만 부르고 저장(onChanged)은 부르지 않는다.
- 해결: 완료 화면의 ✕도 '확인'과 같은 처리로 바꿨고, 자동 저장이 bulkInsert를 기록해 닫는 방법과 관계없이 저장된다.
- 파일: src/components/AccountManagement/AccountManagement.js

### B-025 중복 검사 없음, 계좌 CSV 금액 parseInt·음수 출금 오류
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 가져오기
- 문제: 같은 파일을 두 번 올리면 내역이 두 배가 된다. 계좌 CSV의 "1234.5"는 1234가 되고, "-50000" 같은 음수 출금은 오류가 난다.
- 원인: 가져오기 전에 기존 내역과 대조하지 않고, 금액을 parseInt로 읽는다.
- 해결: 두 가져오기 모두 기존 내역과 개수 기준으로 비교해 중복을 표시하고 기본은 제외한다. 계좌 CSV 금액은 parseImportAmount로 읽고 음수는 출금, 출금/입금 분리 양식과 '2026.05.25' 날짜도 받는다.
- 파일: src/services/importHelpers.js, src/components/ImportModal/ImportModal.js, src/components/AccountManagement/AccountManagement.js

### B-026 일정 유형 드래그가 한 칸 더 내려가고, 목록 끝 드롭은 무시
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 설정
- 문제: 일정 유형을 아래로 드래그하면 표시선보다 한 칸 아래에 들어가고, 목록 끝에 놓으면 아무 일도 일어나지 않는다.
- 원인: 원래 자리에서 뺀 뒤 인덱스를 보정하지 않고, 목록 컨테이너에 onDrop이 없다.
- 해결: moveCalendarEventType의 인덱스를 '옮길 항목을 뺀 위치'로 통일하고 범위를 제한했다. 화면은 행의 위·아래 절반으로 판정하고 목록 끝 드롭을 받는다.
- 파일: src/services/dbManager.js, src/components/SettingsView/SettingsView.js

### B-027 정렬 시 숨김·표시 그룹 간 sort_order 겹침
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 설정
- 문제: 숨김을 해제한 뒤 드래그하면 엉뚱한 위치로 갈 수 있고, 화면마다 순서가 다르게 보일 수 있다.
- 원인: moveItemToPosition이 숨김 여부가 같은 그룹만 1..n으로 다시 번호를 매겨 다른 그룹과 값이 겹친다.
- 해결: moveItemToPosition이 범위 전체를 표시→숨김 순서로 1..n 재번호하고, 정렬 기준을 화면과 같은 is_hidden, sort_order, name, id로 맞췄다.
- 파일: src/services/dbManager.js, src/components/SettingsView/SettingsView.js

### B-028 자동 패턴 비율이 항상 100%
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 설정
- 문제: 설정의 자동 결제수단 패턴 비율이 항상 100%로 표시된다.
- 원인: getDetectedPatterns가 total에 해당 결제수단 건수(cnt)를 그대로 넣는다.
- 해결: total을 같은 표본에서 그 세부카테고리의 전체 건수로 계산한다. 이후 B-058에서 실제 자동 선택과 같은 기준으로 다시 맞췄다.
- 파일: src/services/dbManager.js

### B-029 취소해도 자동 추가 카테고리가 남고, 오류 행 번호·날짜 검증이 틀림
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 가져오기
- 문제: 가져오기를 취소해도 '자동 추가'한 카테고리가 남는다. 오류 행 번호가 실제와 다르고, 2026-02-30 같은 날짜가 통과하며, 항목 하나가 객체가 아니면 파일 전체가 거부된다.
- 원인: 확정 전에 DB에 쓰고, 행 번호에서 헤더를 빼고 세고, 날짜는 형식만 검사하고, 필드 타입을 확인하지 않는다.
- 해결: 확정 전에는 DB에 쓰지 않고, '가져오기'를 누를 때 없는 결제수단·카테고리·일정을 거래와 한 트랜잭션으로 추가한다. 행 번호는 실제 스프레드시트 행·JSON _no, 날짜는 달력 기준으로 검사하고, 이상한 항목은 그 행만 오류로 처리한다.
- 파일: src/components/ImportModal/ImportModal.js, src/services/importHelpers.js

### B-030 분할 결제 첫 몫의 할인을 총액 기준으로 계산
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 높음
- 영역: 거래 입력
- 문제: 10만 원 중 3만 원을 1% 카드로 내면 할인이 300원이 아니라 1,000원으로 저장되어 순지출이 적게 잡힌다.
- 원인: 자동할인 effect가 총액(form.amount)으로 계산한 값을 첫 번째 몫에 그대로 붙인다.
- 해결: 분할이면 자동할인을 첫 결제수단 몫(primaryKrw) 기준으로 계산하고, 할인 칸에 '(○○ 몫)'을 표시한다.
- 파일: src/components/TransactionForm/TransactionForm.js

### B-031 거래 수정 시 할인 메모(discount_note) 삭제
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 거래 입력
- 문제: 가져오기·정기지출로 들어온 "카드 청구할인" 같은 메모가 금액만 고쳐도 사라진다.
- 원인: 폼의 저장 데이터에 discount_note가 없어서, updateTransaction이 ''로 덮어쓴다.
- 해결: 폼이 discount_note를 그대로 넘기고, updateTransaction은 메모를 넘기지 않으면 COALESCE로 기존 값을 유지한다.
- 파일: src/components/TransactionForm/TransactionForm.js, src/services/dbManager.js

### B-032 결제수단을 현금으로 바꿔도 이전 카드 자동할인이 남음
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 거래 입력
- 문제: 카드로 자동할인이 계산된 뒤 현금으로 바꾸면, 현금 거래에 할인이 붙어 저장된다.
- 원인: 자동할인 effect가 현금일 때 할인을 비우지 않고 바로 return한다.
- 해결: 결제수단이 현금·빈 값이면 자동 계산된 할인을 비운다. 사용자가 직접 입력한 값은 유지한다.
- 파일: src/components/TransactionForm/TransactionForm.js

### B-033 분할 거래 수정 시 현재 환율로 재계산, 일정을 숨기면 외화가 원화로 해석
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 높음
- 영역: 거래 입력
- 문제: 예전 분할 거래의 세부내역만 고쳐도 원화 몫이 새 환율로 바뀐다. 일정이 숨겨져 있으면 ¥3000이 3,000원으로 저장된다.
- 원인: 분할 통화·환율을 저장된 값이 아니라 현재 일정의 환율과 보이는 일정 목록에서 다시 구한다.
- 해결: 분할 통화를 저장될 foreign_amounts에서 정하고, 수정 시 저장된 환율(원래 원화÷원래 외화)을 우선 쓴다. 통화가 바뀌면 분할 금액을 다시 입력받는다.
- 파일: src/components/TransactionForm/TransactionForm.js

### B-034 두 통화 이상일 때 분할하면 외화 금액이 버려짐
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 거래 입력
- 문제: 두 통화 이상을 입력한 상태로 분할하면 양쪽 모두 외화 금액 없이 저장되어 현금 지갑 잔액이 틀어진다.
- 원인: 통화가 둘 이상이면 splitCurrency가 KRW가 되어 foreign_amounts를 빈 객체로 저장한다.
- 해결: 현지 금액이 두 통화 이상이면 분할을 막고 이유를 표시한다.
- 파일: src/components/TransactionForm/TransactionForm.js

### B-035 환율 없는 통화 칸 입력 시 직접 입력한 원화 금액이 지워짐
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 거래 입력
- 문제: 환율이 있는 통화와 없는 통화가 섞인 여행에서, 원화를 먼저 입력하고 환율 없는 통화 칸에 입력하면 원화 금액이 지워진다.
- 원인: 환율 있는 통화에 입력값이 없으면 계산 결과로 ''를 돌려줘 금액을 덮어쓴다.
- 해결: 환율 없는 통화 칸을 고칠 때는 원화 금액을 다시 계산하지 않는다.
- 파일: src/components/TransactionForm/TransactionForm.js

### B-036 할인 수식 오류 시 조용히 0으로 저장
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 거래 입력
- 문제: 할인 칸에 "1000+"처럼 잘못된 수식을 넣으면 오류 없이 할인 0으로 저장된다.
- 원인: NaN을 `|| 0`으로 바꾸고, 제출 가능 여부 검사에서 할인값을 보지 않는다.
- 해결: 할인·수익 수식이 잘못됐거나 음수면 제출을 막고 사유를 표시하며, 제출 직전에 다시 확인한다.
- 파일: src/components/TransactionForm/TransactionForm.js

### B-037 폼에서 바꾼 즐겨찾기가 저장되지 않음
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 거래 입력
- 문제: 입력 폼에서 즐겨찾기를 추가·수정·삭제해도 OneDrive에 저장되지 않고, 저장 사이클 중이면 사라진다.
- 원인: 폼의 즐겨찾기 변경 후 저장(onChanged)을 호출하지 않는다.
- 해결: 폼의 즐겨찾기 변경은 App 자동 저장이 기록·저장하고, 저장 후 다시 읽기가 없어져 사이클 중 사라지지 않는다. 폼 목록은 dataVersion으로 갱신된다.
- 파일: src/components/TransactionForm/TransactionForm.js, src/hooks/useLedgerSync.js

### B-038 현금 흐름 삭제 시 연결 기록이 남고, 확인 없이 삭제
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 높음
- 영역: 여행 현금
- 문제: 계좌를 지정한 환전을 지우면 계좌 출금 기록이 남아 잔액이 계속 틀린다. 이월을 지우면 상대 일정에 이월분이 남아 현금이 두 번 잡힌다.
- 원인: deleteEventCashFlow가 흐름 행만 지우고, 흐름과 연결 기록 사이에 참조 id가 없다. ✕ 버튼에 확인창도 없다.
- 해결: 흐름에 연결 id(account_tx_id·linked_flow_id·linked_tx_id)를 저장하고, deleteEventCashFlow가 계좌 기록·이월 짝·환차손익 거래를 한 단위로 함께 지운다. ✕에는 삭제 범위를 적은 확인창을 띄운다.
- 파일: src/services/dbManager.js, src/components/TripCash/TripCashModal.js, src/services/changeLog.js

### B-039 재환전 종료 시 원가 기준 불일치로 원치 않는 환차손익, 음수 지갑
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 높음
- 영역: 여행 현금
- 문제: 화면에는 환차손익 체크박스가 없는데 환차손익 거래가 생기고, 잔액이 음수인 지갑을 정리하면 가짜 "환전 차익"이 기록된다.
- 원인: 화면은 평균 환율만으로, DB는 일정 환율로 대체해 원가를 계산한다. recordFx 기본값이 true이고 음수 잔액도 재환전을 허용한다.
- 해결: 화면도 DB와 같은 원가 환율(getWalletRate)을 쓰고, 체크박스가 보일 때만 환차손익을 기록한다. 음수 지갑은 '지갑에서 비우기'만 허용한다.
- 파일: src/components/TripCash/TripCashModal.js, src/services/dbManager.js

### B-040 정산 지출·환차손익 거래가 카테고리 없이 생성되고 이슈로도 안 잡힘
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 여행 현금
- 문제: 실물 정산의 '지출로 기록'과 환차손익 기록이 세부카테고리 없이 거래를 만들고, 이슈 필터에도 나타나지 않는다.
- 원인: 해당 모드에서 카테고리 선택을 강제하지 않고, 검증기가 빈 세부카테고리를 이슈로 보지 않는다.
- 해결: 정산 지출·환차손익 기록 시 카테고리(세부 포함)를 화면·DB 양쪽에서 필수로 하고, 거래 목록 검증기가 빈 분류를 이슈로 표시한다.
- 파일: src/components/TripCash/TripCashModal.js, src/services/dbManager.js, src/services/txValidator.js

### B-041 허용 안 되는 문자를 지우고 계산("3만"→3원)
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 금액 입력
- 문제: "3만"을 입력하면 3원, "1e5"는 15로 계산되고 오류로 표시되지 않는다.
- 원인: evaluateExpression이 허용되지 않은 문자를 거부하지 않고 지운 뒤 계산한다.
- 해결: normalize 후 허용 문자를 검사해 그 밖의 문자는 NaN으로 처리한다. 끝의 '원'은 허용하고 '1,320'·'1,000×3'은 그대로 받는다.
- 파일: src/services/formulaEvaluator.js, src/components/common/AmountInput.js, src/services/__tests__/formulaEvaluator.test.js

### B-042 입력란 사이 포커스 이동 시 하단 여백이 복원 안 됨
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 금액 입력
- 문제: 터치 기기에서 금액 입력란 A에서 B로 포커스를 옮기면, 폼을 닫을 때까지 하단 여백이 크게 남는다.
- 원인: A의 blur 복원이 rAF로 늦게 실행되어, B가 A가 늘려 둔 여백을 원래 값으로 저장한다.
- 해결: 스크롤 컨테이너별로 원래 여백과 사용 중인 입력란 수를 기록하고, 마지막 입력란이 포커스를 놓을 때만 복원한다(실기기 미확인).
- 파일: src/components/common/AmountInput.js

### B-043 숨긴 세부카테고리 거래를 수정하면 세부카테고리가 지워짐
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 거래 입력
- 문제: 숨긴 세부카테고리를 가진 거래를 수정하려고 열면 세부카테고리가 비워져, 다른 값을 고르기 전에는 저장할 수 없다.
- 원인: skipSubResetRef가 마운트 직후 첫 effect 실행에서 소모되어 실제 초기화를 막지 못한다.
- 해결: 초기화 건너뛰기를 카테고리 값으로 비교하고, 숨긴 결제수단·카테고리·세부카테고리를 '(숨김)' 옵션으로 보여 준다.
- 파일: src/components/TransactionForm/TransactionForm.js

### B-044 분할 거래 한쪽만 삭제하면 짝이 고아로 남음
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 거래 목록
- 문제: 분할 거래 하나를 삭제하면 남은 짝이 분할 표시(🔗)를 단 채 남는다.
- 원인: 삭제 시 같은 split_group_id를 가진 거래를 확인하거나 정리하지 않는다.
- 해결: 상세·일괄 삭제가 같은 split_group_id 묶음을 함께 지우고, 확인창에 함께 지워지는 건수·금액을 표시한다(App.handleDelete가 id 배열을 받음).
- 파일: src/components/TransactionList/TransactionList.js, src/components/App/App.js

### B-045 현금 내역 정렬 비교 함수가 일관되지 않음
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 여행 현금
- 문제: 같은 날짜의 흐름 기록끼리 순서가 실행 환경에 따라 달라질 수 있다.
- 원인: getEventCashLedger의 비교 함수가 둘 다 흐름이면 (a,b)와 (b,a) 모두 -1을 돌려준다.
- 해결: 비교 함수를 날짜 → 종류(흐름 먼저) 순으로 바꾸고, 같은 종류끼리는 0을 돌려 id 순서를 유지한다.
- 파일: src/services/dbManager.js

### B-046 키 입력마다 지갑 SQL 재계산, 목록 ref O(n²), console.log 잔존
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 성능
- 문제: 입력 폼에서 키를 누를 때마다 지갑 계산 SQL이 여러 번 돌고, 거래 목록 렌더가 행 수의 제곱에 비례한다.
- 원인: getEventWallets를 렌더마다 호출하고, 행 ref 콜백이 매번 findIndex를 돈다.
- 해결: 폼의 지갑 계산을 useMemo로 묶고, 목록 ref를 날짜별 첫 거래 Set으로 O(n)으로 줄였다. console.log와 중복 계산도 지웠다.
- 파일: src/components/TransactionForm/TransactionForm.js, src/components/TransactionList/TransactionList.js

### B-047 일정별 결제수단 탭이 유형 필터를 무시
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 요약
- 문제: 일정별 요약에서 유형을 '여행'으로 골라도 결제수단 탭은 모든 유형을 합산해, 상단 총액과 표 합계가 다르다.
- 원인: getEventPaymentMethodSummary에 유형 인자가 없고, memo 의존성에도 필터가 없다.
- 해결: getEventPaymentMethodSummary에 유형 인자를 추가하고, 일정을 고르지 않았을 때 유형 필터를 넘기며 memo 의존성에도 넣었다.
- 파일: src/components/SummaryView/SummaryView.js, src/services/dbManager.js

### B-048 대각선 스크롤·바텀시트 안 스와이프에도 달이 바뀜
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 캘린더
- 문제: 세로로 스크롤하다 살짝 옆으로 밀리거나, 열린 바텀시트 안에서 가로로 밀면 뒤의 달력 월이 바뀐다.
- 원인: 스와이프 판정에서 세로 이동량을 보지 않고, 모달 안 터치가 달력까지 전달된다.
- 해결: 스와이프를 달력 격자(.cv-grid)에만 걸고, 세로 이동이 가로의 0.6배를 넘으면 무시하며, touchcancel도 처리한다.
- 파일: src/components/CalendarView/CalendarView.js

### B-049 영수증 분석 취소가 일부 구간에서 무시되고, 취소 시 오류 화면
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: AI 입력
- 문제: 이미지를 준비하는 동안 취소하면 API가 그대로 호출되어 과금되고, 이전 영수증 결과가 다음 거래에 뜬다. 응답을 읽는 중 취소하면 오류 화면이 나온다.
- 원인: 이미지 준비 단계에 AbortController가 없고, aiClient가 AbortError를 parse 오류로 바꾼다.
- 해결: 이미지 준비 전에 AbortController를 만들고 await마다 취소 여부를 확인한다. aiClient는 본문을 읽는 중 취소돼도 AbortError를 던지고, TextPanel도 같은 방식으로 고쳤다.
- 파일: src/components/AIEntry/ReceiptPanel.js, src/components/AIEntry/TextPanel.js, src/services/aiClient.js

### B-050 종료일이 시작일보다 빠른 일정이 저장되어 달력에서 사라짐
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 캘린더
- 문제: 11/20~11/10처럼 저장한 일정이 달력에도 '날짜 미정'에도 보이지 않는다.
- 원인: 일정 저장 시 시작일·종료일 순서를 검증하지 않는다.
- 해결: 저장 시 '종료일 < 시작일'과 '종료일만 있음'을 막는다(폼과 dbManager 양쪽). 이미 뒤바뀌어 저장된 일정은 조회와 막대 표시에서 앞뒤를 맞춰 보이게 한다.
- 파일: src/components/CalendarView/CalendarView.js, src/services/dbManager.js

### B-051 막대 그래프가 할인 전 금액 사용, 음수면 100%로 그려짐
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 요약
- 문제: 카테고리 막대 길이가 표의 순액과 다르고, 환불로 합계가 음수가 되면 막대가 가득 찬다.
- 원인: 막대에 할인 전 total을 쓰고, 음수 너비를 막지 않는다.
- 해결: 막대를 순액(total−discount)으로 그리고, 0 이하는 0%, 최대는 100%로 제한한다.
- 파일: src/components/SummaryView/SummaryView.js

### B-052 연결 확인 중 공급자를 바꾸면 이전 공급자 모델 목록이 섞임
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: AI 설정
- 문제: 연결 확인이 끝나기 전에 공급자를 바꾸면 이전 공급자의 모델 목록이 표시되어, 잘못된 모델이 저장되고 404가 난다.
- 원인: 비동기 응답이 현재 공급자와 같은지 확인하지 않는다.
- 해결: 연결 확인을 AbortController로 관리해 공급자 전환·키 수정·언마운트 때 취소하고, 결과는 요청한 공급자에만 반영한다.
- 파일: src/components/AIEntry/AISettingsForm.js

### B-053 일정 삭제 시 현금 흐름이 고아로 남고, 연결 거래 해제 안내 없음
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 캘린더
- 문제: 일정을 삭제하면 그 일정의 환전·정산 기록이 남고, 연결된 거래의 일정 연결이 말없이 풀린다.
- 원인: deleteCalendarEvent가 event_cash_flows를 지우지 않고, 확인 문구에 영향 범위가 없다.
- 해결: deleteCalendarEvent를 트랜잭션으로 감싸 현금 흐름도 함께 지운다. 확인창에는 연결 해제될 거래 수와 삭제될 기록 수를 실제 동작대로 보여 준다.
- 파일: src/services/dbManager.js, src/components/CalendarView/CalendarView.js

### B-054 카테고리 색 정의가 두 곳이라 화면마다 색이 다름
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 화면
- 문제: 사용자가 추가한 카테고리가 요약 화면과 캘린더에서 서로 다른 색으로 보인다.
- 원인: CATEGORY_COLORS와 대체 색 규칙이 SummaryView와 CalendarView에 따로 있다.
- 해결: 공통 파일 common/categoryColor.js(categoryColor, categoryColorAlpha)로 요약·캘린더의 색 규칙을 통일했다.
- 파일: src/components/common/categoryColor.js(신규), src/components/SummaryView/SummaryView.js, src/components/CalendarView/CalendarView.js

### B-055 이번 달 거래가 없으면 월 선택이 빈칸
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 요약
- 문제: 이번 달(또는 올해)에 거래가 아직 없으면 요약의 월·연 선택이 빈칸으로 보인다.
- 원인: 선택값이 옵션 목록(거래가 있는 달)에 없는 경우를 처리하지 않는다.
- 해결: 월·연 선택 목록에 이번 달·올해와 현재 선택값을 항상 포함한다.
- 파일: src/components/SummaryView/SummaryView.js

### B-056 가맹점 매칭이 빈도 우선이라 짧은 일반 이름이 구체적 이름을 이김
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: AI 입력
- 문제: "이마트 성수점" 영수증이 자주 쓴 "마트"로 매칭되고, 정확히 맞는 "이마트"는 밀린다.
- 원인: matchHistory 점수가 `횟수×100 + 길이`라 빈도가 구체성을 압도한다.
- 해결: matchHistory 점수를 '정확히 일치 > 겹치는 글자 수 > 횟수' 순으로 바꿨다. 반환 형태는 그대로다.
- 파일: src/services/receiptAssistant.js

### B-057 사용자 카테고리 배지 배경이 보이지 않음
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 거래 목록
- 문제: 사용자가 추가한 카테고리의 배지 배경이 거래 목록에서 보이지 않는다.
- 원인: hsl(...) 색에 hex 알파('33')를 문자열로 붙여 CSS가 무효가 되고, TransactionList에 색 함수 복사본이 따로 있었다.
- 해결: 복사본을 지우고 common/categoryColor를 쓰며, 배경은 categoryColorAlpha(cat, 0.2)로 만든다.
- 파일: src/components/TransactionList/TransactionList.js

### B-058 자동 결제수단 패턴을 꺼도 계속 적용되고, 설정 목록과 실제 기준이 다름
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 중간
- 영역: 거래 입력
- 문제: 설정에서 자동 결제수단 패턴을 꺼도 세부카테고리를 고르면 결제수단이 자동으로 채워지고, 목록에 보이는 패턴이 실제로는 작동하지 않기도 한다.
- 원인: getAutoPaymentMethod가 auto_pattern_settings.is_disabled를 보지 않고, 목록(최근 100건 중 10건)과 실제 선택(최근 20건 중 10건·80%)의 기준이 달랐다.
- 해결: 두 함수가 같은 기준 함수(autoPaymentStats)를 쓰게 하고, 자동 선택은 꺼진 패턴을 무시한다.
- 파일: src/services/dbManager.js

### B-059 계좌 일괄 삽입을 다른 트랜잭션 안에서 부르면 실패
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 계좌
- 문제: 계좌 내역 가져오기를 다른 트랜잭션 안에서 실행하면 "cannot start a transaction within a transaction" 오류가 난다.
- 원인: bulkInsertAccountTransactions가 BEGIN/COMMIT을 직접 쓴다.
- 해결: withTransaction(SAVEPOINT)으로 바꿨다.
- 파일: src/services/dbManager.js

### B-060 일정을 지운 뒤 그 거래를 수정하면 외화 금액이 빠짐
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 캘린더
- 문제: 여행 일정을 지우면 연결 거래는 외화 금액(foreign_amounts)을 가진 채 일정 연결만 풀린다. 이 거래를 수정해 저장하면 외화 금액이 사라진다.
- 원인: 폼이 외화 칸을 일정의 통화 목록으로 만드는데, 일정이 없으면 보여 줄 통화가 없다.
- 해결: 일정이 지워졌거나 숨겨졌거나 그 통화가 없으면 저장된 통화마다 '저장된 현지 금액' 칸을 보여 주고 값을 유지한다(원화는 다시 계산하지 않음). 칸을 비우면 그 외화를 지우고, 분할·수정 불러오기도 일정 없이 외화를 유지한다.
- 파일: src/components/TransactionForm/TransactionForm.js

### B-061 여행 기본 카테고리를 '사용 안 함'으로 골라도 다시 선택됨
- 상태: ✅ 해결 (2026-11-07)
- 심각도: 낮음
- 영역: 설정
- 문제: 여행 기본 카테고리를 '사용 안 함'으로 저장해도 다음에 '여행' 카테고리가 다시 선택된다.
- 원인: 빈 값 저장을 '설정 안 함'으로 보고 자동 추론했다.
- 해결: getTripDefaultCategory가 설정 행이 없을 때만 추론하고, 대분류를 삭제하면 이 설정을 ''(사용 안 함)으로 바꾼다.
- 파일: src/services/dbManager.js

### I-001 자동 테스트 0개 → dbManager 핵심 로직 테스트 추가
- 상태: ✅ 해결 (2026-11-07)
- 영역: 테스트
- 문제: 금액·자동등록·마이그레이션 같은 핵심 로직에 테스트가 없어, 이번 버그들이 그대로 배포됐다.
- 원인: CRA 기본 테스트 설정만 있고 테스트 파일이 없다.
- 해결: src/services/__tests__에 dbManager·changeLog 테스트 16개를 추가했다(마이그레이션, 자동등록 멱등·건너뜀·빈 달 채우기, 병합·id 보정, 롤백 제외).
- 파일: src/services/__tests__/dbManager.test.js, src/services/__tests__/changeLog.test.js

### I-002 죽은 코드 정리
- 상태: ✅ 해결 (2026-11-07)
- 영역: 정리
- 문제: 쓰이지 않거나 이미 사라진 테이블을 참조하는 코드가 남아 혼란을 준다.
- 원인: trips → calendar_events 이전 후 trips 함수·스키마, holidays 테이블, getTrip*Summary, set/getCategoryColor, 미사용 공휴일 함수를 지우지 않았다.
- 해결: trips 함수 15개·ensureTripsExist·set/getCategoryColor·cleanupHiddenPaymentMethods·미사용 tx count 함수·미사용 공휴일 함수를 지우고, SCHEMA의 trips·holidays를 뺐다. pattern_suggestion_log 함수 3개는 기능 계획 확인 전이라 남겼다.
- 파일: src/services/dbManager.js, src/data/holidays.js

### I-003 요약 SQL 함수 9개 복붙 → 공통 함수
- 상태: ✅ 해결 (2026-11-07)
- 영역: 구조
- 문제: 월·연·기간 × 카테고리·세부·결제수단 요약이 거의 같은 함수 9개로 복사되어, 한 곳을 고치면 나머지를 빠뜨리기 쉽다.
- 원인: 기간 조건만 다른 쿼리를 함수마다 따로 작성했다.
- 해결: summaryPeriod + summarizeTransactions 공통 함수로 합치고, 9개 export는 이름과 반환 형태를 유지한 래퍼로 남겼다. 이전과 119개 경우 결과가 같음을 확인했다.
- 파일: src/services/dbManager.js

### I-004 SettingsView·TransactionForm·dbManager 파일 분리
- 상태: ✅ 해결 (2026-11-07)
- 영역: 구조
- 문제: SettingsView 1,573줄(useState 40여 개), TransactionForm 855줄, dbManager 2,724줄로 수정 범위를 파악하기 어렵다.
- 원인: 기능이 늘면서 한 파일에 계속 추가했다.
- 해결: dbManager.js(2,865줄)는 기능별 모듈 src/services/db/*.js 14개로 나누고 재내보내기만 남겼다(export 136개 동일, 순환 import 없음). SettingsView(1,658→124줄)는 섹션 8개와 공용 파일로, TransactionForm(1,002→447줄)은 기본 칸·즐겨찾기·분할·여행 금액·자동할인 컴포넌트와 훅으로 나눴다. 분리 전후로 SettingsView 110단계 DOM·DB 비교와 TransactionForm 렌더링 테스트 16개가 일치했다. 남은 차이는 하나다: 설정에서 다른 섹션에 갔다 오면 입력 중이던 내용이 초기화된다.
- 파일: src/services/dbManager.js, src/services/db/*.js(신규), src/components/SettingsView/**, src/components/TransactionForm/**(테스트 3개 포함)

### I-005 CSV 파서 중복, 따옴표 안 줄바꿈 미지원
- 상태: ✅ 해결 (2026-11-07)
- 영역: 구조
- 문제: 같은 parseCSVLine이 두 파일에 있고, 따옴표 안 줄바꿈이 있는 CSV를 잘못 읽는다.
- 원인: ImportModal과 AccountManagement에 같은 코드를 복사했다.
- 해결: src/services/csv.js(parseCSVRecords·parseCSV)로 모았다. 따옴표 안 쉼표·줄바꿈, "" 이스케이프, BOM, CRLF를 지원하고 행 번호를 준다.
- 파일: src/services/csv.js(신규), src/components/ImportModal/ImportModal.js, src/components/AccountManagement/AccountManagement.js

### I-006 로컬 날짜 포맷 함수 5벌 이상 중복
- 상태: ✅ 해결 (2026-11-07)
- 영역: 구조
- 문제: 'YYYY-MM-DD' 로컬 날짜를 만드는 코드가 여러 파일에 따로 있어, 실수로 toISOString을 쓰기 쉽다.
- 원인: 공통 날짜 유틸이 없다.
- 해결: src/services/dateUtils.js(toDateStr·toYearMonth·ymd·parseDateStr·todayStr·addMonths·addDays·isValidDateStr)로 모으고 9개 파일의 복사본을 지웠다. 기존 export 이름(today, isValidDate, addDays)은 유지하고, 다른 시간대(UTC-8·UTC+14)에서도 같은 결과임을 테스트로 확인했다.
- 파일: src/services/dateUtils.js(신규), src/services/__tests__/dateUtils.test.js(신규), dbManager.js, holidays.js, formulaEvaluator.js, importHelpers.js, receiptAssistant.js, AccountManagement·CalendarView·CalendarMini·SummaryView·TransactionList

### I-007 README가 CRA 기본 문서, 0바이트 sqlite 파일이 커밋됨
- 상태: ✅ 해결 (2026-11-07)
- 영역: 정리
- 문제: README가 앱 설명 없이 CRA 안내문이고, 빈 financial-ledger.sqlite가 저장소에 있다.
- 원인: 프로젝트 생성 시 기본 파일을 그대로 두었다.
- 해결: README를 앱 설명과 문서 안내로 다시 쓰고, 빈 financial-ledger.sqlite를 지웠다. SETUP.md의 구조 설명도 새 저장 방식에 맞췄다.
- 파일: README.md, SETUP.md, financial-ledger.sqlite(삭제)

### I-008 CRA(react-scripts 5) 지원 종료 → Vite 이전
- 상태: ✅ 해결 (2026-11-07)
- 영역: 인프라
- 문제: CRA는 더 이상 관리되지 않아 의존성 보안 경고와 빌드 도구 노후화가 쌓인다.
- 원인: 프로젝트가 react-scripts 5 기반이다.
- 해결: react-scripts·react-app-rewired를 Vite 6 + Vitest 3으로 바꿨다. JSX가 든 .js를 설정으로 처리해 파일 이름은 그대로 두고, 3000번 포트·build 출력 폴더·vercel.json으로 로그인·배포 설정을 유지했다. process.env를 import.meta.env로 바꾸고 테스트 50개를 Vitest로 옮겼다. 운영 의존성 취약점은 0건이다.
- 파일: vite.config.mjs(신규), index.html(public→루트), vercel.json(신규), package.json, package-lock.json, src/services/db/schema.js, 테스트 7개, config-overrides.js(삭제), AGENTS.md, README.md

### I-009 스키마 버전 관리 없음
- 상태: ✅ 해결 (2026-11-07)
- 영역: DB
- 문제: 어떤 마이그레이션이 적용됐는지 알 수 없어, 매 로드마다 모든 ALTER를 시도하고 실패를 무시한다.
- 원인: PRAGMA user_version 같은 버전 기록이 없다.
- 해결: PRAGMA user_version으로 스키마 버전(SCHEMA_VERSION)을 기록하고, 앱보다 새 버전 DB면 새로고침을 안내한다.
- 파일: src/services/dbManager.js, src/hooks/useLedgerSync.js

### I-010 dataVersion 반영 방식이 두 가지
- 상태: ✅ 해결 (2026-11-07)
- 영역: 구조
- 문제: 화면 갱신(B-014)을 반영하는 방식이 두 가지로 섞여 있다.
  - 요약·캘린더·거래 화면: `[db, dataVersion]` 의존성 + eslint-disable 주석
  - 설정·계좌 화면: useDbSnapshot 훅
- 원인: 세 에이전트가 동시에 고치면서 방식이 갈렸다.
- 해결: 요약·캘린더·거래 목록·입력 폼·여행 현금 화면을 useDbSnapshot(live)으로 바꾸고 dataVersion 관련 eslint-disable을 모두 지웠다. TripCashModal의 자체 version 카운터도 필요 없어져 지웠다. 다른 세션 소유인 CardStatementModal은 자체 카운터로 정상 동작해 그대로 두었다.
- 파일: src/components/SummaryView/SummaryView.js, CalendarView.js, TransactionList.js, TransactionForm.js, TripCash/TripCashModal.js
