// 여행 정산 — 일행 N빵 (I-030, ROADMAP C-11) — 일행·몫, 우리가 낸 여행 거래와 일행이 낸 돈, 나눔 설정, 정산표·공유 글
import initSqlJs from 'sql.js';
import {
  createDatabase, SCHEMA_VERSION, addCalendarEvent, deleteCalendarEvent, getCalendarEventLinkCounts, addTransaction,
  isTripSplitEnabled, setTripSplitEnabled, getTripParticipants, ensureTripMe, addTripParticipant, setTripParticipantWeight,
  renameTripParticipant, deleteTripParticipant, countTripEntriesFor, addTripPayment, updateTripPayment, deleteTripPayment,
  setTripTxSplit, getTripSettlement, splitAmount, tripSettlementText, deleteTransaction, updateTransaction, getTransactions,
  reassignTripName,
} from '../dbManager';
import { attachChangeLog, getChangeLog, replayChanges } from '../changeLog';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

function makeDb() {
  const { db } = createDatabase(SQL, null);
  const trip = addCalendarEvent(db, { title: '제주 여행', date_from: '2026-10-01', date_to: '2026-10-03', event_type: 'trip' });
  const other = addCalendarEvent(db, { title: '다른 여행', date_from: '2026-11-01', date_to: '2026-11-02', event_type: 'trip' });
  const spend = (date, amount, extra = {}) => addTransaction(db, {
    payment_method: '카드', date, budget_category: '여행', detail: extra.detail || '지출', amount, event_id: trip, ...extra,
  });
  return { db, trip, other, spend };
}
const won = n => `${n.toLocaleString()}원`;
const summary = s => Object.fromEntries(s.people.map(p => [p.name, [p.paid, p.owed, p.balance]]));

test('스키마·선택 기능 — 표가 생기고 버전이 올랐으며, 처음에는 꺼져 있다', () => {
  const { db } = makeDb();
  expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0].values.map(r => r[0]);
  expect(tables).toEqual(expect.arrayContaining(['trip_participants', 'trip_split_entries']));
  expect(isTripSplitEnabled(db)).toBe(false);
  setTripSplitEnabled(db, true);
  expect(isTripSplitEnabled(db)).toBe(true);
});

test('일행 — 우리가 맨 앞, 같은 이름은 막고, 몫은 1~99, 우리는 뺄 수 없다', () => {
  const { db, trip } = makeDb();
  expect(getTripParticipants(db, trip)).toEqual([]);
  addTripParticipant(db, trip, ' 민수네 ', 3);
  expect(getTripParticipants(db, trip).map(p => [p.name, p.isMe, p.weight])).toEqual([['우리', true, 1], ['민수네', false, 3]]);
  expect(() => addTripParticipant(db, trip, '민수네')).toThrow('이미 같은 이름');
  expect(() => addTripParticipant(db, trip, '   ')).toThrow('이름을 입력');
  setTripParticipantWeight(db, trip, '우리', 4);
  expect(() => setTripParticipantWeight(db, trip, '우리', 0)).toThrow('1~99');
  expect(() => deleteTripParticipant(db, trip, '우리')).toThrow('뺄 수 없습니다');
  ensureTripMe(db, trip);
  expect(getTripParticipants(db, trip).filter(p => p.isMe)).toHaveLength(1);
});

