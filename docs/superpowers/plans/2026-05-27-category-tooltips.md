# Conversion-Category Hover Tooltips — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native HTML `title=""` Hover-Tooltips an jeder Render-Stelle einer Conversion-Kategorie im Dashboard — 1-Satz-Beschreibung + 1–2 echte Beispiele, gespeist aus einem einzigen erweiterten `CATEGORY_LABELS`-Objekt.

**Architecture:** `CATEGORY_LABELS` (im `/admin/conversions`-Template-Literal in `src/routes/admin.ts`) wird pro Kategorie um `description` + `examples` erweitert. Eine kleine `categoryTooltip(def)`-Helper-Funktion baut den Tooltip-Text. Vier dynamische Render-Sites bekommen `title="${escapeHtml(categoryTooltip(def))}"`. Die bisher hartkodierten `<option>`s im manuellen Override-Dropdown werden dynamisch aus `CATEGORY_LABELS` gerendert, sodass die Beschreibungen nur an einer Stelle gepflegt werden.

**Tech Stack:** TypeScript, server-rendered HTML/JS Template-Literal in `src/routes/admin.ts`, native HTML `title`-Attribut. Keine neue Library, keine Tests, kein DB-Change.

**Spec:** `docs/superpowers/specs/2026-05-27-category-tooltips-design.md`

---

## File Structure

Eine einzige Datei wird angefasst: `src/routes/admin.ts` (~4300 Zeilen, Conversion-Dashboard-Block ab Z. ~3211). Touchpoints:

| Abschnitt | Zeilen ca. | Aktion |
|---|---|---|
| `CATEGORY_LABELS`-Objekt | ~3580 | Pro Kategorie `description` + `examples` ergänzen (11 Einträge) |
| Direkt nach `CATEGORY_LABELS` | ~3589 | Neue `categoryTooltip(def)`-Helper-Funktion einfügen |
| `renderCategories(stats)` (Bar-Chart) | ~3679 | `title=` auf `<div class="bar-row …">` |
| `renderChannels(stats)` (per-Source) | ~3693 | `title=` auf `<div class="channel-row">` |
| `renderFilters(stats)` (Filter-Chips) | ~3714 | `title=` auf `<button class="filter-chip">` |
| `renderThreads(json)` (Thread-Tabelle) | ~3772 | `title=` auf `<span class="badge …">` |
| `<select id="recatSelect">` HTML | ~3556 | `<option>`-Liste auf nur „— auto —" reduzieren |
| Nach `CATEGORY_LABELS` / `ORDER` | ~3589 | `populateRecatOptions()` definieren und aufrufen |

Keine externen Dateien, keine Migration, keine Tests.

---

## Task 1: Extend `CATEGORY_LABELS` + add `categoryTooltip` helper

**Files:**
- Modify: `src/routes/admin.ts` (`CATEGORY_LABELS`-Objekt + neue Helper-Funktion direkt darunter)

Erweitert das zentrale Kategorien-Objekt um `description` und `examples` und stellt eine Helper-Funktion bereit, die den Tooltip-String zusammenbaut. Keine Render-Änderungen in diesem Task — der Tooltip wird in Tasks 2 & 3 angewendet.

- [ ] **Step 1: Replace the `CATEGORY_LABELS` object**

In `src/routes/admin.ts`, suche das bestehende `CATEGORY_LABELS`-Objekt (beginnt mit `const CATEGORY_LABELS = {` — aktuell um Z. 3580). Ersetze das gesamte Objekt durch:

