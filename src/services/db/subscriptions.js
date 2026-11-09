// 구독 모아보기 (I-027, ROADMAP C-8) — 선택 기능: 설정에서 켜야 화면에 보인다(가족 공통 설정).
//
// 정기지출(recurring_transactions) 중 '구독'으로 표시한 것(is_subscription)을 모아 월·연 환산 합계를 보여 준다.
//  - 금액은 할인 뺀 금액(순지출, AGENTS §4) — 템플릿 할인이 없으면 결제수단 할인 규칙으로(자동등록과 같은 값).
//  - 월 환산: 월별은 그대로, 연간은 12로 나눈다. 연 환산: 월별 × 12, 연간은 그대로.
//  - 최근 결제: 그 정기지출이 등록한 거래(transactions.recurring_source_id) 중 오늘까지의 마지막 것.
//    나눠 결제한 회차는 몫을 합친 금액으로 본다(연결이 남는 것은 원래 행 하나뿐).
//    그 금액(할인 전)이 등록 금액과 3% 넘게 다르면 '금액이 바뀐 구독'으로 알린다 — 카드 대조 등으로 실제 결제액을 고친 경우.
//    금액을 확인한 날(amount_checked_on — 정기지출 금액을 바꾼 날(새 금액이 되지 못한 앞으로의 거래가 있으면 그 마지막 날)이나
//    '이대로 두기'를 누른 결제일)까지의 결제는 견주지 않는다.
//    그래야 금액을 올린 직후 옛 금액의 지난 결제로 다시 알리지 않고, 외화 결제처럼 조금씩 다른 금액에 매달 알리지 않는다.
//  - 해지 메모(cancel_note): 해지 방법·해지할 때 등을 적어 둔다.

//  - 곧 결제될 구독(getUpcomingSubscriptionPayments): 거래내역 '확인할 것'에 결제 며칠 전부터 알린다(I-036).

import { addDays, parseDateStr } from '../dateUtils';
import { dbRowsToObjects, todayLocal } from './common';
import { getSetting, setSetting } from './settings';
import { getRecurringTransactions, recurringDiscount } from './recurring';
import { recurringTxDateFor } from './recurringDates';

export const SUBSCRIPTIONS_SETTING = 'subscriptions_enabled';
/** 최근 결제가 등록 금액과 이만큼(비율) 넘게 달라야 알린다 */
export const SUBSCRIPTION_CHANGE_TOLERANCE = 0.03;
/** 결제 예정 알림을 결제일 며칠 전부터 보이는지 — 알림은 앱을 열 때만 보이므로 하루 전보다 넉넉히 */
export const SUBSCRIPTION_DUE_DAYS = 3;

export function isSubscriptionsEnabled(db) {
  return !!db && getSetting(db, SUBSCRIPTIONS_SETTING, '0') === '1';
}

export function setSubscriptionsEnabled(db, enabled) {
  setSetting(db, SUBSCRIPTIONS_SETTING, enabled ? '1' : '0');
}

// 구독처럼 보이는 정기지출 — 구독 고르기에서 위로 올리고 '구독 같아요'로 알린다(표시는 사용자가 한다)
const SUBSCRIPTION_HINTS = [
  '구독', '멤버십', '정기결제', '월정액', '넷플릭스', 'netflix', '유튜브', 'youtube', '디즈니', 'disney', '왓챠', '티빙', '웨이브',
  '쿠팡플레이', '와우', '스포티파이', 'spotify', '멜론', '지니', '플로', '벅스', '애플', 'apple', 'icloud', '구글 원', 'google one',
  '네이버플러스', '네이버 플러스', '배민클럽', '요기패스', '밀리의', '리디', '윌라', 'chatgpt', 'openai', 'claude', 'gemini',
  'microsoft 365', 'office 365', '어도비', 'adobe', '노션', 'notion', '드롭박스', 'dropbox', '닌텐도', 'playstation', 'xbox',
];

