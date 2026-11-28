import React from 'react';
import ModalOverlay from '../common/ModalOverlay';
import AIEntry from './AIEntry';
import './AIEntry.css';

const START = { quick: true };

const TIPS = [
  '어제 점심 김치찌개 9천원 현금',
  '방금 넣은 거 지워 줘',
  '어제 스타벅스 카테고리를 간식으로 바꿔 줘',
  '넷플릭스 정기지출 17000원으로 바꿔 줘',
  '식비 예산 50만원으로 해 줘',
  '이번 달 외식 얼마 썼어?',
  '화면 어둡게 해 줘',
];

/**
 * AI 창 (I-051) — 어느 화면에서나 ✨ 버튼으로 연다. AI 입력 상자 하나에 무엇이든 말하면
 * 새 거래는 말로 입력·카드 문자·영수증으로, 고치기·지우기·정기지출·설정·조회는 AI 명령으로 알아서 처리한다.
 * 한 건은 '이대로 넣기'로 바로 넣거나(onBulkAdd, I-066) '이대로 채우기'로 입력 창을 열어 채운다(App의 onApply).
 * 입력하던 글이 있을 수 있어 바깥을 누르거나 Esc로는 닫지 않는다(입력 창과 같다).
 * 열자마자 입력 상자에 키보드가 뜨므로 창을 키보드 위 보이는 곳에 맞춘다(fitKeyboard, B-100) — 짧은 창이라
 * 맞추지 않으면 브라우저가 가려진 상자를 보이려고 화면 전체를 끌어올려 창 머리와 상자가 화면 위로 밀린 채 남는다.
 */
export default function AIAssistant({ db, onApply, onBulkAdd, onQuickAdd, onCommand, onClose }) {
  return (
    <ModalOverlay className="modal-overlay" panelClassName="modal-content ai-assistant" fitKeyboard>
      <div className="modal-header">
        <h2>✨ AI</h2>
        <button type="button" className="modal-close" onClick={onClose}>✕</button>
      </div>
      <div className="ai-assistant-body">
        <AIEntry
          db={db}
          start={START}
          onApply={onApply}
          onBulkAdd={onBulkAdd}
          onQuickAdd={onQuickAdd}
          onCommand={onCommand}
          onExit={onClose}
        />
        <div className="ai-assistant-tips">
          <div className="ai-assistant-tips-title">이렇게 말해 보세요</div>
          <ul>{TIPS.map(t => <li key={t}>{t}</li>)}</ul>
          <div className="ai-assistant-tips-note">
            거래를 고치거나 지우는 일은 맞는 거래를 보여 드리고 한 번 확인받아요. 한 일은 알림의 '되돌리기'로 되돌릴 수 있어요.
            AI에는 카테고리·결제수단·정기지출 이름 같은 목록과 말한 글만 보내고, 거래 내역은 이 기기에서 찾아요.
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}
