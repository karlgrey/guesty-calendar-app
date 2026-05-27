# Conversion-Kategorien — Hover-Tooltips im Dashboard

**Datum:** 2026-05-27
**Status:** Genehmigt
**Scope:** `guesty-calendar-app` — `src/routes/admin.ts` (Conversion-Dashboard)

## Kontext & Ziel

Das Conversion-Dashboard zeigt 11 Kategorien (CONFIRMED, REPEAT, SPAM, COMMERCIAL,
PARTY, DIRECT_DRIFT, PRICE, NO_AVAILABILITY, INFO, PLAN_CHANGE, OTHER). Ein neuer
Operator weiß ohne Spec nicht, was z. B. „COMMERCIAL" vs. „PARTY" trennt oder was
„NO_AVAILABILITY" abdeckt. **Ziel:** native HTML-`title`-Tooltips an jeder Stelle,
an der eine Kategorie gerendert wird, mit 1-Satz-Definition + 1–2 echten Beispielen.

## Architektur

Das bestehende `CATEGORY_LABELS`-Objekt im `/admin/conversions`-Template-Literal
in `src/routes/admin.ts` wird um zwei Felder pro Kategorie erweitert:

```js
PARTY: {
  label: 'Party / Hochzeit',
  emoji: '🎉',
  description: 'Privates Event: Hochzeit, Geburtstag, Feier, Day-Use.',
  examples: ['Yuval — Hochzeit Berlin 2027', 'Melanie — 30. Geburtstag der Frau'],
},
```

Jede Render-Stelle einer Kategorie bekommt ein `title=`-Attribut, dessen Inhalt
aus diesen Feldern zusammengebaut wird (kleine Helper-Funktion im selben Block):

```js
function categoryTooltip(def) {
  if (!def || !def.description) return '';
  const ex = (def.examples || []).map(e => '• ' + e).join('\n');
  return def.description + (ex ? '\n\nBeispiele:\n' + ex : '');
}
```

Render-Sites verwenden das gerenderte Attribut so:

```js
'<div class="bar-row …" title="' + escapeHtml(categoryTooltip(def)) + '" …>'
```

`escapeHtml` existiert bereits im Template; wird wiederverwendet.

## Komponenten

Nur eine Datei wird angefasst: `src/routes/admin.ts`. Fünf Render-Sites bekommen
`title`-Attribute:

1. **Bar-Chart-Reihen** (`renderCategories`-Funktion, `<div class="bar-row …">`)
2. **Filter-Chips** (`renderFilters`-Funktion, `<button class="filter-chip …">`)
3. **Channel-Breakdown-Zeilen** (`renderChannels`-Funktion, `<div class="channel-row">`)
4. **Thread-Badges** in der Threads-Tabelle (`renderThreads`-Funktion, `<span class="badge …">`)
5. **Recat-`<option>`s** in der manuellen Override-Liste (statisches HTML im Modal)

Für Stelle 5 (statische `<option>`-Liste) wird das HTML so umgebaut, dass die
Optionen einmalig aus `CATEGORY_LABELS` gerendert werden — sonst pflegt man die
Beschreibungen an zwei Orten. (Aktuell sind die `<option>`s hartkodiert; das
Refactoring zu „aus CATEGORY_LABELS rendern" ist Teil dieses Specs.)

## Inhalt — Beschreibungen + Beispiele (alle 11 Kategorien)

| Code | Description | Examples |
|---|---|---|
| `CONFIRMED` | Buchung ist zustande gekommen. | Reservierungs-Status confirmed/reserved/active |
| `REPEAT` | Wiederbucher / Stammgast (nur manuell setzbar). | Manuelle Markierung im Thread-Drilldown |
| `SPAM` | Cold-Pitch an den Host — jemand verkauft dir eine Dienstleistung. | Andre — QR-Code-Bewertungstool · Tamsir — Auslastungs-Coaching |
| `COMMERCIAL` | Gast will die Property kommerziell nutzen (Dreh, Workshop, Influencer). | Redseven — TV-Drehort · Lara — Foto-Shoot |
| `PARTY` | Privates Event: Hochzeit, Geburtstag, Feier, Day-Use. | Yuval — Hochzeit · Melanie — 30. Geburtstag |
| `DIRECT_DRIFT` | Versuch, das Gespräch off-platform zu verlagern. | Carina — Handynummer geteilt · Kayla — LinkedIn vorgeschlagen |
| `PRICE` | Explizite Preisverhandlung, Budget unter Listingspreis. | Shavana — Budget-Cap 3000€ · Marion — Langzeit-Miete €950/Monat |
| `NO_AVAILABILITY` | Host lehnt nur wegen belegtem Datum ab. | Thomas — Cleaning-Slot zu eng · Tatsiana — gerade gebucht |
| `INFO` | Gast stellt eine echte Vorab-Frage, kein anderes Signal. | Matilde — ÖPNV-Anbindung · Denise — Silvester-Lärm |
| `PLAN_CHANGE` | Reise-Plan des Gasts hat sich geändert (nur manuell). | Manuelle Markierung im Thread-Drilldown |
| `OTHER` | Kein klassifizierbares Signal — meist System-Nachrichten oder reine Acks. | Reservation-Lifecycle-Threads ohne Gast-Text |

## Tests

Keine neuen Tests. Reine HTML-Template-Änderung im server-gerenderten String;
die bestehende Vitest-Suite ist davon nicht betroffen und bleibt grün.
Verifikation per Browser: Hovern über jede der 5 Surfaces im Dashboard zeigt
den Tooltip.

## Out of Scope

- **Custom-Tooltip-Komponente** (mit Markdown, Mehrzeilen-Formatting, etc.) —
  native `title` reicht für „etwas beschreiben". Wenn später gewünscht, kann eine
  Custom-Tooltip-Lib (z. B. Tippy.js, Floating UI) als separates Vorhaben kommen.
- **Lokalisierung** — Beschreibungen sind Deutsch (passt zur restlichen Dashboard-UI).
- **Tooltips außerhalb des Conversion-Dashboards** — nur `/admin/conversions`,
  nicht z. B. die Property-Dashboard-Übersicht.

## Rollout

Teil des laufenden `feat/llm-classifier`-Branches (gleiche Property-Dashboard-UX-
Verbesserung — landet im selben Merge nach `main`).
