# Guest Fingerprint — Design Spec

**Datum:** 2026-05-13
**Status:** Draft — awaiting user review
**Scope:** Reservierungen aller Properties (Farmhouse + U19)
**Hauptziel:** Repeat-Customer-Erkennung für BI-Analyse ohne zusätzliche Guesty-API-Calls

---

## 1. Motivation

Im BI-Zwischenstand (`data/bi-zwischenstand-farmhouse.md`) wurde festgestellt: Alle 24 manuellen Guesty-Buchungen für Farmhouse haben `guest_id = ''`. Eine naive Repeat-Customer-Analyse über `guest_id` gruppiert sie fälschlich zu einem Pseudo-Stammgast.

Tatsächlich sind die 33 Buchungen 33 verschiedene Gäste — aber: bisher haben wir keine Möglichkeit zu erkennen, wenn dieselbe Firma (z. B. „digitransform GmbH") ein zweites Mal bucht, weil Guesty bei manuellen Buchungen keine stabile `guestId` vergibt.

**Constraint vom User:** Keine zusätzlichen API-Calls (Sorge vor OAuth `too-many-requests`), bestehende Logik darf nicht beeinträchtigt werden.

**Lösung:** Lokal berechneter Fingerprint aus dem bereits vorhandenen `guest_name`-Feld.

---

## 2. Architektur

**Neu:**

1. **Migration `012_add_guest_fingerprint.sql`** — zwei nullable Spalten in `reservations`:
   - `internal_guest_id TEXT` — Slug (z. B. `fastic`, `sebastian_memmel`)
   - `guest_company TEXT` — Klartext-Firma, `NULL` bei Privatpersonen
   - Index `idx_reservations_internal_guest_id` auf `internal_guest_id`
2. **`src/utils/guest-fingerprint.ts`** — pure Funktion `fingerprintGuest(name: string | null): { id: string | null; company: string | null }`. Keine DB-/ETL-Imports.
3. **`src/scripts/backfill-guest-fingerprint.ts`** — CLI mit `--dry-run` und `--apply`. Idempotent.
4. **`src/utils/guest-fingerprint.test.ts`** — Vitest mit allen 33 Bestandsnamen als Fixtures, Edge-Cases, Stabilität.

**Geändert (minimal):**

5. **`src/mappers/reservation-mapper.ts`** — ruft `fingerprintGuest()` auf, schreibt `internal_guest_id` und `guest_company` ins gemappte Objekt.
6. **`src/repositories/reservation-repository.ts`** — INSERT/UPSERT-Statements werden um die zwei neuen Spalten erweitert.
7. **`src/types/models.ts`** — `Reservation`-Type um `internal_guest_id` und `guest_company` ergänzen.

**Nicht angefasst:**

Routes, Frontend, GA4-Sync, Listings, Availability, Inquiries, Documents, Quote-Cache, Scheduler.

**Safety-Garantien:**

- Migration ist rein additive (`ADD COLUMN` mit `NULL` default) — kann nicht fehlschlagen, ist rückwärtskompatibel.
- Bestehende Code-Pfade lesen die neuen Spalten nicht → keine Verhaltensänderung außerhalb der BI-Analyse.
- Fingerprint-Funktion gibt im Fehlerfall `null` zurück — Mapper crasht nie.

---

## 3. Algorithmus

Pure Funktion `fingerprintGuest(rawName: string | null) → { id: string | null; company: string | null }`.

### 3.1 Konstanten

```ts
// Echte Rechtsformen (juristische Suffixe). Werden mit Wortgrenzen gematcht.
const LEGAL_FORMS = [
  'gmbh & co kg', 'gmbh & co. kg', 'gmbh und co kg',
  'gmbh', 'mbh', 'ag', 'se', 'ug', 'kg', 'ohg', 'kgaa',
  'ltd', 'limited', 'inc', 'llc', 'co',
];

// Beschreibungs- und Füllwörter, die NICHT Teil des Markennamens sind.
const STOPWORDS = [
  'für', 'fuer', 'der', 'die', 'das', 'mit', 'und',
  'agency', 'group', 'gruppe', 'holding', 'consulting',
  'advisor', 'markt', 'random', 'house', 'project',
  'beratungs', 'immobilien', 'verlagsgruppe', 'digitale',
  'transformation', 'gesellschaft',
];

const DOMAIN_SUFFIX = /\.(de|com|net|org|io|eu|ai|app|co)$/i;
```

Beide Listen sind als TS-Konstanten oben in der Datei definiert und einfach erweiterbar.

**Wichtig:** Bei mehreren `LEGAL_FORM`-Tokens im selben String wird das **letzte** Vorkommen als Firma-Ende verwendet. Beispiel: `"digitransform.de Gesellschaft für digitale Transformation mbH Thomas Grieß"` → das `mbH` markiert das Firma-Ende, alles davor ist `company`, alles danach ist Person.

### 3.2 Schritte

1. **Null-/Leer-Check:** bei `null`, `''`, nur Whitespace → `{ id: null, company: null }`
2. **Unicode-Normalize:** `ä→ae`, `ö→oe`, `ü→ue`, `ß→ss`, `é→e`, `ñ→n` etc. (via `String.normalize('NFKD')` + Diakritika-Entfernung + manuelle Umlaut-Map)
3. **Whitespace-collapse:** mehrfache Spaces auf einen, trim
4. **Firmen-Detektion:** Enthält der String eines der `LEGAL_FORMS`-Tokens (case-insensitive, mit Wortgrenzen)?
   - **Ja** → Firma-Mode (3.3)
   - **Nein** → Person-Mode (3.4)

### 3.3 Firma-Mode

- `company` = alles bis inkl. Rechtsform (Klartext, original Casing aus Input)
- Tokens vor der Rechtsform: lowercase splitten
- Domain-Suffix vom ersten Token entfernen (`digitransform.de` → `digitransform`)
- Stoppwörter herausfiltern
- `id` = das erste verbleibende Token, slug-safe gemacht (`[a-z0-9_]`)

### 3.4 Person-Mode

- `company` = `null`
- Alle Tokens lowercase, Diakritika weg, Sonderzeichen weg
- `id` = Tokens mit `_` joined (`sebastian_memmel`, `cynthia`, `evolena_de_wilde`)

### 3.5 Beispiel-Tabelle (alle relevanten Pattern aus der echten DB)

| Input | `id` | `company` |
|---|---|---|
| `"Sabine Fastic GmbH"` (alter DB-Stand) | `sabine` | `Sabine Fastic GmbH` |
| `"Fastic GmbH Sabine Drescher"` (aktueller Guesty-Stand) | `fastic` | `Fastic GmbH` |
| `"Rewe Markt GmbH"` | `rewe` | `Rewe Markt GmbH` |
| `"digitransform.de Gesellschaft für digitale Transformation mbH Thomas Grieß"` | `digitransform` | `digitransform.de Gesellschaft für digitale Transformation mbH` |
| `"Penguin Random House Verlagsgruppe GmbH Katja Weingartner"` | `penguin` | `Penguin Random House Verlagsgruppe GmbH` |
| `"Aenu Advisor GmbH  Catrin Schmidt"` | `aenu` | `Aenu Advisor GmbH` |
| `"Flink SE"` | `flink` | `Flink SE` |
| `"Sebastian Memmel"` | `sebastian_memmel` | `null` |
| `"Cynthia"` | `cynthia` | `null` |
| `"Evoléna De Wilde"` | `evolena_de_wilde` | `null` |
| `""` / `null` | `null` | `null` |

**Anmerkung:** Bei „Vorname Marke Rechtsform"-Mustern (wie „Sabine Fastic GmbH") produziert der Algorithmus den Vornamen als ID — unser Code kann Vornamen nicht von Markennamen unterscheiden. Konkret betroffen ist dieser eine Datensatz; in Guesty wurde der Name inzwischen auf „Fastic GmbH Sabine Drescher" korrigiert, beim nächsten Sync propagiert sich der korrekte Fingerprint `fastic`. Daher ist der frische Sync vor dem Backfill (Sektion 7) zentral.

