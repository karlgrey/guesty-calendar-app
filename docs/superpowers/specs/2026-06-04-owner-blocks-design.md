# Owner Blocks überall korrekt behandeln — Design

**Datum:** 2026-06-04
**Status:** Spec (genehmigt im Brainstorming)
**Betrifft:** `src/mappers/airbnb-mail/availability-mapper.ts`, `src/repositories/availability-repository.ts`,
`src/jobs/sync-google-calendar.ts` (+ neuer Block-Helper), `src/services/bi-calendar.ts`,
`src/services/bi-email-templates.ts`, `src/types/bi-report.ts`, `src/jobs/bi-email.ts`,
`src/jobs/weekly-email.ts` (mittelbar), `src/routes/admin.ts` (Dashboard-Abgleich).

## Problem & Recherche-Ergebnis

Owner Blocks (Eigentümer-Sperren) sollen überall korrekt erfasst und behandelt werden.
Empirische Recherche an Live-Daten (Bootshaus 4.–7.6.):

- Blocks **kommen an** und landen als `status='blocked'` in der DB (Guesty/Hostex). Der
  öffentliche Buchungskalender sperrt sie korrekt (prod-API liefert `blocked`). Der **Sync→DB-Schritt
  ist nicht das Problem.**
- Die echten Lücken sind nachgelagert:
  - **G1 — Google-Calendar-Sync:** `sync-google-calendar.ts` pusht nur Reservierungen in die
    geteilten Owner-Kalender → geblockte Tage fehlen dort komplett.
  - **G2 — Belegungsrate:** `getOccupancyRate` zählt `blocked` als *belegt* → Owner Blocks
    verzerren die Quote (überhöht).
  - **G3 — Florence falsch klassifiziert:** Airbnb-iCal Owner Blocks (`SUMMARY:Airbnb (Not available)`,
    real vorhanden: 4 Stück) werden als **Buchung** gespeichert (`status='booked'`,
    `block_type='reservation'`) statt als `blocked`.
  - **G4 — `block_type` inkonsistent:** Guesty→`'manual'`, Hostex→`null`, Florence→`'reservation'`.

## Leitentscheidungen

1. **Kanonischer Marker:** `status='blocked'` = „nicht vermietbar, kein Umsatz", providerübergreifend.
   Nach dem Florence-Fix gilt das einheitlich; alle Konsumenten richten sich nach `status`.
2. **Belegungsformel (statistisch korrekt, Branchenstandard):**
   **`Belegung = gebuchte Nächte ÷ (gesamt − geblockte Nächte)`** — geblockte (nicht verkaufbare)
   Tage werden aus der Basis herausgerechnet. Zusätzlich werden **geblockte Tage separat
   ausgewiesen** (Transparenz). Korrekt und fair (keine Bestrafung für selbst gesperrte Tage),
   ohne Blocks als Umsatz zu zählen.
3. **GCal-Scope:** **alle** `status='blocked'`-Tage werden gepusht; Titel **mit Grund wo bekannt**.
4. **YAGNI:** keine feinere Block-Sub-Klassifizierung (owner vs. channel) erzwingen, wo Provider
   den Grund nicht liefern (Hostex). `block_type` ist informativ; Metriken/Sync keyen auf `status`.

## Arbeitspaket A — Florence-Klassifizierung (Fundament, G3/G4)

**Datei:** `src/mappers/airbnb-mail/availability-mapper.ts` (+ Test).

