# Hostex Reply — Schnitt 2 (KI-Entwürfe) — Design / Spec

**Datum:** 2026-07-01
**Baut auf:** Schnitt 1 (`docs/superpowers/plans/2026-07-01-hostex-reply-slice1.md`, in main gemerged).

## Ziel
Beim Sync bekommt jeder antwort-bedürftige **Hostex**-Thread automatisch einen KI-Entwurf in Michas Stimme, generiert aus Voice + Objektfakten (aus dem TheBrain-Vault gelesen) + Thread-Verlauf. Der Entwurf landet als `pending` in der bestehenden `message_drafts`-Tabelle. Beim Öffnen des Threads liegt er **editierbar** bereit; der Operator gibt frei → senden. **Nie Auto-Send.**

## Entschiedene Optionen (Brainstorming)
- **Wissensquelle:** App liest die `.md`-Dateien zur Laufzeit direkt aus dem Vault (`VAULT_PATH`). Single Source of Truth.
- **Auslöser:** Automatisch beim Sync (nicht on-demand). Mit Idempotenz + Sicherheits-Cap gegen Kosten-Runaway.

## Architektur / Komponenten

### 1. Config: Vault-Pfad
- Neue optionale Env-Var `VAULT_PATH` (Zod in `src/config/index.ts`, `z.string().optional()`), z. B. `/Users/mca/Development/TheBrain`.
- Ist sie nicht gesetzt → Draft-Generierung wird global übersprungen (Feature aus, kein Crash).

### 2. Property→Vault-Mapping
- Neues optionales Feld `vaultNote?: string` pro Property in `data/properties.json` **und** im `PropertyConfig`-Typ (`src/config/properties.ts`).
- Werte: `bootshaus-alte-oder` → `"Bootshaus.md"`, `alte-schilderwerkstatt` → `"Alte-Schilderwerkstatt.md"`.
- Fehlt `vaultNote` → für dieses Objekt keine Objektfakten, Draft-Generierung übersprungen.

### 3. `src/services/vault-knowledge.ts` (neu)
Reine Lese-Schicht über den Vault. Keine Netzwerk-/DB-Zugriffe.
- `loadVoice(): string | null` — liest `${VAULT_PATH}/Areas/Hosting/_Voice.md`; `null` wenn `VAULT_PATH` unset oder Datei fehlt.
- `loadPropertyFacts(vaultNote: string): string | null` — liest `${VAULT_PATH}/Areas/Hosting/Properties/${vaultNote}`; `null` wenn unset/fehlt.
- Pфad-Sicherheit: `vaultNote` wird auf einen einfachen Dateinamen validiert (Regex `^[A-Za-z0-9._-]+\.md$`); kein `/` oder `..` erlaubt (Path-Traversal-Schutz). Bei Verstoß → `null`.

### 4. `src/services/draft-service.ts` (neu)
- `generateDraftForThread(input: { thread: MessageThread; messages: Message[]; voice: string; facts: string }, deps?): Promise<string | null>`
  - Baut einen System-Prompt: Voice-Text + Objektfakten + Anweisung „antworte in Michas Stimme, nur Fakten aus dem Objektwissen, nichts erfinden, kein Auto-Versand von Codes".
  - `userMessage` = der Thread-Verlauf (Gast/Host, chronologisch) mit der letzten Gastnachricht als zu beantwortende.
  - Ruft `callClaudeTool({ systemPrompt, userMessage, tool: SUBMIT_REPLY_TOOL, model: 'claude-sonnet-4-6' })`. `SUBMIT_REPLY_TOOL` = `{ name:'submit_reply', input_schema:{ type:'object', properties:{ reply:{type:'string'} }, required:['reply'] } }`.
  - Rückgabe: `result.reply` (string) oder `null` bei leerem/fehlerhaftem Ergebnis.
  - `deps` erlaubt Injektion des Claude-Callers für Tests (Default = echtes `callClaudeTool`). **Kein echter API-Call in Tests.**

### 5. Auto-Trigger beim Sync
- Neuer Job `src/jobs/hostex/generate-hostex-drafts.ts`:
  - `generateDraftsForProperty(property: PropertyConfig, deps): Promise<{ generated: number; skipped: number }>`
  - Holt Threads dieses Objekts (`listing_id === property.hostexPropertyId`) mit Antwortbedarf **und ohne** aktiven `pending`-Draft (neue Repo-Query, s. u.), begrenzt auf `DRAFT_GEN_CAP` (Konstante, z. B. 10) pro Lauf.
  - Lädt Voice + Objektfakten (vault-knowledge). Fehlt eins → Job endet mit `generated:0` (nichts erzeugt).
  - Für jeden Thread: `generateDraftForThread(...)` → bei Text `createDraft({ id: randomUUID(), thread_id, provider:'hostex', body: reply, generated_by:'llm' })` und `model` mitschreiben (s. Migration 019).
  - `deps` injizierbar (draftService, vault-loader) für Tests.
- Einhängen in `src/jobs/etl-job.ts` `runHostexETL`, **nach** dem Message-Sync, non-fatal (eigener try/catch bzw. der Job wirft nicht — gibt Ergebnisobjekt zurück).

