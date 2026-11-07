// 결제수단 할인 — 결제수단별 기본 할인율과 할인 규칙(조회·추가·삭제·계산).

export function getPaymentMethodDiscountRates(db) {
  const result = db.exec('SELECT name, discount_rate FROM payment_methods');
  if (!result.length) return {};
  const rates = {};
  result[0].values.forEach(([name, rate]) => { rates[name] = rate || 0; });
  return rates;
}

export function setPaymentMethodDiscountRate(db, name, rate) {
  db.run('UPDATE payment_methods SET discount_rate = ? WHERE name = ?', [rate, name]);
}

// ── 결제수단 할인규칙 ────────────────────────────────────────────

export function getDiscountRules(db, paymentMethodName) {
  const result = db.exec(
    'SELECT id, payment_method_name, budget_category, sub_category, detail_keyword, rule_type, value, min_amount, note FROM payment_method_discount_rules WHERE payment_method_name = ? ORDER BY id',
    [paymentMethodName]
  );
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export function addDiscountRule(db, rule) {
  db.run(
    `INSERT INTO payment_method_discount_rules (payment_method_name, budget_category, sub_category, detail_keyword, rule_type, value, min_amount, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [rule.payment_method_name, rule.budget_category || '', rule.sub_category || '', rule.detail_keyword || '', rule.rule_type, rule.value, rule.min_amount || 0, rule.note || '']
  );
}

export function deleteDiscountRule(db, id) {
  db.run('DELETE FROM payment_method_discount_rules WHERE id = ?', [id]);
}

/**
 * rules 배열에서 (카테고리, 세부카테고리, 세부내역, 금액)에 맞는 최적 규칙을 찾아 할인 금액 반환.
 * - 우선순위 스코어: detail_keyword(+4) > budget_category(+2) > sub_category(+1)
 * - detail_keyword는 부분 일치(대소문자 무시)
 * - rule_type: 'percent' (value=비율 e.g.0.01), 'fixed' (value=고정원), 'remainder' (value=단위 e.g.1000)
 */
export function evaluateDiscountRule(rules, budgetCategory, subCategory, amount, detail = '') {
  if (!rules.length || !amount || amount <= 0) return 0;

  const detailLower = (detail || '').toLowerCase();
  let bestRule = null;
  let bestScore = -1;

  for (const rule of rules) {
    if (rule.budget_category && rule.budget_category !== budgetCategory) continue;
    if (rule.sub_category && rule.sub_category !== subCategory) continue;
    if (rule.detail_keyword && !detailLower.includes(rule.detail_keyword.toLowerCase())) continue;
    const score = (rule.budget_category ? 2 : 0) + (rule.sub_category ? 1 : 0) + (rule.detail_keyword ? 4 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  if (!bestRule) return 0;
  if (amount < (bestRule.min_amount || 0)) return 0;

  if (bestRule.rule_type === 'percent') return Math.round(amount * bestRule.value);
  if (bestRule.rule_type === 'fixed') return Math.round(bestRule.value);
  if (bestRule.rule_type === 'remainder') return amount % bestRule.value;
  return 0;
}
