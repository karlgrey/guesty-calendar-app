/**
 * Consistency Alert Email — pure Renderer (#484)
 *
 * Baut Betreff/HTML/Text für die tägliche Kalender-Konsistenz-Alert-Mail.
 * Kein I/O — Versand übernimmt der Job (`runDailyConsistencyJob` in
 * `src/jobs/consistency-check.ts`) via `services/email-service.ts`.
 *
 * See docs/superpowers/specs/2026-08-27-calendar-consistency-check.md
 */

import type { ExpectedEvent, ConsistencyDiff } from './calendar-consistency.js';

// F10: die drei Eintrags-Typen sind die echten Diff-Typen aus
// calendar-consistency.ts statt lokaler Kopien — die Property-/Report-Hülle
// (ConsistencyAlertProperty/-Report) bleibt bewusst lokal: ein Import von
// PropertyConsistencyResult/ConsistencyReport aus jobs/consistency-check.ts
// wäre nur mit einem Typ-only-Re-Import in die Gegenrichtung (dieses Modul
// wird von dort bereits per Wert importiert) möglich und würde für den
// Mail-Renderer irrelevante Felder (sourceCounts, googleEventCount,
// provider, cacheLastSyncedAt) in jede Test-Fixture ziehen.
export type ConsistencyAlertMissingEntry = ExpectedEvent;
export type ConsistencyAlertExtraEntry = ConsistencyDiff['extra'][number];
export type ConsistencyAlertMismatchEntry = ConsistencyDiff['mismatched'][number];

export interface ConsistencyAlertProperty {
  slug: string;
  name: string;
  ok: boolean;
  missing: ConsistencyAlertMissingEntry[];
  extra: ConsistencyAlertExtraEntry[];
  mismatched: ConsistencyAlertMismatchEntry[];
  error: string | null;
}

export interface ConsistencyAlertReport {
  checkedAt: string;
  windowDays: number;
  from: string;
  to: string;
  totalIssues: number;
  properties: ConsistencyAlertProperty[];
}

export interface StaleHold {
  provider: string;
  guestName: string | null;
  property: { slug: string; name: string } | null;
  checkIn: string;
  createdAt: string;
}

/** F4: ein Provider im Hold-Sweep ist komplett fehlgeschlagen (isoliert, non-fatal). */
export interface HoldSweepAlertError {
  provider: string;
  error: string;
}

/** Alert-Mail nur bei Befund: totalIssues > 0 ODER mindestens ein Hold mit Treffern. */
export function shouldSendConsistencyAlert(report: ConsistencyAlertReport, staleHolds: StaleHold[]): boolean {
  return report.totalIssues > 0 || staleHolds.length > 0;
}

