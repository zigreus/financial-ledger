# 지금 가계부 - 설정 가이드

이 앱은 **Microsoft 계정 로그인 + OneDrive 저장** 방식으로 동작합니다.
가계부 데이터(SQLite DB)가 OneDrive에 저장되므로, 가족 구성원 모두 같은 Microsoft 계정으로 로그인하면 동기화됩니다.

---

## 아키텍처 요약

```
브라우저 (React + sql.js)
  ↕ MSAL 인증 (Microsoft 로그인 — 리다이렉트 방식)
Microsoft Graph API
  ↕
OneDrive: Apps/financial-ledger/ledger.db
```

- DB는 sql.js로 브라우저 메모리에서 실행
- 변경하면 자동 저장: `ledger.db`를 eTag 조건부(If-Match)로 PUT
- 다른 기기가 먼저 저장했으면(412) 최신 파일을 받아 내 변경을 다시 적용해 합친 뒤 저장
- 로드 시 OneDrive에서 `ledger.db` 파일을 GET (자세한 내용: `src/hooks/useLedgerSync.js`)

---

## 1. Azure 앱 등록 (최초 1회)

### 1-1. 앱 등록

1. [https://portal.azure.com](https://portal.azure.com) 접속
2. 상단 검색창에 **"앱 등록"** 검색 → **앱 등록** 클릭
3. **+ 새 등록** 클릭
4. 설정:
   - **이름**: `financial-ledger` (아무 이름이나 가능)
   - **지원되는 계정 유형**: `모든 조직 디렉터리의 계정 및 개인 Microsoft 계정` 선택
     - (= "공통" tenant, 개인 Microsoft 계정도 허용)
   - **리디렉션 URI**: 일단 비워두고 등록 (다음 단계에서 추가)
5. **등록** 클릭

### 1-2. Client ID 복사

- 앱 등록 완료 후 **개요** 탭에서 **애플리케이션(클라이언트) ID** 복사
- 이 값을 `src/config.js`의 `AZURE_CLIENT_ID`에 붙여넣기

```js
// src/config.js
export const AZURE_CLIENT_ID = '여기에-붙여넣기';
```

### 1-3. 리디렉션 URI 설정

1. 왼쪽 메뉴 → **인증** (Authentication) 클릭
2. **+ 플랫폼 추가** 클릭
3. **단일 페이지 애플리케이션 (SPA)** 선택
4. 리디렉션 URI 추가 (두 개 모두 등록):
   - `http://localhost:3000` ← 개발용
   - `https://financial-ledger-five.vercel.app` ← Vercel 프로덕션용
5. **구성** 클릭 후 저장

> **주의**: 플랫폼을 반드시 **SPA**로 선택해야 합니다. "웹"으로 선택하면 인증 방식이 달라져서 로그인(리디렉션 방식)이 동작하지 않습니다.

### 1-4. API 권한 확인

1. 왼쪽 메뉴 → **API 권한** 클릭
2. 아래 두 권한이 있는지 확인 (없으면 추가):
   - `Microsoft Graph` → `Files.ReadWrite` (OneDrive 파일 읽기/쓰기)
   - `Microsoft Graph` → `User.Read` (로그인한 사용자 정보)
3. 권한 추가 방법: **+ 권한 추가** → Microsoft Graph → 위임된 권한 → 검색해서 추가
4. **[테넌트명]에 대한 관리자 동의 허용** 버튼은 클릭하지 않아도 됨
   - 개인 계정은 로그인 시 사용자가 직접 동의함

---

## 2. 코드 설정

### 2-1. `src/config.js`

```js
export const AZURE_CLIENT_ID = '9eaaf1b0-...'; // Azure에서 복사한 Client ID
export const ONEDRIVE_DB_PATH = 'Apps/financial-ledger/ledger.db'; // 변경 불필요
```

- `ONEDRIVE_DB_PATH`는 OneDrive 내 저장 경로로, 변경하지 않아도 됩니다.
- OneDrive에 `Apps/financial-ledger/` 폴더가 없어도 자동 생성됩니다.

---

## 3. 로컬 개발 환경 실행 (개발 시)

```bash
# 의존성 설치
npm install

# 개발 서버 실행 (http://localhost:3000, Vite)
npm start
```

- 브라우저에서 `http://localhost:3000` 접속
- **Microsoft 계정으로 로그인** 버튼 클릭 → Microsoft 로그인 페이지로 이동했다가 앱으로 돌아옴
- 최초 로그인 시 OneDrive 접근 권한 동의 필요
- 포트는 3000번 고정입니다(Azure 리디렉션 URI와 맞춤). 3000번이 사용 중이면 다른 포트로 바꾸지 않고 오류로 멈추므로, 사용 중인 프로그램을 먼저 종료하세요.
- 테스트·검사·빌드 명령은 [README.md](README.md#시작하기)를 참고하세요.

---

## 4. Vercel 배포 (프로덕션)

### 4-1. Vercel 프로젝트 연결

1. [https://vercel.com](https://vercel.com) 접속 → **GitHub으로 로그인**
2. **Add New Project** → GitHub 레포지토리(`financial-ledger`) 선택
3. **Import** 클릭

### 4-2. 빌드 설정

저장소의 `vercel.json`에 빌드 설정이 들어 있어 대시보드에서 바꿀 것이 없습니다:

| 항목 | 값 |
|------|----|
| Framework Preset | Vite |
| Build Command | `npm run build` |
| Output Directory | `build` |
| Install Command | `npm install` |

**Deploy** 클릭 → 자동 빌드 및 배포

배포 완료 후 URL: `https://financial-ledger-five.vercel.app`

### 4-3. 이후 업데이트 배포

- `main` 브랜치에 push하면 Vercel이 **자동으로 재배포**
- 수동 배포: Vercel 대시보드 → 프로젝트 → **Redeploy**

### 4-4. 환경변수 설정 (현재 불필요)

- `AZURE_CLIENT_ID`는 현재 `src/config.js`에 하드코딩되어 있어 별도 환경변수 설정 불필요
- 환경변수로 옮기려면: Vercel 대시보드 → Settings → **Environment Variables**에 `VITE_AZURE_CLIENT_ID`를 추가하고 코드에서 `import.meta.env.VITE_AZURE_CLIENT_ID`로 읽습니다.
  - Vite는 `VITE_`로 시작하는 값만 브라우저 코드에 넣습니다. `process.env`는 브라우저에 없습니다.

---

## 5. OneDrive 데이터 위치

- 로그인 후 모든 데이터는 OneDrive에 자동 저장됩니다.
- 파일 경로: `내 OneDrive > Apps > financial-ledger > ledger.db`
- 이 파일을 직접 백업하거나 다른 기기로 복사할 수 있습니다. 앱에는 별도의 내보내기 기능이 없으므로, 백업은 이 파일을 복사해 둡니다.
- 잘못 저장했을 때는 OneDrive 웹의 **버전 기록**에서 이전 파일로 되돌릴 수 있습니다.

---

## 6. AI 기능 (선택)

- 영수증 사진 분석, 말로 입력, 카드 내역 대조에 AI를 씁니다. 쓰지 않으면 설정할 필요가 없습니다.
- 앱의 **설정 > AI**에서 공급자(Gemini 또는 Claude)를 고르고 API 키를 입력합니다.
  - Gemini: Google AI Studio(aistudio.google.com/app/apikey)에서 무료로 발급
  - Claude: Anthropic Console(console.anthropic.com)의 API Keys에서 발급(사용량만큼 과금)
- API 키는 **이 기기의 브라우저(localStorage)에만** 저장됩니다. 가족이 함께 쓰는 DB에는 저장하지 않으므로, 기기마다 따로 입력합니다.

---

## 7. 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `redirect_uri_mismatch` 오류 | Azure에 현재 URL 미등록 | 인증 탭에서 URI 추가 |
| `AADSTS50011` 오류 | 동일한 원인 | 위와 동일 |
| 로그인 후 데이터가 없음 | 새 DB 생성됨 (정상) | 기존 `.db` 파일을 OneDrive에 업로드 |
| 가족이 입력한 내용이 안 보임 | 서로 다른 Microsoft 계정으로 로그인 | 같은 계정으로 로그인 (DB는 로그인한 계정의 OneDrive에 있음) |
| "더 새 버전의 앱에서 저장되었습니다" | 다른 기기가 새 버전 앱으로 DB를 저장함 | 페이지를 새로고침해 앱을 업데이트 |
| 헤더에 '저장 안 됨 N'이 계속 보임 | 네트워크 오류 등으로 저장 실패 | 연결 확인 후 🔄. 미저장 변경은 브라우저에 보관되어 다음 저장 때 반영 |
| `npm start` 시 포트 3000 오류 | 3000번 포트 사용 중 | 사용 중인 프로그램 종료 (포트는 바꾸지 않음) |
| `src/config.js` 설정 경고 | CLIENT_ID 미설정 | 1-2 단계 참고 |
