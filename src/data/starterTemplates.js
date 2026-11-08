/**
 * 첫 실행 템플릿 (ROADMAP F-3, I-019) — 새 가계부에 넣을 가구 유형별 기본 카테고리·세부카테고리·결제수단.
 *
 *  - 사용자가 첫 실행 안내에서 고르고 다듬은 뒤 확정할 때만 applyStarterSetup으로 한 번에 넣는다(이미 쓰던 가계부에는 넣지 않음).
 *  - 거래 입력 폼은 세부카테고리를 꼭 고르게 하므로, 모든 카테고리에 세부카테고리를 하나 이상 둔다.
 *  - '현금'은 앱이 이름으로 알아보는 결제수단이다(여행 현금 지갑, 할인 대신 '수익' 표시) — 이름을 바꾸지 않는다.
 *  - 카테고리 이름은 기본 색이 정해진 이름(common/categoryColor의 DEFAULT_CATEGORY_COLORS)을 되도록 그대로 쓴다.
 */

const cat = (name, subs) => ({ name, subs });

const FOOD = cat('식비', ['장보기', '외식', '배달', '카페·간식']);
const HOME = cat('주거/통신', ['월세·관리비', '전기·가스·수도', '휴대폰', '인터넷·TV']);
const LIVING = cat('생활', ['생활용품', '가전·가구', '세탁·수선']);
const TRANSPORT = cat('교통', ['대중교통', '택시', '주유', '주차·통행료']);
const TRANSPORT_CAR = cat('교통', ['대중교통', '택시', '주유', '주차·통행료', '자동차 정비']);
const SHOPPING = cat('쇼핑', ['온라인쇼핑', '전자기기', '취미용품']);
const BEAUTY = cat('의류/미용', ['옷·신발', '미용실', '화장품']);
const HEALTH = cat('의료/건강', ['병원', '약국', '운동']);
const CULTURE = cat('여행/문화', ['여행', '영화·공연', '도서', '구독 서비스']);
const SELF = cat('자기계발', ['강의·자격증', '도서']);
const CULTURE_SINGLE = cat('여행/문화', ['여행', '영화·공연', '취미', '구독 서비스']);
const EVENTS = cat('경조사/선물', ['경조사비', '선물']);
const EVENTS_FAMILY = cat('경조사/선물', ['경조사비', '선물', '부모님 용돈']);
const FINANCE = cat('금융', ['보험', '세금', '이자·수수료']);
const ETC = cat('기타', ['기타']);

const PAYMENT_METHODS = ['신용카드', '체크카드', '현금', '계좌이체'];

export const STARTER_TEMPLATES = [
  {
    id: 'single',
    label: '1인 가구',
    icon: '🧑',
    description: '혼자 사는 살림 — 식비·주거·교통 위주에 자기계발을 더했어요',
    categories: [FOOD, HOME, LIVING, TRANSPORT, SHOPPING, BEAUTY, HEALTH, CULTURE_SINGLE, SELF, EVENTS, FINANCE, ETC],
    paymentMethods: PAYMENT_METHODS,
  },
  {
    id: 'dual',
    label: '맞벌이',
    icon: '👫',
    description: '둘이 버는 집 — 각자 용돈과 부모님 용돈, 자동차를 더했어요',
    categories: [
      FOOD, HOME, LIVING, TRANSPORT_CAR, SHOPPING, BEAUTY, HEALTH, CULTURE,
      cat('용돈', ['내 용돈', '배우자 용돈']), EVENTS_FAMILY, FINANCE, ETC,
    ],
    paymentMethods: PAYMENT_METHODS,
  },
  {
    id: 'kids',
    label: '아이 있는 집',
    icon: '👨‍👩‍👧',
    description: '아이를 키우는 집 — 육아·교육과 아이 용돈을 더했어요',
    categories: [
      FOOD, HOME, LIVING,
      cat('육아', ['기저귀·분유', '아이 옷', '장난감·책', '아이 병원']),
      cat('교육', ['어린이집·유치원', '학원', '교재·준비물']),
      TRANSPORT_CAR, SHOPPING, BEAUTY, HEALTH, CULTURE,
      cat('용돈', ['부모 용돈', '아이 용돈']), EVENTS_FAMILY, FINANCE, ETC,
    ],
    paymentMethods: PAYMENT_METHODS,
  },
];
