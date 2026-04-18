# 캘린더 & 이벤트 시스템 설계서

> 작성일: 2026-04-12
> 상태: 검토 완료 → 구현 대기

---

## 배경 및 목표

현재 앱은 거래내역·요약·설정 3개 탭으로 구성되어 있고, 여행 기능이 설정 내부에 묶여 있음.  
목표는 **캘린더 탭**을 신설해 여행·기념일·일반 일정을 공유캘린더 느낌으로 관리하고,  
기존 여행 데이터(외화 포함)를 새 일정 시스템으로 완전 통합하는 것.

---

## 1. 하단 네비게이션 개편

### 현재
```
거래내역 | 요약 | [+] | 가져오기 | 설정
```

### 변경
```
거래내역 | 요약 | [+] | 캘린더 | 설정
```

- `가져오기`는 설정 내 "데이터 관리" 섹션으로 이관
- 가운데 `[+]` FAB은 **방안 A: 컨텍스트 감지** 방식으로 개편

---

## 2. + 버튼 UX: 방안 A (컨텍스트 감지 FAB) — 확정

| 활성 탭 | + 아이콘 | + 동작 |
|---|---|---|
| 거래내역 | `+` (파란색, 현재와 동일) | 거래 추가 모달 |
| 요약 | `+` (파란색) | 거래 추가 모달 |
| **캘린더** | `📅` (보라/초록 계열) | 일정 추가 모달 |
| 설정 | `+` (파란색) | 거래 추가 모달 |

구현: App.js에서 `activeTab === 'calendar'` 여부로 FAB 아이콘·색·onClick 분기.  
아이콘만 바뀌고 위치는 그대로이므로 기존 CSS 최소 수정.

---

## 3. DB 스키마 변경 — 전체 구조

### 3-1. 신규 테이블: `calendar_events`

```sql
CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  date_from TEXT NOT NULL,          -- YYYY-MM-DD (시작일, 필수)
  date_to TEXT DEFAULT '',          -- YYYY-MM-DD (종료일, 빈값=단일 날짜)
  event_type TEXT DEFAULT 'general',-- 'trip' | 'occasion' | 'general'
  color TEXT DEFAULT '',            -- 헥스 색상 (예: '#F0A500')
  note TEXT DEFAULT '',             -- 메모
  is_hidden INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
)
```

> ⚠️ 기존 `trips.trip_id` FK 제거 — 외화 정보를 `event_countries`로 완전 이관.

### 3-2. 신규 테이블: `event_countries`

```sql
CREATE TABLE IF NOT EXISTS event_countries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,        -- calendar_events.id FK
  country TEXT NOT NULL,
  currency TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
)
```

기존 `trip_countries` 역할을 완전 대체.  
마이그레이션 완료 후 `trips` / `trip_countries` 테이블 **DROP** (row count 검증 후).

### 3-3. `transactions` 테이블 컬럼 추가

```sql
ALTER TABLE transactions ADD COLUMN event_id INTEGER DEFAULT NULL
-- 기존 trip_id 컬럼은 유지 (레거시, 하위 호환)
```

신규 거래는 `event_id`만 사용.  
기존 `trip_id` 있는 거래는 마이그레이션 후 `event_id`도 채워짐.

---

## 4. 여행 데이터 마이그레이션

`createDatabase` 내 마이그레이션 블록에서 **자동 실행** (didMigrate = true).

### 마이그레이션 순서

```
① calendar_events, event_countries 테이블 생성 (IF NOT EXISTS)
② transactions.event_id 컬럼 추가
③ calendar_events에 중복 마이그레이션 방지용 컬럼 추가
     → migrated_from_trip_id INTEGER DEFAULT NULL
④ trips 테이블 순회
   → calendar_events INSERT (event_type='trip')
   → trip_countries 순회 → event_countries INSERT
⑤ transactions 테이블: trip_id → event_id 매핑
⑥ trips, trip_countries 테이블 DROP
     → 마이그레이션 row count 검증 후 실행
     → event_countries row 수 = trip_countries row 수인지 확인
```

### schedule 텍스트 처리 원칙

**자동 날짜 파싱 없음** — date_from / date_to는 마이그레이션 시 채우지 않음.

| schedule 값 | date_from | date_to | note |
|---|---|---|---|
| `"2024.1.15~1.20"` | (빈값) | (빈값) | `"2024.1.15~1.20"` |
| `"오사카 2박3일"` | (빈값) | (빈값) | `"오사카 2박3일"` |
| `""` (비어있음) | (빈값) | (빈값) | (빈값) |

