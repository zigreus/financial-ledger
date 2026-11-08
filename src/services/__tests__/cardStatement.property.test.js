/**
 * @vitest-environment node
 */
// 카드 내역 대조 무작위 검사 — 고정 seed로 가짜 카드 내역·가계부를 만들어
//   1) 모든 카드 행·가계부 거래가 결과의 정확히 한 곳에 들어가는지 (구조 불변식)
//   2) 화면이 권하는 버튼(카드 금액으로 수정·미리 체크된 "가계부에 없음" 추가·취소 결제 삭제)을
//      누르고 다시 대조하기를 반복한 뒤, 가계부 합계가 실제 쓴 돈과 같은지 — 맞지 않으면 화면에
//      확인할 것(금액 차이·가계부에 없음·이 카드 기록의 카드에 없음·취소 확인)이 반드시 남아 있어야 한다.
//      즉 틀린 채로 "모두 맞습니다"가 되는 일(조용한 오류)은 없어야 한다. 틀렸지만 보이는 경우는 허용한다.
//   3) 권하는 버튼 누르기를 3번 반복하는 안에 더 권할 것이 없어지는지 (끝없는 반복이 없는지),
//      한 취소 건의 기록을 지운 뒤 다시 대조했을 때 같은 취소 건으로 또 지우라고 하지 않는지
//   4) 다른 가게 잡음 기록·앞뒤 명세서의 기록·다른 결제수단 기록을 건드리지 않는지
//   5) 해롭지 않은지 — 처음보다 가계부가 더 틀려지면(버튼이 맞던 기록을 틀리게 만들면) 실패.
//      전체 합계의 오차가 늘었고, 결제별 오차(그 결제의 가계부 기록 합 − 실제 쓴 돈)의 절댓값 합도 늘었을 때로 센다.
//      전체 합계만 보면 서로 다른 결제의 오차가 상쇄돼, 맞는 수정(오타 5,100 → 5,000)이 다른 결제의
//      빠진 2,000원 때문에 해롭게 보인다
// 를 모드별로 검사한다. 실패하면 모드·seed와 내용을 출력하므로 그대로 재현할 수 있다
// (CARD_PROPERTY_N=1000 CARD_PROPERTY_VERBOSE=1 로 많이 돌려 볼 수 있다).
//
// 모드 — 실제로 자주 생기는 경우를 하나씩 켠다:
//   base·noise·dense      : 정확히/오타/나눠/안 적음/합쳐/결제 후 취소, 잡음 기록, 같은 가게가 몰림
//   dup                   : 겹친 캡처에서 같은 결제가 두 번 읽힘 (앱이 긴 캡처를 겹치게 자른다)
//   otherMethod           : 이 카드 결제를 다른 결제수단(카카오페이)으로 적음
//   prevRefund            : 지난 기간 결제의 환불이 이번 기간에 — 원래 결제 기록이 직전에 있음 / 오래전(읽는 범위 밖)에 있음 /
//                           없음(반품하면서 결제 기록을 지움 → 환불을 추가하면 틀린다)
//   generic               : 세부내역을 가게 이름 없이 적음 ("점심", "장보기")
//   habitDetail           : AI가 고른 입력 습관 표기가 가게 이름과 다름
//   bigShift              : 날짜를 4일 잘못 적음 (짝짓기 범위 ±3일 밖)
//   ledgerRefund          : 취소된 결제의 환불을 가계부에 음수로 적음 (가게 이름 없이·며칠 뒤에)
//   neighbor·neighborDense: 앞뒤 명세서 기간(1~3일 밖)에 같은 가게 기록이 있음 (지난 대조에서 이미 맞은 기록)
//   namelessSplit         : 가게 이름 없이 적는 비율이 30~100% (나눠·합쳐 적은 몫도 "식료품", "생활용품")
//
// 생성기에서 빼는 경우 (기계적으로 맞힐 수 없음):
//   · 카드에 없는 다른 가게 거래(잡음)가 카드 건과 같은 금액·±1일 안에 있음
//     → 가게 이름 없이 적은 같은 결제("점심")와 구별할 수 없어 화면은 짝짓는다 (조용한 오류가 된다).
//       2~3일 차이면 짝짓지 않고 "비슷한 기록 있음"으로 미리 체크하지 않는다 (생성기에 남겨 둠).
//   · generic 모드에서 가게 이름 없는 기록이 금액 오타까지 있으면서 다른 결제와 같은 금액이 되는 경우
//     (위와 같은 이유 — 오타 금액을 1,000원 단위로 피해 간다)
//   · 같은 가게·±3일 안의 다른 결제 금액과 헷갈리는 기록 — 정확히 적은 기록으로 바꿔 넣는다:
//     오타 금액이 자기 결제보다 다른 결제 금액에 더 가깝거나 같은 거리 (8,000을 8,500으로 적었는데 10,000 결제도 있음),
//     합쳐 적은 금액이 다른 결제 금액(오타 범위 포함)과 같음 (10,000+10,000을 20,000으로 적었는데 20,000 결제도 있음),
//     나눠 적은 몫이 다른 결제 금액과 같음, 같은 가게·같은 금액 결제가 이틀 안에 또 있는데 그중 하나가 취소됨,
//     지난 기간 결제의 환불인데 이번 기간에 같은 가게·같은 금액 결제가 있음 (그 결제의 취소로 읽힌다),
//     원래 결제 기록을 지운 지난 기간 환불인데 이번 기간에 같은 가게의 더 큰 결제가 있음 (그 결제의 부분취소로 읽힌다).
//     어느 결제의 기록인지 기계적으로 고를 근거가 없어, 화면이 고르면 맞는 기록을 틀리게 고칠 수 있다(해로움).
//     이런 기록이 실제로 있으면 화면은 대개 수정 버튼 없는 금액 차이나 미리 체크하지 않은 행으로 사람에게 맡긴다.
//
// 생성기에 남겨 두었지만 맞힐 수 없는 우연 (기본 N에는 없고, CARD_PROPERTY_N=1000이면 나타나 실패할 수 있다):
//   · 같은 가게 다른 결제 몇 건의 합이, 하루 밀려 적은 또 다른 결제의 금액과 정확히 같음
//     (dense seed 4802478: 11/2 이마트 30,000 + 20,000 = 11/1 결제 50,000을 11/2에 적은 기록) —
//     같은 날 "합쳐 적음"이 하루 차이 1:1보다 먼저 짝지어져, 남은 50,000 결제가 다른 기록(합쳐 적은 34,500)과
//     금액 차이로 묶이고 고치라고 한다. 합이 정확히 같은 같은 날 기록은 합쳐 적은 것일 때가 훨씬 많아 순서를 바꾸지 않는다.
// (환불이 잦은 사용자 테스트의 제외 경우는 그 테스트 머리말에 따로 적었다)
import initSqlJs from 'sql.js';
import { createDatabase, addTransaction, updateTransaction, deleteTransaction, getTransactions } from '../dbManager';
import { normalizeStatement, reconcileStatement, addMissingRows, txWithAmount } from '../cardStatement';
import { addDays } from '../dateUtils';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const TODAY = '2026-11-08';
const CARD = '신한카드';
const OTHER = '카카오페이';
const FROM = '2026-10-30';
const TO = '2026-11-02';
const PERIOD_DAYS = 4;
const N = Number((typeof process !== 'undefined' && process.env.CARD_PROPERTY_N) || 35);
const VERBOSE = typeof process !== 'undefined' && !!process.env.CARD_PROPERTY_VERBOSE;

