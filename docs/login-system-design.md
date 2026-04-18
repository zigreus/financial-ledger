# 로그인 시스템 개선 설계서

> 작성일: 2026-04-05  
> 현재 브랜치: main

---

## 현재 구조 분석 (문제점)

| 항목 | 현재 | 목표 |
|------|------|------|
| 인증 | MS MSAL (클라이언트 사이드) | 드라이브 보유 소셜 로그인 추가 |
| DB 파일 | 개인 OneDrive 고정 경로 1개 | 계정별·가계부별 분리 |
| 공유 | 불가 | 여러 계정이 같은 가계부 접근 |
| 페이지 | 로그인→바로 가계부 | 로그인→가계부 목록→가계부 |

---

## 핵심 원칙: 데이터는 개인 드라이브에 남긴다

가계부 데이터(.db 파일)는 각 사용자의 개인 클라우드 드라이브에 저장합니다.  
외부 서버에 파일이 업로드되지 않으므로 **데이터 소유권·프라이버시가 보장**됩니다.

단, 아래 메타데이터는 중앙 서버(Supabase)가 관리합니다:
- 어떤 가계부가 어느 드라이브 경로에 있는지 (레지스트리)
- 누가 어떤 가계부에 접근 권한을 가지는지 (권한 테이블)
- 초대 링크 토큰

---

## 로그인 provider 선정: 드라이브 보유 서비스만

| Provider | 드라이브 | 지원 여부 | 비고 |
|----------|---------|---------|------|
| **Microsoft** | OneDrive | ✅ 지원 | 현재 구현됨 |
| **Google** | Google Drive | ✅ 지원 | 신규 추가 |
| Dropbox | Dropbox | 보류 | 소셜 로그인 개념 아님, 추후 검토 |
| 카카오 | 없음 | ❌ 제외 | 연결된 클라우드 스토리지 없음 |
| 네이버 | MYBOX (30GB 무료) | ❌ 제외 | 드라이브는 존재하나 **공식 써드파티 API 없음** |

### 네이버 MYBOX 검토 결과 (2025 기준)

네이버도 **MYBOX**라는 클라우드 드라이브 서비스(30GB 무료)를 운영하고 있습니다.  
그러나 **공식 개발자 API를 제공하지 않습니다.**

- GitHub에 비공식 역공학 구현체가 존재하나 공식 API 아님
- 네이버 클라우드 플랫폼(ncloud)은 별도 엔터프라이즈 서비스로, 네이버 로그인 계정과 연결되지 않음
- 결론: API 없으므로 파일 읽기/쓰기/공유 자동화 불가 → **제외**

> **이유**: 로그인 provider = 데이터 저장소가 되어야 프라이버시가 보장됩니다.  
> 공식 API가 없는 provider는 자동 연동이 불가능하므로 제외합니다.

---

## Supabase란?

**Supabase**는 오픈소스 BaaS(Backend-as-a-Service)입니다.  
이 설계에서는 **파일 저장에는 사용하지 않고**, 아래 두 가지 용도로만 사용합니다.

| 사용 기능 | 내용 |
|----------|------|
| **Auth** | Google, Azure(MS) 기본 지원. provider 무관하게 단일 user ID 발급 |
| **PostgreSQL** | 가계부 레지스트리, 멤버 권한, 초대 토큰 저장 |

> Supabase Storage는 **사용하지 않습니다.** 파일은 개인 드라이브에만 존재합니다.

무료 티어(DB 500MB)로 가족 가계부 메타데이터는 충분합니다.  
대안: Firebase Auth + Firestore (Google 종속), Node.js 직접 구축 (호스팅 부담)

---

## 신규 아키텍처

```
[브라우저]
    ↕ MS MSAL (PKCE)          → Microsoft Graph API → OneDrive
    ↕ Google OAuth (PKCE)     → Google Drive API

[Supabase - 메타데이터 전용]
 ├── Auth: 통합 user ID 관리 (Google / MS 구분 없이 단일 식별자)
 └── PostgreSQL: ledgers / ledger_members / ledger_invites
```

