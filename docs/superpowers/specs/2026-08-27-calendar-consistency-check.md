# Kalender-Konsistenz-Check + Hold-Sweep (Agent-API)

**Datum:** 2026-08-27 · **Auftrag:** Micha (Standup 27.08.), SmartTasks #484
**Kontext:** Die Putzcrews arbeiten ausschließlich nach den 5 Google-Buchungskalendern
(alle Properties `googleCalendar.enabled`). Der 30-Min-Sync (`sync-google-calendar.ts`)
hat keinen Kontroll-Abgleich: Fehler landen nur in pm2-Logs, verwaiste
Reservierungs-Events (Quelle kennt sie nicht mehr, kein Storno-Eintrag in `inquiries`)
werden nie erkannt. Außerdem gibt es keinen systematischen Sweep über offene/unbestätigte
Reservierungen (vergessene Holds — Muster Fall Büchler #329).

**Entscheidungen Micha (27.08.):** (a) Check läuft im Standup UND als täglicher
Server-Cron mit Alert bei Abweichung. (b) Diff meldet ALLES — auch manuell im
Google-Kalender angelegte/veränderte Events; Micha entscheidet, was korrigiert wird.

## Nicht-Ziele

- KEIN Auto-Fix, KEINE Löschungen/Schreiboperationen in Google oder den Providern.
  Der Check ist read-only und meldet nur.
- Kein UI. Konsumenten sind agent-api (Claude-Standup) und der Cron-Alert.

## Neue Endpoints (beide in `src/routes/agent-api.ts`, erben `requireAgentKey`)

### 1. `GET /api/agent/consistency-check?days=28`

Query: `days` optional, Integer 1–90, Default 28.
Fenster: `from = heute` (Property-Timezone via `toZonedTime`, wie reconcile-ical),
`to = from + days` (exklusiv).

Ablauf pro Property aus `getAllProperties()` mit `googleCalendar?.enabled && calendarId`:

1. **Erwartungsbild LIVE von der Quelle** (bewusst am DB-Cache vorbei):
   - `guesty`: `guestyClient.getReservations({ listingId, status: ['confirmed','reserved'] })`
     (der ungenutzte Statusfilter existiert bereits; Paginierung wie in `sync-inquiries.ts`,
     pageSize 100) → Reservierungs-Events. Blocks: `guestyClient.getCalendar(listingId, from, to)`
     → über den bestehenden Availability-Mapper (gleiche Klassifikation wie ETL:
     `blocks.o/m` → blocked) → `buildBlockSpans` → Block-Events.
   - `hostex`: `getHostexClient().getReservations({ propertyId })`, Status-Mapping
     IDENTISCH zum ETL via `mapHostexReservation` — nur gemappte Status
     `confirmed`/`reserved` erzeugen Reservierungs-Events (= das, was der Sync in
     Google schreibt). Blocks: `getListingCalendars({ startDate: from, endDate: to, … })`
     → `mapHostexCalendarDay` → `buildBlockSpans`.
   - `airbnb-mail`: `fetchAirbnbIcal(property.airbnbIcalUrl)` → `parseAirbnbIcal` →
     `buildAvailabilityRows` (bestehender Mapper) → booked-Intervalle
     (`block_type='reservation'`, `block_ref`=HM-Code → Event-ID wie ETL) und
     blocked-Tage → `buildBlockSpans`.
   - **Event-Identität EXAKT wie der Sync:** Reservierungen
     `toGoogleEventId(reservation_id)` (dieselbe `reservation_id`-Quelle wie der
     jeweilige ETL-Pfad!), Blocks `blockEventId(getListingId(property), span.startDate)`.
     Zeitspanne: `start = check_in(_localized).split('T')[0]`,
     `endExclusive = addOneDay(check_out…)` — identisch `buildCalendarEvent`.
   - Klipping: Ein erwartetes Event zählt, wenn sein Intervall `[start, endExclusive)`
     das Fenster `[from, to)` schneidet.
2. **Ist-Bild:** `googleCalendarClient.listEvents(calendarId, fromISO, toISO)`
   (liefert `id, summary, start, end, extendedProperties` — Feldmaske reicht).
3. **Diff** (pure function, s. u.): `missing` / `extra` / `mismatched`.
4. **Cache-Frische als Diagnose-Info:** `MAX(last_synced_at)` aus `availability`
   für die `listing_id` (neue kleine Repo-Funktion in
   `src/repositories/availability-repository.ts`:
   `getAvailabilityLastSyncedAt(listingId: string): string | null`).

Fehler eines Providers/Kalenders brechen NICHT den Gesamt-Check ab: Property bekommt
`error`-Feld, restliche Properties laufen weiter (Muster `checkAndSyncGoogleCalendar`).

**Response 200:**
```jsonc
{
  "checkedAt": "2026-08-27T06:00:00.000Z",
  "windowDays": 28,
  "from": "2026-08-27",
  "to": "2026-09-24",
  "totalIssues": 3,                     // Summe über alle Properties: missing+extra+mismatched (+1 je Property-error)
  "properties": [
    {
      "slug": "farmhouse", "name": "Farmhouse Prasser", "provider": "guesty",
      "ok": false,
      "sourceCounts": { "reservations": 4, "blockSpans": 1 },
      "googleEventCount": 6,
      "cacheLastSyncedAt": "2026-08-27T05:32:11.000Z",   // null wenn unbekannt
      "missing": [
        { "type": "reservation", "eventId": "68d…", "reservationId": "68d…",
          "guestName": "Louisa Strasser", "status": "confirmed",
          "start": "2026-10-04", "endExclusive": "2026-10-07" }
      ],
      "extra": [
        { "googleEventId": "abc…", "summary": "Handwerker vor Ort",
          "start": "2026-09-01", "end": "2026-09-02", "isOwnerBlockEvent": false }
      ],
      "mismatched": [
        { "eventId": "68e…", "summary": "…",
          "expected": { "start": "2026-09-12", "endExclusive": "2026-09-14" },
          "actual":   { "start": "2026-09-12", "endExclusive": "2026-09-15" } }
      ],
      "error": null
    }
  ]
}
```

### 2. `GET /api/agent/reservations?status=reserved,inquiry&includePast=false`

Query: `status` optional, kommaseparierte Liste aus
`confirmed|reserved|inquiry` (Default `reserved,inquiry`; unbekannter Wert →
`ValidationError`). `includePast` optional bool, Default false (nur `check_in >= heute`).

Quellen (live):
- `guesty`: EIN `getReservations({ status: [...] })`-Durchlauf OHNE `listingId`
  (paginiert) über das ganze Konto — Property-Zuordnung via
  `getPropertyByGuestyId(listingId)`; unbekannte Listings werden MIT
  `property: null` + rohem `listingId` zurückgegeben (nichts unterschlagen).
- `hostex`: `getReservations()` je Hostex-Property, `mapHostexReservation`-Status
  auf die angefragten gemappten Status gefiltert (`wait_pay→reserved`,
  `wait_accept→inquiry`).
- `airbnb-mail`: entfällt (iCal kennt keine Holds).

**Response 200:**
```jsonc
{
  "fetchedAt": "…",
  "statuses": ["reserved", "inquiry"],
  "reservations": [
    {
      "provider": "guesty",
      "reservationId": "68f…",
      "property": { "slug": "u19", "name": "Ferienwohnung Uferstraße 19", "code": "U19" },  // oder null
      "listingId": "69849a19d793670014d4a11a",
      "status": "reserved",
      "guestName": "Max Mustermann",        // null wenn nicht lieferbar
      "checkIn": "2026-09-12", "checkOut": "2026-09-14",
      "source": "direct", "confirmationCode": "RR-2026-…",   // null-fähig
      "createdAt": "2026-08-10T…"                            // Alter des Holds
    }
  ]
}
```
Sortierung: `createdAt` aufsteigend (älteste Holds zuerst).

## Täglicher Cron + Alert

- Scheduler-Muster wie `shouldRunDailyForceSync`: stündliches Interval, Guard
  `now.getHours() === 6` + `toDateString()`-Vergleich (neues State-Feld
  `consistencyCheckIntervalId` / `lastConsistencyCheck`; `clearInterval` in
  `stopScheduler()`; Registrierung am Ende von `startScheduler()`).
- Job ruft `runConsistencyCheck(28)` + `listOpenReservations(['reserved','inquiry'], false)`.
- **Alert-Mail nur bei Befund:** `totalIssues > 0` ODER mindestens ein offener Hold
  älter als 7 Tage (`createdAt < now-7d`). Versand via bestehendem
  `sendEmail({to, subject, html, text})` (`email-service.ts`, wirft nicht).
- Empfänger: neue optionale ENV `CONSISTENCY_ALERT_RECIPIENTS` (kommasepariert,
  Zod `optional`, in `src/config/index.ts` + `vitest.config.ts`-Stub NICHT nötig da
  optional). Ohne Wert: kein Mailversand, stattdessen `logger.error` je Befund
  (Muster `check-staleness.ts` — Monitoring greift Logs ab).
- Betreff: `⚠️ Kalender-Konsistenz: N Abweichungen` bzw. inkl. Hold-Hinweis.
  Body: schlichte HTML-Liste pro Property (Missing/Extra/Mismatch je eine Zeile:
  Zeitraum, Gast/Summary, Art) + Abschnitt „Offene Holds > 7 Tage".

## Datei-Struktur

- **Neu** `src/services/calendar-consistency.ts` — PURE, kein I/O:
  ```ts
  export interface ExpectedEvent {
    type: 'reservation' | 'block';
    eventId: string;              // bereits normalisiert (toGoogleEventId/blockEventId)
    reservationId?: string;
    guestName?: string | null;
    status?: string;
    start: string;                // YYYY-MM-DD
    endExclusive: string;         // YYYY-MM-DD (Google-Ganztag exklusiv)
  }
  export interface GoogleEventLite {
    id: string; summary?: string;
    start?: { date?: string; dateTime?: string };
    end?: { date?: string; dateTime?: string };
    extendedProperties?: { private?: Record<string, string> };
  }
  export interface ConsistencyDiff {
    missing: ExpectedEvent[];
    extra: Array<{ googleEventId: string; summary: string | null; start: string | null;
                   end: string | null; isOwnerBlockEvent: boolean }>;
    mismatched: Array<{ eventId: string; summary: string | null;
                        expected: { start: string; endExclusive: string };
                        actual: { start: string | null; endExclusive: string | null } }>;
  }
  export function overlapsWindow(start: string, endExclusive: string, from: string, to: string): boolean
  export function diffCalendarEvents(expected: ExpectedEvent[], actual: GoogleEventLite[]): ConsistencyDiff
  ```
  Diff-Regeln: Match über Event-ID. ID in expected & actual mit gleichen Daten → ok;
  gleiche ID, abweichendes `start.date`/`end.date` → `mismatched`; ID nur in
  expected → `missing`; Google-Event, dessen ID in keinem erwarteten Event
  vorkommt → `extra` (`isOwnerBlockEvent` = `extendedProperties.private.kind === 'owner-block'`).
  `dateTime`-Events (keine Ganztages-Events, also fremd/manuell) landen immer in
  `extra` mit dem Datumsteil als start/end. Doppelte erwartete IDs dedupen
  (Zukunft/letzter gewinnt — Verhalten wie Sync).
- **Neu** `src/jobs/consistency-check.ts` — Orchestrierung/Live-Fetch:
  ```ts
  export interface PropertyConsistencyResult { /* wie Response-Property oben */ }
  export interface ConsistencyReport { /* wie Response oben */ }
  export async function buildExpectedEventsForProperty(property: PropertyConfig, from: string, to: string): Promise<{ events: ExpectedEvent[]; sourceCounts: { reservations: number; blockSpans: number } }>
  export async function runConsistencyCheck(days: number): Promise<ConsistencyReport>
  export interface OpenReservation { /* wie Response-Eintrag Endpoint 2 */ }
  export async function listOpenReservations(statuses: string[], includePast: boolean): Promise<OpenReservation[]>
  export async function runDailyConsistencyJob(): Promise<void>   // Check + Holds + Mail/Log
  ```
- **Neu** `src/services/consistency-alert-email.ts` — pure Renderer:
  `buildConsistencyAlertEmail(report, staleHolds): { subject: string; html: string; text: string }`.
- **Ändern** `src/routes/agent-api.ts` — zwei GET-Handler nach bestehendem Muster
  (`try/catch` + `handleError`, Zod- oder Hand-Validierung der Query wie vorhanden).
- **Ändern** `src/repositories/availability-repository.ts` — `getAvailabilityLastSyncedAt`.
- **Ändern** `src/jobs/scheduler.ts` — täglicher Job 06:00 (Muster oben).
- **Ändern** `src/config/index.ts` — `consistencyAlertRecipients: string[]` aus ENV
  (optional, Default `[]`).

## Tests (Vitest, Datei neben Quelle, `<name>.test.ts`)

1. `calendar-consistency.test.ts` — Kernstück, vollständig:
   ok-Fall, missing (Reservierung + Block), extra (manuelles Ganztags-Event,
   `dateTime`-Event, verwaistes App-Event), mismatched (Enddatum weicht ab),
   Fenster-Klipping (`overlapsWindow`: Event ragt hinein/hinaus/außerhalb),
   Dedupe doppelter erwarteter IDs, owner-block-Flag.
2. `consistency-check.test.ts` — `buildExpectedEventsForProperty` je Provider mit
   gemockten Clients (`vi.mock` auf `guesty-client.js`, `hostex-client.js`,
   `ical-fetcher.js`; Fixtures aus `fixtures/` bzw. `src/test-fixtures/hostex/`
   wiederverwenden); `runConsistencyCheck` mit gemocktem
   `googleCalendarClient.listEvents`; Fehler eines Providers → `error`-Feld,
   andere Properties laufen weiter. `listOpenReservations`: Statusfilter,
   `includePast`, unbekanntes Guesty-Listing → `property: null`.
3. `consistency-alert-email.test.ts` — Betreff/Body enthalten Befunde; leerer
   Report → kein Versandfall (Funktion, die entscheidet, testen).
4. `agent-api.test.ts` erweitern — beide Routen: 200-Form, `days`-Validierung
   (0, 91, NaN → 400), `status`-Validierung, Auth greift (bestehendes Muster).
   Achtung Mocks: `vi.mock('../config/index.js', …)` + Logger-Mock-Muster aus der
   bestehenden `agent-api.test.ts` übernehmen.

## Constraints

- Rate-Limits Guesty beachten: Der Check macht pro Guesty-Property ≤ 3 Calls
  (Reservations-Pages + 1 Kalender) — im Rahmen der Bottleneck-Queue, KEINE
  zusätzlichen Delays nötig. Keine neuen Abhängigkeiten (kein node-cron etc.).
- TypeScript strikt, bestehende Fehler-Klassen (`ValidationError` → 400).
- Vergleiche/Formate exakt an `sync-google-calendar.ts` ausrichten — der Check
  muss dieselbe Erwartung berechnen wie der Sync schreibt, sonst false positives.
- `airbnbIcalUrl` ist ein Secret: nie voll loggen (Muster `ical-fetcher.ts`).
- Read-only: keine Schreib-Calls auf Google/Guesty/Hostex.
