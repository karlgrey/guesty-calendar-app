import { describe, it, expect } from 'vitest';
import { buildCalendarEvent } from './sync-google-calendar.js';
import type { Reservation } from '../types/models.js';

function mkReservation(over: Partial<Reservation> = {}): Reservation {
  return {
    id: 1, reservation_id: 'res-1', listing_id: 'L1', check_in: '2026-08-01', check_out: '2026-08-05',
    check_in_localized: '2026-08-01', check_out_localized: '2026-08-05', nights_count: 4,
    guest_id: null, guest_name: 'Darleen', guests_count: 2, adults_count: 2, children_count: 0, infants_count: 0,
    status: 'confirmed', confirmation_code: 'ABC', source: 'airbnb2', platform: 'airbnb2',
    planned_arrival: null, planned_departure: null, currency: 'EUR', total_price: 400, host_payout: 350,
    balance_due: null, total_paid: null, created_at_guesty: null, reserved_at: null, last_synced_at: '',
    internal_guest_id: null, guest_company: null,
    ...over,
  } as Reservation;
}

describe('buildCalendarEvent — Ganztages-Event-Enddatum (#406)', () => {
  it('addiert einen Tag für ein Nicht-DST-Checkout', () => {
    const res = mkReservation({ check_out_localized: '2026-08-05' });
    const event = buildCalendarEvent(res, 'Farmhouse', undefined, undefined);
    expect(event.end.date).toBe('2026-08-06');
  });

  it('addiert korrekt einen Tag über den Frühjahrs-DST-Übergang Europe/Berlin (29.03.2026)', () => {
    const res = mkReservation({ check_out_localized: '2026-03-29' });
    const event = buildCalendarEvent(res, 'Farmhouse', undefined, undefined);
    expect(event.end.date).toBe('2026-03-30');
  });

  it('addiert korrekt einen Tag über den Herbst-DST-Übergang Europe/Berlin (25.10.2026)', () => {
    const res = mkReservation({ check_out_localized: '2026-10-25' });
    const event = buildCalendarEvent(res, 'Farmhouse', undefined, undefined);
    expect(event.end.date).toBe('2026-10-26');
  });

  it('addiert korrekt einen Tag über einen Jahreswechsel', () => {
    const res = mkReservation({ check_out_localized: '2026-12-31' });
    const event = buildCalendarEvent(res, 'Farmhouse', undefined, undefined);
    expect(event.end.date).toBe('2027-01-01');
  });
});
