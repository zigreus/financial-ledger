import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  getMembers, addMember, renameMember, deleteMember, getMemberUsage, exportDatabase,
} from '../../../services/dbManager';
import { getDeviceMember, setDeviceMember } from '../../../services/deviceMember';
import { buildTransactionsCSV } from '../../../services/exportData';
import { isValidDateStr, todayStr } from '../../../services/dateUtils';
import { useDbSnapshot } from '../../../hooks/useDbSnapshot';
import { downloadText, downloadBytes } from '../../common/download';
import { AddItemRow } from '../MasterItemList';
import { IconEdit, IconTrash, IconCheck, IconClose } from '../icons';

const blockStyle = { marginBottom: '24px', paddingBottom: '20px', borderBottom: '1px solid var(--border)' };
const titleStyle = { fontSize: '14px', fontWeight: '600', marginBottom: '6px' };
const descStyle = { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.6 };

/** 설정 › 데이터 — 가족 구성원, 내보내기, 백업·되돌리기 */
export default function DataSection({ db, dataVersion, onChanged, setError, backup }) {
  return (
    <div>
      <MembersBlock db={db} dataVersion={dataVersion} onChanged={onChanged} setError={setError} />
      <ExportBlock db={db} setError={setError} />
      {backup && <BackupBlock backup={backup} setError={setError} />}
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
        하루에 한 번, 그날 가계부를 처음 열 때 OneDrive의 Apps/financial-ledger/backups 폴더에 백업을 만듭니다.
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
        <div className="error-msg" style={{ fontSize: '13px' }}>백업 목록을 불러오지 못했습니다: {loadError}</div>
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
