import React from 'react';

/**
 * AI 입력이 바로 넣은 건 안내와 되돌리기 버튼 (I-022) — 확인 화면 안에 두어, 화면 위 알림이 사라진 뒤에도 되돌릴 수 있다.
 * batches: useQuickBatches의 묶음들 — 어디서 되돌렸든(알림·이 버튼) 그 결과를 보여 준다. onUndo: 남은 것을 모두 되돌린다
 */
export default function QuickAutoNote({ batches, onUndo }) {
  if (!batches || !batches.length) return null;
  const active = batches.filter(b => b.removed === null);
  const activeCount = active.reduce((n, b) => n + b.suggestions.length, 0);
  if (activeCount > 0) {
    return (
      <span className="quick-auto-note">
        자주 넣던 {activeCount}건은 바로 추가했어요
        {active.some(b => b.handle) && (
          <button type="button" className="rs-btn-link quick-undo" onClick={onUndo}>되돌리기</button>
        )}
      </span>
    );
  }
  const total = batches.reduce((n, b) => n + b.suggestions.length, 0);
  const removed = batches.reduce((n, b) => n + (b.removed || 0), 0);
  return (
    <span className="quick-auto-note">
      {removed === total
        ? `바로 넣었던 ${total}건을 되돌렸어요 — 목록에서 고쳐 넣을 수 있어요`
        : `${removed}건만 되돌렸어요 — 나머지는 그사이 고쳐졌거나 지워졌어요`}
    </span>
  );
}
