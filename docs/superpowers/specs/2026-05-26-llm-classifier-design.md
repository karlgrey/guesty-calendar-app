# LLM-Based Conversion Classifier

**Datum:** 2026-05-26
**Status:** Genehmigt
**Scope:** `guesty-calendar-app` — Conversion-Tracking-Classifier

## Kontext & Ziel

Der Conversion-Classifier (`src/utils/message-classifier.ts`) klassifiziert Message-
Threads aktuell per Regex in 11 Kategorien (CONFIRMED, REPEAT, SPAM, COMMERCIAL,
PARTY, DIRECT_DRIFT, PRICE, NO_AVAILABILITY, INFO, PLAN_CHANGE, OTHER — siehe
`docs/superpowers/specs/2026-05-22-conversion-categories-design.md`). Die Regex-Lösung
hat strukturelle Schwächen:

- **`NO_AVAILABILITY` matchte 0 reale Threads**: Hosts schreiben „booked until 19th,
  then again on 23rd — too close for cleaning" statt „ausgebucht/belegt/vergeben".
- **Mehrsprachigkeit fehlt** (DE+EN abgedeckt, IT/RU/FR/ES landen in OTHER, ~3–4
  False-Negatives bei farmhouse laut BI-Doc).
- **Verb-Phrasen** wie `kann ich` matchen auch Aussagen, nicht nur Fragen → INFO-FPs.
- **SPAM/COMMERCIAL-Abgrenzung** ist kontextabhängig — Regex musste z. B. `channel
  manager` und `kostenlos testen` rauslassen, weil Gäste auch so schreiben können.
- **Wartung**: jede neue Kategorie = Regex-Engineering und FP/FN-Tuning.

**Ziel:** Regex-Classifier komplett durch einen LLM-basierten Classifier ersetzen.
Da die Klassifizierung manuell und in Batches getriggert wird, sind LLM-Latenz und
-Kosten unkritisch — die Stärken von LLMs (Intent-Erkennung, Sprachunabhängigkeit,
Kontextverständnis) decken sich exakt mit den Schwächen der Regex.

## Brainstorming-Entscheidungen

- **Scope:** Voll-Ersatz der Regex. Alle Regex-Konstanten entfallen.
- **Trigger-Modell:** Separater Klassifizier-Lauf — Sync speichert Threads mit
  `conversion_category = NULL`, ein eigenes Script macht den LLM-Pass auf Anforderung.
  Sync bleibt schnell und unabhängig von der Anthropic-API.

## Architektur

```
[Sync — Guesty + Direct-Email]
   ↓ speichert Threads/Messages, conversion_category = NULL
   ↓ keinerlei LLM-Abhängigkeit
   
[Manuell: classify-threads.ts <slug>]
   ↓ für jeden Thread mit manually_categorized = 0:
        if reservation_status ∈ {confirmed, reserved, active}:
            → CONFIRMED (deterministisch, kein API-Call)
        else:
            → Anthropic-Call mit tool-use → { category, confidence, reasoning }
            → UPDATE conversion_category, classification_confidence, classification_reasoning
```

**CONFIRMED bleibt deterministisch** (Reservierungs-Status, kein Text) — spart bei
der aktuellen Datenlage ~41 % der API-Calls (101/245 Threads).

**Manuelle Overrides** (`manually_categorized = 1`) bleiben unangetastet, wie heute.