test('정산 — 우리가 낸 여행 거래(할인 뺀 금액)와 일행이 낸 돈을 몫대로 나누고, 보낼 돈을 적은 건수로', () => {
  const { db, trip, other, spend } = makeDb();
  spend('2026-10-01', 120000, { detail: '숙소', discount_amount: 0 });
  spend('2026-10-02', 66000, { detail: '저녁', discount_amount: 6000 });                 // 순지출 60,000
  spend('2026-10-02', 0, { discount_amount: 3000, is_cash_adjustment: true, detail: '환전 차익' });  // 나누지 않는다
  addTransaction(db, { payment_method: '카드', date: '2026-11-01', budget_category: '여행', detail: '다른 여행', amount: 99999, event_id: other });
  addTripParticipant(db, trip, '민수', 1);
  addTripParticipant(db, trip, '지영', 1);
  addTripPayment(db, trip, { payer: '민수', title: '렌터카', date: '2026-10-01', amount: 90000, sharedBy: [] });
  const s = getTripSettlement(db, trip);
  expect(s.total).toBe(270000);
  expect(summary(s)).toEqual({ 우리: [180000, 90000, 90000], 민수: [90000, 90000, 0], 지영: [0, 90000, -90000] });
  expect(s.transfers).toEqual([{ from: '지영', to: '우리', amount: 90000 }]);
  expect(s.items.map(i => [i.kind, i.title, i.amount, i.payer])).toEqual([
    ['tx', '숙소', 120000, '우리'], ['payment', '렌터카', 90000, '민수'], ['tx', '저녁', 60000, '우리'],
  ]);
});

test('몫·나눌 사람·정산에서 빼기 — 원 단위로 나누고 남는 몇 원은 앞사람부터', () => {
  const { db, trip, spend } = makeDb();
  const dinner = spend('2026-10-02', 100000, { detail: '저녁' });
  const souvenir = spend('2026-10-03', 30000, { detail: '우리 기념품' });
  addTripParticipant(db, trip, '민수네', 2);
  setTripTxSplit(db, trip, souvenir, { sharedBy: [], excluded: true });               // 우리 것만 산 기념품
  let s = getTripSettlement(db, trip);
  expect(summary(s)).toEqual({ 우리: [100000, 33334, 66666], 민수네: [0, 66666, -66666] });   // 1:2, 남는 1원은 앞사람
  setTripTxSplit(db, trip, dinner, { sharedBy: ['민수네'], excluded: false });          // 저녁은 민수네 몫
  s = getTripSettlement(db, trip);
  expect(s.transfers).toEqual([{ from: '민수네', to: '우리', amount: 100000 }]);
  expect(s.items.find(i => i.transactionId === souvenir).excluded).toBe(true);
  expect(splitAmount(100, [{ name: 'a', weight: 1 }, { name: 'b', weight: 1 }, { name: 'c', weight: 1 }]).map(x => x.share)).toEqual([34, 33, 33]);
  expect(splitAmount(-100, [{ name: 'a', weight: 1 }, { name: 'b', weight: 1 }, { name: 'c', weight: 1 }]).map(x => x.share)).toEqual([-34, -33, -33]);
});

test('여럿이 주고받을 때 — 줄 돈이 큰 사람부터 받을 돈이 큰 사람에게', () => {
  const { db, trip } = makeDb();
  ['A', 'B', 'C'].forEach(n => addTripParticipant(db, trip, n));
  addTripPayment(db, trip, { payer: 'A', title: '숙소', date: '2026-10-01', amount: 200000, sharedBy: [] });
  addTripPayment(db, trip, { payer: 'B', title: '식사', date: '2026-10-02', amount: 40000, sharedBy: [] });
  const s = getTripSettlement(db, trip);     // 4명 · 1인 60,000 → A +140,000, B -20,000, C -60,000, 우리 -60,000
  expect(s.transfers).toEqual([
    { from: '우리', to: 'A', amount: 60000 }, { from: 'C', to: 'A', amount: 60000 }, { from: 'B', to: 'A', amount: 20000 },
  ]);
  expect(s.people.reduce((sum, p) => sum + p.balance, 0)).toBe(0);
});

