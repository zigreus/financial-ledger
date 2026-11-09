import React, { useCallback, useEffect, useRef, useState } from 'react';
import { buildJoinLink } from '../../../services/ledgers';
import { copyText } from '../../common/copyText';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_MESSAGE = '지금 가계부를 함께 쓰자고 초대했어요. 함께 보낸 참여 링크를 눌러 같은 Microsoft 계정으로 로그인하면 열려요.';

/**
 * 설정 › 데이터 › 다른 계정과 함께 쓰기 (ROADMAP M-2, 1단계 Microsoft 개인 계정)
 *  - 내 가계부를 보는 중: 이메일로 초대 → 참여 링크(메신저로 보낸다) / 함께 쓰는 사람 목록·빼기
 *  - 공유받은 가계부를 보는 중: 누구의 가계부인지, 내 가계부로 돌아가기, 목록에서 빼기
 *  - 공유받은 가계부 목록(열기)
 * ledgers: App의 { provider, canShare, sharing, myName, current, shared, switchTo, leave }
 */
export default function LedgerShareBlock({ ledgers, setError }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState('');
  const [link, setLink] = useState('');
  const [message, setMessage] = useState('');
  const [members, setMembers] = useState(null);   // null = 아직 안 불러옴
  const [membersError, setMembersError] = useState('');
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const { provider, canShare, sharing, myName, current, shared, switchTo, leave } = ledgers || {};

  const loadMembers = useCallback(async () => {
    if (!sharing) return;
    setMembersError('');
    try {
      const list = await sharing.listMembers();
      if (aliveRef.current) setMembers(list.filter(m => !m.owner));
    } catch (e) {
      if (aliveRef.current) setMembersError(e.message);
    }
  }, [sharing]);
  useEffect(() => { if (sharing && !current) loadMembers(); }, [sharing, current, loadMembers]);

  if (!ledgers) return null;

  const invite = async () => {
    const to = email.trim();
    if (!EMAIL_RE.test(to)) { setError('초대할 사람의 이메일 주소를 확인하세요'); return; }
    setBusy('invite');
    setMessage('');
    setError('');
    try {
      const ref = await sharing.invite(to, INVITE_MESSAGE);
      if (!aliveRef.current) return;
      setLink(buildJoinLink(window.location.origin, ref, myName));
      setEmail('');
      setMessage(`✓ ${to}을(를) 초대했어요. 아래 참여 링크를 메신저로 보내 주세요.`);
      loadMembers();
    } catch (e) {
      if (aliveRef.current) setError(e.message);
    } finally {
      if (aliveRef.current) setBusy('');
    }
  };

  const showLink = async () => {
    setBusy('link');
    setError('');
    try {
      const ref = await sharing.ownLedgerRef();
      if (!aliveRef.current) return;
      if (!ref) { setError('가계부 파일이 아직 없습니다 — 가계부를 한 번 저장한 뒤 다시 누르세요'); return; }
      setLink(buildJoinLink(window.location.origin, ref, myName));
    } catch (e) {
      if (aliveRef.current) setError(e.message);
    } finally {
      if (aliveRef.current) setBusy('');
    }
  };

  const copyLink = async () => {
    const ok = await copyText(link);
    setMessage(ok ? '✓ 참여 링크를 복사했어요. 메신저에 붙여 넣어 보내 주세요.' : '복사하지 못했어요 — 링크를 길게 눌러 직접 복사해 주세요.');
  };

  const removeMember = async (m) => {
    if (!window.confirm(`${m.name || m.email}을(를) 함께 쓰는 사람에서 뺄까요?\n그 계정은 더 이상 이 가계부를 열 수 없어요(이미 적은 거래는 그대로 남아요).`)) return;
    setBusy(`rm-${m.id}`);
    try {
      await sharing.removeMember(m.id);
      if (aliveRef.current) setMembers(prev => (prev || []).filter(x => x.id !== m.id));
    } catch (e) {
      if (aliveRef.current) setError(e.message);
    } finally {
      if (aliveRef.current) setBusy('');
    }
  };

  const leaveCurrent = () => {
    if (!current) return;
    if (!window.confirm(`${current.ownerName || '공유받은'} 가계부를 목록에서 뺄까요?\n공유는 그대로라, 다시 열려면 참여 링크를 다시 누르면 돼요.`)) return;
    leave(current.id);
  };

  return (
    <div className="data-share">
      <div className="data-share-title">다른 계정과 함께 쓰기</div>
      {provider !== 'microsoft' ? (
        <div className="data-share-desc">
          지금은 Microsoft 개인 계정끼리만 함께 쓸 수 있어요. Google 계정끼리 함께 쓰기는 다음 단계에서 준비할게요.
          그때까지는 가족이 같은 계정으로 로그인해 함께 쓸 수 있어요.
        </div>
      ) : !canShare ? (
        <div className="data-share-desc">
          회사·학교 Microsoft 계정은 아직 함께 쓰기를 지원하지 않아요(회사 관리자의 승인이 필요해요). 개인 Microsoft 계정으로 로그인하면 쓸 수 있어요.
        </div>
      ) : current ? (
        <>
          <div className="data-share-desc">
            지금 {current.ownerName ? <><b>{current.ownerName}</b>님이</> : '다른 계정이'} 공유한 가계부를 보고 있어요. 적은 것은 공유한 사람의 OneDrive에 저장되고,
            이 가계부의 매일 백업·되돌리기·파일로 바꾸기는 공유한 사람의 기기에서 해요.
          </div>
          <div className="data-actions">
            <button type="button" className="btn-secondary" onClick={() => switchTo('')}>내 가계부로</button>
            <button type="button" className="btn-secondary" onClick={leaveCurrent}>목록에서 빼기</button>
          </div>
        </>
      ) : (
        <>
          <div className="data-share-desc">
            가족이 각자 자기 Microsoft 계정으로 이 가계부를 함께 쓸 수 있어요. 이메일로 초대하면 그 계정에 이 가계부 파일 하나만
            공유되고(AI 설정 등 다른 파일은 공유하지 않아요), 참여 링크가 만들어져요 — 메신저로 보내 주세요.
          </div>
          <div className="data-share-row">
            <input
              type="email"
              className="data-share-input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="초대할 Microsoft 계정 이메일"
              aria-label="초대할 이메일"
              autoComplete="email"
            />
            <button type="button" className="btn-primary data-share-btn" onClick={invite} disabled={!!busy || !email.trim()}>
              {busy === 'invite' ? '초대하는 중…' : '초대'}
            </button>
          </div>
          {!link && (
            <button type="button" className="btn-secondary data-share-linkbtn" onClick={showLink} disabled={!!busy}>
              {busy === 'link' ? '만드는 중…' : '이미 초대한 사람에게 보낼 참여 링크'}
            </button>
          )}
          {link && (
            <div className="data-share-link">
              <code className="data-share-linktext">{link}</code>
              <button type="button" className="btn-secondary" onClick={copyLink}>링크 복사</button>
            </div>
          )}
          <div className="data-share-subtitle">함께 쓰는 사람</div>
          {membersError ? (
            <div className="error-msg" style={{ fontSize: 'calc(13px * var(--fs))' }}>{membersError}</div>
          ) : members === null ? (
            <div className="data-muted">불러오는 중…</div>
          ) : members.length === 0 ? (
            <div className="data-muted">아직 없어요.</div>
          ) : (
            <ul className="data-share-members">
              {members.map(m => (
                <li key={m.id} className="data-share-member">
                  <span className="data-share-member-name">{m.name || m.email || '초대한 사람'}{m.email && m.name ? <small> {m.email}</small> : null}</span>
                  <button type="button" className="btn-secondary data-share-rm" onClick={() => removeMember(m)} disabled={!!busy}>
                    {busy === `rm-${m.id}` ? '빼는 중…' : '빼기'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {message && <div className="data-message" role="status">{message}</div>}
      {canShare && shared?.length > 0 && (
        <>
          <div className="data-share-subtitle">공유받은 가계부</div>
          <ul className="data-share-members">
            {shared.map(l => (
              <li key={l.id} className="data-share-member">
                <span className="data-share-member-name">{l.ownerName || '공유받은'} 가계부</span>
                {current?.id === l.id
                  ? <span className="data-muted">보는 중</span>
                  : <button type="button" className="btn-secondary data-share-rm" onClick={() => switchTo(l.id)}>열기</button>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