const SHOPS = [
  { card: ['이마트', '(주)이마트 성수점', '이마트 성수점'], ledger: ['이마트', '이마트 장보기', '이마트 휴지'] },
  { card: ['스타벅스', '스타벅스 강남점', '스타벅스코리아'], ledger: ['스타벅스', '스타벅스 커피'] },
  { card: ['교보문고', '교보문고 광화문'], ledger: ['교보문고', '교보문고 책'] },
  { card: ['쿠팡', '쿠팡(주)', '네이버페이 쿠팡'], ledger: ['쿠팡', '쿠팡 휴지'] },
  { card: ['올리브영 성수', '올리브영'], ledger: ['올리브영'] },
  { card: ['다이소 성수점', '다이소'], ledger: ['다이소', '다이소 수납함'] },
];
const GENERIC = ['점심', '장보기', '생필품', '간식'];
const NOISE = ['김밥천국', '롯데리아', '배스킨라빈스', '맥도날드'];
const AMOUNTS = [3000, 4500, 5000, 8000, 10000, 12000, 20000, 30000, 50000];

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dayGap = (a, b) => Math.abs(Math.round((new Date(a.replace(/-/g, '/')) - new Date(b.replace(/-/g, '/'))) / 86400000));
const cardRow = (date, merchant, amount, detail) => ({
  date, merchant, amount, is_cancel: amount < 0, currency: 'KRW', foreign_amount: 0,
  installment: '', category: '식비 > 점심', detail: detail || merchant,
});

/**
 * 결제(P)마다 카드 행을 만들고, 가계부에는 정확히 / 금액 오타 / 나눠 적음 / 안 적음 / 다음 결제와 합쳐 적음 /
 * 결제 후 취소(가계부에 승인이 남기도 함) 중 하나로 적는다. 다른 가게 잡음 거래도 섞는다.
 * truth: 실제로 쓴 돈 (취소된 결제는 0, 지난 기간 결제와 그 환불은 둘 다 넣어 상쇄)
 */
