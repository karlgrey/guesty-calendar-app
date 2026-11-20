import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCalendarMock = vi.fn();
vi.mock('./guesty-client.js', () => ({
  guestyClient: { getCalendar: (...a: unknown[]) => getCalendarMock(...a), setListingCalendarPricing: vi.fn() },
}));
const getListingCalendarsMock = vi.fn();
const getReservationsMock = vi.fn();
const updatePricesMock = vi.fn();
const updateRestrictionsMock = vi.fn();
vi.mock('./hostex-client.js', () => ({
  getHostexClient: () => ({
    getProperties: vi.fn(),
    getListingCalendars: (...a: unknown[]) => getListingCalendarsMock(...a),
    getReservations: (...a: unknown[]) => getReservationsMock(...a),
    updateListingPrices: (...a: unknown[]) => updatePricesMock(...a),
    updateListingRestrictions: (...a: unknown[]) => updateRestrictionsMock(...a),
  }),
}));

import {
  planWriteRuns, readPricingDays, findNotApplied, writePricingChanges,
  type PricingTarget, type ProviderPricingDay,
} from './pricing-service.js';
import { addDays, type PricingChange } from './pricing-plan.js';
import { getPropertyBySlug } from '../config/properties.js';

const CH_ID = '1406340600305404294';
const guestyTarget = (): PricingTarget => ({ property: getPropertyBySlug('u19')!, provider: 'guesty', listingId: 'L' });
const hostexTarget = (): PricingTarget => ({
  property: getPropertyBySlug('bootshaus-alte-oder')!, provider: 'hostex', listingId: '12659677',
  channel: { channelType: 'airbnb', listingId: CH_ID },
});

const changes: PricingChange[] = [
  { date: '2027-05-01', price: { old: 139, new: 160 }, minNights: { old: 1, new: 2 } },
  { date: '2027-05-02', price: { old: 139, new: 160 }, minNights: { old: 1, new: 2 } },
];

beforeEach(() => {
  getCalendarMock.mockReset(); getListingCalendarsMock.mockReset(); getReservationsMock.mockReset();
  getReservationsMock.mockResolvedValue([]);
  updatePricesMock.mockReset(); updateRestrictionsMock.mockReset();
});

describe('planWriteRuns', () => {
  it('Guesty: price und minNights in einem gemeinsamen Lauf', () => {
    expect(planWriteRuns(guestyTarget(), changes)).toEqual([
      { from: '2027-05-01', to: '2027-05-02', nights: 2, price: 160, minNights: 2 },
    ]);
  });
  it('Hostex: Preis- und Mindestnächte-Läufe getrennt', () => {
    expect(planWriteRuns(hostexTarget(), changes)).toEqual([
      { from: '2027-05-01', to: '2027-05-02', nights: 2, price: 160 },
      { from: '2027-05-01', to: '2027-05-02', nights: 2, minNights: 2 },
    ]);
  });
});

describe('readPricingDays Hostex', () => {
  const emptyCal = { listings: [{ listing_id: CH_ID, channel_type: 'airbnb', calendar: [] }] };

  it('klemmt from in der Vergangenheit auf heute', async () => {
    getListingCalendarsMock.mockResolvedValue(emptyCal);
    await readPricingDays(hostexTarget(), '2026-11-01', '2026-12-01', '2026-11-20');
    expect(getListingCalendarsMock).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2026-11-20', endDate: '2026-12-01' }));
  });

  it('liefert [] ohne Abruf, wenn der ganze Zeitraum vor heute liegt', async () => {
    expect(await readPricingDays(hostexTarget(), '2026-11-01', '2026-11-10', '2026-11-20')).toEqual([]);
    expect(getListingCalendarsMock).not.toHaveBeenCalled();
  });

  async function occupiedWith(status: string) {
    getListingCalendarsMock.mockResolvedValue({ listings: [{ listing_id: CH_ID, channel_type: 'airbnb', calendar: [
      { date: '2027-05-02', price: 129, inventory: 1, restrictions: { min_stay_on_arrival: 1 } }] }] });
    getReservationsMock.mockResolvedValue([
      { reservation_code: 'HX1', status, check_in_date: '2027-05-01', check_out_date: '2027-05-04' }]);
    return (await readPricingDays(hostexTarget(), '2027-05-02', '2027-05-02', '2026-11-20'))[0];
  }
  it('Status cancelled belegt nicht', async () => { expect((await occupiedWith('cancelled')).occupied).toBe(false); });
  it('Status wait_pay belegt', async () => { expect((await occupiedWith('wait_pay')).occupied).toBe(true); });
});