모든 schedule 텍스트는 `note`에 그대로 복사 → 데이터 손실 없음.  
`date_from`이 비어있는 이벤트는 캘린더 그리드에 표시되지 않고,  
캘린더 하단 **"날짜 미정"** 섹션에 리스트 형태로 별도 표시.  
편집 화면에서 note를 보며 날짜를 직접 입력하는 방식으로 처리.

---

## 5. 캘린더 탭 기능 정의

### 5-1. 화면 구성

```
┌───────────────────────────────────��─┐
│   <      2026년 4월 ▾      >        │  ← 월 이동 + 헤더 탭
│   일  월  화  수  목  금  토         │
│    ·  · ─────여행──────  ·          │  ← 이벤트 기간바
│        ·  ·  ●  ●  ·  ·  ·         │  ← 거래 히트맵 도트
│   ...                                │
├────────────────────��────────────────┤
│  날짜 미정                            │  ← date_from 없는 이벤트
│   🟠 하와이 여행                      │
└─────────────────────────────────────┘
```

#### 월/연 이동 네비게이션 — 확정

```
<      2026년 4월 ▾      >
```

| 인터랙션 | 동작 |
|---|---|
| `<` / `>` 버튼 | 이전/다음 달 |
| `2026년 4월 ▾` 텍스트 탭 | 연·월 인라인 피커 토글 |

**`《》` 연도 버튼 미채택 이유**: 모바일 터치 환경에서 `<`와 `《`이 인접하면 오탭 가능성 있음.  
대신 헤더 텍스트 탭으로 연도+월을 한 번에 선택하는 방식이 더 안전하고 모든 캘린더 앱(Google, Apple)의 표준 패턴임.

**연·월 피커 동작**:
- 헤더 탭 시 캘린더 그리드 자리에 피커 인라인 표시 (모달 없음)
- 연도: 현재 연도 기준 ±5년 세로 목록 (스크롤)
- 월: 1~12월 3×4 그리드
- 선택 즉시 피커 닫히고 해당 월로 이동

#### 날짜 클릭 → 인라인 바텀 시트

날짜 탭 시 화면 하단에서 슬라이드업:

```
┌───────────────────���─────────────┐
│  4월 15일 (화)              [✕] │
├───────────────��─────────────────┤
│  이벤트                          │
│   🟠 오사카 여행 (4/13~4/19)    │
├─────────────────────────────────┤
│  거래 3건 · 57,000원             │
│   식비 · 김밥천국        12,000  │
│   쇼핑 · 돈키호테        45,000  │
│   ...                            │
├─────────────────────────────────┤
│  [+ 거래 추가]                   │
└─────────────────────────────────┘
```

- 거래 없는 날짜 탭 시: 이벤트 정보만 표시 (거래 없음 안내 + 추가 버튼)
- 이벤트 없고 거래도 없는 날: 탭해도 반응 없음 (또는 거래 추가만)
- 이벤트 바 직접 탭: 동일 바텀 시트지만 이벤트 편집 버튼 강조

#### 기타 동작
- 이벤트는 기간에 따라 가로 색상 바로 표시
- 거래가 있는 날짜는 히트맵 도트 (지출 규모에 따라 진하기)
- 이벤트 바 클릭 → 이벤트 상세/편집

### 5-2. 일정 추가/편집 모달 필드

| 필드 | 타입 | 비고 |
|---|---|---|
| 제목 | text | 필수 |
| 날짜 (시작) | date | 선택 (빈값 = 날짜 미정) |
| 날짜 (종료) | date | 선택, 빈값이면 하루 일정 |
| 유형 | select | 아래 5종 |
| 색상 | color picker | 기본값은 유형별 색상 |
| 나라/화폐 | 다중 추가 | event_type=trip일 때만 노출 |
| 메모 | textarea | 마이그레이션된 경우 원본 schedule 텍스트 표시됨 |

### 5-3. 이벤트 유형 (event_type) — 확정 5종

| 유형값 | 한국어 라벨 | 설명 | 기본 색상 | 외화 필드 |
|---|---|---|---|---|
| `trip` | 여행 | 국내외 여행, 외화 지출 동반 가능 | `#F0A500` 주황 | ✓ |
| `occasion` | 경조사 | 결혼식·장례식·돌잔치·생일파티, 축의금·부의금 | `#EC4899` 핑크 | - |
| `holiday` | 명절 | 추석·설날 등 가족 지출 집중 시기 | `#10B981` 초록 | - |
| `medical` | 의료 | 수술·입원 등 큰 의료비 이벤트 | `#3B82F6` 파랑 | - |
| `general` | 기타 | 그 외 모든 일정 | `#6366F1` 인디고 | - |

**세분화 이유**:
- `occasion` / `holiday` 분리: 명절은 반복 계획 가능, 경조사는 일회성 → 요약 필터 시 유의미하게 다름
- `medical` 별도: 의료비는 가계부에서 규모가 크고 단기 집중 특성이 있어 이벤트 단위 추적 필요
- 향후 확장 여지: `education`(입학/졸업), `moving`(이사) 등은 현재 general로 흡수, 수요 확인 후 추가

