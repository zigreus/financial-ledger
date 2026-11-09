import React, { useMemo } from 'react';
import { isTaxSummaryEnabled, setTaxSummaryEnabled } from '../../../services/dbManager';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import { OptionalFeatureHead } from '../optionalFeatures';

/**
 * 지출계획 › 예산 › 연말정산 참고 합계 (I-029, ROADMAP C-10) — 필요한 사람만 켜는 선택 기능(가족 공통 설정).
 * 켜면 요약에 '연말정산' 탭이 생긴다. 끄면 탭만 감추고 결제수단 유형·카테고리 항목은 남겨 둔다.
 */
export default function TaxSummarySettings({ db, dataVersion, onChanged }) {
  const live = useDbSnapshot(db, dataVersion);
  const enabled = useMemo(() => isTaxSummaryEnabled(live.db), [live]);

  const toggle = () => {
    setTaxSummaryEnabled(db, !enabled);
    onChanged();
  };

  return (
    <div className="cb-settings">
      <OptionalFeatureHead featureKey="taxSummary" enabled={enabled} onToggle={toggle} />
      {enabled && (
        <div className="cb-settings-note">
          공제액은 계산하지 않아요(세법이 해마다 바뀌어서). 홈택스 연말정산 간소화 자료와 견주어 빠진 것이 없는지 확인하는 데 쓰세요.
          결제수단 유형과 카테고리 항목은 요약 › 연말정산의 &apos;분류 정하기&apos;에서 고르세요.
        </div>
      )}
    </div>
  );
}
