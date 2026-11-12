import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getListingMock = vi.fn();
vi.mock('./guesty-client.js', () => ({ guestyClient: { getListing: (...a: unknown[]) => getListingMock(...a) } }));
const hostexGetPropertiesMock = vi.fn();
const hostexGetListingsMock = vi.fn();
const getHostexClientMock = vi.fn(() => ({
  getProperties: (...a: unknown[]) => hostexGetPropertiesMock(...a),
  getListings: (...a: unknown[]) => hostexGetListingsMock(...a),
}));
vi.mock('./hostex-client.js', () => ({ getHostexClient: () => getHostexClientMock() }));

import {
  getListingTextsForProperty, clearListingTextsCache,
  LISTING_TEXTS_TTL_MS, LISTING_TEXTS_ERROR_HOLD_MS, LISTING_TEXTS_WAIT_MS,
  NOTE_GUESTY_FAILED, NOTE_GUESTY_PENDING,
  NOTE_HOSTEX_FAILED, NOTE_HOSTEX_PENDING, NOTE_HOSTEX_EMPTY,
} from './listing-texts-service';
import type { PropertyConfig } from '../config/properties';

const guestyProp = { slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'g-1' } as PropertyConfig;
const hostexProp = { slug: 'bootshaus', provider: 'hostex', hostexPropertyId: '12659677' } as PropertyConfig;
const mailProp = { slug: 'florenz', provider: 'airbnb-mail' } as PropertyConfig;

function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  getListingMock.mockReset(); hostexGetPropertiesMock.mockReset(); hostexGetListingsMock.mockReset();
  getHostexClientMock.mockClear();
  clearListingTextsCache();
});
afterEach(() => { vi.useRealTimers(); });

describe('getListingTextsForProperty (#1043)', () => {
  it('Guesty: lädt Texte live und cached sie', async () => {
    getListingMock.mockResolvedValue({ publicDescription: { summary: 'Hallo' }, checkInInstructions: { notes: 'N' } });
    const a = await getListingTextsForProperty(guestyProp);
    const b = await getListingTextsForProperty(guestyProp);
    expect(a.available).toBe(true);
    expect(a.source).toBe('guesty');
    expect(a.texts?.publicDescription.summary).toBe('Hallo');
    expect(a.texts?.guestInstructions.checkInNotes).toBe('N');
    expect(b).toEqual(a);
    expect(getListingMock).toHaveBeenCalledTimes(1);
  });


  it('airbnb-mail: null + Hinweis', async () => {
    const r = await getListingTextsForProperty(mailProp);
    expect(r).toMatchObject({ available: false, source: 'airbnb-mail', texts: null });
    expect(r.note).toBeTruthy();
  });

  it('Guesty-Fehler: available=false mit Hinweis, wirft nicht; nach der Fehler-Halte neuer Versuch', async () => {
    vi.useFakeTimers();
    getListingMock.mockRejectedValueOnce(new Error('boom'));
    const r = await getListingTextsForProperty(guestyProp);
    expect(r).toMatchObject({ available: false, texts: null, note: NOTE_GUESTY_FAILED });

    // Innerhalb der Halte: kein zweiter Guesty-Request (Ausfall-Schutz für die öffentliche Route)
    getListingMock.mockResolvedValue({ publicDescription: { summary: 'ok' } });
    const held = await getListingTextsForProperty(guestyProp);
    expect(held.available).toBe(false);
    expect(getListingMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LISTING_TEXTS_ERROR_HOLD_MS + 1);
    const r2 = await getListingTextsForProperty(guestyProp);
    expect(r2.available).toBe(true);
    expect(getListingMock).toHaveBeenCalledTimes(2);
  });

  it('In-flight-Dedupe: parallele Aufrufe teilen sich einen Guesty-Request', async () => {
    const d = deferred<unknown>();
    getListingMock.mockReturnValue(d.promise);
    const calls = Promise.all([1, 2, 3, 4, 5].map(() => getListingTextsForProperty(guestyProp)));
    d.resolve({ publicDescription: { summary: 'einmal' } });
    const results = await calls;
    expect(results.every((r) => r.available && r.texts?.publicDescription.summary === 'einmal')).toBe(true);
    expect(getListingMock).toHaveBeenCalledTimes(1);
  });

  it('Wartegrenze: antwortet nach LISTING_TEXTS_WAIT_MS mit null + Hinweis, Abruf füllt den Cache nach', async () => {
    vi.useFakeTimers();
    const d = deferred<unknown>();
    getListingMock.mockReturnValue(d.promise);
    const pending = getListingTextsForProperty(guestyProp);
    await vi.advanceTimersByTimeAsync(LISTING_TEXTS_WAIT_MS + 1);
    const r = await pending;
    expect(r).toMatchObject({ available: false, texts: null, note: NOTE_GUESTY_PENDING });

    d.resolve({ publicDescription: { summary: 'spät' } });
    await vi.advanceTimersByTimeAsync(0);
    const r2 = await getListingTextsForProperty(guestyProp);
    expect(r2.available).toBe(true);
    expect(r2.texts?.publicDescription.summary).toBe('spät');
    expect(getListingMock).toHaveBeenCalledTimes(1);
  });

  it('Wartegrenze + späterer Fehler: keine unbehandelte Rejection, Fehler-Halte greift', async () => {
    vi.useFakeTimers();
    const d = deferred<unknown>();
    getListingMock.mockReturnValue(d.promise);
    const pending = getListingTextsForProperty(guestyProp);
    await vi.advanceTimersByTimeAsync(LISTING_TEXTS_WAIT_MS + 1);
    expect((await pending).note).toBe(NOTE_GUESTY_PENDING);
    d.reject(new Error('spät kaputt'));
    await vi.advanceTimersByTimeAsync(0);
    const r = await getListingTextsForProperty(guestyProp);
    expect(r).toMatchObject({ available: false, note: NOTE_GUESTY_FAILED });
    expect(getListingMock).toHaveBeenCalledTimes(1);
  });

  it('Stale-Fallback: abgelaufener Cache wird bei Guesty-Fehler weiter ausgeliefert', async () => {
    vi.useFakeTimers();
    getListingMock.mockResolvedValueOnce({ publicDescription: { summary: 'alt' } });
    await getListingTextsForProperty(guestyProp);
    vi.advanceTimersByTime(LISTING_TEXTS_TTL_MS + 1);
    getListingMock.mockRejectedValueOnce(new Error('boom'));
    const r = await getListingTextsForProperty(guestyProp);
    expect(r.available).toBe(true);
    expect(r.texts?.publicDescription.summary).toBe('alt');
    expect(getListingMock).toHaveBeenCalledTimes(2);
  });
});

