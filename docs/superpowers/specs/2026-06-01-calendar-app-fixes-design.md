# Calendar App — Vier Fixes (Reporting, Steuer, Tagessatz, Absender-URL)

**Datum:** 2026-06-01
**Status:** Design abgestimmt, bereit für Implementierungsplan

## Überblick

Vier unabhängige Fixes in der Guesty Calendar App. Tasks 2–4 haben eine bekannte
Ursache und einen klaren Fix; Task 1 (Umsatz im Wochenreport) braucht zuerst eine
gezielte Untersuchung gegen die echten DB-Daten.

Alle Beträge: Property = Farmhouse (`farmhouse`), Provider Guesty, Währung EUR,
Locale `de-DE`.

---

## Task 1 — Umsatzzahlen in der Wochenreport-Mail stimmen nicht

### Symptom
Die Revenue-Zahlen in der wöchentlichen Report-Mail „stimmen nicht" (vom Nutzer
bestätigt: es geht um **Umsatz/Revenue**, nicht Occupancy/Conversion).

### Bekannter Code-Kontext
- `src/jobs/weekly-email.ts` orchestriert die Datensammlung.
- Revenue-Aggregation in `src/repositories/availability-repository.ts`:
  - `getAllTimeStats()` (~Z. 446): `SUM(COALESCE(host_payout, total_price, 0))`
  - `getCurrentYearStats()` (~Z. 651): gleicher Ausdruck, gefiltert auf `check_in`
    zwischen Jahresanfang/-ende.
  - `getMonthlyBookingComparison()` (~Z. 715): letzte 30 / vorherige 30 Tage.
- Anzeige in `src/services/email-templates.ts`.

### Verdächtige Ursachen (zu verifizieren, nicht spekulativ fixen)
1. **Kein Status-Filter** auf der `reservations`-Aggregation → stornierte/declined
   Reservierungen könnten in den Umsatz einfließen.
2. **Jahreszuordnung über `check_in`** → Buchung Dez→Jan landet im Jahr des
   Check-in, nicht des Umsatzzeitraums.
3. **Mehrere Quellen/Provider** (`source`-Feld) könnten doppelt zählen, falls eine
   Reservierung sowohl in `reservations` als auch woanders aggregiert wird.
4. `host_payout` vs. `total_price`-Fallback mischt Netto- und Bruttobeträge in
   einer Summe.

### Vorgehen (systematic-debugging)
1. Report-Mail mit echten Daten reproduzieren:
   `npx tsx src/scripts/test-email.ts farmhouse`.
2. Jede angezeigte Summe (All-Time-Umsatz, Jahresumsatz, Monatsvergleich) gegen
   direkte SQL-Abfragen auf `data/calendar.db` verifizieren.
3. Die **konkrete** Abweichung isolieren (welche Kennzahl, welcher Betrag, welche
   Differenz).
4. Gezielten Fix anwenden (z.B. Status-Filter ergänzen, Fallback-Logik
   vereinheitlichen) — erst nachdem die Ursache durch SQL belegt ist.
5. Regressionstest für die betroffene Repository-Funktion (Vitest, gemockte DB).

### Abnahmekriterium
Die in der Report-Mail angezeigten Umsatzsummen stimmen mit den per SQL aus der DB
berechneten Werten überein; Reproduktion vor und nach dem Fix dokumentiert.

---

## Task 2 — Steuer-Nachkommastellen in der Anfragemail