test('이름을 바꾸면 낸 사람·나눌 사람이 따라가고, 빼면 그 사람이 낸 돈은 지우고 나눌 사람에서도 뺀다', () => {
  const { db, trip, spend } = makeDb();
  const lunch = spend('2026-10-02', 30000, { detail: '점심' });
  addTripParticipant(db, trip, '민수');
  addTripParticipant(db, trip, '지영');
  addTripPayment(db, trip, { payer: '민수', title: '택시', date: '2026-10-01', amount: 20000, sharedBy: ['민수', '지영'] });
  setTripTxSplit(db, trip, lunch, { sharedBy: ['민수'], excluded: false });
  renameTripParticipant(db, trip, '민수', '민수네');
  let s = getTripSettlement(db, trip);
  expect(s.items.find(i => i.kind === 'payment')).toMatchObject({ payer: '민수네', sharedBy: ['민수네', '지영'] });
  expect(s.items.find(i => i.kind === 'tx').sharedBy).toEqual(['민수네']);
  expect(() => renameTripParticipant(db, trip, '지영', '민수네')).toThrow('이미 같은 이름');

  expect(countTripEntriesFor(db, trip, '민수네')).toEqual({ paid: 1, onlyFor: 1 });
  deleteTripParticipant(db, trip, '민수네');
  s = getTripSettlement(db, trip);
  expect(s.items.map(i => i.kind)).toEqual(['tx']);
  // 민수네 몫으로만 나눈 점심은 남은 사람에게 넘어가지 않고 정산에서 빠진다
  expect(s.items[0]).toMatchObject({ excluded: true });
  expect(summary(s)).toEqual({ 우리: [0, 0, 0], 지영: [0, 0, 0] });
  setTripTxSplit(db, trip, lunch, { sharedBy: [], excluded: false });   // 다시 나누면 모두
  expect(summary(getTripSettlement(db, trip))).toEqual({ 우리: [30000, 15000, 15000], 지영: [0, 15000, -15000] });
});

test('나눌 사람에 같은 이름이 겹쳐도 한 번만 — 이름 바꾸기·바꿔 잇기가 겹치게 만들지 않는다', () => {
  const { db, trip } = makeDb();
  addTripParticipant(db, trip, '민수');
  addTripParticipant(db, trip, '지영');
  db.run("INSERT INTO trip_split_entries (event_id, transaction_id, payer, title, date, amount, shared_by) VALUES (?, NULL, '우리', '저녁', '2026-10-02', 90000, '[\"우리\",\"민수\",\"철수\"]')", [trip]);
  expect(() => reassignTripName(db, trip, '철수', '없는사람')).toThrow('일행에서 고르세요');
  expect(() => reassignTripName(db, trip, '민수', '지영')).toThrow('이미 일행에 있습니다');
  reassignTripName(db, trip, '철수', '민수');                          // 철수 = 민수(다른 기기에서 이름을 바꾼 사이 적힘)
  const s = getTripSettlement(db, trip);
  expect(s.items[0].sharedBy).toEqual(['우리', '민수']);
  expect(summary(s)).toEqual({ 우리: [90000, 45000, 45000], 민수: [0, 45000, -45000], 지영: [0, 0, 0] });
  expect(db.exec('SELECT shared_by FROM trip_split_entries')[0].values[0][0]).toBe('["우리","민수"]');
});

test('빼기 확인 수는 지금 이 일정에서 나누는 지출만 센다(다른 일정으로 옮긴 거래는 빼고)', () => {
  const { db, trip, other, spend } = makeDb();
  const gift = spend('2026-10-02', 30000, { detail: '민수 선물' });
  addTripParticipant(db, trip, '민수');
  setTripTxSplit(db, trip, gift, { sharedBy: ['민수'], excluded: false });
  expect(countTripEntriesFor(db, trip, '민수').onlyFor).toBe(1);
  const tx = getTransactions(db, {}).find(t => t.id === gift);
  updateTransaction(db, gift, { ...tx, event_id: other });
  expect(countTripEntriesFor(db, trip, '민수').onlyFor).toBe(0);
});

