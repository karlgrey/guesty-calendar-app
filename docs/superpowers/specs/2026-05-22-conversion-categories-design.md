# Conversion-Classifier — neue Kategorien & property-übergreifende Vereinheitlichung

**Datum:** 2026-05-22
**Status:** Genehmigt
**Scope:** `guesty-calendar-app` — Conversion-Tracking-Classifier (`/admin/conversions`)

## Kontext & Ziel

Das Conversion-Dashboard klassifiziert Message-Threads in Kategorien. Der `OTHER`-Topf
ist zu groß und heterogen — er enthält erkennbare, wiederkehrende Muster (Werbung an den
Host, Drehanfragen, reine Vorab-Fragen, Absagen wegen Belegung), die als eigene Kategorien
mehr Aussagekraft hätten.

**Ziel:** vier neue Kategorien, eine Umbenennung, **ein** property-übergreifender
Classifier (keine property-spezifischen Regeln). Die Kategorien gelten für u19 *und*
Farmhouse (und alle künftigen Guesty-Properties).

**Grundlage:** Sichtung der 21 `OTHER`-Threads der u19 + Farmhouse-BI-Analyse
(`data/bi-farmhouse-conversion.md`).

## Kategorien-Set (Endzustand)

| Code | Dashboard-Label | Emoji | Was | Erkennung |
|---|---|---|---|---|
| `CONFIRMED` | Bestätigt | ✅ | Buchung zustande gekommen | auto (Reservierungs-Status) |
| `REPEAT` | Wiederbucher | 🔁 | Stammgast | manuell |
| `SPAM` | Werbung | 📣 | Cold-Pitch **an den Host** (Dienstleistung/Marketing) | **neu** · auto |
| `COMMERCIAL` | Dreh & Kooperation | 🎬 | Foto-/Videodreh, Influencer-/Marken-Koop | **neu** · auto |
| `PARTY` | Party / Hochzeit | 🎉 | Hochzeit, Feier, Geburtstag, Day-Use-Event | **umbenannt** von `WEDDING` |
| `DIRECT_DRIFT` | Direct-Drift | ↗ | Off-Platform-Versuch | auto (nur Nicht-Direct-Email) |
| `PRICE` | Preisverhandlung | € | Preisverhandlung | auto |
| `NO_AVAILABILITY` | Kein Termin | 🚫 | Host sagt nur wegen Belegung ab | **neu** · auto |
| `INFO` | Vorab-Frage | ❓ | Gast-Frage, keine Buchung, kein anderes Signal | **neu** · auto (schwach) |
| `PLAN_CHANGE` | Planänderung | 📅 | Gast-Plan ändert sich | manuell |
| `OTHER` | Sonstiges | ◌ | Rest | Fallthrough |

