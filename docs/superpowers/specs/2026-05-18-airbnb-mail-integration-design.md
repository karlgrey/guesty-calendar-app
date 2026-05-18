# Airbnb-Mail Integration — Design Spec

**Datum:** 2026-05-18
**Status:** Draft — awaiting user review
**Scope:** Dritter Booking-Provider „airbnb-mail" neben Guesty und Hostex, für eine Property, die ausschließlich auf Airbnb läuft (kein Channel-Manager). Datenquellen: IMAP-Inbox (Buchungs-Mails) + iCal-URL (Verfügbarkeitskalender).

---

## 1. Motivation

Eine der Properties (genaue Property kommt zur Deploy-Zeit) ist nur über Airbnb buchbar und wird **nicht** über Guesty oder Hostex geroutet. Alle Buchungs-Mails landen an einer dedizierten Forwarding-Adresse (Google-Groups-Verteiler), und Airbnb stellt eine private iCal-URL bereit, die Verfügbarkeits-Slots exportiert.

**Daten-Scope** (vom User definiert):
- Reservierungen (Gast, Daten, Personenzahl, Preise inkl. Host-Payout)
- Inquiries (Anfragen, die noch nicht akzeptiert sind)
- Verfügbarkeitskalender
- **Nicht im Scope**: Tagespreise (Airbnb teilt sie nicht via API/iCal mit)

**Constraints**:
- Architektur soll im bestehenden Pattern bleiben (`provider`-Discriminator in `properties.json`, ETL-Dispatch in `etl-job.ts`)
- Bestehende Logik (Guesty + Hostex) darf nicht beeinträchtigt werden
- Polling-Frequenz max 5 Min für Mails ist akzeptabel
- 1 Property initial; falls später mehrere airbnb-mail Properties hinzukommen, redesign

---

## 2. Architektur

**Strategie:** Parallele Module unter `src/.../airbnb-mail/`, ohne Guesty- oder Hostex-Code zu refactoren.

### 2.1 Datei-Layout

```
src/
├── services/
│   └── airbnb-mail/
│       ├── imap-client.ts          [NEU — IMAP-Verbindung, Mail-Fetch]
│       └── ical-fetcher.ts         [NEU — HTTPS-GET der Airbnb iCal-URL]
├── parsers/airbnb-mail/             [NEU]
│   ├── index.ts                    [Type-Dispatcher, Subject-Erkennung]
│   ├── confirmed-booking.ts
│   ├── booking-inquiry.ts
│   ├── cancellation.ts
│   ├── modification.ts
│   └── ical-parser.ts              [node-ical Wrapper]
├── types/
│   └── airbnb-mail.ts              [NEU — ParsedAirbnbMail, AirbnbIcalEvent]
├── mappers/airbnb-mail/             [NEU]
│   ├── property-mapper.ts          [static config → internal Listing]
│   ├── reservation-mapper.ts       [ParsedMail → Reservation + Inquiry]
│   └── availability-mapper.ts      [iCal-Event → Availability]
├── jobs/airbnb-mail/                [NEU]
│   ├── sync-mail.ts                [IMAP-poll → archive → parse → persist]
│   ├── sync-ical.ts                [iCal-fetch → parse → persist availability]
│   └── sync-properties.ts          [static config → upsert listing]
├── repositories/
│   └── airbnb-mail-archive-repository.ts  [NEU]
├── scripts/
│   ├── test-airbnb-mail-sync.ts    [NEU — manueller ETL-Test pro Property]
│   └── reparse-airbnb-mail.ts      [NEU — Re-Parse einer archivierten Mail]
├── db/migrations/
│   └── 013_add_airbnb_mail_archive.sql  [NEU]
├── test-fixtures/
│   └── airbnb-mail/                [NEU — anonymisierte .eml-Beispiele + iCal]
├── jobs/etl-job.ts                  [MOD: Dispatch für provider='airbnb-mail']
├── config/properties.ts             [MOD: Schema erweitern]
└── config/index.ts                  [MOD: AIRBNB_MAIL_* env-vars]
```

### 2.2 Provider-agnostisch (unverändert)

DB-Schema (existing Tabellen), Repositories für Listings/Reservations/Inquiries/Availability, Routes, Frontend, Admin-Dashboard, Email-Reports, Guest-Fingerprint, Scheduler.

