import React from 'react';
import { isValidDateStr } from '../../services/dateUtils';
import './AIEntry.css';

/**
 * 한 건 화면에서 바로 넣을 수 없는 이유 — 없으면 '' (I-066).
 * 결제수단·카테고리는 그 화면에서 고를 수 있고, 금액·날짜는 입력 창('이대로 채우기')이나 덧붙여 말하기로 채운다
 */
export function directAddProblem(s) {
  if (!s) return '넣을 내용이 없어요';
  if (s.amount === null || s.amount === undefined) return "금액을 몰라 바로 넣을 수 없어요 — '이대로 채우기'로 입력 창에서 채워 주세요";
  if (!(Number(s.amount) > 0)) return "금액을 확인해 주세요 — '이대로 채우기'로 입력 창에서 고칠 수 있어요";
  if (!isValidDateStr(s.date)) return "날짜를 몰라 바로 넣을 수 없어요 — '이대로 채우기'로 입력 창에서 골라 주세요";
  const noPayment = !s.payment_method;
  const noCategory = !(s.budget_category && s.sub_category);
  // 카테고리만 정해지고 세부카테고리가 빈 것(여행 기본 카테고리 등)은 고르기 칸에 카테고리가 보이므로 세부카테고리라고 쓴다
  const categoryWord = s.budget_category ? '세부카테고리' : '카테고리';
  if (noPayment && noCategory) return `결제수단·${categoryWord}를 고르면 바로 넣을 수 있어요`;
  if (noPayment) return '결제수단을 고르면 바로 넣을 수 있어요';
  if (noCategory) return `${categoryWord}를 고르면 바로 넣을 수 있어요`;
  return '';
}

/**
 * 한 건 화면의 버튼 줄 (I-066) — 앞 버튼(children: 취소·다시 쓰기 등) 뒤에 '이대로 채우기'(입력 창을 열어 채움)와
 * '이대로 넣기'(입력 창 없이 바로 가계부에 넣음 — 한 줄을 다 쓰는 기본 버튼)를 둔다.
 *  - 바로 넣을 수 없으면(금액·날짜를 모름, 결제수단·카테고리가 빔) '이대로 넣기'를 막고 이유를 보인다
 *  - held: 이미 넣은 거래와 겹칠 수 있는 건 — 기본 버튼 대신 '그래도 넣기'로(습관처럼 눌러 또 넣지 않게)
 *  - onAdd가 없으면(바로 넣을 곳이 없음) 전처럼 '이대로 채우기'만 기본 버튼으로
 * disabled: 덧붙여 쓰던 글이 있을 때 — 두 버튼 모두 막는다(쓴 글을 두고 넣거나 채우지 않게)
 */
export default function SingleActions({ s, disabled = false, held = false, onApply, onAdd, children }) {
  if (!onAdd) {
    return (
      <div className="rs-actions">
        {children}
        <button type="button" className="rs-btn-primary" disabled={disabled} onClick={() => onApply(s)}>이대로 채우기</button>
      </div>
    );
  }
  const problem = directAddProblem(s);
  return (
    <>
      {problem && <div className="rs-add-note">{problem}</div>}
      <div className="rs-actions rs-single-actions">
        {children}
        <button type="button" className="rs-btn-secondary" disabled={disabled} onClick={() => onApply(s)}>이대로 채우기</button>
        <button
          type="button"
          className={`${held ? 'rs-btn-secondary' : 'rs-btn-primary'} rs-add-btn`}
          disabled={disabled || !!problem}
          onClick={onAdd}
        >
          {held ? '그래도 넣기' : '이대로 넣기'}
        </button>
      </div>
    </>
  );
}
