import { useState, useRef, useCallback, useEffect } from 'react';
import {
  initSQL, createDatabase, exportDatabase, runAutoRegister, runAccountAutoRegister,
} from '../services/dbManager';
import {
  readDbFromOneDrive, writeDbToOneDrive, getRemoteETag, ConflictError, ReauthRedirectError,
} from '../services/oneDriveService';
import {
  attachChangeLog, getChangeLog, replayChanges, stampWriteId, readWriteId,
  savePending, loadPending, clearPending,
} from '../services/changeLog';
import { hasHolidayData } from '../data/holidays';

const SAVE_DEBOUNCE_MS = 400;
const OLD_DB_CLOSE_DELAY_MS = 30000;
const MAX_ATTEMPTS = 5;

/**
 * 가계부 DB의 불러오기·자동 저장·충돌 병합을 맡는다.
 *
 * 저장 규칙 (B-001·B-002·B-003·B-005·B-012·B-014)
 *  - DB에 쓰기가 생기면 변경 기록에 남고, 잠시 뒤 OneDrive에 자동 저장한다 (컴포넌트가 따로 저장을 부를 필요 없음).
 *  - 저장은 eTag가 그대로일 때만 성공한다. 그 사이 다른 기기가 저장했으면 최신 파일을 받아
 *    변경 기록을 다시 실행해 합친 뒤 저장한다 — 어느 쪽 입력도 사라지지 않는다.
 *  - 저장에 성공하면 내 DB가 곧 OneDrive 파일이므로 다시 읽지 않는다 (업로드 1번).
 *  - 저장 안 된 변경은 브라우저에도 보관해, 재로그인 리다이렉트·탭 종료 뒤에도 되살린다.
 *  - dataVersion은 쓰기마다 올라간다. 화면은 db를 읽는 memo 의존성에 이 값을 넣는다.
 */