### 2.3 Externe Abhängigkeiten

- `imapflow` (npm): moderne, gut gewartete IMAP-Client-Library
- `node-ical` (npm): iCalendar-Parser
- `mailparser` (npm): Multipart-MIME / HTML-Body-Extraktion
- `cheerio` (npm): server-side jQuery-like HTML-DOM-Queries (für Body-Selektoren in Mail-Parsern)

---

## 3. `properties.json` Schema-Erweiterung + `.env`

### 3.1 Property-Config

```jsonc
{
  "slug": "schiffmuehle-xyz",
  "provider": "airbnb-mail",
  "name": "Schiffmühle XYZ",
  "timezone": "Europe/Berlin",
  "currency": "EUR",
  "bookingRecipientEmail": "...",
  "bookingSenderName": "...",
  "weeklyReport": { "enabled": true, "recipients": [...], "day": 1, "hour": 6 },
  "googleCalendar": { "enabled": true, "calendarId": "...", "checkInTime": "15:00", "checkOutTime": "12:00" },

  "airbnbListingId": "123456789",
  "airbnbIcalUrl": "https://www.airbnb.com/calendar/ical/123...secret-key.ics",

  "static": {
    "accommodates": 4,
    "bedrooms": 2,
    "bathrooms": 1,
    "propertyType": "Apartment",
    "cleaningFee": 30,
    "extraPersonFee": 0,
    "guestsIncluded": 4,
    "weeklyPriceFactor": 0.9,
    "monthlyPriceFactor": 0.8,
    "taxes": [],
    "basePrice": null,
    "minNights": null,
    "maxNights": null
  }
}
```

### 3.2 Zod-Refinements (in `src/config/properties.ts`)

- `provider` enum erweitern um `'airbnb-mail'`
- Wenn `provider === 'airbnb-mail'`:
  - `airbnbListingId` (String) und `airbnbIcalUrl` (URL) sind **Pflicht**
  - `static` mit `accommodates` als Pflicht (wie bei Hostex)
- Bestehende Guesty- und Hostex-Refinements unverändert

### 3.3 Neue env-vars

```
AIRBNB_MAIL_HOST=imap.gmail.com
AIRBNB_MAIL_PORT=993
AIRBNB_MAIL_USER=airbnb-bot@deinedomain.com
AIRBNB_MAIL_PASSWORD=app-password-from-google-workspace
```

Alle vier sind optional. Wenn mindestens eine airbnb-mail Property konfiguriert ist, sind alle vier Pflicht → Boot-Error mit klarer Meldung.

### 3.4 Neue Helper-Funktion

```ts
export function getPropertiesByProvider(provider: 'guesty' | 'hostex' | 'airbnb-mail'): PropertyConfig[]
```
(existing function, signature erweitert)

---

## 4. IMAP-Client + Mail-Parser

### 4.1 IMAP-Client (`src/services/airbnb-mail/imap-client.ts`)

```ts
class AirbnbImapClient {
  constructor(config: { host: string; port: number; user: string; password: string; mailbox?: string });

  async connect(): Promise<void>
  async fetchNewMails(sinceUid: number): Promise<RawMail[]>  // Mails mit UID > sinceUid
  async disconnect(): Promise<void>
}

interface RawMail {
  uid: number;
  messageId: string;
  subject: string;
  fromAddress: string;
  receivedAt: string;  // ISO 8601
  htmlBody: string;
  textBody: string;
}
```

Verwendet `imapflow` für IMAP, `mailparser` für MIME-Parsing.

### 4.2 Mail-Type-Erkennung (`src/parsers/airbnb-mail/index.ts`)

```ts
type AirbnbMailType = 'confirmed' | 'inquiry' | 'cancellation' | 'modification' | 'unknown';

function detectType(subject: string): AirbnbMailType {
  const s = subject.toLowerCase();
  if (/reservierung best[äa]tigt|buchung best[äa]tigt|✓ reserviert/.test(s)) return 'confirmed';
  if (/anfrage von|buchungsanfrage|möchte buchen/.test(s)) return 'inquiry';
  if (/storniert|stornierung|abgesagt/.test(s)) return 'cancellation';
  if (/datum geändert|änderung|aktualisiert/.test(s)) return 'modification';
  return 'unknown';
}
```

