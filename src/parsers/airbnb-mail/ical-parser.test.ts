import { describe, it, expect } from 'vitest';
import { parseAirbnbIcal } from './ical-parser.js';

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Airbnb Inc//Hosting Calendar 0.8.8//EN
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260601
DTEND;VALUE=DATE:20260605
SUMMARY:Reserved
UID:HMABCXYZ@airbnb.com
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260710
DTEND;VALUE=DATE:20260714
SUMMARY:Airbnb (Not available)
UID:HMOTHER@airbnb.com
END:VEVENT
END:VCALENDAR
`;

describe('parseAirbnbIcal', () => {
  it('returns one event per VEVENT', () => {
    const events = parseAirbnbIcal(SAMPLE_ICS);
    expect(events.length).toBe(2);
  });

  it('extracts UID + reservationCode (UID prefix before @)', () => {
    const events = parseAirbnbIcal(SAMPLE_ICS);
    expect(events[0].uid).toBe('HMABCXYZ@airbnb.com');
    expect(events[0].reservationCode).toBe('HMABCXYZ');
  });

  it('formats dates as YYYY-MM-DD', () => {
    const events = parseAirbnbIcal(SAMPLE_ICS);
    expect(events[0].startDate).toBe('2026-06-01');
    expect(events[0].endDate).toBe('2026-06-05');
  });

  it('passes through summary', () => {
    const events = parseAirbnbIcal(SAMPLE_ICS);
    expect(events[0].summary).toBe('Reserved');
    expect(events[1].summary).toBe('Airbnb (Not available)');
  });

  it('returns empty array for ICS without VEVENTs', () => {
    const empty = `BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n`;
    expect(parseAirbnbIcal(empty)).toEqual([]);
  });

  it('falls back to the UID prefix when there is no DESCRIPTION (e.g. malformed/old feed)', () => {
    const events = parseAirbnbIcal(SAMPLE_ICS);
    expect(events[0].reservationCode).toBe('HMABCXYZ');
  });
});

// Real Airbnb private-iCal feeds (calibrated against a live export, Aug 2026)
// use an OPAQUE UID (e.g. "1418fb94e984-321bd...@airbnb.com") that does NOT
// contain the HM reservation code at all — the code only appears inside the
// DESCRIPTION field's "Reservation URL: .../reservations/details/HMxxxxx"
// line. availability.block_ref (written from reservationCode) must carry the
// HM-code so it can be matched against reservations.reservation_id
// (reconcile-ical.ts) — matching on the raw UID prefix silently never matches
// any real mail-based reservation and creates duplicate placeholder rows.
const REAL_FORMAT_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Airbnb Inc//Hosting Calendar 0.8.8//EN
CALSCALE:GREGORIAN
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261227
DTEND;VALUE=DATE:20270103
SUMMARY:Reserved
UID:1418fb94e984-b0b674ed8d98a9a821c0af037a6b643e@airbnb.com
DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/de
 tails/HMZ82HRR38\\nPhone Number (Last 4 Digits): 8280
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20260815
DTEND;VALUE=DATE:20260902
SUMMARY:Airbnb (Not available)
UID:7f662ec65913-62790305f81db1b570f91a7b16267db7@airbnb.com
END:VEVENT
END:VCALENDAR
`;

describe('parseAirbnbIcal — real Airbnb feed format (opaque UID + DESCRIPTION)', () => {
  it('extracts the HM reservation code from the DESCRIPTION Reservation URL, not the opaque UID', () => {
    const events = parseAirbnbIcal(REAL_FORMAT_ICS);
    expect(events[0].uid).toBe('1418fb94e984-b0b674ed8d98a9a821c0af037a6b643e@airbnb.com');
    expect(events[0].reservationCode).toBe('HMZ82HRR38');
  });

  it('falls back to the UID prefix for owner/block events without a Reservation URL', () => {
    const events = parseAirbnbIcal(REAL_FORMAT_ICS);
    expect(events[1].summary).toBe('Airbnb (Not available)');
    expect(events[1].reservationCode).toBe('7f662ec65913-62790305f81db1b570f91a7b16267db7');
  });
});
