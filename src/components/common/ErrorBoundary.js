import React, { Suspense } from 'react';
import { recordError } from '../../services/errorLog';
import ProblemReport from './lazyProblemReport';
import './ErrorBoundary.css';

/**
 * 화면을 그리다 멈췄을 때 (I-038) — 흰 화면 대신 안내·'다시 열기'·'문제 알리기'를 보인다.
 * 오류는 이 기기의 오류 기록에만 남긴다(services/errorLog — 보내지 않음). 가계부에 쓴 것 중 저장 안 된 변경은
 * useLedgerSync가 쓸 때마다 이 기기에 보관하므로 다시 열면 이어서 저장한다.
 * index.js가 앱 전체를 감싼다. 문제 알리기는 열 때 불러온다(그 사이 연결이 없어도 미리 받아 둔 것을 쓴다 — preloadScreens).
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, report: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    recordError(error, { kind: '화면 오류' });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crash-page">
        <div className="crash-card">
          {/* 알림(role=alert)은 안내에만 — 아래 문제 알리기에 적을 때마다 화면 낭독기가 다시 읽지 않게 */}
          <div role="alert">
            <h1 className="crash-title">화면을 그리다 문제가 생겼어요</h1>
            <p className="crash-desc">
              다시 열면 대부분 괜찮아져요. 가계부에 넣은 것 중 아직 드라이브에 저장하지 못한 변경은 이 기기에 보관되어 있어
              다시 열면 이어서 저장해요(쓰던 입력 창의 글은 사라질 수 있어요). 계속 같은 문제가 생기면 &apos;문제 알리기&apos;로 알려 주세요.
            </p>
          </div>
          <div className="crash-actions">
            <button type="button" className="btn-primary" onClick={() => window.location.reload()}>다시 열기</button>
            {!this.state.report && (
              <button type="button" className="btn-secondary" onClick={() => this.setState({ report: true })}>문제 알리기</button>
            )}
          </div>
          {this.state.report && (
            <Suspense fallback={<p className="crash-desc">불러오는 중…</p>}>
              <ProblemReport />
            </Suspense>
          )}
        </div>
      </div>
    );
  }
}
