# Conversion-Classifier Categories — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Erweitere den property-übergreifenden Conversion-Classifier um 4 neue Kategorien (SPAM, COMMERCIAL, NO_AVAILABILITY, INFO), benenne WEDDING→PARTY um, und re-klassifiziere die bestehenden Threads.

**Architecture:** Ein einziger regex-basierter Classifier (`message-classifier.ts`) ordnet jeden Message-Thread per "first match wins"-Priorität einer Kategorie zu. Das Dashboard (`admin.ts`) rendert Kategorien aus String-Maps. Ein neues Script `reclassify-threads.ts` rechnet die Klassifizierung über bereits gespeicherte Messages neu (kein API-Call), unter Wahrung manueller Overrides.

**Tech Stack:** TypeScript, Node.js, Vitest, better-sqlite3, Express.

**Spec:** `docs/superpowers/specs/2026-05-22-conversion-categories-design.md`

**Priorität (first match wins):**
`CONFIRMED → SPAM → COMMERCIAL → PARTY → DIRECT_DRIFT → PRICE → NO_AVAILABILITY → INFO → OTHER`
(`REPEAT`, `PLAN_CHANGE` = nur manuell, kein Auto-Rule.)

---

## File Structure

| Datei | Rolle | Aktion |
|---|---|---|
| `src/types/messages.ts` | Kanonische `ConversionCategory`-Definition | Modify |
| `src/utils/message-classifier.ts` | Regexes + `classifyThread`-Logik | Modify |
| `src/utils/message-classifier.test.ts` | Classifier-Tests | Modify |
| `src/routes/admin.ts` | Dashboard-Rendering (Labels, Order, CSS, recat, allowed) | Modify |
| `src/repositories/message-repository.ts` | DB-Zugriff Threads/Messages | Modify (1 Funktion) |
| `src/scripts/reclassify-threads.ts` | Re-Klassifizierung gespeicherter Threads | Create |

---

## Task 1: Rename WEDDING→PARTY + consolidate ConversionCategory type

**Files:**
- Modify: `src/types/messages.ts:24-31`
- Modify: `src/utils/message-classifier.ts:21-28` (type), `:44-45` (`WEDDING_RE`), `:128-136` (WEDDING-Branch), Kommentare
- Modify: `src/utils/message-classifier.test.ts` (alle `WEDDING`-Vorkommen)
- Modify: `src/routes/admin.ts` (CSS, `recatSelect`, `CATEGORY_LABELS`, `ORDER`, `ALLOWED_CATEGORIES`)

Reine Umbenennung + Type-Dedup, kein Verhaltenswechsel. Tests bleiben grün.

- [ ] **Step 1: Dedup the type — `message-classifier.ts` imports from `types/messages.ts`**

In `src/utils/message-classifier.ts` die lokale Typdefinition (Zeilen 21-28) ersetzen durch einen Import + Re-Export. Aus:

```ts
export type ConversionCategory =
  | 'CONFIRMED'
  | 'REPEAT'         // Wiederbucher (Stammgast, returning guest). Manually-set for now.
  | 'PRICE'
  | 'WEDDING'
  | 'DIRECT_DRIFT'
  | 'PLAN_CHANGE'    // Planänderung (Datum-/Personenzahl-Konflikt, sich ändernde Reise). Manually-set.
  | 'OTHER';
```

wird:

```ts
import type { ConversionCategory } from '../types/messages.js';
export type { ConversionCategory };
```

Den Import an den Anfang der Datei zu den anderen Imports verschieben (oben). `sync-guesty-messages.ts` importiert `ConversionCategory` weiterhin aus `message-classifier.js` — funktioniert via Re-Export.

- [ ] **Step 2: Rename WEDDING→PARTY in `types/messages.ts`**

In `src/types/messages.ts` Zeilen 24-31 — `'WEDDING'` → `'PARTY'`:

```ts
export type ConversionCategory =
  | 'CONFIRMED'
  | 'REPEAT'
  | 'PRICE'
  | 'PARTY'
  | 'DIRECT_DRIFT'
  | 'PLAN_CHANGE'
  | 'OTHER';
```

- [ ] **Step 3: Rename WEDDING→PARTY in `message-classifier.ts`**

