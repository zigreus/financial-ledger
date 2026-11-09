// 연말정산 참고 합계 (I-029, ROADMAP C-10) — 선택 기능: 설정에서 켜야 화면에 보인다(가족 공통 설정).
//
// 한 해 거래를 연말정산에 쓰는 묶음으로 더해 보여 준다. **공제액은 계산하지 않는다** — 세법이 해마다 바뀌어,
// 틀리면 신뢰를 잃는다. "참고 합계 + 홈택스 연말정산 간소화 자료와 견주기"까지만 한다(ROADMAP C-10).
//  - 결제수단 유형(payment_methods.tax_type): 신용카드 / 체크카드·현금영수증 / 현금(영수증 없음) / 그 밖. 비어 있으면 '유형 미정'.
//  - 항목(budget_categories.tax_tag, sub_categories.tax_tag): 의료비·교육비·대중교통·전통시장 등.
//    세부카테고리에 정한 것이 먼저이고, 비어 있으면 카테고리를 따른다. '-'는 '해당 없음'(예: 교통 › 택시는 대중교통이 아님).
//    표시는 카테고리·세부카테고리 행에 붙어 있어 이름을 바꾸면 따라가고, 지우면 함께 없어진다(AGENTS §3 참조 정리가 필요 없다).
//  - 금액은 결제액(할인 전 amount) — AGENTS §4의 순지출 원칙의 예외. 카드사가 국세청에 알리는 것은 실제 결제(승인) 금액이고,
//    이 앱의 카드 할인은 대부분 나중에 돌려받는 캐시백이다(I-016과 같은 이유). 할인 합계는 따로 보인다. 환불(음수)은 빼서 더한다.
//  - 외화 금액이 있는 거래(해외 결제 — 원화 KRW만 적힌 국내 일정 거래는 아님)는 카드 소득공제에서 빠지므로 따로 모은다.
//  - 여행 현금 지갑의 환차손익 조정 거래(is_cash_adjustment)는 실제 결제가 아니라 뺀다.
//  - 그 해 중 오늘 뒤 날짜(정기지출이 미리 등록한 것)는 아직 내지 않은 돈이라 빼고 따로 알린다.
//  - 알려진 한계: 이름으로 고르므로, 고르는 사이 다른 기기가 그 카테고리 이름을 바꿔 먼저 저장하면 고른 항목이 들어가지 않는다
//    (드물고 화면에서 바로 보인다 — 같은 이름을 양쪽에서 만든 경우를 맞게 처리하려고 id 대신 이름을 택했다).

import { getSetting, setSetting } from './settings';
import { hasForeignAmount, todayLocal } from './common';

export const TAX_SUMMARY_SETTING = 'tax_summary_enabled';

export const TAX_TYPES = [
  { key: 'credit', label: '신용카드' },
  { key: 'debit', label: '체크카드·현금영수증' },
  { key: 'cash', label: '현금(영수증 없음)' },
  { key: 'other', label: '그 밖(포인트·상품권 등)' },
];
const TYPE_KEYS = TAX_TYPES.map(t => t.key);

export const TAX_TAGS = ['의료비', '교육비', '기부금', '보험료', '월세', '대중교통', '전통시장', '문화(도서·공연 등)'];
export const TAX_TAG_NONE = '-';

export function isTaxSummaryEnabled(db) {
  return !!db && getSetting(db, TAX_SUMMARY_SETTING, '0') === '1';
}

export function setTaxSummaryEnabled(db, enabled) {
  setSetting(db, TAX_SUMMARY_SETTING, enabled ? '1' : '0');
}

/** 결제수단 유형 — 이름으로 고른다(병합 때 같은 이름의 결제수단이 양쪽에 있어도 맞게). ''이면 미정 */
export function setPaymentMethodTaxType(db, name, type) {
  if (type !== '' && !TYPE_KEYS.includes(type)) throw new Error(`알 수 없는 결제수단 유형: ${type}`);
  db.run('UPDATE payment_methods SET tax_type = ? WHERE name = ?', [type, name]);
}

