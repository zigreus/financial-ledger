/**
 * 표 파일 읽기 (I-034, ROADMAP M-7) — 사람마다 다른 엑셀 가계부·은행·카드·다른 앱 내보내기를 '시트(행 × 칸)'로 읽는다.
 * 어떤 열이 무엇인지는 sheetImport.js(규칙·저장한 형식)와 importAI.js(AI 추천)가 맞춘다.
 *
 *  - CSV·TSV·TXT: 글자 인코딩을 알아낸다(BOM → UTF-8 → 한국어 엑셀의 EUC-KR/CP949), 칸 구분 문자(쉼표·탭·세미콜론)도
 *  - XLSX: zip을 브라우저 내장 압축 풀기(DecompressionStream)로 열어 시트마다 읽는다 — 라이브러리를 더하지 않는다.
 *    날짜 칸은 엑셀 일련번호(숫자)로 남긴다(날짜 열로 고르면 sheetImport가 날짜로 바꾼다). 1904 날짜 체계도 알린다.
 *  - 은행·카드사의 '엑셀 내려받기' 중 실제로는 HTML 표인 .xls: 표마다 시트로 읽는다
 *  - 예전 엑셀 형식(.xls 이진 파일)은 읽지 못한다 — xlsx나 CSV로 저장해 달라고 안내한다
 *
 * 반환 모양: { sheets: [{ name, rows: (string|number)[][], totalRows }], date1904 }
 *  - totalRows: 상한(MAX_ROWS)을 넘어 앞부분만 읽었을 때 파일의 전체 행 수 — 화면이 알린다(조용히 자르지 않게)
 */
import { parseCSVRecords, detectDelimiter } from './csv';

export const MAX_ROWS = 50000;      // 한 시트에서 읽는 행 상한 — 휴대폰 메모리·한 번에 쌓이는 변경 기록을 지키려고(넘으면 알리고 나눠 올리게)
const MAX_COLS = 60;

/** 상한을 넘은 시트가 있으면 그 시트 — { name, totalRows } */
export const truncatedSheet = book => book.sheets.find(s => s.totalRows > s.rows.length) || null;

export class SheetFileError extends Error {}

const startsWith = (bytes, sig) => sig.every((b, i) => bytes[i] === b);

/** 바이트 → 글자. BOM(UTF-8·UTF-16) → 오류 없는 UTF-8 → EUC-KR(CP949, 한국어 엑셀이 저장하는 CSV) */
export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (startsWith(u8, [0xEF, 0xBB, 0xBF])) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (startsWith(u8, [0xFF, 0xFE])) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (startsWith(u8, [0xFE, 0xFF])) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch (e) {
    return new TextDecoder('euc-kr').decode(u8);
  }
}

const trimRows = rows => rows
  .slice(0, MAX_ROWS)
  .map(r => r.slice(0, MAX_COLS).map(v => (typeof v === 'string' ? v.trim() : v)));
const sheetOf = (name, rows) => ({ name, rows: trimRows(rows), totalRows: rows.length });

/** CSV·TSV 글자 → 시트 하나 */
export function readDelimitedText(text, name = '시트') {
  const records = parseCSVRecords(text, detectDelimiter(text));
  return { sheets: [sheetOf(name, records)], date1904: false };
}

// ── zip ─────────────────────────────────────────────────────────────

