/**
 * @vitest-environment node
 */
// 카드 내역 대조 — 평범한 달 (5차 리뷰 J7)
// 카드 결제마다 가계부에 한 번씩, 날짜 ±1일 안에 맞게 적은 사용자의 한 달 명세서(10/1~10/31)를 만든다.
// 같은 카드의 앞뒤 명세서 몫(9/24~9/30, 11/1~11/14) 기록도 있다 — 가계부가 맞으므로
//   1) 권하는 동작(카드 금액으로 수정·미리 체크된 추가·취소 결제 삭제)이 하나도 없어야 하고 (맞는 가계부를 틀리게 만들지 않게)
//   2) 가게 이름을 카드에 찍히는 대로 적는 사용자면 거의 늘 "모두 맞습니다"가 나와야 한다 (확인거리가 없는데 보이지 않게).
// 변형:
//   strictNames   : 가게 이름을 카드 표기대로 적음 (날짜는 20%가 ±1일)
//   strictNoShift : 위와 같고 날짜도 정확
//   strictFull    : 위 + 결제 후 취소(가계부에 안 적거나 결제·환불 둘 다 적음), 다른 결제수단 기록, 청구할인
//   namesOnly     : 브랜드는 같지만 줄여 적기도 함 ("메가커피" ↔ "메가MGC커피") — 이름이 닿지 않으면 확인거리가 남는다
//   realistic     : 카드에 법인명이 찍히는 곳 ("(주)우아한형제들" ↔ "배민 치킨")까지
//   noPeriod      : 명세서 기간을 읽지 못함 (행 날짜로 범위를 정함)
//   crossBoundary : 기간 경계를 넘겨 적기도 함 (10/31 결제를 11/1에)
//   …AI          : AI가 카드 행마다 입력 습관 표기("메가커피", "배민 치킨")를 골라 줌 — 짝짓기 별칭으로 쓰인다
//   noPeriodInstallment: 기간을 못 읽었고 할부 원거래 행(7/3)이 섞임, 7~9월 기록도 있음 — 범위가 7월부터로 넓어져
//                  그 사이 기록이 "카드에 없음"으로 넘치면 안 된다
// "모두 맞습니다" 비율은 strict·AI 변형에서 단언하고, 나머지는 권하는 동작이 없는지만 본다.
// (CARD_ORDINARY_N=300 CARD_ORDINARY_VERBOSE=1 로 많이 돌려 비율을 볼 수 있다)
import initSqlJs from 'sql.js';
import { createDatabase, addTransaction } from '../dbManager';
import { normalizeStatement, reconcileStatement } from '../cardStatement';
import { addDays } from '../dateUtils';

let SQL;
beforeAll(async () => { SQL = await initSqlJs(); });

const env = typeof process !== 'undefined' ? process.env : {};
const N = Number(env.CARD_ORDINARY_N || 25);
const VERBOSE = !!env.CARD_ORDINARY_VERBOSE;
const CARD = '신한카드';
const TODAY = '2026-11-15';

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R100 = (R, lo, hi) => Math.round((lo + R() * (hi - lo)) / 100) * 100;
const R10 = (R, lo, hi) => Math.round((lo + R() * (hi - lo)) / 10) * 10;
const one = (R, list) => list[Math.floor(R() * list.length)];

