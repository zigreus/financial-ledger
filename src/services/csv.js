/**
 * CSV 파서 (거래 가져오기·계좌 내역 불러오기 공통)
 *
 * RFC 4180 방식: 따옴표로 감싼 칸 안의 쉼표·줄바꿈, 따옴표 두 개("")로 쓴 따옴표를 지원한다.
 * 엑셀에서 저장한 파일의 BOM과 CRLF 줄바꿈도 처리한다.
 */

/**
 * CSV 텍스트를 레코드(칸 문자열 배열) 목록으로 나눈다.
 * 따옴표 안의 줄바꿈은 레코드를 나누지 않는다 — 한 레코드가 여러 줄일 수 있다.
 */
export function parseCSVRecords(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += c;
    }
  }
  // 마지막 줄에 줄바꿈이 없는 경우
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/**
 * 첫 레코드를 헤더로 보고, 나머지를 { rowNumber, fields } 목록으로 돌려준다.
 *  - rowNumber: 스프레드시트에서 보이는 행 번호 (헤더가 1행, 빈 행도 센다)
 *  - fields: { 헤더: 값 } (앞뒤 공백 제거)
 * 모든 칸이 빈 행은 건너뛴다.
 */
export function parseCSV(text) {
  const records = parseCSVRecords(text);
  if (records.length < 2) return [];
  const headers = records[0].map(h => h.trim());
  const rows = [];
  records.slice(1).forEach((values, i) => {
    const fields = {};
    headers.forEach((h, j) => { fields[h] = (values[j] ?? '').trim(); });
    if (Object.values(fields).some(v => v !== '')) {
      rows.push({ rowNumber: i + 2, fields });
    }
  });
  return rows;
}
