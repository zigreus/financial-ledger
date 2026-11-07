/**
 * 설정 화면 섹션들이 함께 쓰는 도우미
 */

/**
 * 드롭 표시선 위치(dropIdx: 화면 목록 기준) → 옮기는 항목을 뺀 목록 기준 위치.
 * sameGroup으로 표시/숨김 같은 그룹 안에서만 셀 수 있다.
 */
export function dropTargetIndex(items, dragId, dropIdx, sameGroup = () => true) {
  return items.slice(0, dropIdx).filter(i => i.id !== dragId && sameGroup(i)).length;
}

/** 사용처 건수 → "거래 3건, 정기지출 1건" */
export function usageText(usage) {
  const labels = {
    transactions: '거래', recurring: '정기지출', favorites: '즐겨찾기',
    discountRules: '할인규칙', accountItems: '계좌 고정항목',
  };
  return Object.entries(labels)
    .filter(([key]) => usage[key] > 0)
    .map(([key, label]) => `${label} ${usage[key]}건`)
    .join(', ');
}
