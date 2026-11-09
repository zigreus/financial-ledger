// 여행 정산 — 일행 N빵 (I-030, ROADMAP C-11) — 선택 기능: 설정에서 켜야 화면에 보인다(가족 공통 설정).
//
// 여행 일정마다 일행(trip_participants)을 두고, 누가 냈고 누구 몫인지로 정산표("A가 B에게 32,000원")를 만든다.
//  - 일행에는 '우리'(이 가계부를 쓰는 집, is_me)가 늘 있다. 사람마다 몫 수(weight — 예: 우리 집 4명이면 4)를 둔다.
//  - 나눌 지출
//    · 가계부의 여행 거래(transactions.event_id = 그 여행): 우리가 낸 돈. 기본은 일행 모두가 몫대로 나눈다.
//      거래마다 나눌 사람을 고르거나 정산에서 뺄 수 있다 — 그 설정만 trip_split_entries(transaction_id 있음)에 둔다.
//      금액은 순지출(amount - discount_amount, AGENTS §4). 여행 현금의 환차손익 조정 거래는 나누지 않는다.
//    · 일행이 낸 돈: trip_split_entries(transaction_id 없음)에 낸 사람·내용·원화 금액·나눌 사람을 적는다.
//      우리 가계부의 지출이 아니다(우리 몫은 정산할 때 돌려주는 돈으로 나간다).
//  - 사람은 이름으로 가리킨다(payer, shared_by의 JSON 이름 목록) — 병합 때 id가 바뀌어도 그대로 맞고,
//    이름을 바꾸면 이 일정의 지출 기록도 함께 고친다(AGENTS §3과 같은 방식). shared_by가 ''이면 모두.
//  - 일정을 지우면 일행과 나눌 지출도 함께 지운다(db/calendar.js deleteCalendarEvent, B-053과 같은 정리).
//  - 몫은 원 단위로 나누고, 나누어떨어지지 않는 몇 원은 나누는 사람 순서대로 1원씩 더 낸다.

import { dbRowsToObjects, withTransaction } from './common';
import { getSetting, setSetting } from './settings';

export const TRIP_SPLIT_SETTING = 'trip_split_enabled';
export const TRIP_ME_DEFAULT_NAME = '우리';

export function isTripSplitEnabled(db) {
  return !!db && getSetting(db, TRIP_SPLIT_SETTING, '0') === '1';
}

export function setTripSplitEnabled(db, enabled) {
  setSetting(db, TRIP_SPLIT_SETTING, enabled ? '1' : '0');
}

const cleanName = (s) => String(s || '').trim().slice(0, 30);
const parseNames = (s) => {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? [...new Set(v.map(String))] : null;   // 같은 이름이 두 번 있어도 한 번만(병합·이름 바꾸기로 겹칠 수 있다)
  } catch (e) {
    return null;
  }
};
const namesJson = (names) => (Array.isArray(names) && names.length ? JSON.stringify([...new Set(names.map(cleanName).filter(Boolean))]) : '');

/** 일행 — '우리'가 맨 앞. 아직 아무도 정하지 않았으면 빈 목록('우리'는 ensureTripMe가 처음 쓸 때 만든다) */
export function getTripParticipants(db, eventId) {
  return dbRowsToObjects(db.exec(
    'SELECT id, name, is_me, weight FROM trip_participants WHERE event_id = ? ORDER BY is_me DESC, sort_order, id',
    [eventId],
  )).map(p => ({ id: p.id, name: p.name, isMe: !!p.is_me, weight: Math.max(1, Number(p.weight) || 1) }));
}

/**
 * '우리'가 없으면 만든다 — 일행을 처음 정할 때 부른다.
 * INSERT … VALUES로만 쓴다: 병합 때 다시 실행하면 변경 기록이 VALUES의 event_id를 새 id로 바꿔 끼우기 때문이다
 * (INSERT … SELECT의 ?는 어느 칸인지 알 수 없어 바꿔 끼우지 못한다). 일정마다 '우리'는 하나(부분 UNIQUE 인덱스)라
 * 두 기기가 따로 만들어도 하나만 남는다.
 */
export function ensureTripMe(db, eventId) {
  if (db.exec('SELECT 1 FROM trip_participants WHERE event_id = ? AND is_me = 1', [eventId])[0]?.values.length) return;
  db.run(
    'INSERT OR IGNORE INTO trip_participants (event_id, name, is_me, weight, sort_order) VALUES (?, ?, 1, 1, 0)',
    [eventId, TRIP_ME_DEFAULT_NAME],
  );
}