**REPEAT** und **PLAN_CHANGE** bleiben manuell-only (kein Auto-Rule — Status quo).
Der LLM kann sie theoretisch auch vorschlagen, der Prompt instruiert ihn aber, sie
nicht selbständig zu wählen (siehe „Prompt-Struktur").

## Komponenten

### 1. Neuer SDK-Wrapper: `src/services/anthropic-client.ts`

- Dünner Wrapper um `@anthropic-ai/sdk`.
- Liest `ANTHROPIC_API_KEY` aus `.env` (über `src/config/index.ts`).
- Default-Modell: `claude-sonnet-4-6` (gutes Accuracy/Cost-Verhältnis für Klassifikation).
- Prompt-Caching aktiv: System-Prompt mit Kategorie-Katalog + Few-Shots wird
  als `cache_control: { type: 'ephemeral' }` markiert → nach erstem Call gecacht
  (5-Min-TTL ist für Batch-Läufe genug).
- Exponential Backoff für 429/5xx (analog `guesty-client.ts`).
- Strukturierte Ausgabe via Tool-Use (siehe „Prompt-Struktur").

### 2. `src/utils/message-classifier.ts` — komplett ersetzt

- `classifyThread()` wird `async`.
- CONFIRMED-Shortcut (Status-Check) bleibt — kein LLM-Call.
- Sonst: ein Tool-Use-Call gegen Anthropic, Response-Parsing, Rückgabe von
  `{ category, confidence, reasoning }`.
- Alle bisherigen Regex-Konstanten (`SPAM_STRONG_RE`, `SPAM_TARGET_RE`, `SPAM_OFFER_RE`,
  `COMMERCIAL_RE`, `COMMERCIAL_LOCATION_RE`, `PARTY_RE`, `EVENT_DAY_USE_RE`,
  `PRICE_RE`, `PRICE_NUMBER_RE`, `NO_AVAILABILITY_RE`, `INFO_RE`, `GUEST_DRIFT_RE`,
  `HOST_PULLBACK_RE`, `KEYWORD_INDEX`, Helper `extractKeywords`/`joinByDirection`)
  **entfallen ersatzlos**.
- `ClassifierResult` wird zu `{ category: ConversionCategory; confidence: number;
  reasoning: string }` — Feld `matchedKeywords` wird entfernt. Die DB-Spalte
  `classification_keywords` bleibt im Schema (für alte regex-klassifizierte Rows),
  wird aber für neue Klassifizierungen NULL.

### 3. Migration `015_add_classification_reasoning.sql`

```sql
ALTER TABLE message_threads ADD COLUMN classification_reasoning TEXT;
```

`classification_keywords` bleibt im Schema (kein DROP — irreversible Operation, und
alte regex-klassifizierte Rows könnten den Wert noch tragen, bis sie re-klassifiziert
werden). Neue LLM-Klassifizierungen schreiben in `classification_reasoning`.

### 4. `src/scripts/classify-threads.ts` (umbenannt von `reclassify-threads.ts`)

Verhalten:
- Lädt alle Threads der Property mit `manually_categorized = 0`.
- Pro Thread: ruft den neuen async `classifyThread()` auf, schreibt das Ergebnis
  via `updateThreadClassification` (erweitert um `reasoning`).
- Loggt Fortschritt (z. B. alle 25 Threads ein Statusupdate, da der Lauf einige
  Minuten dauert) und Vorher/Nachher-Verteilung.
- Bei API-Fehler einzelner Threads: log + skip + continue, Counter `failedCount`,
  Summary erwähnt `failed: N`. Kein Hard-Abort.

### 5. Sync-Code entkoppelt von Klassifizierung

- `src/jobs/sync-guesty-messages.ts`: ruft `classifyThread()` **nicht mehr** auf,
  schreibt Threads mit `conversion_category = null`, `classification_confidence = null`,
  `classification_reasoning = null`. Die Helper-Funktion `mapChannel` etc. bleiben.
- `src/jobs/sync-direct-email-messages.ts`: dito — keine Klassifizierung mehr inline.
- Dashboard-Aggregat `getCategoryCounts` zeigt `COALESCE(conversion_category, 'UNCATEGORIZED')`
  (existiert bereits), also tauchen unklassifizierte neue Threads sauber als
  „UNCATEGORIZED" auf, bis der Klassifizier-Lauf läuft.

### 6. Repository: `updateThreadClassification` erweitert

```ts
export function updateThreadClassification(
  threadId: string,
  category: string,
  confidence: number,
  reasoning: string,
): void
```

Argument `keywordsJson` weg, `reasoning` rein. SQL setzt `classification_reasoning = ?`
und bleibt mit `WHERE … AND manually_categorized = 0`.

### 7. Dashboard: Reasoning anzeigen

- Im Thread-Drill-Down-Modal von `/admin/conversions` (in `src/routes/admin.ts`):
  unter dem Confidence-Score eine kleine Zeile „💡 Reasoning: …" mit dem
  LLM-Begründungstext.
- Keine weiteren UI-Änderungen.

## Prompt-Struktur

### System Prompt (gecacht)

Inhalt grob:

```
You are a conversion classifier for short-term-rental message threads. You receive
a single thread (channel, reservation_status, messages with direction) and must
assign exactly ONE of the following categories.

Categories:
  CONFIRMED      — (Set deterministically by code based on reservation_status; you
                   should NOT choose this. If you see this, return OTHER.)
  REPEAT         — Returning guest. RESERVED for manual override; do not choose.
  PLAN_CHANGE    — Guest's plans changed. RESERVED for manual override; do not choose.
  SPAM           — Cold pitch directed at the host (property management, listing
                   services, review boosting, channel-manager tools). NOT a guest.
  COMMERCIAL     — Guest wants commercial use of the property (photo/video shoot,
                   brand/influencer collaboration). They ARE a potential guest but
                   for non-overnight, non-vacation use.
  PARTY          — Guest wants the property for a private celebration: wedding,
                   birthday, baptism, anniversary, day-use event, family party.
  DIRECT_DRIFT   — Either side attempts to take the conversation off-platform
                   (sharing email/phone/WhatsApp, "let's book directly", host
                   pulls guest back to Airbnb). Only relevant for non-direct-email
                   channels.
  PRICE          — Explicit price negotiation: guest budget below listing price,
                   asks for discount/reduction, mentions specific budget number.
  NO_AVAILABILITY — Host declines because dates are taken (incl. paraphrases like
                   "we are booked until X, too close for cleaning", "leider belegt",
                   "already booked", etc.).
  INFO           — Guest asks a genuine pre-booking question (transport, pets,
                   amenities, check-in times, capacity) and nothing else applies.
  OTHER          — None of the above (rare).

Decision rules:
- Choose the most informative category. SPAM > COMMERCIAL > PARTY > DIRECT_DRIFT
  > PRICE > NO_AVAILABILITY > INFO > OTHER when multiple could apply.
- Threads are multilingual (DE/EN/IT/RU/FR/ES). Classify regardless of language.
- Provide a SHORT reasoning (1 sentence, max 25 words) referencing the key signal.

Few-shot examples:
[8–10 real anonymized examples from u19/farmhouse data, each as a thread + the
expected { category, confidence, reasoning } — covering SPAM, COMMERCIAL, PARTY,
PRICE, DIRECT_DRIFT, NO_AVAILABILITY, INFO, OTHER]
```

Few-Shot-Quellen (echte Daten):
- Tamsir / Sophia / Leon → SPAM
- Lea → COMMERCIAL
- Yuval / Ekin → PARTY
- Shavana / Vian → PRICE
- (Booking.com „too close for our cleaning staff") → NO_AVAILABILITY
- Matilde / Denise → INFO
- Eduardo (detaillierte Fragen ohne Follow-up) → INFO
- Offsite-Statement ohne Frage → OTHER

### User Message

```
Channel: airbnb
Reservation status: inquiry
Messages:
  [inbound] Lieber Christian, ich bin Fotograf/in und bin auf deine schöne …
  [outbound] Hallo, danke für die Anfrage. …
```

### Tool Definition

```ts
{
  name: 'classify_thread',
  description: 'Assign exactly one conversion category to the thread.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['SPAM','COMMERCIAL','PARTY','DIRECT_DRIFT','PRICE',
               'NO_AVAILABILITY','INFO','OTHER'],
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reasoning: { type: 'string', maxLength: 200 },
    },
    required: ['category', 'confidence', 'reasoning'],
  },
}
```

Enum bewusst beschränkt auf 8 Werte — CONFIRMED/REPEAT/PLAN_CHANGE sind deterministisch
bzw. manuell, der LLM darf sie nicht vorschlagen.

`tool_choice: { type: 'tool', name: 'classify_thread' }` erzwingt strukturierte Ausgabe.

## Data Flow

1. **Sync** (Guesty/Gmail) schreibt `message_threads` mit `conversion_category = null`.
2. **`classify-threads.ts <slug>`**:
   - Lädt Threads + Messages.
   - Pro nicht-manuellem Thread:
     - Status-Check → CONFIRMED-Shortcut, kein API-Call.
     - Sonst: `await classifyThread(input)` → Anthropic-Call → strukturiertes
       Ergebnis → `updateThreadClassification(threadId, category, confidence, reasoning)`.
   - Loggt Vorher/Nachher.
3. **Dashboard** liest `message_threads.conversion_category` und
   `classification_reasoning` wie heute.

## Tests

- `src/services/anthropic-client.test.ts` (neu) — Tool-Use-Response-Parsing,
  Fehlerfälle, Backoff-Verhalten (mit gemocktem SDK).
- `src/utils/message-classifier.test.ts` — vollständig neu geschrieben:
  - CONFIRMED-Shortcut bleibt deterministisch testbar.
  - LLM-Pfad mit Mock-Anthropic-Client (Stub-Response). Tests verifizieren:
    Input-Aufbereitung (User-Message), korrekte Tool-Definition, Response-Parsing,
    `ClassifierResult`-Shape, Error-Handling (API-Fehler → throw oder
    Default-Fallback je nach Designentscheidung).
- 1 optionaler **Integration-Test** gegen die echte API, gegated durch
  `process.env.ANTHROPIC_INTEGRATION === '1'` — wird in CI/Default-Run übersprungen,
  manuell für Smoke-Test nutzbar.

## Error Handling

- **API-Fehler pro Thread im Script:** log mit `propertySlug` + `threadId`, skip,
  `failedCount++`, continue. Summary zeigt `failed: N` neben `re-classified: M`.
- **API-Fehler im inline-Path** (falls jemand `classifyThread` direkt verwendet):
  throw. Caller entscheidet. Aktuell nutzt nur das Script die Funktion auf der
  Schreibseite — Sync-Pfade nutzen sie nicht mehr.
- **Invalid tool-use response** (kein Tool-Call, falsche Properties): throw mit
  klarer Fehlermeldung im Wrapper.
- **Rate-Limit (429):** exponential backoff mit Jitter, max 5 retries, dann werfen.
- **Anthropic-Key fehlt in `.env`:** Wrapper wirft beim ersten Aufruf einen
  `ConfigError` mit der Anweisung, `ANTHROPIC_API_KEY` zu setzen.

## Kosten

Grobe Größenordnung pro vollem Lauf (farmhouse + u19, ~144 Nicht-CONFIRMED-Threads):
- System-Prompt: ~2000 Tokens, **gecacht** (1. Call: full price; 2.–N: 10 % der
  Input-Rate). Sonnet 4.6: ~$3 / MTok input, ~$15 / MTok output.
- User-Message pro Thread: ~200–800 Tokens (Threads sind kurz).
- Output: ~50 Tokens (Tool-Call mit JSON).
- 144 Calls × (cached 2k + ~500 Live) input + 50 output ≈ 0,3 MTok input + 0,007 MTok output ≈ **0,10–0,30 €** pro vollständigem Lauf.

Mit Haiku 4.5: etwa ein Drittel. Praktisch egal — Sonnet 4.6 bleibt Default.

## Erwartete Qualitätsverbesserung

- **NO_AVAILABILITY:** 0 → realistisch 5–10 echte Treffer.
- **Mehrsprachigkeit:** IT/RU/FR/ES korrekt klassifiziert.
- **INFO:** keine Verb-Phrasen-FPs mehr (`kann ich` in Aussagen).
- **SPAM:** „channel manager", „kostenlos testen" und ähnliche Vendor-Pitches
  werden zuverlässig erkannt (kein FP-Tradeoff mehr nötig).
- **SPAM/COMMERCIAL-Abgrenzung:** sauberer (Intent statt Keyword).
- **`reasoning`-Feld** im Dashboard → bessere Transparenz für manuelle Reviews.

## Datenbestand & Rollout

1. Branch `feat/llm-classifier`, Implementierung, Tests grün, `npx tsc --noEmit` clean.
2. `.env` lokal: `ANTHROPIC_API_KEY=…` ergänzen.
3. Migration 015 lokal anwenden (passiert automatisch beim Start des Dev-Servers).
4. Smoke-Test: `npx tsx src/scripts/classify-threads.ts u19` → laufen, prüfen ob
   Verteilung plausibel ist, `classification_reasoning`-Spalte gefüllt.
5. Dann farmhouse: `npx tsx src/scripts/classify-threads.ts farmhouse`.
6. Dashboard lokal aufrufen, Drill-Down ansehen — Reasoning-Zeile gerendert?
7. Merge nach `main`.
8. Production: `ANTHROPIC_API_KEY` in `/opt/guesty-calendar-app/.env` ergänzen,
   `git pull && npm install && npm run build && pm2 restart guesty-calendar`,
   Migration 015 läuft automatisch, dann `classify-threads.ts farmhouse` und
   `classify-threads.ts u19` auf dem Server.

## Out of Scope

- **Scheduler-Integration des Klassifizier-Laufs** — bleibt manuell, wie der
  Sync. Bewusst entkoppelt.
- **Re-Klassifikation der bereits regex-klassifizierten Daten** — passiert
  einfach beim ersten manuellen Lauf nach Deploy (idempotent, respektiert
  manuelle Overrides).
- **REPEAT-Auto-Detection** — bleibt manuell-only.
- **Multi-Property-Loop** im Script — `classify-threads.ts` nimmt **eine** Property
  pro Aufruf (wie heute).
- **Confidence-basierte Re-Klassifikation** (z. B. „nur Threads mit confidence<0.5
  erneut anfragen") — YAGNI, kann später ergänzt werden.

## Implementierungs-Hinweise

- Beim Bauen die `claude-api`-Skill nutzen — sie deckt Prompt-Caching, Tool-Use,
  SDK-Konfiguration und Modell-IDs für Claude 4.x ab.
- Modell-ID: `claude-sonnet-4-6`.
- Anthropic-SDK: `@anthropic-ai/sdk` als neue Dependency.
