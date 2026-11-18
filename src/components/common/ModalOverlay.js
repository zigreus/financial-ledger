import React, { useEffect, useRef } from 'react';

// 열려 있는 창 — 맨 위(마지막에 연) 창만 Esc로 닫는다(창 위에 창이 열려 있을 때 둘 다 닫히지 않게)
const openStack = [];

const REVEAL_MARGIN = 8;
const isTextField = (el) => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);

/**
 * 키보드가 열려 작아진 창 안에서 입력 칸이 창의 스크롤 영역 밖(아래)으로 밀렸으면 그 영역만 스크롤해 보이게 한다.
 * scrollIntoView를 쓰지 않는다 — 창이 올라오는 애니메이션 중에는 칸이 화면 아래에 있는 것으로 잡혀 브라우저가 화면 전체를 또 끌어올린다.
 * 같은 창 안에서 위치를 비교하므로 애니메이션(transform)과 상관없다. 위에 붙은 머리글(sticky)에 가리지 않게 그 높이를 뺀다.
 */
function revealInPanel(target, overlay) {
  let scroller = target.parentElement;
  while (scroller && scroller !== overlay) {
    const { overflowY } = window.getComputedStyle(scroller);
    if ((overflowY === 'auto' || overflowY === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break;
    scroller = scroller.parentElement;
  }
  if (!scroller || scroller === overlay) return;
  const box = scroller.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  const head = scroller.firstElementChild;
  const stickyHead = head && head !== target && !head.contains(target)
    && window.getComputedStyle(head).position === 'sticky' ? head.offsetHeight : 0;
  const top = box.top + stickyHead + REVEAL_MARGIN;
  const bottom = box.top + scroller.clientHeight - REVEAL_MARGIN;
  // 칸이 보이는 높이보다 크면 윗부분이 보이게(내리는 만큼을 칸의 윗부분이 위로 넘지 않을 만큼으로 줄인다)
  if (r.bottom > bottom) scroller.scrollTop += Math.min(r.bottom - bottom, Math.max(0, r.top - top));
  else if (r.top < top) scroller.scrollTop -= top - r.top;
}

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
 * - fitKeyboard: 휴대폰 키보드가 열리면 창을 키보드 위의 보이는 곳(visualViewport)에 맞춘다(B-100).
 *   휴대폰 브라우저는 키보드가 화면 아래를 덮어도 고정 위치 창의 크기를 줄이지 않고, 가려진 입력 칸을 보이려고
 *   화면 전체를 위로 끌어올린다 — 아래에 붙은 짧은 창(AI 창)이면 창 머리가 화면 밖으로 나가고 칸이 위 끝에 걸린다.
 *   보이는 곳에 맞추면 브라우저가 이미 끌어올렸어도 창은 보이는 곳 안에 있고(끌어올린 만큼 따라 내려온다),
 *   창이 작아져 칸이 밀리면 창 안에서만 스크롤한다.
 *   확대(두 손가락)해서 보이는 곳이 작아진 것은 맞추지 않는다. 금액 칸(AmountInput)은 자기 처리가 따로 있어
 *   입력 창(TransactionForm)에는 쓰지 않는다.
 */
export default function ModalOverlay({ className, panelClassName, onDismiss, fitKeyboard = false, children }) {
  const pressedBackdrop = useRef(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const overlayRef = useRef(null);

  useEffect(() => {
    const vv = fitKeyboard ? window.visualViewport : null;
    const overlay = overlayRef.current;
    if (!vv || !overlay) return undefined;
    let fitted = 0;   // 지금 맞춘 보이는 높이(0이면 맞추지 않음)
    const clear = () => {
      overlay.style.paddingTop = '';
      overlay.style.paddingBottom = '';
      fitted = 0;
    };
    const update = () => {
      // 판은 inset: 0 그대로 두어 뒤 화면을 늘 어둡게 덮고(키보드가 닫히거나 화면이 밀리는 한 프레임에도),
      // 보이는 곳 바깥(끌어올린 위·키보드 밑)을 안쪽 여백으로 비워 창을 보이는 곳에 둔다 — 창 높이(100%)도 그 안에 견준다.
      // 위치는 판 자신의 사각형(레이아웃 뷰포트 기준)에 견준다 — innerHeight는 브라우저마다 키보드에 따라 달라진다
      const zoomed = Math.abs((vv.scale || 1) - 1) > 0.01;
      const box = overlay.getBoundingClientRect();
      const above = zoomed ? 0 : Math.max(0, vv.offsetTop - box.top);
      const below = zoomed ? 0 : Math.max(0, box.bottom - (vv.offsetTop + vv.height));
      if (above < 0.5 && below < 1) {
        if (fitted) clear();
        return;
      }
      overlay.style.paddingTop = `${above}px`;
      overlay.style.paddingBottom = `${below}px`;
      const visible = box.height - above - below;
      const shrank = !fitted || visible < fitted - 0.5;
      fitted = visible;
      const active = document.activeElement;
      if (shrank && isTextField(active) && overlay.contains(active)) revealInPanel(active, overlay);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      clear();
    };
  }, [fitKeyboard]);

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
    <div
      ref={overlayRef}
      className={fitKeyboard ? [className, 'modal-fit-keyboard'].filter(Boolean).join(' ') : className}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
    >
      <div className={panelClassName}>{children}</div>
    </div>
  );
}
