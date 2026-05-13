# Guest Fingerprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lokal berechneter Guest-Fingerprint (Slug + Klartext-Firma) in `reservations`, ohne zusätzliche Guesty-API-Calls und ohne Eingriff in bestehende Logik. Macht Repeat-Customer-Analyse für BI möglich.

**Architecture:** Additive Migration für zwei neue Nullable-Spalten. Pure Function `fingerprintGuest()` in `src/utils/`. Mapper schreibt Fingerprint beim ETL-Sync mit. Idempotentes Backfill-Script für die 33 Bestandsbuchungen. Spec liegt unter `docs/superpowers/specs/2026-05-13-guest-fingerprint-design.md`.

**Tech Stack:** TypeScript (strict ESM), better-sqlite3, Vitest (default config, kein vitest.config.ts vorhanden), tsx, Node ≥ 18.

---

## File Structure

**Neu:**
- `src/db/migrations/012_add_guest_fingerprint.sql` — additive Migration (2 Spalten + Index)
- `src/utils/guest-fingerprint.ts` — pure Funktion + Konstanten + Hilfsfunktionen
- `src/utils/guest-fingerprint.test.ts` — Vitest mit allen 33 Fixtures, Edge-Cases, Stabilität
- `src/scripts/backfill-guest-fingerprint.ts` — CLI mit `--dry-run` und `--apply`

**Modifiziert (minimal):**
- `src/types/models.ts` — `Reservation` + `ReservationRow` um zwei Felder erweitern
- `src/mappers/reservation-mapper.ts` — Fingerprint-Aufruf in `extractReservationFromCalendar()`
- `src/repositories/reservation-repository.ts` — `upsertReservation()` + `upsertReservationBatch()`: INSERT-Liste und ON CONFLICT UPDATE-Liste um zwei Spalten erweitern

**Nicht angefasst:** Routes, Frontend, GA4, Listings, Availability, Inquiries, Documents, Scheduler.

---

### Task 1: Migration anlegen und ausführen

**Files:**
- Create: `src/db/migrations/012_add_guest_fingerprint.sql`

- [ ] **Step 1: Migration-Datei erstellen**

Datei `src/db/migrations/012_add_guest_fingerprint.sql`:

```sql
-- Migration: Add guest fingerprint columns
-- Created: 2026-05-13
-- Description: Adds two nullable columns to enable repeat-customer detection
--              without additional Guesty API calls. Computed locally from guest_name.
--              See docs/superpowers/specs/2026-05-13-guest-fingerprint-design.md

ALTER TABLE reservations ADD COLUMN internal_guest_id TEXT;
ALTER TABLE reservations ADD COLUMN guest_company TEXT;

CREATE INDEX IF NOT EXISTS idx_reservations_internal_guest_id
  ON reservations(internal_guest_id);
```

- [ ] **Step 2: Migration ausführen**

Run: `npm run db:migrate`
Expected: Logs zeigen „Migration applied: 012_add_guest_fingerprint.sql" und Exit-Code 0.

- [ ] **Step 3: Schema verifizieren**

Run: `sqlite3 data/calendar.db ".schema reservations" | grep -E "internal_guest_id|guest_company"`
Expected:
```
, internal_guest_id TEXT, guest_company TEXT
```
(oder ähnliche Zeile, je nach SQLite-Formatierung)

- [ ] **Step 4: Index verifizieren**

Run: `sqlite3 data/calendar.db ".indexes reservations" | grep internal_guest`
Expected: `idx_reservations_internal_guest_id`

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/012_add_guest_fingerprint.sql
git commit -m "feat: add migration for guest fingerprint columns

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Test-Setup verifizieren und erste failing Tests schreiben

Kein bestehender Test in `src/` — Vitest ist installiert (siehe package.json `"test": "vitest"`), aber unbenutzt. Wir verifizieren, dass das Setup grundsätzlich läuft.

**Files:**
- Create: `src/utils/guest-fingerprint.test.ts`

- [ ] **Step 1: Test-Datei mit Null-/Empty-Cases erstellen**

Datei `src/utils/guest-fingerprint.test.ts`:

```ts
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
```

- [ ] **Step 2: Tests laufen lassen, Failure beobachten**

Run: `npm test -- --run src/utils/guest-fingerprint.test.ts`
Expected: Tests scheitern mit Fehler wie „Failed to resolve import './guest-fingerprint.js'" oder „Cannot find module" — weil `guest-fingerprint.ts` noch nicht existiert. Das bestätigt: Vitest ist funktional, TDD-Loop läuft.

- [ ] **Step 3: Commit**

