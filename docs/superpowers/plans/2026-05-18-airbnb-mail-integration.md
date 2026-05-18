# Airbnb-Mail Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dritter Booking-Provider `airbnb-mail` für eine Property, die nur über Airbnb läuft. Daten kommen aus IMAP-Inbox (Buchungs-Mails) und iCal-URL (Verfügbarkeit).

**Architecture:** Parallele Module unter `src/.../airbnb-mail/`, ETL-Dispatch über `provider`-Feld in `properties.json`. Mail-Parser erkennen 4 Typen (confirmed/inquiry/cancellation/modification) anhand Subject-Patterns. Initial-Patterns sind Schätzungen; nach Live-Anbindung kalibriert man via `airbnb_mail_archive` + Reparse-Skript. Spec: `docs/superpowers/specs/2026-05-18-airbnb-mail-integration-design.md`.

**Tech Stack:** TypeScript strict ESM, better-sqlite3, Vitest, zod. Neue Deps: `imapflow`, `node-ical`, `mailparser`, `cheerio`.

---

## File Structure

**Neu:**
- `src/db/migrations/013_add_airbnb_mail_archive.sql`
- `src/types/airbnb-mail.ts` — RawMail, ParsedAirbnbMail, AirbnbIcalEvent
- `src/services/airbnb-mail/imap-client.ts`
- `src/services/airbnb-mail/ical-fetcher.ts`
- `src/parsers/airbnb-mail/index.ts` (type dispatcher) + `index.test.ts`
- `src/parsers/airbnb-mail/confirmed-booking.ts` + test
- `src/parsers/airbnb-mail/booking-inquiry.ts` + test
- `src/parsers/airbnb-mail/cancellation.ts` + test
- `src/parsers/airbnb-mail/modification.ts` + test
- `src/parsers/airbnb-mail/ical-parser.ts` + test
- `src/mappers/airbnb-mail/property-mapper.ts` + test
- `src/mappers/airbnb-mail/reservation-mapper.ts` + test
- `src/mappers/airbnb-mail/availability-mapper.ts` + test
- `src/repositories/airbnb-mail-archive-repository.ts`
- `src/jobs/airbnb-mail/sync-properties.ts`
- `src/jobs/airbnb-mail/sync-mail.ts`
- `src/jobs/airbnb-mail/sync-ical.ts`
- `src/scripts/test-airbnb-mail-sync.ts`
- `src/scripts/reparse-airbnb-mail.ts`
- `src/test-fixtures/airbnb-mail/*.eml` (synthetic placeholder, replaced post-deploy)
- `src/test-fixtures/airbnb-mail/calendar.ics`

**Modifiziert (minimal):**
- `package.json` — 4 neue Dependencies
- `src/config/index.ts` — AIRBNB_MAIL_* env-vars
- `src/config/properties.ts` — Zod-Schema erweitern um `'airbnb-mail'`
- `src/jobs/etl-job.ts` — Dispatch nach `provider==='airbnb-mail'`

**Nicht angefasst:** DB-Schema (außer der neuen Tabelle), Repositories für listings/reservations/inquiries/availability, Routes, Frontend, Scheduler.

---

### Task 1: Migration 013 — airbnb_mail_archive

**Files:**
- Create: `src/db/migrations/013_add_airbnb_mail_archive.sql`

- [ ] **Step 1: Migration-Datei erstellen**

Datei `src/db/migrations/013_add_airbnb_mail_archive.sql`:

```sql
-- Migration: Airbnb mail archive + state
-- Created: 2026-05-18
-- See docs/superpowers/specs/2026-05-18-airbnb-mail-integration-design.md
-- Retention: 90 days, cleanup in sync-mail.ts after each poll

CREATE TABLE airbnb_mail_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_slug TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  imap_uid INTEGER NOT NULL,
  subject TEXT,
  from_address TEXT,
  received_at TEXT NOT NULL,
  raw_body TEXT NOT NULL,
  detected_type TEXT,
  reservation_code TEXT,
  parse_status TEXT NOT NULL,
  parse_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_airbnb_mail_archive_property ON airbnb_mail_archive(property_slug);
CREATE INDEX idx_airbnb_mail_archive_received ON airbnb_mail_archive(received_at);
CREATE INDEX idx_airbnb_mail_archive_parse_status ON airbnb_mail_archive(parse_status);
CREATE INDEX idx_airbnb_mail_archive_reservation_code ON airbnb_mail_archive(reservation_code);

CREATE TABLE airbnb_mail_state (
  property_slug TEXT PRIMARY KEY,
  last_imap_uid INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Migration ausführen**

Run: `npm run db:migrate`
Expected: „Migration applied: 013_add_airbnb_mail_archive.sql" in den Logs.

- [ ] **Step 3: Schema verifizieren**

Run: `sqlite3 data/calendar.db ".schema airbnb_mail_archive" | head`
Expected: Output enthält `CREATE TABLE airbnb_mail_archive`.

Run: `sqlite3 data/calendar.db ".schema airbnb_mail_state"`
Expected: Output enthält `CREATE TABLE airbnb_mail_state`.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/013_add_airbnb_mail_archive.sql
git commit -m "feat: add airbnb mail archive + state tables

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: NPM-Dependencies installieren

**Files:**
- Modify: `package.json` (via npm install)

- [ ] **Step 1: Dependencies installieren**

Run: `npm install imapflow node-ical mailparser cheerio`
Expected: Vier neue Einträge in `dependencies`, `package-lock.json` aktualisiert (lokal, nicht committed laut `.gitignore`).

- [ ] **Step 2: Types installieren**

Run: `npm install --save-dev @types/mailparser @types/node-ical`
Expected: Zwei neue Einträge in `devDependencies`. Hinweis: `imapflow` und `cheerio` haben eingebaute Types, keine separaten `@types/*`-Pakete nötig.

- [ ] **Step 3: Build prüfen**

Run: `npm run build`
Expected: Build erfolgreich (Deps noch unbenutzt → keine Errors).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: add imapflow, node-ical, mailparser, cheerio deps

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Config-Schema erweitern (env-vars)

**Files:**
- Modify: `src/config/index.ts`

- [ ] **Step 1: configSchema erweitern**

In `src/config/index.ts` finde den Block:

```ts
  hostexAccessToken: z.string().optional(),
  hostexApiUrl: z.string().url().default('https://api.hostex.io/v3'),
```

Direkt darunter einfügen:

```ts
  // Airbnb-Mail integration (optional — only required if airbnb-mail providers exist)
  airbnbMailHost: z.string().optional(),
  airbnbMailPort: z.coerce.number().int().min(1).max(65535).default(993),
  airbnbMailUser: z.string().optional(),
  airbnbMailPassword: z.string().optional(),
```

- [ ] **Step 2: rawConfig in `parseConfig()` erweitern**

Finde im Block `const rawConfig = { ... }` die Zeile `hostexApiUrl: process.env.HOSTEX_API_URL,`. Direkt darunter einfügen:

```ts
    airbnbMailHost: process.env.AIRBNB_MAIL_HOST,
    airbnbMailPort: process.env.AIRBNB_MAIL_PORT,
    airbnbMailUser: process.env.AIRBNB_MAIL_USER,
    airbnbMailPassword: process.env.AIRBNB_MAIL_PASSWORD,
```

- [ ] **Step 3: Build prüfen**

Run: `npm run build`
Expected: Build clean.

- [ ] **Step 4: Commit**

```bash
git add src/config/index.ts
git commit -m "feat: add AIRBNB_MAIL_* config env-vars

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: properties.ts Zod-Schema erweitern

**Files:**
- Modify: `src/config/properties.ts`

- [ ] **Step 1: Provider-Enum erweitern + neue Pflichtfelder**

In `src/config/properties.ts` finde:

```ts
export interface PropertyConfig {
  slug: string;
  provider: 'guesty' | 'hostex';
  guestyPropertyId?: string;
  hostexPropertyId?: string;
```

Ersetze durch:

```ts
export interface PropertyConfig {
  slug: string;
  provider: 'guesty' | 'hostex' | 'airbnb-mail';
  guestyPropertyId?: string;
  hostexPropertyId?: string;
  airbnbListingId?: string;
  airbnbIcalUrl?: string;
```

- [ ] **Step 2: Zod-Schema anpassen**

Finde:

```ts
  provider: z.enum(['guesty', 'hostex']).default('guesty'),
  guestyPropertyId: z.string().optional(),
  hostexPropertyId: z.string().optional(),
```

Ersetze durch:

```ts
  provider: z.enum(['guesty', 'hostex', 'airbnb-mail']).default('guesty'),
  guestyPropertyId: z.string().optional(),
  hostexPropertyId: z.string().optional(),
  airbnbListingId: z.string().optional(),
  airbnbIcalUrl: z.string().url().optional(),
```

- [ ] **Step 3: Refinement-Regeln erweitern**

Finde den ersten `.refine(...)`-Block (Guesty/Hostex-ID-Validation):

```ts
}).refine(
  (data) => {
    if (data.provider === 'guesty') return !!data.guestyPropertyId;
    if (data.provider === 'hostex') return !!data.hostexPropertyId;
    return false;
  },
  {
    message: 'guestyPropertyId is required when provider=guesty; hostexPropertyId is required when provider=hostex',
    path: ['provider'],
  }
)
```

Ersetze durch:

```ts
}).refine(
  (data) => {
    if (data.provider === 'guesty') return !!data.guestyPropertyId;
    if (data.provider === 'hostex') return !!data.hostexPropertyId;
    if (data.provider === 'airbnb-mail') return !!data.airbnbListingId && !!data.airbnbIcalUrl;
    return false;
  },
  {
    message: 'guestyPropertyId required for provider=guesty; hostexPropertyId for provider=hostex; airbnbListingId + airbnbIcalUrl for provider=airbnb-mail',
    path: ['provider'],
  }
)
```

Finde den zweiten `.refine(...)` (static-block):

```ts
.refine(
  (data) => {
    if (data.provider === 'hostex') return !!data.static;
    return true;
  },
  {
    message: 'static block is required when provider=hostex',
    path: ['static'],
  }
);
```

Ersetze durch:

```ts
.refine(
  (data) => {
    if (data.provider === 'hostex' || data.provider === 'airbnb-mail') return !!data.static;
    return true;
  },
  {
    message: 'static block is required when provider=hostex or provider=airbnb-mail',
    path: ['static'],
  }
);
```

- [ ] **Step 4: Helper-Funktion `getPropertyByAirbnbId` ergänzen**

Nach der bestehenden Funktion `getPropertyByHostexId` (zu finden via `grep -n "getPropertyByHostexId" src/config/properties.ts`) einfügen:

```ts
/**
 * Get a property by its Airbnb listing ID
 */
export function getPropertyByAirbnbId(airbnbId: string): PropertyConfig | undefined {
  return loadPropertiesConfig().find((p) => p.airbnbListingId === airbnbId);
}
```

- [ ] **Step 5: Build + Tests**

Run: `npm run build && npm test -- --run`
Expected: Build clean, alle 94 bestehenden Tests grün.

- [ ] **Step 6: Backwards-Compat verifizieren**

Run: `npx tsx -e "import('./src/config/properties.js').then(m => { m.clearPropertiesCache(); console.log(m.getAllProperties().map(p => ({slug: p.slug, provider: p.provider, hasStatic: !!p.static})).slice(0,4)); })"`
Expected: 4 bestehende Properties laden korrekt mit ihren Provider-Werten (`guesty` oder `hostex`).

- [ ] **Step 7: Commit**

```bash
git add src/config/properties.ts
git commit -m "feat: extend properties schema for provider=airbnb-mail

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Type-Definitionen für Airbnb-Mail

