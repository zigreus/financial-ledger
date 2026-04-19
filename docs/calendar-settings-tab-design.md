# 캘린더 설정 탭 — 설계 문서

> 작성일: 2026-04-19  
> 최종 수정: 2026-04-19 v3  
> 관련 파일: `src/components/CalendarView/CalendarView.js`, `src/components/SettingsView/SettingsView.js`, `src/services/dbManager.js`, `src/components/SummaryView/SummaryView.js`

---

## 1. 배경 및 목적

현재 캘린더 일정 유형(EVENT_TYPES)은 [CalendarView.js:17-23](../src/components/CalendarView/CalendarView.js#L17) 에 하드코딩되어 있다.

```js
const EVENT_TYPES = [
  { value: 'trip',      label: '여행',   color: '#F0A500' },
  { value: 'occasion',  label: '경조사', color: '#EC4899' },
  { value: 'holiday',   label: '명절',   color: '#10B981' },
  { value: 'medical',   label: '의료',   color: '#3B82F6' },
  { value: 'general',   label: '기타',   color: '#6366F1' },
];
```

목표:
- 사용자가 일정 유형을 추가·수정·**삭제** (숨기기 아님)·순서변경 가능하도록
- `general` 은 "분류 없음" 역할로 시스템 예약, 항상 존재
- 캘린더 설정을 설정 화면의 **캘린더 탭 → 서브탭** 구조로 제공
- 요약 > 일정별 필터/표시를 동적 유형 기반으로 개선

---

## 2. 범위 (Scope)

### In Scope
- 캘린더 설정 탭 신설 (서브탭: 일정 유형 / 표시 설정)
- 일정 유형 CRUD + 순서변경 (삭제는 사용 중이 아닐 때만)
- 기존 캘린더 표시 설정 이 탭으로 이동
- DB 마이그레이션 (신규 테이블 + 기존 데이터 정규화)
- 요약 > 일정별: 유형 필터 동적화 + 일정 행 색상 표시
- 요약 > 결제수단 일정별: 유형별 소계 추가

### Out of Scope
- 일정 유형별 예산 설정
- 숨기기(`is_hidden`) 기능 — 불필요한 유형은 삭제로 해결

---

## 3. 핵심 설계 결정

### 3-1. `general` — 분류 없음 역할

| 속성 | 값 |
|------|-----|
| value | `'general'` (변경 불가) |
| 기본 label | `'기타'` → 사용자가 이름 변경 가능 |
| is_system | `1` → 삭제 불가 |
| 색상 | `#9CA3AF` (중립 회색) |
| 기본값 | EventForm 기본 event_type |

**"분류 없음" 취급 방식:**
- 설정 목록 내에서 **항상 맨 아래** 고정 표시 (sort_order 무관)
- 드래그 순서 변경 제외
- 캘린더 바 / 요약 행에서 색상 dot을 **표시하지 않거나 회색으로** 처리
- EventForm 유형 선택 시 `general` 은 `"분류 없음"` 레이블로 표시 (label 값과 별개)
- 요약에서 general 유형 이벤트는 유형 배지 없이 이름만 표시

### 3-2. 삭제 정책

| 조건 | 동작 |
|------|------|
| `is_system = 1` (`trip`, `general`) | 삭제 버튼 자체 미표시 |
| 해당 유형을 가진 `calendar_events` 1건 이상 존재 | 삭제 버튼 비활성화 + "N개 일정에서 사용 중" 안내 |
| 사용 건수 = 0 | 삭제 버튼 활성 → 인라인 확인 → 즉시 삭제 |

숨기기(`is_hidden`) 컬럼 없음 — 불필요한 유형은 삭제로 해결.

### 3-3. 설정 UI 위치 — 서브탭 구조

설정 최상위 탭에 `캘린더` 추가, 탭 내부에 서브탭 2개:

```
최상위 탭:   [결제수단] [카테고리] [예산] [정기지출] [캘린더]
                                                        ↓
캘린더 서브탭:                             [일정 유형] [표시 설정]
```

---

## 4. DB 설계

### 4-1. 신규 테이블: `calendar_event_types`

```sql
CREATE TABLE IF NOT EXISTS calendar_event_types (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  value        TEXT    NOT NULL UNIQUE,
  label        TEXT    NOT NULL,
  color        TEXT    NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_system    INTEGER NOT NULL DEFAULT 0,  -- 1: 삭제·value 변경 불가 (trip, general)
  is_trip_type INTEGER NOT NULL DEFAULT 0   -- 1: 국가/통화 입력 UI 활성화
);
```

- `is_hidden` 컬럼 없음 (숨기기 기능 불필요)
- `value` 는 `calendar_events.event_type` 과 텍스트 참조 (FK 없음)
- `is_system = 1` 유형: `trip`, `general`
- `is_trip_type = 1` 유형: 기본값 `trip`. 사용자가 설정에서 다른 유형에도 활성화 가능

### 4-2. 마이그레이션 (3단계)

#### 1단계 — 테이블 생성 및 초기 유형 삽입

기본 제공 유형: **여행(trip) + 경조사(occasion) + general 시스템 타입**

```sql
CREATE TABLE IF NOT EXISTS calendar_event_types ( ... );

INSERT OR IGNORE INTO calendar_event_types (value, label, color, sort_order, is_system, is_trip_type)
VALUES
  ('trip',     '여행',   '#F0A500', 0,   1, 1),  -- 시스템, 국가/통화 UI 기본 활성
  ('occasion', '경조사', '#EC4899', 1,   0, 0),
  ('general',  '기타',   '#9CA3AF', 999, 1, 0);  -- sort_order 999: 항상 맨 아래
```

#### 2단계 — 기존 `calendar_events` 데이터 정규화

```sql
-- 'general', 'trip', 'occasion' 은 그대로 유지

-- 유형 테이블에 없는 구 유형 → 'general' 로 이전 (토스트 안내 없음)
UPDATE calendar_events
SET event_type = 'general'
WHERE event_type IN ('holiday', 'medical');

-- 혹시 모를 미정의 값 방어
UPDATE calendar_events
SET event_type = 'general'
WHERE event_type NOT IN (
  SELECT value FROM calendar_event_types
);
```

**결과 요약:**

| 기존 event_type | 마이그레이션 후 | 비고 |
|-----------------|---------------|------|
| `trip`          | `trip`        | 유지 |
| `occasion`      | `occasion`    | 유지 |
| `general`       | `general`     | 유지 |
| `holiday`       | `general`     | 분류 없음으로 편입 |
| `medical`       | `general`     | 분류 없음으로 편입 |
| 미정의 값        | `general`     | 방어 처리 |

#### 3단계 — 런타임 fallback

마이그레이션 이후에도 알 수 없는 `event_type` 이 생길 수 있는 경우(외부 import 등) 방어:

```js
function resolveEventType(eventTypeMap, value) {
  return eventTypeMap[value] ?? { label: '?', color: '#9CA3AF', value };
}
```

### 4-3. 삭제 제약 (앱 레벨, DB FK 없음)

```sql
SELECT COUNT(*) FROM calendar_events WHERE event_type = ?
```

---

## 5. API 설계 (dbManager.js 추가)

```js
// 조회 — sort_order 오름차순, general 항상 마지막
getCalendarEventTypes(db)
// → [{ id, value, label, color, sort_order, is_system }, ...]

// 추가 (value 자동 생성, is_system=0 으로 고정)
addCalendarEventType(db, { label, color })
// value 생성: label 기반 slug 또는 'type_' + Date.now()

// 수정 (label, color만 — value/is_system 변경 불가)
updateCalendarEventType(db, id, { label, color })

// 삭제 — is_system=0 && 사용 건수=0 일 때만 실행
deleteCalendarEventType(db, id)
// 조건 불충족 시 throw Error

// 순서 변경 — general(sort_order=999)은 항상 마지막으로 되돌림
moveCalendarEventType(db, id, targetIndex)

// 사용 건수 조회 (삭제 버튼 활성 여부 판단)
getCalendarEventTypeUsageCount(db, value)
// → number

// is_trip_type 토글 (is_system 여부 무관하게 변경 가능)
setCalendarEventTypeTripFlag(db, id, isTripType)
// → void
```

**value 자동 생성:**
```js
function generateEventTypeValue(label) {
  const ascii = label.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  return (ascii.replace(/_/g, '').length >= 2) ? ascii : 'type_' + Date.now();
}
```

---

## 6. UI 설계 — 캘린더 설정 탭

### 6-1. 탭 구조

```
최상위: [결제수단] [카테고리] [예산] [정기지출] [캘린더]
```

모바일 5탭 처리: `.settings-tabs { overflow-x: auto; white-space: nowrap; }` — 가로 스크롤.

### 6-2. 서브탭 레이아웃

캘린더 탭 진입 시 서브탭 표시:

```
┌────────────────────────────────────┐
│  [일정 유형]  [표시 설정]            │  ← 서브탭 (더 작은 스타일)
├────────────────────────────────────┤
│  (서브탭 콘텐츠)                     │
└────────────────────────────────────┘
```

서브탭은 `.settings-tabs` 와 구분되는 별도 스타일 (예: 하단 border 방식, 더 작은 폰트).

### 6-3. [일정 유형] 서브탭

```
일정 유형 서브탭 레이아웃:

  ⠿  ●여행      [✎]            ← is_system=1: 삭제 없음, 순서 고정 가능
  ⠿  ●경조사    [✎]  [🗑 비활]  ← 사용 중: 삭제 버튼 비활성 (툴팁 "3개 일정에서 사용 중")
  ⠿  ●휴가      [✎]  [🗑]       ← 사용 안 함: 삭제 버튼 활성
  ──────────────────────────
     ◌기타 (분류 없음)  [✎]      ← general: 항상 맨 아래, 드래그 불가, 삭제 없음
                                   이름 옆에 "(분류 없음)" 부가 설명

  [+ 일정 유형 추가]
  [● 기본색] [입력창: 새 유형 이름] [추가]
```

**유형 행 세부 동작:**

| 상태 | 표시 |
|------|------|
| 기본 | `[⠿] [●색상] 라벨  [✈ 국가입력]` + 편집/삭제 버튼 |
| 편집 중 | `[⠿] [●색상피커] [입력창]` + `[✓] [✗]` |
| 삭제 확인 | `"삭제하시겠어요?" [삭제] [취소]` 인라인 |
| is_system | 삭제 버튼 없음, 드래그 핸들 표시하되 sort_order 고정 |
| general | 드래그 핸들 없음, 구분선 위에 배치, "(분류 없음)" 부연 |

**국가/통화 입력 토글 (`is_trip_type`):**

```
⠿  ● 여행      [✈ ON ]  [✎]         ← trip: is_system이지만 토글 가능
⠿  ● 경조사    [✈ OFF]  [✎]  [🗑]
⠿  ● 배낭여행  [✈ ON ]  [✎]  [🗑]   ← 사용자 추가 유형, 국가 입력 켬
```

- 토글 버튼은 아이콘(✈) + ON/OFF 텍스트 또는 슬라이더 형태
- `is_trip_type = 1` 이면 EventForm에서 해당 일정 선택 시 국가/통화 입력 섹션 표시
- `general` 유형은 `is_trip_type` 토글 없음 (분류 없음 성격상 국가 입력 불필요)

**색상 피커:**
- `<input type="color">` — 기존 EventForm 패턴 재사용

### 6-4. [표시 설정] 서브탭

기존 예산 탭에서 이동:

```
표시 설정 서브탭:

  캘린더 버튼 표시
    PC            [ON/OFF]
    모바일        [ON/OFF]

  캘린더 금액 단위
    [만원 ▾]  (만 / k / 숨김)
```

---

## 7. CalendarView 변경 사항

### 7-1. EVENT_TYPES 동적 로드

```js
// ❌ 삭제
const EVENT_TYPES = [ ... ];
const EVENT_TYPE_MAP = Object.fromEntries(...);

// ✅ 추가 (useMemo, db 변경 시 자동 갱신)
const eventTypes = useMemo(() => getCalendarEventTypes(db), [db]);
const eventTypeMap = useMemo(
  () => Object.fromEntries(eventTypes.map(t => [t.value, t])),
  [eventTypes]
);
```

### 7-2. eventColor 함수 수정

```js
// ❌ 기존
function eventColor(ev) {
  return ev.color || EVENT_TYPE_MAP[ev.event_type]?.color || '#6366F1';
}

// ✅ 변경 (general 색상은 표시 안 함 처리를 호출부에서 결정)
function resolveEventColor(ev, eventTypeMap) {
  if (ev.color) return ev.color;                          // 개별 오버라이드 우선
  const typeColor = eventTypeMap[ev.event_type]?.color;
  return typeColor ?? '#9CA3AF';
}
```

### 7-3. EventForm — 유형 선택 UI

- `general` 은 선택 목록에서 `"기타 (분류 없음)"` 으로 표시
- 목록 순서: DB sort_order 대로, general 은 맨 마지막 (구분선 후)
- 기본값(`EMPTY_FORM.event_type = 'general'`) 유지

```
유형 선택 UI:
  [● 여행    ]
  [● 경조사  ]
  [● 휴가    ]
  ──────────
  [  기타 (분류 없음) ]   ← general
```

### 7-4. 캘린더 바 — general 처리

- `general` 유형 이벤트: 색상 오버라이드 없으면 회색(`#9CA3AF`) 바로 표시
- 유형 레이블 배지 표시하는 경우 general 은 배지 미표시

### 7-5. `trip` 특수 UI 조건 — `is_trip_type` 기반으로 확장

**기존:**
```js
{form.event_type === 'trip' && (
  <div className="trip-countries-section"> ... </div>
)}
```

**변경:**
```js
// 선택된 event_type 의 is_trip_type 확인
const selectedType = eventTypeMap[form.event_type];
const showCountriesSection = selectedType?.is_trip_type === 1;

{showCountriesSection && (
  <div className="trip-countries-section"> ... </div>
)}
```

- `event_type === 'trip'` 하드코딩 제거
- `is_trip_type = 1` 인 유형이면 어느 유형이든 국가/통화 입력 UI 표시
- TransactionForm의 foreign_amounts 입력 조건도 동일하게 변경 필요  
  ([TransactionForm.js](../src/components/TransactionForm/TransactionForm.js) 에서 `ev.event_type === 'trip'` 조건 → `is_trip_type` 기반으로 교체)

---

## 8. 요약 뷰 변경 사항

### 8-1. 일정별 유형 필터 — 동적화

**현재 ([SummaryView.js:239](../src/components/SummaryView/SummaryView.js#L239)):**
```js
{[['', '전체'], ['trip', '여행'], ['occasion', '경조사'],
  ['holiday', '명절'], ['medical', '의료'], ['general', '기타']].map(...)}
```

**변경:**
```js
const eventTypes = useMemo(() => getCalendarEventTypes(db), [db]);

{[{ value: '', label: '전체', color: null }, ...eventTypes].map(t => (
  <button
    key={t.value}
    className={`filter-type-btn${eventTypeFilter === t.value ? ' active' : ''}`}
    style={{ fontSize: 11, padding: '3px 8px' }}
    onClick={() => { setEventTypeFilter(t.value); setSelectedEventId(''); }}
  >
    {t.value && t.value !== 'general' && (
      <span style={{
        display: 'inline-block', width: 7, height: 7,
        borderRadius: '50%', background: t.color, marginRight: 4, verticalAlign: 'middle'
      }}/>
    )}
    {t.label}
  </button>
))}
```

- `general` 필터 버튼에는 색상 dot 없음 (분류 없음 의미 유지)
- DB에 없는 유형 버튼은 자동으로 사라짐

### 8-2. 일정 목록 행 — 색상 표시

**현재:** 텍스트만.

**변경:**
```js
<td className="nowrap-cell">
  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
    {r.event_type !== 'general' && (
      <span style={{
        width: 9, height: 9, borderRadius: '50%', flexShrink: 0, marginTop: 3,
        background: resolveEventColor(r, eventTypeMap)
      }}/>
    )}
    <span>
      {r.event_title}<span className="drilldown-arrow">›</span>
      {r.event_type !== 'general' && (
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 4 }}>
          {eventTypeMap[r.event_type]?.label ?? r.event_type}
        </span>
      )}
    </span>
  </div>
  {r.date_from && (
    <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)',
                   paddingLeft: r.event_type !== 'general' ? 15 : 0 }}>
      {r.date_from.slice(5)}{r.date_to ? ` ~ ${r.date_to.slice(5)}` : ''}
    </span>
  )}
</td>
```

- `general` 행: dot·유형 레이블 없음, 날짜 들여쓰기 없음

### 8-3. 결제수단 탭 — 일정별 유형 소계

`getEventPaymentMethodSummary` 쿼리 변경:

```sql
-- 기존: GROUP BY payment_method
-- 변경: GROUP BY payment_method, event_type

SELECT t.payment_method,
       ce.event_type,
       SUM(t.amount)          AS total,
       SUM(t.discount_amount) AS discount,
       COUNT(*)               AS cnt
FROM transactions t
JOIN calendar_events ce ON t.event_id = ce.id
WHERE t.event_id IS NOT NULL
  [AND t.event_id = ? -- 특정 일정 선택 시]
GROUP BY t.payment_method, ce.event_type
ORDER BY t.payment_method, total DESC
```

UI 표시 (전체 일정 모드):
```
결제수단        유형        건수    총액
──────────────────────────────────────
신한카드                    12    580,000원
             ● 여행          8    400,000원
             ● 경조사         4    180,000원
삼성카드                     5    220,000원
               경조사         5    220,000원   ← general: dot 없음
```

> 특정 일정 선택 시 유형 1개 고정 → 기존 단순 표시 유지.

---

## 9. 예산 탭 변경

캘린더 표시 설정 항목 제거 (캘린더 탭 > 표시 설정 서브탭으로 이동):
- `캘린더 버튼 표시` (PC/모바일 토글)
- `캘린더 금액 단위` 드롭다운

관련 settings key 변경 없음: `show_calendar_btn_pc`, `show_calendar_btn_mobile`, `calendar_mini_amount_unit`

---

## 10. 구현 순서

```
1. dbManager.js
   ├── calendar_event_types 테이블 DDL
   ├── 마이그레이션: 테이블 생성 → 초기 3개 삽입 (trip/occasion/general)
   │              → holiday/medical → occasion UPDATE
   │              → 미정의 event_type → general UPDATE
   ├── CRUD 함수: getCalendarEventTypes, addCalendarEventType,
   │             updateCalendarEventType, deleteCalendarEventType,
   │             moveCalendarEventType, getCalendarEventTypeUsageCount
   └── getEventPaymentMethodSummary: event_type 컬럼 추가

2. SettingsView.js
   ├── 'calendar' 탭 버튼 추가
   ├── 캘린더 탭 내 서브탭 상태 관리 (calendarSubTab: 'types' | 'display')
   ├── [일정 유형] 서브탭: CRUD 리스트 + 추가 폼
   ├── [표시 설정] 서브탭: 캘린더 표시 설정 UI
   └── 예산 탭에서 캘린더 설정 항목 제거

3. CalendarView.js
   ├── EVENT_TYPES 하드코딩 제거 → useMemo(getCalendarEventTypes)
   ├── eventTypeMap 동적 생성
   ├── resolveEventColor 함수 수정 (개별 오버라이드 유지)
   ├── EventForm 유형 선택: general 맨 마지막 + "(분류 없음)" 레이블
   ├── 캘린더 바 general 색상 처리
   └── 국가/통화 섹션 조건: event_type === 'trip' → is_trip_type === 1

3-1. TransactionForm.js
   └── foreign_amounts 표시 조건: ev.event_type === 'trip' → selectedEventType?.is_trip_type === 1

4. SummaryView.js
   ├── 유형 필터 버튼 동적화 (getCalendarEventTypes)
   ├── 일정 목록 행: 색상 dot + 유형 레이블 (general 제외)
   └── 결제수단 탭: 유형별 소계 표시
```

---

## 11. 엣지 케이스 및 고려사항

| 케이스 | 처리 방법 |
|--------|-----------|
| `holiday`/`medical` 데이터가 없는 경우 | UPDATE 0건 — 무해 |
| 외부 import로 알 수 없는 event_type 유입 | `general` 로 fallback (단계 2 방어 쿼리) |
| 유형 0개 (general만 남은 경우) | EventForm 유형 선택 = general만 표시 — 정상 동작 |
| general 이름 변경 후 UI | "(분류 없음)" 부연 설명은 label과 별개로 유지 |
| moveCalendarEventType으로 general을 이동 시도 | 함수 내에서 general의 sort_order를 999로 강제 복원 |
| 결제수단 탭 유형 소계 — 특정 일정 선택 시 | 유형 1개 고정, 기존 단순 표시 유지 |
| `is_trip_type = 1` 유형 일정에 국가 미입력 | 국가 섹션 표시만 하고 저장 정상 진행 (입력 선택 사항) |
| 기존 trip 데이터의 event_countries | is_trip_type 기반 변경 후에도 데이터 구조 동일 — 영향 없음 |
| general 유형에 is_trip_type 설정 시도 | UI에서 토글 자체를 미표시하여 방지 |

---

## 12. 확정 사항 (미결 → 결정 완료)

| 항목 | 결정 |
|------|------|
| 마이그레이션 안내 토스트 | **없음** |
| holiday/medical 이전 대상 | **`general`** (occasion 아님) |
| trip 국가/통화 기능 확장 | **진행** — `is_trip_type` 플래그 방식 |
| 결제수단 유형 소계 접기/펼치기 | **항상 펼침** 권장 (아래 근거) |
| 서브탭 스타일 | **pill 스타일** 권장 (아래 근거) |

### 결제수단 유형 소계 — 항상 펼침 권장 이유
- 일정 유형 수가 통상 2~4개 → 펼쳐도 행 수가 많지 않음
- 토글 구현 시 상태 관리 + 애니메이션 비용 대비 UX 이점 미미
- 나중에 유형이 많아지면 그때 토글 도입 검토

### 서브탭 스타일 — pill 스타일 권장 이유
- 최상위 탭은 전체 너비 균등 분할 + 하단 border 형식
- 서브탭은 **좌측 정렬 pill 버튼** (배경색 토글, 둥근 모서리, 작은 폰트 11-12px)으로 시각적 계층 차이 명확히
- CSS 예시:
  ```css
  .settings-subtabs { display: flex; gap: 6px; margin-bottom: 16px; }
  .settings-subtab  { padding: 4px 12px; border-radius: 12px; font-size: 12px;
                      background: var(--bg-secondary); border: none; cursor: pointer; }
  .settings-subtab.active { background: var(--accent); color: #fff; }
  ```
