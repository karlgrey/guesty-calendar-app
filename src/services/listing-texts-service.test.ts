import { describe, it, expect, vi, beforeEach } from 'vitest';

const getListingMock = vi.fn();
vi.mock('./guesty-client.js', () => ({ guestyClient: { getListing: (...a: unknown[]) => getListingMock(...a) } }));

import { getListingTextsForProperty, clearListingTextsCache } from './listing-texts-service';
import type { PropertyConfig } from '../config/properties';

const guestyProp = { slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'g-1' } as PropertyConfig;
const hostexProp = { slug: 'bootshaus', provider: 'hostex', hostexPropertyId: '12659677' } as PropertyConfig;
const mailProp = { slug: 'florenz', provider: 'airbnb-mail' } as PropertyConfig;

beforeEach(() => { getListingMock.mockReset(); clearListingTextsCache(); });

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

  it('Guesty-Fehler: available=false mit Hinweis, wirft nicht, cached den Fehler nicht', async () => {
    getListingMock.mockRejectedValueOnce(new Error('boom'));
    const r = await getListingTextsForProperty(guestyProp);
    expect(r).toMatchObject({ available: false, texts: null });
    expect(r.note).toMatch(/Guesty/);
    getListingMock.mockResolvedValueOnce({ publicDescription: { summary: 'ok' } });
    const r2 = await getListingTextsForProperty(guestyProp);
    expect(r2.available).toBe(true);
  });
});
