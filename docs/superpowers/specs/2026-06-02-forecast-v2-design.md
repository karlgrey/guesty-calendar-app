# Forecast v2 — Design (Umsatz-Ausblick, geschichtetes Modell)

**Datum:** 2026-06-02
**Status:** Spec (genehmigt im Brainstorming)
**Ersetzt:** den Forecast-Abschnitt (④) aus `2026-06-02-portfolio-bi-email-design.md`.
**Betrifft:** `src/services/forecast.ts`, `src/jobs/bi-email.ts`, `src/types/bi-report.ts`,
`src/services/bi-email-templates.ts`, `src/config/properties.ts` (Ramp-up-Parameter).

## Ziel

Der Forecast-Block der AirBnB-Portfolio-Mail wird neu gebaut:
- **Fokus Umsatz (€)** statt Belegung (Belegung steht schon in der KPI-Tabelle).
- Pro Monat **fest gebucht · erwartet · Spanne (konservativ–optimistisch)** + **Konfidenz**.
- **Historische Daten werden bevorzugt** und auf das laufende Jahr extrapoliert; der
  Buchungsvorlauf (Lead-Time/Pickup) ist nur noch **Fallback**; neue Inserate bekommen eine
  **Ramp-up-Annahme**, damit leere Zukunftsmonate nicht als „0" erscheinen.
- Ein **Methoden-Satz** erklärt in der Mail, wie die Prognose entsteht.

Die alte Darstellung (gestapelte Belegungs-Balken mit ±%-Band) entfällt vollständig.

## Datenlage (Stand 2026-06-02)

- Historische Monatsumsätze liegen pro Property in den Reservierungen (`reservations`, dauerhaft).
  Beispiel Farmhouse 2025: Jul 8.800 · Aug 3.634 · Sep 42.097 · Okt 2.162 · Nov 14.152 · Dez 6.449 €.
  → Für **Farmhouse Jul–Nov 2026** existiert eine echte Vorjahresbasis. Andere Properties sind
  jünger (<12 Monate) → dort greift Pickup oder Ramp-up.
- Historische **Belegung** ist NICHT verlässlich (availability-Tabelle wird nach vorn gepflegt,
  Vergangenheit teils gelöscht). Deshalb basiert der Forecast auf **Umsatz aus Reservierungen**.

## Modell: geschichtete Methodenwahl

Für jede **Property × Prognosemonat M** wird der „erwartet"-Wert nach folgender Priorität bestimmt.
`committed` = bereits bestätigter Umsatz für M (OTB, aus `getRevenueForCheckInMonth`).

### Basis-Erwartung (`base`)

1. **Historisch (bevorzugt)** — wenn die Property im selben Monat eines Vorjahres aktiv war:
   - `priorMonth = M − 12 Monate` (jüngstes verfügbares Vorjahr).
   - `histBase = getRevenueForCheckInMonth(listing, priorMonth)`.
   - „aktiv damals" = `listingStart <= Beginn(priorMonth)`, wobei `listingStart` = frühestes
     `check_in` der Property (`getAllTimeStats().startDate`).
   - `base = histBase × growth`.
   - `growth` = mittlerer YoY-Faktor über Monate, in denen Vor- und aktuelles Jahr beide Werte
     haben, geклippt auf `[0.5, 2.0]`; **Default `1.0`** wenn (noch) nicht berechenbar (aktuell
     bei allen Properties der Fall, da <13 Monate Historie).

2. **Pickup (Fallback)** — wenn kein Vorjahresmonat existiert:
   - `share = shareOnBooksAt(curve, daysUntilMidpoint(M))` (gepoolte Lead-Time-Kurve, wie v1).
   - `base = committed / share`.

### Ramp-up-Boden (nur neue Inserate)

Wenn die Property **jünger als `rampMonths`** ist (`monthsSince(listingStart) < rampMonths`),
wird `base` nach unten abgesichert, damit ferne Monate nicht ~0 ergeben:

- `monthsSinceStart` = volle Monate zwischen `listingStart` und Monatsmitte von M.
- `rampFactor = clamp(monthsSinceStart / rampMonths, 0, 1)` (linearer Hochlauf 0→1).
- `adr` = property-eigener ADR (`currentYear.totalRevenue / totalBookedDays`), sonst
  `static.basePrice`, sonst Portfolio-Ø-ADR.
- `rampBaseline = rampFactor × steadyOccupancyPct × Tage(M) × adr`.
- `base = max(base, rampBaseline)`.

### Endwerte je Monat

- `expected = max(committed, base)` (nie unter dem, was schon gebucht ist).
- **Spanne** (`spread` abhängig von Methode/Datenlage):
  - `low  = max(committed, base × (1 − spread))`
  - `high = base × (1 + spread)` (mind. `expected`)
  - `spread`: Historisch ≥2 Jahre `0.12` · Historisch 1 Jahr `0.20` · Pickup `0.30` · Ramp-up `0.40`.
- **„noch offen"**: wenn `expected ≈ committed` UND `committed` ~0 UND keine Methode eine Basis
  liefert (kein Vorjahr, Pickup auf 0, kein Ramp-Boden) → Monat als *„noch offen — kaum Buchungen,
  keine belastbare Hochrechnung"* ausweisen statt Nullzeile.

