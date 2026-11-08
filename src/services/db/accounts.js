// 계좌·고정 입출금 항목·계좌 거래, 계좌 자동등록, 잔액 예측.

import { addDays, parseDateStr, toDateStr } from '../dateUtils';
import { dbRowsToObjects, todayLocal, withTransaction } from './common';
import { recurringDateFor, ymOf } from './recurringDates';

// ── 계좌 관리 ────────────────────────────────────────────────────

export function getAllAccounts(db) {
  const res = db.exec('SELECT * FROM accounts WHERE is_active = 1 ORDER BY sort_order, id');
  return dbRowsToObjects(res);
}

export function getAccount(db, id) {
  const res = db.exec('SELECT * FROM accounts WHERE id = ?', [id]);
  const rows = dbRowsToObjects(res);
  return rows[0] || null;
}

/**
 * 각 계좌의 잔액 기준일(balance_date)부터 오늘까지 거래 합계 (B-022)
 * 실제 현재 잔액 = current_balance(기준일 시작 잔액) + 이 합계.
 * 기준일 이전 거래는 이미 current_balance에 들어 있으므로 더하지 않는다. 기준일이 비었으면 전부 더한다.
 */
export function getAccountsActualBalances(db) {
  const today = new Date();
  const todayYmd = toDateStr(today);
  const res = db.exec(
    `SELECT t.account_id,
            COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE -t.amount END), 0) AS tx_sum
     FROM account_transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE t.date <= ? AND t.date >= COALESCE(a.balance_date, '')
     GROUP BY t.account_id`,
    [todayYmd]
  );
  const txSums = {};
  if (res.length) res[0].values.forEach(([id, sum]) => { txSums[id] = sum; });
  return txSums;
}

export function getDefaultAccount(db) {
  const res = db.exec('SELECT * FROM accounts WHERE is_default = 1 AND is_active = 1 ORDER BY sort_order, id LIMIT 1');
  const rows = dbRowsToObjects(res);
  return rows[0] || null;
}

// 기본 계좌는 하나만 — 이 계좌를 기본으로 하면 나머지는 해제한다 (B-023)
export function addAccount(db, data) {
  return withTransaction(db, () => {
    const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), -1) FROM accounts');
    const nextSort = (maxSort[0]?.values[0][0] ?? -1) + 1;
    if (data.is_default) db.run('UPDATE accounts SET is_default = 0 WHERE is_default = 1');
    db.run(
      `INSERT INTO accounts (name, bank, account_number, current_balance, balance_date, danger_threshold, is_default, note, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.name || '', data.bank || '', data.account_number || '',
       data.current_balance || 0, data.balance_date || '', data.danger_threshold || 0,
       data.is_default ? 1 : 0, data.note || '', nextSort]
    );
    const res = db.exec('SELECT last_insert_rowid()');
    return res[0].values[0][0];
  });
}

export function updateAccount(db, id, data) {
  withTransaction(db, () => {
    if (data.is_default) db.run('UPDATE accounts SET is_default = 0 WHERE is_default = 1 AND id != ?', [id]);
    db.run(
      `UPDATE accounts SET name=?, bank=?, account_number=?, current_balance=?, balance_date=?,
       danger_threshold=?, is_default=?, note=? WHERE id=?`,
      [data.name || '', data.bank || '', data.account_number || '',
       data.current_balance || 0, data.balance_date || '', data.danger_threshold || 0,
       data.is_default ? 1 : 0, data.note || '', id]
    );
  });
}

export function setDefaultAccount(db, id) {
  withTransaction(db, () => {
    db.run('UPDATE accounts SET is_default = 0 WHERE is_default = 1');
    if (id) db.run('UPDATE accounts SET is_default = 1 WHERE id = ?', [id]);
  });
}

/**
 * 계좌 삭제(숨김) — 지난 내역은 남기고, 자동 등록으로 미리 만들어 둔 앞으로의 예정 내역(고치지 않은 것)은 지운다.
 * 남겨 두면 월급 계좌를 바꿀 때 옛 계좌의 예정 월급이 새 계좌 월급과 겹쳐 월 수지 수입이 두 배가 된다 (I-026, B-009와 같은 방식)
 */
export function deleteAccount(db, id) {
  withTransaction(db, () => {
    db.run('UPDATE accounts SET is_active = 0 WHERE id = ?', [id]);
    db.run(
      'DELETE FROM account_transactions WHERE account_id = ? AND is_auto_generated = 1 AND is_modified = 0 AND date > ?',
      [id, todayLocal()],
    );
  });
}

export function reorderAccounts(db, orderedIds) {
  orderedIds.forEach((id, i) => {
    db.run('UPDATE accounts SET sort_order = ? WHERE id = ?', [i, id]);
  });
}

// ── 고정 입출금 항목 ─────────────────────────────────────────────

export function getRecurringItems(db, accountId) {
  const res = db.exec(
    'SELECT * FROM account_recurring_items WHERE account_id = ? AND is_active = 1 ORDER BY sort_order, id',
    [accountId]
  );
  return dbRowsToObjects(res);
}

export function addRecurringItem(db, data) {
  const maxSort = db.exec(
    'SELECT COALESCE(MAX(sort_order), -1) FROM account_recurring_items WHERE account_id = ?',
    [data.account_id]
  );
  const nextSort = (maxSort[0]?.values[0][0] ?? -1) + 1;
  db.run(
    `INSERT INTO account_recurring_items
       (account_id, name, type, day_of_month, holiday_rule, amount_type, fixed_amount,
        auto_payment_method, auto_register, register_months_ahead, note, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.account_id, data.name || '', data.type || 'expense',
     data.day_of_month || 1, data.holiday_rule || 'next_business',
     data.amount_type || 'fixed', data.fixed_amount || 0,
     data.auto_payment_method || '', data.auto_register !== false ? 1 : 0,
     data.register_months_ahead || 2, data.note || '', nextSort]
  );
}

