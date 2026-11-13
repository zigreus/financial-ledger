import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import './App.css';

import LoginPage from '../LoginPage/LoginPage';
import Header from '../Header/Header';
import TransactionList from '../TransactionList/TransactionList';
import TransactionForm from '../TransactionForm/TransactionForm';
import { showSummaryMonth, showSummaryReportMonth } from '../SummaryView/summaryState';
// 첫 화면에 필요 없는 화면은 열 때 불러온다 (I-033) — 로그인 뒤 쉬는 틈에 미리 불러 둔다
import {
  SummaryView, SettingsView, CalendarView, AccountManagement, ImportModal, CardStatementModal, Onboarding, AIAssistant, preloadScreens,
} from './screens';
import { runPlan, undoPlan, describeRun } from '../../services/aiCommand';
import { ModalLoading } from '../common/lazyScreen';
import { addTransaction, updateTransaction, deleteTransaction, deleteTransactionsForUndo, restoreDeletedTransactions, getSplitGroupTransactions, runAccountAutoRegister, withTransaction, isBlankLedger, addedSnapshot, removeAddedTransactions } from '../../services/dbManager';
import { getAIConfig, clearAIKeys, activeAI } from '../../services/aiClient';
import { setAISyncAccount, syncAISettings } from '../../services/aiSettingsSync';
import useLedgerSync from '../../hooks/useLedgerSync';
import { createOneDriveStorage, isPersonalMicrosoftAccount, sharedLedgerKey, SHARED_GONE_MESSAGE } from '../../services/storage/oneDrive';
import { clearPending, countPendingForAccount, loadPending } from '../../services/changeLog';
import {
  OWN_LEDGER, addSharedLedger, clearPendingJoin, getCurrentLedgerId, getSharedLedgers, peekPendingJoin,
  removeSharedLedger, setCurrentLedgerId, syncLedgerList,
} from '../../services/ledgers';
import { JoinLedgerDialog, LedgerSwitcher } from './LedgerDialogs';
import { createGoogleDriveStorage } from '../../services/storage/googleDrive';
import { OfflineError, ReconnectRequiredError } from '../../services/storage/provider';
import { getGoogleSession, isGoogleTokenValid, markGoogleTokenExpired, googleLogout } from '../../auth/googleAuth';
import { useGoogleSession } from '../../hooks/useGoogleSession';
import GoogleReconnectBanner from './GoogleReconnectBanner';
import { setCurrentDrive } from '../../services/storage/driveName';
import { resolveDeviceMember } from '../../services/deviceMember';
import { isOnboardingPostponed, postponeOnboarding } from '../../services/onboardingPrefs';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';
import { useTopToast } from '../../hooks/useTopToast';
import { clearAIDraft, setAIDraftAccount } from '../../services/aiDraft';
import { clearSharedItems, readLaunchAction, takeSharedItems } from '../../services/shareInbox';
import { recordError } from '../../services/errorLog';
import ProblemReport from '../common/lazyProblemReport';
import PrivacyCurtain from './PrivacyCurtain';
import { collectOpenNotices, hasVisibleNotices } from '../TransactionList/OpenNotices';
import { HIDE_AGAIN_AFTER_MS, getHideOnOpen, getStartTab, onDisplayPrefsChange } from '../../services/displayPrefs';

/** 참여 링크를 열었는데 그 가계부에 닿지 못할 때 — 대개 초대받지 않은 계정으로 로그인했거나 초대를 아직 받지 않았다 */
const JOIN_DENIED_MESSAGE = '이 가계부를 열 수 없어요 — 초대받은 Microsoft 계정으로 로그인했는지 확인해 주세요. 초대 메일을 한 번 열어 본 뒤 참여 링크를 다시 누르면 열릴 수도 있어요.';

// 처음 화면 상태 — 뒤로가기 기록(history)에 담는다. epoch: 어느 가계부에서 쌓인 기록인지(M-2)
const INITIAL_NAV = {
  activeTab: 'list', showForm: false, showImport: false, showCardCheck: false, showEventForm: false, showOnboarding: false, editingTx: null, copyFromTx: null,
  summaryTab: 'monthly', summaryDrilldown: null,
  settingsSection: 'payment',
  settingsDrilldownCategory: null, settingsDrilldownTrip: null, settingsDrilldownPayment: null,
  accountDrilldown: null, accountDetailTab: 'transactions', showAccountForm: false,
  showLedgerSwitcher: false,
  showAssistant: false,
  epoch: 0,
};

