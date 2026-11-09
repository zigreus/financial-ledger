import React, { useState } from 'react';
import {
  bulkInsertTransactions,
  ensureCategoriesExist,
  ensureSubCategoriesExist,
  getAllPaymentMethods,
  withTransaction,
} from '../../services/dbManager';
import { buildValidationContext, detectIssues } from '../../services/txValidator';
import { unescapeSpreadsheetText } from '../../services/csv';
import {
  normalizeDateStr, parseImportAmount, markDuplicates, txDuplicateKey, countExistingTransactions,
  loadTripEvents, findTripEvent, createTripEvent,
} from '../../services/importHelpers';
import { readSheetFile, readFileBytes, decodeText, MAX_ROWS } from '../../services/sheetFile';
import { appTemplateHeaderRow, templateEntries } from '../../services/sheetImport';
import './ImportModal.css';
import ModalOverlay from '../common/ModalOverlay';
import { downloadText } from '../common/download';
import SheetMapper from './SheetMapper';

// ── 템플릿 ────────────────────────────────────────────────────────────
// JSON: _no 필드로 행 번호를 명시 → 오류 발생 시 해당 행을 즉시 찾을 수 있음
const JSON_TEMPLATE = JSON.stringify([
  {
    _no: 1,
    payment_method: '신한카드',
    date: '2026-01-10',
    budget_category: '식비',
    sub_category: '외식',
    detail: '점심 식사',
    amount: 15000,
    discount_amount: 0,
    discount_note: '',
  },
  {
    _no: 2,
    payment_method: '현대카드',
    date: '2026-01-15',
    budget_category: '쇼핑',
    sub_category: '온라인',
    detail: '주방용품',
    amount: 42000,
    discount_amount: 2000,
    discount_note: '카드 청구할인',
  },
  {
    _no: 3,
    payment_method: '현금',
    date: '2026-01-18',
    budget_category: '의료/건강',
    sub_category: '병원',
    detail: '내과 진료',
    amount: 8000,
    discount_amount: 0,
    discount_note: '',
  },
  {
    _no: 4,
    payment_method: 'KB국민카드',
    date: '2026-01-22',
    budget_category: '차량교통비',
    sub_category: '주유',
    detail: 'GS칼텍스',
    amount: 70000,
    discount_amount: 1400,
    discount_note: '주유 1% 할인',
  },
  {
    _no: 5,
    payment_method: '카카오페이',
    date: '2026-02-05',
    budget_category: '여행',
    sub_category: '숙박',
    detail: '도쿄 호텔',
    amount: 220000,
    discount_amount: 0,
    discount_note: '',
    trip_name: '일본 도쿄',
    trip_schedule: '2026-02-03 ~ 2026-02-07',
  },
], null, 2);

// CSV: 헤더+데이터 행, _no 컬럼 포함 (행 번호 추적용)
const CSV_TEMPLATE =
  '_no,payment_method,date,budget_category,sub_category,detail,amount,discount_amount,discount_note,trip_name,trip_schedule\r\n' +
  '1,신한카드,2026-01-10,식비,외식,점심 식사,15000,0,,\r\n' +
  '2,현대카드,2026-01-15,쇼핑,온라인,주방용품,42000,2000,카드 청구할인,,\r\n' +
  '3,현금,2026-01-18,의료/건강,병원,내과 진료,8000,0,,,\r\n' +
  '4,KB국민카드,2026-01-22,차량교통비,주유,GS칼텍스,70000,1400,주유 1% 할인,,\r\n' +
  '5,카카오페이,2026-02-05,여행,숙박,도쿄 호텔,220000,0,,일본 도쿄,2026-02-03 ~ 2026-02-07\r\n';

// ── 행 읽기·검사 ─────────────────────────────────────────────────────
const FIELDS = [
  'payment_method', 'date', 'budget_category', 'sub_category', 'detail',
  'amount', 'discount_amount', 'discount_note', 'trip_name', 'trip_schedule',
];

