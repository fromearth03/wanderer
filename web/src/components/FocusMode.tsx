import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Global Focus mode. One set of delegated listeners on document: hovering, focusing or
// clicking any element with data-explain shows a speech bubble above it (below if there
// is no room), clamped inside the viewport. On touch, the first tap explains and the
// second tap on the same element acts.

interface Bubble {
  text: string;
  title: string;
  left: number;
  top: number;
  above: boolean;
  arrowX: number;
}

const GAP = 10;
const MARGIN = 8;

function labelOf(el: HTMLElement): string {
  const raw =
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    (el.tagName === 'INPUT' ? (el as HTMLInputElement).placeholder : '') ||
    el.textContent ||
    '';
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length > 38 ? t.slice(0, 36) + '...' : t;
}

export function FocusLayer({ on }: { on: boolean }) {
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const current = useRef<HTMLElement | null>(null);
  const armed = useRef<HTMLElement | null>(null); // touch: element explained by the last tap
  const lastPointer = useRef<string>('mouse');

  useEffect(() => {
    document.documentElement.classList.toggle('focus-on', on);
    if (!on) {
      setBubble(null);
      current.current = null;
      armed.current = null;
      return;
    }

    const find = (t: EventTarget | null): HTMLElement | null => {
      if (!(t instanceof Element)) return null;
      return t.closest('[data-explain]') as HTMLElement | null;
    };

    const show = (el: HTMLElement) => {
      const text = el.getAttribute('data-explain');
      if (!text) return;
      current.current = el;
      // First pass renders hidden at the top-left so it takes its natural width; the effect
      // below measures it and moves it into place.
      setBubble({ text, title: labelOf(el), left: MARGIN, top: 0, above: true, arrowX: 0 });
    };
    const hide = () => {
      current.current = null;
      setBubble(null);
    };

    const onOver = (e: MouseEvent) => {
      if (lastPointer.current === 'touch') return;
      const el = find(e.target);
      if (el && el !== current.current) show(el);
      else if (!el && current.current) hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = find(e.target);
      if (el) show(el);
    };
    const onPointerDown = (e: PointerEvent) => {
      lastPointer.current = e.pointerType || 'mouse';
    };
    const onClick = (e: MouseEvent) => {
      const el = find(e.target);
      if (!el) {
        hide();
        armed.current = null;
        return;
      }
      const isFocusToggle = el.hasAttribute('data-focus-toggle');
      if (lastPointer.current === 'touch' && !isFocusToggle && armed.current !== el) {
        // First tap explains only.
        e.preventDefault();
        e.stopPropagation();
        armed.current = el;
        show(el);
        return;
      }
      armed.current = null;
      show(el);
    };
    const onScroll = () => hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('keydown', onKey);
    };
  }, [on]);

  // Measure the bubble and keep it inside the viewport; flip below when there is no room above.
  useLayoutEffect(() => {
    const b = bubbleRef.current;
    const el = current.current;
    if (!bubble || !b || !el || bubble.arrowX) return;
    const r = el.getBoundingClientRect();
    const bw = b.offsetWidth;
    const bh = b.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = r.left + r.width / 2;
    let left = Math.round(cx - bw / 2);
    left = Math.max(MARGIN, Math.min(vw - bw - MARGIN, left));
    let above = r.top - bh - GAP >= MARGIN;
    let top = above ? r.top - bh - GAP : r.bottom + GAP;
    if (!above && top + bh > vh - MARGIN) {
      // Neither fits fully (very tall element): pin inside the viewport.
      top = Math.max(MARGIN, vh - bh - MARGIN);
      above = false;
    }
    const arrowX = Math.max(14, Math.min(bw - 14, cx - left));
    setBubble({ ...bubble, left, top, above, arrowX });
  }, [bubble]);

  if (!on) return null;
  return (
    <>
      {bubble && (
        <div
          ref={bubbleRef}
          className={`bubble ${bubble.above ? 'above' : 'below'}`}
          role="tooltip"
          style={{
            left: bubble.left,
            top: bubble.top,
            visibility: bubble.arrowX ? 'visible' : 'hidden',
            ['--arrow-x' as string]: `${bubble.arrowX}px`,
          }}
        >
          {bubble.title && <div className="bt">{bubble.title}</div>}
          {bubble.text}
        </div>
      )}
      <div className="focus-banner">Focus mode: point at or tap any control</div>
    </>
  );
}