/**
 * 고정항목 수정 — 이미 만들어 둔 미래 자동 내역 중 사용자가 고치지 않은 것은 새 조건으로 다시 만든다 (B-009).
 */
export function updateRecurringItem(db, id, data) {
  withTransaction(db, () => {
    db.run(
      `UPDATE account_recurring_items SET name=?, type=?, day_of_month=?, holiday_rule=?,
       amount_type=?, fixed_amount=?, auto_payment_method=?, auto_register=?,
       register_months_ahead=?, note=? WHERE id=?`,
      [data.name || '', data.type || 'expense', data.day_of_month || 1,
       data.holiday_rule || 'next_business', data.amount_type || 'fixed',
       data.fixed_amount || 0, data.auto_payment_method || '',
       data.auto_register !== false ? 1 : 0, data.register_months_ahead || 2,
       data.note || '', id]
    );
    db.run(
      'DELETE FROM account_transactions WHERE recurring_item_id = ? AND is_modified = 0 AND date > ?',
      [id, todayLocal()]
    );
    const item = dbRowsToObjects(db.exec('SELECT * FROM account_recurring_items WHERE id = ?', [id]))[0];
    const account = item && getAccount(db, item.account_id);
    if (item && account && account.is_active && item.auto_register) {
      registerAccountItem(db, account, item, new Date());
    }
  });
}

/** 고정항목 삭제 — 사용자가 고치지 않은 미래 자동 내역도 함께 지운다 (B-009) */
export function deleteRecurringItem(db, id) {
  withTransaction(db, () => {
    db.run('UPDATE account_recurring_items SET is_active = 0 WHERE id = ?', [id]);
    db.run(
      'DELETE FROM account_transactions WHERE recurring_item_id = ? AND is_modified = 0 AND date > ?',
      [id, todayLocal()]
    );
  });
}

// ── 계좌 거래 내역 ───────────────────────────────────────────────

export function getAccountTransactions(db, accountId, opts = {}) {
  let q = 'SELECT * FROM account_transactions WHERE account_id = ?';
  const params = [accountId];
  if (opts.dateFrom) { q += ' AND date >= ?'; params.push(opts.dateFrom); }
  if (opts.dateTo)   { q += ' AND date <= ?'; params.push(opts.dateTo); }
  q += ' ORDER BY date DESC, id DESC';
  const res = db.exec(q, params);
  return dbRowsToObjects(res);
}

export function addAccountTransaction(db, data) {
  db.run(
    `INSERT INTO account_transactions
       (account_id, date, type, category, description, amount, base_amount,
        recurring_item_id, recurring_month, is_auto_generated, is_modified, is_imported)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.account_id, data.date, data.type || 'expense', data.category || '',
     data.description || '', data.amount, data.base_amount ?? null,
     data.recurring_item_id ?? null,
     data.recurring_item_id ? (data.recurring_month || String(data.date).slice(0, 7)) : '',
     data.is_auto_generated ? 1 : 0, data.is_modified ? 1 : 0, data.is_imported ? 1 : 0]
  );
  return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
}

export function updateAccountTransaction(db, id, data) {
  db.run(
    `UPDATE account_transactions SET date=?, type=?, category=?, description=?, amount=?,
     is_modified=1 WHERE id=?`,
    [data.date, data.type || 'expense', data.category || '', data.description || '',
     data.amount, id]
  );
}

/**
 * 계좌 내역 삭제. 고정항목에서 자동 생성된 내역이면 그 달을 '건너뜀'으로 기록해
 * 자동등록이 다시 만들지 않게 한다 (B-008).
 */
export function deleteAccountTransaction(db, id) {
  withTransaction(db, () => {
    const row = db.exec(
      'SELECT recurring_item_id, recurring_month FROM account_transactions WHERE id = ?', [id]
    )[0]?.values[0];
    if (row && row[0] && row[1]) {
      db.run(
        'INSERT OR IGNORE INTO account_recurring_skips (recurring_item_id, recurring_month) VALUES (?, ?)',
        [row[0], row[1]]
      );
    }
    db.run('DELETE FROM account_transactions WHERE id = ?', [id]);
  });
}

export function bulkInsertAccountTransactions(db, accountId, rows) {
  // withTransaction(SAVEPOINT)이라 다른 트랜잭션 안에서 불러도 안전하다 (B-059)
  withTransaction(db, () => {
    rows.forEach(row => {
      db.run(
        `INSERT INTO account_transactions
           (account_id, date, type, description, amount, is_imported)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [accountId, row.date, row.type, row.description, row.amount]
      );
    });
  });
}

