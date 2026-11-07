import { useState, useCallback } from 'react';

/**
 * 기기(브라우저)별로 기억되는 on/off 설정.
 * 가족이 함께 쓰는 DB가 아니라 localStorage에 저장한다 — 예) 폼의 '연속 입력'.
 * 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 기억만 못 할 뿐 정상 동작한다.
 */
export function useStoredToggle(key, defaultValue = false) {
  const [value, setValue] = useState(() => {
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? defaultValue : v === '1';
    } catch (e) {
      return defaultValue;
    }
  });

  const update = useCallback((next) => {
    setValue(next);
    try { window.localStorage.setItem(key, next ? '1' : '0'); } catch (e) { /* 기억 불가 — 무시 */ }
  }, [key]);

  return [value, update];
}
