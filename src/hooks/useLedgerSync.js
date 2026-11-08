import { useState, useRef, useCallback, useEffect } from 'react';
import {
  initSQL, createDatabase, exportDatabase, runAutoRegister, runAccountAutoRegister,
  getAutoIncrementSeqs, raiseAutoIncrementSeqs,
} from '../services/dbManager';
import { ConflictError, ReauthRedirectError } from '../services/storage/provider';
import {
  attachChangeLog, getChangeLog, replayChanges, stampWriteId, readWriteId, hasWriteId,
  savePending, loadPending, clearPending,
} from '../services/changeLog';
import {
  listBackups as listBackupFiles, uploadBackup, uploadNewBackup, downloadBackup, pruneBackups, backupName,
} from '../services/backups';
import { hasHolidayData } from '../data/holidays';
import { todayStr } from '../services/dateUtils';

const SAVE_DEBOUNCE_MS = 400;
const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000]; // 저장에 실패한 뒤 다시 시도하기까지 — 실패할수록 길게 (B-089)
const OLD_DB_CLOSE_DELAY_MS = 30000;
const MAX_ATTEMPTS = 5;
// 합칠 때 최신 파일과 맞지 않아 뺀 이 기기 변경이 있을 때 덧붙이는 안내 (B-091)
const DROPPED_NOTE = '먼저 바뀐 내용과 맞지 않는 이 기기 변경 일부는 넣지 않았습니다';

/**
 * 결과를 모르는 업로드 중 실제로 이 파일에 닿은 것 — 그 업로드의 변경(앞에서 n개)은 이미 들어 있다. 없으면 null.
 * 목록의 업로드는 모두 같은 버전 위에서 시도해 많아야 하나만 닿고, 저장할 때 앞선 시도의 표식을 빼므로(stampWriteId의 replaces)
 * 닿은 파일에는 그 업로드의 표식만 있다. 예전 버전 앱이 남긴 파일처럼 여럿이 걸리면 가장 많이 담은 것을 쓴다 —
 * 뒤의 시도일수록 앞의 변경을 모두 담고 있기 때문이다.
 * uploads는 [{ writeId, n }] — 예전 버전이 기기에 남긴 { writeId, n } 하나도 받는다 (B-088)
 */
function landedUpload(db, uploads) {
  const list = Array.isArray(uploads) ? uploads : [uploads];
  return list
    .filter(u => u && hasWriteId(db, u.writeId))
    .reduce((best, u) => (!best || u.n > best.n ? u : best), null);
}

/** 로그인 전·로그아웃 뒤(저장소 없음)에 저장소를 쓰려 하면 분명한 오류로 실패한다 */
function required(storage) {
  if (!storage) throw new Error('로그인 정보가 없습니다 — 다시 로그인하세요');
  return storage;
}

/**
 * 가계부 DB의 불러오기·자동 저장·충돌 병합을 맡는다.
 *
 * storage: 가계부 파일을 둔 저장소(services/storage/provider.js의 계약 — 지금은 OneDrive). 로그인 전에는 null.
 * 이 훅은 어느 저장소인지 모른다 — 버전이 다르면 저장이 거절된다는 계약에만 기댄다 (F-2).
 *
 * 저장 규칙 (B-001·B-002·B-003·B-005·B-012·B-014)
 *  - DB에 쓰기가 생기면 변경 기록에 남고, 잠시 뒤 저장소에 자동 저장한다 (컴포넌트가 따로 저장을 부를 필요 없음).
 *  - 저장은 버전(OneDrive eTag)이 그대로일 때만 성공한다. 그 사이 다른 기기가 저장했으면 최신 파일을 받아
 *    변경 기록을 다시 실행해 합친 뒤 저장한다 — 어느 쪽 입력도 사라지지 않는다.
 *  - 저장에 성공하면 내 DB가 곧 저장소 파일이므로 다시 읽지 않는다 (업로드 1번).
 *  - 저장 안 된 변경은 브라우저에도 보관해, 재로그인 리다이렉트·탭 종료 뒤에도 되살린다.
 *  - 응답을 못 받은 업로드는 모두 기억해 두고(inFlightRef), 나중에 합치거나 다시 열 때 실제로 올라간 것이 있으면
 *    그만큼은 다시 넣지 않는다 (B-088). 저장에 실패하면 점점 길게 기다렸다 다시 시도한다 (B-089).
 *  - dataVersion은 쓰기마다 올라간다. 화면은 db를 읽는 memo 의존성에 이 값을 넣는다.
 *
 * 백업 (I-014)
 *  - 그날 저장소에서 파일을 처음 받을 때 백업 폴더에 그날 백업을 만든다(기기마다 하루 한 번 시도, 실패해도 앱은 계속).
 *  - 되돌리기(restoreBackup)는 restoringRef로 자동 저장·불러오기를 멈춘 채 진행한다. 그 사이 이 기기에서 생긴 변경은
 *    버리지 않고 되돌린 DB에 다시 실행해 이어서 저장한다. 덮어쓰는 저장소 파일은 매번 먼저 백업한다.
 */