describe('findNotApplied', () => {
  it('nennt Tage mit altem Preis, alter Mindestnacht oder fehlendem Tag', () => {
    const after = [
      { date: '2027-05-01', price: 160, minNights: 2, occupied: false },
      { date: '2027-05-02', price: 139, minNights: 2, occupied: false },
      { date: '2027-05-03', price: 160, minNights: 1, occupied: false },
    ];
    const ch: PricingChange[] = [
      { date: '2027-05-01', price: { old: 139, new: 160 }, minNights: { old: 1, new: 2 } },
      { date: '2027-05-02', price: { old: 139, new: 160 } },
      { date: '2027-05-03', minNights: { old: 1, new: 2 } },
      { date: '2027-05-04', price: { old: 139, new: 160 } },
    ];
    expect(findNotApplied(ch, after)).toEqual(['2027-05-02', '2027-05-03', '2027-05-04']);
  });
});

describe('writePricingChanges Hostex: Stapel und Teilfehler (Prüfer #1299)', () => {
  // 150 einzelne Tage mit je einem Tag Lücke → 150 Läufe → Stapel 100 + 50
  const dates = Array.from({ length: 150 }, (_, i) => addDays('2027-01-01', 2 * i));
  const days: ProviderPricingDay[] = dates.map((date) => ({
    date, price: 129, minNights: 2, occupied: false, closedOnArrival: false, closedOnDeparture: false,
  }));

  it('Preis: zweiter Stapel scheitert → written nennt genau die 100 Läufe des ersten', async () => {
    updatePricesMock.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('Hostex 500'));
    const ch: PricingChange[] = dates.map((date) => ({ date, price: { old: 129, new: 140 } }));
    const out = await writePricingChanges(hostexTarget(), ch, days);
    expect(out.error).toBeInstanceOf(Error);
    expect(updatePricesMock).toHaveBeenCalledTimes(2);
    expect(updatePricesMock.mock.calls[0][0].prices).toHaveLength(100);
    expect(updatePricesMock.mock.calls[1][0].prices).toHaveLength(50);
    expect(out.written).toHaveLength(100);
    expect(out.written[0]).toEqual({ from: '2027-01-01', to: '2027-01-01', nights: 1, price: 140 });
    expect(out.written[99].from).toBe(dates[99]);
    expect(updateRestrictionsMock).not.toHaveBeenCalled();
  });

  it('Mindestnächte: zweiter Stapel scheitert → Preise und die ersten 100 Mindestnächte-Läufe in written', async () => {
    updatePricesMock.mockResolvedValue({ ok: true });
    updateRestrictionsMock.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('Hostex 500'));
    const ch: PricingChange[] = dates.map((date) => ({ date, price: { old: 129, new: 140 }, minNights: { old: 2, new: 3 } }));
    const out = await writePricingChanges(hostexTarget(), ch, days);
    expect(out.error).toBeInstanceOf(Error);
    expect(out.written.filter((w) => w.price !== undefined)).toHaveLength(150);
    const min = out.written.filter((w) => w.minNights !== undefined);
    expect(min).toHaveLength(100);
    expect(min[99]).toEqual({ from: dates[99], to: dates[99], nights: 1, minNights: 3 });
  });

  it('ohne Fehler: alle Läufe in written, Sperren je Tag mitgesendet', async () => {
    updateRestrictionsMock.mockResolvedValue({ ok: true });
    const two = days.slice(0, 2).map((d, i) => ({ ...d, date: addDays('2027-05-02', i), closedOnArrival: i === 0 }));
    const ch: PricingChange[] = two.map((d) => ({ date: d.date, minNights: { old: 2, new: 3 } }));
    const out = await writePricingChanges(hostexTarget(), ch, two);
    expect(out.error).toBeUndefined();
    expect(updateRestrictionsMock.mock.calls[0][0].restrictions).toEqual([
      { startDate: '2027-05-02', endDate: '2027-05-02', minStayOnArrival: 3, closedOnArrival: true, closedOnDeparture: false },
      { startDate: '2027-05-03', endDate: '2027-05-03', minStayOnArrival: 3, closedOnArrival: false, closedOnDeparture: false },
    ]);
    // Antwort verdichtet auf den Zielwert: ein Lauf über beide Tage
    expect(out.written).toEqual([{ from: '2027-05-02', to: '2027-05-03', nights: 2, minNights: 3 }]);
    expect(updatePricesMock).not.toHaveBeenCalled();
  });
});
