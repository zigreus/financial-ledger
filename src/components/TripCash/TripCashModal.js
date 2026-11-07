import React, { useState, useMemo, useCallback } from 'react';
import {
  getEventWallets, getEventCashLedger, addEventCashFlow, deleteEventCashFlow, getCashFlowLinks,
  reconcileEventWallet, closeEventWallet, getWalletRate,
  getEventCountries, getAllAccounts,
  getBudgetCategories, getSubCategories, getTripDefaultCategory,
  getCalendarEvents, getCalendarEventTypes,
} from '../../services/dbManager';
import { evaluateFormula, parseForeignAmount, formatAmount, today } from '../../services/formulaEvaluator';
import './TripCashModal.css';
import ModalOverlay from '../common/ModalOverlay';
import AmountInput from '../common/AmountInput';

const KRW = 'KRW';

const FLOW_LABEL = {
  exchange: '환전/출금',
  adjust: '정산 조정',
  refund: '재환전/입금',
  carryover_out: '이월 나감',
  carryover_in: '이월 들어옴',
  close: '지갑 정리',
};

/** 현지 통화는 소수점 2자리까지, 원화는 정수로 표시 */
function fmtCur(value, currency) {
  if (currency === KRW) return formatAmount(Math.round(value));
  const rounded = Math.round(value * 100) / 100;
  return rounded.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

/** 현금 흐름 삭제 확인 문구 — 함께 지워지는 기록을 실제 삭제 범위대로 알린다 */
function describeFlowDeletion(links) {
  const { flow, accountTx, accountTxMissing, pairFlow, fxTx } = links;
  const lines = [
    `${FLOW_LABEL[flow.type] || flow.type} ${flow.amount > 0 ? '+' : ''}${fmtCur(flow.amount, flow.currency)} ${flow.currency} (${flow.date}) 기록을 삭제할까요?`,
  ];
  const also = [];
  if (accountTx) {
    also.push(`계좌 ${accountTx.account_name ? `'${accountTx.account_name}' ` : ''}${accountTx.type === 'income' ? '입금' : '출금'} ${formatAmount(accountTx.amount)}원`);
  }
  if (pairFlow) {
    also.push(`'${pairFlow.event_title || '다른 일정'}'의 ${FLOW_LABEL[pairFlow.type] || pairFlow.type} ${fmtCur(pairFlow.amount, pairFlow.currency)} ${pairFlow.currency}`);
  }
  if (fxTx) {
    also.push(`가계부의 ${fxTx.detail} ${formatAmount(fxTx.amount || fxTx.discount_amount)}원`);
  }
  if (also.length) lines.push('', '함께 삭제됩니다:', ...also.map(s => `· ${s}`));
  if (accountTxMissing) {
    lines.push('', '계좌에 반영된 기록을 찾지 못했습니다. 계좌 내역에서 직접 지워 주세요.');
  }
  return lines.join('\n');
}

function Tabs({ value, onChange, items }) {
  return (
    <div className="tc-tabs">
      {items.map(it => (
        <button
          key={it.value}
          type="button"
          className={`tc-tab${value === it.value ? ' active' : ''}`}
          onClick={() => onChange(it.value)}
        >{it.label}</button>
      ))}
    </div>
  );
}

export default function TripCashModal({ db, dataVersion = 0, event, onClose, onChanged }) {
  const [tab, setTab] = useState('wallets');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');

  const bump = useCallback(() => {
    setVersion(v => v + 1);
    onChanged?.();
  }, [onChanged]);

  // version·dataVersion은 sql.js DB가 제자리에서 바뀌므로 다시 읽기 위한 캐시 무효화 키
  // (version: 이 창에서 바꾼 것, dataVersion: 앱 어디서든 DB에 쓴 것)
  /* eslint-disable react-hooks/exhaustive-deps */
  const wallets = useMemo(() => getEventWallets(db, event.id), [db, event.id, version, dataVersion]);
  const ledger = useMemo(() => getEventCashLedger(db, event.id), [db, event.id, version, dataVersion]);
  const countries = useMemo(() => getEventCountries(db, event.id), [db, event.id, version, dataVersion]);
  const accounts = useMemo(() => getAllAccounts(db), [db, dataVersion]);
  const categories = useMemo(() => getBudgetCategories(db), [db, dataVersion]);
  const tripCategory = useMemo(() => getTripDefaultCategory(db), [db, dataVersion]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const handleDeleteFlow = (id) => {
    const links = getCashFlowLinks(db, id);
    if (!links) return;
    if (!window.confirm(describeFlowDeletion(links))) return;
    run(() => { deleteEventCashFlow(db, id); bump(); });
  };

  // 이월 대상 후보 — 다른 여행 유형 일정
  const tripEvents = useMemo(() => {
    const typeMap = Object.fromEntries(getCalendarEventTypes(db).map(t => [t.value, t]));
    return getCalendarEvents(db)
      .filter(e => e.id !== event.id && typeMap[e.event_type]?.is_trip_type)
      .sort((a, b) => (b.date_from || '').localeCompare(a.date_from || ''));
  }, [db, event.id, dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // 원화는 환전 대상이 아니므로 환전/출금 통화 목록에서 제외한다
  const currencyOptions = useMemo(() => {
    const set = new Set(countries.map(c => String(c.currency).trim().toUpperCase()).filter(Boolean));
    wallets.forEach(w => set.add(w.currency));
    set.delete(KRW);
    return [...set].sort();
  }, [countries, wallets]);

  const run = (fn) => {
    try { fn(); setError(''); }
    catch (e) { setError(e.message); }
  };

  const totalKrwLeft = wallets.reduce((sum, w) => {
    if (w.balance <= 0) return sum;
    const rate = w.currency === KRW ? 1 : (w.avgRate || countries.find(c =>
      String(c.currency).trim().toUpperCase() === w.currency)?.exchange_rate || 0);
    return sum + w.balance * rate;
  }, 0);

  return (
    <ModalOverlay className="tc-overlay" panelClassName="tc-modal">
        <div className="tc-header">
          <div className="tc-header-left">
            <span className="tc-title">현금 관리</span>
            <span className="tc-subtitle">{event.title}</span>
          </div>
          <button className="tc-close" onClick={onClose}>✕</button>
        </div>

        {/* 남은 현금 요약 */}
        <div className="tc-summary">
          {wallets.length === 0 ? (
            <div className="tc-summary-empty">아직 환전/출금 기록이 없습니다</div>
          ) : (
            <>
              <div className="tc-summary-label">남은 현금</div>
              <div className="tc-summary-wallets">
                {wallets.map(w => (
                  <div key={w.currency} className={`tc-chip${w.balance < 0 ? ' tc-chip-neg' : ''}`}>
                    <span className="tc-chip-amount">{fmtCur(w.balance, w.currency)}</span>
                    <span className="tc-chip-cur">{w.currency}</span>
                  </div>
                ))}
              </div>
              {totalKrwLeft > 0 && (
                <div className="tc-summary-krw">≈ {formatAmount(Math.round(totalKrwLeft))}원</div>
              )}
            </>
          )}
        </div>

        <Tabs
          value={tab}
          onChange={t => { setTab(t); setError(''); }}
          items={[
            { value: 'wallets', label: '지갑' },
            { value: 'add', label: '환전/출금' },
            { value: 'reconcile', label: '실물 정산' },
            { value: 'close', label: '종료 처리' },
            { value: 'history', label: '내역' },
          ]}
        />

        {error && <div className="tc-error">{error}</div>}

        <div className="tc-body">
          {tab === 'wallets' && (
            <WalletList wallets={wallets} countries={countries} />
          )}
          {tab === 'add' && (
            <AddFlowForm
              event={event} accounts={accounts} currencyOptions={currencyOptions}
              onSubmit={payload => run(() => { addEventCashFlow(db, payload); bump(); setTab('wallets'); })}
            />
          )}
          {tab === 'reconcile' && (
            <ReconcileForm
              db={db} wallets={wallets} categories={categories} tripCategory={tripCategory}
              onSubmit={payload => run(() => { reconcileEventWallet(db, { ...payload, event_id: event.id }); bump(); setTab('wallets'); })}
            />
          )}
          {tab === 'close' && (
            <CloseForm
              db={db} eventId={event.id} wallets={wallets} accounts={accounts} tripEvents={tripEvents}
              categories={categories} tripCategory={tripCategory}
              onSubmit={payload => run(() => {
                const r = closeEventWallet(db, { ...payload, event_id: event.id });
                bump();
                if (r.mode === 'refund' && r.fx) {
                  setError(`처리 완료 — 환차${r.fx < 0 ? '손' : '익'} ${formatAmount(Math.abs(r.fx))}원${r.recordedFx ? ' (가계부에 기록)' : ''}`);
                } else {
                  setTab('wallets');
                }
              })}
            />
          )}
          {tab === 'history' && (
            <FlowHistory
              ledger={ledger} accounts={accounts}
              onDelete={handleDeleteFlow}
            />
          )}
        </div>
    </ModalOverlay>
  );
}

// ── 지갑 목록 ────────────────────────────────────────────────────
function WalletList({ wallets, countries }) {
  if (!wallets.length) {
    return <div className="tc-empty">환전/출금 탭에서 첫 기록을 추가하세요.</div>;
  }
  return (
    <>
      {wallets.map(w => {
        const setRate = countries.find(c =>
          String(c.currency).trim().toUpperCase() === w.currency)?.exchange_rate || 0;
        return (
          <div key={w.currency} className="tc-wallet">
            <div className="tc-wallet-head">
              <span className="tc-wallet-name">
                {w.country ? `${w.country} · ` : ''}{w.currency}
              </span>
              <span className={`tc-wallet-balance${w.balance < 0 ? ' neg' : ''}`}>
                {fmtCur(w.balance, w.currency)}
              </span>
            </div>
            <div className="tc-wallet-rows">
              <div><span>입금·환전</span><b>{fmtCur(w.inflow, w.currency)}</b></div>
              <div><span>현금 사용</span><b>{fmtCur(w.spent, w.currency)}</b></div>
              {w.currency !== KRW && (
                <div>
                  <span>평균 환율</span>
                  <b>{w.avgRate ? `${w.avgRate.toFixed(2)}원` : (setRate ? `${setRate}원 (수동)` : '—')}</b>
                </div>
              )}
              {w.krwCost > 0 && (
                <div><span>투입 원화</span><b>{formatAmount(w.krwCost)}원</b></div>
              )}
            </div>
            {w.balance < 0 && (
              <div className="tc-warn">사용액이 입금액보다 많습니다 — 환전 기록이 빠졌는지 확인하세요.</div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ── 환전/출금 추가 ───────────────────────────────────────────────
function AddFlowForm({ event, accounts, currencyOptions, onSubmit }) {
  const [date, setDate] = useState(event.date_from || today());
  const [currency, setCurrency] = useState(currencyOptions[0] || '');
  const [amount, setAmount] = useState('');
  const [krwCost, setKrwCost] = useState('');
  const [accountId, setAccountId] = useState('');
  const [note, setNote] = useState('');

  const qty = parseForeignAmount(amount);
  const cost = evaluateFormula(krwCost);
  const costValid = cost !== null && !isNaN(cost) && cost > 0;
  const rate = qty > 0 && costValid ? cost / qty : 0;

  const canSubmit = !!currency && qty !== null && qty > 0 && costValid;

  if (!currencyOptions.length) {
    return (
      <div className="tc-empty">
        이 일정에 여행 국가/화폐가 없습니다.<br />
        일정 수정에서 국가와 통화를 먼저 추가하세요.
      </div>
    );
  }

  return (
    <div className="tc-form">
      <div className="tc-hint">
        출금·환전은 <b>지출이 아니라 이동</b>입니다. 가계부 총액에는 잡히지 않고 지갑 잔액만 올라갑니다.
      </div>

      <div className="tc-row">
        <div className="tc-field">
          <label>날짜</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="tc-field tc-field-narrow">
          <label>통화</label>
          <select value={currency} onChange={e => setCurrency(e.target.value)}>
            {currencyOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div className="tc-field">
        <label>받은 금액 ({currency})</label>
        <AmountInput
          decimal unit={currency} value={amount} onChange={setAmount}
          placeholder="예: 10000"
        />
      </div>

      <div className="tc-field">
        <label>지불한 원화</label>
        <AmountInput
          value={krwCost} onChange={setKrwCost}
          placeholder="예: 87800"
        />
        {rate > 0 && (
          <span className="tc-rate-preview">
            실효 환율 1 {currency} = {rate.toFixed(2)}원 — 일정 환율로 자동 반영됩니다
          </span>
        )}
      </div>

      {accounts.length > 0 && (
        <div className="tc-field">
          <label>출금 계좌 <span className="tc-optional">(선택)</span></label>
          <select value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">계좌 반영 안 함</option>
            {accounts.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
          </select>
          <span className="tc-note-sm">선택하면 해당 계좌에서 출금으로 함께 기록됩니다.</span>
        </div>
      )}

      <div className="tc-field">
        <label>메모 <span className="tc-optional">(선택)</span></label>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="예: 공항 환전소" />
      </div>

      <button
        className="tc-submit" disabled={!canSubmit}
        onClick={() => onSubmit({
          event_id: event.id, date, type: 'exchange', currency,
          amount: qty, krw_cost: cost, account_id: accountId ? Number(accountId) : null, note,
        })}
      >지갑에 추가</button>
    </div>
  );
}

// ── 실물 정산 ────────────────────────────────────────────────────
function ReconcileForm({ db, wallets, categories, tripCategory, onSubmit }) {
  const [currency, setCurrency] = useState(wallets[0]?.currency || KRW);
  const [actual, setActual] = useState('');
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState('expense');
  const [category, setCategory] = useState(tripCategory || '');
  const [subCategory, setSubCategory] = useState('');

  const subs = useMemo(() => getSubCategories(db, category), [db, category]);
  const wallet = wallets.find(w => w.currency === currency);
  const actualNum = parseForeignAmount(actual);
  const diff = wallet && actualNum !== null
    ? Number((actualNum - wallet.balance).toFixed(2)) : null;

  // 현금이 비면 대개 기록 못 한 지출, 남으면 입력 실수 → 남을 땐 지갑만 조정
  const effectiveMode = diff !== null && diff > 0 ? 'adjust' : mode;

  // 지출로 기록하면 가계부 거래가 생기므로 분류가 있어야 한다 (세부카테고리가 있는 카테고리면 그것도)
  const needsCategory = effectiveMode === 'expense' && diff !== null && diff < 0;
  const categoryMissing = needsCategory && (!category || (subs.length > 0 && !subCategory));

  if (!wallets.length) return <div className="tc-empty">먼저 환전/출금을 기록하세요.</div>;

  return (
    <div className="tc-form">
      <div className="tc-hint">
        지갑을 직접 세어 본 금액을 넣으면 계산상 잔액과의 차이를 정리합니다.
      </div>

      <div className="tc-row">
        <div className="tc-field tc-field-narrow">
          <label>통화</label>
          <select value={currency} onChange={e => { setCurrency(e.target.value); setActual(''); }}>
            {wallets.map(w => <option key={w.currency} value={w.currency}>{w.currency}</option>)}
          </select>
        </div>
        <div className="tc-field">
          <label>날짜</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
      </div>

      <div className="tc-compare">
        <div><span>계산상 잔액</span><b>{fmtCur(wallet?.balance || 0, currency)} {currency}</b></div>
      </div>

      <div className="tc-field">
        <label>실제 남은 금액 ({currency})</label>
        <AmountInput
          decimal unit={currency} value={actual} onChange={setActual}
          placeholder="지갑을 세어 본 금액 (예: 5000+2000+500)"
        />
      </div>

      {diff !== null && diff !== 0 && (
        <>
          <div className={`tc-diff${diff < 0 ? ' neg' : ' pos'}`}>
            <b>차이 {diff > 0 ? '+' : ''}{fmtCur(diff, currency)} {currency}</b>
            <span>{diff < 0 ? '기록보다 현금이 적습니다' : '기록보다 현금이 많습니다'}</span>
          </div>

          {diff < 0 ? (
            <div className="tc-field">
              <label>처리 방법</label>
              <div className="tc-modes">
                <button
                  type="button" className={`tc-mode${effectiveMode === 'expense' ? ' active' : ''}`}
                  onClick={() => setMode('expense')}
                >
                  <b>지출로 기록</b>
                  <span>가계부에 미기록 현금 지출로 남깁니다</span>
                </button>
                <button
                  type="button" className={`tc-mode${effectiveMode === 'adjust' ? ' active' : ''}`}
                  onClick={() => setMode('adjust')}
                >
                  <b>지갑만 조정</b>
                  <span>가계부는 그대로 두고 잔액만 맞춥니다</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="tc-note-sm">현금이 더 많으므로 지갑 잔액만 조정합니다.</div>
          )}

          {needsCategory && (
            <div className="tc-row">
              <div className="tc-field">
                <label>카테고리</label>
                <select value={category} onChange={e => { setCategory(e.target.value); setSubCategory(''); }}>
                  <option value="">선택</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="tc-field">
                <label>세부카테고리</label>
                <select value={subCategory} onChange={e => setSubCategory(e.target.value)} disabled={!category}>
                  <option value="">선택</option>
                  {subs.map(sc => <option key={sc} value={sc}>{sc}</option>)}
                </select>
              </div>
            </div>
          )}
          {categoryMissing && (
            <div className="tc-note-sm">지출로 기록하려면 카테고리와 세부카테고리를 선택하세요.</div>
          )}
        </>
      )}

      <button
        className="tc-submit" disabled={diff === null || diff === 0 || categoryMissing}
        onClick={() => onSubmit({
          currency, actual: actualNum, date, mode: effectiveMode,
          budget_category: category, sub_category: subCategory,
        })}
      >{diff === 0 && actual ? '차이 없음' : '정산하기'}</button>
    </div>
  );
}

// ── 여행 종료 처리 ───────────────────────────────────────────────
function CloseForm({ db, eventId, wallets, accounts, tripEvents, categories, tripCategory, onSubmit }) {
  const open = wallets.filter(w => Math.abs(w.balance) >= 0.005);
  const [currency, setCurrency] = useState(open[0]?.currency || '');
  const [mode, setMode] = useState('refund');
  const [date, setDate] = useState(today());
  const [receivedKrw, setReceivedKrw] = useState('');
  const [accountId, setAccountId] = useState('');
  const [targetEventId, setTargetEventId] = useState('');
  const [recordFx, setRecordFx] = useState(true);
  const [category, setCategory] = useState(tripCategory || '');
  const [subCategory, setSubCategory] = useState('');

  const subs = useMemo(() => getSubCategories(db, category), [db, category]);
  const wallet = open.find(w => w.currency === currency);

  const isKrw = wallet?.currency === KRW;
  // 잔액이 음수면 환전 기록이 빠진 것 — 재환전·이월은 막고 비우기만 허용한다
  const isNegative = !!wallet && wallet.balance < 0;
  const effectiveMode = isNegative ? 'writeoff' : mode;

  // 원가 환율은 DB(closeEventWallet)와 같은 규칙: 평균 취득 환율, 없으면 일정에 설정된 환율
  const rate = wallet ? getWalletRate(db, eventId, wallet) : 0;
  const basis = wallet ? Math.round(wallet.balance * rate) : 0;
  const received = evaluateFormula(receivedKrw);
  const receivedValid = received !== null && !isNaN(received) && received >= 0;
  const fx = receivedValid && basis > 0 ? received - basis : null;

  // 화면에 체크박스가 보일 때만 환차손익을 기록한다
  const showFxOption = effectiveMode === 'refund' && fx !== null && fx !== 0 && !isKrw;
  const willRecordFx = showFxOption && recordFx;
  const fxCategoryMissing = willRecordFx && (!category || (subs.length > 0 && !subCategory));

  if (!open.length) {
    return <div className="tc-empty">정리할 잔액이 없습니다. 모든 지갑이 비어 있습니다.</div>;
  }

  const canSubmit = effectiveMode === 'refund'
    ? receivedValid && !fxCategoryMissing
    : effectiveMode === 'carryover' ? !!targetEventId : true;

  return (
    <div className="tc-form">
      <div className="tc-row">
        <div className="tc-field tc-field-narrow">
          <label>통화</label>
          <select value={currency} onChange={e => setCurrency(e.target.value)}>
            {open.map(w => <option key={w.currency} value={w.currency}>{w.currency}</option>)}
          </select>
        </div>
        <div className="tc-field">
          <label>날짜</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
      </div>

      <div className="tc-compare">
        <div><span>남은 금액</span><b>{fmtCur(wallet?.balance || 0, currency)} {currency}</b></div>
        {!isKrw && basis > 0 && (
          <div>
            <span>취득 원가{wallet && !wallet.avgRate ? ' (일정 환율 기준)' : ''}</span>
            <b>{formatAmount(basis)}원</b>
          </div>
        )}
      </div>

      {isNegative && (
        <div className="tc-warn">
          잔액이 음수입니다 — 환전 기록이 빠졌다면 '환전/출금' 탭에서 추가하세요.
          기록 없이 잔액만 0으로 맞추려면 아래 '지갑에서 비우기'로 처리합니다.
        </div>
      )}

      <div className="tc-field">
        <label>처리 방법</label>
        <div className="tc-modes">
          <button
            type="button" className={`tc-mode${effectiveMode === 'refund' ? ' active' : ''}`}
            onClick={() => setMode('refund')} disabled={isNegative}
          >
            <b>{isKrw ? '계좌 입금' : '재환전 후 입금'}</b>
            <span>남은 현금을 원화로 회수합니다</span>
          </button>
          <button
            type="button" className={`tc-mode${effectiveMode === 'carryover' ? ' active' : ''}`}
            onClick={() => setMode('carryover')} disabled={isNegative}
          >
            <b>다음 여행으로 이월</b>
            <span>취득 원가와 함께 다른 일정으로 넘깁니다</span>
          </button>
          <button type="button" className={`tc-mode${effectiveMode === 'writeoff' ? ' active' : ''}`} onClick={() => setMode('writeoff')}>
            <b>지갑에서 비우기</b>
            <span>집에 보관 등 — 잔액만 0으로 만듭니다</span>
          </button>
        </div>
      </div>

      {effectiveMode === 'refund' && (
        <>
          <div className="tc-field">
            <label>실제로 받은 원화</label>
            <AmountInput
              value={receivedKrw} onChange={setReceivedKrw}
              placeholder={basis > 0 ? `예: ${basis}` : '예: 35000'}
            />
            {fx !== null && fx !== 0 && (
              <span className={`tc-fx${fx < 0 ? ' neg' : ' pos'}`}>
                환차{fx < 0 ? '손' : '익'} {formatAmount(Math.abs(fx))}원 (취득 원가 {formatAmount(basis)}원 대비)
              </span>
            )}
          </div>

          {accounts.length > 0 && (
            <div className="tc-field">
              <label>입금 계좌 <span className="tc-optional">(선택)</span></label>
              <select value={accountId} onChange={e => setAccountId(e.target.value)}>
                <option value="">계좌 반영 안 함</option>
                {accounts.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
              </select>
            </div>
          )}

          {showFxOption && (
            <>
              <label className="tc-check">
                <input type="checkbox" checked={recordFx} onChange={e => setRecordFx(e.target.checked)} />
                <span>환차{fx < 0 ? '손' : '익'}을 가계부에도 기록 (여행 총비용이 정확해집니다)</span>
              </label>
              {fxCategoryMissing && (
                <div className="tc-note-sm">가계부에 기록하려면 카테고리와 세부카테고리를 선택하세요.</div>
              )}
              {recordFx && (
                <div className="tc-row">
                  <div className="tc-field">
                    <label>카테고리</label>
                    <select value={category} onChange={e => { setCategory(e.target.value); setSubCategory(''); }}>
                      <option value="">선택</option>
                      {categories.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="tc-field">
                    <label>세부카테고리</label>
                    <select value={subCategory} onChange={e => setSubCategory(e.target.value)} disabled={!category}>
                      <option value="">선택</option>
                      {subs.map(sc => <option key={sc} value={sc}>{sc}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {effectiveMode === 'carryover' && (
        <div className="tc-field">
          <label>이월할 일정</label>
          {tripEvents.length === 0 ? (
            <div className="tc-note-sm">이월할 다른 여행 일정이 없습니다. 먼저 일정을 만들어 주세요.</div>
          ) : (
            <select value={targetEventId} onChange={e => setTargetEventId(e.target.value)}>
              <option value="">선택</option>
              {tripEvents.map(ev => (
                <option key={ev.id} value={String(ev.id)}>
                  {ev.title}{ev.date_from ? ` (${ev.date_from})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <button
        className="tc-submit" disabled={!canSubmit}
        onClick={() => onSubmit({
          currency, mode: effectiveMode, date,
          received_krw: received, account_id: accountId ? Number(accountId) : null,
          target_event_id: targetEventId ? Number(targetEventId) : null,
          record_fx: willRecordFx, budget_category: category, sub_category: subCategory,
        })}
      >처리하기</button>
    </div>
  );
}

// ── 내역 (환전 흐름 + 실제 현금 사용) ──────────────────────────
function FlowHistory({ ledger, accounts, onDelete }) {
  if (!ledger.length) return <div className="tc-empty">기록이 없습니다.</div>;
  const acctName = id => accounts.find(a => a.id === id)?.name || '';

  // 통화별 잔액이 어떻게 흘러왔는지 보이도록 누적 잔액을 계산한다
  const running = {};
  const rows = ledger.map(r => {
    running[r.currency] = (running[r.currency] || 0) + r.amount;
    return { ...r, balance: running[r.currency] };
  });

  return (
    <>
      {rows.slice().reverse().map(r => (
        <div key={`${r.kind}-${r.id}`} className={`tc-flow${r.kind === 'spend' ? ' tc-flow-spend' : ''}`}>
          <div className="tc-flow-main">
            <div className="tc-flow-top">
              <span className={`tc-flow-type${r.kind === 'spend' ? ' tc-flow-type-spend' : ''}`}>
                {r.kind === 'spend' ? '현금 사용' : (FLOW_LABEL[r.type] || r.type)}
              </span>
              <span className="tc-flow-date">{r.date}</span>
              {r.is_split && <span className="tc-flow-split" title="분할 결제">🔗</span>}
            </div>
            {(r.note || r.account_id) && (
              <div className="tc-flow-note">
                {r.note}{r.account_id ? `${r.note ? ' · ' : ''}${acctName(r.account_id)}` : ''}
              </div>
            )}
          </div>
          <div className="tc-flow-right">
            <span className={`tc-flow-amount${r.amount < 0 ? ' neg' : ''}`}>
              {r.amount > 0 ? '+' : ''}{fmtCur(r.amount, r.currency)} {r.currency}
            </span>
            <span className="tc-flow-sub">
              {r.kind === 'spend'
                ? `${formatAmount(r.krw_cost)}원`
                : (r.krw_cost > 0 ? `${formatAmount(r.krw_cost)}원` : '')}
              <span className="tc-flow-running">잔액 {fmtCur(r.balance, r.currency)}</span>
            </span>
          </div>
          {r.kind === 'flow' ? (
            <button className="tc-flow-del" onClick={() => onDelete(r.id)} title="삭제">✕</button>
          ) : (
            <span className="tc-flow-del-spacer" />
          )}
        </div>
      ))}
    </>
  );
}
