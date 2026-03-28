# JSON 가져오기 가이드

## JSON 포멧 스펙

```json
[
  {
    "payment_method": "결제수단명",
    "date": "YYYY-MM-DD",
    "budget_category": "카테고리",
    "sub_category": "세부카테고리",
    "detail": "세부내역",
    "amount": 숫자,
    "discount_amount": 숫자,
    "discount_note": "할인/수익 설명"
  }
]
```

## 필드 설명

| 필드 | 필수 | 설명 | 예시 |
|---|---|---|---|
| `payment_method` | ✓ | 결제수단 (카드명 또는 현금) | `"삼성카드"`, `"현금"`, `"하나카드"` |
| `date` | ✓ | 이용일 (YYYY-MM-DD 형식) | `"2023-03-21"` |
| `budget_category` | ✓ | 예산 카테고리 | `"식비"`, `"쇼핑"`, `"차량교통비"` |
| `sub_category` | | 세부 카테고리 | `"편의점"`, `"마트"`, `"주유"` |
| `detail` | | 세부 내역 설명 | `"GS편의점"` |
| `amount` | ✓ | 거래액 (숫자, 원화 제외) | `850`, `1500` |
| `discount_amount` | | 할인액 또는 수익액 (0 이상) | `0`, `100`, `500` |
| `discount_note` | | 할인/수익 설명 | `"카드사 할인"`, `"캐시백"` |

## 샘플 JSON (2행)

```json
[
  {
    "payment_method": "삼성카드",
    "date": "2023-03-21",
    "budget_category": "차량교통비",
    "sub_category": "대충교통",
    "detail": "",
    "amount": 800,
    "discount_amount": 0,
    "discount_note": ""
  },
  {
    "payment_method": "삼성카드",
    "date": "2023-04-28",
    "budget_category": "식비",
    "sub_category": "편의점",
    "detail": "편의점",
    "amount": 850,
    "discount_amount": 0,
    "discount_note": ""
  }
]
```

## 사용 방법

1. 엑셀 데이터를 JSON 형식으로 변환 (예: Python, Excel to JSON 도구 등)
2. 앱의 **"📥 가져오기"** 탭 클릭
3. JSON 파일 선택
4. 미리보기 확인 후 **"N건 가져오기"** 클릭
5. 완료!

## 검증 규칙

- `payment_method`, `date`, `budget_category`, `amount`는 **필수**
- `amount`는 0보다 커야 함
- `date`는 `YYYY-MM-DD` 형식 (예: 2023-03-21)
- 필드가 없으면 기본값 사용:
  - `sub_category`, `detail`: 빈 문자열
  - `discount_amount`, `discount_note`: 0 또는 빈 문자열

## 알려진 카테고리

앱의 기본 카테고리:
- 식비, 쇼핑, 차량교통비, 의류/미용, 의료/건강, 교육, 여행/문화, 반려동물, 기타

알려진 결제수단:
- 신한카드, 현대카드, 삼성카드, KB국민카드, 롯데카드, 카카오페이, 네이버페이, 토스페이, 현금

(설정에서 추가 가능)
