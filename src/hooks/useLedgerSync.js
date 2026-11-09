import { useState, useRef, useCallback, useEffect } from 'react';
import {
  initSQL, createDatabase, exportDatabase, runAutoRegister, runAccountAutoRegister,
  getAutoIncrementSeqs, raiseAutoIncrementSeqs,
} from '../services/dbManager';
import { ConflictError, OfflineError, ReauthRedirectError, ReconnectRequiredError } from '../services/storage/provider';
import { defaultOfflineCache } from '../services/offlineCache';
import {
  attachChangeLog, getChangeLog, replayChanges, stampWriteId, readWriteId, hasWriteId,
  savePending, loadPending, clearPending, stampGeneration, generationOfBytes,
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
// 가계부가 통째로 바뀌어(다른 기기가 파일로 바꾸기, 바꾸기 전 백업으로 되돌리기) 옛 가계부에 하던 이 기기의 저장 안 된
// 변경을 넣지 않았을 때 (I-035) — 그 변경이 담긴 이 기기의 가계부는 백업 목록에 남긴다(keepDropped)
const replacedNote = n => `가계부가 다른 기기에서 통째로 바뀌어, 이 기기에서 저장하지 못한 변경 ${n}건은 넣지 않았습니다 — 그 변경이 담긴 이 기기의 가계부를 백업 목록에 남기는 중입니다`;

/** 사본을 남긴 때 — "11/8 14:05" */
function shortTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 보관한 결과 모르는 업로드 — 예전 버전은 { writeId, n } 하나를 남겼다 */
const inFlightList = (v) => (Array.isArray(v) ? v : (v ? [v] : []));

// 처음 열 때 저장소가 이보다 오래 답하지 않으면(약한 로밍 신호·호텔 와이파이 로그인 페이지), 열 수 있는 사본이 있으면 그것으로 연다.
// 사본이 없으면 그대로 기다린다 — 느려도 연결은 돼 있을 수 있다(로그아웃 뒤 다시 로그인·새 기기는 사본이 없다)
const FIRST_LOAD_TIMEOUT_MS = 15000;
// 연결이 없는 동안 이 간격으로 다시 확인한다 — 'online' 이벤트가 오지 않는 경우(onLine이 내내 true)도 있다
const OFFLINE_RETRY_MS = 30000;
// 처음 받기가 느려 사본으로 열었다 — 그 불러오기는 여기서 끝난다
const OPENED_FROM_COPY = Symbol('opened-from-copy');

// 앱이 일부러 다른 페이지로 떠날 때(Google '다시 연결', M-1) 잠깐 동안 '저장되지 않았을 수 있음' 경고를 띄우지 않는다.
// 미저장 변경은 이미 이 기기(localStorage)에 보관돼 있어 돌아온 뒤 저장된다. 이동이 취소되면 몇 초 뒤 다시 경고한다
let unloadAllowedUntil = 0;
export function allowNextUnload(ms = 5000) {
  unloadAllowedUntil = Date.now() + ms;
}

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
 *  - 파일로 바꾸기(replaceWithFile, I-035)도 같은 절차인데, 다른 가계부라 새 세대 표시를 남긴다. 저장 안 된 변경은
 *    바탕 가계부와 세대가 같을 때만 다시 실행한다(합치기·다시 열기·바꾸는 동안 입력) — 아니면 넣지 않고 알린다.
 *
 * 연결 없이 쓰기 (I-024, ROADMAP C-4)
 *  - 저장소와 맞춘 순간(불러오기·저장 성공·병합·되돌리기)의 파일과 버전을 이 기기에 사본으로 둔다(offlineCache).
 *  - 처음 열 때 연결이 없으면(OfflineError) 그 사본으로 열고 보관한 미저장 변경을 다시 실행한다. 자동등록은 하지 않는다
 *    (그 행을 고친 변경이 나중에 합칠 때 엉뚱한 행을 가리킬 수 있다). 결과를 모르는 업로드가 있는데 사본이 그 바탕이
 *    아니면 가려낼 수 없어 열지 않는다.
 *  - 연결되면(online·앱 복귀) 사본의 버전으로 저장을 시도한다 — 그 사이 다른 기기가 저장했으면 거절되어 기존 병합 경로로 합친다.
 *    이어서 저장소에서 한 번 새로 받아 자동등록·매일 백업을 한다.
 *  - 연결이 없어 저장하지 못하는 동안은 오류 대신 offline으로 알린다(헤더). 로그아웃하면 사본을 지운다 (B-004).
 */
export default function useLedgerSync({
  storage, offlineCache = defaultOfflineCache(),
  firstLoadTimeoutMs = FIRST_LOAD_TIMEOUT_MS, offlineRetryMs = OFFLINE_RETRY_MS,
}) {
  const [db, setDb] = useState(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null); // { text, seq } — 토스트로 보여줄 안내
  const [offline, setOfflineState] = useState(false); // 연결이 없어 저장소에 닿지 못하는 중 (I-024)

  const accountKey = storage?.accountKey || '';
  const dbRef = useRef(null);
  const versionRef = useRef(null); // 지금 DB가 바탕으로 한 저장소 파일 버전 (OneDrive eTag)
  // 지금 DB가 바탕으로 한 가계부의 세대 (I-035) — 화면 DB를 바꿀 때 그 파일 바이트에서 읽어 둔다(쓸 때마다 질의하지 않게)
  const generationRef = useRef(0);
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
  const offlineRef = useRef(false);
  const offlineStartRef = useRef(false); // 이 세션을 사본으로 열었다 — 연결되면 한 번은 저장소에서 새로 받는다
  const offlineCacheRef = useRef(offlineCache);
  offlineCacheRef.current = offlineCache;
  const copyQueueRef = useRef(Promise.resolve()); // 사본 쓰기를 순서대로 (늦게 끝난 옛 사본이 새 사본을 덮지 않게)
  // 로그아웃·계정 전환마다 올린다. 비동기 작업은 시작할 때의 번호를 잡아 두고, 끝났을 때 번호가 바뀌었으면
  // 결과를 버린다 — 로그아웃 뒤 늦게 끝난 불러오기가 가계부를 되살리거나 지운 사본을 다시 쓰지 않게 (B-004, I-024)
  const sessionRef = useRef(0);
  // 처음 열 때 진행 중인 받기 — 느려서 사본으로 열었거나 다시 시도할 때 새 받기를 겹쳐 시작하지 않는다(대역폭을 나눠 더 느려진다)
  const firstReadRef = useRef(null);
  accountKeyRef.current = accountKey;

  const notify = useCallback((text) => setNotice({ text, seq: Date.now() }), []);
  const setOffline = useCallback((v) => { offlineRef.current = v; setOfflineState(v); }, []);

  /**
   * 세대가 달라 넣지 못한 이 기기의 변경을 잃지 않게 — 그 변경이 담긴 이 기기의 가계부(bytes)를 백업으로 올린다 (I-035).
   * 기다리지 않는다. 그 백업으로 되돌리면 바뀌기 전 가계부와 이 기기의 입력을 함께 볼 수 있다
   */
  const keepDropped = useCallback((bytes, count) => {
    notify(replacedNote(count));
    if (!bytes || !storage) return;
    uploadNewBackup(storage, bytes)
      .then(name => notify(`넣지 못한 변경 ${count}건이 담긴 이 기기의 가계부를 백업(${name})으로 남겼습니다 — 필요한 거래는 다시 입력해 주세요(그 백업으로 되돌리면 가족 모두의 가계부가 그때로 바뀝니다)`))
      .catch(() => notify(`넣지 못한 변경 ${count}건이 담긴 이 기기의 가계부를 백업으로 남기지 못했습니다 — 연결을 확인하세요`));
  }, [storage, notify]);

  /**
   * 저장소와 맞춘 파일(bytes가 곧 version)을 이 기기 사본으로 남긴다. 실패해도 앱은 계속 (I-024).
   * session: 그 작업을 시작할 때의 세션 — 그 사이 로그아웃·계정 전환이 있었으면 남기지 않는다
   */
  const keepCopy = useCallback((bytes, version, session) => {
    const key = accountKeyRef.current;
    if (session !== sessionRef.current) return;
    // 열린 가계부가 없으면 남기지 않는다 — 지운 사본을 되살리지 않게
    if (!key || !bytes || !dbRef.current) return;
    copyQueueRef.current = copyQueueRef.current
      .then(() => offlineCacheRef.current.save(key, bytes, version))
      .catch(() => { /* 비공개 모드 등 — 연결 없이 열기만 못 할 뿐 */ });
  }, []);

  // 보관하는 미저장 변경 — base: 이 변경이 바탕으로 한 저장소 버전(사본으로 열 때 맞는지 본다)
  const persist = useCallback(() => {
    const log = getChangeLog(dbRef.current);
    savePending(accountKeyRef.current, log
      ? { entries: log.entries, inFlight: inFlightRef.current, base: versionRef.current, generation: generationRef.current }
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

  /**
   * 새 DB로 교체한다. 옛 DB로 늦게 들어오는 쓰기는 새 DB로 넘기고, 잠시 뒤 메모리를 해제한다 (B-012).
   * baseBytes: 새 DB가 바탕으로 한 파일(저장소에서 받은 것·올린 것) — 그 세대를 기억한다 (I-035)
   */
  const swapDb = useCallback((next, version, baseBytes) => {
    const old = dbRef.current;
    dbRef.current = next;
    versionRef.current = version;
    generationRef.current = generationOfBytes(baseBytes);
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
    const session = sessionRef.current;
    const SQL = await initSQL();
    const { bytes: data, version } = await required(storage).read();
    if (session !== sessionRef.current) return; // 그 사이 로그아웃·계정 전환 — 받은 것을 버린다
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

    // 다른 기기가 가계부를 파일로 통째로 바꿨으면(세대가 다름) 내 변경은 옛 가계부의 것 — 다시 실행하지 않는다 (I-035)
    if (entries.length && generationRef.current !== generationOfBytes(data)) {
      const lost = entries.length;
      const mine = exportDatabase(dbRef.current); // 이 기기의 변경이 담긴 옛 가계부 — 백업으로 남긴다
      attach(fresh, []);
      swapDb(fresh, version, data);
      persist();
      keepCopy(data, version, session);
      setOffline(false);
      keepDropped(mine, lost);
      return;
    }

    const { entries: rewritten, skipped, dropped } = replayChanges(fresh, entries);
    attach(fresh, rewritten);
    swapDb(fresh, version, data);
    persist();
    keepCopy(data, version, session);
    setOffline(false);
    const notes = [];
    if (skipped) notes.push(`이미 있는 ${skipped}건 제외`);
    // 문장 수라 숫자는 보이지 않는다(예: 다른 기기가 먼저 꾸민 가계부에는 이 기기에서 고른 첫 실행 기본값을 넣지 않음, B-091)
    if (dropped) notes.push(DROPPED_NOTE);
    notify(`다른 기기에서 바뀐 내용을 받아 합쳤습니다${notes.length ? ` (${notes.join(' · ')})` : ''}`);
  }, [storage, attach, swapDb, persist, notify, keepCopy, setOffline, keepDropped]);

  /** 저장 안 된 변경을 저장소에 저장한다. 진행 중이면 그 저장에 합류한다. 성공 여부(boolean)를 돌려준다. */
  const saveNow = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (restoringRef.current) return Promise.resolve(false); // 되돌리기가 끝나면 이어서 저장한다
    if (loopRef.current) return loopRef.current;
    if (!dbRef.current) return Promise.resolve(true);

    const run = async () => {
      const session = sessionRef.current;
      setSaving(true);
      try {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
          if (session !== sessionRef.current) return false; // 그 사이 로그아웃·계정 전환
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
            if (session !== sessionRef.current) return false; // 로그아웃한 뒤에 끝난 저장 — 이 기기 상태를 되살리지 않는다
            versionRef.current = newVersion;
            keepCopy(bytes, newVersion, session);
            setOffline(false);
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
        if (session !== sessionRef.current) return false; // 로그아웃한 뒤의 실패는 알리지 않는다
        failuresRef.current += 1;
        if (e instanceof ReauthRedirectError) setError(e.message);
        else if (e instanceof OfflineError) {
          // 연결이 없을 뿐 — 오류 대신 헤더에 '오프라인'으로 알리고, 연결되면 저장한다 (I-024)
          setOffline(true);
          setError('');
        } else setError(`저장 실패: ${e.message} — 변경 내용은 이 기기에 보관되어 있고, 연결되면 다시 저장합니다`);
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
  }, [storage, mergeRemote, persist, keepCopy, setOffline]);
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
   * 연결이 없어 처음 열지 못할 때 — 이 기기에 둔 사본으로 열고 보관한 미저장 변경을 다시 실행한다 (I-024).
   * 열 수 없으면 이유를 담아 던진다(부르는 쪽이 화면에 보인다).
   */
  const openOfflineCopy = useCallback(async (session, { slow = false, reason = null } = {}) => {
    const key = accountKeyRef.current;
    const copy = await offlineCacheRef.current.load(key).catch(() => null);
    if (session !== sessionRef.current) return;
    if (!copy || !copy.bytes) {
      // 로그인 시간이 끝난 경우(Google, M-1)는 연결 문제가 아니라 '다시 연결'로 풀린다
      if (reason instanceof ReconnectRequiredError) {
        throw new Error("로그인 시간이 끝나 가계부를 받지 못했습니다 — 화면 위 '다시 연결'을 눌러 주세요");
      }
      throw new Error('연결이 없어 가계부를 열 수 없습니다 — 이 기기에서 연결된 상태로 한 번 열고 나면, 그다음부터는 연결이 없어도 열 수 있습니다');
    }
    const SQL = await initSQL();
    if (session !== sessionRef.current) return;
    const { db: cached, migrationErrors, newerSchema } = createDatabase(SQL, copy.bytes);
    if (newerSchema) {
      cached.close();
      throw new Error('이 기기의 사본이 더 새 버전의 앱에서 저장되었습니다 — 연결된 뒤 페이지를 새로고침하세요');
    }

    // ↓ 여기부터 교체까지는 동기 실행 — 그 사이 새 쓰기가 끼어들 수 없다
    const pending = loadPending(key);
    const inFlight = inFlightList(pending?.inFlight);
    let restored = [];
    let dropped = 0;
    if (pending) {
      // 보관한 변경은 그 바탕(base) 버전 위에서만 그대로 다시 실행할 수 있다. 사본이 그보다 오래됐으면(사본 쓰기 실패·
      // 쓰기 전에 앱이 닫힘) 새 행이 이미 있는 행의 번호를 받아, 그 번호를 고친 변경이 엉뚱한 행에 들어간다 — 열지 않는다
      if (pending.base !== copy.version) {
        cached.close();
        throw new Error('이 기기의 사본이 저장하지 못한 변경보다 오래되어 연결 없이는 열 수 없습니다 — 연결되면 다시 열어 주세요(변경은 그대로 보관되어 있습니다)');
      }
      const replayed = replayChanges(cached, pending.entries);
      const exact = !replayed.skipped && !replayed.dropped && replayed.entries.length === pending.entries.length;
      // 결과를 모르는 업로드는 '앞에서 n개'로 가려내므로, 그대로 다시 실행돼야 한다 (B-088)
      if (inFlight.length && !exact) {
        cached.close();
        throw new Error('마지막 저장이 올라갔는지 확인하지 못해 연결 없이는 열 수 없습니다 — 연결되면 다시 열어 주세요');
      }
      restored = replayed.entries;
      dropped = replayed.dropped;
    }
    attach(cached, restored);
    swapDb(cached, copy.version, copy.bytes);
    inFlightRef.current = inFlight;
    loadedForRef.current = key;
    offlineStartRef.current = true;
    persist();
    setOffline(true);
    setError(migrationErrors.length ? `DB 업데이트 일부 실패: ${migrationErrors.join(' / ')}` : '');
    const when = shortTime(copy.savedAt);
    notify(`연결이 ${slow ? '너무 느려' : '없어'} 이 기기에 둔 가계부${when ? `(${when} 기준)` : ''}로 열었습니다 — 입력한 내용은 연결되면 저장합니다${dropped ? ` (${DROPPED_NOTE})` : ''}`);
    // 보관한 변경이 있으면 저장을 시도해 둔다 — 실패하면 점점 길게 다시 시도하고, 연결되면 바로 저장한다
    if (restored.length) saveNowRef.current();
  }, [attach, swapDb, persist, notify, setOffline]);

  /**
   * 저장소에서 불러온다. 처음 열 때와 🔄 새로고침에 쓴다.
   * 저장 안 된 변경이 있으면 버리지 않고 먼저 저장(필요하면 병합)한다 (B-003).
   * 연결이 없으면 처음 열 때는 이 기기의 사본으로 연다 (I-024).
   */
  const loadDbInner = useCallback(async ({ silent = false } = {}) => {
    if (loadingRef.current) return;
    const session = sessionRef.current;
    const hadDb = !!dbRef.current;

    /**
     * 처음 받기 (I-024) — 진행 중인 받기가 있으면 그것을 이어 기다린다(겹쳐 받지 않게).
     * firstLoadTimeoutMs가 지나도 답이 없으면 열 수 있는 사본이 있을 때만 그것으로 열고(OPENED_FROM_COPY),
     * 없으면 그대로 기다린다 — 느려도 연결돼 있으면 결국 열린다
     */
    const readFirst = async (store) => {
      let p = firstReadRef.current;
      if (!p) {
        p = store.read();
        firstReadRef.current = p;
        const done = () => { if (firstReadRef.current === p) firstReadRef.current = null; };
        p.then(done, done);
      }
      const TIMED_OUT = {};
      let timer;
      const first = await Promise.race([
        p,
        new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), firstLoadTimeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      if (first !== TIMED_OUT) return first;
      try {
        await openOfflineCopy(session, { slow: true });
        if (dbRef.current) return OPENED_FROM_COPY;
      } catch (e) {
        // 열 수 있는 사본이 없다 — 받기를 계속 기다린다
      }
      return p;
    };

    const curLog = getChangeLog(dbRef.current);
    if (curLog && curLog.entries.length) {
      const ok = await saveNow();
      if (!ok) return;
    } else if (loopRef.current) {
      await loopRef.current;
    }

    // 지난 세션에 보관한 변경이 있으면, 그 바탕일 수 있는 이 기기의 사본을 미리 읽어 둔다 — 가계부가 통째로 바뀌어
    // 그 변경을 넣지 못하면 사본에 다시 실행해 백업으로 남긴다(사본은 곧 새 파일로 바뀐다) (I-035)
    const oldCopyP = !hadDb && loadPending(accountKeyRef.current)
      ? offlineCacheRef.current.load(accountKeyRef.current).catch(() => null)
      : null;

    loadingRef.current = true;
    if (!silent) setLoading(true);
    try {
      const store = required(storage);
      const SQL = await initSQL();
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const baseVersion = versionRef.current; // 이 바퀴를 시작할 때 화면 DB의 바탕 — 불러오는 사이 이 기기 저장이 바꿀 수 있다
        // 이미 최신이면 다시 받지 않는다 — 사본으로 연 세션은 한 번 새로 받아 자동등록·매일 백업을 한다
        if (hadDb && versionRef.current && !offlineStartRef.current) {
          const remoteVersion = await store.getVersion();
          setOffline(false);
          if (remoteVersion === versionRef.current) return;
        }

        let got;
        if (hadDb) {
          // 처음 받기가 아직 끝나지 않았으면(느려서 사본으로 열었다) 끝나기를 기다린 뒤 새로 받는다 — 겹쳐 받지 않게.
          // 그 결과를 쓰지는 않는다: 그 뒤 이 기기에서 저장했으면 그보다 옛 파일이라 방금 저장한 입력이 사라진다(B-090)
          if (firstReadRef.current) await firstReadRef.current.catch(() => {});
          got = await store.read();
        } else {
          got = await readFirst(store);
          if (got === OPENED_FROM_COPY) return;
        }
        if (session !== sessionRef.current) return; // 그 사이 로그아웃·계정 전환 — 받은 것을 버린다
        const { bytes: data, version } = got;
        setOffline(false);
        const { db: fresh, didMigrate, migrationErrors, newerSchema } = createDatabase(SQL, data);

        // 자동등록은 변경 기록을 붙이기 전에 한다 — 병합 때 다시 실행돼 중복되는 일이 없도록
        const auto = runAutoRegister(fresh);
        const accountAutoCount = runAccountAutoRegister(fresh);

        let tag = version;
        let written = null; // 바꿔 올린 파일 — 그러면 이것이 tag 버전의 내용이다
        if (didMigrate || auto.count > 0 || accountAutoCount > 0) {
          try {
            written = exportDatabase(fresh);
            tag = await store.write(written, version);
          } catch (e) {
            fresh.close();
            if (e instanceof ConflictError) continue; // 그 사이 다른 기기가 저장 — 다시 불러온다
            throw e;
          }
        }
        const baseBytes = written || data; // 아래에서 미저장 변경을 다시 실행하기 전의, 저장소 그대로의 내용
        if (session !== sessionRef.current) { fresh.close(); return; }

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
        let lostToReplace = 0; // 가계부가 통째로 바뀌어 다시 실행하지 않은 변경 수 (I-035)
        let droppedBytes = null;    // 그 변경이 담긴 이 기기의 가계부(불러오는 동안 입력)
        let droppedPending = null;  // 지난 세션의 보관분 — 사본에 다시 실행해 백업으로
        if (!hadDb) {
          // 이전 세션에서 저장 못 한 변경 되살리기 (재로그인 리다이렉트·탭 종료)
          const pending = loadPending(accountKeyRef.current);
          const entries = takeRestorable(fresh, pending);
          if (entries.length && (Number(pending.generation) || 0) !== generationOfBytes(baseBytes)) {
            lostToReplace = entries.length;
            droppedPending = { entries, base: pending.base };
            clearPending(accountKeyRef.current);
          } else if (entries.length) {
            const replayed = replayChanges(fresh, entries);
            restored = replayed.entries;
            restoredDropped = replayed.dropped;
          }
          else if (pending) clearPending(accountKeyRef.current);
        } else {
          // 불러오는 동안 생긴 변경은 새 DB에 다시 실행해 이어 간다 — 가계부가 파일로 바뀌었으면 하지 않는다
          const liveLog = getChangeLog(dbRef.current);
          if (liveLog && liveLog.entries.length) {
            if (generationRef.current === generationOfBytes(baseBytes)) restored = replayChanges(fresh, liveLog.entries).entries;
            else {
              lostToReplace = liveLog.entries.length;
              droppedBytes = exportDatabase(dbRef.current);
            }
          }
        }

        attach(fresh, restored);
        swapDb(fresh, tag, baseBytes);
        loadedForRef.current = accountKeyRef.current;
        persist();
        keepCopy(baseBytes, tag, session);
        offlineStartRef.current = false;
        setOffline(false);

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
        if (droppedBytes) keepDropped(droppedBytes, lostToReplace);
        if (droppedPending) {
          const lost = lostToReplace;
          (async () => {
            const copy = oldCopyP ? await oldCopyP : null;
            if (session !== sessionRef.current) return;
            if (!copy?.bytes || copy.version !== droppedPending.base) {
              notify(`가계부가 다른 기기에서 통째로 바뀌어, 이 기기에서 저장하지 못한 변경 ${lost}건은 넣지 않았습니다 — 이 기기에 그 바탕 가계부가 없어 백업으로 남기지 못했습니다`);
              return;
            }
            const old = createDatabase(SQL, copy.bytes).db;
            try {
              replayChanges(old, droppedPending.entries);
              keepDropped(exportDatabase(old), lost);
            } finally { old.close(); }
          })().catch(() => {});
        }
        if (restored.length) {
          if (!hadDb) notify(`저장되지 않았던 변경 ${restored.length}건을 되살려 저장합니다${restoredDropped ? ` (${DROPPED_NOTE})` : ''}`);
          saveNow();
        }
        return;
      }
      throw new Error('다른 기기와 저장이 계속 겹칩니다 — 잠시 후 다시 시도하세요');
    } catch (e) {
      if (session !== sessionRef.current) return; // 로그아웃한 뒤의 실패는 알리지 않는다
      if (e instanceof OfflineError) {
        setOffline(true);
        if (!hadDb && !dbRef.current) {
          try { await openOfflineCopy(session, { reason: e }); } catch (e2) { if (session === sessionRef.current) setError(e2.message); }
        } else if (!silent) {
          setError(e instanceof ReconnectRequiredError
            ? "로그인 시간이 끝나 새로 받지 못했습니다 — 이 기기의 가계부로 계속 쓸 수 있고, '다시 연결'을 누르면 저장합니다"
            : '연결이 없어 새로 받지 못했습니다 — 이 기기의 가계부로 계속 쓸 수 있고, 연결되면 저장합니다');
        }
      } else if (e instanceof ReauthRedirectError) setError(e.message);
      else setError(`불러오기 실패: ${e.message}`);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [storage, saveNow, attach, swapDb, persist, takeRestorable, notify, runDailyBackup, keepCopy, setOffline, openOfflineCopy, firstLoadTimeoutMs, keepDropped]);

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
    if (restoringRef.current) throw new Error('가계부를 되돌리거나 바꾸는 중입니다 — 끝난 뒤 다시 시도하세요');
    if (getChangeLog(dbRef.current)?.entries.length) {
      const ok = await saveNow();
      if (!ok) throw new Error('저장 안 된 변경을 먼저 저장하지 못했습니다 — 연결을 확인하세요');
    } else if (loopRef.current) {
      await loopRef.current;
    }
    return uploadNewBackup(required(storage), exportDatabase(dbRef.current));
  }, [storage, saveNow]);

  /**
   * 가계부를 다른 내용(백업·올린 파일)으로 바꾼다 — 되돌리기(I-014)와 파일로 바꾸기(I-035)가 함께 쓴다.
   *  1) 저장 안 된 변경을 저장하고, 자동 저장·불러오기를 멈춘다(restoringRef)
   *  2) 지금 저장소 파일을 받아 그대로 백업한다 — 다른 기기가 방금 저장한 것까지 남는다
   *  3) 새 내용을 열어 검사·마이그레이션하고, AUTOINCREMENT 번호를 지금 파일 이상으로 올린다
   *     (그 뒤 생겼다 사라진 행의 id를 새 행이 다시 받으면, 다른 기기의 밀린 수정이 엉뚱한 행에 들어간다).
   *     파일로 바꾸면(newGeneration) 새 세대 표시를 남긴다 — 다른 기기의 밀린 변경은 다시 실행하지 않게(changeLog 세대)
   *  4) 2)에서 받은 버전으로만 올린다. 그 사이 다른 기기가 저장했으면 2)부터 다시 해 그 저장도 백업한다.
   *     응답을 못 받았으면 저장소 파일의 동기화 표식으로 실제로 올라갔는지 확인한다
   *  5) 화면의 DB를 바꾼다. 그동안 이 기기에서 생긴 변경은 세대가 같을 때만(되돌리기) 새 DB에 다시 실행해 이어서 저장한다
   * 2)~4)에서 실패하면 ledger.db와 화면은 그대로다.
   */
  const replaceContents = useCallback(async (getBytes, { newGeneration = false, doneText, kindText, subject }) => {
    if (!dbRef.current) throw new Error('가계부가 열려 있지 않습니다');
    if (restoringRef.current) throw new Error('이미 가계부를 되돌리거나 바꾸는 중입니다');
    if (getChangeLog(dbRef.current)?.entries.length) {
      const ok = await saveNow();
      if (!ok) throw new Error('저장 안 된 변경을 먼저 저장하지 못했습니다 — 연결을 확인하세요');
    }

    const session = sessionRef.current;
    restoringRef.current = true;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    let fresh = null;
    try {
      const store = required(storage);
      // 이미 시작한 저장·불러오기가 끝나기를 기다린다 (그 결과가 바꾼 DB를 덮지 않게)
      if (loopRef.current) await loopRef.current;
      if (loadPromiseRef.current) await loadPromiseRef.current.catch(() => {});

      const SQL = await initSQL();
      const newBytes = await getBytes(store);
      let tag = null;
      let uploaded = null; // 저장소에 올라간 내용 — tag 버전의 사본으로 남긴다 (I-024)
      for (let attempt = 0; ; attempt += 1) {
        const current = await store.read(); // 2)
        if (current.bytes) await uploadNewBackup(store, current.bytes);

        if (fresh) { fresh.close(); fresh = null; } // 3)
        const opened = createDatabase(SQL, newBytes);
        fresh = opened.db;
        if (opened.newerSchema) throw new Error(`더 새 버전의 앱에서 만든 ${subject}입니다 — 페이지를 새로고침해 앱을 업데이트하세요`);
        if (opened.migrationErrors.length) throw new Error(`${subject} 파일을 여는 중 오류: ${opened.migrationErrors.join(' / ')}`);
        const seqs = getAutoIncrementSeqs(dbRef.current);
        if (current.bytes) {
          const cur = new SQL.Database(current.bytes);
          try {
            Object.entries(getAutoIncrementSeqs(cur)).forEach(([name, seq]) => { seqs[name] = Math.max(seqs[name] || 0, seq); });
          } finally { cur.close(); }
        }
        raiseAutoIncrementSeqs(fresh, seqs);
        if (newGeneration) stampGeneration(fresh);
        runAutoRegister(fresh);
        runAccountAutoRegister(fresh);
        const writeId = stampWriteId(fresh);

        try { // 4)
          uploaded = exportDatabase(fresh);
          tag = await store.write(uploaded, current.version);
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
            throw new Error(`${kindText} 결과를 확인하지 못했습니다 (${e.message}). 🔄 새로고침으로 지금 상태를 확인하세요 — ${kindText} 전 상태는 백업 목록에 있습니다`);
          }
          tag = check.version;
          uploaded = check.bytes;
          break;
        }
      }

      if (session !== sessionRef.current) return; // 바꾸는 사이 로그아웃 — 이 기기 상태를 되살리지 않는다
      // 5) ↓ 교체는 동기 실행 — 바꾸는 동안 생긴 변경은 같은 가계부(세대)일 때만 새 DB에 다시 실행해 이어서 저장한다
      const leftover = getChangeLog(dbRef.current)?.entries || [];
      const sameLedger = generationRef.current === generationOfBytes(uploaded);
      const carried = leftover.length && sameLedger ? replayChanges(fresh, leftover).entries : [];
      // 다른 가계부라 넣지 못하는 입력은 그것이 담긴 이 기기의 가계부를 백업으로 남긴다
      const mine = leftover.length && !sameLedger ? exportDatabase(dbRef.current) : null;
      inFlightRef.current = [];
      attach(fresh, carried);
      swapDb(fresh, tag, uploaded);
      if (!carried.length) clearPending(accountKeyRef.current);
      persist();
      keepCopy(uploaded, tag, session);
      offlineStartRef.current = false;
      fresh = null;
      setError('');
      if (mine) {
        notify(`${doneText} — 그동안 이 기기에서 입력한 ${leftover.length}건은 다른 가계부의 것이라 넣지 않고 백업으로 남깁니다`);
        uploadNewBackup(store, mine).catch(() => notify(`그동안 입력한 ${leftover.length}건이 담긴 가계부를 백업으로 남기지 못했습니다 — 연결을 확인하세요`));
      } else notify(doneText);
    } finally {
      if (fresh) { try { fresh.close(); } catch (e) { /* 이미 닫힘 */ } }
      restoringRef.current = false;
      if (!unmountedRef.current && getChangeLog(dbRef.current)?.entries.length && !saveTimerRef.current) {
        saveTimerRef.current = setTimeout(() => { saveNowRef.current(); }, SAVE_DEBOUNCE_MS);
      }
    }
  }, [storage, saveNow, attach, swapDb, persist, notify, keepCopy]);

  /** 고른 백업으로 되돌린다 (I-014) — 같은 가계부의 옛 모습이라 세대는 그대로(다른 기기의 밀린 변경은 이어서 저장) */
  const restoreBackup = useCallback((backup) => replaceContents(
    store => downloadBackup(store, backup.id),
    { doneText: `✓ ${backup.date} 백업으로 되돌렸습니다`, kindText: '되돌리기', subject: '백업' },
  ), [replaceContents]);

  /**
   * 가계부를 올린 파일(.db)로 통째로 바꾼다 (I-035, ROADMAP F-5) — 다른 계정·드라이브에서 쓰던 가계부를 옮겨 올 때.
   * 바꾸기 전 저장소 파일은 백업 목록에 남는다. 새 세대가 되어 다른 기기의 저장 안 된 변경은 넣지 않는다(그 기기에 알림).
   * bytes는 inspectLedgerFile로 먼저 살핀 것을 넘긴다
   */
  const replaceWithFile = useCallback((bytes) => replaceContents(
    async () => bytes,
    { newGeneration: true, doneText: '✓ 가계부를 올린 파일로 바꿨습니다', kindText: '바꾸기', subject: '가계부' },
  ), [replaceContents]);

  /**
   * 로그아웃 전 — 메모리의 DB와 보관 중인 변경, 이 기기의 사본을 모두 지운다 (B-004, I-024).
   * 진행 중인 불러오기·저장은 결과를 버린다(세션 번호). 반환: 사본을 다 지우면 끝나는 Promise —
   * 로그인 화면으로 넘어가기 전에 기다린다(넘어가며 문서가 내려가면 지우기가 끊길 수 있다)
   */
  const resetForLogout = useCallback(() => {
    sessionRef.current += 1;
    firstReadRef.current = null; // 다음 로그인(다른 계정일 수 있다)이 이 계정의 받기를 이어 쓰지 않게
    clearTimeout(saveTimerRef.current);
    clearPending(accountKeyRef.current);
    // 앞서 쓰던 사본 쓰기가 끝난 뒤에 지운다 — 늦게 끝난 쓰기가 사본을 되살리지 않게
    copyQueueRef.current = copyQueueRef.current
      .then(() => offlineCacheRef.current.clearAll())
      .catch(() => { /* 지우지 못함 — 다음 로그아웃에 다시 */ });
    const cleared = copyQueueRef.current;
    const old = dbRef.current;
    dbRef.current = null;
    versionRef.current = null;
    inFlightRef.current = [];
    failuresRef.current = 0;
    loadedForRef.current = '';
    offlineStartRef.current = false;
    setOffline(false);
    setDb(null);
    setPendingCount(0);
    setError('');
    if (old) { try { old.close(); } catch (e) { /* 이미 닫힘 */ } }
    return cleared;
  }, [setOffline]);

  // 다른 계정으로 바뀌면 이전 계정의 DB를 즉시 버린다 (B-004). 진행 중이던 작업의 결과도 버린다(세션 번호)
  const prevAccountRef = useRef(accountKey);
  useEffect(() => {
    if (prevAccountRef.current !== accountKey) {
      prevAccountRef.current = accountKey;
      sessionRef.current += 1;
      firstReadRef.current = null;
    }
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

  // 다시 온라인이 되면 미저장 변경을 저장하고, 앱으로 돌아오면 다른 기기의 변경을 확인한다.
  // 연결이 없어 사본으로 열었거나 열지 못했으면, 연결되면 저장한 뒤 저장소에서 새로 받는다 (I-024)
  useEffect(() => {
    const onOnline = () => {
      if (offlineRef.current && !loadingRef.current) { loadDb({ silent: !!dbRef.current }); return; }
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

  // 연결이 없는 동안에는 가끔 다시 확인한다 — 'online' 이벤트가 오지 않거나(onLine이 내내 true),
  // 연결 직후 한 번 실패한 뒤에도 '오프라인'에 머물지 않고 저장·새로 받기를 이어 가게 (I-024)
  useEffect(() => {
    if (!offline) return undefined;
    const timer = setInterval(() => {
      if (loadingRef.current || loopRef.current || restoringRef.current) return;
      loadDb({ silent: true });
    }, offlineRetryMs);
    return () => clearInterval(timer);
  }, [offline, offlineRetryMs, loadDb]);

  // 저장 안 된 변경이 있는데 페이지를 닫으려 하면 경고
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (unloadAllowedUntil > Date.now()) return;   // 앱이 일부러 떠나는 이동('다시 연결') — 변경은 이미 보관했다
      if (getChangeLog(dbRef.current)?.entries.length) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return {
    db, dataVersion, loading, saving, error, setError, notice, offline,
    pendingCount, dirty: pendingCount > 0,
    loadDb, saveNow, resetForLogout,
    listBackups, createBackup, restoreBackup, replaceWithFile,
  };
}
