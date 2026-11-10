import React from 'react';
import { OPTIONAL_FEATURES } from '../../services/optionalFeatures';

// 목록은 services/optionalFeatures.js에 있다(AI 명령도 쓴다, I-051). 새 선택 기능은 그 목록에 한 줄 더한다
export { OPTIONAL_FEATURES };

const BY_KEY = Object.fromEntries(OPTIONAL_FEATURES.map(f => [f.key, f]));

export function optionalFeature(key) {
  const f = BY_KEY[key];
  if (!f) throw new Error(`알 수 없는 선택 기능: ${key}`);
  return f;
}

/** 선택 기능을 원래 자리에서 보일 때의 앵커 id — 선택 기능 화면의 '설정하기'가 이곳으로 스크롤한다 */
export const featureAnchorId = key => `feature-${key}`;

/** 켜고 끄는 스위치 — 제목(title)은 '<이름> 켜기/끄기' */
export function FeatureSwitch({ label, on, onToggle }) {
  return (
    <button
      type="button"
      className={`goal-display-toggle${on ? ' goal-display-toggle--on' : ''}`}
      onClick={onToggle}
      title={on ? `${label} 끄기` : `${label} 켜기`}
      aria-pressed={on}
    >
      <span className="goal-display-toggle-knob" />
    </button>
  );
}

/** 각 기능의 원래 자리에 두는 머리 — 이름, "필요할 때만 켜세요" 설명, 스위치 */
export function OptionalFeatureHead({ featureKey, enabled, onToggle }) {
  const f = optionalFeature(featureKey);
  return (
    <div className="cb-settings-head" id={featureAnchorId(f.key)}>
      <div>
        <div style={{ fontSize: 'calc(14px * var(--fs))', fontWeight: '600' }}>{f.label}</div>
        <div style={{ fontSize: 'calc(11px * var(--fs))', color: 'var(--text-muted)' }}>필요할 때만 켜세요. {f.desc}</div>
      </div>
      <FeatureSwitch label={f.label} on={enabled} onToggle={onToggle} />
    </div>
  );
}
