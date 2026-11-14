import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { JobStatus } from '../api';

export function useAsync<T>(fn: () => Promise<T> | null, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: '', loading: false });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const p = fn();
    if (!p) {
      setState({ data: null, error: '', loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ data: s.data, error: '', loading: true }));
    p.then(
      (data) => alive && setState({ data, error: '', loading: false }),
      (e) => alive && setState({ data: null, error: e?.message || String(e), loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const retry = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, retry };
}

/** Start a gateway job and follow it live (WebSocket with polling fallback). */
export function useJob() {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState('');
  const stopRef = useRef<() => void>();
  useEffect(() => () => stopRef.current?.(), []);
  const start = useCallback(async (starter: () => Promise<string>) => {
    stopRef.current?.();
    setError('');
    setStatus({ job: '', state: 'queued', progress: 0, message: 'Starting' });
    try {
      const job = await starter();
      stopRef.current = api.watchJob(job, (s) => {
        setStatus(s);
        if (s.state === 'error') setError(s.message || 'The job failed.');
      });
    } catch (e: any) {
      setStatus(null);
      setError(e?.message || String(e));
    }
  }, []);
  const reset = useCallback(() => {
    stopRef.current?.();
    setStatus(null);
    setError('');
  }, []);
  const running = !!status && (status.state === 'queued' || status.state === 'running');
  return { status, error, running, start, reset };
}
