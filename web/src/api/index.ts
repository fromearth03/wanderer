import { liveApi } from './client';
import { mockApi } from './mock';
import type { Api } from './types';

// VITE_MOCK=1 at build/dev time, or ?mock=1 in the address bar, selects the mock layer.
function useMock(): boolean {
  if (import.meta.env.VITE_MOCK === '1') return true;
  try {
    const q = new URLSearchParams(location.search).get('mock');
    if (q === '1') sessionStorage.setItem('wanderer.mock', '1');
    if (q === '0') sessionStorage.removeItem('wanderer.mock');
    return sessionStorage.getItem('wanderer.mock') === '1';
  } catch {
    return false;
  }
}

export const api: Api = useMock() ? mockApi : liveApi;
export * from './types';
export { normMovers, normSpectrum, normTrack, mjdToIso } from './client';