function genCase(seed, o) {
  const R = mulberry32(seed);
  const pick = a => a[Math.floor(R() * a.length)];
  const nP = 1 + Math.floor(R() * (o.maxP || 7));
  const P = [];
  for (let i = 0; i < nP; i += 1) {
    const shopIdx = Math.floor(R() * (o.shops || SHOPS.length));
    P.push({
      i, shopIdx, shop: SHOPS[shopIdx], cardName: pick(SHOPS[shopIdx].card),
      date: addDays(FROM, Math.floor(R() * PERIOD_DAYS)), amount: pick(AMOUNTS),
    });
  }
  const ledger = [];
  const cardRows = [];
  const cancelled = new Set();
  const consumed = new Set();
  const shift = () => {
    const x = R();
    if (o.bigShift && x < 0.1) return R() < 0.5 ? 4 : -4;
    return x < 0.7 ? 0 : x < 0.85 ? 1 : x < 0.95 ? -1 : (R() < 0.5 ? 2 : -2);
  };
  const aiDetail = p => (o.habitDetail ? GENERIC[p.shopIdx % GENERIC.length] : undefined);
  // 결제 단위 — 합쳐 적은 두 결제는 한 단위 (그 기록이 둘을 함께 나타낸다)
  const unitRoot = new Map();
  const unitOf = i => (unitRoot.has(i) ? unitRoot.get(i) : i);
  const genericRate = o.namelessSplit ? 0.3 + R() * 0.7 : 0.3;
  P.forEach(p => {
    cardRows.push({ ...cardRow(p.date, p.cardName, p.amount, aiDetail(p)), unit: unitOf(p.i) });
    if (o.dup && R() < 0.15) cardRows.push({ ...cardRow(p.date, p.cardName, p.amount, aiDetail(p)), unit: unitOf(p.i) });   // 겹친 캡처 — 실제는 1건
    if (consumed.has(p.i)) return;
    const x = R();
    const generic = () => o.generic && R() < genericRate;
    const ld = () => (generic() ? pick(GENERIC) : pick(p.shop.ledger));
    // 빼는 경우(머리말 참고): 같은 가게·±3일 안의 다른 결제 금액과 헷갈리는 기록 — 그 대신 정확히 적은 것으로 한다
    const neighborsOf = (...own) => P.filter(q => !own.includes(q) && q.shopIdx === p.shopIdx && dayGap(q.date, p.date) <= 3);
    const exact = () => ledger.push({ date: p.date, detail: ld(), amount: p.amount, unit: unitOf(p.i), tag: 'exact', method: CARD });
    if (x < 0.40) {
      ledger.push({ date: addDays(p.date, shift()), detail: ld(), amount: p.amount, unit: unitOf(p.i), tag: 'exact', method: o.otherMethod && R() < 0.1 ? OTHER : CARD });
    } else if (x < 0.55) {
      const d = pick([100, 500, 1000, 2000]) * (R() < 0.5 ? -1 : 1);
      const detail = ld();
      // 빼는 경우: 가게 이름 없는 기록의 오타가 다른 결제 금액과 같아지는 것 (머리말 참고)
      const amount = GENERIC.includes(detail) && AMOUNTS.includes(p.amount + d) ? p.amount + d + 100 : p.amount + d;
      const date = addDays(p.date, R() < 0.8 ? 0 : (R() < 0.5 ? 1 : -1));
      // 오타 금액이 자기 결제보다 다른 결제 금액에 더 가깝거나 같은 거리면 어느 결제의 오타인지 알 수 없다
      if (neighborsOf(p).some(q => Math.abs(q.amount - amount) <= Math.abs(amount - p.amount))) exact();
      else ledger.push({ date, detail, amount, unit: unitOf(p.i), tag: 'typo', method: CARD });
    } else if (x < 0.70) {
      const k = R() < 0.6 ? 2 : 3;
      const dd = R() < 0.8 ? 0 : (R() < 0.5 ? 1 : -1);
      let left = p.amount;
      const parts = [];
      for (let j = 0; j < k; j += 1) {
        const part = j === k - 1 ? left : Math.round((left * (0.3 + R() * 0.4)) / 100) * 100;
        left -= part;
        parts.push({ date: addDays(p.date, dd), detail: ld(), amount: part, unit: unitOf(p.i), tag: 'split', method: CARD });
      }
      // 나눈 몫이 다른 결제 금액과 같으면 그 결제의 기록과 구별할 수 없다
      if (parts.some(pt => neighborsOf(p).some(q => q.amount === pt.amount))) exact();
      else ledger.push(...parts);
    } else if (x < 0.85) {
      // 안 적음
    } else if (x < 0.95) {
      const other = P.find(q => q.i > p.i && q.shopIdx === p.shopIdx && !consumed.has(q.i) && dayGap(q.date, p.date) <= 1);
      const typo = R() < 0.3 ? pick([500, 1000]) : 0;
      const total = other ? p.amount + other.amount + typo : 0;
      // 합쳐 적은 금액이 다른 결제 금액(또는 그 오타 범위)과 같으면 그 결제의 기록과 구별할 수 없다
      if (other && !neighborsOf(p, other).some(q => Math.abs(q.amount - total) <= Math.max(1000, total * 0.05))) {
        consumed.add(other.i);
        unitRoot.set(other.i, unitOf(p.i));
        ledger.push({ date: R() < 0.5 ? p.date : other.date, detail: ld(), amount: total, unit: unitOf(p.i), tag: 'merge', method: CARD });
      } else {
        exact();
      }
    } else if (neighborsOf(p).some(q => q.amount === p.amount && dayGap(q.date, p.date) <= 2)) {
      exact();   // 빼는 경우: 같은 가게·같은 금액 결제가 이틀 안에 또 있으면 어느 쪽이 취소됐는지 알 수 없다
    } else {
      cancelled.add(p.i);
      const cd = addDays(p.date, R() < 0.5 ? 0 : 1);
      cardRows.push({ ...cardRow(cd > TO ? p.date : cd, p.cardName, -p.amount), unit: unitOf(p.i) });
      if (R() < 0.5) {
        ledger.push({ date: p.date, detail: ld(), amount: p.amount, unit: unitOf(p.i), tag: 'cancelled-approval', method: CARD });
        if (o.ledgerRefund && R() < 0.6) {
          const detail = R() < 0.5 ? '반품 환불' : `${pick(p.shop.ledger)} 환불`;
          ledger.push({ date: addDays(cd, Math.floor(R() * 5)), detail, amount: -p.amount, unit: unitOf(p.i), tag: 'refund', method: CARD });
        }
      }
    }
  });
  // 지난 기간 결제의 환불이 이번 기간에 — 결제와 환불이 상쇄되어 실제 쓴 돈에는 0.
  // 원래 결제 기록: 직전 1~3일 전 / 20~100일 전(읽는 범위 밖) / 없음(반품하면서 지움 — 환불도 적으면 안 된다)
  if (o.prevRefund && R() < 0.4) {
    const shop = pick(SHOPS);
    const kind = R();
    // 빼는 경우: 이번 기간에 같은 가게·같은 금액 결제가 있으면 그 결제를 취소한 것과 구별할 수 없다 — 금액을 바꾼다.
    // 원래 결제 기록이 없으면(지움) 같은 가게의 더 큰 결제가 있어도 그 결제의 부분취소와 구별할 수 없다
    const clash = a => P.some(q => q.shop === shop && (q.amount === a || (kind >= 0.7 && q.amount > a)));
    const first = pick(AMOUNTS);
    const amount = clash(first) ? AMOUNTS.find(a => !clash(a)) : first;
    if (amount) {
      if (kind < 0.7) {
        const date = kind < 0.45 ? addDays(FROM, -1 - Math.floor(R() * 3)) : addDays(FROM, -20 - Math.floor(R() * 80));
        ledger.push({ date, detail: pick(shop.ledger), amount, unit: 'prev', tag: 'prev-approval', method: CARD });
      }
      cardRows.push({ ...cardRow(addDays(FROM, Math.floor(R() * PERIOD_DAYS)), pick(shop.card), -amount), unit: 'prev' });
    }
  }
  // 앞뒤 명세서 기간의 같은 가게 기록 — 이번 카드 건과 상관없다 (건드리면 안 되고 합계에서도 뺀다)
  if (o.neighbor) {
    const nN = 1 + Math.floor(R() * 2);
    for (let i = 0; i < nN; i += 1) {
      const p = pick(P);
      const date = R() < 0.5 ? addDays(FROM, -1 - Math.floor(R() * 3)) : addDays(TO, 1 + Math.floor(R() * 3));
      ledger.push({ date, detail: pick(p.shop.ledger), amount: R() < 0.5 ? p.amount : pick(AMOUNTS), tag: 'neighbor', method: CARD });
    }
  }
  const nNoise = Math.floor(R() * 4);
  for (let i = 0; i < nNoise; i += 1) {
    const date = addDays(FROM, Math.floor(R() * (PERIOD_DAYS + 4)) - 2);
    let amount = o.noiseCollide ? pick(AMOUNTS) : 777 + Math.floor(R() * 50) * 13;
    // 빼는 경우: 카드 건과 같은 금액·±1일 (머리말 참고) — 금액만 바꿔 같은 흐름을 유지한다
    if (cardRows.some(r => Math.abs(r.amount) === amount && dayGap(r.date, date) <= 1)) amount += 7;
    ledger.push({ date, detail: pick(NOISE), amount, tag: 'noise', method: CARD });
  }
  for (let i = cardRows.length - 1; i > 0; i -= 1) {
    const j = Math.floor(R() * (i + 1));
    [cardRows[i], cardRows[j]] = [cardRows[j], cardRows[i]];
  }
  for (let i = ledger.length - 1; i > 0; i -= 1) {
    const j = Math.floor(R() * (i + 1));
    [ledger[i], ledger[j]] = [ledger[j], ledger[i]];
  }
  const truthTotal = P.filter(p => !cancelled.has(p.i)).reduce((s, p) => s + p.amount, 0);
  // 결제 단위별 실제 쓴 돈 — "해로움"은 단위별 차이의 합으로 잰다 (서로 다른 결제의 오차가 상쇄돼
  // 맞는 수정이 해롭게 보이는 일이 없게). 취소된 결제·지난 기간 결제+환불은 0
  const truthByUnit = new Map();
  P.forEach(p => {
    const u = unitOf(p.i);
    truthByUnit.set(u, (truthByUnit.get(u) || 0) + (cancelled.has(p.i) ? 0 : p.amount));
  });
  if (cardRows.some(r => r.unit === 'prev')) truthByUnit.set('prev', 0);
  return { P, cardRows, ledger, truthTotal, truthByUnit };
}