test('일행이 낸 돈은 일행에 있는 사람만, 0보다 큰 금액만 — 나눌 사람도 일행에 있는 이름만 남긴다', () => {
  const { db, trip } = makeDb();
  addTripParticipant(db, trip, '민수');
  expect(() => addTripPayment(db, trip, { payer: '철수', title: 'x', date: '', amount: 1000, sharedBy: [] })).toThrow('낸 사람이 일행에 없습니다');
  expect(() => addTripPayment(db, trip, { payer: '민수', title: 'x', date: '', amount: -1000, sharedBy: [] })).toThrow('0보다 크게');
  addTripPayment(db, trip, { payer: '민수', title: 'x', date: '', amount: 1000, sharedBy: ['민수', '철수'] });
  expect(getTripSettlement(db, trip).items[0].sharedBy).toEqual(['민수']);
});

test('일행이 낸 돈 고치기·지우기, 가계부 거래는 지우지 않는다', () => {
  const { db, trip, spend } = makeDb();
  spend('2026-10-02', 10000);
  addTripParticipant(db, trip, '민수');
  addTripPayment(db, trip, { payer: '민수', title: '택시', date: '2026-10-01', amount: 20000, sharedBy: [] });
  const id = getTripSettlement(db, trip).items.find(i => i.kind === 'payment').id;
  updateTripPayment(db, id, { payer: '우리', title: '택시(현금)', date: '2026-10-01', amount: 24000, sharedBy: [] });
  expect(getTripSettlement(db, trip).items.find(i => i.kind === 'payment')).toMatchObject({ payer: '우리', amount: 24000 });
  expect(() => addTripPayment(db, trip, { payer: '민수', title: 'x', amount: NaN })).toThrow('금액');
  deleteTripPayment(db, id);
  const txId = getTripSettlement(db, trip).items[0].transactionId;
  deleteTripPayment(db, txId);                                          // 거래 id를 넣어도 가계부 거래 설정은 지우지 않는다
  expect(getTripSettlement(db, trip).items).toHaveLength(1);
});

test('일정을 지우면 일행·나눌 지출도 지우고, 확인 문구용 수를 알려 준다', () => {
  const { db, trip, spend } = makeDb();
  const t = spend('2026-10-02', 10000);
  addTripParticipant(db, trip, '민수');
  addTripPayment(db, trip, { payer: '민수', title: '택시', date: '2026-10-01', amount: 20000, sharedBy: [] });
  setTripTxSplit(db, trip, t, { sharedBy: [], excluded: true });
  expect(getCalendarEventLinkCounts(db, trip)).toMatchObject({ txCount: 1, splitPeople: 1, splitPayments: 1, splitTxSettings: 1 });
  deleteCalendarEvent(db, trip);
  expect(db.exec('SELECT COUNT(*) FROM trip_participants')[0].values[0][0]).toBe(0);
  expect(db.exec('SELECT COUNT(*) FROM trip_split_entries')[0].values[0][0]).toBe(0);
  expect(getCalendarEventLinkCounts(db, null)).toMatchObject({ splitTxSettings: 0 });
});

test('거래를 지우면 그 나눔 설정도 지우고, 다른 일정으로 옮긴 거래의 설정은 수에 넣지 않는다', () => {
  const { db, trip, other, spend } = makeDb();
  const a = spend('2026-10-02', 10000);
  const b = spend('2026-10-03', 20000);
  setTripTxSplit(db, trip, a, { sharedBy: [], excluded: true });
  setTripTxSplit(db, trip, b, { sharedBy: [], excluded: true });
  deleteTransaction(db, a);
  expect(db.exec('SELECT COUNT(*) FROM trip_split_entries WHERE transaction_id = ?', [a])[0].values[0][0]).toBe(0);
  const moved = getTransactions(db, {}).find(t => t.id === b);
  updateTransaction(db, b, { ...moved, event_id: other });
  expect(getCalendarEventLinkCounts(db, trip)).toMatchObject({ txCount: 0, splitTxSettings: 0 });
});