/** 카테고리 항목 — ''이면 없음 */
export function setCategoryTaxTag(db, category, tag) {
  if (tag !== '' && !TAX_TAGS.includes(tag)) throw new Error(`알 수 없는 연말정산 항목: ${tag}`);
  db.run('UPDATE budget_categories SET tax_tag = ? WHERE name = ?', [tag, category]);
}

/** 세부카테고리 항목 — ''이면 카테고리를 따름, '-'이면 해당 없음 */
export function setSubCategoryTaxTag(db, category, sub, tag) {
  if (tag !== '' && tag !== TAX_TAG_NONE && !TAX_TAGS.includes(tag)) throw new Error(`알 수 없는 연말정산 항목: ${tag}`);
  db.run('UPDATE sub_categories SET tax_tag = ? WHERE budget_category = ? AND name = ?', [tag, category, sub]);
}

const rowsOf = res => {
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
};

/** 분류 정하기 화면용 — { methods: [{ name, taxType, hidden }], categories: [{ name, taxTag, hidden, subs: [{ name, taxTag, hidden }] }] } */
export function getTaxClassification(db) {
  const methods = rowsOf(db.exec('SELECT name, tax_type, is_hidden FROM payment_methods ORDER BY sort_order, name'))
    .map(m => ({ name: m.name, taxType: m.tax_type || '', hidden: !!m.is_hidden }));
  const subs = rowsOf(db.exec('SELECT budget_category, name, tax_tag, is_hidden FROM sub_categories ORDER BY sort_order, name'));
  const categories = rowsOf(db.exec('SELECT name, tax_tag, is_hidden FROM budget_categories ORDER BY sort_order, name'))
    .map(c => ({
      name: c.name,
      taxTag: c.tax_tag || '',
      hidden: !!c.is_hidden,
      subs: subs.filter(s => s.budget_category === c.name).map(s => ({ name: s.name, taxTag: s.tax_tag || '', hidden: !!s.is_hidden })),
    }));
  return { methods, categories };
}

/** 거래가 있는 해 (새 것부터) — 오늘까지의 거래만(미리 등록된 내년 정기지출로 내년이 보이지 않게) */
export function getTaxYears(db, today = todayLocal()) {
  const res = db.exec('SELECT DISTINCT substr(date, 1, 4) AS y FROM transactions WHERE date <= ? ORDER BY y DESC', [today]);
  return res.length ? res[0].values.map(r => r[0]) : [];
}

const CARD_TYPES = ['credit', 'debit'];

/**
 * 그 해 참고 합계
 * {
 *   year, total: { amount, discount, count },
 *   types: [{ key, label, amount, discount, count, methods: [{ name, amount, count }] }] — TAX_TYPES 순서, 마지막에 미정('')
 *   untypedMethods: ['결제수단 이름'] — 이 해에 쓴 유형 미정 결제수단(결제수단 목록에 있는 것),
 *   missingMethods: ['결제수단 이름'] — 이 해에 썼지만 결제수단 목록에 없는 것(다른 기기에서 지운 사이 쓴 것 등),
 *   usedCategories: ['카테고리 이름'] — 이 해에 쓴 카테고리(숨겼어도 분류 정하기에 보이게),
 *   tags: [{ tag, amount, count, notCard, parts: [{ category, sub, amount, count }] }] — 거래가 있는 항목만, TAX_TAGS 순서.
 *     notCard: 그중 신용카드·체크카드·현금영수증으로 정하지 않은 결제(현금(영수증 없음)·그 밖·유형 미정)
 *   foreign: { amount, count } — 외화 금액이 있는 거래(카드 소득공제에서 빠지는 해외 결제, 위 합계에서 뺐다),
 *   upcoming: { amount, count } — 오늘 뒤로 미리 등록된 거래(아직 내지 않아 위 합계에서 뺐다)
 * }
 */
