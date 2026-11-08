import React from 'react';

/** 받침이 있으면 '을', 없으면 '를' (한글이 아니면 '을(를)') */
export function objectParticle(word) {
  const code = String(word || '').charCodeAt(String(word || '').length - 1);
  if (!(code >= 0xAC00 && code <= 0xD7A3)) return '을(를)';
  return (code - 0xAC00) % 28 ? '을' : '를';
}

/**
 * 거래가 하나도 없을 때의 거래내역 화면 (ROADMAP F-3, I-019).
 *  - 새 가계부(blank): 카테고리·결제수단이 없어 거래를 입력할 수 없다 → 첫 실행 안내 열기 / CSV 가져오기
 *  - 그 밖: "첫 거래 입력해 보기" 3단계 안내. 거래 입력 폼에서 고를 것이 없으면(missing: '결제수단'·'카테고리'·'세부카테고리')
 *    저장할 수 없으므로 먼저 설정에서 만들게 알리고 그 설정 화면을 연다(onOpenSettings(section))
 */
export default function FirstEntryGuide({ blank, missing = [], onOpenOnboarding, onOpenImport, onOpenSettings, onAdd }) {
  if (blank) {
    return (
      <div className="first-entry">
        <h3>새 가계부예요</h3>
        <p className="first-entry-lead">카테고리와 결제수단이 있어야 거래를 입력할 수 있어요. 살림에 맞는 기본값을 골라 시작하세요.</p>
        <button className="btn-primary" onClick={onOpenOnboarding}>기본 카테고리·결제수단 넣기</button>
        {onOpenImport && (
          <button className="first-entry-link" onClick={onOpenImport}>이미 쓰던 가계부(CSV)가 있어요 — 가져오기</button>
        )}
      </div>
    );
  }

  const missingText = missing.join('·');
  return (
    <div className="first-entry">
      <h3>첫 거래를 입력해 볼까요?</h3>
      <ol className="first-entry-steps">
        <li>
          <strong>입력 창 열기</strong>
          <span>아래 가운데 ＋ 버튼을 눌러요.</span>
        </li>
        <li>
          <strong>금액·분류 고르기</strong>
          <span>금액을 적고 결제수단·카테고리·세부카테고리를 골라요. 금액 칸은 12000+3500처럼 계산도 돼요.</span>
        </li>
        <li>
          <strong>저장</strong>
          <span>저장하면 이 목록에 보이고, 자동으로 저장돼 다른 기기에서도 보여요.</span>
        </li>
      </ol>
      {missing.length > 0 && (
        <div className="first-entry-warn" role="alert">
          <p>먼저 설정에서 {missingText}{objectParticle(missingText)} 하나 이상 만들어 주세요 — 고를 것이 없으면 저장할 수 없어요.</p>
          {onOpenSettings && (
            <button className="btn-secondary" onClick={() => onOpenSettings(missing.includes('결제수단') ? 'payment' : 'category')}>
              설정에서 만들기
            </button>
          )}
        </div>
      )}
      <button className="btn-primary" onClick={onAdd}>＋ 첫 거래 입력해 보기</button>
      <p className="first-entry-tip">입력 창 맨 위의 💳 카드 문자에 카드 승인 문자를 붙여넣으면 금액·가게·날짜를 알아서 채워요.</p>
    </div>
  );
}
