import React, { useState, useMemo, useRef, useEffect } from 'react';
import { getPaymentMethods, updateTransaction, deleteTransaction } from '../../services/dbManager';
import { activeAI, PROVIDERS } from '../../services/aiClient';
import { prepareDocuments } from '../../services/imageUtils';
import {
  analyzeStatement, reconcileStatement, addMissingRows, txWithAmount, TOLERANCE_DAYS,
} from '../../services/cardStatement';
import { formatAmount } from '../../services/formulaEvaluator';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';
import ModalOverlay from '../common/ModalOverlay';
import AISettingsForm from '../AIEntry/AISettingsForm';
import { SourceBadge, CategoryPathSelect, splitCategoryPath, categoryText, fmtForeign } from '../AIEntry/SuggestionCard';
import '../AIEntry/AIEntry.css';
import './CardStatementModal.css';

const METHOD_KEY = 'card_statement_method';

function loadMethod() {
  try { return window.localStorage.getItem(METHOD_KEY) || ''; } catch (e) { return ''; }
}
function saveMethod(m) {
  try { window.localStorage.setItem(METHOD_KEY, m); } catch (e) { /* 기억 불가 */ }
}

const md = d => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');
const won = n => `${formatAmount(n)}원`;

function Section({ title, count, tone, children, defaultOpen = true, hint }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!count) return null;
  return (
    <div className={`cs-section cs-tone-${tone}`}>
      <button type="button" className="cs-section-head" onClick={() => setOpen(v => !v)}>
        <span className="cs-section-title">{title}</span>
        <span className="cs-section-count">{count}</span>
        <span className="cs-section-arrow">{open ? '▾' : '▸'}</span>
      </button>
      {open && hint && <div className="cs-section-hint">{hint}</div>}
      {open && <div className="cs-section-body">{children}</div>}
    </div>
  );
}

/**
 * 카드 결제 내역(캡처·명세서 PDF)을 AI로 읽어 가계부와 대조한다.
 * 비교는 로컬에서 하므로, 추가·수정하면 결과가 바로 다시 계산된다.
 */
