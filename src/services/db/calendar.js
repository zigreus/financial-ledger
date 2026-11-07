// 캘린더 일정 — 일정, 일정의 국가·환율, 일정 유형.

import { withTransaction } from './common';

// ── 캘린더 이벤트 ──────────────────────────────────────────────────

export function getCalendarEvents(db, opts = {}) {
  if (!db) return [];
  let q = 'SELECT * FROM calendar_events WHERE 1=1';
  const params = [];
  if (!opts.includeHidden) { q += ' AND is_hidden = 0'; }
  if (opts.eventType) { q += ' AND event_type = ?'; params.push(opts.eventType); }
  q += ' ORDER BY sort_order, id';
  const res = db.exec(q, params);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    obj.countries = getEventCountries(db, obj.id);
    return obj;
  });
}

export function getCalendarEventsInRange(db, dateFrom, dateTo) {
  if (!db) return [];
  // date_from이 비어있지 않고, 기간이 겹치는 이벤트.
  // 종료일이 없으면 하루짜리, 예전에 시작·종료가 뒤바뀌어 저장된 일정은 두 날짜 중 앞·뒤로 본다.
  const res = db.exec(
    `SELECT * FROM calendar_events
     WHERE is_hidden = 0
       AND date_from != ''
       AND MIN(date_from, COALESCE(NULLIF(date_to, ''), date_from)) <= ?
       AND MAX(date_from, COALESCE(NULLIF(date_to, ''), date_from)) >= ?
     ORDER BY date_from, id`,
    [dateTo, dateFrom]
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    obj.countries = getEventCountries(db, obj.id);
    return obj;
  });
}

export function getUndatedCalendarEvents(db) {
  if (!db) return [];
  const res = db.exec(
    "SELECT * FROM calendar_events WHERE is_hidden = 0 AND (date_from = '' OR date_from IS NULL) ORDER BY sort_order, id"
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    obj.countries = getEventCountries(db, obj.id);
    return obj;
  });
}

export function getEventCountries(db, eventId) {
  if (!db || !eventId) return [];
  const res = db.exec(
    'SELECT id, country, currency, COALESCE(exchange_rate, 0), sort_order FROM event_countries WHERE event_id = ? ORDER BY sort_order, id',
    [eventId]
  );
  if (!res.length) return [];
  return res[0].values.map(([id, country, currency, exchange_rate, sort_order]) =>
    ({ id, country, currency, exchange_rate: Number(exchange_rate) || 0, sort_order }));
}

/** 일정 날짜 검증 — 종료일만 있거나 종료일이 시작일보다 빠르면 달력에 나타나지 않으므로 막는다 */
function validateEventDates(ev) {
  const from = ev.date_from || '';
  const to = ev.date_to || '';
  if (to && !from) throw new Error('종료일이 있으면 시작일도 입력하세요');
  if (from && to && to < from) throw new Error('종료일이 시작일보다 빠릅니다');
}

