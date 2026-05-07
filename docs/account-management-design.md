# 계좌 관리 기능 설계

## 1. 개요

특정 은행 계좌(월급통장 등)의 고정 입출금 스케줄을 관리하고, **특정 날짜의 잔액을 미리 예측**하는 기능.
거래내역(소비 패턴 분석)과 별도로 분리하여 관리.

**핵심 흐름:**
잔액 기준값 입력 → 고정 입출금 스케줄 등록 → 월초 자동 입력(카드 결제액 집계 + 고정 수입) → 날짜별 잔액 예측 확인 → 필요 시 수동 수정

**거래내역과의 차이:**

| 구분 | 거래내역 (기존) | 계좌 관리 (신규) |
|------|----------------|----------------|
| 목적 | 소비 패턴 분석 | 잔액 흐름 예측 |
| 단위 | 카드/현금 건별 소비 | 계좌 입출금 스케줄 |
| 사용빈도 | 거의 매일 | 월 수회 |
| 금액 성격 | 소액 다수 | 고정/큰 금액 위주 |

---

## 2. 네비게이션 개편

### 현재 구조
```
[헤더]    👤 이름 | 로그아웃
[하단탭]  거래내역 | 요약 | ➕ | 캘린더 | ⚙️설정
```

### 변경 구조
```
[헤더]    👤 이름 | ⚙️ | 로그아웃    ← 설정 아이콘 헤더 이동
[하단탭]  거래내역 | 요약 | ➕ | 캘린더 | 🏦계좌
```

**변경 이유:**
- 설정은 환경설정 성격 → 헤더 계정 영역이 의미상 자연스러움, 자주 쓰지 않으므로 한 단계 들어가도 무방
- 계좌 관리는 월 수회 접근 → 하단 탭 직접 배치
- 하단 탭 5개 구조 유지

**➕ 버튼 문맥별 동작 (캘린더 탭과 동일한 방식):**

| 현재 탭 | ➕ 버튼 동작 |
|---------|------------|
| 거래내역 | 거래 입력 폼 |
| 요약 | 거래 입력 폼 |
| 캘린더 | 일정 입력 폼 |
| **계좌** | **계좌 거래 입력 폼** (기본 계좌 pre-select) |

---

## 3. 기본 계좌 (Default Account)

### 동작 방식

계좌 탭 진입 시:
- **기본 계좌가 설정된 경우** → 목록 건너뛰고 해당 계좌 상세(잔액 예측 탭)로 바로 이동
- **기본 계좌 미설정 또는 계좌 2개 이상** → 계좌 목록 표시
- 목록 화면에서 ← 뒤로가기 항상 가능

계좌 목록에서 기본 계좌는 상단 고정 + 🏠 표시.

➕ 거래 입력 시 기본 계좌 pre-select.

### 설정 위치

계좌 상세 > 설정 탭 내 토글:
```
기본 계좌로 설정  [🏠 ON]   ← 탭 진입 시 바로 이동
```

---

## 4. 화면 구성

### 4-1. 계좌 목록

```
┌─────────────────────────────┐
│  🏦 계좌 관리          [+]  │
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │ 🏠 월급통장 (신한은행)   │ │  ← 기본 계좌
│ │ 현재잔액 2,450,000원     │ │
│ │ 기준일: 2026-05-01       │ │
│ │ 📅 5/13 카드결제 예정    │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ 비상금통장 (카카오뱅크)  │ │
│ │ 현재잔액 5,000,000원     │ │
│ └─────────────────────────┘ │
└─────────────────────────────┘
```

### 4-2. 계좌 상세 — 잔액 예측 탭 (핵심 화면)

```
┌─────────────────────────────┐
│ ← 월급통장          [편집]  │
├─────────────────────────────┤
│ [잔액예측] [거래내역] [설정] │
├─────────────────────────────┤
│  [이번달] [1개월] [3개월]   │
│                              │
│  오늘 (5/5)   2,450,000원  │
│  ─────────────────────────  │
│  5/13  신한카드 결제         │
│        -850,000원  🔁       │  ← 자동집계 (전월 실사용분)
│        잔액 1,600,000원 🔴  │  ← danger_threshold 미만
│  ─────────────────────────  │
│  5/25  급여                  │
│        +3,200,000원 예상 🔁 │  ← 예상금액 표시
│        잔액 4,800,000원     │
│  ─────────────────────────  │
│  6/13  신한카드 결제         │
│        ~920,000원 추정 🔁   │  ← 5월 사용분 집계중이므로 추정
│        잔액 3,880,000원     │
│  ─────────────────────────  │
│  6/25  급여                  │
│        +3,200,000원 예상 🔁 │
│        잔액 7,080,000원     │
└─────────────────────────────┘
```

