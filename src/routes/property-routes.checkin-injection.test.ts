import { describe, it, expect } from 'vitest';
import express from 'express';
import propertyRoutes from './property-routes.js';

// #656: die Check-in-/Checkout-Zeiten aus properties.json (checkInTime/checkOutTime)
// müssen als window.__CHECKIN_TIME__/__CHECKOUT_TIME__ in die von GET /p/:slug
// ausgelieferte HTML-Seite injiziert werden (analog zu __BOOKING_EMAIL__ etc.),
// damit calendar.js sie in der Anfrage-Mail des Buchungs-Widgets nutzen kann.
// farmhouse hat beide Felder gesetzt, u19 keins — deckt beide Fälle mit echten
// Konfigurationsdaten ab (kein Fixture nötig).

async function get(app: express.Express, path: string) {
  const srv = app.listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, html: await res.text() };
  } finally {
    srv.close();
  }
}

function mkApp() {
  const app = express();
  app.use('/p', propertyRoutes);
  return app;
}

describe('GET /p/:slug — Check-in-/Checkout-Zeit-Injektion (#656)', () => {
  it('injiziert window.__CHECKIN_TIME__/__CHECKOUT_TIME__, wenn in properties.json gesetzt (farmhouse)', async () => {
    const { status, html } = await get(mkApp(), '/p/farmhouse');
    expect(status).toBe(200);
    expect(html).toContain('window.__CHECKIN_TIME__ = "08:00"');
    expect(html).toContain('window.__CHECKOUT_TIME__ = "12:00"');
  });

  it('injiziert leere Strings, wenn checkInTime/checkOutTime fehlen (u19)', async () => {
    const { status, html } = await get(mkApp(), '/p/u19');
    expect(status).toBe(200);
    expect(html).toContain('window.__CHECKIN_TIME__ = ""');
    expect(html).toContain('window.__CHECKOUT_TIME__ = ""');
  });
});
