import React, { useState, useEffect, useRef } from 'react';
import { evaluateExpression, formatAmount, isIncompleteFormula } from '../../services/formulaEvaluator';
import './AmountInput.css';

/**
 * 금액 입력 공통 컴포넌트 — 앱의 모든 금액·환율 입력란은 이것을 쓴다.
 *
 * - 사칙연산 수식 허용 (10000+5000, 34500/2, 950/100)
 * - 터치 기기에서는 숫자 키패드에 없는 + - × ÷ ( ) 를 키보드 위 툴바로 제공
 * - 수식을 입력하면 "= 계산 결과"를 미리 보여주고, 잘못된 수식은 오류로 표시
 *
 * 값은 입력한 문자열 그대로 부모가 들고 있다가, 저장할 때
 * evaluateFormula / parseForeignAmount / parseRate 로 계산한다.
 *
 * props
 *   decimal        결과를 소수 둘째 자리까지 보여줌 (외화·환율·할인율)
 *   allowNegative  수식 결과의 음수 허용 (계좌 잔액 등)
 *   unit           미리보기 단위 ('원' 기본, 'JPY' 등)
 *   preview        수식 미리보기 표시 여부
 *   containerClassName / containerStyle  감싸는 div용
 *   나머지 props(className, style, placeholder, autoFocus, onKeyDown…)는 input에 전달
 */

const SYMBOLS = ['+', '-', '×', '÷', '(', ')'];
const TOOLBAR_HEIGHT = 52;

const isTouchDevice = typeof window !== 'undefined'
  && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

function isPlainNumber(v) {
  return /^-?[\d,]+(\.\d+)?(\s*원)?$/.test(String(v).trim());
}

// 스크롤 컨테이너의 원래 하단 여백 — 여러 입력란이 같은 컨테이너를 쓰므로
// 처음 늘린 입력란이 원래 값을 기록하고, 마지막으로 놓는 입력란이 복원한다.
// (A→B로 포커스가 옮겨가면 A의 정리가 B의 설정보다 늦게 실행되기 때문)
const paddingHolds = new WeakMap(); // element → { count, original }

function holdPadding(el) {
  const hold = paddingHolds.get(el);
  if (hold) hold.count += 1;
  else paddingHolds.set(el, { count: 1, original: el.style.paddingBottom });
  return paddingHolds.get(el).original;
}

function releasePadding(el) {
  const hold = paddingHolds.get(el);
  if (!hold) return;
  hold.count -= 1;
  if (hold.count <= 0) {
    el.style.paddingBottom = hold.original;
    paddingHolds.delete(el);
  }
}

// 키보드가 올라왔을 때 입력란을 끌어올릴 스크롤 컨테이너
function findScrollParent(el) {
  let node = el ? el.parentElement : null;
  while (node && node !== document.body) {
    const { overflowY } = window.getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

function formatResult(n, decimal) {
  if (!decimal) return formatAmount(Math.round(n));
  return (Math.round(n * 100) / 100).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

export default function AmountInput({
  value,
  onChange,
  decimal = false,
  allowNegative = false,
  unit = '원',
  preview = true,
  containerClassName = '',
  containerStyle,
  className = '',
  onFocus,
  onBlur,
  ...inputProps
}) {
  const text = value === null || value === undefined ? '' : String(value);
  const trimmed = text.trim();
  const result = evaluateExpression(text, { allowNegative });
  const isValid = result !== null && !isNaN(result);
  const showError = trimmed !== '' && !isValid && !isIncompleteFormula(trimmed);
  const showPreview = preview && isValid && trimmed !== '' && !isPlainNumber(trimmed);

  const [focused, setFocused] = useState(false);
  const [toolbarBottom, setToolbarBottom] = useState(0);
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  const touchHandledRef = useRef(false);

  const scrollIntoVisibleArea = () => {
    const vv = window.visualViewport;
    const container = containerRef.current;
    if (!vv || !container) return;
    const scrollable = findScrollParent(container);
    if (!scrollable) return;
    // rect는 visual viewport 기준 — 툴바와 여백을 뺀 높이가 실제로 보이는 영역
    const rect = container.getBoundingClientRect();
    const visibleBottom = vv.height - TOOLBAR_HEIGHT - 8;
    if (rect.bottom > visibleBottom) {
      scrollable.scrollTop += rect.bottom - visibleBottom;
    }
  };

  // 키보드 높이를 따라 툴바 위치를 맞추고, 가려지지 않게 스크롤 여유를 만든다
  useEffect(() => {
    if (!focused || !isTouchDevice) return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const scrollable = findScrollParent(containerRef.current);
    const originalPadding = scrollable ? holdPadding(scrollable) : '';

    const update = () => {
      const kb = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
      setToolbarBottom(kb);
      if (scrollable) {
        scrollable.style.paddingBottom = kb > 0 ? `${kb + TOOLBAR_HEIGHT + 16}px` : originalPadding;
      }
      requestAnimationFrame(scrollIntoVisibleArea);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      setToolbarBottom(0);
      if (scrollable) releasePadding(scrollable);
    };
  }, [focused]);

  // 타이핑으로 미리보기가 생겨 높이가 늘어도 다시 맞춘다
  useEffect(() => {
    if (!focused || !isTouchDevice) return;
    const vv = window.visualViewport;
    if (!vv || window.innerHeight - vv.offsetTop - vv.height <= 0) return;
    requestAnimationFrame(scrollIntoVisibleArea);
  }, [text, focused]);

  const insertSymbol = (sym) => {
    const input = inputRef.current;
    if (!input) return;
    const actual = sym === '×' ? '*' : sym === '÷' ? '/' : sym;
    const start = input.selectionStart ?? text.length;
    const end = input.selectionEnd ?? text.length;
    const next = text.slice(0, start) + actual + text.slice(end);
    // onChange보다 focus를 먼저 — Android에서 키보드가 닫히지 않도록
    input.focus();
    onChange(next);
    requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));
  };

  const handleFocus = (e) => {
    setFocused(true);
    if (onFocus) onFocus(e);
  };

  const handleBlur = (e) => {
    // 툴바 버튼을 누른 뒤 포커스가 돌아올 시간을 한 프레임 기다린다
    requestAnimationFrame(() => {
      if (document.activeElement !== inputRef.current) setFocused(false);
    });
    if (onBlur) onBlur(e);
  };

  const unitLabel = unit === '원' ? '원' : unit ? ` ${unit}` : '';

  return (
    <div className={`amount-input ${containerClassName}`.trim()} style={containerStyle} ref={containerRef}>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        onChange={e => onChange(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={`${className}${showError ? ' input-error' : ''}`.trim()}
        {...inputProps}
      />
      {focused && isTouchDevice && (
        <div className="formula-toolbar" style={{ bottom: toolbarBottom }}>
          {SYMBOLS.map(sym => (
            <button
              key={sym}
              type="button"
              className="formula-toolbar-btn"
              onMouseDown={e => e.preventDefault()}
              onTouchStart={e => { e.preventDefault(); touchHandledRef.current = true; insertSymbol(sym); }}
              onClick={() => {
                if (touchHandledRef.current) { touchHandledRef.current = false; return; }
                insertSymbol(sym);
              }}
            >
              {sym}
            </button>
          ))}
        </div>
      )}
      {showPreview && (
        <span className="formula-preview">= {formatResult(result, decimal)}{unitLabel}</span>
      )}
      {showError && (
        <span className="formula-error">올바른 숫자 또는 수식을 입력하세요</span>
      )}
    </div>
  );
}
