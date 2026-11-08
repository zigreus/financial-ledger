// 정기지출 템플릿과 자동등록(빠진 달 보충 포함), 등록 기록.

import { todayLocal, withTransaction } from './common';
import { resolveDay, ymOf } from './recurringDates';
import { evaluateDiscountRule, getDiscountRules } from './discounts';

// ── 정기지출 템플릿 ───────────────────────────────────────────────

/**
 * 정기지출 한 번의 할인 — 템플릿에 적은 할인이 있으면 그 값, 없으면 결제수단 할인 규칙(자동등록과 같은 계산)
 */
export function recurringDiscount(db, r) {
  if ((r.discount_amount || 0) > 0) return r.discount_amount;
  const rules = getDiscountRules(db, r.payment_method);
  const auto = evaluateDiscountRule(rules, r.budget_category, r.sub_category || '', r.amount, r.detail || '');
  return auto > 0 ? auto : 0;
}

export function getRecurringTransactions(db) {
  const res = db.exec(
    `SELECT id, payment_method, budget_category, sub_category, detail, amount, discount_amount, discount_note, frequency, day_of_month, month_of_year, note,
            is_subscription, cancel_note, amount_checked_on
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
    `INSERT INTO recurring_transactions (payment_method, budget_category, sub_category, detail, amount, discount_amount, discount_note, frequency, day_of_month, month_of_year, note,
                                         is_subscription, cancel_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.payment_method, data.budget_category, data.sub_category || '',
      data.detail || '', data.amount,
      data.discount_amount || 0, data.discount_note || '',
      data.frequency || 'monthly', data.day_of_month ?? 1,
      data.month_of_year || null, data.note || '',
      data.is_subscription ? 1 : 0, String(data.cancel_note || '').trim(),
    ]
  );
}

function getRecurringTransaction(db, id) {
  return getRecurringTransactions(db).find(r => r.id === id) || null;
}

const sameSchedule = (a, b) => a.frequency === b.frequency
  && Number(a.day_of_month) === Number(b.day_of_month)
  && (a.frequency !== 'annual' || Number(a.month_of_year) === Number(b.month_of_year));
const sameTarget = (a, b) => a.payment_method === b.payment_method && a.budget_category === b.budget_category
  && (a.sub_category || '') === (b.sub_category || '') && (a.detail || '') === (b.detail || '');

/**
 * 정기지출 수정. is_subscription·cancel_note는 넘길 때만 바꾼다(구독 모아보기를 끈 화면에서 고쳐도 남게).
 * 금액을 바꾸면 amount_checked_on을 오늘(새 금액이 되지 못하고 남은 앞으로의 거래가 있으면 그 마지막 날)로 —
 * 그때까지의 결제가 옛 금액이어도 구독 모아보기가 '금액이 바뀜'으로 알리지 않게 (I-027).
 *
 * 앞으로의 거래 따라 바꾸기 (B-092): 일정(주기·월·일)·결제수단·카테고리·내용은 그대로 두고 금액·할인만 바꾸면,
 * 미리 등록해 둔 앞으로의 거래(오늘 뒤) 중 손대지 않은 것 — 금액·할인·할인 메모·결제수단·카테고리·내용이 예전 템플릿으로
 * 등록한 그대로인 것(할인 규칙을 쓰는 템플릿이면 규칙을 만들기 전에 등록돼 할인이 0인 것도) — 을 새 금액·할인으로 바꾼다.
 * 일정이나 결제수단 등을 함께 바꾼 수정은 옛 일정으로 등록된 거래가
 * 새 금액과 맞지 않을 수 있어 건드리지 않는다. 분할 결제한 거래도 건드리지 않는다.
 * (알려진 한계: 오프라인에서 고친 뒤 한참 지나 합쳐지면 '오늘'은 고친 날 기준이고, 두 기기가 같은 템플릿을 동시에 고치면
 *  늦게 합친 쪽의 앞으로의 거래는 바뀌지 않을 수 있다 — 드물고, 거래 화면에서 고칠 수 있다)
 */
export function updateRecurringTransaction(db, id, data) {
  withTransaction(db, () => {
    const old = getRecurringTransaction(db, id);
    const oldDiscount = old ? recurringDiscount(db, old) : 0;
    db.run(
      `UPDATE recurring_transactions SET payment_method=?, budget_category=?, sub_category=?, detail=?, amount=?, discount_amount=?, discount_note=?, frequency=?, day_of_month=?, month_of_year=?, note=?,
         is_subscription = COALESCE(?, is_subscription), cancel_note = COALESCE(?, cancel_note)
       WHERE id=?`,
      [
        data.payment_method, data.budget_category, data.sub_category || '',
        data.detail || '', data.amount,
        data.discount_amount || 0, data.discount_note || '',
        data.frequency || 'monthly', data.day_of_month ?? 1,
        data.month_of_year || null, data.note || '',
        data.is_subscription === undefined ? null : (data.is_subscription ? 1 : 0),
        data.cancel_note === undefined ? null : String(data.cancel_note || '').trim(),
        id,
      ]
    );
    const next = getRecurringTransaction(db, id);
    if (!old || !next) return;
    const today = todayLocal();
    const amountChanged = old.amount !== next.amount;
    const discountChanged = (old.discount_amount || 0) !== (next.discount_amount || 0);
    if ((amountChanged || discountChanged) && sameSchedule(old, next) && sameTarget(old, next)) {
      // 할인 규칙으로 할인하는 템플릿(직접 적은 할인 0)은, 자동등록 뒤에 규칙을 만들어 할인 0으로 등록된 행도 손대지 않은 것으로 본다
      const ruleBased = !(old.discount_amount > 0);
      db.run(
        `UPDATE transactions SET amount = ?, discount_amount = ?, discount_note = ?
         WHERE recurring_source_id = ? AND date > ? AND COALESCE(split_group_id, '') = ''
           AND amount = ? AND COALESCE(discount_amount, 0) IN (?, ?) AND COALESCE(discount_note, '') = ?
           AND payment_method = ? AND budget_category = ? AND COALESCE(sub_category, '') = ? AND COALESCE(detail, '') = ?`,
        [
          next.amount, recurringDiscount(db, next), next.discount_note || '',
          id, today,
          old.amount, oldDiscount, ruleBased ? 0 : oldDiscount, old.discount_note || '',
          old.payment_method, old.budget_category, old.sub_category || '', old.detail || '',
        ]
      );
    }
    if (amountChanged) {
      // 금액을 확인한 날 — 오늘, 또는 옛 금액 그대로 남은 앞으로의 거래(일정 등을 함께 바꿔 따라 바꾸지 않은 것)의 마지막 날.
      // 그 거래들이 결제일을 지나도 옛 금액이라고 '금액이 바뀐 구독'으로 알리지 않게 (I-027).
      // 사용자가 일부러 다른 금액으로 고친 거래는 넣지 않는다(지나면 한 번 알리고 '이대로 두기'로 끌 수 있다).
      // 한 문장으로 계산해, 병합 때 다른 기기가 그 사이 등록한 옛 금액 거래도 반영되게 한다
      db.run(
        `UPDATE recurring_transactions SET amount_checked_on = COALESCE(
           (SELECT MAX(date) FROM transactions WHERE recurring_source_id = ? AND date > ? AND amount = ?), ?)
         WHERE id = ?`,
        [id, today, old.amount, today, id],
      );
    }
  });
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
        const discountAmt = recurringDiscount(db, r);
        const discountNote = r.discount_note || '';

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
