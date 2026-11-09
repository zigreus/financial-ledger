import React from 'react';
import {
  isCategoryBudgetEnabled, setCategoryBudgetEnabled,
  isMonthlyBalanceEnabled, setMonthlyBalanceEnabled,
  isMonthlyReportEnabled, setMonthlyReportEnabled,
  isTaxSummaryEnabled, setTaxSummaryEnabled,
  isSubscriptionsEnabled, setSubscriptionsEnabled,
  isTripSplitEnabled, setTripSplitEnabled,
} from '../../services/dbManager';

/**
 * 선택 기능 목록 (I-032, ROADMAP Q-2) — 모든 가족이 쓰지는 않아 설정에서 켜고 끄는 기능(기본 꺼짐).
 * 켜고 끈 값은 가계부 DB의 settings에 있어 가족 모두에게 같이 적용된다. 끄면 화면만 감추고 정해 둔 값은 남는다.
 *
 * 설정 › 선택 기능(FeaturesSection)이 이 목록을 한 화면에 보이고, 각 기능의 원래 자리(지출계획 › 예산 등)에도
 * 같은 머리(OptionalFeatureHead)를 둔다 — 이름·설명·스위치가 두 곳에서 같게.
 *  - place: 세부 설정이 있는 설정 화면 { section, label, what } — 선택 기능 화면에서 그 자리로 간다. 없으면 스위치만
 * 새 선택 기능을 만들면 여기에 한 줄 더하고, 원래 자리에서는 OptionalFeatureHead를 쓴다.
 */
export const OPTIONAL_FEATURES = [
  {
    key: 'categoryBudget',
    label: '카테고리별 예산',
    desc: '켜면 요약 › 카테고리에 예산 대비가, 거래내역에 80%·100% 알림이 보여요.',
    isOn: isCategoryBudgetEnabled,
    setOn: setCategoryBudgetEnabled,
    place: { section: 'budget', label: '지출계획 › 예산', what: '카테고리마다 예산 정하기' },
  },
  {
    key: 'monthlyBalance',
    label: '수입·월 수지',
    desc: '켜면 요약 › 월별 추이에 수입·남은 돈·저축률이 보여요.',
    isOn: isMonthlyBalanceEnabled,
    setOn: setMonthlyBalanceEnabled,
    place: { section: 'budget', label: '지출계획 › 예산', what: '수입으로 셀 계좌 고르기' },
  },
  {
    key: 'monthlyReport',
    label: '월간 리포트',
    desc: "켜면 요약에 '리포트' 탭이 생기고, 매달 1~7일에 지난달 리포트를 알려 줘요.",
    isOn: isMonthlyReportEnabled,
    setOn: setMonthlyReportEnabled,
  },
  {
    key: 'taxSummary',
    label: '연말정산 참고 합계',
    desc: "켜면 요약에 '연말정산' 탭이 생겨 한 해 결제를 신용카드·체크카드·현금영수증과 의료비·교육비 등으로 더해 보여 줘요.",
    isOn: isTaxSummaryEnabled,
    setOn: setTaxSummaryEnabled,
  },
  {
    key: 'subscriptions',
    label: '구독 모아보기',
    desc: '켜면 정기지출 중 구독을 모아 월·연 합계와 바뀐 금액을 보여 줘요.',
    isOn: isSubscriptionsEnabled,
    setOn: setSubscriptionsEnabled,
    place: { section: 'recurring', label: '지출계획 › 정기지출', what: '구독 고르기' },
  },
  {
    key: 'tripSplit',
    label: '일행 정산 (N빵)',
    desc: "켜면 여행 일정에 '일행 정산'이 생겨, 누가 냈고 누구 몫인지로 \"누가 누구에게 얼마\"를 계산하고 공유할 글을 만들어 줘요.",
    isOn: isTripSplitEnabled,
    setOn: setTripSplitEnabled,
  },
];

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
        <div style={{ fontSize: '14px', fontWeight: '600' }}>{f.label}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>필요할 때만 켜세요. {f.desc}</div>
      </div>
      <FeatureSwitch label={f.label} on={enabled} onToggle={onToggle} />
    </div>
  );
}