const txsOf = (db, method = CARD) => getTransactions(db, { payment_method: method });

function structureErrors(r, st, db) {
  const errs = [];
  const count = (map, id, where) => {
    if (!map.has(id)) { errs.push(`모르는 id ${id} (${where})`); return; }
    map.set(id, map.get(id) + 1);
  };
  const rowCount = new Map(st.rows.map(x => [x.id, 0]));
  r.matched.forEach(m => count(rowCount, m.row.id, 'matched'));
  r.grouped.forEach(g => g.rows.forEach(x => count(rowCount, x.id, 'grouped')));
  r.mismatched.forEach(g => g.rows.forEach(x => count(rowCount, x.id, 'mismatched')));
  r.missing.forEach(m => count(rowCount, m.row.id, 'missing'));
  r.cancelled.forEach(c => { count(rowCount, c.approval.id, 'approval'); count(rowCount, c.cancel.id, 'cancel'); });
  rowCount.forEach((n, id) => { if (n !== 1) errs.push(`카드 행 ${id}가 ${n}번`); });

  const txCount = new Map(txsOf(db).map(t => [t.id, 0]));
  r.matched.forEach(m => count(txCount, m.tx.id, 'matched'));
  r.grouped.forEach(g => g.txs.forEach(t => count(txCount, t.id, 'grouped')));
  r.mismatched.forEach(g => g.txs.forEach(t => count(txCount, t.id, 'mismatched')));
  r.notOnCard.forEach(t => count(txCount, t.id, 'notOnCard'));
  r.cancelled.forEach(c => c.tx && count(txCount, c.tx.id, 'cancelled'));
  txsOf(db).forEach(t => {
    const n = txCount.get(t.id);
    const inPeriod = t.date >= r.period.from && t.date <= r.period.to;
    if (n > 1 || (inPeriod && n !== 1)) errs.push(`거래 ${t.detail}:${t.amount}@${t.date}가 ${n}번`);
  });
  r.grouped.forEach(g => {
    const card = g.rows.reduce((s, x) => s + x.amount, 0);
    if (card !== g.txs.reduce((s, t) => s + t.amount, 0)
      && card !== g.txs.reduce((s, t) => s + t.amount - (t.discount_amount || 0), 0)) errs.push(`묶음 합계가 다름 ${card}`);
  });
  r.mismatched.forEach(g => { if (g.cardTotal === g.ledgerTotal) errs.push('합계가 같은데 금액 차이'); });
  return errs;
}