```bash
git add src/utils/guest-fingerprint.test.ts
git commit -m "test: add failing tests for fingerprintGuest null/empty inputs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Fingerprint-Util — Skelett mit Null-/Empty-Handling (GREEN)

**Files:**
- Create: `src/utils/guest-fingerprint.ts`

- [ ] **Step 1: Skelett implementieren**

Datei `src/utils/guest-fingerprint.ts`:

```ts
/**
 * Guest Fingerprint
 *
 * Pure function that derives a stable identifier slug and a readable company
 * name from a free-form Guesty guest_name string. Used for repeat-customer
 * analysis without additional API calls.
 *
 * See docs/superpowers/specs/2026-05-13-guest-fingerprint-design.md
 */

export interface GuestFingerprint {
  id: string | null;
  company: string | null;
}

export function fingerprintGuest(
  rawName: string | null | undefined
): GuestFingerprint {
  if (rawName == null) return { id: null, company: null };
  const trimmed = rawName.trim();
  if (trimmed === '') return { id: null, company: null };

  // Person-/Firma-Logik kommt in den nächsten Tasks.
  // Vorerst nur Null-/Empty-Handling.
  return { id: null, company: null };
}
```

- [ ] **Step 2: Tests laufen lassen, GREEN bestätigen**

Run: `npm test -- --run src/utils/guest-fingerprint.test.ts`
Expected: Alle 4 Null-/Empty-Tests bestehen.

- [ ] **Step 3: Commit**

```bash
git add src/utils/guest-fingerprint.ts
git commit -m "feat: add fingerprintGuest stub with null/empty handling

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Person-Mode (TDD: Tests → Implementierung)

**Files:**
- Modify: `src/utils/guest-fingerprint.test.ts`
- Modify: `src/utils/guest-fingerprint.ts`

- [ ] **Step 1: Person-Mode-Tests ergänzen**

In `src/utils/guest-fingerprint.test.ts` nach dem letzten `describe`-Block (vor dem schließenden `});`) einfügen:

```ts
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
```

- [ ] **Step 2: Tests laufen, FAIL erwartet**

Run: `npm test -- --run src/utils/guest-fingerprint.test.ts`
Expected: 7 neue Tests scheitern (id ist überall `null` statt erwarteter Wert).

- [ ] **Step 3: Person-Mode implementieren**

Ersetze den kompletten Inhalt von `src/utils/guest-fingerprint.ts` durch:

```ts
/**
 * Guest Fingerprint
 *
 * Pure function that derives a stable identifier slug and a readable company
 * name from a free-form Guesty guest_name string. Used for repeat-customer
 * analysis without additional API calls.
 *
 * See docs/superpowers/specs/2026-05-13-guest-fingerprint-design.md
 */

export interface GuestFingerprint {
  id: string | null;
  company: string | null;
}

const UMLAUT_MAP: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss',
  Ä: 'ae', Ö: 'oe', Ü: 'ue',
};

function normalizeUnicode(input: string): string {
  let out = input;
  for (const [from, to] of Object.entries(UMLAUT_MAP)) {
    out = out.replaceAll(from, to);
  }
  // Strip remaining combining diacritics (é → e, ñ → n, etc.).
  // Unicode range ̀-ͯ covers "Combining Diacritical Marks".
  out = out.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return out.toLowerCase();
}

function personMode(normalized: string): GuestFingerprint {
  const tokens = normalized
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { id: null, company: null };
  return { id: tokens.join('_'), company: null };
}

export function fingerprintGuest(
  rawName: string | null | undefined
): GuestFingerprint {
  if (rawName == null) return { id: null, company: null };
  const trimmed = rawName.trim();
  if (trimmed === '') return { id: null, company: null };

  try {
    const normalized = normalizeUnicode(trimmed).replace(/\s+/g, ' ').trim();
    // Firma-Detektion kommt im nächsten Task. Vorerst nur Person-Mode.
    return personMode(normalized);
  } catch {
    return { id: null, company: null };
  }
}
```

- [ ] **Step 4: Tests laufen, GREEN bestätigen**

Run: `npm test -- --run src/utils/guest-fingerprint.test.ts`
Expected: Alle 11 Tests (4 null/empty + 7 Person-Mode) bestehen.

- [ ] **Step 5: Commit**