export function getTaxSummary(db, year, today = todayLocal()) {
  const y = String(year);
  const rows = rowsOf(db.exec(
    `SELECT t.date, t.payment_method, t.budget_category, COALESCE(t.sub_category, '') AS sub_category,
            t.amount, COALESCE(t.discount_amount, 0) AS discount_amount, COALESCE(t.foreign_amounts, '') AS foreign_amounts,
            COALESCE(pm.tax_type, '') AS tax_type, pm.name IS NULL AS missing_method,
            COALESCE(bc.tax_tag, '') AS cat_tag, COALESCE(sc.tax_tag, '') AS sub_tag
     FROM transactions t
     LEFT JOIN payment_methods pm ON pm.name = t.payment_method
     LEFT JOIN budget_categories bc ON bc.name = t.budget_category
     LEFT JOIN sub_categories sc ON sc.budget_category = t.budget_category AND sc.name = t.sub_category
     WHERE t.date >= ? AND t.date < ? AND COALESCE(t.is_cash_adjustment, 0) = 0`,
    [`${y}-01-01`, `${Number(y) + 1}-01-01`],
  ));

  const total = { amount: 0, discount: 0, count: 0 };
  const foreign = { amount: 0, count: 0 };
  const upcoming = { amount: 0, count: 0 };
  const missing = new Set();
  const usedCategories = new Set();
  const types = new Map([...TAX_TYPES, { key: '', label: '유형 미정' }]
    .map(t => [t.key, { ...t, amount: 0, discount: 0, count: 0, methods: new Map() }]));
  const tags = new Map();

  rows.forEach(r => {
    const amount = Number(r.amount) || 0;
    const discount = Number(r.discount_amount) || 0;
    if (r.date > today) {
      upcoming.amount += amount;
      upcoming.count += 1;
      return;
    }
    if (hasForeignAmount(r.foreign_amounts)) {
      foreign.amount += amount;
      foreign.count += 1;
      return;
    }
    total.amount += amount;
    total.discount += discount;
    total.count += 1;
    if (r.budget_category) usedCategories.add(r.budget_category);
    if (r.missing_method) missing.add(r.payment_method);

    const typeKey = TYPE_KEYS.includes(r.tax_type) ? r.tax_type : '';
    const type = types.get(typeKey);
    type.amount += amount;
    type.discount += discount;
    type.count += 1;
    const m = type.methods.get(r.payment_method) || { name: r.payment_method, amount: 0, count: 0 };
    m.amount += amount;
    m.count += 1;
    type.methods.set(r.payment_method, m);

    const tag = r.sub_tag === TAX_TAG_NONE ? '' : (r.sub_tag || r.cat_tag);
    if (!TAX_TAGS.includes(tag)) return;
    const g = tags.get(tag) || { tag, amount: 0, count: 0, notCard: 0, parts: new Map() };
    g.amount += amount;
    g.count += 1;
    if (!CARD_TYPES.includes(typeKey)) g.notCard += amount;
    const key = `${r.budget_category}\u0000${r.sub_category}`;
    const p = g.parts.get(key) || { category: r.budget_category, sub: r.sub_category, amount: 0, count: 0 };
    p.amount += amount;
    p.count += 1;
    g.parts.set(key, p);
    tags.set(tag, g);
  });

  const byAmount = (a, b) => b.amount - a.amount || String(a.name || a.category).localeCompare(String(b.name || b.category));
  const typeList = [...types.values()].map(t => ({ ...t, methods: [...t.methods.values()].sort(byAmount) }));
  return {
    year: String(year),
    total,
    types: typeList,
    untypedMethods: typeList.find(t => t.key === '').methods.map(m => m.name).filter(n => !missing.has(n)),
    missingMethods: [...missing],
    usedCategories: [...usedCategories],
    tags: TAX_TAGS.filter(t => tags.has(t)).map(t => {
      const g = tags.get(t);
      return { ...g, parts: [...g.parts.values()].sort(byAmount) };
    }),
    foreign,
    upcoming,
  };
}
