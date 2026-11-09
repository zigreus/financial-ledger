import React, { useMemo } from 'react';
import {
  isMonthlyBalanceEnabled, setMonthlyBalanceEnabled, getIncomeAccounts, setAccountCountsIncome,
} from '../../../services/dbManager';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import { OptionalFeatureHead } from '../optionalFeatures';

/**
 * 지출계획 › 예산 › 수입·월 수지 (I-026, ROADMAP C-6) — 필요한 사람만 켜는 선택 기능(가족 공통 설정).
 * 켜면 요약 › 월별 추이에 수입·남은 돈·저축률이 보인다. 수입은 고른 계좌의 입금(자동 등록된 예정 금액 포함)으로 센다.
 * 계좌마다 '수입으로 셈'을 고른다 — 고르지 않으면 반복 수입(월급 등)이 있는 계좌만 센다.
 * 끄면 화면에서만 감추고 고른 값은 남겨 둔다.
 */
export default function MonthlyBalanceSettings({ db, dataVersion, onChanged }) {
  const live = useDbSnapshot(db, dataVersion);
  const enabled = useMemo(() => isMonthlyBalanceEnabled(live.db), [live]);
  const accounts = useMemo(() => getIncomeAccounts(live.db), [live]);

  const toggle = () => {
    setMonthlyBalanceEnabled(db, !enabled);
    onChanged();
  };
  const toggleAccount = (a) => {
    setAccountCountsIncome(db, a.id, !a.counted);
    onChanged();
  };
  const resetAccount = (a) => {
    setAccountCountsIncome(db, a.id, null);
    onChanged();
  };

  const accountRow = a => (
    <li key={a.id} className="cb-settings-row">
      <span className="cb-settings-name mb-account-name">
        {a.name}
        <span className="mb-account-hint">
          {a.auto
            ? (a.hasRecurringIncome ? '반복 수입 계좌라 셈' : '반복 수입이 없어 세지 않음')
            : '직접 고름'}
          {!a.auto && (
            <button type="button" className="mb-account-reset" onClick={() => resetAccount(a)}>자동으로</button>
          )}
        </span>
      </span>
      <button
        type="button"
        className={`goal-display-toggle${a.counted ? ' goal-display-toggle--on' : ''}`}
        onClick={() => toggleAccount(a)}
        title={a.counted ? `${a.name} 입금을 수입으로 세지 않기` : `${a.name} 입금을 수입으로 세기`}
        aria-pressed={a.counted}
      >
        <span className="goal-display-toggle-knob" />
      </button>
    </li>
  );

  return (
    <div className="cb-settings mb-settings">
      <OptionalFeatureHead featureKey="monthlyBalance" enabled={enabled} onToggle={toggle} />

      {enabled && (
        <>
          {accounts.length === 0 ? (
            <div className="cb-settings-note">계좌가 없습니다 — 계좌 탭에서 월급이 들어오는 계좌를 만들고 반복 수입(예정 금액)을 적어 두세요.</div>
          ) : (
            <>
              <div className="cb-settings-note" style={{ marginTop: 0, marginBottom: 6 }}>수입으로 셀 계좌</div>
              <ul className="cb-settings-list">{accounts.filter(a => !a.deleted).map(accountRow)}</ul>
              {accounts.some(a => a.deleted) && (
                <>
                  <div className="cb-settings-note" style={{ marginBottom: 6 }}>지운 계좌 — 켜 둔 계좌는 지난 입금이 수입에 잡혀요(앞으로의 예정은 세지 않아요)</div>
                  <ul className="cb-settings-list">{accounts.filter(a => a.deleted).map(accountRow)}</ul>
                </>
              )}
              {accounts.filter(a => a.auto && a.counted).length >= 2 && (
                <div className="cb-settings-note mb-transfer-hint">
                  반복 수입이 있어 자동으로 세는 계좌가 여럿이에요 — 적금·생활비처럼 내 계좌끼리 옮기는 돈이면 그 계좌는 끄세요(두 번 세지 않게).
                </div>
              )}
            </>
          )}
          <div className="cb-settings-note">
            수입은 고른 계좌의 입금으로 셉니다 — 반복 수입이 자동 등록한 예정 금액도 세고, 월급이 들어와 실제 금액으로 고치면 그 금액이 돼요.
            여행 현금을 재환전해 돌아온 돈은 세지 않아요. 저축 계좌나 내 계좌끼리 옮긴 돈이 들어오는 계좌는 끄세요.
            지출은 가계부에 적은 지출(할인 뺀 금액)만 셉니다 — 카드 대금 같은 계좌 출금은 가계부 지출과 겹쳐 세지 않아요.
          </div>
        </>
      )}
    </div>
  );
}