/** 화면이 권하는 버튼을 모두 누른다 — 미리 체크되지 않은 "가계부에 없음"·확인만 띄운 삭제(maybeTx)·
 *  근처에 이름 없는 나머지 기록이 있어 권하지 않은 금액 수정은 사람 몫 */
const fixable = m => m.fixable;
function pressRecommended(db, r, onAdded = () => {}) {
  r.mismatched.filter(fixable)
    .forEach(m => updateTransaction(db, m.txs[0].id, txWithAmount(m.txs[0], m.cardTotal)));
  const chosen = r.missing.filter(m => m.autoCheck);
  const picks = chosen.map(m => ({
    suggestion: m.suggestion, budget_category: m.suggestion.budget_category || '식비', sub_category: m.suggestion.sub_category || '점심',
  }));
  if (picks.length) {
    const before = new Set(getTransactions(db, {}).map(t => t.id));
    addMissingRows(db, picks);
    const added = getTransactions(db, {}).map(t => t.id).filter(id => !before.has(id)).sort((a, b) => a - b);
    onAdded(added, chosen.map(m => m.row));   // 추가된 기록은 넣은 순서대로 id가 붙는다
  }
  r.cancelled.filter(c => c.tx).forEach(c => deleteTransaction(db, c.tx.id));
}
const suggests = x => x.mismatched.some(fixable) || x.missing.some(m => m.autoCheck) || x.cancelled.some(y => y.tx);

function runCase(seed, o) {
  const c = genCase(seed, o);
  const { db } = createDatabase(SQL, null);
  db.run(`INSERT INTO payment_methods (name) VALUES ('현금'),('${OTHER}'),('${CARD}')`);
  db.run("INSERT INTO budget_categories (name) VALUES ('식비')");
  db.run("INSERT INTO sub_categories (budget_category, name) VALUES ('식비','점심')");
  const keep = new Set();   // 건드리면 안 되는 기록: 잡음·다른 결제수단
  const unitOfId = new Map();   // 기록 id → 결제 단위 (잡음·앞뒤 명세서 기록은 없음)
  c.ledger.forEach(l => {
    const id = addTransaction(db, { payment_method: l.method, budget_category: '식비', sub_category: '점심', date: l.date, detail: l.detail, amount: l.amount });
    if (l.unit !== undefined) unitOfId.set(id, l.unit);
    if (l.tag === 'noise' || l.tag === 'neighbor' || l.method !== CARD) keep.add(id);
  });
  const keepBefore = getTransactions(db, {}).filter(t => keep.has(t.id)).map(t => `${t.id}:${t.amount}`).join();
  const st = normalizeStatement({ period_from: FROM, period_to: TO, rows: c.cardRows }, TODAY);
  // 처음 가계부가 실제 쓴 돈과 얼마나 다른지 (이 카드와 상관없는 잡음·앞뒤 명세서 기록은 뺀다)
  // 결제 단위별 오차의 합 — 추가된 기록은 그 카드 행의 결제 단위로 센다
  const unitErr = () => {
    const sums = new Map();
    getTransactions(db, {}).forEach(t => {
      if (!unitOfId.has(t.id)) return;
      const u = unitOfId.get(t.id);
      sums.set(u, (sums.get(u) || 0) + t.amount);
    });
    let err = 0;
    c.truthByUnit.forEach((truth, u) => { err += Math.abs((sums.get(u) || 0) - truth); });
    return err;
  };
  const errBefore = unitErr();
  const totalOf = () => getTransactions(db, {}).filter(t => !(keep.has(t.id) && t.payment_method === CARD))
    .reduce((sum, t) => sum + t.amount, 0) - c.truthTotal;
  const totalBefore = totalOf();
  const t0 = Date.now();
  const r = reconcileStatement(db, { paymentMethod: CARD, ...st });
  const ms = Date.now() - t0;
  const errs = structureErrors(r, st, db);
  let again = r;
  let rounds = 0;
  let deletedTwice = false;
  const deletedFor = new Set();   // 삭제를 권해 지운 취소 건 — 같은 취소 건을 또 지우라고 하면 반복
  while (rounds < 3 && suggests(again)) {
    const toDelete = again.cancelled.filter(x => x.tx).map(x => x.cancel.id);
    if (toDelete.some(id => deletedFor.has(id))) deletedTwice = true;
    toDelete.forEach(id => deletedFor.add(id));
    pressRecommended(db, again, (ids, cardRowsAdded) => ids.forEach((id, k) => {
      unitOfId.set(id, c.cardRows[Number(cardRowsAdded[k].id.slice(1))].unit);   // 카드 행 id는 r + 원래 순서
    }));
    again = reconcileStatement(db, { paymentMethod: CARD, ...st });
    rounds += 1;
  }
  const all = getTransactions(db, {});
  const noise = new Set(all.filter(t => keep.has(t.id) && t.payment_method === CARD).map(t => t.id));
  const totalErr = all.filter(t => !noise.has(t.id)).reduce((s, t) => s + t.amount, 0) - c.truthTotal;
  const errAfter = unitErr();
  // 누른 뒤 화면에 남은 확인거리 — 잡음 기록의 "카드에 없음"은 늘 있으므로 빼고 본다
  const stillShown = again.mismatched.length > 0 || again.missing.length > 0
    || again.cancelled.some(x => x.tx || x.maybeTx) || again.notOnCard.some(t => !noise.has(t.id));
  const out = {
    errs,
    totalErr,
    errBefore,
    errAfter,
    totalBefore,
    stillShown,
    keepTouched: all.filter(t => keep.has(t.id)).map(t => `${t.id}:${t.amount}`).join() !== keepBefore,
    repeats: suggests(again) || deletedTwice,
    rounds,
    ms,
  };
  db.close();
  return { c, r, out };
}

