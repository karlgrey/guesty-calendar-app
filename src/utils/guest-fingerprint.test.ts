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

  describe('Person-Mode (kein Firmen-Suffix erkannt)', () => {
    it('einzelner Vorname', () => {
      expect(fingerprintGuest('Cynthia')).toEqual({
        id: 'cynthia',
        company: null,
      });
    });

    it('Vor- und Nachname', () => {
      expect(fingerprintGuest('Sebastian Memmel')).toEqual({
        id: 'sebastian_memmel',
        company: null,
      });
    });

    it('Umlaute werden zu ae/oe/ue/ss', () => {
      expect(fingerprintGuest('Michael Krüger')).toEqual({
        id: 'michael_krueger',
        company: null,
      });
    });

    it('Diakritika (é, á, ñ) werden zu ASCII-Basis', () => {
      expect(fingerprintGuest('Evoléna De Wilde')).toEqual({
        id: 'evolena_de_wilde',
        company: null,
      });
    });

    it('mehrere Vornamen', () => {
      expect(fingerprintGuest('Annabell Victoria Wünsche')).toEqual({
        id: 'annabell_victoria_wuensche',
        company: null,
      });
    });

    it('Bindestrich im Namen wird entfernt', () => {
      expect(fingerprintGuest('Malin Dettmann-Levin')).toEqual({
        id: 'malin_dettmannlevin',
        company: null,
      });
    });

    it('mehrfache Whitespaces werden zusammengezogen', () => {
      expect(fingerprintGuest('  Tilo   Jung  ')).toEqual({
        id: 'tilo_jung',
        company: null,
      });
    });
  });
});