// F8(e): auch " escapen (Konsolidierung aller 5 Escaper im Repo ist NICHT
// Teil dieses Fixes — nur dieser).
function esc(s: string | null | undefined): string {
  if (s == null) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function propertyHasFindings(p: ConsistencyAlertProperty): boolean {
  return p.missing.length > 0 || p.extra.length > 0 || p.mismatched.length > 0 || !!p.error;
}

function renderPropertyHtml(p: ConsistencyAlertProperty): string {
  const rows: string[] = [];
  for (const m of p.missing) {
    rows.push(
      `<li>Fehlt: ${esc(m.type)} · ${esc(m.start)}–${esc(m.endExclusive)}${m.guestName ? ' · ' + esc(m.guestName) : ''}</li>`
    );
  }
  for (const e of p.extra) {
    rows.push(`<li>Extra: ${esc(e.start)}–${esc(e.end)} · ${esc(e.summary)}</li>`);
  }
  for (const mm of p.mismatched) {
    rows.push(
      `<li>Abweichung: ${esc(mm.summary)} · erwartet ${esc(mm.expected.start)}–${esc(mm.expected.endExclusive)}, ` +
        `im Kalender ${esc(mm.actual.start)}–${esc(mm.actual.endExclusive)}</li>`
    );
  }
  const errorLine = p.error ? `<p>Fehler: ${esc(p.error)}</p>` : '';
  return `<h3>${esc(p.name)}</h3>${errorLine}${rows.length ? `<ul>${rows.join('')}</ul>` : ''}`;
}

function renderPropertyText(p: ConsistencyAlertProperty): string {
  const lines: string[] = [`${p.name}:`];
  if (p.error) lines.push(`  Fehler: ${p.error}`);
  for (const m of p.missing) {
    lines.push(`  Fehlt: ${m.type} · ${m.start}–${m.endExclusive}${m.guestName ? ' · ' + m.guestName : ''}`);
  }
  for (const e of p.extra) {
    lines.push(`  Extra: ${e.start}–${e.end} · ${e.summary}`);
  }
  for (const mm of p.mismatched) {
    lines.push(
      `  Abweichung: ${mm.summary} · erwartet ${mm.expected.start}–${mm.expected.endExclusive}, im Kalender ${mm.actual.start}–${mm.actual.endExclusive}`
    );
  }
  return lines.join('\n');
}

function renderStaleHoldsHtml(staleHolds: StaleHold[]): string {
  if (staleHolds.length === 0) return '';
  const rows = staleHolds
    .map(
      (h) =>
        `<li>${esc(h.property?.name ?? h.provider)} · ${esc(h.guestName)} · Check-in ${esc(h.checkIn)} · ` +
        `angelegt ${esc(h.createdAt)}</li>`
    )
    .join('');
  return `<h3>Offene Holds &gt; 7 Tage</h3><ul>${rows}</ul>`;
}

function renderStaleHoldsText(staleHolds: StaleHold[]): string {
  if (staleHolds.length === 0) return '';
  const rows = staleHolds
    .map((h) => `  ${h.property?.name ?? h.provider} · ${h.guestName} · Check-in ${h.checkIn} · angelegt ${h.createdAt}`)
    .join('\n');
  return `\nOffene Holds > 7 Tage:\n${rows}`;
}

/** F4: Hold-Sweep-Provider-Fehler — non-fatal isoliert, aber alert-würdig (Silent-Failure-Risiko). */
function renderHoldSweepErrorsHtml(errors: HoldSweepAlertError[]): string {
  if (errors.length === 0) return '';
  const rows = errors.map((e) => `<li>${esc(e.provider)}: ${esc(e.error)}</li>`).join('');
  return `<h3>Hold-Sweep-Fehler</h3><ul>${rows}</ul>`;
}

function renderHoldSweepErrorsText(errors: HoldSweepAlertError[]): string {
  if (errors.length === 0) return '';
  const rows = errors.map((e) => `  ${e.provider}: ${e.error}`).join('\n');
  return `\nHold-Sweep-Fehler:\n${rows}`;
}

/** Baut Betreff/HTML/Text der täglichen Konsistenz-Alert-Mail. */
export function buildConsistencyAlertEmail(
  report: ConsistencyAlertReport,
  staleHolds: StaleHold[],
  holdSweepErrors: HoldSweepAlertError[] = []
): { subject: string; html: string; text: string } {
  const holdSuffix = staleHolds.length > 0 ? ` + ${staleHolds.length} überfällige Hold${staleHolds.length === 1 ? '' : 's'}` : '';
  const subject = `⚠️ Kalender-Konsistenz: ${report.totalIssues} Abweichungen${holdSuffix}`;

  const propertiesWithFindings = report.properties.filter(propertyHasFindings);

  const html = [
    `<p>Kalender-Konsistenz-Check ${esc(report.checkedAt)} · Fenster ${esc(report.from)}–${esc(report.to)} (${report.windowDays} Tage).</p>`,
    ...propertiesWithFindings.map(renderPropertyHtml),
    renderStaleHoldsHtml(staleHolds),
    renderHoldSweepErrorsHtml(holdSweepErrors),
  ]
    .filter(Boolean)
    .join('\n');

  const text = [
    `Kalender-Konsistenz-Check ${report.checkedAt} · Fenster ${report.from}–${report.to} (${report.windowDays} Tage).`,
    ...propertiesWithFindings.map(renderPropertyText),
    renderStaleHoldsText(staleHolds),
    renderHoldSweepErrorsText(holdSweepErrors),
  ]
    .filter(Boolean)
    .join('\n\n');

  return { subject, html, text };
}
