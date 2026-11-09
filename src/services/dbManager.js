// 가계부 DB 접근 함수 모음 — 실제 구현은 src/services/db/*.js에 기능별로 나뉘어 있다 (I-004).
// 화면·서비스는 계속 이 파일에서 import한다. 새 함수는 해당 db 모듈에 추가하면 여기로 자동으로 내보내진다.
// (db/common·db/recurringDates는 내부 도우미 모듈이라 공개 함수만 골라 내보낸다)

export * from './db/schema';
export * from './db/transactions';
export * from './db/masterData';
export * from './db/discounts';
export * from './db/calendar';
export * from './db/tripCash';
export * from './db/summary';
export * from './db/settings';
export * from './db/recurring';
export * from './db/favorites';
export * from './db/patterns';
export * from './db/accounts';
export * from './db/members';
export * from './db/categoryBudgets';
export * from './db/monthlyBalance';
export * from './db/subscriptions';
export * from './db/monthlyReport';
export * from './db/taxSummary';
export * from './db/tripSplit';
export { withTransaction, hasForeignAmount } from './db/common';
