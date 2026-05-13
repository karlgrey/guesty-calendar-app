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
    it('case-Insensitiv: id bleibt gleich bei unterschiedlichen Casings', () => {
      const a = fingerprintGuest('REWE MARKT GMBH');
      const b = fingerprintGuest('Rewe Markt GmbH');
      expect(a.id).toBe(b.id);
      // Note: company preserves the original input casing by design.
    });

    it('deterministisch: zweimaliger Aufruf liefert gleiches Ergebnis', () => {
      const a = fingerprintGuest('Aenu Advisor GmbH Catrin Schmidt');
      const b = fingerprintGuest('Aenu Advisor GmbH Catrin Schmidt');
      expect(a).toEqual(b);
    });
  });

  describe('Regression: alle 33 Farmhouse-Bestandsnamen (Stand 2026-05-13)', () => {
    const fixtures: Array<{ input: string; id: string | null; company: string | null }> = [
      { input: 'Sabine Fastic GmbH', id: 'sabine', company: 'Sabine Fastic GmbH' },
      { input: 'Carola AS IT', id: 'carola_as_it', company: null },
      { input: 'Flora', id: 'flora', company: null },
      { input: 'Open Cash', id: 'open_cash', company: null },
      { input: 'Rewe Markt GmbH', id: 'rewe', company: 'Rewe Markt GmbH' },
      { input: 'Paul Petereit', id: 'paul_petereit', company: null },
      { input: 'Cynthia', id: 'cynthia', company: null },
      { input: 'Ulf Hansen', id: 'ulf_hansen', company: null },
      { input: 'Sebastian Memmel', id: 'sebastian_memmel', company: null },
      { input: 'Benjamin Minack', id: 'benjamin_minack', company: null },
      { input: 'Flink SE', id: 'flink', company: 'Flink SE' },
      { input: 'Evoléna De Wilde', id: 'evolena_de_wilde', company: null },
      {
        input:
          'digitransform.de Gesellschaft für digitale Transformation mbH Thomas Grieß',
        id: 'digitransform',
        company:
          'digitransform.de Gesellschaft für digitale Transformation mbH',
      },
      { input: 'Fluxraum GmbH Daphne Glasberg', id: 'fluxraum', company: 'Fluxraum GmbH' },
      { input: 'Awake Project GmbH BIRGIT AMELUNG', id: 'awake', company: 'Awake Project GmbH' },
      { input: 'Tilo Jung', id: 'tilo_jung', company: null },
      { input: 'Kaputt Agency GmbH Vian Nguyen', id: 'kaputt', company: 'Kaputt Agency GmbH' },
      { input: 'Clara Iglhaut', id: 'clara_iglhaut', company: null },
      { input: 'Michael Krüger', id: 'michael_krueger', company: null },
      { input: 'Green Grizzly GmbH Casimir Carmer', id: 'green', company: 'Green Grizzly GmbH' },
      {
        input: 'Savills Immobilien Beratungs-GmbH Zoofenster - Minh-Ha Nguyen',
        id: 'savills',
        company: 'Savills Immobilien Beratungs-GmbH',
      },
      { input: 'Pentaleap GmbH Veronika Drefke', id: 'pentaleap', company: 'Pentaleap GmbH' },
      { input: 'SuperX GmbH Helen Khandro Raimann', id: 'superx', company: 'SuperX GmbH' },
      { input: 'Steffen Harter', id: 'steffen_harter', company: null },
      { input: 'Annabell Victoria Wünsche', id: 'annabell_victoria_wuensche', company: null },
      { input: 'Isabelle Reich', id: 'isabelle_reich', company: null },
      {
        input: 'Penguin Random House Verlagsgruppe GmbH Katja Weingartner',
        id: 'penguin',
        company: 'Penguin Random House Verlagsgruppe GmbH',
      },
      {
        input: 'Lüftungstechnik Gehrmann Bauelemente GmbH Hardi Gehrmann',
        id: 'lueftungstechnik',
        company: 'Lüftungstechnik Gehrmann Bauelemente GmbH',
      },
      { input: 'Derya Harke', id: 'derya_harke', company: null },
      { input: 'Ilona Koch', id: 'ilona_koch', company: null },
      { input: 'Aenu Advisor GmbH  Catrin Schmidt', id: 'aenu', company: 'Aenu Advisor GmbH' },
      { input: 'Malin Dettmann-Levin', id: 'malin_dettmannlevin', company: null },
      { input: 'Stephanie Heinrich', id: 'stephanie_heinrich', company: null },
    ];

    it('alle 33 Bestandsnamen', () => {
      expect(fixtures.length).toBe(33);
    });

    for (const fx of fixtures) {
      it(`fixture: ${fx.input}`, () => {
        expect(fingerprintGuest(fx.input)).toEqual({ id: fx.id, company: fx.company });
      });
    }
  });
});
