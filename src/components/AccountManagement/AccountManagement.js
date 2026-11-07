import React, { useState, useMemo } from 'react';
import {
  getAllAccounts, getAccount, getDefaultAccount, getAccountsActualBalances,
  addAccount, updateAccount, deleteAccount, setDefaultAccount,
  getRecurringItems, addRecurringItem, updateRecurringItem, deleteRecurringItem,
  getAccountTransactions, addAccountTransaction, updateAccountTransaction, deleteAccountTransaction,
  bulkInsertAccountTransactions, getPaymentMethods,
} from '../../services/dbManager';
import ModalOverlay from '../common/ModalOverlay';
import AmountInput from '../common/AmountInput';
import { useStoredToggle } from '../../hooks/useStoredToggle';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';
import { evaluateFormula } from '../../services/formulaEvaluator';
import { parseCSV } from '../../services/csv';
import {
  normalizeDateStr, parseImportAmount, markDuplicates,
  accountTxDuplicateKey, countExistingAccountTransactions,
} from '../../services/importHelpers';
import './AccountManagement.css';
import { todayStr } from '../../services/dateUtils';

// ── 날짜 포맷 헬퍼 ──────────────────────────────────────────────
const THIS_YEAR = new Date().getFullYear();

function fmt(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  return year !== THIS_YEAR
    ? `${parts[0]}/${parts[1]}/${parts[2]}`
    : `${parts[1]}/${parts[2]}`;
}


function fmtAmount(n) {
  return Number(n).toLocaleString();
}

/**
 * 각 거래 후 잔액과 현재 잔액 (B-022)
 * current_balance = 잔액 기준일(balance_date)이 시작될 때의 잔액이다.
 *  - 기준일부터(당일 포함) 오늘까지의 거래만 더해 현재 잔액을 낸다 (dbManager.getAccountsActualBalances와 같은 규칙)
 *  - 기준일 이전 거래는 이미 기준 잔액에 들어 있으므로 더하지 않고, 기준 잔액에서 거꾸로 되돌려 그때의 잔액만 보여 준다
 *  - 기준일이 비어 있으면(예전 계좌) 모든 거래를 더한다
 */
function computeRunningBalances(account, descTransactions) {
  const ascTxs = [...descTransactions].reverse();
  const startBalance = account.current_balance || 0;
  const baseDate = account.balance_date || '';
  const effect = (tx) => (tx.type === 'income' ? tx.amount : -tx.amount);
  const before = ascTxs.filter(tx => tx.date < baseDate);
  const after = ascTxs.filter(tx => tx.date >= baseDate);

  const balanceAfterMap = {};
  let back = startBalance;
  for (let i = before.length - 1; i >= 0; i--) {
    balanceAfterMap[before[i].id] = back;
    back -= effect(before[i]);
  }

  const today = todayStr();
  let running = startBalance;
  let currentBalance = startBalance;
  for (const tx of after) {
    running += effect(tx);
    balanceAfterMap[tx.id] = running;
    if (tx.date <= today) currentBalance = running;
  }

  return { balanceAfterMap, currentBalance };
}


// ── 메인 컴포넌트 ────────────────────────────────────────────────

export default function AccountManagement({ db, dataVersion, drilldown, detailTab, showForm, onDrilldownChange, onDetailTabChange, onCloseForm, onChanged }) {
  // DB 쓰기마다 바뀌는 참조 — 변경 직후 목록·잔액이 바로 다시 계산된다 (B-014)
  const live = useDbSnapshot(db, dataVersion);
  const accounts = useMemo(() => live.db ? getAllAccounts(live.db) : [], [live]);
  const defaultAccount = useMemo(() => live.db ? getDefaultAccount(live.db) : null, [live]);

  // 첫 진입 시 기본 계좌가 있으면 바로 드릴다운
  const [autoNavigated, setAutoNavigated] = useState(false);
  React.useEffect(() => {
    if (!autoNavigated && drilldown === null && defaultAccount) {
      setAutoNavigated(true);
      onDrilldownChange({ id: defaultAccount.id });
    }
  }, [autoNavigated, drilldown, defaultAccount, onDrilldownChange]);

  if (drilldown && drilldown.id) {
    return (
      <AccountDetail
        db={db}
        dataVersion={dataVersion}
        accountId={drilldown.id}
        activeTab={detailTab}
        showNavForm={showForm}
        onNavFormClose={onCloseForm}
        onTabChange={onDetailTabChange}
        onBack={() => { setAutoNavigated(true); onDrilldownChange(null); }}
        onChanged={onChanged}
      />
    );
  }

  return (
    <AccountList
      db={db}
      dataVersion={dataVersion}
      accounts={accounts}
      defaultAccountId={defaultAccount?.id}
      showNavForm={showForm}
      onNavFormClose={onCloseForm}
      onSelect={(id) => onDrilldownChange({ id })}
      onChanged={onChanged}
    />
  );
}

// ── 계좌 목록 화면 ───────────────────────────────────────────────