**Wichtig**: Die exakten Subject-Patterns kommen aus echten Beispiel-Mails — der User leitet 2–3 echte Mails pro Type zur Implementierung weiter. Die obigen Patterns sind eine Anfangsschätzung und werden im Implementierungs-Plan verifiziert.

### 4.3 Parser-Architektur

Jeder Parser ist eine Datei mit Funktion `parse(rawMail: RawMail) → ParsedAirbnbMail | null`. Nutzt:
- `cheerio` für HTML-DOM-Queries auf `htmlBody`
- Regex-Fallback auf `textBody` falls HTML-Selectors versagen

Output:
```ts
interface ParsedAirbnbMail {
  type: 'confirmed' | 'inquiry' | 'cancellation' | 'modification';
  reservationCode: string;     // Airbnb HM-Code (z.B. "HMABCXYZ")
  guestName: string;
  checkIn: string;             // YYYY-MM-DD
  checkOut: string;
  numberOfGuests?: number;
  numberOfAdults?: number;
  numberOfChildren?: number;
  totalPrice?: number;         // Gast-Brutto
  hostPayout?: number;         // aus Aufschlüsselung
  cleaningFee?: number;
  serviceFee?: number;         // Airbnb-Service-Fee
  receivedAt: string;
  messageId: string;           // für Dedupe
}
```

### 4.4 Unbekannte / Unparseable Mails

- Speicherung in `airbnb_mail_archive` mit `parse_status='error'` und `parse_error`-Text
- WARN-Log mit Subject, Message-ID, From
- Manuelles Re-Parse via `reparse-airbnb-mail.ts <message_id>` möglich

---

## 5. iCal-Sync

### 5.1 Fetcher (`src/services/airbnb-mail/ical-fetcher.ts`)

```ts
async function fetchIcal(url: string): Promise<string>  // raw ICS body
```

HTTPS-GET mit User-Agent, 3 Retries bei 5xx, ExternalApiError bei finalem Fail.

### 5.2 Parser (`src/parsers/airbnb-mail/ical-parser.ts`)

Wrapper um `node-ical` mit normalisiertem Output:
```ts
interface AirbnbIcalEvent {
  uid: string;            // z.B. "HMABCXYZ@airbnb.com"
  reservationCode: string; // extrahiert aus UID: "HMABCXYZ"
  startDate: string;       // YYYY-MM-DD (DTSTART)
  endDate: string;         // YYYY-MM-DD (DTEND, exclusive)
  summary: string;         // "Reserved" oder "Airbnb (Not available)"
}
```

### 5.3 Availability-Mapping

Pro Tag im 24-Monats-Fenster (heute → +24 Monate):
- Wenn ein Event den Tag überlappt (`startDate ≤ day < endDate`):
  - `status = 'booked'`
  - `block_type = 'reservation'`
  - `block_ref = reservationCode`
- Sonst:
  - `status = 'available'`

Felder ohne iCal-Quelle:
- `price` ← `listings.base_price` (aus static config, fallback 0)
- `min_nights` ← `listings.min_nights` (default 1)
- `closed_to_arrival` / `closed_to_departure` ← `false` (Airbnb iCal hat das nicht)

### 5.4 Reservation-Verknüpfung

`block_ref` enthält den Reservation-Code aus iCal. Wenn die Mail zur Reservation noch nicht eingetroffen ist (z.B. iCal kommt früher als Mail-Sync), existiert `reservations`-Row noch nicht. Beim nächsten Mail-Sync wird die Reservation angelegt, und der iCal-Block-Ref ist bereits korrekt — kein Backfill nötig.

### 5.5 Sync-Frequenz

Stündlich (gleiches Intervall wie Guesty/Hostex). Airbnb-iCal ändert sich nicht häufig genug für höhere Frequenz.

---

## 6. DB-Migration + Storage

### 6.1 Migration `013_add_airbnb_mail_archive.sql`

