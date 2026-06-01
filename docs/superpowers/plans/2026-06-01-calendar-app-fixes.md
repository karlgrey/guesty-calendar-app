# Calendar App — Vier Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vier unabhängige Bugfixes in der Guesty Calendar App: (1) zwei Korrektheits-Bugs im Wochenreport, (2) Cent-Anzeige in der Anfragemail/Aufschlüsselung, (3) Pro-Nacht-Sonderpreise in der Preisaufschlüsselung, (4) korrekte Absender-URL in der generierten Mail.

**Architecture:** Backend = Node/TypeScript + better-sqlite3 + Vitest (Tests nur für reine Funktionen — bestehendes Repo-Muster). Frontend = Vanilla-JS (`public/calendar.js`, kein Test-Harness) → Verifikation manuell über die Quote-Endpoint-/Mail-Reproduktion. Property-Config via Zod-validierte `data/properties.json`.

**Tech Stack:** TypeScript, better-sqlite3, Zod, Vitest, Vanilla JS, Handlebars (nicht betroffen).

**Scope-Hinweis Task 1:** Der „Total Revenue" bleibt absichtlich `SUM(host_payout)` (Nutzer-Entscheidung „Zahl lassen"; die 202k↔214k-Differenz ist Daten-Drift durch einen nachträglich editierten manuellen `host_payout`, kein Code-Bug). Das `total_price`-Mismapping (`reservation-mapper.ts:60` → nur Unterkunftsrate) ist **bewusst out of scope**: ein Brutto-Gesamtpreis-Feld existiert im Guesty-`money`-Objekt nicht, ein Fix bräuchte API-Felderweiterung + Backfill von 115 Zeilen und ändert die (korrekte) Umsatzzahl nicht.

---

## File Structure

| Datei | Änderung | Verantwortung |
|-------|----------|---------------|
| `src/utils/year-range.ts` | **Create** | Reine Helper-Funktion `getYearRange(year)` → `{ start, endExclusive }` (testbar) |
| `src/utils/year-range.test.ts` | **Create** | Vitest für `getYearRange` |
| `src/repositories/availability-repository.ts` | **Modify** (~651–690) | `getCurrentYearStats` nutzt `getYearRange` mit exklusiver Obergrenze |
| `src/services/email-templates.ts` | **Modify** (355, 362, 549) | Label „Expected Revenue" → „Revenue" |
| `public/calendar.js` | **Modify** (633, 1010–1100, 1966–2050, 103–110) | `formatCurrencyExact`, Sonderpreis-Summe, Property-Website |
| `src/config/properties.ts` | **Modify** (82–103, ~155–177) | `website?`-Feld in Interface + Zod-Schema |
| `data/properties.json` | **Modify** (farmhouse) | `"website": "https://farmhouse-prasser.de"` |
| `src/routes/property-routes.ts` | **Modify** (79) | `window.__PROPERTY_WEBSITE__` injizieren |

---

## Task 1: Wochenreport — Jahresgrenze-Bug + Label-Fix

**Files:**
- Create: `src/utils/year-range.ts`
- Test: `src/utils/year-range.test.ts`
- Modify: `src/repositories/availability-repository.ts:651-690`
- Modify: `src/services/email-templates.ts:355,362,549`

**Problem:** In `getCurrentYearStats` filtert die SQL `AND check_in <= '2026-12-31'`. Da `check_in` ein Zeit-Suffix hat (`'2026-12-31T08:00:00+00:00'`), ist der String lexikografisch **größer** als `'2026-12-31'` → ein Check-in am 31.12. fällt aus der Jahresstatistik. Außerdem ist das Label „Expected Revenue" irreführend (zeigt Ist-Umsatz).

- [ ] **Step 1: Failing test für `getYearRange` schreiben**

