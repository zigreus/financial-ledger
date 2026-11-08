import React, { useMemo } from 'react';
import { isMonthlyReportEnabled, setMonthlyReportEnabled } from '../../../services/dbManager';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';

/**
 * 지출계획 › 예산 › 월간 리포트 (I-028, ROADMAP C-9) — 필요한 사람만 켜는 선택 기능(가족 공통 설정).
 * 켜면 요약에 '리포트' 탭이 생기고, 매달 1~7일 거래내역 첫 화면에 지난달 리포트를 알린다.
 */
export default function MonthlyReportSettings({ db, dataVersion, onChanged }) {
  const live = useDbSnapshot(db, dataVersion);
  const enabled = useMemo(() => isMonthlyReportEnabled(live.db), [live]);

  const toggle = () => {
    setMonthlyReportEnabled(db, !enabled);
    onChanged();
  };

  return (
    <div className="cb-settings">
      <div className="cb-settings-head">
        <div>
          <div style={{ fontSize: '14px', fontWeight: '600' }}>월간 리포트</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            필요할 때만 켜세요. 켜면 요약에 &apos;리포트&apos; 탭이 생기고, 매달 1~7일에 지난달 리포트를 알려 줘요.
          </div>
        </div>
        <button
          type="button"
          className={`goal-display-toggle${enabled ? ' goal-display-toggle--on' : ''}`}
          onClick={toggle}
          title={enabled ? '월간 리포트 끄기' : '월간 리포트 켜기'}
          aria-pressed={enabled}
        >
          <span className="goal-display-toggle-knob" />
        </button>
      </div>
      {enabled && (
        <div className="cb-settings-note">
          지난달을 앞 3개월 평균과 견주어 크게 늘거나 줄어든 카테고리, 가장 큰 지출 3건, 무지출일, 월 목표·카테고리 예산 결과를 보여 줘요.
          &apos;✨ AI 한마디&apos;를 누르면 합계 수준의 숫자만 AI에 보내 문장으로 정리해요(AI 키가 있을 때).
        </div>
      )}
    </div>
  );
}