### Konfidenz pro Monat

Spiegelt Methode + Datentiefe + Horizont; **steigt automatisch mit mehr Historie**:

| Bedingung | Konfidenz |
|---|---|
| Historisch, ≥2 Vorjahre vorhanden | **hoch** |
| Historisch, 1 Vorjahr | **mittel** |
| Pickup, naher Monat (`share ≥ 0.5`) und genug Stichprobe (`curve.n ≥ 20`) | **mittel** |
| Pickup, ferner Monat oder dünne Stichprobe | **niedrig** |
| Ramp-up-dominiert (neues Inserat) oder „noch offen" | **niedrig** |

## Aggregation Portfolio

- `committed/expected/low/high` der Portfolio-Monatszeile = Summe über alle Properties.
- Portfolio-Monats-Konfidenz: **hoch**, wenn ≥60% des `expected`-€ aus „hoch"-Properties; **mittel**,
  wenn ≥60% aus „hoch"+„mittel"; sonst **niedrig**.
- Per-Property-Kompakttabelle: Σ `committed/expected/high` über die 6 Monate je Property + die
  „schlechteste" (konservativste) Monats-Konfidenz dieser Property als Property-Konfidenz + ein
  **Methoden-Label** (s. u.), damit pro Property erkennbar ist, **wie** die Prognose zustande kommt.

### Methoden-Label pro Property (Pflicht)

Damit transparent ist, worauf die Zahl je Property beruht, wird die **dominante Methode** über die
6 Monate ausgewiesen (die Methode mit dem größten Anteil an Σ `expected`):

| `method` | Label |
|---|---|
| `historical` | „Vorjahr" |
| `pickup` | „Buchungsvorlauf" |
| `rampup` | „Ramp-up (Anlauf)" |

Sind nicht alle 6 Monate dieselbe Methode (z. B. Farmhouse: Jun = Buchungsvorlauf, Jul–Nov =
Vorjahr), wird dem dominanten Label **„überw."** vorangestellt (z. B. „überw. Vorjahr").

## Darstellung in der Mail (Variante A)

1. **Methoden-Satz** (grau hinterlegt, oben im Block):
   > „So entsteht die Prognose: ‚fest' = bereits bestätigte Buchungen. ‚erwartet' nutzt — wenn
   > genug Historie vorliegt — die Vorjahreswerte (auf dieses Jahr hochgerechnet), sonst den
   > typischen Buchungsvorlauf; neue Inserate über eine Ramp-up-Annahme. Die Spanne zeigt
   > konservativ → optimistisch. Die Konfidenz steigt, je mehr Buchungshistorie vorliegt."

2. **Portfolio-Tabelle** (6 Monate): `Monat | fest | erwartet | opt. | Range-Balken | Konfidenz`.
   - Range-Balken: kräftig = `fest` (Anteil an `high`), schwarzer Strich = `erwartet`, hell = bis `opt.`
   - „noch offen"-Monate: eine zusammengefasste, kursive Zelle statt Zahlen, Konfidenz „niedrig".
   - **Σ-Zeile** über 6 Monate (fest/erwartet/opt.).

3. **Per-Property-Kompakttabelle**: `Property | fest | erwartet | opt. | Methode | Konfidenz`
   (Σ 6 Monate). Die Spalte **Methode** zeigt das Methoden-Label (z. B. „Vorjahr", „überw. Vorjahr",
   „Buchungsvorlauf", „Ramp-up (Anlauf)") — so steht pro Property dabei, wie die Daten entstehen.

4. **Legende**: fest gebucht · erwartet · Spanne bis optimistisch.

Email-sicher: Tabellen + Inline-Styles, keine externen CSS/JS. Konfidenz-Badges:
hoch `#d8ece0/#2f7a52`, mittel `#fbeecc/#9a7b1e`, niedrig `#eee/#888`.

## Konfiguration (Ramp-up-Parameter)

Globale Defaults, pro Property via `static` überschreibbar:
- `rampMonths` = **12**
- `steadyOccupancyPct` = **0.60**

Ablage: ein optionaler Block `forecast` im Top-Level `biReport` (Geschwister von `recipients`),
z. B. `"forecast": { "rampMonths": 12, "steadyOccupancyPct": 0.60 }`; Property-Override über
`static.steadyOccupancyPct` (Zahl 0–1) bzw. `static.rampMonths`. Beide optional, Defaults greifen.

## Architektur & Komponenten

### `src/services/forecast.ts` (pure, erweitert)
Neue/erweiterte reine Funktionen — weiterhin **keine** Date-Abhängigkeit intern (Aufrufer liefert
`daysUntilMidpoint`, `monthsSinceStart`, `daysInMonth`, `priorYearRevenue`):

