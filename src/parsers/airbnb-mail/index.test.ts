import { describe, it, expect } from 'vitest';
import { detectMailType } from './index.js';

describe('detectMailType (initial estimated patterns)', () => {
  it('detects confirmed', () => {
    expect(detectMailType('Reservierung bestätigt: Anna Müller')).toBe('confirmed');
    expect(detectMailType('Buchung bestätigt')).toBe('confirmed');
    expect(detectMailType('✓ Reserviert: 15. Juli – 18. Juli')).toBe('confirmed');
  });

  it('detects inquiry', () => {
    expect(detectMailType('Anfrage von Lukas')).toBe('inquiry');
    expect(detectMailType('Buchungsanfrage: 2 Nächte')).toBe('inquiry');
    expect(detectMailType('Lukas möchte buchen')).toBe('inquiry');
  });

  it('detects cancellation', () => {
    expect(detectMailType('Reservierung storniert')).toBe('cancellation');
    expect(detectMailType('Stornierung durch Anna')).toBe('cancellation');
    expect(detectMailType('Buchung abgesagt')).toBe('cancellation');
  });

  it('detects modification', () => {
    expect(detectMailType('Datum geändert')).toBe('modification');
    expect(detectMailType('Reservierung: Änderung der Daten')).toBe('modification');
    expect(detectMailType('Buchung aktualisiert')).toBe('modification');
  });

  it('returns unknown for unrecognised subjects', () => {
    expect(detectMailType('Newsletter Mai 2026')).toBe('unknown');
    expect(detectMailType('')).toBe('unknown');
    expect(detectMailType('Re: Frage zur Property')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(detectMailType('RESERVIERUNG BESTÄTIGT')).toBe('confirmed');
    expect(detectMailType('anfrage von paul')).toBe('inquiry');
  });
});
