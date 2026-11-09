import React from 'react';
import ModalOverlay from '../common/ModalOverlay';
import { OWN_LEDGER } from '../../services/ledgers';
import './LedgerDialogs.css';

const ledgerLabel = l => `${l.ownerName || '공유받은'} 가계부`;

/**
 * 가계부 바꾸기 (ROADMAP M-2) — 머리글의 가계부 이름을 누르면. 내 가계부와 다른 계정이 공유한 가계부 중 고른다.
 * 저장하지 못한 변경은 그 가계부에 남아 돌아오면 이어서 저장한다.
 */
export function LedgerSwitcher({ current, shared, onPick, onClose }) {
  const item = (id, label, sub) => (
    <li key={id || 'own'}>
      <button
        type="button"
        className={id === current ? 'ledger-pick ledger-pick--on' : 'ledger-pick'}
        aria-current={id === current ? 'true' : undefined}
        onClick={() => onPick(id)}
      >
        <span className="ledger-pick-name">{label}</span>
        <span className="ledger-pick-sub">{sub}</span>
        {id === current && <span className="ledger-pick-check" aria-hidden="true">✓</span>}
      </button>
    </li>
  );
  return (
    <ModalOverlay className="modal-overlay" panelClassName="modal-content modal-small ledger-dialog" onDismiss={onClose}>
      <div className="ledger-dialog-head">
        <h3 className="ledger-dialog-title">가계부 바꾸기</h3>
        <button type="button" className="modal-close" onClick={onClose} aria-label="닫기">✕</button>
      </div>
      <ul className="ledger-pick-list">
        {item(OWN_LEDGER, '내 가계부', '내 드라이브의 가계부')}
        {shared.map(l => item(l.id, ledgerLabel(l), '다른 계정이 함께 쓰자고 공유한 가계부'))}
      </ul>
      <p className="ledger-dialog-note">공유받은 가계부는 설정 › 데이터 › 다른 계정과 함께 쓰기에서 목록에서 뺄 수 있어요.</p>
    </ModalOverlay>
  );
}

/**
 * 참여 링크로 열었을 때 (ROADMAP M-2) — '이 가계부를 열까요?' 또는 열 수 없는 이유.
 * offer: { ownerName, error }
 */
export function JoinLedgerDialog({ offer, onAccept, onClose }) {
  return (
    <ModalOverlay className="modal-overlay" panelClassName="modal-content modal-small ledger-dialog" onDismiss={onClose}>
      <div className="ledger-dialog-head">
        <h3 className="ledger-dialog-title">함께 쓰는 가계부</h3>
        <button type="button" className="modal-close" onClick={onClose} aria-label="닫기">✕</button>
      </div>
      {offer.error ? (
        <>
          <p className="ledger-dialog-text" role="alert">{offer.error}</p>
          <div className="ledger-dialog-actions">
            <button type="button" className="btn-primary" onClick={onClose}>닫기</button>
          </div>
        </>
      ) : (
        <>
          <p className="ledger-dialog-text">
            <b>{offer.ownerName ? `${offer.ownerName}님` : '다른 계정'}</b>이 함께 쓰자고 공유한 가계부예요. 지금 열까요?
          </p>
          <p className="ledger-dialog-note">
            내 가계부는 그대로 있어요. 머리글의 가계부 이름을 눌러 언제든 바꿀 수 있어요.
            함께 쓰는 가계부에 적은 것은 공유한 사람의 드라이브에 저장돼요.
          </p>
          <div className="ledger-dialog-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>나중에</button>
            <button type="button" className="btn-primary" onClick={onAccept}>열기</button>
          </div>
        </>
      )}
    </ModalOverlay>
  );
}
