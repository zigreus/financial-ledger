import React, { useRef } from 'react';

/**
 * 모달 오버레이 공통 처리.
 *
 * - 기본은 바깥을 눌러도 닫히지 않는다 — 입력하던 내용을 잃지 않도록.
 *   폼이 들어있는 팝업은 onDismiss를 넘기지 않는다.
 * - 읽기 전용 팝업(거래 세부, 날짜 바텀시트 등)만 onDismiss를 넘겨
 *   바깥 클릭으로 닫는다.
 * - 패널 안에서 누른 채 바깥에서 손을 뗀 드래그는 닫힘으로 보지 않는다.
 *   (텍스트를 드래그 선택하다 팝업이 닫히는 문제 방지)
 */
export default function ModalOverlay({ className, panelClassName, onDismiss, children }) {
  const pressedBackdrop = useRef(false);

  const handlePointerDown = (e) => {
    pressedBackdrop.current = e.target === e.currentTarget;
  };

  const handleClick = (e) => {
    if (!onDismiss) return;
    if (e.target !== e.currentTarget) return;
    if (!pressedBackdrop.current) return;
    pressedBackdrop.current = false;
    onDismiss();
  };

  return (
    <div className={className} onPointerDown={handlePointerDown} onClick={handleClick}>
      <div className={panelClassName}>{children}</div>
    </div>
  );
}