/** zip 안의 파일 목록 { 이름 → () => Promise<Uint8Array> } — 중앙 디렉터리를 읽고, 꺼낼 때 압축을 푼다 */
export function readZipEntries(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // 끝부분에서 중앙 디렉터리 끝 표시(0x06054b50)를 찾는다 (주석이 붙을 수 있어 뒤에서부터)
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 0xFFFF); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new SheetFileError('엑셀 파일을 열 수 없습니다(손상되었거나 xlsx가 아님).');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const names = new TextDecoder('utf-8');
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > u8.length || view.getUint32(p, true) !== 0x02014b50) throw new SheetFileError('엑셀 파일의 목록을 읽을 수 없습니다.');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = names.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, async () => {
      const lnameLen = view.getUint16(localOffset + 26, true);
      const lextraLen = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lnameLen + lextraLen;
      const data = u8.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method !== 8) throw new SheetFileError('이 엑셀 파일의 압축 방식은 읽을 수 없습니다.');
      return inflateRaw(data);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data) {
  if (typeof DecompressionStream !== 'function') {
    throw new SheetFileError('이 브라우저에서는 엑셀 파일을 읽을 수 없습니다 — 엑셀에서 CSV로 저장해 올려 주세요.');
  }
  let stream;
  try {
    stream = new Response(data).body.pipeThrough(new DecompressionStream('deflate-raw'));
  } catch (e) {
    throw new SheetFileError('이 브라우저에서는 엑셀 파일을 읽을 수 없습니다 — 엑셀에서 CSV로 저장해 올려 주세요.');
  }
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ── xlsx ────────────────────────────────────────────────────────────

const parseXml = text => new DOMParser().parseFromString(text, 'application/xml');
// 이름공간과 상관없이 태그 이름(로컬 이름)으로 찾는다
const byTag = (node, tag) => Array.from(node.getElementsByTagName('*')).filter(el => el.localName === tag);
const childrenByTag = (node, tag) => Array.from(node.childNodes).filter(el => el.localName === tag);

/** 'AB12' → 27 (0부터) */
export function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(String(ref || '').toUpperCase());
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0 → 'A', 27 → 'AB' */
export function columnLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// 공유 문자열의 글자 — 서식이 섞인 글(<r><t>…</t></r>)과 읽는 법(<rPh>)을 구분한다
const stringItemText = si => childrenByTag(si, 't').map(t => t.textContent).join('')
  + childrenByTag(si, 'r').map(r => childrenByTag(r, 't').map(t => t.textContent).join('')).join('');

export async function readXlsx(bytes) {
  const entries = readZipEntries(bytes);
  const read = async (path) => {
    const get = entries.get(path);
    return get ? new TextDecoder('utf-8').decode(await get()) : null;
  };
  const workbookXml = await read('xl/workbook.xml');
  if (!workbookXml) throw new SheetFileError('엑셀 통합 문서(xlsx)가 아닙니다.');
  const workbook = parseXml(workbookXml);
  const date1904 = byTag(workbook, 'workbookPr').some(el => ['1', 'true'].includes(el.getAttribute('date1904')));

  const relsXml = await read('xl/_rels/workbook.xml.rels');
  const targets = new Map();
  if (relsXml) {
    byTag(parseXml(relsXml), 'Relationship').forEach((rel) => {
      const target = rel.getAttribute('Target') || '';
      targets.set(rel.getAttribute('Id'), target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
    });
  }
  const sharedXml = await read('xl/sharedStrings.xml');
  const shared = sharedXml ? byTag(parseXml(sharedXml), 'si').map(stringItemText) : [];

  const sheets = [];
  const sheetEls = byTag(workbook, 'sheet');
  for (let i = 0; i < sheetEls.length; i += 1) {
    const el = sheetEls[i];
    if (el.getAttribute('state') === 'hidden' || el.getAttribute('state') === 'veryHidden') continue;
    const rid = Array.from(el.attributes).find(a => a.localName === 'id')?.value;
    const path = targets.get(rid) || `xl/worksheets/sheet${i + 1}.xml`;
    // eslint-disable-next-line no-await-in-loop
    const xml = await read(path);
    if (xml) {
      const { rows, totalRows } = readSheetXml(xml, shared);
      sheets.push({ name: el.getAttribute('name') || `시트${i + 1}`, rows, totalRows });
    }
  }
  if (!sheets.length) throw new SheetFileError('엑셀 파일에 읽을 시트가 없습니다.');
  return { sheets, date1904 };
}

function readSheetXml(xml, shared) {
  const doc = parseXml(xml);
  const rows = [];
  let totalRows = 0;
  byTag(doc, 'row').forEach((rowEl, i) => {
    const r = Number(rowEl.getAttribute('r')) || i + 1;
    totalRows = Math.max(totalRows, r);
    if (r > MAX_ROWS) return;
    const cells = [];
    let lastCol = -1;
    childrenByTag(rowEl, 'c').forEach((c) => {
      // 위치(r)가 없는 칸은 앞 칸 바로 다음
      const col = c.getAttribute('r') ? columnIndex(c.getAttribute('r')) : lastCol + 1;
      lastCol = col;
      if (col < 0 || col >= MAX_COLS) return;
      const type = c.getAttribute('t');
      const v = childrenByTag(c, 'v')[0]?.textContent ?? '';
      let value = '';
      if (type === 's') value = v === '' ? '' : (shared[Number(v)] ?? '');
      else if (type === 'inlineStr') value = childrenByTag(c, 'is').map(stringItemText).join('');
      else if (type === 'str') value = v;
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'e') value = '';
      else if (v !== '') value = Number.isFinite(Number(v)) ? Number(v) : v;
      while (cells.length < col) cells.push('');
      cells[col] = typeof value === 'string' ? value.trim() : value;
    });
    while (rows.length < r - 1) rows.push([]);
    rows[r - 1] = cells;
  });
  return { rows, totalRows };
}

// ── HTML 표(.xls로 내려받은 은행·카드 내역) ────────────────────────

export function readHtmlTables(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  // 표의 줄·칸은 그 표의 것만(rows·cells) — 표 안에 표가 있어도 안쪽 칸이 바깥 줄에 섞이지 않게
  const sheets = Array.from(doc.querySelectorAll('table'))
    .map(table => Array.from(table.rows).map(tr => Array.from(tr.cells).map(td => (td.textContent || '').replace(/\s+/g, ' ').trim())))
    // 한 줄짜리 머리 표(조회 조건 등)는 빼고, 내용이 있는 표만
    .filter(rows => rows.filter(r => r.some(v => v !== '')).length >= 2)
    .map((rows, i) => sheetOf(`표 ${i + 1}`, rows));
  if (!sheets.length) throw new SheetFileError('파일에서 표를 찾지 못했습니다.');
  return { sheets, date1904: false };
}

// ── 엑셀 2003 XML(SpreadsheetML) — 일부 은행이 .xls로 내려주는 형식 ──────

export function readSpreadsheetMl(text) {
  const doc = parseXml(text);
  const sheets = byTag(doc, 'Worksheet').map((ws, i) => {
    const name = Array.from(ws.attributes).find(a => a.localName === 'Name')?.value || `시트${i + 1}`;
    const rows = [];
    byTag(ws, 'Row').forEach((rowEl) => {
      const at = Array.from(rowEl.attributes).find(a => a.localName === 'Index')?.value;
      if (at) while (rows.length < Number(at) - 1) rows.push([]);
      const cells = [];
      childrenByTag(rowEl, 'Cell').forEach((cell) => {
        const idx = Array.from(cell.attributes).find(a => a.localName === 'Index')?.value;
        if (idx) while (cells.length < Number(idx) - 1) cells.push('');
        const data = childrenByTag(cell, 'Data')[0];
        const type = data ? Array.from(data.attributes).find(a => a.localName === 'Type')?.value : '';
        const t = (data?.textContent || '').trim();
        // 날짜(2024-03-05T00:00:00.000)는 날짜 부분만, 숫자는 숫자로
        cells.push(type === 'Number' && t !== '' && Number.isFinite(Number(t)) ? Number(t) : (type === 'DateTime' ? t.slice(0, 10) : t));
      });
      rows.push(cells);
    });
    return sheetOf(name, rows);
  }).filter(s => s.rows.some(r => r.some(v => v !== '')));
  if (!sheets.length) throw new SheetFileError('파일에서 표를 찾지 못했습니다.');
  return { sheets, date1904: false };
}

// ── 파일 → 시트 ──────────────────────────────────────────────────────

/** 파일 바이트 — arrayBuffer()가 없는 오래된 브라우저는 FileReader로 */
export function readFileBytes(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then(b => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error || new Error('파일을 읽을 수 없습니다.'));
    reader.readAsArrayBuffer(file);
  });
}

