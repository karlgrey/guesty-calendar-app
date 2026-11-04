/**
 * Änderungsantrag-Erkennung (#976, Fall Gast AS 20.–21.11.2026).
 *
 * Ein Gast buchte versehentlich für 1 Person, beantragte in Airbnb direkt die Änderung auf
 * 3 Gäste und schrieb dazu „ich hatte mich bei der Buchung vertan …". Der Bot-Entwurf erklärte
 * Bett/Bad/Bettwäsche und forderte den Gast auf, die Personenzahl selbst anzupassen — obwohl der
 * Antrag längst bei Micha zur Annahme lag. Dieses Modul liefert dem Entwurfs-Prompt (und dem
 * Judge über den Buchungskontext) die Situation als FAKT:
 *
 * 1. `pending_request` — Hostex-Threads: die Conversation-Detail-API liefert System-Karten.
 *    Ein Änderungsantrag kommt als `display_type: 'ReservationAlteration'` (attachment.subject
 *    „Reservation alteration request", attachment.describe z. B. „Nov 20 ~ Nov 21 ・ 3 guests"),
 *    die Annahme als `display_type: 'Box'` mit content „Alteration request accepted". BEIDE
 *    tragen `sender_role: 'guest'` — die Rolle taugt nicht zur Unterscheidung. Weder
 *    `GET /reservations` noch Webhooks kennen Änderungsanträge (Recherche 26.10.2026).
 *    Live-Befund 03.11.2026 (105 Conversations, lesend): 6 Antrags-Karten, 8 „accepted"-Boxen,
 *    10 „The reservation has been cancelled."-Boxen; KEINE Ablehnungs-/Ablauf-Texte gesehen —
 *    deshalb schließt jede spätere Box, die „alteration" oder „cancel" enthält, den Antrag, und
 *    ein Antrag gilt höchstens PENDING_ALTERATION_MAX_AGE_DAYS als offen (Airbnb-Anträge
 *    verfallen; genaue Frist unverifiziert). `describe` ist NUR Anzeigetext, keine Logik.
 *    Der Mapper (message-mapper.ts) schreibt das Ergebnis als `pending_alteration` in
 *    `message_threads.raw_meta` (keine Migration).
 * 2. `guest_reports_change` — Heuristik für alle Provider (Guesty liefert keine Karten): die
 *    letzte Gastnachricht nennt mit einem Änderungs-Signal („vertan", „ändern", „statt" …) eine
 *    Personenzahl ≠ Buchung, zusätzliche Personen oder ein Datum ≠ Anreise/Abreise.
 *
 * Nur für bestätigte/reservierte Buchungen und nie zusammen mit dem Buchungsanfrage-Block
 * (eine offene Anfrage ändert der Gast in der Anfrage selbst).
 */
import { getReservationById } from '../repositories/reservation-repository.js';
import type { MessageThread, Message } from '../types/messages.js';
import type { PendingAlteration } from '../mappers/hostex/alteration-card.js';

// Reine Karten-Erkennung lebt DB-frei im Mapper-Ordner (Prüfer-Korrektur #976) und wird hier
// für bestehende Aufrufer/Tests unverändert re-exportiert.
export { detectPendingHostexAlteration, type HostexCardLike, type PendingAlteration } from '../mappers/hostex/alteration-card.js';

export const PENDING_ALTERATION_MAX_AGE_DAYS = 7;

export type AlterationSituation =
  | { kind: 'pending_request'; requestedAt: string; describe: string | null }
  | { kind: 'guest_reports_change'; detail: string };

function ms(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return Date.parse(iso);
}

/** Liest `pending_alteration` aus thread.raw_meta; verfällt nach maxAgeDays. Nie werfend. */
export function pendingAlterationFromRawMeta(
  rawMeta: string | null,
  now: Date = new Date(),
  maxAgeDays: number = PENDING_ALTERATION_MAX_AGE_DAYS,
): PendingAlteration | null {
  if (!rawMeta) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(rawMeta); } catch { return null; }
  const pa = (parsed as { pending_alteration?: unknown } | null)?.pending_alteration as
    | { requestedAt?: unknown; describe?: unknown } | null | undefined;
  if (!pa || typeof pa.requestedAt !== 'string') return null;
  const t = ms(pa.requestedAt);
  if (Number.isNaN(t)) return null;
  if (now.getTime() - t > maxAgeDays * 24 * 3600 * 1000) return null;
  return { requestedAt: pa.requestedAt, describe: typeof pa.describe === 'string' ? pa.describe : null };
}

// --- Heuristik --------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  ein: 1, eine: 1, einen: 1, einer: 1, zwei: 2, drei: 3, vier: 4, 'fünf': 5, sechs: 6, sieben: 7,
  acht: 8, neun: 9, zehn: 10, elf: 11, 'zwölf': 12,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const ZU_FORMS: Record<string, number> = {
  zweit: 2, dritt: 3, viert: 4, 'fünft': 5, sechst: 6, siebt: 7, acht: 8,
};