`src/utils/year-range.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { getYearRange } from './year-range.js';

describe('getYearRange', () => {
  it('returns Jan 1 start and exclusive next-year start', () => {
    expect(getYearRange(2026)).toEqual({
      start: '2026-01-01',
      endExclusive: '2027-01-01',
    });
  });

  it('endExclusive lets a Dec-31 check_in with time suffix still match a < comparison', () => {
    const { endExclusive } = getYearRange(2026);
    // String-Vergleich: '2026-12-31T08:00:00+00:00' < '2027-01-01' === true
    expect('2026-12-31T08:00:00+00:00' < endExclusive).toBe(true);
    // und ein Januar-Check-in des Folgejahres wird ausgeschlossen
    expect('2027-01-01T00:00:00+00:00' < endExclusive).toBe(false);
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run src/utils/year-range.test.ts`
Expected: FAIL — „Cannot find module './year-range.js'" bzw. `getYearRange is not a function`.

- [ ] **Step 3: `getYearRange` implementieren**

`src/utils/year-range.ts`:
```typescript
/**
 * Inclusive-start / exclusive-end Jahresgrenzen für DB-Vergleiche.
 *
 * `check_in` enthält in der DB ein Zeit-Suffix (z.B. '2026-12-31T08:00:00+00:00').
 * Ein `<= '2026-12-31'`-Vergleich würde den 31.12. fälschlich ausschließen.
 * Deshalb exklusive Obergrenze = Folgejahres-Anfang, abgefragt mit `< endExclusive`.
 */
export function getYearRange(year: number): { start: string; endExclusive: string } {
  return {
    start: `${year}-01-01`,
    endExclusive: `${year + 1}-01-01`,
  };
}
```

- [ ] **Step 4: Test laufen lassen, grün bestätigen**

Run: `npx vitest run src/utils/year-range.test.ts`
Expected: PASS (2 Tests).

- [ ] **Step 5: `getCurrentYearStats` auf `getYearRange` umstellen**

In `src/repositories/availability-repository.ts`, am Dateikopf importieren:
```typescript
import { getYearRange } from '../utils/year-range.js';
```

`getCurrentYearStats` (aktuell ~651–667) — ersetze den Block:
```typescript
  const currentYear = new Date().getFullYear();
  const yearStart = `${currentYear}-01-01`;
  const yearEnd = `${currentYear}-12-31`;

  try {
    const result = db
      .prepare(
        `SELECT
          COUNT(*) as total_bookings,
          SUM(COALESCE(host_payout, total_price, 0)) as total_revenue,
          SUM(nights_count) as total_booked_days
        FROM reservations
        WHERE listing_id = ?
          AND check_in >= ?
          AND check_in <= ?`
      )
      .get(listingId, yearStart, yearEnd) as {
```
durch:
```typescript
  const currentYear = new Date().getFullYear();
  const { start: yearStart, endExclusive: yearEndExclusive } = getYearRange(currentYear);

  try {
    const result = db
      .prepare(
        `SELECT
          COUNT(*) as total_bookings,
          SUM(COALESCE(host_payout, total_price, 0)) as total_revenue,
          SUM(nights_count) as total_booked_days
        FROM reservations
        WHERE listing_id = ?
          AND check_in >= ?
          AND check_in < ?`
      )
      .get(listingId, yearStart, yearEndExclusive) as {
```

- [ ] **Step 6: Label „Expected Revenue" → „Revenue" korrigieren**

In `src/services/email-templates.ts`:
- Zeile 355: `📅 ${currentYearStats.year} Expected Revenue` → `📅 ${currentYearStats.year} Revenue`
- Zeile 362: `<div class="stat-label">Expected Revenue ${currentYearStats.year}</div>` → `<div class="stat-label">Revenue ${currentYearStats.year}</div>`
- Zeile 549 (Text-Variante): `- Expected Revenue: ${formatCurrency(...)}` → `- Revenue: ${formatCurrency(...)}`

- [ ] **Step 7: Build + Lint + ganze Testsuite**

Run: `npm run build && npm run lint && npm test`
Expected: Build ok, Lint ok, alle Tests grün (inkl. neuer `year-range.test.ts`).

- [ ] **Step 8: Commit**