/** 칸 값 → 문자열. 글자·숫자만 받고, 그 밖의 타입(객체·배열·true 등)이면 null */
function cellText(v) {
  if (v === undefined || v === null) return '';
  // 내보내기가 엑셀 수식 방지로 붙인 ' 는 뗀다 (I-014)
  if (typeof v === 'string') return unescapeSpreadsheetText(v.trim());
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * 원본 행 하나를 검사·정리한다 (B-029).
 * 항목이 객체가 아니거나 칸 타입이 이상하면 그 행만 건너뛴다 — 파일 전체를 거부하지 않는다.
 * 반환: { row } 또는 { errors }
 */
function readRow(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['항목 형식 오류: { ... } 객체여야 함'] };
  }
  const errors = [];
  const v = {};
  FIELDS.forEach(f => {
    const t = cellText(raw[f]);
    if (t === null) { errors.push(`${f} 형식 오류: 글자나 숫자여야 함`); v[f] = ''; }
    else v[f] = t;
  });

  if (!v.payment_method) errors.push('결제수단 없음');
  const date = normalizeDateStr(v.date);
  if (!v.date) errors.push('날짜 없음');
  else if (!date) errors.push(`날짜 오류: "${v.date}" → 실제 있는 날짜를 YYYY-MM-DD로`);
  if (!v.budget_category) errors.push('카테고리 없음');

  const amount = parseImportAmount(v.amount);
  const discount = parseImportAmount(v.discount_amount);
  if (Number.isNaN(discount) || discount < 0) {
    errors.push(`할인금액 오류: "${v.discount_amount}" → 0 이상 숫자`);
  }
  const hasDiscount = discount > 0;
  // 할인금액이 있으면 금액 없음/0도 허용 (전액 할인/환급 등)
  const amountBad = amount === null
    ? !hasDiscount
    : Number.isNaN(amount) || amount < 0 || (amount === 0 && !hasDiscount);
  if (amountBad) errors.push(`금액 오류: "${v.amount}" → 양수 필요 (할인금액이 있으면 생략 가능)`);

  if (errors.length > 0) return { errors };
  return {
    row: {
      payment_method: v.payment_method,
      date,
      budget_category: v.budget_category,
      sub_category: v.sub_category,
      detail: v.detail,
      amount: amount ?? 0,
      discount_amount: discount ?? 0,
      discount_note: v.discount_note,
      trip_name: v.trip_name,
      trip_schedule: v.trip_schedule,
    },
  };
}

/**
 * 가져올 행들 기준으로 DB에 없는 항목을 찾는다.
 * 카테고리·세부카테고리 판단은 거래내역 '이슈'와 같은 기준(txValidator)을 쓴다.
 */
function findMissing(db, rows) {
  const ctx = buildValidationContext(db);
  const methods = new Set(getAllPaymentMethods(db).map(p => p.name));
  const paymentMethods = new Set();
  const categories = new Set();
  const subCategories = new Map();
  const trips = new Map();

  rows.forEach(row => {
    if (!methods.has(row.payment_method)) paymentMethods.add(row.payment_method);
    detectIssues(row, ctx).forEach(issue => {
      if (issue.field === 'budget_category') categories.add(row.budget_category);
      if (issue.field === 'sub_category') {
        subCategories.set(`${row.budget_category}|${row.sub_category}`, { budget_category: row.budget_category, name: row.sub_category });
      }
    });
    if (row.tripKey) {
      if (!trips.has(row.tripKey)) {
        trips.set(row.tripKey, { key: row.tripKey, name: row.trip_name, schedule: row.trip_schedule, dates: [] });
      }
      trips.get(row.tripKey).dates.push(row.date);
    }
  });

  return {
    paymentMethods: [...paymentMethods],
    categories: [...categories],
    subCategories: [...subCategories.values()],
    trips: [...trips.values()],
  };
}

