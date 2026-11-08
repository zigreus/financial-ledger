// 여행 현금 지갑 — 환전·정산·이월 흐름, 지갑 잔액·내역, 실물 정산·지갑 종료.

import { dbRowsToObjects, todayLocal, withTransaction } from './common';
import { addTransaction, deleteTransaction } from './transactions';
import { getSubCategories } from './masterData';
import { addEventCountry, getEventCountries } from './calendar';
import { addAccountTransaction, deleteAccountTransaction } from './accounts';

// ── 여행 현금 지갑 ──────────────────────────────────────────────────
//
// 출금/환전은 "지출"이 아니라 계좌 → 현금지갑 이동이다.
// 따라서 가계부 합계(transactions)에는 넣지 않고 event_cash_flows에만 기록하며,
// 실제 현금 사용은 기존 transactions(결제수단='현금')이 담당한다.
// 잔여 현금 = Σ흐름 − Σ현금사용.

const KRW = 'KRW';

export function getEventCashFlows(db, eventId) {
  if (!db || !eventId) return [];
  const res = db.exec(
    `SELECT id, event_id, date, type, currency, amount, krw_cost, account_id, note
     FROM event_cash_flows WHERE event_id = ? ORDER BY date, id`,
    [eventId]
  );
  if (!res.length) return [];
  return res[0].values.map(([id, event_id, date, type, currency, amount, krw_cost, account_id, note]) =>
    ({ id, event_id, date, type, currency, amount: Number(amount), krw_cost: Number(krw_cost) || 0, account_id, note }));
}

const lastInsertId = (db) => db.exec('SELECT last_insert_rowid()')[0].values[0][0];

/** 결과가 정확히 한 행일 때만 그 id — 예전 기록의 짝을 추정할 때 애매하면 건드리지 않는다 */
function uniqueRowId(db, sql, params) {
  const rows = db.exec(sql, params)[0]?.values || [];
  return rows.length === 1 ? rows[0][0] : null;
}

// 여행 현금 흐름과 함께 만든 계좌 내역의 분류 — 월 수지(I-026)는 이 입금(재환전·남은 현금)을 수입으로 세지 않는다
export const CASH_FLOW_ACCOUNT_CATEGORY = '여행 현금';