```bash
git add src/utils/guest-fingerprint.ts src/utils/guest-fingerprint.test.ts
git commit -m "feat: implement person-mode for fingerprintGuest

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Firma-Mode (TDD: Tests → Implementierung)

**Files:**
- Modify: `src/utils/guest-fingerprint.test.ts`
- Modify: `src/utils/guest-fingerprint.ts`

- [ ] **Step 1: Firma-Mode-Tests ergänzen**

In `src/utils/guest-fingerprint.test.ts` nach dem Person-Mode-`describe`-Block einfügen:

```ts
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
```

- [ ] **Step 2: Tests laufen, FAIL erwartet**

Run: `npm test -- --run src/utils/guest-fingerprint.test.ts`
Expected: Die neuen 10 Firma-/Stabilitäts-Tests scheitern. Person-Mode + Null-Tests bestehen weiter.

- [ ] **Step 3: Firma-Mode implementieren**

Ersetze den kompletten Inhalt von `src/utils/guest-fingerprint.ts` durch:

```ts
/**
 * Guest Fingerprint
 *
 * Pure function that derives a stable identifier slug and a readable company
 * name from a free-form Guesty guest_name string. Used for repeat-customer
 * analysis without additional API calls.
 *
 * See docs/superpowers/specs/2026-05-13-guest-fingerprint-design.md
 */

export interface GuestFingerprint {
  id: string | null;
  company: string | null;
}

// Echte Rechtsformen (juristische Suffixe). Sortierung in findLastLegalForm()
// nach Länge desc, damit "gmbh & co kg" vor "gmbh" gematcht wird.
const LEGAL_FORMS = [
  'gmbh & co kg',
  'gmbh & co. kg',
  'gmbh und co kg',
  'gmbh',
  'mbh',
  'ag',
  'se',
  'ug',
  'kg',
  'ohg',
  'kgaa',
  'ltd',
  'limited',
  'inc',
  'llc',
  'co',
];

// Beschreibungs- und Füllwörter, die NICHT Teil des Markennamens sind.
const STOPWORDS = new Set([
  'für', 'fuer', 'der', 'die', 'das', 'mit', 'und',
  'agency', 'group', 'gruppe', 'holding', 'consulting',
  'advisor', 'markt', 'random', 'house', 'project',
  'beratungs', 'immobilien', 'verlagsgruppe', 'digitale',
  'transformation', 'gesellschaft',
]);

const DOMAIN_SUFFIX = /\.(de|com|net|org|io|eu|ai|app|co)$/i;

const UMLAUT_MAP: Record<string, string> = {
  ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss',
  Ä: 'ae', Ö: 'oe', Ü: 'ue',
};

function normalizeUnicode(input: string): string {
  let out = input;
  for (const [from, to] of Object.entries(UMLAUT_MAP)) {
    out = out.replaceAll(from, to);
  }
  out = out.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return out.toLowerCase();
}

interface LegalMatch {
  startIndex: number;
  endIndex: number;
}

/**
 * Findet das LETZTE Vorkommen einer Rechtsform im normalisierten String.
 * Längere Treffer (z.B. "gmbh & co kg") gewinnen über kürzere am selben Anfangs-Index,
 * weil die Liste nach Länge absteigend sortiert wird und ein späteres Match einer
 * längeren Form das frühere überschreibt.
 *
 * Das Pattern (?:^|[^a-z0-9])(<form>)(?:[^a-z0-9]|$) matched die Rechtsform mit
 * Wortgrenzen (auch bei Bindestrich davor, z.B. "Beratungs-GmbH").
 */
function findLastLegalForm(normalized: string): LegalMatch | null {
  const sorted = [...LEGAL_FORMS].sort((a, b) => b.length - a.length);
  let best: LegalMatch | null = null;

  for (const form of sorted) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = `(?:^|[^a-z0-9])(${escaped})(?:[^a-z0-9]|$)`;
    const re = new RegExp(pattern, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalized)) !== null) {
      // Position der Capture-Group 1 = tatsächliche Position der Rechtsform.
      const startIndex = normalized.indexOf(m[1], m.index);
      const endIndex = startIndex + m[1].length;
      if (!best || startIndex > best.startIndex) {
        best = { startIndex, endIndex };
      }
      // Endlos-Loop-Schutz bei Zero-Width-Matches.
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  return best;
}

