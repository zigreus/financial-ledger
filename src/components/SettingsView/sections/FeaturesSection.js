import React, { useMemo } from 'react';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import { OPTIONAL_FEATURES, FeatureSwitch } from '../optionalFeatures';

/**
 * 설정 › 선택 기능 (I-032, ROADMAP Q-2) — 모든 선택 기능을 한 화면에서 켜고 끈다.
 * 켜 둔 기능에 세부 설정이 있으면 그 자리로 가는 버튼을 보인다(onOpenPlace(feature)).
 * 스위치는 각 기능의 원래 자리(OptionalFeatureHead)와 같은 값을 바꾼다 — 가족 공통(가계부 DB).
 */
export default function FeaturesSection({ db, dataVersion, onChanged, onOpenPlace }) {
  const live = useDbSnapshot(db, dataVersion);
  const states = useMemo(() => OPTIONAL_FEATURES.map(f => ({ f, on: f.isOn(live.db) })), [live]);
  const onCount = states.filter(s => s.on).length;

  const toggle = (f, on) => {
    f.setOn(db, !on);
    onChanged();
  };

  return (
    <div className="features-section">
      <div className="features-intro">
        모든 가족이 쓰지는 않는 기능이에요. 필요한 것만 켜세요 — 켜고 끄는 것은 가계부에 저장돼 가족 모두에게 같이 적용되고,
        꺼도 정해 둔 값은 남아 다시 켜면 그대로예요.
        <span className="features-count">{onCount > 0 ? ` 지금 ${onCount}개 켜 둠` : ' 지금 켜 둔 기능 없음'}</span>
      </div>
      <ul className="features-list">
        {states.map(({ f, on }) => (
          <li key={f.key} className={`features-row${on ? ' features-row--on' : ''}`}>
            <div className="features-main">
              <div className="features-text">
                <div className="features-label">{f.label}</div>
                <div className="features-desc">{f.desc}</div>
              </div>
              <FeatureSwitch label={f.label} on={on} onToggle={() => toggle(f, on)} />
            </div>
            {on && f.place && (
              <button type="button" className="features-place" onClick={() => onOpenPlace(f)}>
                {f.place.what} — {f.place.label} ›
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
