# 지금 가계부

가족이 함께 쓰는 모바일 우선 가계부 웹앱입니다. 서버 없이 브라우저에서 동작합니다(React 18 + Vite).

- **저장소:** 가계부 DB(SQLite) 파일 하나를 로그인한 Microsoft 계정의 OneDrive(`Apps/financial-ledger/ledger.db`)에 둡니다. 가족은 같은 계정으로 로그인해 함께 씁니다.
- **동작 방식:** 브라우저에서 sql.js로 이 파일을 열어 씁니다.
- **저장:** 바꾸면 자동으로 저장합니다. 여러 기기에서 동시에 써도, 저장할 때 서로의 변경을 합칩니다.

## 주요 기능

- 거래 입력: 사칙연산 금액 입력, 분할 결제, 연속 입력, 즐겨찾기
- AI 입력: 영수증 사진, 말로 입력, 카드 내역 대조
- 요약: 월·연·기간·일정별 요약, 월 목표
- 캘린더와 일정: 여행 환율, 현금 지갑 관리
- 계좌: 잔액 예측, 고정 입출금 자동등록(공휴일 보정)
- 가져오기: 거래 내역(JSON·CSV), 계좌 내역(CSV, 은행 양식 칸 이름 지원)

## 시작하기

```bash
npm install
npm start          # 개발 서버 http://localhost:3000 (Vite)
npm test           # Vitest
npm run lint       # ESLint, 경고 0이어야 함
npm run build      # build/ 에 배포용 결과물
npm run preview    # 빌드 결과를 http://localhost:3000 에서 확인
```

Azure 앱 등록, 배포, AI 키 설정은 [SETUP.md](SETUP.md)를 참고하세요.

## 문서

| 파일 | 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | 코드 작성 규칙. AI 도구와 사람 모두 작업 전에 읽습니다 |
| [docs/BUGS.md](docs/BUGS.md) | 버그·개선 목록과 수정 기록 (B-xxx / I-xxx) |
| [SETUP.md](SETUP.md) | Azure 앱 등록, 배포, AI 키, 문제 해결 |
| [IMPORT_GUIDE.md](IMPORT_GUIDE.md) | 거래 내역(JSON·CSV)·계좌 내역(CSV) 가져오기 형식 |
| docs/*-design.md, settings-redesign.md, summary-event-filter-ux-review.md | 기능별 설계 기록. 맨 위 '현재 상태'에 구현 여부와 지금 코드와 다른 점을 적었습니다 |