function AccountList({ db, dataVersion, accounts, defaultAccountId, showNavForm, onNavFormClose, onSelect, onChanged }) {
  const [showForm, setShowForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const live = useDbSnapshot(db, dataVersion);

  // 거래 내역을 반영한 실제 현재 잔액 (기준 잔액 + 잔액 기준일~오늘 거래)
  const actualBalances = useMemo(() => {
    if (!live.db) return {};
    const txSums = getAccountsActualBalances(live.db);
    const result = {};
    accounts.forEach(acc => {
      result[acc.id] = (acc.current_balance || 0) + (txSums[acc.id] || 0);
    });
    return result;
  }, [live, accounts]);

  // 네비 ➕ 버튼으로 열기
  React.useEffect(() => {
    if (showNavForm) { setEditingAccount(null); setShowForm(true); }
  }, [showNavForm]);

  const handleSetDefault = async (id) => {
    setDefaultAccount(db, id === defaultAccountId ? null : id);
    await onChanged();
  };

  const handleDelete = async (id) => {
    if (!window.confirm('이 계좌를 삭제하시겠습니까?\n연결된 거래 내역은 유지됩니다.')) return;
    deleteAccount(db, id);
    await onChanged();
  };

  return (
    <div className="acct-container">
      <div className="acct-list-header">
        <h2 className="acct-title">내 계좌</h2>
        <button className="acct-btn-add" onClick={() => { setEditingAccount(null); setShowForm(true); }}>
          + 계좌 추가
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className="acct-empty">
          <p>등록된 계좌가 없습니다.</p>
          <button className="btn-primary" onClick={() => setShowForm(true)}>첫 계좌 추가하기</button>
        </div>
      ) : (
        <ul className="acct-list">
          {accounts.map(acc => (
            <li key={acc.id} className="acct-item" onClick={() => onSelect(acc.id)}>
              <div className="acct-item-main">
                <div className="acct-item-name">
                  {acc.name}
                  {acc.id === defaultAccountId && <span className="acct-badge-default">기본</span>}
                </div>
                <div className="acct-item-bank">{acc.bank}</div>
              </div>
              <div className="acct-item-right">
                <div className={`acct-item-balance${(actualBalances[acc.id] ?? 0) < 0 ? ' negative' : ''}`}>
                  {fmtAmount(actualBalances[acc.id] ?? acc.current_balance)}원
                </div>
                <div className="acct-item-actions" onClick={e => e.stopPropagation()}>
                  <button
                    className={`acct-btn-sm${acc.id === defaultAccountId ? ' active' : ''}`}
                    onClick={() => handleSetDefault(acc.id)}
                    title="기본 계좌 설정"
                  >
                    {acc.id === defaultAccountId ? '★' : '☆'}
                  </button>
                  <button className="acct-btn-sm" onClick={() => { setEditingAccount(acc); setShowForm(true); }} title="편집">
                    ✏️
                  </button>
                  <button className="acct-btn-sm acct-btn-danger" onClick={() => handleDelete(acc.id)} title="삭제">
                    🗑️
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {showForm && (
        <AccountForm
          db={db}
          account={editingAccount}
          onSave={async (data) => {
            if (editingAccount) {
              updateAccount(db, editingAccount.id, data);
            } else {
              addAccount(db, data);
            }
            setShowForm(false);
            if (onNavFormClose) onNavFormClose();
            await onChanged();
          }}
          onCancel={() => { setShowForm(false); if (onNavFormClose) onNavFormClose(); }}
        />
      )}
    </div>
  );
}

// ── 계좌 상세 화면 ───────────────────────────────────────────────

function AccountDetail({ db, dataVersion, accountId, activeTab, showNavForm, onNavFormClose, onTabChange, onBack, onChanged }) {
  const live = useDbSnapshot(db, dataVersion);
  const account = useMemo(() => live.db ? getAccount(live.db, accountId) : null, [live, accountId]);
  const transactions = useMemo(
    () => live.db ? getAccountTransactions(live.db, accountId) : [],
    [live, accountId]
  );
  const { balanceAfterMap, currentBalance } = useMemo(
    () => account ? computeRunningBalances(account, transactions) : { balanceAfterMap: {}, currentBalance: 0 },
    [account, transactions]
  );
  const [showTxForm, setShowTxForm] = useState(false);
  const [editingTx, setEditingTx] = useState(null);
  const [showImport, setShowImport] = useState(false);

  // 네비 ➕ 버튼으로 거래 추가 폼 열기
  React.useEffect(() => {
    if (showNavForm) { setEditingTx(null); setShowTxForm(true); }
  }, [showNavForm]);

  if (!account) return <div className="acct-container"><button onClick={onBack}>← 뒤로</button></div>;

  const tab = activeTab || 'transactions';
  const closeTxForm = () => { setShowTxForm(false); setEditingTx(null); if (onNavFormClose) onNavFormClose(); };

  return (
    <div className="acct-container">
      {/* 상단 헤더 */}
      <div className="acct-detail-header">
        <button className="acct-btn-back" onClick={onBack}>←</button>
        <div className="acct-detail-title">
          <span className="acct-detail-name">{account.name}</span>
          <span className="acct-detail-bank">{account.bank}</span>
        </div>
        <div className="acct-detail-balance">
          <span className="acct-detail-balance-label">현재 잔액</span>
          <span className={`acct-detail-balance-amount${currentBalance < 0 ? ' negative' : ''}`}>
            {fmtAmount(currentBalance)}원
          </span>
        </div>
      </div>

      {/* 탭 */}
      <div className="acct-tabs">
        {['transactions', 'settings'].map(t => (
          <button
            key={t}
            className={`acct-tab${tab === t ? ' active' : ''}`}
            onClick={() => onTabChange(t)}
          >
            {t === 'transactions' ? '내역' : '설정'}
          </button>
        ))}
      </div>

      {tab === 'transactions' && (
        <TransactionsTab
          db={db}
          transactions={transactions}
          balanceAfterMap={balanceAfterMap}
          onOpenAdd={() => { setEditingTx(null); setShowTxForm(true); }}
          onOpenEdit={(tx) => { setEditingTx(tx); setShowTxForm(true); }}
          onOpenImport={() => setShowImport(true)}
          onChanged={onChanged}
        />
      )}
      {showImport && (
        <AccountImportModal
          db={db}
          accountId={accountId}
          onImport={async () => { setShowImport(false); await onChanged(); }}
          onClose={() => setShowImport(false)}
        />
      )}
      {tab === 'settings' && (
        <AccountSettingsTab db={db} dataVersion={dataVersion} account={account} onChanged={onChanged} onBack={onBack} />
      )}

      {/* 거래 추가/수정 폼 — 탭에 무관하게 AccountDetail 레벨에서 렌더링 */}
      {showTxForm && (
        <AccountTxForm
          db={db}
          accountId={accountId}
          tx={editingTx}
          onSave={async (data, { keepOpen = false } = {}) => {
            if (editingTx) {
              updateAccountTransaction(db, editingTx.id, data);
            } else {
              addAccountTransaction(db, { ...data, account_id: accountId });
            }
            // 연속 입력 중이면 폼을 열어둔 채 뒤에서 저장한다
            if (!keepOpen) closeTxForm();
            await onChanged();
          }}
          onCancel={closeTxForm}
        />
      )}
    </div>
  );
}

// ── 내역 탭 ──────────────────────────────────────────────────────

function TransactionsTab({ db, transactions, balanceAfterMap, onOpenAdd, onOpenEdit, onOpenImport, onChanged }) {
  // 현재 월만 기본 펼침, 지난 월은 접힘
  const [expandedMonths, setExpandedMonths] = useState(() => new Set([todayStr().slice(0, 7)]));
  const [expandedDates, setExpandedDates] = useState(new Set());

  const toggleMonth = (ym) => setExpandedMonths(prev => {
    const next = new Set(prev);
    if (next.has(ym)) next.delete(ym); else next.add(ym);
    return next;
  });

  const toggleDate = (date) => setExpandedDates(prev => {
    const next = new Set(prev);
    if (next.has(date)) next.delete(date); else next.add(date);
    return next;
  });

  // 월 → 일 → 건 3단계 그룹화 (전체 DESC 순서 유지)
  const monthGroups = useMemo(() => {
    const monthMap = {};
    const months = [];
    for (const tx of transactions) {
      const ym = tx.date.slice(0, 7);
      if (!monthMap[ym]) { monthMap[ym] = []; months.push(ym); }
      monthMap[ym].push(tx);
    }
    return months.map(ym => {
      const txs = monthMap[ym];
      // 일별 그룹
      const dayMap = {};
      const dates = [];
      for (const tx of txs) {
        if (!dayMap[tx.date]) { dayMap[tx.date] = []; dates.push(tx.date); }
        dayMap[tx.date].push(tx);
      }
      const dayGroups = dates.map(date => {
        const dtxs = dayMap[date];
        let income = 0, expense = 0;
        for (const t of dtxs) {
          if (t.type === 'income') income += t.amount; else expense += t.amount;
        }
        const net = income - expense;
        const endingBalance = balanceAfterMap[dtxs[0].id] ?? 0; // DESC[0] = 당일 마지막 적용
        const first = dtxs[dtxs.length - 1]; // 당일 가장 오래된 거래
        const desc = dtxs.length === 1
          ? dtxs[0].description
          : `${first.description} 외 ${dtxs.length - 1}건`;
        return { date, txs: dtxs, net, endingBalance, desc };
      });
      // 월 합계
      let monthIncome = 0, monthExpense = 0;
      for (const t of txs) {
        if (t.type === 'income') monthIncome += t.amount; else monthExpense += t.amount;
      }
      const monthNet = monthIncome - monthExpense;
      const monthEndBalance = balanceAfterMap[txs[0].id] ?? 0; // DESC[0] = 월말 마지막 거래
      return { ym, dayGroups, monthNet, monthEndBalance };
    });
  }, [transactions, balanceAfterMap]);

  const handleDelete = async (id) => {
    if (!window.confirm('이 내역을 삭제하시겠습니까?')) return;
    deleteAccountTransaction(db, id);
    await onChanged();
  };

  return (
    <div className="acct-txs">
      <div className="acct-txs-header">
        <span>거래 내역</span>
        <div className="acct-txs-header-actions">
          <button className="acct-btn-add-sm" onClick={onOpenImport}>불러오기</button>
          <button className="acct-btn-add-sm" onClick={onOpenAdd}>+ 추가</button>
        </div>
      </div>

      {transactions.length === 0 ? (
        <div className="acct-empty-small">거래 내역이 없습니다.</div>
      ) : (
        <ul className="acct-tx-list">
          {monthGroups.map(mg => {
            const isMonthOpen = expandedMonths.has(mg.ym);
            return (
              <React.Fragment key={mg.ym}>
                {/* ── 월 헤더 ── */}
                <li
                  className={`acct-month-row${isMonthOpen ? ' expanded' : ''}`}
                  onClick={() => toggleMonth(mg.ym)}
                >
                  <div className="acct-month-left">
                    <span className="acct-expand-icon">{isMonthOpen ? '▼' : '▶'}</span>
                    <span className="acct-month-label">{mg.ym}</span>
                  </div>
                  <div className="acct-month-right">
                    {mg.monthNet !== 0 && (
                      <span className={`acct-month-net ${mg.monthNet > 0 ? 'income' : 'expense'}`}>
                        {mg.monthNet > 0 ? '+' : ''}{fmtAmount(mg.monthNet)}
                      </span>
                    )}
                    <span className={`acct-month-balance${mg.monthEndBalance < 0 ? ' negative' : ''}`}>
                      {fmtAmount(mg.monthEndBalance)}원
                    </span>
                  </div>
                </li>

                {/* ── 일별 행 (월 펼침) ── */}
                {isMonthOpen && mg.dayGroups.map(dg => {
                  const isSingle = dg.txs.length === 1;
                  const isDayOpen = expandedDates.has(dg.date);
                  const tx0 = dg.txs[0];
                  return (
                    <React.Fragment key={dg.date}>
                      {isSingle ? (
                        /* 1건: 바로 개별 거래 행으로 표시 */
                        <li className="acct-tx-item">
                          <div className="acct-tx-date">{fmt(dg.date)}</div>
                          <div className="acct-tx-desc">
                            {tx0.description}
                            {!!tx0.is_auto_generated && !tx0.is_modified && <span className="acct-auto-badge">🔁</span>}
                          </div>
                          <div className="acct-tx-right">
                            <div className={`acct-tx-amount ${tx0.type === 'income' ? 'income' : 'expense'}`}>
                              {tx0.type === 'income' ? '+' : '-'}{fmtAmount(tx0.amount)}
                            </div>
                            <div className={`acct-tx-balance${(balanceAfterMap[tx0.id] ?? 0) < 0 ? ' negative' : ''}`}>
                              {fmtAmount(balanceAfterMap[tx0.id] ?? 0)}
                            </div>
                          </div>
                          <div className="acct-tx-actions">
                            <button className="acct-btn-icon" onClick={() => onOpenEdit(tx0)}>✏️</button>
                            <button className="acct-btn-icon" onClick={() => handleDelete(tx0.id)}>🗑️</button>
                          </div>
                        </li>
                      ) : (
                        /* 2건 이상: 일별 요약 + 펼치기 */
                        <>
                          <li
                            className="acct-tx-item acct-tx-item--daily"
                            onClick={() => toggleDate(dg.date)}
                          >
                            <div className="acct-tx-date">{fmt(dg.date)}</div>
                            <div className="acct-tx-desc">
                              {dg.desc}
                              <span className="acct-expand-icon">{isDayOpen ? '▲' : '▼'}</span>
                            </div>
                            <div className="acct-tx-right">
                              <div className={`acct-tx-amount ${dg.net >= 0 ? 'income' : 'expense'}`}>
                                {dg.net >= 0 ? '+' : '-'}{fmtAmount(Math.abs(dg.net))}
                              </div>
                              <div className={`acct-tx-balance${dg.endingBalance < 0 ? ' negative' : ''}`}>
                                {fmtAmount(dg.endingBalance)}
                              </div>
                            </div>
                          </li>
                          {isDayOpen && dg.txs.map(tx => (
                            <li key={tx.id} className="acct-tx-item acct-tx-item--sub">
                              <div className="acct-tx-date" />
                              <div className="acct-tx-desc">
                                {tx.description}
                                {!!tx.is_auto_generated && !tx.is_modified && <span className="acct-auto-badge">🔁</span>}
                              </div>
                              <div className="acct-tx-right">
                                <div className={`acct-tx-amount ${tx.type === 'income' ? 'income' : 'expense'}`}>
                                  {tx.type === 'income' ? '+' : '-'}{fmtAmount(tx.amount)}
                                </div>
                                <div className={`acct-tx-balance${(balanceAfterMap[tx.id] ?? 0) < 0 ? ' negative' : ''}`}>
                                  {fmtAmount(balanceAfterMap[tx.id] ?? 0)}
                                </div>
                              </div>
                              <div className="acct-tx-actions">
                                <button className="acct-btn-icon" onClick={e => { e.stopPropagation(); onOpenEdit(tx); }}>✏️</button>
                                <button className="acct-btn-icon" onClick={e => { e.stopPropagation(); handleDelete(tx.id); }}>🗑️</button>
                              </div>
                            </li>
                          ))}
                        </>
                      )}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── 설정 탭 ──────────────────────────────────────────────────────

function AccountSettingsTab({ db, dataVersion, account, onChanged, onBack }) {
  const [editingAccount, setEditingAccount] = useState(false);
  const [showItemForm, setShowItemForm] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const live = useDbSnapshot(db, dataVersion);
  const recurringItems = useMemo(
    () => live.db ? getRecurringItems(live.db, account.id) : [],
    [live, account.id]
  );
  const paymentMethods = useMemo(() => live.db ? getPaymentMethods(live.db) : [], [live]);

  const handleDeleteItem = async (id) => {
    if (!window.confirm('이 항목을 삭제하시겠습니까?')) return;
    deleteRecurringItem(db, id);
    await onChanged();
  };

  const handleDeleteAccount = async () => {
    if (!window.confirm(`"${account.name}" 계좌를 삭제하시겠습니까?\n연결된 거래 내역은 유지됩니다.`)) return;
    deleteAccount(db, account.id);
    await onChanged();
    onBack();
  };

  if (editingAccount) {
    return (
      <AccountForm
        db={db}
        account={account}
        onSave={async (data) => {
          updateAccount(db, account.id, data);
          setEditingAccount(false);
          await onChanged();
        }}
        onCancel={() => setEditingAccount(false)}
      />
    );
  }

  return (
    <div className="acct-settings">
      <section className="acct-settings-section">
        <div className="acct-settings-section-header">
          <h3>계좌 정보</h3>
          <button className="acct-btn-sm" onClick={() => setEditingAccount(true)}>편집</button>
        </div>
        <dl className="acct-info-list">
          <dt>은행</dt><dd>{account.bank || '-'}</dd>
          <dt>계좌번호</dt><dd>{account.account_number || '-'}</dd>
          <dt>기준 잔액</dt><dd>{fmtAmount(account.current_balance || 0)}원{account.balance_date ? ` (${account.balance_date} 시작 기준)` : ''}</dd>
          <dt>위험 임계값</dt><dd>{account.danger_threshold ? `${fmtAmount(account.danger_threshold)}원` : '-'}</dd>
          <dt>메모</dt><dd>{account.note || '-'}</dd>
        </dl>
      </section>

      <section className="acct-settings-section">
        <div className="acct-settings-section-header">
          <h3>고정 입출금</h3>
          <button className="acct-btn-add-sm" onClick={() => { setEditingItem(null); setShowItemForm(true); }}>+ 추가</button>
        </div>
        {recurringItems.length === 0 ? (
          <p className="acct-empty-small">고정 입출금 항목이 없습니다.</p>
        ) : (
          <ul className="acct-recurring-list">
            {recurringItems.map(item => (
              <li key={item.id} className="acct-recurring-item">
                <div className="acct-recurring-main">
                  <span className={`acct-type-badge ${item.type}`}>
                    {item.type === 'income' ? '수입' : '지출'}
                  </span>
                  <span className="acct-recurring-name">{item.name}</span>
                  <span className="acct-recurring-day">매월 {item.day_of_month}일</span>
                </div>
                <div className="acct-recurring-right">
                  <span className="acct-recurring-amount">
                    {item.amount_type === 'auto'
                      ? `${item.auto_payment_method} 전월 합산`
                      : `${fmtAmount(item.fixed_amount)}원`}
                  </span>
                  <div className="acct-recurring-actions">
                    <button className="acct-btn-icon" onClick={() => { setEditingItem(item); setShowItemForm(true); }}>✏️</button>
                    <button className="acct-btn-icon" onClick={() => handleDeleteItem(item.id)}>🗑️</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showItemForm && (
        <RecurringItemForm
          item={editingItem}
          paymentMethods={paymentMethods}
          onSave={async (data) => {
            if (editingItem) {
              updateRecurringItem(db, editingItem.id, data);
            } else {
              addRecurringItem(db, { ...data, account_id: account.id });
            }
            setShowItemForm(false);
            await onChanged();
          }}
          onCancel={() => setShowItemForm(false)}
        />
      )}

      <div className="acct-danger-zone">
        <button className="acct-btn-delete-account" onClick={handleDeleteAccount}>
          이 계좌 삭제
        </button>
      </div>
    </div>
  );
}

// ── 계좌 추가/편집 폼 ────────────────────────────────────────────

function AccountForm({ account, onSave, onCancel }) {
  const [name, setName] = useState(account?.name || '');
  const [bank, setBank] = useState(account?.bank || '');
  const [accountNumber, setAccountNumber] = useState(account?.account_number || '');
  const [balance, setBalance] = useState(account?.current_balance != null ? String(account.current_balance) : '');
  const [balanceDate, setBalanceDate] = useState(account?.balance_date || todayStr());
  const [dangerThreshold, setDangerThreshold] = useState(account?.danger_threshold != null ? String(account.danger_threshold) : '');
  const [isDefault, setIsDefault] = useState(account?.is_default === 1);
  const [note, setNote] = useState(account?.note || '');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      bank: bank.trim(),
      account_number: accountNumber.trim(),
      current_balance: evaluateFormula(balance, { allowNegative: true }) || 0,
      balance_date: balanceDate,
      danger_threshold: evaluateFormula(dangerThreshold) || 0,
      is_default: isDefault,
      note: note.trim(),
    });
  };

  return (
    <ModalOverlay className="acct-modal-overlay" panelClassName="acct-modal">
        <div className="acct-modal-header">
          <h3>{account ? '계좌 편집' : '계좌 추가'}</h3>
          <button className="acct-modal-close" onClick={onCancel}>✕</button>
        </div>
        <form onSubmit={handleSubmit} className="acct-form">
          <label>
            계좌 이름 *
            <input value={name} onChange={e => setName(e.target.value)} placeholder="예: 월급통장" required />
          </label>
          <label>
            은행
            <input value={bank} onChange={e => setBank(e.target.value)} placeholder="예: 신한은행" />
          </label>
          <label>
            계좌번호
            <input value={accountNumber} onChange={e => setAccountNumber(e.target.value)} placeholder="선택 사항" />
          </label>
          <label>
            기준 잔액 (원)
            <AmountInput
              allowNegative
              value={balance}
              onChange={setBalance}
              placeholder="0"
            />
          </label>
          <label>
            잔액 기준일
            <input type="date" value={balanceDate} onChange={e => setBalanceDate(e.target.value)} />
            <small style={{ fontSize: '11px', fontWeight: 400, lineHeight: 1.5 }}>
              기준일이 시작될 때(그날 거래 전)의 잔액을 입력하세요.
              기준일부터의 내역만 잔액에 더하고, 그 전 내역은 기록으로만 남습니다.
            </small>
          </label>
          <label>
            위험 임계값 (원)
            <AmountInput
              value={dangerThreshold}
              onChange={setDangerThreshold}
              placeholder="0 (미설정)"
            />
          </label>
          <label className="acct-form-checkbox">
            <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
            기본 계좌로 설정
          </label>
          <label>
            메모
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="선택 사항" />
          </label>
          <div className="acct-form-actions">
            <button type="button" className="acct-btn-cancel" onClick={onCancel}>취소</button>
            <button type="submit" className="acct-btn-save">저장</button>
          </div>
        </form>
    </ModalOverlay>
  );
}

// ── 계좌 거래 추가/편집 폼 ────────────────────────────────────────

function AccountTxForm({ tx, onSave, onCancel }) {
  const [date, setDate] = useState(tx?.date || todayStr());
  const [type, setType] = useState(tx?.type || 'expense');
  const [description, setDescription] = useState(tx?.description || '');
  const [amount, setAmount] = useState(tx?.amount != null ? String(tx.amount) : '');
  const [continuous, setContinuous] = useStoredToggle('acct_tx_form_continuous');
  const [addedCount, setAddedCount] = useState(0);
  const descRef = React.useRef(null);

  const parsedAmount = evaluateFormula(amount);
  const amountValid = parsedAmount !== null && !isNaN(parsedAmount) && parsedAmount > 0;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!description.trim() || !amountValid) return;
    const keepOpen = continuous && !tx;
    onSave({
      date,
      type,
      description: description.trim(),
      amount: parsedAmount,
    }, { keepOpen });
    if (keepOpen) {
      // 다음 내역 입력용 — 날짜와 수입/지출 구분은 유지
      setDescription('');
      setAmount('');
      setAddedCount(c => c + 1);
      if (descRef.current) descRef.current.focus();
    }
  };

  return (
    <ModalOverlay className="acct-modal-overlay" panelClassName="acct-modal">
        <div className="acct-modal-header">
          <h3>
            {tx ? '내역 편집' : '내역 추가'}
            {addedCount > 0 && <span className="acct-continuous-count">{addedCount}건 추가됨</span>}
          </h3>
          <button className="acct-modal-close" onClick={onCancel}>✕</button>
        </div>
        <form onSubmit={handleSubmit} className="acct-form">
          <label>
            날짜
            <input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </label>
          <div className="acct-form-type-row">
            <button
              type="button"
              className={`acct-type-btn${type === 'income' ? ' active-income' : ''}`}
              onClick={() => setType('income')}
            >
              수입
            </button>
            <button
              type="button"
              className={`acct-type-btn${type === 'expense' ? ' active-expense' : ''}`}
              onClick={() => setType('expense')}
            >
              지출
            </button>
          </div>
          <label>
            내용 *
            <input ref={descRef} value={description} onChange={e => setDescription(e.target.value)} placeholder="내용을 입력하세요" required />
          </label>
          <label>
            금액 (원) *
            <AmountInput
              value={amount}
              onChange={setAmount}
              placeholder="0 (예: 12000+3000)"
              required
            />
          </label>
          {!tx && (
            <label className="acct-form-checkbox acct-continuous-toggle">
              <input type="checkbox" checked={continuous} onChange={e => setContinuous(e.target.checked)} />
              <span>
                연속 입력
                <small>추가 후 창을 닫지 않고 바로 다음 내역 입력 (날짜·수입/지출 유지)</small>
              </span>
            </label>
          )}
          <div className="acct-form-actions">
            <button type="button" className="acct-btn-cancel" onClick={onCancel}>
              {addedCount > 0 ? '닫기' : '취소'}
            </button>
            <button type="submit" className="acct-btn-save" disabled={!amountValid || !description.trim()}>
              {!tx && continuous ? '저장하고 계속' : '저장'}
            </button>
          </div>
        </form>
    </ModalOverlay>
  );
}

// ── 고정 입출금 항목 폼 ───────────────────────────────────────────

function RecurringItemForm({ item, paymentMethods, onSave, onCancel }) {
  const [name, setName] = useState(item?.name || '');
  const [type, setType] = useState(item?.type || 'expense');
  const [dayOfMonth, setDayOfMonth] = useState(item?.day_of_month != null ? String(item.day_of_month) : '1');
  const [holidayRule, setHolidayRule] = useState(item?.holiday_rule || 'none');
  const [amountType, setAmountType] = useState(item?.amount_type || 'fixed');
  const [fixedAmount, setFixedAmount] = useState(item?.fixed_amount != null ? String(item.fixed_amount) : '');
  const [autoPaymentMethod, setAutoPaymentMethod] = useState(item?.auto_payment_method || '');
  const [monthsAhead, setMonthsAhead] = useState(item?.register_months_ahead != null ? String(item.register_months_ahead) : '2');
  const [note, setNote] = useState(item?.note || '');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      type,
      day_of_month: parseInt(dayOfMonth, 10) || 1,
      holiday_rule: holidayRule,
      amount_type: amountType,
      fixed_amount: amountType === 'fixed' ? (evaluateFormula(fixedAmount) || 0) : 0,
      auto_payment_method: amountType === 'auto' ? autoPaymentMethod : '',
      auto_register: true,
      register_months_ahead: parseInt(monthsAhead, 10) || 2,
      note: note.trim(),
    });
  };

  return (
    <ModalOverlay className="acct-modal-overlay" panelClassName="acct-modal">
        <div className="acct-modal-header">
          <h3>{item ? '항목 편집' : '고정 입출금 추가'}</h3>
          <button className="acct-modal-close" onClick={onCancel}>✕</button>
        </div>
        <form onSubmit={handleSubmit} className="acct-form">
          <label>
            항목 이름 *
            <input value={name} onChange={e => setName(e.target.value)} placeholder="예: 월급, 신한카드 결제" required />
          </label>
          <div className="acct-form-type-row">
            <button
              type="button"
              className={`acct-type-btn${type === 'income' ? ' active-income' : ''}`}
              onClick={() => setType('income')}
            >
              수입
            </button>
            <button
              type="button"
              className={`acct-type-btn${type === 'expense' ? ' active-expense' : ''}`}
              onClick={() => setType('expense')}
            >
              지출
            </button>
          </div>
          <label>
            매월 발생일
            <input
              type="number"
              min="1"
              max="31"
              value={dayOfMonth}
              onChange={e => setDayOfMonth(e.target.value)}
            />
          </label>
          <label>
            공휴일/주말 처리
            <select value={holidayRule} onChange={e => setHolidayRule(e.target.value)}>
              <option value="none">당일</option>
              <option value="next_business">다음 영업일</option>
              <option value="prev_business">이전 영업일</option>
            </select>
          </label>
          <div className="acct-form-row-label">금액 방식</div>
          <div className="acct-form-type-row">
            <button
              type="button"
              className={`acct-type-btn${amountType === 'fixed' ? ' active-income' : ''}`}
              onClick={() => setAmountType('fixed')}
            >
              고정 금액
            </button>
            <button
              type="button"
              className={`acct-type-btn${amountType === 'auto' ? ' active-income' : ''}`}
              onClick={() => { setAmountType('auto'); setMonthsAhead('1'); }}
            >
              카드 자동 집계
            </button>
          </div>
          {amountType === 'fixed' && (
            <label>
              금액 (원)
              <AmountInput
                value={fixedAmount}
                onChange={setFixedAmount}
                placeholder="예상 금액 입력"
              />
            </label>
          )}
          {amountType === 'auto' && (
            <label>
              결제수단 (카드)
              <select value={autoPaymentMethod} onChange={e => setAutoPaymentMethod(e.target.value)}>
                <option value="">선택하세요</option>
                {paymentMethods.map(pm => (
                  <option key={pm} value={pm}>{pm}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            자동 등록 (몇 개월 앞까지)
            <select value={monthsAhead} onChange={e => setMonthsAhead(e.target.value)}>
              <option value="1">1개월</option>
              <option value="2">2개월</option>
              <option value="3">3개월</option>
            </select>
          </label>
          <label>
            메모
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="선택 사항" />
          </label>
          <div className="acct-form-actions">
            <button type="button" className="acct-btn-cancel" onClick={onCancel}>취소</button>
            <button type="submit" className="acct-btn-save">저장</button>
          </div>
        </form>
    </ModalOverlay>
  );
}

// ── CSV 행 해석 ──────────────────────────────────────────────────

const pick = (raw, keys) => {
  for (const k of keys) {
    if (raw[k] !== undefined && String(raw[k]).trim() !== '') return String(raw[k]).trim();
  }
  return '';
};

/**
 * 계좌 CSV 한 행 → { date, type, description, amount } 또는 { errs }
 *  - 금액: '금액'/'거래금액' 칸. 음수는 출금(지출)으로 본다. 은행 양식처럼 '출금액'/'입금액' 칸이 따로 있어도 읽는다.
 *  - 구분: '입금'·'수입'이 들어가면 수입, '출금'·'지출'이면 지출, 비었으면 지출
 *  - 날짜: 2026-05-25 / 2026.05.25 / 2026/5/25 (시각이 붙어도 됨), 실제로 없는 날짜는 오류
 */
function parseAccountRow(raw, rowNumber) {
  const errs = [];
  const dateRaw = pick(raw, ['날짜', '거래일', '일자', '거래일시']);
  const typeRaw = pick(raw, ['구분', '입출금구분', '타입']);
  const desc = pick(raw, ['내용', '적요', '거래내역', '메모']);
  const amtRaw = pick(raw, ['금액', '거래금액']);
  const outRaw = pick(raw, ['출금액', '출금', '찾으신금액']);
  const inRaw = pick(raw, ['입금액', '입금', '맡기신금액']);

  const date = normalizeDateStr(dateRaw);
  if (!dateRaw) errs.push('날짜 없음');
  else if (!date) errs.push(`날짜 오류: "${dateRaw}" (YYYY-MM-DD, 실제 있는 날짜)`);
  if (!desc) errs.push('내용 없음');

  let type = 'expense';
  if (/입금|수입/.test(typeRaw)) type = 'income';
  else if (typeRaw && !/출금|지출/.test(typeRaw)) errs.push(`구분 오류: "${typeRaw}" (수입/지출)`);

  let amount = null;
  if (amtRaw) {
    const n = parseImportAmount(amtRaw);
    if (Number.isNaN(n) || n === 0) errs.push(`금액 오류: "${amtRaw}"`);
    else if (n < 0) { amount = -n; type = 'expense'; } // 음수 금액 = 출금
    else amount = n;
  } else {
    const out = parseImportAmount(outRaw);
    const inn = parseImportAmount(inRaw);
    if (Number.isNaN(out) || Number.isNaN(inn)) errs.push(`금액 오류: "${outRaw || inRaw}"`);
    else if (out) { amount = Math.abs(out); type = 'expense'; }
    else if (inn) { amount = Math.abs(inn); type = 'income'; }
    else errs.push('금액 없음');
  }

  return errs.length > 0
    ? { rowNumber, errs }
    : { rowNumber, date, type, description: desc, amount };
}

const ACCT_CSV_TEMPLATE =
  '날짜,구분,내용,금액\r\n' +
  '2026-05-25,수입,월급,3000000\r\n' +
  '2026-05-13,지출,신한카드 결제,450000\r\n' +
  '2026-05-20,지출,관리비,120000\r\n';

function downloadAcctFile(content, filename) {
  const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── 계좌 불러오기 모달 ────────────────────────────────────────────

function AccountImportModal({ db, accountId, onImport, onClose }) {
  const [step, setStep] = useState('upload');
  const [rows, setRows] = useState([]);
  const [importErrors, setImportErrors] = useState([]);
  const [importing, setImporting] = useState(false);
  const [fileError, setFileError] = useState('');
  const [importedCount, setImportedCount] = useState(0);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);

  const duplicateCount = rows.filter(r => r.isDuplicate).length;
  const rowsToImport = includeDuplicates ? rows : rows.filter(r => !r.isDuplicate);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError('');
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const rawRows = parseCSV(evt.target?.result);
        if (rawRows.length === 0) {
          setFileError('데이터가 없거나 형식이 올바르지 않습니다.');
          return;
        }
        const validRows = [];
        const errorRows = [];
        rawRows.forEach(({ rowNumber, fields }) => {
          const result = parseAccountRow(fields, rowNumber);
          if (result.errs) errorRows.push(result);
          else validRows.push(result);
        });
        // 이미 이 계좌에 있는 내역과 같은 행 표시 (같은 파일을 두 번 올려도 두 배가 되지 않게)
        const existing = countExistingAccountTransactions(db, accountId, validRows);
        setRows(markDuplicates(validRows, accountTxDuplicateKey, existing));
        setImportErrors(errorRows);
        setIncludeDuplicates(false);
        if (validRows.length === 0) {
          setFileError('가져올 수 있는 행이 없습니다. 양식을 확인해주세요.');
          return;
        }
        setStep('preview');
      } catch (err) {
        setFileError(`파일 읽기 오류: ${err.message}`);
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  const handleImport = async () => {
    if (importing || rowsToImport.length === 0) return;
    setImporting(true);
    try {
      bulkInsertAccountTransactions(db, accountId, rowsToImport);
      setImportedCount(rowsToImport.length);
      setStep('done');
    } catch (err) {
      setFileError(`불러오기 오류: ${err.message}`);
      setImporting(false);
    }
  };

  // 완료 화면은 ✕로 닫아도 '확인'과 똑같이 처리한다 (B-024)
  const handleClose = step === 'done' ? onImport : onClose;

  return (
    <ModalOverlay className="acct-modal-overlay" panelClassName="acct-modal acct-modal--tall">
        <div className="acct-modal-header">
          <h3>거래 내역 불러오기</h3>
          <button className="acct-modal-close" onClick={handleClose}>✕</button>
        </div>

        {step === 'upload' && (
          <div className="acct-form">
            <p className="acct-import-info">
              CSV 파일을 업로드하세요.<br />
              <strong>날짜, 구분, 내용, 금액</strong> 컬럼이 필요합니다.
            </p>
            <div className="acct-import-template">
              <span>양식 다운로드</span>
              <button className="acct-btn-add-sm" onClick={() => downloadAcctFile(ACCT_CSV_TEMPLATE, '계좌내역_양식.csv')}>
                CSV 양식
              </button>
            </div>
            <table className="acct-import-table">
              <thead><tr><th>컬럼</th><th></th><th>설명</th></tr></thead>
              <tbody>
                <tr><td>날짜</td><td><span className="acct-badge-req">필수</span></td><td>YYYY-MM-DD (2026.05.25도 가능)</td></tr>
                <tr><td>구분</td><td><span className="acct-badge-opt">선택</span></td><td>수입(입금) / 지출(출금) (기본: 지출)</td></tr>
                <tr><td>내용</td><td><span className="acct-badge-req">필수</span></td><td>거래 내용</td></tr>
                <tr><td>금액</td><td><span className="acct-badge-req">필수</span></td><td>숫자 (음수는 출금으로 처리, 출금액·입금액 칸으로 나눠도 됨)</td></tr>
              </tbody>
            </table>
            <input type="file" accept=".csv" onChange={handleFileChange} className="acct-import-file-input" />
            {fileError && <p className="acct-import-error">{fileError}</p>}
          </div>
        )}

        {step === 'preview' && (
          <div className="acct-form">
            <p className="acct-import-info">
              <strong>{rowsToImport.length}건</strong> 불러오기 예정
              {importErrors.length > 0 && <span className="acct-import-skip"> ({importErrors.length}건 오류로 건너뜀)</span>}
            </p>
            {importErrors.length > 0 && (
              <div className="acct-import-errors">
                <p className="acct-import-errors-title">{importErrors.length}건 건너뜀 — 필드 오류</p>
                {importErrors.map(e => (
                  <div key={e.rowNumber} className="acct-import-error-row">
                    <span>{e.rowNumber}행</span><span>{e.errs.join(' / ')}</span>
                  </div>
                ))}
              </div>
            )}
            {duplicateCount > 0 && (
              <label className="acct-form-checkbox">
                <input type="checkbox" checked={includeDuplicates} onChange={e => setIncludeDuplicates(e.target.checked)} />
                <span>
                  이미 있는 내역과 같은 {duplicateCount}건도 불러오기
                  <small style={{ display: 'block', fontSize: '11px', fontWeight: 400 }}>
                    날짜·구분·금액·내용이 같은 내역이 이 계좌에 이미 있습니다. 보통은 체크하지 않습니다.
                  </small>
                </span>
              </label>
            )}
            <div className="acct-import-preview-wrap">
              <table className="acct-import-preview-table">
                <thead><tr><th>행</th><th>날짜</th><th>구분</th><th>내용</th><th>금액</th></tr></thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.rowNumber} style={row.isDuplicate && !includeDuplicates ? { opacity: 0.45 } : undefined}>
                      <td>{row.rowNumber}</td>
                      <td>{fmt(row.date)}</td>
                      <td><span className={`acct-type-badge ${row.type}`}>{row.type === 'income' ? '수입' : '지출'}</span></td>
                      <td className="acct-preview-desc">
                        {row.description}
                        {row.isDuplicate && <span className="acct-import-skip"> (이미 있음)</span>}
                      </td>
                      <td className={`acct-tx-amount ${row.type}`}>
                        {row.type === 'income' ? '+' : '-'}{fmtAmount(row.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {fileError && <p className="acct-import-error">{fileError}</p>}
            <div className="acct-form-actions">
              <button className="acct-btn-cancel" onClick={() => setStep('upload')}>다시 선택</button>
              <button className="acct-btn-save" onClick={handleImport} disabled={importing || rowsToImport.length === 0}>
                {importing ? '가져오는 중…' : rowsToImport.length === 0 ? '새 내역 없음' : `${rowsToImport.length}건 불러오기`}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="acct-form" style={{ textAlign: 'center', paddingTop: '24px' }}>
            <p style={{ fontSize: '18px', fontWeight: '600', marginBottom: '8px' }}>완료!</p>
            <p className="acct-import-info">{importedCount}건이 추가되었습니다.</p>
            <div className="acct-form-actions" style={{ marginTop: '20px' }}>
              <button className="acct-btn-save" onClick={onImport}>확인</button>
            </div>
          </div>
        )}
    </ModalOverlay>
  );
}