In `src/utils/message-classifier.ts`:
- Konstante `WEDDING_RE` → `PARTY_RE` (Zeile 44, Deklaration + Verwendung in `classifyThread`).
- Im `classifyThread`-Body: `return { category: 'WEDDING', ... }` → `category: 'PARTY'`.
- Header-Kommentar (Zeilen 1-19): `WEDDING` → `PARTY` im Kategorien-Block.
- Entferne dabei die führenden `N)`-Nummern aus den Branch-Kommentaren in `classifyThread` (z.B. `// 2) WEDDING / DAY-USE — …` → `// PARTY / DAY-USE — …`, `// 1) CONFIRMED …` → `// CONFIRMED …`, `// 5) Fall-through` → `// Fall-through`). Die später eingefügten Branches verwenden ebenfalls keine Nummern — so kollidiert nichts.

- [ ] **Step 4: Rename WEDDING→PARTY in the test file**

In `src/utils/message-classifier.test.ts` jedes Vorkommen von `WEDDING` durch `PARTY` ersetzen (Test-Namen + `expect(out.category).toBe('WEDDING')` → `'PARTY'`). Betroffen: 5 Tests (`detects WEDDING from real Yuval-style inquiry`, `detects WEDDING-via-event-keyword`, `detects WEDDING from photo-shoot / drehort`, `priority: WEDDING beats PRICE`, `priority: WEDDING beats DIRECT_DRIFT`).

- [ ] **Step 5: Rename WEDDING→PARTY in `admin.ts`**

In `src/routes/admin.ts`:
- CSS: `.bar-WEDDING     .bar-fill { background: var(--color-terracotta); }` → `.bar-PARTY       .bar-fill { background: var(--color-terracotta); }`
- CSS: `.badge-WEDDING     { background: #f1d0c5; color: #8a3015; }` → `.badge-PARTY       { background: #f1d0c5; color: #8a3015; }`
- recat-`<option>`: `<option value="WEDDING">💍 Hochzeit / Event</option>` → `<option value="PARTY">🎉 Party / Hochzeit</option>`
- `CATEGORY_LABELS`: `WEDDING:      { label: 'Hochzeit / Event',  emoji: '💍' },` → `PARTY:        { label: 'Party / Hochzeit',  emoji: '🎉' },`
- `ORDER`: `'WEDDING'` → `'PARTY'`
- `ALLOWED_CATEGORIES`: `'WEDDING'` → `'PARTY'`

- [ ] **Step 6: Run tests + build to verify nothing broke**

Run: `npx vitest run src/utils/message-classifier.test.ts && npx tsc --noEmit`
Expected: alle Tests PASS, kein TypeScript-Fehler.

- [ ] **Step 7: Commit**

```bash
git add src/types/messages.ts src/utils/message-classifier.ts src/utils/message-classifier.test.ts src/routes/admin.ts
git commit -m "refactor: rename WEDDING→PARTY category and consolidate ConversionCategory type"
```

---

## Task 2: Add SPAM category (host-directed cold pitches)

**Files:**
- Modify: `src/types/messages.ts` (`ConversionCategory`)
- Modify: `src/utils/message-classifier.ts` (Regexes, `classifyThread`, `KEYWORD_INDEX`)
- Test: `src/utils/message-classifier.test.ts`

SPAM = jemand verkauft dem Host eine Leistung. Prüft Inbound-Text. Läuft direkt nach CONFIRMED.

- [ ] **Step 1: Write the failing tests**

Vor dem `// ── Priority order verification`-Block in `src/utils/message-classifier.test.ts` einfügen:

```ts
  // ── SPAM
  it('detects SPAM from "ich unterstütze Hosts" pitch (Tamsir-style)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Ich unterstütze Hosts dabei, Auslastung und Bewertungsscore gezielt zu steigern.'),
      ],
    });
    expect(out.category).toBe('SPAM');
  });

  it('detects SPAM from "360° Rundgang" service offer (Leon-style)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'dein Inserat wirkt ansprechend – mit einem professionellen 360° Rundgang noch stärker.'),
      ],
    });
    expect(out.category).toBe('SPAM');
  });

  it('detects SPAM via possessive+offer combo (Sophia-style property-management pitch)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Ich biete dir treue Unterstützung bei der Verwaltung deiner Ferienwohnung.'),
      ],
    });
    expect(out.category).toBe('SPAM');
  });

  it('priority: SPAM beats PRICE when a pitch mentions a price', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Ich unterstütze Hosts dabei, mehr Buchungen zu generieren — schon ab 99€ im Monat.'),
      ],
    });
    expect(out.category).toBe('SPAM');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/message-classifier.test.ts -t SPAM`
Expected: FAIL — `expected 'OTHER'/'PRICE' to be 'SPAM'`.

- [ ] **Step 3: Add `'SPAM'` to the type**

In `src/types/messages.ts` `ConversionCategory` — `'SPAM'` nach `'REPEAT'` einfügen:

```ts
export type ConversionCategory =
  | 'CONFIRMED'
  | 'REPEAT'
  | 'SPAM'
  | 'PRICE'
  | 'PARTY'
  | 'DIRECT_DRIFT'
  | 'PLAN_CHANGE'
  | 'OTHER';
```

- [ ] **Step 4: Add the SPAM regexes**

In `src/utils/message-classifier.ts` im `// ── Patterns`-Block (nach `HOST_PULLBACK_RE`) einfügen:

```ts
// ── SPAM: host-directed cold pitch — someone selling the HOST a service
// (property management, listing photography, review boosting). Not a guest.
const SPAM_STRONG_RE =
  /(ich unterst[üu]tze\s+(hosts?|gastgeber|vermieter)|auslastung[^.\n]{0,40}steiger|umsatz[^.\n]{0,40}steiger|bewertungs(score|management)|feedback-?l[öo]sung|360[^a-z0-9]{0,4}rundgang|channel\s?manager|kanalmanager|mehr buchungen[^.\n]{0,40}(generier|erziel|bekomm)|kostenlos[^.\n]{0,15}(test|ausprobier))/i;

// host-directed possessive ...
const SPAM_TARGET_RE =
  /\b(dein|deine|deiner|ihr|ihre|ihrer|eure?|euer)\s+(inserat|unterkunft|ferienwohnung|fewo|objekt|vermietung|listing|immobilie)/i;
// ... combined with a service/offer verb
const SPAM_OFFER_RE =
  /(biete|anbieten|unterst[üu]tz|optimier|steiger|verwalt|pr[äa]sentier|vorstellen|helfe\s+(dir|ihnen|euch)|dienstleistung)/i;
```

- [ ] **Step 5: Add the SPAM branch to `classifyThread`**

In `src/utils/message-classifier.ts` in `classifyThread`, direkt nach der `const all = ...`-Zeile und VOR dem PARTY-Block einfügen:

```ts
  // SPAM — host-directed cold pitch. Checked early so a pitch mentioning
  //   "Budget"/"Event" can't be mis-tagged as PRICE/PARTY.
  const spamStrong = SPAM_STRONG_RE.test(guestText);
  const spamCombo = SPAM_TARGET_RE.test(guestText) && SPAM_OFFER_RE.test(guestText);
  if (spamStrong || spamCombo) {
    return {
      category: 'SPAM',
      confidence: spamCombo ? 0.85 : 0.8,
      matchedKeywords: extractKeywords(all),
    };
  }
```

- [ ] **Step 6: Add SPAM keywords to `KEYWORD_INDEX`**

In `src/utils/message-classifier.ts` im `KEYWORD_INDEX`-Array (vor dem `// price`-Kommentar) einfügen:

```ts
  // spam
  { name: 'host-pitch', re: /\bich unterst[üu]tze\s+(hosts?|gastgeber|vermieter)\b/i },
  { name: 'auslastung-steigern', re: /auslastung[^.\n]{0,40}steiger/i },
  { name: 'bewertungsscore', re: /bewertungs(score|management)/i },
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/utils/message-classifier.test.ts`
Expected: alle PASS (inkl. der 4 neuen SPAM-Tests).

- [ ] **Step 8: Commit**

```bash
git add src/types/messages.ts src/utils/message-classifier.ts src/utils/message-classifier.test.ts
git commit -m "feat: add SPAM conversion category (host-directed cold pitches)"
```

---

## Task 3: Add COMMERCIAL category + split shoot terms out of PARTY

**Files:**
- Modify: `src/types/messages.ts` (`ConversionCategory`)
- Modify: `src/utils/message-classifier.ts` (`EVENT_DAY_USE_RE`, neue Regexes, `classifyThread`, `KEYWORD_INDEX`)
- Test: `src/utils/message-classifier.test.ts`

COMMERCIAL = jemand will die Unterkunft kommerziell nutzen (Foto-/Videodreh, Influencer). Läuft nach SPAM, vor PARTY. Die Dreh-Begriffe wandern aus `EVENT_DAY_USE_RE` hierher.

- [ ] **Step 1: Write the failing tests + update the drehort test**

In `src/utils/message-classifier.test.ts`: den bestehenden Test `detects PARTY from photo-shoot / drehort even without "hochzeit"` (vorher WEDDING, in Task 1 zu PARTY umbenannt) ändern zu:

```ts
  it('detects COMMERCIAL from drehort even without "hochzeit"', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [msg('inbound', 'Ich suche derzeit nach einem geeigneten Drehort.')],
    });
    expect(out.category).toBe('COMMERCIAL');
  });
```

