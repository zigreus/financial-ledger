import React from 'react';
import AISettingsForm from '../../AIEntry/AISettingsForm';

/** AI 입력 설정 (같은 Microsoft 계정의 기기끼리 공유 — aiSettingsSync) */
export default function AISection() {
  return (
    <div>
      <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '6px' }}>AI 입력</div>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.6 }}>
        영수증 사진, 말로 적은 내용, 카드 결제 내역을 AI가 읽고
        예전 입력 습관을 기준으로 결제수단과 카테고리를 추천합니다.
        이 설정은 같은 Microsoft 계정으로 로그인한 휴대폰·PC에서 함께 씁니다.
      </div>
      <AISettingsForm />
    </div>
  );
}
