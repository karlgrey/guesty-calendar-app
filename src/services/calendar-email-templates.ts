/**
 * Kalender-Report "Nächste Gäste" (report-type calendar-weekly, #1223).
 * Email-safe HTML (Tabellen + Inline-Styles) plus Text-Version.
 *
 * Bewusst OHNE Preise, Umsätze, Kennzahlen und Kontaktdaten: nur Vorname, Personenzahl, Kanal.
 */
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

export interface CalendarStayEntry {
  kind: 'stay';
  checkIn: string;   // YYYY-MM-DD
  checkOut: string;  // YYYY-MM-DD
  firstName: string; // erstes Wort von guest_name, sonst "Gast"
  guests: number | null;
  channel: string;   // lesbar, oder "–"
}

export interface CalendarBlockEntry {
  kind: 'block';
  from: string; // YYYY-MM-DD, erster geblockter Tag (aufs Fenster beschnitten)
  to: string;   // YYYY-MM-DD, letzter geblockter Tag (aufs Fenster beschnitten, inklusive)
}

export type CalendarEntry = CalendarStayEntry | CalendarBlockEntry;

export interface CalendarReportProperty {
  slug: string;
  name: string;
  entries: CalendarEntry[]; // chronologisch
}

export interface CalendarReportModel {
  generatedAt: string;
  windowStart: string; // YYYY-MM-DD (heute, Berlin)
  windowEnd: string;   // YYYY-MM-DD (heute + 14, inklusive)
  weekNumber: number;  // ISO-Kalenderwoche von windowStart
  properties: CalendarReportProperty[];
}

export const EMPTY_TEXT = 'keine Gäste in den nächsten 14 Tagen';

/** Escape data-derived strings for HTML. */
function h(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const parse = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`);

/** "Mo 23.11." */
export function shortDay(iso: string): string {
  return format(parse(iso), 'EEEEEE dd.MM.', { locale: de });
}

/** Lesbarer Kanal; unbekannte Werte bleiben roh, fehlend = "–". */
export function channelLabel(source: string | null | undefined, platform?: string | null): string {
  const raw = (source || platform || '').trim();
  if (!raw) return '–';
  switch (raw.toLowerCase()) {
    case 'airbnb':
    case 'airbnb2':
      return 'Airbnb';
    case 'booking':
    case 'booking.com':
      return 'Booking.com';
    case 'direct':
    case 'manual':
    case 'website':
      return 'Direkt';
    default:
      return raw;
  }
}

/** Vorname = erstes Wort, sonst "Gast". */
export function firstNameOf(guestName: string | null | undefined): string {
  const first = (guestName ?? '').trim().split(/\s+/)[0];
  return first || 'Gast';
}

export function calendarEmailSubject(model: CalendarReportModel): string {
  const from = format(parse(model.windowStart), 'dd.MM.');
  const to = format(parse(model.windowEnd), 'dd.MM.yyyy');
  return `Nächste Gäste · KW ${model.weekNumber} · ${from}–${to}`;
}

function guestsCell(n: number | null): string {
  return n && n > 0 ? String(n) : '–';
}

function renderProperty(p: CalendarReportProperty): string {
  const td = 'padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee';
  const rows = p.entries
    .map((e) => {
      if (e.kind === 'block') {
        return `<tr><td colspan="5" style="${td};color:#888;font-style:italic">${shortDay(e.from)} – ${shortDay(e.to)} · geblockt</td></tr>`;
      }
      return `<tr>
        <td style="${td};font-weight:600;white-space:nowrap">${shortDay(e.checkIn)}</td>
        <td style="${td};white-space:nowrap">${shortDay(e.checkOut)}</td>
        <td style="${td}">${h(e.firstName)}</td>
        <td style="${td};text-align:right">${guestsCell(e.guests)} P</td>
        <td style="${td}">${h(e.channel)}</td>
      </tr>`;
    })
    .join('');
  const body = p.entries.length
    ? `<table style="border-collapse:collapse;width:100%">
        <tr>
          <th style="font:600 11px sans-serif;color:#888;padding:4px 10px;border-bottom:2px solid #ddd;text-align:left">Anreise</th>
          <th style="font:600 11px sans-serif;color:#888;padding:4px 10px;border-bottom:2px solid #ddd;text-align:left">Abreise</th>
          <th style="font:600 11px sans-serif;color:#888;padding:4px 10px;border-bottom:2px solid #ddd;text-align:left">Gast</th>
          <th style="font:600 11px sans-serif;color:#888;padding:4px 10px;border-bottom:2px solid #ddd;text-align:right">Personen</th>
          <th style="font:600 11px sans-serif;color:#888;padding:4px 10px;border-bottom:2px solid #ddd;text-align:left">Kanal</th>
        </tr>${rows}</table>`
    : `<p style="font:13px sans-serif;color:#888;margin:0">${EMPTY_TEXT}</p>`;
  return `<div style="padding:0 18px 16px">
      <h3 style="font:700 13px sans-serif;margin:0 0 8px">${h(p.name)}</h3>
      ${body}
    </div>`;
}

export function generateCalendarEmail(model: CalendarReportModel): { html: string; text: string } {
  const range = `${format(parse(model.windowStart), 'dd.MM.')}–${format(parse(model.windowEnd), 'dd.MM.yyyy')}`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;background:#fff">
    <div style="max-width:680px;margin:0 auto;border:1px solid #e2e4df;border-radius:10px;overflow:hidden">
      <div style="background:#2f3a33;color:#fff;padding:16px 18px;margin-bottom:16px">
        <div style="font:700 16px sans-serif">Nächste Gäste · KW ${model.weekNumber}</div>
        <div style="font:11px sans-serif;opacity:.7;margin-top:2px">${range} · ${model.properties.length} Objekte</div>
      </div>
      ${model.properties.map(renderProperty).join('')}
      <div style="background:#f7f8f6;padding:10px 18px;font:10px sans-serif;color:#999;text-align:center">
        Remote Republic · automatischer Kalender-Report
      </div>
    </div>
    </body></html>`;

  const lines: string[] = [`Nächste Gäste · KW ${model.weekNumber} · ${range}`];
  for (const p of model.properties) {
    lines.push('', p.name);
    if (!p.entries.length) {
      lines.push(`  ${EMPTY_TEXT}`);
      continue;
    }
    for (const e of p.entries) {
      lines.push(
        e.kind === 'block'
          ? `  ${shortDay(e.from)} – ${shortDay(e.to)} · geblockt`
          : `  ${shortDay(e.checkIn)} → ${shortDay(e.checkOut)} · ${e.firstName} · ${guestsCell(e.guests)} P · ${e.channel}`
      );
    }
  }
  return { html, text: lines.join('\n') };
}
