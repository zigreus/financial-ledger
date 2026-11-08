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

import { dbRowsToObjects, todayLocal } from './common';
import { getSetting, setSetting } from './settings';
import { getRecurringTransactions, recurringDiscount } from './recurring';

export const SUBSCRIPTIONS_SETTING = 'subscriptions_enabled';
/** 최근 결제가 등록 금액과 이만큼(비율) 넘게 달라야 알린다 */
export const SUBSCRIPTION_CHANGE_TOLERANCE = 0.03;

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