export default function useLedgerSync({ storage }) {
  const [db, setDb] = useState(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null); // { text, seq } — 토스트로 보여줄 안내

  const accountKey = storage?.accountKey || '';
  const dbRef = useRef(null);
  const versionRef = useRef(null); // 지금 DB가 바탕으로 한 저장소 파일 버전 (OneDrive eTag)
  const accountKeyRef = useRef(accountKey);
  const loadedForRef = useRef('');
  const loopRef = useRef(null);
  const loadingRef = useRef(false);
  // 결과를 모르는 업로드들 [{ writeId, n }] — 모두 지금 버전(versionRef) 위에서 시도했다. 성공하거나 합치면 비운다 (B-088)
  const inFlightRef = useRef([]);
  const failuresRef = useRef(0); // 잇따라 실패한 저장 횟수 — 다시 시도할 간격을 정한다 (B-089)
  const unmountedRef = useRef(false);
  const saveTimerRef = useRef(null);
  const bumpScheduledRef = useRef(false);
  const onWriteRef = useRef(() => {});
  const saveNowRef = useRef(() => Promise.resolve(true));
  const backupDayRef = useRef(''); // 이 세션에서 매일 백업을 시도한 날
  const restoringRef = useRef(false); // 되돌리는 중 — 자동 저장·불러오기를 멈춘다
  const loadPromiseRef = useRef(null); // 진행 중인 불러오기 (되돌리기 전에 끝나기를 기다린다)
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
      // 되돌리는 중에 생긴 변경은 되돌리기가 끝난 뒤 새 DB에서 저장한다
      if (!restoringRef.current && !unmountedRef.current) {
        saveTimerRef.current = setTimeout(() => { saveNowRef.current(); }, SAVE_DEBOUNCE_MS);
      }
    });
  };

  const attach = useCallback((target, initialEntries = []) => {
    attachChangeLog(target, { onWrite: () => onWriteRef.current(), initialEntries });
  }, []);

  /** 새 DB로 교체한다. 옛 DB로 늦게 들어오는 쓰기는 새 DB로 넘기고, 잠시 뒤 메모리를 해제한다 (B-012). */
  const swapDb = useCallback((next, version) => {
    const old = dbRef.current;
    dbRef.current = next;
    versionRef.current = version;
    setDb(next);
    setDataVersion(v => v + 1);
    setPendingCount(getChangeLog(next)?.entries.length || 0);
    if (old && old !== next) {
      const oldLog = getChangeLog(old);
      if (oldLog) oldLog.forwardTo = next;
      setTimeout(() => { try { old.close(); } catch (e) { /* 이미 닫힘 */ } }, OLD_DB_CLOSE_DELAY_MS);
    }
  }, []);

  /** 이전 세션에서 저장하지 못한 변경을 꺼낸다. 이미 저장소에 반영된 업로드분은 뺀다. */
  const takeRestorable = useCallback((freshDb, pending) => {
    if (!pending) return [];
    const landed = landedUpload(freshDb, pending.inFlight);
    return landed ? pending.entries.slice(landed.n) : pending.entries;
  }, []);

  /** 충돌 시: 최신 파일을 받아 내 변경 기록을 다시 실행해 합친다. */
  const mergeRemote = useCallback(async () => {
    const SQL = await initSQL();
    const { bytes: data, version } = await required(storage).read();
    if (!data) {
      // 파일이 사라졌다면 내 DB 전체를 새로 만든다 (빈 DB에 변경만 다시 넣지 않는다)
      versionRef.current = null;
      return;
    }
    const { db: fresh, migrationErrors } = createDatabase(SQL, data);
    if (migrationErrors.length) setError(`DB 업데이트 일부 실패: ${migrationErrors.join(' / ')}`);

    // ↓ 여기부터 교체까지는 동기 실행 — 그 사이 새 쓰기가 끼어들 수 없다
    const log = getChangeLog(dbRef.current);
    let entries = log ? log.entries.slice() : [];
    const landed = landedUpload(fresh, inFlightRef.current);
    if (landed) entries = entries.slice(landed.n);
    inFlightRef.current = []; // 이 파일이 새 바탕이다

    const { entries: rewritten, skipped, dropped } = replayChanges(fresh, entries);
    attach(fresh, rewritten);
    swapDb(fresh, version);
    persist();
    const notes = [];
    if (skipped) notes.push(`이미 있는 ${skipped}건 제외`);
    // 문장 수라 숫자는 보이지 않는다(예: 다른 기기가 먼저 꾸민 가계부에는 이 기기에서 고른 첫 실행 기본값을 넣지 않음, B-091)
    if (dropped) notes.push(DROPPED_NOTE);
    notify(`다른 기기에서 바뀐 내용을 받아 합쳤습니다${notes.length ? ` (${notes.join(' · ')})` : ''}`);
  }, [storage, attach, swapDb, persist, notify]);

  /** 저장 안 된 변경을 저장소에 저장한다. 진행 중이면 그 저장에 합류한다. 성공 여부(boolean)를 돌려준다. */
  const saveNow = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (restoringRef.current) return Promise.resolve(false); // 되돌리기가 끝나면 이어서 저장한다
    if (loopRef.current) return loopRef.current;
    if (!dbRef.current) return Promise.resolve(true);

    const run = async () => {
      setSaving(true);
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          const current = dbRef.current;
          const log = getChangeLog(current);
          if (!log || log.entries.length === 0) {
            failuresRef.current = 0;
            setError('');
            return true;
          }
          const n = log.entries.length;
          // 앞서 응답을 못 받은 업로드도 지우지 않고 함께 기억한다 — 그중 하나가 실제로 올라갔을 수 있다 (B-088)
          const earlier = inFlightRef.current;
          const writeId = stampWriteId(current, { replaces: earlier.map(u => u.writeId) });
          inFlightRef.current = [...earlier, { writeId, n }];
          persist();
          const bytes = exportDatabase(current);
          try {
            const newVersion = await required(storage).write(bytes, versionRef.current);
            versionRef.current = newVersion;
            // 같은 버전 위에서 이 저장이 받아들여졌으니, 앞서 결과를 몰랐던 업로드는 닿지 않은 것이다
            inFlightRef.current = [];
            failuresRef.current = 0;
            const liveLog = getChangeLog(dbRef.current);
            if (liveLog) liveLog.entries.splice(0, n); // 올리는 동안 생긴 변경은 남겨 다음 바퀴에 저장
            setPendingCount(liveLog ? liveLog.entries.length : 0);
            persist();
            attempt = -1; // 성공했으면 시도 횟수를 다시 센다
          } catch (e) {
            if (!(e instanceof ConflictError)) throw e; // 결과를 모르는 업로드는 inFlightRef에 남겨 둔다
            await mergeRemote();
          }
        }
        throw new Error('다른 기기와 저장이 계속 겹칩니다 — 잠시 후 다시 시도하세요');
      } catch (e) {
        failuresRef.current += 1;
        if (e instanceof ReauthRedirectError) setError(e.message);
        else setError(`저장 실패: ${e.message} — 변경 내용은 이 기기에 보관되어 있고, 연결되면 다시 저장합니다`);
        return false;
      } finally {
        setSaving(false);
      }
    };

    loopRef.current = run().finally(() => {
      loopRef.current = null;
      if (unmountedRef.current) return;
      // 남은 변경이 있으면 다시 예약 — 마지막 확인 직후 들어온 쓰기는 곧바로,
      // 실패했으면 점점 길게 기다린다(연결되거나 앱으로 돌아오면 그때 바로 저장한다) (B-089)
      const log = getChangeLog(dbRef.current);
      if (log && log.entries.length && !saveTimerRef.current) {
        const failures = failuresRef.current;
        const delay = failures ? RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1] : SAVE_DEBOUNCE_MS;
        saveTimerRef.current = setTimeout(() => { saveNowRef.current(); }, delay);
      }
    });
    return loopRef.current;
  }, [storage, mergeRemote, persist]);
  // saveNow가 예약된 다시 시도를 지우고 시작한다 — 온라인·앱 복귀 때 불러도 예약이 겹치지 않는다
  saveNowRef.current = saveNow;

  /**
   * 그날의 매일 백업 (I-014) — 저장소에서 막 받은 파일 그대로를 백업 폴더의 ledger-YYYY-MM-DD.db로 올린다.
   * 같은 날 다른 기기가 이미 만들었으면 덮어쓰지 않는다. 새로 만들었을 때만 오래된 백업을 정리한다.
   * 백업 실패는 가계부 사용을 막지 않는다(다음에 열 때 다시 시도).
   */
  const runDailyBackup = useCallback(async (bytes) => {
    const today = todayStr();
    const doneKey = `ledger_last_backup:${accountKeyRef.current}`;
    let doneDay = '';
    try { doneDay = window.localStorage.getItem(doneKey) || ''; } catch (e) { /* 비공개 모드 */ }
    if (doneDay === today || backupDayRef.current === today) return;
    backupDayRef.current = today;
    try {
      const store = required(storage);
      const created = await uploadBackup(store, backupName(new Date()), bytes);
      try { window.localStorage.setItem(doneKey, today); } catch (e) { /* 다음에 한 번 더 확인할 뿐 */ }
      if (created) await pruneBackups(store);
    } catch (e) {
      backupDayRef.current = '';
      // eslint-disable-next-line no-console
      console.warn('[매일 백업 실패]', e);
    }
  }, [storage]);

  /**
   * 저장소에서 불러온다. 처음 열 때와 🔄 새로고침에 쓴다.
   * 저장 안 된 변경이 있으면 버리지 않고 먼저 저장(필요하면 병합)한다 (B-003).
   */
  const loadDbInner = useCallback(async ({ silent = false } = {}) => {
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
      const store = required(storage);
      const SQL = await initSQL();
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const baseVersion = versionRef.current; // 이 바퀴를 시작할 때 화면 DB의 바탕 — 불러오는 사이 이 기기 저장이 바꿀 수 있다
        // 이미 최신이면 다시 받지 않는다
        if (hadDb && versionRef.current) {
          const remoteVersion = await store.getVersion();
          if (remoteVersion === versionRef.current) return;
        }

        const { bytes: data, version } = await store.read();
        const { db: fresh, didMigrate, migrationErrors, newerSchema } = createDatabase(SQL, data);

        // 자동등록은 변경 기록을 붙이기 전에 한다 — 병합 때 다시 실행돼 중복되는 일이 없도록
        const auto = runAutoRegister(fresh);
        const accountAutoCount = runAccountAutoRegister(fresh);

        let tag = version;
        if (didMigrate || auto.count > 0 || accountAutoCount > 0) {
          try {
            tag = await store.write(exportDatabase(fresh), version);
          } catch (e) {
            fresh.close();
            if (e instanceof ConflictError) continue; // 그 사이 다른 기기가 저장 — 다시 불러온다
            throw e;
          }
        }

        if (hadDb && (loopRef.current || inFlightRef.current.length || versionRef.current !== baseVersion)) {
          // 불러오는 사이 이 기기의 저장이 끼어들었다. 이대로 바꾸면
          //  - 올라갔는지 모르는 저장이 있으면 이미 올라간 변경을 받은 파일에 또 넣거나, 늦게 온 응답이 새 기록을 잘못 지우고 (B-088)
          //  - 저장이 성공해 바탕이 바뀌었으면 그보다 옛 파일로 바꿔 방금 저장한 입력이 화면에서 사라진다 (B-090)
          fresh.close();
          if (loopRef.current) {
            const saved = await loopRef.current;
            if (!saved) return; // 저장이 실패했다 — 그 안내(이 기기에 보관)를 덮지 않고, 다음 저장이 정리하게 둔다
          } else if (inFlightRef.current.length) {
            return; // 바꾸지 않는다 — 다음 저장이 거절되면 합치면서 올라간 것을 가려낸다
          }
          continue; // 처음부터 다시 확인한다 — 그사이 저장한 것이 최신이면 받지 않고 끝난다
        }

        // ↓ 여기부터 교체까지는 동기 실행 — 그 사이 새 쓰기가 끼어들 수 없다
        let restored = [];
        let restoredDropped = 0;
        if (!hadDb) {
          // 이전 세션에서 저장 못 한 변경 되살리기 (재로그인 리다이렉트·탭 종료)
          const pending = loadPending(accountKeyRef.current);
          const entries = takeRestorable(fresh, pending);
          if (entries.length) {
            const replayed = replayChanges(fresh, entries);
            restored = replayed.entries;
            restoredDropped = replayed.dropped;
          }
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

        // 그날 처음 받은 파일이면 그대로 백업 (기다리지 않는다 — 자정을 넘겨 켜 둔 탭도 다음 날 받을 때 만든다)
        if (data) runDailyBackup(data);

        if (auto.count > 0) notify(`✓ 정기지출 ${auto.count}건 자동 등록됨 (${auto.months.join(', ')})`);
        if (restored.length) {
          if (!hadDb) notify(`저장되지 않았던 변경 ${restored.length}건을 되살려 저장합니다${restoredDropped ? ` (${DROPPED_NOTE})` : ''}`);
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
  }, [storage, saveNow, attach, swapDb, persist, takeRestorable, notify, runDailyBackup]);

  const loadDb = useCallback((opts) => {
    if (restoringRef.current) return Promise.resolve();
    // 이미 불러오는 중이면 그 불러오기를 돌려준다 — 되돌리기가 진짜 진행 중인 불러오기를 기다릴 수 있게
    if (loadPromiseRef.current) return loadPromiseRef.current;
    const p = loadDbInner(opts);
    loadPromiseRef.current = p;
    p.finally(() => { if (loadPromiseRef.current === p) loadPromiseRef.current = null; }).catch(() => {});
    return p;
  }, [loadDbInner]);

  // ── 백업 목록·직접 백업·되돌리기 (I-014) — 설정 › 데이터 화면이 쓴다 ─────────

  const listBackups = useCallback(async () => listBackupFiles(required(storage)), [storage]);

  /** 저장 안 된 변경을 먼저 저장한 뒤, 지금 가계부를 시각이 붙은 백업으로 남긴다. 파일 이름을 돌려준다. */
  const createBackup = useCallback(async () => {
    if (!dbRef.current) throw new Error('가계부가 열려 있지 않습니다');
    if (restoringRef.current) throw new Error('되돌리는 중입니다 — 끝난 뒤 다시 시도하세요');
    if (getChangeLog(dbRef.current)?.entries.length) {
      const ok = await saveNow();
      if (!ok) throw new Error('저장 안 된 변경을 먼저 저장하지 못했습니다 — 연결을 확인하세요');
    } else if (loopRef.current) {
      await loopRef.current;
    }
    return uploadNewBackup(required(storage), exportDatabase(dbRef.current));
  }, [storage, saveNow]);

  /**
   * 고른 백업으로 되돌린다.
   *  1) 저장 안 된 변경을 저장하고, 자동 저장·불러오기를 멈춘다(restoringRef)
   *  2) 지금 저장소 파일을 받아 그대로 백업한다 — 다른 기기가 방금 저장한 것까지 남는다
   *  3) 백업 파일을 열어 검사·마이그레이션하고, AUTOINCREMENT 번호를 지금 파일 이상으로 올린다
   *     (그 뒤 생겼다 사라진 행의 id를 새 행이 다시 받으면, 다른 기기의 밀린 수정이 엉뚱한 행에 들어간다)
   *  4) 2)에서 받은 버전으로만 올린다. 그 사이 다른 기기가 저장했으면 2)부터 다시 해 그 저장도 백업한다.
   *     응답을 못 받았으면 저장소 파일의 동기화 표식으로 실제로 올라갔는지 확인한다
   *  5) 화면의 DB를 바꾼다. 그동안 이 기기에서 생긴 변경은 버리지 않고 새 DB에 다시 실행해 이어서 저장한다
   * 2)~4)에서 실패하면 ledger.db와 화면은 그대로다.
   */
  const restoreBackup = useCallback(async (backup) => {
    if (!dbRef.current) throw new Error('가계부가 열려 있지 않습니다');
    if (restoringRef.current) throw new Error('이미 되돌리는 중입니다');
    if (getChangeLog(dbRef.current)?.entries.length) {
      const ok = await saveNow();
      if (!ok) throw new Error('저장 안 된 변경을 먼저 저장하지 못했습니다 — 연결을 확인하세요');
    }

    restoringRef.current = true;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    let fresh = null;
    try {
      const store = required(storage);
      // 이미 시작한 저장·불러오기가 끝나기를 기다린다 (그 결과가 되돌린 DB를 덮지 않게)
      if (loopRef.current) await loopRef.current;
      if (loadPromiseRef.current) await loadPromiseRef.current.catch(() => {});

      const SQL = await initSQL();
      const backupBytes = await downloadBackup(store, backup.id);
      let tag = null;
      for (let attempt = 0; ; attempt += 1) {
        const current = await store.read(); // 2)
        if (current.bytes) await uploadNewBackup(store, current.bytes);

        if (fresh) { fresh.close(); fresh = null; } // 3)
        const opened = createDatabase(SQL, backupBytes);
        fresh = opened.db;
        if (opened.newerSchema) throw new Error('더 새 버전의 앱에서 만든 백업입니다 — 페이지를 새로고침해 앱을 업데이트하세요');
        if (opened.migrationErrors.length) throw new Error(`백업 파일을 여는 중 오류: ${opened.migrationErrors.join(' / ')}`);
        const seqs = getAutoIncrementSeqs(dbRef.current);
        if (current.bytes) {
          const cur = new SQL.Database(current.bytes);
          try {
            Object.entries(getAutoIncrementSeqs(cur)).forEach(([name, seq]) => { seqs[name] = Math.max(seqs[name] || 0, seq); });
          } finally { cur.close(); }
        }
        raiseAutoIncrementSeqs(fresh, seqs);
        runAutoRegister(fresh);
        runAccountAutoRegister(fresh);
        const writeId = stampWriteId(fresh);

        try { // 4)
          tag = await store.write(exportDatabase(fresh), current.version);
          break;
        } catch (e) {
          if (e instanceof ConflictError) {
            if (attempt >= 2) throw new Error('다른 기기와 저장이 계속 겹칩니다 — 잠시 후 다시 시도하세요');
            continue;
          }
          const check = await store.read().catch(() => null);
          let landed = false;
          if (check?.bytes) {
            const remote = new SQL.Database(check.bytes);
            try { landed = readWriteId(remote) === writeId; } finally { remote.close(); }
          }
          if (!landed) {
            // 올라갔는지 확인하지 못했다(그 사이 다른 기기가 저장했거나 연결이 끊김) — 결과를 단정하지 않는다
            throw new Error(`되돌리기 결과를 확인하지 못했습니다 (${e.message}). 🔄 새로고침으로 지금 상태를 확인하세요 — 되돌리기 전 상태는 백업 목록에 있습니다`);
          }
          tag = check.version;
          break;
        }
      }

      // 5) ↓ 교체는 동기 실행 — 되돌리는 동안 생긴 변경은 새 DB에 다시 실행해 이어서 저장한다
      const leftover = getChangeLog(dbRef.current)?.entries || [];
      const carried = leftover.length ? replayChanges(fresh, leftover).entries : [];
      inFlightRef.current = [];
      attach(fresh, carried);
      swapDb(fresh, tag);
      if (!carried.length) clearPending(accountKeyRef.current);
      persist();
      fresh = null;
      setError('');
      notify(`✓ ${backup.date} 백업으로 되돌렸습니다`);
    } finally {
      if (fresh) { try { fresh.close(); } catch (e) { /* 이미 닫힘 */ } }
      restoringRef.current = false;
      if (!unmountedRef.current && getChangeLog(dbRef.current)?.entries.length && !saveTimerRef.current) {
        saveTimerRef.current = setTimeout(() => { saveNowRef.current(); }, SAVE_DEBOUNCE_MS);
      }
    }
  }, [storage, saveNow, attach, swapDb, persist, notify]);

  /** 로그아웃 전 — 메모리의 DB와 보관 중인 변경을 모두 지운다 (B-004) */
  const resetForLogout = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    clearPending(accountKeyRef.current);
    const old = dbRef.current;
    dbRef.current = null;
    versionRef.current = null;
    inFlightRef.current = [];
    failuresRef.current = 0;
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
      versionRef.current = null;
      inFlightRef.current = [];
      failuresRef.current = 0;
      loadedForRef.current = '';
      setDb(null);
      setPendingCount(0);
      try { old.close(); } catch (e) { /* 이미 닫힘 */ }
    }
  }, [accountKey]);

  // 화면이 사라지면 예약해 둔 저장·다시 시도를 지운다 (B-089). StrictMode는 한 번 지웠다 다시 붙이므로 붙일 때 되돌린다
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    };
  }, []);

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
    listBackups, createBackup, restoreBackup,
  };
}