---

## 4. Datenfluss

### 4.1 Normaler ETL-Pfad (nach Deploy)

```
Guesty Calendar API
   ↓ guesty-client.ts (rate-limited, kein zusätzlicher Call)
   ↓ sync-availability.ts
   ↓ extractReservationsFromCalendar()
   ↓ reservation-mapper.ts ← fingerprintGuest(guest_name)
   ↓ reservation-repository.ts (UPSERT auf reservation_id)
   ↓ SQLite: guest_name + internal_guest_id + guest_company
```

Jeder Sync rechnet den Fingerprint frisch aus dem aktuellen `guest_name` aus. Namen-Änderungen in Guesty (z. B. `"Sabine Fastic GmbH" → "Fastic GmbH Sabine Drescher"`) propagieren sich beim nächsten ETL automatisch — kein manuelles Eingreifen nötig.

### 4.2 Einmaliger Backfill-Pfad (nach Deploy)

```
backfill-guest-fingerprint.ts
   ↓ SELECT id, guest_name FROM reservations WHERE internal_guest_id IS NULL
   ↓ Für jeden: fingerprintGuest(guest_name)
   ↓ --dry-run: nur loggen, kein Write
   ↓ --apply:   UPDATE reservations SET internal_guest_id=?, guest_company=? WHERE id=?
```

Idempotent: schreibt nur in Zeilen mit `internal_guest_id IS NULL`. Optional `--force`-Flag für komplettes Neuschreiben.

---

## 5. Error-Handling

