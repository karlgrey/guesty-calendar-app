// #1187: Anfrage-/Buchungsdaten in der Nachrichten-App — Zeile im Thread-Kopf und kompaktes
// Badge in der Thread-Liste. Reine Formatierung; die Daten kommen aus
// resolveThreadBookingSummary (booking-context.ts, nur DB).
import type { ThreadBookingSummary } from '../services/booking-context.js';

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

const STATUS_LABEL: Record<string, string> = {
  confirmed: 'bestätigt',
  reserved: 'reserviert',
  inquiry: 'offen',
  canceled: 'storniert',
  cancelled: 'storniert',
  declined: 'abgelehnt',
  expired: 'abgelaufen',
  closed: 'geschlossen',
};

/** Art mit Status: „Anfrage" (offene Anfrage ohne Zusatz), sonst „Buchung (bestätigt)" usw. */
export function bookingKindLabel(s: ThreadBookingSummary): string {
  const base = s.kind === 'reservation' ? 'Buchung' : 'Anfrage';
  if (!s.status) return base;
  if (s.kind === 'inquiry' && s.status === 'inquiry') return base;
  return `${base} (${STATUS_LABEL[s.status] ?? s.status})`;
}

/** YYYY-MM-DD → TT.MM.JJJJ (bzw. TT.MM. kurz). */
function deDate(iso: string | null, short = false): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return '–';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return short ? `${d}.${m}.` : `${d}.${m}.${y}`;
}

/** Betrag deutsch formatiert: ganze Beträge ohne Nachkommastellen („1.234 €"), sonst zwei. */
export function formatMoney(amount: number, currency: string | null): string {
  const digits = Number.isInteger(amount) ? 0 : 2;
  if (currency) {
    try {
      return new Intl.NumberFormat('de-DE', {
        style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
      }).format(amount).replace(/ /g, ' ');
    } catch {
      // unbekannter Währungscode → Zahl + Code
    }
  }
  const n = new Intl.NumberFormat('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
  return currency ? `${n} ${currency}` : n;
}

function personsLabel(s: ThreadBookingSummary): string {
  if (s.guestsCount == null) return 'Personen –';
  const main = `${s.guestsCount} ${s.guestsCount === 1 ? 'Person' : 'Personen'}`;
  if (s.kind === 'inquiry') return `${main} (laut Anfrage)`;
  if (s.adults != null) {
    const kids = s.children ?? 0;
    return `${main} (${s.adults} Erw.${kids > 0 ? `, ${kids} ${kids === 1 ? 'Kind' : 'Kinder'}` : ''})`;
  }
  return main;
}

function nightsLabel(n: number | null): string {
  if (n == null || n <= 0) return 'Nächte –';
  return `${n} ${n === 1 ? 'Nacht' : 'Nächte'}`;
}

/** Zeile unter der Thread-Unterzeile. Ohne Verknüpfung: Hinweis „keine Buchung/Anfrage verknüpft". */
export function renderBookingSummaryLine(s: ThreadBookingSummary | null): string {
  if (!s) {
    return '<p class="subtitle booking-summary" style="margin-top:-4px">keine Buchung/Anfrage verknüpft</p>';
  }
  const parts = [
    `<strong>${esc(bookingKindLabel(s))}</strong>`,
    esc(`${deDate(s.checkIn)}–${deDate(s.checkOut)}`),
    esc(nightsLabel(s.nights)),
    esc(personsLabel(s)),
  ];
  if (s.hostPayout == null && s.totalPrice == null) {
    parts.push('Preis unbekannt');
  } else {
    const payout = s.hostPayout != null ? formatMoney(s.hostPayout, s.currency) : '–';
    const guest = s.totalPrice != null ? formatMoney(s.totalPrice, s.currency) : '–';
    parts.push(`<strong>Auszahlung ${esc(payout)}</strong> <small style="opacity:.75">Gastpreis ${esc(guest)}</small>`);
  }
  return `<p class="subtitle booking-summary" style="margin-top:-4px">${parts.join(' · ')}</p>`;
}

/** Kompaktes Listen-Badge „31.12.–01.01. · 1 P." (ohne Preis); leer ohne Verknüpfung. */
export function renderBookingSummaryBadge(s: ThreadBookingSummary | null): string {
  if (!s || (!s.checkIn && !s.checkOut)) return '';
  const period = `${deDate(s.checkIn, true)}–${deDate(s.checkOut, true)}`;
  const text = s.guestsCount != null ? `${period} · ${s.guestsCount} P.` : period;
  return `<span class="badge booking-badge" title="${esc(bookingKindLabel(s))}">${esc(text)}</span>`;
}