```js
    const CATEGORY_LABELS = {
      CONFIRMED:    {
        label: 'Bestätigt', emoji: '✅',
        description: 'Buchung ist zustande gekommen.',
        examples: ['Reservierungs-Status confirmed/reserved/active'],
      },
      REPEAT:       {
        label: 'Wiederbucher', emoji: '🔁',
        description: 'Wiederbucher / Stammgast (nur manuell setzbar).',
        examples: ['Manuelle Markierung im Thread-Drilldown'],
      },
      SPAM:         {
        label: 'Werbung', emoji: '📣',
        description: 'Cold-Pitch an den Host — jemand verkauft dir eine Dienstleistung.',
        examples: ['Andre — QR-Code-Bewertungstool', 'Tamsir — Auslastungs-Coaching'],
      },
      COMMERCIAL:   {
        label: 'Dreh & Kooperation', emoji: '🎬',
        description: 'Gast will die Property kommerziell nutzen (Dreh, Workshop, Influencer).',
        examples: ['Redseven — TV-Drehort', 'Lara — Foto-Shoot'],
      },
      PARTY:        {
        label: 'Party / Hochzeit', emoji: '🎉',
        description: 'Privates Event: Hochzeit, Geburtstag, Feier, Day-Use.',
        examples: ['Yuval — Hochzeit', 'Melanie — 30. Geburtstag'],
      },
      PRICE:        {
        label: 'Preisverhandlung', emoji: '€',
        description: 'Explizite Preisverhandlung, Budget unter Listingspreis.',
        examples: ['Shavana — Budget-Cap 3000€', 'Marion — Langzeit-Miete €950/Monat'],
      },
      DIRECT_DRIFT: {
        label: 'Direct-Drift', emoji: '↗',
        description: 'Versuch, das Gespräch off-platform zu verlagern.',
        examples: ['Carina — Handynummer geteilt', 'Kayla — LinkedIn vorgeschlagen'],
      },
      NO_AVAILABILITY: {
        label: 'Kein Termin', emoji: '🚫',
        description: 'Host lehnt nur wegen belegtem Datum ab.',
        examples: ['Thomas — Cleaning-Slot zu eng', 'Tatsiana — gerade gebucht'],
      },
      INFO:         {
        label: 'Vorab-Frage', emoji: '❓',
        description: 'Gast stellt eine echte Vorab-Frage, kein anderes Signal.',
        examples: ['Matilde — ÖPNV-Anbindung', 'Denise — Silvester-Lärm'],
      },
      PLAN_CHANGE:  {
        label: 'Planänderung', emoji: '📅',
        description: 'Reise-Plan des Gasts hat sich geändert (nur manuell setzbar).',
        examples: ['Manuelle Markierung im Thread-Drilldown'],
      },
      OTHER:        {
        label: 'Sonstiges', emoji: '◌',
        description: 'Kein klassifizierbares Signal — meist System-Nachrichten oder reine Acks.',
        examples: ['Reservation-Lifecycle-Threads ohne Gast-Text'],
      },
    };
```

- [ ] **Step 2: Add the `categoryTooltip` helper**

Direkt nach dem `const ORDER = [...]`-Array (eine Zeile unter `CATEGORY_LABELS`, um Z. 3589) einfügen:

```js
    function categoryTooltip(def) {
      if (!def || !def.description) return '';
      const ex = (def.examples || []).map(function(e) { return '• ' + e; }).join('\\n');
      return def.description + (ex ? '\\n\\nBeispiele:\\n' + ex : '');
    }
```

(Die `\\n` sind doppelte Backslashes — das HTML wird als JS-Template-Literal in TypeScript zusammengebaut, also muss der `\n` im erzeugten Browser-JS am Ende `\n` sein. Beim Schreiben in TypeScript wird daraus im erzeugten Browser-Skript ein echter Zeilenumbruch im `title`-Wert, was Browser im Tooltip als Mehrzeile rendern.)

- [ ] **Step 3: Verify tsc + dev-server reload**

Run: `npx tsc --noEmit`
Expected: clean.

Der Dev-Server läuft (`tsx watch`), reloadet automatisch. Browser laden lassen ist hier nicht nötig — Tooltips zeigen erst nach Tasks 2 & 3 etwas Sichtbares.

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat(admin): extend CATEGORY_LABELS with description/examples + categoryTooltip helper"
```

---

## Task 2: Add `title=` to the four dynamic render sites

**Files:**
- Modify: `src/routes/admin.ts` (`renderCategories`, `renderChannels`, `renderFilters`, `renderThreads`)

Vier client-seitige Render-Funktionen bekommen ein `title`-Attribut auf dem Element, das die Kategorie darstellt. Jede nutzt das vorhandene `escapeHtml(...)` (definiert weiter unten im Skript) zum Maskieren des Tooltip-Strings.

- [ ] **Step 1: Update `renderCategories` (bar-chart row)**

In `src/routes/admin.ts` die Funktion `renderCategories(stats)` (ca. Z. 3679) — innerhalb des `.map(cat => { ... })`-Bodys, ergänze die Tooltip-Berechnung vor dem `return` und füge `title="…"` in das `<div class="bar-row …">`-Open-Tag ein. Vor:

```js
        const def = CATEGORY_LABELS[cat] || { label: cat, emoji: '?' };
        return '<div class="bar-row bar-' + cat + (currentCategory === cat ? ' active' : '') + '" onclick="filterByCategory(\\'' + cat + '\\')">' +
```

Nachher:

```js
        const def = CATEGORY_LABELS[cat] || { label: cat, emoji: '?' };
        const tip = escapeHtml(categoryTooltip(def));
        return '<div class="bar-row bar-' + cat + (currentCategory === cat ? ' active' : '') + '" title="' + tip + '" onclick="filterByCategory(\\'' + cat + '\\')">' +
