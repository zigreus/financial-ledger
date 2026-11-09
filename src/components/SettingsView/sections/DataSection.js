import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  getMembers, addMember, renameMember, deleteMember, getMemberUsage, exportDatabase,
} from '../../../services/dbManager';
import { getDeviceMember, setDeviceMember } from '../../../services/deviceMember';
import { buildTransactionsCSV } from '../../../services/exportData';
import { isValidDateStr, todayStr } from '../../../services/dateUtils';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import { downloadText, downloadBytes } from '../../common/download';
import { currentBackupPath, currentDriveName } from '../../../services/storage/driveName';
import { inspectLedgerFile, ledgerSummary } from '../../../services/ledgerFile';
import { readFileBytes } from '../../../services/sheetFile';
import { AddItemRow } from '../MasterItemList';
import { IconEdit, IconTrash, IconCheck, IconClose } from '../icons';

const blockStyle = { marginBottom: '24px', paddingBottom: '20px', borderBottom: '1px solid var(--border)' };
const titleStyle = { fontSize: 'calc(14px * var(--fs))', fontWeight: '600', marginBottom: '6px' };
const descStyle = { fontSize: 'calc(12px * var(--fs))', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.6 };

/** 설정 › 데이터 — 가족 구성원, 내보내기, 백업·되돌리기, 가계부 파일로 바꾸기 */
export default function DataSection({ db, dataVersion, onChanged, setError, backup }) {
  return (
    <div>
      <MembersBlock db={db} dataVersion={dataVersion} onChanged={onChanged} setError={setError} />
      <ExportBlock db={db} setError={setError} />
      {backup && <BackupBlock backup={backup} setError={setError} />}
      {backup?.replaceWithFile && <ReplaceBlock db={db} dataVersion={dataVersion} backup={backup} setError={setError} />}
    </div>
  );
}

// ── 가족 구성원 (I-013) ─────────────────────────────────────────