export function addTripParticipant(db, eventId, name, weight = 1) {
  const n = cleanName(name);
  if (!n) throw new Error('이름을 입력하세요');
  if (getTripParticipants(db, eventId).some(p => p.name === n)) throw new Error('이미 같은 이름이 있습니다');
  withTransaction(db, () => {
    ensureTripMe(db, eventId);
    const nextSort = (Number(db.exec('SELECT COALESCE(MAX(sort_order), 0) FROM trip_participants WHERE event_id = ?', [eventId])[0]?.values[0][0]) || 0) + 1;
    db.run(
      'INSERT OR IGNORE INTO trip_participants (event_id, name, is_me, weight, sort_order) VALUES (?, ?, 0, ?, ?)',
      [eventId, n, Math.max(1, Math.round(Number(weight) || 1)), nextSort],
    );
  });
}

export function setTripParticipantWeight(db, eventId, name, weight) {
  const w = Math.round(Number(weight));
  if (!Number.isFinite(w) || w < 1 || w > 99) throw new Error('몫은 1~99로 정하세요');
  db.run('UPDATE trip_participants SET weight = ? WHERE event_id = ? AND name = ?', [w, eventId, name]);
}

// 이름이 일행 표에서 사라졌을 때만(이름 바꾸기·빼기가 실제로 됐을 때만) 지출 기록을 따라 고친다 — 병합 때 다른 기기가
// 그 사이 같은 이름을 새로 더해 이름 바꾸기가 UNIQUE로 건너뛰어지면, 낸 사람·나눌 사람도 그대로 둔다
const GONE_SQL = 'NOT EXISTS (SELECT 1 FROM trip_participants WHERE event_id = ? AND name = ?)';
// 나눌 사람 목록(JSON)의 이름들 — 빈 칸('' = 모두)은 NULL로 바꿔 0행(json_each('')는 오류라 평가 순서에 기대지 않게)
const NAMES = "json_each(NULLIF(trip_split_entries.shared_by, ''))";
// 나눌 사람 목록에 그 이름이 있는지
const LISTS_SQL = `EXISTS (SELECT 1 FROM ${NAMES} WHERE value = ?)`;
// 그 이름만 있는지(다른 이름이 없는지) — LISTS_SQL과 함께 쓴다
const ONLY_SQL = `NOT EXISTS (SELECT 1 FROM ${NAMES} WHERE value <> ?)`;
// 이 일정에서 쓰이는 줄 — 일행이 낸 돈, 또는 지금 이 일정에 연결된 가계부 거래의 나눔 설정(지웠거나 옮긴 거래의 것은 빼고)
const LIVE_SQL = `(trip_split_entries.transaction_id IS NULL OR EXISTS (SELECT 1 FROM transactions t
  WHERE t.id = trip_split_entries.transaction_id AND t.event_id = trip_split_entries.event_id))`;

/** 낸 사람·나눌 사람의 이름 from을 to로 — from이 일행 표에 없을 때만(이름 바꾸기·바꿔 잇기가 실제로 됐을 때만) */
function moveNameInEntries(db, eventId, from, to) {
  db.run(`UPDATE trip_split_entries SET payer = ? WHERE event_id = ? AND payer = ? AND ${GONE_SQL}`, [to, eventId, from, eventId, from]);
  db.run(
    `UPDATE trip_split_entries
     SET shared_by = (SELECT json_group_array(DISTINCT CASE WHEN value = ? THEN ? ELSE value END) FROM ${NAMES})
     WHERE event_id = ? AND ${LISTS_SQL} AND ${GONE_SQL}`,
    [from, to, eventId, from, eventId, from],
  );
}

/**
 * 이름 바꾸기 — 이 일정의 지출 기록(낸 사람·나눌 사람)도 함께 고친다.
 * 행마다 id로 고치지 않고 일정 전체에 한 문장으로 적용한다 — 병합 때 다른 기기가 그 사이 옛 이름으로 적은 지출도 따라오게.
 */
export function renameTripParticipant(db, eventId, oldName, newName) {
  const n = cleanName(newName);
  if (!n) throw new Error('이름을 입력하세요');
  if (n === oldName) return;
  if (getTripParticipants(db, eventId).some(p => p.name === n)) throw new Error('이미 같은 이름이 있습니다');
  withTransaction(db, () => {
    db.run('UPDATE trip_participants SET name = ? WHERE event_id = ? AND name = ?', [n, eventId, oldName]);
    moveNameInEntries(db, eventId, oldName, n);
  });
}

