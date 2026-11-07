import { useMemo } from 'react';
import { getEventWallets } from '../../services/dbManager';
import { parseRate, parseForeignAmount } from '../../services/formulaEvaluator';
import { krwFromForeign } from './txFormUtils';

/**
 * 여행 금액 — 연결한 일정, 현금 지갑, 현지 금액 입력.
 *  activeCurrencies     : 현지 금액이 입력된 통화 (저장될 foreign_amounts 기준)
 *  storedOnlyCurrencies : 연결된 여행 일정의 통화 칸에 없는, 저장된 현지 금액의 통화 (B-060)
 */
export function useTripAmounts({ live, form, setForm, calendarEvents, eventTypeMap }) {
  const selectedEvent = calendarEvents.find(e => String(e.id) === form.event_id);
  const selectedEventId = selectedEvent?.id;
  const isTripEvent = !!eventTypeMap[selectedEvent?.event_type]?.is_trip_type;
  // 지갑 계산은 SQL 여러 번이라 키 입력마다 돌리지 않는다 — 일정이나 DB가 바뀔 때만 (B-046)
  const wallets = useMemo(
    () => (isTripEvent && selectedEventId
      ? getEventWallets(live.db, selectedEventId).filter(w => Math.abs(w.balance) >= 0.005)
      : []),
    [live, isTripEvent, selectedEventId]
  );

  // 현지 금액이 입력된 통화 — 저장될 값(foreign_amounts) 기준으로 센다.
  // 보이는 일정 목록에서 구하면 일정을 숨기거나 지웠을 때 외화가 사라진 것처럼 보인다 (B-033, B-060)
  const activeCurrencies = Object.keys(form.foreign_amounts)
    .filter(cur => (parseForeignAmount(form.foreign_amounts[cur]) || 0) > 0);
  // 연결된 여행 일정의 통화 칸에 없는, 저장된 현지 금액 — 따로 칸을 보여 줘 값을 확인·수정할 수 있게 한다
  const eventCurrencies = isTripEvent ? (selectedEvent?.countries || []).map(c => c.currency) : [];
  const storedOnlyCurrencies = Object.keys(form.foreign_amounts).filter(cur => !eventCurrencies.includes(cur));

  // 현지 금액 입력 → 여행에 설정된 환율로 원화 금액 자동 계산.
  // 환율이 없는 통화 칸은 원화 금액을 건드리지 않는다 — 먼저 입력한 원화가 지워지지 않게 (B-035)
  const changeForeignAmount = (currency, value, countries) => {
    const rated = countries.some(c => c.currency === currency && parseRate(c.exchange_rate) > 0);
    setForm(prev => {
      const foreign_amounts = { ...prev.foreign_amounts, [currency]: value };
      const krw = rated ? krwFromForeign(foreign_amounts, countries) : null;
      return {
        ...prev,
        foreign_amounts,
        ...(krw === null ? {} : { amount: krw }),
      };
    });
  };

  // 일정에 없는 통화로 저장된 현지 금액 — 환율을 모르므로 원화는 다시 계산하지 않고 값만 고친다 (B-060)
  const changeStoredForeign = (currency, value) => {
    setForm(prev => ({ ...prev, foreign_amounts: { ...prev.foreign_amounts, [currency]: value } }));
  };

  return {
    selectedEvent,
    isTripEvent,
    wallets,
    activeCurrencies,
    storedOnlyCurrencies,
    changeForeignAmount,
    changeStoredForeign,
  };
}