```
interface MonthForecastInput {
  monthLabel: string;
  committedRevenue: number;
  daysUntilMidpoint: number;
  daysInMonth: number;
  monthsSinceStart: number | null;   // null = unbekannt/sehr alt → nicht „neu"
  priorYearRevenue: number | null;   // null = kein Vorjahresmonat verfügbar
  priorYearsAvailable: number;       // 0,1,2… für Konfidenz/Spread
  growth: number;                    // Default 1.0
  adr: number;
  rampMonths: number;
  steadyOccupancyPct: number;
  curve: LeadTimeCurve;
  propertySampleN: number;
}
interface MonthForecast {
  monthLabel: string;
  committedRevenue: number;
  expectedRevenue: number;
  lowRevenue: number;
  highRevenue: number;
  confidence: 'hoch' | 'mittel' | 'niedrig';
  method: 'historical' | 'pickup' | 'rampup';
  isOpen: boolean;                   // „noch offen"
}
export function forecastMonthRevenue(input: MonthForecastInput): MonthForecast
```

- `buildLeadTimeCurve`/`shareOnBooksAt` bleiben unverändert.
- Die alten occupancy-zentrierten Felder (`committedPct`, `projectedFinalPct`, `bandPct`) entfallen.

### `src/jobs/bi-email.ts`
- Pro Property zusätzlich sammeln: `listingStart` (`getAllTimeStats().startDate`),
  `adr`, und pro Prognosemonat `priorYearRevenue = getRevenueForCheckInMonth(listing, M−12)`,
  `priorYearsAvailable` (wie viele Vorjahre die Property im Monat aktiv war),
  `monthsSinceStart`, `daysInMonth`, `growth` (Default 1.0).
- `forecastMonthRevenue` je Property×Monat aufrufen; Portfolio-Monatswerte summieren,
  Portfolio-Konfidenz nach obiger Regel; Per-Property-Σ bilden.
- `committedRevenueHorizon` (Summenband) = Σ `committedRevenue` der Portfolio-Monate (unverändert).

### `src/types/bi-report.ts`
- `MonthForecast` (s. o., inkl. `confidence`/`method`/`isOpen`) ersetzt die alte Form.
  `portfolioForecast: MonthForecast[]` bleibt — die Portfolio-Monats-Konfidenz steckt direkt im
  jeweiligen `MonthForecast.confidence` (keine Parallel-Struktur).
- `PropertyForecast` bekommt eine Σ-Sicht über den Horizont: `committedTotal`, `expectedTotal`,
  `highTotal`, `confidence` (konservativste Monats-Konfidenz der Property) und `methodLabel`
  (dominante Methode + ggf. „überw."-Präfix, s. o.). Das alte `months: MonthForecast[]` bleibt
  erhalten (für evtl. spätere Detailtiefe), wird in der Mail aber nur als Σ gezeigt.

### `src/services/bi-email-templates.ts`
- `renderForecastBars` → `renderForecastTable` (Portfolio) + `renderForecastByProperty` (kompakt).
- Methoden-Satz + Legende + Konfidenz-Badges. `eur()`/`h()` wiederverwenden.

### `src/config/properties.ts`
- Optionaler `forecast`-Block in `biReportConfigSchema`; `static`-Schema um optionale
  `steadyOccupancyPct` (0–1) und `rampMonths` (int ≥1) erweitern.

## Tests (Vitest)
- `forecast.test.ts` erweitern:
  - Historisch: Vorjahresumsatz × growth, `expected ≥ committed`, Konfidenz hoch/mittel je
    `priorYearsAvailable`.
  - Pickup-Fallback: wie bisher (kein Vorjahr).
  - Ramp-up: junges Inserat, ferner Monat → `expected ≈ rampFactor×steadyOcc×Tage×ADR`,
    `rampFactor` monoton mit `monthsSinceStart`, Konfidenz niedrig.
  - „noch offen": kein Vorjahr, committed 0, kein Ramp-Boden → `isOpen=true`.
  - Spread/Range: `low ≤ expected ≤ high`, `low ≥ committed`.
- `bi-email.test.ts`: Methodenwahl-Routing (Farmhouse-Monat mit/ohne Vorjahr), Portfolio-Σ und
  Portfolio-Konfidenz-Aggregation, Per-Property-Σ.
- `bi-email-templates.test.ts`: Tabelle statt Balken, Konfidenz-Badges, „noch offen"-Zeile,
  Methoden-Satz vorhanden, **Per-Property-Methoden-Label** sichtbar (z. B. „Vorjahr"/„Ramp-up").
- `bi-email.test.ts` zusätzlich: dominantes `methodLabel` je Property korrekt (inkl. „überw."-Fall
  bei gemischten Methoden).

## Bewusst nicht in v2 (YAGNI)
- Echte Saisonkurven/Glättung über mehrere Vorjahre (sobald ≥2 Jahre da sind, nur `growth`-Mittelung).
- Wetter-/Event-/Preiselastizität.
- Konfigurierbare Spread-Werte (fix im Code, in Tests fixiert).

## Offene Umsetzungsdetails
- Exakte `growth`-Mittelung (welche Monate zählen) beim Implementieren festlegen; aktuell immer 1.0,
  da keine YoY-Überlappung existiert — Pfad trotzdem implementieren und testbar machen.
- Portfolio-Konfidenz-Schwelle (60%) im Code als Konstante, in Tests fixiert.
