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
  // #1244: bestätigte/reservierte Einzelabruf-Zeile (kind 'inquiry') ist eine Buchung
  const booked = s.status === 'confirmed' || s.status === 'reserved';
  const base = s.kind === 'reservation' || booked ? 'Buchung' : 'Anfrage';
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

/**
 * #1242: Preis-Teil bei Anfragen. Hauptwert ist der Gastbetrag laut Plattform (derselbe wie im
 * Entwurfs-Kontext, mit Steuer), damit Micha die Zahl sieht, auf die sich der Gast bezieht; die
 * Auszahlung steht klein daneben. total_price wird bei Anfragen nie als „Gastpreis" gezeigt — bei
 * Airbnb-Anfragen über Guesty ist es die Netto-Auszahlung.
 */
function inquiryPricePart(s: ThreadBookingSummary): string {
  const p = s.guestPrice;
  const payout = s.hostPayout != null ? `Auszahlung ${formatMoney(s.hostPayout, s.currency)}` : null;
  const small = (items: Array<string | null>) => {
    const text = items.filter((x): x is string => !!x).join(' · ');
    return text ? ` <small style="opacity:.75">${esc(text)}</small>` : '';
  };
  if (p?.kind === 'estimated') {
    return (
      `<strong>${esc(`Gastpreis laut ${p.channel} ca. ${formatMoney(p.inclTax, p.currency)} inkl. Steuern`)}</strong>` +
      small([`berechnet, ohne Steuern ca. ${formatMoney(p.exclTax, p.currency)}`, payout])
    );
  }
  if (p?.kind === 'actual') {
    return `<strong>${esc(`Gastpreis laut ${p.channel} ${formatMoney(p.total, p.currency)} inkl. Steuern`)}</strong>` + small([payout]);
  }
  if (p?.kind === 'accommodation') {
    const accommodation = `Übernachtungspreis ${formatMoney(p.amount, p.currency)} (ohne Reinigung/Steuern)`;
    return payout ? `<strong>${esc(payout)}</strong>` + small([accommodation]) : `<strong>${esc(accommodation)}</strong>`;
  }
  return payout ? `<strong>${esc(payout)}</strong>` + small(['Gastpreis unbekannt']) : 'Preis unbekannt';
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
  if (s.kind === 'inquiry') {
    parts.push(inquiryPricePart(s));
  } else if (s.hostPayout == null && s.totalPrice == null) {
    parts.push('Preis unbekannt');
  } else {
    const payout = s.hostPayout != null ? formatMoney(s.hostPayout, s.currency) : '–';
    const guest = s.totalPrice != null ? formatMoney(s.totalPrice, s.currency) : '–';
    parts.push(`<strong>Auszahlung ${esc(payout)}</strong> <small style="opacity:.75">Gastpreis ${esc(guest)}</small>`);
  }
  return `<p class="subtitle booking-summary" style="margin-top:-4px">${parts.join(' · ')}</p>`;
}

/** #1243: Zeile „Betrag in der Gastnachricht …“ unter der Kopfzeile; leer ohne Notiz. */
export function renderCounterOfferLine(note: string | null): string {
  if (!note) return '';
  return `<p class="subtitle counter-offer" style="margin-top:-4px">${esc(note)}</p>`;
}

/** Kompaktes Listen-Badge „31.12.–01.01. · 1 P." (ohne Preis); leer ohne Verknüpfung. */
export function renderBookingSummaryBadge(s: ThreadBookingSummary | null): string {
  if (!s || (!s.checkIn && !s.checkOut)) return '';
  const period = `${deDate(s.checkIn, true)}–${deDate(s.checkOut, true)}`;
  const text = s.guestsCount != null ? `${period} · ${s.guestsCount} P.` : period;
  return `<span class="badge booking-badge" title="${esc(bookingKindLabel(s))}">${esc(text)}</span>`;
}
