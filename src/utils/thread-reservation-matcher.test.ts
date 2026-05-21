import { describe, it, expect } from 'vitest';
import {
  matchThreadToReservation,
  type ReservationMatcherCandidate,
  type ThreadMatcherInput,
} from './thread-reservation-matcher.js';

// Realistic Farmhouse reservation candidates pulled from live data
const reservations: ReservationMatcherCandidate[] = [
  { reservationId: 'GY-aaa', guestName: 'Pexon Consulting GmbH Noel Dinger', checkIn: '2026-07-22' },
  { reservationId: 'GY-bbb', guestName: 'Langdock GmbH Lennard Schmidt',     checkIn: '2026-09-12' },
  { reservationId: 'GY-ccc', guestName: 'Awake Project GmbH BIRGIT AMRHEIN', checkIn: '2026-08-05' },
  { reservationId: 'GY-ddd', guestName: 'S. Fischer Verlage GmbH Katharina', checkIn: '2026-10-01' },
  { reservationId: 'GY-eee', guestName: 'Michael Krüger',                    checkIn: '2026-11-01' },
];

function makeThread(guestName: string | null, guestEmail: string | null): ThreadMatcherInput {
  return { guestName, guestEmail, lastMessageAt: '2026-05-15T12:00:00.000Z' };
}

describe('matchThreadToReservation', () => {
  it('matches via email local-part fully contained (Pexon)', () => {
    const t = makeThread('Noel Dinger', 'noel.dinger@pexon-consulting.de');
    const m = matchThreadToReservation(t, reservations);
    expect(m?.reservationId).toBe('GY-aaa');
    expect(m?.score).toBeGreaterThanOrEqual(3.0);
  });

  it('matches via first+last token contained (Langdock)', () => {
    const t = makeThread('Lennard Schmidt', 'lennard@langdock.com');
    const m = matchThreadToReservation(t, reservations);
    expect(m?.reservationId).toBe('GY-bbb');
  });

  it('matches via email-domain second-level (Awake Project)', () => {
    // Email is firstname only, but domain "awakeprojects.de" matches reservation "Awake Project GmbH"
    const t = makeThread('Birgit Amrhein', 'birgit@awakeprojects.de');
    const m = matchThreadToReservation(t, reservations);
    expect(m?.reservationId).toBe('GY-ccc');
  });

  it('matches simple personal name match (Michael Krüger)', () => {
    const t = makeThread('Michael Krüger', 'michael.krueger1981@gmail.com');
    const m = matchThreadToReservation(t, reservations);
    expect(m?.reservationId).toBe('GY-eee');
  });

  it('matches short reservation name vs. full thread name (Cynthia)', () => {
    // Reservation guest_name = just "Cynthia"; Gmail thread has the full name.
    const onlyFirst: ReservationMatcherCandidate[] = [
      { reservationId: 'GY-cyn', guestName: 'Cynthia', checkIn: '2025-08-24' },
    ];
    const t = makeThread('Cynthia Mensah-Neglokpe', 'cynthia@clicqui.de');
    expect(matchThreadToReservation(t, onlyFirst)?.reservationId).toBe('GY-cyn');
  });

  it('matches company-only reservation via email domain + lastname.firstname structure', () => {
    // Reservation guest_name = company name only; thread has person + corp email.
    const companyOnly: ReservationMatcherCandidate[] = [
      {
        reservationId: 'GY-corp',
        guestName: 'digitransform.de Gesellschaft für digitale Transformation mbH',
        checkIn: '2025-11-04',
      },
    ];
    const t = makeThread('Thomas Griess', 'thomas.griess@digitransform.de');
    expect(matchThreadToReservation(t, companyOnly)?.reservationId).toBe('GY-corp');
  });

  it('matches initialed sender against company GmbH-reservation (LB → Orcrist)', () => {
    // Thread sender uses initials only ("LB"), email lb@orcrist.org.
    // Reservation includes "GmbH" — company-level signal is strong enough.
    const orcrist: ReservationMatcherCandidate[] = [
      { reservationId: 'GY-orc', guestName: 'Orcrist Technologies GmbH Lucas Barth', checkIn: '2026-04-26' },
    ];
    const t = makeThread('LB', 'lb@orcrist.org');
    expect(matchThreadToReservation(t, orcrist)?.reservationId).toBe('GY-orc');
  });

  it('matches single-token email vs. company GmbH-reservation (Zlata → Almedia)', () => {
    const almedia: ReservationMatcherCandidate[] = [
      { reservationId: 'GY-alm', guestName: 'Almedia GmbH', checkIn: '2026-08-21' },
    ];
    const t = makeThread('Zlata Todorovic', 'zlata@almedia.co');
    expect(matchThreadToReservation(t, almedia)?.reservationId).toBe('GY-alm');
  });

  it('strips company noise — "GmbH" in reservation does not block match', () => {
    const t = makeThread('Katharina', 'katharina.matross.ext@fischerverlage.de');
    const m = matchThreadToReservation(t, reservations);
    expect(m?.reservationId).toBe('GY-ddd');
  });

  it('returns null below threshold (generic email, no name overlap)', () => {
    const t = makeThread('Alex Stranger', 'alex@unknown-company.com');
    expect(matchThreadToReservation(t, reservations)).toBeNull();
  });

  it('returns null for empty inputs', () => {
    expect(matchThreadToReservation(makeThread(null, null), reservations)).toBeNull();
    expect(matchThreadToReservation(makeThread('Anna', 'a@b.c'), [])).toBeNull();
  });

  it('does not match unrelated guest with similar-looking domain', () => {
    // "Pexon" guest at "tomato.com" → no link to Pexon reservation
    const t = makeThread('Different Person', 'unknown@tomato.com');
    expect(matchThreadToReservation(t, reservations)).toBeNull();
  });

  it('tie-break: closer check-in to thread date wins', () => {
    const dup = [
      { reservationId: 'GY-near', guestName: 'Lennard Schmidt', checkIn: '2026-05-20' },
      { reservationId: 'GY-far',  guestName: 'Lennard Schmidt', checkIn: '2027-08-01' },
    ];
    const t = makeThread('Lennard Schmidt', 'lennard@langdock.com');
    const m = matchThreadToReservation(t, dup);
    expect(m?.reservationId).toBe('GY-near');
  });

  it('respects custom threshold', () => {
    const t = makeThread('Anna', 'anna@nowhere.com');
    // With default threshold 2.0, single-token "Anna" against "Michael Krüger" = no match
    expect(matchThreadToReservation(t, reservations)).toBeNull();
    // Lower threshold to 0.5: still no match because score is 0
    expect(matchThreadToReservation(t, reservations, { threshold: 0.5 })).toBeNull();
  });
});