/** File(또는 { name, arrayBuffer() }) → { sheets, date1904 } */
export async function readSheetFile(file) {
  const bytes = await readFileBytes(file);
  const name = String(file.name || '');
  const base = name.replace(/\.[^.]+$/, '') || '시트';
  if (startsWith(bytes, [0x50, 0x4B, 0x03, 0x04])) return readXlsx(bytes);                 // xlsx (zip)
  if (startsWith(bytes, [0xD0, 0xCF, 0x11, 0xE0])) {                                     // 예전 엑셀 이진 형식
    throw new SheetFileError('예전 엑셀 형식(.xls)은 읽을 수 없습니다 — 엑셀에서 "다른 이름으로 저장 › Excel 통합 문서(.xlsx)" 또는 CSV로 저장해 올려 주세요.');
  }
  const text = decodeText(bytes);
  if (/^\s*</.test(text) && /urn:schemas-microsoft-com:office:spreadsheet/i.test(text.slice(0, 4000))) return readSpreadsheetMl(text);
  if (/^\s*</.test(text) && /<table[\s>]/i.test(text)) return readHtmlTables(text);
  if (/\.(xlsx|xlsm)$/i.test(name)) throw new SheetFileError('엑셀 파일을 열 수 없습니다(손상되었거나 xlsx가 아님).');
  return readDelimitedText(text, base);
}
