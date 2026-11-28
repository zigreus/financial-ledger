import React, { useState, useRef, useEffect } from 'react';
import { activeAI, PROVIDERS } from '../../services/aiClient';
import {
  suggestionToTransaction, isSuggestionComplete, alternativePatch, applyAlternative, normalizeName,
} from '../../services/receiptAssistant';
import {
  analyzePhotos, markDuplicates, cleanPhotoNotes, suggestFixNear, nearFix, NEAR_CAUTION, NEAR_BLOCKED,
} from '../../services/photoEntry';
import { familiarity, splitFamiliar, isCategoryReason, BLANK_REASON, QUICK_REASONS } from '../../services/quickEntry';
import { preparePhotos } from '../../services/imageUtils';
import { getMemberNames, getPaymentMethods } from '../../services/dbManager';
import SuggestionDetails, { amountText } from './SuggestionCard';
import SuggestionItem, { patchListItem } from './SuggestionItem';
import QuickAutoNote from './QuickAutoNote';
import SingleActions from './SingleActions';
import { FollowUpBox, SaidSoFar, SETTINGS_KINDS } from './TextFollowUp';
import { useQuickBatches } from './useQuickBatches';
import { isValidDateStr } from '../../services/dateUtils';
import { formatAmount } from '../../services/formulaEvaluator';
import './AIEntry.css';

const CONFIDENCE_LABEL = { high: '잘 읽힘', medium: '대체로 읽힘', low: '확실하지 않음 — 확인 필요' }; // low: 흐림·잘림, 화면에 없는 날짜를 짐작함 등
const DEVICE_MEMBER = '\u0000device'; // '누가' 고르기의 기본값 — 정하지 않음(App이 이 기기 사용자로)

// 사진 설명 덧붙이기 (I-063)
const NOTE_OPEN = '+ 설명 덧붙여 다시 읽기';
const NOTE_HEADING = '사진에 없는 것을 알려 주세요';
const NOTE_EXAMPLE = '예) 반반 나눠 냈어요 / 세제는 생활용품으로 따로 / 남편 카드 내역이에요';
const NOTE_HINT = '사진을 이 설명과 함께 처음부터 다시 읽어요. 직접 고친 값은 새로 읽은 값으로 바뀌어요.';
const NOTE_PENDING = "덧붙여 쓴 설명이 있어요 — '다시 읽기'를 누르거나 지우면 진행할 수 있어요.";
// 설명과 함께 다시 읽은 줄이 앞서 바로 넣은(또는 되돌린) 결제와 같은 곳·같은 날일 때 — 설명대로 금액이 바뀌었을 수 있다
const SIMILAR_REASON = '앞에서 바로 넣은 결제와 같은 곳·같은 날이에요 — 설명대로 바뀐 거라면 바로 넣은 것을 되돌린 뒤 고르세요';
const FIXED_REASON = '되돌린 결제를 설명대로 다시 읽은 것 같아요 — 맞으면 고르세요';
// 이 이유가 붙은 줄은 저절로 체크하지 않는다 (되돌린 거래·바로 넣은 결제와 겹칠 수 있는 줄)
const HELD_REASONS = new Set([QUICK_REASONS.undone, SIMILAR_REASON, FIXED_REASON]);
const held = it => HELD_REASONS.has(it.reason);

const placeNames = s => [s.merchant, s.detail].map(normalizeName).filter(Boolean);
/** 같은 날 같은 가게(가게 이름·세부내역 중 하나가 같음)인지 — 금액은 보지 않는다 */
const samePlace = (a, b) => a.date === b.date && placeNames(a).some(n => placeNames(b).includes(n));

/**
 * 설명과 함께 다시 읽은 결과를 이 화면에서 앞서 바로 넣은 묶음과 맞춘다 → Map(새 추천 → 이유)
 *  - 바로 넣은 그대로 다시 읽혔으면 '이미 넣은 거래'(duplicateOf)로 잡혀 있다 — 그대로 둔다
 *  - 아니면 같은 곳·같은 날인 줄을 모두 체크 없이 — 설명대로 금액이 바뀌거나(반반) 나뉘었을(품목대로) 수 있어
 *    어느 줄이 그 결제인지 알 수 없다. 하나만 잡으면 나머지가 바로 넣은 것과 함께 들어간다
 *  - 되돌린 묶음의 결제는 하나씩 짝지어 체크 없이 '되돌린 거래'(금액이 바뀌었으면 '설명대로 다시 읽은 것')
 */
function batchReasons(suggestions, batches) {
  const out = new Map();
  batches.forEach((b) => {
    const undone = b.removed !== null && b.removed === b.suggestions.length;
    b.suggestions.forEach((old) => {
      const same = s => samePlace(s, old) && s.amount === old.amount;
      if (!undone) {
        if (suggestions.some(s => s.duplicateOf && same(s))) return;
        suggestions.forEach((s) => { if (!s.duplicateOf && samePlace(s, old)) out.set(s, SIMILAR_REASON); });
        return;
      }
      const hit = suggestions.find(s => !s.duplicateOf && !out.has(s) && same(s))
        || suggestions.find(s => !s.duplicateOf && !out.has(s) && samePlace(s, old));
      if (hit) out.set(hit, same(hit) ? QUICK_REASONS.undone : FIXED_REASON);
    });
  });
  return out;
}

/** 넘겨받은 설명 — 글만, 보낼 때와 같은 규칙으로 정리 */
const notesFrom = list => cleanPhotoNotes(Array.isArray(list) ? list.filter(n => typeof n === 'string') : []);

/**
 * 직접 고쳐야 할 줄의 이유 — s.needsFix([{ text, fields }], photoEntry) 중 아직 고치지 않은 것.
 * 그 점의 칸(fields — 간편결제면 세부내역·카테고리, 날짜를 못 읽었으면 날짜)을 고치면 풀리고, 읽은 값으로 되돌리면 다시 보인다.
 * 이미 있거나 겹친 결제는 넣을 줄이 아니라 고칠 것도 없다
 */
const needsFixOf = (it) => {
  if (flagReason(it.s)) return '';
  const changed = k => (it.s[k] ?? '') !== (it.original[k] ?? '');
  return (it.s.needsFix || []).filter(f => !f.fields.some(changed)).map(f => f.text).join(' · ');
};

/** 넣을 수 있는 줄 — 빈 칸 없이, 올바른 날짜와 0보다 큰 금액 */
const addable = s => isSuggestionComplete(s) && isValidDateStr(s.date) && Number(s.amount) > 0;