**Files:**
- Create: `src/types/airbnb-mail.ts`

- [ ] **Step 1: Datei anlegen**

Datei `src/types/airbnb-mail.ts`:

```ts
/**
 * Airbnb-Mail Integration Type Definitions
 *
 * See docs/superpowers/specs/2026-05-18-airbnb-mail-integration-design.md
 */

/**
 * Mail as received via IMAP, before parsing.
 */
export interface RawMail {
  uid: number;
  messageId: string;
  subject: string;
  fromAddress: string;
  receivedAt: string; // ISO 8601
  htmlBody: string;
  textBody: string;
}

/**
 * Mail-type classification.
 */
export type AirbnbMailType =
  | 'confirmed'
  | 'inquiry'
  | 'cancellation'
  | 'modification'
  | 'unknown';

/**
 * Parsed structured mail data — output of any parser.
 */
export interface ParsedAirbnbMail {
  type: Exclude<AirbnbMailType, 'unknown'>;
  reservationCode: string; // Airbnb HM-code, e.g. "HMABCXYZ"
  guestName: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  numberOfGuests?: number;
  numberOfAdults?: number;
  numberOfChildren?: number;
  totalPrice?: number;
  hostPayout?: number;
  cleaningFee?: number;
  serviceFee?: number;
  receivedAt: string;
  messageId: string;
}

/**
 * iCal event from Airbnb listing calendar.
 */
export interface AirbnbIcalEvent {
  uid: string; // e.g. "HMABCXYZ@airbnb.com"
  reservationCode: string; // extracted from uid: "HMABCXYZ"
  startDate: string; // YYYY-MM-DD (DTSTART)
  endDate: string; // YYYY-MM-DD (DTEND, exclusive)
  summary: string;
}
```

- [ ] **Step 2: Build prüfen**

Run: `npm run build`
Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add src/types/airbnb-mail.ts
git commit -m "feat: add Airbnb-Mail type definitions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Airbnb-Mail-Archive Repository

**Files:**
- Create: `src/repositories/airbnb-mail-archive-repository.ts`

- [ ] **Step 1: Repository anlegen**

Datei `src/repositories/airbnb-mail-archive-repository.ts`:

```ts
/**
 * Airbnb Mail Archive Repository
 *
 * Stores raw mail bodies for audit + replay. Tracks per-property IMAP UID
 * state for incremental polling. See migration 013.
 */

import { getDatabase } from '../db/index.js';
import { DatabaseError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export interface NewMailRow {
  property_slug: string;
  message_id: string;
  imap_uid: number;
  subject: string | null;
  from_address: string | null;
  received_at: string;
  raw_body: string;
  detected_type: string | null;
  reservation_code: string | null;
  parse_status: 'pending' | 'ok' | 'error';
  parse_error: string | null;
}

export interface MailRow extends NewMailRow {
  id: number;
  created_at: string;
}

export function insertMail(row: NewMailRow): void {
  const db = getDatabase();
  try {
    db.prepare(`
      INSERT INTO airbnb_mail_archive (
        property_slug, message_id, imap_uid, subject, from_address,
        received_at, raw_body, detected_type, reservation_code,
        parse_status, parse_error
      ) VALUES (
        @property_slug, @message_id, @imap_uid, @subject, @from_address,
        @received_at, @raw_body, @detected_type, @reservation_code,
        @parse_status, @parse_error
      )
      ON CONFLICT(message_id) DO NOTHING
    `).run(row);
  } catch (error) {
    logger.error({ error, message_id: row.message_id }, 'Failed to insert airbnb mail');
    throw new DatabaseError(`Failed to insert airbnb mail: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function updateParseStatus(
  messageId: string,
  status: 'ok' | 'error',
  parseError: string | null = null,
  reservationCode: string | null = null,
  detectedType: string | null = null
): void {
  const db = getDatabase();
  try {
    db.prepare(`
      UPDATE airbnb_mail_archive
      SET parse_status = ?, parse_error = ?, reservation_code = ?, detected_type = COALESCE(?, detected_type)
      WHERE message_id = ?
    `).run(status, parseError, reservationCode, detectedType, messageId);
  } catch (error) {
    logger.error({ error, messageId }, 'Failed to update parse status');
    throw new DatabaseError(`Failed to update parse status: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function getMail(messageId: string): MailRow | null {
  const db = getDatabase();
  try {
    const row = db.prepare(`SELECT * FROM airbnb_mail_archive WHERE message_id = ?`).get(messageId);
    return (row as MailRow) ?? null;
  } catch (error) {
    logger.error({ error, messageId }, 'Failed to get mail');
    throw new DatabaseError(`Failed to get mail: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function pruneOldMails(olderThanDays: number): number {
  const db = getDatabase();
  try {
    const result = db.prepare(
      `DELETE FROM airbnb_mail_archive WHERE created_at < datetime('now', '-' || ? || ' days')`
    ).run(olderThanDays);
    return result.changes;
  } catch (error) {
    logger.error({ error, olderThanDays }, 'Failed to prune old mails');
    throw new DatabaseError(`Failed to prune old mails: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function getLastUid(propertySlug: string): number {
  const db = getDatabase();
  try {
    const row = db.prepare(`SELECT last_imap_uid FROM airbnb_mail_state WHERE property_slug = ?`).get(propertySlug) as { last_imap_uid: number } | undefined;
    return row?.last_imap_uid ?? 0;
  } catch (error) {
    logger.error({ error, propertySlug }, 'Failed to get last UID');
    throw new DatabaseError(`Failed to get last UID: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function setLastUid(propertySlug: string, uid: number): void {
  const db = getDatabase();
  try {
    db.prepare(`
      INSERT INTO airbnb_mail_state (property_slug, last_imap_uid, last_sync_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(property_slug) DO UPDATE SET
        last_imap_uid = excluded.last_imap_uid,
        last_sync_at = excluded.last_sync_at
    `).run(propertySlug, uid);
  } catch (error) {
    logger.error({ error, propertySlug, uid }, 'Failed to set last UID');
    throw new DatabaseError(`Failed to set last UID: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export function getErrorMails(propertySlug?: string): MailRow[] {
  const db = getDatabase();
  try {
    if (propertySlug) {
      return db.prepare(
        `SELECT * FROM airbnb_mail_archive WHERE parse_status = 'error' AND property_slug = ? ORDER BY received_at DESC`
      ).all(propertySlug) as MailRow[];
    }
    return db.prepare(
      `SELECT * FROM airbnb_mail_archive WHERE parse_status = 'error' ORDER BY received_at DESC`
    ).all() as MailRow[];
  } catch (error) {
    logger.error({ error, propertySlug }, 'Failed to get error mails');
    throw new DatabaseError(`Failed to get error mails: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
```

- [ ] **Step 2: Build + Tests**

Run: `npm run build && npm test -- --run`
Expected: Build clean, 94 Tests grün.

- [ ] **Step 3: Commit**

```bash
git add src/repositories/airbnb-mail-archive-repository.ts
git commit -m "feat: add airbnb-mail archive repository

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: IMAP-Client

**Files:**
- Create: `src/services/airbnb-mail/imap-client.ts`

- [ ] **Step 1: Client-Klasse anlegen**

Datei `src/services/airbnb-mail/imap-client.ts`:

```ts
/**
 * Airbnb IMAP Client
 *
 * Connects to a dedicated bot inbox (e.g. Gmail/Google Workspace) and fetches
 * new messages since a given IMAP UID. Used by sync-mail.ts.
 *
 * See docs/superpowers/specs/2026-05-18-airbnb-mail-integration-design.md
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { ExternalApiError } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import type { RawMail } from '../../types/airbnb-mail.js';

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox?: string;
}

export class AirbnbImapClient {
  private readonly config: ImapConfig;
  private client: ImapFlow | null = null;

  constructor(config: ImapConfig) {
    this.config = { mailbox: 'INBOX', ...config };
  }

  async connect(): Promise<void> {
    this.client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
    });
    try {
      await this.client.connect();
      await this.client.mailboxOpen(this.config.mailbox!);
    } catch (error) {
      logger.error({ error, host: this.config.host, user: this.config.user }, 'IMAP connect failed');
      throw new ExternalApiError(
        `IMAP connect failed: ${error instanceof Error ? error.message : 'unknown'}`,
        0,
        'Airbnb-IMAP'
      );
    }
  }

  async fetchNewMails(sinceUid: number): Promise<RawMail[]> {
    if (!this.client) throw new Error('IMAP client not connected');
    const out: RawMail[] = [];
    const searchRange = sinceUid > 0 ? `${sinceUid + 1}:*` : '1:*';

    for await (const msg of this.client.fetch(searchRange, {
      uid: true,
      envelope: true,
      source: true,
    })) {
      try {
        const parsed = await simpleParser(msg.source as Buffer);
        out.push({
          uid: msg.uid,
          messageId: parsed.messageId ?? `imap-uid-${msg.uid}@unknown`,
          subject: parsed.subject ?? '',
          fromAddress: parsed.from?.text ?? '',
          receivedAt: (parsed.date ?? new Date()).toISOString(),
          htmlBody: typeof parsed.html === 'string' ? parsed.html : '',
          textBody: parsed.text ?? '',
        });
      } catch (error) {
        logger.warn({ error, uid: msg.uid }, 'Failed to parse mail, skipping');
      }
    }
    return out;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // ignore — connection may already be dead
      }
      this.client = null;
    }
  }
}
```

- [ ] **Step 2: Build + Tests**

Run: `npm run build && npm test -- --run`
Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add src/services/airbnb-mail/imap-client.ts
git commit -m "feat: add Airbnb IMAP client

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: iCal-Fetcher

**Files:**
- Create: `src/services/airbnb-mail/ical-fetcher.ts`

- [ ] **Step 1: Fetcher anlegen**

Datei `src/services/airbnb-mail/ical-fetcher.ts`:

```ts
/**
 * Airbnb iCal Fetcher
 *
 * Downloads the raw .ics body from a private Airbnb calendar URL.
 * Used by sync-ical.ts.
 */

import { ExternalApiError } from '../../utils/errors.js';
import logger from '../../utils/logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchAirbnbIcal(url: string): Promise<string> {
  const maxRetries = 3;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'guesty-calendar-app' },
      });
      if (!res.ok) {
        if (res.status >= 500 && attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt) * 1000;
          logger.warn({ status: res.status, attempt, delayMs }, 'iCal fetch 5xx, retrying');
          await sleep(delayMs);
          continue;
        }
        throw new ExternalApiError(
          `Airbnb iCal HTTP ${res.status}`,
          res.status,
          'Airbnb-iCal',
          { url: url.replace(/[?].*$/, '?…') }
        );
      }
      return await res.text();
    } catch (error) {
      lastError = error as Error;
      if (!(error instanceof ExternalApiError) && attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 1000;
        logger.warn({ error, attempt, delayMs }, 'iCal network error, retrying');
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error('iCal fetch failed (unknown reason)');
}
```

- [ ] **Step 2: Build + Tests**

Run: `npm run build && npm test -- --run`
Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add src/services/airbnb-mail/ical-fetcher.ts
git commit -m "feat: add Airbnb iCal fetcher with retry/backoff

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Mail-Type-Dispatcher (TDD)

**Files:**
- Create: `src/parsers/airbnb-mail/index.test.ts`
- Create: `src/parsers/airbnb-mail/index.ts`

> **Hinweis**: Subject-Patterns sind Schätzungen (Spec Sektion 4.2). Tests verifizieren die Dispatcher-LOGIK gegen diese Schätzungen. Nach Live-Anbindung werden Patterns + Tests in einem separaten Refinement-Task kalibriert.

- [ ] **Step 1: Tests schreiben**

Datei `src/parsers/airbnb-mail/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectMailType } from './index.js';

describe('detectMailType (initial estimated patterns)', () => {
  it('detects confirmed', () => {
    expect(detectMailType('Reservierung bestätigt: Anna Müller')).toBe('confirmed');
    expect(detectMailType('Buchung bestätigt')).toBe('confirmed');
    expect(detectMailType('✓ Reserviert: 15. Juli – 18. Juli')).toBe('confirmed');
  });

  it('detects inquiry', () => {
    expect(detectMailType('Anfrage von Lukas')).toBe('inquiry');
    expect(detectMailType('Buchungsanfrage: 2 Nächte')).toBe('inquiry');
    expect(detectMailType('Lukas möchte buchen')).toBe('inquiry');
  });

  it('detects cancellation', () => {
    expect(detectMailType('Reservierung storniert')).toBe('cancellation');
    expect(detectMailType('Stornierung durch Anna')).toBe('cancellation');
    expect(detectMailType('Buchung abgesagt')).toBe('cancellation');
  });

  it('detects modification', () => {
    expect(detectMailType('Datum geändert')).toBe('modification');
    expect(detectMailType('Reservierung: Änderung der Daten')).toBe('modification');
    expect(detectMailType('Buchung aktualisiert')).toBe('modification');
  });

  it('returns unknown for unrecognised subjects', () => {
    expect(detectMailType('Newsletter Mai 2026')).toBe('unknown');
    expect(detectMailType('')).toBe('unknown');
    expect(detectMailType('Re: Frage zur Property')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(detectMailType('RESERVIERUNG BESTÄTIGT')).toBe('confirmed');
    expect(detectMailType('anfrage von paul')).toBe('inquiry');
  });
});
```

- [ ] **Step 2: Tests laufen, FAIL erwartet**

Run: `npm test -- --run src/parsers/airbnb-mail/index.test.ts`
Expected: Cannot find module './index.js'.

- [ ] **Step 3: Implementation**

Datei `src/parsers/airbnb-mail/index.ts`:

```ts
/**
 * Airbnb Mail Type Dispatcher
 *
 * Classifies an Airbnb mail by Subject pattern.
 *
 * IMPORTANT: Patterns are initial estimates. They must be calibrated against
 * real anonymised mails after the integration goes live. See spec Section 4.2.
 */

import type { AirbnbMailType } from '../../types/airbnb-mail.js';

const CONFIRMED_RE = /(reservierung best[äa]tigt|buchung best[äa]tigt|✓\s*reserviert)/i;
const INQUIRY_RE = /(anfrage von|buchungsanfrage|m[öo]chte buchen)/i;
const CANCELLATION_RE = /(storniert|stornierung|abgesagt)/i;
const MODIFICATION_RE = /(datum ge[äa]ndert|änderung|aktualisiert)/i;

export function detectMailType(subject: string): AirbnbMailType {
  if (!subject) return 'unknown';
  // Order matters: cancellation/modification patterns may overlap with
  // "Reservierung …" prefix in confirmed.
  if (CANCELLATION_RE.test(subject)) return 'cancellation';
  if (MODIFICATION_RE.test(subject)) return 'modification';
  if (CONFIRMED_RE.test(subject)) return 'confirmed';
  if (INQUIRY_RE.test(subject)) return 'inquiry';
  return 'unknown';
}
```

- [ ] **Step 4: Tests grün**

Run: `npm test -- --run src/parsers/airbnb-mail/index.test.ts`
Expected: Alle 6 Tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/airbnb-mail/index.ts src/parsers/airbnb-mail/index.test.ts
git commit -m "feat: add Airbnb mail type dispatcher (initial subject patterns)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Confirmed-Booking Parser (TDD)

**Files:**
- Create: `src/parsers/airbnb-mail/confirmed-booking.test.ts`
- Create: `src/parsers/airbnb-mail/confirmed-booking.ts`

> **Hinweis**: Parser nutzt synthetic Fixtures, die der Spec-Schätzung folgen. Nach Live-Anbindung in einem separaten Task kalibrieren.

- [ ] **Step 1: Tests schreiben**

Datei `src/parsers/airbnb-mail/confirmed-booking.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseConfirmedBooking } from './confirmed-booking.js';
import type { RawMail } from '../../types/airbnb-mail.js';

const baseMail: RawMail = {
  uid: 1,
  messageId: 'test-1@airbnb.com',
  subject: 'Reservierung bestätigt: Anna Müller',
  fromAddress: 'automated@airbnb.com',
  receivedAt: '2026-05-18T09:00:00.000Z',
  htmlBody: `
    <html><body>
      <p>Reservierungscode: HMABCXYZ</p>
      <p>Gast: Anna Müller</p>
      <p>Check-in: 15. Juli 2026</p>
      <p>Check-out: 18. Juli 2026</p>
      <p>Gäste: 2</p>
      <table>
        <tr><td>Übernachtungen</td><td>270,00 €</td></tr>
        <tr><td>Reinigungsgebühr</td><td>30,00 €</td></tr>
        <tr><td>Service-Gebühr Airbnb</td><td>15,00 €</td></tr>
        <tr><td>Gesamt (du erhältst)</td><td>270,00 €</td></tr>
      </table>
    </body></html>
  `,
  textBody: `Reservierungscode: HMABCXYZ
Gast: Anna Müller
Check-in: 15. Juli 2026
Check-out: 18. Juli 2026
Gäste: 2
Übernachtungen: 270,00 €
Reinigungsgebühr: 30,00 €
Service-Gebühr Airbnb: 15,00 €
Gesamt (du erhältst): 270,00 €`,
};

describe('parseConfirmedBooking', () => {
  it('extracts reservation code', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.reservationCode).toBe('HMABCXYZ');
  });

  it('extracts guest name', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.guestName).toBe('Anna Müller');
  });

  it('extracts check-in/out dates as ISO YYYY-MM-DD', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.checkIn).toBe('2026-07-15');
    expect(out?.checkOut).toBe('2026-07-18');
  });

  it('extracts numberOfGuests', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.numberOfGuests).toBe(2);
  });

  it('extracts hostPayout from "du erhältst" line', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.hostPayout).toBe(270);
  });

  it('extracts cleaningFee', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.cleaningFee).toBe(30);
  });

  it('preserves messageId and receivedAt from RawMail', () => {
    const out = parseConfirmedBooking(baseMail);
    expect(out?.messageId).toBe('test-1@airbnb.com');
    expect(out?.receivedAt).toBe('2026-05-18T09:00:00.000Z');
  });

  it('returns null when no reservation code found', () => {
    const bad: RawMail = { ...baseMail, htmlBody: '', textBody: 'no code here' };
    expect(parseConfirmedBooking(bad)).toBeNull();
  });

  it('falls back to textBody if htmlBody is empty', () => {
    const noHtml: RawMail = { ...baseMail, htmlBody: '' };
    const out = parseConfirmedBooking(noHtml);
    expect(out?.reservationCode).toBe('HMABCXYZ');
    expect(out?.guestName).toBe('Anna Müller');
  });
});
```

- [ ] **Step 2: Tests laufen, FAIL erwartet**

Run: `npm test -- --run src/parsers/airbnb-mail/confirmed-booking.test.ts`
Expected: Cannot find module.

- [ ] **Step 3: Implementation**

Datei `src/parsers/airbnb-mail/confirmed-booking.ts`:

```ts
/**
 * Airbnb Confirmed-Booking Parser
 *
 * Extracts structured data from a confirmed-booking mail. Uses regex on the
 * text-body as primary, HTML stripping as fallback. Patterns are initial
 * estimates — calibrate after live data lands in airbnb_mail_archive.
 */

import * as cheerio from 'cheerio';
import type { RawMail, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

const RES_CODE_RE = /(?:Reservierungscode|Buchungscode)\s*:?\s*(HM[A-Z0-9]+)/i;
const GUEST_RE = /(?:Gast|Gastname)\s*:?\s*([^\n\r<]+)/i;
const CHECK_IN_RE = /Check-?in\s*:?\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})/i;
const CHECK_OUT_RE = /Check-?out\s*:?\s*(\d{1,2})\.\s*([A-Za-zäöüÄÖÜ]+)\s*(\d{4})/i;
const GUESTS_RE = /G[äa]ste\s*:?\s*(\d+)/i;
const CLEANING_RE = /Reinigungsgeb[üu]hr\s*:?\s*([\d.,]+)\s*€/i;
const SERVICE_RE = /Service-?Geb[üu]hr(?:\s+Airbnb)?\s*:?\s*([\d.,]+)\s*€/i;
const HOST_PAYOUT_RE = /(?:du erh[äa]ltst|Auszahlung an dich|Gesamt[^\n]*du erh[äa]ltst)\s*:?\s*\(?\s*([\d.,]+)\s*€/i;
const TOTAL_RE = /Gesamt(?:betrag)?(?:\s*\(Gast\))?\s*:?\s*([\d.,]+)\s*€/i;

const MONATE: Record<string, string> = {
  januar: '01', februar: '02', märz: '03', maerz: '03', april: '04',
  mai: '05', juni: '06', juli: '07', august: '08', september: '09',
  oktober: '10', november: '11', dezember: '12',
};

function parseGermanDate(day: string, month: string, year: string): string {
  const mm = MONATE[month.toLowerCase()];
  if (!mm) throw new Error(`Unknown German month: ${month}`);
  return `${year}-${mm}-${day.padStart(2, '0')}`;
}

function parseAmount(s: string): number {
  // "270,00" or "1.234,56" → 270 / 1234.56
  return parseFloat(s.replace(/\./g, '').replace(',', '.'));
}

function getBodyText(raw: RawMail): string {
  if (raw.textBody && raw.textBody.length > 0) return raw.textBody;
  if (raw.htmlBody) {
    const $ = cheerio.load(raw.htmlBody);
    return $('body').text();
  }
  return '';
}

export function parseConfirmedBooking(raw: RawMail): ParsedAirbnbMail | null {
  const body = getBodyText(raw);
  const codeMatch = body.match(RES_CODE_RE);
  if (!codeMatch) return null;
  const guestMatch = body.match(GUEST_RE);
  const checkInMatch = body.match(CHECK_IN_RE);
  const checkOutMatch = body.match(CHECK_OUT_RE);
  if (!guestMatch || !checkInMatch || !checkOutMatch) return null;

  const guestsMatch = body.match(GUESTS_RE);
  const cleaningMatch = body.match(CLEANING_RE);
  const serviceMatch = body.match(SERVICE_RE);
  const hostPayoutMatch = body.match(HOST_PAYOUT_RE);
  const totalMatch = body.match(TOTAL_RE);

  return {
    type: 'confirmed',
    reservationCode: codeMatch[1],
    guestName: guestMatch[1].trim(),
    checkIn: parseGermanDate(checkInMatch[1], checkInMatch[2], checkInMatch[3]),
    checkOut: parseGermanDate(checkOutMatch[1], checkOutMatch[2], checkOutMatch[3]),
    numberOfGuests: guestsMatch ? parseInt(guestsMatch[1], 10) : undefined,
    cleaningFee: cleaningMatch ? parseAmount(cleaningMatch[1]) : undefined,
    serviceFee: serviceMatch ? parseAmount(serviceMatch[1]) : undefined,
    hostPayout: hostPayoutMatch ? parseAmount(hostPayoutMatch[1]) : undefined,
    totalPrice: totalMatch ? parseAmount(totalMatch[1]) : undefined,
    receivedAt: raw.receivedAt,
    messageId: raw.messageId,
  };
}
```

- [ ] **Step 4: Tests grün**

Run: `npm test -- --run src/parsers/airbnb-mail/confirmed-booking.test.ts`
Expected: 9 Tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/airbnb-mail/confirmed-booking.ts src/parsers/airbnb-mail/confirmed-booking.test.ts
git commit -m "feat: implement Airbnb confirmed-booking parser (initial patterns)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Booking-Inquiry Parser (TDD)

**Files:**
- Create: `src/parsers/airbnb-mail/booking-inquiry.test.ts`
- Create: `src/parsers/airbnb-mail/booking-inquiry.ts`

- [ ] **Step 1: Tests schreiben**

Datei `src/parsers/airbnb-mail/booking-inquiry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseBookingInquiry } from './booking-inquiry.js';
import type { RawMail } from '../../types/airbnb-mail.js';

const baseMail: RawMail = {
  uid: 2,
  messageId: 'test-2@airbnb.com',
  subject: 'Anfrage von Lukas',
  fromAddress: 'automated@airbnb.com',
  receivedAt: '2026-05-18T10:00:00.000Z',
  htmlBody: `
    <html><body>
      <p>Reservierungscode: HMXYZ123</p>
      <p>Gast: Lukas Schmidt</p>
      <p>Check-in: 5. August 2026</p>
      <p>Check-out: 12. August 2026</p>
      <p>Gäste: 3</p>
    </body></html>
  `,
  textBody: `Reservierungscode: HMXYZ123
Gast: Lukas Schmidt
Check-in: 5. August 2026
Check-out: 12. August 2026
Gäste: 3`,
};

describe('parseBookingInquiry', () => {
  it('extracts reservation code and guest', () => {
    const out = parseBookingInquiry(baseMail);
    expect(out?.reservationCode).toBe('HMXYZ123');
    expect(out?.guestName).toBe('Lukas Schmidt');
  });

  it('extracts dates', () => {
    const out = parseBookingInquiry(baseMail);
    expect(out?.checkIn).toBe('2026-08-05');
    expect(out?.checkOut).toBe('2026-08-12');
  });

  it('type is "inquiry"', () => {
    const out = parseBookingInquiry(baseMail);
    expect(out?.type).toBe('inquiry');
  });

  it('returns null when reservation code missing', () => {
    const bad: RawMail = { ...baseMail, htmlBody: '', textBody: 'no code' };
    expect(parseBookingInquiry(bad)).toBeNull();
  });
});
```

- [ ] **Step 2: Tests laufen, FAIL**

Run: `npm test -- --run src/parsers/airbnb-mail/booking-inquiry.test.ts`
Expected: Cannot find module.

- [ ] **Step 3: Implementation**

Datei `src/parsers/airbnb-mail/booking-inquiry.ts`:

```ts
/**
 * Airbnb Booking-Inquiry Parser
 *
 * Inquiries have less data than confirmed bookings — typically no host payout
 * yet. We extract the core fields (code, guest, dates) and leave financials
 * undefined.
 */

import { parseConfirmedBooking } from './confirmed-booking.js';
import type { RawMail, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

export function parseBookingInquiry(raw: RawMail): ParsedAirbnbMail | null {
  // Reuse the confirmed parser's field extraction — financial fields will
  // just be `undefined` if the inquiry mail doesn't contain them.
  const parsed = parseConfirmedBooking(raw);
  if (!parsed) return null;
  return { ...parsed, type: 'inquiry' };
}
```

- [ ] **Step 4: Tests grün**

Run: `npm test -- --run src/parsers/airbnb-mail/booking-inquiry.test.ts`
Expected: 4 Tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/airbnb-mail/booking-inquiry.ts src/parsers/airbnb-mail/booking-inquiry.test.ts
git commit -m "feat: implement Airbnb booking-inquiry parser

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Cancellation Parser (TDD)

**Files:**
- Create: `src/parsers/airbnb-mail/cancellation.test.ts`
- Create: `src/parsers/airbnb-mail/cancellation.ts`

- [ ] **Step 1: Tests schreiben**

Datei `src/parsers/airbnb-mail/cancellation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseCancellation } from './cancellation.js';
import type { RawMail } from '../../types/airbnb-mail.js';

const baseMail: RawMail = {
  uid: 3,
  messageId: 'test-3@airbnb.com',
  subject: 'Reservierung storniert: HMSTORNO1',
  fromAddress: 'automated@airbnb.com',
  receivedAt: '2026-05-18T11:00:00.000Z',
  htmlBody: '',
  textBody: `Reservierungscode: HMSTORNO1
Gast: Sandra Klein
Check-in: 20. Juli 2026
Check-out: 22. Juli 2026
Diese Reservierung wurde storniert.`,
};

describe('parseCancellation', () => {
  it('extracts reservation code', () => {
    const out = parseCancellation(baseMail);
    expect(out?.reservationCode).toBe('HMSTORNO1');
  });

  it('extracts guest name and dates if present', () => {
    const out = parseCancellation(baseMail);
    expect(out?.guestName).toBe('Sandra Klein');
    expect(out?.checkIn).toBe('2026-07-20');
    expect(out?.checkOut).toBe('2026-07-22');
  });

  it('type is "cancellation"', () => {
    const out = parseCancellation(baseMail);
    expect(out?.type).toBe('cancellation');
  });

  it('returns null when reservation code missing', () => {
    const bad: RawMail = { ...baseMail, textBody: 'cancellation but no code' };
    expect(parseCancellation(bad)).toBeNull();
  });
});
```

- [ ] **Step 2: Tests laufen, FAIL**

Run: `npm test -- --run src/parsers/airbnb-mail/cancellation.test.ts`
Expected: Cannot find module.

- [ ] **Step 3: Implementation**

Datei `src/parsers/airbnb-mail/cancellation.ts`:

```ts
/**
 * Airbnb Cancellation Parser
 *
 * Cancellation mails primarily contain the reservation code. Guest/date fields
 * may be included for context; we extract what's there.
 */

import { parseConfirmedBooking } from './confirmed-booking.js';
import type { RawMail, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

export function parseCancellation(raw: RawMail): ParsedAirbnbMail | null {
  const parsed = parseConfirmedBooking(raw);
  if (!parsed) return null;
  return { ...parsed, type: 'cancellation' };
}
```

- [ ] **Step 4: Tests grün**

Run: `npm test -- --run src/parsers/airbnb-mail/cancellation.test.ts`
Expected: 4 Tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/airbnb-mail/cancellation.ts src/parsers/airbnb-mail/cancellation.test.ts
git commit -m "feat: implement Airbnb cancellation parser

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Modification Parser (TDD)

**Files:**
- Create: `src/parsers/airbnb-mail/modification.test.ts`
- Create: `src/parsers/airbnb-mail/modification.ts`

- [ ] **Step 1: Tests schreiben**

Datei `src/parsers/airbnb-mail/modification.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseModification } from './modification.js';
import type { RawMail } from '../../types/airbnb-mail.js';

const baseMail: RawMail = {
  uid: 4,
  messageId: 'test-4@airbnb.com',
  subject: 'Datum geändert: HMMOD1',
  fromAddress: 'automated@airbnb.com',
  receivedAt: '2026-05-18T12:00:00.000Z',
  htmlBody: '',
  textBody: `Reservierungscode: HMMOD1
Gast: Tom Weber
Neue Daten:
Check-in: 1. September 2026
Check-out: 5. September 2026
Gäste: 4`,
};

describe('parseModification', () => {
  it('extracts reservation code', () => {
    const out = parseModification(baseMail);
    expect(out?.reservationCode).toBe('HMMOD1');
  });

  it('extracts new dates', () => {
    const out = parseModification(baseMail);
    expect(out?.checkIn).toBe('2026-09-01');
    expect(out?.checkOut).toBe('2026-09-05');
  });

  it('type is "modification"', () => {
    const out = parseModification(baseMail);
    expect(out?.type).toBe('modification');
  });

  it('returns null when reservation code missing', () => {
    const bad: RawMail = { ...baseMail, textBody: 'no code' };
    expect(parseModification(bad)).toBeNull();
  });
});
```

- [ ] **Step 2: Tests laufen, FAIL**

Run: `npm test -- --run src/parsers/airbnb-mail/modification.test.ts`
Expected: Cannot find module.

- [ ] **Step 3: Implementation**

Datei `src/parsers/airbnb-mail/modification.ts`:

```ts
/**
 * Airbnb Modification Parser
 *
 * Date-change mails. We reuse the confirmed-booking field extractor — if the
 * mail contains snapshot fields (most do), we extract them. Otherwise null.
 */

import { parseConfirmedBooking } from './confirmed-booking.js';
import type { RawMail, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

export function parseModification(raw: RawMail): ParsedAirbnbMail | null {
  const parsed = parseConfirmedBooking(raw);
  if (!parsed) return null;
  return { ...parsed, type: 'modification' };
}
```

- [ ] **Step 4: Tests grün**

Run: `npm test -- --run src/parsers/airbnb-mail/modification.test.ts`
Expected: 4 Tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/airbnb-mail/modification.ts src/parsers/airbnb-mail/modification.test.ts
git commit -m "feat: implement Airbnb modification parser

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: iCal Parser (TDD)

**Files:**
- Create: `src/parsers/airbnb-mail/ical-parser.test.ts`
- Create: `src/parsers/airbnb-mail/ical-parser.ts`

- [ ] **Step 1: Tests schreiben**

Datei `src/parsers/airbnb-mail/ical-parser.test.ts`:

```ts
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
```

- [ ] **Step 2: Tests laufen, FAIL**

Run: `npm test -- --run src/parsers/airbnb-mail/ical-parser.test.ts`
Expected: Cannot find module.

- [ ] **Step 3: Implementation**

Datei `src/parsers/airbnb-mail/ical-parser.ts`:

```ts
/**
 * Airbnb iCal Parser
 *
 * Wraps node-ical to normalise events for downstream availability mapping.
 */

import ical from 'node-ical';
import type { AirbnbIcalEvent } from '../../types/airbnb-mail.js';

function formatDate(d: Date): string {
  // node-ical returns Date objects in UTC for DATE-VALUE entries.
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function parseAirbnbIcal(icsBody: string): AirbnbIcalEvent[] {
  const parsed = ical.sync.parseICS(icsBody);
  const out: AirbnbIcalEvent[] = [];
  for (const key of Object.keys(parsed)) {
    const entry = parsed[key];
    if (entry.type !== 'VEVENT') continue;
    const uid = (entry.uid ?? key) as string;
    const reservationCode = uid.split('@')[0];
    out.push({
      uid,
      reservationCode,
      startDate: formatDate(entry.start as Date),
      endDate: formatDate(entry.end as Date),
      summary: (entry.summary ?? '') as string,
    });
  }
  return out;
}
```

- [ ] **Step 4: Tests grün**

Run: `npm test -- --run src/parsers/airbnb-mail/ical-parser.test.ts`
Expected: 5 Tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/airbnb-mail/ical-parser.ts src/parsers/airbnb-mail/ical-parser.test.ts
git commit -m "feat: implement Airbnb iCal parser

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Property-Mapper (TDD)

**Files:**
- Create: `src/mappers/airbnb-mail/property-mapper.test.ts`
- Create: `src/mappers/airbnb-mail/property-mapper.ts`

- [ ] **Step 1: Tests schreiben**

Datei `src/mappers/airbnb-mail/property-mapper.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { mapAirbnbProperty } from './property-mapper.js';
import type { PropertyConfig } from '../../config/properties.js';

const baseConfig: PropertyConfig = {
  slug: 'schiffmuehle-x',
  provider: 'airbnb-mail',
  airbnbListingId: '987654321',
  airbnbIcalUrl: 'https://www.airbnb.com/calendar/ical/x.ics',
  name: 'Schiffmühle X',
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  bookingRecipientEmail: 'a@b.de',
  bookingSenderName: 'X',
  weeklyReport: { enabled: false, recipients: [], day: 1, hour: 9 },
  ga4: { enabled: false },
  googleCalendar: { enabled: false },
  static: {
    accommodates: 4,
    bedrooms: 2,
    bathrooms: 1,
    propertyType: 'Apartment',
    cleaningFee: 30,
    extraPersonFee: 0,
    guestsIncluded: 4,
    weeklyPriceFactor: 0.9,
    monthlyPriceFactor: 0.8,
    taxes: [],
  },
};

describe('mapAirbnbProperty', () => {
  it('id from airbnbListingId', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.id).toBe('987654321');
  });

  it('accommodates and other static fields populated', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.accommodates).toBe(4);
    expect(l.bedrooms).toBe(2);
    expect(l.bathrooms).toBe(1);
    expect(l.property_type).toBe('Apartment');
    expect(l.cleaning_fee).toBe(30);
    expect(l.guests_included).toBe(4);
    expect(l.weekly_price_factor).toBe(0.9);
    expect(l.monthly_price_factor).toBe(0.8);
  });

  it('base_price = 0 when not in static', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.base_price).toBe(0);
  });

  it('base_price from static.basePrice when set', () => {
    const cfg = { ...baseConfig, static: { ...baseConfig.static!, basePrice: 150 } };
    const l = mapAirbnbProperty(cfg);
    expect(l.base_price).toBe(150);
  });

  it('min_nights default 1', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.min_nights).toBe(1);
  });

  it('max_nights default null', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.max_nights).toBeNull();
  });

  it('throws when static is missing', () => {
    const noStatic = { ...baseConfig, static: undefined };
    expect(() => mapAirbnbProperty(noStatic)).toThrow(/static config/);
  });

  it('active is always true', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.active).toBe(true);
  });

  it('nickname = propertyConfig.name', () => {
    const l = mapAirbnbProperty(baseConfig);
    expect(l.nickname).toBe('Schiffmühle X');
  });
});
```

- [ ] **Step 2: Tests laufen, FAIL**

Run: `npm test -- --run src/mappers/airbnb-mail/property-mapper.test.ts`
Expected: Cannot find module.

- [ ] **Step 3: Implementation**

Datei `src/mappers/airbnb-mail/property-mapper.ts`:

```ts
/**
 * Airbnb Property Mapper
 *
 * Builds the internal Listing model entirely from properties.json `static`
 * config. Airbnb exposes no listing metadata via Mail/iCal, so this is a
 * pure static-config mapping.
 */

import type { PropertyConfig } from '../../config/properties.js';
import type { Listing, Tax } from '../../types/models.js';

export function mapAirbnbProperty(
  propertyConfig: PropertyConfig
): Omit<Listing, 'created_at' | 'updated_at'> {
  const stat = propertyConfig.static;
  if (!stat) {
    throw new Error(
      `mapAirbnbProperty called without static config for property ${propertyConfig.slug}`
    );
  }
  if (!propertyConfig.airbnbListingId) {
    throw new Error(
      `mapAirbnbProperty: airbnbListingId missing for ${propertyConfig.slug}`
    );
  }

  const taxes: Tax[] = (stat.taxes ?? []).map((t, idx) => ({
    id: `static-${idx}`,
    type: t.type,
    amount: t.amount,
    units: t.units,
    quantifier: t.quantifier,
    appliedToAllFees: t.appliedToAllFees ?? false,
    appliedOnFees: t.appliedOnFees ?? [],
  }));

  return {
    id: propertyConfig.airbnbListingId,
    title: propertyConfig.name,
    nickname: propertyConfig.name,
    accommodates: stat.accommodates,
    bedrooms: stat.bedrooms ?? null,
    bathrooms: stat.bathrooms ?? null,
    property_type: stat.propertyType ?? null,
    timezone: propertyConfig.timezone ?? 'Europe/Berlin',
    currency: propertyConfig.currency ?? 'EUR',
    base_price: stat.basePrice ?? 0,
    weekend_base_price: null,
    cleaning_fee: stat.cleaningFee ?? 0,
    extra_person_fee: stat.extraPersonFee ?? 0,
    guests_included: stat.guestsIncluded ?? stat.accommodates,
    weekly_price_factor: stat.weeklyPriceFactor ?? 1.0,
    monthly_price_factor: stat.monthlyPriceFactor ?? 1.0,
    taxes,
    min_nights: stat.minNights ?? 1,
    max_nights: stat.maxNights ?? null,
    check_in_time: propertyConfig.googleCalendar?.checkInTime ?? null,
    check_out_time: propertyConfig.googleCalendar?.checkOutTime ?? null,
    active: true,
    last_synced_at: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Tests grün**

Run: `npm test -- --run src/mappers/airbnb-mail/property-mapper.test.ts`
Expected: 9 Tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/mappers/airbnb-mail/property-mapper.ts src/mappers/airbnb-mail/property-mapper.test.ts
git commit -m "feat: implement Airbnb property mapper (static-only)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Reservation-Mapper (TDD)

**Files:**
- Create: `src/mappers/airbnb-mail/reservation-mapper.test.ts`
- Create: `src/mappers/airbnb-mail/reservation-mapper.ts`

- [ ] **Step 1: Tests schreiben**

Datei `src/mappers/airbnb-mail/reservation-mapper.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { mapAirbnbReservation } from './reservation-mapper.js';
import type { ParsedAirbnbMail } from '../../types/airbnb-mail.js';

const base: ParsedAirbnbMail = {
  type: 'confirmed',
  reservationCode: 'HMABCXYZ',
  guestName: 'Anna Müller',
  checkIn: '2026-07-15',
  checkOut: '2026-07-18',
  numberOfGuests: 2,
  totalPrice: 300,
  hostPayout: 270,
  cleaningFee: 30,
  serviceFee: 15,
  receivedAt: '2026-05-18T09:00:00.000Z',
  messageId: 'test-1@airbnb.com',
};

const defaultTimes = { checkIn: '15:00', checkOut: '12:00' };

describe('mapAirbnbReservation', () => {
  describe('status routing', () => {
    it('confirmed → confirmed in both tables', () => {
      const { asInquiry, asReservation } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asInquiry.status).toBe('confirmed');
      expect(asReservation).not.toBeNull();
      expect(asReservation!.status).toBe('confirmed');
    });

    it('inquiry → inquiry, no reservation', () => {
      const { asInquiry, asReservation } = mapAirbnbReservation({ ...base, type: 'inquiry' }, '999', defaultTimes);
      expect(asInquiry.status).toBe('inquiry');
      expect(asReservation).toBeNull();
    });

    it('cancellation → canceled, no reservation', () => {
      const { asInquiry, asReservation } = mapAirbnbReservation({ ...base, type: 'cancellation' }, '999', defaultTimes);
      expect(asInquiry.status).toBe('canceled');
      expect(asReservation).toBeNull();
    });

    it('modification → confirmed (snapshot)', () => {
      const { asInquiry, asReservation } = mapAirbnbReservation({ ...base, type: 'modification' }, '999', defaultTimes);
      expect(asInquiry.status).toBe('confirmed');
      expect(asReservation!.status).toBe('confirmed');
    });
  });

  describe('financial fields', () => {
    it('host_payout passed through', () => {
      const { asReservation } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asReservation!.host_payout).toBe(270);
      expect(asReservation!.total_price).toBe(300);
    });

    it('host_payout = 0 when missing', () => {
      const noPayout = { ...base, hostPayout: undefined, totalPrice: undefined };
      const { asReservation } = mapAirbnbReservation(noPayout, '999', defaultTimes);
      expect(asReservation!.host_payout).toBe(0);
      expect(asReservation!.total_price).toBe(0);
    });
  });

  describe('date composition', () => {
    it('builds ISO check_in/check_out from date + default time', () => {
      const { asReservation } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asReservation!.check_in).toBe('2026-07-15T15:00:00.000Z');
      expect(asReservation!.check_out).toBe('2026-07-18T12:00:00.000Z');
    });
  });

  describe('identifiers', () => {
    it('reservation_id = reservationCode', () => {
      const { asReservation, asInquiry } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asReservation!.reservation_id).toBe('HMABCXYZ');
      expect(asInquiry.inquiry_id).toBe('HMABCXYZ');
    });

    it('listing_id from caller-supplied airbnbListingId', () => {
      const { asReservation } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asReservation!.listing_id).toBe('999');
    });

    it('source = "airbnb"', () => {
      const { asReservation } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asReservation!.source).toBe('airbnb');
    });
  });

  describe('guest fingerprint', () => {
    it('integrates fingerprintGuest', () => {
      const { asReservation } = mapAirbnbReservation(base, '999', defaultTimes);
      expect(asReservation!.internal_guest_id).toBe('anna_mueller');
    });
  });
});
```

- [ ] **Step 2: Tests laufen, FAIL**

Run: `npm test -- --run src/mappers/airbnb-mail/reservation-mapper.test.ts`
Expected: Cannot find module.

- [ ] **Step 3: Implementation**

Datei `src/mappers/airbnb-mail/reservation-mapper.ts`:

```ts
/**
 * Airbnb Reservation Mapper
 *
 * Maps a ParsedAirbnbMail to internal Reservation + Inquiry rows.
 *
 * Status routing:
 *   confirmed / modification → inquiry='confirmed', reservation='confirmed'
 *   inquiry                  → inquiry='inquiry', no reservation row
 *   cancellation             → inquiry='canceled', no reservation row
 */

import { fingerprintGuest } from '../../utils/guest-fingerprint.js';
import logger from '../../utils/logger.js';
import type { ParsedAirbnbMail } from '../../types/airbnb-mail.js';
import type { Reservation } from '../../types/models.js';

export interface MappedAirbnbInquiry {
  inquiry_id: string;
  listing_id: string;
  status: string;
  check_in: string;
  check_out: string;
  guest_name: string | null;
  guests_count: number | null;
  source: string | null;
  created_at_guesty: string | null;
  last_synced_at: string;
}

export interface MappedAirbnbResult {
  asInquiry: MappedAirbnbInquiry;
  asReservation: Omit<Reservation, 'id' | 'created_at' | 'updated_at'> | null;
}

const STATUS_MAP_INQUIRY: Record<ParsedAirbnbMail['type'], string> = {
  confirmed: 'confirmed',
  inquiry: 'inquiry',
  cancellation: 'canceled',
  modification: 'confirmed',
};

const ACTIVE_TYPES = new Set<ParsedAirbnbMail['type']>(['confirmed', 'modification']);

function fingerprintSafe(name: string | null) {
  try {
    const fp = fingerprintGuest(name);
    return { internal_guest_id: fp.id, guest_company: fp.company };
  } catch (error) {
    logger.warn({ error, name }, 'fingerprintGuest threw, falling back to nulls');
    return { internal_guest_id: null, guest_company: null };
  }
}

export function mapAirbnbReservation(
  parsed: ParsedAirbnbMail,
  airbnbListingId: string,
  defaultTimes: { checkIn: string; checkOut: string }
): MappedAirbnbResult {
  const now = new Date().toISOString();
  const inquiryStatus = STATUS_MAP_INQUIRY[parsed.type];
  const reservationStatus = ACTIVE_TYPES.has(parsed.type) ? 'confirmed' : null;
  const fp = fingerprintSafe(parsed.guestName);

  const checkInIso = `${parsed.checkIn}T${defaultTimes.checkIn}:00.000Z`;
  const checkOutIso = `${parsed.checkOut}T${defaultTimes.checkOut}:00.000Z`;
  const nights = Math.round(
    (Date.parse(`${parsed.checkOut}T00:00:00Z`) - Date.parse(`${parsed.checkIn}T00:00:00Z`)) /
      (1000 * 60 * 60 * 24)
  );

  const asInquiry: MappedAirbnbInquiry = {
    inquiry_id: parsed.reservationCode,
    listing_id: airbnbListingId,
    status: inquiryStatus,
    check_in: parsed.checkIn,
    check_out: parsed.checkOut,
    guest_name: parsed.guestName,
    guests_count: parsed.numberOfGuests ?? null,
    source: 'airbnb',
    created_at_guesty: parsed.receivedAt,
    last_synced_at: now,
  };

  if (!reservationStatus) {
    return { asInquiry, asReservation: null };
  }

  const asReservation: Omit<Reservation, 'id' | 'created_at' | 'updated_at'> = {
    reservation_id: parsed.reservationCode,
    listing_id: airbnbListingId,
    check_in: checkInIso,
    check_out: checkOutIso,
    check_in_localized: parsed.checkIn,
    check_out_localized: parsed.checkOut,
    nights_count: nights,
    guest_id: null,
    guest_name: parsed.guestName,
    guests_count: parsed.numberOfGuests ?? null,
    adults_count: parsed.numberOfAdults ?? null,
    children_count: parsed.numberOfChildren ?? null,
    infants_count: null,
    status: reservationStatus,
    confirmation_code: parsed.reservationCode,
    source: 'airbnb',
    platform: 'airbnb-mail',
    planned_arrival: null,
    planned_departure: null,
    currency: 'EUR',
    total_price: parsed.totalPrice ?? 0,
    host_payout: parsed.hostPayout ?? 0,
    balance_due: null,
    total_paid: null,
    created_at_guesty: parsed.receivedAt,
    reserved_at: parsed.receivedAt,
    last_synced_at: now,
    internal_guest_id: fp.internal_guest_id,
    guest_company: fp.guest_company,
  };

  return { asInquiry, asReservation };
}
```

- [ ] **Step 4: Tests grün**

Run: `npm test -- --run src/mappers/airbnb-mail/reservation-mapper.test.ts`
Expected: 11 Tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/mappers/airbnb-mail/reservation-mapper.ts src/mappers/airbnb-mail/reservation-mapper.test.ts
git commit -m "feat: implement Airbnb reservation mapper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Availability-Mapper (TDD)

**Files:**
- Create: `src/mappers/airbnb-mail/availability-mapper.test.ts`
- Create: `src/mappers/airbnb-mail/availability-mapper.ts`

- [ ] **Step 1: Tests schreiben**

Datei `src/mappers/airbnb-mail/availability-mapper.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildAvailabilityRows } from './availability-mapper.js';
import type { AirbnbIcalEvent } from '../../types/airbnb-mail.js';

const events: AirbnbIcalEvent[] = [
  { uid: 'HMA@airbnb.com', reservationCode: 'HMA', startDate: '2026-07-01', endDate: '2026-07-04', summary: 'Reserved' },
];

describe('buildAvailabilityRows', () => {
  it('returns one row per day in window', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-08',
      events: [],
      basePrice: 100,
      defaultMinNights: 1,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows.length).toBe(7);
  });

  it('marks days inside event range as booked', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-08',
      events,
      basePrice: 100,
      defaultMinNights: 1,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows[0].status).toBe('booked'); // 07-01
    expect(rows[0].block_ref).toBe('HMA');
    expect(rows[1].status).toBe('booked'); // 07-02
    expect(rows[2].status).toBe('booked'); // 07-03
    expect(rows[3].status).toBe('available'); // 07-04 (endDate exclusive)
  });

  it('uses base_price for every row', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-02',
      events: [],
      basePrice: 137,
      defaultMinNights: 1,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows[0].price).toBe(137);
  });

  it('uses default min_nights', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-02',
      events: [],
      basePrice: 100,
      defaultMinNights: 2,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows[0].min_nights).toBe(2);
  });

  it('listing_id, date, last_synced_at are persisted', () => {
    const rows = buildAvailabilityRows({
      listingId: '999',
      windowStart: '2026-07-01',
      windowEnd: '2026-07-02',
      events: [],
      basePrice: 100,
      defaultMinNights: 1,
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(rows[0].listing_id).toBe('999');
    expect(rows[0].date).toBe('2026-07-01');
    expect(rows[0].last_synced_at).toBe('2026-07-01T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Tests laufen, FAIL**

Run: `npm test -- --run src/mappers/airbnb-mail/availability-mapper.test.ts`
Expected: Cannot find module.

- [ ] **Step 3: Implementation**

Datei `src/mappers/airbnb-mail/availability-mapper.ts`:

```ts
/**
 * Airbnb Availability Mapper
 *
 * Builds per-day Availability rows for a window, marking booked days from
 * iCal events. Price/min_nights come from the property's listing config
 * (Airbnb iCal has none).
 */

import type { AirbnbIcalEvent } from '../../types/airbnb-mail.js';
import type { Availability } from '../../types/models.js';

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

export function buildAvailabilityRows(args: {
  listingId: string;
  windowStart: string; // YYYY-MM-DD, inclusive
  windowEnd: string;   // YYYY-MM-DD, exclusive
  events: AirbnbIcalEvent[];
  basePrice: number;
  defaultMinNights: number;
  lastSyncedAt: string;
}): Array<Omit<Availability, 'id' | 'created_at' | 'updated_at'>> {
  const { listingId, windowStart, windowEnd, events, basePrice, defaultMinNights, lastSyncedAt } = args;

  const rows: Array<Omit<Availability, 'id' | 'created_at' | 'updated_at'>> = [];
  let day = windowStart;
  while (day < windowEnd) {
    const event = events.find((e) => e.startDate <= day && day < e.endDate);
    rows.push({
      listing_id: listingId,
      date: day,
      status: event ? 'booked' : 'available',
      price: basePrice,
      min_nights: defaultMinNights,
      closed_to_arrival: false,
      closed_to_departure: false,
      block_type: event ? 'reservation' : null,
      block_ref: event?.reservationCode ?? null,
      last_synced_at: lastSyncedAt,
    });
    day = addDays(day, 1);
  }
  return rows;
}
```

- [ ] **Step 4: Tests grün**

Run: `npm test -- --run src/mappers/airbnb-mail/availability-mapper.test.ts`
Expected: 5 Tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/mappers/airbnb-mail/availability-mapper.ts src/mappers/airbnb-mail/availability-mapper.test.ts
git commit -m "feat: implement Airbnb availability mapper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: sync-properties Job

**Files:**
- Create: `src/jobs/airbnb-mail/sync-properties.ts`

- [ ] **Step 1: Job-Datei anlegen**

Datei `src/jobs/airbnb-mail/sync-properties.ts`:

```ts
/**
 * Airbnb Sync Properties
 *
 * Static-config-only: builds a Listing from properties.json `static` block
 * and upserts.
 */

import { upsertListing } from '../../repositories/listings-repository.js';
import { mapAirbnbProperty } from '../../mappers/airbnb-mail/property-mapper.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';

export interface SyncPropertyResult {
  success: boolean;
  error?: string;
}

export async function syncAirbnbProperty(property: PropertyConfig): Promise<SyncPropertyResult> {
  const slug = property.slug;
  try {
    logger.info({ slug, airbnbListingId: property.airbnbListingId }, 'Airbnb: starting property sync');
    const listing = mapAirbnbProperty(property);
    upsertListing(listing);
    logger.info({ slug }, 'Airbnb: property sync completed');
    return { success: true };
  } catch (error) {
    logger.error({ slug, error }, 'Airbnb: property sync failed');
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
```

- [ ] **Step 2: Build + Tests**

Run: `npm run build && npm test -- --run`
Expected: Build clean.

- [ ] **Step 3: Commit**

```bash
git add src/jobs/airbnb-mail/sync-properties.ts
git commit -m "feat: add Airbnb sync-properties job

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: sync-mail Job

**Files:**
- Create: `src/jobs/airbnb-mail/sync-mail.ts`

- [ ] **Step 1: Job-Datei anlegen**

Datei `src/jobs/airbnb-mail/sync-mail.ts`:

```ts
/**
 * Airbnb Sync Mail
 *
 * IMAP poll: fetch new mails since last UID, archive raw bodies, detect type,
 * parse, and persist to inquiries + reservations. Final step: prune archive
 * older than 90 days.
 */

import { config } from '../../config/index.js';
import { AirbnbImapClient } from '../../services/airbnb-mail/imap-client.js';
import {
  insertMail,
  updateParseStatus,
  getLastUid,
  setLastUid,
  pruneOldMails,
} from '../../repositories/airbnb-mail-archive-repository.js';
import { detectMailType } from '../../parsers/airbnb-mail/index.js';
import { parseConfirmedBooking } from '../../parsers/airbnb-mail/confirmed-booking.js';
import { parseBookingInquiry } from '../../parsers/airbnb-mail/booking-inquiry.js';
import { parseCancellation } from '../../parsers/airbnb-mail/cancellation.js';
import { parseModification } from '../../parsers/airbnb-mail/modification.js';
import { mapAirbnbReservation } from '../../mappers/airbnb-mail/reservation-mapper.js';
import { upsertReservation } from '../../repositories/reservation-repository.js';
import { getDatabase } from '../../db/index.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';
import type { RawMail, AirbnbMailType, ParsedAirbnbMail } from '../../types/airbnb-mail.js';

export interface SyncMailResult {
  success: boolean;
  fetched: number;
  parsedOk: number;
  parsedError: number;
  prunedArchive: number;
  error?: string;
}

function dispatchParser(type: AirbnbMailType, raw: RawMail): ParsedAirbnbMail | null {
  switch (type) {
    case 'confirmed': return parseConfirmedBooking(raw);
    case 'inquiry': return parseBookingInquiry(raw);
    case 'cancellation': return parseCancellation(raw);
    case 'modification': return parseModification(raw);
    default: return null;
  }
}

export async function syncAirbnbMail(property: PropertyConfig): Promise<SyncMailResult> {
  const slug = property.slug;
  const airbnbListingId = property.airbnbListingId!;
  if (!config.airbnbMailHost || !config.airbnbMailUser || !config.airbnbMailPassword) {
    return { success: false, fetched: 0, parsedOk: 0, parsedError: 0, prunedArchive: 0,
             error: 'AIRBNB_MAIL_* env-vars not configured' };
  }

  const defaultTimes = {
    checkIn: property.googleCalendar?.checkInTime ?? '15:00',
    checkOut: property.googleCalendar?.checkOutTime ?? '12:00',
  };

  const client = new AirbnbImapClient({
    host: config.airbnbMailHost,
    port: config.airbnbMailPort,
    user: config.airbnbMailUser,
    password: config.airbnbMailPassword,
  });

  let fetched = 0;
  let parsedOk = 0;
  let parsedError = 0;

  try {
    await client.connect();
    const lastUid = getLastUid(slug);
    const mails = await client.fetchNewMails(lastUid);
    fetched = mails.length;
    logger.info({ slug, fetched, sinceUid: lastUid }, 'Airbnb mail: fetched new mails');

    const db = getDatabase();
    const upsertInquiry = db.prepare(`
      INSERT INTO inquiries (
        inquiry_id, listing_id, status, check_in, check_out,
        guest_name, guests_count, source, created_at_guesty, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(inquiry_id) DO UPDATE SET
        status = excluded.status,
        check_in = excluded.check_in,
        check_out = excluded.check_out,
        guest_name = excluded.guest_name,
        guests_count = excluded.guests_count,
        source = excluded.source,
        last_synced_at = excluded.last_synced_at
    `);

    const deleteReservation = db.prepare(`DELETE FROM reservations WHERE reservation_id = ?`);
    let maxUid = lastUid;

    for (const raw of mails) {
      maxUid = Math.max(maxUid, raw.uid);

      // Archive raw first
      insertMail({
        property_slug: slug,
        message_id: raw.messageId,
        imap_uid: raw.uid,
        subject: raw.subject,
        from_address: raw.fromAddress,
        received_at: raw.receivedAt,
        raw_body: raw.htmlBody || raw.textBody,
        detected_type: null,
        reservation_code: null,
        parse_status: 'pending',
        parse_error: null,
      });

      const type = detectMailType(raw.subject);
      if (type === 'unknown') {
        updateParseStatus(raw.messageId, 'error', `Unknown subject pattern: ${raw.subject}`, null, type);
        parsedError++;
        logger.warn({ slug, messageId: raw.messageId, subject: raw.subject }, 'Airbnb mail: unknown subject pattern');
        continue;
      }

      try {
        const parsed = dispatchParser(type, raw);
        if (!parsed) {
          updateParseStatus(raw.messageId, 'error', 'Parser returned null (missing fields)', null, type);
          parsedError++;
          logger.warn({ slug, messageId: raw.messageId, type }, 'Airbnb mail: parser returned null');
          continue;
        }

        const { asInquiry, asReservation } = mapAirbnbReservation(parsed, airbnbListingId, defaultTimes);

        upsertInquiry.run(
          asInquiry.inquiry_id,
          asInquiry.listing_id,
          asInquiry.status,
          asInquiry.check_in,
          asInquiry.check_out,
          asInquiry.guest_name,
          asInquiry.guests_count,
          asInquiry.source,
          asInquiry.created_at_guesty,
          asInquiry.last_synced_at,
        );

        if (asReservation) {
          upsertReservation(asReservation);
        } else if (type === 'cancellation') {
          // Cancellation mail → remove any existing reservation row
          deleteReservation.run(parsed.reservationCode);
        }

        updateParseStatus(raw.messageId, 'ok', null, parsed.reservationCode, type);
        parsedOk++;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'unknown error';
        updateParseStatus(raw.messageId, 'error', errMsg, null, type);
        parsedError++;
        logger.warn({ slug, messageId: raw.messageId, type, error: errMsg }, 'Airbnb mail: parse threw');
      }
    }

    if (maxUid > lastUid) setLastUid(slug, maxUid);

    // No stale-delete pass: airbnb-mail is a delta-update source, not a snapshot.
    // Cancellations remove rows directly above. If a cancellation mail ever gets
    // lost the orphan row needs manual cleanup (or future iCal-based reconciliation).

    const prunedArchive = pruneOldMails(90);

    return { success: true, fetched, parsedOk, parsedError, prunedArchive };
  } catch (error) {
    logger.error({ slug, error }, 'Airbnb mail sync failed');
    return {
      success: false, fetched, parsedOk, parsedError, prunedArchive: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    await client.disconnect();
  }
}
```

- [ ] **Step 2: Build + Tests**

Run: `npm run build && npm test -- --run`
Expected: Build clean, alle Tests grün.

- [ ] **Step 3: Commit**

```bash
git add src/jobs/airbnb-mail/sync-mail.ts
git commit -m "feat: add Airbnb sync-mail job

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: sync-ical Job

**Files:**
- Create: `src/jobs/airbnb-mail/sync-ical.ts`

- [ ] **Step 1: Job-Datei anlegen**

Datei `src/jobs/airbnb-mail/sync-ical.ts`:

```ts
/**
 * Airbnb Sync iCal
 *
 * Fetches the property's private Airbnb iCal URL, parses events, and writes
 * 24 months (today → +24mo) of Availability rows. Past days are pruned.
 */

import { fetchAirbnbIcal } from '../../services/airbnb-mail/ical-fetcher.js';
import { parseAirbnbIcal } from '../../parsers/airbnb-mail/ical-parser.js';
import { buildAvailabilityRows } from '../../mappers/airbnb-mail/availability-mapper.js';
import {
  upsertAvailabilityBatch,
  deleteOldAvailability,
} from '../../repositories/availability-repository.js';
import { getListingById } from '../../repositories/listings-repository.js';
import logger from '../../utils/logger.js';
import type { PropertyConfig } from '../../config/properties.js';

export interface SyncIcalResult {
  success: boolean;
  daysCount: number;
  events: number;
  error?: string;
}

export async function syncAirbnbIcal(property: PropertyConfig): Promise<SyncIcalResult> {
  const slug = property.slug;
  const airbnbListingId = property.airbnbListingId!;
  const url = property.airbnbIcalUrl!;
  try {
    logger.info({ slug, airbnbListingId }, 'Airbnb iCal: starting sync');
    const ics = await fetchAirbnbIcal(url);
    const events = parseAirbnbIcal(ics);

    const now = new Date();
    const end = new Date(now);
    end.setMonth(end.getMonth() + 24);
    const startStr = now.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    const listing = getListingById(airbnbListingId);
    const basePrice = listing?.base_price ?? 0;
    const minNights = listing?.min_nights ?? 1;

    const rows = buildAvailabilityRows({
      listingId: airbnbListingId,
      windowStart: startStr,
      windowEnd: endStr,
      events,
      basePrice,
      defaultMinNights: minNights,
      lastSyncedAt: new Date().toISOString(),
    });
    upsertAvailabilityBatch(rows);
    const deleted = deleteOldAvailability(airbnbListingId, startStr);

    logger.info({ slug, daysCount: rows.length, events: events.length, deletedOld: deleted }, 'Airbnb iCal: sync completed');
    return { success: true, daysCount: rows.length, events: events.length };
  } catch (error) {
    logger.error({ slug, error }, 'Airbnb iCal sync failed');
    return {
      success: false,
      daysCount: 0,
      events: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
```

- [ ] **Step 2: Build + Tests**

Run: `npm run build && npm test -- --run`
Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add src/jobs/airbnb-mail/sync-ical.ts
git commit -m "feat: add Airbnb sync-ical job

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: ETL-Dispatch

**Files:**
- Modify: `src/jobs/etl-job.ts`

- [ ] **Step 1: Imports ergänzen**

In `src/jobs/etl-job.ts` nach den bestehenden Hostex-Imports ergänzen:

```ts
import { syncAirbnbProperty } from './airbnb-mail/sync-properties.js';
import { syncAirbnbMail } from './airbnb-mail/sync-mail.js';
import { syncAirbnbIcal } from './airbnb-mail/sync-ical.js';
```

- [ ] **Step 2: `runAirbnbMailETL` einfügen**

Direkt vor der Funktion `runHostexETL` (oder direkt vor `export async function runETLJobForProperty`) einfügen:

```ts
async function runAirbnbMailETL(property: PropertyConfig, force: boolean): Promise<ETLJobResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const slug = property.slug;

  logger.info({ propertySlug: slug, force }, `🚀 Starting Airbnb-Mail ETL for ${property.name}`);

  // Step 1: property listing (static)
  const propertyResult = await syncAirbnbProperty(property);

  // Step 2: mail sync (reservations + inquiries)
  const mailResult = propertyResult.success
    ? await syncAirbnbMail(property)
    : { success: false, fetched: 0, parsedOk: 0, parsedError: 0, prunedArchive: 0, error: 'Skipped: property sync failed' };

  // Step 3: iCal sync (availability)
  const icalResult = propertyResult.success
    ? await syncAirbnbIcal(property)
    : { success: false, daysCount: 0, events: 0, error: 'Skipped: property sync failed' };

  const success = propertyResult.success && mailResult.success && icalResult.success;
  const duration = Date.now() - startTime;

  logger.info(
    {
      propertySlug: slug,
      duration,
      success,
      mailsFetched: mailResult.fetched,
      mailsParsedOk: mailResult.parsedOk,
      mailsParsedError: mailResult.parsedError,
      daysCount: icalResult.daysCount,
      icalEvents: icalResult.events,
    },
    success
      ? `✅ Airbnb-Mail ETL completed for ${property.name}`
      : `⚠️  Airbnb-Mail ETL completed with errors for ${property.name}`
  );

  return {
    success,
    propertySlug: slug,
    propertyName: property.name,
    listing: { success: propertyResult.success, error: propertyResult.error },
    availability: {
      success: icalResult.success,
      daysCount: icalResult.daysCount,
      error: icalResult.error,
    },
    inquiries: {
      success: mailResult.success,
      inquiriesCount: mailResult.parsedOk,
      confirmedCount: mailResult.parsedOk,
      error: mailResult.error,
    },
    duration,
    timestamp,
  };
}
```

- [ ] **Step 3: Dispatch in `runETLJobForProperty`**

Direkt unter dem Hostex-Dispatch:

```ts
  if (property.provider === 'hostex') {
    return runHostexETL(property, force);
  }
```

Erweitern um:

```ts
  if (property.provider === 'hostex') {
    return runHostexETL(property, force);
  }
  if (property.provider === 'airbnb-mail') {
    return runAirbnbMailETL(property, force);
  }
```

- [ ] **Step 4: Build + Tests**

Run: `npm run build && npm test -- --run`
Expected: Build clean, alle bisherigen Tests grün.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/etl-job.ts
git commit -m "feat: dispatch ETL for provider=airbnb-mail

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 22: Manuelles Test-Sync-Script

**Files:**
- Create: `src/scripts/test-airbnb-mail-sync.ts`

- [ ] **Step 1: Script anlegen**

Datei `src/scripts/test-airbnb-mail-sync.ts`:

```ts
/**
 * Manual Airbnb-Mail Sync Test
 *
 * Usage:
 *   npx tsx src/scripts/test-airbnb-mail-sync.ts <slug>
 */

import { getPropertyBySlug } from '../config/properties.js';
import { runETLJobForProperty } from '../jobs/etl-job.js';
import { getDatabase, initDatabase } from '../db/index.js';

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: test-airbnb-mail-sync.ts <slug>');
    process.exit(1);
  }
  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found in properties.json`);
    process.exit(1);
  }
  if (property.provider !== 'airbnb-mail') {
    console.error(`Property '${slug}' is not provider=airbnb-mail (got: ${property.provider})`);
    process.exit(1);
  }

  initDatabase();
  const result = await runETLJobForProperty(property, true);
  console.log('\n=== ETL Result ===');
  console.log(JSON.stringify(result, null, 2));

  const db = getDatabase();
  const id = property.airbnbListingId!;
  console.log('\n=== DB Sanity ===');
  console.log('listing:', db.prepare('SELECT id, title, accommodates, base_price FROM listings WHERE id = ?').get(id));
  console.log('reservations:', db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE listing_id = ?').get(id));
  console.log('inquiries:', db.prepare('SELECT COUNT(*) AS n FROM inquiries WHERE listing_id = ?').get(id));
  console.log('availability:', db.prepare('SELECT COUNT(*) AS n FROM availability WHERE listing_id = ?').get(id));
  console.log('mail archive (by status):',
    db.prepare(`SELECT parse_status, COUNT(*) AS n FROM airbnb_mail_archive WHERE property_slug = ? GROUP BY parse_status`).all(slug));
}

main().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/test-airbnb-mail-sync.ts
git commit -m "feat: add manual Airbnb-Mail sync test script

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 23: Reparse-Tool

**Files:**
- Create: `src/scripts/reparse-airbnb-mail.ts`

- [ ] **Step 1: Script anlegen**

Datei `src/scripts/reparse-airbnb-mail.ts`:

```ts
/**
 * Reparse Airbnb-Mail
 *
 * Re-runs the parser pipeline on archived raw mails. Use this after fixing
 * parser bugs or calibrating patterns against live data.
 *
 * Usage:
 *   npx tsx src/scripts/reparse-airbnb-mail.ts <message_id>           # single, only if status=error
 *   npx tsx src/scripts/reparse-airbnb-mail.ts <message_id> --force   # single, even if status=ok
 *   npx tsx src/scripts/reparse-airbnb-mail.ts --all-errors           # all error mails
 *   npx tsx src/scripts/reparse-airbnb-mail.ts --all-errors --slug=X  # only that property
 */

import { initDatabase, getDatabase } from '../db/index.js';
import { getPropertyBySlug } from '../config/properties.js';
import {
  getMail,
  getErrorMails,
  updateParseStatus,
} from '../repositories/airbnb-mail-archive-repository.js';
import { detectMailType } from '../parsers/airbnb-mail/index.js';
import { parseConfirmedBooking } from '../parsers/airbnb-mail/confirmed-booking.js';
import { parseBookingInquiry } from '../parsers/airbnb-mail/booking-inquiry.js';
import { parseCancellation } from '../parsers/airbnb-mail/cancellation.js';
import { parseModification } from '../parsers/airbnb-mail/modification.js';
import { mapAirbnbReservation } from '../mappers/airbnb-mail/reservation-mapper.js';
import { upsertReservation } from '../repositories/reservation-repository.js';
import type { RawMail } from '../types/airbnb-mail.js';
import type { MailRow } from '../repositories/airbnb-mail-archive-repository.js';

function rowToRaw(row: MailRow): RawMail {
  return {
    uid: row.imap_uid,
    messageId: row.message_id,
    subject: row.subject ?? '',
    fromAddress: row.from_address ?? '',
    receivedAt: row.received_at,
    htmlBody: row.raw_body,
    textBody: row.raw_body, // archive stores combined body; parsers fall back from html→text
  };
}

async function processMail(row: MailRow): Promise<{ ok: boolean; error?: string }> {
  const property = getPropertyBySlug(row.property_slug);
  if (!property || property.provider !== 'airbnb-mail' || !property.airbnbListingId) {
    return { ok: false, error: `Property ${row.property_slug} not configured as airbnb-mail` };
  }

  const raw = rowToRaw(row);
  const type = detectMailType(raw.subject);
  if (type === 'unknown') {
    updateParseStatus(row.message_id, 'error', `Unknown subject pattern: ${raw.subject}`, null, type);
    return { ok: false, error: 'Unknown subject pattern' };
  }

  const parsed =
    type === 'confirmed' ? parseConfirmedBooking(raw) :
    type === 'inquiry' ? parseBookingInquiry(raw) :
    type === 'cancellation' ? parseCancellation(raw) :
    parseModification(raw);

  if (!parsed) {
    updateParseStatus(row.message_id, 'error', 'Parser returned null', null, type);
    return { ok: false, error: 'Parser returned null' };
  }

  const defaultTimes = {
    checkIn: property.googleCalendar?.checkInTime ?? '15:00',
    checkOut: property.googleCalendar?.checkOutTime ?? '12:00',
  };
  const { asInquiry, asReservation } = mapAirbnbReservation(parsed, property.airbnbListingId, defaultTimes);

  const db = getDatabase();
  db.prepare(`
    INSERT INTO inquiries (
      inquiry_id, listing_id, status, check_in, check_out,
      guest_name, guests_count, source, created_at_guesty, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(inquiry_id) DO UPDATE SET
      status = excluded.status,
      check_in = excluded.check_in,
      check_out = excluded.check_out,
      guest_name = excluded.guest_name,
      guests_count = excluded.guests_count,
      source = excluded.source,
      last_synced_at = excluded.last_synced_at
  `).run(
    asInquiry.inquiry_id, asInquiry.listing_id, asInquiry.status,
    asInquiry.check_in, asInquiry.check_out, asInquiry.guest_name,
    asInquiry.guests_count, asInquiry.source, asInquiry.created_at_guesty,
    asInquiry.last_synced_at
  );
  if (asReservation) {
    upsertReservation(asReservation);
  } else if (type === 'cancellation') {
    db.prepare(`DELETE FROM reservations WHERE reservation_id = ?`).run(parsed.reservationCode);
  }
  updateParseStatus(row.message_id, 'ok', null, parsed.reservationCode, type);
  return { ok: true };
}

async function main() {
  const args = process.argv.slice(2);
  initDatabase();

  if (args.includes('--all-errors')) {
    const slugArg = args.find((a) => a.startsWith('--slug='));
    const slug = slugArg?.split('=')[1];
    const mails = getErrorMails(slug);
    console.log(`Reparsing ${mails.length} error mails…`);
    let ok = 0, fail = 0;
    for (const m of mails) {
      const r = await processMail(m);
      if (r.ok) ok++; else fail++;
    }
    console.log(`Done. ok=${ok} fail=${fail}`);
    return;
  }

  const messageId = args[0];
  if (!messageId || messageId.startsWith('--')) {
    console.error('Usage: reparse-airbnb-mail.ts <message_id> [--force] | --all-errors [--slug=X]');
    process.exit(1);
  }
  const force = args.includes('--force');
  const row = getMail(messageId);
  if (!row) {
    console.error(`Mail with messageId '${messageId}' not found`);
    process.exit(1);
  }
  if (row.parse_status === 'ok' && !force) {
    console.log(`Already parsed ok. Use --force to re-parse.`);
    return;
  }
  const r = await processMail(row);
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/reparse-airbnb-mail.ts
git commit -m "feat: add reparse-airbnb-mail script

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 24: Final Build/Lint/Tests + Smoke

**Files:** keine Änderungen, nur Verifikation.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean.

- [ ] **Step 2: Tests**

Run: `npm test -- --run`
Expected: alle bisherigen 94 + neue Airbnb-Tests (Dispatcher 6 + Confirmed 9 + Inquiry 4 + Cancellation 4 + Modification 4 + iCal 5 + Property 9 + Reservation 11 + Availability 5 = 57) = **151 passing**.

- [ ] **Step 3: Backwards-Compat: existing properties.json lädt**

Run: `npx tsx -e "import('./src/config/properties.js').then(m => { m.clearPropertiesCache(); console.log('count:', m.getAllProperties().length); })"`
Expected: `count: 4` (Farmhouse, U19, Alte Schilderwerkstatt, Bootshaus — keine airbnb-mail Property bisher).

- [ ] **Step 4: Boot ohne `AIRBNB_MAIL_*`**

Run: `unset AIRBNB_MAIL_HOST AIRBNB_MAIL_USER AIRBNB_MAIL_PASSWORD && npx tsx -e "import('./src/db/index.js').then(m => { m.initDatabase(); console.log('boot ok'); })"`
Expected: `boot ok`. App startet ohne airbnb-mail-Credentials, weil keine Property das nutzt.

---

### Task 25: CLAUDE.md Doku + Deployment-Notiz

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Sektion ergänzen**

In `CLAUDE.md` direkt nach „Hostex Integration" (vor „Authentication") einfügen:

```markdown
### Airbnb-Mail Integration (Migration 013)

Dritter Booking-Provider für Properties, die nur über Airbnb laufen. Daten kommen aus:
- **IMAP-Inbox** (z.B. dedizierter Bot-Account `airbnb-bot@…`) — Buchungs-Mails
- **iCal-URL** (Airbnb Listing → Calendar Settings → Export) — Verfügbarkeit

**Property-Discriminator**: `provider: 'airbnb-mail'` in `properties.json`, plus `airbnbListingId`, `airbnbIcalUrl`, `static`-Block.

**Mail-Typen**: confirmed, inquiry, cancellation, modification. Subject-Patterns sind initial Schätzungen — werden nach Live-Daten kalibriert.

**Storage**:
- `reservations` / `inquiries` / `availability`: bestehende Tabellen, `source='airbnb'`
- `airbnb_mail_archive`: rohe Mail-Bodies + Parse-Status, 90 Tage Retention
- `airbnb_mail_state`: per-Property last-IMAP-UID für inkrementellen Poll

**Scripts**:
- `npx tsx src/scripts/test-airbnb-mail-sync.ts <slug>` — manueller ETL-Test
- `npx tsx src/scripts/reparse-airbnb-mail.ts <message_id> [--force]` — einzelne Mail neu parsen
- `npx tsx src/scripts/reparse-airbnb-mail.ts --all-errors [--slug=X]` — alle Fehler-Mails neu parsen (nach Parser-Update)

**Deployment-Reihenfolge:**
1. Google-Workspace-User `airbnb-bot@…` anlegen, App-Passwort generieren
2. Bot-Adresse zum Google-Groups-Verteiler hinzufügen (empfängt alle Airbnb-Mails)
3. `AIRBNB_MAIL_HOST=imap.gmail.com`, `AIRBNB_MAIL_PORT=993`, `AIRBNB_MAIL_USER=…`, `AIRBNB_MAIL_PASSWORD=…` in `/opt/guesty-calendar-app/.env`
4. Property mit `provider: 'airbnb-mail'` in `data/properties.json` ergänzen (inkl. `airbnbListingId`, `airbnbIcalUrl`, `static`)
5. `git pull && npm install && npm run build && pm2 restart guesty-calendar`
6. Logs prüfen: Migration 013 applied, kein Zod-Error
7. Manueller Sync: `npx tsx src/scripts/test-airbnb-mail-sync.ts <slug>`
8. **Live-Daten-Kalibrierung**:
   - Nach 1-2 echten Mails: `SELECT subject, parse_status, parse_error FROM airbnb_mail_archive ORDER BY received_at DESC` ansehen
   - Subject-Patterns (`src/parsers/airbnb-mail/index.ts`) und Body-Regex (`confirmed-booking.ts` etc.) anhand der echten Mails justieren
   - `npx tsx src/scripts/reparse-airbnb-mail.ts --all-errors --slug=X` zum Backfill

**Rollback**: Property aus `properties.json` entfernen, restart. DB-Rows können bleiben, Migration ist additive.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Airbnb-Mail integration in CLAUDE.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Done-Definition

- [ ] Migration 013 angewendet, zwei neue Tabellen existieren
- [ ] 4 npm-Dependencies installiert (imapflow, node-ical, mailparser, cheerio)
- [ ] Config + properties.json Schema um `provider='airbnb-mail'` erweitert
- [ ] IMAP-Client + iCal-Fetcher implementiert
- [ ] 5 Parser (Dispatcher + 4 Mail-Typen) + iCal-Parser implementiert, **57 grüne Tests**
- [ ] 3 Mapper (Property, Reservation, Availability)
- [ ] 3 Sync-Jobs (properties, mail, ical)
- [ ] ETL-Dispatch in `etl-job.ts`
- [ ] 2 CLI-Scripts (test-sync, reparse)
- [ ] Build clean, 151 Tests grün
- [ ] CLAUDE.md mit Deployment-Anleitung
- [ ] Bestehende Guesty/Hostex-Tests unbeeinträchtigt

## Post-Deploy: Live-Daten-Kalibrierung

Nach Anbindung der Bot-Inbox + erstes ETL-Run:

1. SQL-Inspektion: welche Subjects landen mit `parse_status='error'`?
2. Im Repo: `src/parsers/airbnb-mail/index.ts` Patterns anpassen
3. Echte Mail-Bodies (anonymisiert) als `.eml`-Files nach `src/test-fixtures/airbnb-mail/` legen
4. Body-Selektoren in den einzelnen Parsern (`confirmed-booking.ts`, etc.) anhand der echten HTML-Struktur justieren
5. Tests aktualisieren mit den echten Fixtures
6. `reparse-airbnb-mail.ts --all-errors` ausführen für Backfill