export default function useLedgerSync({ instance, accounts }) {
  const [db, setDb] = useState(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null); // { text, seq } — 토스트로 보여줄 안내

  const accountKey = accounts[0]?.homeAccountId || '';
  const dbRef = useRef(null);
  const eTagRef = useRef(null);
  const accountKeyRef = useRef(accountKey);
  const loadedForRef = useRef('');
  const loopRef = useRef(null);
  const loadingRef = useRef(false);
  const inFlightRef = useRef(null); // 결과를 모르는 업로드 { writeId, n }
  const saveTimerRef = useRef(null);
  const bumpScheduledRef = useRef(false);
  const onWriteRef = useRef(() => {});
  const saveNowRef = useRef(() => Promise.resolve(true));
  accountKeyRef.current = accountKey;

  const notify = useCallback((text) => setNotice({ text, seq: Date.now() }), []);

  const persist = useCallback(() => {
    const log = getChangeLog(dbRef.current);
    savePending(accountKeyRef.current, log
      ? { entries: log.entries, inFlight: inFlightRef.current }
      : null);
  }, []);

  // 쓰기가 기록될 때마다 — 렌더 중 setState를 피하려고 마이크로태스크로 모은다
  onWriteRef.current = () => {
    if (bumpScheduledRef.current) return;
    bumpScheduledRef.current = true;
    queueMicrotask(() => {
      bumpScheduledRef.current = false;
      const log = getChangeLog(dbRef.current);
      setDataVersion(v => v + 1);
      setPendingCount(log ? log.entries.length : 0);
      persist();
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => { saveNowRef.current(); }, SAVE_DEBOUNCE_MS);
    });
  };

  const attach = useCallback((target, initialEntries = []) => {
    attachChangeLog(target, { onWrite: () => onWriteRef.current(), initialEntries });
  }, []);

  /** 새 DB로 교체한다. 옛 DB로 늦게 들어오는 쓰기는 새 DB로 넘기고, 잠시 뒤 메모리를 해제한다 (B-012). */
  const swapDb = useCallback((next, eTag) => {
    const old = dbRef.current;
    dbRef.current = next;
    eTagRef.current = eTag;
    setDb(next);
    setDataVersion(v => v + 1);
    setPendingCount(getChangeLog(next)?.entries.length || 0);
    if (old && old !== next) {
      const oldLog = getChangeLog(old);
      if (oldLog) oldLog.forwardTo = next;
      setTimeout(() => { try { old.close(); } catch (e) { /* 이미 닫힘 */ } }, OLD_DB_CLOSE_DELAY_MS);
    }
  }, []);

  /** 이전 세션에서 저장하지 못한 변경을 꺼낸다. 이미 OneDrive에 반영된 업로드분은 뺀다. */
  const takeRestorable = useCallback((freshDb, pending) => {
    if (!pending) return [];
    let entries = pending.entries;
    const inFlight = pending.inFlight;
    if (inFlight && readWriteId(freshDb) === inFlight.writeId) entries = entries.slice(inFlight.n);
    return entries;
  }, []);

  /** 충돌 시: 최신 파일을 받아 내 변경 기록을 다시 실행해 합친다. */
  const mergeRemote = useCallback(async () => {
    const SQL = await initSQL();
    const { data, eTag } = await readDbFromOneDrive(instance, accounts);
    if (!data) {
      // 파일이 사라졌다면 내 DB 전체를 새로 만든다 (빈 DB에 변경만 다시 넣지 않는다)
      eTagRef.current = null;
      return;
    }
    const { db: fresh, migrationErrors } = createDatabase(SQL, data);
    if (migrationErrors.length) setError(`DB 업데이트 일부 실패: ${migrationErrors.join(' / ')}`);

    // ↓ 여기부터 교체까지는 동기 실행 — 그 사이 새 쓰기가 끼어들 수 없다
    const log = getChangeLog(dbRef.current);
    let entries = log ? log.entries.slice() : [];
    const inFlight = inFlightRef.current;
    if (inFlight && readWriteId(fresh) === inFlight.writeId) entries = entries.slice(inFlight.n);
    inFlightRef.current = null;

    const { entries: rewritten, skipped } = replayChanges(fresh, entries);
    attach(fresh, rewritten);
    swapDb(fresh, eTag);
    persist();
    notify(`다른 기기에서 바뀐 내용을 받아 합쳤습니다${skipped ? ` (이미 있는 ${skipped}건 제외)` : ''}`);
  }, [instance, accounts, attach, swapDb, persist, notify]);

  /** 저장 안 된 변경을 OneDrive에 저장한다. 진행 중이면 그 저장에 합류한다. 성공 여부(boolean)를 돌려준다. */
  const saveNow = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (loopRef.current) return loopRef.current;
    if (!dbRef.current) return Promise.resolve(true);

    const run = async () => {
      setSaving(true);
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          const current = dbRef.current;
          const log = getChangeLog(current);
          if (!log || log.entries.length === 0) {
            setError('');
            return true;
          }
          const n = log.entries.length;
          inFlightRef.current = { writeId: stampWriteId(current), n };
          persist();
          const bytes = exportDatabase(current);
          try {
            const newTag = await writeDbToOneDrive(instance, accounts, bytes, eTagRef.current);
            eTagRef.current = newTag;
            inFlightRef.current = null;
            const liveLog = getChangeLog(dbRef.current);
            if (liveLog) liveLog.entries.splice(0, n); // 올리는 동안 생긴 변경은 남겨 다음 바퀴에 저장
            setPendingCount(liveLog ? liveLog.entries.length : 0);
            persist();
            attempt = -1; // 성공했으면 시도 횟수를 다시 센다
          } catch (e) {
            if (!(e instanceof ConflictError)) throw e; // 결과를 모르는 업로드는 inFlight로 남겨 둔다
            await mergeRemote();
          }
        }
        throw new Error('다른 기기와 저장이 계속 겹칩니다 — 잠시 후 다시 시도하세요');
      } catch (e) {
        if (e instanceof ReauthRedirectError) setError(e.message);
        else setError(`저장 실패: ${e.message} — 변경 내용은 이 기기에 보관되어 있고, 연결되면 다시 저장합니다`);
        return false;
      } finally {
        setSaving(false);
      }
    };

    loopRef.current = run().finally(() => {
      loopRef.current = null;
      // 마지막 확인 직후 들어온 쓰기가 있으면 다시 예약
      const log = getChangeLog(dbRef.current);
      if (log && log.entries.length && !saveTimerRef.current) {
        saveTimerRef.current = setTimeout(() => { saveNowRef.current(); }, SAVE_DEBOUNCE_MS);
      }
    });
    return loopRef.current;
  }, [instance, accounts, mergeRemote, persist]);
  saveNowRef.current = () => { saveTimerRef.current = null; return saveNow(); };

  /**
   * OneDrive에서 불러온다. 처음 열 때와 🔄 새로고침에 쓴다.
   * 저장 안 된 변경이 있으면 버리지 않고 먼저 저장(필요하면 병합)한다 (B-003).
   */
  const loadDb = useCallback(async ({ silent = false } = {}) => {
    if (loadingRef.current) return;
    const hadDb = !!dbRef.current;
    const curLog = getChangeLog(dbRef.current);
    if (curLog && curLog.entries.length) {
      const ok = await saveNow();
      if (!ok) return;
    } else if (loopRef.current) {
      await loopRef.current;
    }

    loadingRef.current = true;
    if (!silent) setLoading(true);
    try {
      const SQL = await initSQL();
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        // 이미 최신이면 다시 받지 않는다
        if (hadDb && eTagRef.current) {
          const remoteTag = await getRemoteETag(instance, accounts);
          if (remoteTag === eTagRef.current) return;
        }

        const { data, eTag } = await readDbFromOneDrive(instance, accounts);
        const { db: fresh, didMigrate, migrationErrors, newerSchema } = createDatabase(SQL, data);

        // 자동등록은 변경 기록을 붙이기 전에 한다 — 병합 때 다시 실행돼 중복되는 일이 없도록
        const auto = runAutoRegister(fresh);
        const accountAutoCount = runAccountAutoRegister(fresh);

        let tag = eTag;
        if (didMigrate || auto.count > 0 || accountAutoCount > 0) {
          try {
            tag = await writeDbToOneDrive(instance, accounts, exportDatabase(fresh), eTag);
          } catch (e) {
            fresh.close();
            if (e instanceof ConflictError) continue; // 그 사이 다른 기기가 저장 — 다시 불러온다
            throw e;
          }
        }

        // ↓ 여기부터 교체까지는 동기 실행 — 그 사이 새 쓰기가 끼어들 수 없다
        let restored = [];
        if (!hadDb) {
          // 이전 세션에서 저장 못 한 변경 되살리기 (재로그인 리다이렉트·탭 종료)
          const pending = loadPending(accountKeyRef.current);
          const entries = takeRestorable(fresh, pending);
          if (entries.length) restored = replayChanges(fresh, entries).entries;
          else if (pending) clearPending(accountKeyRef.current);
        } else {
          // 불러오는 동안 생긴 변경은 새 DB에 다시 실행해 이어 간다
          const liveLog = getChangeLog(dbRef.current);
          if (liveLog && liveLog.entries.length) restored = replayChanges(fresh, liveLog.entries).entries;
        }

        attach(fresh, restored);
        swapDb(fresh, tag);
        loadedForRef.current = accountKeyRef.current;
        persist();

        const errors = [];
        if (migrationErrors.length) errors.push(`DB 업데이트 일부 실패: ${migrationErrors.join(' / ')}`);
        // 자동등록이 쓰는 기간(이번 달~석 달 뒤)의 공휴일 데이터가 없으면 알린다 (B-006)
        const now = new Date();
        const years = [...new Set([0, 3].map(m => new Date(now.getFullYear(), now.getMonth() + m, 1).getFullYear()))];
        const missingYears = years.filter(y => !hasHolidayData(y));
        if (missingYears.length) {
          errors.push(`${missingYears.join(', ')}년 공휴일 데이터가 없어 계좌 자동등록의 휴일 보정이 주말만 반영됩니다 — src/data/holidays.js를 갱신하세요`);
        }
        if (newerSchema) errors.push('이 가계부는 더 새 버전의 앱에서 저장되었습니다 — 페이지를 새로고침해 앱을 업데이트하세요');
        setError(errors.join(' · '));

        if (auto.count > 0) notify(`✓ 정기지출 ${auto.count}건 자동 등록됨 (${auto.months.join(', ')})`);
        if (restored.length) {
          if (!hadDb) notify(`저장되지 않았던 변경 ${restored.length}건을 되살려 저장합니다`);
          saveNow();
        }
        return;
      }
      throw new Error('다른 기기와 저장이 계속 겹칩니다 — 잠시 후 다시 시도하세요');
    } catch (e) {
      if (e instanceof ReauthRedirectError) setError(e.message);
      else setError(`불러오기 실패: ${e.message}`);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [instance, accounts, saveNow, attach, swapDb, persist, takeRestorable, notify]);

  /** 로그아웃 전 — 메모리의 DB와 보관 중인 변경을 모두 지운다 (B-004) */
  const resetForLogout = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    clearPending(accountKeyRef.current);
    const old = dbRef.current;
    dbRef.current = null;
    eTagRef.current = null;
    inFlightRef.current = null;
    loadedForRef.current = '';
    setDb(null);
    setPendingCount(0);
    setError('');
    if (old) { try { old.close(); } catch (e) { /* 이미 닫힘 */ } }
  }, []);

  // 다른 계정으로 바뀌면 이전 계정의 DB를 즉시 버린다 (B-004)
  useEffect(() => {
    if (dbRef.current && loadedForRef.current && loadedForRef.current !== accountKey) {
      const old = dbRef.current;
      dbRef.current = null;
      eTagRef.current = null;
      loadedForRef.current = '';
      setDb(null);
      setPendingCount(0);
      try { old.close(); } catch (e) { /* 이미 닫힘 */ }
    }
  }, [accountKey]);

  // 다시 온라인이 되면 미저장 변경을 저장하고, 앱으로 돌아오면 다른 기기의 변경을 확인한다
  useEffect(() => {
    const onOnline = () => {
      if (getChangeLog(dbRef.current)?.entries.length) saveNowRef.current();
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !dbRef.current || loadingRef.current || loopRef.current) return;
      if (getChangeLog(dbRef.current)?.entries.length) saveNowRef.current();
      else loadDb({ silent: true });
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadDb]);

  // 저장 안 된 변경이 있는데 페이지를 닫으려 하면 경고
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (getChangeLog(dbRef.current)?.entries.length) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return {
    db, dataVersion, loading, saving, error, setError, notice,
    pendingCount, dirty: pendingCount > 0,
    loadDb, saveNow, resetForLogout,
  };
}
