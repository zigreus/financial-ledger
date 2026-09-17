import React, { useState, useMemo, useCallback } from 'react';
import {
  getEventWallets, getEventCashFlows, addEventCashFlow, deleteEventCashFlow,
  reconcileEventWallet, closeEventWallet,
  getEventCountries, getAllAccounts, getDefaultAccount,
  getBudgetCategories, getSubCategories, getTripDefaultCategory,
  getCalendarEvents, getCalendarEventTypes,
} from '../../services/dbManager';
import { evaluateFormula, parseForeignAmount, formatAmount, today } from '../../services/formulaEvaluator';
import './TripCashModal.css';

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

export default function TripCashModal({ db, event, onClose, onChanged }) {
  const [tab, setTab] = useState('wallets');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');

  const bump = useCallback(() => {
    setVersion(v => v + 1);
    onChanged?.();
  }, [onChanged]);

  // version은 sql.js DB가 제자리에서 바뀌므로 다시 읽기 위한 캐시 무효화 키
  /* eslint-disable react-hooks/exhaustive-deps */
  const wallets = useMemo(() => getEventWallets(db, event.id), [db, event.id, version]);
  const flows = useMemo(() => getEventCashFlows(db, event.id), [db, event.id, version]);
  const countries = useMemo(() => getEventCountries(db, event.id), [db, event.id, version]);
  /* eslint-enable react-hooks/exhaustive-deps */
  const accounts = useMemo(() => getAllAccounts(db), [db]);
  const categories = useMemo(() => getBudgetCategories(db), [db]);
  const tripCategory = useMemo(() => getTripDefaultCategory(db), [db]);

  // 이월 대상 후보 — 다른 여행 유형 일정
  const tripEvents = useMemo(() => {
    const typeMap = Object.fromEntries(getCalendarEventTypes(db).map(t => [t.value, t]));
    return getCalendarEvents(db)
      .filter(e => e.id !== event.id && typeMap[e.event_type]?.is_trip_type)
      .sort((a, b) => (b.date_from || '').localeCompare(a.date_from || ''));
  }, [db, event.id]);

  const currencyOptions = useMemo(() => {
    const set = new Set(countries.map(c => String(c.currency).trim().toUpperCase()).filter(Boolean));
    wallets.forEach(w => set.add(w.currency));
    set.add(KRW);
    return [...set].sort((a, b) => (a === KRW ? 1 : 0) - (b === KRW ? 1 : 0) || a.localeCompare(b));
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
    <div className="tc-overlay" onClick={onClose}>
      <div className="tc-modal" onClick={e => e.stopPropagation()}>
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
              defaultAccount={getDefaultAccount(db)}
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
              db={db} wallets={wallets} accounts={accounts} tripEvents={tripEvents}
              categories={categories} tripCategory={tripCategory}
              defaultAccount={getDefaultAccount(db)}
              onSubmit={payload => run(() => {
                const r = closeEventWallet(db, { ...payload, event_id: event.id });
                bump();
                if (r.mode === 'refund' && r.fx) {
                  setError(`처리 완료 — 환차${r.fx < 0 ? '손' : '익'} ${formatAmount(Math.abs(r.fx))}원`);
                } else {
                  setTab('wallets');
                }
              })}
            />
          )}
          {tab === 'history' && (
            <FlowHistory
              flows={flows} accounts={accounts}
              onDelete={id => run(() => { deleteEventCashFlow(db, id); bump(); })}
            />
          )}
        </div>
      </div>
    </div>
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
function AddFlowForm({ event, accounts, currencyOptions, defaultAccount, onSubmit }) {
  const [date, setDate] = useState(event.date_from || today());
  const [currency, setCurrency] = useState(currencyOptions[0] || KRW);
  const [amount, setAmount] = useState('');
  const [krwCost, setKrwCost] = useState('');
  const [accountId, setAccountId] = useState(defaultAccount ? String(defaultAccount.id) : '');
  const [note, setNote] = useState('');

  const isKrw = currency === KRW;
  const qty = parseForeignAmount(amount);
  const cost = isKrw ? (qty === null ? null : Math.round(qty)) : evaluateFormula(krwCost);
  const costValid = cost !== null && !isNaN(cost) && cost > 0;
  const rate = !isKrw && qty > 0 && costValid ? cost / qty : 0;

  const canSubmit = qty !== null && qty > 0 && costValid;

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
        <label>{isKrw ? '출금액 (원)' : `받은 금액 (${currency})`}</label>
        <input
          type="text" inputMode="decimal" value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder={isKrw ? '예: 300000' : '예: 10000'}
        />
      </div>

      {!isKrw && (
        <div className="tc-field">
          <label>지불한 원화</label>
          <input
            type="text" inputMode="decimal" value={krwCost}
            onChange={e => setKrwCost(e.target.value)}
            placeholder="예: 87800"
          />
          {rate > 0 && (
            <span className="tc-rate-preview">
              실효 환율 1 {currency} = {rate.toFixed(2)}원 — 일정 환율로 자동 반영됩니다
            </span>
          )}
        </div>
      )}

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
        <input
          type="text" inputMode="decimal" value={actual}
          onChange={e => setActual(e.target.value)}
          placeholder="지갑을 세어 본 금액"
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

          {effectiveMode === 'expense' && diff < 0 && (
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

      <button
        className="tc-submit" disabled={diff === null || diff === 0}
        onClick={() => onSubmit({
          currency, actual: actualNum, date, mode: effectiveMode,
          budget_category: category, sub_category: subCategory,
        })}
      >{diff === 0 && actual ? '차이 없음' : '정산하기'}</button>
    </div>
  );
}

// ── 여행 종료 처리 ───────────────────────────────────────────────
function CloseForm({ db, wallets, accounts, tripEvents, categories, tripCategory, defaultAccount, onSubmit }) {
  const open = wallets.filter(w => Math.abs(w.balance) >= 0.005);
  const [currency, setCurrency] = useState(open[0]?.currency || '');
  const [mode, setMode] = useState('refund');
  const [date, setDate] = useState(today());
  const [receivedKrw, setReceivedKrw] = useState('');
  const [accountId, setAccountId] = useState(defaultAccount ? String(defaultAccount.id) : '');
  const [targetEventId, setTargetEventId] = useState('');
  const [recordFx, setRecordFx] = useState(true);
  const [category, setCategory] = useState(tripCategory || '');
  const [subCategory, setSubCategory] = useState('');

  const subs = useMemo(() => getSubCategories(db, category), [db, category]);
  const wallet = open.find(w => w.currency === currency);

  const isKrw = wallet?.currency === KRW;
  const basis = wallet ? Math.round(wallet.balance * (isKrw ? 1 : wallet.avgRate || 0)) : 0;
  const received = evaluateFormula(receivedKrw);
  const receivedValid = received !== null && !isNaN(received) && received >= 0;
  const fx = receivedValid && basis > 0 ? received - basis : null;

  if (!open.length) {
    return <div className="tc-empty">정리할 잔액이 없습니다. 모든 지갑이 비어 있습니다.</div>;
  }

  const canSubmit = mode === 'refund'
    ? receivedValid
    : mode === 'carryover' ? !!targetEventId : true;

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
          <div><span>취득 원가</span><b>{formatAmount(basis)}원</b></div>
        )}
      </div>

      <div className="tc-field">
        <label>처리 방법</label>
        <div className="tc-modes">
          <button type="button" className={`tc-mode${mode === 'refund' ? ' active' : ''}`} onClick={() => setMode('refund')}>
            <b>{isKrw ? '계좌 입금' : '재환전 후 입금'}</b>
            <span>남은 현금을 원화로 회수합니다</span>
          </button>
          <button type="button" className={`tc-mode${mode === 'carryover' ? ' active' : ''}`} onClick={() => setMode('carryover')}>
            <b>다음 여행으로 이월</b>
            <span>취득 원가와 함께 다른 일정으로 넘깁니다</span>
          </button>
          <button type="button" className={`tc-mode${mode === 'writeoff' ? ' active' : ''}`} onClick={() => setMode('writeoff')}>
            <b>지갑에서 비우기</b>
            <span>집에 보관 등 — 잔액만 0으로 만듭니다</span>
          </button>
        </div>
      </div>

      {mode === 'refund' && (
        <>
          <div className="tc-field">
            <label>실제로 받은 원화</label>
            <input
              type="text" inputMode="decimal" value={receivedKrw}
              onChange={e => setReceivedKrw(e.target.value)}
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

          {fx !== null && fx !== 0 && !isKrw && (
            <>
              <label className="tc-check">
                <input type="checkbox" checked={recordFx} onChange={e => setRecordFx(e.target.checked)} />
                <span>환차{fx < 0 ? '손' : '익'}을 가계부에도 기록 (여행 총비용이 정확해집니다)</span>
              </label>
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

      {mode === 'carryover' && (
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
          currency, mode, date,
          received_krw: received, account_id: accountId ? Number(accountId) : null,
          target_event_id: targetEventId ? Number(targetEventId) : null,
          record_fx: recordFx, budget_category: category, sub_category: subCategory,
        })}
      >처리하기</button>
    </div>
  );
}

// ── 내역 ─────────────────────────────────────────────────────────
function FlowHistory({ flows, accounts, onDelete }) {
  if (!flows.length) return <div className="tc-empty">기록이 없습니다.</div>;
  const acctName = id => accounts.find(a => a.id === id)?.name || '';
  return (
    <>
      {[...flows].reverse().map(f => (
        <div key={f.id} className="tc-flow">
          <div className="tc-flow-main">
            <div className="tc-flow-top">
              <span className="tc-flow-type">{FLOW_LABEL[f.type] || f.type}</span>
              <span className="tc-flow-date">{f.date}</span>
            </div>
            {(f.note || f.account_id) && (
              <div className="tc-flow-note">
                {f.note}{f.account_id ? `${f.note ? ' · ' : ''}${acctName(f.account_id)}` : ''}
              </div>
            )}
          </div>
          <div className="tc-flow-right">
            <span className={`tc-flow-amount${f.amount < 0 ? ' neg' : ''}`}>
              {f.amount > 0 ? '+' : ''}{fmtCur(f.amount, f.currency)} {f.currency}
            </span>
            {f.krw_cost > 0 && <span className="tc-flow-krw">{formatAmount(f.krw_cost)}원</span>}
          </div>
          <button className="tc-flow-del" onClick={() => onDelete(f.id)} title="삭제">✕</button>
        </div>
      ))}
    </>
  );
}
