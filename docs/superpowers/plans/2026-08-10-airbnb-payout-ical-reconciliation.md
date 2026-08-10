# Airbnb Payout-Ingest + iCal-Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Florenz-Reporting selbstheilend machen: verschluckte IMAP-Mails fixen, Airbnb-Auszahlungsmails als Ground-Truth für Beträge einlesen, Reservierungen gegen den iCal-Kalender abgleichen (Datumsänderungen, fehlende Buchungen), und geschätzte/unbestätigte Werte in beiden Report-Mails sichtbar markieren.

**Architecture:** Der airbnb-mail-Provider (Firenze) bekommt drei neue Bausteine: (1) UID-korrektes IMAP-Fetching, (2) einen Payout-Mail-Parser + -Applier, der pro Reservierungscode die tatsächlich überwiesenen Beträge aufsummiert und in `reservations` zurückschreibt, (3) einen Reconcile-Schritt im ETL, der Belegungsintervalle (aus `availability.block_ref`, das den Reservierungscode trägt) mit der `reservations`-Tabelle abgleicht. Eine neue Spalte `reservations.payout_status` ('confirmed'|'estimated') steuert die Markierung in Weekly- und BI-Report.

**Tech Stack:** Node.js/TypeScript, better-sqlite3, imapflow, cheerio, vitest. Bestehende Muster: Parser mit Inline-Text-Fixtures, Repo-Tests mit `new Database(':memory:')` + `setDatabase()`, SQL-Migrationen in `src/db/migrations/NNN_*.sql`.

## Global Constraints

- Sprache von Code/Kommentaren: Englisch (wie Bestand); Report-Mail-Texte für Menschen: bestehende Sprache der Templates beibehalten (Weekly = Englisch-Labels, BI = Deutsch).
- `reservations`-TypeScript-Interface (`src/types/models.ts`) NICHT um `payout_status` erweitern — die Spalte wird nur über gezielte UPDATEs im neuen Repo geschrieben, damit Guesty/Hostex-Mapper unberührt bleiben.
- `raw/`-artige Daten: `airbnb_mail_archive` ist Quelle für den Backfill, wird nie mutiert außer `parse_status`/`detected_type`.
- Beträge: deutsche Zahlformate ("1.068,00"), Rundung auf 2 Stellen via `Math.round(x * 100) / 100`.
- Tests: jede neue Datei hat eine `.test.ts`-Datei daneben (Bestandsmuster). `npm test` muss nach jedem Task grün sein, `npm run lint` sauber.
- Commits: konventionelle Messages (`feat:`/`fix:`), ein Commit pro Task.

---

### Task 1: IMAP UID-Fix

**Files:**
- Modify: `src/services/airbnb-mail/imap-client.ts:58`
- Test: `src/services/airbnb-mail/imap-client.test.ts` (neu)

**Interfaces:**
- Consumes: `ImapFlow.fetch(range, query, options)` aus `imapflow`.
- Produces: unverändertes `fetchNewMails(sinceUid): Promise<RawMail[]>` — aber Range wird als UID-Range interpretiert.

**Kontext:** `client.fetch(searchRange, { uid: true, envelope: true, source: true })` übergibt `uid: true` nur als Query-Feld („UID im Ergebnis mitliefern"). Damit interpretiert ImapFlow `searchRange` als **Sequenznummern**. Sobald im Gmail-Label eine Mail gelöscht/umgelabelt wird, verschieben sich die Sequenznummern gegen die UIDs und Mails werden übersprungen (Produktion: UIDs 426, 431, 433, 438 verloren). Fix: drittes Argument `{ uid: true }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/airbnb-mail/imap-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchSpy = vi.fn(async function* () {
  // no messages
});

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    mailboxOpen: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    fetch: fetchSpy,
  })),
}));

import { AirbnbImapClient } from './imap-client.js';