Und neue Tests vor dem `// ── Priority order verification`-Block einfügen:

```ts
  // ── COMMERCIAL
  it('detects COMMERCIAL from photographer requesting the property as a location (Lea-style)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Lieber Christian, ich bin Fotograf/in und bin auf deine schöne Unterkunft aufmerksam geworden.'),
      ],
    });
    expect(out.category).toBe('COMMERCIAL');
  });

  it('priority: COMMERCIAL beats PARTY when a shoot request also mentions a Feier', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Ich bin Fotografin und würde die Unterkunft gerne für ein Shooting und eine kleine Feier nutzen.'),
      ],
    });
    expect(out.category).toBe('COMMERCIAL');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/message-classifier.test.ts -t COMMERCIAL`
Expected: FAIL — `expected 'PARTY'/'OTHER' to be 'COMMERCIAL'`.

- [ ] **Step 3: Add `'COMMERCIAL'` to the type**

In `src/types/messages.ts` `ConversionCategory` — `'COMMERCIAL'` nach `'SPAM'` einfügen:

```ts
export type ConversionCategory =
  | 'CONFIRMED'
  | 'REPEAT'
  | 'SPAM'
  | 'COMMERCIAL'
  | 'PRICE'
  | 'PARTY'
  | 'DIRECT_DRIFT'
  | 'PLAN_CHANGE'
  | 'OTHER';
```

- [ ] **Step 4: Remove shoot terms from `EVENT_DAY_USE_RE`, add COMMERCIAL regexes**

In `src/utils/message-classifier.ts` `EVENT_DAY_USE_RE` ersetzen (die Begriffe `drehort|fotoshoot|photo-?shoot|musikvideo|video shoot` entfernen):

```ts
const EVENT_DAY_USE_RE =
  /\b(tages?vermietung|day-?use|day rate|tagesnutzung|feier|veranstaltung|event location|location for our event|reception|ceremony|catering)\b/i;
```

Im `// ── Patterns`-Block (nach den SPAM-Regexes) einfügen:

```ts
// ── COMMERCIAL: guest wants to USE the property commercially — photo/video
// shoot, brand/influencer collaboration. Checked after SPAM (host-directed
// pitches are already out) and before PARTY.
const COMMERCIAL_RE =
  /\b(foto-?shooting|foto-?shoot|photo\s?shoot|fotograf(in)?|videograf(in)?|foto-?dreh|videodreh|filmdreh|dreharbeiten|drehort|drehgenehmigung|musikvideo|video\s?shoot|content\s?creator|content\s?creation|influencer|marken?kooperation)\b/i;
const COMMERCIAL_LOCATION_RE =
  /\b(als location f[üu]r|location f[üu]r (ein|eine|einen|unser|unsere|mein|meine)\s+\w*\s*(shoot|shooting|dreh|video|projekt|kampagne))/i;
```

- [ ] **Step 5: Add the COMMERCIAL branch to `classifyThread`**

In `classifyThread` direkt nach dem SPAM-Block (aus Task 2) und VOR dem PARTY-Block einfügen:

```ts
  // COMMERCIAL — commercial use of the property (shoots, collaborations).
  if (COMMERCIAL_RE.test(guestText) || COMMERCIAL_LOCATION_RE.test(guestText)) {
    return {
      category: 'COMMERCIAL',
      confidence: 0.8,
      matchedKeywords: extractKeywords(all),
    };
  }
```

- [ ] **Step 6: Add COMMERCIAL keywords to `KEYWORD_INDEX`**

In `KEYWORD_INDEX` (nach den SPAM-Keywords) einfügen:

```ts
  // commercial
  { name: 'fotograf', re: /\bfotograf(in)?\b/i },
  { name: 'dreh', re: /\b(dreh(ort|arbeiten|genehmigung)?|videodreh|filmdreh)\b/i },
  { name: 'content-creator', re: /\b(content\s?creator|influencer)\b/i },
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/utils/message-classifier.test.ts`
Expected: alle PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types/messages.ts src/utils/message-classifier.ts src/utils/message-classifier.test.ts
git commit -m "feat: add COMMERCIAL category, split shoot terms out of PARTY"
```

---

## Task 4: Add NO_AVAILABILITY category

**Files:**
- Modify: `src/types/messages.ts` (`ConversionCategory`)
- Modify: `src/utils/message-classifier.ts` (Regex, `classifyThread`, `KEYWORD_INDEX`)
- Test: `src/utils/message-classifier.test.ts`

NO_AVAILABILITY = Host sagt ab, weil das Datum belegt ist. Prüft Outbound-Text. Läuft nach PRICE, vor INFO/OTHER.

- [ ] **Step 1: Write the failing test**

Vor dem `// ── Priority order verification`-Block in `src/utils/message-classifier.test.ts` einfügen:

```ts
  // ── NO_AVAILABILITY
  it('detects NO_AVAILABILITY when host declines because dates are booked', () => {
    const out = classifyThread({
      reservationStatus: 'declined',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Hallo, hättet ihr am ersten Juni-Wochenende frei?'),
        msg('outbound', 'Leider sind wir an dem Wochenende schon ausgebucht.'),
      ],
    });
    expect(out.category).toBe('NO_AVAILABILITY');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/utils/message-classifier.test.ts -t NO_AVAILABILITY`
Expected: FAIL — `expected 'INFO'/'OTHER' to be 'NO_AVAILABILITY'`.
(Hinweis: zu diesem Zeitpunkt existiert INFO noch nicht — der Ist-Wert ist `OTHER`.)

- [ ] **Step 3: Add `'NO_AVAILABILITY'` to the type**

In `src/types/messages.ts` `ConversionCategory` — `'NO_AVAILABILITY'` nach `'DIRECT_DRIFT'` einfügen:

```ts
export type ConversionCategory =
  | 'CONFIRMED'
  | 'REPEAT'
  | 'SPAM'
  | 'COMMERCIAL'
  | 'PRICE'
  | 'PARTY'
  | 'DIRECT_DRIFT'
  | 'NO_AVAILABILITY'
  | 'PLAN_CHANGE'
  | 'OTHER';
```

- [ ] **Step 4: Add the NO_AVAILABILITY regex**

In `src/utils/message-classifier.ts` im `// ── Patterns`-Block (nach den COMMERCIAL-Regexes) einfügen:

```ts
// ── NO_AVAILABILITY: host declines purely because the dates are taken.
// Host-side (outbound) signal.
const NO_AVAILABILITY_RE =
  /\b(ausgebucht|fully booked|already booked|not available|no availability)\b|\b(bereits|schon|leider)\s+(belegt|vergeben|ausgebucht)\b|\bnicht\s+(mehr\s+)?(verf[üu]gbar|frei)\b/i;
```

- [ ] **Step 5: Add the NO_AVAILABILITY branch to `classifyThread`**

In `classifyThread` direkt NACH dem PRICE-Block (nach den beiden `if (PRICE_RE...)`-Blöcken) und VOR dem `// 5) Fall-through`-Kommentar einfügen:

```ts
  // NO_AVAILABILITY — host turned the guest down only because the dates
  //   were taken. Host-side signal; not a real funnel loss.
  if (NO_AVAILABILITY_RE.test(hostText)) {
    return {
      category: 'NO_AVAILABILITY',
      confidence: 0.8,
      matchedKeywords: extractKeywords(all),
    };
  }
```

- [ ] **Step 6: Add NO_AVAILABILITY keyword to `KEYWORD_INDEX`**

In `KEYWORD_INDEX` (nach den COMMERCIAL-Keywords) einfügen:

```ts
  // availability
  { name: 'no-availability', re: /\b(ausgebucht|belegt|vergeben|fully booked)\b/i },
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/utils/message-classifier.test.ts`
Expected: alle PASS.

- [ ] **Step 8: Commit**

```bash
git add src/types/messages.ts src/utils/message-classifier.ts src/utils/message-classifier.test.ts
git commit -m "feat: add NO_AVAILABILITY conversion category"
```

---

## Task 5: Add INFO category (pre-booking questions)

**Files:**
- Modify: `src/types/messages.ts` (`ConversionCategory`)
- Modify: `src/utils/message-classifier.ts` (Regex, `classifyThread`)
- Test: `src/utils/message-classifier.test.ts`

INFO = Gast stellt eine Frage, kein anderes Signal. Schwächstes Auto-Signal (confidence 0.4), vorletzte Stufe vor OTHER.

- [ ] **Step 1: Write tests + update the dog-policy test**

In `src/utils/message-classifier.test.ts` den bestehenden Test `returns OTHER for generic question about dog policy` ändern zu (eine Gast-Frage ist jetzt INFO):

```ts
  it('classifies a generic pre-booking question as INFO', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [msg('inbound', 'Do you accept a large well-behaved dog?')],
    });
    expect(out.category).toBe('INFO');
  });
```

Neue Tests vor dem `// ── Priority order verification`-Block einfügen:

```ts
  // ── INFO
  it('detects INFO from a public-transport question (Matilde-style)', () => {
    const out = classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [msg('inbound', 'Hello there, is it possible to arrive there with public transport?')],
    });
    expect(out.category).toBe('INFO');
  });

  it('priority: NO_AVAILABILITY beats INFO when guest asks AND host says booked', () => {
    const out = classifyThread({
      reservationStatus: 'declined',
      channel: 'airbnb',
      messages: [
        msg('inbound', 'Habt ihr am Wochenende noch frei?'),
        msg('outbound', 'Leider schon vergeben.'),
      ],
    });
    expect(out.category).toBe('NO_AVAILABILITY');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/message-classifier.test.ts -t INFO`
Expected: FAIL — `expected 'OTHER' to be 'INFO'`.

- [ ] **Step 3: Add `'INFO'` to the type**

In `src/types/messages.ts` `ConversionCategory` — `'INFO'` nach `'NO_AVAILABILITY'` einfügen:

```ts
export type ConversionCategory =
  | 'CONFIRMED'
  | 'REPEAT'
  | 'SPAM'
  | 'COMMERCIAL'
  | 'PRICE'
  | 'PARTY'
  | 'DIRECT_DRIFT'
  | 'NO_AVAILABILITY'
  | 'INFO'
  | 'PLAN_CHANGE'
  | 'OTHER';
```

- [ ] **Step 4: Add the INFO regex**

In `src/utils/message-classifier.ts` im `// ── Patterns`-Block (nach `NO_AVAILABILITY_RE`) einfügen:

```ts
// ── INFO: guest asked a genuine question but nothing else matched. Weakest
// signal — last auto-stage before OTHER.
const INFO_RE =
  /\?|\b(wie|was|wann|wo|warum|wieviel|wie\s+viele?|ist es m[öo]glich|kann ich|kann man|k[öo]nnt ihr|k[öo]nnte ich|gibt es|habt ihr|is it possible|can i|can we|do you|could you|how much|how many)\b/i;
```

- [ ] **Step 5: Add the INFO branch to `classifyThread`**

In `classifyThread` direkt NACH dem NO_AVAILABILITY-Block (aus Task 4) und VOR dem `// 5) Fall-through`-Kommentar einfügen:

```ts
  // INFO — guest asked a question, nothing else matched. Low confidence;
  //   the dashboard surfaces low-confidence picks for review.
  if (guestText.trim() && INFO_RE.test(guestText)) {
    return {
      category: 'INFO',
      confidence: 0.4,
      matchedKeywords: extractKeywords(all),
    };
  }
```

- [ ] **Step 6: Run the full test suite to verify it passes**

Run: `npx vitest run src/utils/message-classifier.test.ts`
Expected: alle PASS. Insbesondere `returns OTHER for empty thread` (kein Inbound → kein INFO) und der Offsite-Test (Aussage ohne Frage → OTHER) bleiben grün.

- [ ] **Step 7: Commit**

```bash
git add src/types/messages.ts src/utils/message-classifier.ts src/utils/message-classifier.test.ts
git commit -m "feat: add INFO conversion category (pre-booking questions)"
```

---

## Task 6: Surface the new categories in the dashboard

**Files:**
- Modify: `src/routes/admin.ts` (CSS `.bar-*`/`.badge-*`, `recatSelect`, `CATEGORY_LABELS`, `ORDER`, `ALLOWED_CATEGORIES`)

Reine Render-Konfiguration, kein Unit-Test (HTML/Strings im Template-Literal). Verifikation per Build.

- [ ] **Step 1: Add bar-fill CSS for the 4 new categories**

In `src/routes/admin.ts` nach der Zeile `.bar-PARTY       .bar-fill { background: var(--color-terracotta); }` einfügen:

```css
    .bar-SPAM        .bar-fill { background: #8b7d8f; }
    .bar-COMMERCIAL  .bar-fill { background: #5b6bb0; }
    .bar-NO_AVAILABILITY .bar-fill { background: #9a6b5e; }
    .bar-INFO        .bar-fill { background: var(--color-sage); }
```

- [ ] **Step 2: Add badge CSS for the 4 new categories**

In `src/routes/admin.ts` nach der Zeile `.badge-PARTY       { background: #f1d0c5; color: #8a3015; }` einfügen:

```css
    .badge-SPAM        { background: #e6dfe8; color: #5a4d5e; }
    .badge-COMMERCIAL  { background: #dadef0; color: #2e3a78; }
    .badge-NO_AVAILABILITY { background: #ecd9d3; color: #6a4036; }
    .badge-INFO        { background: #dde4d3; color: #4a5a3b; }
```