// card: 카드 표기, user: 사용자 표기, strictCard/strictUser: 카드 표기대로 적는 사용자, corp: 카드엔 법인명
const SHOPS = [
  { k: 'coffee', w: 8, card: ['스타벅스코리아', '스타벅스 성수역점', '스타벅스'], user: ['스타벅스', '스타벅스 라떼'], amt: R => one(R, [4500, 4700, 5000, 5500, 6100, 9000]) },
  {
    k: 'coffee2', w: 3, card: ['메가MGC커피 성수점', '메가엠지씨커피'], user: ['메가커피'],
    strictCard: ['메가MGC커피 성수점', '메가MGC커피 서울숲점'], strictUser: ['메가MGC커피'], amt: R => one(R, [2000, 3000, 3500, 4500]),
  },
  { k: 'conv', w: 6, card: ['GS25 성수역점', 'GS25 성수점'], user: ['GS25', 'GS25 간식'], amt: R => R100(R, 1200, 12000) },
  { k: 'conv2', w: 3, card: ['CU 성수역점', 'CU 서울숲점'], user: ['CU'], amt: R => R100(R, 1200, 9000) },
  { k: 'grocery', w: 3, card: ['(주)이마트 성수점', '이마트 성수점'], user: ['이마트', '이마트 장보기'], amt: R => R10(R, 15000, 150000) },
  { k: 'online', w: 5, card: ['쿠팡(주)', '쿠팡'], user: ['쿠팡', '쿠팡 생필품'], amt: R => R100(R, 5000, 80000) },
  { k: 'npay', w: 2, card: ['네이버페이 무신사', '무신사'], user: ['무신사'], amt: R => R100(R, 20000, 120000) },
  { k: 'rest', w: 5, card: ['김밥천국 성수점', '본죽 성수점', '한솥도시락 성수점'], user: null, amt: R => one(R, [8000, 9000, 9500, 10000, 12000, 18000]) },
  { k: 'mcd', w: 2, card: ['한국맥도날드(유)', '맥도날드 성수점'], user: ['맥도날드'], amt: R => R100(R, 6000, 15000) },
  { k: 'fuel', w: 2, card: ['GS칼텍스 성수주유소', 'SK에너지 성수주유소'], user: null, amt: R => Math.round((40000 + R() * 40000) / 1000) * 1000 },
  { k: 'olive', w: 1, card: ['CJ올리브영 성수역점', '올리브영 성수'], user: ['올리브영'], amt: R => R100(R, 8000, 60000) },
  { k: 'daiso', w: 1, card: ['(주)아성다이소 성수점', '다이소 성수점'], user: ['다이소'], amt: R => R100(R, 2000, 20000) },
  { k: 'baemin', w: 4, corp: true, card: ['(주)우아한형제들', '우아한형제들'], user: ['배민 치킨', '배달의민족'], amt: R => R100(R, 15000, 35000) },
  { k: 'taxi', w: 2, corp: true, card: ['카카오모빌리티'], user: ['카카오택시', '택시'], amt: R => R100(R, 4800, 25000) },
];
const NETFLIX = { k: 'netflix', corp: true, card: ['NETFLIX.COM'], user: ['넷플릭스'], amt: () => 17000 };

/** 사용자 표기 — rest·fuel은 카드 이름의 브랜드 부분 */
function userNameOf(shop, cardName, R, o) {
  if (o.strict && shop.strictUser) return shop.strictUser[0];
  if (o.strict && !shop.user) return cardName.split(' ')[0];
  if (shop.user) return one(R, shop.user);
  const brand = cardName.split(' ')[0];
  return R() < 0.5 ? brand : `${brand} ${shop.k === 'fuel' ? '주유' : '점심'}`;
}

function pickShop(R, shops) {
  const total = shops.reduce((s, x) => s + x.w, 0);
  let x = R() * total;
  for (let i = 0; i < shops.length; i += 1) {
    x -= shops[i].w;
    if (x < 0) return shops[i];
  }
  return shops[shops.length - 1];
}

/** 한 기간의 결제 목록 — 하루 결제 수는 포아송 비슷하게 */
function payments(R, from, days, perDay, o) {
  const shops = o.namesOnly ? SHOPS.filter(s => !s.corp) : SHOPS;
  const out = [];
  for (let d = 0; d < days; d += 1) {
    let n = 0;
    let p = Math.exp(-perDay);
    let c = p;
    const u = R();
    while (u > c && n < 8) { n += 1; p *= perDay / n; c += p; }
    for (let i = 0; i < n; i += 1) {
      const shop = pickShop(R, shops);
      const cardName = one(R, o.strict && shop.strictCard ? shop.strictCard : shop.card);
      out.push({ date: addDays(from, d), shop, cardName, amount: shop.amt(R) });
    }
  }
  if (!o.namesOnly && from === '2026-10-01') out.push({ date: '2026-10-17', shop: NETFLIX, cardName: 'NETFLIX.COM', amount: 17000 });
  return out;
}

const cardRow = (date, merchant, amount, detail = '') => ({
  date, merchant, amount, is_cancel: amount < 0, currency: 'KRW', foreign_amount: 0, installment: '', category: '모름', detail,
});
/** AI가 입력 습관에서 고르는 표기 — 그 가게를 사용자가 주로 적는 이름 */
function habitOf(shop, cardName, o) {
  if (!o.aiHabit) return '';
  if (o.strict && shop.strictUser) return shop.strictUser[0];
  return shop.user ? shop.user[0] : cardName.split(' ')[0];
}