/**
 * 일행 목록에 없는 이름(병합으로 엇갈린 이름)을 일행 중 한 사람으로 바꿔 잇는다 — 다른 기기가 이름을 바꾼 사이 옛 이름으로
 * 적은 지출을 바로잡는다(다시 더하면 같은 사람이 둘이 된다). 일행 표는 건드리지 않는다.
 */
export function reassignTripName(db, eventId, fromName, toName) {
  const names = new Set(getTripParticipants(db, eventId).map(p => p.name));
  if (!names.has(toName)) throw new Error('바꿔 이을 사람을 일행에서 고르세요');
  if (names.has(fromName)) throw new Error(`${fromName}님은 이미 일행에 있습니다`);
  withTransaction(db, () => moveNameInEntries(db, eventId, fromName, toName));
}

/** 빼기 전 확인 문구용 — { paid: 그 사람이 낸 돈 기록 수, onlyFor: 그 사람 몫으로만 나눈(아직 나누는) 지출 수 } */
export function countTripEntriesFor(db, eventId, name) {
  const one = (sql, params) => Number(db.exec(sql, params)[0]?.values[0][0]) || 0;
  return {
    paid: one('SELECT COUNT(*) FROM trip_split_entries WHERE event_id = ? AND payer = ? AND transaction_id IS NULL', [eventId, name]),
    onlyFor: one(
      `SELECT COUNT(*) FROM trip_split_entries WHERE event_id = ? AND excluded = 0 AND ${LIVE_SQL} AND ${LISTS_SQL} AND ${ONLY_SQL}`,
      [eventId, name, name],
    ),
  };
}

/**
 * 일행에서 빼기('우리'는 뺄 수 없다) — 그 사람이 낸 돈 기록은 지우고, 나눌 사람 목록에서도 뺀다.
 * 그 사람 몫으로만 나눈 지출은 남은 사람에게 넘어가지 않게 정산에서 뺀다(확인창이 수를 알린다).
 */
export function deleteTripParticipant(db, eventId, name) {
  const p = getTripParticipants(db, eventId).find(x => x.name === name);
  if (!p) return;
  if (p.isMe) throw new Error("'우리'는 뺄 수 없습니다");
  withTransaction(db, () => {
    db.run('DELETE FROM trip_participants WHERE event_id = ? AND name = ? AND is_me = 0', [eventId, name]);
    db.run(`DELETE FROM trip_split_entries WHERE event_id = ? AND payer = ? AND transaction_id IS NULL AND ${GONE_SQL}`, [eventId, name, eventId, name]);
    db.run(
      `UPDATE trip_split_entries SET excluded = 1
       WHERE event_id = ? AND ${LISTS_SQL} AND ${ONLY_SQL} AND ${GONE_SQL}`,
      [eventId, name, name, eventId, name],
    );
    db.run(
      `UPDATE trip_split_entries
       SET shared_by = (SELECT json_group_array(DISTINCT value) FROM ${NAMES} WHERE value <> ?)
       WHERE event_id = ? AND ${LISTS_SQL} AND ${GONE_SQL}`,
      [name, eventId, name, eventId, name],
    );
  });
}

function entriesOf(db, eventId) {
  return dbRowsToObjects(db.exec('SELECT * FROM trip_split_entries WHERE event_id = ? ORDER BY date, id', [eventId]));
}

/** 일행이 낸 돈의 내용 검사 — 낸 사람·나눌 사람은 지금 일행에 있는 이름만, 금액은 0보다 큰 원화 정수 */
function checkPayment(db, eventId, { payer, amount, sharedBy }) {
  const names = new Set(getTripParticipants(db, eventId).map(p => p.name));
  if (!cleanName(payer)) throw new Error('낸 사람을 고르세요');
  if (!names.has(cleanName(payer))) throw new Error('낸 사람이 일행에 없습니다 — 낸 사람을 다시 고르세요');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('금액은 0보다 크게 적으세요');
  return (sharedBy || []).filter(n => names.has(n));
}

/** 일행이 낸 돈 추가 — amount는 원화 정수(AmountInput으로 검사한 값), sharedBy: 이름 목록(비우면 모두) */
export function addTripPayment(db, eventId, { payer, title, date, amount, sharedBy }) {
  withTransaction(db, () => {
    ensureTripMe(db, eventId);
    const shared = checkPayment(db, eventId, { payer, amount, sharedBy });
    db.run(
      'INSERT INTO trip_split_entries (event_id, transaction_id, payer, title, date, amount, shared_by) VALUES (?, NULL, ?, ?, ?, ?, ?)',
      [eventId, cleanName(payer), String(title || '').trim().slice(0, 60), date || '', Math.round(amount), namesJson(shared)],
    );
  });
}

