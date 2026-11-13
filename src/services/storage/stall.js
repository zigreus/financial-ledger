/**
 * 멈춘 요청 끊기 (B-094) — 휴대폰 통신(LTE)이 잠깐 끊기면 fetch가 실패도 성공도 하지 않은 채 멈출 수 있다.
 * 그러면 가계부 받기·저장이 영영 끝나지 않아, 동기화가 '받는 중'에 묶여 다시 시도도 못 하고 '오프라인'에 머문다.
 *
 * 걸린 시간이 아니라 '멈춤'으로 끊는다 — 느려도 응답·내용이 조금씩 오고 있으면 기다리고(약한 LTE에서 1분이 걸려도),
 * 아무것도 오지 않는 채 STALL_MS가 지나면 끊고 StalledError(= OfflineError)로 돌려준다. 동기화는 연결 없음과 똑같이
 * 이 기기의 사본으로 이어 가고 곧 새로 다시 시도한다. 저장이 멈춰 끊기면 '올라갔는지 모르는 저장'이다(provider.js 계약).
 *
 * 쓰는 법: const signal = stallSignal(); fetch(url, { signal }) → poke(signal)(응답이 올 때마다) → readBody(res, signal)
 * 저장소 함수 사이에 signal만 넘기면 된다 — 멈춤 시계는 signal에 붙어 있다(pokers).
 */
import { OfflineError } from './provider';

/** 이만큼 아무것도 오지 않으면 멈춘 것으로 본다 */
export const STALL_MS = 25000;
/** 올리기는 진행을 볼 수 없다 — 느린 LTE(초당 16KB)로도 다 올릴 시간을 더 준다 */
const SLOW_UPLOAD_BYTES_PER_SEC = 16 * 1024;
export const uploadStallMs = (bytes, base = STALL_MS) => base + Math.ceil(((bytes?.length || 0) / SLOW_UPLOAD_BYTES_PER_SEC) * 1000);

export class StalledError extends OfflineError {
  constructor(what = '저장소 응답') {
    super(`${what}이(가) 멈춰 끊었습니다 — 곧 다시 시도합니다`);
    this.name = 'StalledError';
    this.what = what;
  }
}

const pokers = new WeakMap(); // signal → { poke, stop }

/**
 * 멈춤 시계가 붙은 signal. ms 동안 poke가 없으면 StalledError로 끊긴다(signal.reason).
 * 일을 마치면 stopStall(signal)로 시계를 멈춘다(안 해도 끊길 뿐 해는 없다 — 끝난 요청은 끊을 것이 없다).
 */
export function stallSignal(what, ms = STALL_MS) {
  const ctrl = new AbortController();
  let timer = null;
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  const poke = (next = ms) => {
    stop();
    if (!ctrl.signal.aborted) timer = setTimeout(() => ctrl.abort(new StalledError(what)), next);
  };
  poke();
  pokers.set(ctrl.signal, { poke, stop });
  return ctrl.signal;
}

/** 무언가 왔다 — 시계를 처음부터. nextMs: 다음 단계(올리기)에 더 줄 시간 */
export function poke(signal, nextMs) {
  pokers.get(signal)?.poke(nextMs);
}

export function stopStall(signal) {
  pokers.get(signal)?.stop();
}

/** 끊긴 이유가 멈춤이면 그 오류, 아니면 null */
export function stalledReason(signal) {
  return signal?.aborted && signal.reason instanceof StalledError ? signal.reason : null;
}

/**
 * 응답 내용을 다 받는다 — 조각이 올 때마다 시계를 처음부터(느려도 오고 있으면 기다린다).
 * 멈춰 끊기면 StalledError.
 */
export async function readBody(res, signal) {
  try {
    if (!res.body || typeof res.body.getReader !== 'function') {
      return new Uint8Array(await res.arrayBuffer());
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      poke(signal);
    }
    const out = new Uint8Array(total);
    let at = 0;
    chunks.forEach((c) => { out.set(c, at); at += c.length; });
    return out;
  } catch (e) {
    const stalled = stalledReason(signal);
    if (stalled) throw stalled;
    if (e instanceof OfflineError) throw e;
    throw new OfflineError(); // 받는 도중 끊겼다
  }
}

/**
 * 끝나지 않을 수 있는 일(로그인 토큰 받기처럼 signal을 받지 않는 것)을 signal의 멈춤 시계로 끊는다.
 * 끊기면 StalledError — 원래 일은 뒤에서 끝나도 결과를 쓰지 않는다.
 */
export function untilStalled(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(stalledReason(signal) || new OfflineError());
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(stalledReason(signal) || new OfflineError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}
