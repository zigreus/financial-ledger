import React from 'react';
import { CONTACT_EMAIL, OPERATOR_NAME, PRIVACY_URL, TERMS_URL } from '../../../config';
import { appVersion } from '../../../services/errorLog';
import { currentDriveName } from '../../../services/storage/driveName';
import ProblemReport from '../../common/ProblemReport';

/**
 * 설정 › 정보 (I-038, ROADMAP M-5) — 앱 버전, 운영·문의, 개인정보처리방침·이용약관, 문제 알리기(common/ProblemReport).
 */
export default function AboutSection() {
  const drive = currentDriveName();
  return (
    <div className="about-section">
      <div className="about-block">
        <div className="about-title">지금 가계부</div>
        <dl className="about-facts">
          <div><dt>버전</dt><dd>{appVersion()}</dd></div>
          <div><dt>운영</dt><dd>{OPERATOR_NAME}</dd></div>
          <div>
            <dt>문의</dt>
            <dd>{CONTACT_EMAIL ? <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> : '문의 메일 주소는 준비 중이에요'}</dd>
          </div>
        </dl>
        <p className="about-desc">
          가계부는 로그인한 계정의 {drive}에 저장되고, 이 기기에는 연결 없이 열기 위한 사본과 아직 저장하지 못한 변경만 둬요.
          운영자는 가계부·사용 기록·오류를 자동으로 받지 않아요(아래 문제 알리기로 직접 보낸 것만 받아요). AI 기능은 직접 넣은 API 키로, 쓸 때만 그 AI 회사에 필요한 만큼 보내요.
        </p>
        <div className="about-links">
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">개인정보처리방침</a>
          <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">이용약관</a>
        </div>
      </div>

      <div className="about-block">
        <div className="about-title">문제 알리기</div>
        <ProblemReport drive={drive} />
      </div>
    </div>
  );
}
