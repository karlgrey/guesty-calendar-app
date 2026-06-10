# „Aktuell belegt"-Block im Admin-Panel — Design

**Datum:** 2026-06-10
**Status:** Spec (genehmigt im Brainstorming)
**Betrifft:** `src/repositories/reservation-repository.ts`, `src/repositories/availability-repository.ts`
(`getDashboardStats`), `src/routes/admin.ts` (Endpoint `/admin/dashboard-data` + Inline-Frontend).

## Problem

Das Admin-Panel schaltet zwischen „Next 12 Months" (`period=future`) und „Last 12 Months"
(`period=past`) um. Eine **gerade laufende** Buchung (`check_in < heute` **und** `check_out ≥ heute`)
fällt durch beide Raster:
- `future` filtert auf `check_in ≥ heute` → laufende raus.
- `past` filtert auf `check_out < heute` → laufende raus.

Sie erscheint also in **keiner** Ansicht (weder in der Liste noch in den Stats/Umsatz von
`getDashboardStats`).

## Lösung (Überblick)

Ein eigener, **immer sichtbarer** Block „🛏️ Aktuell belegt" über der Buchungsliste, in **beiden**
Ansichten. Leer → Text „Aktuell nicht belegt". Die laufende Buchung wird zusätzlich in den
„future"-Kennzahlen mitgezählt. `getReservationsByPeriod` bleibt unangetastet (BI-/Weekly-/GCal-Pfade
nutzen die „future"=echte-Anreisen-Semantik weiter).

**Definition „laufend / in-house":** `date(check_in) ≤ heute` **und** `date(check_out) > heute`,
Status `confirmed`/`reserved`. (Abreisetag = heute zählt **nicht** mehr als belegt.)

## Komponenten

### 1. `getCurrentReservations(listingId)` — `reservation-repository.ts` (neu)
```
SELECT * FROM reservations
WHERE listing_id = ?
  AND date(check_in) <= date('now')
  AND date(check_out) > date('now')
  AND status IN ('confirmed','reserved')
ORDER BY check_in ASC
```
Gibt `Reservation[]` zurück (via `rowToReservation`, wie die anderen Read-Funktionen). Reine,
isoliert testbare Funktion; **kein** Eingriff in `getReservationsByPeriod`.

### 2. `getDashboardStats('future')` zählt Laufende mit — `availability-repository.ts`
Die Umsatz-/Anzahl-Abfrage der `future`-Periode wechselt von `check_in >= date('now')` auf
**`check_out > date('now')`** (= laufend + zukünftig, „noch nicht abgereist"). `past`-Zweig
(`check_out < date('now')`) bleibt unverändert. Kein Doppelzählen (laufende nur in `future`).
`getDashboardStats` wird ausschließlich vom Admin verwendet → keine Nebenwirkungen.
(Die belegungs-/occupancy-Tage in `getDashboardStats` basieren bereits auf dem Datumsfenster
ab heute und enthalten die laufenden Nächte schon — nur die Reservierungs-Umsatzabfrage hatte die
Lücke.)

### 3. Endpoint `/admin/dashboard-data` — `admin.ts`
Zusätzlich `currentBookings` im Response: `getCurrentReservations(propertyId)` mit **demselben
Mapping** wie `bookings` (inkl. `quoteNumber`/`invoiceNumber` aus `getDocumentByReservation`).
Das `bookings`-Feld (Period-Liste) bleibt wie es ist — da laufende Buchungen in keiner Period-Liste
vorkommen, gibt es **keine Doppelanzeige**.

### 4. Inline-Frontend — `admin.ts`
- **Markup:** ein Container `#currentBookingsBlock` direkt **über** `#bookingsTable` (innerhalb der
  Bookings-Section). Überschrift „🛏️ Aktuell belegt".
- **Renderer DRY:** das bestehende Zeilen-Rendering der Buchungsliste (der `data.bookings.map(...)`-
  Block inkl. der Tabellen-Kopfzeile und der Dokument-Buttons `generateDocument`/`refreshDocument`)
  wird in eine gemeinsame JS-Funktion `renderBookingsTable(bookings)` extrahiert, die einen kompletten
  Tabellen-HTML-String liefert. Buchungsliste **und** Block nutzen sie.
- **Verhalten:** Der Block ist **immer** sichtbar (beide Perioden). `currentBookings.length > 0` →
  `renderBookingsTable(currentBookings)`; sonst → `<p>Aktuell nicht belegt</p>`.
- Da die Dokument-Buttons nur die `reservationId` brauchen, funktionieren Angebot/Rechnung im Block
  identisch zur Liste.

## Datenfluss
```
/admin/dashboard-data?period=…&property=…
  ├─ getDashboardStats(propertyId,365,period)      // future zählt laufende mit
  ├─ getReservationsByPeriod(propertyId,365,period) → bookings   (unverändert)
  └─ getCurrentReservations(propertyId)            → currentBookings (neu)
Frontend:
  ├─ #currentBookingsBlock: renderBookingsTable(currentBookings) | "Aktuell nicht belegt"
  └─ #bookingsTable:        renderBookingsTable(bookings) | "No … bookings found"
```

## Tests (Vitest, In-Memory-DB-Seam)
- `getCurrentReservations`:
  - laufende Buchung (check_in gestern, check_out morgen) → drin.
  - rein zukünftige (check_in morgen) → draußen.
  - rein vergangene (check_out gestern) → draußen.
  - Abreise heute (check_out = heute) → draußen.
  - abgesagte/declined (Status ≠ confirmed/reserved) → draußen.
- `getDashboardStats('future')`: eine laufende Buchung wird in `totalBookings`/`totalRevenue`
  mitgezählt; `'past'` zählt sie nicht. (Setzt In-Memory-`reservations`- + `availability`-Tabellen.)

## Bewusst nicht (YAGNI)
- Keine Änderung an `getReservationsByPeriod` (würde BI-/Weekly-/GCal-„Anreisen" verfälschen).
- Keine neue Period-Option im Toggle; der Block deckt „jetzt" ab.
- Kein eigenes Styling-Framework — bestehende Tabellen-/Button-Styles wiederverwenden.

## Offene Detailfrage für die Umsetzung
- Exakte Einfügestelle/Heading-Styling im Inline-HTML beim Implementieren festlegen (bestehende
  Section-/`h2`-Stile spiegeln).