**.db 파일 저장 위치:**

| 로그인 provider | 파일 경로 |
|----------------|----------|
| Microsoft | `OneDrive: Apps/financial-ledger/ledgers/{ledger_id}.db` |
| Google | `Google Drive: 앱 전용 폴더 (appDataFolder)/ledgers/{ledger_id}.db` |

---

## 드라이브 파일 관리

### 파일 생성
- 가계부 생성 시 해당 provider의 Drive API로 파일 업로드
- 파일 ID(OneDrive item ID / Google Drive file ID)를 Supabase `ledgers` 테이블에 저장

### 파일 읽기/쓰기
- 현재 OneDrive 방식과 동일한 흐름 유지 (fetch → sql.js → 수정 → 업로드)
- 소유자: 자신의 드라이브에서 직접 읽기/쓰기
- 공유 멤버: **소유자 드라이브의 파일을 자신의 인증 토큰으로 접근** (드라이브 공유 권한 기반)

### Google Drive 범위(scope)
- `https://www.googleapis.com/auth/drive.file`
- 앱이 생성한 파일에 한해 읽기·쓰기·공유 권한 부여 가능
- 다른 Drive 파일에는 접근 불가 (최소 권한 원칙 준수)

### OneDrive 범위(scope)
- `Files.ReadWrite` (현재 이미 사용 중)

---

## 공유 메커니즘: 드라이브 공유 + 메타데이터 권한

### 공유의 원리

멤버(B)가 소유자(A)의 가계부에 접근하려면 두 가지가 모두 필요합니다:

1. **Supabase `ledger_members`**: "B가 이 가계부에 접근 권한 있음" 기록
2. **Drive 수준 공유**: A의 드라이브 파일을 B 계정이 실제로 읽을 수 있도록 허용

### 공유 방식: "링크로 공유" (편의 우선)

드라이브 파일을 "링크를 가진 사람은 접근 가능"으로 설정합니다.  
앱 초대 링크 토큰이 보안 레이어 역할을 하므로, Drive 파일 자체는 링크 공유로 열어도 됩니다.

```
Google Drive: files/{id}/permissions → { type: 'anyone', role: 'writer' }
OneDrive:     /items/{id}/createLink → { type: 'edit', scope: 'anonymous' }
```

> **보안 분석**: Drive 파일 링크는 공개되지 않습니다. 파일 ID는 Supabase DB에만 있으며,
> Supabase에서 `ledger_members` 확인 없이는 파일 ID를 알 수 없습니다.
> 실질적인 접근 통제는 Supabase Auth + 멤버 확인이 담당합니다.

### 공유의 한계: 동일 provider 간에만 가능

| 케이스 | 가능 여부 |
|--------|---------|
| A(구글) → B(구글) 공유 | ✅ 가능 |
| A(MS) → B(MS) 공유 | ✅ 가능 |
| A(구글) → B(MS) 공유 | ❌ 불가 |
| A(MS) → B(구글) 공유 | ❌ 불가 |

> **이유**: Google Drive 파일은 Google 계정만 접근 가능. MS OneDrive 파일은 MS 계정만 접근 가능.  
> 서로 다른 드라이브 서비스 간 파일 접근은 기술적으로 불가능합니다.
>
> **앱 처리**: 초대 수락 시 provider 불일치 감지 →  
> "이 가계부는 Google 계정으로만 접근할 수 있습니다. Google로 로그인해주세요." 안내

---

## 데이터 모델 (Supabase PostgreSQL)

```sql
-- 가계부 레지스트리 (파일 위치 + 소유자)
CREATE TABLE ledgers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,                          -- "우리집 가계부"
  owner_id         UUID REFERENCES auth.users,
  drive_provider   TEXT CHECK (drive_provider IN ('google', 'microsoft')),
  drive_file_id    TEXT NOT NULL,  -- Google Drive file ID or OneDrive item ID
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- 가계부 멤버 (공유 권한)
CREATE TABLE ledger_members (
  ledger_id   UUID REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES auth.users,
  role        TEXT CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (ledger_id, user_id)
);

-- 초대 링크 토큰
CREATE TABLE ledger_invites (
  token       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  ledger_id   UUID REFERENCES ledgers(id) ON DELETE CASCADE,
  role        TEXT CHECK (role IN ('editor', 'viewer')),
  created_by  UUID REFERENCES auth.users,
  expires_at  TIMESTAMPTZ,   -- NULL이면 만료 없음
  max_uses    INT DEFAULT 1, -- NULL이면 무제한
  use_count   INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now()
);
```

