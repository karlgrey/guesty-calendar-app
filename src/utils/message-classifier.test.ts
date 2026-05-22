import { describe, it, expect } from 'vitest';
import { classifyThread } from './message-classifier.js';

function msg(direction: 'inbound' | 'outbound', body: string) {
  return { direction, body };
}

describe('classifyThread', () => {
  // ── CONFIRMED priority
  it('returns CONFIRMED when reservation_status is confirmed (regardless of body)', () => {
    const out = classifyThread({
      reservationStatus: 'confirmed',
      channel: 'airbnb',
      messages: [msg('inbound', 'wir planen unsere Hochzeit hier zu feiern')],
    });
    expect(out.category).toBe('CONFIRMED');
    expect(out.confidence).toBe(1.0);
  });

  // ── PARTY
  it('detects PARTY from real Yuval-style inquiry', () => {
    const out = classifyThread({
      reservationStatus: 'declined',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Wir planen aktuell eine kleine Hochzeit in Berlin im Juni 2027…'),
      ],
    });
    expect(out.category).toBe('PARTY');
    expect(out.matchedKeywords).toContain('hochzeit');
  });

  it('detects PARTY-via-event-keyword (Ottavia: baptism celebration)', () => {
    const out = classifyThread({
      reservationStatus: 'declined',
      channel: 'airbnb',
      messages: [
        msg(
          'inbound',
          'organizing a small family gathering — a baptism celebration — for around 30 close friends',
        ),
      ],
    });
    expect(out.category).toBe('PARTY');
  });

  it('detects COMMERCIAL from drehort even without "hochzeit"', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [msg('inbound', 'Ich suche derzeit nach einem geeigneten Drehort.')],
    });
    expect(out.category).toBe('COMMERCIAL');
  });

  // ── DIRECT_DRIFT
  it('detects DIRECT_DRIFT from guest sharing WhatsApp (Airbnb channel)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [msg('inbound', 'Können wir das per WhatsApp besprechen?')],
    });
    expect(out.category).toBe('DIRECT_DRIFT');
    expect(out.matchedKeywords).toContain('whatsapp');
  });

  it('detects DIRECT_DRIFT from host pulling guest back to Airbnb', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Hi can we agree on a price?'),
        msg('outbound', 'Bitte bucht regulär hier über Airbnb, dann passt das.'),
      ],
    });
    expect(out.category).toBe('DIRECT_DRIFT');
    expect(out.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('boosts DIRECT_DRIFT confidence when guest hands out contact AND host pulls back', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'My email is foo@bar.com, write me there.'),
        msg('outbound', 'Bitte regulär über Airbnb buchen, das passt.'),
      ],
    });
    expect(out.category).toBe('DIRECT_DRIFT');
    expect(out.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('does NOT apply DIRECT_DRIFT to direct-email channel (would be circular)', () => {
    // Direct emails are already off-platform; drift on thread-level is meaningless.
    // Drift detection happens via cross-referencing Airbnb + email threads at dashboard level.
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'direct_email',
      messages: [msg('inbound', 'Können wir das per WhatsApp besprechen?')],
    });
    expect(out.category).not.toBe('DIRECT_DRIFT');
  });

  it('does not flag corporate offsite as separate category — those tend to book and fall through to OTHER', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg(
          'inbound',
          'Mein Team und ich würden gerne bei euch ein Offsite machen für 12 Personen.',
        ),
      ],
    });
    expect(out.category).toBe('OTHER');
  });

  // ── PRICE
  it('detects PRICE with budget number (Shavana-style)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg(
          'inbound',
          'We have a maximum budget of 3000€ for the two nights. Would you accommodate?',
        ),
      ],
    });
    expect(out.category).toBe('PRICE');
    expect(out.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects PRICE with general negotiation keyword, lower confidence', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [msg('inbound', 'Geht es etwas günstiger? Sind Studenten.')],
    });
    expect(out.category).toBe('PRICE');
    expect(out.confidence).toBeLessThan(0.8);
  });

  // ── OTHER
  it('classifies a generic pre-booking question as INFO', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [msg('inbound', 'Do you accept a large well-behaved dog?')],
    });
    expect(out.category).toBe('INFO');
  });

  it('returns OTHER for empty thread', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [],
    });
    expect(out.category).toBe('OTHER');
  });

  // ── SPAM
  it('detects SPAM from "ich unterstütze Hosts" pitch (Tamsir-style)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Ich unterstütze Hosts dabei, Auslastung und Bewertungsscore gezielt zu steigern.'),
      ],
    });
    expect(out.category).toBe('SPAM');
    expect(out.confidence).toBe(0.85);
  });

  it('detects SPAM from "360° Rundgang" service offer (Leon-style)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'dein Inserat wirkt ansprechend – mit einem professionellen 360° Rundgang noch stärker.'),
      ],
    });
    expect(out.category).toBe('SPAM');
  });

  it('detects SPAM via possessive+offer combo (Sophia-style property-management pitch)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Ich biete dir treue Unterstützung bei der Verwaltung deiner Ferienwohnung.'),
      ],
    });
    expect(out.category).toBe('SPAM');
    expect(out.confidence).toBe(0.8);
  });

  it('priority: SPAM beats PRICE when a pitch mentions a price', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Ich unterstütze Hosts dabei, mehr Buchungen zu generieren — schon ab 99€ im Monat.'),
      ],
    });
    expect(out.category).toBe('SPAM');
  });

  // ── COMMERCIAL
  it('detects COMMERCIAL from photographer requesting the property as a location (Lea-style)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Lieber Christian, ich bin Fotograf/in und bin auf deine schöne Unterkunft aufmerksam geworden.'),
      ],
    });
    expect(out.category).toBe('COMMERCIAL');
  });

  it('priority: COMMERCIAL beats PARTY when a shoot request also mentions a Feier', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Ich bin Fotografin und würde die Unterkunft gerne für ein Shooting und eine kleine Feier nutzen.'),
      ],
    });
    expect(out.category).toBe('COMMERCIAL');
  });

  it('detects COMMERCIAL from a location request for a standalone "Shooting"', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Hallo, wir suchen eine Location für ein zweitägiges Shooting im Frühjahr.'),
      ],
    });
    expect(out.category).toBe('COMMERCIAL');
  });

  // ── NO_AVAILABILITY
  it('detects NO_AVAILABILITY when host declines because dates are booked', () => {
    const out = classifyThread({
      reservationStatus: 'declined',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Hallo, hättet ihr am ersten Juni-Wochenende frei?'),
        msg('outbound', 'Leider sind wir an dem Wochenende schon ausgebucht.'),
      ],
    });
    expect(out.category).toBe('NO_AVAILABILITY');
  });

  // ── INFO
  it('detects INFO from a public-transport question (Matilde-style)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [msg('inbound', 'Hello there, is it possible to arrive there with public transport?')],
    });
    expect(out.category).toBe('INFO');
  });

  it('priority: NO_AVAILABILITY beats INFO when guest asks AND host says booked', () => {
    const out = classifyThread({
      reservationStatus: 'declined',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Habt ihr am Wochenende noch frei?'),
        msg('outbound', 'Leider schon vergeben.'),
      ],
    });
    expect(out.category).toBe('NO_AVAILABILITY');
  });

  // ── Priority order verification
  it('priority: PARTY beats PRICE when both keywords present', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg(
          'inbound',
          'Wir möchten unsere Hochzeit feiern, Budget ist 5000€ für eine Nacht.',
        ),
      ],
    });
    expect(out.category).toBe('PARTY');
  });

  it('priority: PARTY beats DIRECT_DRIFT when both present', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Wir möchten unsere Hochzeit feiern, schreib mir per WhatsApp.'),
      ],
    });
    expect(out.category).toBe('PARTY');
  });

  it('priority: DIRECT_DRIFT beats PRICE when both present (Airbnb channel)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Budget 2000€. Können wir das per WhatsApp besprechen?'),
      ],
    });
    expect(out.category).toBe('DIRECT_DRIFT');
  });
});