/**
 * 여러 건 목록에서 미리 체크할 것 — 넣을 수 있고, 이미 있거나 겹치거나 취소된 결제가 아닌 것(사용자 요청: 중복이 아니면 기본 선택).
 * 날짜를 못 읽었거나 잘 안 읽힌 결제도 체크해 두고, 그 사실은 줄의 날짜·경고·AI 메모로 알린다
 */
const preChecked = s => addable(s) && !flagReason(s);

const won = n => `${formatAmount(n)}원`;
const txText = t => `${t.detail || '내용 없음'} ${won(t.amount)}`;

/** 가계부에 금액·날짜를 다르게 적은 같은 결제가 있는 줄 — '수정 권장' (I-065) */
const isNearRow = s => !!s.nearOf && (s.nearOf.kind === 'amount' || s.nearOf.kind === 'date');

/** 겹친 결제의 이유 — 목록을 고칠 때마다 다시 따진다(markDuplicates) */
function flagReason(s) {
  if (s.pairedCancel) return '같은 사진에 이 결제의 취소가 있어요 — 넣을 때만 고르세요';
  if (s.duplicateOf) {
    const d = s.duplicateOf;
    return `이미 넣은 거래가 있어요(${d.detail || '내용 없음'} ${formatAmount(d.amount)}원 · ${d.payment_method}) — 또 넣을 때만 고르세요`;
  }
  if (s.batchDuplicate) return '앞 줄과 같은 결제예요 — 따로 결제한 것일 때만 고르세요';
  if (s.nearOf) {
    const { kind, txs } = s.nearOf;
    if (kind === 'split') return `나눠 적은 거래 ${txs.length}건이 이미 있어요(${txs.map(txText).join(' + ')}) — 또 넣을 때만 고르세요`;
    if (kind === 'merged') return `가계부에 이 결제까지 합쳐 적은 거래가 있어요(${txText(txs[0])}) — 또 넣을 때만 고르세요`;
    return `가계부에 ${kind === 'date' ? '날짜만' : '금액이'} 다르게 적힌 같은 결제가 있어요 — 따로 결제한 것일 때만 고르세요`;
  }
  return '';
}

/** 어떤 겹침인지 — 같은 겹침에 대해 사용자가 정한 체크(넣기·고치기)는 지킨다 */
const flagKey = s => (s.pairedCancel ? 'cancel' : s.duplicateOf ? `tx${s.duplicateOf.id}` : s.batchDuplicate ? 'batch'
  : s.nearOf ? `near:${s.nearOf.kind}:${s.nearOf.txs.map(t => t.id).join(',')}` : '');

/**
 * 목록 한 줄 — checked는 사용자의 뜻(넣을 수 없는 동안에는 빠진다), decided는 그 체크를 정할 때의 겹침,
 * fix는 가계부 기록을 사진대로 고칠지('수정 권장', I-065 — 넣기와 함께 고르지 않는다),
 * ever는 넣을 수 있던 적이 있는지, original·originalReason은 되돌리기용 처음 읽은 값, rev는 되돌린 횟수
 */
const listItem = (s, checked, reason = '', fix = false) => ({
  s, checked, fix, fixDecided: flagKey(s), reason, decided: flagKey(s), ever: addable(s), original: s, originalReason: reason, rev: 0,
});

/**
 * 줄에 보일 이유 — 겹침이 먼저. 다만 체크 없이 둔 이유(바로 넣은 결제와 같은 곳 등)가 있는 '수정 권장' 줄은 그 이유를 —
 * 고칠 기록이 이 화면에서 바로 넣은 결제일 수 있다 (고치기 칸은 따로 보인다)
 */
const rowReason = it => ((isNearRow(it.s) && held(it)) ? it.reason : (flagReason(it.s) || it.reason));

/** 실제로 넣을 줄 */
const isSelected = it => it.checked && addable(it.s);
/** 기록을 고칠 값이 갖춰졌는지 — 올바른 날짜와 0보다 큰 금액 (고치기는 분류·결제수단이 없어도 된다 — 기록의 것을 쓴다) */
const fixReady = s => isValidDateStr(s.date) && Number(s.amount) > 0;
/** 실제로 가계부 기록을 고칠 줄 — 고칠 값이 갖춰졌고 고칠 것이 있을 때만 */
const isFixing = it => it.fix && fixReady(it.s) && !!nearFix(it.s);
/** 고치기를 미리 골라 둘지 — 권할 만하고, 체크 없이 둔 이유(되돌린 거래·바로 넣은 결제와 같은 곳)가 없을 때 */
const fixByDefault = (s, it) => suggestFixNear(s) && !held(it);

/**
 * 고치기 체크를 겹침에 맞춘다 — 넣기 체크와 따로(fixDecided), 고칠 값이 갖춰졌을 때만.
 *  - 고칠 기록이 그대로면 사용자의 뜻대로
 *  - 새로 고칠 기록이 생겼으면 권할 만할 때만 미리 고른다
 *  - 고칠 기록이 다른 기록으로 바뀌었으면 고르지 않는다 — 사용자가 앞의 기록에 대해 정한 것이 엉뚱한 기록에 옮지 않게
 * confirming: 넣기 직전 — 끄기만 한다
 */
function fixFor(it, s, confirming) {
  if (!fixReady(s)) return { fix: it.fix, fixDecided: it.fixDecided };   // 입력 중 — 그대로
  const key = flagKey(s);
  if (key === it.fixDecided) return { fix: it.fix, fixDecided: key };
  const wasNear = String(it.fixDecided || '').startsWith('near:');
  return { fix: !confirming && !wasNear && fixByDefault(s, it), fixDecided: key };
}

/**
 * 목록을 고친 뒤(또는 넣기 직전에) 겹친 결제를 다시 따지고 체크를 맞춘다. 체크는 겹침이 달라질 때만 건드린다.
 *  - 입력 중이라 넣을 수 없는 줄(빈 금액·"1000+")은 그대로 둔다 — 넣을 때만 빠지고, 다 고치면 사용자의 체크가 살아 있다
 *  - 처음으로 넣을 수 있게 된 줄(결제수단을 고름 등)은 미리 체크할 만한지 본다
 *  - 새로 겹치면(이미 있는 거래·앞 줄과 같아짐) 끈다
 *  - 겹침이 풀리면 고친 그 줄(edited)만 미리 체크할 만한지 다시 본다. 다른 줄은 저절로 켜지 않는다
 *    (한 줄을 고쳐 겹친 짝이 풀려도 그 짝이 켜져 같은 결제가 두 번 들어가지 않게)
 *  - 고치기('수정 권장')도 같다 — 고칠 기록이 그대로면 사용자의 뜻대로, 새로 생기면 권할 만할 때만 미리 고르고, 없어지면 끈다
 * confirming: 넣기 직전 — 끄기만 한다. claimed: 이 화면에서 바로 넣은 추천 — 그 거래는 목록과 짝짓지 않는다
 */