```bash
git add src/utils/year-range.ts src/utils/year-range.test.ts src/repositories/availability-repository.ts src/services/email-templates.ts
git commit -m "fix(report): include Dec-31 check-ins in current-year stats; relabel 'Expected Revenue' -> 'Revenue'"
```

---

## Task 2: Cent-Anzeige in Aufschlüsselung + Anfragemail

**Files:**
- Modify: `public/calendar.js:633` (neuer Helper), `1058-1064` (Steuerzeilen), `1066-1090` (Summen/Gesamt — exakte Zeilen beim Editieren prüfen), `1966-2050` (Mail-Body)

**Problem:** `formatCurrency` (Z. 633) nutzt `maximumFractionDigits: 0` → alle Beträge auf ganze Euro gerundet. Steuern erscheinen als „10 €" statt „9,83 €", Summen reconcilen nicht. Entscheidung: Cent **nur** in Aufschlüsselung + Mail; Kalender-Tageskacheln (Z. 606) bleiben gerundet.

- [ ] **Step 1: `formatCurrencyExact`-Helper direkt nach `formatCurrency` einfügen**

In `public/calendar.js`, unmittelbar nach der schließenden `}` von `formatCurrency` (nach Z. 649):
```javascript
  /**
   * Wie formatCurrency, aber mit 2 Nachkommastellen (Cent).
   * Für Preis-Aufschlüsselung, Steuerzeilen, Summen und die Anfragemail —
   * NICHT für die Kalender-Tageskacheln (die bleiben auf ganze Euro gerundet).
   */
  formatCurrencyExact(amount, currency) {
    const locale = this.language === 'de' ? 'de-DE' : 'en-US';
    const currencyCode = currency || 'EUR';
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currencyCode,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch (error) {
      const symbol = currencyCode === 'EUR' ? '€' : currencyCode === 'USD' ? '$' : currencyCode;
      return `${symbol}${(Math.round(amount * 100) / 100).toFixed(2)}`;
    }
  }
```

- [ ] **Step 2: Steuerzeilen + Summen in der Seiten-Aufschlüsselung auf `formatCurrencyExact` umstellen**

In `renderQuote`/Breakdown-Bereich (~1024–1090): in **allen** `breakdown-value`-/Summen-Zeilen, die Beträge zeigen (Extra-Gast-Gebühr, Rabatt, Promotions, Reinigung, **Steuern**, Zwischensumme, Gesamt), `this.formatCurrency(` durch `this.formatCurrencyExact(` ersetzen. Beispiel Steuerzeile (Z. 1063):
```javascript
              <span class="breakdown-value">${this.formatCurrencyExact(tax.amount, quote.currency)}</span>
```
**Nicht** anfassen: Z. 606 (Tageskacheln). Die Unterkunfts-Zeile (Z. 1014–1021) wird in Task 3 separat überarbeitet — dort dann ebenfalls `formatCurrencyExact`.

- [ ] **Step 3: Anfragemail-Body auf `formatCurrencyExact` umstellen**

In `requestBooking()` (~1985–2041): alle `this.formatCurrency(` im Mail-Body durch `this.formatCurrencyExact(` ersetzen (Unterkunft, Extra-Gast, Rabatt, Promotions, Reinigung, Zwischensumme, **Steuern**, Gesamt). Die Unterkunfts-Zeile (Z. 1993–1996) wird in Task 3 final überarbeitet.

- [ ] **Step 4: Build (Frontend ist statisch — nur Syntaxcheck via Build/Lint)**

Run: `npm run build && npm run lint`
Expected: keine Fehler.

- [ ] **Step 5: Manuelle Verifikation über laufenden Dev-Server**

Run: `npm run dev` (in separatem Terminal), dann im Browser `http://localhost:3000/p/farmhouse` öffnen, Zeitraum + Gäste wählen, „Show pricing details" aufklappen und „Anfrage senden" prüfen.
Expected: Beträge in Aufschlüsselung + Mail-Body als „1.240,00 €" / Steuer „9,83 €"; Netto + Steuer = Gesamt reconcilen auf den Cent. Tageskacheln weiterhin „120 €".