// ── Hostex-Zweig (#983) ──────────────────────────────────────────────────────
const HOSTEX_PROPS = [
  { id: 12659677, title: 'Bootshaus', channels: [{ channel_type: 'airbnb', listing_id: 'air-B', currency: 'EUR' }] },
  { id: 12659676, title: 'Werkstatt', channels: [{ channel_type: 'airbnb', listing_id: 'air-W', currency: 'EUR' }] },
];
const HOSTEX_LISTINGS = [
  { id: 1, listing_id: 'air-W', channel_type: 'airbnb', title: 'Werkstatt-Inserat',
    metadata: { descriptions: [{ locale: 'de', description: 'Werkstatt-Text' }] } },
  { id: 2, listing_id: 'air-B', channel_type: 'airbnb', title: 'Bootshaus-Inserat',
    metadata: { feature: '', descriptions: [{ locale: 'en', description: 'Boathouse text', about_your_house: 'Space', about_amenity: 'Amen' }] } },
];

describe('getListingTextsForProperty — Hostex (#983)', () => {
  it('lädt Texte über properties → Airbnb-listing_id → listings, ohne Guesty', async () => {
    hostexGetPropertiesMock.mockResolvedValue(HOSTEX_PROPS);
    hostexGetListingsMock.mockResolvedValue(HOSTEX_LISTINGS);
    const r = await getListingTextsForProperty(hostexProp);
    expect(r).toMatchObject({ available: true, source: 'hostex' });
    expect(r.note).toBeUndefined();
    expect(r.texts?.publicDescription.summary).toBe('Boathouse text');
    expect(r.texts?.publicDescription.space).toBe('Space');
    expect(r.texts?.guestInstructions).toEqual({ checkInNotes: null, checkOutInstructions: null });
    expect(r.texts?.hostexTexts?.title).toBe('Bootshaus-Inserat');
    expect(r.texts?.hostexTexts?.['metadata.descriptions[0].about_amenity']).toBe('Amen');
    expect(getListingMock).not.toHaveBeenCalled();
  });

  it('cached je Hostex-Property (1 h) und getrennt vom Guesty-Cache', async () => {
    vi.useFakeTimers();
    hostexGetPropertiesMock.mockResolvedValue(HOSTEX_PROPS);
    hostexGetListingsMock.mockResolvedValue(HOSTEX_LISTINGS);
    const werkstatt = { slug: 'alte-schilderwerkstatt', provider: 'hostex', hostexPropertyId: '12659676' } as PropertyConfig;
    const a = await getListingTextsForProperty(hostexProp);
    const b = await getListingTextsForProperty(hostexProp);
    const w = await getListingTextsForProperty(werkstatt);
    expect(b).toEqual(a);
    expect(w.texts?.publicDescription.summary).toBe('Werkstatt-Text');
    expect(hostexGetListingsMock).toHaveBeenCalledTimes(2); // Bootshaus 1x (Cache), Werkstatt 1x
    vi.advanceTimersByTime(LISTING_TEXTS_TTL_MS + 1);
    await getListingTextsForProperty(hostexProp);
    expect(hostexGetListingsMock).toHaveBeenCalledTimes(3);
  });

  it('In-flight-Dedupe: parallele Aufrufe teilen sich einen Hostex-Abruf', async () => {
    const d = deferred<unknown>();
    hostexGetPropertiesMock.mockReturnValue(d.promise);
    hostexGetListingsMock.mockResolvedValue(HOSTEX_LISTINGS);
    const calls = Promise.all([1, 2, 3].map(() => getListingTextsForProperty(hostexProp)));
    d.resolve(HOSTEX_PROPS);
    const results = await calls;
    expect(results.every((r) => r.available)).toBe(true);
    expect(hostexGetPropertiesMock).toHaveBeenCalledTimes(1);
    expect(hostexGetListingsMock).toHaveBeenCalledTimes(1);
  });

  it('Fehler: available=false mit Hostex-Hinweis, Fehler-Halte, danach neuer Versuch', async () => {
    vi.useFakeTimers();
    hostexGetPropertiesMock.mockRejectedValueOnce(new Error('hostex down'));
    const r = await getListingTextsForProperty(hostexProp);
    expect(r).toMatchObject({ available: false, source: 'hostex', texts: null, note: NOTE_HOSTEX_FAILED });

    hostexGetPropertiesMock.mockResolvedValue(HOSTEX_PROPS);
    hostexGetListingsMock.mockResolvedValue(HOSTEX_LISTINGS);
    const held = await getListingTextsForProperty(hostexProp);
    expect(held).toMatchObject({ available: false, note: NOTE_HOSTEX_FAILED });
    expect(hostexGetPropertiesMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LISTING_TEXTS_ERROR_HOLD_MS + 1);
    expect((await getListingTextsForProperty(hostexProp)).available).toBe(true);
  });

  it('fehlender Token (getHostexClient wirft) → Fehler-Hinweis, wirft nicht', async () => {
    getHostexClientMock.mockImplementationOnce(() => { throw new Error('HOSTEX_ACCESS_TOKEN fehlt'); });
    const r = await getListingTextsForProperty(hostexProp);
    expect(r).toMatchObject({ available: false, note: NOTE_HOSTEX_FAILED });
  });

  it('Wartegrenze: Hostex-Pending-Hinweis', async () => {
    vi.useFakeTimers();
    hostexGetPropertiesMock.mockReturnValue(deferred<unknown>().promise);
    const pending = getListingTextsForProperty(hostexProp);
    await vi.advanceTimersByTimeAsync(LISTING_TEXTS_WAIT_MS + 1);
    expect(await pending).toMatchObject({ available: false, note: NOTE_HOSTEX_PENDING });
  });

  it('kein Airbnb-Listing zur Property → available=false, Hinweis nennt geprüften Endpunkt', async () => {
    hostexGetPropertiesMock.mockResolvedValue(HOSTEX_PROPS);
    hostexGetListingsMock.mockResolvedValue([HOSTEX_LISTINGS[0]]);
    const r = await getListingTextsForProperty(hostexProp);
    expect(r).toMatchObject({ available: false, source: 'hostex', texts: null });
    expect(r.note).toContain('GET /v3/listings');
    expect(r.note).toContain('12659677');
  });

  it('Property ohne Airbnb-Kanal → Hinweis nennt GET /v3/properties', async () => {
    hostexGetPropertiesMock.mockResolvedValue([{ id: 12659677, title: 'B', channels: [] }]);
    const r = await getListingTextsForProperty(hostexProp);
    expect(r.available).toBe(false);
    expect(r.note).toContain('GET /v3/properties');
    expect(hostexGetListingsMock).not.toHaveBeenCalled();
  });

  it('Listing ohne gefüllte Textfelder → available=false + NOTE_HOSTEX_EMPTY', async () => {
    hostexGetPropertiesMock.mockResolvedValue(HOSTEX_PROPS);
    hostexGetListingsMock.mockResolvedValue([{ id: 2, listing_id: 'air-B', channel_type: 'airbnb', title: '', metadata: { descriptions: [{ locale: 'de', description: '' }] } }]);
    const r = await getListingTextsForProperty(hostexProp);
    expect(r).toEqual({ available: false, source: 'hostex', texts: null, note: NOTE_HOSTEX_EMPTY });
  });

  it('Hostex-Objekt ohne hostexPropertyId → Hinweis, kein Abruf', async () => {
    const r = await getListingTextsForProperty({ slug: 'x', provider: 'hostex' } as PropertyConfig);
    expect(r.available).toBe(false);
    expect(getHostexClientMock).not.toHaveBeenCalled();
  });
});