```sql
-- Migration: Airbnb mail archive (raw email storage + parse status)
-- Created: 2026-05-18
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
  parse_status TEXT NOT NULL,            -- pending/ok/error
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

### 6.2 Cleanup-Job

Am Ende jedes IMAP-Sync:
```sql
DELETE FROM airbnb_mail_archive WHERE created_at < datetime('now', '-90 days');
```

### 6.3 Repository (`src/repositories/airbnb-mail-archive-repository.ts`)

```ts
export function insertMail(row: NewMailRow): void                    // ON CONFLICT (message_id) DO NOTHING
export function updateParseStatus(messageId: string, status: 'ok' | 'error', error?: string, reservationCode?: string): void
export function getMail(messageId: string): MailRow | null            // für Reparse-Script
export function pruneOldMails(olderThanDays: number): number          // 90-Tage Cleanup
export function getLastUid(propertySlug: string): number              // inkrementeller Poll
export function setLastUid(propertySlug: string, uid: number): void
```

### 6.4 Bestehende Tabellen

- `listings` — bekommt 1 neue Row mit `id = airbnbListingId`. Befüllt durch `property-mapper.ts` aus `properties.json static`.
- `reservations` — Parsed-Confirmed-Mails landen hier mit `source='airbnb'`, `platform='airbnb-mail'`.
- `inquiries` — alle Mail-Types (confirmed, inquiry, cancellation, modification) landen hier als BI-Pool, mit gemapptem Status.
- `availability` — iCal-derived rows.

**Keine bestehenden Tabellen geändert.**

---

## 7. ETL-Dispatch

### 7.1 `runETLJobForProperty` in `etl-job.ts`

```ts
if (property.provider === 'airbnb-mail') {
  return runAirbnbMailETL(property, force);
}
```

Vor den bestehenden Guesty/Hostex-Pfaden.

### 7.2 `runAirbnbMailETL(property, force)`

```
1. syncAirbnbProperty(property)
   → Property-Mapper aus static config → listings UPSERT
2. syncAirbnbMail(property)
   → IMAP poll (alle Mails seit airbnb_mail_state.last_imap_uid)
   → für jede Mail:
       a. Insert in airbnb_mail_archive (parse_status='pending')
       b. Detect type aus subject
       c. Parse via passenden Parser
       d. Update airbnb_mail_archive (parse_status='ok' oder 'error')
       e. Bei type='confirmed' oder 'modification':
          → Upsert in inquiries (mit gemapptem Status)
          → Upsert in reservations (active)
       f. Bei type='inquiry':
          → Upsert in inquiries als status='inquiry'
       g. Bei type='cancellation':
          → Upsert in inquiries als status='canceled'
          → Delete from reservations falls vorhanden
   → Update airbnb_mail_state.last_imap_uid
   → Prune airbnb_mail_archive (>90 Tage)
3. syncAirbnbIcal(property)
   → HTTPS-GET iCal-URL
   → Parse Events
   → Map zu Availability-Rows (24 Monate Window, heute → +24mo)
   → Upsert in availability
   → deleteOldAvailability (vor heute)
