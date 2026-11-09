import { useRef } from 'react';

/** 이만큼 가로로 밀어야 넘긴다(px) */
export const SWIPE_MIN_DX = 50;
/** 세로 이동이 가로의 이 비율을 넘으면 스크롤로 본다 */
export const SWIPE_MAX_SLOPE = 0.6;

/** 손가락을 댄 곳이 가로로 스크롤되는 칸 안인지 — 그 칸을 미는 것은 달 넘기기가 아니다(탭 줄·넓은 표 등) */
function insideSidewaysScroll(el, stop) {
  for (let node = el; node && node !== stop; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const { overflowX } = window.getComputedStyle(node);
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
  }
  return false;
}

/**
 * 가로로 밀어 넘기기 (캘린더 달력, 요약의 달 — ROADMAP U-9). 받는 요소에 돌려준 손 이벤트를 붙인다.
 *  - 왼쪽으로 밀면 onNext(다음·새 달), 오른쪽으로 밀면 onPrev(앞·지난 달)
 *  - 세로로 더 많이 움직였으면 스크롤로 보고, 입력 칸·가로로 스크롤되는 칸에서 시작한 것은 넘기지 않는다
 *  - 모달은 받는 요소 밖에 그리거나(캘린더는 격자에서만 받는다) enabled로 끈다 — 모달 안의 드래그가 뒤 화면을 넘기지 않게
 */
export function useHorizontalSwipe({ onNext, onPrev, enabled = true }) {
  const start = useRef(null);
  return {
    onTouchStart(e) {
      start.current = null;
      if (!enabled || e.touches.length !== 1) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '')) return;
      if (insideSidewaysScroll(e.target, e.currentTarget)) return;
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    },
    onTouchEnd(e) {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const dx = e.changedTouches[0].clientX - s.x;
      const dy = e.changedTouches[0].clientY - s.y;
      if (Math.abs(dx) < SWIPE_MIN_DX) return;
      if (Math.abs(dy) > Math.abs(dx) * SWIPE_MAX_SLOPE) return;
      if (dx < 0) onNext?.();
      else onPrev?.();
    },
    onTouchCancel() {
      start.current = null;
    },
  };
}
