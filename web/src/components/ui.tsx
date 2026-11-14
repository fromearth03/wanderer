import type { ReactNode } from 'react';
import { ex } from '../explain';

// Small wrappers. Each takes an `explain` string and puts it on the real element as data-explain.

export function Chip(props: { pressed: boolean; onClick: () => void; explain: string; color?: string; children: ReactNode }) {
  return (
    <button type="button" className="chip" aria-pressed={props.pressed} onClick={props.onClick} data-explain={props.explain}>
      {props.color && <i className="sw" style={{ background: props.color }} />}
      {props.children}
    </button>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  explain: string;
}
export function Segmented<T extends string>(props: { value: T; options: SegOption<T>[]; onChange: (v: T) => void; label: string; role?: 'tablist' }) {
  return (
    <div className="seg" role={props.role === 'tablist' ? 'tablist' : 'group'} aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role={props.role === 'tablist' ? 'tab' : undefined}
          aria-selected={props.role === 'tablist' ? props.value === o.value : undefined}
          aria-pressed={props.role === 'tablist' ? undefined : props.value === o.value}
          onClick={() => props.onChange(o.value)}
          data-explain={o.explain}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; explain: string; children: ReactNode }) {
  return (
    <button type="button" role="switch" className="toggle" aria-checked={props.checked} onClick={() => props.onChange(!props.checked)} data-explain={props.explain}>
      <span className="track" />
      {props.children}
    </button>
  );
}

export function Slider(props: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; explain: string; display?: string; width?: number }) {
  return (
    <label className="range" style={props.width ? { width: props.width } : undefined}>
      <span className="rl">
        {props.label} <b>{props.display ?? props.value}</b>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} onChange={(e) => props.onChange(parseFloat(e.target.value))} data-explain={props.explain} aria-label={props.label} />
    </label>
  );
}

export function Select<T extends string>(props: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; explain: string }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select className="select" value={props.value} onChange={(e) => props.onChange(e.target.value as T)} data-explain={props.explain}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function IconButton(props: { label: string; onClick: () => void; explain: string; on?: boolean; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={`icon-btn${props.on ? ' on' : ''} ${props.className || ''}`} aria-label={props.label} aria-pressed={props.on} title={props.label} onClick={props.onClick} data-explain={props.explain}>
      {props.children}
    </button>
  );
}

export function ErrorBox(props: { message: string; onRetry?: () => void }) {
  return (
    <div className="err" role="alert">
      <span style={{ flex: 1 }}>{props.message}</span>
      {props.onRetry && (
        <button type="button" className="btn btn-sm" onClick={props.onRetry} data-explain={ex('common.retry')}>
          Retry
        </button>
      )}
    </div>
  );
}

export interface JobView {
  state: string;
  progress: number;
  message: string;
  cached?: boolean;
}

export function JobBar({ status }: { status: JobView | null | undefined }) {
  if (!status) return null;
  const pct = Math.round((status.progress || 0) * 100);
  const live = status.state === 'queued' || status.state === 'running' || status.state === 'starting';
  if (status.state === 'done') {
    return <p className="jobline">{status.cached ? 'Saved result, opened at once.' : 'Finished.'}</p>;
  }
  return (
    <div aria-live="polite">
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <div className="jobline">
        {live && <span className="spinner" />}
        <span className="mono">{pct}%</span>
        <span>{status.message || status.state}</span>
      </div>
    </div>
  );
}

/** Section title. The old numbered kicker (n) is ignored on purpose. */
export function PanelHead(props: { n?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="panel-head">
      <h2 className="panel-title">{props.title}</h2>
      {props.children && <div className="row">{props.children}</div>}
    </div>
  );
}

/** A plain note with a small "i" glyph. */
export function Note({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return (
    <p className={`note${warn ? ' warn' : ''}`}>
      <span className="note-i" aria-hidden="true">
        {warn ? '!' : 'i'}
      </span>
      <span>{children}</span>
    </p>
  );
}

/** Title block at the top of a side panel. */
export function SideHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="side-head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
      {children}
    </header>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  // Original mark: a tilted orbit around a fixed star, with one wandering body on it.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <g transform="rotate(-24 16 16)">
        <ellipse cx="16" cy="16" rx="13" ry="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.6" />
        <circle cx="16" cy="16" r="2.6" fill="currentColor" />
        <circle cx="28.4" cy="14.2" r="2.3" fill="var(--accent)" />
      </g>
    </svg>
  );
}

export const Icon = {
  crosshair: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </svg>
  ),
  sun: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  moon: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
    </svg>
  ),
  menu: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  ),
  plus: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  minus: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  ),
  target: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  grid: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M3 8h18M3 16h18M8 3v18M16 3v18" />
    </svg>
  ),
  reset: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" />
    </svg>
  ),
  play: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4l13 8-13 8z" />
    </svg>
  ),
  pause: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
    </svg>
  ),
  prev: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 5h2v14H6zM20 5L9 12l11 7z" />
    </svg>
  ),
  next: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16 5h2v14h-2zM4 5l11 7-11 7z" />
    </svg>
  ),
};
