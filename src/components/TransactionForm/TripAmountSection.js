import React from 'react';
import AmountInput from '../common/AmountInput';
import { formatAmount, parseRate, parseForeignAmount, toKrw } from '../../services/formulaEvaluator';
import { fmtWallet } from './txFormUtils';

/**
 * 여행 금액 영역 — 남은 현금(지갑), 여행 일정의 현지 금액 칸, 일정에 없는 통화로 저장된 현지 금액 칸.
 * 상태와 계산은 useTripAmounts가 맡고, 여기는 그리기만 한다.
 */
export default function TripAmountSection({ form, trip, amountParsed, onForeignChange, onStoredForeignChange }) {
  const { selectedEvent, isTripEvent, wallets, activeCurrencies, storedOnlyCurrencies } = trip;

  return (
    <>
      {/* 남은 현금 (여행 지갑) */}
      {wallets.length > 0 && (
        <div className={`wallet-badge${form.payment_method === '현금' ? ' active' : ''}`}>
          <span className="wallet-badge-icon">💰</span>
          <div className="wallet-badge-body">
            <div className="wallet-badge-title">남은 현금</div>
            <div className="wallet-badge-list">
              {wallets.map(w => {
                const used = w.currency === 'KRW'
                  ? (form.payment_method === '현금' && activeCurrencies.length === 0 ? (amountParsed || 0) : 0)
                  : (form.payment_method === '현금'
                      ? (parseForeignAmount(form.foreign_amounts[w.currency]) || 0) : 0);
                const after = w.balance - used;
                return (
                  <span key={w.currency} className="wallet-badge-item">
                    {fmtWallet(w.balance, w.currency)} {w.currency}
                    {used > 0 && (
                      <b className={after < 0 ? 'neg' : ''}> → {fmtWallet(after, w.currency)}</b>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 현지 금액 (여행 유형 일정 선택 시) */}
      {form.event_id && (() => {
        if (!isTripEvent || !selectedEvent?.countries?.length) return null;
        const countries = selectedEvent.countries;
        const hasAnyRate = countries.some(c => parseRate(c.exchange_rate) > 0);
        return (
          <>
            <div className="form-section-title">
              현지 금액 <span className="optional">(선택)</span>
            </div>
            {hasAnyRate && (
              <div className="fx-note">환율이 설정된 통화는 금액(원)이 자동 계산됩니다.</div>
            )}
            {countries.map(c => {
              const rate = parseRate(c.exchange_rate);
              const raw = form.foreign_amounts[c.currency] || '';
              const converted = rate > 0 ? toKrw(parseForeignAmount(raw), rate) : null;
              return (
                <div key={c.id} className="form-group">
                  <label>
                    {c.country} ({c.currency})
                    {rate > 0 && (
                      <span className="fx-rate">1 {c.currency} = {formatAmount(rate)}원</span>
                    )}
                  </label>
                  <AmountInput
                    decimal
                    unit={c.currency}
                    value={raw}
                    onChange={v => onForeignChange(c.currency, v, countries)}
                    placeholder={`${c.currency} 금액 (예: 1200+800)`}
                  />
                  {converted !== null && (
                    <span className="formula-preview">≈ {formatAmount(converted)}원</span>
                  )}
                </div>
              );
            })}
          </>
        );
      })()}

      {/* 저장된 현지 금액 — 일정이 지워졌거나 숨겨졌거나, 일정에 그 통화가 없을 때 (B-060) */}
      {storedOnlyCurrencies.length > 0 && (
        <>
          <div className="form-section-title">
            저장된 현지 금액 <span className="optional">(선택)</span>
          </div>
          <div className="fx-note">
            {!form.event_id ? '연결된 일정이 없어' : !selectedEvent ? '연결된 일정이 숨겨져 있어' : '연결된 일정에 이 통화가 없어'}
            {' '}원화 금액은 자동으로 다시 계산하지 않습니다. 칸을 비우고 저장하면 이 현지 금액은 지워집니다.
          </div>
          {storedOnlyCurrencies.map(cur => (
            <div key={cur} className="form-group">
              <label>{cur}</label>
              <AmountInput
                decimal
                unit={cur}
                value={form.foreign_amounts[cur] ?? ''}
                onChange={v => onStoredForeignChange(cur, v)}
                placeholder={`${cur} 금액`}
              />
            </div>
          ))}
        </>
      )}
    </>
  );
}