function genMonth(seed, o) {
  const R = mulberry32(seed);
  const perDay = 0.6 + R() * 1.4;   // 하루 0.6~2건
  const oct = payments(R, '2026-10-01', 31, perDay, o);
  const neighbors = [...payments(R, '2026-09-24', 7, perDay, o), ...payments(R, '2026-11-01', 14, perDay, o)];
  const shiftRate = o.shiftRate !== undefined ? o.shiftRate : 0.2;
  const shift = () => (R() < shiftRate ? (R() < 0.5 ? 1 : -1) : 0);
  const ledger = [];
  const cardRows = [];
  const inOctober = d => d >= '2026-10-01' && d <= '2026-10-31';
  const record = (p, octPayment) => {
    let date = addDays(p.date, shift());
    // 이번 달 결제는 이번 달 안에 적는다 (경계를 넘겨 적는 것은 crossBoundary일 때만)
    if (!o.crossBoundary && inOctober(date) !== octPayment) date = p.date;
    const discount = o.discount && R() < 0.1 ? 500 : 0;
    ledger.push({ date, detail: userNameOf(p.shop, p.cardName, R, o), amount: p.amount + discount, discount_amount: discount, method: CARD });
    return discount;
  };
  oct.forEach(p => {
    const discount = record(p, true);
    // 캐시백(카드엔 할인 전 금액) / 즉시 할인(할인 후 금액)
    cardRows.push(cardRow(p.date, p.cardName, discount && R() < 0.5 ? p.amount + discount : p.amount, habitOf(p.shop, p.cardName, o)));
  });
  neighbors.forEach(p => record(p, false));
  // 할부 원거래 행(명세서 상세에 원거래일로 나옴)과 그 사이 달의 평범한 기록
  if (o.installment) {
    cardRows.push({ ...cardRow('2026-07-03', '삼성전자 디지털프라자', 1200000), installment: '12개월 중 4회' });
    ledger.push({ date: '2026-07-03', detail: '삼성전자 냉장고', amount: 1200000, method: CARD });
    ['07', '08', '09'].forEach(mm => [3, 8, 12, 17, 21].forEach(d => ledger.push({
      date: `2026-${mm}-${String(d).padStart(2, '0')}`, detail: '스타벅스', amount: 4500 + d * 100, method: CARD,
    })));
  }
  // 결제 후 취소 — 가계부에 안 적었거나, 결제·환불을 둘 다 적음
  if (o.cancel && R() < 0.4 && oct.length) {
    const shop = pickShop(R, SHOPS.filter(s => !s.corp));
    const cardName = shop.card[0];
    const date = addDays('2026-10-01', Math.floor(R() * 28));
    const amount = shop.amt(R);
    const cdate = addDays(date, Math.floor(R() * 3));
    cardRows.push(cardRow(date, cardName, amount), cardRow(cdate, cardName, -amount));
    if (R() < 0.3) {
      const name = userNameOf(shop, cardName, R, o);
      ledger.push({ date, detail: name, amount, method: CARD }, { date: cdate, detail: `${name} 환불`, amount: -amount, method: CARD });
    }
  }
  // 다른 결제수단 기록 (이 카드 대조와 상관없음)
  if (o.others) {
    payments(R, '2026-09-24', 52, 0.5, o).forEach(p => ledger.push({
      date: p.date, detail: userNameOf(p.shop, p.cardName, R, o), amount: p.amount, method: R() < 0.5 ? '현금' : '카카오페이',
    }));
  }
  cardRows.sort((a, b) => (a.date < b.date ? 1 : -1));   // 카드 앱 목록 순서 (최근 것 먼저)
  return { cardRows, ledger };
}

function runMonth(seed, o) {
  const c = genMonth(seed, o);
  const { db } = createDatabase(SQL, null);
  db.run(`INSERT INTO payment_methods (name) VALUES ('현금'),('카카오페이'),('${CARD}')`);
  db.run("INSERT INTO budget_categories (name) VALUES ('식비')");
  db.run("INSERT INTO sub_categories (budget_category, name) VALUES ('식비','점심')");
  c.ledger.forEach(l => addTransaction(db, {
    payment_method: l.method, budget_category: '식비', sub_category: '점심',
    date: l.date, detail: l.detail, amount: l.amount, discount_amount: l.discount_amount || 0,
  }));
  const st = normalizeStatement({
    period_from: o.noPeriod ? '' : '2026-10-01', period_to: o.noPeriod ? '' : '2026-10-31', rows: c.cardRows,
  }, TODAY);
  const t0 = Date.now();
  const r = reconcileStatement(db, { paymentMethod: CARD, ...st });
  const ms = Date.now() - t0;
  db.close();
  const toRemove = r.cancelled.filter(x => x.tx || x.maybeTx);
  return {
    r,
    ms,
    rows: c.cardRows.length,
    // 화면의 "모두 맞습니다" 조건과 같다
    allGood: !r.mismatched.length && !r.missing.length && !r.notOnCard.length && !toRemove.length,
    // 이번 달과 상관없는 지난 달들의 기록이 "카드에 없음"에 나옴 (범위를 할부 원거래일까지 넓힌 경우)
    oldNotOnCard: r.notOnCard.filter(t => t.date < '2026-09-24').length,
    // 맞는 가계부에서 권하는 동작 — 하나라도 있으면 맞는 기록을 틀리게 만든다
    actions: r.mismatched.filter(m => m.fixable).length + r.missing.filter(m => m.autoCheck).length + r.cancelled.filter(x => x.tx).length,
  };
}

