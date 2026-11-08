// 수입·월 수지 (I-026, ROADMAP C-6 1안) — 선택 기능: 설정에서 켜야 화면에 보인다(가족 공통 설정).
//
// 수입 = 수입으로 세는 계좌의 그 달 입금(account_transactions.type = 'income').
//  - 계좌마다 고른다(accounts.count_income): NULL이면 자동 — 반복 수입 항목(월급 등)이 있는(있었던) 계좌만 센다. 1 셈, 0 세지 않음.
//    반복 항목을 지우거나(이직) 계좌를 지워도(쓰지 않음) 지난 달 수입은 그대로 센다 — 지난 달 수지가 바뀌지 않게.
//    다만 지운 계좌의 앞으로의 자동 예정은 세지 않는다(월급 계좌를 바꾸면 새 계좌 월급과 겹치므로).
//    저축 계좌·내 계좌끼리 옮긴 돈처럼 수입이 아닌 입금이 있는 계좌는 끈다.
//  - 여행 현금 흐름이 만든 입금(재환전·남은 현금)은 내 돈이 돌아온 것이라 세지 않는다.
//  - 반복 항목이 자동 등록한 예정 금액도 센다 — 월급이 들어와 실제 금액으로 고치면 그 금액이 된다(달마다 조금씩 달라도).
//    아직 오지 않은(오늘 뒤) 입금은 upcoming, 날짜는 지났지만 금액을 고치지 않은 예정 입금은 unconfirmed로 따로 알린다.
//  - 어느 달 몫인지: 자동 등록 항목은 그 몫의 달(recurring_month — 휴일 보정으로 날짜가 다음 달이 돼도), 나머지는 날짜의 달.
// 지출 = 가계부의 순지출(amount - discount_amount, AGENTS §4) — 요약의 '총액'과 같다.
//  카드 대금처럼 계좌에서 나가는 돈은 가계부 지출과 겹치므로 세지 않는다.
// 남은 돈 = 수입 - 지출, 저축률 = 남은 돈 / 수입(수입이 없으면 없음).

import { dbRowsToObjects } from './common';
import { getSetting, setSetting } from './settings';
import { CASH_FLOW_ACCOUNT_CATEGORY } from './tripCash';
import { todayStr } from '../dateUtils';

export const MONTHLY_BALANCE_SETTING = 'monthly_balance_enabled';

export function isMonthlyBalanceEnabled(db) {
  return !!db && getSetting(db, MONTHLY_BALANCE_SETTING, '0') === '1';
}

export function setMonthlyBalanceEnabled(db, enabled) {
  setSetting(db, MONTHLY_BALANCE_SETTING, enabled ? '1' : '0');
}

// 반복 수입 항목이 있는(있었던) 계좌인지 — a: accounts 별칭
const HAS_INCOME_ITEM_SQL = `EXISTS (
  SELECT 1 FROM account_recurring_items r WHERE r.account_id = a.id AND r.type = 'income'
)`;
// 그 계좌를 수입으로 세는지
const COUNTED_SQL = `(a.count_income = 1 OR (a.count_income IS NULL AND ${HAS_INCOME_ITEM_SQL}))`;

// 수입으로 셀 수 있는 입금 — t: account_transactions, a: accounts 별칭. 바인딩: [여행 현금 분류, 오늘]
//  - 여행 현금 흐름이 만든 입금(재환전·남은 현금)은 빼고,
//  - 지운 계좌의 앞으로의(오늘 뒤) 자동 예정은 뺀다 — 계좌를 지우면 이 예정은 지워지고(deleteAccount),
//    그 전 버전·예전 버전 기기로 지운 계좌에 남은 것은 불러올 때 지운다(schema '지운 계좌의 앞으로 예정 정리').
//    여기서는 그 사이(예전 버전 기기가 막 지운 계좌가 병합된 직후 등)에 월급 계좌를 바꾼 달이 겹치지 않게 막는다.
//    지난 입금은 고치지 않은 예정 그대로여도 센다 — 예정 금액만 적어 두고 확정하지 않는 집이 많아, 빼면 지난 달 수입이 사라진다.
const INCOME_ROW_SQL = `t.type = 'income'
  AND COALESCE(t.category, '') <> ?
  AND t.id NOT IN (SELECT account_tx_id FROM event_cash_flows WHERE account_tx_id IS NOT NULL)
  AND (a.is_active = 1 OR NOT (t.is_auto_generated = 1 AND t.is_modified = 0 AND t.date > ?))`;

