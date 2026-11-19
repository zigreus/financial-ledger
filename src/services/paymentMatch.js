/**
 * 결제 짝짓기 공통 — 카드 대조와 사진 목록의 수정 권장(I-065)이 함께 쓴다.
 *  - 가게 이름 비교: 카드 가맹점명과 가계부 세부내역이 같은 곳을 가리키는지 (merchantInfo·merchantLevel)
 *  - 묶음: 여러 건의 합이 한 건과 같은 조합 (findCombination — 나눠 적음·합쳐 적음)
 */
import { normalizeName } from './receiptAssistant';

/** 묶음은 이 건수까지만 본다 (아무 금액이나 더해 맞추는 오탐 방지) */
export const GROUP_MAX = 4;

// 결제대행·간편결제 표기 — "네이버페이 OO몰"이면 실제 가게는 OO몰이다
const PAY_NAMES = '네이버페이|naverpay|npay|카카오페이|kakaopay|토스페이먼츠|tosspayments|토스페이|tosspay|페이코|payco'
  + '|스마일페이|smilepay|케이지이니시스|kg이니시스|이니시스|inicis|nhnkcp|나이스페이|nicepay|다날|danal|페이팔|paypal';
const PAY_PREFIX = new RegExp(`^(${PAY_NAMES})`);
const PAY_ONLY = new RegExp(`^(${PAY_NAMES})$`);
const LEGAL = /\(주\)|㈜|주식회사|\(유\)|유한회사/g;
const REFUND_WORDS = /부분\s*취소|취소|환불|반품|환급/g;
const NAME_SPLIT = /[^0-9A-Za-z가-힣ぁ-んァ-ン一-龥]+/;

/**
 * 가게 이름 비교 재료 — 한 번만 만들어 둔다 (행·거래마다 다시 계산하지 않게).
 *   raw : 법인 표기·www·도메인 끝을 뺀 이름        "(주)이마트 성수점" → "이마트성수점"
 *   key : raw에서 앞의 결제대행 표기까지 뺀 이름    "네이버페이 무신사" → "무신사"
 *   head: 첫 단어 (결제대행 단어는 건너뜀)          "이마트 장보기" → "이마트"
 */
export function merchantInfo(name) {
  const cleaned = String(name || '')
    .replace(LEGAL, ' ')
    .replace(REFUND_WORDS, ' ')   // "다이소 환불"·"쿠팡 반품"도 그 가게 이름으로 본다
    .replace(/(https?:\/\/)?www\d?\./gi, ' ')
    .replace(/\.(co\.kr|or\.kr|com|net|org|kr)\b/gi, ' ');
  const raw = normalizeName(cleaned);
  const rest = raw.replace(PAY_PREFIX, '');
  const words = cleaned.split(NAME_SPLIT).map(normalizeName).filter(Boolean);
  while (words.length > 1 && PAY_ONLY.test(words[0])) words.shift();
  const first = words[0] || '';
  const firstRest = first.replace(PAY_PREFIX, '');
  return { raw, key: rest.length >= 2 ? rest : raw, head: firstRest.length >= 2 ? firstRest : first };
}

function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return i;
}

// 가게 이름이 아닌 흔한 첫 단어 — 두 글자 첫 단어가 같아도 같은 가게로 보지 않는다 ("점심 김밥" ↔ "점심 국수")
export const GENERIC_HEADS = new Set([
  '점심', '저녁', '아침', '간식', '야식', '커피', '택시', '주유', '장보기', '식비', '외식', '배달', '회식', '마트', '카페',
  '쇼핑', '선물', '병원', '약국', '버스', '교통', '생활', '기타', '송금', '결제', '충전', '환불', '취소', '할인', '적립',
  '이체', '입금', '출금', '구독', '월세', '보험', '통신', '용돈', '반찬', '과일', '주차', '세탁', '미용', '학원', '식당',
]);

export const SAME = 2;     // 같은 가게 — 금액이 달라도 "카드 금액으로 수정"을 권할 수 있다
export const SIMILAR = 1;  // 아마 같은 가게 — 금액이 정확히 맞을 때(1:1·묶음 합계)만 근거로 쓴다

/**
 * 카드 가맹점명과 가계부 세부내역이 같은 곳을 가리키는지.
 *   SAME   : 한쪽이 다른 쪽을 포함 ("스타벅스 강남점" ⊃ "스타벅스"),
 *            또는 한쪽 첫 단어(3글자 이상)로 다른 쪽이 시작 ("이마트 장보기" ↔ "(주)이마트 성수점")
 *   SIMILAR: 앞 3글자 이상이 같음 ("이마트성수점" ↔ "이마트장보기"),
 *            또는 두 글자 첫 단어가 같음 ("본죽 점심" ↔ "본죽 성수점", "CU 간식" ↔ "CU 성수역점") — 일반어("점심 김밥")는 빼고
 * 가운데·뒤만 같은 건 다른 가게다 — 현대백화점/롯데백화점, 밝은치과의원/서울치과의원,
 * 앞 2글자만 같은 것도 — 스타벅스/스타필드, 롯데마트/롯데리아.
 * (예전 입력 습관 matchHistory로 맞추던 별칭은 같은 "포함" 규칙이라 SAME에 이미 들어 있다)
 */
export function merchantLevel(a, b) {
  if (a.raw.length < 2 || b.raw.length < 2) return 0;
  if (a.raw.includes(b.raw) || b.raw.includes(a.raw) || a.key.includes(b.key) || b.key.includes(a.key)) return SAME;
  if ((a.head.length >= 3 && b.key.startsWith(a.head)) || (b.head.length >= 3 && a.key.startsWith(b.head))) return SAME;
  if (a.head.length === 2 && a.head === b.head && !GENERIC_HEADS.has(a.head)) return SIMILAR;
  return commonPrefixLength(a.key, b.key) >= 3 ? SIMILAR : 0;
}

/**
 * items 중 2~GROUP_MAX개를 골라 value 합이 target인 조합 (건수가 적은 것 먼저).
 * 후보는 같은 가게·가까운 날짜로 이미 걸러져 있어 몇 개 안 된다.
 */
export function findCombination(items, value, target) {
  const pool = items.slice(0, 10);
  for (let size = 2; size <= Math.min(GROUP_MAX, pool.length); size += 1) {
    const pick = [];
    const search = (start, sum) => {
      if (pick.length === size) return sum === target;
      for (let i = start; i < pool.length; i += 1) {
        pick.push(pool[i]);
        if (search(i + 1, sum + value(pool[i]))) return true;
        pick.pop();
      }
      return false;
    };
    if (search(0, 0)) return [...pick];
  }
  return null;
}