describe('AirbnbImapClient.fetchNewMails', () => {
  beforeEach(() => fetchSpy.mockClear());

  it('passes {uid: true} as fetch OPTIONS so the range is a UID range', async () => {
    const client = new AirbnbImapClient({
      host: 'imap.example.com', port: 993, user: 'u', password: 'p', mailbox: 'Label',
    });
    await client.connect();
    await client.fetchNewMails(425);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [range, , options] = fetchSpy.mock.calls[0];
    expect(range).toBe('426:*');
    expect(options).toEqual({ uid: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/airbnb-mail/imap-client.test.ts`
Expected: FAIL — `options` ist `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `imap-client.ts` die fetch-Schleife ändern:

```typescript
    for await (const msg of this.client.fetch(
      searchRange,
      { uid: true, envelope: true, source: true },
      { uid: true }
    )) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/airbnb-mail/imap-client.test.ts` → PASS.
Run: `npm test` → alles grün.

- [ ] **Step 5: Commit**

```bash
git add src/services/airbnb-mail/imap-client.ts src/services/airbnb-mail/imap-client.test.ts
git commit -m "fix(airbnb-mail): fetch by UID range, not sequence numbers"
```

---

### Task 2: Migration 022 + Payout-Repository

**Files:**
- Create: `src/db/migrations/022_add_payout_tracking.sql`
- Create: `src/repositories/airbnb-payout-repository.ts`
- Test: `src/repositories/airbnb-payout-repository.test.ts`

**Interfaces:**
- Produces (von Task 5/6/7/8 genutzt):
  - `insertPayoutItems(items: PayoutItemRow[]): number` — INSERT OR IGNORE, gibt Anzahl neu eingefügter Zeilen zurück
  - `getPayoutSumByCode(reservationCode: string): { sum: number; count: number }`
  - `setReservationPayoutConfirmed(reservationCode: string, amount: number): void`
  - `setPayoutStatus(reservationCode: string, status: 'confirmed' | 'estimated'): void`
  - `updateReservationStay(reservationCode: string, checkInDate: string, checkOutDate: string): void` — Datumsanteil ersetzen, Zeitanteil aus Bestandswert erhalten, `nights_count` neu berechnen
  - `getEstimatedYearStats(listingId: string, year: number): { count: number; revenue: number }`
  - `getUnmatchedPayouts(listingId: string): Array<{ reservation_code: string | null; payout_date: string; amount: number }>`
  - `interface PayoutItemRow { message_id: string; listing_id: string; reservation_code: string; payout_date: string; amount: number; stay_start: string | null; stay_end: string | null; total_mail_amount: number; }`

- [ ] **Step 1: Migration schreiben**

```sql
-- src/db/migrations/022_add_payout_tracking.sql
-- Payout ground-truth tracking for the airbnb-mail provider.
-- payout_status: 'confirmed' = amount is exact (API providers, or matched payout mail),
--                'estimated' = computed from booking mail / iCal, awaiting payout mail.
ALTER TABLE reservations ADD COLUMN payout_status TEXT NOT NULL DEFAULT 'confirmed';

UPDATE reservations SET payout_status = 'estimated' WHERE platform = 'airbnb-mail';

CREATE TABLE IF NOT EXISTS airbnb_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  reservation_code TEXT,
  payout_date TEXT NOT NULL,
  amount REAL NOT NULL,
  stay_start TEXT,
  stay_end TEXT,
  total_mail_amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, reservation_code)
);

CREATE INDEX IF NOT EXISTS idx_airbnb_payouts_code ON airbnb_payouts(reservation_code);
```

- [ ] **Step 2: Failing Repo-Test schreiben** (Muster: `bi-report-queries.test.ts` — `new Database(':memory:')`, Mini-Schema, `setDatabase`)

```typescript
// src/repositories/airbnb-payout-repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  insertPayoutItems, getPayoutSumByCode, setReservationPayoutConfirmed,
  setPayoutStatus, updateReservationStay, getEstimatedYearStats, getUnmatchedPayouts,
} from './airbnb-payout-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY, reservation_id TEXT UNIQUE, listing_id TEXT,
      check_in TEXT, check_out TEXT, check_in_localized TEXT, check_out_localized TEXT,
      nights_count INTEGER, status TEXT, host_payout REAL, total_price REAL,
      platform TEXT, payout_status TEXT NOT NULL DEFAULT 'confirmed'
    );
    CREATE TABLE airbnb_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, listing_id TEXT NOT NULL,
      reservation_code TEXT, payout_date TEXT NOT NULL, amount REAL NOT NULL,
      stay_start TEXT, stay_end TEXT, total_mail_amount REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_id, reservation_code)
    );
  `);
  setDatabase(db);
});

afterEach(() => { resetDatabase(); db.close(); });

const item = (over: Partial<Record<string, unknown>> = {}) => ({
  message_id: 'm1', listing_id: 'L1', reservation_code: 'HMAAAA0001',
  payout_date: '2026-08-03', amount: 425.4, stay_start: '2026-08-02',
  stay_end: '2026-08-07', total_mail_amount: 425.4, ...over,
});

describe('insertPayoutItems / getPayoutSumByCode', () => {
  it('inserts items and sums per code', () => {
    expect(insertPayoutItems([item()])).toBe(1);
    expect(insertPayoutItems([item({ message_id: 'm2', amount: 72.48 })])).toBe(1);
    const { sum, count } = getPayoutSumByCode('HMAAAA0001');
    expect(sum).toBeCloseTo(497.88, 2);
    expect(count).toBe(2);
  });

  it('is idempotent on (message_id, reservation_code)', () => {
    insertPayoutItems([item()]);
    expect(insertPayoutItems([item({ amount: 999 })])).toBe(0);
    expect(getPayoutSumByCode('HMAAAA0001').sum).toBeCloseTo(425.4, 2);
  });
});

describe('reservation updates', () => {
  beforeEach(() => {
    db.prepare(`INSERT INTO reservations
      (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, host_payout, total_price, platform, payout_status)
      VALUES ('HMAAAA0001','L1','2026-08-02T15:00:00.000Z','2026-08-07T12:00:00.000Z','2026-08-02','2026-08-07',5,'confirmed',425.4,870,'airbnb-mail','estimated')`).run();
  });

  it('setReservationPayoutConfirmed writes amount + confirmed', () => {
    setReservationPayoutConfirmed('HMAAAA0001', 497.88);
    const row = db.prepare(`SELECT host_payout, payout_status FROM reservations WHERE reservation_id='HMAAAA0001'`).get() as { host_payout: number; payout_status: string };
    expect(row.host_payout).toBeCloseTo(497.88, 2);
    expect(row.payout_status).toBe('confirmed');
  });

  it('setPayoutStatus flips only the flag', () => {
    setPayoutStatus('HMAAAA0001', 'confirmed');
    const row = db.prepare(`SELECT host_payout, payout_status FROM reservations WHERE reservation_id='HMAAAA0001'`).get() as { host_payout: number; payout_status: string };
    expect(row.payout_status).toBe('confirmed');
    expect(row.host_payout).toBeCloseTo(425.4, 2);
  });

  it('updateReservationStay keeps the time-of-day and recomputes nights', () => {
    updateReservationStay('HMAAAA0001', '2026-08-02', '2026-08-08');
    const row = db.prepare(`SELECT check_in, check_out, check_in_localized, check_out_localized, nights_count FROM reservations WHERE reservation_id='HMAAAA0001'`).get() as Record<string, unknown>;
    expect(row.check_in).toBe('2026-08-02T15:00:00.000Z');
    expect(row.check_out).toBe('2026-08-08T12:00:00.000Z');
    expect(row.check_out_localized).toBe('2026-08-08');
    expect(row.nights_count).toBe(6);
  });
});

describe('report queries', () => {
  it('getEstimatedYearStats counts only estimated rows of the listing/year', () => {
    const ins = db.prepare(`INSERT INTO reservations (reservation_id, listing_id, check_in, nights_count, host_payout, total_price, payout_status) VALUES (?,?,?,?,?,?,?)`);
    ins.run('HMB1', 'L1', '2026-12-26T15:00:00.000Z', 4, 512.38, 1068, 'estimated');
    ins.run('HMB2', 'L1', '2026-07-01T15:00:00.000Z', 3, 300, 400, 'confirmed');
    ins.run('HMB3', 'L2', '2026-07-01T15:00:00.000Z', 3, 300, 400, 'estimated');
    ins.run('HMB4', 'L1', '2025-07-01T15:00:00.000Z', 3, 300, 400, 'estimated');
    const stats = getEstimatedYearStats('L1', 2026);
    expect(stats.count).toBe(1);
    expect(stats.revenue).toBeCloseTo(512.38, 2);
  });

  it('getUnmatchedPayouts returns payouts without a matching reservation', () => {
    insertPayoutItems([item({ reservation_code: 'HMNOMATCH1' })]);
    const rows = getUnmatchedPayouts('L1');
    expect(rows).toHaveLength(1);
    expect(rows[0].reservation_code).toBe('HMNOMATCH1');
  });
});
```

- [ ] **Step 3: Test laufen lassen** → FAIL (Modul existiert nicht).

- [ ] **Step 4: Repository implementieren**

```typescript
// src/repositories/airbnb-payout-repository.ts
/**
 * Airbnb Payout Repository
 *
 * Ground-truth payout amounts parsed from Airbnb payout mails, plus the
 * payout_status flag on reservations ('confirmed' = exact, 'estimated' =
 * derived from booking mail or iCal, awaiting a payout mail).
 *
 * Deliberately NOT part of the Reservation TS model: payout_status is only
 * written here so Guesty/Hostex code paths stay untouched.
 */
import { getDatabase } from '../db/index.js';

export interface PayoutItemRow {
  message_id: string;
  listing_id: string;
  reservation_code: string;
  payout_date: string;        // YYYY-MM-DD
  amount: number;             // net contribution of this mail to this reservation
  stay_start: string | null;  // YYYY-MM-DD from the payout line items
  stay_end: string | null;    // YYYY-MM-DD (check-out date as printed)
  total_mail_amount: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function insertPayoutItems(items: PayoutItemRow[]): number {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO airbnb_payouts
      (message_id, listing_id, reservation_code, payout_date, amount, stay_start, stay_end, total_mail_amount)
    VALUES (@message_id, @listing_id, @reservation_code, @payout_date, @amount, @stay_start, @stay_end, @total_mail_amount)
  `);
  let inserted = 0;
  for (const it of items) inserted += stmt.run(it).changes;
  return inserted;
}

export function getPayoutSumByCode(reservationCode: string): { sum: number; count: number } {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS sum, COUNT(*) AS count FROM airbnb_payouts WHERE reservation_code = ?`
  ).get(reservationCode) as { sum: number; count: number };
  return { sum: r2(row.sum), count: row.count };
}

export function setReservationPayoutConfirmed(reservationCode: string, amount: number): void {
  getDatabase().prepare(
    `UPDATE reservations SET host_payout = ?, payout_status = 'confirmed' WHERE reservation_id = ?`
  ).run(r2(amount), reservationCode);
}

export function setPayoutStatus(reservationCode: string, status: 'confirmed' | 'estimated'): void {
  getDatabase().prepare(
    `UPDATE reservations SET payout_status = ? WHERE reservation_id = ?`
  ).run(status, reservationCode);
}

/**
 * Replace the DATE part of check_in/check_out, keep the stored time-of-day,
 * recompute nights_count. Used when payout mails / iCal report changed dates.
 */
export function updateReservationStay(reservationCode: string, checkInDate: string, checkOutDate: string): void {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT check_in, check_out FROM reservations WHERE reservation_id = ?`
  ).get(reservationCode) as { check_in: string; check_out: string } | undefined;
  if (!row) return;
  const timePart = (iso: string, fallback: string) => (iso && iso.includes('T') ? iso.slice(10) : fallback);
  const nights = Math.round(
    (Date.parse(`${checkOutDate}T00:00:00Z`) - Date.parse(`${checkInDate}T00:00:00Z`)) / 86_400_000
  );
  db.prepare(`
    UPDATE reservations SET
      check_in = ?, check_out = ?, check_in_localized = ?, check_out_localized = ?, nights_count = ?
    WHERE reservation_id = ?
  `).run(
    `${checkInDate}${timePart(row.check_in, 'T15:00:00.000Z')}`,
    `${checkOutDate}${timePart(row.check_out, 'T12:00:00.000Z')}`,
    checkInDate, checkOutDate, nights, reservationCode
  );
}

export function getEstimatedYearStats(listingId: string, year: number): { count: number; revenue: number } {
  const row = getDatabase().prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(host_payout, total_price, 0)), 0) AS revenue
    FROM reservations
    WHERE listing_id = ? AND payout_status = 'estimated' AND check_in >= ? AND check_in < ?
  `).get(listingId, `${year}-01-01`, `${year + 1}-01-01`) as { count: number; revenue: number };
  return { count: row.count, revenue: r2(row.revenue) };
}

export function getUnmatchedPayouts(listingId: string): Array<{ reservation_code: string | null; payout_date: string; amount: number }> {
  return getDatabase().prepare(`
    SELECT p.reservation_code, p.payout_date, p.amount
    FROM airbnb_payouts p
    LEFT JOIN reservations r ON r.reservation_id = p.reservation_code
    WHERE p.listing_id = ? AND r.id IS NULL
    ORDER BY p.payout_date
  `).all(listingId) as Array<{ reservation_code: string | null; payout_date: string; amount: number }>;
}
```

- [ ] **Step 5: Tests laufen lassen** → PASS. Danach `npm test` komplett.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/022_add_payout_tracking.sql src/repositories/airbnb-payout-repository.ts src/repositories/airbnb-payout-repository.test.ts
git commit -m "feat(airbnb-mail): payout tracking schema + repository"
```

---

### Task 3: Mail-Typ-Erkennung erweitern ('payout' + breitere modification) + geteilter Body-Text-Helper

**Files:**
- Modify: `src/types/airbnb-mail.ts` (Union + neues Interface)
- Modify: `src/parsers/airbnb-mail/index.ts`
- Create: `src/parsers/airbnb-mail/body-text.ts`
- Modify: `src/parsers/airbnb-mail/confirmed-booking.ts` (lokales `getBodyText` durch Import ersetzen)
- Test: `src/parsers/airbnb-mail/index.test.ts` (erweitern), `src/parsers/airbnb-mail/body-text.test.ts`

**Interfaces:**
- Produces:
  - `AirbnbMailType` erweitert um `'payout'`
  - `detectMailType('Wir haben eine Auszahlung in Höhe von 425,40 € EUR gesendet')` → `'payout'`
  - `detectMailType('Buchung aktualisiert')` → `'modification'`; `detectMailType('Puneet möchte die Buchung ändern')` → `'modification'`
  - `getBodyText(raw: RawMail): string` aus `body-text.ts` (HTML → Text, Whitespace kollabiert; entfernt `<style>`/`<script>`)

- [ ] **Step 1: Failing Tests ergänzen** in `index.test.ts`:

```typescript
  it('classifies payout mails', () => {
    expect(detectMailType('Wir haben eine Auszahlung in Höhe von 425,40 € EUR gesendet')).toBe('payout');
    expect(detectMailType('Wir haben eine Auszahlung in Höhe von 1.068,00 € EUR gesendet')).toBe('payout');
  });

  it('classifies real alteration subjects as modification', () => {
    expect(detectMailType('Buchung aktualisiert')).toBe('modification');
    expect(detectMailType('Puneet möchte die Buchung ändern')).toBe('modification');
    expect(detectMailType('Deine Buchungsänderung wurde bestätigt')).toBe('modification');
  });
```

Und neuer Test `body-text.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getBodyText } from './body-text.js';
import type { RawMail } from '../../types/airbnb-mail.js';

const raw = (over: Partial<RawMail>): RawMail => ({
  uid: 1, messageId: 'x', subject: 's', fromAddress: 'f',
  receivedAt: '2026-08-03T11:28:28.000Z', htmlBody: '', textBody: '', ...over,
});

describe('getBodyText', () => {
  it('strips tags and styles, collapses whitespace', () => {
    const text = getBodyText(raw({
      htmlBody: '<html><head><style>.x{color:red}</style></head><body><p>425,40&nbsp;€  EUR</p>\n<div>wurden   versendet</div></body></html>',
    }));
    expect(text).toBe('425,40 € EUR wurden versendet');
  });

  it('falls back to textBody', () => {
    expect(getBodyText(raw({ textBody: ' a  b ' }))).toBe('a b');
  });
});
```

- [ ] **Step 2: Tests laufen lassen** → FAIL.

- [ ] **Step 3: Implementieren**

`body-text.ts` (Logik 1:1 aus `confirmed-booking.ts` extrahieren):

```typescript
/**
 * Shared HTML→flat-text extraction for Airbnb mail parsers.
 */
import * as cheerio from 'cheerio';
import type { RawMail } from '../../types/airbnb-mail.js';

export function getBodyText(raw: RawMail): string {
  if (raw.htmlBody && raw.htmlBody.length > 0) {
    const $ = cheerio.load(raw.htmlBody);
    $('style,script').remove();
    return $('body').text().replace(/\s+/g, ' ').trim();
  }
  if (raw.textBody) return raw.textBody.replace(/\s+/g, ' ').trim();
  return '';
}
```

`index.ts`: Union-Reihenfolge beachten — `payout` VOR `cancellation` prüfen (kein Konflikt, aber deterministisch halten):

```typescript
// "Wir haben eine Auszahlung in Höhe von 425,40 € EUR gesendet"
const PAYOUT_RE = /^Wir haben eine Auszahlung in H[öo]he von\s*[\d.,]+\s*€/i;

// "Deine Buchungsänderung wurde bestätigt" | "Buchung aktualisiert" |
// "{Gast} möchte die Buchung ändern" — all alteration-related notifications.
const MODIFICATION_RE =
  /^Deine\s+Buchungs[äa]nderung\s+wurde\s+best[äa]tigt|^Buchung\s+aktualisiert|m[öo]chte\s+die\s+Buchung\s+[äa]ndern/i;

export function detectMailType(subject: string): AirbnbMailType {
  if (!subject) return 'unknown';
  if (PAYOUT_RE.test(subject)) return 'payout';
  if (CANCELLATION_RE.test(subject)) return 'cancellation';
  if (MODIFICATION_RE.test(subject)) return 'modification';
  if (CONFIRMED_RE.test(subject)) return 'confirmed';
  if (INQUIRY_RE.test(subject)) return 'inquiry';
  return 'unknown';
}
```

`types/airbnb-mail.ts`: `'payout'` in die Union aufnehmen. ACHTUNG: `ParsedAirbnbMail.type` ist `Exclude<AirbnbMailType, 'unknown'>` — nach der Erweiterung `Exclude<AirbnbMailType, 'unknown' | 'payout'>` setzen, damit die bestehenden Parser-Typen unverändert bleiben (Payout hat in Task 4 ein eigenes Interface).

`confirmed-booking.ts`: lokales `getBodyText` löschen, `import { getBodyText } from './body-text.js';`.

In `sync-mail.ts` kompiliert der `switch` weiter (Task 5 behandelt 'payout' explizit; bis dahin fällt 'payout' in `dispatchParser` auf `default: null` — das ist für diesen Zwischenstand ok, `mapAirbnbReservation`'s `STATUS_MAP_INQUIRY`/`ACTIVE_TYPES` referenzieren nur `ParsedAirbnbMail['type']`, das 'payout' ausschließt).

- [ ] **Step 4: Tests laufen lassen** → PASS (inkl. bestehender confirmed-booking-Tests). `npm test` komplett.

- [ ] **Step 5: Commit**

```bash
git add src/types/airbnb-mail.ts src/parsers/airbnb-mail/index.ts src/parsers/airbnb-mail/index.test.ts src/parsers/airbnb-mail/body-text.ts src/parsers/airbnb-mail/body-text.test.ts src/parsers/airbnb-mail/confirmed-booking.ts
git commit -m "feat(airbnb-mail): detect payout + real alteration subjects, shared body-text helper"
```

---

### Task 4: Payout-Parser

**Files:**
- Create: `src/parsers/airbnb-mail/payout.ts`
- Test: `src/parsers/airbnb-mail/payout.test.ts`

**Interfaces:**
- Consumes: `getBodyText` (Task 3), `RawMail`.
- Produces:

```typescript
export interface ParsedPayoutItem {
  amount: number;            // signed, e.g. -31.5
  category: string;          // "Unterkunft", "Steuereinbehalt bei Einkünften in Italien", …
  stayStart: string;         // YYYY-MM-DD
  stayEnd: string;           // YYYY-MM-DD
  listingId: string;         // numeric Airbnb listing id from "( … )"
  reservationCode: string;   // HM… code
}
export interface ParsedPayoutMail {
  totalAmount: number;       // from Subject
  payoutDate: string;        // YYYY-MM-DD from receivedAt
  items: ParsedPayoutItem[];
  messageId: string;
}
export function parsePayoutMail(raw: RawMail): ParsedPayoutMail | null;
```

**Kontext — reale Body-Struktur** (Produktion, nach HTML→Text-Kollaps; Fixture so nachbauen):

```
… Details Egbert Witteveen -31,50 € EUR Steuereinbehalt bei Einkünften in Italien • 2.8.2026 - 8.8.2026 Elegance & Design Duplex - Manifattura Tabacchi (1678837365136764301) HME9WZFQTY Egbert Witteveen -18,35 € EUR Auszahlung an Co-Gastgeber:innen • 2.8.2026 - 8.8.2026 … (1678837365136764301) HME9WZFQTY Egbert Witteveen 122,33 € EUR Unterkunft • 2.8.2026 - 8.8.2026 … (1678837365136764301) HME9WZFQTY Gesamtbetrag der Auszahlung: 72,48 € EUR …
```

- [ ] **Step 1: Failing Test schreiben** (Inline-Fixture nach obigem Muster; zweiter Fall = einzelne Buchung 425,40)

```typescript
// src/parsers/airbnb-mail/payout.test.ts
import { describe, it, expect } from 'vitest';
import { parsePayoutMail } from './payout.js';
import type { RawMail } from '../../types/airbnb-mail.js';

const topUpMail: RawMail = {
  uid: 10, messageId: 'payout-1@airbnb.com',
  subject: 'Wir haben eine Auszahlung in Höhe von 72,48 € EUR gesendet',
  fromAddress: 'express@airbnb.com',
  receivedAt: '2026-08-03T13:52:27.000Z',
  htmlBody: '',
  textBody:
    '72,48 € EUR wurden heute versendet Deine Auszahlung wurde am 3. August versendet' +
    ' Bankkonto Christian Henschel, IBAN 7706 (EUR) ID des Airbnb-Kontos 1678835943572371700 Details' +
    ' Egbert Witteveen -31,50 € EUR Steuereinbehalt bei Einkünften in Italien • 2.8.2026 - 8.8.2026' +
    ' Elegance & Design Duplex - Manifattura Tabacchi (1678837365136764301) HME9WZFQTY' +
    ' Egbert Witteveen -18,35 € EUR Auszahlung an Co-Gastgeber:innen • 2.8.2026 - 8.8.2026' +
    ' Elegance & Design Duplex - Manifattura Tabacchi (1678837365136764301) HME9WZFQTY' +
    ' Egbert Witteveen 122,33 € EUR Unterkunft • 2.8.2026 - 8.8.2026' +
    ' Elegance & Design Duplex - Manifattura Tabacchi (1678837365136764301) HME9WZFQTY' +
    ' Gesamtbetrag der Auszahlung: 72,48 € EUR',
};

describe('parsePayoutMail', () => {
  it('parses total from subject and payout date from receivedAt', () => {
    const out = parsePayoutMail(topUpMail);
    expect(out?.totalAmount).toBeCloseTo(72.48, 2);
    expect(out?.payoutDate).toBe('2026-08-03');
  });

  it('parses all line items with code, listing, stay dates and signed amounts', () => {
    const out = parsePayoutMail(topUpMail);
    expect(out?.items).toHaveLength(3);
    expect(out?.items[0]).toEqual({
      amount: -31.5,
      category: 'Steuereinbehalt bei Einkünften in Italien',
      stayStart: '2026-08-02',
      stayEnd: '2026-08-08',
      listingId: '1678837365136764301',
      reservationCode: 'HME9WZFQTY',
    });
    const sum = out!.items.reduce((a, i) => a + i.amount, 0);
    expect(sum).toBeCloseTo(72.48, 2);
  });

  it('parses thousands amounts ("1.068,00")', () => {
    const mail: RawMail = {
      ...topUpMail,
      subject: 'Wir haben eine Auszahlung in Höhe von 1.068,00 € EUR gesendet',
    };
    expect(parsePayoutMail(mail)?.totalAmount).toBeCloseTo(1068, 2);
  });

  it('returns null when subject does not match', () => {
    expect(parsePayoutMail({ ...topUpMail, subject: 'Buchung aktualisiert' })).toBeNull();
  });
});
```

- [ ] **Step 2: Test laufen lassen** → FAIL.

- [ ] **Step 3: Implementieren**

```typescript
// src/parsers/airbnb-mail/payout.ts
/**
 * Airbnb Payout-Mail Parser
 *
 * "Wir haben eine Auszahlung in Höhe von X € EUR gesendet" — the body lists
 * line items per reservation: amount, category, stay dates, listing id, HM-code.
 * These amounts are the ground truth for what Airbnb actually transferred
 * (net of co-host share and Italian withholding), unlike the booking-mail
 * estimate. Calibrated against live Firenze payout mail (Aug 2026).
 */
import { getBodyText } from './body-text.js';
import type { RawMail } from '../../types/airbnb-mail.js';

export interface ParsedPayoutItem {
  amount: number;
  category: string;
  stayStart: string;
  stayEnd: string;
  listingId: string;
  reservationCode: string;
}

export interface ParsedPayoutMail {
  totalAmount: number;
  payoutDate: string;
  items: ParsedPayoutItem[];
  messageId: string;
}

const SUBJECT_TOTAL_RE = /^Wir haben eine Auszahlung in H[öo]he von\s*([\d.,]+)\s*€/i;

// "-31,50 € EUR Steuereinbehalt bei Einkünften in Italien • 2.8.2026 - 8.8.2026 … (1678837365136764301) HME9WZFQTY"
const ITEM_RE =
  /(-?[\d.,]+)\s*€\s*EUR\s+(.+?)\s*•\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*-\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s+[^()]*\((\d{10,25})\)\s*(HM[A-Z0-9]{8})/g;

function parseGermanAmount(s: string): number {
  return parseFloat(s.replace(/\./g, '').replace(',', '.'));
}

const iso = (y: string, m: string, d: string) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;

export function parsePayoutMail(raw: RawMail): ParsedPayoutMail | null {
  const subjectMatch = raw.subject.match(SUBJECT_TOTAL_RE);
  if (!subjectMatch) return null;

  const body = getBodyText(raw);
  const items: ParsedPayoutItem[] = [];
  for (const m of body.matchAll(ITEM_RE)) {
    items.push({
      amount: parseGermanAmount(m[1]),
      category: m[2].trim(),
      stayStart: iso(m[5], m[4], m[3]),
      stayEnd: iso(m[8], m[7], m[6]),
      listingId: m[9],
      reservationCode: m[10],
    });
  }

  return {
    totalAmount: parseGermanAmount(subjectMatch[1]),
    payoutDate: raw.receivedAt.slice(0, 10),
    items,
    messageId: raw.messageId,
  };
}
```

Hinweis für die Item-Regex: `(.+?)` für die Kategorie frisst rückwärts auch den Gastnamen des Items NICHT, weil das Match beim Betrag beginnt — der Gastname steht VOR dem Betrag und bleibt außerhalb. Genau so gewollt (Name kommt aus der Reservierung).

- [ ] **Step 4: Tests laufen lassen** → PASS. `npm test` komplett.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/airbnb-mail/payout.ts src/parsers/airbnb-mail/payout.test.ts
git commit -m "feat(airbnb-mail): parse payout mails (ground-truth amounts per reservation)"
```

---

### Task 5: Payout-Applier + sync-mail-Integration

**Files:**
- Create: `src/services/airbnb-mail/payout-applier.ts`
- Modify: `src/jobs/airbnb-mail/sync-mail.ts`
- Test: `src/services/airbnb-mail/payout-applier.test.ts`

**Interfaces:**
- Consumes: `ParsedPayoutMail` (Task 4), Repo-Funktionen (Task 2), `getReservationById` aus `reservation-repository.ts`.
- Produces:

```typescript
export interface ApplyPayoutResult {
  matchedCodes: string[];    // reservation existed, amount confirmed
  unmatchedCodes: string[];  // no reservation row (yet) — items stored anyway
  dateCorrections: string[]; // codes whose stay dates were updated from payout items
}
export function applyPayout(parsed: ParsedPayoutMail): ApplyPayoutResult;
```

**Verhalten:**
1. Items nach `reservationCode` gruppieren; Beitrag = Summe der Item-Beträge (gerundet).
2. `insertPayoutItems` (idempotent über `(message_id, reservation_code)`).
3. Pro Code: `getReservationById(code)`:
   - **existiert** → `setReservationPayoutConfirmed(code, getPayoutSumByCode(code).sum)`. Zusätzlich: weichen `stayStart/stayEnd` der Items von `check_in_localized`/`check_out_localized` ab → `updateReservationStay(code, stayStart, stayEnd)` und Code in `dateCorrections` aufnehmen (Fall Egbert: Payout-Items tragen die FINALEN Daten 2.8.–8.8.).
   - **existiert nicht** → nur `unmatchedCodes` (Reconcile in Task 6 legt ggf. den Platzhalter an und adoptiert die Summe).

- [ ] **Step 1: Failing Test schreiben**

```typescript
// src/services/airbnb-mail/payout-applier.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../../db/index.js';
import { applyPayout } from './payout-applier.js';
import type { ParsedPayoutMail } from '../../parsers/airbnb-mail/payout.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reservations (
      id INTEGER PRIMARY KEY, reservation_id TEXT UNIQUE, listing_id TEXT,
      check_in TEXT, check_out TEXT, check_in_localized TEXT, check_out_localized TEXT,
      nights_count INTEGER, status TEXT, host_payout REAL, total_price REAL,
      platform TEXT, payout_status TEXT NOT NULL DEFAULT 'confirmed'
    );
    CREATE TABLE airbnb_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, listing_id TEXT NOT NULL,
      reservation_code TEXT, payout_date TEXT NOT NULL, amount REAL NOT NULL,
      stay_start TEXT, stay_end TEXT, total_mail_amount REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_id, reservation_code)
    );
  `);
  setDatabase(db);
  db.prepare(`INSERT INTO reservations
    (reservation_id, listing_id, check_in, check_out, check_in_localized, check_out_localized, nights_count, status, host_payout, total_price, platform, payout_status)
    VALUES ('HME9WZFQTY','L1','2026-08-02T15:00:00.000Z','2026-08-07T12:00:00.000Z','2026-08-02','2026-08-07',5,'confirmed',425.4,870,'airbnb-mail','estimated')`).run();
});

afterEach(() => { resetDatabase(); db.close(); });

const mail = (messageId: string, items: Array<{ amount: number; stayEnd?: string }>): ParsedPayoutMail => ({
  totalAmount: items.reduce((a, i) => a + i.amount, 0),
  payoutDate: '2026-08-03',
  messageId,
  items: items.map((i) => ({
    amount: i.amount, category: 'Unterkunft',
    stayStart: '2026-08-02', stayEnd: i.stayEnd ?? '2026-08-07',
    listingId: 'L1', reservationCode: 'HME9WZFQTY',
  })),
});

describe('applyPayout', () => {
  it('confirms amount as sum of all payout mails for the code', () => {
    const r1 = applyPayout(mail('m1', [{ amount: 425.4 }]));
    expect(r1.matchedCodes).toEqual(['HME9WZFQTY']);
    const r2 = applyPayout(mail('m2', [{ amount: 72.48, stayEnd: '2026-08-08' }]));
    expect(r2.matchedCodes).toEqual(['HME9WZFQTY']);
    const row = db.prepare(`SELECT host_payout, payout_status, check_out_localized, nights_count FROM reservations WHERE reservation_id='HME9WZFQTY'`).get() as Record<string, unknown>;
    expect(row.host_payout).toBeCloseTo(497.88, 2);
    expect(row.payout_status).toBe('confirmed');
    expect(row.check_out_localized).toBe('2026-08-08'); // date correction from payout item
    expect(row.nights_count).toBe(6);
    expect(r2.dateCorrections).toEqual(['HME9WZFQTY']);
  });

  it('is idempotent when the same mail is applied twice', () => {
    applyPayout(mail('m1', [{ amount: 425.4 }]));
    applyPayout(mail('m1', [{ amount: 425.4 }]));
    const row = db.prepare(`SELECT host_payout FROM reservations WHERE reservation_id='HME9WZFQTY'`).get() as { host_payout: number };
    expect(row.host_payout).toBeCloseTo(425.4, 2);
  });

  it('stores unmatched codes without touching reservations', () => {
    const m: ParsedPayoutMail = {
      totalAmount: 100, payoutDate: '2026-09-18', messageId: 'm9',
      items: [{ amount: 100, category: 'Unterkunft', stayStart: '2026-09-17', stayEnd: '2026-09-22', listingId: 'L1', reservationCode: 'HMRONY00001' }],
    };
    const r = applyPayout(m);
    expect(r.unmatchedCodes).toEqual(['HMRONY00001']);
    expect(db.prepare(`SELECT COUNT(*) c FROM airbnb_payouts WHERE reservation_code='HMRONY00001'`).get()).toEqual({ c: 1 });
  });
});
```

