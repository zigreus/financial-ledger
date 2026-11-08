/**
 * 가계부 카테고리 색 — 요약·캘린더 등 모든 화면이 이 한 곳의 규칙을 쓴다.
 * 기본 카테고리는 정해진 색, 사용자가 추가한 카테고리는 이름에서 만든 고정 색(화면이 달라도 같은 색).
 */
export const DEFAULT_CATEGORY_COLORS = {
  '식비': '#FF6B6B',
  '쇼핑': '#4ECDC4',
  '차량교통비': '#45B7D1',
  '의류/미용': '#F7DC6F',
  '의료/건강': '#82E0AA',
  '교육': '#BB8FCE',
  '여행/문화': '#F0A500',
  '반려동물': '#A3C4F3',
  '기타': '#AAB7B8',
  // 첫 실행 템플릿(src/data/starterTemplates.js)의 카테고리 — 이름에서 만든 색끼리 비슷하게 겹치지 않게 정해 둔다 (I-019)
  '교통': '#5C7CFA',
  '주거/통신': '#A1887F',
  '생활': '#9CCC65',
  '자기계발': '#FF8A65',
  '경조사/선물': '#F06292',
  '금융': '#607D8B',
  '용돈': '#7E57C2',
  '육아': '#F8BBD0',
};

const EMPTY_COLOR = '#AAB7B8';

function stringToHue(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}

export function categoryColor(category) {
  return categoryColorAlpha(category, 1);
}

/** 같은 색의 반투명 버전 (배지 배경 등). alpha: 0~1 */
export function categoryColorAlpha(category, alpha) {
  const hex = !category ? EMPTY_COLOR : DEFAULT_CATEGORY_COLORS[category];
  if (hex) {
    if (alpha >= 1) return hex;
    return hex + Math.round(alpha * 255).toString(16).padStart(2, '0');
  }
  const hue = stringToHue(category);
  return alpha >= 1 ? `hsl(${hue}, 55%, 52%)` : `hsla(${hue}, 55%, 52%, ${alpha})`;
}
