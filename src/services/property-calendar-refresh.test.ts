import { describe, it, expect, vi, beforeEach } from 'vitest';

const syncAvailabilityMock = vi.fn();
const syncGoogleMock = vi.fn();
vi.mock('../jobs/sync-availability.js', () => ({ syncAvailability: (...a: unknown[]) => syncAvailabilityMock(...a) }));
vi.mock('../jobs/sync-google-calendar.js', () => ({ syncGoogleCalendarForProperty: (...a: unknown[]) => syncGoogleMock(...a) }));
const syncHostexPropertyMock = vi.fn();
const syncHostexCalendarMock = vi.fn();
vi.mock('../jobs/hostex/sync-properties.js', () => ({ syncHostexProperty: (...a: unknown[]) => syncHostexPropertyMock(...a) }));
vi.mock('../jobs/hostex/sync-calendar.js', () => ({ syncHostexCalendar: (...a: unknown[]) => syncHostexCalendarMock(...a) }));

import {
  runPropertyCalendarRefresh, triggerPropertyCalendarRefresh, resetPropertyCalendarRefreshGuard,
} from './property-calendar-refresh.js';
import type { PropertyConfig } from '../config/properties.js';

const withCal = { slug: 'farmhouse', googleCalendar: { enabled: true, calendarId: 'c' } } as unknown as PropertyConfig;
const noCal = { slug: 'x' } as unknown as PropertyConfig;

describe('property-calendar-refresh (#1167)', () => {
  beforeEach(() => {
    resetPropertyCalendarRefreshGuard();
    syncAvailabilityMock.mockReset().mockResolvedValue({ success: true, listingId: 'L' });
    syncGoogleMock.mockReset().mockResolvedValue({ success: true });
  });

  it('erst Availability (force), dann Google-Kalender', async () => {
    const order: string[] = [];
    syncAvailabilityMock.mockImplementation(async () => { order.push('avail'); return { success: true }; });
    syncGoogleMock.mockImplementation(async () => { order.push('google'); return { success: true }; });
    await runPropertyCalendarRefresh(withCal, 'L');
    expect(syncAvailabilityMock).toHaveBeenCalledWith('L', true);
    expect(order).toEqual(['avail', 'google']);
  });

  it('ohne Google-Kalender nur Availability', async () => {
    await runPropertyCalendarRefresh(noCal, 'L');
    expect(syncAvailabilityMock).toHaveBeenCalledTimes(1);
    expect(syncGoogleMock).not.toHaveBeenCalled();
  });

  it('Fehler sind non-fatal', async () => {
    syncAvailabilityMock.mockRejectedValueOnce(new Error('weg'));
    await expect(runPropertyCalendarRefresh(withCal, 'L')).resolves.toBeUndefined();
    expect(syncGoogleMock).toHaveBeenCalledTimes(1);
  });

  it('Guard: paralleler Aufruf startet keinen zweiten Lauf, aber genau einen Nachlauf', async () => {
    let release!: () => void;
    syncAvailabilityMock.mockImplementationOnce(() => new Promise((r) => { release = () => r({ success: true }); }));
    const first = runPropertyCalendarRefresh(withCal, 'L');
    await runPropertyCalendarRefresh(withCal, 'L');
    await runPropertyCalendarRefresh(withCal, 'L');
    release();
    await first;
    expect(syncAvailabilityMock).toHaveBeenCalledTimes(2);
  });

  it('trigger startet asynchron und meldet den Status', async () => {
    expect(triggerPropertyCalendarRefresh(withCal, 'L')).toBe('angestoßen');
    expect(syncAvailabilityMock).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(syncAvailabilityMock).toHaveBeenCalledTimes(1);
    expect(triggerPropertyCalendarRefresh(noCal, 'L')).toBe('angestoßen (ohne Google-Kalender)');
  });

  it('Hostex-Objekt (#1299): Property + Kalender von Hostex statt Guesty-Availability, danach Google', async () => {
    const hostex = { slug: 'bootshaus-alte-oder', provider: 'hostex', googleCalendar: { enabled: true, calendarId: 'c' } } as unknown as PropertyConfig;
    const order: string[] = [];
    syncHostexPropertyMock.mockReset().mockImplementation(async () => { order.push('prop'); return { success: true, hostexProperty: { id: 1 } }; });
    syncHostexCalendarMock.mockReset().mockImplementation(async () => { order.push('cal'); return { success: true, daysCount: 3 }; });
    syncGoogleMock.mockImplementation(async () => { order.push('google'); return { success: true }; });
    await runPropertyCalendarRefresh(hostex, '12659677');
    expect(syncAvailabilityMock).not.toHaveBeenCalled();
    expect(syncHostexCalendarMock).toHaveBeenCalledWith(hostex, { id: 1 });
    expect(order).toEqual(['prop', 'cal', 'google']);
  });

  it('Hostex-Objekt: Property-Sync scheitert → kein Kalender-Sync, non-fatal', async () => {
    const hostex = { slug: 'alte-schilderwerkstatt', provider: 'hostex' } as unknown as PropertyConfig;
    syncHostexPropertyMock.mockReset().mockResolvedValue({ success: false, error: 'weg' });
    syncHostexCalendarMock.mockReset();
    await expect(runPropertyCalendarRefresh(hostex, '12659676')).resolves.toBeUndefined();
    expect(syncHostexCalendarMock).not.toHaveBeenCalled();
  });
});
