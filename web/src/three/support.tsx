// Shared helpers for the 3D views: WebGL / reduced-motion detection, a still
// image fallback, an error boundary around the canvas, visibility tracking and
// an offline studio environment map (no CDN downloads).
import { Component, useEffect, useState, type ErrorInfo, type ReactNode, type RefObject } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import './three.css';

let webglCache: boolean | null = null;

/** ?quality=high keeps full quality (bloom, shadows, MSAA) even when the frame rate drops; for screenshots. */
export const FORCE_HQ = typeof location !== 'undefined' && /[?&]quality=high\b/.test(location.search);

export function webglAvailable(): boolean {
  if (webglCache !== null) return webglCache;
  try {
    const c = document.createElement('canvas');
    webglCache = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    webglCache = false;
  }
  return webglCache;
}

export function usePrefersReducedMotion(): boolean {
  const q = '(prefers-reduced-motion: reduce)';
  const [v, setV] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return;
    const on = () => setV(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return v;
}

/** True while the element is on screen and the tab is visible; used to pause rendering. */
export function useInView(ref: RefObject<Element>): boolean {
  const [v, setV] = useState(true);
  const [shown, setShown] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => setV(e.some((x) => x.isIntersecting)), { rootMargin: '100px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  useEffect(() => {
    const on = () => setShown(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return v && shown;
}

export function Still({ src, alt, caption, children }: { src?: string; alt: string; caption?: ReactNode; children?: ReactNode }) {
  return (
    <figure className="w3-still">
      {src ? <img src={src} alt={alt} loading="lazy" /> : null}
      {children}
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

type BoundaryProps = { fallback: ReactNode; children: ReactNode };

export class CanvasBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('3D view failed, showing the still image instead', error, info.componentStack);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Renders children (the WebGL view) only when WebGL works and the visitor has
 * not asked for reduced motion. Otherwise shows `still`, with a button to opt in.
 */
export function ThreeGuard({ still, children, label }: { still: ReactNode; children: ReactNode; label: string }) {
  const reduced = usePrefersReducedMotion();
  const [optIn, setOptIn] = useState(false);
  const gl = typeof document !== 'undefined' && webglAvailable();
  if (!gl) return <>{still}</>;
  if (reduced && !optIn) {
    return (
      <div className="w3-guard">
        {still}
        <button
          type="button"
          className="w3-btn w3-guard-btn"
          onClick={() => setOptIn(true)}
          data-explain={`Your device asks for reduced motion, so a still picture is shown. Press to load the moving 3D ${label} anyway.`}
        >
          Show 3D view
        </button>
      </div>
    );
  }
  return <CanvasBoundary fallback={still}>{children}</CanvasBoundary>;
}

/** Studio-like reflections for the metal parts, generated locally. */
export function StudioEnvironment({ intensity = 1 }: { intensity?: number }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    const prev = scene.environment;
    scene.environment = env;
    scene.environmentIntensity = intensity;
    return () => {
      scene.environment = prev;
      env.dispose();
      pm.dispose();
    };
  }, [gl, scene, intensity]);
  return null;
}

export const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');

/** Julian date (UTC based) for a JS time in ms. */
export const msToJD = (ms: number) => ms / 86400000 + 2440587.5;
export const jdToMs = (jd: number) => (jd - 2440587.5) * 86400000;
export const mjdToMs = (mjd: number) => jdToMs(mjd + 2400000.5);
