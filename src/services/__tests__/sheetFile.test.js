/**
 * @vitest-environment jsdom
 */
// 표 파일 읽기 (I-034, ROADMAP M-7) — CSV 인코딩·구분 문자, xlsx(zip), HTML 표 .xls, 예전 .xls 안내
import { decodeText, readDelimitedText, readXlsx, readHtmlTables, readSheetFile, readZipEntries, columnIndex, columnLetter, SheetFileError, MAX_ROWS } from '../sheetFile';

const enc = s => new TextEncoder().encode(s);

// ── zip 만들기(테스트용) — stored 또는 deflate ───────────────────────
async function deflateRaw(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function makeZip(files, { deflate = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc(name);
    const raw = typeof content === 'string' ? enc(content) : content;
    const data = deflate ? await deflateRaw(raw) : raw;
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    parts.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let p = 0;
  all.forEach((part) => { out.set(part, p); p += part.length; });
  return out;
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
export function xlsxFiles({ sheets, shared = [], date1904 = false }) {
  const files = {
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS}>${date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${
      sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.hidden ? ' state="hidden"' : ''}/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${NS}>${shared.map(t => `<si>${t}</si>`).join('')}</sst>`,
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0"?><worksheet ${NS}><sheetData>${s.xml}</sheetData></worksheet>`; });
  return files;
}

const book = xlsxFiles({
  shared: ['<t>날짜</t>', '<t>내용</t>', '<t>금액</t>', '<r><t>스타</t></r><r><t>벅스</t></r><rPh><t>스타벅스</t></rPh>', '<t>메모</t>'],
  sheets: [
    {
      name: '2024년 가계부',
      // 빈 칸(B 없이 C), 날짜는 일련번호, 수식 문자열, 인라인 문자열, 숫자
      xml: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>4</v></c></row>'
        + '<row r="2"><c r="A2"><v>45356</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>4500</v></c><c r="D2" t="inlineStr"><is><t>아메리카노</t></is></c></row>'
        + '<row r="4"><c r="A4"><v>45357</v></c><c r="C4"><f>1000*2</f><v>2000</v></c><c r="D4" t="str"><f>"a"&amp;"b"</f><v>ab</v></c></row>',
    },
    { name: '숨김', hidden: true, xml: '<row r="1"><c r="A1"><v>1</v></c></row>' },
    { name: '두번째', xml: '<row r="1"><c r="B1" t="s"><v>2</v></c></row>' },
  ],
});

describe('글자 인코딩', () => {
  test('UTF-8(BOM 있음·없음), EUC-KR(한국어 엑셀 CSV), UTF-16LE(엑셀 유니코드 텍스트)', () => {
    expect(decodeText(new Uint8Array([0xEF, 0xBB, 0xBF, ...enc('날짜,금액')]))).toBe('날짜,금액');
    expect(decodeText(enc('날짜,금액'))).toBe('날짜,금액');
    expect(decodeText(new Uint8Array([0xb3, 0xaf, 0xc2, 0xa5, 0x2c, 0xb1, 0xdd, 0xbe, 0xd7]))).toBe('날짜,금액');
    const utf16 = new Uint8Array([0xFF, 0xFE, ...Array.from('날짜\t금액').flatMap(ch => [ch.charCodeAt(0) & 0xFF, ch.charCodeAt(0) >> 8])]);
    expect(decodeText(utf16)).toBe('날짜\t금액');
  });

  test('칸 구분 문자 — 탭·세미콜론도 고르고, 내용 속 쉼표에 흔들리지 않는다', () => {
    expect(readDelimitedText('날짜\t내용\t금액\n2024-03-05\t점심, 김밥\t5000\n').sheets[0].rows[1]).toEqual(['2024-03-05', '점심, 김밥', '5000']);
    expect(readDelimitedText('날짜;금액\n2024-03-05;5000\n').sheets[0].rows[1]).toEqual(['2024-03-05', '5000']);
    expect(readDelimitedText('날짜,내용,금액\n2024-03-05,"점심, 김밥",5000\n').sheets[0].rows[1]).toEqual(['2024-03-05', '점심, 김밥', '5000']);
  });
});

describe('xlsx', () => {
  test('열 글자 ↔ 번호', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AB12')).toBe(27);
    expect(columnLetter(27)).toBe('AB');
  });

  test.each([false, true])('시트·공유 문자열·빈 칸·빈 줄·수식 값을 읽고 숨긴 시트는 뺀다 (압축 %s)', async (deflate) => {
    const { sheets, date1904 } = await readXlsx(await makeZip(book, { deflate }));
    expect(date1904).toBe(false);
    expect(sheets.map(s => s.name)).toEqual(['2024년 가계부', '두번째']);
    expect(sheets[0].rows).toEqual([
      ['날짜', '내용', '금액', '메모'],
      [45356, '스타벅스', 4500, '아메리카노'],
      [],
      [45357, '', 2000, 'ab'],
    ]);
    expect(sheets[1].rows).toEqual([['', '금액']]);
  });

  test('값 없는 공유 문자열 칸은 비우고, 위치(r) 없는 칸은 앞 칸 다음에 둔다', async () => {
    const files = xlsxFiles({
      shared: ['<t>첫째</t>', '<t>둘째</t>'],
      sheets: [{ name: 'a', xml: '<row r="1"><c r="B1" t="s"><v>1</v></c><c t="s"><v>0</v></c><c r="E1" t="s"/></row>' }],
    });
    const { sheets } = await readXlsx(await makeZip(files));
    expect(sheets[0].rows).toEqual([['', '둘째', '첫째', '', '']]);
  });

  test('1904 날짜 체계를 알린다', async () => {
    const { date1904 } = await readXlsx(await makeZip(xlsxFiles({ date1904: true, sheets: [{ name: 'a', xml: '' }] })));
    expect(date1904).toBe(true);
  });

  test('zip이 아니거나 엑셀이 아니면 안내 오류', async () => {
    expect(() => readZipEntries(enc('hello world, not a zip file at all......'))).toThrow(SheetFileError);
    await expect(readXlsx(await makeZip({ 'word/document.xml': '<x/>' }))).rejects.toThrow('엑셀 통합 문서(xlsx)가 아닙니다');
  });
});

describe('파일 → 시트', () => {
  const file = (name, bytes) => ({ name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });

  test('은행 .xls가 실제로는 HTML 표면 표로 읽는다', async () => {
    const html = '<html><body><table><tr><td>조회</td></tr></table><table><tr><th>거래일자</th><th>적요</th><th>출금액</th></tr>'
      + '<tr><td>2024.03.05</td><td> 편의점 </td><td>3,000</td></tr></table></body></html>';
    const { sheets } = await readSheetFile(file('내역.xls', enc(html)));
    expect(sheets).toHaveLength(1);
    expect(sheets[0].rows).toEqual([['거래일자', '적요', '출금액'], ['2024.03.05', '편의점', '3,000']]);
    expect(readHtmlTables(html).sheets[0].name).toBe('표 1');
  });

  test('표 안의 표 — 안쪽 칸이 바깥 줄에 섞이지 않는다', () => {
    const html = '<table><tr><td>날짜</td><td>금액</td></tr><tr><td>2024-03-05</td><td>1000<table><tr><td>속</td></tr><tr><td>표</td></tr></table></td></tr></table>';
    const { sheets } = readHtmlTables(html);
    expect(sheets[0].rows).toEqual([['날짜', '금액'], ['2024-03-05', '1000속표']]);
    expect(sheets[1].rows).toEqual([['속'], ['표']]);
  });

  test('엑셀 2003 XML(.xls로 내려받은 은행 내역)도 읽는다 — 건너뛴 칸(Index)·숫자·날짜', async () => {
    const xml = '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">'
      + '<Worksheet ss:Name="거래내역"><Table>'
      + '<Row><Cell><Data ss:Type="String">거래일</Data></Cell><Cell><Data ss:Type="String">적요</Data></Cell><Cell ss:Index="4"><Data ss:Type="String">출금</Data></Cell></Row>'
      + '<Row><Cell><Data ss:Type="DateTime">2024-03-05T00:00:00.000</Data></Cell><Cell><Data ss:Type="String">편의점</Data></Cell><Cell ss:Index="4"><Data ss:Type="Number">3000</Data></Cell></Row>'
      + '</Table></Worksheet></Workbook>';
    const { sheets } = await readSheetFile(file('내역.xls', enc(xml)));
    expect(sheets[0].name).toBe('거래내역');
    expect(sheets[0].rows).toEqual([['거래일', '적요', '', '출금'], ['2024-03-05', '편의점', '', 3000]]);
  });

  test('너무 긴 파일은 앞부분만 읽고 전체 줄 수를 알린다', () => {
    const lines = ['날짜,금액', ...Array.from({ length: MAX_ROWS + 5 }, (_, i) => `2024-03-01,${i}`)];
    const { sheets } = readDelimitedText(lines.join('\n'));
    expect(sheets[0].rows).toHaveLength(MAX_ROWS);
    expect(sheets[0].totalRows).toBe(MAX_ROWS + 6);
  });

  test('예전 엑셀 이진 형식(.xls)은 xlsx·CSV로 저장해 달라고 안내한다', async () => {
    await expect(readSheetFile(file('a.xls', new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0]))))
      .rejects.toThrow('예전 엑셀 형식(.xls)은 읽을 수 없습니다');
  });

  test('CSV는 파일 이름을 시트 이름으로, xlsx는 zip 표시로 알아본다', async () => {
    const csv = await readSheetFile(file('카드내역.csv', new Uint8Array([0xb3, 0xaf, 0xc2, 0xa5, 0x2c, 0xb1, 0xdd, 0xbe, 0xd7])));
    expect(csv.sheets[0]).toEqual({ name: '카드내역', rows: [['날짜', '금액']], totalRows: 1 });
    const xlsx = await readSheetFile(file('이름이이상함.dat', await makeZip(book)));
    expect(xlsx.sheets[0].name).toBe('2024년 가계부');
  });
});
