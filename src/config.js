// ============================================================
// Azure AD 앱 등록 설정
// Azure Portal(https://portal.azure.com)에서 앱 등록 후 값을 넣습니다. 등록 방법: SETUP.md 참고
// 개발·운영 앱 등록을 나누려면 Vite 환경값 VITE_AZURE_CLIENT_ID로 덮어씁니다(.env.local·Vercel 환경 변수, I-038).
// 없으면 아래 기본값(지금 운영 중인 앱 등록)을 씁니다.
// ============================================================
export const AZURE_CLIENT_ID = (import.meta.env && import.meta.env.VITE_AZURE_CLIENT_ID)
  || '9eaaf1b0-6f99-488d-9ca0-e74468bbea52';

// OneDrive 내 DB 파일 경로 (변경 불필요 — 바꾸면 기존 가계부를 찾지 못한다)
export const ONEDRIVE_DB_PATH = 'Apps/financial-ledger/ledger.db';

// ============================================================
// 출시 정보 (I-038, ROADMAP M-5)
// 바꾸면 public/privacy.html·public/terms.html의 같은 값도 함께 고칩니다(로그인 없이 보는 정적 페이지라 이 값을 읽지 못함).
// ============================================================
/** 개인정보처리방침·이용약관 — public/의 정적 페이지(로그인 없이, 앱을 받지 않고도 열린다) */
export const PRIVACY_URL = '/privacy.html';
export const TERMS_URL = '/terms.html';
/** 처리방침·약관에 적는 운영자 이름 — 정하기 전까지는 앱 이름 (할 일: ROADMAP M-5) */
export const OPERATOR_NAME = '지금 가계부';
/** 공개 문의 메일 — 문의 전용 주소를 만들면 넣는다. 비어 있으면 '문제 알리기'는 복사만 하고 메일 버튼을 숨긴다 (할 일: ROADMAP M-5) */
export const CONTACT_EMAIL = '';
