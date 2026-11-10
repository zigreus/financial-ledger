// 정기지출 템플릿과 자동등록(빠진 달 보충 포함), 등록 기록.

import { dbRowsToObjects, reinsert, todayLocal, withTransaction } from './common';
import { recurringTxDateFor, ymOf } from './recurringDates';
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
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
}

function getRecurringTransaction(db, id) {
  return getRecurringTransactions(db).find(r => r.id === id) || null;
}

const sameSchedule = (a, b) => a.frequency === b.frequency
  && Number(a.day_of_month) === Number(b.day_of_month)
  && (a.frequency !== 'annual' || Number(a.month_of_year) === Number(b.month_of_year));
const sameTarget = (a, b) => a.payment_method === b.payment_method && a.budget_category === b.budget_category
  && (a.sub_category || '') === (b.sub_category || '') && (a.detail || '') === (b.detail || '');
// 결제일만 바뀌었다(주기는 그대로) — 앞으로의 거래를 새 결제일로 옮길 수 있다 (I-037)
const dateOnlyChanged = (a, b) => a.frequency === b.frequency && !sameSchedule(a, b);

/**
 * 일정의 결제일 SQL 식 (I-037) — 거래의 날짜(date 칸)마다, 그 거래에 해당하는 이 일정(r)의 결제일.
 *  - 월별: 그 거래의 달. 연간: 그 거래에 가장 가까운 일정의 달 — 여섯 달 넘게 차이 나면 해를 넘긴다
 *    (12월 거래를 1월 일정으로 보면 다음 해 1월, 1월 거래를 12월 일정으로 보면 앞 해 12월).
 *  - 그 달의 일정 날(0은 말일, 그 달에 없는 날은 말일) — 자동등록(recurringTxDateFor)과 같은 규칙.
 * 옛 일정으로 계산하면 그 거래가 아직 옛 결제일 그대로인지(사용자가 날짜를 직접 고치지 않았는지), 새 일정으로 계산하면 옮길 날짜.
 * 미리보기와 옮기기가 같은 식을 쓰고, 병합 때 다른 기기 파일에 다시 실행해도 그 파일의 거래마다(그 기기가 등록해 둔 것까지)
 * 같은 규칙으로 계산된다.
 */
function scheduleDateSql(r) {
  const annual = r.frequency === 'annual';
  const month = Number(r.month_of_year);
  const ym = annual
    ? `(printf('%04d', CAST(substr(date, 1, 4) AS INTEGER) + CASE
         WHEN ? - CAST(substr(date, 6, 2) AS INTEGER) > 6 THEN -1
         WHEN ? - CAST(substr(date, 6, 2) AS INTEGER) < -6 THEN 1 ELSE 0 END) || '-' || printf('%02d', ?))`
    : 'substr(date, 1, 7)';
  const ymParams = annual ? [month, month, month] : [];
  const lastDay = `CAST(strftime('%d', date(${ym} || '-01', '+1 month', '-1 day')) AS INTEGER)`;
  const day = Number(r.day_of_month) || 0;
  return {
    sql: `(${ym} || '-' || printf('%02d', CASE WHEN ? = 0 THEN ${lastDay} ELSE MIN(?, ${lastDay}) END))`,
    params: [...ymParams, day, ...ymParams, day, ...ymParams],
  };
}

/** 옮길 거래의 조건 — 아직 옛 결제일 그대로이고, 새 결제일이 오늘 뒤이며 지금 날짜와 다르다 (I-037) */
function movableSql(old, next, today) {
  const was = scheduleDateSql(old);
  const to = scheduleDateSql(next);
  return {
    sql: `date = ${was.sql} AND ${to.sql} > ? AND ${to.sql} <> date`,
    params: [...was.params, ...to.params, today, ...to.params],
  };
}