const NUM = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})`;
// Kinder zählen mit, damit eine Aufschlüsselung „2 Erwachsene und 2 Kinder" als Summe gegen die
// Buchung geprüft werden kann (Prüfer-Korrektur #976: löste bei 4er-Buchung + „ändern" fälschlich aus).
const PERSON_NOUN = '(?:gäste|gästen|gast|personen|person|leute|leuten|erwachsene|erwachsenen|kinder|kindern|kind|guests?|people|persons|adults?|children|child|kids?)';
const DELTA = '(?:weitere|weiteren|zusätzliche|zusätzlichen|more|additional|extra)';
// „statt 1 Person", „nicht zu dritt": die Zahl dahinter ist der ALTE/verneinte Wert, nicht der Wunsch.
const OLD_MARK = '(?:statt|anstatt|anstelle\\s+von|nicht|instead\\s+of|not)';

const CHANGE_CUE = /(vertan|versehen|versehentlich|falsch|änder|aender|anpass|korrigier|umbuch|statt|eigentlich|nachträglich|mistake|accident|wrong|chang|modif|instead|actually|update)/i;

function toNumber(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  return NUMBER_WORDS[token.toLowerCase()] ?? null;
}

/**
 * In der Nachricht genannte Gesamt-Personenzahlen (ohne „weitere …"), in Textreihenfolge.
 * `oldValues`: Zahlen hinter „statt/nicht" (alter bzw. verneinter Wert).
 */
function mentionedGuestCounts(text: string): { totals: number[]; oldValues: number[]; delta: boolean } {
  const found: { pos: number; n: number; old: boolean }[] = [];
  let delta = false;
  const deltaRe = new RegExp(`(?:${DELTA}\\s+${NUM}|${NUM}\\s+${DELTA})\\s+${PERSON_NOUN}`, 'gi');
  if (deltaRe.test(text)) delta = true;
  const totalRe = new RegExp(`(^|[^\\p{L}\\d])(${OLD_MARK}\\s+)?${NUM}\\s+(${DELTA}\\s+)?${PERSON_NOUN}(?![\\p{L}])`, 'giu');
  for (const m of text.matchAll(totalRe)) {
    if (m[4]) { delta = true; continue; }
    const n = toNumber(m[3]);
    if (n != null) found.push({ pos: m.index ?? 0, n, old: !!m[2] });
  }
  const zuRe = new RegExp(`(${OLD_MARK}\\s+)?\\bzu\\s+(${Object.keys(ZU_FORMS).join('|')})\\b`, 'giu');
  for (const m of text.matchAll(zuRe)) found.push({ pos: m.index ?? 0, n: ZU_FORMS[m[2].toLowerCase()], old: !!m[1] });
  found.sort((a, b) => a.pos - b.pos);
  return {
    totals: found.filter((f) => !f.old).map((f) => f.n),
    oldValues: found.filter((f) => f.old).map((f) => f.n),
    delta,
  };
}

function dayMonth(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])}.${Number(m[2])}` : null;
}

/** Alle Tag.Monat-Werte von Anreise bis Abreise (inklusiv; Tage im Aufenthalt sind keine Änderung). */
function stayDayMonths(checkIn: string | null, checkOut: string | null): Set<string> {
  const out = new Set<string>();
  const a = checkIn ? Date.parse(`${checkIn.slice(0, 10)}T00:00:00Z`) : NaN;
  const b = checkOut ? Date.parse(`${checkOut.slice(0, 10)}T00:00:00Z`) : NaN;
  for (const v of [dayMonth(checkIn), dayMonth(checkOut)]) if (v) out.add(v);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return out;
  for (let t = a, i = 0; t <= b && i < 60; t += 86_400_000, i++) {
    const d = new Date(t);
    out.add(`${d.getUTCDate()}.${d.getUTCMonth() + 1}`);
  }
  return out;
}

/**
 * Heuristik: liefert eine kurze Beschreibung des erkannten Änderungswunsches oder null.
 * Verlangt IMMER ein Änderungs-Signal, damit „wir sind 2 Erwachsene und 2 Kinder" bei einer
 * 4er-Buchung nicht auslöst. Personenzahl gilt als passend, wenn die ERSTE genannte Gesamtzahl
 * der Buchung entspricht („wir sind 4 Personen, 2 Erwachsene und 2 Kinder") oder eine
 * Aufschlüsselung in Summe passt („2 Erwachsene und 2 Kinder" bei 4). Zahlen hinter
 * „statt/nicht" sind der alte Wert und zählen nicht als Wunsch. Datumsangaben innerhalb des
 * Aufenthalts (Anreise…Abreise) sind keine Änderung; Uhrzeiten wie „15.30." (Monat > 12) auch nicht.
 */
