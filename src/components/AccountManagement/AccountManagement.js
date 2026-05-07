import React, { useState, useMemo } from 'react';
import {
  getAllAccounts, getAccount, getDefaultAccount, getAccountsActualBalances,
  addAccount, updateAccount, deleteAccount, setDefaultAccount,
  getRecurringItems, addRecurringItem, updateRecurringItem, deleteRecurringItem,
  getAccountTransactions, addAccountTransaction, updateAccountTransaction, deleteAccountTransaction,
  bulkInsertAccountTransactions, getPaymentMethods,
} from '../../services/dbManager';
import './AccountManagement.css';

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

// current_balance를 최초 시작 금액으로 삼아 각 거래 후 잔액과 현재 잔액을 계산
function computeRunningBalances(account, descTransactions) {
  const ascTxs = [...descTransactions].reverse();
  const startBalance = account.current_balance || 0;

  // 오래된 거래부터 순서대로 적용 → 거래 후 잔액 맵
  const balanceAfterMap = {};
  let running = startBalance;
  for (const tx of ascTxs) {
    if (tx.type === 'income') running += tx.amount;
    else running -= tx.amount;
    balanceAfterMap[tx.id] = running;
  }

  // 오늘까지 적용한 실제 현재 잔액
  const today = todayStr();
  let currentBalance = startBalance;
  for (const tx of ascTxs) {
    if (tx.date > today) break;
    if (tx.type === 'income') currentBalance += tx.amount;
    else currentBalance -= tx.amount;
  }

  return { balanceAfterMap, currentBalance };
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 메인 컴포넌트 ────────────────────────────────────────────────

export default function AccountManagement({ db, drilldown, detailTab, showForm, onDrilldownChange, onDetailTabChange, onCloseForm, onChanged }) {
  const accounts = useMemo(() => db ? getAllAccounts(db) : [], [db]);
  const defaultAccount = useMemo(() => db ? getDefaultAccount(db) : null, [db]);

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

function AccountList({ db, accounts, defaultAccountId, showNavForm, onNavFormClose, onSelect, onChanged }) {
  const [showForm, setShowForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);

  // 거래 내역을 반영한 실제 현재 잔액
  const actualBalances = useMemo(() => {
    if (!db) return {};
    const txSums = getAccountsActualBalances(db);
    const result = {};
    accounts.forEach(acc => {
      result[acc.id] = (acc.current_balance || 0) + (txSums[acc.id] || 0);
    });
    return result;
  }, [db, accounts]);

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

function AccountDetail({ db, accountId, activeTab, showNavForm, onNavFormClose, onTabChange, onBack, onChanged }) {
  const account = useMemo(() => db ? getAccount(db, accountId) : null, [db, accountId]);
  const transactions = useMemo(
    () => db ? getAccountTransactions(db, accountId) : [],
    [db, accountId]
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
        <AccountSettingsTab db={db} account={account} onChanged={onChanged} onBack={onBack} />
      )}

      {/* 거래 추가/수정 폼 — 탭에 무관하게 AccountDetail 레벨에서 렌더링 */}
      {showTxForm && (
        <AccountTxForm
          db={db}
          accountId={accountId}
          tx={editingTx}
          onSave={async (data) => {
            if (editingTx) {
              updateAccountTransaction(db, editingTx.id, data);
            } else {
              addAccountTransaction(db, { ...data, account_id: accountId });
            }
            closeTxForm();
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

function AccountSettingsTab({ db, account, onChanged, onBack }) {
  const [editingAccount, setEditingAccount] = useState(false);
  const [showItemForm, setShowItemForm] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const recurringItems = useMemo(
    () => db ? getRecurringItems(db, account.id) : [],
    [db, account.id]
  );
  const paymentMethods = useMemo(() => db ? getPaymentMethods(db) : [], [db]);

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
      current_balance: parseInt(balance.replace(/,/g, ''), 10) || 0,
      balance_date: balanceDate,
      danger_threshold: parseInt(dangerThreshold.replace(/,/g, ''), 10) || 0,
      is_default: isDefault,
      note: note.trim(),
    });
  };

  return (
    <div className="acct-modal-overlay" onClick={onCancel}>
      <div className="acct-modal" onClick={e => e.stopPropagation()}>
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
            최초 잔액 (원)
            <input
              type="number"
              value={balance}
              onChange={e => setBalance(e.target.value)}
              placeholder="0"
            />
          </label>
          <label>
            잔액 기준일
            <input type="date" value={balanceDate} onChange={e => setBalanceDate(e.target.value)} />
          </label>
          <label>
            위험 임계값 (원)
            <input
              type="number"
              value={dangerThreshold}
              onChange={e => setDangerThreshold(e.target.value)}
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
      </div>
    </div>
  );
}

// ── 계좌 거래 추가/편집 폼 ────────────────────────────────────────

function AccountTxForm({ tx, onSave, onCancel }) {
  const [date, setDate] = useState(tx?.date || todayStr());
  const [type, setType] = useState(tx?.type || 'expense');
  const [description, setDescription] = useState(tx?.description || '');
  const [amount, setAmount] = useState(tx?.amount != null ? String(tx.amount) : '');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!description.trim() || !amount) return;
    onSave({
      date,
      type,
      description: description.trim(),
      amount: parseInt(amount.replace(/,/g, ''), 10) || 0,
    });
  };

  return (
    <div className="acct-modal-overlay" onClick={onCancel}>
      <div className="acct-modal" onClick={e => e.stopPropagation()}>
        <div className="acct-modal-header">
          <h3>{tx ? '내역 편집' : '내역 추가'}</h3>
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
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="내용을 입력하세요" required />
          </label>
          <label>
            금액 (원) *
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0"
              required
            />
          </label>
          <div className="acct-form-actions">
            <button type="button" className="acct-btn-cancel" onClick={onCancel}>취소</button>
            <button type="submit" className="acct-btn-save">저장</button>
          </div>
        </form>
      </div>
    </div>
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
      fixed_amount: amountType === 'fixed' ? (parseInt(fixedAmount.replace(/,/g, ''), 10) || 0) : 0,
      auto_payment_method: amountType === 'auto' ? autoPaymentMethod : '',
      auto_register: true,
      register_months_ahead: parseInt(monthsAhead, 10) || 2,
      note: note.trim(),
    });
  };

  return (
    <div className="acct-modal-overlay">
      <div className="acct-modal">
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
              <input
                type="number"
                value={fixedAmount}
                onChange={e => setFixedAmount(e.target.value)}
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
      </div>
    </div>
  );
}

