import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import './App.css';

import LoginPage from '../LoginPage/LoginPage';
import Header from '../Header/Header';
import TransactionList from '../TransactionList/TransactionList';
import TransactionForm from '../TransactionForm/TransactionForm';
import SummaryView, { showSummaryMonth } from '../SummaryView/SummaryView';
import SettingsView from '../SettingsView/SettingsView';
import ImportModal from '../ImportModal/ImportModal';
import CardStatementModal from '../CardStatement/CardStatementModal';
import CalendarView from '../CalendarView/CalendarView';

import AccountManagement from '../AccountManagement/AccountManagement';
import Onboarding from '../Onboarding/Onboarding';
import { addTransaction, updateTransaction, deleteTransaction, getSplitGroupTransactions, runAccountAutoRegister, withTransaction, isBlankLedger, addedSnapshot, removeAddedTransactions } from '../../services/dbManager';
import { getAIConfig, clearAIKeys, activeAI } from '../../services/aiClient';
import { setAISyncAccount, syncAISettings } from '../../services/aiSettingsSync';
import useLedgerSync from '../../hooks/useLedgerSync';
import { createOneDriveStorage } from '../../services/storage/oneDrive';
import { resolveDeviceMember } from '../../services/deviceMember';
import { isOnboardingPostponed, postponeOnboarding } from '../../services/onboardingPrefs';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';
import { useTopToast } from '../../hooks/useTopToast';
import { clearAIDraft, setAIDraftAccount } from '../../services/aiDraft';
import { clearSharedItems, readLaunchAction, takeSharedItems } from '../../services/shareInbox';

