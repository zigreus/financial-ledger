import React, { useState } from 'react';
import { bulkInsertTransactions } from '../services/dbManager';

function ImportModal({ db, onImport, onClose }) {
  const [step, setStep] = useState('upload');
  const [parsed, setParsed] = useState({ rows: [], skipped: 0 });
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  // CSV 파싱 로직
  // 엑셀 구조: A(이용일) | B(결제수단/카드명) | C(카테고리) | D(세부카테고리) | E(금액) | F(할인/수익) | G(비고)
  const parseCSV = (text) => {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line);
    const rows = [];
    let skipped = 0;
    let currentPaymentMethod = null;

    // 알려진 결제수단 목록 (이것이 B열에 나오면 카드 그룹 헤더로 인식)
    const knownPaymentMethods = ['현금', '삼성카드', '신한카드', '하나카드', 'KB국민카드', '롯데카드', '카카오페이', '네이버페이', '토스페이'];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const cells = line.split(',').map(cell => cell.trim());

      if (cells.length < 3) {
        skipped++;
        continue;
      }

      const aCell = cells[0];  // 이용일 또는 비움
      const bCell = cells[1];  // 결제수단/카드명 또는 결제수단 반복
      const cCell = cells[2];  // 카테고리
      const dCell = cells[3];  // 세부카테고리
      const eCell = cells[4];  // 금액
      const fCell = cells[5];  // 할인/수익
      const gCell = cells[6];  // 비고

      // B열이 알려진 결제수단 이름이고 A열이 비어있으면 → 카드 그룹 헤더
      if (knownPaymentMethods.includes(bCell) && !aCell) {
        currentPaymentMethod = bCell;
        continue;
      }

      // A열에 날짜 패턴 (YYYY-MM-DD 또는 YYMMDD) → 거래 내역
      if (/^\d{4}-\d{2}-\d{2}|^\d{6}/.test(aCell)) {
        if (!currentPaymentMethod) {
          skipped++;
          continue;
        }

        try {
          let date = aCell;

          // YYMMDD 형식을 YYYY-MM-DD로 변환
          if (/^\d{6}$/.test(aCell)) {
            const match = aCell.match(/^(\d{2})(\d{2})(\d{2})/);
            if (match) {
              const yy = parseInt(match[1], 10);
              const mm = match[2];
              const dd = match[3];
              const year = 2000 + yy;
              date = `${year}-${mm}-${dd}`;
            } else {
              skipped++;
              continue;
            }
          }

          // 금액 추출: 쉼표 제거, "원" 제거
          const amountStr = eCell.replace(/,/g, '').replace(/원/g, '').trim();
          const amount = parseInt(amountStr, 10);

          if (isNaN(amount) || amount <= 0) {
            skipped++;
            continue;
          }

          // 할인/수익 추출: 쉼표 제거, "-" 또는 "원" 제거
          let discountAmount = 0;
          if (fCell && fCell !== '-') {
            const discountStr = fCell.replace(/,/g, '').replace(/원/g, '').replace(/-/g, '').trim();
            discountAmount = parseInt(discountStr, 10) || 0;
          }

          // 카테고리가 없으면 기타
          const category = cCell || '기타';

          rows.push({
            payment_method: currentPaymentMethod,
            date,
            budget_category: category,
            sub_category: dCell || '',
            detail: '',
            amount,
            discount_amount: discountAmount,
            discount_note: gCell || '',
          });
        } catch (e) {
          skipped++;
        }
        continue;
      }

      // 인식하지 못한 행
      if (aCell || bCell || cCell) {  // 최소 하나라도 값이 있으면 건너뜸
        skipped++;
      }
    }

    return { rows, skipped };
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const text = evt.target?.result;
        if (typeof text !== 'string') {
          setError('파일을 읽을 수 없습니다.');
          return;
        }

        const result = parseCSV(text);
        if (result.rows.length === 0) {
          setError('인식 가능한 거래 데이터가 없습니다. CSV 형식을 확인해주세요.');
          return;
        }

        setParsed(result);
        setError('');
        setStep('preview');
      } catch (err) {
        setError(`파일 읽기 오류: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (importing) return;
    setImporting(true);
    try {
      bulkInsertTransactions(db, parsed.rows);
      onImport();
      setStep('done');
    } catch (err) {
      setError(`가져오기 오류: ${err.message}`);
      setImporting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>CSV 가져오기</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {step === 'upload' && (
          <form className="tx-form" onSubmit={e => e.preventDefault()}>
            <p className="import-info">
              엑셀을 <strong>CSV (쉼표로 구분)</strong>로 저장하여 업로드하세요.<br />
              자동으로 파싱되어 거래 내역에 추가됩니다.
            </p>
            <input
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              style={{
                padding: '12px',
                border: '1.5px solid var(--border)',
                borderRadius: '10px',
                width: '100%',
              }}
            />
            {error && <p className="error-msg">{error}</p>}
          </form>
        )}

        {step === 'preview' && (
          <div className="tx-form">
            <p className="import-info">
              총 <strong>{parsed.rows.length}건</strong> 인식{parsed.skipped > 0 && `, ${parsed.skipped}건 건너뜀`}
            </p>

            {/* 미리보기 테이블 */}
            <div style={{ overflowX: 'auto', marginBottom: '16px' }}>
              <table className="import-preview-table">
                <thead>
                  <tr>
                    <th>날짜</th>
                    <th>결제수단</th>
                    <th>카테고리</th>
                    <th>세부</th>
                    <th>금액</th>
                    <th>할인</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 5).map((row, idx) => (
                    <tr key={idx}>
                      <td>{row.date}</td>
                      <td>{row.payment_method}</td>
                      <td>{row.budget_category}</td>
                      <td style={{ maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.detail}</td>
                      <td>{row.amount.toLocaleString()}원</td>
                      <td>{row.discount_amount ? `-${row.discount_amount.toLocaleString()}원` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {error && <p className="error-msg">{error}</p>}

            <div className="form-actions">
              <button className="btn-secondary" onClick={() => { setStep('upload'); setError(''); }}>다시 선택</button>
              <button className="btn-primary" onClick={handleImport} disabled={importing}>
                {importing ? '가져오는 중...' : `${parsed.rows.length}건 가져오기`}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="tx-form">
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <p style={{ fontSize: '18px', fontWeight: '600', marginBottom: '8px' }}>✓ 완료!</p>
              <p className="import-info">{parsed.rows.length}건이 추가되었습니다.</p>
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
