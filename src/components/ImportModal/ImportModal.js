import React, { useState } from 'react';
import {
  bulkInsertTransactions,
  ensureCategoriesExist,
  ensureSubCategoriesExist,
  ensureTripsExist,
} from '../../services/dbManager';
import { buildValidationContext, detectIssues } from '../../services/txValidator';
import './ImportModal.css';

// ── CSV 파서 ─────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++;
      let field = '';
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else field += line[i++];
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  if (line.endsWith(',')) fields.push('');
  return fields;
}

function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (values[i] ?? '').trim(); });
    return obj;
  }).filter(row => Object.values(row).some(v => v !== ''));
}

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

function downloadFile(content, filename, mime) {
  const blob = new Blob(['\uFEFF' + content], { type: mime + ';charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── 유효성 검사 ──────────────────────────────────────────────────────
// 필수 필드 형식 오류 (복구 불가 → 해당 행 건너뜀)
// 오류 메시지에 실제 입력값을 포함해 원인을 즉시 파악할 수 있게 한다.
function checkRequiredFields(raw) {
  const errors = [];
  if (!raw.payment_method?.trim()) errors.push('결제수단 없음');
  const dateStr = raw.date?.trim() || '';
  if (!dateStr) {
    errors.push('날짜 없음');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    errors.push(`날짜 형식 오류: "${dateStr}" → YYYY-MM-DD 필요`);
  }
  if (!raw.budget_category?.trim()) errors.push('카테고리 없음');
  const amtNum = Number(String(raw.amount ?? '').replace(/,/g, ''));
  const discountNum = Number(String(raw.discount_amount ?? '0').replace(/,/g, '')) || 0;
  // 할인금액이 있으면 금액 없음/0도 허용 (전액 할인/환급 등)
  if (discountNum <= 0 && (raw.amount === undefined || raw.amount === '' || isNaN(amtNum) || amtNum <= 0)) {
    errors.push(`금액 오류: "${raw.amount ?? ''}" → 양수 필요 (할인금액이 있으면 생략 가능)`);
  }
  return errors;
}

function normalizeRow(raw, rowNum) {
  return {
    rowNum,
    payment_method: raw.payment_method.trim(),
    date: raw.date.trim(),
    budget_category: raw.budget_category.trim(),
    sub_category: raw.sub_category?.trim() || '',
    detail: raw.detail?.trim() || '',
    amount: Math.round(Number(String(raw.amount ?? '0').replace(/,/g, '')) || 0),
    discount_amount: Math.round(Number(String(raw.discount_amount || '0').replace(/,/g, '')) || 0),
    discount_note: raw.discount_note?.trim() || '',
    trip_name: raw.trip_name?.trim() || '',
    trip_schedule: raw.trip_schedule?.trim() || '',
  };
}

/**
 * validateRows: txValidator.detectIssues를 활용해 거래내역 "이슈" 기준과 동일하게 검사한다.
 * - hardErrors: 필수 필드 누락/형식 오류 → 해당 행 건너뜀
 * - missingCategories/SubCategories/Trips: DB에 없는 항목 → 자동 추가 또는 취소 선택
 */
function validateRows(rawRows, validationContext, tripMap) {
  const validRows = [];
  const hardErrors = [];
  const missingCatSet = new Set();
  const missingSubCatMap = new Map();
  const missingTripMap = new Map();

  rawRows.forEach((raw, idx) => {
    const rowNum = idx + 1;
    const fieldErrors = checkRequiredFields(raw);
    if (fieldErrors.length > 0) {
      hardErrors.push({ rowNum, fields: fieldErrors });
      return;
    }

    const row = normalizeRow(raw, rowNum);

    // txValidator.detectIssues와 동일한 기준으로 카테고리/서브카테고리 누락 감지
    const issues = detectIssues(row, validationContext);
    issues.forEach(issue => {
      if (issue.field === 'budget_category') {
        missingCatSet.add(row.budget_category);
      }
      if (issue.field === 'sub_category') {
        const key = `${row.budget_category}|${row.sub_category}`;
        missingSubCatMap.set(key, { budget_category: row.budget_category, name: row.sub_category });
      }
    });

    // 여행 누락 감지 (임포트 전용 — 거래내역 이슈와는 별도)
    if (row.trip_name) {
      const tripKey = `${row.trip_name}|${row.trip_schedule}`;
      if (!tripMap.has(tripKey) && !missingTripMap.has(tripKey)) {
        missingTripMap.set(tripKey, { name: row.trip_name, schedule: row.trip_schedule });
      }
    }

    validRows.push(row);
  });

  return {
    validRows,
    hardErrors,
    missingCategories: [...missingCatSet],
    missingSubCategories: [...missingSubCatMap.values()],
    missingTrips: [...missingTripMap.values()],
  };
}

// ── 컴포넌트 ─────────────────────────────────────────────────────────
function ImportModal({ db, onImport, onClose }) {
  const [step, setStep] = useState('upload');
  const [validRows, setValidRows] = useState([]);
  const [hardErrors, setHardErrors] = useState([]);
  const [missing, setMissing] = useState({ categories: [], subCategories: [], trips: [] });
  const [finalRows, setFinalRows] = useState([]);
  const [tripNameById, setTripNameById] = useState({});
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [importedCount, setImportedCount] = useState(0);

  const loadTripMap = () => {
    const tripRes = db.exec("SELECT id, name, COALESCE(schedule, '') FROM trips");
    const tripMap = new Map();
    const nameById = {};
    (tripRes[0]?.values || []).forEach(([id, name, schedule]) => {
      tripMap.set(`${name}|${schedule}`, id);
      nameById[id] = name;
    });
    return { tripMap, nameById };
  };

  const resolveTripIds = (rows, tripMap, nameById) => {
    return rows.map(({ trip_name, trip_schedule, rowNum: _rn, ...rest }) => {
      let trip_id = null;
      if (trip_name) {
        trip_id = tripMap.get(`${trip_name}|${trip_schedule}`) ?? null;
        if (trip_id) nameById[trip_id] = trip_name;
      }
      return { ...rest, trip_id };
    });
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const text = evt.target?.result;
        if (typeof text !== 'string') { setError('파일을 읽을 수 없습니다.'); return; }

        let rawRows = [];
        const name = file.name.toLowerCase();
        if (name.endsWith('.json')) {
          const data = JSON.parse(text.replace(/^\uFEFF/, ''));
          if (!Array.isArray(data)) { setError('JSON은 배열 형식이어야 합니다.'); return; }
          rawRows = data;
        } else if (name.endsWith('.csv')) {
          rawRows = parseCSV(text);
        } else {
          setError('JSON 또는 CSV 파일을 업로드해주세요.');
          return;
        }

        if (rawRows.length === 0) { setError('데이터가 없습니다.'); return; }

        // txValidator.buildValidationContext와 동일한 컨텍스트 사용
        const validationContext = buildValidationContext(db);
        const { tripMap, nameById } = loadTripMap();
        const result = validateRows(rawRows, validationContext, tripMap);

        setValidRows(result.validRows);
        setHardErrors(result.hardErrors);

        // 유효 행이 0개여도 충돌 단계로 이동해 어떤 행이 왜 실패했는지 표시한다
        if (result.validRows.length === 0 && result.hardErrors.length > 0) {
          setMissing({ categories: [], subCategories: [], trips: [] });
          setStep('conflict');
          return;
        }

        if (result.validRows.length === 0) {
          setError('데이터를 인식할 수 없습니다. 파일 형식(JSON/CSV)을 확인해주세요.');
          return;
        }

        const hasMissing =
          result.missingCategories.length > 0 ||
          result.missingSubCategories.length > 0 ||
          result.missingTrips.length > 0;

        if (hasMissing || result.hardErrors.length > 0) {
          setMissing({
            categories: result.missingCategories,
            subCategories: result.missingSubCategories,
            trips: result.missingTrips,
          });
          setStep('conflict');
        } else {
          const resolved = resolveTripIds(result.validRows, tripMap, nameById);
          setTripNameById({ ...nameById });
          setFinalRows(resolved);
          setStep('preview');
        }
      } catch (err) {
        setError(`파일 읽기 오류: ${err.message}`);
      }
    };
    reader.readAsText(file, 'UTF-8');
  };

  const handleAutoAdd = () => {
    try {
      db.run('BEGIN');
      if (missing.categories.length > 0) ensureCategoriesExist(db, missing.categories);
      if (missing.subCategories.length > 0) ensureSubCategoriesExist(db, missing.subCategories);
      if (missing.trips.length > 0) ensureTripsExist(db, missing.trips);
      db.run('COMMIT');
    } catch (err) {
      db.run('ROLLBACK');
      setError(`자동 추가 오류: ${err.message}`);
      return;
    }

    const { tripMap, nameById } = loadTripMap();
    const resolved = resolveTripIds(validRows, tripMap, nameById);
    setTripNameById(nameById);
    setFinalRows(resolved);
    setStep('preview');
  };

  const handleSkipToPreview = () => {
    const { tripMap, nameById } = loadTripMap();
    const resolved = resolveTripIds(validRows, tripMap, nameById);
    setTripNameById(nameById);
    setFinalRows(resolved);
    setStep('preview');
  };

  const handleImport = async () => {
    if (importing) return;
    setImporting(true);
    try {
      bulkInsertTransactions(db, finalRows);
      setImportedCount(finalRows.length);
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
    setValidRows([]);
    setHardErrors([]);
    setMissing({ categories: [], subCategories: [], trips: [] });
    setFinalRows([]);
    setImporting(false);
  };

  const hasMissing =
    missing.categories.length > 0 ||
    missing.subCategories.length > 0 ||
    missing.trips.length > 0;

  const hasTrip = finalRows.some(r => r.trip_id);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>거래내역 가져오기</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* ── 업로드 단계 ──────────────────────────────────────── */}
        {step === 'upload' && (
          <div className="tx-form">
            <p className="import-info">
              <strong>JSON</strong> 또는 <strong>CSV</strong> 파일을 업로드하세요.<br />
              양식을 먼저 다운로드해 작성하시면 편리합니다.
            </p>

            <div className="import-template-section">
              <p className="import-template-label">양식 파일 다운로드</p>
              <div className="import-template-buttons">
                <button
                  className="btn-template"
                  onClick={() => downloadFile(JSON_TEMPLATE, '거래내역_양식.json', 'application/json')}
                >
                  JSON 양식
                </button>
                <button
                  className="btn-template"
                  onClick={() => downloadFile(CSV_TEMPLATE, '거래내역_양식.csv', 'text/csv')}
                >
                  CSV 양식
                </button>
              </div>
              <p className="import-template-note">
                JSON 양식의 <code>_no</code> 필드는 행 번호 표시용이며 가져오기 시 무시됩니다.
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
                  <tr><td>trip_name</td><td><span className="badge badge-travel">여행</span></td><td>여행 이름</td></tr>
                  <tr><td>trip_schedule</td><td><span className="badge badge-travel">여행</span></td><td>여행 일정 (예: 2026-01-18 ~ 01-22)</td></tr>
                  <tr><td>_no</td><td><span className="badge badge-info">참고</span></td><td>행 번호 (JSON 전용, 가져오기 시 무시)</td></tr>
                </tbody>
              </table>
            </div>

            <input
              type="file"
              accept=".json,.csv"
              onChange={handleFileChange}
              className="import-file-input"
            />
            {error && <p className="error-msg">{error}</p>}
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
                  {hardErrors.map(({ rowNum, fields }) => (
                    <div key={rowNum} className="conflict-item">
                      <span className="conflict-row">{rowNum}행</span>
                      <span className="conflict-desc">{fields.join(' / ')}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {hasMissing && (
              <div className="conflict-section conflict-section--warn">
                <p className="conflict-title">
                  다음 항목이 없습니다. 자동으로 추가하시겠습니까?
                </p>
                <p className="conflict-subtitle">
                  추가 후 거래내역 목록의 <strong>이슈</strong> 필터로 확인할 수 있습니다.
                </p>
                <div className="conflict-list">
                  {missing.categories.map(name => (
                    <div key={name} className="conflict-item">
                      <span className="badge badge-cat">카테고리</span>
                      <span className="conflict-desc">{name}</span>
                    </div>
                  ))}
                  {missing.subCategories.map(({ budget_category, name }) => (
                    <div key={`${budget_category}|${name}`} className="conflict-item">
                      <span className="badge badge-subcat">세부카테고리</span>
                      <span className="conflict-desc">{budget_category} › {name}</span>
                    </div>
                  ))}
                  {missing.trips.map(({ name, schedule }) => (
                    <div key={`${name}|${schedule}`} className="conflict-item">
                      <span className="badge badge-trip">여행</span>
                      <span className="conflict-desc">
                        {name}{schedule ? ` (${schedule})` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {validRows.length > 0 ? (
              <p className="import-info" style={{ marginTop: '4px' }}>
                유효한 거래 <strong>{validRows.length}건</strong>
                {hardErrors.length > 0 && ` (${hardErrors.length}건 건너뜀)`}
              </p>
            ) : (
              <p className="import-info conflict-all-failed" style={{ marginTop: '4px' }}>
                가져올 수 있는 거래가 없습니다. 위 오류를 수정 후 다시 시도해주세요.
              </p>
            )}

            {error && <p className="error-msg">{error}</p>}

            <div className="form-actions">
              <button className="btn-secondary" onClick={resetToUpload}>다시 선택</button>
              {validRows.length > 0 && (
                hasMissing ? (
                  <button className="btn-primary" onClick={handleAutoAdd}>
                    자동 추가 후 미리보기
                  </button>
                ) : (
                  <button className="btn-primary" onClick={handleSkipToPreview}>
                    미리보기
                  </button>
                )
              )}
            </div>
          </div>
        )}

        {/* ── 미리보기 단계 ────────────────────────────────────── */}
        {step === 'preview' && (
          <div className="tx-form">
            <p className="import-info">
              <strong>{finalRows.length}건</strong> 가져오기 예정
              {hardErrors.length > 0 && (
                <span className="import-skip-note"> ({hardErrors.length}건 건너뜀)</span>
              )}
            </p>

            <div className="import-preview-wrap">
              <table className="import-preview-table">
                <thead>
                  <tr>
                    <th>#</th>
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
                  {finalRows.map((row, idx) => (
                    <tr key={idx}>
                      <td className="preview-row-num">{idx + 1}</td>
                      <td>{row.date}</td>
                      <td>{row.payment_method}</td>
                      <td>{row.budget_category}</td>
                      <td>{row.sub_category || <span className="preview-empty">-</span>}</td>
                      <td className="preview-detail">{row.detail || <span className="preview-empty">-</span>}</td>
                      <td className="preview-amount">{row.amount.toLocaleString()}원</td>
                      <td>{row.discount_amount
                        ? <span className="preview-discount">-{row.discount_amount.toLocaleString()}원</span>
                        : <span className="preview-empty">-</span>}
                      </td>
                      {hasTrip && (
                        <td>{row.trip_id
                          ? <span className="preview-trip">{tripNameById[row.trip_id] || '✓'}</span>
                          : <span className="preview-empty">-</span>}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {error && <p className="error-msg">{error}</p>}

            <div className="form-actions">
              <button className="btn-secondary" onClick={resetToUpload}>다시 선택</button>
              <button className="btn-primary" onClick={handleImport} disabled={importing}>
                {importing ? '가져오는 중...' : `${finalRows.length}건 가져오기`}
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
      </div>
    </div>
  );
}

export default ImportModal;
