# Agent-API: Reservierung + Angebot anlegen (Design)

**Datum:** 2026-07-24 · **Kontext:** SmartTasks #275 (Befähigung Claude:
Angebots-Workflow für Direktanfragen komplett selbstständig) · **Erstanwendung:**
Anfrage Nina Lattke / Netlight (Farmhouse, 09.–10.09.2026, Retreat-Pauschale)

## Ziel

Ein Aufruf legt für eine Direktanfrage (Guesty-Objekte: `farmhouse`, `u19`) einen
Gast und eine **Hold-Reservierung mit Ablaufdatum** in Guesty an und erzeugt
direkt das **Angebots-PDF mit fortlaufender Nummer** über den bestehenden
Dokumenten-Flow. Auslösbar auf zwei Wegen:

1. **Agent-API** (API-Key, headless) — für Claude
2. **Admin-UI-Formular** (bestehende Session-Auth) — für Micha

Zusätzlich zwei Folge-Aktionen, damit der komplette #275-Zyklus maschinell
bedienbar ist: **bestätigen** (Hold → confirmed) und **rausnehmen** (Hold
stornieren/freigeben).

## Entscheidungen (Micha, 24.07.2026)

| Frage | Entscheidung |
|---|---|
| Zugang | Agent-API (API-Key) **und** Admin-UI-Formular |
| Default-Status | Hold (`reserved`) **mit Ablaufdatum**; blockt den Kalender, verfällt ohne Zusage |
| Preis | Manuell mitgegebene Pauschale; ohne Angabe Fallback auf Guesty-Quote |
| Umfang | Reservierung + Angebots-PDF in einem Aufruf |

## Schritt 0: Erkundungs-Spike (MUSS zuerst)

Die App liest bisher nur aus Guesty (einzige Writes: `POST /quotes`,
`send-message`). Unverifiziert ist, ob die Guesty Open API beim Erstellen einer
Reservierung (a) einen **manuellen Pauschalpreis** und (b) ein
**Hold-Ablaufdatum** akzeptiert. Der Spike prüft gegen die offizielle
Open-API-Doku (open-api-docs.guesty.com) + einen Test-Call, welcher der drei
Wege trägt — in dieser Reihenfolge:

1. **Direkt `POST /reservations`** (Status `reserved`, Gast inline oder via
   guests-crud, Preis-Override, `expiresAt`/vergleichbares Feld) — sauberster Weg.
2. **Quote-Flow:** bestehenden `getQuote` erweitern → Reservierung aus Quote
   erstellen; Pauschalpreis ggf. über Rabatt-/Adjustment-Feld abbilden.
3. **Fallback (garantiert machbar):** Kalender-Block in Guesty
   (Availability-Write) + Reservierungsdaten nur lokal in der App-DB;
   `document-service` bekommt einen lokalen Datenpfad statt
   `fetchDocumentDataFromGuesty`.

### Spike-Ergebnis (24.07.2026, Doku-Recherche — WEG 1 TRÄGT)