| Szenario | Verhalten |
|---|---|
| `guest_name = null` | `{ id: null, company: null }` — DB-Spalten bleiben `NULL` |
| `guest_name = ''` oder nur Whitespace | wie oben |
| Unbekanntes Zeichen / Unicode-Edgecase | best-effort: fällt durch in Person-Mode mit ASCII-Resten |
| Fingerprint wirft Exception | Mapper fängt ab (try/catch), schreibt `NULL`, loggt `warn` mit `reservation_id` — Reservierung kommt trotzdem in die DB |
| Backfill-Script trifft auf neuen Edge-Case | `--dry-run`-Liste zeigt Auffälligkeiten vor `--apply` |

**Garantie:** Mapper bleibt nicht stehen, ETL bricht nicht ab — schlimmster Fall ist ein `NULL` in den zwei neuen Spalten. Bestehende Felder (`guest_name`, `total_price`, etc.) sind nie betroffen.

---

## 6. Testing

**`src/utils/guest-fingerprint.test.ts`** — drei Gruppen:

1. **Alle 33 Bestandsnamen als Fixtures** — jede Zeile mit erwartetem `id`/`company`. Regression-Sicherheit für künftige Refactors.
2. **Edge-Cases:** `null`, `''`, `'   '`, nur Rechtsform (`'GmbH'`), nur Vornamen, Umlaute, Sonderzeichen, sehr langer String, mehrere Rechtsformen im Namen.
3. **Stabilität:** gleicher Input → gleicher Output (Determinismus); unterschiedliche Casings → gleicher Fingerprint; Whitespace-Varianten → gleicher Fingerprint.

Kein Integrationstest mit echter DB nötig — Fingerprint ist pure Function.

**Existierende Mapper-Tests** (falls vorhanden) bekommen einen Fixture-Eintrag ergänzt, der `internal_guest_id` und `guest_company` prüft.

---

## 7. Deployment & Pre-Backfill-Checkliste

Reihenfolge auf Production (`deploy@guesty.remoterepublic.com`, Pfad `/opt/guesty-calendar-app`):

1. Code mergen, deployen: `git pull && npm install && npm run build && pm2 restart guesty-calendar`
2. Health-Check: `curl https://guesty.remoterepublic.com/health`
3. Migration läuft beim Startup automatisch — in den Logs bestätigen: „Migration 012 applied"
4. **Frischer Sync:** `npx tsx src/scripts/sync-property.ts farmhouse` und `npx tsx src/scripts/sync-property.ts u19` — stellt sicher, dass Guest-Namen aktuell sind (nicht stale)
5. **Dry-Run:** `npx tsx src/scripts/backfill-guest-fingerprint.ts --dry-run` → Liste aller berechneten Fingerprints prüfen
6. **Apply:** `npx tsx src/scripts/backfill-guest-fingerprint.ts --apply`
7. **Sanity-Check:**
   ```sql
   SELECT internal_guest_id, COUNT(*) AS n
   FROM reservations
   WHERE listing_id='686d1e927ae7af00234115ad'
   GROUP BY internal_guest_id
   ORDER BY n DESC LIMIT 10;
   ```
   Gibt es jetzt echte Repeats? (Erwartung für Farmhouse heute: noch keine, aber baseline für die Zukunft.)
8. PM2-Logs 24h beobachten — sicherstellen, dass neue ETL-Runs Fingerprints korrekt schreiben.

**Rollback-Pfad:** Migration ist additive → einfach Code zurückrollen, die zwei neuen Spalten bleiben in der DB liegen (`NULL` für neue Inserts, kein Schaden). Keine Datenmigration rückwärts nötig.

---

## 8. Bewusst nicht im Scope (YAGNI)

- Keine zusätzlichen Guesty-API-Calls für volle Guest-Profile (User-Constraint: OAuth-Limits)
- Keine E-Mail-Sekundärschlüssel (Guesty Calendar-Endpoint liefert keine Gast-E-Mails)
- Keine Verknüpfung mit `inquiries` (separater Job, falls überhaupt nötig)
- Keine Fuzzy-Match-Heuristik (Levenshtein etc.) — deterministische Slug-Regel reicht
- Keine UI-Anzeige der Fingerprints — nur DB-Spalten für SQL-Analyse / Admin-Dashboard kann später nachgezogen werden
- Keine Migration auf `inquiries` (separate Entscheidung, falls Inquiry-Repeats relevant werden)

---

## 9. Offene Punkte für Implementierungsplan

- Genaue Definition der Token-Splitting-Regel (Whitespace vs. Whitespace+Tab+Newline)
- Reihenfolge der Stoppwort-/Domain-Filter (kann das Endergebnis beeinflussen — empfohlene Reihenfolge: 1) Domain-Suffix entfernen, 2) Stoppwörter filtern, 3) Erstes Token nehmen)
- Mapper-Test-Fixture vorhanden? Falls nein, neu anlegen
- Backfill-Script: Per-Property oder global? (Vorschlag: global, da `reservations` über alle Properties geht)