const hasAnyMissing = (m) =>
  m.paymentMethods.length > 0 || m.categories.length > 0 || m.subCategories.length > 0 || m.trips.length > 0;

function missingSummary(m) {
  return [
    m.paymentMethods.length && `결제수단 ${m.paymentMethods.length}개`,
    m.categories.length && `카테고리 ${m.categories.length}개`,
    m.subCategories.length && `세부카테고리 ${m.subCategories.length}개`,
    m.trips.length && `여행 일정 ${m.trips.length}개`,
  ].filter(Boolean).join(' · ');
}

/**
 * 파일의 항목들을 검사하고, 여행 일정 연결·중복 여부를 붙인다. DB에는 쓰지 않는다.
 * entries: [{ label, raw }]
 */
function analyze(db, entries) {
  const tripEvents = loadTripEvents(db);
  const valid = [];
  const hardErrors = [];

  entries.forEach(({ label, raw }) => {
    const { row, errors } = readRow(raw);
    if (errors) { hardErrors.push({ label, fields: errors }); return; }

    let eventId = null;
    let eventTitle = '';
    let tripKey = '';
    if (row.trip_name) {
      const ev = findTripEvent(tripEvents, row.trip_name, row.trip_schedule, row.date);
      if (ev) { eventId = ev.id; eventTitle = ev.title; }
      else tripKey = `${row.trip_name}|${row.trip_schedule}`;
    }
    valid.push({ ...row, label, event_id: eventId, eventTitle, tripKey });
  });

  // 이미 가계부에 있는 거래와 같은 행 표시 (같은 파일을 두 번 올려도 두 배가 되지 않게, B-025)
  const rows = markDuplicates(valid, txDuplicateKey, countExistingTransactions(db, valid));
  return { rows, hardErrors };
}

/** JSON 파일 → [{ label, raw }]. label은 오류 표시에 쓰는 행 위치 */
function readJsonEntries(text) {
  const data = JSON.parse(text.replace(/^﻿/, ''));
  if (!Array.isArray(data)) throw new Error('JSON은 배열 형식이어야 합니다.');
  return data.map((raw, idx) => {
    const no = raw && typeof raw === 'object' ? cellText(raw._no) : '';
    return { label: no ? `_no ${no}` : `${idx + 1}번째 항목`, raw };
  });
}