- [ ] **Step 3: Add `<option>`s to the recat dropdown**

In `src/routes/admin.ts` im `<select id="recatSelect">` nach `<option value="PARTY">🎉 Party / Hochzeit</option>` einfügen:

```html
            <option value="SPAM">📣 Werbung</option>
            <option value="COMMERCIAL">🎬 Dreh & Kooperation</option>
            <option value="NO_AVAILABILITY">🚫 Kein Termin</option>
            <option value="INFO">❓ Vorab-Frage</option>
```

- [ ] **Step 4: Add entries to `CATEGORY_LABELS`**

In `src/routes/admin.ts` das `CATEGORY_LABELS`-Objekt so erweitern (nach `PARTY`, vor `PRICE`):

```js
    const CATEGORY_LABELS = {
      CONFIRMED:    { label: 'Bestätigt',         emoji: '✅' },
      REPEAT:       { label: 'Wiederbucher',      emoji: '🔁' },
      SPAM:         { label: 'Werbung',           emoji: '📣' },
      COMMERCIAL:   { label: 'Dreh & Kooperation', emoji: '🎬' },
      PARTY:        { label: 'Party / Hochzeit',  emoji: '🎉' },
      PRICE:        { label: 'Preisverhandlung',  emoji: '€'  },
      DIRECT_DRIFT: { label: 'Direct-Drift',      emoji: '↗'  },
      NO_AVAILABILITY: { label: 'Kein Termin',    emoji: '🚫' },
      INFO:         { label: 'Vorab-Frage',       emoji: '❓' },
      PLAN_CHANGE:  { label: 'Planänderung',      emoji: '📅' },
      OTHER:        { label: 'Sonstiges',         emoji: '◌'  },
    };
```

- [ ] **Step 5: Update the `ORDER` array**

In `src/routes/admin.ts` die `ORDER`-Zeile ersetzen durch:

```js
    const ORDER = ['CONFIRMED', 'REPEAT', 'SPAM', 'COMMERCIAL', 'PARTY', 'DIRECT_DRIFT', 'PRICE', 'NO_AVAILABILITY', 'INFO', 'PLAN_CHANGE', 'OTHER'];
```

- [ ] **Step 6: Update `ALLOWED_CATEGORIES`**

In `src/routes/admin.ts` das `ALLOWED_CATEGORIES`-Set ersetzen durch:

```ts
const ALLOWED_CATEGORIES = new Set([
  'CONFIRMED', 'REPEAT', 'SPAM', 'COMMERCIAL', 'PARTY', 'DIRECT_DRIFT',
  'PRICE', 'NO_AVAILABILITY', 'INFO', 'PLAN_CHANGE', 'OTHER',
]);
```

- [ ] **Step 7: Verify the build**

Run: `npx tsc --noEmit && npm run lint`
Expected: kein Fehler.

- [ ] **Step 8: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat: surface new conversion categories in dashboard"
```

---

## Task 7: Reclassify script + repository function

**Files:**
- Modify: `src/repositories/message-repository.ts` (neue Funktion `updateThreadClassification`)
- Create: `src/scripts/reclassify-threads.ts`

Re-Klassifizierung über bereits gespeicherte Messages — kein API/IMAP-Call. Konsistent mit dem Script-Pattern von `sync-guesty-messages.ts`.

- [ ] **Step 1: Add `updateThreadClassification` to the repository**

In `src/repositories/message-repository.ts` nach der `setManualCategory`-Funktion einfügen:

```ts
/**
 * Overwrite a thread's auto-classification. Used by the reclassify script.
 * Guards on manually_categorized = 0 so manual overrides are never touched.
 */
