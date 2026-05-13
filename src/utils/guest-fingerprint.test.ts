import { describe, it, expect } from 'vitest';
import { fingerprintGuest } from './guest-fingerprint.js';

describe('fingerprintGuest', () => {
  describe('null / leere Inputs', () => {
    it('liefert {null, null} bei null', () => {
      expect(fingerprintGuest(null)).toEqual({ id: null, company: null });
    });

    it('liefert {null, null} bei undefined', () => {
      expect(fingerprintGuest(undefined)).toEqual({ id: null, company: null });
    });

    it('liefert {null, null} bei leerem String', () => {
      expect(fingerprintGuest('')).toEqual({ id: null, company: null });
    });

    it('liefert {null, null} bei nur Whitespace', () => {
      expect(fingerprintGuest('   ')).toEqual({ id: null, company: null });
    });
  });
});