**금액 상태 표시:**

| 표시 | 의미 |
|------|------|
| (표시 없음) | 실제 확정된 금액 |
| `예상` | 고정 수입의 예상금액, 실제 입금 후 수정 가능 |
| `추정` | 카드 집계 대상월이 진행 중 → 전월 기준 추정 |
| `🔁` | 자동 생성 항목 |
| 🔴 | 잔액 danger_threshold 미만 |

### 4-3. 계좌 상세 — 거래내역 탭

```
┌─────────────────────────────┐
│ [잔액예측] [거래내역] [설정] │
├─────────────────────────────┤
│                  [가져오기] │
│ 2026-05-25  급여  +3,200,000│  🔁
│ 2026-05-13  신한카드 -850,000│ 🔁
│ 2026-04-25  급여  +3,178,000│  🔁✏️  ← 예상(3,200,000)→실제 수정됨
│ 2026-04-14  신한카드 -780,000│ 🔁   ← 4/13이 일요일, 실제는 4/14
└─────────────────────────────┘
```

수정된 자동 항목은 🔁✏️ 표시로 구분.

### 4-4. 계좌 상세 — 설정 탭

```
┌─────────────────────────────┐
│ [잔액예측] [거래내역] [설정] │
├─────────────────────────────┤
│ 계좌명    [월급통장        ] │
│ 은행      [신한은행        ] │
│ 계좌번호  [선택입력        ] │
│                              │
│ 기본 계좌로 설정  [🏠 ON  ] │
│                              │
│ 잔액 기준                    │
│ 금액   [2,450,000         ] │
│ 기준일 [2026-05-01        ] │
│                              │
│ 위험잔액 기준 [500,000     ] │
│                              │
│ ── 고정 입출금 항목 ──       │
│ 급여    입금  25일  예상 3,200,000│ [편집]
│ 신한카드 출금  13일  자동집계      │ [편집]
│ 관리비  출금  25일  80,000         │ [편집]
│                        [+ 추가]    │
└─────────────────────────────┘
```

### 4-5. 거래 입력 폼 (모달 — ➕ 버튼)

```
계좌     [월급통장 ▼]   (기본 계좌 pre-select)
날짜     [2026-05-25      ]
유형     [● 입금  ○ 출금  ]
분류     [급여           ▼]   급여 / 카드결제 / 이체 / 기타
금액     [3,200,000      ]   수식 지원 (1600000+1600000)
내용     [5월 급여        ]
```

### 4-6. 고정 입출금 편집 폼

```
항목명   [신한카드 결제     ]
유형     [● 입금  ○ 출금  ]
매월     [13       ]일
공휴일   [● 다음 업무일  ○ 처리 안함]

금액 방식
  ○ 고정 예상금액  [3,200,000    ]   ← 입금 항목은 "예상금액"으로 표시
  ● 자동 집계     → 연동 결제수단: [신한카드 ▼]
                   집계 기간: 전월 사용분 (고정)
                   현재 집계값: 850,000원 (4/1~4/30 신한카드 합계)

자동 등록  [✓]   (월초에 거래내역 자동 삽입, 이후 수동 수정 가능)

[취소]                      [저장]
```

**입금 항목의 예상금액 안내:**
> 실제 입금액이 다를 경우 거래내역 탭에서 직접 수정하세요.  
> 수정 전까지는 잔액 예측에 예상금액이 사용됩니다.

---

## 5. 고정 입출금 설정 위치 결정

### 질문: 설정 > 지출계획 탭에 두면 안될까?

**검토 의견:**

정기지출(기존)과 계좌 고정 입출금은 성격이 다름:

| 구분 | 정기지출 (설정>지출계획) | 계좌 고정 입출금 |
|------|------------------------|----------------|
| 목적 | 거래내역 자동 등록 | 계좌 잔액 예측용 스케줄 |
| 단위 | 카드/현금 소비 건 | 통장 입출금 흐름 |
| 계좌 연관 | 없음 | 특정 계좌에 종속 |