```

- [ ] **Step 2: Update `renderChannels` (per-source row)**

In `renderChannels(stats)` (ca. Z. 3693) — innerhalb des inneren `.map(cat => { ... })`-Bodys:

Vor:

```js
          const def = CATEGORY_LABELS[cat] || { label: cat, emoji: '?' };
          return '<div class="channel-row"><span>' + def.emoji + ' ' + def.label + '</span><span class="n">' + counts[cat] + '</span></div>';
```

Nachher:

```js
          const def = CATEGORY_LABELS[cat] || { label: cat, emoji: '?' };
          const tip = escapeHtml(categoryTooltip(def));
          return '<div class="channel-row" title="' + tip + '"><span>' + def.emoji + ' ' + def.label + '</span><span class="n">' + counts[cat] + '</span></div>';
```

- [ ] **Step 3: Update `renderFilters` (filter chips)**

In `renderFilters(stats)` (ca. Z. 3714) — innerhalb der `for (const cat of ORDER)`-Schleife, wo jeder `filter-chip`-Button gebaut wird. Suche die Zeile, die wie `chips.push('<button class="filter-chip …`-anfängt, und ergänze `title=` analog. Beispiel-Patch (innerhalb der for-Schleife):

Vor:

```js
      for (const cat of ORDER) {
        if (!agg[cat]) continue;
        const def = CATEGORY_LABELS[cat] || { label: cat, emoji: '?' };
        chips.push('<button class="filter-chip ' + (currentCategory === cat ? 'active' : '') + '" onclick="filterByCategory(\\'' + cat + '\\')">' + def.emoji + ' ' + def.label + ' (' + agg[cat] + ')</button>');
      }
```

Nachher:

```js
      for (const cat of ORDER) {
        if (!agg[cat]) continue;
        const def = CATEGORY_LABELS[cat] || { label: cat, emoji: '?' };
        const tip = escapeHtml(categoryTooltip(def));
        chips.push('<button class="filter-chip ' + (currentCategory === cat ? 'active' : '') + '" title="' + tip + '" onclick="filterByCategory(\\'' + cat + '\\')">' + def.emoji + ' ' + def.label + ' (' + agg[cat] + ')</button>');
      }
```

Wenn die genaue Struktur leicht abweicht (z. B. Format ohne `( count )`), die Logik anpassen — Kernpunkt: `title="' + tip + '"` ins `<button>`-Open-Tag einfügen, **vor** `onclick`.

- [ ] **Step 4: Update `renderThreads` (badge)**

In `renderThreads(json)` (ca. Z. 3772) gibt es eine Stelle, an der das Kategorien-Badge für jede Thread-Zeile gerendert wird:

Vor:

```js
        const def = CATEGORY_LABELS[t.conversion_category] || { label: t.conversion_category || 'unkat.', emoji: '?' };
        ...
        '<td><span class="badge badge-' + (t.conversion_category || 'OTHER') + '">' + def.emoji + ' ' + escapeHtml(def.label) + '</span></td>' +
```

Nachher (ergänze `tip` direkt nach dem `def`-Lookup, und `title="…"` ins `<span class="badge …">`):

```js
        const def = CATEGORY_LABELS[t.conversion_category] || { label: t.conversion_category || 'unkat.', emoji: '?' };
        const badgeTip = escapeHtml(categoryTooltip(def));
        ...
        '<td><span class="badge badge-' + (t.conversion_category || 'OTHER') + '" title="' + badgeTip + '">' + def.emoji + ' ' + escapeHtml(def.label) + '</span></td>' +
```

Wenn `def` für ein unbekanntes `t.conversion_category` keinen `description` hat, ist `categoryTooltip(def)` `''` und das `title`-Attribut wird leer — kein Tooltip wird angezeigt. Das ist erwünscht.

- [ ] **Step 5: Verify tsc**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat(admin): show category tooltips on bar-chart, channels, filters, and badges"
```

---

## Task 3: Make the recat-Select dropdown data-driven

**Files:**
- Modify: `src/routes/admin.ts` (HTML-Template des Modals + neue JS-Funktion)

Aktuell sind die `<option>`s im manuellen Override-Dropdown hartkodiert. Damit Beschreibungen nicht doppelt gepflegt werden müssen, refaktorieren wir auf eine Render-aus-`CATEGORY_LABELS`-Variante. Jede `<option>` bekommt zusätzlich `title="…"`.

- [ ] **Step 1: Slim down the static `<select>` HTML**

In `src/routes/admin.ts` das `<select id="recatSelect">`-Element (ca. Z. 3556-3568) ersetzen. Vor:

```html
          <select id="recatSelect">
            <option value="">— auto —</option>
            <option value="CONFIRMED">✅ Bestätigt</option>
            <option value="REPEAT">🔁 Wiederbucher</option>
            <option value="PARTY">🎉 Party / Hochzeit</option>
            <option value="SPAM">📣 Werbung</option>
            <option value="COMMERCIAL">🎬 Dreh & Kooperation</option>
            <option value="NO_AVAILABILITY">🚫 Kein Termin</option>
            <option value="INFO">❓ Vorab-Frage</option>
            <option value="PRICE">€ Preisverhandlung</option>
            <option value="DIRECT_DRIFT">↗ Direct-Drift</option>
            <option value="PLAN_CHANGE">📅 Planänderung</option>
            <option value="OTHER">◌ Sonstiges</option>
          </select>
```

(Die exakten Optionen kann es leicht abweichend geben — Hauptsache, du behältst nur die `— auto —`-Option, die manuelle Liste fliegt komplett raus.) Nachher:

```html
          <select id="recatSelect">
            <option value="">— auto —</option>
          </select>
```

- [ ] **Step 2: Add `populateRecatOptions()` and call it on script init**

Direkt nach der `categoryTooltip(def)`-Helper-Funktion (aus Task 1, Step 2) einfügen:

```js
    function populateRecatOptions() {
      const select = document.getElementById('recatSelect');
      if (!select) return;
      // Wipe everything except the "— auto —" placeholder option at index 0.
      while (select.options.length > 1) select.remove(1);
      for (const cat of ORDER) {
        const def = CATEGORY_LABELS[cat];
        if (!def) continue;
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = def.emoji + ' ' + def.label;
        opt.title = categoryTooltip(def);
        select.appendChild(opt);
      }
    }
    populateRecatOptions();
```

Das `populateRecatOptions()` läuft genau einmal beim Skript-Init, nachdem `CATEGORY_LABELS` und `ORDER` definiert sind. Das `<select>`-Element ist statisches HTML im selben Template-Literal und damit vom JS aus erreichbar.

- [ ] **Step 3: Verify in the browser (optional but recommended)**

Öffne `http://localhost:3099/admin/conversions`, öffne ein Thread-Modal und klicke ins recat-Dropdown — die Optionen sollten dieselben sein wie vorher (11 Kategorien + „— auto —"), und beim Hovern über eine Option sollte der Tooltip mit Beschreibung + Beispielen erscheinen.

- [ ] **Step 4: Verify tsc**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat(admin): data-driven recat dropdown options with category tooltips"
```

---

## Task 4: Manual browser verification

**Files:** keine — Verifikations-Task, kein Commit.

- [ ] **Step 1: Reload the dashboard and verify all 5 tooltip surfaces**

Öffne `http://localhost:3099/admin/conversions` (Dev-Server läuft schon). Wähle Property `farmhouse`.

Für jede der 5 Surfaces hover-und-warte ~1 Sekunde:
1. **Bar-Chart-Reihen** in der „Kategorien"-Sektion (oben) — hover auf eine Reihe → Tooltip zeigt Beschreibung + Beispiele.
2. **Filter-Chips** über der Threads-Tabelle — hover auf einen Chip wie „📣 Werbung (2)" → Tooltip.
3. **Channel-Breakdown-Zeilen** in der „Nach Channel"-Sektion — hover auf eine Zeile → Tooltip.
4. **Badges in der Threads-Tabelle** — hover auf eine farbige Pille pro Thread → Tooltip.
5. **Recat-Dropdown** — Klick auf eine Thread-Zeile (Modal öffnet), Klick ins manuelle Override-Dropdown — Hovern über eine Option zeigt den Tooltip.

Erwartung: Auf jeder der 5 Surfaces erscheint nach ~1s der native Browser-Tooltip mit Format:

```
<Beschreibung>

Beispiele:
• <example 1>
• <example 2>
```

- [ ] **Step 2: Spot-check that `OTHER` shows „System-Nachrichten" example, `NO_AVAILABILITY` shows „Cleaning-Slot zu eng"**

Visueller Sanity-Check, dass die Beispiele korrekt aus dem erweiterten `CATEGORY_LABELS` kommen.

- [ ] **Step 3: Spot-check on u19**

Wechsle Property auf „Uferstrasse 19" und prüfe denselben Hover-Flow — die Tooltips sind property-unabhängig (Inhalte aus `CATEGORY_LABELS`), sollten gleich aussehen.

---

## Rollout

Teil des laufenden `feat/llm-classifier`-Branches. Geht beim nächsten Merge nach `main` und Production-Deploy mit allen anderen Conversion-Dashboard-Änderungen automatisch live — keine separate Production-Aktion nötig.