function refresh(db, list, { edited = -1, confirming = false, claimed = [] } = {}) {
  const marked = markDuplicates(db, list.map(it => it.s), { claimed });
  return list.map((it, i) => {
    const s = marked[i];
    const fix = fixFor(it, s, confirming);
    if (!addable(s)) return { ...it, s, ...fix };
    const key = flagKey(s);
    if (!it.ever) {
      const checked = !confirming && preChecked(s) && !held(it);
      return { ...it, s, ...fix, ever: true, decided: key, checked };
    }
    if (key === it.decided) return { ...it, s, ...fix };
    // 넣기와 고치기는 함께 고르지 않는다 — 고치기를 골라 둔 줄은 저절로 넣기를 켜지 않는다
    if (key) return { ...it, s, ...fix, decided: key, checked: false };
    const recheck = !confirming && i === edited && preChecked(s) && !held(it) && !fix.fix;
    return { ...it, s, ...fix, decided: '', checked: (recheck || it.checked) && !fix.fix };
  });
}

/**
 * '수정 권장' 칸 — 가계부에 적힌 같은 결제와 무엇이 다른지, 사진대로 고칠지 (I-065).
 * onToggle이 있으면(목록) 고치기 체크, onFix가 있으면(한 건 화면) 바로 고치는 버튼. 고칠 수 없으면 이유만 보인다
 */
function NearFix({ s, fix = false, disabled = false, onToggle, onFix }) {
  const { kind, txs: [tx], blocked, cautions } = s.nearOf;
  const changes = [];
  if (kind === 'amount') changes.push(`금액 ${won(tx.amount)} → ${s.amount === null || s.amount === undefined ? '?' : won(s.amount)}`);
  if (tx.date !== s.date) changes.push(`날짜 ${tx.date} → ${s.date || '?'}`);
  const label = `가계부 기록을 사진대로 고치기 — ${changes.join(', ')}`;
  return (
    <div className="rs-near">
      <div className="rs-near-tx">가계부: {tx.date} · {txText(tx)} · {tx.payment_method}</div>
      {blocked && <div className="rs-near-note">{NEAR_BLOCKED[blocked]}</div>}
      {!blocked && onToggle && (
        <label className="rs-near-fix">
          <input type="checkbox" checked={fix} disabled={disabled} onChange={e => onToggle(e.target.checked)} />
          <span>{label}</span>
        </label>
      )}
      {!blocked && onFix && <div className="rs-near-change">{changes.join(', ')}</div>}
      {!blocked && cautions.map(c => <div key={c} className="rs-near-note">{NEAR_CAUTION[c]}</div>)}
      {!blocked && onFix && (
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" disabled={disabled} onClick={onFix}>가계부 기록 고치기</button>
        </div>
      )}
    </div>
  );
}

function Thumbs({ previews, count }) {
  if (!previews.length) return null;
  const shown = previews.slice(0, 3);
  const more = count - shown.length;
  return (
    <span className="rs-thumbs">
      {shown.map((src, i) => <img key={i} className="rs-thumb" src={src} alt={`사진 ${i + 1}`} />)}
      {more > 0 && <span className="rs-thumb-more">+{more}</span>}
    </span>
  );
}

/**
 * 사진(영수증 여러 장·결제 내역 캡처) → AI 분석 → 확인 → 입력.
 * 사진 선택창은 부모(AIEntry)가 연다 — 모바일 브라우저는 사용자가 누른 순간에만 열어 주기 때문.
 * files가 바뀔 때마다 새로 분석한다.
 *  - 결제가 한 건이면 "이렇게 입력하시겠습니까?" → 바로 넣기('이대로 넣기' — onBulkAdd, 결제수단·카테고리는 그 자리에서 고른다, I-066)
 *    또는 폼 채우기('이대로 채우기' — onApply). 이미 넣은 거래와 겹칠 수 있으면 '그래도 넣기'로.
 *    onAutoAdd가 있으면(AI 입력, I-022) 자주 넣던 가게의 분명한 영수증은 확인 없이 바로 넣는다.
 *  - 여러 건이면(영수증 여러 장, 카드 앱의 이용내역 캡처) 자주 넣던 건은 바로 넣고, 나머지는 목록에서 골라
 *    한 번에 추가한다(onBulkAdd). 이미 가계부에 있는 결제·겹쳐 찍은 결제·취소된 결제는 체크 없이 보인다.
 *    가족 카드 내역처럼 한 사람 것이면 결제수단·'누가'를 한 번에 정할 수 있다.
 *  - 설명 덧붙이기 (I-063): 결과·오류 화면에서 사진에 없는 것(나눠 냄·누구 것·일부만)을 적으면 사진을 그 설명과 함께
 *    처음부터 다시 읽는다. initialNotes는 사진과 함께 온 설명(AI 입력 상자에 먼저 쓴 글·공유받은 글, 다시 고른 사진이면 앞 사진의 설명)이다.
 *    설명이 있으면 바로 넣지 않고 모두 확인받는다 — 설명은 금액·건수를 바꿀 수 있는데 바로 넣기는 그것을 따지지 않는다.
 *    다시 읽는 동안 앞 결과는 남겨 두어, 취소하거나 실패하면 그 화면으로 돌아간다.
 *    notesRef: 이 사진의 설명(덧붙이던 것까지)을 부모에 알린다 — 다시 찍기·다른 사진·붙여넣기로 바꾼 사진도 같은 설명으로 읽게
 */