// ── 컴포넌트 ─────────────────────────────────────────────────────────
// step: upload → (앱 양식이 아니면) map: 열·분류 맞추기(SheetMapper, M-7) → conflict(오류·없는 항목) → preview → done
function ImportModal({ db, dataVersion, onImport, onClose }) {
  const [step, setStep] = useState('upload');
  const [rows, setRows] = useState([]);
  const [hardErrors, setHardErrors] = useState([]);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [importedCount, setImportedCount] = useState(0);
  const [reading, setReading] = useState(false);
  // 아무 양식의 표(엑셀·CSV·은행 내역) — 열·분류 맞추기 단계가 쓴다. 검사 단계에서 돌아와 다시 맞출 수 있게 남겨 둔다
  const [workbook, setWorkbook] = useState(null);
  const [rememberFormat, setRememberFormat] = useState(null);   // 가져오기를 마치면 부를 '이 양식 기억하기'

  const rowsToImport = includeDuplicates ? rows : rows.filter(r => !r.isDuplicate);
  const duplicateCount = rows.filter(r => r.isDuplicate).length;
  // 확정 전에는 DB에 쓰지 않는다 — 없는 항목은 '가져오기'를 누를 때 함께 추가한다 (B-029)
  const missingAll = step === 'conflict' ? findMissing(db, rows) : null;
  const missingToAdd = step === 'preview' ? findMissing(db, rowsToImport) : null;

  // 행들을 검사하고 오류·없는 항목이 있으면 conflict, 아니면 preview로
  const review = (entries) => {
    if (entries.length === 0) { setError('데이터가 없습니다.'); return; }
    const result = analyze(db, entries);
    setRows(result.rows);
    setHardErrors(result.hardErrors);
    setIncludeDuplicates(false);
    if (result.rows.length === 0 && result.hardErrors.length === 0) {
      setError('데이터를 인식할 수 없습니다. 파일 형식을 확인해주세요.');
      return;
    }
    // 유효 행이 0개여도 충돌 단계로 이동해 어떤 행이 왜 실패했는지 표시한다
    const needsReview = result.hardErrors.length > 0 || hasAnyMissing(findMissing(db, result.rows));
    setError('');
    setStep(needsReview ? 'conflict' : 'preview');
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';   // 같은 파일을 다시 골라도 읽게
    if (!file) return;
    setError('');
    setWorkbook(null);
    setRememberFormat(null);
    setReading(true);
    try {
      if (/\.json$/i.test(file.name)) {
        review(readJsonEntries(decodeText(await readFileBytes(file))));
        return;
      }
      // CSV·엑셀·은행 내역(HTML 표) — 이 앱의 양식(내보내기와 같은 칸)이면 바로, 아니면 열·분류 맞추기로 (M-7)
      const book = await readSheetFile(file);
      const only = book.sheets.length === 1 ? book.sheets[0] : null;
      const templateRow = only ? appTemplateHeaderRow(only.rows) : -1;
      if (templateRow >= 0) {
        // 너무 커서 앞부분만 읽었으면 조용히 자르지 않고 나눠 올리게 한다
        if (only.totalRows > only.rows.length) {
          setError(`파일이 ${only.totalRows.toLocaleString()}줄이라 한 번에 가져올 수 없습니다 — ${MAX_ROWS.toLocaleString()}줄씩 나눠 올려 주세요.`);
          return;
        }
        review(templateEntries(only.rows, templateRow, { date1904: book.date1904 }));
        return;
      }
      if (!book.sheets.some(s => s.rows.some(r => r && r.some(v => v !== '' && v !== undefined && v !== null)))) {
        setError('파일에 내용이 없습니다.');
        return;
      }
      setWorkbook(book);
      setStep('map');
    } catch (err) {
      setError(`파일 읽기 오류: ${err.message}`);
    } finally {
      setReading(false);
    }
  };

  const handleMapped = (entries, remember) => {
    setRememberFormat(() => remember);
    review(entries);
  };

  const handleImport = async () => {
    if (importing || rowsToImport.length === 0) return;
    setImporting(true);
    try {
      // 없는 항목 추가 + 거래 추가를 한 단위로 — 중간에 실패하면 아무것도 남지 않는다
      withTransaction(db, () => {
        const need = findMissing(db, rowsToImport);
        if (need.categories.length > 0) ensureCategoriesExist(db, need.categories);
        if (need.subCategories.length > 0) ensureSubCategoriesExist(db, need.subCategories);
        const newEventIds = new Map();
        need.trips.forEach(t => {
          newEventIds.set(t.key, createTripEvent(db, { name: t.name, schedule: t.schedule, dates: t.dates }));
        });
        // 결제수단은 bulkInsertTransactions가 없으면 추가한다
        bulkInsertTransactions(db, rowsToImport.map(r => ({
          payment_method: r.payment_method,
          date: r.date,
          budget_category: r.budget_category,
          sub_category: r.sub_category,
          detail: r.detail,
          amount: r.amount,
          discount_amount: r.discount_amount,
          discount_note: r.discount_note,
          event_id: r.event_id ?? (r.tripKey ? newEventIds.get(r.tripKey) : null) ?? null,
        })));
      });
      setImportedCount(rowsToImport.length);
      if (rememberFormat) rememberFormat();   // 맞춘 양식을 기억 — 실제로 가져왔을 때만
      onImport();
      setStep('done');
    } catch (err) {
      setError(`가져오기 오류: ${err.message}`);
      setImporting(false);
    }
  };

  const resetToUpload = () => {
    setStep('upload');
    setError('');
    setRows([]);
    setHardErrors([]);
    setIncludeDuplicates(false);
    setImporting(false);
    setWorkbook(null);
    setRememberFormat(null);
  };

  // 검사·미리보기에서 열·분류 맞추기로 돌아간다(맞춘 것은 그대로 남아 있다)
  const backToMapping = workbook && (
    <button className="btn-secondary" onClick={() => { setError(''); setStep('map'); }}>← 다시 맞추기</button>
  );

  const hasTrip = rowsToImport.some(r => r.trip_name);

  return (
    <ModalOverlay className="modal-overlay" panelClassName="modal-content">
        <div className="modal-header">
          <h2>거래내역 가져오기</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* ── 업로드 단계 ──────────────────────────────────────── */}
        {step === 'upload' && (
          <div className="tx-form">
            <p className="import-info">
              쓰던 <strong>엑셀(.xlsx)</strong>·<strong>CSV</strong> 가계부, 은행·카드사 내역, 다른 가계부 앱에서 내보낸 파일을 그대로 올리세요.
              어떤 열이 날짜·금액·내용인지 맞춘 뒤 가져옵니다(AI 키가 있으면 AI가 대신 맞춰 줘요).<br />
              아래 양식으로 만든 파일과 이 앱에서 내보낸 CSV는 바로 가져옵니다.
            </p>

            <input
              type="file"
              accept=".xlsx,.xlsm,.xls,.csv,.tsv,.txt,.htm,.html,.json"
              onChange={handleFileChange}
              disabled={reading}
              className="import-file-input"
            />
            {reading && <p className="import-info">파일을 읽는 중…</p>}
            {error && <p className="error-msg">{error}</p>}
            <p className="import-template-note">
              예전 엑셀 형식(.xls)은 엑셀에서 &quot;다른 이름으로 저장 › Excel 통합 문서(.xlsx)&quot;로 저장해 올려 주세요.
              표가 아닌 메모·문자 글은 거래 입력 창의 &apos;AI 입력&apos;에 붙여 넣으면 거래로 나눠 줍니다.
            </p>

            <div className="import-template-section">
              <p className="import-template-label">양식 파일 다운로드</p>
              <div className="import-template-buttons">
                <button
                  className="btn-template"
                  onClick={() => downloadText(JSON_TEMPLATE, '거래내역_양식.json', 'application/json')}
                >
                  JSON 양식
                </button>
                <button
                  className="btn-template"
                  onClick={() => downloadText(CSV_TEMPLATE, '거래내역_양식.csv', 'text/csv')}
                >
                  CSV 양식
                </button>
              </div>
              <p className="import-template-note">
                JSON 양식의 <code>_no</code> 필드는 오류 표시용 번호이며 가져오기 시 저장되지 않습니다.
              </p>
            </div>

            <div className="import-field-guide">
              <p className="import-field-guide-title">입력 필드 안내</p>
              <table className="import-field-table">
                <thead>
                  <tr><th>필드명</th><th>구분</th><th>설명</th></tr>
                </thead>
                <tbody>
                  <tr><td>payment_method</td><td><span className="badge badge-required">필수</span></td><td>결제수단</td></tr>
                  <tr><td>date</td><td><span className="badge badge-required">필수</span></td><td>날짜 (YYYY-MM-DD)</td></tr>
                  <tr><td>budget_category</td><td><span className="badge badge-required">필수</span></td><td>카테고리</td></tr>
                  <tr><td>amount</td><td><span className="badge badge-required">필수</span></td><td>금액 (양수)</td></tr>
                  <tr><td>sub_category</td><td><span className="badge badge-optional">선택</span></td><td>세부 카테고리</td></tr>
                  <tr><td>detail</td><td><span className="badge badge-optional">선택</span></td><td>내역 메모</td></tr>
                  <tr><td>discount_amount</td><td><span className="badge badge-optional">선택</span></td><td>할인 금액</td></tr>
                  <tr><td>discount_note</td><td><span className="badge badge-optional">선택</span></td><td>할인 설명</td></tr>
                  <tr><td>trip_name</td><td><span className="badge badge-travel">여행</span></td><td>여행 일정 이름 (캘린더 여행 일정과 연결, 없으면 새로 만듦)</td></tr>
                  <tr><td>trip_schedule</td><td><span className="badge badge-travel">여행</span></td><td>여행 기간 (예: 2026-01-18 ~ 01-22)</td></tr>
                  <tr><td>_no</td><td><span className="badge badge-info">참고</span></td><td>행 번호 (JSON 전용, 오류 표시용)</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── 열·분류 맞추기 (아무 양식의 표, M-7) — 검사 단계에서 돌아올 수 있게 숨겨 둔 채 남긴다 ── */}
        {workbook && (
          <div style={step === 'map' ? undefined : { display: 'none' }}>
            <SheetMapper db={db} dataVersion={dataVersion} workbook={workbook} onBack={resetToUpload} onDone={handleMapped} />
            {step === 'map' && error && <p className="error-msg">{error}</p>}
          </div>
        )}

        {/* ── 충돌/오류 단계 ───────────────────────────────────── */}
        {step === 'conflict' && (
          <div className="tx-form">
            {hardErrors.length > 0 && (
              <div className="conflict-section conflict-section--error">
                <p className="conflict-title">
                  {hardErrors.length}건 건너뜀 — 필수 필드 오류
                </p>
                <div className="conflict-list">
                  {hardErrors.map(({ label, fields }, i) => (
                    <div key={`${label}|${i}`} className="conflict-item">
                      <span className="conflict-row">{label}</span>
                      <span className="conflict-desc">{fields.join(' / ')}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {missingAll && hasAnyMissing(missingAll) && (
              <div className="conflict-section conflict-section--warn">
                <p className="conflict-title">
                  다음 항목이 없습니다. 가져올 때 함께 추가됩니다.
                </p>
                <p className="conflict-subtitle">
                  아직 아무것도 바뀌지 않았습니다. 미리보기에서 <strong>가져오기</strong>를 눌러야 추가되며, 취소하면 그대로입니다.
                </p>
                <div className="conflict-list">
                  {missingAll.paymentMethods.map(name => (
                    <div key={`pm|${name}`} className="conflict-item">
                      <span className="badge badge-cat">결제수단</span>
                      <span className="conflict-desc">{name}</span>
                    </div>
                  ))}
                  {missingAll.categories.map(name => (
                    <div key={`cat|${name}`} className="conflict-item">
                      <span className="badge badge-cat">카테고리</span>
                      <span className="conflict-desc">{name}</span>
                    </div>
                  ))}
                  {missingAll.subCategories.map(({ budget_category, name }) => (
                    <div key={`sub|${budget_category}|${name}`} className="conflict-item">
                      <span className="badge badge-subcat">세부카테고리</span>
                      <span className="conflict-desc">{budget_category} › {name}</span>
                    </div>
                  ))}
                  {missingAll.trips.map(({ key, name, schedule }) => (
                    <div key={`trip|${key}`} className="conflict-item">
                      <span className="badge badge-trip">여행 일정</span>
                      <span className="conflict-desc">
                        {name}{schedule ? ` (${schedule})` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {rows.length > 0 ? (
              <p className="import-info" style={{ marginTop: '4px' }}>
                유효한 거래 <strong>{rows.length}건</strong>
                {hardErrors.length > 0 && ` (${hardErrors.length}건 건너뜀)`}
              </p>
            ) : (
              <p className="import-info conflict-all-failed" style={{ marginTop: '4px' }}>
                가져올 수 있는 거래가 없습니다. 위 오류를 수정 후 다시 시도해주세요.
              </p>
            )}

            {error && <p className="error-msg">{error}</p>}

            <div className="form-actions">
              {backToMapping || <button className="btn-secondary" onClick={resetToUpload}>다시 선택</button>}
              {rows.length > 0 && (
                <button className="btn-primary" onClick={() => setStep('preview')}>
                  미리보기
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── 미리보기 단계 ────────────────────────────────────── */}
        {step === 'preview' && (
          <div className="tx-form">
            <p className="import-info">
              <strong>{rowsToImport.length}건</strong> 가져오기 예정
              {hardErrors.length > 0 && (
                <span className="import-skip-note"> ({hardErrors.length}건 오류로 건너뜀)</span>
              )}
              {missingToAdd && hasAnyMissing(missingToAdd) && (
                <><br />함께 추가: {missingSummary(missingToAdd)}</>
              )}
            </p>

            {duplicateCount > 0 && (
              <label className="import-info" style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="checkbox" checked={includeDuplicates} onChange={e => setIncludeDuplicates(e.target.checked)} />
                <span>
                  이미 있는 거래와 같은 {duplicateCount}건도 가져오기
                  <span className="import-skip-note"> — 날짜·결제수단·금액·세부내역이 같은 거래가 이미 있습니다. 보통은 체크하지 않습니다.</span>
                </span>
              </label>
            )}

            <div className="import-preview-wrap">
              <table className="import-preview-table">
                <thead>
                  <tr>
                    <th>행</th>
                    <th>날짜</th>
                    <th>결제수단</th>
                    <th>카테고리</th>
                    <th>세부카테고리</th>
                    <th>내역</th>
                    <th>금액</th>
                    <th>할인</th>
                    {hasTrip && <th>여행</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const skipped = row.isDuplicate && !includeDuplicates;
                    return (
                      <tr key={`${row.label}|${i}`} style={skipped ? { opacity: 0.45 } : undefined}>
                        <td className="preview-row-num">{row.label}</td>
                        <td>{row.date}</td>
                        <td>{row.payment_method}</td>
                        <td>{row.budget_category}</td>
                        <td>{row.sub_category || <span className="preview-empty">-</span>}</td>
                        <td className="preview-detail">
                          {row.detail || <span className="preview-empty">-</span>}
                          {row.isDuplicate && <span className="import-skip-note"> (이미 있음)</span>}
                        </td>
                        <td className="preview-amount">{row.amount.toLocaleString()}원</td>
                        <td>{row.discount_amount
                          ? <span className="preview-discount">-{row.discount_amount.toLocaleString()}원</span>
                          : <span className="preview-empty">-</span>}
                        </td>
                        {hasTrip && (
                          <td>{row.trip_name
                            ? <span className="preview-trip">{row.event_id ? row.eventTitle : `${row.trip_name} (새 일정)`}</span>
                            : <span className="preview-empty">-</span>}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {error && <p className="error-msg">{error}</p>}

            <div className="form-actions">
              {backToMapping || <button className="btn-secondary" onClick={resetToUpload}>다시 선택</button>}
              <button className="btn-primary" onClick={handleImport} disabled={importing || rowsToImport.length === 0}>
                {importing ? '가져오는 중...' : rowsToImport.length === 0 ? '새 거래 없음' : `${rowsToImport.length}건 가져오기`}
              </button>
            </div>
          </div>
        )}

        {/* ── 완료 단계 ────────────────────────────────────────── */}
        {step === 'done' && (
          <div className="tx-form">
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <p style={{ fontSize: '18px', fontWeight: '600', marginBottom: '8px' }}>완료!</p>
              <p className="import-info">{importedCount}건이 추가되었습니다.</p>
            </div>
            <div className="form-actions">
              <button className="btn-primary" onClick={onClose}>확인</button>
            </div>
          </div>
        )}
    </ModalOverlay>
  );
}

export default ImportModal;