/**
 * 결제일을 바꿀 때 함께 옮길 앞으로의 거래 미리보기 (I-037) — 주기는 그대로 두고 날(연간이면 달·날)만 바꿀 때.
 * 이 정기지출이 미리 등록한 오늘 뒤의 거래마다(분할 결제는 원래 행 하나로 센다) [{ id, from, to }]:
 *  - moves: 아직 옛 결제일 그대로이고 새 결제일이 오늘 뒤 → 함께 옮길 수 있다
 *  - stays: 새 결제일이 오늘이거나 이미 지났다 → 날짜·금액 모두 그대로 둔다
 *  - kept: 지금 결제일(옛 일정)과 날짜가 다른 거래 — 직접 고쳤거나, 예전 결제일로 남은 것('정기지출만 바꾸기'·다른 기기) → 그대로 둔다
 * 이미 새 결제일인 거래는 넣지 않는다. 결제일이 그대로거나 주기를 바꾸면 모두 빈 목록.
 *  - amountFollows: 옮기는 거래는 금액·할인도 따라 바뀐다(금액·할인을 함께 바꿨고 결제수단·카테고리·내용은 그대로 — B-092)
 * data: 수정 폼의 값(frequency·day_of_month·month_of_year·amount·discount_amount 등)
 */
export function getRecurringDateMoves(db, id, data, today = todayLocal()) {
  const old = getRecurringTransaction(db, id);
  const next = old && { ...old, ...data };
  if (!old || !dateOnlyChanged(old, next)) return { moves: [], stays: [], kept: [], amountFollows: false };
  const was = scheduleDateSql(old);
  const to = scheduleDateSql(next);
  const res = db.exec(
    `SELECT id, date, ${was.sql} AS was, ${to.sql} AS moved FROM transactions
     WHERE recurring_source_id = ? AND date > ? ORDER BY date, id`,
    [...was.params, ...to.params, id, today],
  );
  const moves = [];
  const stays = [];
  const kept = [];
  (res[0]?.values || []).forEach(([txId, from, wasDate, moved]) => {
    if (moved === from) return;
    if (from !== wasDate) kept.push({ id: txId, from, to: moved });
    else (moved > today ? moves : stays).push({ id: txId, from, to: moved });
  });
  const amountFollows = (old.amount !== next.amount || (old.discount_amount || 0) !== (next.discount_amount || 0))
    && sameTarget(old, next);
  return { moves, stays, kept, amountFollows };
}

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
 *
 * 결제일 옮기기 (I-037): options.moveDates면 주기는 그대로 두고 날(연간이면 달·날)만 바꾼 수정에서, 미리 등록한 앞으로의
 * 거래 중 옮길 수 있는 것(getRecurringDateMoves의 moves — 아직 옛 결제일 그대로이고 새 결제일도 오늘 뒤)을 새 결제일로 옮긴다
 * (분할 결제는 같은 묶음의 몫을 함께). 옮기는 거래는 새 일정이 되므로 그 거래에는 위의 금액·할인 따라 바꾸기도 한다 —
 * 그대로 두는 거래(지금 결제일과 날짜가 다른 것, 새 결제일이 지난 것)는 금액도 그대로.
 * 연간 구독의 달을 옮기면 등록 기록의 달도 옮긴다 — 자동등록이 새 달에 한 번 더 넣지 않게.
 */
