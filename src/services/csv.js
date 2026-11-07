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

// 엑셀이 =, +, -, @ 로 시작하는 칸을 수식으로 실행하지 않게 앞에 ' 를 붙인다 (CSV 수식 주입 방지).
// 가져오기는 이 ' 를 다시 떼어 내보낸 파일을 그대로 다시 가져올 수 있게 한다.
const FORMULA_START = /^[=+\-@\t\r]/;

/** 글자 칸을 엑셀에 안전하게 — 수식으로 읽힐 값이면 ' 를 붙인다 */
export function escapeSpreadsheetText(value) {
  return typeof value === 'string' && FORMULA_START.test(value) ? `'${value}` : value;
}

/** escapeSpreadsheetText로 붙인 ' 를 뗀다 */
export function unescapeSpreadsheetText(value) {
  return typeof value === 'string' && value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}

/** 칸 하나를 CSV용으로 — 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싸고, 따옴표는 두 번 쓴다 */
function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 헤더와 행(객체 목록)으로 CSV 텍스트를 만든다. parseCSV로 다시 읽으면 같은 값이 나온다.
 * 엑셀이 한글을 바로 읽도록 BOM은 내려받을 때 붙인다.
 */
export function toCSV(headers, rows) {
  const lines = [headers.map(csvField).join(',')];
  rows.forEach(row => lines.push(headers.map(h => csvField(row[h])).join(',')));
  return lines.join('\r\n') + '\r\n';
}