**설정 > 지출계획에 넣을 경우 문제:**
- 설정이 헤더로 이동하면 진입 경로가 더 깊어짐 (헤더 → 설정 → 지출계획 → 계좌일정)
- 계좌가 여러 개면 설정 탭에서 계좌 선택 UI가 추가로 필요
- "지출계획"은 소비 관점 기능들의 모음 → 입금(급여) 항목이 여기 섞이면 의미 혼재

**결론: 계좌 상세 > 설정 탭에 유지**

계좌 탭에서 바로 접근하는 흐름이 더 자연스럽고, 계좌별 맥락도 명확함.  
향후 계좌가 많아지면 계좌 목록에서 전체 스케줄 통합 뷰를 별도 추가 검토 가능.

---

## 6. 데이터 모델

### 신규 테이블

```sql
-- 계좌 정보
CREATE TABLE IF NOT EXISTS accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,               -- '월급통장'
  bank             TEXT,                        -- '신한은행'
  account_number   TEXT,                        -- 선택 입력
  current_balance  INTEGER NOT NULL DEFAULT 0,  -- 잔액 기준값
  balance_date     DATE NOT NULL,               -- 잔액 기준일 (직접 입력)
  danger_threshold INTEGER DEFAULT 500000,      -- 위험잔액 기준
  is_default       INTEGER DEFAULT 0,           -- 기본 계좌 여부 (1개만 1)
  note             TEXT,
  sort_order       INTEGER DEFAULT 0,
  is_active        INTEGER DEFAULT 1,
  created_at       TEXT DEFAULT (datetime('now','localtime'))
);

-- 고정 입출금 스케줄 (자동 입력 + 예측의 핵심)
CREATE TABLE IF NOT EXISTS account_recurring_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            INTEGER NOT NULL REFERENCES accounts(id),
  name                  TEXT NOT NULL,                 -- '급여', '신한카드 결제'
  type                  TEXT NOT NULL CHECK(type IN ('income','expense')),
  day_of_month          INTEGER NOT NULL,              -- 매월 N일
  holiday_rule          TEXT DEFAULT 'next_business',  -- 'next_business' | 'none'
  -- 금액 방식
  amount_type           TEXT NOT NULL DEFAULT 'fixed' CHECK(amount_type IN ('fixed','auto')),
  fixed_amount          INTEGER,     -- amount_type='fixed'일 때 (입금이면 "예상금액")
  auto_payment_method   TEXT,        -- amount_type='auto', 연동 결제수단명
  -- 자동 등록 설정
  auto_register         INTEGER DEFAULT 1,  -- 월초에 account_transactions 자동 삽입
  register_months_ahead INTEGER DEFAULT 2,  -- 몇 개월 앞까지 자동 등록 (기본 2)
  -- 메타
  note                  TEXT,
  sort_order            INTEGER DEFAULT 0,
  is_active             INTEGER DEFAULT 1,
  created_at            TEXT DEFAULT (datetime('now','localtime'))
);

-- 계좌 거래 내역 (자동 생성 + 수동 입력 + import)
CREATE TABLE IF NOT EXISTS account_transactions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id         INTEGER NOT NULL REFERENCES accounts(id),
  date               DATE NOT NULL,
  type               TEXT NOT NULL CHECK(type IN ('income','expense')),
  category           TEXT,               -- '급여','카드결제','이체','기타'
  description        TEXT,
  amount             INTEGER NOT NULL,
  base_amount        INTEGER,            -- 자동 생성 시 원래 예상/집계 금액 (비교용)
  recurring_item_id  INTEGER,            -- account_recurring_items.id (자동 생성 시)
  is_auto_generated  INTEGER DEFAULT 0,  -- 자동 생성 여부 (수정해도 1 유지)
  is_modified        INTEGER DEFAULT 0,  -- 자동 생성 후 사용자가 수정했는지
  is_imported        INTEGER DEFAULT 0,  -- import 여부
  created_at         TEXT DEFAULT (datetime('now','localtime'))
);

-- 공휴일 데이터 (결제일 계산용 — src/data/holidays.js 와 동기화)
CREATE TABLE IF NOT EXISTS holidays (
  date  DATE PRIMARY KEY, -- 'YYYY-MM-DD'
  name  TEXT
);
```

**`base_amount` 활용:**  
자동 생성 시 예상/집계 금액을 `base_amount`에 저장. 사용자가 실제 금액으로 수정하면 `amount`만 변경 + `is_modified=1`. 나중에 "예상 vs 실제" 비교 가능.

