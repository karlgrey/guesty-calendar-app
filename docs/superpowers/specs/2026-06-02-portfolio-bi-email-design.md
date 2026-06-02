# Portfolio-BI-Mail — Design

**Datum:** 2026-06-02
**Status:** Spec (genehmigt im Brainstorming)
**Autor:** Brainstorming-Session (Claude + mca)

## Ziel

Eine wöchentliche, zusammenfassende „Business-Intelligence"-Mail über **alle** Properties
des Portfolios — ein konsolidierter Überblick statt fünf einzelner Weekly-Reports. Sie
zeigt Belegung, Kennzahlen und einen ehrlichen Forecast auf einen Blick.

Die Mail ergänzt die bestehenden per-Property-Weekly-Reports (diese laufen unverändert
weiter); sie ersetzt sie nicht.

## Kontext & Datenlage

5 Properties über 3 Provider, alle EUR:

| Property | slug | Provider | Buchungen | Historie ab |
|---|---|---|---|---|
| Farmhouse Prasser | `farmhouse` | Guesty | 54 | Jul 2025 |
| Uferstrasse 19 | `u19` | Guesty | 32 | Feb 2026 |
| Alte Schilderwerkstatt | `alte-schilderwerkstatt` | Hostex | 14 | Mär 2026 |
| Bootshaus an der alten Oder | `bootshaus-alte-oder` | Hostex | 5 | Mär 2026 |
| Urban Luxury Loft – Florence | `firenze-loft` | Airbnb-Mail | 5 | Mai 2026 |

**Datenrealität (entscheidend für den Forecast):** Insgesamt ~110 Buchungen, <1 Jahr
Historie, 3 von 5 Properties erst seit ~2–3 Monaten. → Klassisches Year-over-Year-/
Saison-Forecasting ist **jetzt noch nicht seriös**. Verlässlich verfügbar:
- **On-the-books (OTB)**: Summe zukünftiger Reservierungen — 100% verlässlich.
- **Lead-Time-Kurve**: aus `reservations.reserved_at` (Buchungsdatum) vs. `check_in`.
  Gemessen (n=39 mit Buchungsdatum): Median 33 Tage Vorlauf; 49% der Buchungen fallen in
  die letzten 30 Tage vor Anreise, 74% in 60, 90% in 90 Tage. Trägt einen Pickup-Forecast.

`reserved_at` ist bei Hostex/Airbnb-Mail teilweise NULL → diese Buchungen zählen voll zum
OTB, fließen aber nicht in die Lead-Time-Kurve ein (Kurve wird portfolioweit gepoolt).

## Empfänger & Rhythmus

- **Empfänger:** Owner (eine zentrale Management-Adresse, konfigurierbar als Liste).
- **Rhythmus:** wöchentlich, Montag früh (Default `day=1`, `hour=6`), konfigurierbar.
- Respektiert das bestehende `DEV_EMAIL_OVERRIDE` (alle Mails außerhalb Production an eine
  Adresse umgeleitet).

## Mail-Aufbau (5 Abschnitte)

1. **Header + Portfolio-Summenband**
   Umsatz YTD · Ø Belegung nächste 6 Wochen · Buchungen YTD · fest gebucht (kommende 6 Monate).