Quelle: open-api-docs.guesty.com (Reservations V3 Booking Flow + Referenz
`POST /reservations-v3` „Quick Booking", `PUT /reservations-v3/{id}/status`).

- **`POST /v1/reservations-v3`** erstellt Reservierungen direkt (ohne Quote).
  Pflicht: `checkInDateLocalized`, `checkOutDateLocalized` (YYYY-MM-DD),
  `listingId`, `source`, `status`, `guestsCount`.
  `status`-Enum enthält `reserved` (Hold), `confirmed`, `inquiry` u. a.
- **Preis-Override beim Erstellen:** `accommodationFare` (number ≥ 0,
  „override the calculated nightly rates") + `cleaningFee` — Pauschalpreise
  gehen also DIREKT im Create-Call, kein Nach-Adjustieren nötig.
- **Gast:** `guestId` (empfohlen: vorher via guests-crud anlegen) oder
  Inline-`guest`-Objekt (`firstName`, `lastName`, `email`, `phones`).
- **⚠️ `reservedUntil` ist enum-beschränkt:** −1 (unbefristet), 10/15/30 min,
  24 h, 48 h, 72 h — **max. 72 Stunden**. Angebots-Holds brauchen aber oft
  1–2 Wochen → **Design-Anpassung:** wir setzen `reservedUntil: -1` und
  verwalten die Hold-Frist SELBST: `holdUntil` wird lokal gespeichert
  (documents-/reservations-Snapshot) und von Claude über die #275-Routine
  überwacht (nachfassen → bestätigen oder via Cancel-Endpoint freigeben).
  Kein App-eigener Auto-Expiry-Scheduler (YAGNI; kann später kommen).
- **Statuswechsel:** `PUT /v1/reservations-v3/{id}/status` (z. B. auf
  `confirmed`); Stornieren = Status `canceled`.
- Nützliche Flags: `ignoreCalendar`/`ignoreBlocks` (Default false — wir lassen
  sie false, damit Guesty Konflikte selbst ablehnt).

Im Implementierungsplan bleibt als Rest-Verifikation ein **echter Test-Call**
(Anlegen + sofort stornieren) — die Doku-Lage ist eindeutig, Weg 2/3 entfallen.

## Architektur

Neue Bausteine folgen den bestehenden Mustern (Services + Repositories +
Routes, Bottleneck-Rate-Limiter, Zod-Env-Config).

### 1. `src/services/guesty-client.ts` — neue Write-Methoden

- `createGuest(data)` — nur falls der Reservierungs-Call den Gast nicht inline
  nimmt (guests-crud POST).
- `createReservation({listingId, checkIn, checkOut, guestsCount, guest, money?, status: 'reserved', holdUntil})`
- `updateReservationStatus(reservationId, 'confirmed' | 'canceled')`

Alle über den bestehenden Limiter/Token-Cache, analog `sendConversationMessage`.

### 2. `src/services/reservation-service.ts` — Orchestrierung (neu)

`createOfferReservation(input)` in dieser Reihenfolge (kein Nummern-Verbrennen:
das Dokument entsteht erst, wenn die Reservierung steht):

1. **Verfügbarkeit prüfen:** lokale `availability` UND Guesty-Kalender live
   für den Zeitraum → bei Konflikt Abbruch mit 409.
2. **Preis bestimmen:** `priceGross` bzw. `priceNet` aus dem Input; fehlt
   beides → Guesty-Quote (`getQuote`) als Fallback.
3. **Gast + Hold-Reservierung in Guesty anlegen** (Status `reserved`,
   `reservedUntil: -1`; die fachliche Hold-Frist `holdUntil` — Default
   **14 Tage** — wird lokal gespeichert und per #275-Routine überwacht,
   siehe Spike-Ergebnis).
4. **Angebot erzeugen:** bestehender `document-service`
   (`createOrGetDocument(reservationId, 'angebot')`) → fortlaufende Nummer
   `A-YYYY-NNNN`, PDF.
5. **Availability lokal upserten**, damit der öffentliche Kalender sofort
   blockt (der reguläre ETL zieht ohnehin nach).

Rückgabe: `{ reservationId, guestId, documentNumber, pdfPath, holdUntil, priceSource: 'manual' | 'quote' }`.

Dazu: `confirmReservation(id)` und `releaseReservation(id)` (Status-Update in
Guesty + lokales Availability-Update; Dokumente bleiben unangetastet).

### 3. `src/routes/agent-api.ts` — neue Route `/api/agent/*` (neu)

- **Auth:** eigene Middleware `requireAgentKey` — Header `X-Agent-Key` gegen
  `AGENT_API_KEY` aus der Server-`.env` (Zod-Config; fehlt der Wert, ist die
  Route deaktiviert). Key zusätzlich in Claudes lokaler TheBrain2-`.env`.
  Konstantzeit-Vergleich, kein Key im Log.
- **Endpoints:**
  - `POST /api/agent/reservations` — Body:
    `{ propertyId, checkIn, checkOut, guestsCount, guest: {firstName, lastName, email, phone?, company?}, priceGross? | priceNet?, holdUntil?, note? }`
    → 201 mit Service-Rückgabe (PDF als Pfad/Download-URL).
  - `POST /api/agent/reservations/:id/confirm`
  - `POST /api/agent/reservations/:id/cancel`
  - `GET /api/agent/reservations/:id` — Status nachschauen (fürs Monitoren).
- Nur JSON, keine Session, kein CSRF; `propertyId` muss ein Guesty-Objekt aus
  `properties.json` sein (sonst 400).

### 4. Admin-UI — Formular „Neue Reservierung + Angebot"

Im bestehenden `/admin`-Dashboard (`src/routes/admin.ts`): Formular mit
Objekt-Auswahl, Zeitraum, Gastdaten, Personenzahl, optionalem Pauschalpreis
und Hold-Frist → ruft denselben `reservation-service` auf, zeigt
Angebotsnummer + PDF-Link. Hinter `requireAuth` wie alles unter `/admin`.

## Fehlerbehandlung

- Zeitraum belegt → **409** mit belegten Tagen.
- Guesty-Fehler (4xx/5xx) → unverändert durchreichen (Status + Message),
  nichts Halbes zurücklassen: schlägt das Dokument nach erfolgreicher
  Reservierung fehl, Reservierung NICHT stornieren, sondern 207-artige Antwort
  `{reservation: ok, document: error}` — Angebot lässt sich über den
  bestehenden Admin-Flow nachziehen.
- Ungültige Eingaben (Datum, Objekt, Preis ≤ 0) → 400 vor jedem Guesty-Call.

## Tests

- **Vitest-Units** für `reservation-service` mit gemocktem Guesty-Client:
  Preis-Fallback, Konflikt-409, Reihenfolge (Dokument erst nach Reservierung),
  Teilfehler-Fall.
- **Middleware-Test** für `requireAgentKey` (fehlender/falscher/richtiger Key,
  deaktivierte Route ohne Env).
- **Ein echter Probelauf** gegen Guesty mit stornierbarer Test-Reservierung
  (kurzer Zeitraum, sofort wieder released) — danach der Nina-Fall als
  Erstanwendung.

## Nicht-Ziele

- Keine Änderungen am Rechnungs-Flow und an den Nummernkreisen.
- Keine Hostex-/Airbnb-Mail-Objekte (nur Guesty: `farmhouse`, `u19`).
- Kein automatisches Nachfassen/Erinnern (macht Claude über SmartTasks
  #275-Routine, nicht die App).
- Keine Änderung am Storno-Sync (Bug #271 ist ein separater Task).

## Betrieb / Deploy

- Server-`.env` um `AGENT_API_KEY` ergänzen (generierter Zufallswert),
  PM2-Restart nach Deploy (`/opt/guesty-calendar-app`, Prozess
  `guesty-calendar`).
- Key-Ablage für Claude: TheBrain2-`.env` (gitignored); Nutzungs-Doku als
  Abschnitt in [[Gäste-Messaging-Automation]] bzw. SmartTasks-Doc, ohne Key.
