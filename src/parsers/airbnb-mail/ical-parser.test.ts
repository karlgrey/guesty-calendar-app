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
});
