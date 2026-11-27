/**
 * Mail „Strom je Gast“ (#1376) — pure Vorlage, kein I/O.
 *
 * Zahlen und Statustexte kommen aus power-format.ts, also dieselben wie die Zeile auf
 * /admin/strom. Keine Euro, keine Kosten.
 */
import type { PowerReport } from './power-report-service.js';
import type { PowerRow } from './power-consumption.js';
import { deDateTime, deviationLabel, num, num1, statusLabel } from './power-format.js';

export interface PowerStayEmailInput {
  report: PowerReport;
  stay: PowerRow;
  /** Leerstand direkt vor der Buchung (nur genutzt, wenn vollständig erfasst) */
  vacancyBefore: PowerRow | null;
  adminUrl: string;
}

function esc(s: string | number | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function vacancyLine(v: PowerRow | null): string | null {
  if (!v || v.status !== 'complete' || v.kwh === null) return null;
  const parts = [`${num(v.kwh)} kWh`];
  if (v.kwhPerDay !== null) parts.push(`${num(v.kwhPerDay)} kWh/Tag`);
  parts.push(`${num1(v.days)} Tage`);
  return parts.join(' · ');
}

export function buildPowerStayEmail(input: PowerStayEmailInput): { subject: string; html: string; text: string } {
  const { report, stay, vacancyBefore, adminUrl } = input;
  const incomplete = stay.status === 'incomplete';
  const guest = stay.guestName || 'Gast unbekannt';

  const tail = incomplete ? statusLabel(stay) : `${stay.kwhPerNight !== null ? num(stay.kwhPerNight) : '—'} kWh/Nacht`;
  const subject = `${stay.flagged ? 'auffällig · ' : ''}Strom ${report.propertyName}: ${guest} · ${tail}`;

  let deviation = '—';
  if (!incomplete) {
    if (report.medianKwhPerNight === null) {
      deviation = 'kein Median (noch keine vollständig erfassten Buchungen)';
    } else {
      deviation = `${deviationLabel(stay.deviationPct) || '—'} (Median ${num(report.medianKwhPerNight)} kWh/Nacht aus ${report.comparisonCount} vollständig erfassten Buchungen)`;
    }
  }

  const rows: Array<[string, string]> = [
    ['Gast', guest],
    ['Check-in', deDateTime(stay.startUtc, report.timezone)],
    ['Check-out', deDateTime(stay.endUtc, report.timezone)],
    ['Nächte', stay.nights === null ? '—' : String(stay.nights)],
    ['kWh gesamt', stay.kwh !== null ? num(stay.kwh) : '—'],
    ['kWh pro Nacht', stay.kwhPerNight !== null ? num(stay.kwhPerNight) : '—'],
    ['Abweichung vom Median', deviation],
    ['Status', statusLabel(stay) || 'vollständig'],
  ];
  const vac = vacancyLine(vacancyBefore);
  if (vac) rows.push(['Leerstand davor', vac]);

  const hint = report.flaggingActive ? null : 'Markierung „auffällig“ ab 5 Vergleichsbuchungen';

  const html = `<!DOCTYPE html>
<html lang="de"><body style="font-family: system-ui, sans-serif; color: #222;">
<h2 style="margin: 0 0 12px;">Strom ${esc(report.propertyName)}: ${esc(guest)}</h2>
<table style="border-collapse: collapse; font-size: 14px;">
${rows.map(([k, v]) => `<tr><td style="padding: 4px 16px 4px 0; color: #666;">${esc(k)}</td><td style="padding: 4px 0;">${esc(v)}</td></tr>`).join('\n')}
</table>
${hint ? `<p style="color: #666; font-size: 13px;">${esc(hint)}</p>` : ''}
<p><a href="${esc(adminUrl)}">Alle Buchungen: /admin/strom</a></p>
</body></html>`;

  const text = [
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(hint ? ['', hint] : []),
    '',
    `Alle Buchungen: ${adminUrl}`,
  ].join('\n');

  return { subject, html, text };
}
