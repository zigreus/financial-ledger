import React, { useState } from 'react';
import {
  FONT_SCALES, THEMES, getFontScale, getTheme, setFontScale, setTheme,
} from '../../../services/displayPrefs';

/** 고르는 버튼 묶음 — 하나만 고른다(라디오) */
function Choices({ id, label, options, value, onChange }) {
  return (
    <div className="disp-row">
      <span className="disp-label" id={`disp-${id}`}>{label}</span>
      <div className="disp-options" role="radiogroup" aria-labelledby={`disp-${id}`}>
        {options.map(o => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={value === o.key}
            className={value === o.key ? 'disp-option disp-option--on' : 'disp-option'}
            onClick={() => onChange(o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 설정 › 앱 › 이 기기 화면 (ROADMAP U-1 글씨 크기, U-2 화면 테마) — 이 기기에서만 바뀐다(services/displayPrefs).
 * 고르는 즉시 화면 전체에 적용된다.
 */
export default function DisplaySettings() {
  const [font, setFont] = useState(getFontScale);
  const [theme, setThemeKey] = useState(getTheme);
  return (
    <div className="about-block">
      <div className="about-title">이 기기 화면</div>
      <p className="about-desc">이 기기에서만 바뀌어요. 가족의 다른 기기는 각자 정해요.</p>
      <Choices id="font" label="글씨 크기" options={FONT_SCALES} value={font} onChange={(k) => { setFontScale(k); setFont(k); }} />
      <p className="disp-preview" aria-hidden="true">미리 보기 · 어제 점심 김치찌개 9,000원</p>
      <Choices id="theme" label="화면 테마" options={THEMES} value={theme} onChange={(k) => { setTheme(k); setThemeKey(k); }} />
      <p className="about-desc">&apos;기기 설정 따라&apos;는 휴대폰의 다크 모드를 켜고 끌 때 함께 바뀌어요.</p>
    </div>
  );
}
