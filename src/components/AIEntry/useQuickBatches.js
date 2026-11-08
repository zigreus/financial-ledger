import { useState, useRef, useEffect, useCallback } from 'react';

let nextId = 0;

/**
 * AI 입력이 바로 넣은 묶음들 (I-022) — 어디서 되돌리든(화면 위 알림·확인 화면의 버튼) 알게 한다.
 *  - add(suggestions, handle): handle은 App handleQuickAdd가 돌려준 { undo, onUndone } (없을 수 있음)
 *  - onBatchUndone({ id, suggestions, removed }): 되돌려졌을 때. removed가 suggestions 수와 같으면 모두 지운 것
 *  - undoAll(): 아직 되돌리지 않은 묶음을 모두 되돌린다
 *  - reset(): 지켜보기를 그만두고 비운다 (입력 창을 닫거나 다음 거래로 넘어갈 때)
 * batches: [{ id, suggestions, handle, removed }] — removed는 아직 되돌리지 않았으면 null
 */
export function useQuickBatches(onBatchUndone) {
  const [batches, setBatches] = useState([]);
  const callbackRef = useRef(onBatchUndone);
  callbackRef.current = onBatchUndone;
  const offsRef = useRef([]);

  const add = useCallback((suggestions, handle) => {
    nextId += 1;
    const id = nextId;
    setBatches(list => [...list, { id, suggestions, handle: handle || null, removed: null }]);
    if (handle && handle.onUndone) {
      offsRef.current.push(handle.onUndone((removed) => {
        setBatches(list => list.map(b => (b.id === id ? { ...b, removed } : b)));
        if (callbackRef.current) callbackRef.current({ id, suggestions, removed });
      }));
    }
  }, []);

  const stopWatching = useCallback(() => {
    offsRef.current.forEach(off => off());
    offsRef.current = [];
  }, []);

  const reset = useCallback(() => {
    stopWatching();
    setBatches([]);
  }, [stopWatching]);

  useEffect(() => stopWatching, [stopWatching]);

  const undoAll = () => {
    batches.forEach(b => { if (b.removed === null && b.handle) b.handle.undo(); });
  };

  return { batches, add, undoAll, reset };
}

/** 모두 되돌린 묶음인지 */
export const fullyUndone = b => b.removed !== null && b.removed === b.suggestions.length;
