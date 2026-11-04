import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  detectPendingHostexAlteration, pendingAlterationFromRawMeta, detectAlterationWish,
  resolveAlterationSituation, withAlterationFact, alterationAdminHint, type HostexCardLike,
} from './alteration-request.js';
import type { Message } from '../types/messages.js';

const card = (at: string, describe = 'Nov 20 ~ Nov 21 ・ 3 guests'): HostexCardLike => ({
  display_type: 'ReservationAlteration', content: '', created_at: at,
  attachment: { subject: 'Reservation alteration request', describe },
});
const box = (at: string, content: string): HostexCardLike => ({ display_type: 'Box', content, created_at: at });
const text = (at: string, content: string): HostexCardLike => ({ display_type: 'Text', content, created_at: at });

describe('detectPendingHostexAlteration (#976)', () => {
  it('offene Karte ohne Annahme → pending mit describe', () => {
    const out = detectPendingHostexAlteration([
      text('2026-10-26T08:42:00+00:00', 'ich hatte mich vertan'),
      card('2026-10-26T08:41:12+00:00'),
    ]);
    expect(out).toEqual({ requestedAt: '2026-10-26T08:41:12+00:00', describe: 'Nov 20 ~ Nov 21 ・ 3 guests' });
  });

  it('Annahme-Box nach der Karte schließt den Antrag (beide sender_role guest)', () => {
    expect(detectPendingHostexAlteration([
      box('2026-10-26T08:55:31+00:00', 'Alteration request accepted'),
      card('2026-10-26T08:41:12+00:00'),
    ])).toBeNull();
  });

  it('Storno-Box schließt ebenfalls', () => {
    expect(detectPendingHostexAlteration([
      card('2026-10-26T08:41:12+00:00'),
      box('2026-10-27T08:00:00+00:00', 'The reservation has been cancelled.'),
    ])).toBeNull();
  });

  it('neuer Antrag nach früherer Annahme ist wieder offen', () => {
    const out = detectPendingHostexAlteration([
      card('2026-10-28T10:00:00+00:00', 'Nov 20 ~ Nov 22 ・ 3 guests'),
      box('2026-10-26T08:55:31+00:00', 'Alteration request accepted'),
      card('2026-10-26T08:41:12+00:00'),
    ]);
    expect(out?.describe).toBe('Nov 20 ~ Nov 22 ・ 3 guests');
  });

  it('keine Karte → null; leere Box schließt nichts', () => {
    expect(detectPendingHostexAlteration([text('2026-10-26T08:42:00+00:00', 'Hallo')])).toBeNull();
    expect(detectPendingHostexAlteration([card('2026-10-26T08:41:12+00:00'), box('2026-10-27T00:00:00+00:00', '')])).not.toBeNull();
  });

  it('echtes Fixture (Juni 2026): Antrag wurde angenommen → nicht offen', () => {
    const raw = JSON.parse(readFileSync('src/test-fixtures/hostex/conversations.json', 'utf8'));
    const findMessages = (o: unknown): HostexCardLike[] | null => {
      if (!o || typeof o !== 'object') return null;
      const r = o as Record<string, unknown>;
      if (Array.isArray(r.messages) && r.messages.some((m) => (m as HostexCardLike).display_type === 'ReservationAlteration')) {
        return r.messages as HostexCardLike[];
      }
      for (const v of Object.values(r)) { const f = findMessages(v); if (f) return f; }
      return null;
    };
    const msgs = findMessages(raw);
    expect(msgs).not.toBeNull();
    expect(detectPendingHostexAlteration(msgs!)).toBeNull();
    expect(detectPendingHostexAlteration(msgs!.filter((m) => m.display_type !== 'Box'))).not.toBeNull();
  });
});