### 기존 테이블 연동

`account_recurring_items.auto_payment_method` → `payment_methods.name` 참조  
예측/자동 집계 시 기존 `transactions` 테이블에서 해당 결제수단의 전월 합계를 쿼리.

---

## 7. 핵심 로직

### 7-1. 월초 자동 입력 트리거

앱 로드 시 또는 계좌 탭 진입 시 실행:

```
현재 날짜 기준 등록 대상 월: [이번달, 다음달, 다음다음달]

각 account_recurring_items (auto_register=1) × 대상 월:
  1. 중복 체크:
     SELECT 1 FROM account_transactions
     WHERE recurring_item_id = ? AND strftime('%Y-%m', date) = 'YYYY-MM'

  2. 미등록이면 자동 삽입:
     a. 실제 날짜: getActualPaymentDate(년, 월, day_of_month, holiday_rule)
     b. amount_type='auto':
          amount = getCardTotal(auto_payment_method, 전월)
          base_amount = amount
          description = '{결제수단} {전월}월 사용분'
        amount_type='fixed':
          amount = fixed_amount  (입금이면 예상금액)
          base_amount = fixed_amount
          description = '{name}'
     c. INSERT (is_auto_generated=1, is_modified=0)
```

### 7-2. 카드 결제액 자동 집계

```sql
SELECT SUM(amount - COALESCE(discount_amount, 0))
FROM transactions
WHERE payment_method = :payment_method_name
  AND date BETWEEN :prev_month_start AND :prev_month_end
```

**케이스별 처리:**

| 상황 | 처리 |
|------|------|
| 전월 완료 | 집계 금액 그대로 사용 |
| 전월 진행 중 | 현재까지 합계 삽입, 예측 화면에서 "추정" 표시 |
| 전월이 미래 | 전전월 값으로 삽입 + "추정" 표시 |
| 집계 결과 없음 | 0원 삽입 + "내역없음" 표시, 수동 수정 안내 |

### 7-3. 카드 결제일 공휴일 처리

`src/data/holidays.js`의 `getActualPaymentDate()` 사용.  
holidays 테이블은 앱 초기화 시 `holidays.js` 데이터로 동기화.

### 7-4. 잔액 예측 알고리즘

```
입력: account_id, 예측_종료일

1. accounts에서 current_balance, balance_date, danger_threshold 로드

2. balance_date 이후의 account_transactions 조회
   (is_auto_generated 여부 무관, 모두 포함)

3. 예측 스케줄 전개 (미등록 미래 달만):
   - 각 recurring_item × 대상 월에서 account_transactions 미존재 시만 전개
   - 실제 날짜 계산 + 금액 산출 (amount_type에 따라)

4. 2 + 3 합쳐 날짜순 정렬

5. current_balance에서 순차 적용
   → [{date, description, amount, type, balance_after,
       is_estimated, is_danger, recurring_item_id}, ...]

6. balance_after < danger_threshold → is_danger = true
```

**예측 항목 레이블:**
- `is_auto_generated=1` + `is_modified=0` + 미래 날짜 → "예상" 표시
- 전개된 미래 스케줄 → "추정" 표시 (아직 account_transactions 미삽입)

### 7-5. Import 처리 흐름

```
1. CSV 파일 선택 또는 텍스트 붙여넣기
2. 은행별 파서로 파싱 (날짜, 입출금구분, 금액, 내역)
3. 미리보기 테이블 표시
4. 중복 검사: 같은 (date, type, amount) 하이라이트
5. 확인 후 account_transactions 삽입 (is_imported=1)
```

초기 지원 포맷: 신한은행 CSV (추후 확장)

---

## 8. 공휴일 데이터 관리

### 파일 위치

```
src/data/holidays.js    ← 연도별 공휴일 상수 + 유틸 함수
```

### 역할 분리

| 위치 | 역할 |
|------|------|
| `src/data/holidays.js` | 원본 데이터 (직접 보고 수정하는 파일) |
| `holidays` DB 테이블 | 앱 내 계산용 (앱 로드 시 holidays.js와 동기화) |

### 연도별 추가 방법

`holidays.js`의 `HOLIDAYS_BY_YEAR`에 연도 키 추가:
```js
2027: [
  { date: '2027-01-01', name: '신정' },
  // ...
]
```

### 2026년 공휴일 목록

