import React, { useState } from 'react';
import { bulkInsertTransactions } from '../services/dbManager';

function ImportModal({ db, onImport, onClose }) {
  const [step, setStep] = useState('upload');
  const [parsed, setParsed] = useState({ rows: [], skipped: 0 });
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

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

        let rows = [];
        let skipped = 0;

        // 파일 확장자로 JSON 또는 CSV 판별
        if (file.name.endsWith('.json')) {
          // JSON 파싱
          const data = JSON.parse(text);
          if (!Array.isArray(data)) {
            setError('JSON은 배열 형식이어야 합니다.');
            return;
          }
          rows = data.filter(item => {
            // 필수 필드 검증
            if (!item.payment_method || !item.date || !item.budget_category || item.amount === undefined) {
              skipped++;
              return false;
            }
            // 기본값 채우기
            return true;
          }).map(item => ({
            payment_method: item.payment_method,
            date: item.date,
            budget_category: item.budget_category,
            sub_category: item.sub_category || '',
            detail: item.detail || '',
            amount: parseInt(item.amount, 10),
            discount_amount: parseInt(item.discount_amount || 0, 10),
          }));
        } else {
          // CSV 파싱은 생략 (JSON만 사용하기로 함)
          setError('JSON 파일을 업로드해주세요.');
          return;
        }

        if (rows.length === 0) {
          setError('인식 가능한 거래 데이터가 없습니다. JSON 형식을 확인해주세요.');
          return;
        }

        setParsed({ rows, skipped });
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
              <strong>JSON 파일</strong>을 업로드하세요.<br />
              자동으로 파싱되어 거래 내역에 추가됩니다.
            </p>
            <input
              type="file"
              accept=".json"
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
