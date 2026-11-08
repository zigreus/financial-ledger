import { useEffect, useRef } from 'react';
import { imagesFromPaste } from '../services/clipboardImage';

/**
 * 화면이 열려 있는 동안 단축키(Ctrl+V·⌘V)로 붙여넣은 이미지를 받는다 (I-020).
 * 이미지가 없는 붙여넣기(글)는 건드리지 않고, 이미지를 받았을 때만 브라우저의 기본 붙여넣기를 막는다.
 * 다른 화면이 이미 받은 붙여넣기(defaultPrevented)는 다시 받지 않는다.
 *
 *   usePasteImages(files => ..., enabled, { accept });
 */
export function usePasteImages(onImages, enabled = true, options) {
  const handlerRef = useRef(onImages);
  handlerRef.current = onImages;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!enabled) return undefined;
    const onPaste = (e) => {
      if (e.defaultPrevented) return;
      const files = imagesFromPaste(e, optionsRef.current);
      if (!files.length) return;
      e.preventDefault();
      handlerRef.current(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [enabled]);
}