/** 일행이 낸 돈 고치기 — 정산에서 빠진 상태(excluded)는 그대로 둔다(빼기·다시 나누기는 setTripPaymentExcluded로) */
export function updateTripPayment(db, id, { payer, title, date, amount, sharedBy }) {
  const row = dbRowsToObjects(db.exec('SELECT event_id FROM trip_split_entries WHERE id = ? AND transaction_id IS NULL', [id]))[0];
  if (!row) throw new Error('지출 기록을 찾지 못했습니다 — 다른 기기에서 지웠을 수 있습니다');
  const shared = checkPayment(db, row.event_id, { payer, amount, sharedBy });
  db.run(
    'UPDATE trip_split_entries SET payer = ?, title = ?, date = ?, amount = ?, shared_by = ? WHERE id = ? AND transaction_id IS NULL',
    [cleanName(payer), String(title || '').trim().slice(0, 60), date || '', Math.round(amount), namesJson(shared), id],
  );
}

/** 일행이 낸 돈을 정산에서 빼거나 다시 나눈다 */
export function setTripPaymentExcluded(db, id, excluded) {
  db.run('UPDATE trip_split_entries SET excluded = ? WHERE id = ? AND transaction_id IS NULL', [excluded ? 1 : 0, id]);
}

export function deleteTripPayment(db, id) {
  db.run('DELETE FROM trip_split_entries WHERE id = ? AND transaction_id IS NULL', [id]);
}

/**
 * 가계부 거래의 나눔 설정 — sharedBy: 이름 목록(비우면 모두), excluded: 정산에서 뺌.
 * 거래마다 한 줄(일정+거래로 UNIQUE) — 없으면 만들고 있으면 고친다(병합 때 양쪽에서 만들어도 한 줄).
 */
export function setTripTxSplit(db, eventId, transactionId, { sharedBy, excluded }) {
  const names = new Set(getTripParticipants(db, eventId).map(p => p.name));
  const shared = (sharedBy || []).filter(n => names.has(n));
  withTransaction(db, () => {
    db.run(
      'INSERT OR IGNORE INTO trip_split_entries (event_id, transaction_id, payer, shared_by, excluded) VALUES (?, ?, \'\', \'\', 0)',
      [eventId, transactionId],
    );
    db.run(
      'UPDATE trip_split_entries SET shared_by = ?, excluded = ? WHERE event_id = ? AND transaction_id = ?',
      [namesJson(shared), excluded ? 1 : 0, eventId, transactionId],
    );
  });
}

/** 일정을 지울 때 — 일행과 나눌 지출을 함께 지운다 */
export function deleteTripSplitData(db, eventId) {
  db.run('DELETE FROM trip_split_entries WHERE event_id = ?', [eventId]);
  db.run('DELETE FROM trip_participants WHERE event_id = ?', [eventId]);
}

/** 금액을 몫대로 원 단위로 나눈다 — [{ name, share }], 남는 몇 원은 앞사람부터 1원씩 */
export function splitAmount(amount, sharers) {
  const total = sharers.reduce((s, p) => s + p.weight, 0);
  if (!total) return [];
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  const shares = sharers.map(p => ({ name: p.name, share: Math.floor((abs * p.weight) / total) }));
  let rest = abs - shares.reduce((s, x) => s + x.share, 0);
  for (let i = 0; rest > 0; i = (i + 1) % shares.length) { shares[i].share += 1; rest -= 1; }
  return shares.map(x => ({ name: x.name, share: x.share * sign }));
}

/**
 * 여행 정산 — {
 *   people: [{ name, isMe, weight, paid, owed, balance }] — balance > 0이면 받을 돈, < 0이면 줄 돈,
 *   items: [{ key, kind: 'tx'|'payment', id, transactionId, date, title, amount, payer, sharedBy: [이름]|null, excluded, unknown: [이름] }],
 *   total: 나눈 지출 합계, transfers: [{ from, to, amount }] (보낼 사람 → 받을 사람, 적은 건수로),
 *   unknownNames: 일행 목록에 없는 이름 — 병합 때 다른 기기가 그 사이 이름을 바꾸거나 뺀 경우.
 *     그 이름이 낸 사람·나눌 사람인 지출은 나누지 않고(모두에게 넘기지 않는다) 화면이 알려 일행에 다시 더하게 한다
 * }
 */