const VARIANTS = {
  strictNames: { opts: { namesOnly: true, strict: true }, minAllGood: 0.95 },
  strictNoShift: { opts: { namesOnly: true, strict: true, shiftRate: 0 }, minAllGood: 0.95 },
  strictFull: { opts: { namesOnly: true, strict: true, cancel: true, others: true, discount: true }, minAllGood: 0.95 },
  namesOnly: { opts: { namesOnly: true } },
  realistic: { opts: { cancel: true, others: true, discount: true } },
  noPeriod: { opts: { cancel: true, others: true, noPeriod: true } },
  crossBoundary: { opts: { crossBoundary: true } },
  noPeriodInstallment: { opts: { cancel: true, others: true, noPeriod: true, installment: true } },
  namesOnlyAI: { opts: { namesOnly: true, aiHabit: true }, minAllGood: 0.95 },
  realisticAI: { opts: { cancel: true, others: true, discount: true, aiHabit: true }, minAllGood: 0.95 },
};

test('평범한 달: 맞는 가계부에 권하는 동작이 없고, 지난 달 기록이 "카드에 없음"에 넘치지 않으며, 카드 표기대로 적거나 AI가 습관 표기를 고르면 95% 이상 "모두 맞습니다"', { timeout: Math.max(60000, N * 2000) }, () => {
  const stats = {};
  const harmful = [];
  Object.entries(VARIANTS).forEach(([name, { opts }], vi) => {
    const s = { n: 0, allGood: 0, actions: 0, maxMs: 0, rows: 0, oldNotOnCard: 0 };
    stats[name] = s;
    for (let k = 1; k <= N; k += 1) {
      const seed = k * 7919 + vi * 1000003;
      const x = runMonth(seed, opts);
      s.n += 1;
      s.rows += x.rows;
      s.maxMs = Math.max(s.maxMs, x.ms);
      if (x.allGood) s.allGood += 1;
      s.oldNotOnCard += x.oldNotOnCard;
      if (x.actions) {
        s.actions += x.actions;
        harmful.push({
          variant: name,
          seed,
          ...(VERBOSE ? {
            mismatched: x.r.mismatched.filter(m => m.fixable).map(m => `[${m.rows.map(q => `${q.merchant}:${q.amount}@${q.date.slice(5)}`)}] vs [${m.txs.map(t => `${t.detail}:${t.amount}@${t.date.slice(5)}`)}]`),
            missing: x.r.missing.filter(m => m.autoCheck).map(m => `${m.row.merchant}:${m.row.amount}@${m.row.date.slice(5)}`),
            cancelled: x.r.cancelled.filter(c => c.tx).map(c => `${c.approval.merchant}:${c.approval.amount} tx=${c.tx.detail}`),
          } : {}),
        });
      }
    }
    s.rows = Math.round(s.rows / s.n);
  });
  if (VERBOSE) {
    Object.entries(stats).forEach(([name, s]) => console.log(name, JSON.stringify({ ...s, allGoodRate: `${Math.round((s.allGood / s.n) * 100)}%` })));
    harmful.slice(0, 5).forEach(h => console.log('harmful', JSON.stringify(h, null, 1)));
  }
  expect(harmful).toEqual([]);
  expect(Object.entries(stats).filter(([, s]) => s.oldNotOnCard).map(([name]) => name)).toEqual([]);
  Object.entries(VARIANTS).forEach(([name, { minAllGood }]) => {
    if (minAllGood) expect({ name, rate: stats[name].allGood / stats[name].n >= minAllGood }).toEqual({ name, rate: true });
  });
});
