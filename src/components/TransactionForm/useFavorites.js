import { useEffect, useState } from 'react';
import { getFavorites, addFavorite, updateFavorite, deleteFavorite, recordFavoriteUse } from '../../services/dbManager';

/**
 * 즐겨찾기 — 목록, 지금 폼과 일치하는 즐겨찾기, 추가·이름 바꾸기·해제·사용 기록.
 * 저장은 App 자동 저장이 맡는다 (B-037). 목록은 DB가 바뀌면(live) 다시 읽는다.
 */
export function useFavorites({ live, form, starAmount }) {
  const [favorites, setFavorites] = useState([]);
  const [starredFavoriteId, setStarredFavoriteId] = useState(null);

  useEffect(() => {
    setFavorites(getFavorites(live.db));
  }, [live]);

  // 현재 폼이 기존 즐겨찾기와 일치하는지 확인
  useEffect(() => {
    if (!form.payment_method || !form.budget_category || !form.sub_category) {
      setStarredFavoriteId(null);
      return;
    }
    const matched = favorites.find(f =>
      f.payment_method === form.payment_method &&
      f.budget_category === form.budget_category &&
      f.sub_category === form.sub_category &&
      f.detail === form.detail &&
      (f.amount ?? null) === starAmount
    );
    setStarredFavoriteId(matched ? matched.id : null);
  }, [form, favorites, starAmount]);

  // 금액은 선택 — 결제수단/카테고리/세부카테고리 3개만 있으면 즐겨찾기 가능
  const canStar = !!(form.payment_method && form.budget_category && form.sub_category);
  const autoName = () => form.detail || `${form.payment_method}-${form.sub_category}`;

  const current = (name) => ({
    name,
    payment_method: form.payment_method,
    budget_category: form.budget_category,
    sub_category: form.sub_category,
    detail: form.detail,
    amount: starAmount,
  });

  return {
    favorites,
    starredFavoriteId,
    canStar,
    autoName,
    starredName: () => favorites.find(f => f.id === starredFavoriteId)?.name || '',
    // 지금 폼으로 새 즐겨찾기를 만들고 그 이름을 돌려준다
    addCurrent: () => {
      const name = autoName();
      addFavorite(live.db, current(name));
      setFavorites(getFavorites(live.db));
      return name;
    },
    // 일치하는 즐겨찾기를 지금 폼 값과 새 이름으로 고친다
    updateStarred: (name) => {
      updateFavorite(live.db, starredFavoriteId, current(name));
      setFavorites(getFavorites(live.db));
    },
    removeStarred: () => {
      if (!starredFavoriteId) return;
      deleteFavorite(live.db, starredFavoriteId);
      setFavorites(getFavorites(live.db));
      setStarredFavoriteId(null);
    },
    recordUse: (fav) => {
      recordFavoriteUse(live.db, fav.id);
      setFavorites(getFavorites(live.db));
    },
  };
}