| 날짜 | 요일 | 이름 | 비고 |
|------|------|------|------|
| 01-01 | 목 | 신정 | |
| 02-16 | 월 | 설날 연휴 | |
| 02-17 | 화 | 설날 | |
| 02-18 | 수 | 설날 연휴 | |
| 03-01 | 일 | 삼일절 | |
| 03-02 | 월 | 대체공휴일(삼일절) | 3/1 일요일 |
| 05-01 | 금 | 근로자의 날 | 근로기준법 법정 유급휴일 → 카드 결제일 다음 업무일로 이동 |
| 05-05 | 화 | 어린이날 | |
| 05-24 | 일 | 부처님오신날 | |
| 05-25 | 월 | 대체공휴일(부처님오신날) | 5/24 일요일 |
| 06-03 | 수 | 전국동시지방선거 | |
| 06-06 | 토 | 현충일 | 대체공휴일 미적용 |
| 08-15 | 토 | 광복절 | |
| 08-17 | 월 | 대체공휴일(광복절) | 8/15 토요일 |
| 09-24 | 목 | 추석 연휴 | |
| 09-25 | 금 | 추석 | |
| 09-26 | 토 | 추석 연휴 | |
| 10-03 | 토 | 개천절 | |
| 10-05 | 월 | 대체공휴일(개천절) | 10/3 토요일 |
| 10-09 | 금 | 한글날 | |
| 12-25 | 금 | 성탄절 | |

> ⚠️ 추석 연휴(9/26 토요일) 대체공휴일(9/28) 여부 미확정. 확정 시 `holidays.js`에 추가.
>

---

## 9. 개발 단계

**Step 1 — DB 스키마 + 공휴일 초기화**
- `accounts`, `account_recurring_items`, `account_transactions`, `holidays` 테이블 추가
- 앱 로드 시 `holidays.js` → `holidays` 테이블 동기화

**Step 2 — 계좌 CRUD + 기본 계좌**
- 계좌 목록/추가/수정/삭제
- `is_default` 처리: 기본 계좌 탭 진입 시 바로 상세로 이동

**Step 3 — 고정 입출금 항목 관리 (계좌 설정 탭)**
- 항목 추가/편집/삭제
- 금액 방식: 고정 예상금액 vs 자동 집계 선택

**Step 4 — 자동 입력 로직**
- 월초 자동 삽입 트리거
- 카드 결제액 집계 (`transactions` 테이블 연동)
- `base_amount` 저장, 수정 시 `is_modified=1`

**Step 5 — 잔액 예측 뷰**
- 예측 알고리즘 구현 (공휴일 처리 포함)
- 타임라인 UI (날짜별 잔액 + 상태 레이블 + 위험 강조)
- 예측 범위 선택 (이번달 / 1개월 / 3개월)

**Step 6 — 수동 거래 입력 + 거래내역 탭**
- ➕ 버튼 → 계좌 거래 입력 폼 (기본 계좌 pre-select)
- 자동 입력 항목 수정 지원 (🔁✏️ 표시)
- 거래내역 목록

**Step 7 — Import 기능**
- 신한은행 CSV 파싱 + 미리보기
- 중복 검사

**Step 8 — 네비게이션 개편**
- 설정 아이콘 헤더 이동
- 계좌 탭 추가 (하단 네비)
- ➕ 버튼 문맥별 동작 분기

---

## 10. 결정된 사항

| 항목 | 결정 |
|------|------|
| 기본 계좌 | `is_default` 필드, 탭 진입 시 바로 상세로 이동 |
| 고정 입출금 위치 | 계좌 상세 > 설정 탭 (계좌별 맥락 유지) |
| 입금 예상금액 | `fixed_amount`를 예상금액으로 사용, 실제 입금 후 수정 |
| 수정 추적 | `base_amount` + `is_modified` 필드로 예상 vs 실제 비교 가능 |
| 카드 결제 집계 기준 | 전월 사용분 고정 |
| 자동 입력 시점 | 앱 로드 / 계좌 탭 진입 시 |
| 자동 입력 범위 | 현재월 + 2개월 뒤까지 (5월 기준 → 7월까지) |
| 미래달 집계값 | 전전월 값 + "추정" 표시 |
| 공휴일 데이터 | `src/data/holidays.js` 별도 파일, 연도별 추가 방식 |
| 근로자의 날 | 법정 유급휴일, 카드 결제일 이동 대상에 포함 |
| 복수 계좌 합산 뷰 | 추후 검토 (v1 미구현) |