function firmaMode(
  rawTrimmed: string,
  normalized: string,
  legal: LegalMatch
): GuestFingerprint {
  // Tokens vor der Rechtsform → Marken-Slug
  const beforeLegal = normalized.substring(0, legal.startIndex).trim();
  const tokens = beforeLegal.split(/\s+/).filter((t) => t.length > 0);

  const cleaned: string[] = [];
  for (const token of tokens) {
    const noDomain = token.replace(DOMAIN_SUFFIX, '');
    const slug = noDomain.replace(/[^a-z0-9]/g, '');
    if (!slug) continue;
    if (STOPWORDS.has(slug)) continue;
    cleaned.push(slug);
  }
  const id = cleaned.length > 0 ? cleaned[0] : null;

  // company = original-Casing-String bis Ende der Rechtsform
  // legal.endIndex ist Position im normalisierten String — gleiche Länge wie raw
  // (normalizeUnicode ändert keine String-Längen außer bei Umlauten und Diakritika).
  // Sichere Strategie: suche im rawTrimmed das letzte Match derselben Rechtsform-Tokens
  // case-insensitive und schneide dort ab.
  const lowerRaw = rawTrimmed.toLowerCase();
  // Map: rawTrimmed lowercased entspricht NICHT zwingend normalized (Umlaute!),
  // aber Rechtsformen enthalten keine Umlaute. Daher reicht ein lowercased Substring-Search.
  const legalTokenLower = normalized.substring(legal.startIndex, legal.endIndex);

  // Finde letztes Vorkommen im lowerRaw (gleiche Form, da kein Umlaut darin)
  let lastIdx = -1;
  let searchFrom = 0;
  while (true) {
    const found = lowerRaw.indexOf(legalTokenLower, searchFrom);
    if (found === -1) break;
    // Wortgrenzen verifizieren
    const before = found === 0 ? '' : lowerRaw[found - 1];
    const after =
      found + legalTokenLower.length >= lowerRaw.length
        ? ''
        : lowerRaw[found + legalTokenLower.length];
    const isWordChar = (c: string) => /[a-z0-9]/.test(c);
    if (!isWordChar(before) && !isWordChar(after)) {
      lastIdx = found;
    }
    searchFrom = found + 1;
  }

  let company: string;
  if (lastIdx === -1) {
    // Fallback: nimm den Substring nach Position im normalized-String
    company = rawTrimmed.substring(0, legal.endIndex).trim();
  } else {
    company = rawTrimmed.substring(0, lastIdx + legalTokenLower.length).trim();
  }

  return { id, company };
}

function personMode(normalized: string): GuestFingerprint {
  const tokens = normalized
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { id: null, company: null };
  return { id: tokens.join('_'), company: null };
}

export function fingerprintGuest(
  rawName: string | null | undefined
): GuestFingerprint {
  if (rawName == null) return { id: null, company: null };
  const trimmed = rawName.trim();
  if (trimmed === '') return { id: null, company: null };

  try {
    const normalized = normalizeUnicode(trimmed).replace(/\s+/g, ' ').trim();
    const legal = findLastLegalForm(normalized);
    if (legal) {
      return firmaMode(trimmed, normalized, legal);
    }
    return personMode(normalized);
  } catch {
    return { id: null, company: null };
  }
}
```

- [ ] **Step 4: Tests laufen, GREEN bestätigen**

Run: `npm test -- --run src/utils/guest-fingerprint.test.ts`
Expected: Alle 21 Tests (4 null + 7 Person + 8 Firma + 2 Stabilität) bestehen.

- [ ] **Step 5: Commit**

```bash
git add src/utils/guest-fingerprint.ts src/utils/guest-fingerprint.test.ts
git commit -m "feat: implement firma-mode for fingerprintGuest

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Regression-Fixture mit allen 33 Bestandsnamen

**Files:**
- Modify: `src/utils/guest-fingerprint.test.ts`

- [ ] **Step 1: Fixture-Test ergänzen**

In `src/utils/guest-fingerprint.test.ts` vor dem schließenden `});` einfügen:

```ts
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
```

- [ ] **Step 2: Tests laufen lassen**

Run: `npm test -- --run src/utils/guest-fingerprint.test.ts`
Expected: Alle 21 + 34 (1 count check + 33 fixtures) Tests bestehen. Insgesamt 55 passing.

Falls einzelne Fixtures scheitern: Output sorgfältig lesen — meist ein Edge-Case in der Stoppwort- oder Rechtsform-Liste. Kein „workaround" inline patchen, sondern in den Konstanten ergänzen und alle Tests wieder grün laufen lassen.

- [ ] **Step 3: Commit**

```bash
git add src/utils/guest-fingerprint.test.ts
git commit -m "test: add regression fixtures for all 33 farmhouse guest names

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Type-Modell erweitern

**Files:**
- Modify: `src/types/models.ts` (Reservation Interface bei Zeile ~178, ReservationRow bei ~334)

- [ ] **Step 1: `Reservation` Interface erweitern**

In `src/types/models.ts` — finde den Block:

```ts
  // Metadata
  created_at_guesty: string | null;
  reserved_at: string | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}
