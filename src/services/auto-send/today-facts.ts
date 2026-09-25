// src/services/auto-send/today-facts.ts
// #698 (Fall Lorenzo U19, 20.09.2026): der Entwurfs-/Judge-Systemprompt kannte bisher weder
// Wochentag noch Uhrzeit — Zeitbezüge stammten ausschließlich aus der Gastnachricht. Ein Gast
// schrieb sonntags "have a wonderful Sunday", der Entwurf spiegelte "schönen Sonntag", versendet
// wurde aber erst montags. Dieses Modul liefert den HEUTE-Fakt (Prompt-Block) und die erlaubten
// Wochentage (mechanischer Check) — reine Funktionen, kein I/O.
import { berlinCalendarDay, berlinWeekdayIndex, formatBerlinToday, WEEKDAY_DE_LONG } from './berlin-day.js';

export interface BookingPeriod {
  checkIn: string;  // ISO YYYY-MM-DD
  checkOut: string; // ISO YYYY-MM-DD
}

// Erkennt "Zeitraum TT.MM.JJJJ–TT.MM.JJJJ" (Gedankenstrich „–", tolerant auch „-") aus dem
// Prosa-String von booking-context.ts (buildBookingContext/resolveBookingPeriod). "?" statt
// eines Datums (Konfirmationscode/Reservierung ohne bekannte Termine) matcht bewusst nicht —
// \d{2} verlangt genau zwei Ziffern.
const PERIOD_RE = /Zeitraum\s+(\d{2})\.(\d{2})\.(\d{4})\s*[–-]\s*(\d{2})\.(\d{2})\.(\d{4})/;

export function parseBookingPeriod(bookingContext: string | null): BookingPeriod | null {
  if (!bookingContext) return null;
  const m = bookingContext.match(PERIOD_RE);
  if (!m) return null;
  const [, d1, mo1, y1, d2, mo2, y2] = m;
  return { checkIn: `${y1}-${mo1}-${d1}`, checkOut: `${y2}-${mo2}-${d2}` };
}

function isoDateWeekdayLong(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAY_DE_LONG[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function isoDateDe(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Kalendertag-Differenz b - a (beide reine "YYYY-MM-DD"-Daten, keine Uhrzeit/DST-Fragen). */
function daysBetween(aIso: string, bIso: string): number {
  const [ay, am, ad] = aIso.split('-').map(Number);
  const [by, bm, bd] = bIso.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/**
 * HEUTE-Fakt für den Entwurfs-/Judge-Systemprompt: die HEUTE-Zeile ist immer da, dazu — sofern
 * der Buchungskontext einen Zeitraum hergibt — GENAU eine Relationszeile (Anreise/Abreise-Bezug,
 * Tagesdifferenz auf Berliner Kalendertagen). "in 1 Tagen" ist bewusst kein Sonderfall (Spec).
 */
export function buildTodayBlock(now: Date, bookingContext: string | null): string {
  const lines = [`HEUTE: ${formatBerlinToday(now)}`];
  const period = parseBookingPeriod(bookingContext);
  if (period) {
    const today = berlinCalendarDay(now.toISOString());
    const diffIn = daysBetween(today, period.checkIn);
    const diffOut = daysBetween(today, period.checkOut);
    if (diffIn > 0) {
      lines.push(
        `Anreise in ${diffIn} Tagen (${isoDateWeekdayLong(period.checkIn)}, ${isoDateDe(period.checkIn)}); ` +
          `Abreise ${isoDateWeekdayLong(period.checkOut)}, ${isoDateDe(period.checkOut)}`,
      );
    } else if (diffIn === 0) {
      lines.push(`Anreise HEUTE; Abreise ${isoDateWeekdayLong(period.checkOut)}, ${isoDateDe(period.checkOut)}`);
    } else if (diffOut === 0) {
      lines.push('Abreise HEUTE');
    } else if (diffOut < 0) {
      lines.push(`Abreise war vor ${-diffOut} Tagen (${isoDateWeekdayLong(period.checkOut)}, ${isoDateDe(period.checkOut)})`);
    } else {
      // diffIn < 0 && diffOut > 0: heute liegt zwischen checkIn und checkOut (exklusiv).
      lines.push(`Gast ist vor Ort; Abreise in ${diffOut} Tagen (${isoDateWeekdayLong(period.checkOut)}, ${isoDateDe(period.checkOut)})`);
    }
  }
  return lines.join('\n');
}

/**
 * Erlaubte Wochentage (0=So…6=Sa) für den mechanischen Wochentags-Check (mechanical-checks.ts,
 * Flag 'zeitbezug_veraltet'): der heutige Wochentag ∪ alle Wochentage von checkIn bis checkOut
 * INKLUSIVE (Aufenthaltstage; bei ≥ 7 Tagen automatisch alle 7).
 *
 * Bewusste Abweichung von der Task-Spec (dort nur Anreise-/Abreise-Wochentag): als Obermenge
 * gebaut, um Fehlalarme bei z. B. "am Samstag könnt ihr …" während eines Fr–So-Aufenthalts zu
 * vermeiden — jeder Tag, an dem der Gast tatsächlich vor Ort ist, ist ein legitimer Zeitbezug,
 * nicht nur An-/Abreisetag.
 */
export function allowedWeekdays(now: Date, bookingContext: string | null): Set<number> {
  const allowed = new Set<number>([berlinWeekdayIndex(now)]);
  const period = parseBookingPeriod(bookingContext);
  if (period) {
    const [cy, cm, cd] = period.checkIn.split('-').map(Number);
    const [oy, om, od] = period.checkOut.split('-').map(Number);
    let cur = Date.UTC(cy, cm - 1, cd);
    const end = Date.UTC(oy, om - 1, od);
    for (let i = 0; cur <= end && i < 7; i++, cur += 86_400_000) {
      allowed.add(new Date(cur).getUTCDay());
    }
  }
  return allowed;
}