Die Airbnb-iCal liefert zwei Event-Typen, unterscheidbar am `summary`:
- `Reserved` → echte Gastbuchung → `status='booked'`, `block_type='reservation'`, `block_ref=reservationCode`.
- `Airbnb (Not available)` (bzw. summary enthält „not available", case-insensitive) → Owner Block →
  `status='blocked'`, `block_type='owner'`, `block_ref=null`.

`buildAvailabilityRows` klassifiziert pro Tag das überdeckende Event entsprechend; kein Event → `available`.
`AirbnbIcalEvent.summary` ist bereits vorhanden (Parser liefert es) — keine Parser-Änderung nötig.
Reservierungen bei Florence kommen aus E-Mails, nicht aus iCal → **keine** Doppel-Erfassung, Owner Blocks
erzeugen keine `reservations`-Zeile.

Guesty/Hostex-Mapper bleiben unverändert (liefern bereits `status='blocked'`).

**Tests:** „Not available"-Event → blocked/owner; „Reserved"-Event → booked/reservation; gemischtes
Fenster; case-insensitive Match.

## Arbeitspaket B — Belegungsrate (G2)

**Datei:** `src/repositories/availability-repository.ts` (+ Test); Konsumenten-Abgleich.

- **Neu: `getOccupancyBreakdown(listingId, start, end)`** → `{ bookedDays, blockedDays, sellableDays,
  totalDays, rate }` (EINE SQL-Aggregation):
  - `bookedDays` = `status='booked'`; `blockedDays` = `status='blocked'`; `totalDays` = alle;
    `sellableDays = totalDays − blockedDays`; `rate = sellableDays > 0 ? round(bookedDays/sellableDays*100) : 0`.
- **`getOccupancyRate`** wird DRY auf `getOccupancyBreakdown(...).rate` zurückgeführt (eine einzige
  Belegungs-Definition, keine doppelte SQL).
- **Konsumenten-Abgleich:** `getDashboardStats` (admin) muss dieselbe Definition verwenden — prüfen
  und ggf. auf `getOccupancyBreakdown`/das neue `getOccupancyRate` umstellen, damit Dashboard,
  Weekly-Mail und BI-Mail konsistent sind. `weekly-email.ts` und `bi-email.ts` profitieren automatisch
  (sie rufen `getOccupancyRate`).

**Tests:** Formel (10 gebucht, 5 geblockt, 30 gesamt → 40%); Randfall alles geblockt → 0%; Breakdown-Felder.

## Arbeitspaket C — Google-Calendar-Block-Sync (G1)

**Dateien:** `src/jobs/sync-google-calendar.ts` (Integration) + neuer reiner Helper
`src/services/google-calendar-blocks.ts` (Span-Bildung + Event-Bau, voll testbar).

- **Span-Bildung (pure):** `buildBlockSpans(days: Array<{date, status, block_type}>)` →
  zusammenhängende `blocked`-Spannen `[{ startDate, endExclusive, blockType }]` (Tage mit gleichem/
  beliebigem block_type werden zu einer Spanne zusammengefasst, sobald die Daten lückenlos
  aufeinanderfolgen; block_type der Spanne = block_type des ersten Tages).
- **Event-Bau (pure):** `buildBlockEvent(span, propertyName)` → Ganztags-Event:
  - `start.date = startDate`, `end.date = endExclusive` (Google-exklusiv).
  - `summary` **mit Grund wo bekannt**: `owner`→„🔒 Owner-Block", `maintenance`→„🔒 Blockiert (Wartung)",
    `manual`→„🔒 Blockiert (manuell)", sonst (null/`reservation` darf hier nicht vorkommen)→„🔒 Blockiert".
  - `transparency='opaque'`, `extendedProperties.private = { kind: 'owner-block' }` (Cleanup-Marker).
  - **Event-ID:** `toGoogleEventId('blk-' + listingId + '-' + startDate)` (stabil, base32hex-safe via
    bestehender Helper; Namespace `blk-` vermeidet Kollision mit Reservierungs-IDs).
- **Sync-Integration** in `syncGoogleCalendarForProperty` (gleicher Kalender, gleiche Kadenz):
  1. Verfügbarkeit `today … +365` laden (`getAvailability`), `blocked`-Spannen bilden.
  2. Jede Block-Spanne upserten; gewünschte Block-Event-IDs sammeln.
  3. **Cleanup:** `listEvents(calendarId, today, +365)` → Events mit
     `extendedProperties.private.kind==='owner-block'`, deren ID nicht im gewünschten Set ist, löschen.
     (Reservierungs-Events sind nicht markiert → bleiben unberührt.)
  4. Rate-Limit-Delays wie beim Reservierungs-Sync (200 ms).
  - Ergebnis-Counter um `blockEventsUpserted` / `blockEventsDeleted` erweitern.

**Tests:** `buildBlockSpans` (zusammenhängend, mit Lücken, leer, gemischte block_types); `buildBlockEvent`
(Datum exklusiv, Titel je block_type, `extendedProperties`-Marker, Event-ID stabil).

## Arbeitspaket D — BI-Mail-Sichtbarkeit (G4)

**Dateien:** `src/services/bi-calendar.ts`, `src/types/bi-report.ts` (mittelbar), `src/jobs/bi-email.ts`,
`src/services/bi-email-templates.ts` (+ Tests).

- **`DayState`** um `'blocked'` erweitern (heute: `'booked' | 'free' | 'turnover'`). `buildGanttGrid`:
  `status='blocked'` → `'blocked'` (statt wie bisher zu `'booked'` zusammengefasst); `status='booked'` →
  `'booked'`; Turnover-Logik unverändert (überschreibt).
- **Template-Farbe:** `COLORS.blocked` = eigene, klar unterscheidbare Farbe (z. B. grau `#b9bfb6`).
  Kalender-Legende um „blockiert" ergänzen.
- **KPI-Tabelle:** pro Property „Owner-Block-Tage" der nächsten 6 Wochen ausweisen (aus
  `getOccupancyBreakdown(listingId, today, +42)` → `blockedDays`); Portfolio-Summe analog. `PropertyKpi`
  um `blockedDays6wk: number` erweitern; Template zeigt eine Spalte oder einen kompakten Hinweis.
