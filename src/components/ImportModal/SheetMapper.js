import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getPaymentMethods, getDetailPatterns, getBudgetCategories } from '../../services/dbManager';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';
import { activeAI } from '../../services/aiClient';
import { categoryPaths } from '../../services/receiptAssistant';
import {
  COLUMN_FIELDS, FIELD_LABELS, guessMapping, applyMappingToSheets, headerCells, columnName, typeValues, rowIsEmpty, defaultSpendTypes,
  categorizesByDetail, categoryKeyOf, historyIndex, distinctCategories, distinctPayments, toImportEntries, joinCategoryPath,
  formatSignature, findSavedFormat, saveFormat,
} from '../../services/sheetImport';
import { MAX_ROWS } from '../../services/sheetFile';
import { suggestSheetMapping, suggestCategoryMatches, suggestPaymentMatches, SAMPLE_ROWS, MAX_DETAIL_MATCHES } from '../../services/importAI';
import { formatAmount } from '../../services/formulaEvaluator';
import { todayStr } from '../../services/dateUtils';

const LIST_STEP = 60;
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
const cellLabel = v => (typeof v === 'number' ? String(v) : clip(v, 18));

/** 기본값 고르기 — 내 목록에서 고르거나 새 이름을 적는다 */
function PickOrType({ label, value, options, onChange, placeholder }) {
  const known = options.includes(value);
  const [typing, setTyping] = useState(!!value && !known);
  return (
    <label className="sm-field">
      <span className="sm-field-label">{label}</span>
      <span className="sm-pick">
        <select
          className="sm-select"
          value={typing ? '__new__' : (known ? value : '')}
          onChange={(e) => {
            if (e.target.value === '__new__') { setTyping(true); onChange(''); } else { setTyping(false); onChange(e.target.value); }
          }}
        >
          <option value="">고르세요</option>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
          <option value="__new__">새로 만들기…</option>
        </select>
        {typing && (
          <input className="sm-input" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} maxLength={40} />
        )}
      </span>
    </label>
  );
}

/**
 * 표 열·분류 맞추기 (I-034, ROADMAP M-7) — 아무 양식의 표를 가계부 거래로 바꾸는 두 단계.
 *  1) 열 맞추기: 시트·제목줄·각 열이 무엇인지(규칙으로 짐작, '✨ AI로 양식 읽기'), 수입·이체·환불 줄은 건너뜀
 *  2) 분류 맞추기: 파일의 카테고리·결제수단 이름 → 내 가계부 이름(같은 이름·입력 습관으로 먼저, '✨ AI로 맞추기'),
 *     분류 열이 없으면 내용(가게 이름)별로
 * 끝나면 onDone(entries, remember) — entries는 ImportModal의 기존 검사·미리보기·가져오기로 간다. DB에는 쓰지 않는다.
 * remember(): 가져오기를 마친 뒤 부르면 이 양식을 기기에 기억해 다음에 같은 양식이면 바로 맞춘다(없으면 null).
 * 시트를 바꾸면 그 시트로 새로 시작한다(안쪽 화면을 key로 다시 그림).
 */
