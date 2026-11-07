import { useMemo } from 'react';

/**
 * sql.js DB 객체는 쓰기를 해도 같은 참조라서, [db]만 의존하는 useMemo는 다시 계산되지 않는다.
 * App이 쓰기마다 올려 주는 dataVersion과 묶어 "바뀔 때마다 새 참조"를 만든다.
 *
 *   const live = useDbSnapshot(db, dataVersion);
 *   const items = useMemo(() => getItems(live.db), [live]);
 */
export function useDbSnapshot(db, dataVersion) {
  return useMemo(() => ({ db, dataVersion }), [db, dataVersion]);
}