function App() {
  const msalAuthenticated = useIsAuthenticated();
  const { instance, accounts } = useMsal();
  // Google 로그인 (M-1, I-031) — 이 기기에 Google 세션이 있으면 Google Drive를 쓴다(토큰이 끝났어도 세션은 남는다)
  const { session: googleSession, tokenValid: googleTokenValid } = useGoogleSession();
  const googleSub = googleSession?.sub || '';
  const provider = googleSub ? 'google' : (msalAuthenticated && accounts.length ? 'microsoft' : null);
  const isAuthenticated = !!provider;
  const driveName = provider === 'google' ? 'Google Drive' : 'OneDrive';
  setCurrentDrive(provider);   // 화면 문구(머리글·AI 설정·백업 안내)가 쓰는 저장소 이름

  // 가계부·백업·AI 설정 파일을 두는 저장소 (F-2) — 로그인한 계정의 OneDrive 또는 Google Drive. 로그인 전에는 null
  const baseStorage = useMemo(() => {
    if (googleSub) {
      return createGoogleDriveStorage({
        accountKey: `google:${googleSub}`,
        // 토큰은 부를 때마다 읽는다 — 다시 연결해 바뀌어도 저장소를 새로 만들지 않게. 끝났으면 연결 없음처럼(ReconnectRequiredError)
        getToken: () => {
          const s = getGoogleSession();
          if (!s || s.sub !== googleSub || !isGoogleTokenValid(s)) throw new ReconnectRequiredError();
          return s.accessToken;
        },
        onUnauthorized: markGoogleTokenExpired,
      });
    }
    return accounts.length ? createOneDriveStorage(instance, accounts) : null;
  }, [googleSub, instance, accounts]);

  // 다른 계정과 함께 쓰기 (M-2, 1단계 Microsoft 개인 계정) — 공유받은 가계부 목록과 이 기기에서 지금 보는 가계부
  const msAccount = provider === 'microsoft' ? accounts[0] : null;
  const msAccountKey = msAccount?.homeAccountId || '';
  const canShare = !!msAccount && isPersonalMicrosoftAccount(msAccount);
  const [ledgerVersion, setLedgerVersion] = useState(0);   // 목록·지금 가계부가 바뀌면 올린다
  const sharedLedgers = useMemo(
    () => (canShare ? getSharedLedgers(msAccountKey) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canShare, msAccountKey, ledgerVersion],
  );
  const currentLedgerId = useMemo(
    () => (canShare ? getCurrentLedgerId(msAccountKey) : OWN_LEDGER),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canShare, msAccountKey, ledgerVersion],
  );
  const currentLedger = sharedLedgers.find(l => l.id === currentLedgerId) || null;
  // 지금 쓰는 가계부의 저장소 — 공유받은 가계부면 그 파일(백업 없음), 아니면 내 가계부. AI 설정 파일은 늘 내 앱 폴더
  const ownStorage = baseStorage;
  const storage = useMemo(() => (
    currentLedger && ownStorage && !googleSub
      ? createOneDriveStorage(instance, accounts, { ledger: { driveId: currentLedger.driveId, itemId: currentLedger.itemId } })
      : ownStorage
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [ownStorage, currentLedger?.id, googleSub]);

  // DB 불러오기·자동 저장·충돌 병합은 useLedgerSync가 맡는다.
  // 컴포넌트는 db에 쓰기만 하면 자동으로 저장된다. 화면은 dataVersion으로 갱신한다.
  const {
    db, dataVersion, loading, saving, error, setError, notice, offline, catchingUp, syncing, serviceDown,
    dirty, pendingCount, loadDb, saveNow, resetForLogout, closeLedger,
    listBackups, createBackup, restoreBackup, replaceWithFile,
  } = useLedgerSync({ storage });
  // 늦게 끝나는 일(AI 입력의 바로 넣기·되돌리기)이 그 순간의 DB를 쓰게 — 저장소에서 다시 받으면 DB 객체가 바뀐다
  const dbRef = React.useRef(db);
  dbRef.current = db;
  // 설정 › 데이터의 백업 목록·직접 백업·되돌리기 (I-014)·가계부 파일로 바꾸기 (I-035) — 같은 객체를 유지해 목록을 매번 다시 부르지 않게
  const backupApi = useMemo(
    () => ({ list: listBackups, create: createBackup, restore: restoreBackup, replaceWithFile, shared: !!storage?.isShared }),
    [listBackups, createBackup, restoreBackup, replaceWithFile, storage],
  );
  const [activeTab, setActiveTab] = useState('list'); // 'list' | 'summary' | 'calendar' | 'account' | 'settings'
  const [showForm, setShowForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showCardCheck, setShowCardCheck] = useState(false);
  const [showLoadReport, setShowLoadReport] = useState(false); // 가계부를 불러오지 못한 화면의 '문제 알리기' (I-038)
  const [showAssistant, setShowAssistant] = useState(false); // AI 창 (I-051) — 뒤로가기 흐름(navigate)
  const [showLedgerSwitcher, setShowLedgerSwitcher] = useState(false); // 가계부 바꾸기 창 (M-2) — 뒤로가기 흐름(navigate)
  // 가계부를 열 때 가리기 (U-7) — 이 기기 설정을 켰으면 앱을 열 때 덮어 두고, 누르면 걷는다
  const [curtain, setCurtain] = useState(() => getHideOnOpen());
  // 설정에서 '가계부를 열 때 가리기'를 켜고 끄면 머리글의 🔒도 바로 따라간다
  const [hideOnOpen, setHideOnOpenOn] = useState(() => getHideOnOpen());
  useEffect(() => onDisplayPrefsChange(() => setHideOnOpenOn(getHideOnOpen())), []);
  const curtainRef = React.useRef(curtain);
  curtainRef.current = curtain;
  const [showEventForm, setShowEventForm] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false); // 첫 실행 안내 (F-3)
  const [editingTx, setEditingTx] = useState(null);
  const [copyFromTx, setCopyFromTx] = useState(null); // 이 거래로 새로 입력 (U-6)
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

  // 가계부를 바꿀 때마다 올린다(M-2) — 그 전 가계부에서 쌓인 뒤로가기 기록(계좌·여행 번호 등)은 새 가계부에서 처음 화면으로 연다.
  // 페이지를 새로 열 때마다 다른 값에서 시작한다 — 지난번에 연 페이지의 기록(다른 가계부였을 수 있다)도 쓰지 않게
  const ledgerEpochRef = React.useRef(Date.now());
  const navRef = React.useRef({ ...INITIAL_NAV, epoch: ledgerEpochRef.current });
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
    if ('copyFromTx' in s) setCopyFromTx(s.copyFromTx);
    if ('summaryTab' in s) setSummaryTab(s.summaryTab);
    if ('summaryDrilldown' in s) setSummaryDrilldown(s.summaryDrilldown);
    if ('settingsSection' in s) setSettingsSection(s.settingsSection);
    if ('settingsDrilldownCategory' in s) setSettingsDrilldownCategory(s.settingsDrilldownCategory);
    if ('settingsDrilldownTrip' in s) setSettingsDrilldownTrip(s.settingsDrilldownTrip);
    if ('settingsDrilldownPayment' in s) setSettingsDrilldownPayment(s.settingsDrilldownPayment);
    if ('accountDrilldown' in s) setAccountDrilldown(s.accountDrilldown);
    if ('accountDetailTab' in s) setAccountDetailTab(s.accountDetailTab);
    if ('showAccountForm' in s) setShowAccountForm(s.showAccountForm);
    if ('showLedgerSwitcher' in s) setShowLedgerSwitcher(s.showLedgerSwitcher);
    if ('showAssistant' in s) setShowAssistant(s.showAssistant);
  }, []);

  const navigate = useCallback((updates) => {
    const newState = { ...navRef.current, ...updates };
    navRef.current = newState;
    window.history.pushState(newState, '');
    applyNavState(updates);
  }, [applyNavState]);

  // 지금 기록을 바꾼다(새로 쌓지 않음) — 창에서 다른 화면으로 넘어갈 때, 뒤로가기가 닫은 창으로 돌아가지 않게 (I-051)
  const replaceNav = useCallback((updates) => {
    const newState = { ...navRef.current, ...updates };
    navRef.current = newState;
    window.history.replaceState(newState, '');
    applyNavState(updates);
  }, [applyNavState]);

  useEffect(() => {
    const onPopState = (e) => {
      if (e.state) {
        // 다른 가계부에서 쌓인 기록이면 처음 화면으로 — 그 가계부의 계좌·여행 번호가 새 가계부의 다른 것을 열지 않게(M-2)
        const next = (e.state.epoch || 0) === ledgerEpochRef.current
          ? e.state : { ...INITIAL_NAV, epoch: ledgerEpochRef.current };
        if (next !== e.state) window.history.replaceState(next, '');
        navRef.current = next;
        applyNavState(next);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyNavState]);

  // 열 때 불러오는 화면(요약·캘린더·계좌·설정·창들)을 로그인 뒤 쉬는 틈에 미리 불러 둔다 (I-033) —
  // 가계부를 드라이브에서 받는 동안 읽어 두어, 탭을 처음 눌러도 기다리지 않게. 실패하면 열 때 다시 시도한다
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => { preloadScreens(); }, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(() => { preloadScreens(); }, 1000);
    return () => clearTimeout(timer);
  }, [isAuthenticated]);

  // 로그인 후 DB 자동 로드 (실패하면 버튼으로 다시 시도)
  const loadedStorageRef = React.useRef(null);
  useEffect(() => {
    if (!isAuthenticated || !storage) { loadAttemptedRef.current = false; return; }
    // 가계부를 바꿨으면(M-2 — 저장소가 바뀌고 useLedgerSync가 지금 DB를 버린다) 그 가계부를 새로 불러온다
    if (loadedStorageRef.current !== storage) {
      loadedStorageRef.current = storage;
      loadAttemptedRef.current = false;
    }
    if (!db && !loadAttemptedRef.current) {
      loadAttemptedRef.current = true;
      loadDb();
    }
  }, [isAuthenticated, storage, db, loadDb]);

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

  // ── 다른 계정과 함께 쓰기 (M-2) ─────────────────────────────
  // 가계부 바꾸기 — 저장하지 못한 변경은 그 가계부 열쇠에 남아 돌아오면 이어서 저장한다(useLedgerSync)
  /**
   * 지금 가계부를 닫고 처음 화면으로 — 가계부를 바꾸기 직전(M-2). 미저장 변경은 그 가계부 열쇠에 남는다(useLedgerSync).
   * 진행 중이던 불러오기·저장의 결과는 버리고, 창·계좌·여행 같은 화면 상태와 뒤로가기 기록은 새 가계부에서 쓰지 않는다
   */
  const leaveCurrentLedger = useCallback(() => {
    hideTopToast();   // 앞 가계부의 '되돌리기'가 남지 않게
    closeLedger();
    loadAttemptedRef.current = false;   // 같은 저장소로 다시 열 때도(같은 가계부의 참여 링크) 불러오게
    ledgerEpochRef.current += 1;
    const initial = { ...INITIAL_NAV, epoch: ledgerEpochRef.current };
    navRef.current = initial;
    applyNavState(initial);
    window.history.replaceState(initial, '');
  }, [hideTopToast, closeLedger, applyNavState]);
  const currentLedgerIdRef = React.useRef(currentLedgerId);
  currentLedgerIdRef.current = currentLedgerId;
  const leaveCurrentLedgerRef = React.useRef(leaveCurrentLedger);
  leaveCurrentLedgerRef.current = leaveCurrentLedger;
  const switchLedger = useCallback(async (id) => {
    if (!msAccountKey || id === currentLedgerId) {
      if (showLedgerSwitcher) window.history.back();
      return;
    }
    if (dirty) await saveNow();
    leaveCurrentLedger();
    setCurrentLedgerId(msAccountKey, id);
    setLedgerVersion(v => v + 1);
  }, [msAccountKey, currentLedgerId, dirty, saveNow, leaveCurrentLedger, showLedgerSwitcher]);
  const switchLedgerRef = React.useRef(switchLedger);
  switchLedgerRef.current = switchLedger;
  /** 공유받은 가계부를 목록에서 뺀다 — 저장하지 못한 변경이 있으면 사라진다고 묻는다 */
  const leaveSharedLedger = useCallback(async (id) => {
    if (!msAccountKey) return;
    const ledger = sharedLedgers.find(l => l.id === id);
    const key = ledger ? sharedLedgerKey(msAccountKey, ledger) : '';
    if (id === currentLedgerId) {
      if (dirty && !(await saveNow())
        && !window.confirm(`이 가계부에 저장하지 못한 변경 ${pendingCount}건이 있어요.\n목록에서 빼면 이 변경은 사라져요. 그래도 뺄까요?`)) return;
      leaveCurrentLedger();
    } else {
      const left = key ? loadPending(key)?.entries.length || 0 : 0;
      if (left && !window.confirm(`그 가계부에 저장하지 못한 변경 ${left}건이 있어요.\n목록에서 빼면 이 변경은 사라져요. 그래도 뺄까요?`)) return;
    }
    if (key) clearPending(key);
    removeSharedLedger(msAccountKey, id);
    setLedgerVersion(v => v + 1);
    if (ownStorage) syncLedgerList(ownStorage).catch(() => {});
  }, [msAccountKey, sharedLedgers, currentLedgerId, dirty, saveNow, pendingCount, leaveCurrentLedger, ownStorage]);

  // 공유받은 가계부 목록을 이 계정의 다른 기기와 맞춘다(내 앱 폴더의 ledgers.json) — 가계부를 연 뒤 한 번
  const ledgerSyncedRef = React.useRef('');
  useEffect(() => {
    if (!canShare || !ownStorage || !db || ledgerSyncedRef.current === msAccountKey) return;
    ledgerSyncedRef.current = msAccountKey;
    syncLedgerList(ownStorage).then((changed) => {
      if (!changed) return;
      // 다른 기기에서 지금 보던 가계부를 목록에서 뺐다 — 닫고 내 가계부로(화면·뒤로가기 기록도 처음으로)
      const viewing = currentLedgerIdRef.current;
      if (viewing && !getSharedLedgers(msAccountKey).some(l => l.id === viewing)) leaveCurrentLedgerRef.current();
      setLedgerVersion(v => v + 1);
    }).catch(() => {});
  }, [canShare, ownStorage, db, msAccountKey]);

  // 참여 링크로 열었으면(index.js가 받아 둠) 로그인 뒤 '이 가계부를 열까요?'를 묻는다
  const [joinOffer, setJoinOffer] = useState(null);   // { driveId, itemId, ownerName, error, keep }
  const joinDismissedRef = React.useRef(false);   // 이번에 '나중에'를 눌렀다 — 다음에 앱을 열 때 다시 묻는다
  useEffect(() => {
    if (!isAuthenticated || !ownStorage || joinDismissedRef.current) return undefined;
    const join = peekPendingJoin();
    if (!join) return undefined;
    if (provider !== 'microsoft') {
      clearPendingJoin();
      setJoinOffer({ ...join, error: 'Microsoft 계정으로 공유된 가계부예요 — 로그아웃한 뒤 초대받은 Microsoft 계정으로 로그인해 주세요' });
      return undefined;
    }
    if (!canShare) {
      clearPendingJoin();
      setJoinOffer({ ...join, error: '회사·학교 Microsoft 계정은 아직 함께 쓰기를 지원하지 않아요 — 개인 Microsoft 계정으로 로그인해 주세요' });
      return undefined;
    }
    let alive = true;
    (async () => {
      try {
        const own = await ownStorage.sharing.ownLedgerRef().catch(() => null);
        if (own && own.driveId === join.driveId && own.itemId === join.itemId) {
          clearPendingJoin();   // 내 가계부의 링크 — 따로 넣을 것이 없다
          if (alive) showToast('내 가계부의 참여 링크예요 — 따로 넣을 것이 없어요');
          return;
        }
        const known = getSharedLedgers(msAccountKey).find(l => l.driveId === join.driveId && l.itemId === join.itemId);
        if (known) {
          // 이미 넣은 가계부 — 다시 묻지 않고 그 가계부로(보고 있으면 그대로)
          clearPendingJoin();
          if (alive && known.id !== currentLedgerIdRef.current) switchLedgerRef.current(known.id);
          return;
        }
        const info = await ownStorage.sharing.inspectShared(join);
        if (alive) setJoinOffer({ ...join, ownerName: info.ownerName || join.from || '' });
      } catch (e) {
        if (e instanceof OfflineError) return;   // 연결이 없다 — 받아 둔 링크는 그대로, 다음에 열 때 다시
        // 열 수 없음(403·404)이나 잘못된 링크(400 등 4xx) — 다시 물어도 같다. 408(시간 초과)·429(요청이 많음)는 잠깐의 오류
        if (e.message === SHARED_GONE_MESSAGE || /: 4(?!08|29)\d\d\b/.test(e.message)) {
          // 참여할 때 열 수 없는 까닭은 대개 다른 계정으로 로그인했거나 초대를 아직 받지 않은 것이다
          clearPendingJoin();
          if (alive) setJoinOffer({ ...join, error: JOIN_DENIED_MESSAGE });
          return;
        }
        // 잠깐의 오류(서버 등) — 링크는 남겨 두고 알린다
        if (alive) setJoinOffer({ ...join, keep: true, error: `공유받은 가계부를 확인하지 못했어요 — 잠시 뒤 앱을 다시 열어 주세요 (${e.message})` });
      }
    })();
    return () => { alive = false; };
  }, [isAuthenticated, ownStorage, provider, canShare, showToast, msAccountKey]);
  const acceptJoin = useCallback(async () => {
    const offer = joinOffer;
    setJoinOffer(null);
    clearPendingJoin();
    if (!offer || offer.error || !msAccountKey) return;
    const id = addSharedLedger(msAccountKey, offer);
    if (id === currentLedgerIdRef.current) { setLedgerVersion(v => v + 1); return; }   // 이미 보고 있다
    if (ownStorage) syncLedgerList(ownStorage).catch(() => {});
    if (dirty) await saveNow();
    leaveCurrentLedger();
    setCurrentLedgerId(msAccountKey, id);
    setLedgerVersion(v => v + 1);
  }, [joinOffer, msAccountKey, ownStorage, dirty, saveNow, leaveCurrentLedger]);
  // 나중에(또는 바깥·Esc) — 링크는 남겨 두고 다음에 앱을 열 때 다시 묻는다. 열 수 없는 링크면 버린다
  const dismissJoin = useCallback(() => {
    if (joinOffer?.error && !joinOffer.keep) clearPendingJoin();
    else joinDismissedRef.current = true;
    setJoinOffer(null);
    // 참여 링크 때문에 미뤄 둔 첫 실행 안내 — 내 가계부가 비어 있으면 이제 연다
    if (blankLedgerRef.current && !isOnboardingPostponed(storage?.accountKey || '')) navigate({ showOnboarding: true });
  }, [joinOffer, storage, navigate]);
  // 설정 › 데이터의 '다른 계정과 함께 쓰기'
  const ledgersApi = useMemo(() => ({
    provider,
    canShare,
    sharing: canShare ? ownStorage?.sharing || null : null,
    myName: msAccount?.name || '',
    current: currentLedger,
    shared: sharedLedgers,
    switchTo: switchLedger,
    leave: leaveSharedLedger,
  }), [provider, canShare, ownStorage, msAccount, currentLedger, sharedLedgers, switchLedger, leaveSharedLedger]);
  const ledgerName = currentLedger ? `${currentLedger.ownerName || '공유받은'} 가계부` : '';

  // 동기화 안내(병합·자동등록 등)는 토스트로 보여준다
  useEffect(() => {
    if (notice) showToast(notice.text);
  }, [notice, showToast]);

  // 화면 위 띠로 알린 오류(불러오기·저장 실패 등)는 이 기기의 오류 기록에도 남긴다 — '문제 알리기'에서 사용자가 보고 보낸다(I-038)
  useEffect(() => {
    if (error) recordError(error, { kind: '화면에 알린 오류' });
  }, [error]);

  // 가계부를 열면 불러오기 실패 화면의 문제 알리기를 닫아 둔다 — 다음에 또 실패하면 처음처럼 버튼부터
  useEffect(() => {
    if (db) setShowLoadReport(false);
  }, [db]);

  // DB 최초 로드 완료 시 브라우저 히스토리 초기화
  // 처음 여는 화면 (U-8) — 이 기기에서 고른 화면으로. 다만 '확인할 것'이 보일 때(I-036), 바로가기·공유로 열었을 때,
  // 빈 가계부(첫 실행 안내)일 때는 거래내역 그대로. 그리기 전에(useLayoutEffect) 정해 거래내역이 잠깐 보였다 바뀌지 않게
  useLayoutEffect(() => {
    if (!db || historyInitialized.current) return;
    historyInitialized.current = true;
    const start = getStartTab();
    if (start !== 'list' && !launchRef.current && !isBlankLedger(db) && !hasVisibleNotices(collectOpenNotices(db))) {
      navRef.current = { ...navRef.current, activeTab: start };
      setActiveTab(start);
    }
    window.history.replaceState(navRef.current, '');
  }, [db]);

  // 다른 앱으로 갈 때 바로 덮는다 (U-7) — 돌아온 뒤에 덮으면 돌아오는 첫 장면에 금액이 보인다
  // (앱 전환 화면의 미리 보기는 가려진 뒤에 찍지 않는 휴대폰도 있어 장담하지 않는다).
  // 금방(HIDE_AGAIN_AFTER_MS 안에) 돌아오면 저절로 걷는다. 그동안 휴대폰을 남에게 건넸을 수 있어 오래 있다 오면 그대로 둔다.
  // 가기 전부터 덮여 있었으면 그대로
  useEffect(() => {
    let hiddenAt = 0;
    let coveredOnLeave = false;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        coveredOnLeave = false;
        if (getHideOnOpen() && !curtainRef.current) {
          coveredOnLeave = true;
          flushSync(() => setCurtain(true));
        }
        return;
      }
      if (coveredOnLeave && hiddenAt && Date.now() - hiddenAt < HIDE_AGAIN_AFTER_MS) setCurtain(false);
      coveredOnLeave = false;
      hiddenAt = 0;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

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
    if (blankLedger && !isOnboardingPostponed(accountKey) && !peekPendingJoin()) navigate({ showOnboarding: true });
  }, [db, blankLedger, accountKey, navigate]);

  // 홈 화면 바로가기·공유 받기 (I-024) — 가계부를 연 뒤 한 번: 공유로 받아 둔 사진·글이 있으면 AI 입력으로,
  // 바로가기(?action=add|ai)면 입력 창을 연다. 빈 가계부는 첫 실행 안내가 먼저다(받아 둔 것은 버린다 — 넣을 분류가 없다).
  // 주소의 표시는 지운다 — 새로고침해도 또 열리지 않게
  const launchRef = React.useRef(readLaunchAction());
  const launchHandledRef = React.useRef(false);
  const blankLedgerRef = React.useRef(blankLedger);
  blankLedgerRef.current = blankLedger;
  // 화면을 가려 두었으면(U-7) 걷은 뒤에 연다 — 가린 뒤에서 입력 창이 열려 키보드가 올라오거나 공유한 글이 저절로 들어가지 않게
  useEffect(() => {
    if (!db || launchHandledRef.current || curtain) return;
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
        navigate({ showForm: true, editingTx: null, copyFromTx: null });
      } else if (action === 'ai') {
        navigate({ showAssistant: true });
      } else if (action === 'add') {
        setAiStart(null);
        navigate({ showForm: true, editingTx: null, copyFromTx: null });
      }
    })();
  }, [db, navigate, curtain]);

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

  // 입력 창이나 AI 창(I-051)을 닫는다 — 거래를 넣어 끝났을 때. 둘 중 하나만 열려 있다
  const closeEntry = useCallback(() => {
    setShowForm(false);
    setEditingTx(null);
    setShowAssistant(false);
    window.history.back();
  }, []);

  // AI 명령 실행 (I-051) — 그 순간의 DB에 한 트랜잭션으로 하고, 알림의 '되돌리기'로 되돌린다.
  // 되돌리기는 실행한 때와 같은 가계부에만(그사이 다시 불러왔으면 기록의 번호가 다른 행을 가리킬 수 있다 — handleDelete와 같다).
  // close: 실행한 뒤 창을 닫는다. 화면 열기가 있으면 창 대신 그 화면으로 바꾼다(뒤로가기가 닫은 창으로 돌아가지 않게).
  // 반환: { error } | { done }
  const handleCommand = useCallback((inputSteps, { close = true, planDb = null } = {}) => {
    const target = dbRef.current;
    if (!target) return { error: '가계부를 아직 불러오지 못했어요' };
    // 계획을 보는 사이 가계부를 다시 불러왔으면(다른 기기와 합침 등) 거래 번호가 다른 거래를 가리킬 수 있다 — 다시 읽게 한다
    if (planDb && planDb !== target) return { error: '그사이 가계부를 다시 불러왔어요 — 한 번 더 말해 주세요' };
    // 새로 넣는 거래의 '누가'는 이 기기 사용자 (I-013)
    const steps = inputSteps.map(st => (st.kind === 'tx_add' && st.data && st.data.row.member === undefined
      ? { ...st, data: { ...st.data, row: { ...st.data.row, member: resolveDeviceMember(target) } } } : st));
    let result;
    try {
      result = runPlan(target, steps);
    } catch (e) {
      return { error: e.message || '처리하지 못했어요' };
    }
    if (result.open) {
      const screen = result.open;
      const tab = ['list', 'summary', 'calendar', 'account'].includes(screen) ? screen : 'settings';
      const section = { recurring: 'recurring', budget: 'budget', features: 'features' }[screen];
      replaceNav({
        showForm: false, showAssistant: false, editingTx: null, copyFromTx: null, activeTab: tab,
        ...(section ? { settingsSection: section, settingsDrilldownCategory: null, settingsDrilldownTrip: null, settingsDrilldownPayment: null } : {}),
      });
    } else if (close) {
      closeEntry();
    }
    const text = [describeRun(steps), result.skipped ? `(그사이 바뀐 ${result.skipped}건은 그대로 두었어요)` : ''].filter(Boolean).join(' ');
    if (result.records.length) {
      let undone = false;
      const undo = () => {
        if (undone) return;
        undone = true;
        if (dbRef.current !== target) {
          showTopToast('그사이 가계부를 다시 불러와 되돌리지 못했습니다 — 필요하면 직접 고쳐 주세요');
          return;
        }
        try {
          const { undone: n, kept } = undoPlan(target, result.records);
          showTopToast(kept ? `${n}가지만 되돌렸습니다 — 나머지는 그사이 바뀌어 그대로 두었습니다` : '✓ 방금 한 일을 되돌렸습니다');
        } catch (e) {
          showTopToast(`되돌리지 못했습니다 — ${e.message}`);
        }
      };
      showTopToast(text || '✓ 했어요', { label: '되돌리기', onClick: undo });
    } else if (text) {
      showToast(text);
    }
    return { done: result.done };
  }, [closeEntry, replaceNav, showTopToast, showToast]);

  // AI 창에서 한 건을 '이대로 채우기' — 입력 창을 열어 채운다(AI 창 기록을 입력 창으로 바꾼다)
  const applyFromAssistant = useCallback((s) => {
    setAiStart({ apply: s });
    replaceNav({ showAssistant: false, showForm: true, editingTx: null, copyFromTx: null });
  }, [replaceNav]);

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
    if (done) closeEntry();
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
  }, [showTopToast, closeEntry]);

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
    closeEntry();
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const parts = [];
    if (rows.length) parts.push(`${rows.length}건 ${total.toLocaleString()}원 추가`);
    if (deleteIds.length) parts.push(`취소된 거래 ${deleteIds.length}건 삭제`);
    showToast(`✓ ${parts.join(', ')}됨`);
  }, [db, showToast, withMember, closeEntry]);

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

  // id 하나 또는 id 배열(분할 묶음 전체 삭제 등) — 화면 위 알림의 '되돌리기'로 되살릴 수 있다 (ROADMAP U-3)
  const handleDelete = useCallback((idOrIds) => {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    const target = db;
    const undoRecord = deleteTransactionsForUndo(target, ids);
    const count = undoRecord.transactions.length;
    if (!count) return;
    let restored = false;
    const undo = () => {
      if (restored) return;
      restored = true;
      // 지운 때와 같은 가계부에만 — 그사이 다시 불러왔으면(다른 기기와 합침·파일로 바꾸기·백업 되돌리기·다시 로그인)
      // 기록의 번호가 새 가계부의 다른 행을 가리킬 수 있어 되살리지 않는다
      if (dbRef.current !== target) {
        showTopToast('그사이 가계부를 다시 불러와 되돌리지 못했습니다 — 필요하면 다시 입력해 주세요');
        return;
      }
      const n = restoreDeletedTransactions(target, undoRecord);
      showTopToast(n > 1 ? `✓ 지운 거래 ${n}건을 되살렸습니다` : '✓ 지운 거래를 되살렸습니다');
    };
    showTopToast(count > 1 ? `✓ 거래 ${count}건이 삭제되었습니다` : '✓ 거래가 삭제되었습니다', { label: '되돌리기', onClick: undo });
  }, [db, showTopToast]);

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
    hideTopToast(); // '되돌리기'가 다음 계정의 가계부에 남지 않게
    try {
      if (dirty) {
        const ok = await saveNow();
        if (!ok && !window.confirm(`저장되지 않은 변경 ${pendingCount}건이 있습니다.\n로그아웃하면 이 변경은 사라집니다. 그래도 로그아웃할까요?`)) {
          loggingOutRef.current = false;
          return;
        }
      }
      // 이 계정의 다른 가계부(공유받은 가계부·내 가계부, M-2)에 저장하지 못한 변경 — 로그아웃하면 이 기기에서 지운다
      const others = countPendingForAccount(storage?.accountKey, storage?.ledgerKey || storage?.accountKey);
      if (others && !window.confirm(`다른 가계부에 저장하지 못한 변경 ${others}건이 있습니다.\n로그아웃하면 이 변경도 사라집니다(그 가계부를 열면 저장할 수 있어요). 그래도 로그아웃할까요?`)) {
        loggingOutRef.current = false;
        return;
      }
      if (Object.values(getAIConfig().keys).some(k => String(k || '').trim())) {
        // 키를 지울지 묻기 전에 드라이브와 맞춰 본다 — 이 기기에서 바꾼 것이 올라가 있어야 지워도 다른 기기·다시 로그인에 남는다.
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
          ? `다른 사람도 쓰는 기기라면 지우는 것을 권장합니다. ${driveName}에 저장된 키는 그대로라, 다시 로그인하면 자동으로 불러옵니다`
          : `지금 ${driveName}와 맞추지 못했습니다. 지우면 이 기기에만 있던 키나 바꾼 설정은 사라질 수 있습니다. 다시 로그인하면 ${driveName}에 있는 설정을 불러옵니다`;
        if (window.confirm(`이 기기에 저장된 AI API 키도 지울까요?\n(${note})`)) clearAIKeys();
      }
      clearAIDraft(); // AI 입력에 쓰다 남은 글은 이 계정의 것 — 다음에 로그인하는 사람에게 보이지 않게
      // 공유로 받아 두고 아직 꺼내지 않은 사진·글과 이 기기의 가계부 사본도 지운다 (B-004, I-024) — 로그인 화면으로
      // 넘어가며 문서가 내려가면 지우기가 끊길 수 있어 잠깐(최대 3초) 기다린다
      const clearing = Promise.all([clearSharedItems(), resetForLogout()]);
      await Promise.race([clearing, new Promise(r => setTimeout(r, 3000))]);
      if (provider === 'google') {
        // Google은 이 기기의 세션만 지운 뒤 첫 화면으로 — 토큰 폐기는 가족 기기 허락까지 지워 하지 않는다 (M-1)
        await googleLogout();
        window.location.assign('/');
        return;
      }
      await instance.logoutRedirect({ account: accounts[0] });
    } catch (e) {
      loggingOutRef.current = false;
      setError(`로그아웃 실패: ${e.message}`);
    }
  }, [dirty, pendingCount, saveNow, resetForLogout, storage, instance, accounts, setError, showToast, hideTopToast, provider, driveName]);

  const openAdd = (date) => {
    setDefaultFormDate(typeof date === 'string' ? date : null);
    navigate({ showForm: true, editingTx: null, copyFromTx: null });
  };

  const openEdit = (tx) => {
    navigate({ showForm: true, editingTx: tx, copyFromTx: null });
  };

  // 이 거래로 새로 입력 (U-6) — 거래 상세 창에서
  const openCopy = (tx) => {
    setDefaultFormDate(null);
    navigate({ showForm: true, editingTx: null, copyFromTx: tx });
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingTx(null);
    setCopyFromTx(null);
    setDefaultFormDate(null);
    window.history.back();
  };

  // 창 닫기 — 창을 불러오는 동안의 '닫기'(ModalLoading)도 같은 것을 쓴다
  const closeCardCheck = () => { setShowCardCheck(false); window.history.back(); };
  const closeImport = () => { setShowImport(false); window.history.back(); };

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
            <p>{driveName}에서 가계부를 불러오는 중…</p>
          </>
        ) : (
          <>
            {provider === 'google' && !googleTokenValid && (
              <GoogleReconnectBanner email={googleSession?.email} pending={pendingCount} />
            )}
            {error && <p className="error-msg">{error}</p>}
            <button className="btn-primary" onClick={() => loadDb()}>가계부 불러오기</button>
            {currentLedger && (
              <button type="button" className="btn-secondary" onClick={() => switchLedger(OWN_LEDGER)}>내 가계부 열기</button>
            )}
            {/* 설정 › 앱에 갈 수 없는 화면이라 여기서도 문제를 알릴 수 있게 (I-038) */}
            {error && !showLoadReport && (
              <button type="button" className="btn-secondary" onClick={() => setShowLoadReport(true)}>문제 알리기</button>
            )}
          </>
        )}
        {/* 다시 불러오는 동안(스피너)에도 같은 자리에 두어 적던 글이 사라지지 않게 */}
        {showLoadReport && (
          <div className="load-report">
            <Suspense fallback={<p className="load-report-wait">불러오는 중…</p>}>
              <ProblemReport drive={driveName} />
            </Suspense>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* 가계부 바꾸기·참여 링크 (M-2) */}
      {showLedgerSwitcher && (
        <LedgerSwitcher
          current={currentLedgerId}
          shared={sharedLedgers}
          onPick={switchLedger}
          onClose={() => window.history.back()}
        />
      )}
      {joinOffer && <JoinLedgerDialog offer={joinOffer} onAccept={acceptJoin} onClose={dismissJoin} />}
      {/* 가계부를 열 때 가리기 (U-7) — 모든 창 위에 덮는다 */}
      {curtain && <PrivacyCurtain onReveal={() => setCurtain(false)} />}
      <Header
        onRefresh={() => loadDb()}
        onSave={() => saveNow()}
        onLogout={handleLogout}
        onCover={hideOnOpen ? () => setCurtain(true) : null}
        ledgerName={ledgerName}
        onSwitchLedger={sharedLedgers.length ? () => navigate({ showLedgerSwitcher: true }) : null}
        loading={loading}
        saving={saving}
        dirty={dirty}
        offline={offline}
        catchingUp={catchingUp}
        syncing={syncing}
        serviceDown={serviceDown}
        pendingCount={pendingCount}
        onSettings={() => { navigate({ activeTab: 'settings' }); document.querySelector('.app-main')?.scrollTo(0, 0); }}
        settingsActive={activeTab === 'settings'}
        userLabel={provider === 'google' ? (googleSession?.email || '').split('@')[0] : ''}
        {...(provider === 'google' && !googleTokenValid
          ? { offlineLabel: '로그인 필요', offlineTitle: "로그인 시간이 끝났습니다 — 입력한 내용은 이 기기에 보관했다가 '다시 연결'을 누르면 저장합니다" }
          : {})}
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

      {provider === 'google' && !googleTokenValid && (
        <GoogleReconnectBanner email={googleSession?.email} pending={pendingCount} />
      )}

      {error && (
        <div className="error-banner" onClick={() => setError('')}>
          ⚠️ {error} (탭하여 닫기)
        </div>
      )}

<main className="app-main">
        <Suspense fallback={<div className="screen-loading"><div className="spinner" /></div>}>
        {activeTab === 'list' && (
          <TransactionList
            db={db}
            dataVersion={dataVersion}
            goTodayKey={listGoTodayKey}
            onAdd={openAdd}
            onEdit={openEdit}
            onCopy={openCopy}
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
            onOpenReport={(month) => {
              // 지난달 리포트 알림 → 요약 › 리포트의 그 달 (I-028)
              showSummaryReportMonth(month);
              navigate({ activeTab: 'summary', summaryTab: 'report', summaryDrilldown: null });
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
            onChanged={() => saveWithToast()}
            onOpenSettings={(section) => {
              navigate({
                activeTab: 'settings', settingsSection: section,
                settingsDrilldownCategory: null, settingsDrilldownTrip: null, settingsDrilldownPayment: null,
              });
              document.querySelector('.app-main')?.scrollTo(0, 0);
            }}
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
            onDeleteTransaction={handleDelete}
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
            ledgers={ledgersApi}
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
        </Suspense>
      </main>

      {/* AI 버튼 (I-051) — 무엇이든 말하면 알아서: 거래 넣기·고치기·지우기·정기지출·설정·조회 */}
      {db && !showForm && !showAssistant && (
        <button type="button" className="ai-fab" onClick={() => navigate({ showAssistant: true })} aria-label="AI에게 말하기">
          <span aria-hidden="true">✨</span> AI
        </button>
      )}

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
          copyFromTx={editingTx ? null : copyFromTx}
          defaultDate={defaultFormDate}
          aiStart={editingTx || copyFromTx ? null : aiStart}
          onSave={editingTx ? handleUpdate : handleAdd}
          onBulkAdd={handleBulkAdd}
          onQuickAdd={handleQuickAdd}
          onCommand={handleCommand}
          onCancel={closeForm}
        />
      )}

      {/* AI 창 (I-051) — 어느 화면에서나 ✨ AI 버튼으로 */}
      {showAssistant && db && (
        <Suspense fallback={<ModalLoading onClose={() => window.history.back()} />}>
          <AIAssistant
            db={db}
            onApply={applyFromAssistant}
            onBulkAdd={handleBulkAdd}
            onQuickAdd={handleQuickAdd}
            onCommand={handleCommand}
            onClose={() => window.history.back()}
          />
        </Suspense>
      )}

      {/* 카드 내역 대조 */}
      {showCardCheck && (
        <Suspense fallback={<ModalLoading onClose={closeCardCheck} />}>
          <CardStatementModal
            db={db}
            dataVersion={dataVersion}
            onChanged={() => saveNow()}
            onClose={closeCardCheck}
          />
        </Suspense>
      )}

      {/* 첫 실행 안내 — 가계부가 비어 있을 때만 (기본값을 넣으면 바로 닫힌다) */}
      {showOnboarding && blankLedger && (
        <Suspense fallback={<ModalLoading onClose={handleOnboardingClose} />}>
          <Onboarding
            db={db}
            accountLabel={provider === 'google'
              ? (googleSession?.email ? `${googleSession.email}의 Google Drive` : 'Google Drive')
              : (accounts[0]?.username ? `${accounts[0].username}의 OneDrive` : '')}
            onDone={handleOnboardingDone}
            onClose={handleOnboardingClose}
            onLater={handleOnboardingLater}
            onOpenImport={() => navigate({ showOnboarding: false, showImport: true })}
            onOpenReplace={() => {
              // 이 기기에서 저절로 열지 않게 하고 설정 › 데이터의 '가계부 파일로 바꾸기'로 (F-5)
              postponeOnboarding(accountKey);
              navigate({
                showOnboarding: false, activeTab: 'settings', settingsSection: 'data',
                settingsDrilldownCategory: null, settingsDrilldownTrip: null, settingsDrilldownPayment: null,
              });
            }}
          />
        </Suspense>
      )}

      {/* CSV 가져오기 모달 */}
      {showImport && (
        <Suspense fallback={<ModalLoading onClose={closeImport} />}>
          <ImportModal
            db={db}
            dataVersion={dataVersion}
            onImport={handleImport}
            onClose={closeImport}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
