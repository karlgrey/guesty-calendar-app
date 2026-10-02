import { describe, it, expect } from 'vitest';
import { effectiveTimes } from './effective-stay-times.js';
import type { StayTimeOverride } from '../repositories/stay-time-override-repository.js';

const ov = (o: Partial<StayTimeOverride> = {}): StayTimeOverride => ({
  reservationId: 'r1', plannedArrival: null, plannedDeparture: null, blockNextDay: false, note: null,
  source: 'agent', createdAt: 'x', updatedAt: 'x', ...o,
});
const defaults = { checkIn: '08:00:00', checkOut: '12:00:00' };

describe('effectiveTimes', () => {
  it('Override gewinnt vor Provider und Standard', () => {
    const t = effectiveTimes({ planned_arrival: '10:00', planned_departure: '15:00' }, ov({ plannedArrival: '14:00', plannedDeparture: '18:00' }), defaults);
    expect(t).toMatchObject({
      effectiveArrival: '14:00', arrivalSource: 'override', effectiveDeparture: '18:00', departureSource: 'override',
      providerArrival: '10:00', providerDeparture: '15:00', defaultArrival: '08:00', defaultDeparture: '12:00',
    });
  });

  it('Override null -> Provider-Wert', () => {
    const t = effectiveTimes({ planned_arrival: '10:00', planned_departure: '15:00' }, ov({ plannedDeparture: '18:00' }), defaults);
    expect(t).toMatchObject({ effectiveArrival: '10:00', arrivalSource: 'provider', effectiveDeparture: '18:00', departureSource: 'override' });
  });

  it('weder Override noch Provider -> Listing-Standard (HH:MM:SS gekürzt)', () => {
    const t = effectiveTimes({ planned_arrival: null, planned_departure: '' }, null, defaults);
    expect(t).toMatchObject({ effectiveArrival: '08:00', arrivalSource: 'default', effectiveDeparture: '12:00', departureSource: 'default' });
  });

  it('nichts bekannt -> null/null', () => {
    const t = effectiveTimes({ planned_arrival: null, planned_departure: null }, null, { checkIn: null, checkOut: null });
    expect(t).toMatchObject({ effectiveArrival: null, arrivalSource: null, effectiveDeparture: null, departureSource: null });
  });

  it('ohne Listing-Defaults (null) funktioniert es', () => {
    const t = effectiveTimes({ planned_arrival: '09:30', planned_departure: null }, null, null);
    expect(t).toMatchObject({ effectiveArrival: '09:30', arrivalSource: 'provider', effectiveDeparture: null });
  });

  it('Provider-Zeit mit Sekunden wird auf HH:MM gekürzt', () => {
    expect(effectiveTimes({ planned_arrival: '14:00:00', planned_departure: null }, null, null).providerArrival).toBe('14:00');
  });
});