/**
 * 수입을 셀지 고를 계좌들 — 쓰는 계좌, 그리고 지운 계좌 중 수입으로 셀 입금이 있는 것(지난 달 수지에 잡히므로 끌 수 있게)
 * [{ id, name, counted, auto, hasRecurringIncome, deleted }] — auto: 직접 고르지 않아 자동(반복 수입이 있으면 셈)인지
 */
export function getIncomeAccounts(db, today = todayStr()) {
  return dbRowsToObjects(db.exec(
    `SELECT a.id, a.name, a.count_income, a.is_active, ${HAS_INCOME_ITEM_SQL} AS has_income
     FROM accounts a
     WHERE a.is_active = 1
        OR EXISTS (SELECT 1 FROM account_transactions t WHERE t.account_id = a.id AND ${INCOME_ROW_SQL})
     ORDER BY a.is_active DESC, a.sort_order, a.id`,
    [CASH_FLOW_ACCOUNT_CATEGORY, today],
  )).map(r => ({
    id: r.id,
    name: r.name,
    hasRecurringIncome: !!r.has_income,
    auto: r.count_income === null || r.count_income === undefined,
    counted: r.count_income === null || r.count_income === undefined ? !!r.has_income : r.count_income === 1,
    deleted: !r.is_active,
  }));
}

/** 계좌의 입금을 수입으로 셀지 — true·false로 직접 고르거나, null이면 자동으로 되돌린다 */
export function setAccountCountsIncome(db, accountId, counted) {
  db.run('UPDATE accounts SET count_income = ? WHERE id = ?', [counted === null ? null : (counted ? 1 : 0), accountId]);
}

/**
 * 달마다 수입 { 'YYYY-MM': { income, upcoming, unconfirmed } }
 *  - upcoming: 그중 오늘 뒤 날짜(아직 오지 않은 예정)
 *  - unconfirmed: 날짜는 지났지만 자동 등록된 예정 금액을 고치지 않은 것(실제 금액이 다를 수 있다)
 *    — 쓰는 계좌만. 지운 계좌의 내역은 더 고칠 수 없으니 고치라고 알리지 않는다
 * months를 주면 그 달들만(없으면 수입이 있는 모든 달)
 */
export function getMonthlyIncome(db, months = null, today = todayStr()) {
  const monthOf = "COALESCE(NULLIF(t.recurring_month, ''), strftime('%Y-%m', t.date))";
  const params = [today, today, CASH_FLOW_ACCOUNT_CATEGORY, today];
  let where = '';
  if (Array.isArray(months)) {
    if (!months.length) return {};
    where = ` AND ${monthOf} IN (${months.map(() => '?').join(', ')})`;
    params.push(...months);
  }
  const res = db.exec(
    `SELECT ${monthOf} AS ym,
            SUM(t.amount) AS income,
            SUM(CASE WHEN t.date > ? THEN t.amount ELSE 0 END) AS upcoming,
            SUM(CASE WHEN t.date <= ? AND t.is_auto_generated = 1 AND t.is_modified = 0 AND a.is_active = 1
                     THEN t.amount ELSE 0 END) AS unconfirmed
     FROM account_transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE ${INCOME_ROW_SQL} AND ${COUNTED_SQL}${where}
     GROUP BY ym`,
    params,
  );
  const map = {};
  (res[0]?.values || []).forEach(([ym, income, upcoming, unconfirmed]) => {
    map[ym] = { income: Number(income) || 0, upcoming: Number(upcoming) || 0, unconfirmed: Number(unconfirmed) || 0 };
  });
  return map;
}

/**
 * 그 달 수지 — { income, upcoming, unconfirmed, spend, left, rate }
 *  - spend: 가계부 순지출(요약의 '총액'), left: income - spend, rate: left / income (수입이 없으면 null)
 */
export function getMonthlyBalance(db, yearMonth, today = todayStr()) {
  const { income = 0, upcoming = 0, unconfirmed = 0 } = getMonthlyIncome(db, [yearMonth], today)[yearMonth] || {};
  const res = db.exec(
    "SELECT COALESCE(SUM(amount), 0) - COALESCE(SUM(discount_amount), 0) FROM transactions WHERE strftime('%Y-%m', date) = ?",
    [yearMonth],
  );
  const spend = Number(res[0]?.values[0][0]) || 0;
  const left = income - spend;
  return { income, upcoming, unconfirmed, spend, left, rate: income > 0 ? left / income : null };
}
