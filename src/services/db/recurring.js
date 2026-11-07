// 정기지출 템플릿과 자동등록(빠진 달 보충 포함), 등록 기록.

import { withTransaction } from './common';
import { resolveDay, ymOf } from './recurringDates';
import { evaluateDiscountRule, getDiscountRules } from './discounts';

// ── 정기지출 템플릿 ───────────────────────────────────────────────

export function getRecurringTransactions(db) {
  const res = db.exec(
    `SELECT id, payment_method, budget_category, sub_category, detail, amount, discount_amount, discount_note, frequency, day_of_month, month_of_year, note
     FROM recurring_transactions
     ORDER BY
       CASE frequency WHEN 'monthly' THEN 0 ELSE 1 END,
       COALESCE(month_of_year, 0),
       CASE day_of_month WHEN 0 THEN 32 ELSE day_of_month END`
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function addRecurringTransaction(db, data) {
  db.run(
    `INSERT INTO recurring_transactions (payment_method, budget_category, sub_category, detail, amount, discount_amount, discount_note, frequency, day_of_month, month_of_year, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.payment_method, data.budget_category, data.sub_category || '',
      data.detail || '', data.amount,
      data.discount_amount || 0, data.discount_note || '',
      data.frequency || 'monthly', data.day_of_month ?? 1,
      data.month_of_year || null, data.note || '',
    ]
  );
}

export function updateRecurringTransaction(db, id, data) {
  db.run(
    `UPDATE recurring_transactions SET payment_method=?, budget_category=?, sub_category=?, detail=?, amount=?, discount_amount=?, discount_note=?, frequency=?, day_of_month=?, month_of_year=?, note=? WHERE id=?`,
    [
      data.payment_method, data.budget_category, data.sub_category || '',
      data.detail || '', data.amount,
      data.discount_amount || 0, data.discount_note || '',
      data.frequency || 'monthly', data.day_of_month ?? 1,
      data.month_of_year || null, data.note || '', id,
    ]
  );
}

export function deleteRecurringTransaction(db, id) {
  db.run('DELETE FROM recurring_transactions WHERE id = ?', [id]);
  db.run('DELETE FROM recurring_registration_log WHERE recurring_id = ?', [id]);
}

export function getRegistrationLog(db) {
  const res = db.exec('SELECT recurring_id, registered_for_month FROM recurring_registration_log ORDER BY registered_for_month DESC');
  if (!res.length) return {};
  const map = {};
  res[0].values.forEach(([rid, ym]) => {
    if (!map[rid]) map[rid] = new Set();
    map[rid].add(ym);
  });
  return map;
}

// ── 자동등록 ─────────────────────────────────────────────────────

function nextYm(ym) {
  const [y, m] = ym.split('-').map(Number);
  return ymOf(new Date(y, m, 1)); // m은 1부터 → 그대로 넣으면 다음 달
}

const AUTO_REGISTER_MAX_BACKFILL = 12;

/**
 * 정기지출 자동등록 — 오늘 기준 두 달 뒤까지 등록한다.
 * 마지막으로 등록한 달 다음부터 목표 달까지 빠진 달을 모두 채운다 (B-010: 앱을 한 달 넘게 안 열어도 누락 없음).
 * 처음 등록하는 항목은 목표 달만 등록한다 (이미 손으로 적은 이번 달 몫과 겹치지 않게).
 * 이미 등록한 달은 recurring_registration_log(UNIQUE)로 다시 만들지 않는다.
 */
export function runAutoRegister(db, now = new Date()) {
  const targetYearMonth = ymOf(new Date(now.getFullYear(), now.getMonth() + 2, 1));
  const recurring = getRecurringTransactions(db);
  let count = 0;
  const months = new Set();

  withTransaction(db, () => {
    recurring.forEach(r => {
      const last = db.exec(
        'SELECT MAX(registered_for_month) FROM recurring_registration_log WHERE recurring_id = ?',
        [r.id]
      )[0]?.values[0]?.[0] || null;

      const candidates = [];
      if (!last) {
        candidates.push(targetYearMonth);
      } else {
        for (let ym = nextYm(last); ym <= targetYearMonth; ym = nextYm(ym)) candidates.push(ym);
      }

      candidates.slice(-AUTO_REGISTER_MAX_BACKFILL).forEach(ym => {
        const [year, month] = ym.split('-').map(Number);
        if (r.frequency === 'annual' && Number(r.month_of_year) !== month) return;

        const alreadyDone = db.exec(
          'SELECT 1 FROM recurring_registration_log WHERE recurring_id = ? AND registered_for_month = ?',
          [r.id, ym]
        );
        if (alreadyDone[0]?.values.length) return;

        const day = resolveDay(year, month, r.day_of_month);
        const txDate = `${ym}-${String(day).padStart(2, '0')}`;

        // 자동 할인 계산: template에 할인이 없으면 결제수단 규칙 적용
        let discountAmt = r.discount_amount || 0;
        const discountNote = r.discount_note || '';
        if (discountAmt === 0) {
          const rules = getDiscountRules(db, r.payment_method);
          const autoDiscount = evaluateDiscountRule(rules, r.budget_category, r.sub_category || '', r.amount, r.detail || '');
          if (autoDiscount > 0) discountAmt = autoDiscount;
        }

        db.run(
          `INSERT INTO transactions (payment_method, date, budget_category, sub_category, detail, amount, discount_amount, discount_note, is_recurring, recurring_source_id, recurring_frequency)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [r.payment_method, txDate, r.budget_category, r.sub_category || '', r.detail || '', r.amount, discountAmt, discountNote, r.id, r.frequency]
        );
        const txId = db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] || null;

        db.run(
          'INSERT OR IGNORE INTO recurring_registration_log (recurring_id, registered_for_month, transaction_id) VALUES (?, ?, ?)',
          [r.id, ym, txId]
        );
        count++;
        months.add(ym);
      });
    });
  });

  return { count, targetYearMonth, months: [...months].sort() };
}
