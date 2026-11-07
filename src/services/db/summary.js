// 요약 — 월·연·기간별 카테고리/세부카테고리/결제수단 합계, 일정별 합계,
// 월별 추이와 날짜별 합계(캘린더).

import { dbRowsToObjects } from './common';

// ── 요약 ───────────────────────────────────────────────────────

export function getAvailableMonths(db) {
  const result = db.exec(
    "SELECT DISTINCT strftime('%Y-%m', date) as month FROM transactions ORDER BY month DESC"
  );
  return result.length ? result[0].values.map(r => r[0]) : [];
}

// 특정 월의 날짜별 지출 합계 반환 { 'YYYY-MM-DD': { total, discount, count } }
export function getDailyTotals(db, month) {
  if (!db || !month) return {};
  const result = db.exec(
    `SELECT date, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as count
     FROM transactions WHERE strftime('%Y-%m', date) = ?
     GROUP BY date`,
    [month]
  );
  if (!result.length) return {};
  const map = {};
  result[0].values.forEach(row => {
    map[row[0]] = { total: row[1] || 0, discount: row[2] || 0, count: row[3] || 0 };
  });
  return map;
}

// ── 캘린더 이벤트 요약 (요약 탭 일정별) ────────────────────────────

function aggregateEventRows(rows, keyField) {
  const map = {};
  const order = [];
  rows.forEach(obj => {
    const key = obj[keyField];
    if (!map[key]) {
      map[key] = {
        event_id: obj.event_id, event_title: obj.event_title,
        date_from: obj.date_from || '', date_to: obj.date_to || '',
        event_type: obj.event_type, color: obj.color,
        total: 0, discount: 0, cnt: 0, foreignTotals: {},
      };
      order.push(key);
    }
    const e = map[key];
    e.total += obj.amount || 0;
    e.discount += obj.discount_amount || 0;
    e.cnt += 1;
    if (obj.foreign_amounts) {
      try {
        Object.entries(JSON.parse(obj.foreign_amounts)).forEach(([cur, amt]) => {
          e.foreignTotals[cur] = (e.foreignTotals[cur] || 0) + Number(amt);
        });
      } catch {}
    }
  });
  return order.map(k => map[k]).sort((a, b) => b.total - a.total);
}