```

(im `Reservation`-Interface, ca. Zeile 203-209)

Ersetze diesen Block durch:

```ts
  // Metadata
  created_at_guesty: string | null;
  reserved_at: string | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;

  // Local-only fingerprint (computed in mapper, see src/utils/guest-fingerprint.ts)
  internal_guest_id: string | null;
  guest_company: string | null;
}
```

- [ ] **Step 2: `ReservationRow` Interface erweitern**

Im selben File, finde:

```ts
  created_at_guesty: string | null;
  reserved_at: string | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}
```

(im `ReservationRow`-Interface, ca. Zeile 333-338)

Ersetze durch:

```ts
  created_at_guesty: string | null;
  reserved_at: string | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
  internal_guest_id: string | null;
  guest_company: string | null;
}
```

- [ ] **Step 3: Build prüfen**

Run: `npm run build`
Expected: Erfolgreicher Build. Hinweis: Es können TypeScript-Errors in `reservation-mapper.ts` oder `reservation-repository.ts` auftreten („Property 'internal_guest_id' is missing"). Das ist erwartet — wir fixen es in den nächsten Tasks. Falls der Build trotzdem durchläuft, ist `Omit<Reservation, 'id' | 'created_at' | 'updated_at'>` strukturell auf die neuen Felder durchgesprungen.

Run: `npm run lint`
Expected: keine neuen Errors.

- [ ] **Step 4: Commit**

```bash
git add src/types/models.ts
git commit -m "feat: extend Reservation type with internal_guest_id and guest_company

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Mapper erweitern

**Files:**
- Modify: `src/mappers/reservation-mapper.ts`

- [ ] **Step 1: Import ergänzen**

In `src/mappers/reservation-mapper.ts` nach dem bestehenden Import-Block (Zeile 7-9) ergänzen:

```ts
import { fingerprintGuest } from '../utils/guest-fingerprint.js';
```

Der Import-Block sieht danach so aus:

```ts
import type { GuestyCalendarDay } from '../types/guesty.js';
import type { Reservation } from '../types/models.js';
import logger from '../utils/logger.js';
import { fingerprintGuest } from '../utils/guest-fingerprint.js';
```

- [ ] **Step 2: Fingerprint im Return-Objekt einbauen**

Im `extractReservationFromCalendar()`-Body, im `return`-Statement der `try`-Block — finde diesen Teil (Zeile ~64-68):

```ts
      // Metadata
      created_at_guesty: res.createdAt || null,
      reserved_at: res.reservedAt || null,
      last_synced_at: lastSyncedAt,
    };
```

Ersetze durch:

```ts
      // Metadata
      created_at_guesty: res.createdAt || null,
      reserved_at: res.reservedAt || null,
      last_synced_at: lastSyncedAt,

      // Local-only fingerprint (computed from guest_name, see src/utils/guest-fingerprint.ts)
      ...fingerprintGuestSafe(res.guest?.fullName || null),
    };
```

- [ ] **Step 3: Defensive Wrapper-Funktion ergänzen**

Im selben File, ganz unten nach `extractReservationsFromCalendar()` einfügen:

```ts
/**
 * Defensive wrapper: any fingerprint failure logs warn but never crashes the mapper.
 * Returns the two fields needed for the Reservation object.
 */
function fingerprintGuestSafe(
  rawName: string | null
): { internal_guest_id: string | null; guest_company: string | null } {
  try {
    const fp = fingerprintGuest(rawName);
    return { internal_guest_id: fp.id, guest_company: fp.company };
  } catch (error) {
    logger.warn({ error, rawName }, 'fingerprintGuest threw, falling back to nulls');
    return { internal_guest_id: null, guest_company: null };
  }
}
```

- [ ] **Step 4: Build prüfen**

Run: `npm run build`
Expected: Erfolgreich, keine TS-Errors mehr im Mapper.

Run: `npm run lint`
Expected: keine neuen Errors.

- [ ] **Step 5: Sanity-Test über Vitest**

Run: `npm test -- --run`
Expected: Alle 55 Tests aus Task 6 bestehen weiter — Mapper ändert nichts an Fingerprint-Tests.

- [ ] **Step 6: Commit**