---

## 초대 링크 공유 흐름

```
[가계부 설정 > 공유]
    → 역할 선택 (편집자 / 뷰어)
    → "초대 링크 생성" 클릭
        → Drive 파일에 "링크 공유" 권한 설정 (Drive API 호출)
        → Supabase ledger_invites에 토큰 생성
        → 링크 클립보드 복사

초대 링크: https://앱주소/invite/{token}

[수신자가 링크 오픈]
    ├── 미로그인
    │     → 로그인 페이지 이동 (redirect_to 파라미터로 /invite/:token 기억)
    │     → 로그인 완료 후 /invite/:token으로 자동 복귀
    │
    └── 로그인됨
          → Supabase에서 토큰 조회 → 가계부 이름·역할 확인
          ├── provider 불일치 → "Google 계정으로만 접근 가능합니다" 안내
          ├── 이미 멤버 → /ledgers/:id로 바로 이동
          └── 신규 멤버
                → "우리집 가계부에 [편집자]로 참여하시겠습니까?" 팝업
                → 확인 → ledger_members에 추가 → /ledgers/:id 이동
                → 거절 → /ledgers로 이동
```

### 초대 링크 옵션

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| 만료 기간 | 없음 | 선택적으로 7일·30일 설정 가능 |
| 사용 횟수 | 1회 | 가족 초대 시 무제한으로 변경 가능 |
| 역할 | editor | viewer(읽기 전용)로도 생성 가능 |

---

## 라우팅: react-router-dom 도입

### 현재 방식의 문제

현재 [App.js](../src/components/App/App.js)는 `window.history.pushState` + `popstate` 이벤트를 직접 관리합니다 (~50줄).  
새 페이지(`/ledgers`, `/ledgers/:id`, `/invite/:token`)가 추가되면 이 수동 관리 코드가 급격히 복잡해집니다.

### react-router-dom 도입 이점

| 이점 | 설명 |
|------|------|
| **뒤로가기·앞으로가기 자동 지원** | 현재 수동 `popstate` 처리가 라우터에서 자동 처리됨. 기존 기능 완전 유지 |
| **URL이 앱 상태를 반영** | `/ledgers/abc123` 형태로 북마크·공유 가능 |
| **`useParams()`** | `/ledgers/:id`에서 ledger ID를 URL에서 직접 읽음. prop drilling 제거 |
| **`useNavigate()`** | 선언적 네비게이션. 현재 수동 `navigate()` 함수 대체 |
| **초대 링크 처리** | `/invite/:token` route 자연스럽게 추가 가능 |
| **Protected Route** | 로그인 여부에 따른 자동 리디렉트 패턴이 깔끔해짐 |
| **코드 감소** | `navRef`, `historyInitialized`, `applyNavState`, `navigate` 등 ~50줄 제거 |

### 라우팅 구조

```
/                   → 로그인 상태면 /ledgers로, 아니면 /login
/login              → LoginPage (Google / Microsoft 버튼)
/ledgers            → LedgerListPage (로그인 필수)
/ledgers/:id        → 가계부 내부 (로그인 + 접근권한 필수)
/invite/:token      → 초대 수락 페이지 (로그인 후 처리)
```

가계부 내부(`/ledgers/:id`)의 탭 전환(거래내역·요약·설정)은 URL 변경 없이 내부 state로 유지  
→ 브라우저 뒤로가기는 가계부 목록(`/ledgers`)으로 이동

---

## 페이지 흐름