// ── 카드 결제 추정액 집계 ────────────────────────────────────────
// 그 결제수단의 해당 월 거래 amount 합계이며, 할인(discount_amount)은 빼지 않는다 (I-016).
// - 카드 할인은 대부분 캐시백·포인트다. 결제일에는 할인 전 금액이 빠져나가고, 혜택은 그 뒤에 따로 들어온다.
// - 할인을 빼면 출금 예상이 실제보다 적게 잡혀, 잔액 예측과 위험 알림이 잔액 부족을 늦게 알린다.
// - 결제액에서 바로 깎이는 청구할인 카드는 사용자가 계좌 내역 금액을 고치면 된다(is_modified인 내역은 자동으로 바꾸지 않음).
// 화면의 순지출(amount - discount_amount, AGENTS.md §4)과 다르게 계산하는 것은 의도한 것이다.

export function getCardPaymentTotal(db, paymentMethod, yearMonth) {
  if (!paymentMethod || !yearMonth) return 0;
  const res = db.exec(
    `SELECT COALESCE(SUM(amount), 0)
     FROM transactions WHERE payment_method = ? AND strftime('%Y-%m', date) = ?`,
    [paymentMethod, yearMonth]
  );
  return res[0]?.values[0][0] || 0;
}

// ── 계좌 자동 등록 ───────────────────────────────────────────────
// 자동 생성 내역은 (고정항목, 대상 월)로 식별한다. 휴일 보정으로 실제 날짜가 다른 달이 되어도
// 대상 월은 그대로라 중복이 생기지 않는다 (B-007). UNIQUE 인덱스가 이를 보장한다.

