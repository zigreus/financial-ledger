@AGENTS.md

# Claude Code 메모

- 위 AGENTS.md의 규칙을 모든 작업의 기본으로 따릅니다.
- 버그를 고치면 docs/BUGS.md에 `문제 / 원인 / 해결` 각 1줄로 기록하고 요약표 상태도 갱신합니다.
- 저장·동기화(useLedgerSync, changeLog, oneDriveService)를 바꿀 때는 `src/services/__tests__/changeLog.test.js`를 먼저 읽고, 병합 시나리오 테스트를 함께 고칩니다.