```
[로그인 페이지]  /login
  - Google로 로그인
  - Microsoft로 로그인
    |
    ▼
[가계부 목록 페이지]  /ledgers
  - 가계부 0개: "새 가계부 만들기" 안내
  - 가계부 1개: 자동으로 /ledgers/:id 이동
  - 가계부 N개: 목록 표시, 탭하면 이동
    |
    ▼
[가계부 내부]  /ledgers/:id
  - 헤더: [목록] 우리집 가계부  [저장] [↺]
  - 하단 탭: 거래내역 / 요약 / + / 가져오기 / 설정
```

---

## 가계부 목록 페이지 UI (모바일 우선)

```
┌─────────────────────┐
│  지금 가계부  [로그아웃]│
├─────────────────────┤
│  내 가계부           │
│  ┌─────────────────┐│
│  │ 우리집 가계부    ││  ← 탭하면 /ledgers/:id 이동
│  │ 4명  │  owner   ││
│  └─────────────────┘│
│  ┌─────────────────┐│
│  │ 여행 가계부      ││
│  │ 2명  │  editor  ││
│  └─────────────────┘│
│                     │
│  [+ 새 가계부 만들기]│
└─────────────────────┘
```

---

## 헤더 변경 (가계부 내부)

```
┌──────────────────────────────────┐
│ [목록] 우리집 가계부  [저장] [↺] │
└──────────────────────────────────┘
```

- **[목록]** 버튼: `/ledgers`로 이동 (브라우저 뒤로가기와 동일한 효과)
- 가계부 이름: 현재 어떤 가계부인지 표시
- [저장][↺]: 기존과 동일

---

## 컴포넌트/파일 구조 변경

```
src/
├── auth/
│   ├── msalConfig.js           (유지)
│   ├── googleAuthConfig.js     (신규: Google OAuth PKCE 설정)
│   ├── supabaseClient.js       (신규: Supabase 초기화)
│   └── authHelpers.js          (신규: provider 통합 로그인 함수)
│
├── pages/                      (신규 폴더)
│   ├── LoginPage/              (기존 LoginPage 이전 + Google 버튼 추가)
│   ├── LedgerListPage/         (신규: 가계부 목록)
│   └── InvitePage/             (신규: 초대 수락)
│
├── services/
│   ├── oneDriveService.js      (유지, 경로 변경: ledgers/{id}.db)
│   ├── googleDriveService.js   (신규: Google Drive 읽기/쓰기/공유)
│   ├── driveService.js         (신규: provider 분기 래퍼)
│   └── ledgerService.js        (신규: Supabase 가계부 CRUD, 멤버·초대 관리)
│
└── components/App/
    └── App.js                  (수정: ledgerId를 useParams()로 수신, drive 추상화)
```

---

## 단계별 구현 계획

**원칙**: 각 단계 완료 후 앱이 정상 작동해야 합니다. 언제든 멈출 수 있고 이전 단계로 되돌릴 수 있습니다.

---

### 준비 단계 (코드 변경 없음)

#### 준비-A: react-router-dom 설치

```bash
npm install react-router-dom
```

변경 파일 없음. 다음 단계에서 함께 적용.

---

#### 준비-B: Supabase 프로젝트 세팅 (대시보드 작업)

