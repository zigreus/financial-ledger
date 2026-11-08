import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  getPaymentMethods, updateTransaction, deleteTransaction, getSplitGroupTransactions, withTransaction,
} from '../../services/dbManager';
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
// 금액이 다른 취소의 안내 — 거의 전액이면(해외결제 환율 차이) "취소", 아니면 "부분취소"
const cutKind = (approval, cancel) => (-cancel.amount >= approval.amount * 0.9 ? '취소' : '부분취소');
const cutDates = cs => cs.map(c => md(c.date)).join('·');
const cutSum = cs => won(cs.reduce((s, c) => s - c.amount, 0));
const GROUP_TAG = { split: '나눠 적음', merged: '합쳐 적음', mixed: '나눠·합쳐 적음', partialCancel: '부분취소 반영' };

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
  const [statement, setStatement] = useState(null); // { ...카드 내역, method: 대조한 결제수단, modelNote }
  const [error, setError] = useState('');
  const [edits, setEdits] = useState({});   // 가계부에 없음 행별 { checked, path }
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [kept, setKept] = useState(() => new Set());   // "그대로 두기"를 누른 취소 건 — 이번 결과에서는 확인거리로 세지 않는다
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState(''); // 서버가 붐빌 때 "다시 시도하는 중" 등
  const fileRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  // 추가·수정하면 App이 dataVersion을 올려 다시 계산된다.
  // 읽을 때 고른 결제수단으로만 대조한다 — 뒤에서 카드를 바꿔도 이전 내역을 다른 카드와 비교하지 않게
  const result = useMemo(
    () => (statement ? reconcileStatement(live.db, { ...statement, paymentMethod: statement.method }) : null),
    [live, statement]
  );
  const canShowPrevious = !!statement && statement.method === method;

  const chooseMethod = (m) => {
    setMethod(m);
    saveMethod(m);
    setEdits({});
    setConfirmDelete(null);
  };
  const keepCancelled = (c) => {
    setConfirmDelete(null);
    setKept(prev => new Set(prev).add(c.cancel.id));
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
    setConfirmDelete(null);   // 새 명세서의 행 id가 이전 것과 같아도 확인 단계가 열린 채로 시작하지 않게
    setKept(new Set());
    setStep('analyzing');
    let modelNote = ''; // 고른 모델이 붐벼 다른 모델이 대신 읽었을 때 — 이 결과에만 붙는다
    try {
      const st = await analyzeStatement({
        db, ai, files: docs.parts, paymentMethod: method, signal: controller.signal,
        onProgress: (msg, info) => {
          if (controller.signal.aborted) return;
          if (info?.modelUsed) {
            if (info.modelUsed !== ai.model) modelNote = `${ai.model}이(가) 붐벼서 ${info.modelUsed}(으)로 읽었습니다`;
          } else {
            setProgress(msg);
          }
        },
      });
      setStatement({ ...st, method, modelNote });
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

  // 고치기·지우기·추가가 성공하면 앞서 실패한 안내는 지운다
  const afterChange = async (message) => {
    setError('');
    setNotice(message);
    if (onChanged) await onChanged();
  };
  const failChange = (what, e) => {
    setNotice('');
    setError(`${what} — 아무것도 바뀌지 않았습니다 (${e.message})`);
  };

  // ── 가계부에 없음: 행별 선택·분류 ──
  const rowState = (m) => {
    const e = edits[m.row.id] || {};
    const path = e.path !== undefined ? e.path : categoryText(m.suggestion);
    const { budget_category, sub_category } = splitCategoryPath(path);
    const ready = !!(budget_category && sub_category);
    // 이미 적었을 수도 있는 건(비슷한 기록·기간 밖·할부)은 미리 체크하지 않는다
    const checked = e.checked !== undefined ? e.checked && ready : ready && m.autoCheck;
    return { path, ready, checked, budget_category, sub_category };
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
      failChange('추가하지 못했습니다', e);
      return;
    }
    await afterChange(`${picks.length}건을 가계부에 추가했습니다`);
  };

  // 가계부가 한 건일 때만 — 여러 건이면 한 건만 고치면 이중 계산된다.
  // 카드가 여러 건이면(합쳐 적음) 그 합계로 고친다.
  const fixAmount = async (m) => {
    const [tx] = m.txs;
    try {
      updateTransaction(db, tx.id, txWithAmount(tx, m.cardTotal));
    } catch (e) {
      failChange('고치지 못했습니다', e);
      return;
    }
    await afterChange(`${tx.detail || '거래'} 금액을 ${won(m.cardTotal)}으로 고쳤습니다`);
  };

  // 나눠 결제한 묶음의 한 몫이면 묶음 전체를 지운다 (결제가 취소되면 나머지 몫도 돌려받는다 — 한 몫만 지우면
  // 나머지가 분할 표시를 단 채 고아로 남는다). 확인 단계에서 묶음의 모든 몫과 금액을 보여 준다.
  const splitGroupOf = tx => (tx && tx.split_group_id ? getSplitGroupTransactions(live.db, tx.split_group_id) : []);
  const removeCancelled = async (c) => {
    const tx = c.tx || c.maybeTx;
    const group = splitGroupOf(tx);
    const ids = group.length > 1 ? group.map(t => t.id) : [tx.id];
    setConfirmDelete(null);
    try {
      withTransaction(db, () => ids.forEach(id => deleteTransaction(db, id)));
    } catch (e) {
      failChange('지우지 못했습니다', e);
      return;
    }
    await afterChange(ids.length > 1
      ? `취소된 결제(${tx.detail || c.approval.merchant})를 묶인 ${ids.length}건과 함께 가계부에서 지웠습니다`
      : `취소된 결제(${tx.detail || c.approval.merchant})를 가계부에서 지웠습니다`);
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
    // 삭제를 권하는 것(tx)과, 확실하지 않아 확인만 띄우는 것(maybeTx)
    const toRemove = cancelled.filter(c => (c.tx || c.maybeTx) && !kept.has(c.cancel.id));
    // 명세서 기간 밖 기록 (앞뒤 명세서의 것일 수 있다) — 화면에 나오는 곳마다 표시한다
    const outside = t => t && (t.date < period.from || t.date > period.to);
    const outTag = t => (outside(t) ? ' · 기간 밖' : '');
    // 카드 승인과 짝지은 취소인데 같은 가게 환불 기록이 금액만 달리 따로 있음 (수수료를 뗀 취소를 전액으로 적음) — 안내를 하나로
    const refundConflict = m => !!(m.partialOfRow && m.similarTx && m.similarTx.amount < 0);
    const selectedCount = missing.filter(m => rowState(m).checked).length;
    const selectedTotal = missing.filter(m => rowState(m).checked).reduce((s, m) => s + m.row.amount, 0);
    // 읽은 행이 0건이면 "모두 맞습니다"가 아니다 — 비교할 것이 없었을 뿐
    const noRows = !statement.rows.length;
    // 0건이면 기간 안 가계부 전부가 "카드에 없음"으로 뜨므로 숨긴다
    const notOnCardShown = noRows ? [] : notOnCard;
    const allGood = !noRows && !mismatched.length && !missing.length && !notOnCard.length && !toRemove.length;
    const cautious = missing.filter(m => !m.autoCheck).length;

    body = (
      <div className="cs-pad">
        <div className="cs-summary">
          <div className="cs-summary-title">
            {statement.method} · {md(period.from)} ~ {md(period.to)}
            <span>카드 {statement.rows.length}건</span>
          </div>
          <div className="cs-chips">
            <span className="cs-chip ok">일치 {matchCount}</span>
            {mismatched.length > 0 && <span className="cs-chip warn">금액 차이 {mismatched.length}</span>}
            {missing.length > 0 && <span className="cs-chip add">가계부에 없음 {missing.length}</span>}
            {notOnCardShown.length > 0 && <span className="cs-chip info">카드에 없음 {notOnCardShown.length}</span>}
            {toRemove.length > 0 && <span className="cs-chip warn">취소 확인 {toRemove.length}</span>}
          </div>
        </div>

        {notice && <div className="cs-notice">✓ {notice}</div>}
        {error && <div className="rs-box rs-error"><div className="rs-error-text">{error}</div></div>}
        {statement.modelNote && <div className="rs-model-note">{statement.modelNote}</div>}
        {noRows && (
          <div className="rs-box rs-error">
            <div className="rs-error-text">읽은 카드 내역이 없습니다 — 결제 목록이 보이는 캡처나 명세서로 다시 시도해 주세요.</div>
          </div>
        )}
        {allGood && <div className="cs-allgood">카드 내역과 가계부가 모두 맞습니다 👍</div>}
        {(statement.note || statement.unreadable > 0 || statement.zeroAmount > 0 || statement.discountLines > 0) && (
          <ul className="rs-warnings">
            {statement.unreadable > 0 && <li>날짜를 읽지 못한 {statement.unreadable}건은 비교에서 뺐습니다</li>}
            {statement.discountLines > 0 && (
              <li>청구할인·캐시백·포인트 차감 {statement.discountLines}건은 결제·취소가 아니라서 비교에서 뺐습니다</li>
            )}
            {statement.zeroAmount > 0 && (
              <li>원화 금액을 읽지 못했거나 0원인 {statement.zeroAmount}건은 비교에서 뺐습니다 (해외결제는 원화 금액이 확정된 뒤 다시 대조해 주세요)</li>
            )}
            {statement.note && <li>{statement.note}</li>}
          </ul>
        )}

        <Section
          title="가계부에 없음"
          count={missing.length}
          tone="add"
          hint={`카드로 결제했는데 가계부에 없는 건입니다. 분류를 확인하고 추가하세요.${cautious ? ' 이미 적었을 수도 있는 건은 미리 체크하지 않았어요.' : ''}`}
        >
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
                    {m.row.foreignAmount !== null && <small>{m.row.amount < 0 ? '−' : ''}{fmtForeign(m.row.foreignAmount)} {m.row.currency}</small>}
                  </span>
                </label>
                <div className="cs-row-fields">
                  <CategoryPathSelect
                    db={db}
                    value={st.path}
                    // 주의가 붙은 행은 분류를 바꿔도 저절로 체크하지 않는다
                    onChange={v => setRow(m.row.id, m.autoCheck ? { path: v, checked: true } : { path: v })}
                  />
                  {st.path === categoryText(s) && <SourceBadge source={s.sources.category} />}
                </div>
                {m.cautions.length > 0 && (
                  <ul className="cs-row-cautions">
                    {refundConflict(m) && (
                      <li>
                        같은 가게 환불 기록({m.similarTx.detail || m.similarTx.sub_category} {won(m.similarTx.amount)}, {md(m.similarTx.date)}{outTag(m.similarTx)})이 있어요
                        {' — '}카드 취소액({won(m.row.amount)})과 다르면 그 기록의 금액을 확인하세요.
                      </li>
                    )}
                    {m.cautions.includes('duplicate') && (
                      <li>같은 결제가 두 번 읽혔을 수 있어요 (같은 날·같은 곳·같은 금액이 한 번 더 있어요). 정말 두 번 결제했을 때만 추가하세요.</li>
                    )}
                    {m.cautions.includes('otherMethod') && m.otherTx && (
                      <li>
                        {m.otherTx.payment_method}(으)로 적은 기록이 있어요: {m.otherTx.detail || m.otherTx.sub_category} {won(m.otherTx.amount)} ({md(m.otherTx.date)}{outTag(m.otherTx)}).
                        같은 결제면 추가하지 말고 그 기록의 결제수단을 고치세요.
                      </li>
                    )}
                    {m.cautions.includes('similar') && m.similarTx && !refundConflict(m) && (
                      <li>
                        비슷한 기록이 있어요: {m.similarTx.detail || m.similarTx.sub_category} {won(m.similarTx.amount)} ({md(m.similarTx.date)}{outTag(m.similarTx)}).
                        같은 결제면 추가하지 마세요.
                      </li>
                    )}
                    {m.cautions.includes('period') && (
                      <li>명세서 기간({md(period.from)}~{md(period.to)}) 밖의 결제예요. 할부 원거래이거나 날짜를 잘못 읽었을 수 있어요.</li>
                    )}
                    {m.cautions.includes('installment') && (
                      <li>할부 결제예요. 할부를 달마다 나눠 적고 있다면 추가하지 마세요.</li>
                    )}
                    {m.cautions.includes('noOriginal') && (
                      <li>원래 결제 기록을 찾지 못했어요 — 결제를 지웠거나 적지 않았다면 추가하지 마세요.</li>
                    )}
                    {m.cautions.includes('partialRefund') && m.partialOf && (
                      <li>
                        부분취소일 수 있어요 — 원래 결제({m.partialOf.detail || m.partialOf.sub_category} {won(m.partialOf.amount)}, {md(m.partialOf.date)}{outTag(m.partialOf)})의 금액을 확인하세요.
                      </li>
                    )}
                    {m.cautions.includes('manyOriginals') && (
                      <li>같은 가게·같은 금액 결제가 여러 번 있어요 — 어느 결제의 환불인지, 그 결제 기록이 남아 있는지 확인하고 추가하세요.</li>
                    )}
                    {m.cautions.includes('partialRecorded') && m.partialOfRow && !refundConflict(m) && (
                      <li>
                        카드의 {md(m.partialOfRow.date)} 결제({won(m.partialOfRow.amount)})의 {cutKind(m.partialOfRow, m.row)}예요 — 그 결제를 가계부에 원래 금액으로 적었다면 추가하세요.
                      </li>
                    )}
                    {m.cautions.includes('partialCheck') && m.partialOfRow && !refundConflict(m) && (
                      <li>
                        카드의 {md(m.partialOfRow.date)} 결제({won(m.partialOfRow.amount)})가 가계부와 금액이 달라요 — 결제 기록을 확인한 뒤 추가하세요.
                      </li>
                    )}
                    {m.cautions.includes('partialCancelled') && m.partialCancelRows.length > 0 && (
                      <li>
                        {cutDates(m.partialCancelRows)}에 {cutSum(m.partialCancelRows)}이 취소된 결제예요 — 취소 행과 함께 확인하고 추가하세요.
                      </li>
                    )}
                    {m.cautions.includes('cancelDup') && (
                      <li>같은 금액 취소가 두 줄 있어요 — 두 번 읽힌 것이 아니라면 이 결제가 취소된 것일 수 있으니 확인하고 추가하세요.</li>
                    )}
                  </ul>
                )}
                {m.partialOfRow && !m.cautions.includes('partialCheck') && !m.cautions.includes('partialRecorded') && !refundConflict(m) && (
                  <div className="cs-row-info">
                    카드의 {md(m.partialOfRow.date)} 결제({won(m.partialOfRow.amount)})의 {cutKind(m.partialOfRow, m.row)}예요.
                    {m.autoCheck ? (missing.some(x => x.row === m.partialOfRow) ? ' 결제와 함께 추가하면 합계가 맞습니다.' : ' 추가하면 합계가 맞습니다.') : ''}
                  </div>
                )}
                {m.partialCancelRows.length > 0 && m.autoCheck && (
                  <div className="cs-row-info">
                    {cutDates(m.partialCancelRows)}에 {cutSum(m.partialCancelRows)}이 취소된 결제예요 — 취소 행과 함께 추가하면 합계가 맞습니다.
                  </div>
                )}
                {/* 원래 결제가 여러 번이거나 같은 환불 기록이 이미 있으면(이 결제수단이든 다른 결제수단이든) "추가하면 맞는다"고 하지 않는다 */}
                {m.refundOf && !m.cautions.includes('manyOriginals') && !(m.similarTx && m.similarTx.amount < 0)
                  && !(m.otherTx && m.otherTx.amount < 0) && (
                  <div className="cs-row-info">
                    원래 결제({m.refundOf.detail || m.refundOf.sub_category} {won(m.refundOf.amount)}, {md(m.refundOf.date)}{outTag(m.refundOf)})의 환불이에요.
                    추가하면 합계가 맞습니다.
                  </div>
                )}
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
            const single = m.txs.length === 1;      // 가계부 1건일 때만 고칠 수 있다
            const cardMany = m.rows.length > 1;     // 카드 여러 건을 가계부에 합쳐 적음
            const near = m.namelessNear || [];      // 나눠·합쳐 적은 나머지일 수 있는 근처 기록 — 고치기를 권하지 않는다
            const cautions = m.cautions || (near.length ? ['nameless'] : []);
            // 권하지 않는 이유(cautions)가 있으면 안내와 "그래도 수정" 링크만 — 누를지는 사람이 정한다
            const fixable = m.fixable !== undefined ? m.fixable : single && !cautions.length;
            const fixLabel = cardMany ? '카드 합계로 수정' : '카드 금액으로 수정';
            const cardList = m.rows.map(r => won(r.amount)).join(' + ');
            const ledgerList = m.txs.map(t => won(t.amount)).join(' + ');
            return (
              <div key={row.id} className="cs-row">
                <div className="cs-row-head">
                  <span className="cs-row-main">
                    <b>{m.txs[0].detail || row.merchant}{single ? '' : ` 외 ${m.txs.length - 1}건`}</b>
                    <small>
                      {md(m.txs[0].date)}{outTag(m.txs[0])} · 카드: {row.merchant}{cardMany ? ` 외 ${m.rows.length - 1}건` : ''}
                    </small>
                  </span>
                  <span className="cs-row-amount">
                    <s>{won(m.ledgerTotal)}</s>
                    <b>→ {won(m.cardTotal)}</b>
                  </span>
                </div>
                {single && cardMany && (
                  <div className="cs-group-note">
                    카드 {m.rows.length}건({cardList})을 가계부에는 1건으로 합쳐 적었어요. 고치면 카드 합계로 바뀝니다.
                  </div>
                )}
                {single && near.length > 0 && (
                  <div className="cs-group-note">
                    근처에 짝 없는 기록이 있어요 ({near.map(t => `${t.detail || t.sub_category} ${won(t.amount)}${outTag(t)}`).join(', ')}).
                    한 결제를 나눠 적었거나 여러 결제를 합쳐 적은 것이면 고치면 이중으로 계산돼요. 거래내역에서 확인해 주세요.
                  </div>
                )}
                {single && cautions.includes('installment') && (
                  <div className="cs-group-note">
                    할부 결제예요 ({m.rows.filter(r => r.installment).map(r => r.installment).join(', ')}).
                    할부를 달마다 나눠 적고 있다면 고치지 마세요 — 가계부에는 이번 달 몫만 있는 게 맞아요.
                  </div>
                )}
                {cautions.includes('partialCancel') && m.partialCancelRows && (
                  <div className="cs-group-note">
                    카드에서 {cutDates(m.partialCancelRows)}에 {cutSum(m.partialCancelRows)}이 취소된 결제예요.
                    가계부에 취소 뒤 금액을 적었거나 취소를 따로 적을 거라면 고치지 마세요.
                  </div>
                )}
                {single && cautions.includes('outsideRange') && (
                  <div className="cs-group-note">
                    명세서 기간을 읽지 못해 카드 내역 날짜({md(period.from)}~{md(period.to)}) 밖의 기록과 비교했어요.
                    캡처에 없는 다른 결제의 기록일 수 있어요.
                  </div>
                )}
                {fixable && (
                  <div className="rs-actions">
                    <button type="button" className="rs-btn-secondary" onClick={() => fixAmount(m)}>{fixLabel}</button>
                  </div>
                )}
                {single && !fixable && (
                  <div className="rs-actions">
                    <button type="button" className="rs-btn-link" onClick={() => fixAmount(m)}>그래도 {fixLabel}</button>
                  </div>
                )}
                {!single && (
                  <div className="cs-group-note">
                    {cardMany
                      ? `카드 ${m.rows.length}건(${cardList})과 가계부 ${m.txs.length}건(${ledgerList})의 합이 다릅니다.`
                      : `가계부에 ${m.txs.length}건으로 나눠 적혀 있어요 (${ledgerList}). 합이 카드와 다릅니다.`}
                    {' '}거래내역에서 직접 확인해 주세요.
                  </div>
                )}
              </div>
            );
          })}
        </Section>

        <Section title="취소된 결제" count={toRemove.length} tone="warn" hint="카드에서는 결제 후 취소됐는데 가계부에는 결제만 남아 있습니다.">
          {toRemove.map(c => {
            const tx = c.tx || c.maybeTx;
            const group = confirmDelete === c.cancel.id ? splitGroupOf(tx) : [];
            return (
              <div key={c.cancel.id} className="cs-row">
                <div className="cs-row-head">
                  <span className="cs-row-main">
                    <b>{tx.detail || c.approval.merchant}</b>
                    <small>
                      {md(c.approval.date)} 결제 → {md(c.cancel.date)} 취소 · 가계부 {md(tx.date)}
                      {c.outsidePeriod ? ' (명세서 기간 밖 기록)' : ''}
                    </small>
                  </span>
                  <span className="cs-row-amount">{won(c.approval.amount)}</span>
                </div>
                {!c.tx && !c.doubtTx && (
                  <div className="cs-group-note">
                    이 기록이 취소된 결제인지 확실하지 않아요 — 같은 결제가 두 번 읽혔거나, 같은 금액 결제가 더 있거나,
                    지난 기간 결제의 환불일 수 있어요. 취소된 결제가 맞을 때만 지우세요.
                  </div>
                )}
                {!c.tx && c.doubtTx && (
                  <div className="cs-group-note">
                    {md(c.doubtTx.date)}에 같은 금액 환불 기록({c.doubtTx.detail || c.doubtTx.sub_category} {won(c.doubtTx.amount)})이 있어요.
                    그 기록이 이 취소의 것이면 지우지 마세요.
                  </div>
                )}
                {group.length > 1 && (
                  <div className="cs-group-note">
                    나눠 결제한 묶음의 한 몫이에요 ({group.map(t => `${t.payment_method} ${won(t.amount)}`).join(' + ')}).
                    결제가 취소되면 나머지 몫도 돌려받으므로 묶인 {group.length}건을 모두 지웁니다.
                  </div>
                )}
                <div className="rs-actions">
                  {confirmDelete === c.cancel.id ? (
                    <>
                      <button type="button" className="rs-btn-secondary" onClick={() => keepCancelled(c)}>그대로 두기</button>
                      <button type="button" className="cs-btn-danger" onClick={() => removeCancelled(c)}>
                        {group.length > 1 ? `묶인 ${group.length}건 모두 삭제` : '가계부에서 삭제'}
                      </button>
                    </>
                  ) : (
                    <>
                      {!c.tx && <button type="button" className="rs-btn-secondary" onClick={() => keepCancelled(c)}>그대로 두기</button>}
                      <button type="button" className="rs-btn-secondary" onClick={() => setConfirmDelete(c.cancel.id)}>
                        {c.tx ? '가계부에서 삭제…' : '확인 후 삭제…'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </Section>

        <Section
          title="카드에 없음"
          count={notOnCardShown.length}
          tone="info"
          defaultOpen={false}
          hint={`가계부에는 ${statement.method}(으)로 적었는데 카드 내역에 없습니다. 다른 결제수단이었거나, 아직 승인 전이거나, 캡처에서 빠졌을 수 있어요.`}
        >
          {notOnCardShown.map(t => (
            <div key={t.id} className="cs-row cs-row-plain">
              <span className="cs-row-main">
                <b>{t.detail || t.sub_category}</b>
                <small>{md(t.date)}{outTag(t)} · {t.budget_category}{t.sub_category ? ` > ${t.sub_category}` : ''}</small>
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
          hint={`금액이 같고 날짜가 ±${TOLERANCE_DAYS}일 안인 건입니다. 같은 가게에서 나눠 적거나 합쳐 적은 것도 합계가 같으면 일치로 봅니다. "이름 다름"은 가게 이름 없이 적은 기록과 금액·날짜로 짝지은 것이에요.`}
        >
          {grouped.map(g => {
            const ledgerPart = `가계부 ${g.txs.length}건 (${g.txs.map(t => won(t.amount)).join(' + ')})`;
            const cardPart = `카드 ${g.rows.length}건 (${g.rows.map(r => won(r.amount)).join(' + ')})`;
            const paid = g.rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
            const refunded = -g.rows.filter(r => r.amount < 0).reduce((s, r) => s + r.amount, 0);
            const cancelPart = `카드 ${won(paid)} − 취소 ${won(refunded)} = 가계부 ${won(paid - refunded)}`;
            return (
              <div key={`g-${g.rows[0].id}`} className="cs-row cs-row-plain">
                <span className="cs-row-main">
                  <b>
                    {g.txs[0].detail || g.rows[0].merchant}
                    <span className="cs-group-tag">{GROUP_TAG[g.kind]}</span>
                  </b>
                  <small className="cs-wrap">
                    {g.kind === 'partialCancel' ? cancelPart
                      : g.kind === 'split' ? ledgerPart : g.kind === 'merged' ? cardPart : `${cardPart} = ${ledgerPart}`}
                    {' · '}{md(g.rows[0].date)}{g.txs.some(outside) ? ' · 기간 밖 기록 포함' : ''}
                  </small>
                </span>
                <span className="cs-row-amount">{won(g.rows.reduce((s, r) => s + r.amount, 0))}</span>
              </div>
            );
          })}
          {matched.map(m => (
            <div key={m.row.id} className="cs-row cs-row-plain">
              <span className="cs-row-main">
                <b>
                  {m.tx.detail || m.row.merchant}
                  {m.nameDiffers && <span className="cs-group-tag cs-tag-differs">이름 다름</span>}
                </b>
                <small>
                  {md(m.tx.date)}{outTag(m.tx)}{m.dayDiff ? ` (카드 ${md(m.row.date)})` : ''} · 카드: {m.row.merchant}
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
          {canShowPrevious && (
            <button type="button" className="rs-btn-secondary" onClick={() => { setError(''); setStep('result'); }}>이전 결과 보기</button>
          )}
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
          <button type="button" className="rs-btn-secondary" onClick={() => { setStep('pick'); setNotice(''); setError(''); }}>다른 내역 대조</button>
          <button type="button" className="rs-btn-primary" onClick={onClose}>닫기</button>
        </div>
      )}
    </ModalOverlay>
  );
}