export function detectAlterationWish(
  text: string,
  booking: { guestsCount: number | null; checkIn: string | null; checkOut: string | null },
): string | null {
  if (!text || !CHANGE_CUE.test(text)) return null;
  const { totals, delta } = mentionedGuestCounts(text);
  if (delta) return 'Gast nennt zusätzliche Personen';
  if (booking.guestsCount != null && totals.length > 0) {
    const sum = totals.reduce((a, b) => a + b, 0);
    const consistent = totals[0] === booking.guestsCount || (totals.length > 1 && sum === booking.guestsCount);
    if (!consistent) {
      const differing = totals.find((n) => n !== booking.guestsCount);
      if (differing != null) {
        return `Gast nennt ${differing} Personen, gebucht sind ${booking.guestsCount}`;
      }
    }
  }
  const booked = stayDayMonths(booking.checkIn, booking.checkOut);
  if (booked.size > 0) {
    for (const m of text.matchAll(/\b(\d{1,2})\.\s?(\d{1,2})\./g)) {
      const day = Number(m[1]); const month = Number(m[2]);
      if (day < 1 || day > 31 || month < 1 || month > 12) continue;
      const dm = `${day}.${month}`;
      if (!booked.has(dm)) return `Gast nennt Datum ${m[1]}.${m[2]}., abweichend von Anreise/Abreise`;
    }
  }
  return null;
}

const BOOKED_STATUSES = new Set(['confirmed', 'reserved']);

export interface AlterationDeps {
  getReservation: (id: string) => { guests_count: number | null; check_in: string; check_out: string } | null;
}
const defaultDeps: AlterationDeps = {
  getReservation: (id) => getReservationById(id),
};

function lastInbound(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === 'inbound') return messages[i].body;
  }
  return '';
}

/**
 * Situation für DIESEN Entwurf. Vorrang: echter offener Antrag (Hostex-Karte) vor Heuristik.
 * null bei Buchungsanfragen, ohne bestätigte/reservierte Buchung oder ohne Signal. Nie werfend
 * (Lookup-Fehler → Heuristik ohne Buchungsdaten bzw. null).
 */
export function resolveAlterationSituation(
  thread: Pick<MessageThread, 'raw_meta' | 'reservation_id' | 'reservation_status'>,
  messages: readonly Message[],
  opts: { isBookingRequest?: boolean; now?: Date } = {},
  deps: AlterationDeps = defaultDeps,
): AlterationSituation | null {
  if (opts.isBookingRequest) return null;
  if (!thread.reservation_status || !BOOKED_STATUSES.has(thread.reservation_status)) return null;

  const pending = pendingAlterationFromRawMeta(thread.raw_meta, opts.now ?? new Date());
  if (pending) return { kind: 'pending_request', requestedAt: pending.requestedAt, describe: pending.describe };

  let res: ReturnType<AlterationDeps['getReservation']> = null;
  if (thread.reservation_id) {
    try { res = deps.getReservation(thread.reservation_id); } catch { res = null; }
  }
  const detail = detectAlterationWish(lastInbound(messages), {
    guestsCount: res?.guests_count ?? null,
    checkIn: res?.check_in ?? null,
    checkOut: res?.check_out ?? null,
  });
  return detail ? { kind: 'guest_reports_change', detail } : null;
}

/** Eine Fakt-Zeile für Buchungskontext/Judge (der Judge sieht so dieselbe Lage wie der Entwurf). */
export function alterationFactLine(s: AlterationSituation): string {
  if (s.kind === 'pending_request') {
    return `Offener Änderungsantrag des Gastes (Plattform-Karte${s.describe ? `: „${s.describe}"` : ''}) — liegt bei Micha zur Annahme, der Gast muss nichts mehr tun.`;
  }
  return `Gast meldet einen Änderungswunsch zur Buchung (${s.detail}) — Micha kümmert sich um die Änderung.`;
}

/** bookingContext + Fakt-Zeile (für den Gate-/Judge-Aufruf). */
export function withAlterationFact(bookingContext: string | null, s: AlterationSituation | null): string | null {
  if (!s) return bookingContext;
  const line = alterationFactLine(s);
  return bookingContext ? `${bookingContext}\n${line}` : line;
}

/** Hinweis für Micha in der Admin-UI. */
export function alterationAdminHint(s: AlterationSituation): string {
  if (s.kind === 'pending_request') {
    return `Änderungsantrag in Airbnb annehmen${s.describe ? ` (${s.describe})` : ''}`;
  }
  return `Änderungswunsch erkannt (${s.detail}) — Änderungsantrag in Airbnb prüfen/annehmen`;
}
