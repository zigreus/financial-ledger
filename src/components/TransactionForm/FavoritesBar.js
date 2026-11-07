import React, { useState } from 'react';

/**
 * 머리글의 ☆ 버튼과 이름 팝업 — 누르면 지금 폼을 즐겨찾기로 추가하거나, 일치하는 즐겨찾기의 이름을 고친다.
 * fav: useFavorites의 반환값
 */
export function FavoriteStar({ fav }) {
  const [showPopup, setShowPopup] = useState(false);
  const [name, setName] = useState('');
  const { canStar, starredFavoriteId } = fav;

  const handleClick = () => {
    if (!canStar) return;
    if (starredFavoriteId) {
      setShowPopup(true);
      setName(fav.starredName());
    } else {
      setName(fav.addCurrent());
      setShowPopup(true);
    }
  };

  const handleClose = () => {
    if (!starredFavoriteId || !name.trim()) {
      setShowPopup(false);
      return;
    }
    fav.updateStarred(name);
    setShowPopup(false);
  };

  const handleRemove = () => {
    fav.removeStarred();
    setShowPopup(false);
  };

  return (
    <>
      <button
        type="button"
        className={`btn-star ${!canStar ? 'disabled' : ''} ${starredFavoriteId ? 'active' : ''}`}
        onClick={handleClick}
        disabled={!canStar}
        title={canStar ? '즐겨찾기' : '결제수단, 카테고리, 세부카테고리를 모두 선택하세요'}
      >
        {starredFavoriteId ? '★' : '☆'}
      </button>
      {showPopup && (
        <div className="star-popup">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={fav.autoName()}
            autoFocus
          />
          <div className="star-popup-buttons">
            {starredFavoriteId && (
              <button type="button" className="btn-secondary" onClick={handleRemove}>
                해제
              </button>
            )}
            <button type="button" className="btn-primary" onClick={handleClose}>
              완료
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** 즐겨찾기 칩 — 누르면 그 즐겨찾기로 폼을 채운다 */
export default function FavoritesBar({ favorites, starredFavoriteId, onApply }) {
  if (favorites.length === 0) return null;
  return (
    <div className="favorite-chips">
      {favorites.map(fav => (
        <button
          key={fav.id}
          type="button"
          className={`favorite-chip ${starredFavoriteId === fav.id ? 'active' : ''}`}
          onClick={() => onApply(fav)}
        >
          ★ {fav.name}
        </button>
      ))}
    </div>
  );
}
