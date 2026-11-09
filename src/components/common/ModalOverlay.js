import React, { useEffect, useRef } from 'react';

// 열려 있는 창 — 맨 위(마지막에 연) 창만 Esc로 닫는다(창 위에 창이 열려 있을 때 둘 다 닫히지 않게)
const openStack = [];

/**
 * 모달 오버레이 공통 처리.
 *
 * - 기본은 바깥을 눌러도 닫히지 않는다 — 입력하던 내용을 잃지 않도록.
 *   폼이 들어있는 팝업은 onDismiss를 넘기지 않는다.
 * - 읽기 전용 팝업(거래 세부, 날짜 바텀시트 등)만 onDismiss를 넘겨
 *   바깥 클릭으로 닫는다.
 * - 패널 안에서 누른 채 바깥에서 손을 뗀 드래그는 닫힘으로 보지 않는다.
 *   (텍스트를 드래그 선택하다 팝업이 닫히는 문제 방지)
 * - Esc(키보드)는 바깥을 누른 것과 같다 — onDismiss가 있는 창만, 맨 위 창 하나만 닫는다 (ROADMAP U-10).
 *   Esc를 먼저 쓴 쪽이 preventDefault를 부르면 창은 그대로 둔다(가리기 화면 U-7). 지금 Esc로 고치기를 취소하는 입력 칸은
 *   이렇게 닫히는 창 안에 없다 — 그런 칸을 닫히는 창에 넣으면 그 칸의 Esc 처리에서 preventDefault를 부른다.
 */
export default function ModalOverlay({ className, panelClassName, onDismiss, children }) {
  const pressedBackdrop = useRef(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const token = {};
    openStack.push(token);
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (openStack[openStack.length - 1] !== token || !dismissRef.current) return;
      e.preventDefault();
      dismissRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = openStack.indexOf(token);
      if (i >= 0) openStack.splice(i, 1);
    };
  }, []);

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
