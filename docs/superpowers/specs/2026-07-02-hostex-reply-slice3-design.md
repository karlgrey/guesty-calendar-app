# Hostex Reply — Schnitt 3 (Vault-Feedback-Loop) — Design / Spec

**Datum:** 2026-07-02
**Baut auf:** Schnitt 1 + 2 (in main). Draft-Service liest Voice + Objektfakten live aus `VAULT_PATH`.

## Ziel
Gefällt ein generierter Entwurf nicht, gibt der Operator im Thread Feedback → ein LLM formuliert daraus einen konkreten **Vault-Vorschlag** (welche Datei, welche Überschrift, welcher Zusatztext, warum) → der Operator gibt frei → die Ergänzung wird in die Vault-Datei geschrieben **und committet** → der nächste Entwurf zieht das aktualisierte Wissen. **Freigabe ist das Kuratierungs-Gate; nie Auto-Schreiben ohne OK.**

## Entschiedene Optionen (Brainstorming)
- **Automatisierung: B** — LLM schlägt konkreten Vault-Edit vor, Mensch gibt frei.
- **Vault-Write: direkt nach Freigabe in den Vault** (App schreibt + committet). Der Server-Vault wird damit **read-write** (kehrt die frühere read-only-Annahme bewusst um; die meisten Änderungen laufen künftig auf dem Server). **Push/Propagation** (Server↔Remote↔Laptop) ist bewusst Folgeschritt — der Loop schließt sich schon ohne Push, weil der Draft-Service die Datei live liest.
- **MVP-Grenze:** nur **Ergänzungen** (Text unter eine bestehende Überschrift anhängen). Echtes *Ersetzen* falscher Fakten ist Folgeschritt.

## Architektur / Komponenten

### 1. DB (Migration `020_add_feedback_and_suggestions.sql`)
```sql
CREATE TABLE draft_feedback (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  draft_id TEXT,                         -- der beanstandete Draft (kann später weg sein)
  category TEXT NOT NULL,                -- 'ton' | 'fakt' | 'einmalig'
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE vault_suggestions (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL,
  target_file TEXT NOT NULL,             -- vault-relativ, z. B. 'Areas/Hosting/_Voice.md'
  target_heading TEXT NOT NULL,          -- z. B. '## Anti-Pattern'
  addition_text TEXT NOT NULL,           -- der anzuhängende Block (i. d. R. ein Bullet)
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'discarded'
  applied_commit TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  FOREIGN KEY (feedback_id) REFERENCES draft_feedback(id) ON DELETE CASCADE
);
```

### 2. `src/repositories/feedback-repository.ts`
- `createFeedback(f: { id; thread_id; draft_id: string|null; category; note }): void`
- `createSuggestion(s: { id; feedback_id; target_file; target_heading; addition_text; rationale }): void`
- `getSuggestionById(id): VaultSuggestion | null`
- `getPendingSuggestions(): VaultSuggestion[]`
- `markSuggestionApplied(id, commit: string|null): void` (status='approved', applied_at=now, applied_commit)
- `discardSuggestion(id): void` (status='discarded')
- `countPendingSuggestions(): number`
Typen in `src/types/feedback.ts` (`FeedbackCategory = 'ton'|'fakt'|'einmalig'`, `DraftFeedback`, `VaultSuggestion`, `SuggestionStatus`).

### 3. `src/services/suggestion-service.ts`
- `PROPOSE_VAULT_EDIT_TOOL` (`ClaudeToolDefinition`, schema `{ target_heading, addition_text, rationale }`).
- `generateSuggestion(input: { category: 'ton'|'fakt'; note: string; draftBody: string; fileContent: string }, deps?): Promise<{ target_heading; addition_text; rationale } | null>`
  - System-Prompt: „Formuliere aus dem Feedback eine minimale, kuratierte Ergänzung für die folgende Vault-Datei. Wähle eine passende, **bereits existierende** Überschrift aus der Datei. Gib nur den anzuhängenden Text (i. d. R. ein Bullet), keine Umschreibung der ganzen Datei. Nichts erfinden."
  - `userMessage`: Feedback-Notiz + der beanstandete Entwurf + der aktuelle Dateiinhalt.
  - `callClaudeTool` (Sonnet 4.6, injizierbar via `deps.call`). `null` bei leerem Ergebnis.
  - **`target_file` bestimmt NICHT das LLM**, sondern die Kategorie (Ton→`_Voice.md`, Fakt→Objekt-Notiz) — Sicherheit.