**SPAM vs. COMMERCIAL** — die kritische Abgrenzung: SPAM = jemand verkauft dem Host *eine
Leistung* („Verwaltung deiner Ferienwohnung", „360°-Rundgang", „Bewertungsscore steigern")
→ gar kein Gast. COMMERCIAL = jemand will *die Unterkunft kommerziell nutzen* („ich bin
Fotograf/in, suche eine Location"). SPAM läuft vor COMMERCIAL, host-gerichtete Pitches sind
also schon raus, bevor COMMERCIAL prüft.

## Erkennungslogik

### Priorität (first match wins)

```
CONFIRMED → SPAM → COMMERCIAL → PARTY → DIRECT_DRIFT → PRICE → NO_AVAILABILITY → INFO → OTHER
```

`REPEAT` und `PLAN_CHANGE` haben **kein** Auto-Rule — sie werden nur manuell im Dashboard
gesetzt (Status quo, unverändert).

SPAM früh, damit ein Pitch mit „Budget"/„Event" nicht als `PRICE`/`PARTY`
missklassifiziert wird. COMMERCIAL vor PARTY, deshalb wandern die Dreh-Begriffe aus der
PARTY-Regex hierher.

### CONFIRMED — unverändert
`reservation_status ∈ {confirmed, reserved, active}` → confidence 1.0.

### SPAM (neu) — Cold-Pitch an den Host
Quelle: **Inbound**-Text. Erkennt host-gerichtete Dienstleistungs-/Marketing-Angebote.
- Starke Einzelphrasen: `ich unterstütze (hosts|gastgeber|vermieter)`, `auslastung
  steigern`, `umsatz steigern`, `bewertungsscore`, `feedback-lösung`,
  `360°[ -]?rundgang`, `mehr buchungen … generieren`
  - *Hinweis (Code-Review Task 2):* `channel ?manager`/`kanalmanager` und
    `kostenlos testen` wurden bewusst **nicht** aufgenommen — sie produzieren
    False Positives auf echte Gast-Anfragen (Gast mit Berufsbezeichnung „Channel
    Manager"; Gast fragt „kann ich kostenlos …"). Der Cold-Pitch-Korpus wird auch
    ohne sie zuverlässig erkannt.
- Kombi-Signal: host-gerichtetes Possessivum (`dein|deine|Ihr|Ihre|eure` +
  `inserat|unterkunft|ferienwohnung|objekt|vermietung|listing`) + Angebots-/
  Service-Verb (`biete|unterstütze|optimiere|steigere|verwalte|vorstellen|helfe`)
- Confidence: 0.85 (Einzelphrase — präzise, eindeutig), 0.8 (Kombi-Signal — weicher).
  *Korrigiert ggü. erster Spec-Fassung: die starke Einzelphrase ist sicherer als
  das Possessiv+Verb-Kombi und bekommt daher die höhere Confidence.*

### COMMERCIAL (neu) — kommerzielle Nutzung der Unterkunft
Quelle: **Inbound**-Text. Läuft nach SPAM.
- `fotoshooting?|foto-?shoot|photo ?shoot|fotograf(in)?|videograf(in)?|videodreh|
  filmdreh|dreharbeiten|drehort|drehgenehmigung|musikvideo|content creator|
  content creation`
- Guest-seitige Kooperation: `influencer|reichweite|marken?kooperation`,
  `als location für`, `location für (ein|unser|mein|meine) (shoot|dreh|video|projekt)`
- Confidence: 0.8
- **Migration aus PARTY:** Die Begriffe `drehort|fotoshoot|photo-?shoot|musikvideo|
  video shoot` werden aus `EVENT_DAY_USE_RE` entfernt und hier aufgenommen.

### PARTY (umbenannt von WEDDING) — privates Event
Inhaltlich unverändert *minus* der nach COMMERCIAL verschobenen Dreh-Begriffe. Deckt
Hochzeit, Feier, Geburtstag, Taufe, Jubiläum, Day-Use/Veranstaltung. Confidence 0.85.

### DIRECT_DRIFT — unverändert
Off-Platform-Versuch; nur für Nicht-`direct_email`-Channels. Logik bleibt wie heute.

### PRICE — unverändert
Explizite Preisverhandlung. Logik bleibt wie heute.

### NO_AVAILABILITY (neu) — Host sagt wegen Belegung ab
Quelle: **Outbound**-Text (Host).
- `ausgebucht|(bereits|schon) (belegt|vergeben)|nicht mehr (verfügbar|frei)|
  leider (belegt|ausgebucht)|already booked|fully booked|not available|no availability`
- Greift nur, wenn `reservation_status` nicht confirmed (über die Priorität abgedeckt).
- Confidence: 0.8

### INFO (neu) — Vorab-Frage ohne Abschluss
Schwächstes Signal, vorletzte Stufe. Greift, wenn ein **Inbound**-Gast-Text eine Frage
enthält und nichts anderes matchte.
- Signal: Inbound enthält `?` **oder** Fragewörter (`wie|was|wann|wo|wieviel|
  ist es möglich|kann (ich|man)|könnt ihr|könnte ich|gibt es|habt ihr|is it possible|
  can i|do you|could you|how (much|many)`)
- Confidence: 0.4 — das Dashboard zeigt low-confidence-Treffer ohnehin zur Review.
- Bewusst breit: nach Abzug von SPAM/COMMERCIAL/PARTY/DRIFT/PRICE/NO_AVAILABILITY ist der
  Rest fast immer „Gast hat etwas gefragt". `OTHER` schrumpft dadurch auf echten Rest-Müll.

### OTHER — Fallthrough
Nur noch echter Rest (leere/system-only Threads, Statements ohne Frage). Confidence 0.3.

## Touchpoints

1. **`src/types/messages.ts`** — `ConversionCategory` ist hier *und* im Classifier
   dupliziert. **Dedup:** Der Typ bleibt kanonisch in `types/messages.ts`, erweitert um
   die 4 neuen Werte, `WEDDING` → `PARTY`. Der Classifier importiert ihn von dort und
   re-exportiert (`export type { ConversionCategory }`) — so bleibt der bestehende Import
   in `sync-guesty-messages.ts` (`from '../utils/message-classifier.js'`) unverändert.

2. **`src/utils/message-classifier.ts`** — neue Regexes (`SPAM_RE`, `COMMERCIAL_RE`,
   `NO_AVAILABILITY_RE`, `INFO_RE`), Dreh-Begriffe aus `EVENT_DAY_USE_RE` entfernt,
   `classifyThread`-Priorität gemäß oben, `KEYWORD_INDEX` um Keywords der neuen Kategorien
   ergänzt (Dashboard-Transparenz), `WEDDING` → `PARTY` in Typ-Literal und Rückgabe.

3. **`src/routes/admin.ts`** — 5 Stellen:
   - `CATEGORY_LABELS` (≈ Z. 3580) — Rename `WEDDING`→`PARTY` + 4 neue Einträge
   - `ORDER` (≈ Z. 3589) → `['CONFIRMED','REPEAT','SPAM','COMMERCIAL','PARTY',
     'DIRECT_DRIFT','PRICE','NO_AVAILABILITY','INFO','PLAN_CHANGE','OTHER']`
   - `recatSelect`-`<option>`-Liste (≈ Z. 3562) — Rename + 4 neu
   - `ALLOWED_CATEGORIES` (≈ Z. 4077) — Rename + 4 neu
   - CSS `.bar-*` / `.badge-*` (≈ Z. 3329 / 3398) — Farben für SPAM, COMMERCIAL,
     NO_AVAILABILITY, INFO; `.bar-WEDDING`/`.badge-WEDDING` → `.bar-PARTY`/`.badge-PARTY`

4. **`src/utils/message-classifier.test.ts`** — bestehende `WEDDING`-Tests → `PARTY`;
   neue Test-Cases je neuer Kategorie; Prioritäts-Tests: SPAM schlägt PRICE, COMMERCIAL
   schlägt PARTY, NO_AVAILABILITY schlägt INFO.

5. **Neu: `src/scripts/reclassify-threads.ts <slug>`** — lädt alle Threads einer Property
   + ihre Messages aus der DB, ruft `classifyThread` neu auf, schreibt
   `conversion_category` / `classification_confidence` / `classification_keywords` zurück
   — **nur** für Threads mit `manually_categorized = 0`. Keine Guesty-API-/IMAP-Calls.
   Idempotent. Gibt Vorher/Nachher-Kategorienverteilung aus.

## Datenbestand

Kein DB-Migration / Schema-Change. `conversion_category` ist freitextiges `TEXT`.
Bestehende `WEDDING`-Zeilen werden durch den Reclassify-Lauf überschrieben. Manuelle
Overrides (`manually_categorized = 1`) bleiben unangetastet — **Ausnahme:** ein evtl.
manuell auf `WEDDING` gesetzter Thread behielte den alten Wert; solche Zeilen per
einmaligem SQL-Update `WEDDING` → `PARTY` mitziehen (Teil des Rollouts).

## Rollout

1. Branch `feat/conversion-categories`, Implementierung, `npm run lint` + `npm test` grün.
2. Lokal reclassifizieren:
   `npx tsx src/scripts/reclassify-threads.ts farmhouse` + `... u19`
3. Dashboard lokal prüfen (`localhost:3099/admin/conversions`) — Verteilung plausibel
   für beide Properties?
4. Merge nach `main`.
5. Production: `git pull && npm install && npm run build && pm2 restart guesty-calendar`,
   dann auf dem Server `reclassify-threads.ts farmhouse` + `u19` ausführen, plus
   SQL-Update für etwaige manuelle `WEDDING`-Overrides.

## Out of Scope

- Auto-Erkennung für `REPEAT` / `PLAN_CHANGE` — bleiben manuell.
- Scheduler-Integration des Message-Syncs — bleibt manuell (separat entschieden).
- u19-Direct-Email — u19 hat kein eigenes Postfach.
- BI-Analyse-Dokument `bi-u19-conversion.md` — separates Vorhaben.