export function getEventSummary(db, eventType = null) {
  if (!db) return [];
  let q = `SELECT ce.id as event_id, ce.title as event_title,
                  ce.date_from, ce.date_to, ce.event_type, ce.color,
                  t.amount, t.discount_amount, t.foreign_amounts
           FROM transactions t
           JOIN calendar_events ce ON t.event_id = ce.id
           WHERE t.event_id IS NOT NULL`;
  const params = [];
  if (eventType) { q += ' AND ce.event_type = ?'; params.push(eventType); }
  const res = db.exec(q, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  const rows = values.map(row => { const o = {}; columns.forEach((c, i) => o[c] = row[i]); return o; });
  return aggregateEventRows(rows, 'event_id');
}

export function getEventDetailSummary(db, eventId) {
  if (!db || !eventId) return [];
  const res = db.exec(
    'SELECT sub_category, amount, discount_amount, foreign_amounts FROM transactions WHERE event_id = ?',
    [eventId]
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  const subMap = {};
  const subOrder = [];
  values.forEach(row => {
    const obj = {}; columns.forEach((c, i) => obj[c] = row[i]);
    const key = obj.sub_category || '(미분류)';
    if (!subMap[key]) { subMap[key] = { sub_category: key, total: 0, discount: 0, cnt: 0, foreignTotals: {} }; subOrder.push(key); }
    const s = subMap[key];
    s.total += obj.amount || 0;
    s.discount += obj.discount_amount || 0;
    s.cnt += 1;
    if (obj.foreign_amounts) {
      try { Object.entries(JSON.parse(obj.foreign_amounts)).forEach(([cur, amt]) => { s.foreignTotals[cur] = (s.foreignTotals[cur] || 0) + Number(amt); }); } catch {}
    }
  });
  return subOrder.map(k => subMap[k]).sort((a, b) => b.total - a.total);
}

/**
 * 일정에 연결된 거래의 결제수단별 합계.
 *  - eventId가 있으면 그 일정만 (event_type은 '')
 *  - 없으면 결제수단 × 일정 유형별 소계. eventType을 주면 그 유형의 일정만 (요약 화면의 유형 필터)
 */
export function getEventPaymentMethodSummary(db, eventId = null, eventType = null) {
  if (!db) return [];
  let q, params;
  if (eventId) {
    q = `SELECT t.payment_method, '' as event_type,
                SUM(t.amount) as total, SUM(t.discount_amount) as discount, COUNT(*) as cnt
         FROM transactions t WHERE t.event_id = ?
         GROUP BY t.payment_method ORDER BY total DESC`;
    params = [eventId];
  } else {
    q = `SELECT t.payment_method, ce.event_type,
                SUM(t.amount) as total, SUM(t.discount_amount) as discount, COUNT(*) as cnt
         FROM transactions t
         JOIN calendar_events ce ON t.event_id = ce.id
         WHERE t.event_id IS NOT NULL${eventType ? ' AND ce.event_type = ?' : ''}
         GROUP BY t.payment_method, ce.event_type
         ORDER BY t.payment_method, total DESC`;
    params = eventType ? [eventType] : [];
  }
  return dbRowsToObjects(db.exec(q, params));
}

// ── 기간별 요약 (월·연·기간 × 카테고리·세부카테고리·결제수단) ──────────────
// 아래 9개 함수는 기간 조건과 묶는 기준만 다르다. 쿼리는 summarizeTransactions 한 곳에서 만든다.

const SUMMARY_GROUP_COLUMNS = ['budget_category', 'sub_category', 'payment_method', 'member'];

/** 기간 조건 — { month } | { year } | { from, to }. month가 비어 있으면 전체 기간 (연·기간은 항상 적용) */
function summaryPeriod(period) {
  if ('month' in period) {
    return period.month ? { conds: ["strftime('%Y-%m', date) = ?"], params: [period.month] } : { conds: [], params: [] };
  }
  if ('year' in period) return { conds: ["strftime('%Y', date) = ?"], params: [period.year] };
  return { conds: ['date >= ?', 'date <= ?'], params: [period.from, period.to] };
}

/**
 * 거래를 groupBy 열로 묶은 합계: [{ [groupBy], total, discount, cnt }] (total 내림차순).
 * 세부카테고리 요약은 항상 budgetCategory 한 카테고리 안에서 묶는다 (드릴다운).
 */
function summarizeTransactions(db, groupBy, period, budgetCategory) {
  if (!SUMMARY_GROUP_COLUMNS.includes(groupBy)) throw new Error(`알 수 없는 요약 기준: ${groupBy}`);
  const { conds, params } = summaryPeriod(period);
  if (groupBy === 'sub_category') {
    conds.push('budget_category = ?');
    params.push(budgetCategory);
  }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  return dbRowsToObjects(db.exec(
    `SELECT ${groupBy}, SUM(amount) as total, SUM(discount_amount) as discount, COUNT(*) as cnt
     FROM transactions${where}
     GROUP BY ${groupBy} ORDER BY total DESC`,
    params
  ));
}

export function getMonthlySummary(db, month) {
  return summarizeTransactions(db, 'budget_category', { month });
}

export function getMonthlySubCategorySummary(db, month, budgetCategory) {
  return summarizeTransactions(db, 'sub_category', { month }, budgetCategory);
}

export function getMonthlyTotals(db, limit = 24) {
  const query = limit
    ? `SELECT strftime('%Y-%m', date) as month,
              SUM(amount) as total,
              SUM(discount_amount) as discount,
              COUNT(*) as cnt
       FROM transactions
       GROUP BY month ORDER BY month DESC
       LIMIT ${limit}`
    : `SELECT strftime('%Y-%m', date) as month,
              SUM(amount) as total,
              SUM(discount_amount) as discount,
              COUNT(*) as cnt
       FROM transactions
       GROUP BY month ORDER BY month DESC`;
  const result = db.exec(query);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function getPaymentMethodSummary(db, month) {
  return summarizeTransactions(db, 'payment_method', { month });
}

export function getAvailableYears(db) {
  const result = db.exec(
    "SELECT DISTINCT strftime('%Y', date) as year FROM transactions ORDER BY year DESC"
  );
  return result.length ? result[0].values.map(r => r[0]) : [];
}

export function getYearlySummary(db, year) {
  return summarizeTransactions(db, 'budget_category', { year });
}

export function getYearlySubCategorySummary(db, year, budgetCategory) {
  return summarizeTransactions(db, 'sub_category', { year }, budgetCategory);
}

export function getYearlyPaymentMethodSummary(db, year) {
  return summarizeTransactions(db, 'payment_method', { year });
}

export function getRangeSummary(db, dateFrom, dateTo) {
  return summarizeTransactions(db, 'budget_category', { from: dateFrom, to: dateTo });
}

export function getRangeSubCategorySummary(db, dateFrom, dateTo, budgetCategory) {
  return summarizeTransactions(db, 'sub_category', { from: dateFrom, to: dateTo }, budgetCategory);
}

export function getRangePaymentMethodSummary(db, dateFrom, dateTo) {
  return summarizeTransactions(db, 'payment_method', { from: dateFrom, to: dateTo });
}

/**
 * 구성원별 합계 (I-013) — period: { month } | { year } | { from, to }.
 * 반환 행의 member가 빈 문자열이면 '지정 안 함'이다.
 */
export function getMemberSummary(db, period) {
  // NULL과 ''는 같은 '지정 안 함'으로 합친다
  const byMember = new Map();
  summarizeTransactions(db, 'member', period).forEach(r => {
    const key = r.member || '';
    const acc = byMember.get(key) || { member: key, total: 0, discount: 0, cnt: 0 };
    acc.total += r.total || 0;
    acc.discount += r.discount || 0;
    acc.cnt += r.cnt || 0;
    byMember.set(key, acc);
  });
  // 표에 보이는 순지출(지출 - 할인) 순 (B-051)
  return [...byMember.values()].sort((a, b) => (b.total - b.discount) - (a.total - a.discount));
}