---

## 6. 거래 추가 폼 — 일정 연결

### 변경 내용

기존 `여행` 드롭다운(trip_id) → **일정 선택** 드롭다운(event_id)으로 교체.

```
[ 일정 ]  없음 ▼
           🟠 오사카 여행 (4/1~4/7)   ← event_type=trip
           🟠 하와이 신혼여행
           🩷 친구 결혼식 (5/10)       ← event_type=occasion
           🔵 메모 이벤트              ← event_type=general
           + 새 일정 만들기
```

- 여행 유형 일정 선택 시 → 외화 입력 필드 활성화 (해당 event의 currencies 기반)
- 저장 시: `event_id` 설정, 레거시 호환을 위해 trip_id는 null로 초기화 (신규 거래)
- 기존 거래 수정 시: trip_id가 있으면 해당 event_id로 자동 매핑하여 표시

---

## 7. 요약 탭 변경 사항

### 현재 구조 (실제)

요약 탭은 `카테고리` / `결제수단` 두 탭 각각에 **filterType 서브필터**가 있음:
```
[월별] [연간] [기간] [여행별]  ← filterType 버튼
```

`여행별` filterType 선택 시:
- `getTrips(db)` → 여행 선택 드롭다운
- `getTripSummary(db)` → 여행별 집계
- `getTripDetailSummary(db, tripId)` → 카테고리 breakdown
- `getTripPaymentMethodSummary(db, tripId)` → 결제수단 breakdown
- 외화 합산 (`foreignTotals`) 표시

### 변경 내용

#### filterType 버튼
```
[월별] [연간] [기간] [여행별]
              ↓
[월별] [연간] [기간] [일정별]
```

#### 일정별 filterType 동작

```
일정별 선택
│
├── 유형 필터 칩: [전체] [여행] [기념일] [기타]
│
├── 이벤트 선택 드롭다운 (전체 / 개별 이벤트)
│
└── 집계 결과
    ├── 카테고리 탭: 카테고리별 breakdown (기존 여행 상세와 동일)
    ├── 결제수단 탭: 결제수단별 breakdown
    └── 외화 합산 표시 (event_countries 기반)
```

#### 영향받는 DB 함수 (기존 → 신규)

| 기존 함수 | 신규 함수 | 변경 내용 |
|---|---|---|
| `getTrips(db)` | `getCalendarEvents(db)` | trips → calendar_events |
| `getTripSummary(db)` | `getEventSummary(db, eventType?)` | trip_id → event_id, 유형 필터 추가 |
| `getTripDetailSummary(db, tripId)` | `getEventDetailSummary(db, eventId)` | event_id 기반 |
| `getTripPaymentMethodSummary(db, tripId)` | `getEventPaymentMethodSummary(db, eventId?)` | event_id 기반 |

기존 함수는 삭제하고 신규 함수로 교체. `foreignTotals` 집계 로직은 `event_countries` 기반으로 동일하게 재구현.

#### SummaryView.js 내 state 변경

| 기존 | 신규 |
|---|---|
| `filterType === 'trip'` | `filterType === 'event'` |
| `selectedTripId` state | `selectedEventId` state |
| `trips` useMemo | `calendarEvents` useMemo |
| `tripSummary`, `tripDetailSummary` | `eventSummary`, `eventDetailSummary` |

---

## 8. CalendarMini 표시 설정

기존 `show_goal_display_pc` / `show_goal_display_mobile` 패턴을 동일하게 적용.  
설정 탭 예산 섹션의 **"표시 설정"** 블록에 항목 추가.

### 8-1. 신규 settings 키

| 키 | 기본값 | 설명 |
|---|---|---|
| `show_calendar_btn_pc` | `'1'` | PC에서 거래내역 📅 달력 버튼 표시 여부 |
| `show_calendar_btn_mobile` | `'1'` | 모바일에서 달력 버튼 표시 여부 |
| `calendar_mini_amount_unit` | `'만'` | 달력 금액 표시 단위 |

### 8-2. 금액 단위 옵션 (`calendar_mini_amount_unit`)

| 값 | 표시 예 | 설명 |
|---|---|---|
| `'만'` (기본) | `5만`, `10만`, `1.2억` | 한국 원화 기준 자연스러운 단위 |
| `'k'` | `50k`, `100k`, `1000k` | 천 단위, 글로벌 표기 선호 시 |
| `'hidden'` | (숨김) | 히트맵 도트만 표시, 금액 텍스트 없음 |