export default function ReceiptPanel({
  db, files, initialNotes = [], notesRef, onApply, onAutoAdd, onBulkAdd, onRepick, onClose, onSetup,
}) {
  const [phase, setPhase] = useState('analyzing'); // analyzing | review | list | error
  const [prepared, setPrepared] = useState(null);  // { parts, previews }
  const [suggestion, setSuggestion] = useState(null);
  const [items, setItems] = useState([]);          // 여러 건: listItem들
  const [listNote, setListNote] = useState('');    // 넣으려다 멈춘 이유 (그사이 같은 거래가 들어옴)
  const [cancels, setCancels] = useState([]);
  const [note, setNote] = useState('');
  const [member, setMember] = useState(DEVICE_MEMBER);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(''); // 서버가 붐빌 때 "다시 시도하는 중" 등
  const [modelNote, setModelNote] = useState(''); // 고른 모델이 붐벼 다른 모델이 대신 읽었을 때
  const [reviewReason, setReviewReason] = useState(''); // 바로 넣지 않고 확인받는 이유
  const [notes, setNotes] = useState(() => notesFrom(initialNotes)); // 이 사진에 덧붙인 설명 — 지금 결과를 읽을 때 함께 보낸 것 (I-063)
  const [addition, setAddition] = useState('');     // 덧붙이는 중인 설명
  const [boxOpen, setBoxOpen] = useState(false);    // 설명 상자를 열었는지
  const [followError, setFollowError] = useState(null); // 설명과 함께 다시 읽기가 실패했을 때 { message, settings }
  const abortRef = useRef(null);
  const backRef = useRef(null); // 설명과 함께 다시 읽는 중이면 취소·실패 때 돌아갈 화면(review | list | error)
  const sendingRef = useRef([]); // 지금 읽는 중인 요청에 함께 보낸 설명 — 읽는 중 문구가 쓴다
  const autoAddRef = useRef(onAutoAdd);
  autoAddRef.current = onAutoAdd;
  const dbRef = useRef(db);
  dbRef.current = db;
  // 여러 건 중 바로 넣은 것 — 되돌리면 목록에 체크 없이 다시 올려 고쳐 넣게 한다
  const batchesRef = useRef([]);
  // 설명과 함께 다시 읽기 전에 바로 넣은 묶음 — 다시 읽은 목록에는 그 결제가 '이미 넣은 거래'로 들어 있다
  const supersededRef = useRef(new Set());
  /** 이 화면에서 바로 넣고 아직 되돌리지 않은 추천 — 그 거래를 목록의 '이미 있는 거래'로 보지 않는다 (다시 읽기 전의 것은 빼고) */
  const claimedNow = (exceptId) => batchesRef.current
    .filter(b => b.removed === null && b.id !== exceptId && !supersededRef.current.has(b.id)).flatMap(b => b.suggestions);
  const { batches, add: addBatch, undoAll, reset: resetBatches } = useQuickBatches(({ id, suggestions, removed }) => {
    if (removed !== suggestions.length) return;
    if (supersededRef.current.has(id)) {
      // 다시 읽은 목록에 이 결제들이 이미 있다 — 줄을 더하지 않고 겹침만 다시 따진다.
      // 되돌려 '이미 넣은 거래'가 풀린 줄은 체크 없이 '되돌린 거래'로
      // 같은 곳·같은 날이라 체크 없이 둔 줄('바로 넣은 결제와 같은 곳')은 '설명대로 다시 읽은 것'으로
      const mine = s => suggestions.some(old => samePlace(s, old));
      setItems(list => refresh(dbRef.current, list, { claimed: claimedNow(id) }).map((it, i) => {
        if (list[i].s.duplicateOf && !it.s.duplicateOf && mine(it.s)) {
          return { ...it, checked: false, fix: false, decided: '', fixDecided: '', reason: QUICK_REASONS.undone, originalReason: QUICK_REASONS.undone };
        }
        if (it.reason === SIMILAR_REASON && mine(it.s)) return { ...it, checked: false, reason: FIXED_REASON, originalReason: FIXED_REASON };
        return it;
      }));
      // 한 건 화면이면 그 결제의 겹침·이유도 다시 — 되돌린 뒤에도 '이미 넣은 거래'로 남지 않게
      if (suggestion && mine(suggestion)) {
        const [again] = markDuplicates(dbRef.current, [suggestion]);
        setSuggestion(again);
        if (reviewReason === SIMILAR_REASON) setReviewReason(FIXED_REASON);
        else if (suggestion.duplicateOf && !again.duplicateOf) setReviewReason(QUICK_REASONS.undone);
      }
      return;
    }
    // 되돌려 가계부에서 빠졌다 — 체크 없이 목록에 다시 올리고 겹친 결제를 다시 따진다
    setItems(list => refresh(dbRef.current,
      [...list, ...suggestions.map(s => ({ ...listItem(s, false, QUICK_REASONS.undone), ever: true }))],
      { claimed: claimedNow(id) }));
  });
  batchesRef.current = batches;

  const clearResult = () => {
    setSuggestion(null);
    setItems([]);
    setListNote('');
    setCancels([]);
    setNote('');
    setReviewReason('');
    setError('');
    setProgress('');
    setModelNote('');
    setFollowError(null);
  };

  // 취소(닫기·연속 입력으로 다음 거래·다른 사진)는 언제 하든 같은 컨트롤러를 abort한다.
  // 이미지 준비 단계부터 컨트롤러를 만들어 두어야 그 사이의 취소도 API 호출 전에 막힌다.
  // sent: 함께 보낼 설명(I-063). back: 설명을 덧붙여 다시 읽을 때 시작한 화면 — 앞 결과를 남겨 두고, 취소·실패하면 그리로 돌아간다
  const run = async (photos, controller = new AbortController(), { notes: sent = [], back = null } = {}) => {
    const ai = activeAI();
    if (!ai) {
      // 설정 화면에 다녀오는 동안 이 화면은 남는다(AIEntry) — 읽는 중으로 멈춰 있지 않게
      if (!back) {
        setError('AI 설정이 필요합니다 — 설정을 마친 뒤 다시 시도해 주세요');
        setPhase('error');
      }
      onSetup();
      return;
    }
    if (abortRef.current && abortRef.current !== controller) abortRef.current.abort();
    abortRef.current = controller;
    if (controller.signal.aborted) return;
    backRef.current = back;
    sendingRef.current = sent;
    if (back) {
      setProgress('');
      setFollowError(null);
    } else {
      clearResult();
    }
    setPhase('analyzing');
    /** 읽지 못했다 — 다시 읽기였으면 앞 화면(결과·덧붙이던 설명)으로 돌아가 설명 상자에 이유를 보인다 */
    const fail = (message, kind) => {
      if (back) {
        setFollowError({ message, settings: SETTINGS_KINDS.has(kind) });
        setPhase(back);
      } else {
        setError(message);
        setPhase('error');
      }
    };
    let usedNote = ''; // 고른 모델이 붐벼 다른 모델이 대신 읽었으면 — 새 결과와 함께 보인다
    try {
      const { suggestions, cancels: cancelList, note: aiNote } = await analyzePhotos({
        db: dbRef.current, ai, parts: photos.parts, photos: photos.previews.length, notes: sent, signal: controller.signal,
        onProgress: (msg, info) => {
          if (controller.signal.aborted) return;
          if (info?.modelUsed) {
            usedNote = info.modelUsed !== ai.model ? `${ai.model}이(가) 붐벼서 ${info.modelUsed}(으)로 읽었습니다` : '';
          } else {
            setProgress(msg);
          }
        },
      });
      if (controller.signal.aborted) return;
      const cur = dbRef.current;
      if (!suggestions.length && !cancelList.length) {
        let message = '사진에서 결제를 찾지 못했습니다 — 금액이 잘 보이게 다시 찍어 주세요';
        if (back && sent.length) message = '설명과 함께 읽어도 결제를 찾지 못했어요 — 설명을 고쳐 보거나 다른 사진을 골라 주세요';
        else if (back) message = '설명 없이 읽어도 결제를 찾지 못했어요 — 설명을 덧붙이거나 다른 사진을 골라 주세요';
        fail(message);
        return;
      }
      // 새 결과로 바꾼다 — 다시 읽기였으면 앞서 바로 넣은 묶음은 이제 새 목록의 '이미 넣은 거래'로 보인다
      clearResult();
      setModelNote(usedNote);
      setNotes(sent);
      setAddition('');
      setBoxOpen(false);
      // 앞서 바로 넣은(또는 되돌린) 결제와 같은 곳·같은 날인 줄 — 체크 없이 이유를 붙인다
      const marks = back ? batchReasons(suggestions, batchesRef.current) : new Map();
      if (back) batchesRef.current.forEach(b => supersededRef.current.add(b.id));
      // 설명을 덧붙였으면 바로 넣지 않는다 — 설명은 금액·건수를 바꿀 수 있는데(반반, 일부만) 바로 넣기는 그것을 따지지 않는다.
      // 다시 읽은 결과도(설명을 뺐어도) 바로 넣지 않는다 — 앞 결과를 보고 있던 사용자가 확인한다
      const autoAdd = sent.length || back ? null : autoAddRef.current;

      // 한 건 — 영수증 한 장
      if (suggestions.length === 1 && !cancelList.length) {
        const s = suggestions[0];
        if (autoAdd) {
          const f = familiarity(cur, s, 'receipt');
          if (f.familiar) {
            autoAdd([suggestionToTransaction(cur, s)], { remaining: 0 });
            return; // 바로 넣었다 — 입력 창이 닫힌다
          }
          // 겹친 결제면 그 자세한 이유를 — 고쳐서 겹침이 풀리면 지울 수 있게(patchSingle), 바로 넣지 않은 다른 이유는 그대로
          setReviewReason(flagReason(s) || f.reason);
        } else {
          // 바로 넣기를 따지지 않아도 이미 넣은 거래·앞서 바로 넣은 결제와 겹치는 것은 알린다
          setReviewReason(marks.get(s) || (s.duplicateOf || s.nearOf ? flagReason(s) : ''));
        }
        setSuggestion(s);
        setPhase('review');
        return;
      }

      // 여러 건 — 자주 넣던 것은 바로, 나머지는 목록에서 고른다
      // 겹친 결제, AI가 확실하지 않다고 메모를 남긴 결제, 직접 고쳐야 할 결제는 바로 넣지 않는다
      const flagged = suggestions.filter(s => flagReason(s) || s.aiNote || (s.needsFix && s.needsFix.length));
      const candidates = suggestions.filter(s => !flagged.includes(s));
      const reasons = new Map();
      let familiar = [];
      // 바로 넣지 않고 모두 확인받는 때: AI가 알릴 점(흐림·잘림·짐작)을 남겼거나, '누가'를 적는 가계부라 한 번에 정해야 할 때
      // (가족 카드 내역 — 바로 넣으면 이 기기 사용자로 들어가 '누가'가 갈린다)
      const holdAll = !!aiNote || getMemberNames(cur).length > 0;
      if (autoAdd && !holdAll) {
        const split = splitFamiliar(cur, candidates, 'receipt');
        familiar = split.familiar;
        // 이미 있는 거래는 목록이 한 거래에 한 줄씩 따로 따진다(markDuplicates) — 여기서는 그 밖의 이유만
        split.review.forEach(r => { if (!/^같은 날 같은 금액 거래가 이미 있어요/.test(r.reason)) reasons.set(r.s, r.reason); });
      }
      const rest = suggestions.filter(s => !familiar.includes(s));
      const remaining = rest.length + cancelList.filter(c => !c.paired).length;
      if (familiar.length) {
        const handle = autoAdd(familiar.map(s => suggestionToTransaction(cur, s)), { remaining });
        if (!remaining) return; // 모두 넣었다 — 입력 창이 닫힌다
        addBatch(familiar, handle);
      }
      setItems(rest.map(s => listItem(s, preChecked(s) && !marks.has(s), marks.get(s) || reasons.get(s) || '',
        suggestFixNear(s) && !marks.has(s))));
      setCancels(cancelList);
      setNote(aiNote);
      setPhase('list');
    } catch (e) {
      // 취소된 요청은 어떤 오류로 끝나든 화면을 바꾸지 않는다 (취소한 쪽이 이미 화면을 정했다)
      if (controller.signal.aborted) return;
      if (e.name === 'AbortError') {
        if (back) setPhase(back);
        return;
      }
      fail(e.message || '분석에 실패했습니다', e.kind);
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        backRef.current = null;
      }
    }
  };

  useEffect(() => {
    if (!files || !files.length) return undefined;
    const controller = new AbortController();
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = controller;
    // 새 사진 — 이전 사진·결과·덧붙인 설명을 지운다 (준비에 실패했을 때 '다시 시도'가 이전 사진을 보내지 않도록)
    const initial = notesFrom(initialNotes);
    setPrepared(null);
    clearResult(); // 이전 사진의 "붐벼서 다시 시도하는 중…"이 새 사진을 준비하는 동안 남지 않게
    resetBatches();
    supersededRef.current = new Set();
    backRef.current = null;
    setNotes(initial);
    setAddition('');
    setBoxOpen(false);
    setFollowError(null);
    setMember(DEVICE_MEMBER);
    setPhase('analyzing');
    (async () => {
      try {
        const photos = await preparePhotos(files);
        if (controller.signal.aborted) return;
        setPrepared(photos);
        await run(photos, controller, { notes: initial });
      } catch (e) {
        if (!controller.signal.aborted) { setError(e.message); setPhase('error'); }
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  // 패널이 닫히면 진행 중인 요청을 모두 취소한다 ('다시 시도'로 시작한 요청 포함)
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  /** 덧붙인 설명과 함께 사진을 처음부터 다시 읽는다 — 지금 화면(결과·오류)은 남겨 두고. 보내는 설명 그대로 화면에 남긴다 */
  const reread = () => {
    const said = addition.trim();
    if (!said || !prepared) return;
    run(prepared, undefined, { notes: cleanPhotoNotes([...notes, said]), back: phase });
  };

  /** 설명 빼고 다시 읽기 — 넘겨받거나 덧붙인 설명이 이 사진에 맞지 않을 때 */
  const dropNotes = () => {
    if (!prepared) return;
    run(prepared, undefined, { notes: [], back: phase });
  };

  // 이 사진의 설명(덧붙이던 것까지)을 부모에 알린다 — 다시 찍기·다른 사진·붙여넣기로 바꾼 사진도 같은 설명으로
  useEffect(() => {
    if (notesRef) notesRef.current = cleanPhotoNotes([...notes, addition]);
  });

  /** 읽는 중 취소 — 처음 읽기면 닫고, 설명과 함께 다시 읽기면 앞 화면으로 (덧붙이던 설명은 상자에 남는다) */
  const cancelAnalysis = () => {
    const back = backRef.current;
    if (!back) { onClose(); return; }
    if (abortRef.current) abortRef.current.abort();
    backRef.current = null;
    setProgress('');
    setPhase(back);
  };

  /**
   * 한 건 화면의 추천을 바꾼 뒤(결제수단·카테고리를 고름, 다른 후보를 고름 — I-066) 겹친 결제를 다시 따진다
   * (결제수단·세부내역이 같은 기록과 짝짓는다). 이유도 맞춘다: 바로 넣은(되돌린) 결제와 겹칠 수 있다는 이유는 그대로,
   * 새로 겹치면 그 이유, 겹침이 풀렸으면 그 이유는 지우고, 분류를 골랐으면 분류 확인을, 빈 칸을 다 채웠으면 빈 칸을 지운다.
   * p: 바꾼 칸
   */
  const changeSingle = (prev, changed, p) => {
    const [again] = markDuplicates(dbRef.current, [changed], { claimed: claimedNow() });
    const flag = flagReason(again);
    let reason = reviewReason;
    if (!HELD_REASONS.has(reason)) {
      if (flag) reason = flag;
      else if (reason && reason === flagReason(prev)) reason = '';
      else if ('budget_category' in p && isCategoryReason(reason)) reason = '';
      else if (reason === BLANK_REASON && isSuggestionComplete(again)) reason = '';
    }
    setSuggestion(again);
    setReviewReason(reason);
  };
  /** 결제수단·카테고리를 고른다 — 직접 고른 칸은 근거 표시를 지운다(patchListItem) */
  const patchSingle = p => changeSingle(suggestion, patchListItem({ s: suggestion, checked: false }, p).s, p);
  /** 다른 후보(예전 기록·2순위 등)로 바꾼다 — 근거 표시도 그 후보의 것으로 */
  const pickSingleAlternative = o => changeSingle(suggestion, applyAlternative(suggestion, o), alternativePatch(suggestion, o));

  /**
   * 한 건 화면의 '이대로 넣기' (I-066) — 누른 순간 다시 대조해, 그사이 같은 거래가 새로 들어왔으면(다른 기기 등)
   * 넣지 않고 그 이유를 보인다. 이미 알고 '그래도 넣기'로 누른 겹침은 그대로 넣는다
   */
  const addSingle = () => {
    const [again] = markDuplicates(dbRef.current, [suggestion], { claimed: claimedNow() });
    const now = flagKey(again);
    if (now && now !== flagKey(suggestion)) {
      setSuggestion(again);
      setReviewReason(flagReason(again));
      return;
    }
    onBulkAdd([suggestionToTransaction(dbRef.current, again)]);
  };

  /**
   * 한 건 화면의 '가계부 기록 고치기' (I-065) — 누른 순간 다시 대조해, 고칠 기록이 그대로일 때만 고친다
   * (그사이 다른 기기에서 고쳤거나 지웠으면 바뀐 대조를 보여 주고 멈춘다)
   */
  const fixSingle = () => {
    const before = nearFix(suggestion);
    const [again] = markDuplicates(dbRef.current, [suggestion], { claimed: claimedNow() });
    const fix = nearFix(again);
    if (!before || !fix || fix.id !== before.id) {
      setSuggestion(again);
      setReviewReason(again.duplicateOf || again.nearOf ? flagReason(again) : '그사이 가계부가 바뀌었어요 — 다시 확인해 주세요');
      return;
    }
    onBulkAdd([], { updates: [fix] });
  };

  const ai = activeAI();
  const providerLabel = ai ? PROVIDERS[ai.provider].label.split(' ')[0] : '';
  const count = files ? files.length : 0;
  const previews = prepared ? prepared.previews : [];
  const pending = addition.trim() !== '';
  const notesQuote = notes.length > 0 && (
    <SaidSoFar text={notes[0]} followUps={notes.slice(1).map(said => ({ said }))} />
  );
  // 결과·오류 화면의 설명 — 맞지 않으면(다른 사진에 넘겨받은 설명 등) 빼고 다시 읽을 수 있다. 쓰는 중인 설명이 있으면 그 상자부터
  const notesLine = notes.length > 0 && (
    <>
      {notesQuote}
      {prepared && !pending && (
        <button type="button" className="rs-btn-link tp-followup-open" onClick={dropNotes}>설명 빼고 다시 읽기</button>
      )}
    </>
  );

  if (phase === 'analyzing') {
    let label = count > 1 ? `사진 ${count}장 읽는 중…` : '사진 읽는 중…';
    if (backRef.current) label = sendingRef.current.length ? '설명과 함께 다시 읽는 중…' : '설명 없이 다시 읽는 중…';
    else if (notes.length) label = count > 1 ? `사진 ${count}장을 설명과 함께 읽는 중…` : '사진을 설명과 함께 읽는 중…';
    return (
      <div className="rs-box rs-analyzing">
        <Thumbs previews={previews} count={count} />
        <div className="rs-analyzing-text">
          <span className="rs-spinner" />
          <span className="rs-analyzing-label">
            <span>{label}{providerLabel && <small> ({providerLabel})</small>}</span>
            {!backRef.current && notesQuote}
            {progress && <span className="rs-progress">{progress}</span>}
          </span>
        </div>
        <button type="button" className="rs-btn-link" onClick={cancelAnalysis}>취소</button>
      </div>
    );
  }

  // 설명 덧붙이기 — 사진이 준비됐을 때만(다시 보낼 사진이 있어야 한다). 쓰는 중이거나 실패했으면 상자를 열어 둔다
  let followArea = null;
  if (prepared) {
    followArea = boxOpen || pending || followError ? (
      <FollowUpBox
        heading={NOTE_HEADING}
        example={NOTE_EXAMPLE}
        submitLabel="다시 읽기"
        value={addition}
        onChange={setAddition}
        onSubmit={reread}
        error={followError ? followError.message : ''}
        onSetup={followError && followError.settings && phase !== 'error' ? onSetup : undefined}
        hint={NOTE_HINT}
        pendingNote={phase === 'error' ? '' : NOTE_PENDING}
        autoFocus={boxOpen}
      />
    ) : (
      <button type="button" className="rs-btn-link tp-followup-open" onClick={() => setBoxOpen(true)}>{NOTE_OPEN}</button>
    );
  }

  if (phase === 'error') {
    return (
      <div className="rs-box rs-error">
        <div className="rs-error-text">{error}</div>
        {notesLine}
        {followArea}
        <div className="rs-actions">
          <button type="button" className="rs-btn-secondary" onClick={onClose}>닫기</button>
          <button type="button" className="rs-btn-secondary" onClick={onSetup}>AI 설정</button>
          <button type="button" className="rs-btn-secondary" onClick={() => onRepick()}>다른 사진</button>
          {/* 설명을 쓰는 중이면 그 상자의 '다시 읽기'로 — 쓴 설명을 버리고 다시 시도하지 않게 */}
          {prepared && !pending && (
            <button type="button" className="rs-btn-primary" onClick={() => run(prepared, undefined, { notes })}>다시 시도</button>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'review') {
    const s = suggestion;
    // 이미 있거나 겹친 결제, 앞서 바로 넣은(되돌린) 결제와 같은 곳 — 목록처럼 저절로 넣지 않는다('그래도 넣기', I-066)
    const heldSingle = !!flagReason(s) || HELD_REASONS.has(reviewReason);
    return (
      <div className="rs-box rs-review">
        <div className="rs-review-head">
          <Thumbs previews={previews} count={count} />
          <div className="rs-review-title">
            <b>이렇게 입력하시겠습니까?</b>
            <span>{s.merchant || '가맹점 미확인'} · {CONFIDENCE_LABEL[s.confidence]}</span>
            {notesLine}
            <QuickAutoNote batches={batches} onUndo={undoAll} />
            {reviewReason && <span className="quick-reason">확인이 필요한 이유: {reviewReason}</span>}
          </div>
        </div>
        {modelNote && <div className="rs-model-note">{modelNote}</div>}
        <SuggestionDetails
          suggestion={s}
          amountSource="receipt"
          onUseAlternative={pickSingleAlternative}
          db={db}
          methods={getPaymentMethods(db)}
          onPatch={patchSingle}
        />
        {isNearRow(s) && <NearFix s={s} disabled={pending} onFix={onBulkAdd ? fixSingle : undefined} />}
        {followArea}
        <SingleActions
          s={s}
          disabled={pending}
          held={heldSingle}
          onApply={onApply}
          onAdd={onBulkAdd ? addSingle : undefined}
        >
          <button type="button" className="rs-btn-secondary" onClick={onClose}>취소</button>
          <button type="button" className="rs-btn-secondary" onClick={() => onRepick()}>다시 찍기</button>
        </SingleActions>
      </div>
    );
  }

  // 여러 건
  const methods = getPaymentMethods(db);
  const members = getMemberNames(db);
  const selected = items.filter(isSelected);
  const fixCount = items.filter(needsFixOf).length;
  const unfixedSelected = selected.filter(needsFixOf).length;
  const selectedTotal = selected.reduce((sum, it) => sum + (it.s.amount || 0), 0);
  const fixing = items.filter(isFixing);                     // 가계부 기록을 사진대로 고칠 줄 (I-065)
  const nearCount = items.filter(it => isNearRow(it.s)).length;
  const unpaired = cancels.filter(c => !c.paired);
  /** 고친 값을 반영한다 — idx가 null이면 모든 줄에 (결제수단 모두 바꾸기). 한 줄을 고치면 그 줄의 예전 이유는 지운다 */
  const edit = (idx, p) => {
    setListNote('');
    const claimed = claimedNow();
    setItems(list => refresh(dbRef.current,
      list.map((x, i) => {
        // 체크는 refresh가 정한다 — patchListItem의 체크(빈 칸이면 끔)는 쓰지 않아 입력 중에도 사용자의 체크가 남는다
        if (idx === null) return { ...patchListItem(x, p), checked: x.checked };
        // 체크 없이 둔 이유(되돌린 거래·바로 넣은 결제와 같은 곳)는 남긴다 — 고치다가 저절로 체크되지 않게
        return i === idx ? { ...patchListItem(x, p), checked: x.checked, reason: held(x) ? x.reason : '' } : x;
      }),
      { edited: idx === null ? -1 : idx, claimed }));
  };
  const setAllPayment = (method) => { if (method) edit(null, { payment_method: method }); };
  /**
   * 한 줄을 처음 읽은 값으로 되돌린다 — 근거·이유·경고도 함께. 겹침은 다시 따지고,
   * 체크는 처음 읽었을 때처럼 다시 정한다(고친 값에 준 체크가 잘못 읽은 값에 남지 않게, 되돌린 거래는 체크 없이)
   */
  const revert = (idx) => {
    setListNote('');
    const claimed = claimedNow();
    setItems(list => refresh(dbRef.current,
      list.map((x, i) => (i === idx ? { ...x, s: x.original, reason: x.originalReason, rev: x.rev + 1 } : x)),
      { claimed }).map((x, i) => (i === idx
      ? { ...x, decided: flagKey(x.s), checked: preChecked(x.s) && !held(x), fix: fixByDefault(x.s, x), fixDecided: flagKey(x.s) }
      : x)));
  };
  const checkable = items.filter(it => addable(it.s));
  // '모두'는 이미 있거나 겹친 결제, 체크 없이 둔 줄(되돌린 거래·바로 넣은 결제와 같은 곳)을 뺀 줄 기준 —
  // 그런 줄을 안 골랐어도 나머지를 다 골랐으면 '모두 빼기'
  const pickable = checkable.filter(it => !flagReason(it.s) && !held(it));
  const allChecked = pickable.length > 0 && pickable.every(it => it.checked);
  // 모두 고르기는 그런 줄은 빼고 고른다 — 그런 줄은 한 줄씩 직접 고른다(이미 직접 고른 것은 그대로)
  const toggleAll = () => setItems(list => list.map(it => ({
    ...it,
    decided: flagKey(it.s),
    checked: allChecked ? false : (it.checked || (addable(it.s) && !flagReason(it.s) && !held(it))),
  })));
  const confirm = () => {
    const cur = dbRef.current;
    // 누른 순간 다시 대조한다 — 그사이 다른 기기에서 같은 거래가 들어왔을 수 있다. 이때는 끄기만 한다
    const now = refresh(cur, items, { confirming: true, claimed: claimedNow() });
    const dropped = items.filter((it, i) => isSelected(it) && !isSelected(now[i])).length;
    // 고칠 기록이 그사이 바뀌었거나(다른 기기에서 고침·지움) 같은 거래가 새로 들어왔으면 고치기도 멈춘다 (I-065)
    const droppedFix = items.filter((it, i) => isFixing(it) && !isFixing(now[i])).length;
    if (dropped || droppedFix) {
      setItems(now);
      const why = [];
      if (dropped) why.push(`그사이 가계부에 같은 거래가 들어와 ${dropped}건을 뺐어요`);
      if (droppedFix) why.push(`그사이 가계부가 바뀌어 고칠 거래 ${droppedFix}건을 뺐어요`);
      setListNote(`${why.join(' · ')} — 확인하고 다시 눌러 주세요`);
      return;
    }
    const rows = now.filter(isSelected).map(it => {
      const row = suggestionToTransaction(cur, it.s);
      return member === DEVICE_MEMBER ? row : { ...row, member };
    });
    const updates = now.filter(isFixing).map(it => nearFix(it.s));
    if (updates.length) onBulkAdd(rows, { updates });
    else onBulkAdd(rows);
  };
  // 사용자가 직접 고른 체크는 지금의 겹침에 대해 정한 것 — 같은 겹침이면 고쳐도 그대로 둔다.
  // 넣기와 고치기는 함께 고르지 않는다 — 같은 결제를 고치고 또 넣으면 두 번이 된다
  const toggle = (idx, checked) => setItems(list => list.map((x, i) => (i === idx
    ? { ...x, checked, fix: checked ? false : x.fix, decided: flagKey(x.s), fixDecided: flagKey(x.s) } : x)));
  const toggleFix = (idx, fix) => setItems(list => list.map((x, i) => (i === idx
    ? { ...x, fix, checked: fix ? false : x.checked, decided: flagKey(x.s), fixDecided: flagKey(x.s) } : x)));

  return (
    <div className="rs-box rs-review">
      <div className="rs-review-head">
        <Thumbs previews={previews} count={count} />
        <div className="rs-review-title">
          <b>
            {!items.length ? '취소·환불 내역을 확인해 주세요'
              : batches.length ? `확인이 필요한 결제 ${items.length}건` : `사진에서 결제 ${items.length}건을 찾았어요`}
          </b>
          {notesLine}
          <QuickAutoNote batches={batches} onUndo={undoAll} />
          {fixCount > 0 && <strong className="rs-fix-count">수정 필요 {fixCount}건 — 노란 줄을 고쳐 주세요</strong>}
          {nearCount > 0 && (
            <strong className="rs-near-count">수정 권장 {nearCount}건 — 가계부에 금액·날짜가 다르게 적힌 같은 결제가 있어요</strong>
          )}
          {items.length > 0 && <span>줄마다 '고치기'로 날짜·내용·금액을 고친 뒤 추가하세요</span>}
        </div>
      </div>
      {modelNote && <div className="rs-model-note">{modelNote}</div>}
      {note && <div className="tp-item-warn">{note}</div>}
      {listNote && <div className="rs-error-text" role="alert">{listNote}</div>}

      {items.length > 1 && (
        <div className="tp-item-fields rs-bulk">
          <span className="tp-field">
            <select value="" onChange={e => setAllPayment(e.target.value)} aria-label="결제수단 모두 바꾸기">
              <option value="">결제수단 모두 바꾸기</option>
              {methods.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </span>
          {pickable.length > 1 && (
            <button type="button" className="rs-btn-link" onClick={toggleAll}>{allChecked ? '모두 빼기' : '모두 고르기'}</button>
          )}
          {members.length > 0 && (
            <span className="tp-field">
              <select value={member} onChange={e => setMember(e.target.value)} aria-label="누가">
                <option value={DEVICE_MEMBER}>누가: 이 기기 사용자</option>
                {members.map(m => <option key={m} value={m}>누가: {m}</option>)}
              </select>
            </span>
          )}
        </div>
      )}

      <div className="tp-list">
        {items.map((it, idx) => (
          <SuggestionItem
            key={idx}
            db={db}
            item={{ ...it, checked: isSelected(it) }}
            methods={methods}
            subtitle={[it.s.date, it.s.paymentHint, it.s.eventTitle, rowReason(it)].filter(Boolean).join(' · ')}
            onToggle={checked => toggle(idx, checked)}
            onPatch={p => edit(idx, p)}
            onRevert={() => revert(idx)}
            needsFix={needsFixOf(it)}
            onFillForm={onApply}
            editable
            canCheck={addable(it.s)}
            badge={isNearRow(it.s) ? '수정 권장' : ''}
          >
            {isNearRow(it.s) && (
              <NearFix s={it.s} fix={isFixing(it)} disabled={!fixReady(it.s)} onToggle={on => toggleFix(idx, on)} />
            )}
          </SuggestionItem>
        ))}
      </div>

      {cancels.length > 0 && (
        <div className="rs-cancels">
          <b>취소·환불 {cancels.length}건은 넣지 않아요</b>
          {cancels.map((c, i) => (
            <span key={i}>
              {c.date} {c.merchant || '가맹점 모름'}{c.amount !== null || c.foreignAmount !== null ? ` -${amountText(c)}` : ''}
              {c.paired ? ' (위 결제와 짝)' : ''}
            </span>
          ))}
          {unpaired.length > 0 && <small>이미 가계부에 넣은 결제의 취소라면 거래내역에서 지워 주세요</small>}
        </div>
      )}

      {followArea}

      {unfixedSelected > 0 && (
        <div className="rs-fix-pending"><b>수정 필요 {unfixedSelected}건을 고치지 않은 채 골랐어요</b> — 그대로 넣어도 되지만 세부내역·카테고리를 확인해 주세요</div>
      )}
      <div className="rs-actions">
        <button type="button" className="rs-btn-secondary" onClick={onClose}>취소</button>
        <button type="button" className="rs-btn-secondary" onClick={() => onRepick()}>다른 사진</button>
        <button type="button" className="rs-btn-primary" disabled={(!selected.length && !fixing.length) || pending} onClick={confirm}>
          {[
            selected.length ? `${selected.length}건 추가 (${selectedTotal.toLocaleString()}원)` : '',
            fixing.length ? `${fixing.length}건 고치기` : '',
          ].filter(Boolean).join(' · ') || '추가할 건 선택'}
        </button>
      </div>
    </div>
  );
}
