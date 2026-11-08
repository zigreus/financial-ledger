/**
 * AI가 읽는 동안 화면이 저절로 꺼지지 않게 한다 (I-023, Screen Wake Lock).
 * 지원하지 않는 브라우저에서는 아무것도 하지 않는다. 사용자가 직접 화면을 끄거나 다른 앱으로 가는 것은 막지 못한다
 * — 그때는 aiClient가 돌아온 뒤 끊긴 요청을 다시 보낸다.
 * 화면이 가려지면 브라우저가 잠금을 풀므로, 아직 필요할 때 화면이 다시 보이면 다시 건다.
 */

let holders = 0;
let sentinel = null;
let requesting = false;

const supported = () => typeof navigator !== 'undefined' && !!navigator.wakeLock
  && typeof document !== 'undefined' && !!document.addEventListener;

async function acquire() {
  if (sentinel || requesting || holders === 0 || document.visibilityState !== 'visible') return;
  requesting = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (holders === 0) {                 // 기다리는 사이 다 끝났다
      lock.release().catch(() => {});
      return;
    }
    sentinel = lock;
    lock.addEventListener?.('release', () => { if (sentinel === lock) sentinel = null; });
  } catch (e) {
    // 배터리 절약 모드·권한 정책 등으로 거절될 수 있다 — 화면 꺼짐 방지만 못 할 뿐 분석은 그대로
  } finally {
    requesting = false;
  }
}

function onVisibility() {
  if (holders > 0 && document.visibilityState === 'visible') acquire();
}

/** 화면을 켜 둔다 — 반환한 함수를 부르면 놓는다(여러 번 불러도 한 번만). 여럿이 동시에 잡아도 된다 */
export function keepScreenOn() {
  if (!supported()) return () => {};
  holders += 1;
  if (holders === 1) document.addEventListener('visibilitychange', onVisibility);
  acquire();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders > 0) return;
    document.removeEventListener('visibilitychange', onVisibility);
    const lock = sentinel;
    sentinel = null;
    if (lock) lock.release().catch(() => {});
  };
}