export function updateRecurringTransaction(db, id, data, { moveDates = false } = {}) {
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
    const movingDates = moveDates && dateOnlyChanged(old, next);
    // 옮길 거래(아직 옛 결제일 그대로이고 새 결제일도 오늘 뒤) — 옮길 때는 금액 따라 바꾸기도 이 거래에만
    const movable = movingDates ? movableSql(old, next, today) : null;
    if ((amountChanged || discountChanged) && (sameSchedule(old, next) || movingDates) && sameTarget(old, next)) {
      // 할인 규칙으로 할인하는 템플릿(직접 적은 할인 0)은, 자동등록 뒤에 규칙을 만들어 할인 0으로 등록된 행도 손대지 않은 것으로 본다
      const ruleBased = !(old.discount_amount > 0);
      db.run(
        `UPDATE transactions SET amount = ?, discount_amount = ?, discount_note = ?
         WHERE recurring_source_id = ? AND date > ? AND COALESCE(split_group_id, '') = ''
           AND amount = ? AND COALESCE(discount_amount, 0) IN (?, ?) AND COALESCE(discount_note, '') = ?
           AND payment_method = ? AND budget_category = ? AND COALESCE(sub_category, '') = ? AND COALESCE(detail, '') = ?${movable ? `
           AND ${movable.sql}` : ''}`,
        [
          next.amount, recurringDiscount(db, next), next.discount_note || '',
          id, today,
          old.amount, oldDiscount, ruleBased ? 0 : oldDiscount, old.discount_note || '',
          old.payment_method, old.budget_category, old.sub_category || '', old.detail || '',
          ...(movable ? movable.params : []),
        ]
      );
    }
    if (movingDates) {
      const to = scheduleDateSql(next);
      // 분할 결제 — 원래 행과 같은 묶음의 몫(같은 날짜)을 함께 옮긴다
      db.run(
        `UPDATE transactions SET date = ${to.sql}
         WHERE split_group_id IN (
           SELECT split_group_id FROM transactions
           WHERE recurring_source_id = ? AND date > ? AND COALESCE(split_group_id, '') <> '' AND ${movable.sql})`,
        [...to.params, id, today, ...movable.params],
      );
      db.run(
        `UPDATE transactions SET date = ${to.sql}
         WHERE recurring_source_id = ? AND date > ? AND COALESCE(split_group_id, '') = '' AND ${movable.sql}`,
        [...to.params, id, today, ...movable.params],
      );
      if (next.frequency === 'annual' && Number(old.month_of_year) !== Number(next.month_of_year)) {
        db.run(
          `UPDATE OR IGNORE recurring_registration_log
           SET registered_for_month = (SELECT substr(t.date, 1, 7) FROM transactions t WHERE t.id = recurring_registration_log.transaction_id)
           WHERE recurring_id = ? AND transaction_id IN (
             SELECT id FROM transactions
             WHERE recurring_source_id = ? AND date > ? AND substr(date, 6, 2) = printf('%02d', ?))
             AND registered_for_month <> (SELECT substr(t.date, 1, 7) FROM transactions t WHERE t.id = recurring_registration_log.transaction_id)`,
          [id, id, today, Number(next.month_of_year)],
        );
      }
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

/** 금액을 확인한 날(구독 모아보기의 '금액이 바뀜' 기준, I-027)을 그대로 적는다 — AI 명령의 되돌리기가 그때 값으로 돌린다 (I-051) */
export function setRecurringAmountCheckedOn(db, id, value) {
  db.run('UPDATE recurring_transactions SET amount_checked_on = ? WHERE id = ?', [value || '', id]);
}

/**
 * 정기지출을 지우고 되돌리기에 쓸 기록을 돌려준다 (I-051 AI 명령) — 행 그대로와 등록 기록.
 * 등록 기록을 함께 되살려야 되돌린 뒤 이번 달을 또 자동등록하지 않는다(멱등, AGENTS §2.7). 없으면 null
 */
export function deleteRecurringForUndo(db, id) {
  const row = dbRowsToObjects(db.exec('SELECT * FROM recurring_transactions WHERE id = ?', [id]))[0];
  if (!row) return null;
  const logs = dbRowsToObjects(db.exec('SELECT * FROM recurring_registration_log WHERE recurring_id = ?', [id]));
  withTransaction(db, () => deleteRecurringTransaction(db, id));
  return { row, logs };
}

/**
 * 지운 정기지출을 되살린다 — 새 번호로 넣고(병합 때 번호가 겹치지 않게), 등록 기록과
 * 그 정기지출이 등록했던 거래의 연결(recurring_source_id — 지워도 옛 번호로 남는다)을 새 번호로 잇는다. 새 번호
 */
export function restoreDeletedRecurring(db, undo) {
  if (!undo?.row) return null;
  return withTransaction(db, () => {
    const oldId = undo.row.id;
    const newId = reinsert(db, 'recurring_transactions', undo.row);
    undo.logs.forEach(log => {
      db.run(
        'INSERT OR IGNORE INTO recurring_registration_log (recurring_id, registered_for_month, transaction_id, registered_at) VALUES (?, ?, ?, ?)',
        [newId, log.registered_for_month, log.transaction_id ?? null, log.registered_at ?? null],
      );
    });
    db.run('UPDATE transactions SET recurring_source_id = ? WHERE recurring_source_id = ?', [newId, oldId]);
    return newId;
  });
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
        const month = Number(ym.slice(5, 7));
        if (r.frequency === 'annual' && Number(r.month_of_year) !== month) return;

        const alreadyDone = db.exec(
          'SELECT 1 FROM recurring_registration_log WHERE recurring_id = ? AND registered_for_month = ?',
          [r.id, ym]
        );
        if (alreadyDone[0]?.values.length) return;

        const txDate = recurringTxDateFor(r, ym);

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