- [ ] **Step 2: Test laufen lassen** → FAIL.

- [ ] **Step 3: Implementieren**

```typescript
// src/services/airbnb-mail/payout-applier.ts
/**
 * Applies a parsed Airbnb payout mail to the database: stores per-reservation
 * contributions (idempotent) and updates reservations with the ground-truth
 * payout sum. Payout line items carry the FINAL stay dates, so they also
 * correct date drift for altered bookings (incl. past stays iCal can't see).
 */
import {
  insertPayoutItems, getPayoutSumByCode, setReservationPayoutConfirmed, updateReservationStay,
} from '../../repositories/airbnb-payout-repository.js';
import { getReservationById } from '../../repositories/reservation-repository.js';
import type { ParsedPayoutMail } from '../../parsers/airbnb-mail/payout.js';
import logger from '../../utils/logger.js';

export interface ApplyPayoutResult {
  matchedCodes: string[];
  unmatchedCodes: string[];
  dateCorrections: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function applyPayout(parsed: ParsedPayoutMail): ApplyPayoutResult {
  const byCode = new Map<string, { amount: number; listingId: string; stayStart: string; stayEnd: string }>();
  for (const item of parsed.items) {
    const cur = byCode.get(item.reservationCode);
    if (cur) {
      cur.amount = r2(cur.amount + item.amount);
    } else {
      byCode.set(item.reservationCode, {
        amount: item.amount, listingId: item.listingId,
        stayStart: item.stayStart, stayEnd: item.stayEnd,
      });
    }
  }

  insertPayoutItems(
    Array.from(byCode.entries()).map(([code, v]) => ({
      message_id: parsed.messageId,
      listing_id: v.listingId,
      reservation_code: code,
      payout_date: parsed.payoutDate,
      amount: v.amount,
      stay_start: v.stayStart,
      stay_end: v.stayEnd,
      total_mail_amount: parsed.totalAmount,
    }))
  );

  const result: ApplyPayoutResult = { matchedCodes: [], unmatchedCodes: [], dateCorrections: [] };

  for (const [code, v] of byCode) {
    const reservation = getReservationById(code);
    if (!reservation) {
      result.unmatchedCodes.push(code);
      logger.warn({ code, amount: v.amount }, 'Payout mail references unknown reservation — stored for later adoption');
      continue;
    }
    if (
      reservation.check_in_localized !== v.stayStart ||
      reservation.check_out_localized !== v.stayEnd
    ) {
      updateReservationStay(code, v.stayStart, v.stayEnd);
      result.dateCorrections.push(code);
    }
    setReservationPayoutConfirmed(code, getPayoutSumByCode(code).sum);
    result.matchedCodes.push(code);
  }
  return result;
}
```