### 4. `src/services/vault-writer.ts`
- `applySuggestion(s: VaultSuggestion, deps?): { committed: boolean; commit: string | null; error?: string }`
- Pfad-Sicherheit: `target_file` muss unter `Areas/Hosting/` liegen und auf `.md` enden (Regex, kein `..`); sonst Fehler, kein Schreiben.
- **Anhängen:** Datei unter `VAULT_PATH` lesen; die Zeile `target_heading` finden; `addition_text` am **Ende des zugehörigen Abschnitts** einfügen (vor der nächsten `## `-Überschrift oder EOF). Überschrift nicht gefunden → `addition_text` (mit Überschrift) an EOF anhängen. Datei schreiben.
- **Commit:** `git -C <VAULT_PATH> add <target_file>` + `git -C <VAULT_PATH> commit -m "Voice/Fakt-Update via Feedback-Loop: <kurz>"`. Git-Runner injizierbar (`deps.git`) → Tests gegen ein Temp-git-Repo. Kein `push`.
- Feature-gated: kein `VAULT_PATH` / kein git-Repo → `{ committed:false, error }`, Datei-Write wird trotzdem versucht (Loop funktioniert auch ohne Commit); Fehler wird sauber zurückgegeben.

### 5. Feedback erfassen (Thread-UI + Route, `messages.ts`)
- In der Thread-Ansicht (bei vorhandenem Entwurf) ein aufklappbares „Passt nicht?"-Formular: `category` (Ton/Fakt/Einmalig) + `note` (Textfeld) → `POST /admin/messages/:threadId/feedback`.
- Route: Thread laden; aktiven Draft für `draft_id` + `draftBody` holen; `createFeedback`. Wenn `category !== 'einmalig'` **und** VAULT_PATH lesbar:
  - Ton → `fileContent = loadVoice()`, `target_file='Areas/Hosting/_Voice.md'`.
  - Fakt → Property via `getPropertyByHostexId(thread.listing_id)`; `fileContent = loadPropertyFacts(vaultNote)`, `target_file='Areas/Hosting/Properties/'+vaultNote`.
  - `generateSuggestion(...)` → bei Ergebnis `createSuggestion(...)`.
- Redirect nach `/admin/suggestions` (damit man den Vorschlag gleich sieht) bzw. zurück zum Thread bei „Einmalig".

### 6. Vorschläge prüfen (`src/routes/suggestions.ts`, gemountet an `/admin/suggestions` vor `/admin`)
- `GET /` → offene Vorschläge: Zieldatei, Überschrift, Diff-Vorschau (der `addition_text`), Begründung + Formulare.
- `POST /:id/approve` → `applySuggestion` → `markSuggestionApplied(id, commit)`; bei Writer-Fehler 502 + Meldung.
- `POST /:id/discard` → `discardSuggestion`.
- Escaping wie in messages.ts (`esc`). Layout via `renderAdminPage`.
- Nav: Link „🧠 Vault-Vorschläge" (mit Pending-Count) in der Messages-Liste und/oder Admin-Nav.

## Datenfluss
```
Thread → „Passt nicht" (Ton/Fakt/Einmalig + Notiz)
  → createFeedback
  → (Ton/Fakt) generateSuggestion(fileContent + note + draftBody) → createSuggestion(pending)
Operator → /admin/suggestions → Freigeben
  → applySuggestion: append unter Überschrift in Vault-Datei + git commit
  → markSuggestionApplied
Nächster Draft (regenerate/sync) → loadVoice/loadPropertyFacts liest die aktualisierte Datei
```

## Fehlerbehandlung
- Kein VAULT_PATH / Datei fehlt → keine Vorschlags-Generierung (geloggt); Feedback wird trotzdem erfasst.
- LLM leer/Fehler → kein Vorschlag (Feedback bleibt erfasst).
- Writer: unsicherer Pfad → Abbruch ohne Schreiben; git nicht verfügbar → Datei geschrieben, `committed:false` + Fehlermeldung (Operator sieht’s).

## Tests
- `feedback-repository`: create/read Feedback + Suggestion, pending-Liste, apply/discard-Statusübergänge, count (in-memory DB).
- `suggestion-service`: gemockter Claude-Caller → Prompt enthält Notiz + Draft + Dateiinhalt; Rückgabe = Vorschlag; `null` bei leer. Kein echter API-Call.
- `vault-writer`: gegen ein **Temp-git-Repo** — append unter existierende Überschrift (Position korrekt), Überschrift-fehlt→EOF, Pfad-Traversal→Abbruch, Commit entsteht (injizierter/echter git-Runner). 
- Migration 020 smoke.
- Routen (Feedback, Suggestions): manuell/curl (kein supertest) — 302/Erreichbarkeit; Escaping durch Lesen geprüft.

## Scope / YAGNI (bewusst NICHT in Schnitt 3)
- Fakt-*Ersetzen*/Korrigieren (nur Anhängen).
- Auto-`git push` / Remote-Propagation / `git pull`-Konflikt-Handling.
- Feedback-Analytics, mehrere Vorschläge pro Feedback, Bearbeiten des Vorschlags vor Freigabe.
- Corrected-draft-Text als Feedback-Signal (nur Kategorie + Notiz).

## Offene Punkte / Voraussetzungen
- Server-Vault muss ein **schreibbares git-Repo** unter `VAULT_PATH` sein (git user.name/email gesetzt).
- Push/Propagation der Vault-Commits = eigener Folgeschritt (Schnitt 3.5).
- Prompt-Qualität der Vorschläge wird am ersten echten Fall (Bootshaus) beurteilt und iteriert.
