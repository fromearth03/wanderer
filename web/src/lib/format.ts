export const detColor = (d: number) => `var(--d${Math.min(6, Math.max(1, d))})`;
export const DET_RANGES: Record<number, [number, number]> = {
  1: [0.75, 1.09], 2: [1.1, 1.62], 3: [1.63, 2.41], 4: [2.42, 3.82], 5: [3.83, 4.41], 6: [4.42, 5.0],
};

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');

export function fmtRa(deg: number): string {
  if (!isFinite(deg)) return '';
  const h = (((deg % 360) + 360) % 360) / 15;
  const hh = Math.floor(h);
  const m = (h - hh) * 60;
  const mm = Math.floor(m);
  const s = (m - mm) * 60;
  return `${pad(hh)}h ${pad(mm)}m ${s.toFixed(1).padStart(4, '0')}s`;
}
export function fmtDec(deg: number): string {
  if (!isFinite(deg)) return '';
  const sign = deg < 0 ? '-' : '+';
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  const mm = Math.floor(m);
  const s = (m - mm) * 60;
  return `${sign}${pad(d)}° ${pad(mm)}' ${s.toFixed(0).padStart(2, '0')}"`;
}
export function fmtDate(isoOrMjd: string | number, withTime = true): string {
  const d = typeof isoOrMjd === 'number' ? new Date((isoOrMjd - 40587) * 86400000) : new Date(isoOrMjd);
  if (isNaN(d.getTime())) return String(isoOrMjd);
  const s = d.toISOString();
  return withTime ? `${s.slice(0, 10)} ${s.slice(11, 16)} UTC` : s.slice(0, 10);
}
export const mjdToDate = (mjd: number) => new Date((mjd - 40587) * 86400000);
export const dateToMjd = (d: Date) => d.getTime() / 86400000 + 40587;
export const um = (v: number | undefined | null, digits = 3) => (v === undefined || v === null || !isFinite(v) ? '?' : `${v.toFixed(digits)} µm`);

/** Parse "180 0", "180.5, -5.2", "12:30:00 +12:00:00", "12h30m00s +12d00m00s". */
export function parseCoords(text: string): { ra: number; dec: number } | null {
  const t = text.trim();
  const dec2 = t.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*([+-]?\d+(?:\.\d+)?)$/);
  if (dec2) {
    const ra = parseFloat(dec2[1]);
    const dec = parseFloat(dec2[2]);
    if (ra >= 0 && ra < 360 && dec >= -90 && dec <= 90) return { ra, dec };
    return null;
  }
  const sex = t.match(/^(\d{1,2})[h: ]\s*(\d{1,2})[m: ]\s*(\d{1,2}(?:\.\d+)?)s?\s*[, ]?\s*([+-]?)(\d{1,2})[d°: ]\s*(\d{1,2})[m': ]\s*(\d{1,2}(?:\.\d+)?)["s]?$/i);
  if (sex) {
    const ra = (parseInt(sex[1]) + parseInt(sex[2]) / 60 + parseFloat(sex[3]) / 3600) * 15;
    const dec = (parseInt(sex[5]) + parseInt(sex[6]) / 60 + parseFloat(sex[7]) / 3600) * (sex[4] === '-' ? -1 : 1);
    if (ra >= 0 && ra < 360 && dec >= -90 && dec <= 90) return { ra, dec };
  }
  return null;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