**sync-mail.ts integrieren** — nach dem `modification`-Block, vor `dispatchParser`:

```typescript
        if (type === 'payout') {
          const payout = parsePayoutMail(raw);
          if (!payout) {
            updateParseStatus(raw.messageId, 'error', 'Payout parser returned null', null, type);
            parsedError++;
          } else {
            const applied = applyPayout(payout);
            updateParseStatus(
              raw.messageId, 'ok', null,
              applied.matchedCodes[0] ?? applied.unmatchedCodes[0] ?? null, type
            );
            parsedOk++;
            logger.info({ slug, ...applied, total: payout.totalAmount }, 'Airbnb mail: payout applied');
          }
          continue;
        }
```

Imports ergänzen: `parsePayoutMail` aus `../../parsers/airbnb-mail/payout.js`, `applyPayout` aus `../../services/airbnb-mail/payout-applier.js`. Außerdem den `modification`-Kommentar aktualisieren: iCal-Reconciliation (Task 6) übernimmt Datumsabgleich, Payout-Mails die Beträge.

- [ ] **Step 4: Tests laufen lassen** → PASS. `npm test` + `npm run build` (Typen!).

- [ ] **Step 5: Commit**

```bash
git add src/services/airbnb-mail/payout-applier.ts src/services/airbnb-mail/payout-applier.test.ts src/jobs/airbnb-mail/sync-mail.ts
git commit -m "feat(airbnb-mail): apply payout mails as ground truth (amounts + final stay dates)"
```

