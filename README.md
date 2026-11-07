# 지금 가계부

가족이 함께 쓰는 모바일 우선 가계부 웹앱입니다. 서버 없이 브라우저에서 동작합니다(React 18 + Vite).

- **저장소:** 가계부 DB(SQLite) 파일 하나를 각자의 Microsoft 계정 OneDrive(`Apps/financial-ledger/ledger.db`)에 둡니다.
- **동작 방식:** 브라우저에서 sql.js로 이 파일을 열어 씁니다.
- **동시 사용:** 여러 기기에서 동시에 써도, 저장할 때 서로의 변경을 합칩니다.

## 주요 기능

- 거래 입력: 사칙연산 금액 입력, 분할 결제, 연속 입력, 즐겨찾기
- AI 입력: 영수증 사진, 말로 입력, 카드 내역 대조
- 요약: 월·연·기간·일정별 요약, 월 목표
- 캘린더와 일정: 여행 환율, 현금 지갑 관리
- 계좌: 잔액 예측, 고정 입출금 자동등록(공휴일 보정)
- 가져오기: 엑셀·JSON 거래 내역, 계좌 CSV

## 시작하기

```bash
npm install
npm start          # 개발 서버 http://localhost:3000 (Vite)
npm test           # Vitest
npm run lint       # ESLint, 경고 0이어야 함
npm run build      # build/ 에 배포용 결과물
```

Azure 앱 등록과 OneDrive 설정은 [SETUP.md](SETUP.md)를 참고하세요.

## 문서

| 파일 | 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | 코드 작성 규칙. AI 도구와 사람 모두 작업 전에 읽습니다 |
| [docs/BUGS.md](docs/BUGS.md) | 버그·개선 목록과 수정 기록 (B-xxx / I-xxx) |
| [SETUP.md](SETUP.md) | Azure 앱 등록, 배포 설정 |
| [IMPORT_GUIDE.md](IMPORT_GUIDE.md) | 엑셀·JSON 가져오기 형식 |
| docs/*-design.md | 기능별 설계 문서 |