function MembersBlock({ db, dataVersion, onChanged, setError }) {
  const live = useDbSnapshot(db, dataVersion);
  const members = useMemo(() => getMembers(live.db), [live]);
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState(null); // { name, value }
  const [device, setDevice] = useState(getDeviceMember);
  const deviceValid = members.some(m => m.name === device);

  const chooseDevice = (name) => {
    setDeviceMember(name);
    setDevice(name);
  };

  const handleAdd = () => {
    try {
      addMember(db, adding);
      onChanged();
      setAdding('');
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleRename = () => {
    try {
      const next = renameMember(db, editing.name, editing.value);
      if (device === editing.name) chooseDevice(next);
      onChanged();
      setEditing(null);
      setError('');
    } catch (e) { setError(e.message); }
  };

  const handleDelete = (name) => {
    const used = getMemberUsage(db, name);
    const msg = used
      ? `"${name}"을(를) 삭제합니다.\n이 이름으로 적힌 거래 ${used}건은 '누가'가 비워집니다(거래는 그대로 남습니다).`
      : `"${name}"을(를) 삭제하시겠습니까?`;
    if (!window.confirm(msg)) return;
    try {
      deleteMember(db, name);
      if (device === name) chooseDevice('');
      onChanged();
      setError('');
    } catch (e) { setError(e.message); }
  };

  return (
    <div style={blockStyle}>
      <div style={titleStyle}>가족 구성원</div>
      <div style={descStyle}>
        거래마다 '누가' 썼는지 적을 수 있습니다. 거래 목록에서 구성원별로 거르고, 요약 › 결제수단 탭에서 구성원별 합계를 볼 수 있습니다.
      </div>

      {members.length > 0 && (
        <ul className="data-member-list">
          {members.map(m => (
            <li key={m.id} className="data-member-row">
              {editing?.name === m.name ? (
                <>
                  <input
                    className="settings-inline-input"
                    value={editing.value}
                    autoFocus
                    onChange={e => setEditing({ ...editing, value: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditing(null); }}
                  />
                  <button className="btn-icon btn-icon--success" onClick={handleRename} title="저장"><IconCheck /></button>
                  <button className="btn-icon" onClick={() => setEditing(null)} title="취소"><IconClose /></button>
                </>
              ) : (
                <>
                  <span className="data-member-name">
                    {m.name}
                    {device === m.name && <span className="data-member-badge">이 기기</span>}
                  </span>
                  <button className="btn-icon" onClick={() => setEditing({ name: m.name, value: m.name })} title="이름 바꾸기"><IconEdit /></button>
                  <button className="btn-icon btn-icon--danger" onClick={() => handleDelete(m.name)} title="삭제"><IconTrash /></button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <AddItemRow value={adding} onChange={setAdding} onSubmit={handleAdd} placeholder="예: 엄마, 아빠" />

      {members.length > 0 && (
        <label className="data-device-row">
          <span>
            <b>이 기기 사용자</b>
            <small>새 거래의 '누가'에 미리 채워집니다. 기기마다 따로 정합니다.</small>
          </span>
          <select value={deviceValid ? device : ''} onChange={e => chooseDevice(e.target.value)}>
            <option value="">정하지 않음</option>
            {members.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

// ── 내보내기 (I-014) ────────────────────────────────────────────

function ExportBlock({ db, setError }) {
  const year = Number(todayStr().slice(0, 4));
  const [period, setPeriod] = useState('all'); // all | thisYear | lastYear | range
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');

  const range = () => {
    if (period === 'thisYear') return { from: `${year}-01-01`, to: `${year}-12-31`, label: String(year) };
    if (period === 'lastYear') return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31`, label: String(year - 1) };
    if (period === 'range') {
      if (!isValidDateStr(from) || !isValidDateStr(to)) throw new Error('시작일과 종료일을 모두 고르세요.');
      if (from > to) throw new Error('종료일이 시작일보다 빠릅니다.');
      return { from, to, label: `${from}_${to}` };
    }
    return { from: '', to: '', label: `전체_${todayStr()}` };
  };

  const exportCsv = () => {
    try {
      const r = range();
      const { csv, count } = buildTransactionsCSV(db, r);
      if (!count) { setMessage('이 기간에는 내보낼 거래가 없습니다.'); return; }
      downloadText(csv, `가계부_거래_${r.label}.csv`, 'text/csv');
      setMessage(`✓ 거래 ${count.toLocaleString()}건을 내려받았습니다.`);
      setError('');
    } catch (e) { setError(e.message); }
  };

  const exportDb = () => {
    downloadBytes(exportDatabase(db), `가계부_${todayStr()}.db`);
    setMessage('✓ 가계부 파일(.db)을 내려받았습니다.');
  };

  return (
    <div style={blockStyle}>
      <div style={titleStyle}>내보내기</div>
      <div style={descStyle}>
        거래 CSV는 엑셀에서 바로 열리고, 거래내역 › 불러오기로 다시 가져올 수 있는 형식입니다.
        가계부 파일(.db)은 모든 설정·계좌·일정까지 담긴 전체 사본입니다.
      </div>
      <div className="data-export-row">
        <select value={period} onChange={e => { setPeriod(e.target.value); setMessage(''); }}>
          <option value="all">전체 기간</option>
          <option value="thisYear">올해 ({year})</option>
          <option value="lastYear">작년 ({year - 1})</option>
          <option value="range">기간 직접 선택</option>
        </select>
        {period === 'range' && (
          <span className="data-export-range">
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="시작일" />
            <span>~</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="종료일" />
          </span>
        )}
      </div>
      <div className="data-actions">
        <button className="btn-primary" onClick={exportCsv}>거래 CSV 내려받기</button>
        <button className="btn-secondary" onClick={exportDb}>가계부 파일(.db) 내려받기</button>
      </div>
      {message && <div className="data-message">{message}</div>}
    </div>
  );
}

// ── 백업·되돌리기 (I-014) ────────────────────────────────────────

const sizeText = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`);
const backupLabel = (b) => `${b.date}${b.time ? ` ${b.time.slice(0, 5)}` : ''}`;

function BackupBlock({ backup, setError }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(''); // '' | 'create' | 백업 id
  const [message, setMessage] = useState('');
  const seqRef = useRef(0);

  // 늦게 도착한 목록 응답은 버린다 — 화면을 떠났거나 그 사이 다시 불렀으면 무시 (B-049·B-052와 같은 규칙)
  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const items = await backup.list();
      if (seq === seqRef.current) setList(items);
    } catch (e) {
      if (seq === seqRef.current) setLoadError(e.message);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [backup]);

  useEffect(() => {
    load();
    return () => { seqRef.current += 1; };
  }, [load]);

  const createNow = async () => {
    setBusy('create');
    setMessage('');
    try {
      const name = await backup.create();
      setMessage(`✓ 지금 상태를 백업했습니다 (${name})`);
      setError('');
      load();
    } catch (e) { setError(`백업 실패: ${e.message}`); } finally { setBusy(''); }
  };

  const restore = async (item) => {
    const ok = window.confirm(
      `${backupLabel(item)} 백업으로 되돌립니다.\n\n`
      + '· 그 뒤에 입력하거나 고친 내용은 가계부에서 사라집니다.\n'
      + '· 되돌리기 전에 지금 상태를 백업 목록에 하나 더 남깁니다.\n'
      + '· 다른 기기에서 아직 저장하지 못한 변경은 되돌린 가계부에 이어서 저장될 수 있습니다.',
    );
    if (!ok) return;
    setBusy(item.id);
    setMessage('');
    try {
      await backup.restore(item);
      setMessage(`✓ ${backupLabel(item)} 백업으로 되돌렸습니다.`);
      setError('');
      load();
    } catch (e) { setError(`되돌리기 실패: ${e.message}`); } finally { setBusy(''); }
  };

  return (
    <div style={{ marginBottom: '8px' }}>
      <div style={titleStyle}>백업·되돌리기</div>
      <div style={descStyle}>
        하루에 한 번, 그날 가계부를 처음 열 때 {currentBackupPath()}에 백업을 만듭니다.
        최근 30개를 보관하고, 실수로 지우거나 잘못 가져왔을 때 그 시점으로 되돌릴 수 있습니다.
      </div>
      <div className="data-actions">
        <button className="btn-secondary" onClick={createNow} disabled={!!busy}>
          {busy === 'create' ? '백업하는 중…' : '지금 백업'}
        </button>
        <button className="btn-secondary" onClick={load} disabled={loading || !!busy}>새로고침</button>
      </div>
      {message && <div className="data-message">{message}</div>}

      {loading ? (
        <div className="data-muted">백업 목록을 불러오는 중…</div>
      ) : loadError ? (
        <div className="error-msg" style={{ fontSize: 'calc(13px * var(--fs))' }}>백업 목록을 불러오지 못했습니다: {loadError}</div>
      ) : list.length === 0 ? (
        <div className="data-muted">아직 백업이 없습니다. 가계부를 여는 날마다 자동으로 만들어지고, '지금 백업'으로 바로 만들 수도 있습니다.</div>
      ) : (
        <ul className="data-backup-list">
          {list.map(b => (
            <li key={b.id} className="data-backup-row">
              <span className="data-backup-main">
                <b>{backupLabel(b)}</b>
                <small>{b.daily ? '매일 백업' : '직접 · 되돌리기 전 백업'} · {sizeText(b.size)}</small>
              </span>
              <button className="btn-secondary data-backup-btn" onClick={() => restore(b)} disabled={!!busy}>
                {busy === b.id ? '되돌리는 중…' : '되돌리기'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 가계부 파일로 바꾸기 (I-035, ROADMAP F-5) ────────────────────

const won = n => Number(n || 0).toLocaleString();
function summaryText(s) {
  const period = s.from ? ` (${s.from} ~ ${s.to})` : '';
  return `거래 ${won(s.transactions)}건${period} · 카테고리 ${won(s.categories)} · 결제수단 ${won(s.paymentMethods)} · 계좌 ${won(s.accounts)} · 일정 ${won(s.events)} · 정기지출 ${won(s.recurring)}`;
}

/**
 * 다른 계정·드라이브에서 쓰던 가계부(.db)를 이 계정의 가계부로 통째로 옮겨 온다.
 * 파일을 고르면 이 앱의 가계부인지 살펴 지금 가계부와 견줘 보이고, 확정할 때만 바꾼다(B-029).
 * 바꾸기 전 지금 가계부는 백업 목록에 남는다(되돌리기로 돌아올 수 있음).
 */
function ReplaceBlock({ db, dataVersion, backup, setError }) {
  const live = useDbSnapshot(db, dataVersion);
  const current = useMemo(() => ledgerSummary(live.db), [live]);
  const [picked, setPicked] = useState(null);   // { name, bytes, summary }
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [fileError, setFileError] = useState('');
  const seqRef = useRef(0);
  useEffect(() => () => { seqRef.current += 1; }, []);

  const choose = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const seq = ++seqRef.current;
    setPicked(null);
    setMessage('');
    setFileError('');
    setChecking(true);
    try {
      const bytes = await readFileBytes(file);
      const summary = await inspectLedgerFile(bytes);
      if (seq === seqRef.current) setPicked({ name: file.name, bytes, summary });
    } catch (err) {
      if (seq === seqRef.current) setFileError(err.message);
    } finally {
      if (seq === seqRef.current) setChecking(false);
    }
  };

  const replace = async () => {
    if (!picked) return;
    const ok = window.confirm(
      `지금 가계부를 "${picked.name}"의 내용으로 통째로 바꿉니다.\n\n`
      + `· 지금 가계부(거래 ${won(current.transactions)}건)는 바꾸기 전에 백업 목록에 남깁니다 — 되돌리기로 돌아올 수 있습니다.\n`
      + '· 이 계정을 쓰는 다른 기기에서 아직 저장하지 않은 입력은 바뀐 가계부에 들어가지 않습니다(그 기기에 알림).\n'
      + '· 가족 구성원 이름·카테고리·계좌·일정·설정도 모두 파일의 것으로 바뀝니다.',
    );
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      await backup.replaceWithFile(picked.bytes);
      setMessage(`✓ 가계부를 "${picked.name}"로 바꿨습니다. 바꾸기 전 가계부는 위 백업 목록에 있습니다.`);
      setPicked(null);
      setError('');
    } catch (err) {
      setError(`바꾸기 실패: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: '24px', paddingTop: '20px', borderTop: '1px solid var(--border)' }}>
      <div style={titleStyle}>가계부 파일로 바꾸기</div>
      <div style={descStyle}>
        다른 계정({currentDriveName() === 'Google Drive' ? 'OneDrive' : 'Google Drive'} 등)에서 쓰던 가계부를 옮겨 올 때 씁니다.
        그 계정에서 위 &apos;가계부 파일(.db) 내려받기&apos;로 받은 파일을 고르세요. 거래뿐 아니라 카테고리·결제수단·계좌·정기지출·일정·설정까지 그대로 옮겨집니다.
        엑셀·CSV는 거래내역 › 가져오기를 쓰세요.
      </div>
      <input type="file" accept=".db,.sqlite,application/octet-stream" onChange={choose} disabled={busy || checking} className="data-file-input" aria-label="가계부 파일 고르기" />
      {checking && <div className="data-muted">파일을 살펴보는 중…</div>}
      {fileError && <div className="error-msg" style={{ fontSize: 'calc(13px * var(--fs))' }}>{fileError}</div>}
      {picked && (
        <div className="data-replace-compare">
          <div><b>고른 파일</b><span>{summaryText(picked.summary)}</span></div>
          <div><b>지금 가계부</b><span>{summaryText(current)}</span></div>
          <div className="data-actions">
            <button className="btn-primary" onClick={replace} disabled={busy}>{busy ? '바꾸는 중…' : '이 파일로 바꾸기'}</button>
            <button className="btn-secondary" onClick={() => setPicked(null)} disabled={busy}>취소</button>
          </div>
        </div>
      )}
      {message && <div className="data-message">{message}</div>}
    </div>
  );
}