export function addCalendarEvent(db, ev) {
  if (!db || !ev.title?.trim()) throw new Error('제목을 입력하세요');
  validateEventDates(ev);
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), -1) FROM calendar_events');
  const nextSort = (maxSort[0]?.values[0][0] ?? -1) + 1;
  db.run(
    `INSERT INTO calendar_events (title, date_from, date_to, event_type, color, note, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ev.title.trim(), ev.date_from || '', ev.date_to || '', ev.event_type || 'general',
     ev.color || '', ev.note || '', nextSort]
  );
  const res = db.exec('SELECT last_insert_rowid()');
  return res[0].values[0][0];
}

export function updateCalendarEvent(db, id, ev) {
  if (!db || !ev.title?.trim()) throw new Error('제목을 입력하세요');
  validateEventDates(ev);
  db.run(
    `UPDATE calendar_events SET title=?, date_from=?, date_to=?, event_type=?, color=?, note=?, is_hidden=?
     WHERE id=?`,
    [ev.title.trim(), ev.date_from || '', ev.date_to || '', ev.event_type || 'general',
     ev.color || '', ev.note || '', ev.is_hidden ? 1 : 0, id]
  );
}

/**
 * 일정을 지우면 함께 바뀌는 것 — 삭제 확인 문구용.
 *  txCount: 일정 연결만 풀리고 남는 거래 수
 *  flowCount: 같이 지워지는 환전·정산 기록 수 (accountFlowCount: 그중 계좌 입출금으로도 기록된 것)
 */
export function getCalendarEventLinkCounts(db, id) {
  if (!db || !id) return { txCount: 0, flowCount: 0, accountFlowCount: 0 };
  const one = (sql) => Number(db.exec(sql, [id])[0]?.values[0][0]) || 0;
  return {
    txCount: one('SELECT COUNT(*) FROM transactions WHERE event_id = ?'),
    flowCount: one('SELECT COUNT(*) FROM event_cash_flows WHERE event_id = ?'),
    // addEventCashFlow는 계좌를 지정하고 원화 금액이 있을 때만 계좌 내역을 만든다
    accountFlowCount: one(`SELECT COUNT(*) FROM event_cash_flows
      WHERE event_id = ? AND account_id IS NOT NULL AND COALESCE(krw_cost, 0) != 0`),
  };
}

/**
 * 일정 삭제 — 국가·환율과 환전·정산 기록(event_cash_flows)은 함께 지우고,
 * 연결된 거래는 남긴 채 일정 연결만 푼다. 계좌 입출금 내역(account_transactions)은 실제 돈의 이동이라 그대로 둔다.
 */
export function deleteCalendarEvent(db, id) {
  withTransaction(db, () => {
    db.run('DELETE FROM event_countries WHERE event_id = ?', [id]);
    // 다른 일정에 남는 이월 짝은 실제로 옮긴 현금이라 지우지 않고, 연결만 끊는다
    db.run(`UPDATE event_cash_flows SET linked_flow_id = NULL
            WHERE event_id != ? AND linked_flow_id IN (SELECT id FROM event_cash_flows WHERE event_id = ?)`, [id, id]);
    db.run('DELETE FROM event_cash_flows WHERE event_id = ?', [id]);
    db.run('UPDATE transactions SET event_id = NULL WHERE event_id = ?', [id]);
    db.run('DELETE FROM calendar_events WHERE id = ?', [id]);
  });
}

export function addEventCountry(db, eventId, country, currency, exchangeRate = 0) {
  const maxSort = db.exec('SELECT COALESCE(MAX(sort_order), -1) FROM event_countries WHERE event_id = ?', [eventId]);
  const nextSort = (maxSort[0]?.values[0][0] ?? -1) + 1;
  db.run('INSERT INTO event_countries (event_id, country, currency, exchange_rate, sort_order) VALUES (?, ?, ?, ?, ?)',
    [eventId, country, currency, Number(exchangeRate) || 0, nextSort]);
}

export function updateEventCountry(db, id, country, currency, exchangeRate = 0) {
  db.run('UPDATE event_countries SET country=?, currency=?, exchange_rate=? WHERE id=?',
    [country, currency, Number(exchangeRate) || 0, id]);
}

export function deleteEventCountry(db, id) {
  db.run('DELETE FROM event_countries WHERE id = ?', [id]);
}

// ── 캘린더 일정 유형 ────────────────────────────────────────────────

export function getCalendarEventTypes(db) {
  if (!db) return [];
  const res = db.exec(
    'SELECT id, value, label, color, sort_order, is_system, is_trip_type FROM calendar_event_types ORDER BY sort_order, id'
  );
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => { const o = {}; columns.forEach((c, i) => o[c] = row[i]); return o; });
}

export function addCalendarEventType(db, { label, color }) {
  if (!label?.trim()) throw new Error('유형 이름을 입력하세요');
  const slug = label.trim().replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  const value = (slug.replace(/_/g, '').length >= 2) ? slug : 'type_' + Date.now();
  const maxSort = db.exec(
    "SELECT COALESCE(MAX(sort_order), 0) FROM calendar_event_types WHERE value != 'general'"
  );
  const nextSort = (maxSort[0]?.values[0][0] ?? 0) + 1;
  db.run(
    'INSERT INTO calendar_event_types (value, label, color, sort_order, is_system, is_trip_type) VALUES (?, ?, ?, ?, 0, 0)',
    [value, label.trim(), color || '#9CA3AF', nextSort]
  );
}

export function updateCalendarEventType(db, id, { label, color }) {
  if (!label?.trim()) throw new Error('유형 이름을 입력하세요');
  db.run('UPDATE calendar_event_types SET label=?, color=? WHERE id=?', [label.trim(), color, id]);
}

export function deleteCalendarEventType(db, id) {
  const row = db.exec('SELECT value, is_system FROM calendar_event_types WHERE id = ?', [id]);
  if (!row.length || !row[0].values.length) throw new Error('유형을 찾을 수 없습니다');
  const [value, isSystem] = row[0].values[0];
  if (isSystem) throw new Error('시스템 유형은 삭제할 수 없습니다');
  const usage = db.exec('SELECT COUNT(*) FROM calendar_events WHERE event_type = ?', [value]);
  const cnt = usage[0]?.values[0][0] || 0;
  if (cnt > 0) throw new Error(`${cnt}개 일정에서 사용 중입니다`);
  db.run('DELETE FROM calendar_event_types WHERE id = ?', [id]);
}

/**
 * 일정 유형을 targetIndex로 옮긴다 (B-026).
 * targetIndex는 옮기는 유형을 뺀 목록 기준이다 (moveItemToPosition·reorderFavorite와 같은 규칙).
 */
export function moveCalendarEventType(db, id, targetIndex) {
  const all = getCalendarEventTypes(db);
  const fromIdx = all.findIndex(t => t.id === id);
  if (fromIdx === -1) return;
  const reordered = [...all];
  const [moved] = reordered.splice(fromIdx, 1);
  const clamped = Math.max(0, Math.min(targetIndex, reordered.length));
  reordered.splice(clamped, 0, moved);
  withTransaction(db, () => {
    reordered.forEach((t, i) => {
      db.run('UPDATE calendar_event_types SET sort_order=? WHERE id=?', [i, t.id]);
    });
  });
}

export function getCalendarEventTypeUsageCount(db, value) {
  if (!db) return 0;
  const res = db.exec('SELECT COUNT(*) FROM calendar_events WHERE event_type = ?', [value]);
  return res[0]?.values[0][0] || 0;
}

export function setCalendarEventTypeTripFlag(db, id, isTripType) {
  db.run('UPDATE calendar_event_types SET is_trip_type=? WHERE id=?', [isTripType ? 1 : 0, id]);
}
