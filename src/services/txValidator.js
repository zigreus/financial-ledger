/**
 * 공통 거래 유효성 검사 유틸리티
 *
 * ImportModal과 TransactionList가 동일한 로직으로 이슈를 감지한다.
 * "이슈"의 정의: DB에 등록되지 않은 카테고리 또는 세부카테고리가 거래에 사용된 상태.
 */

/**
 * DB에서 검증에 필요한 컨텍스트를 빌드한다.
 * 숨김(is_hidden) 항목도 포함 — 숨겨도 존재하면 이슈가 아니다.
 *
 * @param {object} db  sql.js DB 인스턴스
 * @returns {{ categories: Set<string>, subCatMap: Map<string, Set<string>> }}
 */
export function buildValidationContext(db) {
  const catRes = db.exec('SELECT name FROM budget_categories');
  const categories = new Set((catRes[0]?.values || []).map(r => r[0]));

  // 서브카테고리 전체를 한 번에 로드 (N+1 쿼리 방지)
  const subRes = db.exec('SELECT budget_category, name FROM sub_categories');
  const subCatMap = new Map();
  categories.forEach(cat => subCatMap.set(cat, new Set()));
  (subRes[0]?.values || []).forEach(([cat, name]) => {
    if (!subCatMap.has(cat)) subCatMap.set(cat, new Set());
    subCatMap.get(cat).add(name);
  });

  return { categories, subCatMap };
}

/**
 * 거래 하나에서 이슈 목록을 반환한다.
 *
 * @param {{ budget_category?: string, sub_category?: string }} tx
 * @param {{ categories: Set<string>, subCatMap: Map<string, Set<string>> }} context
 * @returns {Array<{ field: 'budget_category'|'sub_category', message: string }>}
 */
export function detectIssues(tx, { categories, subCatMap }) {
  const issues = [];

  if (tx.budget_category && !categories.has(tx.budget_category)) {
    issues.push({
      field: 'budget_category',
      message: `카테고리 '${tx.budget_category}' 없음`,
    });
  }

  if (tx.sub_category && tx.budget_category) {
    const subs = subCatMap.get(tx.budget_category);
    if (!subs?.has(tx.sub_category)) {
      issues.push({
        field: 'sub_category',
        message: `세부카테고리 '${tx.sub_category}' 없음`,
      });
    }
  }

  return issues;
}

/**
 * 이슈 여부만 반환 (boolean).
 */
export function hasIssue(tx, context) {
  return detectIssues(tx, context).length > 0;
}

/**
 * 세부카테고리만 이슈인지 반환.
 * 거래 목록에서 sub_category 텍스트에 underline 표시용.
 */
export function hasSubCategoryIssue(tx, { subCatMap }) {
  if (!tx.sub_category || !tx.budget_category) return false;
  const subs = subCatMap.get(tx.budget_category);
  return !subs?.has(tx.sub_category);
}
