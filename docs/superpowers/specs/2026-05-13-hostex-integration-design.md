# Hostex-Integration — Design Spec

**Datum:** 2026-05-13
**Status:** Draft — awaiting user review
**Scope:** Anbindung von Hostex.io als zweiter Booking-Provider neben Guesty, mit Pfad zum mittelfristigen Komplettwechsel

---

## 1. Motivation

Der User hat drei weitere Properties (Alte Schilderwerkstatt, Bootshaus an der alten Oder, Luxury Loft Firenze), die nicht auf Guesty, sondern auf [Hostex.io](https://hostex.io) angebunden sind. Mittelfristiges Ziel: Komplettwechsel zu Hostex, dann Guesty-Module aus dem Codebase entfernen.

**User-Constraints:**
- Bestehende Logik darf nicht beeinträchtigt werden (analog zum Guest-Fingerprint-Feature)
- Polling, keine Webhooks (Hostex Webhooks sind single-attempt mit 3s-Timeout → zu riskant)
- Status-Mapping muss in Production verifizierbar sein, weil das Test-Sample auf Hostex nur `accepted`-Reservierungen enthielt (alle anderen Status haben 0 Treffer)

Diese Spec definiert ein **paralleles Modul-System** für Hostex, ohne Refactoring des Guesty-Codes. Endgame: Guesty-Files gezielt löschen.

---

## 2. Architektur

**Strategie:** „Hostex-First, Guesty als Legacy bis Cleanup". Parallele Module unter `src/.../hostex/`, Dispatch über ein neues `provider`-Feld in `properties.json`.

### 2.1 Datei-Layout

```
src/
├── services/
│   ├── guesty-client.ts           [unverändert]
│   └── hostex-client.ts           [NEU]
├── types/
│   ├── guesty.ts                  [unverändert]
│   └── hostex.ts                  [NEU — API-Response-Typen]
├── mappers/
│   ├── (Guesty-Mapper bleiben)    [unverändert]
│   └── hostex/
│       ├── property-mapper.ts     [NEU]
│       ├── reservation-mapper.ts  [NEU]
│       └── calendar-mapper.ts     [NEU]
├── jobs/
│   ├── etl-job.ts                 [MOD: dispatch nach provider]
│   ├── (Guesty sync-*)            [unverändert]
│   └── hostex/
│       ├── sync-properties.ts     [NEU]
│       ├── sync-reservations.ts   [NEU]
│       └── sync-calendar.ts       [NEU]
├── config/
│   ├── properties.ts              [MOD: Zod-Schema erweitert]
│   └── index.ts                   [MOD: HOSTEX_ACCESS_TOKEN env-var]
└── test-fixtures/
    └── hostex/                    [NEU: API-Response-Beispiele für Tests]
```

### 2.2 Provider-agnostisch (bleibt unverändert)

- DB-Schema (alle Tabellen `listing_id`-keyed, provider-neutral)
- Repositories (Listings, Reservations, Inquiries, Availability, Documents)
- Routes (`/p/:slug/*`)
- Frontend / Admin-Dashboard / Weekly-Email / GA4-Sync / Google-Calendar-Sync
- Guest-Fingerprint (wird im Hostex-Reservation-Mapper wiederverwendet)
- Scheduler

### 2.3 Endgame (Cleanup nach Komplettwechsel)

Wenn alle Properties zu Hostex migriert sind:
1. `src/services/guesty-client.ts`, `src/types/guesty.ts`, `src/mappers/{listing,reservation,availability}-mapper.ts`, `src/jobs/sync-{listing,availability,inquiries}.ts` löschen
2. `provider`-Feld in properties.json entfernen
3. ETL-Job-Dispatch entfernen, direkt Hostex aufrufen
4. Guesty-spezifische Env-Vars (GUESTY_CLIENT_ID, GUESTY_CLIENT_SECRET, GUESTY_PROPERTY_ID, etc.) entfernen

---

## 3. `properties.json` Schema-Erweiterung

### 3.1 Schema

```jsonc
{
  "properties": [
    // Bestehende Guesty-Property — unverändert
    {
      "slug": "farmhouse",
      "provider": "guesty",
      "guestyPropertyId": "686d1e927ae7af00234115ad",
      "name": "Farmhouse Prasser",
      "timezone": "Europe/Berlin",
      "currency": "EUR",
      "bookingRecipientEmail": "booking@farmhouse-prasser.de",
      "bookingSenderName": "Farmhouse Prasser",
      "weeklyReport": { "enabled": true, "recipients": ["..."], "day": 1, "hour": 6 },
      "ga4": { "enabled": true, "propertyId": "513788097", ... },
      "googleCalendar": { "enabled": true, "calendarId": "...", ... }
    },
    // Neue Hostex-Property
    {
      "slug": "alte-schilderwerkstatt",
      "provider": "hostex",
      "hostexPropertyId": "12659676",
      "name": "Alte Schilderwerkstatt",
      "timezone": "Europe/Berlin",
      "currency": "EUR",
      "bookingRecipientEmail": "...",
      "bookingSenderName": "...",
      "weeklyReport": { ... },
      "googleCalendar": { ... },

      "static": {
        "accommodates": 4,
        "bedrooms": 2,
        "bathrooms": 1,
        "propertyType": "Apartment",
        "extraPersonFee": 25,
        "guestsIncluded": 2,
        "weeklyPriceFactor": 0.9,
        "monthlyPriceFactor": 0.8,
        "taxes": [
          { "type": "VAT", "amount": 7, "units": "PERCENTAGE",
            "quantifier": "PER_NIGHT", "appliedOnFees": ["AF","CF"] }
        ],
        "basePrice": null,
        "cleaningFee": null,
        "minNights": null,
        "maxNights": null
      }
    }
  ]
}
```

### 3.2 Zod-Refinement-Regeln

- `provider` ist optional, defaultet auf `"guesty"` → Backwards-Compat für bestehende Properties (farmhouse, u19)
- Wenn `provider === "guesty"`:
  - `guestyPropertyId` ist **Pflicht**
  - `static` muss leer/abwesend sein
- Wenn `provider === "hostex"`:
  - `hostexPropertyId` ist **Pflicht** (String, da Hostex-API numerische IDs liefert, wir speichern als String)
  - `static` muss **vorhanden** sein
  - `static.accommodates` ist **Pflicht** (kritisch für Quote-Berechnung)
  - alle anderen `static`-Felder optional
- Bei Validierungs-Fehler: Boot-Error mit klarer Meldung (Pino), Server startet nicht

### 3.3 Neue Helper-Funktionen in `src/config/properties.ts`

```ts
export function getPropertiesByProvider(provider: 'guesty' | 'hostex'): PropertyConfig[]
```

Bestehende Helper (`getPropertyBySlug`, `getAllProperties`, `getDefaultProperty`) bleiben unverändert.

---

## 4. Hostex Client (`src/services/hostex-client.ts`)

### 4.1 Klasse

```ts
class HostexClient {
  private readonly baseUrl = 'https://api.hostex.io/v3';
  private readonly accessToken: string;
  private readonly limiter: Bottleneck;

  constructor(accessToken: string = config.hostexAccessToken) { ... }

  async getProperties(): Promise<HostexProperty[]>
  async getReservations(opts: {
    propertyId?: string;
    startCheckIn?: string;
    endCheckIn?: string;
    limit?: number;
  }): Promise<HostexReservation[]>
  async getListingCalendars(opts: {
    startDate: string;
    endDate: string;
    listings: Array<{ channel_type: string; listing_id: string }>;
  }): Promise<HostexCalendarResponse>
}
```

### 4.2 Wrapper-Auspack zentralisiert

```ts
private async call<T>(path: string, init?: RequestInit): Promise<T> {
  const json = await this.fetchWithRetry(path, init);
  if (json.error_code !== 200) {
    throw new ExternalApiError(
      `Hostex ${json.error_code}: ${json.error_msg} (request_id=${json.request_id})`
    );
  }
  return json.data as T;
}
```

Jeder Aufrufer arbeitet direkt mit `data`, nicht dem Wrapper-Objekt.

### 4.3 Pagination

`getReservations()` schleift intern durch:
```
offset = 0
while (true):
  batch = call(`/reservations?offset=${offset}&limit=100`)
  results.push(...batch.reservations)
  if batch.reservations.length < 100: break
  offset += 100
```
Caller bekommt das volle Array.

### 4.4 Rate-Limiting & Retries

- **Bottleneck**:
  ```
  reservoir: 60
  reservoirRefreshAmount: 60
  reservoirRefreshInterval: 60_000  // 60/min (well under 1200/min host-cap)
  maxConcurrent: 10
  minTime: 1000  // 1s between requests (Hostex best-practice)
  ```
- **429-Handling**: Exponential Backoff 1s → 2s → 4s → 8s → 16s, max 5 Retries, dann `ExternalApiError`. Da Hostex kein `Retry-After` liefert, festes Pattern.
- **5xx und Netzwerk-Fehler**: 3 Retries mit 1s/2s/4s Backoff, dann `ExternalApiError`.

### 4.5 Token-Handling

- env-var `HOSTEX_ACCESS_TOKEN` (zod-validiert in `src/config/index.ts`, **optional**)
- Wenn `getAllProperties().some(p => p.provider === 'hostex')` aber Token fehlt → Boot-Error mit klarer Meldung
- Lokal: `.env.hostex` (gitignored) zum Testen. Production: in der bestehenden `.env`-Datei

---

## 5. Mapper-Strategie

Drei pure functions unter `src/mappers/hostex/`.

### 5.1 `property-mapper.ts`

```ts
mapHostexProperty(args: {
  hostexProperty: HostexProperty;
  propertyConfig: PropertyConfig;
  recentReservations: HostexReservation[];  // letzte 20 für cleaning_fee
  calendarSample: HostexCalendarDay[];       // 30 Tage für base_price/min_nights
}): Omit<Listing, 'created_at' | 'updated_at'>
```

**Befüllungs-Reihenfolge (Static-First mit Dynamic-Fallback):**

| Feld | Quelle 1 (priority) | Quelle 2 (fallback) | Quelle 3 (final) |
|---|---|---|---|
| `id` | `hostexProperty.id.toString()` | — | — |
| `title` | `hostexProperty.title` | — | — |
| `nickname` | `propertyConfig.name` | `hostexProperty.title` | — |
| `accommodates` | `static.accommodates` (Pflicht) | **Error** | — |
| `bedrooms` | `static.bedrooms` | `null` | — |
| `bathrooms` | `static.bathrooms` | `null` | — |
| `property_type` | `static.propertyType` | `null` | — |
| `timezone` | `hostexProperty.timezone` | `propertyConfig.timezone` | `'Europe/Berlin'` |
| `currency` | `propertyConfig.currency` | `hostexProperty.channels[0].currency` | `'EUR'` |
| `base_price` | `static.basePrice` | **median** Tagespreis aus 30-Tage Calendar | `0` + WARN |
| `cleaning_fee` | `static.cleaningFee` | **median** CLEANING_FEE aus letzten 20 Reservations | `0` |
| `extra_person_fee` | `static.extraPersonFee` | `0` | — |
| `guests_included` | `static.guestsIncluded` | `static.accommodates` | — |
| `weekly_price_factor` | `static.weeklyPriceFactor` | `1.0` | — |
| `monthly_price_factor` | `static.monthlyPriceFactor` | `1.0` | — |
| `taxes` | `static.taxes` | `[]` | — |
| `min_nights` | `static.minNights` | **median** `restrictions.min_stay_on_arrival` | `1` |
| `max_nights` | `static.maxNights` | **max** `restrictions.max_stay_on_arrival` | `null` |
| `check_in_time` | `propertyConfig.googleCalendar?.checkInTime` | `hostexProperty.default_checkin_time` | `null` |
| `check_out_time` | analog | analog | `null` |
| `active` | immer `true` | — | — |

Median statt Average → robust gegen Hochsaison-Ausreißer und Hostex-Dynamic-Pricing.

### 5.2 `reservation-mapper.ts`

```ts
mapHostexReservation(res: HostexReservation, defaultTimes: { checkIn: string; checkOut: string }):
  { asReservation: Reservation | null; asInquiry: Inquiry }
```

**Status-Mapping:**

| Hostex | Internal (inquiries) | In reservations? (status) |
|---|---|---|
| `accepted` | `confirmed` | ja, als `confirmed` |
| `wait_pay` | `reserved` | ja, als `reserved` |
| `wait_accept` | `inquiry` | nein |
| `cancelled` | `canceled` | nein |
| `denied` | `declined` | nein |
| `timeout` | `expired` | nein |
| (unbekannt) | `inquiry` + WARN-Log | **ja, als `reserved` + WARN-Log** (defensive: blockt Verfügbarkeit, verhindert Double-Booking, sichtbar im Log) |

- `asInquiry` wird **immer** befüllt (alle Reservations → inquiries-Tabelle als BI-Pool, exakt wie bei Guesty heute).
- `asReservation` ist `null` für `wait_accept`/`cancelled`/`denied`/`timeout` (keine Calendar-Blockierung gewünscht). Bei unbekanntem Status defensive `reserved` schreiben, damit niemand doppelt buchen kann.
- `host_payout` = `rates.total_rate.amount - rates.total_commission.amount`
- ISO-Datum: `check_in = ${check_in_date}T${defaultCheckInTime}:00.000Z` (Hostex liefert nur DATE, kein Time)
- Guest-Fingerprint: bestehende `fingerprintGuestSafe()` aus `src/mappers/reservation-mapper.ts` re-import und re-use, **nicht duplizieren**

### 5.3 `calendar-mapper.ts`

```ts
mapHostexCalendarDay(args: {
  day: HostexCalendarDay;
  listingId: string;
  reservationsForDate: HostexReservation[];  // alle aktiven Buchungen mit Overlap
  lastSyncedAt: string;
}): Omit<Availability, 'id' | 'created_at' | 'updated_at'>
```

**Status-Logik:**
- Wenn `reservationsForDate.length > 0`:
  - `status = 'booked'`
  - `block_type = 'reservation'`
  - `block_ref = reservationsForDate[0].reservation_code`
- Sonst wenn `day.inventory === 0`:
  - `status = 'blocked'` (von Hostex/anderem Channel blockiert)
  - `block_type = null`
- Sonst:
  - `status = 'available'`

Übrige Felder:
- `price ← day.price`
- `min_nights ← day.restrictions.min_stay_on_arrival`
- `closed_to_arrival ← day.restrictions.closed_on_arrival`
- `closed_to_departure ← day.restrictions.closed_on_departure`

---

## 6. Sync-Jobs und ETL-Dispatch

### 6.1 ETL-Dispatch in `etl-job.ts`

```ts
export async function runETLJobForProperty(property: PropertyConfig, force: boolean) {
  if (property.provider === 'hostex') {
    return runHostexETL(property, force);
  }
  // existing Guesty 3-step logic — unverändert
  ...
}
```

`runETLJob()` (Multi-Property-Loop) bleibt unverändert. Scheduler bleibt unverändert.

### 6.2 `runHostexETL(property, force)` — 3 Schritte

Reihenfolge wichtig (anders als Guesty):

**1. `syncHostexReservations(property)`**
- `GET /v3/reservations?property_id=${id}&limit=100` (paginated)
- Für jede Reservation:
  - `mapHostexReservation()` aufrufen
  - `asInquiry` → `inquiries`-Tabelle UPSERT
  - `asReservation` → `reservations`-Tabelle UPSERT (wenn non-null)
- `deleteStaleReservationsInRange(listingId, range, keepIds)` (bestehende Repository-Funktion) — entfernt aus `reservations`, was nicht mehr aktiv ist
- **inquiries werden NIE bereinigt** (BI-Pool, wie bei Guesty)

**2. `syncHostexCalendar(property)`**
- `POST /v3/listings/calendar` mit 24 Monaten Range (12 zurück + 12 vorwärts)
- Pro Tag: Lookup gegen `reservations`-Tabelle (für booked-Status)
- `mapHostexCalendarDay()` → `availability`-Tabelle UPSERT
- `deleteOldAvailability()` (bestehende Funktion) räumt alte Tage außerhalb der Range weg

**3. `syncHostexProperty(property)`**
- `GET /v3/properties` (alle Hostex-Properties, filter auf `hostexPropertyId`)
- Aus DB lesen: letzte 20 Reservations + 30-Tage Calendar-Sample
- `mapHostexProperty()` → `listings`-Tabelle UPSERT

### 6.3 Channel-Mapping

Hostex-Reservations haben `channel_type` (z. B. `airbnb`). Pass-Through: wir speichern den Wert direkt in `reservations.source`. Konsequenz: BI-Abfragen sehen `airbnb` (Hostex) parallel zu `airbnb2` (Guesty). Akzeptabel für die Übergangsphase; im Cleanup nach Komplettwechsel können historische `airbnb2`-Werte optional umbenannt werden.

### 6.4 Konstanten

- Cleaning-Fee-Sample-Window: letzte **20** Reservations mit `CLEANING_FEE > 0`
- Calendar-Sample-Window für base_price: nächste **30** Tage ab heute
- ETL-Calendar-Range: **24 Monate** (12 zurück + 12 vorwärts), analog Guesty

---

## 7. Error-Handling

### 7.1 API-Layer (`hostex-client.ts`)
- `error_code !== 200` → `ExternalApiError(message, code, request_id)`
- HTTP 429: Exponential Backoff (1s, 2s, 4s, 8s, 16s), max 5 Retries
- HTTP 4xx/5xx: 3 Retries (1s/2s/4s), dann `ExternalApiError`
- Netzwerk-Errors: gleich wie 5xx

### 7.2 Mapper-Layer
- Unbekannter Status → WARN-Log mit `reservation_code` + Original-Status, Default-Fallback (siehe 5.2)
- Fehlende `static.accommodates` → `ValidationError` beim Sync, andere Properties laufen weiter
- Dynamic-Fallback ohne Daten (neue Property, keine Reservations) → `base_price=0`, `cleaning_fee=0` + WARN

### 7.3 Sync-Job-Layer
- Pro Property isoliert via existing `runETLJobForProperty`-Pattern
- Hostex-Property-Fail beeinträchtigt Guesty-Properties nicht und umgekehrt
- `ETLJobResult.success: false` mit Error-Message

### 7.4 Boot-Validation
- Wenn Hostex-Properties konfiguriert aber `HOSTEX_ACCESS_TOKEN` fehlt → Boot-Error mit klarer Meldung
- Zod-Validation-Fehler in properties.json → Boot-Error mit Pfad-Hinweis

---

## 8. Testing

### 8.1 Unit-Tests (Vitest)

| Datei | Was getestet |
|---|---|
| `src/mappers/hostex/property-mapper.test.ts` | Static-Vorrang, Dynamic-Fallback, alle 17 Felder, median/max-Berechnungen, Edge-Cases (leere Calendar, leere Reservations) |
| `src/mappers/hostex/reservation-mapper.test.ts` | Alle 6 Status → korrekte Routing-Tupel, host_payout-Berechnung, unbekannter Status mit WARN, ISO-Datum-Bildung, Guest-Fingerprint-Integration |
| `src/mappers/hostex/calendar-mapper.test.ts` | booked/blocked/available-Status-Logik, Reservation-Overlap-Detection |
| `src/services/hostex-client.test.ts` | Wrapper-Auspack bei error_code=200/4xx, Pagination-Loop, Rate-Limit-Backoff (mit fetch-Mock) |
| `src/config/properties.test.ts` | Zod-Schema-Refinements (provider+IDs+static-Konsistenz) |

### 8.2 Test-Fixtures

`src/test-fixtures/hostex/` mit den echten Live-Test-Responses aus `/tmp/hostex-*.json`:
- `properties-response.json`
- `reservations-response.json`
- `calendar-response.json`
- `availabilities-response.json`

Reale Daten als Test-Grundlage, kein Erfinden.

### 8.3 Manueller Live-Test

`src/scripts/test-hostex-sync.ts` (analog zu existing `test-inquiry-sync.ts`):
```bash
npx tsx src/scripts/test-hostex-sync.ts alte-schilderwerkstatt
```
Führt einen vollen ETL für eine Property aus, zeigt Mapping-Ergebnis vor DB-Write. Für lokale Verifikation, nicht in CI.

### 8.4 Was NICHT getestet wird

- Live-API-Calls in CI (würde Token brauchen, Rate-Limit konsumieren)
- Repository-Logik (bleibt unverändert, ist via Guesty-Pfad schon validiert)

---

## 9. Deployment

Reihenfolge auf Production:

1. **Token in `.env` ergänzen** auf `deploy@guesty.remoterepublic.com:/opt/guesty-calendar-app/.env`:
   ```
   HOSTEX_ACCESS_TOKEN=...
   ```
2. **properties.json erweitern** — 3 neue Hostex-Property-Einträge mit vollem `static`-Block
3. **Deploy:** `git pull && npm install && npm run build && pm2 restart guesty-calendar`
4. **Boot-Check:** `pm2 logs guesty-calendar --lines 20` → keine Zod-Validation-Errors, kein Token-Missing-Error
5. **Health-Check:** `curl https://guesty.remoterepublic.com/health`
6. **Manueller Test-Sync für 1 Property zuerst:**
   ```bash
   npx tsx src/scripts/sync-property.ts alte-schilderwerkstatt
   ```
7. **Verifikation per SQL:**
   - `listings`: 1 neue Row mit gefüllten Pflichtfeldern
   - `reservations`: aktive Bookings present
   - `inquiries`: full history
   - `availability`: 24 Monate gefüllt
8. **Nach Sanity-Check für 1 Property:** verbleibende 2 Properties via `sync-property.ts` durchziehen
9. **24h Monitoring:** PM2-Logs auf WARN/ERROR — besonders unbekannte Hostex-Status-Werte

### 9.1 Rollback-Pfad

Bei Problemen:
1. Hostex-Properties aus `properties.json` entfernen
2. Server restart → nächster ETL ignoriert sie
3. DB-Rows können stehen bleiben (kein Schaden) oder via SQL gelöscht werden:
   ```sql
   DELETE FROM listings WHERE id IN ('12659676', '12659677', '12659678');
   ```
   (CASCADE entfernt zugehörige Reservations + Availability)

Code-Cleanup nicht nötig — Hostex-Module liegen unbenutzt im Repo.

---

## 10. Bewusst nicht im Scope (YAGNI)

- **Webhooks**: Hostex single-attempt mit 3s-Timeout. Polling reicht, Webhooks später als Optimization
- **Multi-Listing-Calendar-Optimierung**: Hostex erlaubt mehrere Listings in 1 Calendar-Call. Mit nur 3 Hostex-Properties unkritisch
- **OAuth-Flow für Hostex**: Statischer Token reicht, OAuth ist Hostex-Software-Partner-Pfad
- **Hostex-Update-Endpoints** (POST `/v3/reservations`, `/v3/availabilities`, etc.): wir konsumieren Read-Only, kein Write nach Hostex
- **Cancellation-spezifische Webhooks oder Polling**: Cancelled-Reservations werden über reguläres `/v3/reservations`-Polling erkannt
- **Channel-Type-Normalisierung**: Hostex `airbnb` wird nicht zu Guesty `airbnb2` umbenannt. Pass-Through. Erst beim Komplett-Cleanup ggf. historisch normalisieren
- **Provider-Interface-Refactor**: würde Sinn machen wenn das Endziel „Multi-Provider forever" wäre. Da Endziel „nur Hostex" ist, würde der Refactor-Aufwand verschwendet
- **UI-Anzeige der Provider**: kein Badge im Admin-Dashboard. `properties.json` ist die Wahrheit

---

## 11. Future Work (post-Spec)

- **Webhooks aktivieren**, sobald Hostex Retry-Mechanism nachrüstet ODER Hostex selbst Polling-Backup signalisiert
- **Multi-Listing-Calendar** als Performance-Optimization bei >10 Hostex-Properties
- **Channel-Type-Normalisierung** historisch nachziehen bei Cleanup
- **Hostex-Webhook-Receiver** für Live-Updates bei messages_created (wenn Guest-Communication via Hostex relevant wird)
- **Guesty-Cleanup**: nach erfolgreicher Migration aller Properties, gezielte File-Löschungen (siehe 2.3)

---

## 12. Offene Punkte für Implementation

- **`hostex.ts`-Type-Definitionen**: Aus Live-Response-Fixtures generieren (manuell oder via tooling). Felder, die wir nicht brauchen, weglassen.
- **`base_price`-Fallback wenn Calendar leer**: aktuell `0 + WARN`. Vielleicht stattdessen letzte bekannte Reservation-Rate? Implementierungs-Plan entscheidet.
- **Test-Fixtures in `src/test-fixtures/hostex/`**: aus `/tmp/hostex-*.json` kopieren, gegebenenfalls Sensitive-Felder (guest_email, guest_phone) maskieren
- **Channel-Type-Whitelist**: aktuell pass-through. Implementierungs-Plan entscheidet, ob unbekannte channel_types ein WARN-Log triggern
- **Lokale Test-DB**: wahrscheinlich nicht stale-Problem wie bei Guesty (Hostex-Properties existieren erst nach Deploy)
