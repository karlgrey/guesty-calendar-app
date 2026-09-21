# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Roadmap:** Die priorisierte Vorhaben-Liste (u. a. Schnitt 4 — Guesty-Send) lebt im
> Wissens-Master `~/Development/TheBrain2` — CLAUDE.md „→ Nächste Session" und
> Projektseite `wiki/projekte/Gäste-Messaging-Automation.md`.

## Project Overview

A Node.js/TypeScript service that provides Airbnb-style booking calendars for multiple Guesty properties. The service caches Guesty API data in SQLite and serves it through a public API with a vanilla JavaScript frontend. Properties are configured via `data/properties.json` and each gets its own URL namespace (`/p/:slug/...`).

## Development Commands

```bash
npm run dev              # Development with hot reload (tsx watch)
npm run build            # Compile TypeScript to dist/
npm start               # Run production build from dist/
npm run lint            # ESLint on src/**/*.ts
npm test               # ACHTUNG: startet Vitest im WATCH-Modus (beendet nie) — fuer Einmal-Laeufe IMMER `npx vitest run`

# Data sync
npm run sync            # Sync all properties (respects cache)
npm run sync:force      # Force sync all properties
npx tsx src/scripts/sync-property.ts <slug>  # Sync single property (e.g., farmhouse, u19)

# Testing scripts
npx tsx src/scripts/test-email.ts [slug]     # Send test weekly email (optional: for specific property)
npx tsx src/scripts/test-document.ts <reservationId> <quote|invoice>
npx tsx src/scripts/set-document-sequence.ts [year] [lastNumber]
npx tsx src/scripts/list-properties.ts       # List all Guesty properties
```

### Access Points
- Property calendar: `http://localhost:3000/p/:slug` (e.g., `/p/farmhouse`, `/p/u19`)
- Property API: `/p/:slug/listing`, `/p/:slug/availability`, `/p/:slug/quote`
- Admin dashboard: `/admin` (property stats, bookings, analytics, documents)
- Admin system: `/admin/system` (health, sync, DB viewer, ETL, user management)
- Guest replies: `/admin/messages` (Hostex threads needing reply), `/admin/suggestions` (vault edits)
- Legacy routes: `/listing`, `/availability`, `/quote` (use default property)
- Auth: `/auth/login`, Health: `/health`, `/health/detailed`

## Multi-Property Configuration

Properties are defined in `data/properties.json` (validated with Zod on startup):
```json
{
  "properties": [
    {
      "slug": "farmhouse",
      "guestyPropertyId": "686d1e927ae7af00234115ad",
      "name": "Farmhouse Prasser",
      "timezone": "Europe/Berlin",
      "currency": "EUR",
      "bookingRecipientEmail": "booking@farmhouse-prasser.de",
      "bookingSenderName": "Farmhouse Prasser",
      "weeklyReport": { "enabled": true, "recipients": ["..."], "day": 1, "hour": 6 },
      "ga4": { "enabled": true, "propertyId": "513788097", "keyFilePath": "...", "syncHour": 3 }
    }
  ]
}
```

**Key files:**
- `data/properties.json` - Central property configuration
- `src/config/properties.ts` - Loader: `getPropertyBySlug()`, `getAllProperties()`, `getDefaultProperty()`
- `src/routes/property-routes.ts` - Property-scoped API routes (`/p/:slug/...`)

**Important patterns:**
- `config.guestyPropertyId` is **optional** in `.env` (overridden by `properties.json`)
- Always use fallback: `config.guestyPropertyId || getDefaultProperty()?.guestyPropertyId`
- `ga4` field is optional per property (defaults to `{ enabled: false }`)
- Legacy routes (without `/p/:slug`) use the default (first) property
- `req.property` available after `resolveProperty` middleware

### Adding a New Property
1. Find the Guesty listing ID: `npx tsx src/scripts/list-properties.ts`
2. Add property config to `data/properties.json`
3. Sync: `npx tsx src/scripts/sync-property.ts <slug>`
4. Verify in admin dashboard (property selector)

## Architecture Overview

### Data Flow
1. **Properties Config** (`data/properties.json`) defines all managed properties
2. **ETL Jobs** (`src/jobs/`) fetch data from Guesty API for each property on startup and hourly
3. **Guesty Client** (`src/services/guesty-client.ts`) handles OAuth + rate-limited requests (Bottleneck)
4. **Repositories** (`src/repositories/`) handle SQLite operations, keyed by `listing_id`
5. **Routes** (`src/routes/`) serve API endpoints per property
6. **Frontend** (`public/`) vanilla JS calendar with property context injection

### ETL & Cache
- `runETLJobForProperty(property, force)` - Sync single property
- `runETLJob(force)` - Sync all properties sequentially
- Listings: 24h TTL | Availability: configurable via `CACHE_AVAILABILITY_TTL` (default 30min) | Quotes: 60min TTL
- Daily forced sync at 2 AM for all properties (24 months of data)
- Scheduler tracks per-property state: `propertyWeeklyEmailSent: Map<string, Date>`