```bash
git add src/mappers/reservation-mapper.ts
git commit -m "feat: write guest fingerprint in reservation mapper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Repository SQL erweitern (Single + Batch)

**Files:**
- Modify: `src/repositories/reservation-repository.ts`

Wichtig: BEIDE Upsert-Funktionen anpassen — `upsertReservation` und `upsertReservationBatch`. Sie haben identische SQL-Strukturen.

- [ ] **Step 1: `upsertReservation()` — INSERT-Spalten erweitern**

In `src/repositories/reservation-repository.ts`, finde im `upsertReservation()`-Body (Zeile 22-39) den INSERT:

```ts
      INSERT INTO reservations (
        reservation_id, listing_id, check_in, check_out,
        check_in_localized, check_out_localized, nights_count,
        guest_id, guest_name, guests_count, adults_count, children_count, infants_count,
        status, confirmation_code, source, platform,
        planned_arrival, planned_departure,
        currency, total_price, host_payout, balance_due, total_paid,
        created_at_guesty, reserved_at, last_synced_at
      ) VALUES (
        @reservation_id, @listing_id, @check_in, @check_out,
        @check_in_localized, @check_out_localized, @nights_count,
        @guest_id, @guest_name, @guests_count, @adults_count, @children_count, @infants_count,
        @status, @confirmation_code, @source, @platform,
        @planned_arrival, @planned_departure,
        @currency, @total_price, @host_payout, @balance_due, @total_paid,
        @created_at_guesty, @reserved_at, @last_synced_at
      )
```

Ersetze durch:

```ts
      INSERT INTO reservations (
        reservation_id, listing_id, check_in, check_out,
        check_in_localized, check_out_localized, nights_count,
        guest_id, guest_name, guests_count, adults_count, children_count, infants_count,
        status, confirmation_code, source, platform,
        planned_arrival, planned_departure,
        currency, total_price, host_payout, balance_due, total_paid,
        created_at_guesty, reserved_at, last_synced_at,
        internal_guest_id, guest_company
      ) VALUES (
        @reservation_id, @listing_id, @check_in, @check_out,
        @check_in_localized, @check_out_localized, @nights_count,
        @guest_id, @guest_name, @guests_count, @adults_count, @children_count, @infants_count,
        @status, @confirmation_code, @source, @platform,
        @planned_arrival, @planned_departure,
        @currency, @total_price, @host_payout, @balance_due, @total_paid,
        @created_at_guesty, @reserved_at, @last_synced_at,
        @internal_guest_id, @guest_company
      )
```

- [ ] **Step 2: `upsertReservation()` — ON CONFLICT UPDATE erweitern**

Direkt darunter, finde:

```ts
      ON CONFLICT(reservation_id) DO UPDATE SET
        check_in = excluded.check_in,
        ...
        last_synced_at = excluded.last_synced_at,
        updated_at = datetime('now')
    `);
```

Vor `updated_at = datetime('now')` zwei Zeilen einfügen — der finale Block sieht so aus:

```ts
      ON CONFLICT(reservation_id) DO UPDATE SET
        check_in = excluded.check_in,
        check_out = excluded.check_out,
        check_in_localized = excluded.check_in_localized,
        check_out_localized = excluded.check_out_localized,
        nights_count = excluded.nights_count,
        guest_id = excluded.guest_id,
        guest_name = excluded.guest_name,
        guests_count = excluded.guests_count,
        adults_count = excluded.adults_count,
        children_count = excluded.children_count,
        infants_count = excluded.infants_count,
        status = excluded.status,
        confirmation_code = excluded.confirmation_code,
        source = excluded.source,
        platform = excluded.platform,
        planned_arrival = excluded.planned_arrival,
        planned_departure = excluded.planned_departure,
        currency = excluded.currency,
        total_price = excluded.total_price,
        host_payout = excluded.host_payout,
        balance_due = excluded.balance_due,
        total_paid = excluded.total_paid,
        created_at_guesty = excluded.created_at_guesty,
        reserved_at = excluded.reserved_at,
        last_synced_at = excluded.last_synced_at,
        internal_guest_id = excluded.internal_guest_id,
        guest_company = excluded.guest_company,
        updated_at = datetime('now')
    `);
```

- [ ] **Step 3: `upsertReservationBatch()` — gleiche zwei Änderungen wiederholen**

Im selben File, ab ca. Zeile 87, findet sich `upsertReservationBatch()`. Wende die exakt gleichen INSERT- und ON CONFLICT-Änderungen wie in Step 1 + 2 hier auch an. (Der SQL-Inhalt ist identisch.)

- [ ] **Step 4: Build + Lint prüfen**

Run: `npm run build && npm run lint`
Expected: kein Error.

- [ ] **Step 5: Sanity: Tests laufen**

Run: `npm test -- --run`
Expected: 55 Tests bestehen weiter.

- [ ] **Step 6: Commit**

```bash
git add src/repositories/reservation-repository.ts
git commit -m "feat: persist guest fingerprint in reservation upsert

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Backfill-Script

**Files:**
- Create: `src/scripts/backfill-guest-fingerprint.ts`

- [ ] **Step 1: Backfill-Script schreiben**

Datei `src/scripts/backfill-guest-fingerprint.ts`:

```ts
/**
 * Backfill Guest Fingerprint
 *
 * Computes internal_guest_id and guest_company for existing reservations
 * where they are still NULL (or for all rows if --force is passed).
 *
 * Usage:
 *   npx tsx src/scripts/backfill-guest-fingerprint.ts --dry-run
 *   npx tsx src/scripts/backfill-guest-fingerprint.ts --apply
 *   npx tsx src/scripts/backfill-guest-fingerprint.ts --apply --force
 *
 * Safe to re-run: without --force it only touches rows with NULL fingerprint.
 */

import { getDatabase } from '../db/index.js';
import { fingerprintGuest } from '../utils/guest-fingerprint.js';
import logger from '../utils/logger.js';

interface Row {
  id: number;
  reservation_id: string;
  guest_name: string | null;
  internal_guest_id: string | null;
  guest_company: string | null;
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');
  const force = args.includes('--force');

  if (!dryRun && !apply) {
    console.error('Usage: backfill-guest-fingerprint.ts --dry-run | --apply [--force]');
    process.exit(1);
  }

  const db = getDatabase();

  const where = force ? '' : 'WHERE internal_guest_id IS NULL';
  const rows = db
    .prepare(
      `SELECT id, reservation_id, guest_name, internal_guest_id, guest_company
       FROM reservations
       ${where}
       ORDER BY id ASC`
    )
    .all() as Row[];

  console.log(`Found ${rows.length} reservations to process (force=${force})`);
  console.log('');

  const update = db.prepare(
    `UPDATE reservations
     SET internal_guest_id = ?, guest_company = ?
     WHERE id = ?`
  );

  let changed = 0;
  for (const row of rows) {
    const fp = fingerprintGuest(row.guest_name);
    const willChange =
      fp.id !== row.internal_guest_id || fp.company !== row.guest_company;

    const status = willChange ? 'CHANGE' : 'same';
    console.log(
      `[${status}] #${row.id}  "${row.guest_name ?? '(null)'}"  →  id="${fp.id ?? '(null)'}"  company="${fp.company ?? '(null)'}"`
    );

    if (apply && willChange) {
      update.run(fp.id, fp.company, row.id);
      changed++;
    }
  }

  console.log('');
  if (dryRun) {
    console.log(`DRY-RUN: would update ${rows.filter((r) => {
      const f = fingerprintGuest(r.guest_name);
      return f.id !== r.internal_guest_id || f.company !== r.guest_company;
    }).length} rows. No write performed.`);
  } else {
    console.log(`APPLIED: updated ${changed} rows.`);
  }
}

try {
  main();
} catch (error) {
  logger.error({ error }, 'Backfill failed');
  process.exit(1);
}
```

- [ ] **Step 2: Dry-Run lokal testen**

Run: `npx tsx src/scripts/backfill-guest-fingerprint.ts --dry-run`
Expected: Tabellenartige Liste aller Reservierungen mit berechneten Fingerprints. Letzte Zeile: „DRY-RUN: would update N rows. No write performed."

Hinweis: Lokale DB ist seit Feb 2026 stale (alle 33 Bestandsbuchungen mit alten Namen). Das Dry-Run produziert die im Regression-Test erwarteten Werte für die alten Namen — `"Sabine Fastic GmbH"` → `sabine`. Auf Production nach frischem Sync würde der neue Name → `fastic` produzieren.

- [ ] **Step 3: Apply lokal testen**

Run: `npx tsx src/scripts/backfill-guest-fingerprint.ts --apply`
Expected: Status [CHANGE] für alle Zeilen, am Ende: „APPLIED: updated 33 rows."

- [ ] **Step 4: Idempotenz prüfen**

Run nochmal: `npx tsx src/scripts/backfill-guest-fingerprint.ts --apply`
Expected: „Found 0 reservations to process" oder alle Zeilen mit [same]-Status und „APPLIED: updated 0 rows."

- [ ] **Step 5: SQL-Verifikation**

Run:
```bash
sqlite3 data/calendar.db <<'EOF'
.headers on
.mode column
SELECT internal_guest_id, COUNT(*) AS n, GROUP_CONCAT(guest_name, ' | ') AS namen
FROM reservations
WHERE listing_id='686d1e927ae7af00234115ad'
GROUP BY internal_guest_id
ORDER BY n DESC LIMIT 10;
EOF
```
Expected: 33 distinkte `internal_guest_id`-Werte für die 33 Buchungen, alle mit n=1. Keine Duplikate (in der aktuellen Stale-DB). Auf Production nach frischem Sync ggf. Duplikate, falls echte Repeats inzwischen existieren.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/backfill-guest-fingerprint.ts
git commit -m "feat: add idempotent backfill script for guest fingerprint

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Final Sanity Check

**Files:** keine Änderungen, nur Verifikation.

- [ ] **Step 1: Vollständiger Build**

Run: `npm run build`
Expected: Kein Error. `dist/` ist aktuell.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: Kein Error.

- [ ] **Step 3: Volle Test-Suite**

Run: `npm test -- --run`
Expected: 55 passing.

- [ ] **Step 4: Migrations-Liste prüfen**

Run: `sqlite3 data/calendar.db "SELECT filename FROM migrations ORDER BY id"`
Expected: Liste endet mit `012_add_guest_fingerprint.sql`.

- [ ] **Step 5: Reservation-Stichprobe**

Run:
```bash
sqlite3 data/calendar.db <<'EOF'
.headers on
.mode column
SELECT reservation_id, guest_name, internal_guest_id, guest_company
FROM reservations
WHERE listing_id='686d1e927ae7af00234115ad'
LIMIT 5;
EOF
```
Expected: Alle 5 Zeilen haben `internal_guest_id` befüllt. `guest_company` ist NULL für Privatpersonen, befüllt für Firmen.

- [ ] **Step 6: Bestehende Verhalten unverändert?**

Run: `npx tsx src/scripts/test-all-reservations.ts` (falls vorhanden) — sonst alternative:
```bash
sqlite3 data/calendar.db "SELECT COUNT(*) FROM reservations" 
```
Expected: 33 (oder die ursprüngliche Anzahl). Keine Reservierungen wurden durch das Backfill gelöscht oder dupliziert.

---

### Task 12: Deployment-Notiz ergänzen

**Files:**
- Modify: `CLAUDE.md` (am Ende, optional neuer Abschnitt)

- [ ] **Step 1: Deploy-Sektion ergänzen**

In `CLAUDE.md` am Ende, vor dem letzten Abschnitt, einfügen:

```markdown
### Guest Fingerprint (Migration 012)