test('공유할 글', () => {
  const { db, trip, spend } = makeDb();
  spend('2026-10-02', 60000, { detail: '저녁' });
  addTripParticipant(db, trip, '민수네', 2);
  const text = tripSettlementText('제주 여행', getTripSettlement(db, trip), won);
  expect(text).toBe([
    '🧾 제주 여행 정산', '함께 쓴 돈 60,000원',
    '· 우리: 낸 돈 60,000원 / 몫 20,000원', '· 민수네(2몫): 낸 돈 0원 / 몫 40,000원',
    '', '보낼 돈', '· 민수네 → 우리 40,000원',
  ].join('\n'));
});

test('병합 — 이 기기에서 만든 일정·거래의 정산 설정도, 다른 기기가 먼저 행을 만들어 id가 바뀌면 새 id에 들어간다', () => {
  const { db } = makeDb();
  const bytes = db.export();
  const mine = createDatabase(SQL, bytes).db;
  attachChangeLog(mine);
  const newTrip = addCalendarEvent(mine, { title: '부산', date_from: '2026-12-01', date_to: '2026-12-02', event_type: 'trip' });
  const tx = addTransaction(mine, { payment_method: '카드', date: '2026-12-01', budget_category: '여행', detail: '회', amount: 80000, event_id: newTrip });
  addTripParticipant(mine, newTrip, '민수');
  setTripTxSplit(mine, newTrip, tx, { sharedBy: ['민수'], excluded: false });
  const remote = createDatabase(SQL, bytes).db;
  const theirs = addCalendarEvent(remote, { title: '다른 기기 일정', date_from: '2026-12-05', date_to: '', event_type: 'general' });
  addTransaction(remote, { payment_method: '카드', date: '2026-12-05', budget_category: '식비', detail: '다른 기기', amount: 1000 });
  replayChanges(remote, getChangeLog(mine).entries);
  const busan = remote.exec("SELECT id FROM calendar_events WHERE title = '부산'")[0].values[0][0];
  expect(busan).not.toBe(theirs);
  const s = getTripSettlement(remote, busan);
  expect(s.people.map(p => p.name)).toEqual(['우리', '민수']);
  expect(s.transfers).toEqual([{ from: '민수', to: '우리', amount: 80000 }]);
  expect(getTripParticipants(remote, theirs)).toEqual([]);
});

test('병합 — 두 기기가 같은 여행에 각자 일행을 정해도 우리는 하나, 같은 이름은 한 사람', () => {
  const { db, trip } = makeDb();
  const bytes = db.export();
  const mine = createDatabase(SQL, bytes).db;
  attachChangeLog(mine);
  addTripParticipant(mine, trip, '민수');
  setTripParticipantWeight(mine, trip, '우리', 3);
  const remote = createDatabase(SQL, bytes).db;
  addTripParticipant(remote, trip, '민수');
  addTripParticipant(remote, trip, '지영');
  replayChanges(remote, getChangeLog(mine).entries);
  expect(getTripParticipants(remote, trip).map(p => [p.name, p.isMe, p.weight])).toEqual([
    ['우리', true, 3], ['민수', false, 1], ['지영', false, 1],
  ]);
});

