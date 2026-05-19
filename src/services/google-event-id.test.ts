import { describe, it, expect } from 'vitest';
import { toGoogleEventId } from './google-event-id.js';

describe('toGoogleEventId', () => {
  it('passes through Guesty Mongo-ObjectId reservations unchanged (pure hex)', () => {
    // Guesty IDs are MongoDB ObjectIds (lowercase hex), so stripping non-alphanum
    // and lowercasing yields a pure base32hex-compliant string.
    const guestyId = '686d1e927ae7af00234115ad-id3abcdef';
    expect(toGoogleEventId(guestyId)).toBe('686d1e927ae7af00234115adid3abcdef');
  });

  it('hashes Airbnb codes containing letters outside a-v (x, y, z)', () => {
    // HM...x containing 'x' is not valid base32hex → must be hashed.
    const airbnbId = 'HMRK8QX8KX';
    const out = toGoogleEventId(airbnbId);
    expect(out).toMatch(/^[a-v0-9]+$/);
    expect(out).toHaveLength(40); // SHA-1 hex
    // Stable: same input → same output across calls
    expect(toGoogleEventId(airbnbId)).toBe(out);
  });

  it('hashes Hostex IDs containing "w"', () => {
    const hostexId = '0-HM5HDKWMP4-id3zpmcuqu';  // contains W
    const out = toGoogleEventId(hostexId);
    expect(out).toMatch(/^[a-v0-9]{40}$/);
  });

  it('passes through Airbnb codes that happen to be pure base32hex', () => {
    // HMQBCCMBHA → hmqbccmbha (all in a-v + 0-9) — no hash needed
    expect(toGoogleEventId('HMQBCCMBHA')).toBe('hmqbccmbha');
  });

  it('hashes reservations shorter than 5 chars after stripping', () => {
    const out = toGoogleEventId('hi');
    expect(out).toHaveLength(40);
  });

  it('produces distinct event IDs for distinct inputs', () => {
    const a = toGoogleEventId('HMRK8QX8KX');
    const b = toGoogleEventId('HMM5ZH5BFH');
    expect(a).not.toBe(b);
  });
});