// ── CSV 파서 ─────────────────────────────────────────────────────
function parseCSVLine(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++;
      let field = '';
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else field += line[i++];
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  if (line.endsWith(',')) fields.push('');
  return fields;
}

function parseAccountCSV(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return null;
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] ?? '').trim(); });
    return obj;
  }).filter(r => Object.values(r).some(v => v !== ''));
  return rows;
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

  const parseRow = (raw, idx) => {
    const dateRaw = (raw['날짜'] || raw['거래일'] || raw['일자'] || raw['거래일시'] || '').trim();
    const typeRaw = (raw['구분'] || raw['입출금구분'] || raw['타입'] || '').trim();
    const desc = (raw['내용'] || raw['적요'] || raw['거래내역'] || raw['메모'] || '').trim();
    const amtRaw = (raw['금액'] || raw['거래금액'] || '').replace(/,/g, '').trim();

    const errs = [];
    if (!dateRaw) errs.push('날짜 없음');
    else if (!/^\d{4}-\d{2}-\d{2}/.test(dateRaw)) errs.push(`날짜 형식 오류: "${dateRaw}"`);
    const amount = parseInt(amtRaw, 10);
    if (!amtRaw || isNaN(amount) || amount <= 0) errs.push(`금액 오류: "${amtRaw}"`);
    if (!desc) errs.push('내용 없음');

    const type = (typeRaw === '수입' || typeRaw === '입금') ? 'income' : 'expense';
    return errs.length > 0
      ? { rowNum: idx + 1, errs }
      : { rowNum: idx + 1, date: dateRaw.slice(0, 10), type, description: desc, amount };
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError('');
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const rawRows = parseAccountCSV(evt.target?.result);
        if (!rawRows || rawRows.length === 0) {
          setFileError('데이터가 없거나 형식이 올바르지 않습니다.');
          return;
        }
        const validRows = [];
        const errorRows = [];
        rawRows.forEach((raw, idx) => {
          const result = parseRow(raw, idx);
          if (result.errs) errorRows.push(result);
          else validRows.push(result);
        });
        setRows(validRows);
        setImportErrors(errorRows);
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
    if (importing) return;
    setImporting(true);
    try {
      bulkInsertAccountTransactions(db, accountId, rows);
      setImportedCount(rows.length);
      setStep('done');
    } catch (err) {
      setFileError(`불러오기 오류: ${err.message}`);
      setImporting(false);
    }
  };

  return (
    <div className="acct-modal-overlay" onClick={onClose}>
      <div className="acct-modal acct-modal--tall" onClick={e => e.stopPropagation()}>
        <div className="acct-modal-header">
          <h3>거래 내역 불러오기</h3>
          <button className="acct-modal-close" onClick={onClose}>✕</button>
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
                <tr><td>날짜</td><td><span className="acct-badge-req">필수</span></td><td>YYYY-MM-DD</td></tr>
                <tr><td>구분</td><td><span className="acct-badge-opt">선택</span></td><td>수입 / 지출 (기본: 지출)</td></tr>
                <tr><td>내용</td><td><span className="acct-badge-req">필수</span></td><td>거래 내용</td></tr>
                <tr><td>금액</td><td><span className="acct-badge-req">필수</span></td><td>양수 숫자</td></tr>
              </tbody>
            </table>
            <input type="file" accept=".csv" onChange={handleFileChange} className="acct-import-file-input" />
            {fileError && <p className="acct-import-error">{fileError}</p>}
          </div>
        )}

        {step === 'preview' && (
          <div className="acct-form">
            <p className="acct-import-info">
              <strong>{rows.length}건</strong> 불러오기 예정
              {importErrors.length > 0 && <span className="acct-import-skip"> ({importErrors.length}건 건너뜀)</span>}
            </p>
            {importErrors.length > 0 && (
              <div className="acct-import-errors">
                <p className="acct-import-errors-title">{importErrors.length}건 건너뜀 — 필드 오류</p>
                {importErrors.map(e => (
                  <div key={e.rowNum} className="acct-import-error-row">
                    <span>{e.rowNum}행</span><span>{e.errs.join(' / ')}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="acct-import-preview-wrap">
              <table className="acct-import-preview-table">
                <thead><tr><th>#</th><th>날짜</th><th>구분</th><th>내용</th><th>금액</th></tr></thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>{fmt(row.date)}</td>
                      <td><span className={`acct-type-badge ${row.type}`}>{row.type === 'income' ? '수입' : '지출'}</span></td>
                      <td className="acct-preview-desc">{row.description}</td>
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
              <button className="acct-btn-save" onClick={handleImport} disabled={importing}>
                {importing ? '가져오는 중…' : `${rows.length}건 불러오기`}
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
      </div>
    </div>
  );
}