- Da die Belegung (Paket B) bereits korrigiert ist, spiegelt die KPI-Belegung jetzt die verkaufbare
  Auslastung; die Block-Tage stehen transparent daneben.

## Datenfluss (Ziel)

```
Provider-Sync → availability(status: available|booked|blocked, block_type)
   ├─ Florence: iCal SUMMARY → blocked/owner | booked/reservation   (Paket A)
   ├─ Guesty/Hostex: unverändert (status='blocked' vorhanden)
   ↓
Konsumenten richten sich nach status='blocked':
   ├─ getOccupancyRate/Breakdown → gebucht/(gesamt−geblockt) + blockedDays   (Paket B)
   │     → BI-Mail-KPI, Weekly-Mail, Admin-Dashboard
   ├─ Google-Calendar: blocked-Spannen als „🔒…"-Events + Cleanup            (Paket C)
   └─ BI-Gantt: eigener DayState 'blocked' + Farbe; KPI Block-Tage           (Paket D)
```

## Reihenfolge / Abhängigkeiten

A (Fundament) zuerst — danach sind B, C, D unabhängig voneinander umsetzbar (alle keyen auf
`status='blocked'`, das nach A providerübergreifend korrekt ist).

## Fehlerbehandlung

- GCal-Block-Sync: pro Spanne try/catch + Warn-Log (wie Reservierungs-Sync); ein Fehler kippt nicht
  den ganzen Sync. Cleanup-`listEvents`-Fehler wird geloggt, blockiert die Upserts nicht.
- Florence-Mapper bleibt rein/total; unbekannte Summaries werden als Buchung behandelt (sicherer
  Default: lieber als belegt zeigen als fälschlich frei) — wird im Test fixiert.

## Tests (Vitest)

- `airbnb-mail/availability-mapper.test.ts`: Klassifizierung (Paket A).
- `availability-repository`-Tests: verkaufbare Belegung + Breakdown (Paket B), via In-Memory-DB-Seam.
- `google-calendar-blocks.test.ts`: Span-Bildung + Event-Bau (Paket C).
- `bi-calendar.test.ts`: `blocked`-DayState; `bi-email-templates.test.ts`: Block-Farbe/Legende +
  Block-Tage-Anzeige; `bi-email.test.ts`: `blockedDays6wk` in KPI (Paket D).

## Bewusst nicht in v1 (YAGNI)

- Rück-Sync: in Google Calendar manuell erstellte Blocks zurück in die Provider schreiben.
- Owner-Blocks in diesem Tool anlegen/verwalten (nur lesen/spiegeln).
- Feinere Hostex-Grund-Klassifizierung (Provider liefert keinen Grund).

## Offene Detailfrages für die Umsetzung

- Exakte Block-Farbe im Gantt beim Implementieren festlegen (Vorschlag `#b9bfb6`, in Tests fixiert).
- `getDashboardStats`: beim Implementieren prüfen, ob es `getOccupancyRate` aufruft oder eine eigene
  Belegungsberechnung hat — und konsistent auf die neue Definition bringen.