Lokal berechneter Fingerprint für Repeat-Customer-Analyse — keine Guesty-API-Calls.
Felder: `reservations.internal_guest_id` (Slug), `reservations.guest_company` (Klartext-Firma, NULL bei Privatpersonen).
- Algorithmus: `src/utils/guest-fingerprint.ts` (pure function, vollständig getestet)
- Schreibt sich bei jedem ETL-Sync automatisch ins Mapping
- Einmaliges Backfill: `npx tsx src/scripts/backfill-guest-fingerprint.ts --apply`
- Spec: `docs/superpowers/specs/2026-05-13-guest-fingerprint-design.md`

**Pre-Backfill-Check (wichtig):** Bei stale-Sync würden alte Namen gefingerprintet. Daher
vor dem Backfill auf Production einen Force-Sync laufen lassen:
`npx tsx src/scripts/sync-property.ts farmhouse` und `... u19`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document guest fingerprint feature in CLAUDE.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Done-Definition

- [ ] Migration 012 angewendet, zwei neue Spalten existieren
- [ ] `fingerprintGuest()` mit 55 grünen Tests, davon 33 Regression-Fixtures
- [ ] Mapper schreibt Fingerprint bei jedem ETL-Sync
- [ ] Repository persistiert die zwei neuen Spalten in INSERT und UPDATE
- [ ] Backfill-Script idempotent, mit Dry-Run validiert
- [ ] Build + Lint + Tests grün
- [ ] Bestehende Tests/Features unverändert
- [ ] Deployment-Notiz in CLAUDE.md
- [ ] (Production-Schritte aus Spec Sektion 7 sind eine separate Deploy-Aktion)

## Pre-Deploy-Checkliste (siehe Spec Sektion 7)

Nach Merge auf `main`:
1. SSH auf `deploy@guesty.remoterepublic.com`
2. `git pull && npm install && npm run build && pm2 restart guesty-calendar`
3. `pm2 logs guesty-calendar --lines 20` → Migration 012 applied bestätigen
4. `curl https://guesty.remoterepublic.com/health` → 200 OK
5. **Frischer Sync:** `cd /opt/guesty-calendar-app && npx tsx src/scripts/sync-property.ts farmhouse` und `... u19`
6. **Dry-Run:** `npx tsx src/scripts/backfill-guest-fingerprint.ts --dry-run` → Output kontrollieren
7. **Apply:** `npx tsx src/scripts/backfill-guest-fingerprint.ts --apply`
8. **Sanity:** `sqlite3 /opt/guesty-calendar-app/data/calendar.db "SELECT internal_guest_id, COUNT(*) FROM reservations GROUP BY internal_guest_id ORDER BY 2 DESC LIMIT 10"`
9. `pm2 logs guesty-calendar --lines 50` für 24 h monitoren