2. **Übersichtskalender** — Tages-Gantt
   - Horizont: **6 Wochen (42 Tage)**, Start = heute.
   - Eine Zeile pro Property (5 Zeilen), jede Zelle = 1 Tag.
   - Zustände: **belegt** / **frei** / **Turnover** (Tag mit Ab- *und* Anreise — eigene Farbe).
   - Datums-Labels (Monat + Tag, z.B. „2 Jun") am Beginn jedes 7-Tage-Blocks (keine KW).

3. **Nächste Anreisen & Turnovers** — operative Liste
   - Die **nächsten 5 Anreisen portfolioweit** (über alle Properties gemerged, nach
     `check_in` sortiert).
   - Je Eintrag: Datum · Property · Gast · Nächte · Personen · Quelle (source/platform) ·
     **Turnover-Flag** (an der Property am selben Tag auch ein Check-out).

4. **Kennzahlen pro Property** — Tabelle, eine Zeile je Property + Portfolio-Summenzeile
   - Belegung nächste 6 Wochen (%) und letzte 30 Tage (%)
   - Umsatz YTD · Umsatz aktueller Monat · Δ zum Vormonat
   - Buchungen YTD · ADR (Ø-Nächtigungspreis = Umsatz ÷ belegte Nächte)
   - Umsatz = `host_payout` (netto), konsistent mit den bestehenden Reports.

5. **Forecast** — fest gebucht + Pickup-Hochrechnung
   - Horizont: **6 Monate**, sowohl **portfolioweit** als auch **pro Property**.
   - Pro Monat: committed (OTB) Belegung **und** Umsatz, plus erwarteter Pickup bis Monatsende.
   - **Pickup-Kurve wird portfolioweit gepoolt** (eine Lead-Time-Verteilung über alle
     Reservierungen) und auf den OTB-Stand jeder Property angewandt → Per-Property-Prognosen
     ohne Scheingenauigkeit bei dünner Datenbasis.
   - **Konfidenzband** wächst mit dem Horizont (nahe Monate eng, ferne breit).
   - Properties mit zu wenig Historie bekommen ein **breiteres Band + „dünne Datenbasis"-Flag**.
   - YoY-Saisonvergleich ist bewusst **nicht** Teil von v1 (kommt, wenn genug Historie da ist).

## Architektur & Komponenten

Kleine, isoliert testbare Einheiten. Bestehende Repo-Funktionen werden wiederverwendet
(`getAllTimeStats`, `getCurrentYearStats`, `getOccupancyRate`, `getMonthlyBookingComparison`,
`getReservationsByPeriod`, `getAvailability`).

### `src/services/forecast.ts` (pure functions)
- `buildLeadTimeCurve(reservations)` → kumulative „booked-share" nach Tagen-vor-Anreise
  (portfolioweit gepoolt; ignoriert Buchungen ohne `reserved_at`).
- `forecastMonthOccupancy(otbNights, capacityNights, monthsAhead, curve)` →
  `{ committedPct, projectedFinalPct, confidenceBand, lowData }`.
- `forecastMonthRevenue(otbRevenue, monthsAhead, curve)` → analog für Umsatz.
- Konfidenzband als Funktion des Horizonts + Stichprobengröße der Property.
- **Was sie tut:** rechnet aus OTB + gepoolter Kurve einen geschätzten Endstand.
  **Abhängigkeiten:** keine (reine Funktionen auf übergebenen Daten).

### `src/services/bi-calendar.ts` (pure functions)
- `buildGanttGrid(perProperty: { slug, name, availability, reservations }, startDate, days=42)`
  → pro Property ein Array von `'booked' | 'free' | 'turnover'` je Tag.
- Turnover-Erkennung: Tag D ist Turnover, wenn an der Property an D ein Check-out **und** ein
  Check-in liegt (aus Reservierungen abgeleitet).
- Datums-Label-Positionen (alle 7 Tage).

### `src/jobs/bi-email.ts` (Orchestrierung)
- `sendBiReportEmail()`:
  1. Lädt alle Properties (`getAllProperties`).
  2. Sammelt je Property: Listing, KPIs (reuse Repos), Availability (42 Tage), zukünftige
     Reservierungen.
  3. Baut Gantt-Grid (`bi-calendar.ts`), Anreisen-Liste (merge + sort + top 5), Forecast
     (`forecast.ts`), Portfolio-Summen.
  4. Rendert über `bi-email-templates.ts`, sendet via `sendEmail` (Resend).
- `shouldSendBiReport()`: timezone-aware Schedule-Check (analog `shouldSendWeeklyEmailForProperty`).
- **Fehlerbehandlung:** Property-Fehler kippen nicht die ganze Mail — werden gesammelt,
  vorhandene Daten gerendert, fehlende Teile mit Warnhinweis markiert (Pino-Log mit `propertySlug`).

### `src/services/bi-email-templates.ts`
- `generateBiReportEmail(model)` → `{ html, text }`.
- Email-sicheres HTML: Tabellen-Layout, inline styles, keine externen CSS/JS.
- Text-Variante als Fallback.

### Scheduler & Config
- `data/properties.json` bekommt einen **neuen Top-Level-Block** `biReport` (Geschwister von
  `properties`), Zod-validiert im Properties-Loader:
  ```json
  "biReport": {
    "enabled": true,
    "recipients": ["..."],
    "day": 1,
    "hour": 6,
    "timezone": "Europe/Berlin",
    "forecastHorizonMonths": 6
  }
  ```
- `src/jobs/scheduler.ts`: stündlicher Check über `shouldSendBiReport()`, State `biReportSent: Date`
  (analog zur per-Property-Weekly-Logik), Versand einmal pro geplantem Slot.
- `src/scripts/test-bi-email.ts`: sendet die BI-Mail sofort (zu Test/DEV_EMAIL_OVERRIDE-Adresse).

## Datenfluss

```
scheduler (stündlich)
  └─ shouldSendBiReport()  ── timezone-aware, day/hour aus biReport
       └─ sendBiReportEmail()
            ├─ getAllProperties()
            ├─ je Property: Listing + KPIs (Repos) + Availability(42d) + future Reservations
            ├─ bi-calendar.buildGanttGrid()        → Kalender-Grid + Turnovers
            ├─ merge+sort future reservations       → nächste 5 Anreisen (+ Turnover-Flag)
            ├─ forecast.buildLeadTimeCurve(all)     → gepoolte Pickup-Kurve
            ├─ forecast.forecast{Occupancy,Revenue} → 6-Monats-Forecast portfolio + je Property
            ├─ Portfolio-Summen (YTD, Ø Belegung, committed 6 Mon)
            └─ bi-email-templates.generateBiReportEmail() → sendEmail (Resend)
```

## Fehlerbehandlung

- Property ohne Listing/Daten → übersprungen, im Log als WARN mit `propertySlug`, in der Mail
  als „keine Daten" markiert; restliche Mail wird normal versendet.
- Buchungen ohne `reserved_at` → zählen voll zum OTB, fehlen nur in der Lead-Time-Kurve.
- Forecast bei sehr dünner Property-Historie → breiteres Konfidenzband + „dünne Datenbasis"-Flag,
  keine harte Fehlersituation.

## Tests (Vitest, mock DB)

- `forecast.test.ts`: Lead-Time-Kurve (bekannte Eingaben → erwartete kumulative Anteile),
  OTB-Hochrechnung, Konfidenzband wächst mit Horizont, lowData-Flag bei kleiner Stichprobe.
- `bi-calendar.test.ts`: Grid-Länge = 42, korrekte booked/free-Zuordnung, **Turnover-Erkennung**
  (Check-out + Check-in am selben Tag), Label-Positionen.
- `bi-email.test.ts` (oder KPI-Aggregations-Tests): Portfolio-Summen, ADR-Berechnung,
  Top-5-Anreisen-Merge/Sort über mehrere Properties, Fehler-Isolation einer Property.

## Bewusst nicht in v1 (YAGNI)

- YoY-/Saison-Forecast (Datenbasis reicht noch nicht).
- Conversion-Rate-Spalte (nur Guesty hätte Daten; im Brainstorming verworfen).
- „Nächste Anreise"-Spalte in der KPI-Tabelle (durch Abschnitt 3 abgedeckt).
- Pro-Empfänger-gefilterte Varianten der Mail (ein Owner-Empfänger genügt).

## Offene Punkte für die Umsetzung

- Konkrete Konfidenzband-Formel (z.B. Funktion aus Horizont-Monaten und n der Property)
  beim Implementieren festlegen und im Test fixieren.
- Farbwahl Turnover-Tag im Kalender (eigene, gut unterscheidbare Farbe).