---

### Task 6: iCal-Reconciliation + ETL-Integration

**Files:**
- Create: `src/jobs/airbnb-mail/reconcile-ical.ts`
- Modify: `src/jobs/airbnb-mail/sync-ical.ts` (kein Funktionsänderung nötig — Reconcile liest `availability`)
- Modify: `src/jobs/etl-job.ts` (Step 4 nach iCal-Sync)
- Test: `src/jobs/airbnb-mail/reconcile-ical.test.ts`

**Interfaces:**
- Consumes: `availability`-Zeilen (`block_type='reservation'`, `block_ref` = Reservierungscode — von `buildAvailabilityRows` bereits geschrieben), `getReservationById`, Repo-Funktionen aus Task 2, `computeEffectivePayout` aus `src/utils/airbnb-payout.ts`, `getListingById` aus `listings-repository.ts`.
- Produces:

```typescript
export interface ReconcileResult {
  updated: string[];        // codes with corrected dates
  created: string[];        // placeholder reservations created from iCal
  missingInIcal: string[];  // future mail-based reservations absent from the calendar
}
export function reconcileAirbnbReservations(
  property: PropertyConfig, todayStr?: string  // default: heute als YYYY-MM-DD
): ReconcileResult;
export function findReservationsMissingInIcal(listingId: string, todayStr: string): string[];
```