```

### 7.3 Status-Routing

| Mail-Type | Internal (inquiries.status) | In reservations? (status) |
|---|---|---|
| `confirmed` | `confirmed` | ja, als `confirmed` |
| `inquiry` | `inquiry` | nein |
| `cancellation` | `canceled` | nein (gelöscht falls vorhanden) |
| `modification` | `confirmed` (mit aktualisierten Daten) | ja, als `confirmed` (Upsert auf reservation_code) |
| `unknown` | wird nicht zu Inquiries / Reservations geschrieben — bleibt im Archiv mit parse_status='error' | — |

---

## 8. Error-Handling

### 8.1 API-Layer

| Fehler | Verhalten |
|---|---|
| IMAP-Connect (TLS/Auth) | 3 Retries mit 1s/2s/4s Backoff, dann ExternalApiError, property-fail isoliert |
| IMAP-Fetch (einzelne Mail Read-Fehler) | Mail wird übersprungen + WARN-Log, Loop fährt mit nächster Mail fort; betroffene Mail bleibt im Server bis zum nächsten Sync (nicht in Archive gelandet, weil Read fehlschlug) |
| iCal-HTTP-Fehler (5xx) | 3 Retries, dann ExternalApiError, iCal-Sync-Step failed (Mail-Sync ist bereits durch) |
| iCal-Parse-Error | property-fail isoliert |

### 8.2 Mail-Parser-Layer

- Unbekannter Subject-Pattern → `type='unknown'`, in Archiv mit `parse_status='error'`, WARN-Log
- Regex-/Selector-Mismatch in Parser → `parse_status='error'`, error message persistiert, WARN-Log
- Mail wird trotzdem deduped (message_id unique) — kein erneutes Parsen ohne `--force` Flag im Reparse-Script

### 8.3 Boot-Validation

- airbnb-mail Property konfiguriert + `AIRBNB_MAIL_*` env-vars fehlen → Boot-Error
- Zod-Validation-Fehler in properties.json → Boot-Error mit Pfad-Hinweis

### 8.4 IMAP-Account-Status

Wenn Google Workspace das App-Passwort widerruft (z.B. Sicherheits-Event), schlägt jeder Sync mit Auth-Error fehl. Wir loggen WARN (kein dauerhaftes ERROR-Spam) und benachrichtigen via Admin-Dashboard (Health-Status). User muss manuell intervenieren.

---

## 9. Testing

### 9.1 Unit-Tests (Vitest)

| Datei | Was getestet |
|---|---|
| `src/parsers/airbnb-mail/index.test.ts` | `detectType()` für alle 4 + unknown, mit Subject-Variationen |
| `src/parsers/airbnb-mail/confirmed-booking.test.ts` | Echte anonymisierte `.eml`-Fixtures, Edge-Cases (Sonderzeichen, mehrere Gäste) |
| `src/parsers/airbnb-mail/booking-inquiry.test.ts` | wie oben |
| `src/parsers/airbnb-mail/cancellation.test.ts` | wie oben |
| `src/parsers/airbnb-mail/modification.test.ts` | wie oben |
| `src/parsers/airbnb-mail/ical-parser.test.ts` | echte iCal-Files, multi-event, UID-Extraktion |
| `src/mappers/airbnb-mail/reservation-mapper.test.ts` | Status-Routing, Guest-Fingerprint-Integration |
| `src/mappers/airbnb-mail/availability-mapper.test.ts` | booked/available, overlap-detection |
| `src/mappers/airbnb-mail/property-mapper.test.ts` | static config → Listing, alle Felder |
| `src/config/properties.test.ts` | Zod-Refinements für `provider='airbnb-mail'` |

### 9.2 Test-Fixtures

- `src/test-fixtures/airbnb-mail/*.eml` — anonymisierte echte Mails (Gast-Daten maskiert)
- `src/test-fixtures/airbnb-mail/calendar.ics` — echte iCal-Antwort (UIDs anonymisiert wenn nötig)

### 9.3 Manueller Test

`src/scripts/test-airbnb-mail-sync.ts <slug>` (analog `test-hostex-sync.ts`):
- Führt vollen ETL aus
- Zeigt Result + DB-Sanity-Check (listings, reservations, inquiries, availability)

### 9.4 Re-Parse-Tool

`src/scripts/reparse-airbnb-mail.ts <message_id> [--force]`:
- Holt Raw-Mail aus `airbnb_mail_archive`
- Detect Type, parsed neu, schreibt Daten in `inquiries`/`reservations`
- Setzt `parse_status` neu
- `--force` re-parsed auch bei bestehendem `parse_status='ok'` (für Bug-Fix-Replay)

---

## 10. Deployment

Reihenfolge auf Production (analog zu Hostex-Deploy):

1. **`AIRBNB_MAIL_*` env-vars** in `/opt/guesty-calendar-app/.env` ergänzen
2. **`properties.json`** um airbnb-mail Property erweitern (mit `provider`, `airbnbListingId`, `airbnbIcalUrl`, `static`)
3. **Google-Workspace-User** anlegen (z.B. `airbnb-bot@...`), App-Passwort erstellen
4. **Google-Groups-Verteiler**: `airbnb-bot@...` als zusätzlichen Empfänger hinzufügen
5. **Deploy**: `git pull && npm install && npm run build && pm2 restart guesty-calendar`
6. **Boot-Check**: `pm2 logs guesty-calendar --lines 20` → Migration 013 applied, kein Zod-Error
7. **Health-Check**: `curl https://guesty.remoterepublic.com/health`
8. **Manueller Test-Sync**: `npx tsx src/scripts/test-airbnb-mail-sync.ts <slug>`
9. **Sanity-Check** in SQL:
   ```sql
   SELECT id, title, accommodates FROM listings WHERE id = '<airbnbListingId>';
   SELECT COUNT(*) FROM reservations WHERE listing_id = '<airbnbListingId>';
   SELECT COUNT(*) FROM inquiries WHERE listing_id = '<airbnbListingId>';
   SELECT COUNT(*) FROM availability WHERE listing_id = '<airbnbListingId>';
   SELECT COUNT(*), parse_status FROM airbnb_mail_archive GROUP BY parse_status;
   ```
10. **24h PM2-Log-Monitoring** für WARN/ERROR — besonders `parse_status='error'`-Mails

### 10.1 Rollback

1. Property aus `properties.json` entfernen
2. `pm2 restart` — ETL ignoriert sie
3. DB-Rows können stehenbleiben oder via SQL gelöscht werden
4. Migration 013 bleibt drin (additive, kein Schaden)

---

## 11. Bewusst nicht im Scope (YAGNI)

- **Tagespreise**: Airbnb stellt sie nicht via iCal oder Mail bereit. Property-Level base_price aus static config oder NULL.
- **Auszahlungs-Mails**: Buchungsbestätigungs-Mails enthalten bereits `host_payout` (vom User bestätigt). Payout-Mails überflüssig.
- **Mehrere airbnb-mail Properties**: Initial 1 Property. Falls später mehrere kommen, redesign (Mail-Disambiguation per Listing-ID im Body).
- **Webhook-basierter Mail-Ingress** (Resend Inbound, Mailgun): IMAP-Poll mit 5-Min-Frequenz reicht für Booking-Calendar. Webhooks später wenn echtes Realtime-Bedürfnis.
- **Airbnb-Property-API**: gibt es nicht. Stammdaten kommen aus `static` config.
- **Inquiry-Antwort-Workflow**: das System erfasst Inquiries, sendet aber keine Antworten an Airbnb. Host antwortet weiterhin in der Airbnb-App.
- **OAuth statt App-Password**: Google OAuth für Workspace-User ist möglich, aber für eine dedizierte Bot-Inbox ist App-Password einfacher und ausreichend.

---

## 12. Future Work

- **Webhook-Ingress** falls Airbnb-Mail-Volumen so hoch wird, dass 5-Min-Polling spürbar lagt
- **Multi-Property-Support**: Mail-Disambiguation per Airbnb-Listing-ID im Body
- **Auszahlungs-Reconciliation**: Vergleich der `host_payout`-Schätzung aus Confirmed-Mail mit echter Auszahlung
- **Self-Healing-Parser**: bei `parse_status='error'` automatisch alle bekannten Parser durchtesten, nicht nur den vom Subject-Detect bestimmten
- **Replay-Tool** mit Bulk-Mode: alle archivierten error-Mails neu parsen nach Parser-Update

---

## 13. Offene Punkte für Implementation

- **Echte Subject-Patterns**: Aus 2-3 echten anonymisierten Mails pro Type extrahieren — die in Section 4.2 aufgelisteten Patterns sind Schätzungen.
- **HTML-Selektoren in Parsern**: Airbnb-Templates haben Struktur (z.B. table-Layout, Inline-Styles), die wir mit `cheerio` auslesen. Konkrete Selektoren erst nach Inspektion echter Mails.
- **Cleaning-Fee-Extraktion**: ob die aufgeschlüsselten Beträge ausgewiesen sind, muss verifiziert werden.
- **Modification-Mail-Format**: enthält die ggf. nur Diff (alte vs neue Daten) oder kompletter Snapshot? Bei Diff: Mapper muss bestehende Reservation lesen und Diff anwenden.
- **iCal-Cache-Headers**: Airbnb iCal-URL hat ggf. `ETag` / `Last-Modified`. Wenn ja, sparen wir Bandwidth via Conditional-GET. Optimierung, nicht Pflicht.
- **App-Password-Setup-Doku**: Schritt-für-Schritt-Anleitung für Google-Workspace-Admin (App-Password generieren) — für CLAUDE.md.
