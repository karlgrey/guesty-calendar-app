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

  describe('Firma-Mode (Rechtsform erkannt)', () => {
    it('einfaches Firma + Rechtsform', () => {
      expect(fingerprintGuest('Flink SE')).toEqual({
        id: 'flink',
        company: 'Flink SE',
      });
    });

    it('Firma + Beschreibung + Rechtsform (Beschreibung ist Stoppwort)', () => {
      expect(fingerprintGuest('Rewe Markt GmbH')).toEqual({
        id: 'rewe',
        company: 'Rewe Markt GmbH',
      });
    });

    it('Firma + Rechtsform + Personenname dahinter', () => {
      expect(fingerprintGuest('Pentaleap GmbH Veronika Drefke')).toEqual({
        id: 'pentaleap',
        company: 'Pentaleap GmbH',
      });
    });

    it('Domain-Endung am ersten Token wird entfernt', () => {
      expect(
        fingerprintGuest('digitransform.de Gesellschaft für digitale Transformation mbH Thomas Grieß')
      ).toEqual({
        id: 'digitransform',
        company: 'digitransform.de Gesellschaft für digitale Transformation mbH',
      });
    });

    it('mehrere Stoppwörter werden alle gefiltert', () => {
      expect(
        fingerprintGuest('Penguin Random House Verlagsgruppe GmbH Katja Weingartner')
      ).toEqual({
        id: 'penguin',
        company: 'Penguin Random House Verlagsgruppe GmbH',
      });
    });

    it('Bindestrich vor Rechtsform (Beratungs-GmbH)', () => {
      expect(
        fingerprintGuest('Savills Immobilien Beratungs-GmbH Zoofenster - Minh-Ha Nguyen')
      ).toEqual({
        id: 'savills',
        company: 'Savills Immobilien Beratungs-GmbH',
      });
    });

    it('doppelte Whitespaces vor Personen-Teil', () => {
      expect(fingerprintGuest('Aenu Advisor GmbH  Catrin Schmidt')).toEqual({
        id: 'aenu',
        company: 'Aenu Advisor GmbH',
      });
    });

    it('nur Rechtsform allein liefert keinen Marken-Token', () => {
      expect(fingerprintGuest('GmbH')).toEqual({
        id: null,
        company: 'GmbH',
      });
    });
  });

  describe('Stabilität', () => {
    it('case-Insensitiv: gleicher Output bei unterschiedlichen Casings', () => {
      expect(fingerprintGuest('REWE MARKT GMBH')).toEqual(
        fingerprintGuest('Rewe Markt GmbH')
      );
    });

    it('deterministisch: zweimaliger Aufruf liefert gleiches Ergebnis', () => {
      const a = fingerprintGuest('Aenu Advisor GmbH Catrin Schmidt');
      const b = fingerprintGuest('Aenu Advisor GmbH Catrin Schmidt');
      expect(a).toEqual(b);
    });
  });
});