### Rate Limiting
- 10 req/sec, 10 concurrent (below Guesty's 15/15 limits)
- Exponential backoff with jitter for 429 responses
- OAuth retry: up to 5 attempts with backoff

### Admin Dashboard
- **`/admin`** - Property Dashboard: stats, conversion rate, analytics (if GA4 enabled), bookings, documents
- **`/admin/system`** - System: health, sync, DB viewer, ETL scheduler, user management
- Property selector on both pages; analytics auto-hidden for properties without GA4
- **"Aktuell belegt" block**: an always-visible block above the bookings list shows currently
  in-house stays (`getCurrentReservations`: `check_in ≤ today < check_out`) in BOTH the Next/Last
  12-Months views (else "Aktuell nicht belegt"), with the same quote/invoice actions. In-house
  stays also count in the `future`-period `getDashboardStats` (revenue query uses
  `check_out > today`). Spec: `docs/superpowers/specs/2026-06-10-current-booking-block-design.md`.

### Weekly Email Reports
Per-property config in `properties.json`: `weeklyReport: { enabled, recipients, day (0-6), hour (0-23) }`

- Scheduler checks each property's schedule hourly (timezone-aware via `date-fns-tz`)
- `sendWeeklySummaryEmailForProperty(property)` - generates and sends per-property email
- Includes: all-time stats, current year, occupancy, conversion rate, GA4 analytics (if enabled), top 5 bookings
- Revenue uses `host_payout` (net after platform fees)
- Sent via Resend API; sender name configured via `EMAIL_FROM_NAME` env var

### Portfolio BI Report (alle Properties)

Eine wöchentliche, konsolidierte Mail über alle Properties — ergänzt die per-Property-Weekly-Reports.
Konfiguration als **Top-Level-Block** `biReport` in `data/properties.json` (Geschwister von `properties`):
`{ enabled, recipients[], day (0-6), hour (0-23), timezone, forecastHorizonMonths }`.

- Scheduler prüft stündlich (timezone-aware), sendet einmal pro Slot (`shouldSendBiReport()`).
- Inhalt: Portfolio-Summenband · 6-Wochen-Belegungskalender (belegt/frei/Turnover) · nächste 5
  Anreisen & Turnovers · KPI-Tabelle pro Property (Belegung 6Wo/30Tg, Umsatz YTD/Monat/Δ, Buchungen, ADR) ·
  6-Monats-Forecast (OTB + portfolioweit gepoolter Pickup, pro Property mit „dünne Datenbasis"-Flag).
- Forecast: `src/services/forecast.ts` (Lead-Time-Kurve aus `reservations.reserved_at`), Kalender:
  `src/services/bi-calendar.ts`, Orchestrierung: `src/jobs/bi-email.ts`, Renderer: `src/services/bi-email-templates.ts`.
- Manueller Test: `npx tsx src/scripts/test-bi-email.ts` (respektiert `DEV_EMAIL_OVERRIDE`).
- **Deploy:** seit 2026-06-08 ist die frühere Prod-`properties.json`-Divergenz aufgelöst (alle
  echten Empfänger sind committet, prod-Arbeitskopie sauber) → Deploy ist wieder plain
  `git pull && npm run build && pm2 restart`, **kein** `git stash`/`pop` mehr nötig. Empfänger
  künftig im Repo ändern, nicht live auf prod.
- Spec: `docs/superpowers/specs/2026-06-02-portfolio-bi-email-design.md`

### Google Analytics 4
Optional per property. Configured in `properties.json` `ga4` field (or omit for disabled).
- Syncs daily at configured hour via `src/jobs/sync-analytics.ts`
- Admin dashboard shows/hides analytics based on `ga4Enabled` flag per property
- Setup: Create GCP service account → grant GA4 Viewer → add JSON key to `data/ga4-service-account.json`

### Document Generation (Quotes & Invoices)
- PDF generation: Puppeteer + Handlebars templates (`data/templates/angebot.html`, `rechnung.html`)
- Quotes: `A-YYYY-NNNN`, Invoices: `YYYY-NNNN` (independent counters per year)
- **Document numbering is SHARED across all properties** (one global sequence per type per year)
- Document numbers are **permanently stable** once created (never change, even on refresh)
- Refresh button (↻) fetches fresh Guesty data but preserves the document number
- Company names (GmbH, AG, UG, Ltd, etc.) in guest firstName auto-detected
- **Airbnb invoices = what the GUEST pays**, NOT the host payout. In `document-service.ts`
  `extractPricingFromReservation`, the `isAirbnb` branch sets
  `discountTotal = fareAccommodationAdjusted − fareAccommodation` (the real guest discount,
  e.g. length-of-stay) so the **Airbnb host channel fee (commission) is excluded**, while
  real discounts stay in. `subtotal = fareAccommodationAdjusted + cleaning + extras`,
  `total = subtotal + taxes`. (Do NOT use `subTotalPrice`/`hostPayout` for Airbnb — those are
  net of commission.) Verified: reservation `6a2720bb` (UNvia/Janos Udvary) → 332.98 €.
  Regression history in `docs/superpowers/specs/2026-06-05-…` family; covered by
  `document-service.airbnb-pricing.test.ts`.

### Owner Blocks & Sellable Occupancy

Owner/host-blocked (non-rentable) days are handled consistently via the canonical marker
**`availability.status = 'blocked'`** (provider-agnostic). Spec:
`docs/superpowers/specs/2026-06-04-owner-blocks-design.md`.
- **Classification:** Guesty `blocks.o/m` → blocked; Hostex `inventory=0` → blocked; Florence
  Airbnb-iCal `SUMMARY:Airbnb (Not available)` → blocked/`owner` (in
  `mappers/airbnb-mail/availability-mapper.ts`). Reservations (`Reserved`) stay `booked`.
- **Sellable occupancy:** `getOccupancyRate`/`getOccupancyBreakdown` = `booked / (total − blocked)`
  (blocked days excluded from the rentable base; `getDashboardStats` aligned). Used by BI mail,
  weekly mail, admin.
- **Google Calendar:** `sync-google-calendar.ts` pushes blocked spans as all-day events labelled by
  reason/source via `services/google-calendar-blocks.ts` `blockLabel(blockType, provider)`
  (`Owner-Block`/`Manuell blockiert`/`Wartung`/`Blockiert (Hostex|Airbnb)`, no emoji). Cleanup keys
  on `extendedProperties.private.kind='owner-block'`; **`listEvents` MUST request `fields=…
  extendedProperties`** or the default response omits it. Spans split on `block_type` change.
- **BI mail:** owner-blocked days render the same red as booked (not available); a `Block-Tg` KPI
  column shows blocked days per property. (`getReservationsByPeriod` is intentionally NOT changed —
  it stays "future = real arrivals" for BI/weekly/calendar.)

### Guest Fingerprint (Migration 012)

Lokal berechneter Fingerprint für Repeat-Customer-Analyse — keine zusätzlichen Guesty-API-Calls.
Felder: `reservations.internal_guest_id` (Slug), `reservations.guest_company` (Klartext-Firma, NULL bei Privatpersonen).
- Algorithmus: `src/utils/guest-fingerprint.ts` (pure function, vollständig getestet in `guest-fingerprint.test.ts`)
- Schreibt sich bei jedem ETL-Sync automatisch ins Mapping (`reservation-mapper.ts`)
- Einmaliges Backfill: `npx tsx src/scripts/backfill-guest-fingerprint.ts --apply`
- Spec: `docs/superpowers/specs/2026-05-13-guest-fingerprint-design.md`

**Pre-Backfill-Check (wichtig):** Bei stale-Sync würden alte Namen gefingerprintet. Daher
vor dem Backfill auf Production einen Force-Sync laufen lassen:
`npx tsx src/scripts/sync-property.ts farmhouse` und `... u19`.

### Hostex Integration

Zweiter Booking-Provider neben Guesty. Parallel-Modul-Architektur, ETL-Dispatch nach `provider`-Feld in `properties.json`.
- **Provider-Discriminator**: jede Property hat `provider: 'guesty' | 'hostex'` (Default `guesty`)
- **Hostex-Properties** brauchen `hostexPropertyId` (String) und `static`-Block in `properties.json` (mit Pflichtfeld `accommodates`)
- **API-Client**: `src/services/hostex-client.ts` (Header-Token via `HOSTEX_ACCESS_TOKEN` env-var, Bottleneck-Rate-Limit, Exponential-Backoff)
- **Mapper**: `src/mappers/hostex/{property,reservation,calendar}-mapper.ts` (alle pure functions, vollständig getestet)
- **ETL**: `src/jobs/hostex/{sync-properties,sync-reservations,sync-calendar}.ts` (Reihenfolge: properties → reservations → calendar → re-property)
- **Status-Routing**: alle Reservations → `inquiries` (BI-Pool), aktive (`accepted`/`wait_pay`) zusätzlich → `reservations`
- **Manueller Test**: `npx tsx src/scripts/test-hostex-sync.ts <slug>`
- **Spec**: `docs/superpowers/specs/2026-05-13-hostex-integration-design.md`

**Deployment-Reihenfolge (Production):**
1. `HOSTEX_ACCESS_TOKEN=...` in `/opt/guesty-calendar-app/.env` ergänzen
2. `data/properties.json` erweitern um 3 Hostex-Properties mit `provider: 'hostex'` + `static`-Block
3. `git pull && npm install && npm run build && pm2 restart guesty-calendar`
4. `pm2 logs guesty-calendar --lines 20` → keine Zod-Validation-Errors
5. Manueller Test pro Property: `npx tsx src/scripts/test-hostex-sync.ts <slug>`
6. SQL-Stichprobe für jede Property: `sqlite3 data/calendar.db "SELECT id, title, base_price FROM listings WHERE id IN ('12659676', '12659677', '12659678')"`
7. 24h PM2-Logs auf WARN/ERROR beobachten — besonders unknown-status Warnings

**Rollback**: 3 Hostex-Property-Einträge aus `properties.json` entfernen, Server-Restart. DB-Rows können stehenbleiben oder via SQL gelöscht werden.

### Guest-Reply System: Hostex + Guesty (Migrations 014, 018–020)

KI-gestützte Gästekommunikation mit Freigabe-Gate. Schnitte 1–3 (Hostex), Schnitt 4
erweitert auf Guesty-Properties (Farmhouse, U19) — Spec:
`docs/superpowers/specs/2026-07-07-guesty-send-design.md`.

**Schnitt 1 — Message Sync** (`src/jobs/hostex/sync-hostex-messages.ts` + `src/jobs/sync-guesty-messages.ts`):
- **Inkrementell** (Button + stündlicher ETL): Hostex skippt Details, wenn das
  Listen-`last_message_at` ≤ lokalem `last_synced_at` (exakt); Guesty skippt Posts für
  Conversations, die lokal bekannt, >30 Tage inaktiv UND deren Aufenthalt >14 Tage vorbei
  ist (Liste hat KEINEN Aktivitäts-Zeitstempel, `state.read` ist bei uns immer unread,
  Sortierung = `createdAt`). Täglicher Force-ETL (2 Uhr) = Deep-Sync über alles.
  Guesty-Posts-Fetches laufen parallel (Bottleneck 10 in flight). Button-Sync: ~15 s.
- **Guesty-Eigenheit:** an neue Anfragen hängt Guesty einen System-Post („New guest
  inquiry") ZEITLICH NACH der Gastnachricht — die „letzte Nachricht = inbound"-Queries
  ignorieren daher `direction='system'`.
- Fetcht alle Conversations via Hostex-API (`limit=100`, account-weit)
- Attributiert Buchungen über `property_title === property.name` (Schnell-Pfad), Anfragen (leerer `property_title`) über `activities[].property.id` im Detail
- Optionaler per-Run-`detailCache` (Map) verhindert Mehrfachfetches derselben Detail-Response
- Persistiert `Text`-Messages in `message_threads` + `messages` (mapper: `src/mappers/hostex/message-mapper.ts`); andere `display_type`-Werte (`Box`, `ReservationAlteration`) werden verworfen
- Liest via `src/repositories/message-repository.ts`

**Schnitt 2 — AI-Entwürfe** (`src/jobs/generate-drafts.ts` + `src/services/draft-service.ts`):
- Provider-agnostisch: `resolveDraftSource(property)` mappt hostex→`hostexPropertyId`, guesty→`guestyPropertyId`; airbnb-mail hat keinen Rückkanal (kein Draft)
- Voraussetzungen pro Property: Provider-Listing-ID + `vaultNote` in `properties.json` + `VAULT_PATH` + `ANTHROPIC_API_KEY`
- Liest Voice-Stil aus `prozesse/Gästekommunikation Grundsätze.md` und Objektfakten aus `prozesse/<vaultNote>` via `src/services/vault-knowledge.ts`
- Wählt nur Threads, deren letzte Gastnachricht < 72h alt ist (`DRAFT_MAX_AGE_HOURS = 72`), noch kein `pending`-Entwurf existiert, und letzte Richtung `inbound` ist
- Cap: maximal `DRAFT_GEN_CAP = 10` Entwürfe pro Property pro Run
- Modell: `claude-sonnet-4-6` via Forced-Tool-Call (`submit_reply`); leere Antwort = kein Entwurf nötig
- Speichert in `message_drafts` (`generated_by='llm'`, `model='claude-sonnet-4-6'`)
- Beide Schritte laufen in `runHostexETL` (nach Reservierungen, vor Calendar) in separaten try/catch-Blöcken — **non-fatal**

**Send** (`src/services/message-sender.ts`):
- Hostex-Branch: entfernt `hostex:`-Prefix aus `thread.id`, sendet via `hostexClient.sendMessage`
- Guesty-Branch (Schnitt 4): entfernt `guesty:`-Prefix, spiegelt den Kanal der letzten
  Gastnachricht via `resolveOutboundModuleType` (`src/services/guesty-channel.ts`, liest
  `raw_meta.type` — z. B. `airbnb2`, `platform`=E-Mail; `log`/unklar → Fehler bzw. kein
  Send-Button in der UI) und sendet via `guestyClient.sendConversationMessage`
  (`POST /communication/conversations/{id}/send-message`)
- Atomarer Send-Guard: `claimDraftForSending` setzt Status `pending→sending` (TOCTOU-sicher)
- Outbound-Row wird auf `{source}:{message_id}` der API-Response gehasht (kein Duplikat beim
  nächsten Sync); Guesty-Response-Schema beim Erst-Send verifizieren (wird raw geloggt)

**Admin-UI** (`src/routes/messages.ts`, gemountet auf `/admin/messages`):
- `GET /` — Threadliste (letzte Gastnachricht zuerst, nur letzte 14 Tage, farbige
  Objekt-Kürzel via `shortCode`/`uiColor` in properties.json) + "Jetzt syncen"-Button +
  verboser Sync-Fortschritt (Auto-Reload alle 4s während des Laufs)
- `GET /:threadId` — Verlauf, bearbeitbarer Entwurf-Textarea, Senden/Verwerfen/Neu-generieren/Manuell-speichern, einklappbares "Passt nicht?"-Feedback-Formular
- `POST /sync` — startet Sync+Drafts asynchron für Hostex- UND Guesty-Properties, leitet sofort zurück (kein Proxy-Timeout); Guesty-Conversations werden pro Run nur EINMAL account-weit gefetcht
- `POST /:threadId/draft` — manueller Entwurf; lehnt ab wenn schon `pending`-Draft existiert
- `POST /drafts/:draftId/send` — sendet (mit optionalem Body-Edit), atomic claim
- `POST /drafts/:draftId/discard` — verwirft Entwurf
- `POST /:threadId/regenerate` — verwirft aktuellen Draft, generiert frischen KI-Entwurf
- `POST /:threadId/feedback` — speichert Feedback, löst bei `ton`/`fakt` KI-Vault-Vorschlag aus

**Schnitt 3 — Feedback-Loop** (`src/services/suggestion-service.ts`, `src/services/vault-writer.ts`, `src/routes/suggestions.ts`):
- Feedback (Kategorie: `ton`/`fakt`/`einmalig` + Freitext) landet in `draft_feedback`
- Bei `ton`/`fakt`: LLM (`claude-sonnet-4-6`, Tool `propose_vault_edit`) schlägt einen Markdown-Bullet vor (target_heading + addition_text + rationale) → gespeichert in `vault_suggestions`
- `src/services/vault-writer.ts`: pfad-sicher (nur `prozesse/*.md`), hängt Text unter bestehende Überschrift an, git-committet via `execFileSync` (argv, kein Shell-Injection)
- Freigabe auf `/admin/suggestions` ist das Kurations-Gate — kein Auto-Write

**Konfiguration:**
- `VAULT_PATH` — absoluter Pfad zum Deploy-Vault (brainstem-gaeste, generiert aus TheBrain2); ohne diesen Wert sind Entwürfe und Feedback-Loop deaktiviert
- `ANTHROPIC_API_KEY` — für Entwurf-Generierung und Vault-Vorschläge (auch vom bestehenden Classifier genutzt)
- `vaultNote` — optionales Feld pro Property in `data/properties.json`, z.B. `"vaultNote": "Gästekommunikation Bootshaus.md"` → `prozesse/Gästekommunikation Bootshaus.md`

**Vault-Vertrag (WICHTIG bei App-Änderungen):** Das Vault (`VAULT_PATH` →
`brainstem-gaeste`) ist ein generiertes Deploy-Artefakt des Master-Wikis `TheBrain2`;
dessen `tools/sync.py` (läuft nur auf dem Laptop, via post-commit-Hook) holt die
Feedback-Loop-Commits per Struktur-Replay in den Master zurück. Der Sync verlässt sich
auf drei Invarianten der App — wer eine davon ändert, muss `TheBrain2/tools/sync.py`
mitziehen, sonst bricht der Rückfluss (laut, mit „bitte manuell ingesten"):
1. **Pfade:** gelesen/geschrieben wird nur `prozesse/<Seitenname>.md`; `vaultNote` in
   `data/properties.json` = Dateiname der Master-Seite in `wiki/prozesse/`.
2. **Git-Autor:** Feedback-Commits laufen als **"Remote Republic Bot"** — daran erkennt
   sync sie (`git config user.name` im Vault-Repo auf dem Server).
3. **Edit-Muster:** `vault-writer.ts` hängt ausschließlich Zeilen unter eine bestehende
   `##`-Überschrift an (append-only). Ersetzen/Löschen würde der Struktur-Replay
   ablehnen.
Spec: `TheBrain2/docs/superpowers/specs/2026-07-06-brainstem-sync-design.md`.

**Server-Setup:** → siehe `docs/vault-deployment.md`

### Gäste-Bewertungen: Auto-Draft nach Checkout (Migration 023, #377)

Zweites Freigabe-Gate-System neben dem Guest-Reply-System oben — eigene Tabelle
(`review_drafts`, ein Eintrag pro Reservierung statt pro Thread), eigener Prompt,
eigene Route. Kein Auto-Post: kein Anbieter (Guesty Open API, Hostex API) bietet
einen dokumentierten Endpoint, über den ein Host eine Gäste-Bewertung veröffentlicht
(Guesty: nur `PUT /reviews/{id}/reply` = Antwort auf eine Gast-Bewertung der
Unterkunft, nicht die Host-Bewertung des Gastes; Hostex: `GET /reviews` ist laut
Doku `read_only`) — bleibt beim Copy-Paste-Flow. Spec:
`TheBrain2/docs/superpowers/specs/2026-08-11-gaeste-bewertungen-design.md`.

- **Trigger** (`src/jobs/generate-review-drafts.ts`, non-fatal, läuft in
  `runETLJobForProperty`/`runHostexETL` direkt nach der Draft-Generierung für
  Gästenachrichten): pro ETL-Lauf werden bis zu `REVIEW_DRAFT_CAP` (10) frisch
  ausgecheckte Reservierungen ohne `review_drafts`-Zeile gefunden
  (`getRecentCheckoutIdsNeedingReview`, Lookback `REVIEW_LOOKBACK_DAYS` = 13
  Tage — knapp unter der 14-Tage-Airbnb-Frist). `resolveReviewSource()` spiegelt
  `resolveDraftSource()` 1:1 (nur `provider: guesty|hostex`) — Florenz/Manifattura
  läuft auf `provider: airbnb-mail` ohne Rückkanal und fällt damit automatisch raus
  (Design-Entscheidung Micha 11.08.2026), kein eigenes Opt-out-Feld nötig.
  **Airbnb-only** (Nachbesserung 11.08.2026, Bugfix): `getRecentCheckoutIdsNeedingReview`
  filtert zusätzlich `source LIKE '%airbnb%'` (Guesty `reservation.source` bzw. Hostex
  `channel_type`, case-insensitiv, gleiche Substring-Konvention wie in
  `document-service.ts`/`pdf-generator.ts`) — Direktbuchungen (`source: 'manual'`) und
  andere Kanäle (Booking.com, Landfolk, VRBO) bekommen keinen Entwurf, dafür gibt es
  keine Airbnb-Bewertung (Bug-Fall: Direktbuchung „S. Fischer Verlag" am Farmhouse).
- **Thread-Zuordnung:** Guesty-Threads tragen `reservation_id`
  (`getThreadsByReservationId`); Hostex-Conversations NIE (API-Limitierung, siehe
  Guest-Reply-System oben) — Fallback ist ein Guest-Name-Match innerhalb des
  Listings (`getThreadsByListingAndGuestName`, case/whitespace-insensitiv).
  **Bekannte Lücke:** weicht der Thread-Gastname vom Reservierungs-Gastnamen ab,
  sieht die Generierung fälschlich "kein Verlauf" statt der echten Konversation.
- **Klassifikation** (`src/utils/review-classifier.ts` + `review-classifier-prompt.ts`,
  Tool `classify_stay`, `ok`|`flagged`, eigener Prompt/eigene Few-Shots, getrennt vom
  Conversion-Classifier oben): Problemfall (Beschwerde/Schaden/Storno-Streit/
  Eskalation) → `flagged`, kein Draft. Bewusst konservativ (im Zweifel `flagged`).
  Threads ohne jede Nachricht werden NICHT ans LLM geschickt — automatisch `ok`
  (kein Anlass zur Sorge, kein API-Call).
- **Generierung** (`src/services/review-draft-service.ts`, Tool `submit_review`,
  Modell `claude-sonnet-5`): eigener Prompt-Baustein (nutzt NUR die Voice aus dem
  Vault, keine Objektfakten, keine Textbank) — schreibt 2–4 Sätze frei aus
  Gastname/Zeitraum/Objekt/Thread-Verlauf, spiegelt die Sprache des Gastes,
  kein Markdown, erfindet nichts über den Zustand der Unterkunft nach Abreise.
  **Problemfälle bekommen seit 11.08.2026 trotzdem einen Entwurf**
  (Nachbesserung Micha): `generateReviewForStay({ …, flagged: true })` setzt
  eine HARTE Prompt-Regel (Vorrang vor allen anderen Regeln) — Schäden,
  Beschwerden, Streit, Vorfälle dürfen im Text NICHT erwähnt/angedeutet
  werden, nur neutral-freundlich über die unproblematischen Aspekte
  schreiben (bei fast nichts Unproblematischem: kurz und neutral bleiben).
- **Status-Flow** (`review_drafts.status`): `pending` (Entwurf da, ggf. MIT
  `flag_reason` bei einem gedrafteten Problemfall) → `done`/`discarded`
  (Freigabe/Verwerfen); `needs_review` bleibt die Reserve für „LLM lieferte
  keinen Text" (egal ob Problemfall oder nicht) — `body` bleibt NULL,
  `flag_reason` erklärt warum. D. h. `flag_reason` ist NICHT mehr an
  `needs_review` gebunden: `pending` + `flag_reason` gesetzt = Problemfall
  MIT Entwurf, der im UI als Warnhinweis auffallen muss (siehe Admin-UI).
- **Admin-UI** (`src/routes/reviews.ts`, `/admin/reviews`, Nav-Button "⭐
  Bewertungen" in `/admin`): offene Entwürfe (`pending`+`needs_review`), pro
  Eintrag Verfallsdatum = Checkout + 14 Tage (nur Anzeige/Badge "Frist
  abgelaufen" — kein Auto-Discard). Aktionen: Erledigt (kopiert/gepostet, Text
  editierbar) · Verwerfen · Neu generieren (reklassifiziert + generiert frisch,
  ruft dieselben Bausteine direkt auf wie der Job, nicht den Batch-Wrapper —
  Muster wie `/admin/messages`' Regenerate). Ein `pending`-Entwurf mit
  gesetztem `flag_reason` (Problemfall) bekommt in Liste UND Detail einen
  eigenen roten „Problemfall — prüfen"-Badge/Warnblock, deutlich abgesetzt
  vom normalen amberfarbenen „KI-Entwurf bereit" und vom `needs_review`-Badge.
- Läuft NICHT über den manuellen "Jetzt syncen"-Button auf `/admin/messages`
  (nur über den periodischen/täglichen ETL-Zyklus) — bewusste Abgrenzung, damit
  der Messaging-Sync-Button nicht überraschend auch Bewertungen anstößt.

### Auto-Send-Gate (Migration 027, Spec 2026-09-19)

Drittes Freigabe-Gate-System neben Guest-Reply und Gäste-Bewertungen oben — statt
Copy-Paste kann ein sicherer Entwurf automatisch rausgehen. Spec:
`TheBrain2/docs/superpowers/specs/2026-09-19-auto-send-gate-design.md`.

- **Kette** (`src/services/auto-send/runner.ts`, `runAutoSendGate`, läuft nach JEDEM
  LLM-Entwurf in `generate-drafts.ts`): Schicht 1 Prüfmodell
  (`judge-service.ts`/`judge-prompt.ts`, `JUDGE_MODEL`, Kategorie + Risk-Flags +
  Konfidenz), Schicht 2 mechanische Checks (`mechanical-checks.ts` — Ziffernfolgen,
  Links, Mail, Geldbeträge inkl. `EUR120`, Telefonnummern, Code-Wörter mit Ziffer,
  Zahlwörter eins…zwölf/one…ten, Länge, leer), Schicht 3 reine Entscheidungsfunktion
  (`policy.ts`, `decide()` — kein I/O). `off` prüft NICHT und persistiert NICHT
  (Entwürfe von Off-Objekten landen sonst fälschlich im „wait"/Push); `shadow` prüft
  und protokolliert nur (`message_drafts.auto_decision`); `live` sendet bei
  Entscheidung `auto` automatisch über `sendClaimedDraft(..., 'auto')`
  (`src/services/draft-send-service.ts`, atomarer Claim gegen Doppelversand). Schlägt
  die Prüfung technisch fehl (Prüfmodell/Deps), ist das Ergebnis `wait` mit Grund
  „Prüfung technisch fehlgeschlagen: …" — nie eine Exception. Unbekannte/ungültige
  `risk_flags` im Prüfmodell-Output gelten seit Final-Review F4 als Prüffehler
  (`wait`, „Unbekanntes Risk-Flag: …") statt stillschweigend verworfen zu werden — fail
  closed statt fail open.
- **Modus-Auflösung** (`mode.ts`, `resolveAutoSendMode`): restriktiverer Wert aus
  `AUTO_SEND_MODE` (Env, global) und `properties.json`-Feld `autoSend` (pro Objekt;
  `off < shadow < live`) — ein Objekt kann den globalen Modus nur verschärfen, nie lockern.
- **Pause & Tageslimit:** Schalter „Auto-Send" auf `/admin/messages/auto-send`
  (`src/routes/messages.ts`) setzt `scheduler_state`-Key `auto_send_paused` — pausiert
  entscheidet `policy.ts` immer `wait`. `AUTO_SEND_DAILY_CAP` zählt automatisch versendete
  Entwürfe pro Kalendertag Europe/Berlin (`berlin-day.ts`, `countAutoSentSince`).
- **Weitere Wait-Gründe:** Kategorie nicht in `AUTO_OK_CATEGORIES`, `playbook_fakt` ohne
  `answerableFromFacts`, jedes Risk-Flag, jeder mechanische Treffer, Konfidenz ≠ „hoch",
  Micha hat im Thread schon eingegriffen (`threadHasHumanIntervention` — verworfener
  Entwurf, Feedback-Zeile oder manuelle Kategorie im Thread), vorheriger Versand im
  Thread fehlgeschlagen/hängt (`threadHasFailedSend` — Draft mit `status` `error` oder
  `sending` im selben Thread, Final-Review F1: verhindert Doppelversand nach einem
  fehlgeschlagenen Auto-Send). `threadHasFailedSend` schließt den Thread dabei für die
  gesamte Lebensdauer dieses hängenden/fehlgeschlagenen Drafts vom Auto-Send aus, nicht
  nur für den einen betroffenen Entwurf — erst wenn der Draft manuell aufgelöst wird
  (gesendet/verworfen), greift die Regel wieder normal. Weiterer Wait-Grund: Kanal
  unklar (`canSend`).
- **Sichtbarkeit hängender Sends:** `getAwaitingDrafts` (`draft-repository.ts`, hinter
  `/api/agent/drafts/awaiting`) zeigt seit Final-Review F3 zusätzlich zu `wait`/`error`
  auch hängende Sends: Entwürfe, die seit über 10 Minuten auf `auto`/`pending` stehen
  (Claim verloren, Prozess gestorben) — **nur im Live-Modus** (`auto_mode = 'live'`; im
  Schattenmodus ist `auto`/`pending` der Normalzustand, Spec 4 verlangt „Push nur für
  wait-Entscheidungen, auch im Schattenmodus" — Re-Review-Korrektur, sonst würde jeder
  gute Schatten-Entwurf nach 10 Minuten fälschlich gepusht) — Grund „Auto-Send hängt —
  bitte manuell prüfen"; sowie Entwürfe seit über 10 Minuten auf `sending` (Crash mitten
  im Versand, gilt für manuelle UND Auto-Sends) — neutraler Grund „Versand hängt —
  bitte manuell prüfen". Schlägt der Claim in `runner.ts` fehl, persistiert die Kette
  sofort eine `wait`-Entscheidung, statt den Entwurf stillschweigend auf `auto` stehen
  zu lassen.
- **Nachrichten-Loop** (`src/jobs/message-loop.ts`, `runMessageLoopOnce`, eigener Takt
  `MESSAGE_LOOP_MINUTES` (5) unabhängig vom Stunden-ETL): Sync beider Provider →
  Entwürfe → Gate. `messageSyncLock`/`acquireMessageSyncLock` verhindert überlappende Syncs
  mit dem ETL (ETL wartet bis 60 s, manueller „Jetzt syncen"-Button und Webhook je 30 s).
  Guesty-Conversation-Liste läuft mit `limit=100`. Start-Log: „💬 Nachrichten-Loop gestartet".
- **Guesty-Webhook** (`POST /api/webhooks/guesty`, `src/routes/webhooks-guesty.ts` +
  `src/services/guesty-webhook-signature.ts`): reagiert auf `reservation.messageReceived`
  in Echtzeit statt auf den nächsten Loop-Tick. Svix-Signatur-Prüfung, deshalb VOR
  `express.json()` mit `express.raw()` gemountet (`app.ts`) — sonst ist der Rohkörper für
  die Signatur weg. Sofort `202`, Verarbeitung async (`src/jobs/handle-guesty-inbound.ts`
  lädt die Konversation immer per `getConversation` frisch nach, Shape verifiziert
  20.09.2026). Einmalig registrieren: `npm run webhook:register`
  (`src/scripts/register-guesty-webhook.ts`, legt die Subscription an bzw. warnt wenn sie
  ohne das nötige Event existiert) → gibt `GUESTY_WEBHOOK_SECRET` aus, in `.env` eintragen.
- **Agent-API** (`src/routes/agent-api.ts`): `GET /api/agent/drafts/awaiting?since=&limit=`
  (offene `wait`-Entwürfe fürs WhatsApp-Push/Briefing), `GET
  /api/agent/auto-send/stats?days=` (Auto-Send-Auswertung); `/threads` liefert zusätzlich
  `autoDecision` und `property.shortCode`.
- **Testfixtures:** `npm run test:judge` (`src/scripts/test-judge-fixtures.ts`, Live-Lauf
  gegen `JUDGE_MODEL`, 13 Fälle in `src/test-fixtures/judge/cases.json`) — **Pflicht vor
  jeder Prompt-Änderung** an `judge-prompt.ts` (aktuell 13/13 grün).
- **Sprach-Pin (#695, 21.09.2026):** `src/utils/language-detect.ts` erkennt die Sprache der
  letzten Gastnachricht deterministisch (Stopwort-Heuristik DE/EN/IT/ES/FR, Fallback Deutsch;
  franc/tinyld scheiterten an Kurztexten wie „Danke, alles super!"). Die Sprache geht als harte
  Zeile `ANTWORTSPRACHE: <Sprache>` in den Entwurfs-Systemprompt (`draft-service.ts`, vor
  Voice/Objektwissen), als Fakt in den Judge-Kontext (`judge-service.ts`) und in die mechanischen
  Checks (`mechanical-checks.ts`, Flag `language_mismatch` = Sprache des Entwurfs ≠ Gast-Sprache).
  Fällt das Gate mit `language_mismatch` (Judge oder `mech:`) auf `wait`, generiert
  `generate-drafts.ts` GENAU EINEN Neuversuch mit expliziter Korrektur-Anweisung, überschreibt den
  Body desselben Draft-Datensatzes und lässt das Gate mit `attempt: 2` erneut laufen — der
  persistierte `auto_reason` trägt dann den Präfix „Neuversuch: “ (nur die letzte Entscheidung
  steht in der DB, beide im Log). `no_reply`/`failed` beim Neuversuch → erste wait-Entscheidung
  bleibt. Fixture „lorenzo dank en" in `cases.json` (Feld `guestLanguage`).
- **Zusagen-Task (#696, 21.09.2026, Fall Lorenzo U19):** eine Zusage im Entwurf
  (Judge-Risk-Flag `promises_action`) ist allein kein Wait-Grund mehr, WENN sie
  nachgehalten wird — der Judge liefert bei `promises_action` zusätzlich `promised_action`
  (ein Satz, was zugesagt wird; `judge-prompt.ts`/`judge-service.ts`). `policy.ts`
  (`isPromiseOnlyRisk`, `wouldAutoWithPromiseTask` — beide pure, kein I/O) lässt den
  Entwurf nur dann automatisch gehen, wenn riskFlags GENAU `['promises_action']` ist
  (jedes weitere Flag bleibt wie bisher `wait`), `promised_action` gesetzt ist und alle
  übrigen Gates (Kategorie, Mechanik, Konfidenz „hoch", Thread-Zustand, Tageslimit)
  bereits grün wären — erst dann versucht `runner.ts` die (async) Task-Anlage über
  `promise-task-service.ts` (`resolvePromiseTask`) und ruft `decide()` mit dem Ergebnis
  ein zweites Mal auf. Schlägt die Anlage fehl (SmartTasks-API nicht erreichbar/Timeout),
  bleibt es bei `wait`, Grund „Task konnte nicht angelegt werden" — der Versand wird nie
  blockiert, nur nicht beschleunigt. Auch im Schattenmodus wird der Task angelegt (sonst
  lässt sich die Mechanik nicht bewerten); `auto_reason` markiert das dann zusätzlich
  („Zusage → Task #NNN (Schattenmodus)"). Die confidence=hoch-Regel im Judge-Prompt hat
  dafür eine explizite Ausnahme für die Zusage selbst (sie braucht keinen Beleg im
  Objektwissen — sie wird ja separat nachgehalten), sonst hätte `promises_action` in der
  Praxis fast nie `confidence: hoch` erreicht.
  - **SmartTasks-Client** (`src/services/smarttasks-client.ts`): kleiner HTTP-Client
    (Muster `guesty-client.ts`/`hostex-client.ts`), `POST /tasks` mit Bearer-Key aus
    `SMARTTASKS_API_KEY`, 10 s Timeout, kein Retry (ein Fehlversuch ist okay, siehe oben).
    **Kernschutz:** der Key ist ein separater Key „guesty-app" am bestehenden User
    „Claude" — er darf laut SmartTasks-Auslegung nur Tasks anlegen/kommentieren, keine
    Wiki-/Vault-Rechte, und ist unabhängig vom Standup-Session-Key widerrufbar.
    **Anlage** (auf labs, `/opt/smarttasks`): `npx tsx scripts/create-api-key.ts Claude
    guesty-app` (Name „Claude" ist Pflicht — sonst wird ein neuer User statt eines
    zusätzlichen Keys angelegt); Ausgabe direkt in `/opt/guesty-calendar-app/.env` als
    `SMARTTASKS_API_KEY=…` eintragen, nirgends sonst notieren. **Widerruf:** `npx tsx
    scripts/revoke-api-key.ts <id>` (Id aus Tabelle `api_keys`).
  - **Task-Inhalt** (`promise-task-service.ts`): Titel `Zusage an Gast <Vorname>
    (<Objekt-Code>): <promised_action>`; Beschreibung mit Thread-Link (`adminUrl`), Zitat
    der Gastnachricht, Zitat des Entwurfs, Datum. Projekt = Betriebs-Projekt des Objekts
    aus `properties.json`-Feld `smartTasksProjectId` (FH → 5, U19 → 36, AS/BH → 7 —
    verifiziert gegen `/api/projects`); Assignee Micha (`MICHA_SMARTTASKS_USER_ID = 1`);
    Status „To Do"; Due = nächster Werktag Berlin-Zeit, nie Sa/So
    (`berlin-day.ts`, `nextBerlinBusinessDay`).
  - **Idempotenz** (Spec Punkt 6 — Neuversuch nach Sprach-Pin, #695, erzeugt keinen
    zweiten Task): Migration 029 fügt `message_drafts.smarttasks_task_id` +
    `smarttasks_task_guest_message_id` (Id der zuletzt beantworteten Gastnachricht) hinzu.
    `resolvePromiseTask` prüft zuerst `findExistingSmartTasksTaskId(threadId,
    guestMessageId)` — existiert im selben Thread bereits ein Task für GENAU diese
    Gastnachricht (über alle Draft-Status hinweg, auch discarded/error), wird dessen
    Id auf den aktuellen Draft gespiegelt statt neu angelegt. Das greift generisch für
    JEDEN Fall, in dem ein neuer Draft-Datensatz für dieselbe letzte Gastnachricht
    entsteht (der Sprach-Pin-Neuversuch überschreibt zwar denselben Datensatz, aber auch
    ein künftiger Pfad mit neuem Draft wäre abgedeckt) — bewusst über Thread+Gastnachricht
    statt Draft-Id verankert, weil Draft-Ids sich ändern können, die beantwortete
    Gastnachricht aber nicht.
  - **Sichtbarkeit:** Task-Nummer im Admin-UI (`renderAutoBadge`, Thread-Detail-Badges)
    und in `GET /api/agent/drafts/awaiting` (`smartTasksTaskId`) — dort nur relevant für
    hängende/fehlgeschlagene Sends, deren Zusage bereits getrackt wurde (Auto-Entscheidungen
    selbst tauchen in `/drafts/awaiting` nicht auf, das ist reine Wait/Error-Liste).
  - **Testfixture:** „Lorenzo — Dank mit Zusage (#696)" in `cases.json` (englischer Dank +
    Zusage, `expected.riskFlags`/`promisedActionContains`) — zu unterscheiden von der
    #695-Fixture „lorenzo dank en" (reiner Sprach-Pin-Test, keine Zusage).
- **Env-Variablen:** `AUTO_SEND_MODE` (`off`|`shadow`|`live`, Default `off`),
  `AUTO_SEND_DAILY_CAP` (Default 10), `MESSAGE_LOOP_MINUTES` (Default 5), `JUDGE_MODEL`
  (Default `claude-opus-5`), `GUESTY_WEBHOOK_SECRET` (aus `npm run webhook:register`),
  `SMARTTASKS_API_KEY`/`SMARTTASKS_API_URL` (#696, siehe „SmartTasks-Client" oben).
- **Key Files:** `src/services/auto-send/{types,mode,berlin-day,mechanical-checks,
  judge-prompt,judge-service,policy,runner}.ts`, `src/services/draft-send-service.ts`,
  `src/services/guesty-webhook-signature.ts`, `src/routes/webhooks-guesty.ts`,
  `src/services/{smarttasks-client,promise-task-service}.ts`,
  `src/jobs/{message-loop,handle-guesty-inbound}.ts`,
  `src/scripts/{register-guesty-webhook,test-judge-fixtures}.ts`,
  `src/test-fixtures/judge/cases.json`, Migrationen `027_add_auto_send.sql`,
  `029_add_smarttasks_task.sql`.
- **Server-Setup:** → siehe `docs/vault-deployment.md`, Abschnitt „Auto-Send-Gate
  aktivieren".

### Airbnb-Mail Integration (Migration 013)

Dritter Booking-Provider für Properties, die nur über Airbnb laufen. Daten kommen aus:
- **IMAP-Inbox** (z.B. dedizierter Bot-Account `airbnb-bot@…`) — Buchungs-Mails
- **iCal-URL** (Airbnb Listing → Calendar Settings → Export) — Verfügbarkeit

**Property-Discriminator**: `provider: 'airbnb-mail'` in `properties.json`, plus `airbnbListingId`, `airbnbIcalUrl`, `airbnbMailLabel` (Gmail-Label, optional), `static`-Block.

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
4. Property mit `provider: 'airbnb-mail'` in `data/properties.json` ergänzen (inkl. `airbnbListingId`, `airbnbIcalUrl`, `airbnbMailLabel` für den Gmail-Label-Filter, `static`)
5. `git pull && npm install && npm run build && pm2 restart guesty-calendar`
6. Logs prüfen: Migration 013 applied, kein Zod-Error
7. Manueller Sync: `npx tsx src/scripts/test-airbnb-mail-sync.ts <slug>`
8. **Live-Daten-Kalibrierung**:
   - Nach 1-2 echten Mails: `SELECT subject, parse_status, parse_error FROM airbnb_mail_archive ORDER BY received_at DESC` ansehen
   - Subject-Patterns (`src/parsers/airbnb-mail/index.ts`) und Body-Regex (`confirmed-booking.ts` etc.) anhand der echten Mails justieren
   - `npx tsx src/scripts/reparse-airbnb-mail.ts --all-errors --slug=X` zum Backfill

**Rollback**: Property aus `properties.json` entfernen, restart. DB-Rows können bleiben, Migration ist additive.

**Staleness-Alarm (#327, seit 08/2026):** #324 verhindert das WEDGE (eine kaputte Mail blockiert
den UID-Fortschritt dauerhaft), aber nicht das unbemerkte STEHEN — z. B. ein kaputter IMAP-Login,
der einfach nie wieder erfolgreich pollt (Florence stand so 10 Wochen unbemerkt still).
- `src/services/airbnb-mail-staleness.ts` — reine Kernlogik (`findStaleAirbnbMailSources`)
- `src/jobs/airbnb-mail/check-staleness.ts` — DB+Config-Wrapper, läuft stündlich im Scheduler
  (`src/jobs/scheduler.ts`), loggt pro stale Property ein `logger.error` (pm2-Monitoring sieht das,
  anders als das bestehende `WARN` im normalen ETL-Lauf, das in stündlichem Rauschen untergeht)
- Schwellwert: `AIRBNB_MAIL_STALENESS_THRESHOLD_HOURS` (Default 26h), `src/config/index.ts`
- `airbnb_mail_state.last_sync_at` wird jetzt bei JEDEM erfolgreichen Poll aktualisiert, auch wenn
  keine neue Mail da war (vorher nur bei UID-Fortschritt) — sonst hätte eine ruhige Mailbox
  (keine neuen Buchungen) fälschlich wie ein kaputter Sync ausgesehen
- Die BI-Report-Mail (`src/jobs/bi-email.ts` → `staleAirbnbMailSources` auf `BiReportModel`,
  gerendert in `src/services/bi-email-templates.ts`) zeigt eine Warnzeile, falls etwas stale ist

### Authentication
- Google OAuth 2.0 via Passport.js (`src/config/auth.ts`)
- Email whitelist: `ADMIN_ALLOWED_EMAILS` env var
- Session-based with secure cookies (24h lifetime)

### Error Handling
Custom error classes in `src/utils/errors.ts`: `ConfigError`, `DatabaseError`, `ExternalApiError`, `ValidationError`, `NotFoundError`, `CacheMissError`. All extend `AppError` with structured Pino logging.

## Key Patterns

- **Database**: `better-sqlite3` sync API, `listing_id` as key (multi-property ready without migrations)
- **Dates**: ISO 8601 strings, property timezone for availability, UTC for `last_synced_at`
- **Logging**: Pino structured logging, include `propertySlug` for multi-property tracing
- **Testing**: Vitest, mock DB and Guesty API responses
- **Optional config fallback**:
```typescript
const defaultProperty = getDefaultProperty();
const propertyId = config.guestyPropertyId || defaultProperty?.guestyPropertyId;
if (!propertyId) throw new NotFoundError('No property configured');
```

## Important Files

### Configuration
- `.env` / `.env.example` - Environment variables (secrets, API keys)
- `data/properties.json` - Multi-property config (slug, Guesty ID, email, weekly report, GA4)
- `src/config/index.ts` - Zod-validated config object
- `src/config/properties.ts` - Property config loader with caching

### Services & Jobs
- `src/services/guesty-client.ts` - OAuth + rate-limited Guesty API client
- `src/services/pricing-calculator.ts` - Local quote computation
- `src/jobs/scheduler.ts` - ETL scheduling with jitter, per-property state
- `src/jobs/etl-job.ts` - Listing + availability sync orchestration
- `src/jobs/weekly-email.ts` - Per-property weekly email with `sendWeeklySummaryEmailForProperty()`

### Routes
- `src/routes/property-routes.ts` - `/p/:slug/*` routes with `resolveProperty` middleware
- `src/routes/admin.ts` - `/admin` dashboard + `/admin/system`
- `src/routes/listing.ts`, `availability.ts`, `quote.ts` - Legacy routes (default property)
- `src/routes/messages.ts` - `/admin/messages*` — Hostex thread list, detail, send, feedback
- `src/routes/reviews.ts` - `/admin/reviews*` — guest-review drafts (#377): list, detail, done/discard/regenerate
- `src/routes/suggestions.ts` - `/admin/suggestions*` — vault suggestion review + approve/discard
- `src/routes/admin-layout.ts` - Shared HTML page shell used by messages + reviews + suggestions routes

### Guest-Reply Services
- `src/services/draft-service.ts` - `generateDraftForThread()`: builds prompt, calls Claude, returns reply text or null
- `src/services/message-sender.ts` - `sendReply()`: provider-dispatch (Hostex only); atomic claim in caller
- `src/services/suggestion-service.ts` - `generateSuggestion()`: LLM-proposes vault edit (target_heading + bullet)
- `src/services/vault-writer.ts` - `applySuggestion()`: path-safe write + git-commit to vault
- `src/services/vault-knowledge.ts` - `loadVoice()` + `loadPropertyFacts()`: reads vault files, gated on `VAULT_PATH`
- `src/mappers/hostex/message-mapper.ts` - Maps Hostex conversation detail → thread + messages (Text only)
- `src/repositories/message-repository.ts` - Upsert + query for `message_threads` / `messages`
- `src/jobs/hostex/sync-hostex-messages.ts` - Per-property Hostex message sync with detail cache
- `src/jobs/sync-guesty-messages.ts` - Per-property Guesty conversation sync (läuft non-fatal im Guesty-ETL + Sync-Button)
- `src/jobs/generate-drafts.ts` - Provider-agnostic draft generation with cap + age gate
- `src/services/guesty-channel.ts` - `resolveOutboundModuleType()`: Kanal-Spiegelung für Guesty-Sends

### Guest-Review Services (#377)
- `src/jobs/generate-review-drafts.ts` - `generateReviewDraftsForProperty()`: finds fresh checkouts, classifies, generates, caps
- `src/services/review-draft-service.ts` - `generateReviewForStay()`: own prompt block, Tool `submit_review`
- `src/utils/review-classifier.ts` + `review-classifier-prompt.ts` - `classifyStayForReview()`: `ok`/`flagged`, own prompt/few-shots
- `src/repositories/review-draft-repository.ts` - CRUD for `review_drafts` (migration 023)
- `src/repositories/reservation-repository.ts` - `getRecentCheckoutIdsNeedingReview()`
- `src/repositories/message-repository.ts` - `getThreadsByReservationId()` (Guesty) + `getThreadsByListingAndGuestName()` (Hostex fallback)

### Auto-Send-Gate Services (Migration 027)
- `src/services/auto-send/{types,mode,berlin-day,mechanical-checks,judge-prompt,judge-service,policy,runner}.ts` - Gate-Kette (Spec 2026-09-19)
- `src/services/draft-send-service.ts` - `sendClaimedDraft()`: atomarer Claim + Versand, auch für manuelles Senden
- `src/services/guesty-webhook-signature.ts` - Svix-Signaturprüfung für den Guesty-Webhook
- `src/routes/webhooks-guesty.ts` - `POST /api/webhooks/guesty`, vor `express.json()` gemountet
- `src/jobs/message-loop.ts` - eigener `MESSAGE_LOOP_MINUTES`-Takt: Sync → Entwürfe → Gate
- `src/jobs/handle-guesty-inbound.ts` - lädt die Konversation beim Webhook-Treffer frisch nach
- `src/scripts/register-guesty-webhook.ts` - `npm run webhook:register`
- `src/scripts/test-judge-fixtures.ts` - `npm run test:judge`, Live-Lauf gegen `JUDGE_MODEL`
- `src/test-fixtures/judge/cases.json` - 11 Testfälle fürs Prüfmodell

### Frontend
- `public/calendar.js` - Calendar with property context (`window.__PROPERTY_SLUG__`, `__PROPERTY_NAME__`, `__BOOKING_EMAIL__`)
- `public/calendar.css` - Mobile-first responsive design
- **Widget i18n (DE/EN)**: the booking widget is fully bilingual — all UI labels, the
  booking-email body, ARIA labels and currency/date formatting live in a `de`/`en` translations
  object in `calendar.js`. Language selection (`detectLanguage()`) precedence: **`?lang=de|en`
  URL param (if valid) > browser language > `de` default**. Embed an English page via
  `/p/:slug?lang=en` (append the param to the iframe `src`). `detectLanguage()` runs before any
  network call and sets `document.documentElement.lang`, so there is no English-flash for DE
  visitors. Adding a new string means adding the key to BOTH language blocks.
- **iframe-Embedding (WICHTIG)**: im iframe öffnet das Widget mailto NICHT selbst — es sendet
  `postMessage({type: 'OPEN_MAILTO', url}, '*')` an die Eltern-Seite und bricht dann ab
  (`openMailtoLink()` in `calendar.js`; `postMessage` wirft nie, daher greifen die Fallbacks im
  iframe nie). **Jede einbettende Website MUSS einen `message`-Listener einbauen**, sonst macht
  der „Buchung anfragen"-Button stumm gar nichts (so geschehen beim farmhouse-prasser.de-Relaunch
  2026-07). Snippet + Details: `WEBFLOW_IFRAME_INTEGRATION.md`; Referenz-Implementierung:
  farmhouse-prasser.de-Repo, `assets/js/main.js` Section 7 (mit Origin- und mailto-Scheme-Guard).
  Zweite Anforderung: die CSP `frame-ancestors` (gesetzt in der Caddy-Config auf dem Server,
  nicht im App-Code) muss die Domain der einbettenden Seite whitelisten, sonst lädt das iframe
  gar nicht erst.

## Environment Variables

**Note:** Per-property settings (booking email, timezone, weekly report, GA4) are in `data/properties.json`. The `.env` variables are legacy fallbacks.

Required:
- `GUESTY_CLIENT_ID`, `GUESTY_CLIENT_SECRET` - Guesty OAuth credentials
- `BASE_URL` - Public URL (e.g., `https://guesty.remoterepublic.com`)
- `SESSION_SECRET` - Random 32+ char string for sessions
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` - Google OAuth for admin
- `ADMIN_ALLOWED_EMAILS` - Comma-separated email whitelist
- `RESEND_API_KEY` - Resend email service API key
- `EMAIL_FROM_ADDRESS` - Sender email (verified domain)
- `EMAIL_FROM_NAME` - Sender display name (e.g., "Remote Republic Booking")

Optional:
- `GUESTY_PROPERTY_ID` - Legacy single-property fallback
- `PORT` (default: 3000), `DATABASE_PATH` (default: ./data/calendar.db)
- `CACHE_AVAILABILITY_TTL` - Minutes between ETL runs (default: 60)
- `LOG_LEVEL` (default: info), `LOG_PRETTY` (default: false)
- `ANTHROPIC_API_KEY` - Required for AI draft generation and vault suggestions (also used by the existing classifier)
- `VAULT_PATH` - Absolute path to the knowledge vault repo; enables AI drafts + feedback loop. Without it, draft-gen is a no-op and vault-writer aborts safely
- `HOSTEX_ACCESS_TOKEN` - Hostex API token (required for Hostex properties)
- `DRAFT_GEN_CAP` - Max AI drafts per property per ETL run (default: 10)
- `DRAFT_MAX_AGE_HOURS` - Only draft threads with guest activity newer than this (default: 72 hours)
- `AUTO_SEND_MODE` - `off`|`shadow`|`live`, Auto-Send-Gate (default: `off`), see Auto-Send-Gate section
- `AUTO_SEND_DAILY_CAP` - Max automatisch versendete Entwürfe pro Kalendertag Europe/Berlin (default: 10)
- `MESSAGE_LOOP_MINUTES` - Takt des eigenständigen Nachrichten-Loops (default: 5)
- `JUDGE_MODEL` - Modell für die Auto-Send-Prüfung (default: `claude-opus-5`)
- `GUESTY_WEBHOOK_SECRET` - Svix-Secret des Guesty-Webhooks, aus `npm run webhook:register`

## Guesty API Quirks

- OAuth tokens: 24h validity, cached until 5min before expiry
- Calendar endpoint: unwrap `data.days` from response
- Rate limits: 15 req/sec, 120 req/min, 5000 req/hour
- `listings.nickname` may be null → fallback to `title`
- Tax codes: `AF` = accommodation fare, `CF`/`CLEANING` = cleaning fee
- **Quirk**: `limit=100` returns all reservations, but `limit=1000` returns fewer
- **Airbnb money fields**: `hostPayout`/`subTotalPrice` are NET of the Airbnb commission (host
  side) — NOT what the guest paid. The guest-paid amount = `fareAccommodationAdjusted` (accommodation
  net of guest discounts like length-of-stay) `+ fareCleaning + totalTaxes`. `invoiceItems`: `LOSD`
  = length-of-stay discount (guest discount), `PCM` = "Host channel fee" (commission, NOT a guest
  discount). See the Airbnb-invoice rule under Document Generation.

## Agent-API (Angebots-Workflow, seit 07/2026)

API-Key-geschützte Endpoints für den maschinellen Angebots-Workflow
(Spec: `docs/superpowers/specs/2026-07-24-agent-reservierung-design.md`):

- Auth: Header `X-Agent-Key` gegen die Vereinigungsmenge aus `AGENT_API_KEY` (Einzelwert, Legacy) und `AGENT_API_KEYS` (kommagetrennte Liste, Whitespace toleriert) aus `.env`, aufgelöst in `config.agentApiKeySet` — jeder Key min. 32 Zeichen, Vergleich zeitkonstant; kein Key konfiguriert → 503, falscher Key → 401 (#671).
- `POST /api/agent/reservations` — Gast + Hold (`reserved`, `reservedUntil: -1`) + Angebots-PDF; Body siehe `src/services/reservation-service.ts` (`CreateOfferInput`).
- `GET /api/agent/reservations/:id` · `GET …/:id/offer.pdf` (`?refresh=1` = frische Guesty-Daten, Nummer stabil) · `POST …/:id/confirm` · `POST …/:id/cancel` · `PUT /api/agent/guests/:guestId` (Kundenstamm-Nachpflege)
- **Kundenstamm:** Gast beim Anlegen IMMER mit `address` (street/city/zipcode/country) + `phone` versorgen — die Anschrift fließt aus dem Guesty-Gastdatensatz ins Angebots-/Rechnungs-PDF (Regel Micha, 24.07.2026).
- Admin-Pendant: Formular unter `/admin/reservations/new`.
- Hold-Fristen verwaltet der aufrufende Agent (kein Auto-Expiry in der App; `holdUntil` ist rein informativ).
- **Firmenkunden-Konvention (Guesty-Beschränkung):** Firmenname ins `firstName`-Feld, Ansprechpartner ins `lastName`-Feld (z. B. firstName "S. Fischer Verlage GmbH", lastName "Katharina Matroß") — der Rechnungs-/Angebotsgenerator erkennt Firmen daran automatisch (COMPANY_SUFFIXES) und formatiert entsprechend. Gilt auch für die Agent-API.
- **Nummernkreise:** Quelle ist `document_sequences` in der Server-DB — wird ein Angebot/eine Rechnung MANUELL außerhalb der App nummeriert, den Zähler nachziehen (Admin-UI `/admin/system` oder `POST /admin/api/document-sequence`), sonst laufen Automatik und Hand auseinander (Abgleich 24.07.2026: quote=28, invoice=27).
- **Gäste-Messaging (read-only, seit 08/2026):** `GET /api/agent/threads?since=<ISO>&limit=<n>` (Default: letzte 7 Tage, 50 Treffer, neueste zuerst) — Liste mit `threadId`, `source`, `property` (Kürzel/Name), `guestName`, `needsReply`, `lastMessageAt`/`lastMessageDirection`. `GET /api/agent/threads/:threadId` — Thread-Metadaten + alle Nachrichten (`direction`, `sender`, `body`, `sentAt`, aufsteigend). Nur lesend — kein Draft-/Send-Zugriff über die Agent-API.

**Guesty-Verhalten (Smoke-Test 24.07.2026):**
- `POST /reservations-v3` antwortet mit `reservationId` (nicht `_id`); Creates werden ASYNCHRON verarbeitet — sofortiger `GET /reservations/{id}` kann 404en (Service pollt bis ~18 s).
- Ein Hold (`reserved`) ist NICHT stornierbar — Freigabe = Status **`closed`** (`PUT /reservations-v3/{id}/status`): nur `closed` entfernt auch die Kalender-Blöcke des Holds inkl. Puffer-Blöcken (Guesty-Doku + Fall Büchler 14.08.2026 — manuell gesetztes `expired` ließ die Blöcke stehen und ist auf bereits expirte Reservierungen nicht mehr korrigierbar, Status-PUT 404t dann). `canceled` gilt für bestätigte Reservierungen und verlangt einen `cancellationReason` aus fester Liste.
- **Sonderpreise via `totalGross`** (Ziel-GESAMTSUMME inkl. Reinigung + USt): der Service rechnet rückwärts auf den `accommodationFare`-Override — `fare = (totalGross/(1+USt-Satz) − fareCleaning) / Rabattfaktor`. USt-Satz und Rabattfaktor (`fareAccommodationAdjusted/fareAccommodation`, z. B. Length-of-Stay 10 %) kommen aus der Quote, denn Guesty schlägt die USt AUF und wendet Rate-Plan-Rabatte AUCH auf Overrides an (verifiziert 24.07.2026: Ziel 500 € → Punktlandung). Reinigungsgebühr bleibt separater Posten; `actualTotal` in der Antwort ist der Kontrollwert.
- `documents.reservation_id` hat einen FK auf die lokale `reservations`-Tabelle → der Service spiegelt die frische Reservierung sofort lokal (ETL überschreibt später). Achtung Follow-up: nach Hold-Freigabe räumt `deleteStaleReservationsInRange` die Zeile + Dokument-Zeile wieder ab.

## Git & Deployment

### Commit Conventions
Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`, `perf:`

### Repository Structure
```
main (default branch)
├── data/properties.json    # Multi-property config (commit this)
├── data/templates/         # PDF templates (commit these)
├── src/                    # TypeScript source
├── public/                 # Static frontend
├── .env                    # Secrets (NEVER commit)
└── data/calendar.db        # SQLite DB (ignored)
```

### Production Server
- **Host**: `deploy@guesty.remoterepublic.com`
- **Path**: `/opt/guesty-calendar-app`
- **Process**: PM2 (`guesty-calendar`), requires nvm sourcing for CLI commands
- **Proxy**: Caddy with auto-SSL on port 3005
- **Deploy**: `git pull && npm install && npm run build && pm2 restart guesty-calendar`
- **Logs**: `pm2 logs guesty-calendar --lines 50`
- **Health**: `curl https://guesty.remoterepublic.com/health`

### Production Checklist
- [ ] `data/properties.json` present with all properties
- [ ] All properties synced (`sync-property.ts <slug>` for each)
- [ ] `.env` configured (Guesty API, OAuth, Resend, session secret)
- [ ] Google OAuth callback URL set for production domain
- [ ] Health check responding
- [ ] Weekly report recipients configured per property
- [ ] GA4 service account configured (if applicable)