### Symptom
Steuerbeträge in der Anfragemail werden ohne Cent angezeigt (z.B. „10 €" statt
„9,83 €"). Vom Nutzer bestätigt: **Betrag wird auf ganze Euro gerundet**.

### Ursache
`public/calendar.js`, `formatCurrency()` (Z. 633) nutzt
`minimumFractionDigits: 0, maximumFractionDigits: 0` → alle Beträge auf ganze Euro
gerundet. Betrifft Aufschlüsselung, Steuerzeilen, Summen und die Anfragemail.
Zusätzlich wird der Steuersatz als `Math.round((totalTaxes/subtotal)*100)` auf
ganze Prozent gerundet (in der Mail, ~Z. 2031–2036).

### Fix (abgestimmt: Cent nur in Aufschlüsselung + Mail, Tageskacheln bleiben gerundet)
- Neue Formatierungsvariante für „genaue" Beträge mit 2 Nachkommastellen
  (`minimumFractionDigits: 2, maximumFractionDigits: 2`, Locale `de-DE`). Z.B.
  `formatCurrencyExact(amount, currency)` oder Parameter an `formatCurrency`.
- Verwenden in:
  - der Preis-Aufschlüsselung auf der Seite (`calendar.js` ~Z. 1010–1064),
  - der Anfragemail (`requestBooking()`, ~Z. 1985–2041),
  - allen Steuerzeilen und der Summen-/Gesamtzeile.
- Die **Kalender-Tageskacheln** (~Z. 606) bleiben unverändert (ganze Euro).
- Steuersatz in der Mail: prüfen, ob ganze Prozent ausreichen; falls der reale
  Satz Nachkommastellen hat (selten bei DE-USt 7%/19%), ggf. mitziehen — sonst so
  lassen.

### Abnahmekriterium
In Aufschlüsselung und Anfragemail werden Beträge als „1.240,00 €" / „9,83 €"
dargestellt; Netto + Steuer = Gesamt reconcilen auf den Cent.

---

## Task 3 — Preisaufschlüsselung ignoriert Sonderpreise einzelner Nächte

### Symptom
Der **Gesamtpreis stimmt** (kommt korrekt von der Guesty-Quote-API), aber die
**Preisdetails** auf der Seite und in der Anfragemail spiegeln Sonderpreise
einzelner Nächte (Weihnachten/Silvester) nicht wider.

### Ursache
Sowohl die Seite (`calendar.js` ~Z. 1014) als auch die Mail (`requestBooking()`
~Z. 1994) berechnen die Unterkunfts-Zeile als
`nightlyRates[0].basePrice × nights` — also erster Nachtpreis mal Anzahl Nächte.
Bei variierenden Nachtpreisen ist diese Zeile falsch (Gesamtpreis bleibt korrekt,
da er separat aus dem Quote kommt).

Datenquelle: `quote.breakdown.nightlyRates` (Array mit `{date, basePrice, adjustedPrice}`),
aus der Guesty-API gemappt in `calculateQuoteWithGuesty()`
(`src/services/pricing-calculator.ts`).

### Fix (abgestimmt: Summe ohne Einzelrate bei variierenden Preisen)
- Unterkunfts-Summe als `sum(nightlyRates[i].basePrice)` über alle Nächte
  berechnen (statt `[0] × nights`).
- Anzeige-Logik:
  - Alle Nächte gleich teuer → weiterhin „120 € × 7 Nächte = 840 €".
  - Nächte variieren → „Unterkunft (7 Nächte): 1.240 €" (Summe, keine
    irreführende Einzelrate).
- Gleiche Logik für Seite (`calendar.js` ~Z. 1010–1019) und Mail
  (`requestBooking()` ~Z. 1992–1996).
- `nightlyRates` aus Guesty nutzt `basePrice` (vor Promotions). Konsistenz mit der
  bisherigen Anzeige prüfen — die Basisrate (vor Rabatt) war auch bislang die
  angezeigte Größe, daher `basePrice` beibehalten.

### Abnahmekriterium
Bei einem Aufenthalt über Weihnachten/Silvester zeigt die Unterkunfts-Zeile die
korrekte Summe der tatsächlichen Nachtpreise — auf Seite und in Mail identisch.

---

## Task 4 — Absender-URL in der generierten Mail

### Symptom
Die Anfragemail schreibt unten die iframe-URL als „Unterkunfts-Link", statt der
kanonischen Property-Website (gewünscht: `https://farmhouse-prasser.de`).

### Ursache
`public/calendar.js` Z. 2039: `${window.location.origin}` = Origin des iframes
(Einbettungs-Domain), nicht die Property-Website.

### Fix
1. Neues **optionales** Feld `website` in `PropertyConfig`
   (`src/config/properties.ts`) + Zod-Schema.
2. Wert in `data/properties.json` für Farmhouse: `"website": "https://farmhouse-prasser.de"`.
3. Über die bestehende Property-Injection ins Frontend durchreichen
   (`src/routes/property-routes.ts`, analog zu `__PROPERTY_SLUG__` etc.) als
   `window.__PROPERTY_WEBSITE__`.
4. In `requestBooking()` (`calendar.js` Z. 2039) verwenden:
   `this.propertyWebsite || window.location.origin` (Fallback bleibt erhalten).
5. Konstruktor: `this.propertyWebsite` aus `window.__PROPERTY_WEBSITE__` lesen.

### Abnahmekriterium
Die generierte Anfragemail enthält unten `https://farmhouse-prasser.de` (bzw. den
konfigurierten Wert), unabhängig davon, wo das iframe eingebettet ist. Properties
ohne `website` fallen sauber auf `window.location.origin` zurück.

---

## Reihenfolge & Gruppierung
- **Frontend-Block (calendar.js):** Tasks 2, 3, 4 hängen alle in `calendar.js`
  (Task 4 zusätzlich Config + Route). Gemeinsam umsetzbar, ein Build/Test.
- **Backend-Block:** Task 1 (Untersuchung + Repository-Fix + Vitest) separat.

## Tests
- Task 1: Vitest für die betroffene Repository-Aggregation (gemockte DB).
- Task 2/3: Reproduktion über `/p/farmhouse/quote` mit einem Datumsbereich, der
  Sonderpreis-Nächte enthält; visuelle Prüfung von Aufschlüsselung + Mail-Body.
- Task 4: Property-Injection-Snapshot / manuelle Prüfung der Mail.

## Out of Scope
- Kein Umbau der Guesty-Quote-Berechnung (Gesamtpreis ist korrekt).
- Keine Änderung der Kalender-Tageskachel-Formatierung.
- Kein Refactoring des `weekly-email`-Templates über den belegten Bug hinaus.