const describeCase = ({ c, r }) => ({
  card: c.cardRows.map(x => `${x.merchant}:${x.amount}@${x.date}`),
  ledger: c.ledger.map(l => `${l.tag}${l.method === CARD ? '' : `/${l.method}`} ${l.detail}:${l.amount}@${l.date}`),
  ...(r.mismatched.some(m => m.cautions.length) ? { cautions: r.mismatched.map(m => m.cautions) } : {}),
  matched: r.matched.map(m => `${m.row.amount}@${m.row.date.slice(5)}~${m.tx.detail}:${m.tx.amount}@${m.tx.date.slice(5)}`),
  grouped: r.grouped.map(g => `${g.kind} [${g.rows.map(x => `${x.amount}@${x.date.slice(5)}`)}]=[${g.txs.map(t => `${t.amount}@${t.date.slice(5)}`)}]`),
  notOnCard: r.notOnCard.map(t => `${t.detail}:${t.amount}@${t.date.slice(5)}`),
  mismatched: r.mismatched.map(m => `[${m.rows.map(x => `${x.amount}@${x.date.slice(5)}`)}] vs [${m.txs.map(t => `${t.amount}@${t.date.slice(5)}`)}]`),
  missing: r.missing.map(m => `${m.row.merchant}:${m.row.amount}@${m.row.date.slice(5)}${m.autoCheck ? '' : `(${m.cautions})`}`),
  cancelled: r.cancelled.map(x => `${x.approval.amount}@${x.approval.date} tx=${x.tx ? x.tx.date : null} maybe=${x.maybeTx ? x.maybeTx.date : null}`),
});

const MODES = {
  base: {},
  noise: { noiseCollide: true },
  dense: { shops: 2, maxP: 10 },
  dup: { dup: true },
  otherMethod: { otherMethod: true },
  prevRefund: { prevRefund: true },
  generic: { generic: true },
  habitDetail: { habitDetail: true },
  bigShift: { bigShift: true },
  ledgerRefund: { ledgerRefund: true },
  neighbor: { neighbor: true },
  neighborDense: { neighbor: true, shops: 2, maxP: 10 },
  namelessSplit: { generic: true, namelessSplit: true },
};