**기본 통화 설정과 연동하지 않는 이유**: 앱이 KRW 단일 기반 설계이므로 기본 통화 개념을 도입하면 요약·목표·정기지출 등 전체에 영향을 줌. 달력 표시 단위만을 위한 전역 리팩토링은 비용 대비 효과 낮음. 단순 3-way 옵션으로 충분.

### 8-3. 금액 포맷 로직

```
만 단위:
  ≥ 1억(100,000,000)  →  "X억" (소수점 1자리, 예: 1.2억)
  ≥ 1만(10,000)       →  "X만" (소수점 1자리, 예: 1.2만, 정수면 "5만")
  < 1만               →  실제 금액 그대로 (예: 9,500)

k 단위:
  ≥ 1,000             →  "Xk" (반올림, 예: 50k, 1000k)
  < 1,000             →  실제 금액 그대로

hidden:
  텍스트 없음, 히트맵 도트(배경색)만 표시
```

### 8-4. 표시 설정 UI (설정 > 예산 탭)

기존 "목표금액 표시" 블록 아래에 추가:

```
달력 버튼 표시   [PC ●] [모바일 ●]
달력 금액 단위   [만원] [k] [숨김]   ← 라디오/칩 형태
```

---

## 9. 설정 UI 개편 (별도 문서로 분리 예정)

설정 탭 현황: 결제수단 | 카테고리 | 여행 | 예산 | 정기지출 (가로 탭 5개)  
방향: iOS Settings 스타일 목록 내비게이션으로 교체 + 가져오기 편입

> 상세 설계는 `settings-redesign.md`에 별도 작성.

---

## 10. 구현 작업 목록 (순서)

| # | 작업 | 파일 | 우선순위 |
|---|---|---|---|
| 1 | `calendar_events`, `event_countries` 테이블 스키마 추가 | dbManager.js | 최우선 |
| 2 | `transactions.event_id` 컬럼 추가 | dbManager.js | 최우선 |
| 3 | 여행 데이터 자동 마이그레이션 (trips→calendar_events, trip_countries→event_countries, DROP) | dbManager.js | 최우선 |
| 4 | calendar_events CRUD 함수 | dbManager.js | 1순위 |
| 5 | CalendarView 컴포넌트 신설 (월 네비, 이벤트 기간바, 히트맵, 바텀시트) | CalendarView/ | 1순위 |
| 6 | 하단 네비 가져오기→캘린더 교체 | App.js | 1순위 |
| 7 | + FAB 컨텍스트 감지 (캘린더 탭일 때 📅 아이콘) | App.js | 1순위 |
| 8 | CalendarMini k→만 단위 변경 + 금액 단위 설정 읽기 | CalendarMini.js | 1순위 |
| 9 | 표시 설정 항목 추가 (달력 버튼, 금액 단위) | SettingsView.js | 1순위 |
| 10 | 거래 추가 폼 일정 셀렉터 교체 (trip_id → event_id) | TransactionForm.js | 2순위 |
| 11 | 요약 탭 filterType `trip`→`event` 교체 + 신규 DB 함수 연결 | SummaryView.js + dbManager.js | 2순위 |
| 12 | 설정 여행 탭 제거 | SettingsView.js | 2순위 |
| 13 | 가져오기 설정 내 이관 | App.js + SettingsView.js | 3순위 |
| 14 | 설정 UI iOS 스타일 개편 | SettingsView.js | 3순위 |

---

## 11. 확정 사항 (미결 → 완료)

- [x] **CalendarMini (거래내역 탭 월별 히트맵)**: 유지. 단, 초기 상태는 항상 꺼짐 — 📅 버튼을 한 번 눌러야 열림. `calendarOpenMonths` 초기값을 빈 Set으로 변경 필요.
- [x] **여행 설정 탭**: 캘린더 탭으로 기능 이관 후 설정에서 제거. `trips`/`trip_countries` 테이블은 마이그레이션 row count 검증 후 DROP.
- [x] **event_type**: 5종으로 확정 — trip / occasion / holiday / medical / general (섹션 5-3 참조)
- [x] **캘린더 뷰 날짜 클릭**: 인라인 바텀 시트로 확정 (거래내역 탭 이동 없음)
- [x] **CalendarMini 날짜 클릭**: 거래내역 리스트 내 해당 날짜 포커싱만 (기존 구현 유지, 탭 이동 없음)
- [x] **연도 이동**: `《》` 버튼 없이 헤더 텍스트 탭 → 연·월 인라인 피커 방식으로 확정
- [x] **CalendarMini 금액 단위**: 기본 `만` 단위로 변경. 설정에서 `만` / `k` / `숨김` 3-way 선택 가능. 기본 통화 설정 연동 방식은 앱 범위 초과로 미채택.

---

> 다음 문서: [settings-redesign.md](./settings-redesign.md)
