/**
 * Calendar Consistency Diff (#484)
 *
 * PURE, kein I/O. Vergleicht die Erwartung (aus den Provider-Quellen live
 * berechnet, in derselben Event-Identität/Datumslogik wie
 * `sync-google-calendar.ts`) gegen den tatsächlichen Google-Kalenderinhalt.
 * Meldet ALLES — auch manuell angelegte/veränderte Events (Entscheidung
 * Micha, 27.08.2026) — Korrektur bleibt Handarbeit.
 *
 * See docs/superpowers/specs/2026-08-27-calendar-consistency-check.md
 */

export interface ExpectedEvent {
  type: 'reservation' | 'block';
  eventId: string; // bereits normalisiert (toGoogleEventId/blockEventId)
  reservationId?: string;
  guestName?: string | null;
  status?: string;
  start: string; // YYYY-MM-DD
  endExclusive: string; // YYYY-MM-DD (Google-Ganztag exklusiv)
}

export interface GoogleEventLite {
  id: string;
  summary?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export interface ConsistencyDiff {
  missing: ExpectedEvent[];
  extra: Array<{
    googleEventId: string;
    summary: string | null;
    start: string | null;
    end: string | null;
    isOwnerBlockEvent: boolean;
  }>;
  mismatched: Array<{
    eventId: string;
    summary: string | null;
    expected: { start: string; endExclusive: string };
    actual: { start: string | null; endExclusive: string | null };
  }>;
}

/** True when [start, endExclusive) das Fenster [from, to) schneidet (beide halboffen). */
export function overlapsWindow(start: string, endExclusive: string, from: string, to: string): boolean {
  return start < to && endExclusive > from;
}

function isOwnerBlock(ev: GoogleEventLite): boolean {
  return ev.extendedProperties?.private?.kind === 'owner-block';
}

function extraFrom(ev: GoogleEventLite, start: string | null, end: string | null): ConsistencyDiff['extra'][number] {
  return {
    googleEventId: ev.id,
    summary: ev.summary ?? null,
    start,
    end,
    isOwnerBlockEvent: isOwnerBlock(ev),
  };
}

interface ClippedRange {
  start: string;
  endExclusive: string;
}

/**
 * Klippt [start, endExclusive) auf das Fenster [from, to). Liefert null, wenn
 * das geklippte Intervall leer ist (Event liegt komplett außerhalb) —
 * Aufrufer behandeln das als "ignorieren", nicht als extra/missing/mismatch
 * (Fenster-Rand-False-Positives, u. a. Google-timeMax-Zeitzonenrand).
 */
function clipToWindow(start: string, endExclusive: string, from: string, to: string): ClippedRange | null {
  const clippedStart = start > from ? start : from;
  const clippedEnd = endExclusive < to ? endExclusive : to;
  if (clippedStart >= clippedEnd) return null;
  return { start: clippedStart, endExclusive: clippedEnd };
}

export function diffCalendarEvents(
  expected: ExpectedEvent[],
  actual: GoogleEventLite[],
  from: string,
  to: string
): ConsistencyDiff {
  // Dedupe doppelter erwarteter IDs — letzter Eintrag gewinnt (Verhalten wie Sync).
  // Zusätzlich beidseitiges Fenster-Klipping (F1–F3): ein expected, das nach dem
  // Klippen leer wäre, kann laut overlapsWindow-Vorfilterung beim Bauen der
  // Erwartungsliste eigentlich nicht vorkommen — hier trotzdem defensiv
  // ignoriert, falls ein Aufrufer das nicht vorfiltert.
  const expectedById = new Map<string, { exp: ExpectedEvent; clipped: ClippedRange }>();
  for (const e of expected) {
    const clipped = clipToWindow(e.start, e.endExclusive, from, to);
    if (!clipped) continue;
    expectedById.set(e.eventId, { exp: e, clipped });
  }

  const missing: ExpectedEvent[] = [];
  const extra: ConsistencyDiff['extra'] = [];
  const mismatched: ConsistencyDiff['mismatched'] = [];
  const matchedIds = new Set<string>();

  for (const ev of actual) {
    if (!ev.id) continue;

    // dateTime-Events (keine Ganztages-Events) sind per Definition nie vom
    // Sync erzeugt (der schreibt ausschließlich Ganztages-Events) — immer
    // fremd/manuell. Ausnahme (F6): trägt die ID ein bekanntes erwartetes
    // Event (z. B. manuell in einen Termin umgewandeltes App-Event), zählt das
    // als mismatched (Datumsteil der dateTime-Werte, geklippt) statt als
    // extra — sonst würde dieselbe Reservierung doppelt gemeldet
    // (extra + missing).
    if (ev.start?.dateTime && !ev.start?.date) {
      const start = ev.start.dateTime.split('T')[0];
      const end = ev.end?.dateTime ? ev.end.dateTime.split('T')[0] : null;
      const entry = expectedById.get(ev.id);
      if (!entry) {
        extra.push(extraFrom(ev, start, end));
        continue;
      }
      matchedIds.add(ev.id);
      const clippedActual = end ? clipToWindow(start, end, from, to) : null;
      mismatched.push({
        eventId: ev.id,
        summary: ev.summary ?? null,
        expected: entry.clipped,
        actual: { start: clippedActual?.start ?? start, endExclusive: clippedActual?.endExclusive ?? end },
      });
      continue;
    }

    const actualStart = ev.start?.date ?? null;
    const actualEnd = ev.end?.date ?? null;
    const clippedActual = actualStart && actualEnd ? clipToWindow(actualStart, actualEnd, from, to) : null;

    // Geklippt leer (z. B. Google-timeMax-Zeitzonenrand: Start exakt am
    // Fenstertag `to`) -> komplett ignorieren, weder extra noch mismatch.
    if (actualStart && actualEnd && !clippedActual) continue;

    const entry = expectedById.get(ev.id);
    if (!entry) {
      extra.push(extraFrom(ev, clippedActual?.start ?? actualStart, clippedActual?.endExclusive ?? actualEnd));
      continue;
    }

    matchedIds.add(ev.id);
    const cmpStart = clippedActual?.start ?? actualStart;
    const cmpEnd = clippedActual?.endExclusive ?? actualEnd;
    if (cmpStart === entry.clipped.start && cmpEnd === entry.clipped.endExclusive) {
      continue; // ok
    }
    mismatched.push({
      eventId: ev.id,
      summary: ev.summary ?? null,
      expected: entry.clipped,
      actual: { start: cmpStart, endExclusive: cmpEnd },
    });
  }

  for (const [id, { exp }] of expectedById) {
    if (!matchedIds.has(id)) missing.push(exp);
  }

  return { missing, extra, mismatched };
}