export function addEventCashFlow(db, flow) {
  if (!db || !flow.event_id) throw new Error('일정을 선택하세요');
  const currency = (flow.currency || KRW).trim().toUpperCase();
  const amount = Number(flow.amount);
  if (!isFinite(amount) || amount === 0) throw new Error('금액을 입력하세요');
  const krwCost = Math.round(Number(flow.krw_cost) || 0);

  return withTransaction(db, () => {
    // 계좌를 지정했으면 계좌 잔액에도 반영 (출금=지출 / 입금=수입).
    // 흐름을 지울 때 같이 지우도록 계좌 기록 id를 흐름에 남긴다.
    let accountTxId = null;
    if (flow.account_id && krwCost !== 0) {
      addAccountTransaction(db, {
        account_id: flow.account_id,
        date: flow.date,
        type: amount > 0 ? 'expense' : 'income',
        category: CASH_FLOW_ACCOUNT_CATEGORY,
        description: flow.note || (amount > 0 ? `${currency} 환전/출금` : `${currency} 재환전/입금`),
        amount: Math.abs(krwCost),
      });
      accountTxId = lastInsertId(db);
    }

    db.run(
      `INSERT INTO event_cash_flows
         (event_id, date, type, currency, amount, krw_cost, account_id, note, account_tx_id, linked_flow_id, linked_tx_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [flow.event_id, flow.date, flow.type || 'exchange', currency, amount,
       krwCost, flow.account_id || null, flow.note || '',
       accountTxId, flow.linked_flow_id || null, flow.linked_tx_id || null]
    );
    const id = lastInsertId(db);

    syncEventRateFromFlows(db, flow.event_id, currency);
    return id;
  });
}

/**
 * 현금 흐름 하나를 지울 때 함께 정리할 기록 — 삭제 확인 문구와 deleteEventCashFlow가 같이 쓴다.
 *  accountTx : 이 흐름으로 만든 계좌 출금/입금 기록
 *  pairFlow  : 이월의 짝 (다른 일정의 '이월 들어옴'/'이월 나감')
 *  fxTx      : 재환전 때 기록한 환차손익 거래
 *  accountTxMissing : 계좌에 반영된 흐름인데 그 기록을 찾지 못함 (직접 지워야 함)
 * 연결 id가 없는 예전 기록은 같은 날짜·금액으로 짝을 찾되, 후보가 하나일 때만 연결로 본다.
 */
export function getCashFlowLinks(db, id) {
  if (!db || !id) return null;
  const flow = dbRowsToObjects(db.exec('SELECT * FROM event_cash_flows WHERE id = ?', [id]))[0];
  if (!flow) return null;
  const cur = String(flow.currency || '').trim().toUpperCase();
  const amount = Number(flow.amount) || 0;
  const krw = Math.abs(Math.round(Number(flow.krw_cost) || 0));

  // 계좌 기록
  let accountTxId = flow.account_tx_id || null;
  if (!accountTxId && flow.account_id && krw > 0) {
    accountTxId = db.exec(
      `SELECT id FROM account_transactions
       WHERE account_id = ? AND date = ? AND category = ? AND amount = ? AND type = ?
         AND id NOT IN (SELECT account_tx_id FROM event_cash_flows WHERE account_tx_id IS NOT NULL)
       ORDER BY id DESC LIMIT 1`,
      [flow.account_id, flow.date, CASH_FLOW_ACCOUNT_CATEGORY, krw, amount > 0 ? 'expense' : 'income']
    )[0]?.values[0]?.[0] || null;
  }
  const accountTx = accountTxId ? dbRowsToObjects(db.exec(
    `SELECT t.id, t.amount, t.type, a.name AS account_name
     FROM account_transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`,
    [accountTxId]
  ))[0] || null : null;

  // 이월의 짝
  let pairId = flow.linked_flow_id || null;
  if (!pairId && (flow.type === 'carryover_out' || flow.type === 'carryover_in')) {
    pairId = uniqueRowId(db,
      `SELECT id FROM event_cash_flows
       WHERE type = ? AND date = ? AND UPPER(currency) = ? AND ABS(amount + ?) < 0.005
         AND event_id != ? AND linked_flow_id IS NULL`,
      [flow.type === 'carryover_out' ? 'carryover_in' : 'carryover_out', flow.date, cur, amount, flow.event_id]);
  }
  const pairFlow = pairId ? dbRowsToObjects(db.exec(
    `SELECT f.*, e.title AS event_title
     FROM event_cash_flows f LEFT JOIN calendar_events e ON e.id = f.event_id WHERE f.id = ?`,
    [pairId]
  ))[0] || null : null;

  // 재환전의 환차손익 거래 — 예전 기록은 그날 이 일정의 외화 재환전이 하나뿐일 때만 추정한다
  let fxTxId = flow.linked_tx_id || null;
  if (!fxTxId && flow.type === 'refund' && cur !== KRW) {
    const sameDayRefunds = Number(db.exec(
      `SELECT COUNT(*) FROM event_cash_flows
       WHERE event_id = ? AND date = ? AND type = 'refund' AND UPPER(currency) != ?`,
      [flow.event_id, flow.date, KRW]
    )[0]?.values[0][0]) || 0;
    if (sameDayRefunds === 1) {
      fxTxId = uniqueRowId(db,
        `SELECT id FROM transactions
         WHERE event_id = ? AND date = ? AND COALESCE(is_cash_adjustment, 0) = 1
           AND detail IN ('환전 차손', '환전 차익')
           AND id NOT IN (SELECT linked_tx_id FROM event_cash_flows WHERE linked_tx_id IS NOT NULL)`,
        [flow.event_id, flow.date]);
    }
  }
  const fxTx = fxTxId ? dbRowsToObjects(db.exec(
    'SELECT id, detail, amount, discount_amount FROM transactions WHERE id = ?', [fxTxId]
  ))[0] || null : null;

  return {
    flow,
    accountTx,
    accountTxMissing: !!flow.account_id && krw > 0 && !accountTx,
    pairFlow,
    fxTx,
  };
}

/** 현금 흐름 삭제 — 함께 만든 계좌 기록·이월 짝·환차손익 거래도 지운다. 지운 내용을 돌려준다. */
export function deleteEventCashFlow(db, id) {
  if (!db) return null;
  const links = getCashFlowLinks(db, id);
  if (!links) return null;

  withTransaction(db, () => {
    if (links.accountTx) deleteAccountTransaction(db, links.accountTx.id);
    if (links.fxTx) deleteTransaction(db, links.fxTx.id);
    if (links.pairFlow) {
      if (links.pairFlow.account_tx_id) deleteAccountTransaction(db, links.pairFlow.account_tx_id);
      db.run('DELETE FROM event_cash_flows WHERE id = ?', [links.pairFlow.id]);
      syncEventRateFromFlows(db, links.pairFlow.event_id, links.pairFlow.currency);
    }
    db.run('DELETE FROM event_cash_flows WHERE id = ?', [id]);
    syncEventRateFromFlows(db, links.flow.event_id, links.flow.currency);
  });
  return links;
}

/**
 * 일정에 연결된 현금(결제수단='현금') 거래의 통화별 사용액.
 * 현지 통화 금액이 기록돼 있으면 그 통화 지갑에서, 없으면 원화 지갑에서 차감한다.
 */
export function getEventCashSpending(db, eventId) {
  const spent = {};
  if (!db || !eventId) return spent;
  const res = db.exec(
    `SELECT amount, foreign_amounts FROM transactions
     WHERE event_id = ? AND payment_method = '현금' AND COALESCE(is_cash_adjustment, 0) = 0`,
    [eventId]
  );
  if (!res.length) return spent;

  const walletCurrencies = new Set(
    (db.exec('SELECT DISTINCT currency FROM event_countries WHERE event_id = ?', [eventId])[0]?.values || [])
      .map(r => String(r[0]).trim().toUpperCase())
  );

  res[0].values.forEach(([amount, foreignJson]) => {
    let fa = {};
    try { fa = foreignJson ? JSON.parse(foreignJson) : {}; } catch (e) {}
    const matched = Object.entries(fa).filter(([cur, val]) =>
      walletCurrencies.has(String(cur).trim().toUpperCase()) && Number(val) > 0);

    if (matched.length) {
      matched.forEach(([cur, val]) => {
        const c = String(cur).trim().toUpperCase();
        spent[c] = (spent[c] || 0) + Number(val);
      });
    } else {
      spent[KRW] = (spent[KRW] || 0) + (Number(amount) || 0);
    }
  });
  return spent;
}

/**
 * 일정의 통화별 현금 지갑 현황.
 * balance = 흐름 합계 − 현금 사용액, avgRate = 취득 원화 / 취득 수량.
 */
export function getEventWallets(db, eventId) {
  if (!db || !eventId) return [];
  const flows = getEventCashFlows(db, eventId);
  const spending = getEventCashSpending(db, eventId);
  const countries = getEventCountries(db, eventId);

  const currencyLabel = {};
  countries.forEach(c => {
    const cur = String(c.currency || '').trim().toUpperCase();
    if (cur) currencyLabel[cur] = c.country;
  });

  const map = {};
  const ensure = (cur) => {
    if (!map[cur]) {
      map[cur] = {
        currency: cur,
        country: currencyLabel[cur] || (cur === KRW ? '원화' : ''),
        inflow: 0, acquired: 0, krwCost: 0, spent: 0, balance: 0, avgRate: 0,
      };
    }
    return map[cur];
  };

  // 환율이 설정된 통화는 흐름이 없어도 지갑을 노출한다 (원화는 환전 대상이 아니므로 제외)
  Object.keys(currencyLabel).filter(c => c !== KRW).forEach(ensure);
  flows.forEach(f => {
    const w = ensure(f.currency);
    w.inflow += f.amount;
    if (f.amount > 0 && f.krw_cost > 0) {
      w.acquired += f.amount;
      w.krwCost += f.krw_cost;
    }
  });
  // 원화 현금 지출은 지갑에 넣지 않는다 — 원화를 따로 환전해 둔 기록이 있을 때만 추적
  const krwTracked = flows.some(f => f.currency === KRW);
  Object.keys(spending)
    .filter(cur => cur !== KRW || krwTracked)
    .forEach(cur => { ensure(cur).spent += spending[cur]; });

  return Object.values(map).map(w => ({
    ...w,
    balance: w.inflow - w.spent,
    avgRate: w.acquired > 0 ? w.krwCost / w.acquired : 0,
  })).sort((a, b) => (a.currency === KRW ? 1 : 0) - (b.currency === KRW ? 1 : 0)
      || a.currency.localeCompare(b.currency));
}

/**
 * 현금 관리 내역용 — 흐름(환전/정산/종료)과 실제 현금 사용 거래를 한 줄기로 합쳐
 * 날짜순으로 돌려준다. kind로 구분한다: 'flow' | 'spend'
 */
export function getEventCashLedger(db, eventId) {
  if (!db || !eventId) return [];

  const walletCurrencies = new Set(
    (db.exec('SELECT DISTINCT UPPER(currency) FROM event_countries WHERE event_id = ?', [eventId])[0]?.values || [])
      .map(r => String(r[0]))
  );

  const flows = getEventCashFlows(db, eventId);
  const rows = flows.map(f => ({ ...f, kind: 'flow' }));

  // 원화는 따로 환전해 둔 기록이 있을 때만 지갑으로 추적한다 (getEventWallets와 동일 규칙)
  const krwTracked = flows.some(f => f.currency === KRW);

  const res = db.exec(
    `SELECT id, date, budget_category, sub_category, detail, amount, foreign_amounts, split_group_id
     FROM transactions
     WHERE event_id = ? AND payment_method = '현금' AND COALESCE(is_cash_adjustment, 0) = 0
     ORDER BY date, id`,
    [eventId]
  );

  (res[0]?.values || []).forEach(([id, date, cat, sub, detail, amount, foreignJson, splitId]) => {
    let fa = {};
    try { fa = foreignJson ? JSON.parse(foreignJson) : {}; } catch (e) {}
    const matched = Object.entries(fa).filter(([cur, val]) =>
      walletCurrencies.has(String(cur).trim().toUpperCase()) && Number(val) > 0);

    // 현지 통화로 쓴 건 통화별로, 아니면 원화 지출로 한 줄
    const legs = matched.length
      ? matched.map(([cur, val]) => ({ currency: String(cur).trim().toUpperCase(), amount: -Number(val) }))
      : [{ currency: KRW, amount: -(Number(amount) || 0) }];

    legs.filter(leg => leg.currency !== KRW || krwTracked).forEach(leg => rows.push({
      id: `tx-${id}-${leg.currency}`,
      kind: 'spend',
      tx_id: id,
      date,
      type: 'spend',
      currency: leg.currency,
      amount: leg.amount,
      krw_cost: Number(amount) || 0,
      note: detail || [cat, sub].filter(Boolean).join(' / '),
      is_split: !!splitId,
    }));
  });

  // 같은 날짜면 흐름 먼저. 같은 종류끼리는 0을 돌려 원래 순서(id 순)를 유지한다 (sort는 안정 정렬)
  const kindOrder = r => (r.kind === 'flow' ? 0 : 1);
  return rows.sort((a, b) =>
    a.date.localeCompare(b.date) || kindOrder(a) - kindOrder(b));
}

/** 환전 기록에서 실효 환율을 구해 event_countries.exchange_rate에 반영한다. */
export function syncEventRateFromFlows(db, eventId, currency) {
  const cur = String(currency || '').trim().toUpperCase();
  if (!db || !eventId || !cur || cur === KRW) return;

  const res = db.exec(
    `SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(krw_cost), 0)
     FROM event_cash_flows
     WHERE event_id = ? AND UPPER(currency) = ? AND amount > 0 AND krw_cost > 0`,
    [eventId, cur]
  );
  const [qty, cost] = res[0]?.values[0] || [0, 0];
  if (!qty || !cost) return;

  const rate = Number(cost) / Number(qty);
  db.run('UPDATE event_countries SET exchange_rate = ? WHERE event_id = ? AND UPPER(currency) = ?',
    [rate, eventId, cur]);
}

function walletOf(db, eventId, currency) {
  const cur = String(currency || '').trim().toUpperCase();
  return getEventWallets(db, eventId).find(w => w.currency === cur) || null;
}

/**
 * 지갑의 원가 환율 — 평균 취득 환율, 없으면 일정에 설정된 환율 (원화는 1, 모르면 0).
 * 화면(종료 처리의 취득 원가·환차손익 표시)도 이 값을 써야 DB 계산과 어긋나지 않는다.
 */
export function getWalletRate(db, eventId, wallet) {
  if (!wallet) return 0;
  if (wallet.currency === KRW) return 1;
  if (wallet.avgRate) return wallet.avgRate;
  const c = getEventCountries(db, eventId)
    .find(x => String(x.currency).trim().toUpperCase() === wallet.currency);
  return c?.exchange_rate || 0;
}

/** 지갑의 현지 금액을 원화로 환산한다. 평균 환율이 없으면 일정에 설정된 환율을 쓴다. */
function walletKrw(db, eventId, wallet, foreignAmount) {
  return Math.round(foreignAmount * getWalletRate(db, eventId, wallet));
}

/** 가계부에 거래를 만들 때의 분류 검사 — 세부카테고리가 있는 카테고리면 세부카테고리도 필수 */
function requireCategory(db, budgetCategory, subCategory, what) {
  if (!budgetCategory) throw new Error(`${what} 카테고리를 선택하세요`);
  if (!subCategory && getSubCategories(db, budgetCategory).length > 0) {
    throw new Error(`${what} 세부카테고리를 선택하세요`);
  }
}

/**
 * 실물 정산 — 지갑에 실제로 남은 현금을 입력해 계산상 잔액과 맞춘다.
 *  mode 'expense' : 부족분을 '미기록 현금 지출'로 가계부에 기록 (잔액은 자동으로 맞춰짐)
 *  mode 'adjust'  : 가계부는 두고 지갑 잔액만 보정
 */
export function reconcileEventWallet(db, opts) {
  const cur = String(opts.currency || '').trim().toUpperCase();
  const wallet = walletOf(db, opts.event_id, cur);
  if (!wallet) throw new Error('지갑을 찾을 수 없습니다');

  const actual = Number(opts.actual);
  if (!isFinite(actual) || actual < 0) throw new Error('실제 잔액을 입력하세요');

  const diff = Number((actual - wallet.balance).toFixed(2));
  if (Math.abs(diff) < 0.005) return { diff: 0 };

  const date = opts.date || todayLocal();

  if (opts.mode === 'expense' && diff < 0) {
    requireCategory(db, opts.budget_category, opts.sub_category, '지출로 기록할');
    const missing = -diff;
    addTransaction(db, {
      payment_method: '현금',
      date,
      budget_category: opts.budget_category || '',
      sub_category: opts.sub_category || '',
      detail: opts.detail || '미기록 현금 지출 (정산)',
      amount: walletKrw(db, opts.event_id, wallet, missing),
      event_id: opts.event_id,
      foreign_amounts: cur === KRW ? {} : { [cur]: missing },
    });
    return { diff, mode: 'expense' };
  }

  addEventCashFlow(db, {
    event_id: opts.event_id,
    date,
    type: 'adjust',
    currency: cur,
    amount: diff,
    krw_cost: 0,
    note: opts.detail || '실물 정산',
  });
  return { diff, mode: 'adjust' };
}

/**
 * 여행 종료 처리 — 남은 현금을 정리한다.
 *  mode 'refund'    : 재환전해서 계좌로 입금 (received_krw, account_id)
 *  mode 'carryover' : 다른 일정으로 이월 (target_event_id) — 취득 원가도 함께 넘긴다
 *  mode 'writeoff'  : 남은 현금을 지갑에서 비움 (원화 현금으로 보관 등)
 * 재환전 시 환차손익을 계산해 돌려주고, record_fx가 참이면 가계부에도 반영한다.
 */
export function closeEventWallet(db, opts) {
  const cur = String(opts.currency || '').trim().toUpperCase();
  const wallet = walletOf(db, opts.event_id, cur);
  if (!wallet) throw new Error('지갑을 찾을 수 없습니다');

  const balance = Number(wallet.balance.toFixed(2));
  if (Math.abs(balance) < 0.005) return { closed: false };

  // 잔액이 음수면 환전 기록이 빠진 것 — 재환전·이월하면 가짜 환차익·빚 이월이 생긴다
  if (balance < 0 && opts.mode !== 'writeoff') {
    throw new Error('잔액이 음수인 지갑은 재환전·이월할 수 없습니다. 빠진 환전 기록을 추가하거나 "지갑에서 비우기"를 쓰세요.');
  }

  const date = opts.date || todayLocal();

  if (opts.mode === 'carryover') {
    if (!opts.target_event_id) throw new Error('이월할 일정을 선택하세요');
    const srcTitle = db.exec('SELECT title FROM calendar_events WHERE id = ?', [opts.event_id])[0]?.values[0][0] || '';
    const dstTitle = db.exec('SELECT title FROM calendar_events WHERE id = ?', [opts.target_event_id])[0]?.values[0][0] || '';

    return withTransaction(db, () => {
      const outId = addEventCashFlow(db, {
        event_id: opts.event_id, date, type: 'carryover_out', currency: cur,
        amount: -balance, krw_cost: 0, note: `${dstTitle}(으)로 이월`,
      });

      // 이월 대상에 해당 통화가 없으면 만들어 줘야 환율이 따라간다
      const hasCountry = getEventCountries(db, opts.target_event_id)
        .some(c => String(c.currency).trim().toUpperCase() === cur);
      if (!hasCountry && cur !== KRW) {
        addEventCountry(db, opts.target_event_id, wallet.country || cur, cur, wallet.avgRate || 0);
      }

      // 나감 ↔ 들어옴을 서로 연결해 두어, 한쪽을 지우면 짝도 함께 지운다
      const inId = addEventCashFlow(db, {
        event_id: opts.target_event_id, date, type: 'carryover_in', currency: cur,
        amount: balance, krw_cost: walletKrw(db, opts.event_id, wallet, balance),
        note: `${srcTitle}에서 이월`, linked_flow_id: outId,
      });
      db.run('UPDATE event_cash_flows SET linked_flow_id = ? WHERE id = ?', [inId, outId]);
      return { closed: true, mode: 'carryover', balance };
    });
  }

  if (opts.mode === 'refund') {
    const received = Math.round(Number(opts.received_krw) || 0);

    // 취득 원가 대비 실제로 회수한 금액의 차이 = 환차손익.
    // 원가를 모르면(환율 없음) 차이를 계산할 수 없으므로 기록하지 않는다.
    const basis = walletKrw(db, opts.event_id, wallet, balance);
    const fx = basis > 0 ? received - basis : 0;
    const recordFx = !!opts.record_fx && fx !== 0 && cur !== KRW;
    if (recordFx) requireCategory(db, opts.budget_category, opts.sub_category, '환차손익을 기록할');

    return withTransaction(db, () => {
      const flowId = addEventCashFlow(db, {
        event_id: opts.event_id, date, type: 'refund', currency: cur,
        amount: -balance, krw_cost: received, account_id: opts.account_id || null,
        note: opts.note || (cur === KRW ? '현금 입금' : '재환전 후 입금'),
      });

      if (recordFx) {
        const txId = addTransaction(db, {
          payment_method: '현금',
          date,
          budget_category: opts.budget_category,
          sub_category: opts.sub_category || '',
          detail: fx < 0 ? '환전 차손' : '환전 차익',
          amount: fx < 0 ? -fx : 0,
          discount_amount: fx > 0 ? fx : 0,
          event_id: opts.event_id,
          is_cash_adjustment: 1,
        });
        // 재환전 기록을 지우면 이 환차손익 거래도 함께 지운다
        db.run('UPDATE event_cash_flows SET linked_tx_id = ? WHERE id = ?', [txId, flowId]);
      }
      return { closed: true, mode: 'refund', balance, basis, fx, recordedFx: recordFx };
    });
  }

  addEventCashFlow(db, {
    event_id: opts.event_id, date, type: 'close', currency: cur,
    amount: -balance, krw_cost: 0, note: opts.note || '지갑 정리',
  });
  return { closed: true, mode: 'writeoff', balance };
}