function App() {
  const isAuthenticated = useIsAuthenticated();
  const { instance, accounts } = useMsal();

  // 가계부·백업·AI 설정 파일을 두는 저장소 (F-2) — 지금은 로그인한 Microsoft 계정의 OneDrive. 로그인 전에는 null
  const storage = useMemo(
    () => (accounts.length ? createOneDriveStorage(instance, accounts) : null),
    [instance, accounts],
  );

  // DB 불러오기·자동 저장·충돌 병합은 useLedgerSync가 맡는다.
  // 컴포넌트는 db에 쓰기만 하면 자동으로 저장된다. 화면은 dataVersion으로 갱신한다.
  const {
    db, dataVersion, loading, saving, error, setError, notice, offline,
    dirty, pendingCount, loadDb, saveNow, resetForLogout,
    listBackups, createBackup, restoreBackup,
  } = useLedgerSync({ storage });
  // 늦게 끝나는 일(AI 입력의 바로 넣기·되돌리기)이 그 순간의 DB를 쓰게 — 저장소에서 다시 받으면 DB 객체가 바뀐다
  const dbRef = React.useRef(db);
  dbRef.current = db;
  // 설정 › 데이터의 백업 목록·직접 백업·되돌리기 (I-014) — 같은 객체를 유지해 목록을 매번 다시 부르지 않게
  const backupApi = useMemo(
    () => ({ list: listBackups, create: createBackup, restore: restoreBackup }),
    [listBackups, createBackup, restoreBackup],
  );
  const [activeTab, setActiveTab] = useState('list'); // 'list' | 'summary' | 'calendar' | 'account' | 'settings'
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showCardCheck, setShowCardCheck] = useState(false);
  const [showEventForm, setShowEventForm] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false); // 첫 실행 안내 (F-3)
  const [editingTx, setEditingTx] = useState(null);
  const [defaultFormDate, setDefaultFormDate] = useState(null);
  // 입력 창을 열 때 AI 입력을 바로 시작할 것 (I-024) — 바로가기 'AI 입력' { quick: true }, 공유 받기 { text, files }
  const [aiStart, setAiStart] = useState(null);
  const [toast, setToast] = useState('');
  const toastTimer = React.useRef(null);

  // SummaryView 내비게이션 state
  const [summaryTab, setSummaryTab] = useState('monthly');
  const [summaryDrilldown, setSummaryDrilldown] = useState(null);
  // SettingsView 내비게이션 state
  const [settingsSection, setSettingsSection] = useState('payment');
  const [settingsDrilldownCategory, setSettingsDrilldownCategory] = useState(null);
  const [settingsDrilldownTrip, setSettingsDrilldownTrip] = useState(null);
  const [settingsDrilldownPayment, setSettingsDrilldownPayment] = useState(null);
  // AccountManagement 내비게이션 state
  const [accountDrilldown, setAccountDrilldown] = useState(null); // null=list, {id}=detail
  const [accountDetailTab, setAccountDetailTab] = useState('transactions');
  const [showAccountForm, setShowAccountForm] = useState(false); // 계좌탭 ➕ 버튼용
  const [calendarGoTodayKey, setCalendarGoTodayKey] = useState(0);
  const [listGoTodayKey, setListGoTodayKey] = useState(0);

  const navRef = React.useRef({
    activeTab: 'list', showForm: false, showImport: false, showCardCheck: false, showEventForm: false, showOnboarding: false, editingTx: null,
    summaryTab: 'monthly', summaryDrilldown: null,
    settingsSection: 'payment',
    settingsDrilldownCategory: null, settingsDrilldownTrip: null, settingsDrilldownPayment: null,
    accountDrilldown: null, accountDetailTab: 'transactions', showAccountForm: false,
  });
  const historyInitialized = React.useRef(false);
  const loadAttemptedRef = React.useRef(false);
  const aiSyncedRef = React.useRef(false); // 이번 로그인에서 AI 설정을 맞췄는지

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  }, []);

  // 화면 위 알림(되돌리기) — 일반 알림이 덮지 않고, 다른 앱에 가 있는 동안에는 시간을 세지 않는다 (I-022, I-023)
  const { topToast, showTopToast, hideTopToast } = useTopToast();

  const applyNavState = useCallback((s) => {
    if ('activeTab' in s) setActiveTab(s.activeTab);
    if ('showForm' in s) setShowForm(s.showForm);
    if ('showImport' in s) setShowImport(s.showImport);
    if ('showCardCheck' in s) setShowCardCheck(s.showCardCheck);
    if ('showEventForm' in s) setShowEventForm(s.showEventForm);
    if ('showOnboarding' in s) setShowOnboarding(s.showOnboarding);
    if ('editingTx' in s) setEditingTx(s.editingTx);
    if ('summaryTab' in s) setSummaryTab(s.summaryTab);
    if ('summaryDrilldown' in s) setSummaryDrilldown(s.summaryDrilldown);
    if ('settingsSection' in s) setSettingsSection(s.settingsSection);
    if ('settingsDrilldownCategory' in s) setSettingsDrilldownCategory(s.settingsDrilldownCategory);
    if ('settingsDrilldownTrip' in s) setSettingsDrilldownTrip(s.settingsDrilldownTrip);
    if ('settingsDrilldownPayment' in s) setSettingsDrilldownPayment(s.settingsDrilldownPayment);
    if ('accountDrilldown' in s) setAccountDrilldown(s.accountDrilldown);
    if ('accountDetailTab' in s) setAccountDetailTab(s.accountDetailTab);
    if ('showAccountForm' in s) setShowAccountForm(s.showAccountForm);
  }, []);

  const navigate = useCallback((updates) => {
    const newState = { ...navRef.current, ...updates };
    navRef.current = newState;
    window.history.pushState(newState, '');
    applyNavState(updates);
  }, [applyNavState]);

  useEffect(() => {
    const onPopState = (e) => {
      if (e.state) {
        navRef.current = e.state;
        applyNavState(e.state);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyNavState]);

  // 로그인 후 DB 자동 로드 (실패하면 버튼으로 다시 시도)
  useEffect(() => {
    if (!isAuthenticated || accounts.length === 0) { loadAttemptedRef.current = false; return; }
    if (!db && !loadAttemptedRef.current) {
      loadAttemptedRef.current = true;
      loadDb();
    }
  }, [isAuthenticated, accounts, db, loadDb]);

  // AI 설정(API 키)을 같은 계정의 기기끼리 맞춘다 — 가계부를 불러온 뒤 한 번, 그리고 앱으로 돌아오거나
  // 다시 온라인이 될 때. 다른 기기에서 넣은 키가 있으면 이 기기에서 다시 입력하지 않아도 되고,
  // 다른 기기에서 지운 키는 열어 둔 앱에서도 지워진다. 실패하면 다음 기회에 다시 한다.
  useEffect(() => {
    setAISyncAccount(isAuthenticated ? storage : null);
    setAIDraftAccount(isAuthenticated ? storage?.accountKey : ''); // AI 입력의 남은 글도 이 계정에 묶는다 (I-023)
    if (!isAuthenticated) aiSyncedRef.current = false;
  }, [isAuthenticated, storage]);

  const lastAISyncRef = React.useRef(0);
  const runAISync = useCallback(() => {
    lastAISyncRef.current = Date.now();
    const hadKey = !!activeAI();
    syncAISettings()
      .then(result => {
        if (result === 'pulled' && !hadKey && activeAI()) showToast('✓ 다른 기기에서 저장한 AI 설정을 불러왔습니다');
      })
      .catch(() => { /* 오프라인·재로그인 필요 등 — 다음 기회에 다시 */ });
  }, [showToast]);

  useEffect(() => {
    if (!db || aiSyncedRef.current) return;
    aiSyncedRef.current = true;
    runAISync();
  }, [db, runAISync]);

  useEffect(() => {
    if (!db) return undefined;
    const onVisible = () => {
      // 화면을 빠르게 껐다 켤 때 겹쳐 부르지 않게 10초에 한 번까지만
      if (document.visibilityState === 'visible' && Date.now() - lastAISyncRef.current > 10 * 1000) runAISync();
    };
    window.addEventListener('online', runAISync);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', runAISync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [db, runAISync]);

  // 동기화 안내(병합·자동등록 등)는 토스트로 보여준다
  useEffect(() => {
    if (notice) showToast(notice.text);
  }, [notice, showToast]);

  // DB 최초 로드 완료 시 브라우저 히스토리 초기화
  useEffect(() => {
    if (!db || historyInitialized.current) return;
    historyInitialized.current = true;
    window.history.replaceState(navRef.current, '');
  }, [db]);

  // 첫 실행 안내 (F-3) — 처음 불러온 가계부가 비어 있으면(카테고리·결제수단·거래가 하나도 없음) 한 번 연다.
  // 이 기기에서 '나중에'를 골랐으면 저절로 열지 않는다. 거래내역 빈 화면에서 언제든 다시 열 수 있다
  const live = useDbSnapshot(db, dataVersion);
  const blankLedger = useMemo(() => !!live.db && isBlankLedger(live.db), [live]);
  const accountKey = storage?.accountKey || '';
  const onboardingCheckedRef = React.useRef(false);
  useEffect(() => {
    if (!db) { onboardingCheckedRef.current = false; return; }
    if (onboardingCheckedRef.current) return;
    onboardingCheckedRef.current = true;
    if (blankLedger && !isOnboardingPostponed(accountKey)) navigate({ showOnboarding: true });
  }, [db, blankLedger, accountKey, navigate]);

  // 홈 화면 바로가기·공유 받기 (I-024) — 가계부를 연 뒤 한 번: 공유로 받아 둔 사진·글이 있으면 AI 입력으로,
  // 바로가기(?action=add|ai)면 입력 창을 연다. 빈 가계부는 첫 실행 안내가 먼저다(받아 둔 것은 버린다 — 넣을 분류가 없다).
  // 주소의 표시는 지운다 — 새로고침해도 또 열리지 않게
  const launchRef = React.useRef(readLaunchAction());
  const launchHandledRef = React.useRef(false);
  const blankLedgerRef = React.useRef(blankLedger);
  blankLedgerRef.current = blankLedger;
  useEffect(() => {
    if (!db || launchHandledRef.current) return;
    launchHandledRef.current = true;
    const action = launchRef.current;
    launchRef.current = null;
    if (action) window.history.replaceState(window.history.state, '', window.location.pathname);
    (async () => {
      const shared = await takeSharedItems().catch(() => null);
      // 꺼내는 사이 로그아웃했거나 빈 가계부(첫 실행 안내)면 열지 않는다
      if (!dbRef.current || blankLedgerRef.current) return;
      if (shared) {
        setAiStart({ text: shared.text, files: shared.files });
        navigate({ showForm: true, editingTx: null });
      } else if (action === 'add' || action === 'ai') {
        setAiStart(action === 'ai' ? { quick: true } : null);
        navigate({ showForm: true, editingTx: null });
      }
    })();
  }, [db, navigate]);

  // 입력 창이 닫히면 AI 입력 시작 정보를 버린다 — 다음에 열 때는 평소대로
  useEffect(() => { if (!showForm) setAiStart(null); }, [showForm]);

  const handleOnboardingDone = useCallback((counts) => {
    setShowOnboarding(false);
    window.history.back();
    showToast(`✓ 카테고리 ${counts.categories}개·결제수단 ${counts.paymentMethods}개를 넣었습니다`);
  }, [showToast]);

  const handleOnboardingLater = useCallback(() => {
    postponeOnboarding(accountKey);
    setShowOnboarding(false);
    window.history.back();
  }, [accountKey]);

  const handleOnboardingClose = useCallback(() => {
    setShowOnboarding(false);
    window.history.back();
  }, []);

  // 안내가 열려 있다고 기록된 채 가계부가 비지 않게 되면(가져오기를 마치고 돌아옴, 다른 기기의 변경이 합쳐짐) 그 기록을 지운다 —
  // 보이지 않는 안내가 뒤로가기 한 번을 삼키거나, 이후 화면 이동마다 따라붙지 않게. 보이던 안내가 닫혔으면 이유를 알린다
  const onboardingVisibleRef = React.useRef(false);
  useEffect(() => {
    if (showOnboarding && !blankLedger) {
      setShowOnboarding(false);
      if (window.history.state?.showOnboarding) {
        window.history.back(); // 지금 항목이 안내를 연 기록이면 물린다 — 앞 항목(목록)으로 돌아간다
      } else {
        navRef.current = { ...navRef.current, showOnboarding: false };
        window.history.replaceState(navRef.current, '');
      }
      if (onboardingVisibleRef.current) showToast('다른 기기에서 카테고리·결제수단을 만들어 첫 실행 안내를 닫았습니다');
    }
    onboardingVisibleRef.current = showOnboarding && blankLedger;
  }, [showOnboarding, blankLedger, showToast]);

  // 저장은 자동으로 된다 — 여기서는 DB에 반영하고 결과만 알린다.
  // 저장 실패는 헤더의 '저장 안 됨' 표시와 오류 배너로 따로 보여준다 (B-003).
  // '누가'를 정하지 않고 들어온 새 거래는 이 기기 사용자로 (I-013) — 폼은 직접 고른 값(빈 값 포함)을 넘긴다
  const withMember = useCallback((row) => (
    row.member === undefined ? { ...row, member: resolveDeviceMember(db) } : row
  ), [db]);

  // AI 입력이 자주 넣던 거래를 바로 넣는다 (I-022) — 확인할 것이 남아 있으면 입력 창은 열어 둔다(done이 아님).
  // 분석을 기다리는 사이 저장소에서 다시 받아 DB가 바뀌었을 수 있어, 넣을 때와 되돌릴 때 모두 그 순간의 DB(dbRef)를 쓴다.
  // 되돌리기는 넣을 때의 모습과 같은 행만 지운다(병합으로 id가 바뀌었으면 같은 모습의 행을 찾고, 고친 것은 그대로).
  // 반환: { undo, onUndone } — 확인 화면 안의 되돌리기 버튼도 같은 것을 부른다.
  //  - undo(): 지운 개수 — 한 번만 지우고, 다시 부르면(알림과 화면 버튼 둘 다) 그때의 개수를 돌려준다. DB가 없으면 null
  //  - onUndone(fn): 어디서 되돌리든(알림·화면 버튼) fn(지운 개수)을 부른다 — 확인 화면이 목록을 맞춘다. 반환은 구독 해제
  const handleQuickAdd = useCallback((inputRows, { done = false } = {}) => {
    const target = dbRef.current;
    const rows = inputRows.map(row => (row.member === undefined ? { ...row, member: resolveDeviceMember(target) } : row));
    if (!rows.length || !target) return null;
    const snapshots = [];
    withTransaction(target, () => rows.forEach(row => snapshots.push(addedSnapshot(addTransaction(target, row), row))));
    if (done) {
      setShowForm(false);
      setEditingTx(null);
      window.history.back();
    }
    let removed = null;
    const listeners = new Set();
    const undo = () => {
      if (removed !== null) return removed;
      if (!dbRef.current) return null;
      removed = removeAddedTransactions(dbRef.current, snapshots);
      showTopToast(removed === snapshots.length
        ? `✓ 방금 바로 넣은 ${removed}건을 되돌렸습니다`
        : `${removed}건만 되돌렸습니다 — 나머지는 그사이 고쳐졌거나 지워졌습니다`);
      listeners.forEach(fn => fn(removed));
      listeners.clear();
      return removed;
    };
    const onUndone = (fn) => {
      if (removed !== null) { fn(removed); return () => {}; }
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    };
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const what = rows.length > 1 ? `${rows.length}건 ${total.toLocaleString()}원` : `${rows[0].detail || rows[0].budget_category} ${total.toLocaleString()}원`;
    showTopToast(`✓ 자주 넣던 ${what} 바로 추가됨`, { label: '되돌리기', onClick: undo });
    return { undo, onUndone };
  }, [showTopToast]);

  const handleAdd = useCallback((txData, { keepOpen = false } = {}) => {
    // 분할 결제는 거래 2건으로 들어온다
    const rows = (Array.isArray(txData) ? txData : [txData]).map(withMember);
    withTransaction(db, () => rows.forEach(row => addTransaction(db, row)));

    // 연속 입력 중이면 폼을 열어둔 채 뒤에서 저장한다
    if (!keepOpen) {
      setShowForm(false);
      setEditingTx(null);
      window.history.back();
    }
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const label = rows.length > 1
      ? `${rows[0].budget_category} ${total.toLocaleString()}원 분할 ${rows.length}건`
      : `${rows[0].budget_category} ${total.toLocaleString()}원`;
    showToast(`✓ ${label} 추가됨`);
  }, [db, showToast, withMember]);

  // 말로 입력·카드 문자로 여러 건을 한 번에 반영 — 카드 문자의 승인 취소는 지울 거래(deleteIds)로 함께 온다 (I-012)
  const handleBulkAdd = useCallback((inputRows, { deleteIds = [] } = {}) => {
    const rows = inputRows.map(withMember);
    if (!rows.length && !deleteIds.length) return;
    withTransaction(db, () => {
      rows.forEach(row => addTransaction(db, row));
      deleteIds.forEach(id => deleteTransaction(db, id));
    });
    setShowForm(false);
    setEditingTx(null);
    window.history.back();
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const parts = [];
    if (rows.length) parts.push(`${rows.length}건 ${total.toLocaleString()}원 추가`);
    if (deleteIds.length) parts.push(`취소된 거래 ${deleteIds.length}건 삭제`);
    showToast(`✓ ${parts.join(', ')}됨`);
  }, [db, showToast, withMember]);

  const handleUpdate = useCallback((txData) => {
    // 분할 결제는 묶음 전체를 한 번에 반영한다.
    // id가 있으면 갱신, 없으면 새로 만들고, 묶음에 있었는데 빠진 건 삭제한다.
    const rows = Array.isArray(txData) ? txData : [txData];
    const priorIds = editingTx.split_group_id
      ? getSplitGroupTransactions(db, editingTx.split_group_id).map(t => t.id)
      : [editingTx.id];

    const keptIds = new Set(rows.map(r => r.id).filter(Boolean));
    withTransaction(db, () => {
      rows.forEach(row => {
        if (row.id) updateTransaction(db, row.id, row);
        else addTransaction(db, row);
      });
      priorIds.filter(id => !keptIds.has(id)).forEach(id => deleteTransaction(db, id));
    });

    setShowForm(false);
    setEditingTx(null);
    window.history.back();
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const amt = total.toLocaleString();
    showToast(rows.length > 1
      ? `✓ ${rows[0].budget_category} ${amt}원 분할 ${rows.length}건 수정됨`
      : `✓ ${rows[0].budget_category} ${amt}원 수정됨`);
  }, [db, editingTx, showToast]);

  // id 하나 또는 id 배열(분할 묶음 전체 삭제 등)
  const handleDelete = useCallback((idOrIds) => {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    withTransaction(db, () => ids.forEach(id => deleteTransaction(db, id)));
    showToast(ids.length > 1 ? `✓ 거래 ${ids.length}건이 삭제되었습니다` : '✓ 거래가 삭제되었습니다');
  }, [db, showToast]);

  /** 화면이 변경 후 부르는 콜백 — 바로 저장하고, 성공하면 안내한다 */
  const saveWithToast = useCallback(async (msg = '✓ 저장됨') => {
    const ok = await saveNow();
    if (ok) showToast(msg);
    return ok;
  }, [saveNow, showToast]);

  const loggingOutRef = React.useRef(false); // 로그아웃 진행 중 — 두 번 눌러도 한 번만
  const handleLogout = useCallback(async () => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    try {
      if (dirty) {
        const ok = await saveNow();
        if (!ok && !window.confirm(`저장되지 않은 변경 ${pendingCount}건이 있습니다.\n로그아웃하면 이 변경은 사라집니다. 그래도 로그아웃할까요?`)) {
          loggingOutRef.current = false;
          return;
        }
      }
      if (Object.values(getAIConfig().keys).some(k => String(k || '').trim())) {
        // 키를 지울지 묻기 전에 OneDrive와 맞춰 본다 — 이 기기에서 바꾼 것이 올라가 있어야 지워도 다른 기기·다시 로그인에 남는다.
        // 신호가 약해도 로그아웃이 멈추지 않게 5초까지만 기다린다
        showToast('로그아웃하는 중…');
        let synced = false;
        let timer;
        try {
          const result = await Promise.race([
            syncAISettings(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5000); }),
          ]);
          synced = result !== 'offline' && result !== 'cancelled';
        } catch (e) { /* 맞추지 못함 — 아래 안내로 알린다 */ }
        clearTimeout(timer);
        const ai = getAIConfig();
        const note = synced && !Object.keys(ai.pending).length
          ? '다른 사람도 쓰는 기기라면 지우는 것을 권장합니다. OneDrive에 저장된 키는 그대로라, 다시 로그인하면 자동으로 불러옵니다'
          : '지금 OneDrive와 맞추지 못했습니다. 지우면 이 기기에만 있던 키나 바꾼 설정은 사라질 수 있습니다. 다시 로그인하면 OneDrive에 있는 설정을 불러옵니다';
        if (window.confirm(`이 기기에 저장된 AI API 키도 지울까요?\n(${note})`)) clearAIKeys();
      }
      clearAIDraft(); // AI 입력에 쓰다 남은 글은 이 계정의 것 — 다음에 로그인하는 사람에게 보이지 않게
      // 공유로 받아 두고 아직 꺼내지 않은 사진·글과 이 기기의 가계부 사본도 지운다 (B-004, I-024) — 로그인 화면으로
      // 넘어가며 문서가 내려가면 지우기가 끊길 수 있어 잠깐(최대 3초) 기다린다
      const clearing = Promise.all([clearSharedItems(), resetForLogout()]);
      await Promise.race([clearing, new Promise(r => setTimeout(r, 3000))]);
      await instance.logoutRedirect({ account: accounts[0] });
    } catch (e) {
      loggingOutRef.current = false;
      setError(`로그아웃 실패: ${e.message}`);
    }
  }, [dirty, pendingCount, saveNow, resetForLogout, instance, accounts, setError, showToast]);

  const openAdd = (date) => {
    setDefaultFormDate(typeof date === 'string' ? date : null);
    navigate({ showForm: true, editingTx: null });
  };

  const openEdit = (tx) => {
    navigate({ showForm: true, editingTx: tx });
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingTx(null);
    setDefaultFormDate(null);
    window.history.back();
  };

  const handleImport = useCallback(async () => {
    setShowImport(false);
    window.history.back();
    await saveWithToast('✓ 가져오기 완료 및 저장됨');
  }, [saveWithToast]);

  if (!isAuthenticated) return <LoginPage />;

  if (!db) {
    return (
      <div className="loading-page">
        {loading ? (
          <>
            <div className="spinner" />
            <p>OneDrive에서 가계부를 불러오는 중…</p>
          </>
        ) : (
          <>
            {error && <p className="error-msg">{error}</p>}
            <button className="btn-primary" onClick={() => loadDb()}>가계부 불러오기</button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="app-container">
      <Header
        onRefresh={() => loadDb()}
        onSave={() => saveNow()}
        onLogout={handleLogout}
        loading={loading}
        saving={saving}
        dirty={dirty}
        offline={offline}
        pendingCount={pendingCount}
        onSettings={() => { navigate({ activeTab: 'settings' }); document.querySelector('.app-main')?.scrollTo(0, 0); }}
        settingsActive={activeTab === 'settings'}
      />

      {toast && (
        <div className="toast-banner">
          {toast}
        </div>
      )}
      {topToast && (
        <div className="toast-banner toast-top" role="status">
          <span>{topToast.text}</span>
          {topToast.action && (
            <button type="button" className="toast-action-btn" onClick={() => { const { onClick } = topToast.action; hideTopToast(); onClick(); }}>
              {topToast.action.label}
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="error-banner" onClick={() => setError('')}>
          ⚠️ {error} (탭하여 닫기)
        </div>
      )}

<main className="app-main">
        {activeTab === 'list' && (
          <TransactionList
            db={db}
            dataVersion={dataVersion}
            goTodayKey={listGoTodayKey}
            onAdd={openAdd}
            onEdit={openEdit}
            onDelete={handleDelete}
            onChanged={() => saveWithToast()}
            onOpenImport={() => navigate({ showImport: true })}
            onOpenOnboarding={() => navigate({ showOnboarding: true })}
            onOpenSettings={(section) => {
              navigate({
                activeTab: 'settings', settingsSection: section,
                settingsDrilldownCategory: null, settingsDrilldownTrip: null, settingsDrilldownPayment: null,
              });
              document.querySelector('.app-main')?.scrollTo(0, 0);
            }}
            onOpenCardCheck={() => navigate({ showCardCheck: true })}
            onOpenAccount={(id) => {
              navigate({ activeTab: 'account', accountDrilldown: { id }, accountDetailTab: 'transactions' });
              document.querySelector('.app-main')?.scrollTo(0, 0);
            }}
            onOpenBudget={(month) => {
              // 예산 알림 → 요약 › 카테고리의 그 달 예산 대비 (I-025)
              showSummaryMonth(month);
              navigate({ activeTab: 'summary', summaryTab: 'category', summaryDrilldown: null });
              document.querySelector('.app-main')?.scrollTo(0, 0);
            }}
          />
        )}
        {activeTab === 'summary' && (
          <SummaryView
            db={db}
            dataVersion={dataVersion}
            tab={summaryTab}
            drilldownCategory={summaryDrilldown}
            onTabChange={(t) => navigate({ summaryTab: t, summaryDrilldown: null })}
            onDrilldownChange={(d) => navigate({ summaryDrilldown: d })}
          />
        )}
        {activeTab === 'calendar' && (
          <CalendarView
            db={db}
            dataVersion={dataVersion}
            goTodayKey={calendarGoTodayKey}
            onChanged={() => saveWithToast()}
            showEventForm={showEventForm}
            onOpenEventForm={() => navigate({ showEventForm: true })}
            onCloseEventForm={() => { setShowEventForm(false); window.history.back(); }}
            onAddTransaction={openAdd}
            onEditTransaction={openEdit}
          />
        )}
        {activeTab === 'account' && (
          <AccountManagement
            db={db}
            dataVersion={dataVersion}
            drilldown={accountDrilldown}
            detailTab={accountDetailTab}
            showForm={showAccountForm}
            onDrilldownChange={(v) => navigate({ accountDrilldown: v })}
            onDetailTabChange={(t) => navigate({ accountDetailTab: t })}
            onCloseForm={() => setShowAccountForm(false)}
            onChanged={() => {
              runAccountAutoRegister(db);
              return saveWithToast();
            }}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsView
            db={db}
            dataVersion={dataVersion}
            onChanged={() => saveWithToast('✓ 설정이 저장됨')}
            backup={backupApi}
            activeSection={settingsSection}
            drilldownCategory={settingsDrilldownCategory}
            drilldownTrip={settingsDrilldownTrip}
            drilldownPayment={settingsDrilldownPayment}
            onSectionChange={(sec) => navigate({
              settingsSection: sec,
              settingsDrilldownCategory: null,
              settingsDrilldownTrip: null,
              settingsDrilldownPayment: null,
            })}
            onDrilldownCategoryChange={(v) => navigate({ settingsDrilldownCategory: v })}
            onDrilldownTripChange={(v) => navigate({ settingsDrilldownTrip: v })}
            onDrilldownPaymentChange={(v) => navigate({ settingsDrilldownPayment: v })}
          />
        )}
      </main>

      {/* 하단 네비게이션 */}
      <nav className="bottom-nav">
        <button
          className={activeTab === 'list' ? 'nav-item active' : 'nav-item'}
          onClick={() => {
            if (activeTab === 'list') {
              setListGoTodayKey(k => k + 1);
            } else {
              navigate({ activeTab: 'list' });
            }
          }}
        >
          <span className="nav-icon">📋</span>
          <span className="nav-label">거래내역</span>
        </button>
        <button
          className={activeTab === 'summary' ? 'nav-item active' : 'nav-item'}
          onClick={() => { navigate({ activeTab: 'summary' }); document.querySelector('.app-main')?.scrollTo(0, 0); }}
        >
          <span className="nav-icon">📊</span>
          <span className="nav-label">요약</span>
        </button>
        <button
          className={`nav-item nav-add${activeTab === 'calendar' ? ' nav-add--event' : activeTab === 'account' ? ' nav-add--account' : ''}`}
          onClick={
            activeTab === 'calendar'
              ? () => navigate({ showEventForm: true })
              : activeTab === 'account'
                ? () => { setShowAccountForm(true); }
                : openAdd
          }
        >
          <span className="nav-icon-add">{activeTab === 'calendar' ? '📅' : activeTab === 'account' ? '💳' : '+'}</span>
        </button>
        <button
          className={activeTab === 'calendar' ? 'nav-item active' : 'nav-item'}
          onClick={() => {
            if (activeTab === 'calendar') {
              setCalendarGoTodayKey(k => k + 1);
              document.querySelector('.app-main')?.scrollTo(0, 0);
            } else {
              navigate({ activeTab: 'calendar' });
              document.querySelector('.app-main')?.scrollTo(0, 0);
            }
          }}
        >
          <span className="nav-icon">🗓️</span>
          <span className="nav-label">캘린더</span>
        </button>
        <button
          className={activeTab === 'account' ? 'nav-item active' : 'nav-item'}
          onClick={() => { navigate({ activeTab: 'account', accountDrilldown: null }); document.querySelector('.app-main')?.scrollTo(0, 0); }}
        >
          <span className="nav-icon">🏦</span>
          <span className="nav-label">계좌</span>
        </button>
      </nav>

      {/* 거래 추가/수정 모달 */}
      {showForm && (
        <TransactionForm
          db={db}
          dataVersion={dataVersion}
          editingTx={editingTx}
          defaultDate={defaultFormDate}
          aiStart={editingTx ? null : aiStart}
          onSave={editingTx ? handleUpdate : handleAdd}
          onBulkAdd={handleBulkAdd}
          onQuickAdd={handleQuickAdd}
          onCancel={closeForm}
        />
      )}

      {/* 카드 내역 대조 */}
      {showCardCheck && (
        <CardStatementModal
          db={db}
          dataVersion={dataVersion}
          onChanged={() => saveNow()}
          onClose={() => { setShowCardCheck(false); window.history.back(); }}
        />
      )}

      {/* 첫 실행 안내 — 가계부가 비어 있을 때만 (기본값을 넣으면 바로 닫힌다) */}
      {showOnboarding && blankLedger && (
        <Onboarding
          db={db}
          accountLabel={accounts[0]?.username ? `${accounts[0].username}의 OneDrive` : ''}
          onDone={handleOnboardingDone}
          onClose={handleOnboardingClose}
          onLater={handleOnboardingLater}
          onOpenImport={() => navigate({ showOnboarding: false, showImport: true })}
        />
      )}

      {/* CSV 가져오기 모달 */}
      {showImport && (
        <ImportModal
          db={db}
          dataVersion={dataVersion}
          onImport={handleImport}
          onClose={() => { setShowImport(false); window.history.back(); }}
        />
      )}
    </div>
  );
}

export default App;
