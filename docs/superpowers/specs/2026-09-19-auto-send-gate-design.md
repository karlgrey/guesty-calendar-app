# Auto-Send-Gate für Gästeantworten + Push für wartende Entwürfe — Design

**Datum:** 2026-09-19 · **Status:** Entwurf zur Freigabe · **Auftraggeber:** Micha
**Repos:** `guesty-calendar-app` (Kern) · `TheBrain2` (Push-Watcher auf labs, Wiki-Nachzug)

## 1. Ziel und Entscheidung

Die Gäste-Messaging-App entwirft heute Antworten, die Micha im Admin-UI pro
Nachricht freigibt. Das war seit 07.07.2026 das einzige Sicherungs-Gate
(„Kein Auto-Send"). **Micha hat diese Entscheidung am 19.09.2026 bewusst
revidiert:** Antworten, bei denen ein prüfbares Gate „sicher" sagt, gehen
automatisch raus. Alles andere wartet weiter auf Micha — und er erfährt davon
jetzt per WhatsApp-Push, damit auch diese Fälle im Fenster bleiben.

**Antwortzeit-Ziel:** Gastnachricht → Antwort (automatisch oder durch Micha)
in **maximal 20 Minuten**. Daraus abgeleitet:

| Schritt | Ziel |
|---|---|
| Gastnachricht bekannt in der App | Guesty: Sekunden (Webhook), spätestens 5 min (Poll) · Hostex: ≤ 5 min |
| Entwurf + Prüfung + Entscheidung | ≤ 1 min nach Bekanntwerden |
| Auto-Send (Live-Modus) | ≤ 10 min nach Gastnachricht (Worst Case) |
| WhatsApp-Push „wartet auf dich" | ≤ 8 min nach Gastnachricht (Worst Case) |

**Nicht Teil dieses Vorhabens:** Direktanfragen per Mail-Formular
(`sync-direct-email-messages`), Gastbewertungen, Florenz/airbnb-mail
(kein Rückkanal), Hostex-Webhooks (single-attempt, 3 s — Entscheidung 05/2026
bleibt), Push für automatisch gesendete Antworten (Micha sieht sie im UI und
im Standup), ein eigener Push-Kanal in der App (WhatsApp bleibt Sache von
TheBrain2/labs).

## 2. Warum kein „95 %-Wert" des Modells

Ein Sprachmodell, das sich selbst eine Sicherheit von 95 % attestiert, liefert
keine belastbare Zahl. Sicherheit entsteht hier aus drei unabhängig prüfbaren
Schichten, die **alle** grün sein müssen (Abschnitt 5):

1. **Inhaltliche Prüfung** durch ein zweites Modell mit eigenem Prompt
   (Kategorie, Risiko-Flags, Ja/Nein) — getrennt vom Entwurfs-Aufruf.
2. **Mechanische Checks** im Code, modellunabhängig (Codes, Links, Mail-
   Adressen, Geldbeträge, fremde Datumsangaben).
3. **Betriebsgrenzen**: Modus pro Objekt (aus/Schatten/live), Tageslimit,
   Not-Aus, Thread-Ausschlüsse.

Die Zahl „95 %" wird stattdessen zur **Messgröße der Schattenphase**
(Abschnitt 9): Anteil der als „auto" bewerteten Entwürfe, die Micha
unverändert gesendet hat.

## 3. Architektur und Datenfluss

```
Guesty ──webhook reservation.messageReceived──▶ POST /api/webhooks/guesty ──┐
Guesty ──Poll alle 5 min (Konversationen, limit 100, inkrementell)──────────┤
Hostex ──Poll alle 5 min (Liste mit last_message_at, inkrementell)──────────┤
                                                                            ▼
                                              Message-Sync (bestehend, idempotent)
                                                                            ▼
                                   Entwurf (bestehend: generate-drafts / draft-service)
                                                                            ▼
                                            Auto-Send-Gate (NEU, Abschnitt 5)
                                            ┌───────────────┴────────────────┐
                                     Entscheidung „auto"             Entscheidung „wait"
                                     ├─ Modus live → sendReply()     └─ Entwurf bleibt pending,
                                     │  → markDraftSent(sent_by=auto)   auto_decision='wait'
                                     └─ Modus shadow → nur protokollieren        │
                                                                                 ▼
                                        Agent-API GET /api/agent/drafts/awaiting?since=…
                                                                                 ▼
                                   labs (User claude): tools/labs/draft-push.sh, Timer alle 2 min
                                                                                 ▼
                                        tools/push-micha-wa.sh → WhatsApp-Selbst-Chat
```

**Trennung vom Stunden-ETL:** Der ETL (Listing, Verfügbarkeit, Reservierungen,
Nachrichten, Entwürfe, Bewertungen) bleibt wie er ist. Neu ist ein
**Nachrichten-Loop** (`src/jobs/message-loop.ts`), der nur Nachrichten-Sync +
Entwurf + Gate fährt. Beide rufen dieselbe Verarbeitungskette pro Thread auf
(`processThreadForReply`), die idempotent ist: ein Thread mit aktivem
`pending`-Draft oder ohne neue Gastnachricht wird nicht erneut bearbeitet
(bestehende Invariante „ein pending-Draft pro Thread").

**Nebenläufigkeit:** Ein prozessweiter Mutex (`message-loop` vs. ETL-Schritt
Nachrichten) verhindert überlappende Syncs desselben Providers; wer den Lock
nicht bekommt, überspringt den Lauf und loggt das (kein Warten).

### 3.1 Guesty-Webhook

- Registrierung einmalig per Skript `src/scripts/register-guesty-webhook.ts`:
  `POST /webhooks` mit `url = <BASE_URL>/api/webhooks/guesty`,
  `events = ["reservation.messageReceived"]`. Das Skript listet vorher
  bestehende Subscriptions und legt keine doppelte an (Guesty-Hinweis:
  URLs pro Subscription eindeutig halten).
- Signaturprüfung: Secret per `GET /webhooks-v2/secret` holen (Skript gibt es
  aus), in `.env` als `GUESTY_WEBHOOK_SECRET`; Verifikation nach Svix-Schema
  (Header `svix-id`, `svix-timestamp`, `svix-signature`, HMAC-SHA256 über
  `id.timestamp.rawBody`, Toleranz 5 min). **Die Route wird vor
  `express.json()` mit `express.raw({ type: 'application/json' })` gemountet**,
  weil die Signatur den unveränderten Rohkörper braucht.
- Verarbeitung: sofort `202` (Guesty erwartet 2xx binnen 15 s), dann
  asynchron: `conversationId` aus dem Payload → Posts genau dieser einen
  Konversation nachladen (bestehender Post-Sync, eine Konversation) →
  `processThreadForReply`. Payload-Body wird **nicht** direkt persistiert
  (Dedup und Vollständigkeit über den Post-Fetch; Guesty-Replay-Falle bleibt
  durch Dedup auf `message_id` abgedeckt).
- Nur `conversationWith === 'Guest'` und `message.type === 'fromGuest'` lösen
  etwas aus; alles andere wird quittiert und ignoriert.
- Ungültige Signatur → `401`, Log `warn`. Fehlende Konfiguration
  (`GUESTY_WEBHOOK_SECRET` leer) → Route antwortet `503` und loggt einmal
  beim Start; der Poll bleibt das Netz.

### 3.2 Nachrichten-Loop (Poll)

- `MESSAGE_LOOP_MINUTES` (Default 5), Start 60 s nach App-Start, Jitter ±10 %.
- Guesty: `fetchAllConversations` mit `limit=100` (statt 50; Spike 19.09.2026:
  282 Konversationen im Account = 3 Seiten) + bestehendes Inkrementell-Gate
  `shouldDeepFetchConversation`. Listing-Filter der API ist überflüssig (der
  Account enthält nur unsere zwei Listings); `sort=-lastUpdatedAt` wird von
  der API ignoriert (Spike) — bleibt außen vor.
- Hostex: bestehender inkrementeller Sync (Liste trägt `last_message_at`).
- Danach pro Property `processThreadForReply` für Threads mit neuer
  Gastnachricht (bestehende Auswahl `getThreadsNeedingDraft`, Cap
  `DRAFT_GEN_CAP`).
- Rate-Budget Guesty: ~3 Listen-Aufrufe + Posts aktiver Threads (typisch
  5–20) pro Lauf → < 300 Aufrufe/Stunde, weit unter 5.000/h; der Bottleneck-
  Limiter bleibt aktiv.

## 4. Verarbeitungskette pro Thread (`processThreadForReply`)

1. Entwurf erzeugen wie heute (`generateDraftForThread`); `no_reply` und
   `failed` bleiben unverändert (kein Gate, kein Push — `no_reply` ist per
   Definition „braucht keine Antwort").
2. Entwurf speichern (`createDraft`, `status='pending'`).
3. Gate ausführen (Abschnitt 5) → Entscheidung + Begründung am Entwurf
   persistieren (`auto_decision`, `auto_category`, `auto_flags`,
   `auto_reason`, `auto_mode`, `auto_judged_at`).
4. Modus des Objekts:
   - `off`: nichts weiter (Entwurf wartet, aber ohne Push-Kennzeichnung —
     Verhalten wie heute; `auto_decision` bleibt `NULL`).
   - `shadow`: Entscheidung nur protokolliert; Entwurf wartet auf Micha.
     **Push nur für `wait`-Entscheidungen** (auch im Schattenmodus — sonst
     bekäme Micha im Schatten mehr Pushes als später live).
   - `live` + `auto`: `claimDraftForSending` → `sendReply` → `markDraftSent`
     mit `sent_by='auto'`. Fehler → `markDraftError`, Entwurf zählt als
     `wait` für den Push (Grund „Auto-Send fehlgeschlagen: …").
   - `live` + `wait`: Entwurf wartet, Push.

## 5. Das Gate

### 5.1 Schicht 1 — Prüfung durch zweites Modell (`judge-service.ts`)

- Modell: `claude-opus-5` (bewusst ein anderes Modell als der Entwurf
  `claude-sonnet-5`, Unabhängigkeit; Volumen ist klein). `thinking: { type:
  'disabled' }` wie überall in der App (Lehre 07.08.2026: adaptives Thinking
  frisst `max_tokens`).
- Eingabe: letzte Gastnachricht(en) seit der letzten Host-Antwort, der
  Entwurf, die Objekt-Fakten und Voice aus dem Vault (dieselben Blöcke wie im
  Entwurfs-Prompt), BUCHUNGSKONTEXT-Block.
- Ausgabe über Tool `judge_draft` (Pflichtfelder, `tool_choice` erzwungen):
  - `category` ∈ `dank_smalltalk` · `ankunftszeit` · `playbook_fakt`
    (WLAN, Parken, Checkout-Zeit, Ausstattung, Umgebung) ·
    `checkin_standard` (Bestätigung Self-Check-in-Ablauf) ·
    `geld` · `storno_datum` · `beschwerde_schaden` · `sonderwunsch`
    (Früh-Zugang, Zusatzgäste, Haustiere …) · `medizin_sicherheit` · `unklar`
  - `answerable_from_facts` (bool): steht die Antwort wörtlich/eindeutig in
    den Fakten?
  - `risk_flags` ⊆ `invents_fact` · `promises_action` · `mentions_code` ·
    `contradicts_facts` · `tone_off` · `language_mismatch` · `multi_topic`
    (Gast fragt mehrere Dinge, davon mindestens eines nicht harmlos)
  - `confidence` ∈ `hoch` · `mittel` · `niedrig`
  - `reasoning` (1–2 Sätze, für die Ampel)
- Der Prompt enthält die Kategorie-Definitionen und **Few-Shots** aus
  anonymisierten echten Fällen (mind. je zwei pro Kategorie, Fixtures in
  `src/test-fixtures/judge/`). Der Prompt ist eine eigene Datei
  (`judge-prompt.ts`), getrennt von `draft-service`/`review-classifier`.
- Technischer Fehler (Timeout, Parse-Fehler, fehlendes Pflichtfeld) →
  Ergebnis `wait` mit Grund „Prüfung technisch fehlgeschlagen".

### 5.2 Schicht 2 — Mechanische Checks (`mechanical-checks.ts`, rein)

Läuft über den Entwurfstext; jeder Treffer ist ein Flag mit Fundstelle:

| Flag | Regel |
|---|---|
| `digits` | Ziffernfolge ≥ 4 Stellen, die nicht als Datum/Jahr im Buchungskontext oder in der Gastnachricht vorkommt |
| `url` | `https?://`, `www.` |
| `email` | `\S+@\S+\.\S+` |
| `money` | `€`, `EUR`, `Euro`, Beträge mit Nachkommastellen |
| `phone` | `+` gefolgt von Ziffern, oder ≥ 7 Ziffern mit Trennern |
| `code_words` | `Code`, `PIN`, `Tresor`, `Schlüsselbox`, `Schloss` + Ziffer im selben Satz |
| `length` | Entwurf > 1.200 Zeichen |
| `empty` | Entwurf leer/nur Whitespace |

Alle Regeln sind Regex/Stringfunktionen ohne I/O und vollständig unit-getestet.

### 5.3 Schicht 3 — Betriebsgrenzen (`policy.ts`, rein)

`decide(input) → { decision: 'auto' | 'wait', reason, category, flags }` mit:

- **Kategorie-Whitelist:** nur `dank_smalltalk`, `ankunftszeit`,
  `playbook_fakt`, `checkin_standard`. Für `playbook_fakt` zusätzlich
  `answerable_from_facts === true`.
- `risk_flags` leer, mechanische Flags leer, `confidence === 'hoch'`.
- **Thread-Ausschlüsse** (→ `wait`, Grund „Micha hat in diesem Thread schon
  eingegriffen"): irgendein Draft mit `status='discarded'` im Thread, eine
  `draft_feedback`-Zeile im Thread, `manual_category` gesetzt.
- **Tageslimit:** `AUTO_SEND_DAILY_CAP` (Default 10) Auto-Sends pro Kalendertag
  (Europe/Berlin) über alle Objekte; erreicht → `wait`, Grund „Tageslimit".
- **Not-Aus:** Setting `auto_send_paused` (Tabelle `app_settings`, Schalter
  im Admin-UI unter `/admin/system`), zusätzlich `AUTO_SEND_MODE=off` in
  `.env` als harter Aus-Schalter. Pausiert → alle Entscheidungen `wait`,
  Grund „Auto-Send pausiert".
- **Modus:** `AUTO_SEND_MODE` global (`off`|`shadow`|`live`, Default `off`),
  pro Property optional `autoSend` in `data/properties.json`; effektiv ist
  der **restriktivere** der beiden Werte (`off` < `shadow` < `live`).

Die Begründung (`auto_reason`) ist immer ein deutscher Satz für die Ampel,
z. B. „Kategorie Sonderwunsch — nie automatisch" oder „Mechanischer Check:
Ziffernfolge 4711 im Text".

## 6. Datenmodell (Migration `027_add_auto_send.sql`)

`message_drafts` neue Spalten:

| Spalte | Typ | Bedeutung |
|---|---|---|
| `auto_decision` | TEXT NULL | `auto` · `wait` (NULL = Gate lief nicht / Modus off) |
| `auto_category` | TEXT NULL | Kategorie aus 5.1 |
| `auto_flags` | TEXT NULL | JSON-Array aller Flags (Modell + mechanisch) |
| `auto_reason` | TEXT NULL | Ampel-Satz |
| `auto_mode` | TEXT NULL | effektiver Modus zur Entscheidungszeit |
| `auto_judged_at` | TEXT NULL | ISO-Zeit |
| `sent_by` | TEXT NULL | `micha` · `auto` (bei `status='sent'`) |
| `sent_body_changed` | INTEGER NULL | 1 = Micha hat den Text vor dem Senden geändert (Schatten-Auswertung) |

Neue Tabelle `app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`
für `auto_send_paused`. Indizes: `(auto_decision, created_at)` für die
Awaiting-Abfrage, `(sent_by, sent_at)` für Tageslimit und Statistik.

`sent_by='micha'` und `sent_body_changed` werden in der bestehenden Send-Route gesetzt: Body aus dem
Formular ≠ gespeicherter Draft-Body (Whitespace-normalisiert).

## 7. Sichtbarkeit

### 7.1 Admin-UI (Ampel)

- **Liste** `/admin/messages`: Badge je Thread mit aktivem Draft —
  🟢 „automatisch gesendet HH:MM" · 🟡 „wartet auf dich: <Grund>" ·
  im Schattenmodus zusätzlich ⚪ „wäre automatisch gesendet worden".
- **Thread-Ansicht**: Panel über dem Entwurf mit Entscheidung, Kategorie,
  Flags, Begründung, Modus; im Schattenmodus der Hinweis „Schattenphase —
  nichts wird ohne dich gesendet".
- **Auswertungsseite** `/admin/messages/auto-send`: Zähler je Modus und
  Entscheidung, Kennzahl **„auto-bewertet und unverändert gesendet"** in
  Prozent, Liste aller `auto`-Fälle mit Änderungs-Marker und Link, Schalter
  „Auto-Send pausieren", Tageszähler gegen das Limit.

### 7.2 Agent-API (read-only, bestehender `X-Agent-Key`)

- `GET /api/agent/drafts/awaiting?since=<ISO>&limit=<n>` → Entwürfe mit
  `auto_decision='wait'` **oder** `status='error'`, `created_at > since`,
  aufsteigend: `draftId`, `threadId`, `property` (Kürzel), `guestName`,
  `guestMessageExcerpt` (letzte Gastnachricht, max. 160 Zeichen, ein Satz),
  `reason`, `createdAt`, `adminUrl`.
- `GET /api/agent/threads` bekommt zusätzlich `autoDecision` je Thread.
- `GET /api/agent/auto-send/stats?days=1` → Zähler für die Standup-Zeile
  (`autoSent`, `waited`, `shadowWouldAuto`, `shadowUnchangedRate`).

### 7.3 Push-Watcher (TheBrain2, labs, User `claude`)

- `tools/labs/draft-push.sh`, systemd-Units `claude-draft-push.service`/
  `.timer` (`OnCalendar=*-*-* 07..22:*/2 Europe/Berlin`, `AccuracySec=30s`;
  ANNAHME: kein Push zwischen 23:00 und 07:00 — nachts liegengebliebene
  Fälle erscheinen im Standup und beim ersten Lauf um 07:00; Micha
  bestätigt oder ändert das Fenster).
- Ablauf: Cursor aus `~/logs/draft-push-cursor.json` (lokal auf labs, **nicht**
  im Repo — alle 2 Minuten committen wäre Rauschen) → `tools/agent-api.sh
  GET "/drafts/awaiting?since=<cursor>"` → je Treffer `tools/push-micha-wa.sh`
  → Cursor auf das größte `createdAt` setzen, nur wenn alle Pushes `sent`
  waren (sonst bleibt der Cursor stehen und der nächste Lauf wiederholt).
- Push-Text (eine Zeile, keine Codes, kein Gast-Kontakt):
  `📩 Gast wartet · FH · Max M.: „Können wir schon um 13 Uhr kommen?" · Grund: Sonderwunsch · https://guesty.remoterepublic.com/admin/messages/<threadId>`
- `DRAFT_PUSH_DRY_RUN=1` loggt statt zu senden. flock gegen Überlappung,
  Logs nach `~/logs/draft-push.log` wie bei den anderen labs-Skripten.
- Allow-Regel für das neue Skript in `.claude/settings.json` nicht nötig
  (läuft per Timer, nicht aus Sessions).

### 7.4 Standup

Skill `standup` bekommt im Gäste-Schritt eine Zeile aus
`/auto-send/stats?days=1`: „Auto-Send: N automatisch, M warteten, Schatten:
K wären raus (X % unverändert)". Nur eine Zeile, keine Einzelfälle — die
stehen im Admin-UI.

## 8. Fehlerbehandlung (Zusammenfassung)

| Fall | Verhalten |
|---|---|
| Webhook-Signatur ungültig | 401, `warn`-Log, keine Verarbeitung |
| Webhook-Payload ohne Gastnachricht | 202, ignoriert |
| Webhook-Duplikat / Replay | Post-Fetch + Dedup auf `message_id`; kein zweiter Entwurf dank pending-Invariante |
| Prüfmodell fehlerhaft/Timeout | Entscheidung `wait`, Grund benennt den Fehler |
| Auto-Send schlägt fehl | `status='error'`, erscheint in `/drafts/awaiting`, Push |
| Kanal nicht auflösbar (Guesty `log`-Posts) | wie heute: kein Send möglich → `wait`, Grund „Kanal unklar" |
| Tageslimit erreicht | `wait`, Grund „Tageslimit" — Micha sieht es im UI |
| Poll und ETL gleichzeitig | Mutex, zweiter überspringt mit Log |
| Watcher: Push fehlgeschlagen | Cursor bleibt, Wiederholung im nächsten Lauf, Log |
| Watcher: Agent-API nicht erreichbar | Lauf endet mit Log, Cursor unverändert |

## 9. Schattenphase und Scharfschalten

1. **Deploy mit `AUTO_SEND_MODE=shadow`** für alle vier Objekte, Webhook
   registriert, Watcher installiert. Ab jetzt: jede Entscheidung
   protokolliert, Push für `wait`-Fälle, nichts wird automatisch gesendet.
2. **Kriterium für live** (Auswertungsseite): mindestens **20** Entwürfe mit
   Entscheidung `auto`, davon **≥ 95 %** von Micha unverändert gesendet
   (`sent_body_changed = 0`) und **kein** `auto`-Fall, den Micha verworfen
   oder mit Feedback `fakt` versehen hat.
3. **Scharfschalten objektweise** (`autoSend: "live"` in `properties.json`),
   Reihenfolge entscheidet Micha; Tageslimit bleibt. Nach einer Woche live
   ohne Vorfall: alle vier.
4. Jederzeit zurück: Schalter „pausieren" im UI (sofort) oder
   `AUTO_SEND_MODE=off` + Restart.

## 10. Komponenten und Dateien

**guesty-calendar-app**
- `src/routes/webhooks-guesty.ts` (neu) — Route, Signaturprüfung, 202-Ack,
  asynchrone Verarbeitung. Mount in `app.ts` **vor** `express.json()`.
- `src/services/guesty-webhook-signature.ts` (neu, rein) — Svix-Verifikation.
- `src/scripts/register-guesty-webhook.ts` (neu) — Registrierung + Secret.
- `src/jobs/message-loop.ts` (neu) — 5-min-Loop, Mutex, Aufruf Sync + Kette.
- `src/jobs/process-thread-for-reply.ts` (neu) — Kette aus Abschnitt 4;
  `generate-drafts.ts` ruft sie statt `createDraft` direkt.
- `src/services/auto-send/policy.ts`, `mechanical-checks.ts`,
  `judge-service.ts`, `judge-prompt.ts`, `auto-send-runner.ts` (neu).
- `src/repositories/draft-repository.ts` — neue Felder, `getAwaitingDrafts`,
  `countAutoSentToday`, `getAutoSendStats`.
- `src/repositories/app-settings-repository.ts` (neu).
- `src/db/migrations/027_add_auto_send.sql` (neu).
- `src/routes/messages.ts` — Ampel-Daten, `sent_body_changed`, Auswertungs-
  seite, Pausen-Schalter (Views entsprechend).
- `src/routes/agent-api.ts` — `/drafts/awaiting`, `/auto-send/stats`,
  `autoDecision` in `/threads`.
- `src/jobs/scheduler.ts` — Start des Message-Loops; `sync-guesty-messages.ts`
  auf `limit=100`.
- `src/config/index.ts`, `.env.example`, `CLAUDE.md` — neue Variablen
  (`AUTO_SEND_MODE`, `AUTO_SEND_DAILY_CAP`, `MESSAGE_LOOP_MINUTES`,
  `GUESTY_WEBHOOK_SECRET`, `JUDGE_MODEL`).

**TheBrain2**
- `tools/labs/draft-push.sh`, `tools/labs/units/claude-draft-push.{service,timer}`,
  `tools/labs/README.md`, `tools/labs/install.sh` (Unit mit installieren).
- Skill `standup` (eine Zeile), Skill `eingang` (Hinweis: wartende Entwürfe
  kommen jetzt per Push, im Sweep nur noch melden, nicht mehr als Neuigkeit
  behandeln).
- Wiki nach Go-live: [[Gäste-Messaging-Automation]] (Entscheidung
  19.09.2026 revidiert „Kein Auto-Send", Schnitt 7), [[Gästekommunikation
  Grundsätze]] (Satz „Kein Auto-Send" ersetzen), [[Systemstand]], `index.md`,
  `log.md`.

## 11. Tests

- **Rein/Unit:** `policy.decide` (Whitelist, jede Ausschlussregel,
  Tageslimit, Pause, Modus-Minimum), `mechanical-checks` (jede Regel mit
  Positiv-/Negativfällen, Datum-im-Kontext-Ausnahme), Parsen der
  `judge_draft`-Antwort (fehlende Felder, ungültige Enums → `wait`),
  Svix-Signatur (gültig, manipulierter Body, alte Zeit, fehlende Header).
- **Repository:** Migration, `getAwaitingDrafts` (since/limit/Reihenfolge,
  `error`-Drafts enthalten), `countAutoSentToday` (Tagesgrenze Europe/Berlin).
- **Kette:** `processThreadForReply` mit injizierten Deps (wie
  `generate-drafts.test.ts`): shadow sendet nie; live + auto sendet genau
  einmal; Send-Fehler → error + awaiting; Prüffehler → wait.
- **Route:** Webhook-Route liefert 202 vor der Verarbeitung, 401 bei
  Signaturfehler, 503 ohne Secret; Agent-API-Endpunkte mit Key.
- **Judge-Prompt:** Fixture-Suite (anonymisierte echte Fälle) als
  Regressionstest gegen das echte Modell, **nicht** im normalen `npm test`
  (Kosten), sondern `npm run test:judge` — Pflicht vor jeder Prompt-Änderung.
- **Watcher:** `draft-push.sh` mit `DRAFT_PUSH_DRY_RUN=1` gegen die echte
  Agent-API auf labs; Cursor-Verhalten bei fehlgeschlagenem Push manuell
  geprüft (Push-Skript im dry-run der Bridge).

## 12. Offene Punkte (Micha)

- Push-Zeitfenster 07:00–23:00 (Annahme in 7.3) — ok?
- Reihenfolge des objektweisen Scharfschaltens nach der Schattenphase.
- Separat, nicht Teil dieser Spec: **Guesty-App pusht nicht** — Micha prüft
  die Benachrichtigungs-Einstellungen der Guesty-Mobile-App (Task im Board).

## 13. Verworfene Alternativen

- **Gate im Eingang-Sweep (Claude entscheidet):** 20-min-Takt hält das Fenster
  nicht; außenwirksame Entscheidungen gehören in getesteten Code.
- **Direkter Bridge-Aufruf aus der App (HTTP-Endpunkt in der Bridge):**
  Sekunden schneller, aber Änderung an der bewusst dummen Bridge und ein
  neuer Schreibkanal in Michas WhatsApp; der Watcher liefert ≤ 2 min.
- **Eigene Konfidenzzahl aus dem Entwurfs-Aufruf:** Selbstbewertung ohne
  Prüfwert; ersetzt durch zweites Modell + mechanische Checks.
- **Hostex-Webhooks:** single-attempt, 3 s — Polling alle 5 min ist billig.
- **Guesty-Listing-Filter / Sortierung nach Aktivität:** Filter unnötig (nur
  unsere Listings im Account), Sortierung wird ignoriert (Spike 19.09.2026).