export function looksLikeSubscription(r) {
  const text = [r.detail, r.sub_category, r.budget_category, r.note].filter(Boolean).join(' ').toLowerCase();
  return SUBSCRIPTION_HINTS.some(k => text.includes(k));
}

export function setRecurringSubscription(db, id, on) {
  db.run('UPDATE recurring_transactions SET is_subscription = ? WHERE id = ?', [on ? 1 : 0, id]);
}

export function setSubscriptionNote(db, id, note) {
  db.run('UPDATE recurring_transactions SET cancel_note = ? WHERE id = ?', [String(note || '').trim(), id]);
}

/** '이대로 두기' — 그 결제일까지는 등록 금액과 달라도 알리지 않는다(다음 결제가 또 다르면 다시 알린다) */
export function keepSubscriptionAmount(db, id, paidDate) {
  db.run('UPDATE recurring_transactions SET amount_checked_on = ? WHERE id = ?', [paidDate, id]);
}

/**
 * 구독 목록 — [{ ...정기지출, discount, net, monthly, annual, lastPaid: { id, date, amount, net } | null, changed }]
 *  - discount: 한 번의 할인, net: 한 번 결제의 순지출, monthly·annual: 월·연 환산(순지출)
 *  - changed: 최근 결제의 금액(할인 전)이 등록 금액과 다름
 */
export function getSubscriptions(db, today = todayLocal()) {
  return getRecurringTransactions(db)
    .filter(r => r.is_subscription)
    .map(r => {
      const discount = recurringDiscount(db, r);
      const net = r.amount - discount;
      const annualItem = r.frequency === 'annual';
      const last = dbRowsToObjects(db.exec(
        `SELECT id, date, amount, discount_amount, COALESCE(split_group_id, '') AS split_group_id FROM transactions
         WHERE recurring_source_id = ? AND date <= ?
         ORDER BY date DESC, id DESC LIMIT 1`,
        [r.id, today],
      ))[0];
      let lastPaid = null;
      if (last) {
        let amount = Number(last.amount) || 0;
        let disc = Number(last.discount_amount) || 0;
        if (last.split_group_id) {
          const [sum, sumDisc] = db.exec(
            'SELECT COALESCE(SUM(amount), 0), COALESCE(SUM(discount_amount), 0) FROM transactions WHERE split_group_id = ?',
            [last.split_group_id],
          )[0].values[0];
          amount = Number(sum) || 0;
          disc = Number(sumDisc) || 0;
        }
        lastPaid = { id: last.id, date: last.date, amount, net: amount - disc, split: !!last.split_group_id };
      }
      const changed = !!lastPaid && r.amount > 0
        && lastPaid.date > (r.amount_checked_on || '')
        && Math.abs(lastPaid.amount - r.amount) > r.amount * SUBSCRIPTION_CHANGE_TOLERANCE;
      return {
        ...r,
        discount,
        net,
        monthly: annualItem ? Math.round(net / 12) : net,
        annual: annualItem ? net : net * 12,
        lastPaid,
        changed,
      };
    });
}

/**
 * 곧 결제될 구독 (I-036, ROADMAP C-12) — 오늘부터 days일 뒤까지 결제될 구독, 날짜순.
 *  - 자동등록한 달은 그때 미리 들어간 거래를 본다 — 사용자가 그 거래를 지웠거나(해지) 날짜·금액·내용을 고쳤으면 따른다.
 *  - 아직 자동등록하지 않은 달(새로 만든 정기지출은 두 달 뒤부터 등록된다)은 정기지출의 결제일·금액으로 센다.
 *    그 달에 이 정기지출의 거래가 있으면(다른 달에 등록된 거래를 옮겨 온 것) 그 거래로 본다 — 한 결제를 두 번 알리지 않게.
 *  - 결제일을 바꿔도 미리 등록된 거래의 날짜는 그대로다(B-092 — 목록과 같게). 그 거래의 날짜를 고치면 알림도 따른다.
 * [{ id, recurringId, name, date, daysUntil, amount }]
 *  - id: 목록 항목 구별용(미리 들어간 거래의 id, 등록 전이면 'r<정기지출 id>'). 닫은 기록의 열쇠로 쓰지 않는다 —
 *    닫은 기록은 recurringId@date로 남긴다(등록 전 일정으로 닫은 결제가 자동등록돼 거래 id가 생겨도 다시 뜨지 않게)
 *  - amount: 결제액(할인 전 — 카드로 실제 나가는 금액). 나눠 결제한 회차는 몫을 합친 금액
 */
