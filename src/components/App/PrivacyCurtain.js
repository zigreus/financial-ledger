import React, { useEffect, useRef } from 'react';
import './PrivacyCurtain.css';

/**
 * 가계부를 열 때 가리기 (ROADMAP U-7) — 이 기기 설정을 켜면, 앱을 열 때와 다른 앱으로 갈 때(App이 바로 덮는다)
 * 화면 전체를 흐리게 덮는다. 누르면(또는 Enter·Space) 보인다. 남 앞에서 앱을 열어도 금액·잔액이 바로 보이지 않게.
 *  - 덮는 동안 뒤의 화면은 inert — Tab·화면 낭독기가 뒤의 금액에 닿지 않고, Esc가 뒤의 창을 닫지 않는다.
 *    덮은 뒤에 생긴 것(알림·창)도 inert로 하고, 뒤로 간 초점(자동 초점 등)은 가리개로 되돌린다
 *  - 걷으면 덮기 전에 쓰던 칸으로 초점을 돌려준다(입력하다 잠깐 다른 앱에 다녀온 경우 — 키보드가 다시 올라오게)
 *  - (갤럭시 S26 울트라의 프라이버시 디스플레이는 앱이 켤 수 없어 설정 화면에서 휴대폰 설정 방법을 안내한다)
 */
export default function PrivacyCurtain({ onReveal }) {
  const ref = useRef(null);

  useEffect(() => {
    const curtain = ref.current;
    const parent = curtain?.parentElement;
    if (!parent) return undefined;
    const before = document.activeElement;
    // 이미 inert였던 것은 걷을 때 그대로 둔다
    const made = new Set();
    const cover = (el) => {
      if (el === curtain || el.nodeType !== 1 || el.hasAttribute('inert')) return;
      el.setAttribute('inert', '');
      made.add(el);
    };
    [...parent.children].forEach(cover);
    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(cover)))
      : null;
    observer?.observe(parent, { childList: true });
    curtain.focus();
    // 뒤에서 초점을 가져가면(자동 초점 입력 칸 등) 가리개로 되돌린다
    const onFocusIn = (e) => { if (e.target !== curtain && !curtain.contains(e.target)) curtain.focus(); };
    // 뒤의 창(ModalOverlay)이 Esc로 닫히지 않게 — 그 창은 preventDefault된 Esc를 건너뛴다
    const onKey = (e) => { if (e.key === 'Escape') e.preventDefault(); };
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      observer?.disconnect();
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('keydown', onKey, true);
      made.forEach(el => el.removeAttribute('inert'));
      if (before && before !== document.body && before.isConnected && typeof before.focus === 'function') {
        try { before.focus({ preventScroll: true }); } catch { /* 초점을 받을 수 없게 됐으면 그대로 */ }
      }
    };
  }, []);

  return (
    <button type="button" className="privacy-curtain" onClick={onReveal} aria-label="가린 화면 보기" ref={ref}>
      <span className="privacy-curtain-box">
        <span className="privacy-curtain-icon" aria-hidden="true">🔒</span>
        <span className="privacy-curtain-title">화면을 가려 두었어요</span>
        <span className="privacy-curtain-hint">눌러서 보기</span>
      </span>
    </button>
  );
}