export default function SheetMapper({ db, dataVersion, workbook, onBack, onDone }) {
  const [sheetIdx, setSheetIdx] = useState(() => Math.max(0, workbook.sheets.findIndex(s => s.rows.some(r => !rowIsEmpty(r)))));
  const sheetPicker = workbook.sheets.length > 1 && (
    <label className="sm-field">
      <span className="sm-field-label">시트</span>
      <select className="sm-select" value={sheetIdx} onChange={e => setSheetIdx(Number(e.target.value))}>
        {workbook.sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
      </select>
    </label>
  );
  return (
    <SheetMapping
      key={sheetIdx}
      db={db}
      dataVersion={dataVersion}
      sheet={workbook.sheets[sheetIdx]}
      sheets={workbook.sheets}
      date1904={workbook.date1904}
      sheetPicker={sheetPicker}
      onBack={onBack}
      onDone={onDone}
    />
  );
}

function SheetMapping({ db, dataVersion, sheet, sheets, date1904, sheetPicker, onBack, onDone }) {
  const live = useDbSnapshot(db, dataVersion);
  const paths = useMemo(() => categoryPaths(live.db), [live]);
  const methods = useMemo(() => getPaymentMethods(live.db), [live]);
  const categories = useMemo(() => getBudgetCategories(live.db), [live]);
  const ai = activeAI();
  const rows = sheet.rows;
  const [today] = useState(todayStr);

  // 처음 열 때: 기억한 같은 양식이 있으면 그것(해·달은 이번 파일의 시트 이름·오늘로), 없으면 규칙으로 짐작
  const [initial] = useState(() => {
    const guess = guessMapping(rows, { sheetName: sheet.name, today });
    const saved = findSavedFormat(rows, { isPath: p => paths.includes(p), isMethod: m => methods.includes(m) });
    if (!saved) return { mapping: guess, categoryTargets: {}, paymentTargets: {}, defaultCategory: '', defaultPayment: '', saved: false };
    return { ...saved, mapping: { ...saved.mapping, year: guess.year, yearAuto: guess.yearAuto, month: guess.month }, saved: true };
  });

  const [step, setStep] = useState('columns');
  const [mapping, setMapping] = useState(initial.mapping);
  const [categoryTargets, setCategoryTargets] = useState(initial.categoryTargets);
  const [paymentTargets, setPaymentTargets] = useState(initial.paymentTargets);
  const [defaultCategory, setDefaultCategory] = useState(initial.defaultCategory || (paths.includes('기타') ? '기타' : ''));
  const [defaultPayment, setDefaultPayment] = useState(initial.defaultPayment || (methods.includes('현금') ? '현금' : ''));
  const [savedApplied, setSavedApplied] = useState(initial.saved);
  const [remember, setRemember] = useState(true);
  const [aiBusy, setAiBusy] = useState('');       // '' | 'layout' | 'categories' | 'payments'
  const [aiProgress, setAiProgress] = useState('');
  const [aiError, setAiError] = useState('');
  const [aiNote, setAiNote] = useState('');
  const [aiPicked, setAiPicked] = useState(() => new Set());
  const [shown, setShown] = useState(LIST_STEP);
  const [shownPay, setShownPay] = useState(LIST_STEP);
  // 같은 모양의 시트(1월·2월…)도 함께 — 기본은 끔(같은 표를 두 시트에 둔 파일이 두 번 들어가지 않게)
  const [allSheets, setAllSheets] = useState(false);
  const abortRef = useRef(null);
  const runRef = useRef(0);

  useEffect(() => () => abortRef.current?.abort(), []);

  const headers = useMemo(() => headerCells(rows, mapping.headerRow), [rows, mapping.headerRow]);
  // 같은 제목줄의 다른 시트 — 월마다 시트를 나눈 가계부
  const sameSheets = useMemo(() => {
    const sig = formatSignature(rows, mapping.headerRow);
    return mapping.headerRow < 0 ? [] : sheets.filter(s => s !== sheet && formatSignature(s.rows, mapping.headerRow) === sig);
  }, [rows, sheets, sheet, mapping.headerRow]);
  const usedSheets = useMemo(() => (allSheets && sameSheets.length ? [sheet, ...sameSheets] : [sheet]), [allSheets, sameSheets, sheet]);
  const result = useMemo(() => applyMappingToSheets(usedSheets, mapping, { date1904, today }), [usedSheets, mapping, date1904, today]);
  // 구분 값은 함께 가져오는 시트 모두에서 모은다(2월 시트에만 있는 값도 고를 수 있게)
  const types = useMemo(() => [...new Set(usedSheets.flatMap(s => typeValues(s.rows, mapping)))], [usedSheets, mapping]);
  const byDetail = categorizesByDetail(mapping);
  const catList = useMemo(() => distinctCategories(result.items, byDetail), [result.items, byDetail]);
  const payList = useMemo(() => distinctPayments(result.items), [result.items]);
  const truncated = usedSheets.find(s => s.totalRows > s.rows.length);

  // 입력 습관(최근 3년, 내용 → 분류) — 분류 맞추기 단계에서 내용별로 맞출 때만 한 번 읽는다(열을 고칠 때마다 다시 하지 않게)
  const inValues = step === 'values';
  const fromHistory = useMemo(
    () => (inValues && byDetail ? historyIndex(getDetailPatterns(live.db, { sinceMonths: 36, limit: 5000 })) : () => null),
    [inValues, byDetail, live],
  );
  // 사용자가 고르지 않은 분류의 기본 맞춤 — 같은 이름이 있으면 그것, 내용별이면 입력 습관(예전에 같은 내용을 넣은 분류)
  const autoCategory = useMemo(() => {
    const auto = {};
    if (!inValues) return auto;
    catList.forEach((c) => {
      if (byDetail) {
        const p = c.detail ? fromHistory(c.detail) : null;
        auto[c.key] = p && paths.includes(p) ? { path: p, source: 'history' } : null;
      } else if (c.category) {
        const p = joinCategoryPath(c.category, c.sub);
        auto[c.key] = paths.includes(p) ? { path: p, source: 'same' } : null;
      } else auto[c.key] = null;
    });
    return auto;
  }, [inValues, catList, byDetail, paths, fromHistory]);
  const categoryOf = key => (key in categoryTargets ? categoryTargets[key] : autoCategory[key]?.path || '');
  const paymentOf = key => (key in paymentTargets ? paymentTargets[key] : (methods.includes(key) ? key : ''));

  // 기본 카테고리가 쓰이는 줄이 있는지 — 내용별로 고르지 않은 것, 분류 칸이 비고 고르지 않은 것
  const needsDefaultCategory = result.items.some(it => (byDetail || !it.category) && !categoryOf(categoryKeyOf(it, byDetail)));
  const needsDefaultPayment = result.items.some(it => !it.payment);

  const setField = (field, col) => {
    setMapping((m) => {
      const next = { ...m, [field]: col };
      // 한 열은 한 항목에만
      COLUMN_FIELDS.forEach((f) => { if (f !== field && col >= 0 && next[f] === col) next[f] = -1; });
      // 지출로 볼 구분 값은 함께 가져오는 시트 모두의 값에서 고른다
      if (field === 'type') next.spendTypes = col >= 0 ? defaultSpendTypes([...new Set(usedSheets.flatMap(s => typeValues(s.rows, next)))], headers[col]) : [];
      if (col >= 0) next.categoryColumns = (next.categoryColumns || []).filter(c => c !== col);
      return next;
    });
    setSavedApplied(false);
  };

  // ── AI ──────────────────────────────────────────────────────────
  const startAI = (kind) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    runRef.current += 1;
    setAiBusy(kind); setAiProgress(''); setAiError('');
    return { signal: controller.signal, run: runRef.current };
  };
  const finishAI = (run, err) => {
    if (run !== runRef.current) return false;      // 그사이 시트를 바꿨거나 다시 눌렀다 — 늦게 온 답은 버린다
    setAiBusy(''); setAiProgress('');
    if (err && err.name !== 'AbortError') setAiError(err.message || 'AI 요청이 실패했습니다');
    return !err;
  };

  const readLayoutWithAI = async () => {
    const { signal, run } = startAI('layout');
    try {
      const r = await suggestSheetMapping({ ai, rows, sheetName: sheet.name, headerRow: mapping.headerRow, year: mapping.year, signal, onProgress: setAiProgress });
      if (!finishAI(run)) return;
      // 해·달·날짜 채우기는 지금 것을 그대로(AI는 열만 고른다)
      const next = { ...r.mapping, year: mapping.year, yearAuto: mapping.yearAuto, month: mapping.month, fillDate: mapping.fillDate };
      const known = typeValues(rows, next);
      next.spendTypes = next.spendTypes.filter(v => known.includes(v));
      if (next.type >= 0 && !next.spendTypes.length) next.spendTypes = defaultSpendTypes(known, headerCells(rows, next.headerRow)[next.type]);
      setMapping(next);
      setSavedApplied(false);
      setAiNote(`${r.notes ? `${r.notes} ` : ''}(표의 앞 ${r.rowsSent}줄만 AI에 보냈어요)`);
    } catch (e) { finishAI(run, e); }
  };

  const matchCategoriesWithAI = async () => {
    const values = catList
      .filter(c => !(c.key in categoryTargets) && !autoCategory[c.key] && (byDetail ? c.detail : c.category))
      .map(c => ({ key: c.key, label: byDetail ? c.detail : joinCategoryPath(c.category, c.sub), count: c.count }));
    if (!values.length) { setAiNote('맞출 분류가 남아 있지 않아요.'); return; }
    const { signal, run } = startAI('categories');
    try {
      const found = await suggestCategoryMatches({ ai, values, paths, byDetail, signal, onProgress: setAiProgress });
      if (!finishAI(run)) return;
      setCategoryTargets(t => ({ ...found, ...t }));
      setAiPicked(s => new Set([...s, ...Object.keys(found)]));
      const asked = byDetail ? Math.min(values.length, MAX_DETAIL_MATCHES) : values.length;
      setAiNote(`${asked}개 중 ${Object.keys(found).length}개를 맞췄어요. 맞추지 못한 것은 ${byDetail ? '기본 카테고리로' : '그대로 새로 만들어'} 가져옵니다.`);
    } catch (e) { finishAI(run, e); }
  };

  const matchPaymentsWithAI = async () => {
    const values = payList.filter(p => !(p.key in paymentTargets) && !methods.includes(p.key)).map(p => ({ key: p.key, label: p.key, count: p.count }));
    if (!values.length) { setAiNote('맞출 결제수단이 남아 있지 않아요.'); return; }
    const { signal, run } = startAI('payments');
    try {
      const found = await suggestPaymentMatches({ ai, values, methods, signal, onProgress: setAiProgress });
      if (!finishAI(run)) return;
      setPaymentTargets(t => ({ ...found, ...t }));
      setAiNote(`결제수단 ${values.length}개 중 ${Object.keys(found).length}개를 맞췄어요.`);
    } catch (e) { finishAI(run, e); }
  };

  // ── 다음 ────────────────────────────────────────────────────────
  const columnsReady = mapping.date >= 0 && (mapping.amountMode === 'perCategory' ? mapping.categoryColumns.length > 0 : mapping.amount >= 0);
  const valuesReady = (!needsDefaultCategory || defaultCategory.trim()) && (!needsDefaultPayment || defaultPayment.trim());

  const finish = () => {
    const effectiveCategories = {};
    catList.forEach((c) => { const p = categoryOf(c.key); if (p) effectiveCategories[c.key] = p; });
    const effectivePayments = {};
    payList.forEach((p) => { const t = paymentOf(p.key); if (t) effectivePayments[p.key] = t; });
    const options = {
      categoryTargets: effectiveCategories,
      paymentTargets: effectivePayments,
      defaultCategory: defaultCategory.trim(),
      defaultPayment: defaultPayment.trim(),
    };
    const entries = toImportEntries(result.items, mapping, options);
    const signature = formatSignature(rows, mapping.headerRow);
    onDone(entries, remember ? () => saveFormat(signature, { mapping, ...options }) : null);
  };

  const columnOptions = (
    <>
      <option value={-1}>없음</option>
      {headers.map((h, i) => <option key={i} value={i}>{columnName(i)}: {clip(h, 20)}</option>)}
    </>
  );
  const previewRows = useMemo(() => {
    const out = [];
    for (let i = mapping.headerRow + 1; i < rows.length && out.length < 4; i += 1) if (!rowIsEmpty(rows[i])) out.push(rows[i]);
    return out;
  }, [rows, mapping.headerRow]);

  const aiBlock = (kind, label, privacy, onClick) => (
    <div className="sm-ai">
      <button type="button" className="btn-secondary sm-ai-btn" disabled={!ai || !!aiBusy} onClick={onClick}>
        {aiBusy === kind ? (aiProgress || 'AI가 읽는 중…') : label}
      </button>
      {aiBusy === kind && <button type="button" className="sm-link" onClick={() => { abortRef.current?.abort(); }}>취소</button>}
      <span className="sm-hint">{ai ? privacy : 'AI 키를 설정하면(설정 › AI) 양식·분류를 AI가 대신 맞춰 줘요.'}</span>
    </div>
  );

  // ── 1단계: 열 맞추기 ─────────────────────────────────────────────
  if (step === 'columns') {
    return (
      <div className="tx-form sm">
        {savedApplied && <p className="sm-note">지난번에 맞춘 같은 양식이라 그대로 맞췄어요. 바꿀 것이 있으면 고치세요.</p>}
        {truncated && (
          <p className="error-msg">
            &apos;{truncated.name}&apos;이 {formatAmount(truncated.totalRows)}줄이라 앞 {formatAmount(MAX_ROWS)}줄만 읽었어요 — 나머지는 파일을 나눠 한 번 더 올려 주세요.
          </p>
        )}
        {sheetPicker}
        {sameSheets.length > 0 && (
          <label className="sm-check">
            <input
              type="checkbox"
              checked={allSheets}
              onChange={(e) => {
                const on = e.target.checked;
                setAllSheets(on);
                // 함께 가져오는 시트에만 있는 구분 값도 지출로 볼 것은 골라 둔다(이미 고른 것은 그대로)
                if (on && mapping.type >= 0) {
                  const mine = typeValues(rows, mapping);
                  const added = [...new Set(sameSheets.flatMap(s => typeValues(s.rows, mapping)))].filter(v => !mine.includes(v));
                  const extra = defaultSpendTypes(added, headers[mapping.type]);
                  if (extra.length) setMapping(m => ({ ...m, spendTypes: [...new Set([...m.spendTypes, ...extra])] }));
                }
              }}
            />
            같은 모양의 시트 {sameSheets.length}개({clip(sameSheets.map(s => s.name).join(', '), 30)})도 함께 가져오기
          </label>
        )}
        <label className="sm-field">
          <span className="sm-field-label">제목줄</span>
          <select className="sm-select" value={mapping.headerRow} onChange={(e) => { setMapping(m => ({ ...m, headerRow: Number(e.target.value) })); setSavedApplied(false); }}>
            <option value={-1}>없음 — 첫 줄부터 내용</option>
            {rows.slice(0, 30).map((r, i) => (rowIsEmpty(r) ? null : (
              <option key={i} value={i}>{i + 1}행: {clip(r.filter(v => v !== '' && v !== undefined).slice(0, 4).map(cellLabel).join(' · '), 40)}</option>
            )))}
          </select>
        </label>

        {aiBlock('layout', '✨ AI로 양식 읽기', `표의 앞 ${SAMPLE_ROWS}줄 정도만 AI에 보내요(계좌·카드번호처럼 긴 숫자는 가려서).`, readLayoutWithAI)}
        {aiNote && <p className="sm-note">{aiNote}</p>}
        {aiError && <p className="error-msg">{aiError}</p>}

        <div className="import-preview-wrap sm-raw">
          <table className="import-preview-table">
            <thead><tr>{headers.map((h, i) => <th key={i}>{columnName(i)} {clip(h, 12)}</th>)}</tr></thead>
            <tbody>{previewRows.map((r, i) => <tr key={i}>{headers.map((_, j) => <td key={j}>{cellLabel(r[j] ?? '')}</td>)}</tr>)}</tbody>
          </table>
        </div>

        <div className="sm-fields">
          <label className="sm-field">
            <span className="sm-field-label">금액 모양</span>
            <select className="sm-select" value={mapping.amountMode} onChange={(e) => { setMapping(m => ({ ...m, amountMode: e.target.value })); setSavedApplied(false); }}>
              <option value="single">금액이 한 열</option>
              <option value="perCategory">카테고리마다 금액 열이 따로(식비 | 교통 | …)</option>
            </select>
          </label>
          {COLUMN_FIELDS.filter(f => !(mapping.amountMode === 'perCategory' && (f === 'amount' || f === 'category' || f === 'subCategory' || f === 'discount'))).map(f => (
            <label key={f} className="sm-field">
              <span className="sm-field-label">{FIELD_LABELS[f]}{(f === 'date' || (f === 'amount' && mapping.amountMode === 'single')) && <em className="sm-req"> 필수</em>}</span>
              <select className="sm-select" value={mapping[f]} onChange={e => setField(f, Number(e.target.value))}>{columnOptions}</select>
            </label>
          ))}
          {mapping.amountMode === 'perCategory' && (
            <div className="sm-field sm-field--block">
              <span className="sm-field-label">금액 열(열 제목이 카테고리가 돼요)</span>
              <div className="sm-checks">
                {headers.map((h, i) => (COLUMN_FIELDS.some(f => mapping[f] === i) ? null : (
                  <label key={i} className="sm-check">
                    <input
                      type="checkbox"
                      checked={mapping.categoryColumns.includes(i)}
                      onChange={(e) => {
                        setMapping(m => ({ ...m, categoryColumns: e.target.checked ? [...m.categoryColumns, i].sort((a, b) => a - b) : m.categoryColumns.filter(c => c !== i) }));
                        setSavedApplied(false);
                      }}
                    />
                    {clip(h, 14)}
                  </label>
                )))}
              </div>
            </div>
          )}
          <label className="sm-field">
            <span className="sm-field-label">지출 금액이</span>
            <select className="sm-select" value={mapping.amountSign} onChange={(e) => { setMapping(m => ({ ...m, amountSign: e.target.value })); setSavedApplied(false); }}>
              <option value="positive">양수로 적혀 있어요</option>
              <option value="negative">음수로 적혀 있어요(입금이 양수)</option>
            </select>
          </label>
          {mapping.type >= 0 && (
            <div className="sm-field sm-field--block">
              <span className="sm-field-label">지출로 가져올 구분 값</span>
              <div className="sm-checks">
                {types.slice(0, 12).map(v => (
                  <label key={v || '(빈 칸)'} className="sm-check">
                    <input
                      type="checkbox"
                      checked={mapping.spendTypes.includes(v)}
                      onChange={(e) => {
                        setMapping(m => ({ ...m, spendTypes: e.target.checked ? [...m.spendTypes, v] : m.spendTypes.filter(x => x !== v) }));
                        setSavedApplied(false);
                      }}
                    />
                    {v || '(빈 칸)'}
                  </label>
                ))}
              </div>
            </div>
          )}
          {result.yearless && (
            <label className="sm-field">
              <span className="sm-field-label">연도 없는 날짜의 해</span>
              <input
                className="sm-input"
                inputMode="numeric"
                value={mapping.year ?? ''}
                onChange={(e) => {
                  const y = e.target.value.replace(/\D/g, '').slice(0, 4);
                  // 직접 정한 해는 그대로 쓴다(미래 날짜라도 한 해 앞으로 바꾸지 않음)
                  setMapping(m => ({ ...m, year: y.length === 4 ? Number(y) : null, yearAuto: false }));
                }}
                placeholder="예: 2024"
              />
            </label>
          )}
          {mapping.date >= 0 && (
            <label className="sm-check">
              <input
                type="checkbox"
                checked={mapping.fillDate !== false}
                onChange={e => setMapping(m => ({ ...m, fillDate: e.target.checked }))}
              />
              날짜 칸이 빈 줄은 위 줄의 날짜로(하루 날짜를 여러 줄에 합쳐 둔 표)
            </label>
          )}
        </div>

        <p className="import-info">
          가져올 지출 <strong>{result.items.length}건</strong>
        </p>
        {result.skipped.length > 0 && (
          <ul className="sm-skipped-list">
            {result.skipped.map(s => (
              <li key={s.reason}>
                건너뜀 · {s.reason} {formatAmount(s.count)}줄
                <span className="sm-count"> ({s.labels.join(', ')}{s.count > s.labels.length ? ' …' : ''})</span>
              </li>
            ))}
          </ul>
        )}
        {result.items.length > 0 && (
          <div className="import-preview-wrap">
            <table className="import-preview-table">
              <thead><tr><th>행</th><th>날짜</th><th>내용</th><th>분류</th><th>결제수단</th><th>금액</th></tr></thead>
              <tbody>
                {result.items.slice(0, 5).map(it => (
                  <tr key={it.label}>
                    <td className="preview-row-num">{it.label}</td>
                    <td>{it.date}</td>
                    <td className="preview-detail">{[it.detail, it.memo].filter(Boolean).join(' · ') || <span className="preview-empty">-</span>}</td>
                    <td>{it.category ? joinCategoryPath(it.category, it.sub).replace(' > ', ' › ') : <span className="preview-empty">-</span>}</td>
                    <td>{it.payment || <span className="preview-empty">-</span>}</td>
                    <td className="preview-amount">{formatAmount(it.amount)}원</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onBack}>다시 선택</button>
          <button type="button" className="btn-primary" disabled={!columnsReady || !result.items.length || !!aiBusy} onClick={() => { setStep('values'); setAiNote(''); setAiError(''); setShown(LIST_STEP); }}>
            {!columnsReady ? '날짜·금액 열을 고르세요' : '다음: 분류 맞추기'}
          </button>
        </div>
      </div>
    );
  }

  // ── 2단계: 분류 맞추기 ───────────────────────────────────────────
  const catRow = (c) => {
    const value = categoryOf(c.key);
    const source = c.key in categoryTargets ? (aiPicked.has(c.key) ? 'AI' : '') : (autoCategory[c.key]?.source === 'history' ? '습관' : '');
    // 고르지 않았을 때 — 이미 있는 카테고리인데 세부카테고리가 없으면 그렇다고(거래내역에서 확인할 거래로 보인다)
    let keepLabel = '그대로 새로 만들기';
    if (byDetail || !c.category) keepLabel = '기본 카테고리';
    else if (paths.includes(joinCategoryPath(c.category, c.sub))) keepLabel = '그대로';
    else if (!c.sub && categories.includes(c.category)) keepLabel = '그대로(세부카테고리 없이)';
    return (
      <li key={c.key} className="sm-match">
        <span className="sm-match-name">
          {byDetail ? (c.detail || '(내용 없음)') : (c.category ? joinCategoryPath(c.category, c.sub).replace(' > ', ' › ') : '(분류 빈 칸)')}
          <span className="sm-count">{c.count}건</span>
          {source && <span className="sm-badge">{source}</span>}
        </span>
        <select
          className="sm-select"
          value={value}
          aria-label={`${byDetail ? c.detail : c.category} 카테고리`}
          onChange={(e) => {
            const v = e.target.value;
            setCategoryTargets(t => ({ ...t, [c.key]: v }));
            setAiPicked(s => { const n = new Set(s); n.delete(c.key); return n; });
          }}
        >
          <option value="">{keepLabel}</option>
          {paths.map(p => <option key={p} value={p}>{p.replace(' > ', ' › ')}</option>)}
        </select>
      </li>
    );
  };

  return (
    <div className="tx-form sm">
      <div className="sm-section">
        <div className="sm-section-head">
          <strong>{byDetail ? '내용별 카테고리' : '카테고리 맞추기'}</strong>
          <span className="sm-hint">
            {byDetail
              ? '파일에 분류가 없어 내용(가게 이름)으로 고릅니다. 예전에 같은 내용을 넣은 분류는 미리 골라 뒀어요.'
              : '파일의 분류를 내 가계부 카테고리에 맞추세요. 고르지 않으면 파일 이름 그대로 새로 만듭니다.'}
          </span>
        </div>
        {paths.length > 0 && aiBlock(
          'categories',
          '✨ AI로 카테고리 맞추기',
          byDetail ? `내용(가게·받는 분 이름)과 건수를 보내요 — 많이 나온 ${MAX_DETAIL_MATCHES}개까지, 메모는 보내지 않아요.` : '분류 이름과 건수만 보내요.',
          matchCategoriesWithAI,
        )}
        <ul className="sm-matches">{catList.slice(0, shown).map(catRow)}</ul>
        {catList.length > shown && (
          <button type="button" className="sm-link" onClick={() => setShown(n => n + 100)}>
            {catList.length - shown}개 더 보기{byDetail ? ' (고르지 않으면 기본 카테고리)' : ''}
          </button>
        )}
        {needsDefaultCategory && (
          <PickOrType label="기본 카테고리" value={defaultCategory} options={paths} onChange={setDefaultCategory} placeholder="예: 기타" />
        )}
      </div>

      <div className="sm-section">
        <div className="sm-section-head">
          <strong>결제수단</strong>
          {payList.length > 0 && <span className="sm-hint">고르지 않으면 파일 이름 그대로 새로 만듭니다.</span>}
        </div>
        {payList.length > 0 && methods.length > 0 && aiBlock('payments', '✨ AI로 결제수단 맞추기', '결제수단 이름과 건수만 보내요.', matchPaymentsWithAI)}
        {payList.length > 0 && (
          <ul className="sm-matches">
            {payList.slice(0, shownPay).map(p => (
              <li key={p.key} className="sm-match">
                <span className="sm-match-name">{p.key}<span className="sm-count">{p.count}건</span></span>
                <select
                  className="sm-select"
                  value={paymentOf(p.key)}
                  aria-label={`${p.key} 결제수단`}
                  onChange={e => setPaymentTargets(t => ({ ...t, [p.key]: e.target.value }))}
                >
                  <option value="">{methods.includes(p.key) ? '그대로' : '그대로 새로 만들기'}</option>
                  {methods.map(mth => <option key={mth} value={mth}>{mth}</option>)}
                </select>
              </li>
            ))}
          </ul>
        )}
        {payList.length > shownPay && (
          <button type="button" className="sm-link" onClick={() => setShownPay(n => n + 100)}>{payList.length - shownPay}개 더 보기</button>
        )}
        {needsDefaultPayment && (
          <PickOrType label={payList.length ? '결제수단이 빈 줄' : '모두 이 결제수단으로'} value={defaultPayment} options={methods} onChange={setDefaultPayment} placeholder="예: 현금" />
        )}
      </div>

      {aiNote && <p className="sm-note">{aiNote}</p>}
      {aiError && <p className="error-msg">{aiError}</p>}

      <label className="sm-check sm-remember">
        <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
        이 양식 기억하기 — 다음에 같은 양식을 올리면 바로 맞춰요(이 기기에)
      </label>

      <div className="form-actions">
        <button type="button" className="btn-secondary" onClick={() => { abortRef.current?.abort(); setStep('columns'); setAiNote(''); setAiError(''); }}>이전</button>
        <button type="button" className="btn-primary" disabled={!valuesReady || !!aiBusy} onClick={finish}>
          {valuesReady ? `${result.items.length}건 검사하기` : '기본값을 고르세요'}
        </button>
      </div>
    </div>
  );
}