test('무작위: 모든 행·거래가 한 곳에, 권하는 버튼을 다 누르면 합계가 맞거나 확인거리가 남고, 더 틀려지지 않으며, 끝없이 권하지 않는다', { timeout: Math.max(120000, N * 400) }, () => {
  const fails = { structure: [], silent: [], harmful: [], keepTouched: [], repeats: [] };
  const stats = {};
  Object.entries(MODES).forEach(([name, opts], m) => {
    const st = { cases: 0, wrongButShown: 0, harmful: 0, secondRound: 0, maxMs: 0 };
    stats[name] = st;
    for (let k = 1; k <= N; k += 1) {
      const seed = k * 7919 + m * 104729;
      const res = runCase(seed, opts);
      const { out } = res;
      st.cases += 1;
      st.maxMs = Math.max(st.maxMs, out.ms);
      if (out.rounds > 1) st.secondRound += 1;
      const tag = { mode: name, seed };
      if (out.errs.length) fails.structure.push({ ...tag, errs: out.errs });
      if (out.totalErr !== 0 && out.stillShown) st.wrongButShown += 1;
      if (out.totalErr !== 0 && !out.stillShown) fails.silent.push({ ...tag, totalErr: out.totalErr, ...(VERBOSE ? describeCase(res) : {}) });
      // 해로움: 전체 합계가 더 틀려졌고, 그것이 다른 결제 오차와의 상쇄 탓이 아님 (결제별 오차도 늘었음)
      if (Math.abs(out.totalErr) > Math.abs(out.totalBefore) && out.errAfter > out.errBefore) {
        st.harmful += 1;
        fails.harmful.push({ ...tag, before: out.errBefore, after: out.errAfter, ...(VERBOSE ? describeCase(res) : {}) });
      }
      if (out.keepTouched) fails.keepTouched.push(tag);
      if (out.repeats) fails.repeats.push({ ...tag, ...(VERBOSE ? describeCase(res) : {}) });
    }
  });
  if (VERBOSE) {
    console.log('counts', JSON.stringify(Object.fromEntries(Object.entries(fails).map(([k, v]) => [k, v.length]))));
    console.log('stats', JSON.stringify(stats));
    Object.entries(fails).forEach(([k, v]) => v.slice(0, Number(process.env.CARD_PROPERTY_SHOW || 3))
      .forEach(f => console.log(k, JSON.stringify(f, null, 1))));
  }
  expect(fails.structure).toEqual([]);
  expect(fails.keepTouched).toEqual([]);
  expect(fails.silent).toEqual([]);
  expect(fails.harmful).toEqual([]);
  expect(fails.repeats).toEqual([]);
});

// ── 환불이 잦은 사용자 (refundHeavy) ─────────────────────────────
// 정기 결제(같은 금액), 같은 가게·같은 금액 반복 구매, 캐치테이블 예약금(방문 후 환불), KTX 예매·취소, 쿠팡 반품이 섞인 반년.
// 결제·환불을 모두 적는 사용자 — 환불 기록은 취소일에(60%), 며칠 늦게(25%), 반품 신청일에 미리(15%) 적는다.
// 10월 명세서(기간 10/1~10/31)로 대조해
//   1) 맞는 가계부: 권하는 동작(수정·미리 체크된 추가·삭제)이 하나도 없어야 한다
//   2) 10월 카드에 취소 행이 있는 환불 하나를 빠뜨린 가계부:
//      · 기간 합계가 카드와 다른데 화면에 확인거리가 하나도 없으면 안 된다 (조용한 오류)
//      · 권하는 버튼을 누른 뒤 전체 합계가 맞는 가계부에서 더 멀어지면 안 된다 (해로움)
// 생성기에서 빼는 경우 (빠뜨린 환불 쪽, 기계적으로 맞힐 수 없음 — 예약금을 며칠 간격으로 여러 번 걸고 환불받으면 생긴다.
// 다음·지난 명세서와 함께 보아야만 가릴 수 있다):
//   · 명세서 기간 밖에 같은 가게·같은 금액의 다른 환불 기록이 있고, 빠뜨린 환불의 취소일과 그 기록 사이에
//     같은 가게·같은 금액 결제가 없음 (뒤쪽은 취소 다음 날 ~ 기록 날짜, 앞쪽은 기록 날짜 ~ 취소 전날) —
//     그 기록이 이 취소의 환불을 늦게(앞 기간이면 미리) 적은 것과 구별할 수 없다.
//   · 지난·다음 명세서의 취소에 딸린 같은 가게·같은 금액 환불을 이번 기간 안의 날짜로 적음 (9/30 취소를 10/7에 적음) —
//     기간 안 기록은 이번 명세서의 몫으로 보고 사이 결제를 따지지 않으므로, 빠뜨린 이번 달 환불 자리를 그 기록이 채운다.
const RH_N = Number((typeof process !== 'undefined' && process.env.CARD_REFUND_N) || 20);

function genRefundHeavy(seed) {
  const R = mulberry32(seed);
  const R100 = (lo, hi) => Math.round((lo + R() * (hi - lo)) / 100) * 100;
  const pay = [];
  const push = (date, card, user, amount, refundAfter = null) => {
    const p = { date, card, user, amount };
    if (refundAfter !== null) {
      const cdate = addDays(date, refundAfter);
      const x = R();
      const recDate = x < 0.6 ? cdate : x < 0.85 ? addDays(cdate, 1 + Math.floor(R() * 7)) : addDays(cdate, -(1 + Math.floor(R() * 3)));
      p.refund = { date: cdate, recDate: recDate < date ? date : recDate };
    }
    pay.push(p);
  };
  for (let m = 6; m <= 11; m += 1) {
    const mm = String(m).padStart(2, '0');
    push(`2026-${mm}-17`, 'NETFLIX.COM', '넷플릭스', 17000);
    push(`2026-${mm}-05`, '쿠팡(주)', '쿠팡 와우', 7890);
  }
  for (let d = 0; d < 166; d += 1) {
    const date = addDays('2026-06-01', d);
    if (R() < 0.08) push(date, '쿠팡(주)', '쿠팡 생수', 23900, R() < 0.1 ? 2 + Math.floor(R() * 5) : null);
    if (R() < 0.08) push(date, '쿠팡(주)', '쿠팡', R100(5000, 60000), R() < 0.12 ? 2 + Math.floor(R() * 8) : null);
    if (R() < 0.05) push(date, '캐치테이블', '캐치테이블 예약금', 10000, 1 + Math.floor(R() * 6));
    if (R() < 0.04) push(date, '코레일 KTX', 'KTX', 45000, R() < 0.3 ? Math.floor(R() * 4) : null);
    if (R() < 0.5) push(date, '스타벅스 성수역점', '스타벅스', pick(R, [4500, 5000, 6100]));
    if (R() < 0.3) push(date, 'GS25 성수역점', 'GS25', R100(1200, 9000));
  }
  return pay;
}
function pick(R, list) { return list[Math.floor(R() * list.length)]; }

