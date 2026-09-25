import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';

/**
 * #729 (Fall momox): /dashboard-data muss guestCompany je Buchung liefern,
 * damit das Admin-Frontend die Firma anzeigen kann. Repositories gemockt
 * (Muster agent-api.test.ts), echte properties.json (Slug 'farmhouse').
 */

vi.mock('../jobs/sync-listing.js', () => ({ syncListing: vi.fn() }));
vi.mock('../jobs/sync-availability.js', () => ({ syncAvailability: vi.fn() }));
vi.mock('../jobs/etl-job.js', () => ({ runETLJob: vi.fn(), runETLJobForProperty: vi.fn() }));
vi.mock('../jobs/scheduler.js', () => ({ getSchedulerStatus: vi.fn() }));
vi.mock('../jobs/sync-analytics.js', () => ({ syncAnalytics: vi.fn() }));
vi.mock('../services/ga4-client.js', () => ({ ga4Client: {} }));
vi.mock('../services/reservation-service.js', () => ({ createOfferReservation: vi.fn() }));
vi.mock('../repositories/message-repository.js', () => ({ setManualCategory: vi.fn() }));
vi.mock('../repositories/analytics-repository.js', () => ({
  getAnalyticsSummary: vi.fn(), getLatestTopPages: vi.fn(), getLastSyncTime: vi.fn(),
  hasAnalyticsData: vi.fn(), getDailyAnalytics: vi.fn(),
}));
vi.mock('../services/document-service.js', () => ({ createOrGetDocument: vi.fn(), refreshDocument: vi.fn() }));

vi.mock('../repositories/availability-repository.js', () => ({
  getDashboardStats: vi.fn().mockReturnValue({
    totalBookings: 1, totalRevenue: 332.98, occupancyRate: 10, bookedDays: 1, availableDays: 9, blockedDays: 0,
  }),
  getAllTimeConversionRate: vi.fn().mockReturnValue({
    inquiriesCount: 1, confirmedCount: 1, declinedCount: 0, canceledCount: 0, totalCount: 1, conversionRate: 100,
  }),
}));
vi.mock('../repositories/listings-repository.js', () => ({
  getListingById: vi.fn().mockReturnValue({ nickname: 'Farmhouse Prasser', title: 'Farmhouse Prasser', currency: 'EUR' }),
}));
vi.mock('../repositories/document-repository.js', () => ({
  getDocumentsByReservation: vi.fn(),
  getDocumentByReservation: vi.fn().mockReturnValue(null),
  listDocuments: vi.fn(),
  getDocumentSequenceInfo: vi.fn(),
  setDocumentSequenceNumber: vi.fn(),
}));
vi.mock('../repositories/reservation-repository.js', () => ({
  getReservationsByPeriod: vi.fn().mockReturnValue([
    {
      reservation_id: 'res-momox', check_in: '2026-08-18', check_out: '2026-08-19', nights_count: 1,
      guest_name: 'Lenia Karallus', guests_count: 1, status: 'confirmed', confirmation_code: 'ABC123',
      source: 'airbnb2', platform: 'airbnb', host_payout: 332.98, total_price: 332.98,
      planned_arrival: null, planned_departure: null, guest_company: 'momox SE',
    },
    {
      reservation_id: 'res-privat', check_in: '2026-09-01', check_out: '2026-09-03', nights_count: 2,
      guest_name: 'Anna Lindvall', guests_count: 2, status: 'confirmed', confirmation_code: 'XYZ789',
      source: 'manual', platform: 'direct', host_payout: 500, total_price: 500,
      planned_arrival: null, planned_departure: null, guest_company: null,
    },
  ]),
  getCurrentReservations: vi.fn().mockReturnValue([]),
}));

import adminRoutes from './admin.js';

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

describe('GET /admin/dashboard-data — guestCompany (#729)', () => {
  it('liefert guestCompany je Buchung (momox SE bzw. null ohne Firma)', async () => {
    const r = await fetch(`${base}/admin/dashboard-data?property=farmhouse&period=past`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.bookings).toHaveLength(2);
    const momox = body.bookings.find((b: any) => b.reservationId === 'res-momox');
    const privat = body.bookings.find((b: any) => b.reservationId === 'res-privat');
    expect(momox.guestCompany).toBe('momox SE');
    expect(privat.guestCompany).toBeNull();
  });
});