**Verhalten:**
1. Belegungsintervalle bauen: `SELECT date, block_ref FROM availability WHERE listing_id = ? AND block_type = 'reservation' AND status = 'booked' ORDER BY date` → aufeinanderfolgende Tage mit gleichem `block_ref` zu `{ code, start, endExclusive }` gruppieren (endExclusive = letzter Tag + 1 = Check-out-Datum). Lücken oder Ref-Wechsel beenden ein Intervall.
2. Pro Intervall:
   - **Reservierung existiert:** Zieldaten bestimmen — `newCheckIn = intervalStart` nur wenn bestehendes `check_in_localized >= todayStr` (bei laufenden Aufenthalten sind vergangene Nächte aus der availability gepruned — Check-in dann NICHT anfassen); `newCheckOut = intervalEndExclusive` immer. Weichen Zieldaten von `check_in_localized`/`check_out_localized` ab → `updateReservationStay`; falls `getPayoutSumByCode(code).count === 0` zusätzlich `setPayoutStatus(code, 'estimated')` und `host_payout` proportional skalieren: `neuerWert = r2(alter host_payout / alte nights * neue nights)` (direktes UPDATE über neues Repo-Statement `scaleReservationPayout(code, factor)` — ODER einfacher: nach `updateReservationStay` per SQL `UPDATE reservations SET host_payout = ROUND(host_payout * ?.0 / ?, 2) WHERE reservation_id = ?` mit (neueNights, alteNights)). Code in `updated`.
   - **Reservierung fehlt:** Platzhalter anlegen via `upsertReservation` (aus `reservation-repository.ts`) mit: `reservation_id = code`, `guest_name = 'Airbnb-Gast (aus Kalender)'`, `source = 'airbnb'`, `platform = 'airbnb-ical'`, `status = 'confirmed'`, Zeiten aus `property.googleCalendar?.checkInTime ?? '15:00'` / `checkOutTime ?? '12:00'` (gleiches Muster wie `sync-mail.ts`), `nights = endExclusive - start` (Tagesdifferenz), Preisschätzung: `basePrice = getListingById(listingId)?.base_price ?? 0`; `brutto = nights * basePrice + (property.static?.cleaningFee ?? 0)`; `host_payout = computeEffectivePayout({ hostPayoutBrutto: brutto, cleaningFee: property.static?.cleaningFee, totalPrice: brutto, occupancyTax: 0 }, { coHostShareRate: property.static?.coHostShareRate, incomeTaxRate: property.static?.incomeTaxRate }).hostPayoutEffective`; `total_price = brutto`. Danach: hat `getPayoutSumByCode(code)` bereits Einträge (Payout kam vor der Reconciliation) → `setReservationPayoutConfirmed(code, sum)`, sonst `setPayoutStatus(code, 'estimated')`. Code in `created`. Übrige Pflichtfelder des `Reservation`-Typs wie in `reservation-mapper.ts` (`guest_id: null`, `currency: 'EUR'`, `created_at_guesty`/`reserved_at`/`last_synced_at = new Date().toISOString()`, Zähler-Felder `null`, `confirmation_code = code`, `balance_due/total_paid/planned_* = null`, `internal_guest_id/guest_company = null`).
3. `findReservationsMissingInIcal`: `SELECT reservation_id FROM reservations WHERE listing_id = ? AND platform IN ('airbnb-mail','airbnb-ical') AND check_in_localized >= ? AND status = 'confirmed'` minus die Intervall-Codes → nur zurückgeben/loggen (KEIN Löschen — Storno-Mails löschen weiterhin; das hier ist ein Warnsignal für den Report).
4. `reconcileAirbnbReservations` ruft intern beide Schritte; loggt das Result.

**ETL-Integration** in `etl-job.ts` (`runAirbnbMailETL`), nach Step 3:

```typescript
  // Step 4: reconcile reservations against the iCal calendar (dates + missing bookings)
  if (propertyResult.success && icalResult.success) {
    try {
      const recon = reconcileAirbnbReservations(property);
      logger.info({ propertySlug: slug, ...recon }, 'Airbnb iCal reconciliation done');
    } catch (error) {
      logger.error({ propertySlug: slug, error }, 'Airbnb iCal reconciliation failed');
    }
  }
```