/** 고정항목 하나를 이번 달부터 register_months_ahead개월 뒤까지 등록·갱신한다. 새로 만든 건수를 돌려준다. */
function registerAccountItem(db, account, item, now) {
  const today = todayLocal();
  const monthsAhead = item.register_months_ahead || 2;
  let count = 0;

  for (let m = 0; m <= monthsAhead; m++) {
    const ym = ymOf(new Date(now.getFullYear(), now.getMonth() + m, 1));
    const [year, month] = ym.split('-').map(Number);
    const actualDate = recurringDateFor(item, ym);

    let amount = item.fixed_amount || 0;
    let baseAmount = null;
    if (item.amount_type === 'auto' && item.auto_payment_method) {
      amount = getCardPaymentTotal(db, item.auto_payment_method, ymOf(new Date(year, month - 2, 1)));
      baseAmount = amount;
    }

    const skipped = db.exec(
      'SELECT 1 FROM account_recurring_skips WHERE recurring_item_id = ? AND recurring_month = ?',
      [item.id, ym]
    );
    if (skipped[0]?.values.length) continue;

    const existing = dbRowsToObjects(db.exec(
      `SELECT id, date, amount, is_modified FROM account_transactions
       WHERE recurring_item_id = ? AND recurring_month = ?`,
      [item.id, ym]
    ))[0];

    if (existing) {
      if (existing.is_modified) continue; // 사용자가 고친 내역은 건드리지 않는다
      // auto 금액이 바뀌었으면 갱신
      if (item.amount_type === 'auto' && amount > 0 && amount !== existing.amount) {
        db.run('UPDATE account_transactions SET amount = ?, base_amount = ? WHERE id = ?',
          [amount, baseAmount, existing.id]);
      }
      // 공휴일 데이터가 바뀌어 처리일이 달라졌으면 미래 내역만 고친다 (B-006)
      if (existing.date !== actualDate && existing.date > today && actualDate > today) {
        db.run('UPDATE account_transactions SET date = ? WHERE id = ?', [actualDate, existing.id]);
      }
      continue;
    }

    if (amount === 0) continue;

    db.run(
      `INSERT INTO account_transactions
         (account_id, date, type, category, description, amount, base_amount,
          recurring_item_id, recurring_month, is_auto_generated, is_modified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
      [account.id, actualDate, item.type, '', item.name, amount, baseAmount, item.id, ym]
    );
    count++;
  }
  return count;
}

export function runAccountAutoRegister(db, now = new Date()) {
  let totalCount = 0;
  withTransaction(db, () => {
    getAllAccounts(db).forEach(account => {
      getRecurringItems(db, account.id)
        .filter(i => i.auto_register)
        .forEach(item => { totalCount += registerAccountItem(db, account, item, now); });
    });
  });
  return totalCount;
}

// ── 잔액 예측 ────────────────────────────────────────────────────

export function getBalanceForecast(db, accountId, daysAhead = 90, now = new Date()) {
  const account = getAccount(db, accountId);
  if (!account) return [];

  const todayYmd = toDateStr(now);
  const endStr = addDays(todayYmd, daysAhead);

  // current_balance(잔액 기준일 시작 잔액)에 기준일~오늘 거래를 순서대로 적용 → 실제 현재 잔액 (B-022)
  // 기준일 이전 거래는 이미 current_balance에 들어 있으므로 제외한다.
  const balanceDate = account.balance_date || '';
  const pastRes = db.exec(
    'SELECT * FROM account_transactions WHERE account_id = ? AND date <= ? AND date >= ? ORDER BY date ASC, id ASC',
    [accountId, todayYmd, balanceDate]
  );
  const pastTxs = dbRowsToObjects(pastRes);

  let actualCurrentBalance = account.current_balance || 0;
  for (const tx of pastTxs) {
    if (tx.type === 'income') actualCurrentBalance += tx.amount;
    else actualCurrentBalance -= tx.amount;
  }

  // 오늘 이후 거래를 예측 이벤트로 처리
  const futureRes = db.exec(
    'SELECT * FROM account_transactions WHERE account_id = ? AND date > ? AND date <= ? AND date >= ? ORDER BY date ASC, id ASC',
    [accountId, todayYmd, endStr, balanceDate]
  );
  const futureTxs = dbRowsToObjects(futureRes);

  let balance = actualCurrentBalance;
  const events = [];

  futureTxs.forEach(tx => {
    const delta = tx.type === 'income' ? tx.amount : -tx.amount;
    balance += delta;

    const isEstimated = !!tx.is_auto_generated && !tx.is_modified;
    const isCardEstimate = tx.amount_type === 'auto';

    events.push({
      date: tx.date,
      description: tx.description,
      type: tx.type,
      amount: tx.amount,
      balance,
      isEstimated,
      isCardEstimate,
      isBelowDanger: account.danger_threshold > 0 && balance < account.danger_threshold,
      tx,
    });
  });

  return { account, startBalance: actualCurrentBalance, events };
}

/**
 * 잔액 위험 알림 (B-066) — 위험 임계값을 넣은 계좌마다, 앞으로 daysAhead일 안에 잔액이 임계값 아래로
 * 내려가는 첫날을 찾는다. 이미 아래면 오늘(isNow)로 알린다.
 * 같은 날 입금·출금 순서는 알 수 없으므로 하루가 끝났을 때의 잔액으로 판단한다(같은 날 월급이 들어오면 경고하지 않음).
 * 반환: [{ accountId, accountName, threshold, date, balance, daysUntil, isNow }] (가까운 날 순)
 */
export function getBalanceAlerts(db, { daysAhead = 35, now = new Date() } = {}) {
  const todayYmd = toDateStr(now);
  const alerts = [];
  getAllAccounts(db).forEach(account => {
    const threshold = Number(account.danger_threshold) || 0;
    if (threshold <= 0) return;
    const forecast = getBalanceForecast(db, account.id, daysAhead, now);
    if (!forecast || !forecast.account) return;

    const base = { accountId: account.id, accountName: account.name, threshold };
    if (forecast.startBalance < threshold) {
      alerts.push({ ...base, date: todayYmd, balance: forecast.startBalance, daysUntil: 0, isNow: true });
      return;
    }
    // 날짜별 마지막 잔액
    const endOfDay = new Map();
    forecast.events.forEach(ev => endOfDay.set(ev.date, ev.balance));
    for (const [date, balance] of endOfDay) {
      if (balance < threshold) {
        const daysUntil = Math.round((parseDateStr(date) - parseDateStr(todayYmd)) / 86400000);
        alerts.push({ ...base, date, balance, daysUntil, isNow: false });
        break;
      }
    }
  });
  return alerts.sort((a, b) => a.date.localeCompare(b.date) || a.balance - b.balance);
}