const OCT_FROM = '2026-10-01';
const OCT_TO = '2026-10-31';
const inOct = d => d >= OCT_FROM && d <= OCT_TO;

function refundLedger(pay, forget = -1) {
  const { db } = createDatabase(SQL, null);
  db.run(`INSERT INTO payment_methods (name) VALUES ('현금'),('${OTHER}'),('${CARD}')`);
  db.run("INSERT INTO budget_categories (name) VALUES ('식비')");
  db.run("INSERT INTO sub_categories (budget_category, name) VALUES ('식비','점심')");
  const put = (date, detail, amount) => addTransaction(db, { payment_method: CARD, budget_category: '식비', sub_category: '점심', date, detail, amount });
  pay.forEach((p, i) => {
    put(p.date, p.user, p.amount);
    if (p.refund && i !== forget) put(p.refund.recDate, `${p.user} 환불`, -p.amount);
  });
  return db;
}

function refundCardRows(pay) {
  const rows = [];
  pay.forEach(p => {
    if (inOct(p.date)) rows.push(cardRow(p.date, p.card, p.amount, ''));
    if (p.refund && inOct(p.refund.date)) rows.push(cardRow(p.refund.date, p.card, -p.amount, ''));
  });
  return rows.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 빠뜨린 환불이 기간 밖의 다른 환불 기록과 구별되지 않는 경우 (머리말 참고) */
function indistinguishable(pay, fi) {
  const p = pay[fi];
  const c = p.refund.date;
  const samePay = q => q.user === p.user && q.amount === p.amount;
  return pay.some((q, i) => {
    if (i === fi || !samePay(q) || !q.refund) return false;
    const r = q.refund.recDate;
    if (inOct(r)) return !inOct(q.refund.date);
    return r > c
      ? !pay.some(x => samePay(x) && x.date > c && x.date <= r)
      : !pay.some(x => samePay(x) && x.date >= r && x.date < c);
  });
}

const cardTotalOf = db => getTransactions(db, { payment_method: CARD }).reduce((s, t) => s + t.amount, 0);
const octTotalOf = db => getTransactions(db, { payment_method: CARD }).filter(t => inOct(t.date)).reduce((s, t) => s + t.amount, 0);

test('무작위: 환불이 잦은 사용자 — 맞는 가계부엔 권하는 동작이 없고, 빠뜨린 환불은 조용히 숨지 않으며, 버튼이 더 틀리게 만들지 않는다', { timeout: Math.max(60000, RH_N * 4000) }, () => {
  const fails = { actions: [], silent: [], harmful: [] };
  const stats = { cases: 0, allGood: 0, forgot: 0, excluded: 0, shown: 0 };
  for (let k = 1; k <= RH_N; k += 1) {
    const seed = k * 104729 + 3;
    const pay = genRefundHeavy(seed);
    const st = normalizeStatement({ period_from: OCT_FROM, period_to: OCT_TO, rows: refundCardRows(pay) }, '2026-11-20');
    const cardSum = st.rows.reduce((s, x) => s + x.amount, 0);
    let db = refundLedger(pay);
    const correctTotal = cardTotalOf(db);
    let r = reconcileStatement(db, { paymentMethod: CARD, ...st });
    stats.cases += 1;
    const shownOf = x => x.mismatched.length > 0 || x.missing.length > 0 || x.notOnCard.length > 0 || x.cancelled.some(y => y.tx || y.maybeTx);
    if (!shownOf(r)) stats.allGood += 1;
    if (suggests(r)) fails.actions.push({ seed, ...(VERBOSE ? describeCase({ c: { cardRows: st.rows, ledger: [] }, r }) : {}) });
    db.close();
    pay.forEach((p, fi) => {
      if (!p.refund || !inOct(p.refund.date)) return;
      if (indistinguishable(pay, fi)) { stats.excluded += 1; return; }
      stats.forgot += 1;
      db = refundLedger(pay, fi);
      r = reconcileStatement(db, { paymentMethod: CARD, ...st });
      const tag = { seed, forgot: `${p.user} ${p.amount} 결제 ${p.date} 취소 ${p.refund.date} 기록 ${p.refund.recDate}` };
      if (shownOf(r)) stats.shown += 1;
      else if (octTotalOf(db) !== cardSum) fails.silent.push(tag);
      const before = Math.abs(cardTotalOf(db) - correctTotal);
      pressRecommended(db, r);
      if (Math.abs(cardTotalOf(db) - correctTotal) > before) fails.harmful.push(tag);
      db.close();
    });
  }
  if (VERBOSE) {
    console.log('refundHeavy', JSON.stringify({ ...stats, fails: Object.fromEntries(Object.entries(fails).map(([key, v]) => [key, v.length])) }));
    Object.entries(fails).forEach(([key, v]) => v.slice(0, 3).forEach(f => console.log(key, JSON.stringify(f))));
  }
  expect(fails.actions).toEqual([]);
  expect(fails.silent).toEqual([]);
  expect(fails.harmful).toEqual([]);
});