1. [supabase.com](https://supabase.com) 에서 프로젝트 생성
2. Authentication → Providers → Azure 활성화 (기존 Azure Client ID 입력)
3. SQL Editor에서 테이블 생성:

```sql
CREATE TABLE ledgers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  owner_id         UUID REFERENCES auth.users,
  drive_provider   TEXT CHECK (drive_provider IN ('google', 'microsoft')),
  drive_file_id    TEXT NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ledger_members (
  ledger_id   UUID REFERENCES ledgers(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES auth.users,
  role        TEXT CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (ledger_id, user_id)
);

CREATE TABLE ledger_invites (
  token       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  ledger_id   UUID REFERENCES ledgers(id) ON DELETE CASCADE,
  role        TEXT CHECK (role IN ('editor', 'viewer')),
  created_by  UUID REFERENCES auth.users,
  expires_at  TIMESTAMPTZ,
  max_uses    INT DEFAULT 1,
  use_count   INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now()
);
```

4. Project Settings → API → `anon key`, `project URL` 메모

코드 변경 없음. 앱 동작 변화 없음.

---

### 단계 1: react-router-dom 도입 + MSAL → Supabase Auth 교체

> **이 단계가 전체 중 가장 큰 변화입니다. 이후 모든 단계의 기반.**

**변경 파일:**
- `src/index.js` — MsalProvider 제거, BrowserRouter + SupabaseProvider 추가
- `src/auth/msalConfig.js` → `src/auth/supabaseClient.js` 로 교체
- `src/components/App/App.js` — `useMsal()` → `supabase.auth.getSession()`, 수동 navigate → `useNavigate()`
- `src/services/oneDriveService.js` — `instance.acquireTokenSilent()` → `session.provider_token`
- `src/components/LoginPage/LoginPage.js` — `instance.loginRedirect()` → `supabase.auth.signInWithOAuth({ provider: 'azure' })`
- `package.json` — `@azure/msal-browser`, `@azure/msal-react` 제거, `@supabase/supabase-js` 추가

**사용자가 보는 변화:**
- MS 로그인 버튼 동작 방식이 약간 바뀜 (Azure 로그인 페이지 경유는 동일)
- 로그인 후 앱 동작: 동일

**주의사항:**
- Supabase Auth의 `provider_token` (MS Graph API 토큰)은 1시간 후 만료됨
- 초기 구현: 만료 시 "다시 로그인 필요" 메시지 표시 (MSAL의 자동 갱신은 나중에 구현)
- Azure 앱 등록에서 redirect URI에 Supabase 콜백 URL 추가 필요

**위험도:** 높음 | **롤백:** MSAL 코드 복원 가능

---

### 단계 2: OneDrive 경로 다중화 + 기존 파일 자동 마이그레이션

**변경 파일:**
- `src/config.js` — 고정 경로 상수 제거
- `src/services/oneDriveService.js` — 경로를 파라미터로 받도록 변경
- `src/services/ledgerService.js` (신규) — Supabase 레지스트리 CRUD
- `src/components/App/App.js` — 로드 시 마이그레이션 감지 로직 추가

**마이그레이션 로직 (최초 1회):**
```
로그인 후:
1. Supabase에서 내 ledgers 조회
2. 결과 없음 → "기존 파일 마이그레이션 모드"
   a. OneDrive에서 Apps/financial-ledger/ledger.db 조회
   b. 파일 있음 → 내용 읽기 → Apps/financial-ledger/ledgers/{new_uuid}.db 에 쓰기
   c. Supabase ledgers 테이블에 등록 (name: "우리집 가계부", drive_file_id: new file ID)
   d. ledger_members에 owner로 등록
3. 결과 있음 → 정상 진행
```

**사용자가 보는 변화:** 없음 (자동 처리, 첫 로그인 시 1~2초 추가 소요)

**위험도:** 중간 (기존 파일 복사 후 원본 유지, 삭제 안 함) | **롤백:** 가능

---

### 단계 3: 가계부 목록 페이지 (LedgerListPage)

**변경 파일:**
- `src/pages/LedgerListPage/LedgerListPage.js` (신규)
- `src/components/App/App.js` — 라우팅 연결
- `src/components/Header/Header.js` — [목록] 버튼 + 가계부 이름 추가

**동작:**
- 가계부가 1개이면 → 자동으로 `/ledgers/:id` 이동 (사용자는 목록 페이지를 거의 못 봄)
- 가계부가 N개이면 → 목록 표시

**사용자가 보는 변화:**
- 현재 사용자(1개 가계부): 체감 변화 없음
- 헤더에 [목록] 버튼, 가계부 이름 표시 추가

**위험도:** 낮음 | **롤백:** 가능

---

### 단계 4: 새 가계부 만들기

**변경 파일:**
- `src/pages/LedgerListPage/LedgerListPage.js` — "새 가계부 만들기" 버튼 활성화
- `src/services/oneDriveService.js` — 신규 파일 생성 함수
- `src/services/ledgerService.js` — Supabase 등록 함수

**동작:**
- 이름 입력 → OneDrive에 빈 DB 파일 생성 → Supabase에 등록 → 해당 가계부로 이동

**사용자가 보는 변화:** 가계부 목록에서 새 가계부 생성 가능

**위험도:** 낮음 | **롤백:** 가능

---

### 단계 5: Google 로그인 + Google Drive 연동

**변경 파일:**
- `src/services/googleDriveService.js` (신규) — Google Drive API 읽기/쓰기
- `src/services/driveService.js` (신규) — provider별 분기 (`if microsoft → oneDrive, if google → googleDrive`)
- `src/components/App/App.js` — oneDriveService → driveService로 교체
- `src/pages/LoginPage/LoginPage.js` — Google 로그인 버튼 추가
- Supabase 대시보드 — Google provider 활성화

**Google Drive scope:**
```
https://www.googleapis.com/auth/drive.file
```
(앱이 생성한 파일만 접근 — 최소 권한)

**사용자가 보는 변화:** 로그인 페이지에 Google 버튼 추가

**위험도:** 중간 | **롤백:** 가능 (Google 버튼만 제거하면 됨)

---

### 단계 6: 공유 — 초대 링크 생성

**변경 파일:**
- `src/components/SettingsView/SettingsView.js` — 공유 섹션 추가
- `src/services/ledgerService.js` — invite 토큰 생성
- `src/services/oneDriveService.js` / `googleDriveService.js` — "링크 공유" 설정 API 추가

**동작:**
- 설정 → 공유 → 역할 선택 → "링크 복사"
- 동시에: Drive 파일에 "링크 보유자 편집/뷰 가능" 권한 설정
- Supabase `ledger_invites`에 토큰 저장

**사용자가 보는 변화:** 설정에 공유 섹션 추가

**위험도:** 낮음 | **롤백:** 가능

---

### 단계 7: 공유 — 초대 수락 (InvitePage)

**변경 파일:**
- `src/pages/InvitePage/InvitePage.js` (신규)
- 라우팅에 `/invite/:token` 추가

**동작:**
- 링크 열기 → 로그인 확인 → provider 일치 확인 → 참여 확인 팝업
- 수락 시: `ledger_members`에 추가 → `/ledgers/:id`로 이동

**사용자가 보는 변화:** 초대 링크로 가계부 참여 가능

**위험도:** 낮음 | **롤백:** 가능

---

### 단계별 요약

| 단계 | 내용 | 변화 체감 | 위험도 | 전제 |
|------|------|-----------|--------|------|
| 준비-A/B | 라이브러리 설치 + Supabase 세팅 | 없음 | 없음 | - |
| **1** | **MSAL → Supabase Auth + router 도입** | 로그인 방식 소폭 변경 | **높음** | 준비 완료 |
| 2 | OneDrive 경로 다중화 + 자동 마이그레이션 | 없음 | 중간 | 1 완료 |
| 3 | 가계부 목록 페이지 | 헤더 변경 | 낮음 | 2 완료 |
| 4 | 새 가계부 만들기 | 목록에서 생성 버튼 | 낮음 | 3 완료 |
| 5 | Google 로그인 + Google Drive | 로그인 버튼 추가 | 중간 | 3 완료 |
| 6 | 초대 링크 생성 | 설정에 공유 섹션 | 낮음 | 4 완료 |
| 7 | 초대 수락 페이지 | 링크로 참여 가능 | 낮음 | 6 완료 |

> 단계 4 완료 시점이면 MS 계정만으로 다중 가계부 사용 가능한 완성된 앱입니다.  
> 단계 5 이후는 Google 지원 및 공유 확장입니다.

---

## 미결 결정 사항

1. **단계 1 토큰 갱신**: Supabase의 `provider_token`(MS Graph 토큰)은 1시간 후 만료됩니다.  
   초기엔 만료 시 재로그인 안내로 처리하고, 추후 자동 갱신 구현 예정.