- [ ] **Step 6: Commit**

```bash
git add public/calendar.js
git commit -m "fix(calendar): show 2-decimal amounts in price breakdown and inquiry email (keep tiles rounded)"
```

---

## Task 3: Pro-Nacht-Sonderpreise in der Aufschlüsselung

**Files:**
- Modify: `public/calendar.js:1013-1022` (Seiten-Breakdown), `1992-1996` (Mail-Body)

**Problem:** Seite (Z. 1014) und Mail (Z. 1993) berechnen die Unterkunfts-Zeile als `nightlyRates[0].basePrice × nights`. Bei Sonderpreisen einzelner Nächte (Weihnachten/Silvester) ist diese Zeile falsch (der Gesamtpreis bleibt korrekt, da separat von Guesty). Entscheidung: Bei variierenden Preisen Summe ohne Einzelrate.

- [ ] **Step 1: Geeigneten Testzeitraum mit variierenden Nachtpreisen finden**

Run:
```bash
sqlite3 data/calendar.db "SELECT date, price FROM availability WHERE listing_id='686d1e927ae7af00234115ad' AND date BETWEEN '2026-12-20' AND '2027-01-05' ORDER BY date;"
```
Expected: Liste der Nachtpreise; notiere einen Zeitraum, in dem sich `price` zwischen Nächten unterscheidet (für die spätere Verifikation). Falls über Weihnachten/Silvester noch keine Sonderpreise gepflegt sind, irgendeinen Zeitraum mit Wochenend-/Tagespreis-Varianz wählen.

- [ ] **Step 2: Seiten-Breakdown — Unterkunfts-Zeile auf Summe umstellen**

In `public/calendar.js`, ersetze den Block (Z. 1013–1022):
```javascript
      // Accommodation fare (base rate before discounts)
      const baseNightlyRateSummary = quote.breakdown.nightlyRates[0]?.basePrice || 0;
      const baseTotalSummary = baseNightlyRateSummary * quote.nights;
      breakdownHtml += `
        <div class="breakdown-row">
          <span class="breakdown-label">${this.formatCurrency(baseNightlyRateSummary, quote.currency)} × ${quote.nights} night${quote.nights > 1 ? 's' : ''}</span>
          <span class="breakdown-value">${this.formatCurrency(baseTotalSummary, quote.currency)}</span>
        </div>
      `;
```
durch:
```javascript
      // Accommodation fare (base rate before discounts) — summiere die tatsächlichen
      // Pro-Nacht-Preise, damit Sonderpreise einzelner Nächte (z.B. Weihnachten/Silvester)
      // korrekt enthalten sind statt erste-Nacht-Rate × Nächte.
      const nightly = quote.breakdown.nightlyRates || [];
      const baseTotalSummary = nightly.length
        ? nightly.reduce((sum, nr) => sum + (nr.basePrice || 0), 0)
        : (quote.breakdown.nightlyRates[0]?.basePrice || 0) * quote.nights;
      const firstNightRate = nightly[0]?.basePrice || 0;
      const allNightsEqual = nightly.length > 0 && nightly.every((nr) => (nr.basePrice || 0) === firstNightRate);
      const accommodationLabel = allNightsEqual
        ? `${this.formatCurrencyExact(firstNightRate, quote.currency)} × ${quote.nights} night${quote.nights > 1 ? 's' : ''}`
        : `Accommodation (${quote.nights} night${quote.nights > 1 ? 's' : ''})`;
      breakdownHtml += `
        <div class="breakdown-row">
          <span class="breakdown-label">${accommodationLabel}</span>
          <span class="breakdown-value">${this.formatCurrencyExact(baseTotalSummary, quote.currency)}</span>
        </div>
      `;
```

- [ ] **Step 3: Mail-Body — Unterkunfts-Zeile auf Summe umstellen**

