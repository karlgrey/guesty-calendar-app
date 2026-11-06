import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getListingMock = vi.fn();
vi.mock('./guesty-client.js', () => ({ guestyClient: { getListing: (...a: unknown[]) => getListingMock(...a) } }));

import {
  getListingTextsForProperty, clearListingTextsCache,
  LISTING_TEXTS_TTL_MS, LISTING_TEXTS_ERROR_HOLD_MS, LISTING_TEXTS_WAIT_MS,
  NOTE_GUESTY_FAILED, NOTE_GUESTY_PENDING,
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

beforeEach(() => { getListingMock.mockReset(); clearListingTextsCache(); });
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

  it('Hostex: null + Hinweis, kein Guesty-Aufruf', async () => {
    const r = await getListingTextsForProperty(hostexProp);
    expect(r).toMatchObject({ available: false, source: 'hostex', texts: null });
    expect(r.note).toMatch(/Hostex/);
    expect(getListingMock).not.toHaveBeenCalled();
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