- [ ] **Step 1: Failing Tests schreiben** — In-Memory-DB mit `reservations`, `availability`, `airbnb_payouts`, `listings` (Minimalspalten: `listing_id`, `base_price`); `PropertyConfig`-Stub als Objekt-Literal mit `slug`, `airbnbListingId`, `static: { cleaningFee: 130, coHostShareRate: 0.15, incomeTaxRate: 0.21 }`. Testfälle:

```typescript
// src/jobs/airbnb-mail/reconcile-ical.test.ts — Kerntests (Setup wie payout-applier.test.ts, plus:)
//  availability-Insert-Helper: ins Tage [start, endExclusive) mit block_ref/status/block_type.

it('corrects dates when the iCal block moved (Puneet case)', () => {
  // reservation 2026-12-26 → 2026-12-30 (4 nights, estimated, no payouts)
  // availability booked 2026-12-27 .. 2027-01-02 (block_ref HMZ82HRR38)
  const res = reconcileAirbnbReservations(prop, '2026-08-10');
  expect(res.updated).toEqual(['HMZ82HRR38']);
  // row now 2026-12-27 → 2027-01-03, 7 nights, host_payout scaled 512.38/4*7 = 896.67, payout_status 'estimated'
});

it('does not move check_in of an in-progress stay (past days pruned)', () => {
  // reservation 2026-08-09 → 2026-08-15; availability booked only 2026-08-10..2026-08-14 (today = 2026-08-10)
  const res = reconcileAirbnbReservations(prop, '2026-08-10');
  expect(res.updated).toEqual([]); // endExclusive 2026-08-15 matches stored check_out → no change
});

it('creates a placeholder for an iCal-only booking (Rony case) and marks it estimated', () => {
  // availability booked 2026-09-17..2026-09-21, block_ref HMRONY00001, no reservation row; listing base_price 250
  const res = reconcileAirbnbReservations(prop, '2026-08-10');
  expect(res.created).toEqual(['HMRONY00001']);
  // row exists: 5 nights, guest 'Airbnb-Gast (aus Kalender)', platform 'airbnb-ical', payout_status 'estimated',
  // total_price = 5*250+130 = 1380, host_payout = computeEffectivePayout(...) value — assert via direct recompute
});

it('adopts stored payouts when creating a placeholder', () => {
  // like above, but airbnb_payouts already has 100 € for HMRONY00001 → payout_status 'confirmed', host_payout 100
});

it('reports future mail-reservations missing from the calendar', () => {
  // reservation HMGONE00001 check_in 2026-10-01, no availability block
  const res = reconcileAirbnbReservations(prop, '2026-08-10');
  expect(res.missingInIcal).toEqual(['HMGONE00001']);
});
```

Die Tests müssen die vollständigen INSERTs enthalten (siehe Muster in Task 5); `upsertReservation` erwartet das komplette Spaltenset der echten Tabelle — deshalb im Test-Schema `reservations` mit ALLEN Spalten anlegen, die `upsertReservation` schreibt (Spaltenliste aus `reservation-repository.ts:16-84` übernehmen).

- [ ] **Step 2: Tests laufen lassen** → FAIL.

- [ ] **Step 3: `reconcile-ical.ts` implementieren** (Struktur oben; Intervall-Gruppierung als pure Funktion `groupBookedIntervals(rows: Array<{date: string; block_ref: string | null}>): Array<{code: string; start: string; endExclusive: string}>` mit eigenem Unit-Test im selben File-Test).

- [ ] **Step 4: ETL-Integration einbauen** (Code oben), `npm run build`.

- [ ] **Step 5: Tests laufen lassen** → PASS, `npm test` komplett.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/airbnb-mail/reconcile-ical.ts src/jobs/airbnb-mail/reconcile-ical.test.ts src/jobs/etl-job.ts
git commit -m "feat(airbnb-mail): reconcile reservations against iCal (date drift, missing bookings)"
```

---

### Task 7: Weekly-Report-Markierung

**Files:**
- Modify: `src/jobs/weekly-email.ts`
- Modify: `src/services/email-templates.ts`
- Test: `src/services/email-templates.test.ts` (erweitern, falls vorhanden — sonst neu anlegen)

**Interfaces:**
- Consumes: `getEstimatedYearStats(listingId, year)` (Task 2).
- Produces: `WeeklyEmailData` (Interface in `email-templates.ts`, um Zeile 122) erweitert um:

```typescript
  estimateInfo?: { count: number; revenue: number };  // reservations with unconfirmed payout amounts
```

**Verhalten:** `weekly-email.ts` befüllt `estimateInfo` nur für Properties mit `airbnbListingId` (Provider airbnb-mail): `getEstimatedYearStats(listingId, new Date().getFullYear())`; bei `count === 0` → `undefined`.

Template-Änderungen in `generateWeeklyEmail` (HTML + Text):
- Beim Revenue-Stat (`Revenue ${currentYearStats.year}`): wenn `estimateInfo` gesetzt, Wert mit `≈ `-Präfix rendern.
- Direkt unter dem Stats-Block, wenn `estimateInfo` gesetzt:

```html
<div style="margin-top: 8px; padding: 10px 14px; background: #fff8e1; border-left: 4px solid #f6a609; font-size: 13px;">
  ⚠️ ${estimateInfo.count} Buchung(en) mit geschätztem Betrag (zusammen ${formatCurrency(estimateInfo.revenue, currency)}) —
  Airbnb-Auszahlung noch nicht bestätigt. Werte korrigieren sich automatisch mit der Auszahlungs-Mail.
</div>
```

- Text-Variante analog: `⚠️ ${count} Buchung(en) mit geschätztem Betrag (${revenue}) — Auszahlung ausstehend.`

- [ ] **Step 1: Failing Test** — `generateWeeklyEmail` mit `estimateInfo: { count: 2, revenue: 1409.04 }` aufrufen; erwarten: HTML enthält `'≈'` und `'2 Buchung(en) mit geschätztem Betrag'`; ohne `estimateInfo` enthält es beides nicht. (Aufruf-Fixture: Minimal-`WeeklyEmailData` nach Interface — bestehende Pflichtfelder mit Dummywerten belegen, `currentYearStats: { year: 2026, total_bookings: 14, total_revenue: 7820.45, total_booked_days: 73 }`.)

- [ ] **Step 2: Test laufen lassen** → FAIL.

- [ ] **Step 3: Template + Job implementieren** (oben spezifiziert; in `weekly-email.ts` Import + Befüllung, Property-Weiche über `property.airbnbListingId != null`).

- [ ] **Step 4: Tests laufen lassen** → PASS, `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/weekly-email.ts src/services/email-templates.ts src/services/email-templates.test.ts
git commit -m "feat(reports): mark estimated payout amounts in weekly property email"
```

---

### Task 8: BI-Report-Markierung + Warnhinweise

**Files:**
- Modify: `src/types/bi-report.ts` (`PropertyKpi` + `BiReportModel`)
- Modify: `src/jobs/bi-email.ts`
- Modify: `src/services/bi-email-templates.ts`
- Test: `src/services/bi-email-templates.test.ts` (erweitern)

**Interfaces:**
- Consumes: `getEstimatedYearStats`, `getUnmatchedPayouts` (Task 2), `findReservationsMissingInIcal` (Task 6).
- Produces:

```typescript
// PropertyKpi ergänzen:
  estimatedCount: number;    // reservations in YTD stats with unconfirmed amounts (0 for API providers)
// BiReportModel ergänzen (top-level):
  dataWarnings: string[];    // human-readable warnings, e.g. unmatched payouts / bookings missing from calendar
