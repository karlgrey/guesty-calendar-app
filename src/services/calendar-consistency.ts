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

export function diffCalendarEvents(expected: ExpectedEvent[], actual: GoogleEventLite[]): ConsistencyDiff {
  // Dedupe doppelter erwarteter IDs — letzter Eintrag gewinnt (Verhalten wie Sync).
  const expectedById = new Map<string, ExpectedEvent>();
  for (const e of expected) expectedById.set(e.eventId, e);

  const missing: ExpectedEvent[] = [];
  const extra: ConsistencyDiff['extra'] = [];
  const mismatched: ConsistencyDiff['mismatched'] = [];
  const matchedIds = new Set<string>();

  for (const ev of actual) {
    if (!ev.id) continue;

    // dateTime-Events (keine Ganztages-Events) sind per Definition nie vom
    // Sync erzeugt (der schreibt ausschließlich Ganztages-Events) — immer
    // fremd/manuell, landen unbedingt in extra.
    if (ev.start?.dateTime && !ev.start?.date) {
      const start = ev.start.dateTime.split('T')[0];
      const end = ev.end?.dateTime ? ev.end.dateTime.split('T')[0] : null;
      extra.push(extraFrom(ev, start, end));
      continue;
    }

    const exp = expectedById.get(ev.id);
    if (!exp) {
      extra.push(extraFrom(ev, ev.start?.date ?? null, ev.end?.date ?? null));
      continue;
    }

    matchedIds.add(ev.id);
    const actualStart = ev.start?.date ?? null;
    const actualEnd = ev.end?.date ?? null;
    if (actualStart === exp.start && actualEnd === exp.endExclusive) {
      continue; // ok
    }
    mismatched.push({
      eventId: ev.id,
      summary: ev.summary ?? null,
      expected: { start: exp.start, endExclusive: exp.endExclusive },
      actual: { start: actualStart, endExclusive: actualEnd },
    });
  }

  for (const [id, exp] of expectedById) {
    if (!matchedIds.has(id)) missing.push(exp);
  }

  return { missing, extra, mismatched };
}