describe('병합 — 이름 바꾸기·빼기와 다른 기기의 지출 기록', () => {
  function twoDevices() {
    const { db, trip, spend } = makeDb();
    spend('2026-10-02', 30000, { detail: '점심' });
    addTripParticipant(db, trip, '민수');
    const bytes = db.export();
    return { trip, bytes, lunch: getTripSettlement(db, trip).items[0].transactionId };
  }

  test('내가 이름을 바꾸는 사이 다른 기기가 옛 이름으로 나눔을 정해 먼저 저장 — 다시 실행하면 그 기록도 새 이름으로', () => {
    const { trip, bytes, lunch } = twoDevices();
    const a = createDatabase(SQL, bytes).db;
    attachChangeLog(a);
    renameTripParticipant(a, trip, '민수', '민수네');
    const b = createDatabase(SQL, bytes).db;
    setTripTxSplit(b, trip, lunch, { sharedBy: ['민수'], excluded: false });
    addTripPayment(b, trip, { payer: '민수', title: '택시', date: '2026-10-01', amount: 20000, sharedBy: ['민수'] });
    replayChanges(b, getChangeLog(a).entries);
    const s = getTripSettlement(b, trip);
    expect(s.unknownNames).toEqual([]);
    expect(s.items.map(i => [i.title, i.payer, i.sharedBy])).toEqual([['택시', '민수네', ['민수네']], ['점심', '우리', ['민수네']]]);
    expect(s.transfers).toEqual([{ from: '민수네', to: '우리', amount: 30000 }]);
  });

  test('내가 먼저 이름을 바꿔 저장한 뒤 다른 기기가 옛 이름으로 적은 지출이 합쳐지면 — 나누지 않고 알린다', () => {
    const { trip, bytes } = twoDevices();
    const a = createDatabase(SQL, bytes).db;
    renameTripParticipant(a, trip, '민수', '민수네');
    const b = createDatabase(SQL, bytes).db;
    attachChangeLog(b);
    addTripPayment(b, trip, { payer: '민수', title: '렌터카', date: '2026-10-01', amount: 90000, sharedBy: [] });
    replayChanges(a, getChangeLog(b).entries);
    let s = getTripSettlement(a, trip);
    expect(s.unknownNames).toEqual(['민수']);
    expect(s.items.find(i => i.title === '렌터카').unknown).toEqual(['민수']);
    expect(s.total).toBe(30000);                                        // 렌터카는 나누지 않았다(모두에게 넘기지 않음)
    addTripParticipant(a, trip, '민수');                                 // 다시 더하면 나눈다
    s = getTripSettlement(a, trip);
    expect([s.unknownNames, s.total]).toEqual([[], 120000]);
  });

  test('이름 바꾸기가 다른 기기의 같은 이름 때문에 건너뛰어지면, 낸 사람·나눌 사람도 그대로 둔다', () => {
    const { trip, bytes } = twoDevices();
    const a = createDatabase(SQL, bytes).db;
    attachChangeLog(a);
    addTripPayment(a, trip, { payer: '민수', title: '택시', date: '2026-10-01', amount: 20000, sharedBy: ['민수'] });
    renameTripParticipant(a, trip, '민수', '지영');
    const b = createDatabase(SQL, bytes).db;
    addTripParticipant(b, trip, '지영');
    replayChanges(b, getChangeLog(a).entries);
    expect(getTripParticipants(b, trip).map(p => p.name)).toEqual(['우리', '민수', '지영']);
    expect(getTripSettlement(b, trip).items.find(i => i.kind === 'payment')).toMatchObject({ payer: '민수', sharedBy: ['민수'] });
  });

  test('내가 일행을 빼는 사이 다른 기기가 그 사람 몫으로 나눔을 정하면 — 그 지출도 정산에서 빠진다', () => {
    const { trip, bytes, lunch } = twoDevices();
    const a = createDatabase(SQL, bytes).db;
    attachChangeLog(a);
    deleteTripParticipant(a, trip, '민수');
    const b = createDatabase(SQL, bytes).db;
    addTripParticipant(b, trip, '지영');
    setTripTxSplit(b, trip, lunch, { sharedBy: ['민수'], excluded: false });
    replayChanges(b, getChangeLog(a).entries);
    const s = getTripSettlement(b, trip);
    expect(s.people.map(p => p.name)).toEqual(['우리', '지영']);
    expect(s.items[0]).toMatchObject({ excluded: true });
    expect(s.total).toBe(0);
  });
});

test('예전 버전(v7) 파일을 열면 표를 만들고 한 번만 다시 저장한다', () => {
  const { db } = makeDb();
  db.run('DROP TABLE trip_participants');
  db.run('DROP TABLE trip_split_entries');
  db.run('PRAGMA user_version = 7');
  const reopened = createDatabase(SQL, db.export());
  expect(reopened.didMigrate).toBe(true);
  expect(reopened.migrationErrors).toEqual([]);
  expect(createDatabase(SQL, reopened.db.export()).didMigrate).toBe(false);
});