In `requestBooking()` ersetze (Z. 1992–1996):
```javascript
    // Accommodation (base rate before discounts)
    const emailBaseRate = quote.breakdown.nightlyRates[0]?.basePrice || 0;
    const emailBaseTotal = emailBaseRate * quote.nights;
    emailBody += ` •  ${this.t('emailAccommodation')}: ${this.formatCurrency(emailBaseRate, quote.currency)} × ${quote.nights} ${this.t('nightsLowercase')(quote.nights)} = ${this.formatCurrency(emailBaseTotal, quote.currency)}\n`;
```
durch:
```javascript
    // Accommodation (base rate before discounts) — summiere echte Pro-Nacht-Preise
    const emailNightly = quote.breakdown.nightlyRates || [];
    const emailBaseTotal = emailNightly.length
      ? emailNightly.reduce((sum, nr) => sum + (nr.basePrice || 0), 0)
      : (quote.breakdown.nightlyRates[0]?.basePrice || 0) * quote.nights;
    const emailFirstRate = emailNightly[0]?.basePrice || 0;
    const emailAllEqual = emailNightly.length > 0 && emailNightly.every((nr) => (nr.basePrice || 0) === emailFirstRate);
    if (emailAllEqual) {
      emailBody += ` •  ${this.t('emailAccommodation')}: ${this.formatCurrencyExact(emailFirstRate, quote.currency)} × ${quote.nights} ${this.t('nightsLowercase')(quote.nights)} = ${this.formatCurrencyExact(emailBaseTotal, quote.currency)}\n`;
    } else {
      emailBody += ` •  ${this.t('emailAccommodation')} (${this.t('emailNights')(quote.nights)}): ${this.formatCurrencyExact(emailBaseTotal, quote.currency)}\n`;
    }
```

- [ ] **Step 4: Build + Lint**

Run: `npm run build && npm run lint`
Expected: keine Fehler.

- [ ] **Step 5: Manuelle Verifikation mit dem Zeitraum aus Step 1**

Mit laufendem `npm run dev`: im Browser `http://localhost:3000/p/farmhouse` den variierenden Zeitraum wählen.
Expected: Bei gleichen Nachtpreisen weiterhin „120,00 € × N nights"; bei variierenden Preisen „Accommodation (N nights): <korrekte Summe>". Die Unterkunfts-Summe entspricht der Summe der `availability.price`-Werte aus Step 1; Seite und Mail zeigen denselben Wert.

- [ ] **Step 6: Commit**

```bash
git add public/calendar.js
git commit -m "fix(calendar): sum actual per-night rates in breakdown so holiday surcharges show correctly"
```

---

## Task 4: Absender-URL aus Property-Config statt iframe-Origin

**Files:**
- Modify: `src/config/properties.ts:82-103` (Interface), `~155-177` (Zod-Schema)
- Modify: `data/properties.json` (farmhouse-Eintrag)
- Modify: `src/routes/property-routes.ts:79` (Injection)
- Modify: `public/calendar.js:103-110` (Konstruktor), `2039` (Mail-Footer)

**Problem:** `calendar.js:2039` schreibt `${window.location.origin}` (= iframe-Einbettungs-Domain) als „Unterkunfts-Link". Gewünscht: die kanonische Property-Website.

- [ ] **Step 1: `website`-Feld zum `PropertyConfig`-Interface hinzufügen**

In `src/config/properties.ts`, im `PropertyConfig`-Interface nach `bookingSenderName: string;` (Z. 98):
```typescript
  bookingSenderName: string;
  /** Kanonische öffentliche Website der Unterkunft, z.B. "https://farmhouse-prasser.de".
   *  Wird in der generierten Anfragemail als Absender-/Unterkunfts-Link verwendet. */
  website?: string;
```

- [ ] **Step 2: `website` zum Zod-Schema hinzufügen**

In `propertyConfigSchema` (nach `bookingSenderName: z.string().min(1),`, ~Z. 169):
```typescript
  bookingSenderName: z.string().min(1),
  website: z.string().url().optional(),
```

- [ ] **Step 3: `website` für farmhouse in `data/properties.json` setzen**