describe('pendingAlterationFromRawMeta (#976)', () => {
  const now = new Date('2026-10-26T09:00:00Z');
  it('liest pending_alteration aus raw_meta', () => {
    const meta = JSON.stringify({ channel_type: 'airbnb', pending_alteration: { requestedAt: '2026-10-26T08:41:12+00:00', describe: 'x' } });
    expect(pendingAlterationFromRawMeta(meta, now)).toEqual({ requestedAt: '2026-10-26T08:41:12+00:00', describe: 'x' });
  });
  it('null bei fehlendem Feld, kaputtem JSON, null-Wert oder zu altem Antrag', () => {
    expect(pendingAlterationFromRawMeta(null, now)).toBeNull();
    expect(pendingAlterationFromRawMeta('{kaputt', now)).toBeNull();
    expect(pendingAlterationFromRawMeta(JSON.stringify({ pending_alteration: null }), now)).toBeNull();
    const old = JSON.stringify({ pending_alteration: { requestedAt: '2026-10-10T08:00:00Z', describe: null } });
    expect(pendingAlterationFromRawMeta(old, now)).toBeNull();
  });
});

describe('detectAlterationWish — Heuristik (#976)', () => {
  const b1 = { guestsCount: 1, checkIn: '2026-11-20', checkOut: '2026-11-21' };
  it('Fall AS: „vertan … für 3 Gäste" bei 1 gebuchtem Gast', () => {
    expect(detectAlterationWish('Hallo, ich hatte mich bei der Buchung vertan und wollte gerne für 3 Gäste buchen.', b1))
      .toBe('Gast nennt 3 Personen, gebucht sind 1');
  });
  it('Zahlwort und „zu dritt statt zu zweit"', () => {
    expect(detectAlterationWish('Wir kommen doch zu dritt statt zu zweit', { ...b1, guestsCount: 2 })).toContain('3 Personen');
    expect(detectAlterationWish('Sorry, wrong booking, we are three guests', b1)).toContain('3 Personen');
  });
  it('zusätzliche Personen mit Änderungs-Signal', () => {
    expect(detectAlterationWish('Können wir die Buchung ändern? Es kommen 2 weitere Personen mit.', { ...b1, guestsCount: 2 }))
      .toBe('Gast nennt zusätzliche Personen');
  });
  it('abweichendes Datum mit Änderungs-Signal', () => {
    expect(detectAlterationWish('Wir möchten die Buchung auf den 22.11. ändern', b1)).toContain('22.11.');
  });
  it('kein Signal → null (Personenzahl ohne Änderungswort)', () => {
    expect(detectAlterationWish('Wir sind 2 Erwachsene und 2 Kinder, gibt es Parkplätze?', { ...b1, guestsCount: 4 })).toBeNull();
  });
  it('Signal, aber Zahl passt zur Buchung → null', () => {
    expect(detectAlterationWish('Eigentlich sind wir 1 Person, passt alles', b1)).toBeNull();
  });
  it('reiner Dank → null', () => {
    expect(detectAlterationWish('Vielen Dank für alles, war super!', b1)).toBeNull();
  });

  // Prüfer-Korrekturen #976: Fehlalarme der ersten Fassung.
  const b4 = { guestsCount: 4, checkIn: '2026-11-20', checkOut: '2026-11-22' };
  it('Aufschlüsselung in Summe = Buchung → null, auch mit Änderungs-Signal zu anderem Thema', () => {
    expect(detectAlterationWish('Können wir die Ankunftszeit ändern? Wir sind 2 Erwachsene und 2 Kinder.', b4)).toBeNull();
    expect(detectAlterationWish('Wir sind 4 Personen, 2 Erwachsene und 2 Kinder — könnt ihr das Kinderbett anpassen?', b4)).toBeNull();
  });
  it('Zahl hinter „statt/nicht" ist der alte Wert', () => {
    expect(detectAlterationWish('Statt 1 Person kommen wir jetzt zu dritt.', b1)).toContain('3 Personen');
    expect(detectAlterationWish('Wir kommen zu zweit, nicht zu dritt — ändert sich am Preis etwas?', { ...b1, guestsCount: 2 })).toBeNull();
    expect(detectAlterationWish('Wir sind jetzt 2 Personen statt 4 Personen, bitte ändern.', b4)).toContain('2 Personen');
  });
  it('Uhrzeit „15.30." und Tage innerhalb des Aufenthalts sind keine Datumsänderung', () => {
    expect(detectAlterationWish('Wir kommen am 20.11. gegen 15.30. Könnt ihr den Check-in anpassen?', b4)).toBeNull();
    expect(detectAlterationWish('Eigentlich wollte ich fragen, ob am 21.11. jemand da ist, um uns das Tor zu zeigen.', b4)).toBeNull();
    expect(detectAlterationWish('Könnten wir statt am 22.11. erst am 23.11. abreisen?', b4)).toContain('23.11.');
  });
});

