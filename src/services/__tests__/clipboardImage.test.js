/**
 * @vitest-environment jsdom
 */
// 클립보드 이미지 꺼내기 (I-020) — 캡처는 이미지로, 글 붙여넣기는 그대로
import { imagesFromPaste, readClipboardImages, canReadClipboardImages, pasteShortcut } from '../clipboardImage';

const png = (name = 'image.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

/** 붙여넣기 이벤트 흉내 — images: File[], text: 함께 담긴 글 */
function pasteEvent({ images = [], text = '', target = document.body, filesOnly = false } = {}) {
  const items = filesOnly ? [] : images.map(f => ({ kind: 'file', type: f.type, getAsFile: () => f }));
  if (text && !filesOnly) items.push({ kind: 'string', type: 'text/plain', getAsFile: () => null });
  return {
    target,
    clipboardData: { items, files: images, getData: t => (t === 'text/plain' ? text : '') },
  };
}

afterEach(() => { vi.restoreAllMocks(); delete navigator.clipboard; });

describe('단축키 붙여넣기', () => {
  test('캡처 이미지는 시각이 붙은 이름의 파일로 꺼낸다', () => {
    const files = imagesFromPaste(pasteEvent({ images: [png()] }));
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe('image/png');
    expect(files[0].name).toMatch(/^캡처-\d{8}-\d{6}\.png$/);
    expect(files[0].size).toBe(4);
  });

  test('여러 장이면 번호를 붙이고, items가 없는 브라우저는 files에서 꺼낸다', () => {
    const two = imagesFromPaste(pasteEvent({ images: [png(), png('')] }));
    expect(two.map(f => f.name.replace(/\d{8}-\d{6}/, 'T'))).toEqual(['캡처-T-1.png', '캡처-T-2.png']);
    expect(imagesFromPaste(pasteEvent({ images: [png()], filesOnly: true }))).toHaveLength(1);
  });

  test('탐색기에서 복사한 파일은 원래 이름을 그대로 둔다', () => {
    const [file] = imagesFromPaste(pasteEvent({ images: [png('11월 영수증.png')] }));
    expect(file.name).toBe('11월 영수증.png');
  });

  test('글만 있으면 이미지가 없다 — 원래대로 글이 붙여넣어진다', () => {
    expect(imagesFromPaste(pasteEvent({ text: '12,000원' }))).toEqual([]);
    expect(imagesFromPaste({ target: document.body })).toEqual([]);
  });

  test('글과 그림이 함께 오면(엑셀·워드·웹 복사) 글로 본다 — 글 없이 그림만이면 입력 칸에서도 그림으로 읽는다', () => {
    const input = document.createElement('input');
    expect(imagesFromPaste(pasteEvent({ images: [png()], text: '스타벅스 4500', target: input }))).toEqual([]);
    expect(imagesFromPaste(pasteEvent({ images: [png()], text: '스타벅스 4500', target: document.body }))).toEqual([]);
    expect(imagesFromPaste(pasteEvent({ images: [png()], text: '날짜\t가맹점\t금액\n11/01\t스타벅스\t4500', target: document.body }))).toEqual([]);
    expect(imagesFromPaste(pasteEvent({ images: [png()], text: '   ', target: document.body }))).toHaveLength(1);
    expect(imagesFromPaste(pasteEvent({ images: [png()], target: input }))).toHaveLength(1);
  });

  test('함께 온 글이 이미지 주소·파일 이름뿐이면(브라우저 이미지 복사, Mac 파일 복사) 입력 칸 밖에서는 그림으로 읽는다', () => {
    const outside = (text) => imagesFromPaste(pasteEvent({ images: [png()], text, target: document.body }));
    expect(outside('https://example.com/receipt.png?w=800')).toHaveLength(1);
    expect(outside('11월 영수증.png')).toHaveLength(1);
    expect(outside('영수증1.jpg\n영수증2.jpg')).toHaveLength(1);
    expect(outside('영수증 보세요 https://example.com/a.png')).toEqual([]);
    // 입력 칸에서는 주소를 붙여넣는 것일 수 있으니 늘 글로 둔다
    const input = document.createElement('input');
    expect(imagesFromPaste(pasteEvent({ images: [png()], text: 'https://example.com/a.png', target: input }))).toEqual([]);
  });

  test('기본은 이미지만 — PDF는 받겠다고 할 때만 꺼낸다', () => {
    const pdf = new File(['%PDF'], '명세서.pdf', { type: 'application/pdf' });
    expect(imagesFromPaste(pasteEvent({ images: [pdf] }))).toEqual([]);
    const got = imagesFromPaste(pasteEvent({ images: [pdf, png()] }), { accept: /^(image\/|application\/pdf$)/ });
    expect(got.map(f => f.type)).toEqual(['application/pdf', 'image/png']);
    expect(got[0].name).toBe('명세서.pdf');
  });
});

describe('붙여넣기 단축키 이름', () => {
  const on = (platform, userAgent = '') => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  };
  test('Mac·iPad는 ⌘V, 그 밖에는 Ctrl+V', () => {
    on('MacIntel');
    expect(pasteShortcut()).toBe('⌘V');
    on('', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)');
    expect(pasteShortcut()).toBe('⌘V');
    on('Win32', 'Mozilla/5.0 (Windows NT 10.0)');
    expect(pasteShortcut()).toBe('Ctrl+V');
  });
});

describe('붙여넣기 버튼 (클립보드 읽기)', () => {
  const clipboardWith = (read) => { navigator.clipboard = { read }; };

  test('지원하지 않는 브라우저는 버튼을 보이지 않게 알 수 있고, 눌러도 이유를 알려 준다', async () => {
    expect(canReadClipboardImages()).toBe(false);
    await expect(readClipboardImages()).rejects.toThrow('버튼으로 붙여넣기를 지원하지 않습니다');
  });

  test('클립보드의 이미지를 읽어 파일로 돌려준다', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    clipboardWith(async () => [
      { types: ['text/plain'], getType: async () => new Blob(['x']) },
      { types: ['text/html', 'image/png'], getType: async (t) => (t === 'image/png' ? blob : null) },
    ]);
    expect(canReadClipboardImages()).toBe(true);
    const files = await readClipboardImages();
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/^캡처-.*\.png$/);
    expect(files[0].size).toBe(3);
  });

  test('이미지가 없거나, 허용되지 않거나, 이미지를 꺼내다 실패하면 한국어로 이유를 알려 준다', async () => {
    clipboardWith(async () => [{ types: ['text/plain'], getType: async () => new Blob(['x']) }]);
    await expect(readClipboardImages()).rejects.toThrow('클립보드에 이미지가 없습니다');

    clipboardWith(async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; });
    await expect(readClipboardImages()).rejects.toThrow("브라우저가 묻는 '붙여넣기'·'허용'을 누르거나");

    clipboardWith(async () => { throw new Error('boom'); });
    await expect(readClipboardImages()).rejects.toThrow('클립보드를 읽지 못했습니다');

    // 항목은 읽었지만 이미지를 꺼내는 단계에서 브라우저가 거절 — 영어 원문이 화면에 나오지 않게
    clipboardWith(async () => [{
      types: ['image/png'],
      getType: async () => { const e = new Error('The request is not allowed by the user agent'); e.name = 'NotAllowedError'; throw e; },
    }]);
    const err = await readClipboardImages().catch(e => e);
    expect(err.message).toMatch(/^클립보드를 읽지 못했습니다/);
    expect(err.message).not.toMatch(/not allowed/);
  });
});
