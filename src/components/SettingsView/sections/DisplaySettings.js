import React, { useState } from 'react';
import {
  FONT_SCALES, THEMES, START_TABS, getFontScale, getTheme, getHideOnOpen, getStartTab, isAndroid,
  setFontScale, setTheme, setHideOnOpen, setStartTab,
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
 * 설정 › 앱 › 이 기기 화면 — 이 기기에서만 바뀐다(services/displayPrefs).
 *  - 글씨 크기(U-1)·화면 테마(U-2): 고르는 즉시 화면 전체에 적용
 *  - 처음 여는 화면(U-8): 다음에 열 때부터('확인할 것'이 있으면 거래내역이 먼저)
 *  - 가계부를 열 때 가리기(U-7): 다음에 열 때부터. 안드로이드면 갤럭시 프라이버시 디스플레이 설정 방법을 함께 안내한다
 *    (앱이 휴대폰의 프라이버시 디스플레이를 직접 켤 수는 없다 — 휴대폰 설정에서 이 앱을 골라야 한다)
 */
export default function DisplaySettings() {
  const [font, setFont] = useState(getFontScale);
  const [theme, setThemeKey] = useState(getTheme);
  const [start, setStart] = useState(getStartTab);
  const [hide, setHide] = useState(getHideOnOpen);
  return (
    <div className="about-block">
      <div className="about-title">이 기기 화면</div>
      <p className="about-desc">이 기기에서만 바뀌어요. 가족의 다른 기기는 각자 정해요.</p>
      <Choices id="font" label="글씨 크기" options={FONT_SCALES} value={font} onChange={(k) => { setFontScale(k); setFont(k); }} />
      <p className="disp-preview" aria-hidden="true">미리 보기 · 어제 점심 김치찌개 9,000원</p>
      <Choices id="theme" label="화면 테마" options={THEMES} value={theme} onChange={(k) => { setTheme(k); setThemeKey(k); }} />
      <p className="about-desc">&apos;기기 설정 따라&apos;는 휴대폰의 다크 모드를 켜고 끌 때 함께 바뀌어요.</p>
      <Choices id="start" label="처음 여는 화면" options={START_TABS} value={start} onChange={(k) => { setStartTab(k); setStart(k); }} />
      <p className="about-desc">다음에 앱을 열 때부터 적용돼요. &apos;확인할 것&apos;(잔액 위험·예산·결제 예정 등)이 있으면 거래내역이 먼저 열려요.</p>

      <label className="disp-switch">
        <input
          type="checkbox"
          checked={hide}
          onChange={(e) => { setHideOnOpen(e.target.checked); setHide(e.target.checked); }}
        />
        <span>가계부를 열 때 가리기</span>
      </label>
      <p className="about-desc">
        앱을 열 때와 다른 앱으로 갈 때 화면을 흐리게 가려요(1분 안에 돌아오면 저절로 걷혀요). 눌러야 보여서, 남 앞에서 열어도
        금액이 바로 보이지 않아요. 켜 두면 머리글의 🔒로 쓰는 중에도 바로 가릴 수 있어요.
      </p>
      {isAndroid() && (
        <p className="disp-tip">
          <b>갤럭시 S26 울트라라면</b> 휴대폰의 프라이버시 디스플레이도 함께 쓰세요. 휴대폰 설정 › 디스플레이 › 프라이버시 디스플레이에서
          켜는 조건에 이 앱(홈 화면에 설치한 &apos;지금 가계부&apos;)을 고르면, 이 앱을 열 때 옆에서는 화면이 보이지 않게 돼요.
          앱이 직접 켤 수는 없어 휴대폰에서 한 번 정해 두어야 해요(메뉴 이름은 기기·버전마다 조금 다를 수 있어요).
        </p>
      )}
    </div>
  );
}