### 6. Repository
- Migration `019_add_draft_model.sql` (nächste freie Nummer; Schnitt 1 endete bei 018): `ALTER TABLE message_drafts ADD COLUMN model TEXT;`
- `createDraft` um optionales `model` erweitern (`NewDraft.model?: string`); INSERT schreibt `model`.
- Neue Query in `message-repository.ts`: `getThreadsNeedingDraft(listingId: string, limit: number): MessageThread[]` — Threads mit `source='hostex'`, `listing_id=?`, deren jüngste Nachricht `inbound` ist, und für die KEIN `message_drafts`-Eintrag mit `status='pending'` existiert; `LIMIT ?`.
- `updateDraftBody(id: string, body: string): void` — für das Editieren vor dem Senden.

### 7. UI (`src/routes/messages.ts`)
- **Liste:** Threads mit aktivem `pending`-Draft bekommen ein Badge **„Entwurf bereit"** (zusätzliche Query oder Join; simpel: `getActiveDraftByThread` pro Thread — bei den paar Threads okay).
- **Thread-Ansicht, pending Draft:** Statt read-only Vorschau ein **editierbares Textfeld** (vorbefüllt mit `draft.body`) innerhalb des Send-Formulars, plus:
  - „Senden (Freigabe)" — POST an `/admin/messages/drafts/:id/send` mit dem (ggf. editierten) `body`. Die Send-Route (Schnitt 1) wird erweitert: `express.urlencoded` ergänzen; wenn `req.body.body` vorhanden und ≠ gespeichert → `updateDraftBody` **vor** dem atomaren Claim. Danach unverändert: claim → `sendReply` → `markDraftSent` + outbound-Row.
  - „Verwerfen" — unverändert.
  - „Neu generieren" — POST `/admin/messages/:threadId/regenerate`: verwirft den aktiven Draft (`discardDraft`) und erzeugt via `generateDraftForThread` einen neuen (synchron, on-demand). Nur Hostex.
- Badge/Label zeigt Herkunft: „KI-Entwurf" (`generated_by='llm'`) vs. „Entwurf" (manuell).

## Datenfluss
```
Sync (runHostexETL)
  → syncHostexMessagesForProperty (Schnitt 1)
  → generateDraftsForProperty:
        getThreadsNeedingDraft(listing, cap)
        loadVoice() + loadPropertyFacts(vaultNote)
        für jeden Thread: generateDraftForThread → callClaudeTool → createDraft(pending, llm, model)
Operator öffnet Thread
  → editierbares Textfeld mit draft.body
  → „Senden": updateDraftBody? → claimDraftForSending → sendReply → markDraftSent + outbound
```

## Fehlerbehandlung
- Vault unset/Datei fehlt/`vaultNote` fehlt → Generierung übersprungen, geloggt, kein Crash, Sync läuft normal weiter.
- Claude-Fehler (nach Retries im Client) → dieser Thread wird übersprungen (kein Draft), Job macht weiter.
- Generierung ist non-fatal für den ETL (wie der Message-Sync).

## Tests
- `vault-knowledge.test.ts`: temporäres `VAULT_PATH`-Fixture-Verzeichnis → `loadVoice`/`loadPropertyFacts` liefern Inhalt; `null` bei unset/fehlender Datei; Path-Traversal (`../x`, `a/b.md`) → `null`.
- `draft-service.test.ts`: gemockter Claude-Caller (`deps`) → Prompt enthält Voice + Facts + letzte Gastnachricht; Rückgabe = `reply`; `null` bei leerem Ergebnis. Kein echter API-Call.
- `generate-hostex-drafts.test.ts` (in-memory DB): erzeugt Drafts nur für needing-reply-ohne-Draft; respektiert Cap; idempotent (zweiter Lauf erzeugt nichts, weil jetzt `pending` existiert); überspringt sauber wenn Voice/Facts `null`.
- `message-repository`: `getThreadsNeedingDraft` (Ausschluss von Threads mit `pending`-Draft, listing-Filter, Limit); `updateDraftBody`.
- Migration 020 smoke (`npm run db:migrate`).
- UI: manuell/curl (kein supertest) — Badge sichtbar, Textfeld editierbar, Senden mit editiertem Text.

## Scope / YAGNI (bewusst NICHT in Schnitt 2)
- Buchungs-/Reservierungskontext im Prompt.
- Guesty-Drafting/-Send.
- Vault-Datei-Caching / File-Watching (bei jedem Lauf frisch lesen ist bei der Größe okay).
- Vault-Rücksync / Schreiben in den Vault.

## Offene Punkte / Voraussetzungen
- `VAULT_PATH` muss in der `.env` gesetzt werden, damit das Feature aktiv ist (sonst no-op).
- `vaultNote` in `data/properties.json` für die beiden Hostex-Objekte ergänzen.
- Prompt-Qualität (Voice-Treue) wird am ersten echten Entwurf beurteilt; der Prompt ist iterierbar, ohne die Architektur zu ändern.