function msg(direction: Message['direction'], body: string): Message {
  return { id: body, thread_id: 't', direction, sent_at: '2026-10-26T08:42:00Z', from_name: null, from_address: null, to_address: null, subject: null, body, body_html: null, source: 'hostex', raw_meta: null };
}

describe('resolveAlterationSituation (#976)', () => {
  const now = new Date('2026-10-26T09:00:00Z');
  const deps = { getReservation: () => ({ guests_count: 1, check_in: '2026-11-20', check_out: '2026-11-21' }) };
  const pendingMeta = JSON.stringify({ channel_type: 'airbnb', pending_alteration: { requestedAt: '2026-10-26T08:41:12+00:00', describe: 'Nov 20 ~ Nov 21 ・ 3 guests' } });
  const msgs = [msg('inbound', 'Ich hatte mich vertan und wollte für 3 Gäste buchen')];

  it('offene Karte hat Vorrang vor der Heuristik', () => {
    const s = resolveAlterationSituation({ raw_meta: pendingMeta, reservation_id: 'R', reservation_status: 'confirmed' }, msgs, { now }, deps);
    expect(s).toEqual({ kind: 'pending_request', requestedAt: '2026-10-26T08:41:12+00:00', describe: 'Nov 20 ~ Nov 21 ・ 3 guests' });
  });
  it('ohne Karte greift die Heuristik', () => {
    const s = resolveAlterationSituation({ raw_meta: null, reservation_id: 'R', reservation_status: 'confirmed' }, msgs, { now }, deps);
    expect(s).toEqual({ kind: 'guest_reports_change', detail: 'Gast nennt 3 Personen, gebucht sind 1' });
  });
  it('null bei Buchungsanfrage oder unbestätigtem Status', () => {
    expect(resolveAlterationSituation({ raw_meta: pendingMeta, reservation_id: 'R', reservation_status: 'confirmed' }, msgs, { now, isBookingRequest: true }, deps)).toBeNull();
    expect(resolveAlterationSituation({ raw_meta: pendingMeta, reservation_id: 'R', reservation_status: 'inquiry' }, msgs, { now }, deps)).toBeNull();
    expect(resolveAlterationSituation({ raw_meta: pendingMeta, reservation_id: 'R', reservation_status: null }, msgs, { now }, deps)).toBeNull();
  });
  it('Lookup-Fehler wirft nicht', () => {
    const s = resolveAlterationSituation({ raw_meta: null, reservation_id: 'R', reservation_status: 'confirmed' }, msgs, { now }, { getReservation: () => { throw new Error('db'); } });
    expect(s).toBeNull();
  });
});

describe('withAlterationFact / alterationAdminHint (#976)', () => {
  it('hängt die Fakt-Zeile an den Buchungskontext an', () => {
    const s = { kind: 'pending_request' as const, requestedAt: 'x', describe: 'Nov 20 ~ Nov 21 ・ 3 guests' };
    expect(withAlterationFact('Bestätigte Buchung …', s)).toBe('Bestätigte Buchung …\nOffener Änderungsantrag des Gastes (Plattform-Karte: „Nov 20 ~ Nov 21 ・ 3 guests") — liegt bei Micha zur Annahme, der Gast muss nichts mehr tun.');
    expect(withAlterationFact('ctx', null)).toBe('ctx');
    expect(alterationAdminHint(s)).toBe('Änderungsantrag in Airbnb annehmen (Nov 20 ~ Nov 21 ・ 3 guests)');
    expect(alterationAdminHint({ kind: 'guest_reports_change', detail: 'd' })).toContain('Änderungsantrag in Airbnb prüfen/annehmen');
  });
});
