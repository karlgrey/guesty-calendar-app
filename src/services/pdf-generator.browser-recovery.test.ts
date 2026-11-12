import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Document } from '../repositories/document-repository.js';

const launchMock = vi.fn();
vi.mock('puppeteer', () => ({
  default: { launch: (...args: unknown[]) => launchMock(...args) },
}));

vi.mock('../repositories/reservation-repository.js', () => ({ getReservationById: vi.fn() }));
vi.mock('../config/properties.js', () => ({ getPropertyByGuestyId: vi.fn() }));
vi.mock('../repositories/document-repository.js', () => ({ getDocumentById: vi.fn() }));

const warnMock = vi.fn();
vi.mock('../utils/logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: (...a: unknown[]) => warnMock(...a), error: vi.fn() },
}));

const { pdfGenerator } = await import('./pdf-generator.js');

function doc(): Document {
  return {
    id: 1, documentType: 'invoice', documentNumber: '2026-0099', reservationId: 'r1',
    customer: { name: 'Anna', company: null, street: null, city: null, zip: null, country: null },
    checkIn: '2026-09-01', checkOut: '2026-09-03', nights: 2, guestsCount: 2, guestsIncluded: 5,
    currency: 'EUR', source: 'Direct', accommodationTotal: 20000, accommodationRate: 10000,
    extraGuestTotal: 0, extraGuestRate: 0, extraGuestNights: 0, cleaningFee: 0, discountTotal: 0,
    subtotal: 20000, taxRate: 7, taxAmount: 1400, total: 21400,
    createdAt: '2026-09-08T09:00:00.000Z', updatedAt: '2026-09-08T09:00:00.000Z',
  } as Document;
}

function connErr(msg = 'Connection closed.'): Error {
  const e = new Error(msg);
  e.name = 'ConnectionClosedError';
  return e;
}

interface FakeBrowser {
  connected: boolean;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  newPage: ReturnType<typeof vi.fn>;
  fire: (ev: string) => void;
  page: { setContent: ReturnType<typeof vi.fn>; pdf: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

function fakeBrowser(pdfImpl?: () => Promise<Uint8Array>): FakeBrowser {
  const handlers: Record<string, () => void> = {};
  const page = {
    setContent: vi.fn().mockResolvedValue(undefined),
    pdf: vi.fn(pdfImpl ?? (async () => new Uint8Array([1, 2, 3]))),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const b: FakeBrowser = {
    connected: true,
    on: vi.fn((ev: string, h: () => void) => { handlers[ev] = h; }),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
    fire: (ev) => { b.connected = false; handlers[ev]?.(); },
    page,
  };
  return b;
}

describe('PDFGenerator Browser-Recovery', () => {
  beforeEach(async () => {
    launchMock.mockReset();
    warnMock.mockReset();
    await pdfGenerator.close().catch(() => {});
    (pdfGenerator as unknown as { browser: unknown }).browser = null;
    (pdfGenerator as unknown as { templatesDir: string }).templatesDir = `${process.cwd()}/data/templates`;
    pdfGenerator.clearTemplateCache();
  });

  it('(a) startet einen getrennten Browser beim nächsten Aufruf neu und loggt die Warnung', async () => {
    const b1 = fakeBrowser();
    const b2 = fakeBrowser();
    launchMock.mockResolvedValueOnce(b1).mockResolvedValueOnce(b2);

    await pdfGenerator.generatePDF(doc());
    b1.fire('disconnected');
    expect(warnMock).toHaveBeenCalledWith('Puppeteer browser disconnected');

    await pdfGenerator.generatePDF(doc());
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(b2.newPage).toHaveBeenCalledTimes(1);
  });

  it('(a2) verwirft ein Handle mit connected=false auch ohne Event', async () => {
    const b1 = fakeBrowser();
    const b2 = fakeBrowser();
    launchMock.mockResolvedValueOnce(b1).mockResolvedValueOnce(b2);
    await pdfGenerator.generatePDF(doc());
    b1.connected = false;
    await pdfGenerator.generatePDF(doc());
    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it('(b) Verbindungsfehler im ersten Versuch führt zu genau einem Neuversuch und liefert ein PDF', async () => {
    const b1 = fakeBrowser(async () => { throw connErr(); });
    const b2 = fakeBrowser();
    launchMock.mockResolvedValueOnce(b1).mockResolvedValueOnce(b2);

    const buf = await pdfGenerator.generatePDF(doc());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(launchMock).toHaveBeenCalledTimes(2);
    expect(b1.page.close).toHaveBeenCalled(); // Seite im finally geschlossen
  });

  it('(b2) Verbindungsfehler schon bei newPage (Message-Erkennung) wird wiederholt', async () => {
    const b1 = fakeBrowser();
    b1.newPage.mockRejectedValueOnce(new Error('Protocol error: Target closed'));
    const b2 = fakeBrowser();
    launchMock.mockResolvedValueOnce(b1).mockResolvedValueOnce(b2);
    await pdfGenerator.generatePDF(doc());
    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it('(c) zweiter Verbindungsfehler wird gemeldet, kein dritter Versuch', async () => {
    const b1 = fakeBrowser(async () => { throw connErr(); });
    const b2 = fakeBrowser(async () => { throw connErr(); });
    launchMock.mockResolvedValueOnce(b1).mockResolvedValueOnce(b2).mockResolvedValue(fakeBrowser());

    await expect(pdfGenerator.generatePDF(doc())).rejects.toThrow(/Connection closed/);
    expect(launchMock).toHaveBeenCalledTimes(2);
  });

  it('(d) fachlicher Fehler (Template fehlt) löst keinen Neuversuch aus', async () => {
    (pdfGenerator as unknown as { templatesDir: string }).templatesDir = '/nonexistent-dir';
    await expect(pdfGenerator.generatePDF(doc())).rejects.toThrow(/Template not found/);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('(d2) anderer Renderfehler wird ohne Neuversuch durchgereicht', async () => {
    const b1 = fakeBrowser(async () => { throw new Error('Invalid margin'); });
    launchMock.mockResolvedValueOnce(b1);
    await expect(pdfGenerator.generatePDF(doc())).rejects.toThrow('Invalid margin');
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(b1.page.close).toHaveBeenCalled();
  });
});
