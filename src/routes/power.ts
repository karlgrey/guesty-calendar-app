// src/routes/power.ts
//
// Admin-Seite „Stromverbrauch“ (#1169): kWh je Buchung und Leerstand aus den
// Zählerständen von Home Assistant. Reine Anzeige, keine Kosten. Mounted at
// /admin/strom in src/app.ts. `renderPowerPage` ist ohne DB testbar.
import express from 'express';
import { buildPowerReport, type PowerReport } from '../services/power-report-service.js';
import type { PowerRow } from '../services/power-consumption.js';
import { renderAdminPage } from './admin-layout.js';
import { NotFoundError } from '../utils/errors.js';

const router = express.Router();

const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
const DEFAULT_PROPERTY = 'farmhouse';

function esc(s: string | number | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const num = (n: number): string => n.toLocaleString('de-DE', { maximumFractionDigits: 1 });
const num1 = (n: number): string => n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** UTC-ISO → Teile (TT, MM, JJJJ, HH, MM) in der Objekt-Zeitzone. */
function zonedParts(iso: string, timezone: string): { d: string; m: string; y: string; hh: string; mm: string } {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { d: get('day'), m: get('month'), y: get('year'), hh: get('hour'), mm: get('minute') };
}

function deDateTime(iso: string, timezone: string): string {
  const p = zonedParts(iso, timezone);
  return `${p.d}.${p.m}.${p.y} ${p.hh}:${p.mm}`;
}

/** YYYY-MM-DD → [TT, MM, JJJJ] */
function ymd(date: string): [string, string, string] {
  const [y, m, d] = date.slice(0, 10).split('-');
  return [d, m, y];
}

function periodLabel(row: PowerRow, timezone: string): string {
  let from: [string, string, string];
  let to: [string, string, string];
  if (row.kind === 'stay' && row.checkInDate && row.checkOutDate) {
    from = ymd(row.checkInDate);
    to = ymd(row.checkOutDate);
  } else {
    const a = zonedParts(row.startUtc, timezone);
    const b = zonedParts(row.endUtc, timezone);
    from = [a.d, a.m, a.y];
    to = [b.d, b.m, b.y];
    if (row.status === 'running') return `seit ${from[0]}.${from[1]}.${from[2]}`;
  }
  return `${from[0]}.${from[1]}.–${to[0]}.${to[1]}.${to[2]}`;
}

function statusLabel(row: PowerRow): string {
  const parts: string[] = [];
  if (row.status === 'running') parts.push('läuft (bis letzter Stand)');
  else if (row.status === 'incomplete') {
    parts.push(row.incompleteReason === 'reset' ? 'unvollständig (Zählerstand gesunken)' : 'unvollständig (Messlücke)');
  }
  if (row.flagged) parts.push('auffällig');
  return parts.join(' · ');
}

function deviationLabel(pct: number | null): string {
  if (pct === null || pct === undefined) return '';
  const r = Math.round(pct);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toLocaleString('de-DE')} %`;
}

function renderRow(row: PowerRow, timezone: string): string {
  const incomplete = row.status === 'incomplete';
  const classes = ['pw-row', row.kind === 'vacancy' ? 'pw-vacancy' : 'pw-stay'];
  if (incomplete) classes.push('pw-incomplete');
  if (row.flagged) classes.push('pw-flagged');

  const guest = row.kind === 'vacancy' ? 'Leerstand' : (row.guestName || '—');
  const nights = row.kind === 'vacancy'
    ? `${num1(row.days)} Tage`
    : (row.nights === null ? '—' : String(row.nights));

  let kwh = '—';
  let perUnit = '—';
  let deviation = '';
  if (!incomplete) {
    if (row.kwh !== null) kwh = num(row.kwh);
    if (row.kind === 'vacancy') {
      if (row.kwhPerDay !== null) perUnit = `${num(row.kwhPerDay)}/Tag`;
    } else if (row.kwhPerNight !== null) {
      perUnit = num(row.kwhPerNight);
    }
    deviation = deviationLabel(row.deviationPct);
  }

  return `<tr class="${classes.join(' ')}">
    <td>${esc(periodLabel(row, timezone))}</td>
    <td>${esc(guest)}</td>
    <td class="pw-num">${esc(nights)}</td>
    <td class="pw-num">${esc(kwh)}</td>
    <td class="pw-num">${esc(perUnit)}</td>
    <td class="pw-num">${esc(deviation)}</td>
    <td>${esc(statusLabel(row))}</td>
  </tr>`;
}

export function renderPowerPage(report: PowerReport): string {
  let latest: string;
  let stale = '';
  if (report.latestReading) {
    latest = `Letzter Zählerstand: ${esc(deDateTime(report.latestReading.measuredAt, report.timezone))} (${esc(num1(report.latestReading.kwh))} kWh)`;
    const ageMs = Date.parse(report.generatedAt) - Date.parse(report.latestReading.measuredAt);
    if (ageMs > STALE_AFTER_MS) {
      const hours = Math.floor(ageMs / (60 * 60 * 1000));
      stale = `<div class="pw-warn">Lieferung ausgefallen? Letzter Stand vor ${hours} Stunden</div>`;
    }
  } else {
    latest = 'Noch kein Zählerstand empfangen';
  }

  const medianText = report.medianKwhPerNight === null
    ? 'Median: noch keine vollständig erfassten Buchungen'
    : `Median: ${esc(num(report.medianKwhPerNight))} kWh/Nacht aus ${esc(report.comparisonCount)} vollständig erfassten Buchungen`;
  const flagHint = report.flaggingActive ? '' : ' · Markierung ab 5 Vergleichsbuchungen';

  const rows = [...report.rows].reverse().map((r) => renderRow(r, report.timezone)).join('\n');
  const table = report.rows.length === 0
    ? '<p>Keine Buchungen im Auswertungszeitraum.</p>'
    : `<table class="pw-table">
  <thead><tr><th>Zeitraum</th><th>Gast</th><th class="pw-num">Nächte</th><th class="pw-num">kWh gesamt</th><th class="pw-num">kWh/Nacht</th><th class="pw-num">Abweichung vom Median</th><th>Status</th></tr></thead>
  <tbody>
${rows}
  </tbody></table>`;

  const body = `<style>
  .pw-wrap { max-width: 1000px; margin: 0 auto; padding: 16px; font-family: system-ui, sans-serif; }
  .pw-last { font-size: 1.05rem; margin: 8px 0; }
  .pw-warn { background: #fff3cd; border: 1px solid #e0a800; color: #7a5200; padding: 10px 14px; border-radius: 6px; font-weight: 600; margin: 8px 0; }
  .pw-median { margin: 8px 0 16px; color: #444; }
  .pw-table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
  .pw-table th, .pw-table td { padding: 6px 8px; border-bottom: 1px solid #e5e5e5; text-align: left; }
  .pw-table .pw-num { text-align: right; white-space: nowrap; }
  .pw-vacancy { background: #f4f4f4; font-size: 0.85rem; }
  .pw-incomplete { color: #888; font-style: italic; }
  .pw-flagged { background: #fde2e1; }
  .pw-flagged td:last-child { color: #a12622; font-weight: 600; }
</style>
<div class="pw-wrap">
  <h1>Stromverbrauch · ${esc(report.propertyName)}</h1>
  <div class="pw-last">${latest}</div>
  ${stale}
  <div class="pw-median">${medianText}${flagHint}</div>
  ${table}
</div>`;

  return renderAdminPage({ title: 'Stromverbrauch', body, active: 'power' });
}

router.get('/', (req, res) => {
  const slug = typeof req.query.property === 'string' && req.query.property ? req.query.property : DEFAULT_PROPERTY;
  try {
    res.type('html').send(renderPowerPage(buildPowerReport(slug)));
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).type('html').send(renderAdminPage({
        title: 'Stromverbrauch',
        body: `<div style="padding:16px"><p>Objekt „${esc(slug)}“ ist nicht konfiguriert.</p></div>`,
        active: 'power',
      }));
      return;
    }
    throw err;
  }
});

export default router;