export function getUpcomingSubscriptionPayments(db, today = todayLocal(), days = SUBSCRIPTION_DUE_DAYS) {
  const subs = getRecurringTransactions(db).filter(r => r.is_subscription);
  if (!subs.length) return [];
  const until = addDays(today, days);
  const start = parseDateStr(today);
  const daysUntil = date => Math.round((parseDateStr(date) - start) / 86400000);
  const nameOf = r => r.detail || r.sub_category || r.budget_category;

  const registered = dbRowsToObjects(db.exec(
    `SELECT t.id, t.date, t.amount, t.detail, COALESCE(t.split_group_id, '') AS split_group_id, t.recurring_source_id
     FROM transactions t JOIN recurring_transactions r ON r.id = t.recurring_source_id
     WHERE r.is_subscription = 1 AND t.date >= ? AND t.date <= ?`,
    [today, until],
  )).map(t => {
    let amount = Number(t.amount) || 0;
    if (t.split_group_id) {
      amount = Number(db.exec(
        'SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE split_group_id = ?',
        [t.split_group_id],
      )[0].values[0][0]) || 0;
    }
    const r = subs.find(s => s.id === t.recurring_source_id);
    return { id: t.id, recurringId: r.id, name: t.detail || nameOf(r), date: t.date, daysUntil: daysUntil(t.date), amount };
  });

  // 아직 등록하지 않은 달 — 등록한 달이면(거래를 지웠어도) 정기지출의 날짜로 다시 세지 않는다.
  // 그 달에 이 정기지출의 거래가 있어도(다른 달 것을 옮겨 옴) 세지 않는다
  const months = [...new Set([today.slice(0, 7), until.slice(0, 7)])];
  const logged = new Set(dbRowsToObjects(db.exec(
    `SELECT recurring_id, registered_for_month FROM recurring_registration_log
     WHERE registered_for_month IN (${months.map(() => '?').join(', ')})`,
    months,
  )).map(l => `${l.recurring_id}|${l.registered_for_month}`));
  const scheduled = [];
  subs.forEach(r => months.forEach(ym => {
    if (logged.has(`${r.id}|${ym}`)) return;
    if (r.frequency === 'annual' && Number(r.month_of_year) !== Number(ym.slice(5, 7))) return;
    const date = recurringTxDateFor(r, ym);
    if (date < today || date > until) return;
    const moved = db.exec(
      'SELECT 1 FROM transactions WHERE recurring_source_id = ? AND date >= ? AND date <= ? LIMIT 1',
      [r.id, `${ym}-01`, `${ym}-31`],
    );
    if (moved[0]?.values.length) return;
    scheduled.push({ id: `r${r.id}`, recurringId: r.id, name: nameOf(r), date, daysUntil: daysUntil(date), amount: r.amount });
  }));

  const order = p => (typeof p.id === 'number' ? p.id : Number.MAX_SAFE_INTEGER - p.recurringId);
  return [...registered, ...scheduled].sort((a, b) => a.date.localeCompare(b.date) || order(a) - order(b));
}

/** 구독 합계 — { count, monthly, annual } (월 환산은 연간 구독을 모두 더한 뒤 12로 나눠 반올림) */
export function getSubscriptionTotals(subs) {
  let monthlyNet = 0;
  let annualNet = 0;
  subs.forEach(s => {
    if (s.frequency === 'annual') annualNet += s.net;
    else monthlyNet += s.net;
  });
  return {
    count: subs.length,
    monthly: monthlyNet + Math.round(annualNet / 12),
    annual: monthlyNet * 12 + annualNet,
  };
}
