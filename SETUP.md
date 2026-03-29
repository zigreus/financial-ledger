# 우리 가계부 - 설정 가이드

이 앱은 **Microsoft 계정 로그인 + OneDrive 저장** 방식으로 동작합니다.
가계부 데이터(SQLite DB)가 OneDrive에 저장되므로, 가족 구성원 모두 같은 Microsoft 계정으로 로그인하면 동기화됩니다.

---

## 아키텍처 요약

```
브라우저 (React + sql.js)
  ↕ MSAL 인증 (Microsoft 로그인 팝업)
Microsoft Graph API
  ↕
OneDrive: Apps/financial-ledger/ledger.db
```

- DB는 sql.js로 브라우저 메모리에서 실행
- 저장 시 `ledger.db` 파일을 OneDrive에 PUT
- 로드 시 OneDrive에서 `ledger.db` 파일을 GET

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

> **주의**: 플랫폼을 반드시 **SPA**로 선택해야 합니다. "웹"으로 선택하면 인증 방식이 달라져서 팝업 로그인이 동작하지 않습니다.

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

# 개발 서버 실행 (http://localhost:3000)
npm start
```

- 브라우저에서 `http://localhost:3000` 접속
- **Microsoft 계정으로 로그인** 버튼 클릭 → 팝업으로 Microsoft 로그인
- 최초 로그인 시 OneDrive 접근 권한 동의 필요

---

## 4. Vercel 배포 (프로덕션)

### 4-1. Vercel 프로젝트 연결

1. [https://vercel.com](https://vercel.com) 접속 → **GitHub으로 로그인**
2. **Add New Project** → GitHub 레포지토리(`financial-ledger`) 선택
3. **Import** 클릭

### 4-2. 빌드 설정

Vercel이 React 앱을 자동 감지하므로 별도 변경 불필요:

| 항목 | 값 |
|------|----|
| Framework Preset | Create React App |
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
- 보안이 필요한 경우: Vercel 대시보드 → Settings → **Environment Variables**에 추가 후 코드에서 `process.env.REACT_APP_CLIENT_ID`로 참조

---

## 5. OneDrive 데이터 위치

- 로그인 후 모든 데이터는 OneDrive에 자동 저장됩니다.
- 파일 경로: `내 OneDrive > Apps > financial-ledger > ledger.db`
- 이 파일을 직접 백업하거나 다른 기기로 복사할 수 있습니다.
- 앱 내 **설정 > 내보내기(JSON)** 기능으로 데이터를 JSON으로 내보낼 수도 있습니다.

---

## 6. 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| 로그인 팝업이 뜨지 않음 | 팝업 차단 | 브라우저 팝업 허용 설정 |
| `redirect_uri_mismatch` 오류 | Azure에 현재 URL 미등록 | 인증 탭에서 URI 추가 |
| `AADSTS50011` 오류 | 동일한 원인 | 위와 동일 |
| 로그인 후 데이터가 없음 | 새 DB 생성됨 (정상) | 기존 `.db` 파일을 OneDrive에 업로드 |
| `src/config.js` 설정 경고 | CLIENT_ID 미설정 | 1-2 단계 참고 |
