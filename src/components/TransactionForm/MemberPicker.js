import React from 'react';

/**
 * '누가' 고르기 (I-013) — 가족 구성원 칩. 누른 칩을 다시 누르면 '지정 안 함'.
 * 구성원이 하나도 없으면 그리지 않는다(설정 › 데이터에서 추가).
 */
export default function MemberPicker({ members, value, onChange }) {
  if (!members.length && !value) return null;
  // 목록에 없는 이름으로 적힌 거래를 고칠 때도 현재 값이 보이게
  const list = value && !members.includes(value) ? [...members, value] : members;
  return (
    <div className="form-group">
      <label>누가<span className="optional">(선택)</span></label>
      <div className="member-chips" role="group" aria-label="누가">
        {list.map(name => (
          <button
            type="button"
            key={name}
            className={`member-chip${value === name ? ' active' : ''}`}
            aria-pressed={value === name}
            onClick={() => onChange(value === name ? '' : name)}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}
