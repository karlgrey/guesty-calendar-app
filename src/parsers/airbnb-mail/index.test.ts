import { describe, it, expect } from 'vitest';
import { detectMailType } from './index.js';

// Subjects calibrated against live Airbnb host mail (Firenze property, May 2026).
// See archive query in airbnb_mail_archive for the source samples.
describe('detectMailType (calibrated against live data)', () => {
  it('detects confirmed bookings', () => {
    expect(detectMailType('Buchung bestätigt – Amber Hiles kommt am 14. Juni an')).toBe('confirmed');
    expect(detectMailType('Buchung bestätigt – Angela Yan kommt am 17. Mai an')).toBe('confirmed');
    expect(detectMailType('Buchung bestätigt – Wei An Wang kommt am 26. Mai an')).toBe('confirmed');
  });

  it('detects modifications', () => {
    expect(detectMailType('Deine Buchungsänderung wurde bestätigt')).toBe('modification');
  });

  it('detects inquiries', () => {
    expect(detectMailType('Anfrage für „Art-Filled Duplex Loft · Florence Design District" für den 23.–25. Mai 2026')).toBe('inquiry');
  });

  it('detects cancellations', () => {
    expect(detectMailType('Reservierung storniert')).toBe('cancellation');
    expect(detectMailType('Stornierung durch Anna')).toBe('cancellation');
    expect(detectMailType('Buchung abgesagt')).toBe('cancellation');
  });

  it('returns unknown for noise mails (account, threads, 2FA, payouts)', () => {
    expect(detectMailType('Newsletter Mai 2026')).toBe('unknown');
    expect(detectMailType('')).toBe('unknown');
    expect(detectMailType('Dein Bestätigungscode lautet 254746')).toBe('unknown');
    expect(detectMailType('Neue Nachricht vom Airbnb-Support')).toBe('unknown');
    expect(detectMailType('RE: Buchung für „Urban Luxury Loft - Florence Interior Design Hub", 17.–22. Mai')).toBe('unknown');
    expect(detectMailType('Buchungserinnerung: Angela kommt bald an')).toBe('unknown');
    expect(detectMailType('Erinnerung: Du kannst den Aufenthalt von M.C im Voraus bestätigen')).toBe('unknown');
    expect(detectMailType('Wir haben eine Auszahlung in Höhe von 636,52 € EUR gesendet')).toBe('unknown');
    expect(detectMailType('Account-Aktivität: Name geändert')).toBe('unknown');
    expect(detectMailType('Nutzungsbedingungen für europäische Nutzer')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(detectMailType('BUCHUNG BESTÄTIGT – Anna kommt am 1. Juli an')).toBe('confirmed');
  });
});