```

**Verhalten in `bi-email.ts` (`buildBiReportModel`):**
- Pro Property mit `airbnbListingId`: `estimatedCount = getEstimatedYearStats(listingId, now.getFullYear()).count`; sonst `0`.
- `dataWarnings` sammeln:
  - `getUnmatchedPayouts(listingId)` → je Zeile `'${property.name}: Auszahlung ${amount} € vom ${payout_date} keiner Buchung zuordenbar (${reservation_code})'`
  - `findReservationsMissingInIcal(listingId, today)` → je Code `'${property.name}: Buchung ${code} fehlt im Airbnb-Kalender — prüfen (Storno?)'`

**Template (`bi-email-templates.ts`):**
- KPI-Tabellenzelle `revenueYtd` (Zeile ~96): bei `k.estimatedCount > 0` → `≈ `-Präfix.
- Unter der KPI-Tabelle Legende, wenn irgendein `estimatedCount > 0`: `≈ enthält geschätzte Beträge — Airbnb-Auszahlung noch nicht bestätigt`.
- Neuer Abschnitt „⚠️ Datenqualität" (nur wenn `dataWarnings.length > 0`), HTML-Liste + Text-Variante (Zeile ~264 im Text-Builder ergänzen).
- Auch der Portfolio-Umsatz (Zeile ~217) bekommt das `≈`-Präfix, wenn irgendeine Property Schätzwerte enthält.

- [ ] **Step 1: Failing Tests** in `bi-email-templates.test.ts`: Modell-Fixture (bestehende Test-Fixtures dort wiederverwenden) mit `kpis[0].estimatedCount = 1` und `dataWarnings: ['Urban Luxury Loft - Florence: Buchung HMGONE00001 fehlt im Airbnb-Kalender — prüfen (Storno?)']` → HTML enthält `'≈'`, `'Datenqualität'` und den Warntext; mit `estimatedCount: 0` überall + leeren Warnings → keins davon.

- [ ] **Step 2: Tests laufen lassen** → FAIL (Typfehler zuerst: `estimatedCount`/`dataWarnings` in Fixtures ergänzen).

- [ ] **Step 3: Implementieren** (Typen → Job → Template).

- [ ] **Step 4: Tests laufen lassen** → PASS, `npm test`, `npm run build`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/types/bi-report.ts src/jobs/bi-email.ts src/services/bi-email-templates.ts src/services/bi-email-templates.test.ts
git commit -m "feat(reports): estimate markers + data-quality warnings in BI portfolio email"
```

---

### Task 9: Backfill-Skript

**Files:**
- Create: `src/scripts/backfill-airbnb-payouts.ts`
- Test: kein eigener Testfile — das Skript komponiert ausschließlich getestete Bausteine; Verifikation erfolgt beim Deploy gegen die Produktions-DB (Runbook unten).

**Interfaces:**
- Consumes: `airbnb_mail_archive` (Spalten `message_id, imap_uid, subject, received_at, raw_body`), `parsePayoutMail`, `applyPayout`, `reconcileAirbnbReservations`, `updateParseStatus` aus `airbnb-mail-archive-repository.ts`, `getAllProperties`.

- [ ] **Step 1: Skript schreiben**

```typescript
// src/scripts/backfill-airbnb-payouts.ts
/**
 * One-off backfill: re-process archived Airbnb payout mails (previously
 * classified 'unknown'/ignored) and reconcile reservations against the iCal.
 *
 * Usage: npx tsx src/scripts/backfill-airbnb-payouts.ts
 */
import { getDatabase, initDatabase, runMigrations } from '../db/index.js';
import { getAllProperties } from '../config/properties.js';
import { parsePayoutMail } from '../parsers/airbnb-mail/payout.js';
import { applyPayout } from '../services/airbnb-mail/payout-applier.js';
import { reconcileAirbnbReservations } from '../jobs/airbnb-mail/reconcile-ical.js';
import { updateParseStatus } from '../repositories/airbnb-mail-archive-repository.js';

initDatabase();
runMigrations();
const db = getDatabase();

const rows = db.prepare(`
  SELECT message_id, imap_uid, subject, received_at, raw_body
  FROM airbnb_mail_archive
  WHERE subject LIKE 'Wir haben eine Auszahlung%'
  ORDER BY received_at
`).all() as Array<{ message_id: string; imap_uid: number; subject: string; received_at: string; raw_body: string }>;

console.log(`Found ${rows.length} archived payout mails`);

for (const row of rows) {
  const parsed = parsePayoutMail({
    uid: row.imap_uid, messageId: row.message_id, subject: row.subject,
    fromAddress: '', receivedAt: row.received_at,
    htmlBody: row.raw_body ?? '', textBody: '',
  });
  if (!parsed || parsed.items.length === 0) {
    console.log(`  ✗ ${row.received_at} ${row.subject} — parser returned ${parsed ? '0 items' : 'null'}`);
    continue;
  }
  const result = applyPayout(parsed);
  updateParseStatus(row.message_id, 'ok', null, result.matchedCodes[0] ?? null, 'payout');
  console.log(`  ✓ ${row.received_at} total=${parsed.totalAmount} matched=[${result.matchedCodes}] unmatched=[${result.unmatchedCodes}] dates=[${result.dateCorrections}]`);
}

for (const property of getAllProperties()) {
  if (!property.airbnbListingId || !property.airbnbIcalUrl) continue;
  const recon = reconcileAirbnbReservations(property);
  console.log(`Reconcile ${property.slug}: updated=[${recon.updated}] created=[${recon.created}] missingInIcal=[${recon.missingInIcal}]`);
}

console.log('Backfill done.');
```

Hinweis: `updateParseStatus`-Signatur vor Verwendung in `airbnb-mail-archive-repository.ts` prüfen und exakt übernehmen (Reihenfolge der Argumente wie in `sync-mail.ts`-Aufrufen).

- [ ] **Step 2: Build prüfen**

Run: `npm run build` → kompiliert ohne Fehler. `npm test` → grün.

- [ ] **Step 3: Lokal gegen Kopie testen (WICHTIG - nicht gegen Produktions-DB):**

```bash
scp deploy@labs.remoterepublic.com:/opt/guesty-calendar-app/data/calendar.db /tmp/calendar-copy.db
DATABASE_PATH=/tmp/calendar-copy.db npx tsx src/scripts/backfill-airbnb-payouts.ts
sqlite3 /tmp/calendar-copy.db "SELECT reservation_id, guest_name, check_in_localized, check_out_localized, nights_count, host_payout, payout_status FROM reservations WHERE listing_id='1678837365136764301' ORDER BY check_in;"
```

Erwartung (Verifikation gegen bekannte Fälle):
- `HMZ82HRR38` (Puneet): 2026-12-27 → 2027-01-03, 7 Nächte, payout_status 'estimated', host_payout ~896,67 (skaliert)
- `HME9WZFQTY` (Egbert): 2026-08-02 → 2026-08-08, 6 Nächte, host_payout 497,88, 'confirmed'
- `HMRONY…` (neuer Platzhalter): 2026-09-17 → 2026-09-22, 'Airbnb-Gast (aus Kalender)', 'estimated'
- Bestandsbuchungen mit Payout-Mail im Archiv (90 Tage): 'confirmed' mit exakten Beträgen (z. B. Iris 704,17)

(Der env-Var-Name für den DB-Pfad ist in `src/config/index.ts` zu verifizieren — `DATABASE_PATH` ggf. anpassen.)

- [ ] **Step 4: Commit**

```bash
git add src/scripts/backfill-airbnb-payouts.ts
git commit -m "feat(airbnb-mail): backfill script for archived payout mails + reconciliation"
```

---

## Deploy-Runbook (macht die Hauptsession, nicht der Implementierungs-Agent)

1. `git push` → auf Server `cd /opt/guesty-calendar-app && git pull && npm ci && npm run build`
2. DB-Backup: `cp data/calendar.db data/calendar.db.bak-$(date +%F)`
3. Migration läuft beim App-Start; Backfill: `npx tsx src/scripts/backfill-airbnb-payouts.ts` (bzw. dist-Variante)
4. `pm2 restart guesty-calendar-app && curl -s localhost:PORT/health`
5. Verifikation wie in Task 9 Step 3 gegen die echte DB; Test-Report: `npx tsx src/scripts/test-email.ts firenze-loft`
6. SmartTasks #363 kommentieren, log.md-Zeile, Wiki [[Gäste-Messaging-Automation]] um Payout/Reconcile-Architektur ergänzen.