export default function CardStatementModal({ db, dataVersion, onChanged, onClose }) {
  const live = useDbSnapshot(db, dataVersion);
  const methods = useMemo(() => getPaymentMethods(live.db).filter(m => m !== '현금'), [live]);
  const [method, setMethod] = useState(() => {
    const saved = loadMethod();
    return methods.includes(saved) ? saved : '';
  });
  const [step, setStep] = useState('pick'); // pick | setup | analyzing | result | error
  const [docs, setDocs] = useState(null);   // { parts, previews }
  const [preparing, setPreparing] = useState(false);
  const [statement, setStatement] = useState(null);
  const [error, setError] = useState('');
  const [edits, setEdits] = useState({});   // 가계부에 없음 행별 { checked, path }
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState(''); // 서버가 붐빌 때 "다시 시도하는 중" 등
  const fileRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  // 추가·수정하면 App이 dataVersion을 올려 다시 계산된다
  const result = useMemo(
    () => (statement && method ? reconcileStatement(live.db, { paymentMethod: method, ...statement }) : null),
    [live, statement, method]
  );

  const chooseMethod = (m) => {
    setMethod(m);
    saveMethod(m);
    setEdits({});
  };

  const onFiles = async (e) => {
    const list = Array.from(e.target.files || []);
    if (!list.length) return;
    setError('');
    setPreparing(true);
    try {
      setDocs(await prepareDocuments(list));
    } catch (err) {
      setDocs(null);
      setError(err.message);
    } finally {
      setPreparing(false);
    }
  };

  const pickFiles = () => {
    if (!fileRef.current) return;
    fileRef.current.value = '';
    fileRef.current.click();
  };

  const analyze = async () => {
    const ai = activeAI();
    if (!ai) { setStep('setup'); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setError('');
    setNotice('');
    setProgress('');
    setStep('analyzing');
    try {
      const st = await analyzeStatement({
        db, ai, files: docs.parts, paymentMethod: method, signal: controller.signal,
        onProgress: msg => { if (!controller.signal.aborted) setProgress(msg); },
      });
      setStatement(st);
      setEdits({});
      setStep('result');
    } catch (err) {
      if (err.name === 'AbortError') { setStep('pick'); return; }
      setError(err.message || '분석에 실패했습니다');
      setStep('error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const afterChange = async (message) => {
    setNotice(message);
    if (onChanged) await onChanged();
  };

  // ── 가계부에 없음: 행별 선택·분류 ──
  const rowState = (m) => {
    const e = edits[m.row.id] || {};
    const path = e.path !== undefined ? e.path : categoryText(m.suggestion);
    const { budget_category, sub_category } = splitCategoryPath(path);
    const ready = !!(budget_category && sub_category);
    return { path, ready, checked: e.checked !== undefined ? e.checked && ready : ready, budget_category, sub_category };
  };
  const setRow = (id, patch) => setEdits(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));

  const addSelected = async () => {
    const picks = result.missing
      .filter(m => rowState(m).checked)
      .map(m => {
        const { budget_category, sub_category } = rowState(m);
        return { suggestion: m.suggestion, budget_category, sub_category };
      });
    try {
      addMissingRows(db, picks);   // 한 묶음 — 실패하면 아무것도 들어가지 않는다
    } catch (e) {
      setNotice('');
      setError(`추가하지 못했습니다 — 아무것도 바뀌지 않았습니다 (${e.message})`);
      return;
    }
    setError('');
    await afterChange(`${picks.length}건을 가계부에 추가했습니다`);
  };

  // 가계부가 한 건일 때만 — 여러 건이면 한 건만 고치면 이중 계산된다
  const fixAmount = async (m) => {
    const [tx] = m.txs;
    updateTransaction(db, tx.id, txWithAmount(tx, m.cardTotal));
    await afterChange(`${tx.detail || '거래'} 금액을 ${won(m.cardTotal)}으로 고쳤습니다`);
  };

  const removeCancelled = async (c) => {
    deleteTransaction(db, c.tx.id);
    setConfirmDelete(null);
    await afterChange(`취소된 결제(${c.tx.detail || c.approval.merchant})를 가계부에서 지웠습니다`);
  };

  const ai = activeAI();
  const providerLabel = ai ? PROVIDERS[ai.provider].label.split(' ')[0] : '';

  // ── 단계별 화면 ──
  let body;
  if (step === 'setup') {
    body = (
      <div className="cs-pad">
        <div className="rs-box">
          <div className="rs-setup-title">AI 설정</div>
          <div className="rs-setup-desc">카드 내역을 읽을 AI를 한 번만 설정하면 됩니다.</div>
          <AISettingsForm compact onSaved={() => setStep('pick')} onCancel={() => setStep('pick')} />
        </div>
      </div>
    );
  } else if (step === 'analyzing') {
    body = (
      <div className="cs-pad">
        <div className="rs-box rs-analyzing">
          <div className="rs-analyzing-text">
            <span className="rs-spinner" />
            <span className="rs-analyzing-label">
              <span>카드 내역 읽는 중…{providerLabel && <small> ({providerLabel})</small>}</span>
              {progress && <span className="rs-progress">{progress}</span>}
            </span>
          </div>
          <button type="button" className="rs-btn-link" onClick={() => abortRef.current && abortRef.current.abort()}>취소</button>
        </div>
        <div className="cs-help">내역이 길면 30초 이상 걸릴 수 있어요.</div>
      </div>
    );
  } else if (step === 'result' && result) {
    const { matched, grouped, mismatched, missing, notOnCard, cancelled, period } = result;
    const matchCount = matched.length + grouped.length;
    const toRemove = cancelled.filter(c => c.tx);
    const selectedCount = missing.filter(m => rowState(m).checked).length;
    const selectedTotal = missing.filter(m => rowState(m).checked).reduce((s, m) => s + m.row.amount, 0);
    const allGood = !mismatched.length && !missing.length && !notOnCard.length && !toRemove.length;

    body = (
      <div className="cs-pad">
        <div className="cs-summary">
          <div className="cs-summary-title">
            {method} · {md(period.from)} ~ {md(period.to)}
            <span>카드 {statement.rows.length}건</span>
          </div>
          <div className="cs-chips">
            <span className="cs-chip ok">일치 {matchCount}</span>
            {mismatched.length > 0 && <span className="cs-chip warn">금액 차이 {mismatched.length}</span>}
            {missing.length > 0 && <span className="cs-chip add">가계부에 없음 {missing.length}</span>}
            {notOnCard.length > 0 && <span className="cs-chip info">카드에 없음 {notOnCard.length}</span>}
            {toRemove.length > 0 && <span className="cs-chip warn">취소 확인 {toRemove.length}</span>}
          </div>
        </div>

        {notice && <div className="cs-notice">✓ {notice}</div>}
        {error && <div className="rs-box rs-error"><div className="rs-error-text">{error}</div></div>}
        {allGood && <div className="cs-allgood">카드 내역과 가계부가 모두 맞습니다 👍</div>}
        {(statement.note || statement.unreadable > 0) && (
          <ul className="rs-warnings">
            {statement.unreadable > 0 && <li>날짜를 읽지 못한 {statement.unreadable}건은 비교에서 뺐습니다</li>}
            {statement.note && <li>{statement.note}</li>}
          </ul>
        )}

        <Section title="가계부에 없음" count={missing.length} tone="add" hint="카드로 결제했는데 가계부에 없는 건입니다. 분류를 확인하고 추가하세요.">
          {missing.map(m => {
            const st = rowState(m);
            const s = m.suggestion;
            return (
              <div key={m.row.id} className={`cs-row${st.checked ? ' checked' : ''}`}>
                <label className="cs-row-head">
                  <input
                    type="checkbox"
                    checked={st.checked}
                    disabled={!st.ready}
                    onChange={e => setRow(m.row.id, { checked: e.target.checked })}
                  />
                  <span className="cs-row-main">
                    <b>{s.detail || m.row.merchant}</b>
                    <small>
                      {md(m.row.date)} · {m.row.merchant}
                      {m.row.installment ? ` · ${m.row.installment}` : ''}
                      {s.eventTitle ? ` · ${s.eventTitle}` : ''}
                    </small>
                  </span>
                  <span className={`cs-row-amount${m.row.amount < 0 ? ' neg' : ''}`}>
                    {won(m.row.amount)}
                    {m.row.foreignAmount !== null && <small>{fmtForeign(m.row.foreignAmount)} {m.row.currency}</small>}
                  </span>
                </label>
                <div className="cs-row-fields">
                  <CategoryPathSelect db={db} value={st.path} onChange={v => setRow(m.row.id, { path: v, checked: true })} />
                  {st.path === categoryText(s) && <SourceBadge source={s.sources.category} />}
                </div>
              </div>
            );
          })}
          <div className="rs-actions">
            <button type="button" className="rs-btn-primary" disabled={!selectedCount} onClick={addSelected}>
              {selectedCount ? `선택한 ${selectedCount}건 추가 (${won(selectedTotal)})` : '추가할 건 선택'}
            </button>
          </div>
        </Section>

        <Section title="금액 차이" count={mismatched.length} tone="warn" hint="같은 날 같은 곳인데 금액이 다릅니다.">
          {mismatched.map(m => {
            const row = m.rows[0];
            const single = m.txs.length === 1;
            return (
              <div key={row.id} className="cs-row">
                <div className="cs-row-head">
                  <span className="cs-row-main">
                    <b>{m.txs[0].detail || row.merchant}{single ? '' : ` 외 ${m.txs.length - 1}건`}</b>
                    <small>{md(m.txs[0].date)} · 카드: {row.merchant}</small>
                  </span>
                  <span className="cs-row-amount">
                    <s>{won(m.ledgerTotal)}</s>
                    <b>→ {won(m.cardTotal)}</b>
                  </span>
                </div>
                {single ? (
                  <div className="rs-actions">
                    <button type="button" className="rs-btn-secondary" onClick={() => fixAmount(m)}>카드 금액으로 수정</button>
                  </div>
                ) : (
                  <div className="cs-group-note">
                    가계부에 {m.txs.length}건으로 나눠 적혀 있어요 ({m.txs.map(t => won(t.amount)).join(' + ')}).
                    합이 카드와 다르니 거래내역에서 직접 확인해 주세요.
                  </div>
                )}
              </div>
            );
          })}
        </Section>

        <Section title="취소된 결제" count={toRemove.length} tone="warn" hint="카드에서는 결제 후 취소됐는데 가계부에는 결제만 남아 있습니다.">
          {toRemove.map(c => (
            <div key={c.cancel.id} className="cs-row">
              <div className="cs-row-head">
                <span className="cs-row-main">
                  <b>{c.tx.detail || c.approval.merchant}</b>
                  <small>{md(c.approval.date)} 결제 → {md(c.cancel.date)} 취소</small>
                </span>
                <span className="cs-row-amount">{won(c.approval.amount)}</span>
              </div>
              <div className="rs-actions">
                {confirmDelete === c.cancel.id ? (
                  <>
                    <button type="button" className="rs-btn-secondary" onClick={() => setConfirmDelete(null)}>그대로 두기</button>
                    <button type="button" className="cs-btn-danger" onClick={() => removeCancelled(c)}>가계부에서 삭제</button>
                  </>
                ) : (
                  <button type="button" className="rs-btn-secondary" onClick={() => setConfirmDelete(c.cancel.id)}>가계부에서 삭제…</button>
                )}
              </div>
            </div>
          ))}
        </Section>

        <Section
          title="카드에 없음"
          count={notOnCard.length}
          tone="info"
          defaultOpen={false}
          hint={`가계부에는 ${method}(으)로 적었는데 카드 내역에 없습니다. 다른 결제수단이었거나, 아직 승인 전이거나, 캡처에서 빠졌을 수 있어요.`}
        >
          {notOnCard.map(t => (
            <div key={t.id} className="cs-row cs-row-plain">
              <span className="cs-row-main">
                <b>{t.detail || t.sub_category}</b>
                <small>{md(t.date)} · {t.budget_category}{t.sub_category ? ` > ${t.sub_category}` : ''}</small>
              </span>
              <span className="cs-row-amount">{won(t.amount)}</span>
            </div>
          ))}
        </Section>

        <Section
          title="일치"
          count={matchCount}
          tone="ok"
          defaultOpen={false}
          hint={`금액이 같고 날짜가 ±${TOLERANCE_DAYS}일 안인 건입니다. 같은 가게에서 나눠 적거나 합쳐 적은 것도 합계가 같으면 일치로 봅니다.`}
        >
          {grouped.map(g => (
            <div key={`g-${g.rows[0].id}`} className="cs-row cs-row-plain">
              <span className="cs-row-main">
                <b>
                  {g.txs[0].detail || g.rows[0].merchant}
                  <span className="cs-group-tag">{g.kind === 'split' ? '나눠 적음' : '합쳐 적음'}</span>
                </b>
                <small>
                  {g.kind === 'split'
                    ? `가계부 ${g.txs.length}건 (${g.txs.map(t => won(t.amount)).join(' + ')})`
                    : `카드 ${g.rows.length}건 (${g.rows.map(r => won(r.amount)).join(' + ')})`}
                  {' · '}{md(g.rows[0].date)}
                </small>
              </span>
              <span className="cs-row-amount">
                {won(g.kind === 'split' ? g.rows[0].amount : g.rows.reduce((s, r) => s + r.amount, 0))}
              </span>
            </div>
          ))}
          {matched.map(m => (
            <div key={m.row.id} className="cs-row cs-row-plain">
              <span className="cs-row-main">
                <b>{m.tx.detail || m.row.merchant}</b>
                <small>
                  {md(m.tx.date)}{m.dayDiff ? ` (카드 ${md(m.row.date)})` : ''} · 카드: {m.row.merchant}
                </small>
              </span>
              <span className="cs-row-amount">{won(m.row.amount)}</span>
            </div>
          ))}
        </Section>
      </div>
    );
  } else {
    // pick / error
    body = (
      <div className="cs-pad">
        <div className="cs-intro">
          카드 앱의 <b>이용내역 캡처</b>나 <b>명세서 PDF</b>를 올리면 AI가 결제 목록을 읽어
          가계부와 비교하고, 빠진 건은 바로 추가할 수 있게 정리합니다.
        </div>

        <div className="cs-field">
          <label>어느 카드인가요?</label>
          <select value={method} onChange={e => chooseMethod(e.target.value)}>
            <option value="">결제수단 선택</option>
            {methods.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div className="cs-field">
          <label>카드 내역 파일</label>
          <button type="button" className="cs-drop" onClick={pickFiles} disabled={preparing}>
            {preparing ? '파일 준비 중…' : docs ? '다른 파일로 바꾸기' : '📎 캡처·PDF 선택 (여러 장 가능)'}
          </button>
          {docs && (
            <div className="cs-previews">
              {docs.previews.map((p, i) => (
                <div key={i} className="cs-preview">
                  {p.dataUrl ? <img src={p.dataUrl} alt={p.name} /> : <span className="cs-pdf">PDF</span>}
                  <small>{p.name}{p.tiles > 1 ? ` · ${p.tiles}조각` : ''}</small>
                </div>
              ))}
            </div>
          )}
          <span className="cs-help">긴 캡처는 글자가 뭉개지지 않게 나눠서 보냅니다. 카드 번호·이름 같은 개인정보는 가려도 됩니다.</span>
        </div>

        {error && <div className="rs-box rs-error"><div className="rs-error-text">{error}</div></div>}

        <div className="rs-actions">
          {step === 'error' && <button type="button" className="rs-btn-secondary" onClick={() => setStep('setup')}>AI 설정</button>}
          {statement && <button type="button" className="rs-btn-secondary" onClick={() => setStep('result')}>이전 결과 보기</button>}
          <button type="button" className="rs-btn-primary" disabled={!method || !docs || preparing} onClick={analyze}>
            {!method ? '카드를 먼저 고르세요' : !docs ? '파일을 올려 주세요' : '대조하기'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <ModalOverlay className="modal-overlay" panelClassName="modal-content cs-modal">
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        onChange={onFiles}
        style={{ display: 'none' }}
      />
      <div className="modal-header">
        <h2>카드 내역 대조</h2>
        <button className="modal-close" onClick={onClose}>✕</button>
      </div>
      {body}
      {step === 'result' && (
        <div className="cs-pad cs-footer">
          <button type="button" className="rs-btn-secondary" onClick={() => { setStep('pick'); setNotice(''); }}>다른 내역 대조</button>
          <button type="button" className="rs-btn-primary" onClick={onClose}>닫기</button>
        </div>
      )}
    </ModalOverlay>
  );
}