export function getTripSettlement(db, eventId) {
  const people = getTripParticipants(db, eventId);
  if (!people.length) {
    people.push({ id: null, name: TRIP_ME_DEFAULT_NAME, isMe: true, weight: 1 });
  }
  const me = people.find(p => p.isMe) || people[0];
  const byName = new Map(people.map(p => [p.name, p]));
  const entries = entriesOf(db, eventId);
  const txSetting = new Map(entries.filter(e => e.transaction_id !== null && e.transaction_id !== undefined).map(e => [e.transaction_id, e]));

  const txs = dbRowsToObjects(db.exec(
    `SELECT id, date, detail, budget_category, amount, COALESCE(discount_amount, 0) AS discount_amount
     FROM transactions WHERE event_id = ? AND COALESCE(is_cash_adjustment, 0) = 0
     ORDER BY date, id`,
    [eventId],
  ));
  const items = [
    ...txs.map(t => {
      const s = txSetting.get(t.id);
      return {
        key: `t${t.id}`, kind: 'tx', id: s?.id ?? null, transactionId: t.id, date: t.date,
        title: String(t.detail || '').trim() || t.budget_category || '',
        amount: (Number(t.amount) || 0) - (Number(t.discount_amount) || 0),
        payer: me.name, sharedBy: parseNames(s?.shared_by), excluded: !!s?.excluded,
      };
    }),
    ...entries.filter(e => e.transaction_id === null || e.transaction_id === undefined).map(e => ({
      key: `p${e.id}`, kind: 'payment', id: e.id, transactionId: null, date: e.date || '', title: e.title || '',
      amount: Number(e.amount) || 0, payer: e.payer, sharedBy: parseNames(e.shared_by), excluded: !!e.excluded,
    })),
  ].sort((a, b) => (a.date || '').localeCompare(b.date || '')
    || (a.kind === b.kind ? 0 : a.kind === 'tx' ? -1 : 1)                // 같은 날이면 가계부 거래 먼저
    || (a.transactionId ?? a.id) - (b.transactionId ?? b.id));

  const paid = new Map(people.map(p => [p.name, 0]));
  const owed = new Map(people.map(p => [p.name, 0]));
  const unknownNames = new Set();
  let total = 0;
  items.forEach(it => {
    it.unknown = [it.payer, ...(it.sharedBy || [])].filter(n => n && !byName.has(n));
    if (it.excluded || !it.amount) return;
    if (it.unknown.length) {            // 목록에 없는 이름 — 나누지 않고 알린다
      it.unknown.forEach(n => unknownNames.add(n));
      return;
    }
    const payer = byName.get(it.payer);
    const named = (it.sharedBy || []).map(n => byName.get(n));
    const sharers = named.length ? named : people;
    total += it.amount;
    paid.set(payer.name, paid.get(payer.name) + it.amount);
    splitAmount(it.amount, sharers).forEach(({ name, share }) => owed.set(name, owed.get(name) + share));
  });

  const list = people.map(p => ({
    name: p.name, isMe: p.isMe, weight: p.weight, paid: paid.get(p.name), owed: owed.get(p.name),
    balance: paid.get(p.name) - owed.get(p.name),
  }));

  // 줄 돈이 큰 사람부터 받을 돈이 큰 사람에게 — 건수를 줄인다
  const debtors = list.filter(p => p.balance < 0).map(p => ({ name: p.name, left: -p.balance })).sort((a, b) => b.left - a.left);
  const creditors = list.filter(p => p.balance > 0).map(p => ({ name: p.name, left: p.balance })).sort((a, b) => b.left - a.left);
  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].left, creditors[j].left);
    if (amount > 0) transfers.push({ from: debtors[i].name, to: creditors[j].name, amount });
    debtors[i].left -= amount;
    creditors[j].left -= amount;
    if (debtors[i].left === 0) i += 1;
    if (creditors[j].left === 0) j += 1;
  }

  return { people: list, items, total, transfers, unknownNames: [...unknownNames] };
}

/** 공유용 텍스트 — 메신저에 붙여 넣는다 */
export function tripSettlementText(title, settlement, formatWon) {
  const s = settlement;
  const lines = [`🧾 ${title} 정산`, `함께 쓴 돈 ${formatWon(s.total)}`];
  s.people.forEach(p => {
    lines.push(`· ${p.name}${p.weight > 1 ? `(${p.weight}몫)` : ''}: 낸 돈 ${formatWon(p.paid)} / 몫 ${formatWon(p.owed)}`);
  });
  lines.push('');
  if (s.transfers.length) {
    lines.push('보낼 돈');
    s.transfers.forEach(t => lines.push(`· ${t.from} → ${t.to} ${formatWon(t.amount)}`));
  } else {
    lines.push('주고받을 돈이 없어요.');
  }
  return lines.join('\n');
}
