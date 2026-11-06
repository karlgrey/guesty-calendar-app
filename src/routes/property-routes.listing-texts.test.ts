import { describe, it, expect, vi } from 'vitest';
import express from 'express';

// #1043: /p/:slug/listing gibt zusätzlich die öffentlichen Inserat-Texte aus.
vi.mock('../repositories/listings-repository.js', () => ({
  getListingById: vi.fn().mockReturnValue({
    id: 'l1', title: 'T', nickname: null, accommodates: 4, bedrooms: 1, bathrooms: 1, property_type: 'House',
    timezone: 'Europe/Berlin', currency: 'EUR', base_price: 100, weekend_base_price: null, cleaning_fee: 0,
    extra_person_fee: 0, guests_included: 1, weekly_price_factor: 1, monthly_price_factor: 1, taxes: [],
    min_nights: 1, max_nights: 30, check_in_time: '15:00', check_out_time: '11:00',
  }),
}));
const textsMock = vi.fn();
vi.mock('../services/listing-texts-service.js', () => ({
  getListingTextsForProperty: (...a: unknown[]) => textsMock(...a),
}));

import propertyRoutes from './property-routes.js';

async function getJson(path: string) {
  const app = express();
  app.use('/p', propertyRoutes);
  const srv = app.listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally { srv.close(); }
}

describe('GET /p/:slug/listing — publicDescription (#1043)', () => {
  it('gibt die öffentlichen Texte aus, Gästeanleitungen NICHT', async () => {
    textsMock.mockResolvedValueOnce({
      available: true, source: 'guesty',
      texts: {
        publicDescription: { summary: 'S', space: null, access: null, neighborhood: null, transit: null, notes: null, interactionWithGuests: null, houseRules: null },
        guestInstructions: { checkInNotes: 'GEHEIM', checkOutInstructions: null },
      },
    });
    const { status, body } = await getJson('/p/farmhouse/listing');
    expect(status).toBe(200);
    expect(body.publicDescription.summary).toBe('S');
    expect(JSON.stringify(body)).not.toContain('GEHEIM');
    expect(body.title).toBe('T');
  });

  it('ohne Texte (Hostex/Fehler): null + Hinweis, Rest der Antwort bleibt', async () => {
    textsMock.mockResolvedValueOnce({ available: false, source: 'hostex', texts: null, note: 'keine Beschreibungsfelder' });
    const { status, body } = await getJson('/p/farmhouse/listing');
    expect(status).toBe(200);
    expect(body.publicDescription).toBeNull();
    expect(body.publicDescriptionNote).toBe('keine Beschreibungsfelder');
    expect(body.pricing.basePrice).toBe(100);
  });
});