Im farmhouse-Objekt eine Zeile ergänzen (nach `"bookingSenderName": "Farmhouse Prasser",`):
```json
      "bookingSenderName": "Farmhouse Prasser",
      "website": "https://farmhouse-prasser.de",
```

- [ ] **Step 4: App starten, Zod-Validierung bestätigen**

Run: `npm run build && npx tsx src/scripts/list-properties.ts`
Expected: kein Zod-Validation-Error; Properties laden sauber.

- [ ] **Step 5: `window.__PROPERTY_WEBSITE__` injizieren**

In `src/routes/property-routes.ts`, Zeile 79 ersetzen:
```typescript
    const propertyScript = `<script>window.__PROPERTY_SLUG__ = "${property.slug}"; window.__PROPERTY_NAME__ = "${property.name}"; window.__BOOKING_EMAIL__ = "${property.bookingRecipientEmail}";</script>`;
```
durch:
```typescript
    const propertyScript = `<script>window.__PROPERTY_SLUG__ = "${property.slug}"; window.__PROPERTY_NAME__ = "${property.name}"; window.__BOOKING_EMAIL__ = "${property.bookingRecipientEmail}"; window.__PROPERTY_WEBSITE__ = "${property.website || ''}";</script>`;
```

- [ ] **Step 6: Website im Konstruktor lesen**

In `public/calendar.js`, nach Z. 107 (`this.bookingEmail = ...`):
```javascript
    this.bookingEmail = options.bookingEmail || window.__BOOKING_EMAIL__ || 'booking@farmhouse-prasser.de';
    this.propertyWebsite = options.propertyWebsite || window.__PROPERTY_WEBSITE__ || '';
```

- [ ] **Step 7: Mail-Footer auf Property-Website umstellen**

In `requestBooking()`, Zeile 2039 ersetzen:
```javascript
    emailBody += `${this.t('emailPropertyLink')}: ${window.location.origin}\n\n`;
```
durch:
```javascript
    emailBody += `${this.t('emailPropertyLink')}: ${this.propertyWebsite || window.location.origin}\n\n`;
```

- [ ] **Step 8: Build + Lint + manuelle Verifikation**

Run: `npm run build && npm run lint`
Mit `npm run dev`: `http://localhost:3000/p/farmhouse`, Anfrage senden.
Expected: Mail-Footer zeigt `Unterkunfts-Link: https://farmhouse-prasser.de` — unabhängig vom iframe-Origin. Properties ohne `website` fallen auf `window.location.origin` zurück.

- [ ] **Step 9: Commit**

```bash
git add src/config/properties.ts data/properties.json src/routes/property-routes.ts public/calendar.js
git commit -m "fix(calendar): use per-property website as inquiry-email link instead of iframe origin"
```

---

## Verifikation gesamt

- [ ] `npm run build && npm run lint && npm test` — alles grün.
- [ ] Manuelle End-to-End-Prüfung über `npm run dev`:
  - Aufschlüsselung + Anfragemail zeigen Cent-Beträge (Task 2).
  - Sonderpreis-Zeitraum zeigt korrekte Unterkunfts-Summe (Task 3).
  - Mail-Footer = `https://farmhouse-prasser.de` (Task 4).
- [ ] Task 1: per SQL gegen `getCurrentYearStats` gegenprüfen, dass ein hypothetischer 31.12.-Check-in jetzt zum laufenden Jahr zählt; Mail-Labels lauten „Revenue" statt „Expected Revenue".

## Out of Scope (dokumentiert, nicht umgesetzt)
- `total_price`-Remapping (`reservation-mapper.ts:60`) — kein Guesty-Brutto-Feld verfügbar, bräuchte API-Erweiterung + Backfill; Umsatz nutzt korrekt `host_payout`.
- Volatilität des „Total Revenue" (Zukunft + editierbare manuelle Payouts) — bewusst beibehalten („Zahl lassen").
- Occupancy-Datumsexklusivität, Conversion-Label, %-vs-Absolut-Anzeige im Report — nicht vom Nutzer beanstandet; optionaler Folge-Cleanup.