export function updateThreadClassification(
  threadId: string,
  category: string,
  confidence: number,
  keywordsJson: string,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE message_threads
     SET conversion_category = ?,
         classification_confidence = ?,
         classification_keywords = ?
     WHERE id = ? AND manually_categorized = 0`,
  ).run(category, confidence, keywordsJson, threadId);
}
```

- [ ] **Step 2: Create the reclassify script**

Create `src/scripts/reclassify-threads.ts` mit:

```ts
/**
 * Re-run the conversation classifier over already-stored messages.
 *
 * Re-classifies every auto-categorized thread of a property using the current
 * classifier rules — no Guesty-API / IMAP calls. Threads with a manual override
 * (manually_categorized = 1) are left untouched.
 *
 * Usage:
 *   npx tsx src/scripts/reclassify-threads.ts <slug>
 */

import { initDatabase } from '../db/index.js';
import { getPropertyBySlug, getListingId } from '../config/properties.js';
import {
  getThreadsByListing,
  getMessagesByThread,
  updateThreadClassification,
  getCategoryCounts,
} from '../repositories/message-repository.js';
import { classifyThread } from '../utils/message-classifier.js';

function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: reclassify-threads.ts <slug>');
    process.exit(1);
  }
  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found`);
    process.exit(1);
  }

  initDatabase();
  const listingId = getListingId(property);
  if (!listingId) {
    console.error(`No listing id resolvable for '${slug}'`);
    process.exit(1);
  }

  const before = getCategoryCounts(listingId);
  const threads = getThreadsByListing(listingId, { limit: 100000 });

  let updated = 0;
  let skippedManual = 0;
  for (const thread of threads) {
    if (thread.manually_categorized === 1) {
      skippedManual++;
      continue;
    }
    const messages = getMessagesByThread(thread.id).map((m) => ({
      direction: m.direction,
      body: m.body ?? '',
    }));
    const result = classifyThread({
      reservationStatus: thread.reservation_status,
      channel: thread.channel,
      messages,
    });
    updateThreadClassification(
      thread.id,
      result.category,
      result.confidence,
      JSON.stringify(result.matchedKeywords),
    );
    updated++;
  }

  const after = getCategoryCounts(listingId);
  console.log(`\n=== Reclassify '${slug}' (${listingId}) ===`);
  console.log(`threads total:    ${threads.length}`);
  console.log(`re-classified:    ${updated}`);
  console.log(`manual (skipped): ${skippedManual}`);
  console.log('\nbefore:', before);
  console.log('after: ', after);
}

main();
```

- [ ] **Step 3: Verify the build**

Run: `npx tsc --noEmit`
Expected: kein Fehler.

- [ ] **Step 4: Smoke-test the script against the local DB**

Run: `npx tsx src/scripts/reclassify-threads.ts u19`
Expected: Ausgabe `=== Reclassify 'u19' …`, `threads total: 52`, `re-classified: 52`, `manual (skipped): 0`, plus before/after-Verteilung. `after` enthält die neuen Kategorien (z.B. `SPAM`, `INFO`).

- [ ] **Step 5: Commit**

```bash
git add src/repositories/message-repository.ts src/scripts/reclassify-threads.ts
git commit -m "feat: add reclassify-threads script + updateThreadClassification repo fn"
```

---

## Task 8: Reclassify both properties + verify the dashboard

**Files:** keine — Verifikations-Task, kein Commit.

- [ ] **Step 1: Reclassify farmhouse + u19 locally**

```bash
npx tsx src/scripts/reclassify-threads.ts farmhouse
npx tsx src/scripts/reclassify-threads.ts u19
```

Expected: beide laufen ohne Fehler durch; `after`-Verteilung zeigt die neuen Kategorien. `manual (skipped)` > 0 ist OK (manuelle Overrides bleiben erhalten).

- [ ] **Step 2: Spot-check that no thread still has the old `WEDDING` value**

Run: `sqlite3 data/calendar.db "SELECT conversion_category, COUNT(*) FROM message_threads GROUP BY conversion_category ORDER BY 2 DESC;"`
Expected: kein `WEDDING` mehr in der Liste (außer evtl. bei manuell gesetzten Threads — siehe Step 3).

- [ ] **Step 3: Migrate any manual `WEDDING` overrides to `PARTY`**

Run: `sqlite3 data/calendar.db "UPDATE message_threads SET conversion_category='PARTY' WHERE conversion_category='WEDDING' AND manually_categorized=1;"`
Danach Step 2 erneut ausführen — jetzt darf `WEDDING` gar nicht mehr vorkommen.

- [ ] **Step 4: Verify the dashboard**

Dev-Server starten (`npm run dev`, Port 3099), `http://localhost:3099/admin/conversions` öffnen, je einmal `farmhouse` und `u19` wählen. Prüfen: die neuen Kategorie-Balken/Badges erscheinen mit Farbe, die Verteilung ist plausibel, ein SPAM- und ein INFO-Thread im Drilldown sehen korrekt aus.

---

## Rollout (nach Merge)

Auf dem Server (`deploy@guesty.remoterepublic.com`, `/opt/guesty-calendar-app`):

```bash
git pull && npm install && npm run build && pm2 restart guesty-calendar
npx tsx src/scripts/reclassify-threads.ts farmhouse
npx tsx src/scripts/reclassify-threads.ts u19
sqlite3 data/calendar.db "UPDATE message_threads SET conversion_category='PARTY' WHERE conversion_category='WEDDING' AND manually_categorized=1;"
```
