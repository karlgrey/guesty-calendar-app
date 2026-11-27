/**
 * Reine Format-Helfer für Stromwerte (#1169, #1376) — gemeinsam genutzt von der Admin-Seite
 * /admin/strom (src/routes/power.ts) und der Strom-Mail je Gast, damit beide dieselben
 * Zahlen und Texte zeigen. Kein I/O.
 */
import type { PowerRow } from './power-consumption.js';

export const num = (n: number): string => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });
export const num1 = (n: number): string => n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** UTC-ISO → Teile (TT, MM, JJJJ, HH, MM) in der Objekt-Zeitzone. */
export function zonedParts(iso: string, timezone: string): { d: string; m: string; y: string; hh: string; mm: string } {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { d: get('day'), m: get('month'), y: get('year'), hh: get('hour'), mm: get('minute') };
}

export function deDateTime(iso: string, timezone: string): string {
  const p = zonedParts(iso, timezone);
  return `${p.d}.${p.m}.${p.y} ${p.hh}:${p.mm}`;
}

export function statusLabel(row: PowerRow): string {
  const parts: string[] = [];
  if (row.status === 'running') parts.push('läuft (bis letzter Stand)');
  else if (row.status === 'incomplete') {
    parts.push(row.incompleteReason === 'reset' ? 'unvollständig (Zählerstand gesunken)' : 'unvollständig (Messlücke)');
  }
  if (row.flagged) parts.push('auffällig');
  return parts.join(' · ');
}

export function deviationLabel(pct: number | null): string {
  if (pct === null || pct === undefined) return '';
  const r = Math.round(pct);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toLocaleString('de-DE')} %`;
}
