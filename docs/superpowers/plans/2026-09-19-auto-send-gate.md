# Auto-Send-Gate + Push für wartende Entwürfe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gästeantworten, die ein dreischichtiges Gate als sicher einstuft, automatisch senden (nach Schattenphase); alle anderen Entwürfe per Agent-API als „wartet auf Micha" ausweisen und von labs aus per WhatsApp pushen — Antwortfenster max. 20 Minuten.

**Architecture:** Neuer 5-Minuten-Nachrichten-Loop (beide Provider) plus Guesty-Webhook stoßen die bestehende Entwurfs-Kette an. Nach jedem LLM-Entwurf läuft das Gate: Prüfmodell (Opus 5, eigener Prompt) → mechanische Regex-Checks → Policy (Modus, Tageslimit, Pause, Thread-Ausschlüsse). Entscheidung wird am Entwurf persistiert, Ampel im Admin-UI, Agent-API-Endpunkt für wartende Entwürfe; ein Shell-Watcher auf labs (User claude, systemd-Timer alle 2 min) pusht via `tools/push-micha-wa.sh`.

**Tech Stack:** Node 24 / TypeScript / Express / better-sqlite3 / vitest / Anthropic SDK (`callClaudeTool`) / systemd-User-Timer + bash auf labs.

**Spec:** `docs/superpowers/specs/2026-09-19-auto-send-gate-design.md` (App-Repo). Der Plan argumentiert aus der Spec; bei Widerspruch gilt die Spec, Abweichungen sind unten als „Abweichung" markiert.

## Global Constraints

- Sprache in Code-Kommentaren, Logs, UI-Texten, Commit-Messages: **Deutsch** (Bestandsstil des Repos; englische Identifier ok).
- Jeder Anthropic-Aufruf über `callClaudeTool` (setzt `thinking: { type: 'disabled' }`; nie umgehen).
- Prüfmodell-ID: `claude-opus-5` (Env `JUDGE_MODEL`, Default). Entwurfsmodell bleibt `claude-sonnet-5`.
- Kategorie-Whitelist für Auto-Send: **nur** `dank_smalltalk`, `ankunftszeit`, `playbook_fakt` (mit `answerableFromFacts === true`), `checkin_standard`.
- Default-Modus `AUTO_SEND_MODE=off`; effektiver Modus = restriktiverer Wert aus Env und `properties.json` (`off` < `shadow` < `live`).
- Tageslimit `AUTO_SEND_DAILY_CAP=10`, Kalendertag Europe/Berlin.
- Push-Text enthält NIE Codes, Gast-Kontaktdaten oder Links außer der Admin-URL.
- `raw/` und Deploy-Repos in TheBrain2 nie anfassen; Wiki-Nachzug nur in Task 15.
- Tests: `npm test -- --run` muss vor jedem Commit grün sein (Stand vor diesem Plan: alle grün).
- Commits im App-Repo auf Branch `feat/auto-send-gate`, Merge in `main` nach Task 14; TheBrain2-Änderungen direkt auf `main` (post-commit-Hook pusht).
- **Abweichung 1 (DRY):** Pausen-Schalter nutzt die vorhandene Tabelle `scheduler_state` (Key `auto_send_paused`) statt einer neuen `app_settings`-Tabelle.
- **Abweichung 2 (DRY):** Die Kette „Entwurf → Gate" lebt in `generate-drafts.ts` (optionaler Thread-Filter) statt in einer neuen Datei `process-thread-for-reply.ts`.
- **Abweichung 3:** Pausen-Schalter liegt auf der Auswertungsseite `/admin/messages/auto-send` (nicht `/admin/system`).

---

## File Map

**guesty-calendar-app (neu)**
- `src/db/migrations/027_add_auto_send.sql` — Spalten an `message_drafts`, Indizes.
- `src/services/auto-send/types.ts` — gemeinsame Typen (Modus, Kategorien, Flags, Verdict, Decision).
- `src/services/auto-send/berlin-day.ts` — `startOfBerlinDayIso()`.
- `src/services/auto-send/mode.ts` — `resolveAutoSendMode()`.
- `src/services/auto-send/mechanical-checks.ts` — reine Regex-Checks.
- `src/services/auto-send/judge-prompt.ts` — Prompt + Tool-Definition des Prüfmodells.
- `src/services/auto-send/judge-service.ts` — Aufruf + Parsen → `JudgeResult`.
- `src/services/auto-send/policy.ts` — `decide()`.
- `src/services/auto-send/runner.ts` — Orchestrierung `runAutoSendGate()`.
- `src/services/draft-send-service.ts` — `sendClaimedDraft()` (aus `routes/messages.ts` extrahiert).
- `src/services/guesty-webhook-signature.ts` — Svix-Verifikation.
- `src/routes/webhooks-guesty.ts` — Webhook-Route.
- `src/jobs/handle-guesty-inbound.ts` — Webhook → Sync einer Konversation → Kette.
- `src/jobs/message-loop.ts` — 5-min-Loop + Lock.
- `src/scripts/register-guesty-webhook.ts` — Registrierung.
- `src/scripts/test-judge-fixtures.ts` + `src/test-fixtures/judge/cases.json` — Live-Regressionslauf.

**guesty-calendar-app (geändert)**
- `src/types/messages.ts`, `src/repositories/draft-repository.ts`, `src/config/index.ts`, `src/config/properties.ts`, `src/jobs/generate-drafts.ts`, `src/jobs/etl-job.ts`, `src/jobs/scheduler.ts`, `src/jobs/sync-guesty-messages.ts`, `src/services/guesty-client.ts`, `src/routes/messages.ts`, `src/routes/agent-api.ts`, `src/routes/admin-layout.ts`, `src/app.ts`, `package.json`, `.env.example`, `CLAUDE.md`.

**TheBrain2**
- `tools/labs/draft-push.sh`, `tools/labs/units/claude-draft-push.{service,timer}`, `tools/labs/install.sh`, `tools/labs/README.md`, `tools/labs/defaults.env`, `.claude/skills/standup/SKILL.md`, `.claude/skills/eingang/SKILL.md`, Wiki-Seiten (Task 15).

---

### Task 0: Branch anlegen

- [ ] **Step 1:** `cd ~/Development/guesty-calendar-app && git checkout -b feat/auto-send-gate && npm test -- --run` → alle Tests grün (Ausgangsbasis).

---

### Task 1: Migration 027 + Typen + Draft-Repository

**Files:**
- Create: `src/db/migrations/027_add_auto_send.sql`
- Create: `src/services/auto-send/types.ts`
- Modify: `src/types/messages.ts` (Interface `MessageDraft`)
- Modify: `src/repositories/draft-repository.ts`
- Test: `src/repositories/draft-repository.auto-send.test.ts`

**Interfaces:**
- Produces: Typen aus `types.ts` (unten), Repository-Funktionen `setAutoDecision`, `markDraftSent(id, externalId, sentBy)`, `setSentBodyChanged`, `threadHasHumanIntervention`, `countAutoSentSince`, `getAwaitingDrafts`, `getAutoSendStats`, `listAutoDecisions`.

- [ ] **Step 1: Migration schreiben**

```sql
-- src/db/migrations/027_add_auto_send.sql
-- Auto-Send-Gate (Spec docs/superpowers/specs/2026-09-19-auto-send-gate-design.md):
-- Entscheidung + Begründung des Gates je Entwurf, wer gesendet hat, und ob Micha
-- den Text vor dem Senden geändert hat (Schatten-Auswertung).
ALTER TABLE message_drafts ADD COLUMN auto_decision TEXT;        -- 'auto' | 'wait' | NULL
ALTER TABLE message_drafts ADD COLUMN auto_category TEXT;
ALTER TABLE message_drafts ADD COLUMN auto_flags TEXT;           -- JSON-Array
ALTER TABLE message_drafts ADD COLUMN auto_reason TEXT;
ALTER TABLE message_drafts ADD COLUMN auto_mode TEXT;            -- 'off' | 'shadow' | 'live'
ALTER TABLE message_drafts ADD COLUMN auto_judged_at TEXT;
ALTER TABLE message_drafts ADD COLUMN sent_by TEXT;              -- 'micha' | 'auto'
ALTER TABLE message_drafts ADD COLUMN sent_body_changed INTEGER; -- 1 = vor dem Senden geändert

CREATE INDEX idx_message_drafts_auto ON message_drafts(auto_decision, created_at);
CREATE INDEX idx_message_drafts_sent_by ON message_drafts(sent_by, sent_at);
```

- [ ] **Step 2: Typen anlegen**

```ts
// src/services/auto-send/types.ts
export type AutoSendMode = 'off' | 'shadow' | 'live';
export const AUTO_SEND_MODES: AutoSendMode[] = ['off', 'shadow', 'live'];

export type JudgeCategory =
  | 'dank_smalltalk' | 'ankunftszeit' | 'playbook_fakt' | 'checkin_standard'
  | 'geld' | 'storno_datum' | 'beschwerde_schaden' | 'sonderwunsch' | 'medizin_sicherheit' | 'unklar';
export const JUDGE_CATEGORIES: JudgeCategory[] = [
  'dank_smalltalk', 'ankunftszeit', 'playbook_fakt', 'checkin_standard',
  'geld', 'storno_datum', 'beschwerde_schaden', 'sonderwunsch', 'medizin_sicherheit', 'unklar',
];
/** Nur diese Kategorien dürfen automatisch raus (Spec 5.3). */
export const AUTO_OK_CATEGORIES: ReadonlySet<JudgeCategory> = new Set([
  'dank_smalltalk', 'ankunftszeit', 'playbook_fakt', 'checkin_standard',
]);

export type JudgeRiskFlag =
  | 'invents_fact' | 'promises_action' | 'mentions_code' | 'contradicts_facts'
  | 'tone_off' | 'language_mismatch' | 'multi_topic';
export const JUDGE_RISK_FLAGS: JudgeRiskFlag[] = [
  'invents_fact', 'promises_action', 'mentions_code', 'contradicts_facts',
  'tone_off', 'language_mismatch', 'multi_topic',
];
export type JudgeConfidence = 'hoch' | 'mittel' | 'niedrig';

export interface JudgeVerdict {
  category: JudgeCategory;
  answerableFromFacts: boolean;
  riskFlags: JudgeRiskFlag[];
  confidence: JudgeConfidence;
  reasoning: string;
}
export type JudgeResult =
  | { kind: 'verdict'; verdict: JudgeVerdict }
  | { kind: 'failed'; error: string };

export type MechanicalFlag = 'digits' | 'url' | 'email' | 'money' | 'phone' | 'code_words' | 'length' | 'empty';
export interface MechanicalFinding { flag: MechanicalFlag; match: string }

export interface AutoSendDecision {
  decision: 'auto' | 'wait';
  reason: string;               // deutscher Satz für die Ampel
  category: JudgeCategory | null;
  flags: string[];              // Modell-Flags + mechanische Flags, z. B. 'mech:url'
}
```

- [ ] **Step 3: `MessageDraft` erweitern** — in `src/types/messages.ts` nach `model: string | null;` einfügen:

```ts
  // Auto-Send-Gate (Migration 027)
  auto_decision: 'auto' | 'wait' | null;
  auto_category: string | null;
  auto_flags: string | null;      // JSON-Array
  auto_reason: string | null;
  auto_mode: 'off' | 'shadow' | 'live' | null;
  auto_judged_at: string | null;
  sent_by: 'micha' | 'auto' | null;
  sent_body_changed: number | null;
```

- [ ] **Step 4: Failing Tests schreiben**

```ts
// src/repositories/draft-repository.auto-send.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createDraft, setAutoDecision, markDraftSent, setSentBodyChanged, threadHasHumanIntervention,
  countAutoSentSince, getAwaitingDrafts, getAutoSendStats, listAutoDecisions, getDraftById,
} from './draft-repository.js';

let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

function seedThread(id: string, guest = 'Anna', manually = 0) {
  db.prepare(`INSERT INTO message_threads (id, listing_id, source, channel, guest_name, first_message_at, last_message_at, message_count, manually_categorized, last_synced_at)
    VALUES (?, 'L1', 'hostex', 'airbnb', ?, '2026-09-19T10:00:00Z', '2026-09-19T10:00:00Z', 1, ?, '2026-09-19T10:00:00Z')`).run(id, guest, manually);
  db.prepare(`INSERT INTO messages (id, thread_id, direction, sent_at, body, source) VALUES (?, ?, 'inbound', '2026-09-19T10:00:00Z', 'Können wir um 13 Uhr kommen? Danke!', 'hostex')`).run(`${id}:m1`, id);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(mig('014_add_messages_threads.sql'));
  db.exec(mig('015_add_manual_category.sql'));
  db.exec(mig('018_add_message_drafts.sql'));
  db.exec(mig('019_add_draft_model.sql'));
  db.exec(mig('020_add_feedback_and_suggestions.sql'));
  db.exec(mig('025_add_thread_discarded_at.sql'));
  db.exec(mig('027_add_auto_send.sql'));
  setDatabase(db);
  seedThread('hostex:t1');
});
afterEach(() => { resetDatabase(); db.close(); });

describe('setAutoDecision / markDraftSent', () => {
  it('persistiert Entscheidung, Flags als JSON und sent_by', () => {
    createDraft({ id: 'd1', thread_id: 'hostex:t1', provider: 'hostex', body: 'Hallo', generated_by: 'llm' });
    setAutoDecision('d1', { decision: 'wait', reason: 'Kategorie Sonderwunsch — nie automatisch', category: 'sonderwunsch', flags: ['mech:url'] }, 'shadow');
    markDraftSent('d1', 'ext-1', 'auto');
    const d = getDraftById('d1')!;
    expect(d.auto_decision).toBe('wait');
    expect(JSON.parse(d.auto_flags!)).toEqual(['mech:url']);
    expect(d.auto_mode).toBe('shadow');
    expect(d.auto_judged_at).toBeTruthy();
    expect(d.sent_by).toBe('auto');
  });
  it('markDraftSent ohne sentBy → micha', () => {
    createDraft({ id: 'd2', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    markDraftSent('d2', null);
    setSentBodyChanged('d2', true);
    const d = getDraftById('d2')!;
    expect(d.sent_by).toBe('micha');
    expect(d.sent_body_changed).toBe(1);
  });
});

describe('threadHasHumanIntervention', () => {
  it('false ohne Verwerfen/Feedback/manuelle Kategorie', () => {
    expect(threadHasHumanIntervention('hostex:t1')).toBe(false);
  });
  it('true bei verworfenem Draft', () => {
    createDraft({ id: 'd3', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='discarded' WHERE id='d3'`).run();
    expect(threadHasHumanIntervention('hostex:t1')).toBe(true);
  });
  it('true bei Feedback-Zeile', () => {
    db.prepare(`INSERT INTO draft_feedback (id, thread_id, category, note) VALUES ('f1','hostex:t1','fakt','x')`).run();
    expect(threadHasHumanIntervention('hostex:t1')).toBe(true);
  });
  it('true bei manueller Kategorie', () => {
    seedThread('hostex:t2', 'Ben', 1);
    expect(threadHasHumanIntervention('hostex:t2')).toBe(true);
  });
});

describe('countAutoSentSince / getAwaitingDrafts / stats', () => {
  it('zählt nur sent_by=auto ab Zeitpunkt', () => {
    for (const [id, by, at] of [['a1', 'auto', '2026-09-19 08:00:00'], ['a2', 'auto', '2026-09-18 23:00:00'], ['a3', 'micha', '2026-09-19 09:00:00']] as const) {
      createDraft({ id, thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
      db.prepare(`UPDATE message_drafts SET status='sent', sent_by=?, sent_at=? WHERE id=?`).run(by, at, id);
    }
    expect(countAutoSentSince('2026-09-19T00:00:00.000Z')).toBe(1);
  });
  it('getAwaitingDrafts liefert wait- und error-Drafts nach since, aufsteigend, mit Gast-Auszug', () => {
    createDraft({ id: 'w1', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    setAutoDecision('w1', { decision: 'wait', reason: 'Grund A', category: 'geld', flags: [] }, 'live');
    createDraft({ id: 'e1', thread_id: 'hostex:t1', provider: 'hostex', body: 'y', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='error', error='Kanal', created_at='2026-09-19 12:00:00' WHERE id='e1'`).run();
    createDraft({ id: 'ok1', thread_id: 'hostex:t1', provider: 'hostex', body: 'z', generated_by: 'llm' });
    setAutoDecision('ok1', { decision: 'auto', reason: 'ok', category: 'dank_smalltalk', flags: [] }, 'live');
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    expect(rows.map((r) => r.id).sort()).toEqual(['e1', 'w1']);
    expect(rows[0].guest_name).toBe('Anna');
    expect(rows[0].last_guest_message).toContain('13 Uhr');
    expect(rows.find((r) => r.id === 'e1')!.reason).toContain('Auto-Send fehlgeschlagen');
  });
  it('getAutoSendStats zählt Schattenfälle unverändert/geändert', () => {
    createDraft({ id: 's1', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    setAutoDecision('s1', { decision: 'auto', reason: 'ok', category: 'dank_smalltalk', flags: [] }, 'shadow');
    markDraftSent('s1', null, 'micha'); setSentBodyChanged('s1', false);
    createDraft({ id: 's2', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    setAutoDecision('s2', { decision: 'auto', reason: 'ok', category: 'dank_smalltalk', flags: [] }, 'shadow');
    markDraftSent('s2', null, 'micha'); setSentBodyChanged('s2', true);
    createDraft({ id: 's3', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    setAutoDecision('s3', { decision: 'wait', reason: 'w', category: 'geld', flags: [] }, 'shadow');
    const s = getAutoSendStats('2026-01-01T00:00:00.000Z');
    expect(s).toEqual({ autoSent: 0, waited: 1, shadowWouldAuto: 2, shadowUnchanged: 1, shadowChanged: 1, shadowDiscarded: 0 });
    expect(listAutoDecisions(10).length).toBe(3);
  });
});
```

- [ ] **Step 5: Test laufen lassen** — `npx vitest run src/repositories/draft-repository.auto-send.test.ts` → FAIL („setAutoDecision is not exported" o. ä.).

- [ ] **Step 6: Repository erweitern** — in `src/repositories/draft-repository.ts`:

```ts
import type { AutoSendDecision, AutoSendMode } from '../services/auto-send/types.js';

export function setAutoDecision(id: string, d: AutoSendDecision, mode: AutoSendMode): void {
  getDatabase().prepare(
    `UPDATE message_drafts SET auto_decision = ?, auto_category = ?, auto_flags = ?, auto_reason = ?,
       auto_mode = ?, auto_judged_at = datetime('now') WHERE id = ?`,
  ).run(d.decision, d.category, JSON.stringify(d.flags), d.reason, mode, id);
}

// Signatur erweitert: dritter Parameter (Default 'micha') — bestehende Aufrufer bleiben gültig.
export function markDraftSent(id: string, externalMessageId: string | null, sentBy: 'micha' | 'auto' = 'micha'): void {
  getDatabase().prepare(
    `UPDATE message_drafts
     SET status = 'sent', external_message_id = ?, sent_at = datetime('now'), error = NULL, sent_by = ?
     WHERE id = ?`,
  ).run(externalMessageId, sentBy, id);
}

export function setSentBodyChanged(id: string, changed: boolean): void {
  getDatabase().prepare(`UPDATE message_drafts SET sent_body_changed = ? WHERE id = ?`).run(changed ? 1 : 0, id);
}

/** Micha hat in diesem Thread schon eingegriffen (Spec 5.3 Thread-Ausschlüsse). */
export function threadHasHumanIntervention(threadId: string): boolean {
  const row = getDatabase().prepare(
    `SELECT (
        EXISTS (SELECT 1 FROM message_drafts WHERE thread_id = @t AND status = 'discarded')
     OR EXISTS (SELECT 1 FROM draft_feedback WHERE thread_id = @t)
     OR EXISTS (SELECT 1 FROM message_threads WHERE id = @t AND manually_categorized = 1)
    ) AS hit`,
  ).get({ t: threadId }) as { hit: number };
  return row.hit === 1;
}

export function countAutoSentSince(sinceIso: string): number {
  const row = getDatabase().prepare(
    `SELECT COUNT(*) AS n FROM message_drafts WHERE sent_by = 'auto' AND datetime(sent_at) >= datetime(?)`,
  ).get(sinceIso) as { n: number };
  return row.n;
}

export interface AwaitingDraftRow {
  id: string; thread_id: string; provider: string; status: string; created_at: string;
  reason: string; guest_name: string | null; listing_id: string; source: string;
  last_guest_message: string | null;
}

/** Entwürfe, die auf Micha warten: Gate-Entscheidung 'wait' (noch pending) oder Send-Fehler. */
export function getAwaitingDrafts(sinceIso: string, limit: number): AwaitingDraftRow[] {
  return getDatabase().prepare(
    `SELECT d.id, d.thread_id, d.provider, d.status, d.created_at,
       CASE WHEN d.status = 'error' THEN 'Auto-Send fehlgeschlagen: ' || COALESCE(d.error, '?') ELSE COALESCE(d.auto_reason, '') END AS reason,
       t.guest_name, t.listing_id, t.source,
       (SELECT m.body FROM messages m WHERE m.thread_id = t.id AND m.direction = 'inbound'
          ORDER BY m.sent_at DESC, m.created_at DESC LIMIT 1) AS last_guest_message
     FROM message_drafts d JOIN message_threads t ON t.id = d.thread_id
     WHERE datetime(d.created_at) > datetime(?)
       AND ((d.auto_decision = 'wait' AND d.status = 'pending') OR d.status = 'error')
     ORDER BY d.created_at ASC LIMIT ?`,
  ).all(sinceIso, limit) as AwaitingDraftRow[];
}

export interface AutoSendStats {
  autoSent: number; waited: number; shadowWouldAuto: number;
  shadowUnchanged: number; shadowChanged: number; shadowDiscarded: number;
}
export function getAutoSendStats(sinceIso: string): AutoSendStats {
  return getDatabase().prepare(
    `SELECT
       SUM(sent_by = 'auto') AS autoSent,
       SUM(auto_decision = 'wait') AS waited,
       SUM(auto_decision = 'auto' AND auto_mode = 'shadow') AS shadowWouldAuto,
       SUM(auto_decision = 'auto' AND auto_mode = 'shadow' AND status = 'sent' AND sent_body_changed = 0) AS shadowUnchanged,
       SUM(auto_decision = 'auto' AND auto_mode = 'shadow' AND status = 'sent' AND sent_body_changed = 1) AS shadowChanged,
       SUM(auto_decision = 'auto' AND auto_mode = 'shadow' AND status = 'discarded') AS shadowDiscarded
     FROM message_drafts WHERE datetime(created_at) >= datetime(?)`,
  ).get(sinceIso) as AutoSendStats;
}

export function listAutoDecisions(limit: number): Array<MessageDraft & { guest_name: string | null }> {
  return getDatabase().prepare(
    `SELECT d.*, t.guest_name FROM message_drafts d JOIN message_threads t ON t.id = d.thread_id
     WHERE d.auto_decision IS NOT NULL ORDER BY d.created_at DESC LIMIT ?`,
  ).all(limit) as Array<MessageDraft & { guest_name: string | null }>;
}
```

Hinweis: `SUM(bool)` liefert in SQLite `NULL` bei null Zeilen — im Test sind Zeilen vorhanden; in der Route (Task 12) `?? 0` je Feld anwenden.

- [ ] **Step 7:** `npx vitest run src/repositories/draft-repository.auto-send.test.ts` → PASS. Danach `npm test -- --run` → alles grün (bestehende `markDraftSent`-Aufrufer unverändert).

- [ ] **Step 8: Commit**

```bash
git add src/db/migrations/027_add_auto_send.sql src/services/auto-send/types.ts src/types/messages.ts src/repositories/draft-repository.ts src/repositories/draft-repository.auto-send.test.ts
git commit -m "feat(auto-send): Migration 027, Typen und Draft-Repository für das Gate"
```

---

### Task 2: Konfiguration + Modus-Auflösung + Berlin-Tagesanfang

**Files:**
- Modify: `src/config/index.ts` (Schema + rawConfig)
- Modify: `src/config/properties.ts` (`PropertyConfig.autoSend`, Zod-Schema)
- Create: `src/services/auto-send/mode.ts`, `src/services/auto-send/berlin-day.ts`
- Test: `src/services/auto-send/mode.test.ts`, `src/services/auto-send/berlin-day.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `config.autoSendMode: AutoSendMode`, `config.autoSendDailyCap: number`, `config.messageLoopMinutes: number`, `config.guestyWebhookSecret?: string`, `config.judgeModel: string`; `resolveAutoSendMode(envMode, propertyMode?)`; `startOfBerlinDayIso(now?)`.

- [ ] **Step 1: Failing Tests**

```ts
// src/services/auto-send/mode.test.ts
import { describe, it, expect } from 'vitest';
import { resolveAutoSendMode } from './mode.js';

describe('resolveAutoSendMode', () => {
  it('nimmt den restriktiveren Wert', () => {
    expect(resolveAutoSendMode('live', 'shadow')).toBe('shadow');
    expect(resolveAutoSendMode('shadow', 'live')).toBe('shadow');
    expect(resolveAutoSendMode('off', 'live')).toBe('off');
    expect(resolveAutoSendMode('live', 'off')).toBe('off');
  });
  it('ohne Property-Wert gilt der Env-Wert', () => {
    expect(resolveAutoSendMode('live', undefined)).toBe('live');
  });
});
```

```ts
// src/services/auto-send/berlin-day.test.ts
import { describe, it, expect } from 'vitest';
import { startOfBerlinDayIso } from './berlin-day.js';

describe('startOfBerlinDayIso', () => {
  it('Sommerzeit: 00:00 Berlin = 22:00Z Vortag', () => {
    expect(startOfBerlinDayIso(new Date('2026-09-19T10:30:00.000Z'))).toBe('2026-09-18T22:00:00.000Z');
  });
  it('Winterzeit: 00:00 Berlin = 23:00Z Vortag', () => {
    expect(startOfBerlinDayIso(new Date('2026-12-05T10:30:00.000Z'))).toBe('2026-12-04T23:00:00.000Z');
  });
  it('kurz vor Mitternacht UTC gehört schon zum nächsten Berliner Tag', () => {
    expect(startOfBerlinDayIso(new Date('2026-09-19T22:30:00.000Z'))).toBe('2026-09-19T22:00:00.000Z');
  });
});
```

- [ ] **Step 2:** `npx vitest run src/services/auto-send` → FAIL (Module fehlen).

- [ ] **Step 3: Implementieren**

```ts
// src/services/auto-send/mode.ts
import { AUTO_SEND_MODES, type AutoSendMode } from './types.js';

/** Effektiver Modus = restriktiverer Wert aus Env und properties.json (off < shadow < live). */
export function resolveAutoSendMode(envMode: AutoSendMode, propertyMode: AutoSendMode | undefined): AutoSendMode {
  if (!propertyMode) return envMode;
  const rank = (m: AutoSendMode) => AUTO_SEND_MODES.indexOf(m);
  return rank(propertyMode) < rank(envMode) ? propertyMode : envMode;
}
```

```ts
// src/services/auto-send/berlin-day.ts
/** ISO-Zeitpunkt (UTC) des Kalendertag-Beginns in Europe/Berlin für `now` (Tageslimit, Spec 5.3). */
export function startOfBerlinDayIso(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const wallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  const offsetMs = Math.round((wallAsUtc - now.getTime()) / 60000) * 60000; // Berlin-Offset (+1h/+2h)
  const dayStartWallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day);
  return new Date(dayStartWallAsUtc - offsetMs).toISOString();
}
```

In `src/config/index.ts` im `configSchema` (nach `anthropicApiKey`):

```ts
  // Auto-Send-Gate (Spec 2026-09-19)
  autoSendMode: z.enum(['off', 'shadow', 'live']).default('off'),
  autoSendDailyCap: z.coerce.number().int().min(0).default(10),
  messageLoopMinutes: z.coerce.number().int().min(1).default(5),
  guestyWebhookSecret: z.string().optional(),
  judgeModel: z.string().default('claude-opus-5'),
```

und in `rawConfig`:

```ts
    autoSendMode: process.env.AUTO_SEND_MODE,
    autoSendDailyCap: process.env.AUTO_SEND_DAILY_CAP,
    messageLoopMinutes: process.env.MESSAGE_LOOP_MINUTES,
    guestyWebhookSecret: process.env.GUESTY_WEBHOOK_SECRET,
    judgeModel: process.env.JUDGE_MODEL,
```

In `src/config/properties.ts`: Interface `PropertyConfig` um `autoSend?: 'off' | 'shadow' | 'live';` ergänzen (Kommentar: „Auto-Send-Modus dieses Objekts; effektiv gilt der restriktivere Wert gegenüber AUTO_SEND_MODE"), und im Zod-Property-Schema `autoSend: z.enum(['off', 'shadow', 'live']).optional(),` an derselben Stelle wie `vaultNote`.

`.env.example` ergänzen:

```
# Auto-Send-Gate (docs/superpowers/specs/2026-09-19-auto-send-gate-design.md)
# off = wie bisher · shadow = Entscheidung nur protokollieren · live = sichere Entwürfe automatisch senden
AUTO_SEND_MODE=off
AUTO_SEND_DAILY_CAP=10
MESSAGE_LOOP_MINUTES=5
JUDGE_MODEL=claude-opus-5
# Svix-Secret des Guesty-Webhooks (npm run webhook:register gibt es aus)
GUESTY_WEBHOOK_SECRET=
```

- [ ] **Step 4:** `npx vitest run src/services/auto-send` → PASS; `npm test -- --run` grün.
- [ ] **Step 5: Commit** — `git add -A src/config src/services/auto-send .env.example && git commit -m "feat(auto-send): Konfiguration, Modus-Auflösung, Berliner Tagesanfang"`

---

### Task 3: Mechanische Checks

**Files:**
- Create: `src/services/auto-send/mechanical-checks.ts`
- Test: `src/services/auto-send/mechanical-checks.test.ts`

**Interfaces:**
- Produces: `runMechanicalChecks(body: string, context: { knownDigitRuns: string[] }): MechanicalFinding[]` und `collectDigitRuns(texts: string[]): string[]`.

- [ ] **Step 1: Failing Tests**

```ts
// src/services/auto-send/mechanical-checks.test.ts
import { describe, it, expect } from 'vitest';
import { runMechanicalChecks, collectDigitRuns } from './mechanical-checks.js';

const flags = (body: string, known: string[] = []) => runMechanicalChecks(body, { knownDigitRuns: known }).map((f) => f.flag);

describe('runMechanicalChecks', () => {
  it('leer → empty', () => expect(flags('   ')).toEqual(['empty']));
  it('sauberer Text → keine Flags', () => expect(flags('Hallo Anna, 13 Uhr passt. Bis dann!')).toEqual([]));
  it('Ziffernfolge ≥ 4 ohne Kontext → digits', () => expect(flags('Der Code ist 4711.')).toContain('digits'));
  it('Ziffernfolge aus dem Kontext (Datum/Jahr) ist erlaubt', () => {
    expect(flags('Wir freuen uns auf 2026.', ['2026'])).not.toContain('digits');
    expect(flags('Bis zum 19.09.2026!', ['2026'])).not.toContain('digits');
  });
  it('URL → url', () => {
    expect(flags('Siehe https://farmhouse-prasser.de')).toContain('url');
    expect(flags('Siehe www.beispiel.de')).toContain('url');
  });
  it('E-Mail → email', () => expect(flags('Schreib an mic@beispiel.de')).toContain('email'));
  it('Geldbetrag → money', () => {
    expect(flags('Das kostet 120 €.')).toContain('money');
    expect(flags('Preis 120,00 pro Nacht')).toContain('money');
    expect(flags('Das sind 30 EUR extra')).toContain('money');
  });
  it('Telefonnummer → phone', () => {
    expect(flags('Ruf an: +49 160 1234567')).toContain('phone');
    expect(flags('Tel 0160/123 45 67')).toContain('phone');
  });
  it('Code-Wort mit Ziffer im selben Satz → code_words', () => {
    expect(flags('Der Tresor öffnet mit 12 34.')).toContain('code_words');
    expect(flags('Die PIN lautet 9.')).toContain('code_words');
    expect(flags('Der Schlüssel liegt im Tresor.')).not.toContain('code_words');
  });
  it('zu lang → length', () => expect(flags('a'.repeat(1201))).toContain('length'));
  it('liefert Fundstelle', () => {
    const f = runMechanicalChecks('Mail an x@y.de', { knownDigitRuns: [] });
    expect(f).toEqual([{ flag: 'email', match: 'x@y.de' }]);
  });
});

describe('collectDigitRuns', () => {
  it('sammelt Ziffernfolgen ≥ 4 aus Texten', () => {
    expect(collectDigitRuns(['Check-in 19.09.2026', 'Code HM12345678'])).toEqual(['2026', '12345678']);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/services/auto-send/mechanical-checks.test.ts` → FAIL.

- [ ] **Step 3: Implementieren**

```ts
// src/services/auto-send/mechanical-checks.ts
// Modellunabhängige Schicht des Auto-Send-Gates (Spec 5.2): reine String-Regeln, kein I/O.
import type { MechanicalFinding } from './types.js';

export const MAX_DRAFT_LENGTH = 1200;
const DIGIT_RUN = /\d{4,}/g;
const URL = /https?:\/\/\S+|\bwww\.\S+/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const MONEY = /€|\bEUR\b|\bEuro\b|\d+,\d{2}\b/;
const PHONE = /\+\d[\d\s/-]{5,}|\b0\d{2,4}[\s/-]?\d{2,}[\s/-]?\d{2,}(?:[\s/-]?\d{2,})?/;
const CODE_WORDS = /\b(Code|PIN|Tresor|Schlüsselbox|Schloss)\b/i;

export function collectDigitRuns(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(DIGIT_RUN)) out.add(m[0]);
  return [...out];
}

export function runMechanicalChecks(body: string, context: { knownDigitRuns: string[] }): MechanicalFinding[] {
  const f: MechanicalFinding[] = [];
  const text = body ?? '';
  if (!text.trim()) return [{ flag: 'empty', match: '' }];
  if (text.length > MAX_DRAFT_LENGTH) f.push({ flag: 'length', match: `${text.length} Zeichen` });
  const known = new Set(context.knownDigitRuns);
  for (const m of text.matchAll(DIGIT_RUN)) if (!known.has(m[0])) { f.push({ flag: 'digits', match: m[0] }); break; }
  const url = text.match(URL); if (url) f.push({ flag: 'url', match: url[0] });
  const mail = text.match(EMAIL); if (mail) f.push({ flag: 'email', match: mail[0] });
  const money = text.match(MONEY); if (money) f.push({ flag: 'money', match: money[0] });
  const phone = text.match(PHONE); if (phone) f.push({ flag: 'phone', match: phone[0].trim() });
  // Code-Wort + Ziffer im selben Satz
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (CODE_WORDS.test(sentence) && /\d/.test(sentence)) { f.push({ flag: 'code_words', match: sentence.trim().slice(0, 80) }); break; }
  }
  return f;
}
```

- [ ] **Step 4:** Test → PASS. Bei Regex-Fehltreffern (z. B. `phone` auf „13 Uhr") die Regex nachschärfen, bis alle Fälle grün sind; keine Testfälle streichen.
- [ ] **Step 5: Commit** — `git add src/services/auto-send/mechanical-checks* && git commit -m "feat(auto-send): mechanische Checks (Codes, Links, Mail, Geld, Telefon, Länge)"`

---

### Task 4: Prüfmodell — Prompt, Service, Fixtures, Live-Lauf

**Files:**
- Create: `src/services/auto-send/judge-prompt.ts`, `src/services/auto-send/judge-service.ts`
- Create: `src/test-fixtures/judge/cases.json`, `src/scripts/test-judge-fixtures.ts`
- Modify: `package.json` (Script `test:judge`)
- Test: `src/services/auto-send/judge-service.test.ts`

**Interfaces:**
- Produces: `judgeDraft(input: JudgeInput, deps?): Promise<JudgeResult>` mit `JudgeInput = { guestMessages: string[]; draft: string; voice: string; facts: string; bookingContext: string | null; guestName: string | null }`; `JUDGE_DRAFT_TOOL`, `buildJudgeSystemPrompt(voice, facts, bookingContext)`, `buildJudgeUserMessage(input)`.

- [ ] **Step 1: Failing Tests (Parsen)**

```ts
// src/services/auto-send/judge-service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { judgeDraft, buildJudgeUserMessage } from './judge-service.js';

const input = { guestMessages: ['Können wir um 13 Uhr kommen?'], draft: 'Ja, 13 Uhr passt.', voice: 'V', facts: 'F', bookingContext: null, guestName: 'Anna' };

describe('judgeDraft', () => {
  it('parst ein gültiges Urteil', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'ankunftszeit', answerable_from_facts: true, risk_flags: [], confidence: 'hoch', reasoning: 'Standardfrage.' });
    const r = await judgeDraft(input, { call, model: 'm' });
    expect(r).toEqual({ kind: 'verdict', verdict: { category: 'ankunftszeit', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'Standardfrage.' } });
    expect(call.mock.calls[0][0].model).toBe('m');
  });
  it('unbekannte Kategorie → failed', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'quatsch', answerable_from_facts: true, risk_flags: [], confidence: 'hoch', reasoning: 'x' });
    expect((await judgeDraft(input, { call, model: 'm' })).kind).toBe('failed');
  });
  it('unbekanntes Flag wird verworfen, Rest bleibt', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'geld', answerable_from_facts: false, risk_flags: ['promises_action', 'wat'], confidence: 'mittel', reasoning: 'x' });
    const r = await judgeDraft(input, { call, model: 'm' });
    expect(r.kind === 'verdict' && r.verdict.riskFlags).toEqual(['promises_action']);
  });
  it('fehlende Pflichtfelder → failed', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'geld' });
    expect((await judgeDraft(input, { call, model: 'm' })).kind).toBe('failed');
  });
  it('Exception → failed mit Fehlertext', async () => {
    const call = vi.fn().mockRejectedValue(new Error('boom'));
    expect(await judgeDraft(input, { call, model: 'm' })).toEqual({ kind: 'failed', error: 'boom' });
  });
  it('User-Message enthält Gastnachricht und Entwurf getrennt', () => {
    const m = buildJudgeUserMessage(input);
    expect(m).toContain('--- GASTNACHRICHT');
    expect(m).toContain('--- ENTWURF');
    expect(m).toContain('13 Uhr');
  });
});
```

- [ ] **Step 2:** Test → FAIL.

- [ ] **Step 3: Prompt + Service implementieren**

```ts
// src/services/auto-send/judge-prompt.ts
// Zweites, unabhängiges Modell prüft den Entwurf (Spec 5.1). Eigener Prompt — bewusst getrennt
// von draft-service.ts und review-classifier.ts. Kategorien/Flags: types.ts.
import type { ClaudeToolDefinition } from '../anthropic-client.js';
import { JUDGE_CATEGORIES, JUDGE_RISK_FLAGS } from './types.js';

export const JUDGE_DRAFT_TOOL: ClaudeToolDefinition = {
  name: 'judge_draft',
  description: 'Bewerte, ob der Antwortentwurf ohne menschliche Prüfung an den Gast gehen darf.',
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: JUDGE_CATEGORIES, description: 'Kategorie des Gast-Anliegens (siehe Definitionen im Systemprompt).' },
      answerable_from_facts: { type: 'boolean', description: 'true NUR, wenn die Antwort eindeutig und vollständig aus OBJEKTWISSEN/BUCHUNGSKONTEXT belegt ist.' },
      risk_flags: { type: 'array', items: { type: 'string', enum: JUDGE_RISK_FLAGS }, description: 'Alle zutreffenden Risiken; leer, wenn keines.' },
      confidence: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'], description: 'Wie sicher bist du, dass der Entwurf fehlerfrei und angemessen ist?' },
      reasoning: { type: 'string', description: 'Ein bis zwei deutsche Sätze für den Menschen, der die Ampel liest.' },
    },
    required: ['category', 'answerable_from_facts', 'risk_flags', 'confidence', 'reasoning'],
  },
};

export function buildJudgeSystemPrompt(voice: string, facts: string, bookingContext: string | null): string {
  const lines = [
    'Du bist die unabhängige Prüfinstanz für automatische Gästeantworten einer Ferienvermietung.',
    'Ein anderes Modell hat einen Antwortentwurf geschrieben. Du entscheidest NICHT, ob die Antwort gut klingt,',
    'sondern ob sie ohne menschliche Freigabe rausgehen darf. Im Zweifel: NICHT freigeben (confidence mittel/niedrig oder Flag).',
    '',
    'KATEGORIEN des Gast-Anliegens (genau eine wählen):',
    '- dank_smalltalk: Dank, Grüße, Small Talk ohne Frage oder Anliegen.',
    '- ankunftszeit: Gast kündigt Ankunfts-/Abreisezeit an oder fragt, ob eine Zeit innerhalb der regulären Zeiten passt.',
    '- playbook_fakt: Sachfrage, die das OBJEKTWISSEN wörtlich beantwortet (WLAN, Parken, Checkout-Zeit, Ausstattung, Umgebung, Anfahrt).',
    '- checkin_standard: Frage/Bestätigung zum regulären Self-Check-in-Ablauf, OHNE dass Codes genannt werden müssen.',
    '- geld: Preise, Rabatte, Erstattungen, Kaution, Rechnungen, Zahlungen.',
    '- storno_datum: Stornierung, Umbuchung, Änderung von Datum, Nächten oder Personenzahl.',
    '- beschwerde_schaden: Beschwerde, Mangel, Schaden, Streit, Unzufriedenheit.',
    '- sonderwunsch: Alles außerhalb des Standards: früher Check-in / später Checkout außerhalb der Regeln, zusätzliche Gäste, Haustiere, Feiern, Sonderausstattung.',
    '- medizin_sicherheit: Gesundheit, Notfall, Sicherheit, Polizei, Feuer, Verletzung.',
    '- unklar: Anliegen nicht eindeutig zuzuordnen oder mehrere Kategorien gleichrangig.',
    '',
    'RISIKO-FLAGS (alle zutreffenden setzen):',
    '- invents_fact: Entwurf behauptet etwas, das weder im OBJEKTWISSEN noch im BUCHUNGSKONTEXT steht.',
    '- promises_action: Entwurf sagt eine Handlung zu (jemand kommt vorbei, wird organisiert, wird erstattet …).',
    '- mentions_code: Entwurf nennt oder umschreibt Zugangscodes, Tresor-/Schloss-Kombinationen.',
    '- contradicts_facts: Entwurf widerspricht OBJEKTWISSEN oder BUCHUNGSKONTEXT.',
    '- tone_off: Ton passt nicht zur VOICE (zu förmlich, zu flapsig, unfreundlich).',
    '- language_mismatch: Antwortsprache ≠ Sprache der letzten Gastnachricht.',
    '- multi_topic: Gast fragt mehrere Dinge, davon mindestens eines NICHT in dank_smalltalk/ankunftszeit/playbook_fakt/checkin_standard.',
    '',
    'confidence=hoch NUR, wenn: Kategorie eindeutig, keine Flags, und jeder Sachaussage im Entwurf eine Zeile im OBJEKTWISSEN/BUCHUNGSKONTEXT entspricht.',
    '--- VOICE ---', voice, '--- ENDE VOICE ---',
    '--- OBJEKTWISSEN ---', facts, '--- ENDE OBJEKTWISSEN ---',
  ];
  if (bookingContext) lines.push('--- BUCHUNGSKONTEXT ---', bookingContext, '--- ENDE BUCHUNGSKONTEXT ---');
  lines.push('Antworte ausschließlich über das Tool judge_draft.');
  return lines.join('\n');
}
```

```ts
// src/services/auto-send/judge-service.ts
import { callClaudeTool } from '../anthropic-client.js';
import { config } from '../../config/index.js';
import { JUDGE_DRAFT_TOOL, buildJudgeSystemPrompt } from './judge-prompt.js';
import { JUDGE_CATEGORIES, JUDGE_RISK_FLAGS, type JudgeCategory, type JudgeResult, type JudgeRiskFlag } from './types.js';

export interface JudgeInput {
  guestMessages: string[];      // Gastnachrichten seit der letzten Host-Antwort, chronologisch
  draft: string;
  voice: string;
  facts: string;
  bookingContext: string | null;
  guestName: string | null;
}
export interface JudgeDeps { call: typeof callClaudeTool; model: string }
const defaultDeps = (): JudgeDeps => ({ call: callClaudeTool, model: config.judgeModel });

export function buildJudgeUserMessage(input: JudgeInput): string {
  return [
    `Gast: ${input.guestName ?? 'unbekannt'}`,
    '--- GASTNACHRICHT(EN), chronologisch ---',
    ...input.guestMessages.map((m, i) => `[${i + 1}] ${m}`),
    '--- ENDE GASTNACHRICHT ---',
    '--- ENTWURF (zu prüfen) ---', input.draft, '--- ENDE ENTWURF ---',
  ].join('\n');
}

export async function judgeDraft(input: JudgeInput, deps: JudgeDeps = defaultDeps()): Promise<JudgeResult> {
  let out: unknown;
  try {
    out = await deps.call({
      systemPrompt: buildJudgeSystemPrompt(input.voice, input.facts, input.bookingContext),
      userMessage: buildJudgeUserMessage(input),
      tool: JUDGE_DRAFT_TOOL,
      model: deps.model,
      maxTokens: 600,
    });
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  if (!out || typeof out !== 'object') return { kind: 'failed', error: 'Prüf-Output fehlt oder ist kein Objekt' };
  const o = out as Record<string, unknown>;
  const category = o.category as JudgeCategory;
  if (!JUDGE_CATEGORIES.includes(category)) return { kind: 'failed', error: `Unbekannte Kategorie: ${String(o.category)}` };
  if (typeof o.answerable_from_facts !== 'boolean') return { kind: 'failed', error: 'answerable_from_facts fehlt' };
  if (!['hoch', 'mittel', 'niedrig'].includes(String(o.confidence))) return { kind: 'failed', error: 'confidence fehlt/ungültig' };
  const riskFlags = (Array.isArray(o.risk_flags) ? o.risk_flags : []).filter((f): f is JudgeRiskFlag => JUDGE_RISK_FLAGS.includes(f as JudgeRiskFlag));
  return {
    kind: 'verdict',
    verdict: {
      category,
      answerableFromFacts: o.answerable_from_facts,
      riskFlags,
      confidence: o.confidence as 'hoch' | 'mittel' | 'niedrig',
      reasoning: typeof o.reasoning === 'string' ? o.reasoning.trim() : '',
    },
  };
}
```

- [ ] **Step 4:** Test → PASS.

- [ ] **Step 5: Fixtures + Live-Skript** (Starter-Set, synthetisch; wird in der Schattenphase durch anonymisierte echte Fälle ersetzt — Task 15 hält das fest):

```json
// src/test-fixtures/judge/cases.json
[
  { "name": "dank ohne frage", "guestMessages": ["Vielen Dank, wir hatten eine tolle Zeit!"], "draft": "Danke dir, Anna — das freut uns sehr. Kommt gern wieder!", "expected": { "category": "dank_smalltalk", "auto": true } },
  { "name": "ankunft regulär", "guestMessages": ["Wir kommen morgen gegen 17 Uhr an, passt das?"], "draft": "Hallo Ben, 17 Uhr passt perfekt — Check-in ist ab 15 Uhr möglich. Gute Anreise!", "facts": "Check-in ab 15:00 Uhr, Checkout bis 11:00 Uhr.", "expected": { "category": "ankunftszeit", "auto": true } },
  { "name": "wlan aus playbook", "guestMessages": ["Wie lautet das WLAN?"], "draft": "Hallo Lisa, das WLAN heißt Farmhouse-Gast, das Passwort steht im Gästehandbuch auf dem Küchentisch.", "facts": "WLAN: Farmhouse-Gast, Passwort im Gästehandbuch (Küchentisch).", "expected": { "category": "playbook_fakt", "auto": true } },
  { "name": "früher checkin = sonderwunsch", "guestMessages": ["Könnten wir schon um 11 Uhr rein?"], "draft": "Klar, 11 Uhr geht in Ordnung!", "facts": "Check-in ab 15:00 Uhr.", "expected": { "category": "sonderwunsch", "auto": false } },
  { "name": "erstattung = geld", "guestMessages": ["Die Heizung ging nicht, ich erwarte eine Erstattung."], "draft": "Das tut mir leid, ich erstatte dir 50 €.", "expected": { "category": "beschwerde_schaden", "auto": false } },
  { "name": "code angefragt", "guestMessages": ["Wie ist der Tresorcode?"], "draft": "Der Code steht im Airbnb-Check-in-Guide, bitte dort nachsehen.", "facts": "Codes NIE in Nachrichten — auf den Check-in-Guide verweisen.", "expected": { "category": "checkin_standard", "auto": true } },
  { "name": "zwei themen", "guestMessages": ["Danke! Und können wir einen Hund mitbringen?"], "draft": "Gern geschehen! Ein Hund ist leider nicht möglich.", "expected": { "category": "sonderwunsch", "auto": false } },
  { "name": "notfall", "guestMessages": ["Es riecht nach Gas in der Küche!"], "draft": "Bitte sofort das Haus verlassen und den Notruf 112 wählen.", "expected": { "category": "medizin_sicherheit", "auto": false } }
]
```

```ts
// src/scripts/test-judge-fixtures.ts
// Live-Regressionslauf gegen das echte Prüfmodell (kostet Geld, daher nicht in `npm test`).
// Aufruf: npm run test:judge — Pflicht vor jeder Änderung an judge-prompt.ts.
import { readFileSync } from 'node:fs';
import { judgeDraft } from '../services/auto-send/judge-service.js';
import { AUTO_OK_CATEGORIES } from '../services/auto-send/types.js';

interface Case { name: string; guestMessages: string[]; draft: string; facts?: string; expected: { category: string; auto: boolean } }
const cases = JSON.parse(readFileSync(new URL('../test-fixtures/judge/cases.json', import.meta.url), 'utf8')) as Case[];
let failed = 0;
for (const c of cases) {
  const r = await judgeDraft({ guestMessages: c.guestMessages, draft: c.draft, voice: 'Du, locker, herzlich, kurz.', facts: c.facts ?? '(keine Fakten)', bookingContext: null, guestName: null });
  if (r.kind !== 'verdict') { console.log(`✗ ${c.name}: technisch fehlgeschlagen (${r.error})`); failed++; continue; }
  const v = r.verdict;
  const wouldAuto = AUTO_OK_CATEGORIES.has(v.category) && v.riskFlags.length === 0 && v.confidence === 'hoch' && (v.category !== 'playbook_fakt' || v.answerableFromFacts);
  const ok = v.category === c.expected.category && wouldAuto === c.expected.auto;
  console.log(`${ok ? '✓' : '✗'} ${c.name}: ${v.category} auto=${wouldAuto} flags=[${v.riskFlags.join(',')}] conf=${v.confidence} — ${v.reasoning}`);
  if (!ok) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} Fälle wie erwartet`);
process.exit(failed ? 1 : 0);
```

`package.json` Scripts: `"test:judge": "tsx src/scripts/test-judge-fixtures.ts"`.

- [ ] **Step 6:** `npm run test:judge` (braucht `ANTHROPIC_API_KEY` in `.env`) → Ausgabe prüfen. Ziel: 8/8. Weicht das Modell ab, Prompt-Definitionen (nicht die Erwartungen) nachschärfen, erneut laufen lassen; Ergebnis im Commit-Text notieren.
- [ ] **Step 7: Commit** — `git add src/services/auto-send/judge-* src/test-fixtures/judge src/scripts/test-judge-fixtures.ts package.json && git commit -m "feat(auto-send): Prüfmodell (Prompt, Service, Fixtures, Live-Lauf) — test:judge N/8"`

---

### Task 5: Policy `decide()`

**Files:**
- Create: `src/services/auto-send/policy.ts`
- Test: `src/services/auto-send/policy.test.ts`

**Interfaces:**
- Produces: `decide(input: PolicyInput): AutoSendDecision` mit
  `PolicyInput = { mode: AutoSendMode; paused: boolean; judge: JudgeResult; mechanical: MechanicalFinding[]; threadHasHumanIntervention: boolean; autoSentToday: number; dailyCap: number; canSend: boolean }`.

- [ ] **Step 1: Failing Tests**

```ts
// src/services/auto-send/policy.test.ts
import { describe, it, expect } from 'vitest';
import { decide, type PolicyInput } from './policy.js';
import type { JudgeResult } from './types.js';

const okJudge: JudgeResult = { kind: 'verdict', verdict: { category: 'ankunftszeit', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'r' } };
const base: PolicyInput = { mode: 'live', paused: false, judge: okJudge, mechanical: [], threadHasHumanIntervention: false, autoSentToday: 0, dailyCap: 10, canSend: true };
const withVerdict = (over: Partial<(typeof okJudge)['verdict']>): JudgeResult =>
  ({ kind: 'verdict', verdict: { ...okJudge.verdict, ...over } });

describe('decide', () => {
  it('alles grün → auto', () => {
    const d = decide(base);
    expect(d.decision).toBe('auto');
    expect(d.category).toBe('ankunftszeit');
    expect(d.reason).toMatch(/Ankunftszeit/);
  });
  it('Modus off → wait, kein Gate-Grund', () => expect(decide({ ...base, mode: 'off' })).toMatchObject({ decision: 'wait', reason: 'Auto-Send aus (Modus off)' }));
  it('pausiert → wait', () => expect(decide({ ...base, paused: true }).reason).toBe('Auto-Send pausiert'));
  it('Prüfung technisch fehlgeschlagen → wait mit Fehlertext', () => {
    expect(decide({ ...base, judge: { kind: 'failed', error: 'timeout' } }).reason).toBe('Prüfung technisch fehlgeschlagen: timeout');
  });
  it('Kategorie außerhalb Whitelist → wait', () => {
    expect(decide({ ...base, judge: withVerdict({ category: 'geld' }) }).reason).toBe('Kategorie Geld — nie automatisch');
  });
  it('playbook_fakt ohne Faktenbeleg → wait', () => {
    expect(decide({ ...base, judge: withVerdict({ category: 'playbook_fakt', answerableFromFacts: false }) }).reason).toMatch(/nicht eindeutig aus dem Playbook/);
  });
  it('Risiko-Flag → wait, Flag in flags', () => {
    const d = decide({ ...base, judge: withVerdict({ riskFlags: ['promises_action'] }) });
    expect(d.decision).toBe('wait'); expect(d.flags).toContain('promises_action'); expect(d.reason).toMatch(/Handlung/);
  });
  it('confidence nicht hoch → wait', () => expect(decide({ ...base, judge: withVerdict({ confidence: 'mittel' }) }).reason).toMatch(/Sicherheit/));
  it('mechanischer Treffer → wait mit Fundstelle, Flag mech:*', () => {
    const d = decide({ ...base, mechanical: [{ flag: 'url', match: 'www.x.de' }] });
    expect(d.reason).toBe('Mechanischer Check: Link im Text (www.x.de)'); expect(d.flags).toEqual(['mech:url']);
  });
  it('Micha hat eingegriffen → wait', () => expect(decide({ ...base, threadHasHumanIntervention: true }).reason).toMatch(/schon eingegriffen/));
  it('Tageslimit erreicht → wait', () => expect(decide({ ...base, autoSentToday: 10 }).reason).toBe('Tageslimit erreicht (10/10)'));
  it('Kanal nicht auflösbar → wait', () => expect(decide({ ...base, canSend: false }).reason).toBe('Kanal unklar — kein Versand möglich'));
  it('shadow verhält sich wie live (Entscheidung, nicht Versand)', () => expect(decide({ ...base, mode: 'shadow' }).decision).toBe('auto'));
  it('Prüfergebnis-Flags landen auch bei wait durch anderen Grund in flags', () => {
    const d = decide({ ...base, judge: withVerdict({ riskFlags: ['tone_off'] }), mechanical: [{ flag: 'email', match: 'a@b.de' }] });
    expect(d.flags).toEqual(['tone_off', 'mech:email']);
  });
});
```

- [ ] **Step 2:** Test → FAIL.

- [ ] **Step 3: Implementieren**

```ts
// src/services/auto-send/policy.ts
// Schicht 3 des Gates (Spec 5.3): reine Entscheidungsfunktion, kein I/O.
import { AUTO_OK_CATEGORIES, type AutoSendDecision, type AutoSendMode, type JudgeCategory, type JudgeResult, type JudgeRiskFlag, type MechanicalFinding, type MechanicalFlag } from './types.js';

export interface PolicyInput {
  mode: AutoSendMode; paused: boolean; judge: JudgeResult; mechanical: MechanicalFinding[];
  threadHasHumanIntervention: boolean; autoSentToday: number; dailyCap: number; canSend: boolean;
}

const CATEGORY_LABEL: Record<JudgeCategory, string> = {
  dank_smalltalk: 'Dank/Small Talk', ankunftszeit: 'Ankunftszeit', playbook_fakt: 'Playbook-Fakt', checkin_standard: 'Check-in-Standard',
  geld: 'Geld', storno_datum: 'Storno/Datum', beschwerde_schaden: 'Beschwerde/Schaden', sonderwunsch: 'Sonderwunsch',
  medizin_sicherheit: 'Medizin/Sicherheit', unklar: 'Unklar',
};
const RISK_LABEL: Record<JudgeRiskFlag, string> = {
  invents_fact: 'erfundener Fakt', promises_action: 'Zusage einer Handlung', mentions_code: 'Zugangscode erwähnt',
  contradicts_facts: 'Widerspruch zum Playbook', tone_off: 'Ton passt nicht', language_mismatch: 'falsche Sprache', multi_topic: 'mehrere Themen',
};
const MECH_LABEL: Record<MechanicalFlag, string> = {
  digits: 'Ziffernfolge', url: 'Link', email: 'Mail-Adresse', money: 'Geldbetrag', phone: 'Telefonnummer',
  code_words: 'Code-Wort mit Ziffer', length: 'Text zu lang', empty: 'Text leer',
};

export function decide(i: PolicyInput): AutoSendDecision {
  const verdict = i.judge.kind === 'verdict' ? i.judge.verdict : null;
  const flags = [...(verdict?.riskFlags ?? []), ...i.mechanical.map((m) => `mech:${m.flag}`)];
  const category = verdict?.category ?? null;
  const wait = (reason: string): AutoSendDecision => ({ decision: 'wait', reason, category, flags });

  if (i.mode === 'off') return wait('Auto-Send aus (Modus off)');
  if (i.paused) return wait('Auto-Send pausiert');
  if (i.judge.kind === 'failed') return wait(`Prüfung technisch fehlgeschlagen: ${i.judge.error}`);
  const v = i.judge.verdict;
  if (!AUTO_OK_CATEGORIES.has(v.category)) return wait(`Kategorie ${CATEGORY_LABEL[v.category]} — nie automatisch`);
  if (v.category === 'playbook_fakt' && !v.answerableFromFacts) return wait('Antwort nicht eindeutig aus dem Playbook belegt');
  if (v.riskFlags.length) return wait(`Prüfmodell: ${v.riskFlags.map((f) => RISK_LABEL[f]).join(', ')}`);
  if (i.mechanical.length) { const m = i.mechanical[0]; return wait(`Mechanischer Check: ${MECH_LABEL[m.flag]} im Text (${m.match})`); }
  if (v.confidence !== 'hoch') return wait(`Sicherheit des Prüfmodells nur „${v.confidence}"`);
  if (i.threadHasHumanIntervention) return wait('Micha hat in diesem Thread schon eingegriffen');
  if (!i.canSend) return wait('Kanal unklar — kein Versand möglich');
  if (i.autoSentToday >= i.dailyCap) return wait(`Tageslimit erreicht (${i.autoSentToday}/${i.dailyCap})`);
  return { decision: 'auto', reason: `${CATEGORY_LABEL[v.category]}, keine Risiken, Sicherheit hoch`, category, flags };
}
```

- [ ] **Step 4:** Test → PASS (Reihenfolge der Prüfungen ist Teil des Vertrags; Testerwartungen ggf. an die Reihenfolge oben anpassen, nicht umgekehrt — die Reihenfolge Modus → Pause → Prüfung → Kategorie → Fakten → Flags → Mechanik → Sicherheit → Eingriff → Kanal → Limit bleibt).
- [ ] **Step 5: Commit** — `git commit -am "feat(auto-send): Policy decide() mit deutschen Ampel-Gründen"` (nach `git add src/services/auto-send/policy*`).

---

### Task 6: `sendClaimedDraft` in Service extrahieren

**Files:**
- Create: `src/services/draft-send-service.ts`
- Modify: `src/routes/messages.ts` (Funktion entfernen, importieren; Send-Route setzt `sent_body_changed`)
- Test: `src/services/draft-send-service.test.ts`

**Interfaces:**
- Produces: `sendClaimedDraft(draftId, thread, bodyToSend, sentBy: 'micha'|'auto', deps?)` → `Promise<{ ok: true } | { ok: false; err: unknown }>`; `SendDraftDeps = { sendReply, markDraftSent, markDraftError, upsertMessage }`.

- [ ] **Step 1: Failing Test**

```ts
// src/services/draft-send-service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { sendClaimedDraft, type SendDraftDeps } from './draft-send-service.js';
import type { MessageThread } from '../types/messages.js';

const thread = { id: 'hostex:t1', source: 'hostex' } as MessageThread;
const deps = (over: Partial<SendDraftDeps> = {}): SendDraftDeps => ({
  sendReply: vi.fn().mockResolvedValue({ externalMessageId: 'x1' }),
  markDraftSent: vi.fn(), markDraftError: vi.fn(), upsertMessage: vi.fn(), ...over,
});

describe('sendClaimedDraft', () => {
  it('sendet, markiert sent_by und legt Outbound-Message an', async () => {
    const d = deps();
    expect(await sendClaimedDraft('d1', thread, 'Hallo', 'auto', d)).toEqual({ ok: true });
    expect(d.markDraftSent).toHaveBeenCalledWith('d1', 'x1', 'auto');
    expect((d.upsertMessage as any).mock.calls[0][0]).toMatchObject({ id: 'hostex:x1', direction: 'outbound', body: 'Hallo' });
  });
  it('Fehler → markDraftError, ok=false', async () => {
    const d = deps({ sendReply: vi.fn().mockRejectedValue(new Error('down')) });
    const r = await sendClaimedDraft('d1', thread, 'Hallo', 'micha', d);
    expect(r.ok).toBe(false);
    expect(d.markDraftError).toHaveBeenCalledWith('d1', 'down');
  });
});
```

- [ ] **Step 2:** Test → FAIL.

- [ ] **Step 3: Service anlegen** (Körper 1:1 aus `routes/messages.ts` Zeilen 323–347 übernehmen, nur Deps injizierbar + `sentBy`):

```ts
// src/services/draft-send-service.ts
import type { MessageThread } from '../types/messages.js';
import { sendReply } from './message-sender.js';
import { markDraftSent, markDraftError } from '../repositories/draft-repository.js';
import { upsertMessage } from '../repositories/message-repository.js';

export interface SendDraftDeps {
  sendReply: typeof sendReply; markDraftSent: typeof markDraftSent; markDraftError: typeof markDraftError; upsertMessage: typeof upsertMessage;
}
const defaultDeps: SendDraftDeps = { sendReply, markDraftSent, markDraftError, upsertMessage };

/** Versand eines bereits per claimDraftForSending geclaimten Entwurfs (Freigabe-Klick ODER Auto-Send). */
export async function sendClaimedDraft(
  draftId: string, thread: MessageThread, bodyToSend: string, sentBy: 'micha' | 'auto', deps: SendDraftDeps = defaultDeps,
): Promise<{ ok: true } | { ok: false; err: unknown }> {
  try {
    const { externalMessageId } = await deps.sendReply(thread, bodyToSend);
    deps.markDraftSent(draftId, externalMessageId, sentBy);
    const outboundId = externalMessageId ? `${thread.source}:${externalMessageId}` : `sent:${draftId}`;
    deps.upsertMessage({
      id: outboundId, thread_id: thread.id, direction: 'outbound',
      sent_at: new Date().toISOString(), from_name: 'host', from_address: null, to_address: null,
      subject: null, body: bodyToSend, body_html: null, source: thread.source,
      raw_meta: JSON.stringify({ draftId, externalMessageId, sentBy }),
    });
    return { ok: true };
  } catch (sendErr) {
    deps.markDraftError(draftId, sendErr instanceof Error ? sendErr.message : String(sendErr));
    return { ok: false, err: sendErr };
  }
}
```

In `routes/messages.ts`: lokale `sendClaimedDraft` löschen, `import { sendClaimedDraft } from '../services/draft-send-service.js';` und `setSentBodyChanged` importieren. In der Send-Route (`/drafts/:draftId/send`) nach `const bodyToSend = …`:

```ts
    setSentBodyChanged(draft.id, edited !== '' && edited !== draft.body);
    const result = await sendClaimedDraft(draft.id, thread, bodyToSend, 'micha');
```

Den Aufruf in `/:threadId/reply` ebenfalls auf `sendClaimedDraft(draft.id, thread, body, 'micha')` umstellen. `markDraftSent`/`markDraftError`/`upsertMessage` in `messages.ts` nur noch importieren, wenn andere Stellen sie brauchen (sonst Import entfernen, damit Lint nicht meckert).

- [ ] **Step 4:** `npm test -- --run` → grün (inkl. `messages.reply.test.ts`).
- [ ] **Step 5: Commit** — `git add -A src/services/draft-send-service* src/routes/messages.ts && git commit -m "refactor: sendClaimedDraft als Service, sent_by + sent_body_changed in Send-Route"`

---

### Task 7: Runner `runAutoSendGate()`

**Files:**
- Create: `src/services/auto-send/runner.ts`
- Test: `src/services/auto-send/runner.test.ts`

**Interfaces:**
- Consumes: `judgeDraft`, `runMechanicalChecks`, `collectDigitRuns`, `decide`, `resolveAutoSendMode`, `startOfBerlinDayIso`, Repository-Funktionen aus Task 1, `sendClaimedDraft`, `claimDraftForSending`, `resolveOutboundModuleType`, `getSchedulerState`.
- Produces: `runAutoSendGate(input: GateInput, deps?: GateDeps): Promise<{ decision: AutoSendDecision; mode: AutoSendMode; sent: boolean }>` mit `GateInput = { draftId; body; thread; messages; voice; facts; bookingContext; property }`.

- [ ] **Step 1: Failing Tests**

```ts
// src/services/auto-send/runner.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runAutoSendGate, type GateDeps, type GateInput } from './runner.js';
import type { MessageThread, Message } from '../../types/messages.js';
import type { PropertyConfig } from '../../config/properties.js';

const thread = { id: 'hostex:t1', source: 'hostex', guest_name: 'Anna', channel: 'airbnb', reservation_status: 'confirmed' } as MessageThread;
const msgs = [{ id: 'm1', direction: 'inbound', body: 'Können wir um 13 Uhr kommen?', sent_at: '2026-09-19T10:00:00Z' }] as Message[];
const property = { slug: 'bootshaus', autoSend: undefined } as PropertyConfig;
const input: GateInput = { draftId: 'd1', body: 'Ja, 13 Uhr passt.', thread, messages: msgs, voice: 'V', facts: 'F', bookingContext: null, property };

const okVerdict = { kind: 'verdict', verdict: { category: 'ankunftszeit', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'r' } } as const;
function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    envMode: 'live', dailyCap: 10,
    judge: vi.fn().mockResolvedValue(okVerdict),
    isPaused: vi.fn().mockReturnValue(false),
    hasHumanIntervention: vi.fn().mockReturnValue(false),
    countAutoSentSince: vi.fn().mockReturnValue(0),
    canSend: vi.fn().mockReturnValue(true),
    persistDecision: vi.fn(),
    claim: vi.fn().mockReturnValue(true),
    send: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
}

describe('runAutoSendGate', () => {
  it('live + auto → persistiert und sendet als auto', async () => {
    const d = deps();
    const r = await runAutoSendGate(input, d);
    expect(r).toMatchObject({ decision: { decision: 'auto' }, mode: 'live', sent: true });
    expect(d.persistDecision).toHaveBeenCalledWith('d1', expect.objectContaining({ decision: 'auto' }), 'live');
    expect(d.claim).toHaveBeenCalledWith('d1');
    expect(d.send).toHaveBeenCalledWith('d1', thread, 'Ja, 13 Uhr passt.', 'auto');
  });
  it('shadow + auto → persistiert, sendet NICHT', async () => {
    const d = deps({ envMode: 'shadow' });
    const r = await runAutoSendGate(input, d);
    expect(r.sent).toBe(false); expect(d.send).not.toHaveBeenCalled();
    expect(d.persistDecision).toHaveBeenCalledWith('d1', expect.objectContaining({ decision: 'auto' }), 'shadow');
  });
  it('Property-Modus off schlägt Env live', async () => {
    const d = deps();
    const r = await runAutoSendGate({ ...input, property: { slug: 'x', autoSend: 'off' } as PropertyConfig }, d);
    expect(r.mode).toBe('off'); expect(r.decision.decision).toBe('wait'); expect(d.judge).not.toHaveBeenCalled();
  });
  it('live + wait → kein Send', async () => {
    const d = deps({ judge: vi.fn().mockResolvedValue({ kind: 'failed', error: 'x' }) });
    const r = await runAutoSendGate(input, d);
    expect(r.decision.decision).toBe('wait'); expect(d.send).not.toHaveBeenCalled();
  });
  it('Claim schlägt fehl → nicht gesendet', async () => {
    const d = deps({ claim: vi.fn().mockReturnValue(false) });
    expect((await runAutoSendGate(input, d)).sent).toBe(false);
  });
  it('Send-Fehler → sent=false (Draft steht auf error, Push folgt über awaiting)', async () => {
    const d = deps({ send: vi.fn().mockResolvedValue({ ok: false, err: new Error('down') }) });
    expect((await runAutoSendGate(input, d)).sent).toBe(false);
  });
  it('Prüfmodell bekommt nur Gastnachrichten seit letzter Host-Antwort', async () => {
    const d = deps();
    const messages = [
      { id: '1', direction: 'inbound', body: 'alt', sent_at: '2026-09-18T10:00:00Z' },
      { id: '2', direction: 'outbound', body: 'host', sent_at: '2026-09-18T11:00:00Z' },
      { id: '3', direction: 'inbound', body: 'neu', sent_at: '2026-09-19T10:00:00Z' },
    ] as Message[];
    await runAutoSendGate({ ...input, messages }, d);
    expect((d.judge as any).mock.calls[0][0].guestMessages).toEqual(['neu']);
  });
  it('bekannte Ziffernfolgen aus Gastnachricht + Buchungskontext gelten als Kontext', async () => {
    const d = deps();
    await runAutoSendGate({ ...input, body: 'Bis 2026!', bookingContext: 'Check-in 19.09.2026' }, d);
    expect((d.persistDecision as any).mock.calls[0][1].flags).toEqual([]);
  });
});
```

- [ ] **Step 2:** Test → FAIL.

- [ ] **Step 3: Implementieren**

```ts
// src/services/auto-send/runner.ts
// Orchestrierung des Gates (Spec 4 + 5): Entwurf liegt bereits als pending in message_drafts.
import { config } from '../../config/index.js';
import type { Message, MessageThread } from '../../types/messages.js';
import type { PropertyConfig } from '../../config/properties.js';
import { judgeDraft, type JudgeInput } from './judge-service.js';
import { runMechanicalChecks, collectDigitRuns } from './mechanical-checks.js';
import { decide } from './policy.js';
import { resolveAutoSendMode } from './mode.js';
import { startOfBerlinDayIso } from './berlin-day.js';
import type { AutoSendDecision, AutoSendMode, JudgeResult } from './types.js';
import { setAutoDecision, threadHasHumanIntervention, countAutoSentSince, claimDraftForSending } from '../../repositories/draft-repository.js';
import { getSchedulerState } from '../../repositories/scheduler-state-repository.js';
import { resolveOutboundModuleType } from '../guesty-channel.js';
import { sendClaimedDraft } from '../draft-send-service.js';
import logger from '../../utils/logger.js';

export const PAUSE_KEY = 'auto_send_paused';

export interface GateInput {
  draftId: string; body: string; thread: MessageThread; messages: Message[];
  voice: string; facts: string; bookingContext: string | null; property: PropertyConfig;
}
export interface GateDeps {
  envMode: AutoSendMode; dailyCap: number;
  judge: (i: JudgeInput) => Promise<JudgeResult>;
  isPaused: () => boolean;
  hasHumanIntervention: (threadId: string) => boolean;
  countAutoSentSince: (sinceIso: string) => number;
  canSend: (thread: MessageThread, messages: Message[]) => boolean;
  persistDecision: (draftId: string, d: AutoSendDecision, mode: AutoSendMode) => void;
  claim: (draftId: string) => boolean;
  send: (draftId: string, thread: MessageThread, body: string, sentBy: 'auto') => Promise<{ ok: true } | { ok: false; err: unknown }>;
}
export function realGateDeps(): GateDeps {
  return {
    envMode: config.autoSendMode, dailyCap: config.autoSendDailyCap,
    judge: (i) => judgeDraft(i),
    isPaused: () => getSchedulerState(PAUSE_KEY) === '1',
    hasHumanIntervention: threadHasHumanIntervention,
    countAutoSentSince,
    canSend: (thread, messages) => thread.source !== 'guesty' || resolveOutboundModuleType(messages) !== null,
    persistDecision: setAutoDecision,
    claim: claimDraftForSending,
    send: (id, thread, body, sentBy) => sendClaimedDraft(id, thread, body, sentBy),
  };
}

/** Gastnachrichten seit der letzten Host-Antwort (chronologisch). */
export function guestMessagesSinceLastHost(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.direction === 'outbound') out.length = 0;
    else if (m.direction === 'inbound') out.push(m.body);
  }
  return out;
}

export async function runAutoSendGate(input: GateInput, deps: GateDeps = realGateDeps()): Promise<{ decision: AutoSendDecision; mode: AutoSendMode; sent: boolean }> {
  const mode = resolveAutoSendMode(deps.envMode, input.property.autoSend);
  if (mode === 'off') {
    const decision = decide({ mode, paused: false, judge: { kind: 'failed', error: 'off' }, mechanical: [], threadHasHumanIntervention: false, autoSentToday: 0, dailyCap: deps.dailyCap, canSend: true });
    deps.persistDecision(input.draftId, decision, mode);
    return { decision, mode, sent: false };
  }
  const guestMessages = guestMessagesSinceLastHost(input.messages);
  const judge = await deps.judge({ guestMessages, draft: input.body, voice: input.voice, facts: input.facts, bookingContext: input.bookingContext, guestName: input.thread.guest_name });
  const mechanical = runMechanicalChecks(input.body, { knownDigitRuns: collectDigitRuns([...guestMessages, input.bookingContext ?? '']) });
  const decision = decide({
    mode, paused: deps.isPaused(), judge, mechanical,
    threadHasHumanIntervention: deps.hasHumanIntervention(input.thread.id),
    autoSentToday: deps.countAutoSentSince(startOfBerlinDayIso()),
    dailyCap: deps.dailyCap,
    canSend: deps.canSend(input.thread, input.messages),
  });
  deps.persistDecision(input.draftId, decision, mode);
  logger.info({ draftId: input.draftId, threadId: input.thread.id, mode, decision: decision.decision, reason: decision.reason, flags: decision.flags }, 'auto-send: Entscheidung');

  if (mode !== 'live' || decision.decision !== 'auto') return { decision, mode, sent: false };
  if (!deps.claim(input.draftId)) { logger.warn({ draftId: input.draftId }, 'auto-send: Claim fehlgeschlagen'); return { decision, mode, sent: false }; }
  const result = await deps.send(input.draftId, input.thread, input.body, 'auto');
  if (!result.ok) logger.error({ draftId: input.draftId, err: result.err instanceof Error ? result.err.message : String(result.err) }, 'auto-send: Versand fehlgeschlagen');
  return { decision, mode, sent: result.ok };
}
```

- [ ] **Step 4:** Test → PASS; `npm test -- --run` grün.
- [ ] **Step 5: Commit** — `git add src/services/auto-send/runner* && git commit -m "feat(auto-send): Runner orchestriert Prüfung, Checks, Policy und Live-Versand"`

---

### Task 8: Gate in die Entwurfs-Kette einhängen (+ Thread-Filter)

**Files:**
- Modify: `src/jobs/generate-drafts.ts`
- Test: `src/jobs/generate-drafts.test.ts` (ergänzen)

**Interfaces:**
- Produces: `generateDraftsForProperty(property, deps?, opts?: { onlyThreadIds?: string[] })`; `DraftGenDeps.gate: (i: GateInput) => Promise<unknown>`.

- [ ] **Step 1: Failing Tests** (an `generate-drafts.test.ts` anhängen; `deps()`-Helper um `gate: vi.fn().mockResolvedValue({})` ergänzen):

```ts
describe('Auto-Send-Gate in der Kette', () => {
  it('ruft das Gate nach jedem erzeugten Entwurf mit Draft-Id und Kontext', async () => {
    const d = deps({ getThreads: vi.fn().mockReturnValue([mkThread('hostex:a')]) });
    await generateDraftsForProperty(property, d);
    expect(d.gate).toHaveBeenCalledTimes(1);
    const arg = (d.gate as any).mock.calls[0][0];
    expect(arg).toMatchObject({ body: 'REPLY', voice: 'VOICE', facts: 'FACTS', property });
    expect(arg.draftId).toBe((d.create as any).mock.calls[0][0].id);
  });
  it('Gate-Fehler bricht die Kette nicht ab', async () => {
    const d = deps({ gate: vi.fn().mockRejectedValue(new Error('gate down')) });
    const res = await generateDraftsForProperty(property, d);
    expect(res.generated).toBe(2);
  });
  it('onlyThreadIds filtert', async () => {
    const d = deps();
    await generateDraftsForProperty(property, d, { onlyThreadIds: ['hostex:b'] });
    expect(d.create).toHaveBeenCalledTimes(1);
    expect((d.create as any).mock.calls[0][0].thread_id).toBe('hostex:b');
  });
});
```

- [ ] **Step 2:** Test → FAIL.

- [ ] **Step 3: Implementieren** — in `generate-drafts.ts`:

```ts
import { runAutoSendGate, type GateInput } from '../services/auto-send/runner.js';
// DraftGenDeps ergänzen:
  gate: (i: GateInput) => Promise<unknown>;
// realDeps ergänzen:
  gate: (i) => runAutoSendGate(i),
```

Signatur: `export async function generateDraftsForProperty(property, deps = realDeps, opts: { onlyThreadIds?: string[] } = {})`. Nach `const threads = deps.getThreads(...)`:

```ts
  const selected = opts.onlyThreadIds ? threads.filter((t) => opts.onlyThreadIds!.includes(t.id)) : threads;
```

(Schleife über `selected`). Im `result.kind === 'text'`-Zweig:

```ts
        const messages = deps.getMessages(thread.id);
        const draftId = randomUUID();
        deps.create({ id: draftId, thread_id: thread.id, provider: target.source, body: result.body, generated_by: 'llm', model: DRAFT_MODEL });
        generated++;
        try {
          await deps.gate({ draftId, body: result.body, thread, messages, voice, facts, bookingContext, property });
        } catch (gateErr) {
          logger.warn({ threadId: thread.id, err: gateErr instanceof Error ? gateErr.message : String(gateErr) }, 'auto-send: Gate fehlgeschlagen (Entwurf bleibt pending)');
        }
```

(`deps.getMessages(thread.id)` wird jetzt einmal vor `generate` geholt und für beide Aufrufe wiederverwendet.)

- [ ] **Step 4:** `npm test -- --run` grün.
- [ ] **Step 5: Commit** — `git commit -am "feat(auto-send): Gate läuft nach jedem KI-Entwurf; Thread-Filter für Webhook-Pfad"`

---

### Task 9: Nachrichten-Loop (5 min) + Lock + Guesty limit=100

**Files:**
- Create: `src/jobs/message-loop.ts`
- Modify: `src/jobs/etl-job.ts` (Lock um Nachrichten-Schritte), `src/jobs/scheduler.ts` (Start), `src/jobs/sync-guesty-messages.ts` (`limit: 100`)
- Test: `src/jobs/message-loop.test.ts`

**Interfaces:**
- Produces: `messageSyncLock = { tryAcquire(owner): boolean; release(): void; holder: string | null }`, `runMessageLoopOnce(deps?)`, `startMessageLoop(intervalMinutes)`, `stopMessageLoop()`.

- [ ] **Step 1: Failing Tests**

```ts
// src/jobs/message-loop.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { messageSyncLock, runMessageLoopOnce, type MessageLoopDeps } from './message-loop.js';
import type { PropertyConfig } from '../config/properties.js';

const props = [
  { slug: 'bootshaus', provider: 'hostex', hostexPropertyId: 'H1', vaultNote: 'b.md' },
  { slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'G1', vaultNote: 'f.md' },
  { slug: 'florenz', provider: 'airbnb-mail' },
] as unknown as PropertyConfig[];

function deps(over: Partial<MessageLoopDeps> = {}): MessageLoopDeps {
  return {
    getProperties: () => props,
    syncHostex: vi.fn().mockResolvedValue(undefined),
    fetchGuestyConversations: vi.fn().mockResolvedValue([{ _id: 'c1' }]),
    syncGuesty: vi.fn().mockResolvedValue(undefined),
    generateDrafts: vi.fn().mockResolvedValue({ generated: 0, skipped: 0 }),
    ...over,
  };
}
beforeEach(() => messageSyncLock.release());

describe('runMessageLoopOnce', () => {
  it('synct Hostex- und Guesty-Objekte, Guesty-Liste nur einmal, dann Entwürfe', async () => {
    const d = deps();
    const r = await runMessageLoopOnce(d);
    expect(r).toEqual({ skipped: false, properties: 2 });
    expect(d.syncHostex).toHaveBeenCalledTimes(1);
    expect(d.fetchGuestyConversations).toHaveBeenCalledTimes(1);
    expect(d.syncGuesty).toHaveBeenCalledWith(props[1], [{ _id: 'c1' }]);
    expect(d.generateDrafts).toHaveBeenCalledTimes(2);
  });
  it('überspringt, wenn der Lock gehalten wird', async () => {
    messageSyncLock.tryAcquire('etl');
    const d = deps();
    expect(await runMessageLoopOnce(d)).toEqual({ skipped: true, properties: 0 });
    expect(d.syncHostex).not.toHaveBeenCalled();
  });
  it('gibt den Lock auch bei Fehler frei', async () => {
    const d = deps({ syncHostex: vi.fn().mockRejectedValue(new Error('x')) });
    await runMessageLoopOnce(d);
    expect(messageSyncLock.holder).toBeNull();
  });
});
```

- [ ] **Step 2:** Test → FAIL.

- [ ] **Step 3: Implementieren**

```ts
// src/jobs/message-loop.ts
// Eigener Nachrichten-Takt (Spec 3.2), unabhängig vom Stunden-ETL: Sync beider Provider →
// Entwürfe → Gate. Ein prozessweiter Lock verhindert überlappende Syncs mit dem ETL.
import { getAllProperties, type PropertyConfig } from '../config/properties.js';
import { getHostexClient } from '../services/hostex-client.js';
import { syncHostexMessagesForProperty } from './hostex/sync-hostex-messages.js';
import { syncGuestyMessagesForProperty, fetchAllConversations } from './sync-guesty-messages.js';
import { generateDraftsForProperty } from './generate-drafts.js';
import logger from '../utils/logger.js';

export const messageSyncLock = {
  holder: null as string | null,
  tryAcquire(owner: string): boolean { if (this.holder) return false; this.holder = owner; return true; },
  release(): void { this.holder = null; },
};

export interface MessageLoopDeps {
  getProperties: () => PropertyConfig[];
  syncHostex: (p: PropertyConfig) => Promise<unknown>;
  fetchGuestyConversations: () => Promise<any[]>;
  syncGuesty: (p: PropertyConfig, convs: any[]) => Promise<unknown>;
  generateDrafts: (p: PropertyConfig) => Promise<unknown>;
}
const realDeps: MessageLoopDeps = {
  getProperties: getAllProperties,
  syncHostex: (p) => syncHostexMessagesForProperty(p, getHostexClient(), undefined, undefined, { deep: false }),
  fetchGuestyConversations: fetchAllConversations,
  syncGuesty: (p, convs) => syncGuestyMessagesForProperty(p, convs, { deep: false }),
  generateDrafts: (p) => generateDraftsForProperty(p),
};

export async function runMessageLoopOnce(deps: MessageLoopDeps = realDeps): Promise<{ skipped: boolean; properties: number }> {
  if (!messageSyncLock.tryAcquire('message-loop')) {
    logger.info({ holder: messageSyncLock.holder }, 'message-loop: Lock gehalten — Lauf übersprungen');
    return { skipped: true, properties: 0 };
  }
  const start = Date.now();
  let count = 0;
  try {
    const props = deps.getProperties().filter((p) => p.provider === 'hostex' || p.provider === 'guesty');
    let guestyConvs: any[] | null = null;
    for (const p of props) {
      try {
        if (p.provider === 'hostex') await deps.syncHostex(p);
        else { guestyConvs ??= await deps.fetchGuestyConversations(); await deps.syncGuesty(p, guestyConvs); }
        await deps.generateDrafts(p);
        count++;
      } catch (err) {
        logger.error({ slug: p.slug, err: err instanceof Error ? err.message : String(err) }, 'message-loop: Objekt fehlgeschlagen (non-fatal)');
      }
    }
  } finally {
    messageSyncLock.release();
  }
  logger.info({ properties: count, durationMs: Date.now() - start }, 'message-loop: Lauf beendet');
  return { skipped: false, properties: count };
}

let timer: NodeJS.Timeout | null = null;
export function startMessageLoop(intervalMinutes: number): void {
  if (timer) return;
  const base = intervalMinutes * 60_000;
  const tick = () => {
    void runMessageLoopOnce().catch((err) => logger.error({ err }, 'message-loop: unerwarteter Fehler'));
    timer = setTimeout(tick, Math.floor(base * (0.9 + Math.random() * 0.2))); // Jitter ±10 %
  };
  timer = setTimeout(tick, 60_000); // 60 s nach Start
  logger.info({ intervalMinutes }, '💬 Nachrichten-Loop gestartet');
}
export function stopMessageLoop(): void { if (timer) clearTimeout(timer); timer = null; }
```

`scheduler.ts`: in `startScheduler()` nach `state.running = true;` → `startMessageLoop(config.messageLoopMinutes);` (Import ergänzen); in der Stop-Funktion `stopMessageLoop()`.

`etl-job.ts`: die Nachrichten-Schritte (Hostex Step 3 Sync + Draft-Gen; Guesty Step 4 Sync + Draft-Gen) wie folgt kapseln:

```ts
    if (!messageSyncLock.tryAcquire('etl')) {
      logger.info({ slug: property.slug, holder: messageSyncLock.holder }, 'ETL: Nachrichten-Schritt übersprungen (Lock)');
    } else {
      try {
        /* bestehende try/catch-Blöcke Sync + generateDraftsForProperty unverändert */
      } finally { messageSyncLock.release(); }
    }
```

(Review-Drafts bleiben außerhalb des Locks.) `sync-guesty-messages.ts`: `limit: 50` → `limit: 100` in `fetchAllConversations`.

- [ ] **Step 4:** `npm test -- --run` grün. `npm run dev` kurz starten und im Log „Nachrichten-Loop gestartet" sehen, dann beenden.
- [ ] **Step 5: Commit** — `git add -A src/jobs && git commit -m "feat(auto-send): 5-min-Nachrichten-Loop mit Lock gegen ETL, Guesty-Liste limit=100"`

---

### Task 10: Guesty-Webhook (Signatur, Route, Inbound-Handler, Registrierung)

**Files:**
- Create: `src/services/guesty-webhook-signature.ts`, `src/routes/webhooks-guesty.ts`, `src/jobs/handle-guesty-inbound.ts`, `src/scripts/register-guesty-webhook.ts`
- Modify: `src/services/guesty-client.ts` (Webhook-Methoden + `getConversation`), `src/app.ts`, `package.json`
- Test: `src/services/guesty-webhook-signature.test.ts`, `src/routes/webhooks-guesty.test.ts`, `src/jobs/handle-guesty-inbound.test.ts`

**Interfaces:**
- Produces: `verifySvixSignature({ secret, msgId, timestamp, signatureHeader, rawBody, nowSec?, toleranceSec? }): boolean`; `createGuestyWebhookRouter(deps: { secret?: string; handleInbound: (payload: GuestyMessageWebhook) => Promise<void> })`; `handleGuestyInbound(payload, deps?)`; `guestyClient.listWebhooks()`, `createWebhook(url, events)`, `getWebhookSecret()`, `getConversation(id)`.

- [ ] **Step 1: Failing Tests — Signatur**

```ts
// src/services/guesty-webhook-signature.test.ts
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySvixSignature } from './guesty-webhook-signature.js';

const secretRaw = Buffer.from('supersecretkey1234567890');
const secret = `whsec_${secretRaw.toString('base64')}`;
const body = '{"event":"reservation.messageReceived"}';
const ts = '1758300000';
const sig = (b: string, t = ts) => `v1,${createHmac('sha256', secretRaw).update(`msg_1.${t}.${b}`).digest('base64')}`;

describe('verifySvixSignature', () => {
  const base = { secret, msgId: 'msg_1', timestamp: ts, rawBody: body, nowSec: 1758300010 };
  it('gültig', () => expect(verifySvixSignature({ ...base, signatureHeader: sig(body) })).toBe(true));
  it('mehrere Signaturen im Header, eine passt', () => expect(verifySvixSignature({ ...base, signatureHeader: `v1,abc ${sig(body)}` })).toBe(true));
  it('manipulierter Body', () => expect(verifySvixSignature({ ...base, rawBody: body + ' ', signatureHeader: sig(body) })).toBe(false));
  it('Zeitstempel zu alt', () => expect(verifySvixSignature({ ...base, nowSec: 1758300000 + 600, signatureHeader: sig(body) })).toBe(false));
  it('Secret ohne Präfix funktioniert ebenfalls', () => expect(verifySvixSignature({ ...base, secret: secretRaw.toString('base64'), signatureHeader: sig(body) })).toBe(true));
  it('fehlender Header → false', () => expect(verifySvixSignature({ ...base, signatureHeader: '' })).toBe(false));
});
```

- [ ] **Step 2: Implementieren — Signatur**

```ts
// src/services/guesty-webhook-signature.ts
// Guesty liefert Webhooks über Svix: Header svix-id, svix-timestamp, svix-signature
// ("v1,<base64> v1,<base64>"), HMAC-SHA256 über "<id>.<timestamp>.<rawBody>" mit dem
// base64-dekodierten Secret (Präfix "whsec_"). Toleranz 5 min gegen Replay.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySvixSignature(p: {
  secret: string; msgId: string; timestamp: string; signatureHeader: string; rawBody: string;
  nowSec?: number; toleranceSec?: number;
}): boolean {
  if (!p.secret || !p.msgId || !p.timestamp || !p.signatureHeader) return false;
  const now = p.nowSec ?? Math.floor(Date.now() / 1000);
  const ts = Number(p.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (p.toleranceSec ?? 300)) return false;
  const key = Buffer.from(p.secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${p.msgId}.${p.timestamp}.${p.rawBody}`).digest();
  for (const part of p.signatureHeader.split(' ')) {
    const [version, b64] = part.split(',');
    if (version !== 'v1' || !b64) continue;
    const given = Buffer.from(b64, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}
```

Test → PASS.

- [ ] **Step 3: Failing Tests — Route**

```ts
// src/routes/webhooks-guesty.test.ts
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { createHmac } from 'node:crypto';
import { createGuestyWebhookRouter } from './webhooks-guesty.js';

const secretRaw = Buffer.from('k'.repeat(24));
const secret = `whsec_${secretRaw.toString('base64')}`;
const payload = { event: 'reservation.messageReceived', reservationId: 'r1', conversation: { _id: 'c1', conversationWith: 'Guest' }, message: { type: 'fromGuest', body: 'Hi' } };

async function post(app: express.Express, body: string, headers: Record<string, string>) {
  const srv = app.listen(0); const port = (srv.address() as any).port;
  try { return await fetch(`http://127.0.0.1:${port}/api/webhooks/guesty`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }); }
  finally { srv.close(); }
}
function signed(body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'svix-id': 'm1', 'svix-timestamp': ts, 'svix-signature': `v1,${createHmac('sha256', secretRaw).update(`m1.${ts}.${body}`).digest('base64')}` };
}
function mkApp(secret?: string, handleInbound = vi.fn().mockResolvedValue(undefined)) {
  const app = express();
  app.use('/api/webhooks/guesty', express.raw({ type: '*/*', limit: '1mb' }), createGuestyWebhookRouter({ secret, handleInbound }));
  app.use(express.json());
  return { app, handleInbound };
}

describe('POST /api/webhooks/guesty', () => {
  it('202 + Handler bei gültiger Signatur und Gastnachricht', async () => {
    const body = JSON.stringify(payload); const { app, handleInbound } = mkApp(secret);
    const res = await post(app, body, signed(body));
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(handleInbound).toHaveBeenCalledWith(expect.objectContaining({ conversation: expect.objectContaining({ _id: 'c1' }) }));
  });
  it('401 bei falscher Signatur', async () => {
    const body = JSON.stringify(payload); const { app, handleInbound } = mkApp(secret);
    const res = await post(app, body, { ...signed(body), 'svix-signature': 'v1,nope' });
    expect(res.status).toBe(401); expect(handleInbound).not.toHaveBeenCalled();
  });
  it('503 ohne Secret', async () => {
    const body = JSON.stringify(payload); const { app } = mkApp(undefined);
    expect((await post(app, body, signed(body))).status).toBe(503);
  });
  it('202 ohne Handler bei Host-Nachricht', async () => {
    const body = JSON.stringify({ ...payload, message: { type: 'fromHost' } }); const { app, handleInbound } = mkApp(secret);
    expect((await post(app, body, signed(body))).status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(handleInbound).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Implementieren — Route**

```ts
// src/routes/webhooks-guesty.ts
// Guesty-Webhook reservation.messageReceived (Spec 3.1): Signatur prüfen, sofort 202,
// Verarbeitung asynchron. Muss mit express.raw() VOR express.json() gemountet sein (app.ts).
import express from 'express';
import { verifySvixSignature } from '../services/guesty-webhook-signature.js';
import logger from '../utils/logger.js';

export interface GuestyMessageWebhook {
  event: string; reservationId?: string;
  conversation: { _id: string; conversationWith?: string; meta?: any };
  message: { type?: string; body?: string; module?: string };
}
export function createGuestyWebhookRouter(deps: { secret?: string; handleInbound: (p: GuestyMessageWebhook) => Promise<void> }) {
  const router = express.Router();
  router.post('/', (req, res) => {
    if (!deps.secret) { res.status(503).json({ error: 'Webhook nicht konfiguriert (GUESTY_WEBHOOK_SECRET)' }); return; }
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const ok = verifySvixSignature({
      secret: deps.secret, msgId: String(req.header('svix-id') ?? ''), timestamp: String(req.header('svix-timestamp') ?? ''),
      signatureHeader: String(req.header('svix-signature') ?? ''), rawBody,
    });
    if (!ok) { logger.warn({ ip: req.ip }, 'guesty-webhook: ungültige Signatur'); res.status(401).json({ error: 'Ungültige Signatur' }); return; }
    let payload: GuestyMessageWebhook;
    try { payload = JSON.parse(rawBody); } catch { res.status(400).json({ error: 'Kein JSON' }); return; }
    res.status(202).json({ ok: true });
    const isGuest = (payload.conversation?.conversationWith ?? 'Guest') === 'Guest' && payload.message?.type === 'fromGuest';
    if (!isGuest || !payload.conversation?._id) return;
    setImmediate(() => {
      deps.handleInbound(payload).catch((err) => logger.error({ err: err instanceof Error ? err.message : String(err), conversationId: payload.conversation._id }, 'guesty-webhook: Verarbeitung fehlgeschlagen'));
    });
  });
  return router;
}
```

`app.ts`: direkt nach `app.set('trust proxy', 1); configureAuth();` und VOR `app.use(express.json())`:

```ts
  // Guesty-Webhook braucht den Rohkörper für die Svix-Signatur — vor express.json() mounten.
  app.use('/api/webhooks/guesty', express.raw({ type: '*/*', limit: '1mb' }),
    createGuestyWebhookRouter({ secret: config.guestyWebhookSecret, handleInbound: handleGuestyInbound }));
```

(Imports: `createGuestyWebhookRouter` aus `./routes/webhooks-guesty.js`, `handleGuestyInbound` aus `./jobs/handle-guesty-inbound.js`.) Beim App-Start einmalig loggen, wenn `config.guestyWebhookSecret` fehlt: `logger.warn('Guesty-Webhook inaktiv: GUESTY_WEBHOOK_SECRET fehlt — Poll bleibt das Netz')`.

Test → PASS.

- [ ] **Step 5: Failing Test — Inbound-Handler**

```ts
// src/jobs/handle-guesty-inbound.test.ts
import { describe, it, expect, vi } from 'vitest';
import { handleGuestyInbound, type InboundDeps } from './handle-guesty-inbound.js';
import type { PropertyConfig } from '../config/properties.js';

const props = [{ slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'G1' }, { slug: 'u19', provider: 'guesty', guestyPropertyId: 'G2' }] as PropertyConfig[];
const conv = { _id: 'c1', meta: { reservations: [{ listing: { _id: 'G2' } }] } };
function deps(over: Partial<InboundDeps> = {}): InboundDeps {
  return { getProperties: () => props, getConversation: vi.fn().mockResolvedValue(conv), syncGuesty: vi.fn().mockResolvedValue(undefined), generateDrafts: vi.fn().mockResolvedValue(undefined), ...over };
}

describe('handleGuestyInbound', () => {
  it('nutzt Payload-Konversation, synct nur das passende Objekt, dann Kette für genau diesen Thread', async () => {
    const d = deps();
    await handleGuestyInbound({ event: 'x', conversation: conv, message: { type: 'fromGuest' } }, d);
    expect(d.getConversation).not.toHaveBeenCalled();
    expect(d.syncGuesty).toHaveBeenCalledWith(props[1], [conv]);
    expect(d.generateDrafts).toHaveBeenCalledWith(props[1], ['guesty:c1']);
  });
  it('holt die Konversation nach, wenn das Payload keine Listing-Info hat', async () => {
    const d = deps();
    await handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d);
    expect(d.getConversation).toHaveBeenCalledWith('c1');
    expect(d.syncGuesty).toHaveBeenCalledTimes(1);
  });
  it('kein Objekt passt → nichts, kein Fehler', async () => {
    const d = deps({ getConversation: vi.fn().mockResolvedValue({ _id: 'c1', meta: { reservations: [{ listing: { _id: 'ZZ' } }] } }) });
    await handleGuestyInbound({ event: 'x', conversation: { _id: 'c1' }, message: { type: 'fromGuest' } }, d);
    expect(d.syncGuesty).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Implementieren — Handler + Client-Methoden**

```ts
// src/jobs/handle-guesty-inbound.ts
import { getAllProperties, type PropertyConfig } from '../config/properties.js';
import { guestyClient } from '../services/guesty-client.js';
import { syncGuestyMessagesForProperty } from './sync-guesty-messages.js';
import { generateDraftsForProperty } from './generate-drafts.js';
import { messageSyncLock } from './message-loop.js';
import type { GuestyMessageWebhook } from '../routes/webhooks-guesty.js';
import logger from '../utils/logger.js';

export interface InboundDeps {
  getProperties: () => PropertyConfig[];
  getConversation: (id: string) => Promise<any>;
  syncGuesty: (p: PropertyConfig, convs: any[]) => Promise<unknown>;
  generateDrafts: (p: PropertyConfig, onlyThreadIds: string[]) => Promise<unknown>;
}
const realDeps: InboundDeps = {
  getProperties: getAllProperties,
  getConversation: (id) => guestyClient.getConversation(id),
  syncGuesty: (p, convs) => syncGuestyMessagesForProperty(p, convs, { deep: true }),
  generateDrafts: (p, ids) => generateDraftsForProperty(p, undefined, { onlyThreadIds: ids }),
};
const listingIdsOf = (conv: any): string[] => (conv?.meta?.reservations ?? []).map((r: any) => r?.listing?._id ?? r?.listingId).filter(Boolean);

export async function handleGuestyInbound(payload: GuestyMessageWebhook, deps: InboundDeps = realDeps): Promise<void> {
  let conv: any = payload.conversation;
  if (listingIdsOf(conv).length === 0) conv = await deps.getConversation(conv._id);
  const ids = listingIdsOf(conv);
  const property = deps.getProperties().find((p) => p.provider === 'guesty' && p.guestyPropertyId && ids.includes(p.guestyPropertyId));
  if (!property) { logger.warn({ conversationId: conv?._id, ids }, 'guesty-webhook: kein Objekt passt — Poll fängt es'); return; }
  // Kurz auf den Lock warten (max. 30 s), sonst dem Poll überlassen.
  for (let i = 0; i < 30 && !messageSyncLock.tryAcquire('webhook'); i++) await new Promise((r) => setTimeout(r, 1000));
  if (messageSyncLock.holder !== 'webhook') { logger.info({ conversationId: conv._id }, 'guesty-webhook: Lock belegt — Poll übernimmt'); return; }
  try {
    await deps.syncGuesty(property, [conv]);
    await deps.generateDrafts(property, [`guesty:${conv._id}`]);
  } finally { messageSyncLock.release(); }
}
```

`guesty-client.ts` (öffentliche Methoden, neben `sendConversationMessage`):

```ts
  async getConversation(conversationId: string): Promise<any> {
    const res = await this.request<any>(`/communication/conversations/${conversationId}`);
    return res?.data ?? res;
  }
  async listWebhooks(): Promise<any[]> {
    const res = await this.request<any>('/webhooks');
    return Array.isArray(res) ? res : res?.data ?? [];
  }
  async createWebhook(url: string, events: string[]): Promise<any> {
    return this.request<any>('/webhooks', { method: 'POST', body: JSON.stringify({ url, events }) });
  }
  async getWebhookSecret(): Promise<string> {
    const res = await this.request<any>('/webhooks-v2/secret');
    return res?.secret ?? res?.data?.secret ?? JSON.stringify(res);
  }
```

Registrierungs-Skript:

```ts
// src/scripts/register-guesty-webhook.ts
// Einmalig: npm run webhook:register — legt die Subscription an (falls nicht vorhanden) und gibt das Secret aus.
import { config } from '../config/index.js';
import { guestyClient } from '../services/guesty-client.js';

const url = `${config.baseUrl.replace(/\/$/, '')}/api/webhooks/guesty`;
const existing = await guestyClient.listWebhooks();
const hit = existing.find((w: any) => w.url === url);
if (hit) console.log(`Subscription existiert bereits: ${hit._id} (${(hit.events ?? []).join(',')})`);
else { const created = await guestyClient.createWebhook(url, ['reservation.messageReceived']); console.log(`Angelegt: ${created?._id ?? JSON.stringify(created)}`); }
console.log(`\nGUESTY_WEBHOOK_SECRET=${await guestyClient.getWebhookSecret()}`);
console.log('→ in die Server-.env eintragen und pm2 restart.');
process.exit(0);
```

`package.json`: `"webhook:register": "tsx src/scripts/register-guesty-webhook.ts"`.

- [ ] **Step 7:** `npm test -- --run` grün.
- [ ] **Step 8: Commit** — `git add -A src package.json && git commit -m "feat(auto-send): Guesty-Webhook (Svix-Signatur, Route, Inbound-Kette, Registrierungsskript)"`

---

### Task 11: Admin-UI — Ampel, Auswertungsseite, Pausen-Schalter

**Files:**
- Modify: `src/routes/messages.ts`, `src/routes/admin-layout.ts` (Nav-Eintrag)
- Test: `src/routes/messages.auto-send.test.ts`

**Interfaces:**
- Produces: `renderAutoBadge(draft)` (exportiert, rein), Route `GET /admin/messages/auto-send`, `POST /admin/messages/auto-send/pause` (Body `paused=1|0`).

- [ ] **Step 1: Failing Test (reine Render-Funktion)**

```ts
// src/routes/messages.auto-send.test.ts
import { describe, it, expect } from 'vitest';
import { renderAutoBadge } from './messages.js';
import type { MessageDraft } from '../types/messages.js';

const d = (o: Partial<MessageDraft>): MessageDraft => ({ id: 'x', thread_id: 't', provider: 'hostex', body: '', status: 'pending', generated_by: 'llm', send_attempts: 0, external_message_id: null, error: null, created_at: '', sent_at: null, model: null, auto_decision: null, auto_category: null, auto_flags: null, auto_reason: null, auto_mode: null, auto_judged_at: null, sent_by: null, sent_body_changed: null, ...o });

describe('renderAutoBadge', () => {
  it('ohne Entscheidung → leer', () => expect(renderAutoBadge(d({}))).toBe(''));
  it('automatisch gesendet → grün mit Uhrzeit', () => expect(renderAutoBadge(d({ status: 'sent', sent_by: 'auto', sent_at: '2026-09-19 13:05:00' }))).toContain('automatisch gesendet 13:05'));
  it('wait → gelb mit Grund', () => expect(renderAutoBadge(d({ auto_decision: 'wait', auto_reason: 'Kategorie Geld — nie automatisch' }))).toContain('wartet auf dich: Kategorie Geld'));
  it('shadow + auto → weiß „wäre automatisch"', () => expect(renderAutoBadge(d({ auto_decision: 'auto', auto_mode: 'shadow' }))).toContain('wäre automatisch gesendet worden'));
  it('escaped HTML im Grund', () => expect(renderAutoBadge(d({ auto_decision: 'wait', auto_reason: '<b>' }))).toContain('&lt;b&gt;'));
});
```

- [ ] **Step 2: Implementieren** — in `routes/messages.ts`:

```ts
export function renderAutoBadge(draft: MessageDraft): string {
  if (draft.status === 'sent' && draft.sent_by === 'auto') {
    return `<span class="badge" style="background:var(--color-forest);color:#fff;border:none">🟢 automatisch gesendet ${esc(fmtTime(draft.sent_at))}</span>`;
  }
  if (draft.auto_decision === 'wait') {
    return `<span class="badge" style="background:var(--color-amber);color:#fff;border:none">🟡 wartet auf dich: ${esc(draft.auto_reason)}</span>`;
  }
  if (draft.auto_decision === 'auto' && draft.auto_mode === 'shadow') {
    return `<span class="badge">⚪ wäre automatisch gesendet worden</span>`;
  }
  if (draft.auto_decision === 'auto' && draft.auto_mode === 'live' && draft.status === 'pending') {
    return `<span class="badge" style="background:var(--color-amber);color:#fff;border:none">🟡 Auto-Send steht aus</span>`;
  }
  return '';
}
```

Liste (`router.get('/')`): nach `draftBadge` → `const autoBadge = d ? renderAutoBadge(d) : '';` und in `thread-meta` vor `${codeBadge}` einfügen. Thread-Ansicht: über `draftBlock` ein Panel, wenn `draft?.auto_decision`:

```ts
  const autoPanel = draft?.auto_decision
    ? `<div class="section" style="border-left:4px solid var(--color-amber)">
         <strong>Auto-Send-Gate</strong> · Modus ${esc(draft.auto_mode)} · ${renderAutoBadge(draft)}
         <p class="subtitle" style="margin:6px 0 0">Kategorie: ${esc(draft.auto_category ?? '–')} · Flags: ${esc((JSON.parse(draft.auto_flags ?? '[]') as string[]).join(', ') || 'keine')}<br>${esc(draft.auto_reason)}</p>
         ${draft.auto_mode === 'shadow' ? '<p class="subtitle">Schattenphase — nichts wird ohne dich gesendet.</p>' : ''}
       </div>`
    : '';
```

(`${autoPanel}` vor `${draftBlock}` in `body`.) Auch der zuletzt gesendete Draft eines Threads soll das grüne Badge zeigen: dazu `getLastSentDraftByThread(threadId)` im Repository (`SELECT * FROM message_drafts WHERE thread_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`) und in der Thread-Ansicht `const lastSent = draft ? null : getLastSentDraftByThread(thread.id);` → Panel auch für `lastSent?.sent_by === 'auto'` rendern („automatisch gesendet um …, Grund: …").

Auswertungsseite + Pause (vor `router.get('/:threadId')` einfügen, sonst fängt die Thread-Route `auto-send` als threadId):

```ts
router.get('/auto-send', (_req, res) => {
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const s = getAutoSendStats(since30);
  const n = (v: number | null) => v ?? 0;
  const paused = getSchedulerState(PAUSE_KEY) === '1';
  const rate = n(s.shadowUnchanged) + n(s.shadowChanged) > 0 ? Math.round(100 * n(s.shadowUnchanged) / (n(s.shadowUnchanged) + n(s.shadowChanged))) : null;
  const todayCount = countAutoSentSince(startOfBerlinDayIso());
  const rows = listAutoDecisions(100).map((d) => `<tr>
      <td>${esc(fmtDate(d.created_at))}</td><td><a href="/admin/messages/${encodeURIComponent(d.thread_id)}">${esc(d.guest_name) || esc(d.thread_id)}</a></td>
      <td>${esc(d.auto_mode)}</td><td>${esc(d.auto_decision)}</td><td>${esc(d.auto_category ?? '')}</td><td>${esc(d.auto_reason)}</td>
      <td>${d.status === 'sent' ? (d.sent_by === 'auto' ? 'auto' : d.sent_body_changed ? 'Micha, geändert' : 'Micha, unverändert') : esc(d.status)}</td></tr>`).join('');
  const body = `<a class="back-link" href="/admin/messages">&larr; Nachrichten</a>
    <h1>Auto-Send</h1>
    <div class="section">
      <form method="POST" action="/admin/messages/auto-send/pause"><input type="hidden" name="paused" value="${paused ? 0 : 1}">
        <button type="submit" class="btn ${paused ? 'btn-primary' : 'btn-danger'}">${paused ? 'Auto-Send fortsetzen' : 'Auto-Send pausieren'}</button></form>
      <p class="subtitle">Env-Modus: <strong>${esc(config.autoSendMode)}</strong> · heute automatisch gesendet: ${todayCount}/${config.autoSendDailyCap}${paused ? ' · <strong>PAUSIERT</strong>' : ''}</p>
    </div>
    <div class="section"><h3>Letzte 30 Tage</h3>
      <p>Automatisch gesendet: <strong>${n(s.autoSent)}</strong> · warteten auf dich: <strong>${n(s.waited)}</strong></p>
      <p>Schatten: <strong>${n(s.shadowWouldAuto)}</strong> wären automatisch rausgegangen — davon von dir unverändert gesendet: <strong>${n(s.shadowUnchanged)}</strong>, geändert: <strong>${n(s.shadowChanged)}</strong>, verworfen: <strong>${n(s.shadowDiscarded)}</strong>
      ${rate !== null ? ` → <strong>${rate} % unverändert</strong> (Ziel ≥ 95 % bei ≥ 20 Fällen)` : ''}</p>
    </div>
    <div class="section" style="overflow-x:auto"><table class="table"><thead><tr><th>Zeit</th><th>Gast</th><th>Modus</th><th>Entscheidung</th><th>Kategorie</th><th>Grund</th><th>Ausgang</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  res.type('html').send(renderAdminPage({ title: 'Auto-Send', body, active: 'messages' }));
});

router.post('/auto-send/pause', express.urlencoded({ extended: true }), (req, res) => {
  setSchedulerState(PAUSE_KEY, req.body?.paused === '1' ? '1' : '0');
  res.redirect('/admin/messages/auto-send');
});
```

Imports in `messages.ts`: `getAutoSendStats, countAutoSentSince, listAutoDecisions, getLastSentDraftByThread` (Repository), `getSchedulerState, setSchedulerState`, `PAUSE_KEY` aus `../services/auto-send/runner.js`, `startOfBerlinDayIso`, `config`. Link „Auto-Send" neben „Vault-Vorschläge" in der `sync-bar` der Listenseite: `<a href="/admin/messages/auto-send" class="btn btn-ghost">Auto-Send</a>`.

- [ ] **Step 3:** `npm test -- --run` grün. `npm run dev`, `/admin/messages/auto-send` öffnen, Pause-Schalter zweimal klicken, Zustand prüfen.
- [ ] **Step 4: Commit** — `git add -A src/routes src/repositories && git commit -m "feat(auto-send): Ampel in Liste/Thread, Auswertungsseite, Pausen-Schalter"`

---

### Task 12: Agent-API — `/drafts/awaiting`, `/auto-send/stats`, `autoDecision`

**Files:**
- Modify: `src/routes/agent-api.ts`, `src/repositories/message-repository.ts` (`getThreadsUpdatedSince` liefert `auto_decision`)
- Test: `src/routes/agent-api.test.ts` (ergänzen; die bestehenden `vi.mock`s für `message-repository` um `getAwaitingDrafts`-Mock in `draft-repository` erweitern)

**Interfaces:**
- Produces: `GET /api/agent/drafts/awaiting?since=<ISO>&limit=<n>` → `{ drafts: [{ draftId, threadId, property, guestName, guestMessageExcerpt, reason, createdAt, adminUrl }] }`; `GET /api/agent/auto-send/stats?days=1` → `{ autoSent, waited, shadowWouldAuto, shadowUnchanged, shadowChanged, shadowDiscarded, shadowUnchangedRate }`; `threads[].autoDecision`.

- [ ] **Step 1: Failing Tests** (in `agent-api.test.ts`; Mock ergänzen):

```ts
vi.mock('../repositories/draft-repository.js', () => ({
  getAwaitingDrafts: vi.fn().mockReturnValue([{
    id: 'd1', thread_id: 'hostex:a', provider: 'hostex', status: 'pending', created_at: '2026-09-19 12:00:00',
    reason: 'Kategorie Sonderwunsch — nie automatisch', guest_name: 'Anna', listing_id: 'L1', source: 'hostex',
    last_guest_message: 'Könnten wir schon um 11 Uhr rein? Wir sind früh da.\nDanke!',
  }]),
  getAutoSendStats: vi.fn().mockReturnValue({ autoSent: 2, waited: 3, shadowWouldAuto: 10, shadowUnchanged: 9, shadowChanged: 1, shadowDiscarded: 0 }),
}));
// …
describe('GET /drafts/awaiting', () => {
  it('liefert wartende Entwürfe mit Auszug und Admin-URL', async () => {
    const res = await fetch(`${base}/drafts/awaiting?since=2026-09-19T00:00:00Z`, { headers: { 'X-Agent-Key': KEY } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drafts[0]).toMatchObject({ draftId: 'd1', threadId: 'hostex:a', guestName: 'Anna', reason: 'Kategorie Sonderwunsch — nie automatisch' });
    expect(body.drafts[0].guestMessageExcerpt).toBe('Könnten wir schon um 11 Uhr rein? Wir sind früh da.');
    expect(body.drafts[0].adminUrl).toMatch(/\/admin\/messages\/hostex%3Aa$/);
    expect(body.drafts[0].createdAt).toBe('2026-09-19T12:00:00.000Z');
  });
  it('400 bei ungültigem since', async () => {
    expect((await fetch(`${base}/drafts/awaiting?since=gestern`, { headers: { 'X-Agent-Key': KEY } })).status).toBe(400);
  });
});
describe('GET /auto-send/stats', () => {
  it('liefert Zähler + Quote', async () => {
    const body = await (await fetch(`${base}/auto-send/stats?days=1`, { headers: { 'X-Agent-Key': KEY } })).json();
    expect(body).toMatchObject({ autoSent: 2, waited: 3, shadowUnchangedRate: 90 });
  });
});
```

(`base`/`KEY` wie in den bestehenden Tests der Datei benennen.)

- [ ] **Step 2: Implementieren** — in `agent-api.ts`:

```ts
import { getAwaitingDrafts, getAutoSendStats } from '../repositories/draft-repository.js';

/** Ein Satz, max. 160 Zeichen, keine Zeilenumbrüche — für den Push-Text. */
export function guestExcerpt(text: string | null): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim();
  const firstSentence = oneLine.split(/(?<=[.!?])\s/)[0] ?? oneLine;
  return firstSentence.length > 160 ? `${firstSentence.slice(0, 157)}…` : firstSentence;
}
const sqliteToIso = (s: string) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).toISOString();

router.get('/drafts/awaiting', (req, res) => {
  try {
    let sinceIso = new Date(Date.now() - DEFAULT_THREADS_WINDOW_MS).toISOString();
    if (typeof req.query.since === 'string' && req.query.since) {
      const parsed = new Date(req.query.since);
      if (Number.isNaN(parsed.getTime())) throw new ValidationError('since muss ein gültiger ISO-Zeitstempel sein');
      sinceIso = parsed.toISOString();
    }
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : NaN;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50;
    const rows = getAwaitingDrafts(sinceIso, limit);
    res.json({
      drafts: rows.map((r) => ({
        draftId: r.id, threadId: r.thread_id,
        property: propertySummary(propertyForBadge({ source: r.source, listing_id: r.listing_id })),
        guestName: r.guest_name, guestMessageExcerpt: guestExcerpt(r.last_guest_message),
        reason: r.reason, createdAt: sqliteToIso(r.created_at),
        adminUrl: `${config.baseUrl.replace(/\/$/, '')}/admin/messages/${encodeURIComponent(r.thread_id)}`,
      })),
    });
  } catch (err) { handleError(res, err); }
});

router.get('/auto-send/stats', (req, res) => {
  try {
    const daysRaw = typeof req.query.days === 'string' ? Number(req.query.days) : 1;
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 1;
    const s = getAutoSendStats(new Date(Date.now() - days * 86400000).toISOString());
    const n = (v: number | null) => v ?? 0;
    const denom = n(s.shadowUnchanged) + n(s.shadowChanged);
    res.json({ autoSent: n(s.autoSent), waited: n(s.waited), shadowWouldAuto: n(s.shadowWouldAuto), shadowUnchanged: n(s.shadowUnchanged), shadowChanged: n(s.shadowChanged), shadowDiscarded: n(s.shadowDiscarded), shadowUnchangedRate: denom ? Math.round(100 * n(s.shadowUnchanged) / denom) : null });
  } catch (err) { handleError(res, err); }
});
```

(`config` importieren.) In `getThreadsUpdatedSince` (message-repository) ein Subselect ergänzen: `(SELECT d.auto_decision FROM message_drafts d WHERE d.thread_id = t.id ORDER BY d.created_at DESC LIMIT 1) AS auto_decision` und in `ThreadWithLastMessage` `auto_decision: 'auto' | 'wait' | null;`; in `/threads` `autoDecision: t.auto_decision ?? null` ausgeben.

- [ ] **Step 3:** `npm test -- --run` grün.
- [ ] **Step 4: Commit** — `git add -A src && git commit -m "feat(auto-send): Agent-API drafts/awaiting, auto-send/stats, autoDecision in threads"`

---

### Task 13: Doku im App-Repo + Merge

**Files:**
- Modify: `CLAUDE.md` (App), `.env.example` (bereits Task 2), `docs/vault-deployment.md` (Deploy-Schritte)

- [ ] **Step 1:** In `CLAUDE.md` Abschnitt „### Auto-Send-Gate (Migration 027, Spec 2026-09-19)" nach dem Gäste-Bewertungen-Abschnitt anlegen: Kurzbeschreibung Kette, Modus-Auflösung, Env-Variablen (`AUTO_SEND_MODE`, `AUTO_SEND_DAILY_CAP`, `MESSAGE_LOOP_MINUTES`, `JUDGE_MODEL`, `GUESTY_WEBHOOK_SECRET`), Dateien (`src/services/auto-send/*`, `message-loop.ts`, `webhooks-guesty.ts`), Agent-API-Endpunkte, `npm run test:judge` als Pflicht vor Prompt-Änderungen, `npm run webhook:register`, Pausen-Schalter, Hinweis „Webhook-Route vor express.json()". In der Env-Liste unten die fünf Variablen ergänzen; in der Key-Files-Liste die neuen Dateien.
- [ ] **Step 2:** In `docs/vault-deployment.md` Abschnitt „Auto-Send-Gate aktivieren": `git pull`, `npm run db:migrate`, `.env` ergänzen (`AUTO_SEND_MODE=shadow`), `pm2 restart`, `npm run webhook:register` → Secret in `.env` → erneut `pm2 restart`, Log auf „Nachrichten-Loop gestartet" prüfen.
- [ ] **Step 3:** `npm test -- --run` grün, `npm run build` fehlerfrei. Commit: `git commit -am "docs: Auto-Send-Gate in CLAUDE.md und Deploy-Doku"`.
- [ ] **Step 4:** `git checkout main && git merge --no-ff feat/auto-send-gate -m "Merge feat/auto-send-gate: Auto-Send-Gate, Nachrichten-Loop, Guesty-Webhook, Push-API (Spec 2026-09-19)"`. Noch NICHT deployen (Task 15).

---

### Task 14: TheBrain2 — Push-Watcher auf labs + Skills

**Files (TheBrain2):**
- Create: `tools/labs/draft-push.sh`, `tools/labs/units/claude-draft-push.service`, `tools/labs/units/claude-draft-push.timer`
- Modify: `tools/labs/install.sh`, `tools/labs/README.md`, `tools/labs/defaults.env`, `.claude/skills/standup/SKILL.md`, `.claude/skills/eingang/SKILL.md`

- [ ] **Step 1: Watcher-Skript**

```bash
#!/bin/bash
# Push-Watcher fuer wartende Gaeste-Entwuerfe (Spec guesty-calendar-app
# docs/superpowers/specs/2026-09-19-auto-send-gate-design.md, Abschnitt 7.3).
# Laeuft auf labs als User claude per systemd-Timer (claude-draft-push.timer, alle 2 Min,
# 07-23 Uhr). Fragt die Agent-API nach Entwuerfen, die auf Micha warten, und pusht je
# Treffer eine WhatsApp-Zeile ueber tools/push-micha-wa.sh. Cursor lokal in $LOG_DIR,
# NICHT im Repo. DRAFT_PUSH_DRY_RUN=1 loggt statt zu senden.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"
load_config
mkdir -p "$LOG_DIR"

LOCK_FILE="$LOG_DIR/draft-push.lock"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then log "draft-push: Lock gehalten, breche ab"; exit 0; fi

CURSOR_FILE="$LOG_DIR/draft-push-cursor.json"
DRY_RUN="${DRAFT_PUSH_DRY_RUN:-0}"
if [ -f "$CURSOR_FILE" ]; then
  SINCE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["since"])' "$CURSOR_FILE")"
else
  SINCE="$(date -u -d '-2 hours' +%Y-%m-%dT%H:%M:%SZ)"
fi

cd "$REPO"
if ! RESPONSE="$(tools/agent-api.sh GET "/drafts/awaiting?since=${SINCE}&limit=20" 2>>"$LOG_DIR/draft-push.log")"; then
  log "draft-push: Agent-API nicht erreichbar, Cursor bleibt $SINCE"; exit 0
fi

# Eine Zeile je Entwurf: <createdAt>\t<Pushtext>
LINES="$(printf '%s' "$RESPONSE" | python3 -c '
import json,sys
data=json.load(sys.stdin)
for d in data.get("drafts", []):
    prop=(d.get("property") or {}).get("shortCode") or (d.get("property") or {}).get("slug") or "?"
    name=(d.get("guestName") or "Gast").split(" ")[0]
    text=f"📩 Gast wartet · {prop} · {name}: „{d.get(\"guestMessageExcerpt\",\"\")}“ · Grund: {d.get(\"reason\",\"\")} · {d.get(\"adminUrl\",\"\")}"
    print(d["createdAt"] + "\t" + text.replace("\n"," "))
')"
[ -z "$LINES" ] && { log "draft-push: nichts Neues seit $SINCE"; exit 0; }

MAX_TS="$SINCE"; ALL_OK=1
while IFS=$'\t' read -r ts text; do
  [ -z "$ts" ] && continue
  if [ "$DRY_RUN" = "1" ]; then
    log "draft-push (dry-run): $text"
  elif tools/push-micha-wa.sh "$text" >>"$LOG_DIR/draft-push.log" 2>&1; then
    log "draft-push: gesendet ($ts)"
  else
    log "draft-push: FEHLER beim Push ($ts) - Cursor bleibt"; ALL_OK=0; break
  fi
  [[ "$ts" > "$MAX_TS" ]] && MAX_TS="$ts"
done <<< "$LINES"

if [ "$ALL_OK" = "1" ]; then
  printf '{"since": "%s"}\n' "$MAX_TS" > "$CURSOR_FILE"
  log "draft-push: Cursor -> $MAX_TS"
fi
```

Units:

```ini
# tools/labs/units/claude-draft-push.service
[Unit]
Description=Push-Watcher fuer wartende Gaeste-Entwuerfe (Auto-Send-Gate)

[Service]
Type=oneshot
WorkingDirectory=%h/Development/TheBrain2
Environment=TZ=Europe/Berlin
Environment="PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=%h/Development/TheBrain2/tools/labs/draft-push.sh
```

```ini
# tools/labs/units/claude-draft-push.timer
[Unit]
Description=Timer Push-Watcher (07:00-22:58, alle 2 Minuten)

[Timer]
OnCalendar=*-*-* 07..22:00/2 Europe/Berlin
AccuracySec=30s
Persistent=false

[Install]
WantedBy=timers.target
```

`install.sh`: `draft-push.sh` in die `chmod`-Zeile aufnehmen, `systemctl --user enable --now claude-draft-push.timer` ergänzen. `README.md`: Absatz „draft-push.sh" (Zweck, Takt, Cursor-Datei, Dry-Run, Log `draft-push.log`, manueller Lauf `systemctl --user start claude-draft-push.service`). `defaults.env`: `DRAFT_PUSH_DRY_RUN=0` mit Kommentar.

- [ ] **Step 2: Lokaler Trockenlauf** — vom Laptop: `DRAFT_PUSH_DRY_RUN=1 LOG_DIR=/tmp/dp tools/labs/draft-push.sh` (nutzt `.env`-Key gegen die Live-API; vor dem Deploy liefert die API 404 auf `/drafts/awaiting` → Skript muss sauber „nicht erreichbar" loggen und mit 0 enden). Nach dem Deploy (Task 15) erneut mit Dry-Run gegen echte Daten.
- [ ] **Step 3: Skills** — `standup/SKILL.md` Schritt 7 (Anfragen-Check) eine Zeile: „`tools/agent-api.sh GET "/auto-send/stats?days=1"` → eine Standup-Zeile „Auto-Send: N automatisch, M warteten, Schatten: K wären raus (X % unverändert)"; Einzelfälle nur im Admin-UI." `eingang/SKILL.md` Schritt 1 Gäste-Punkt ergänzen: „Entwürfe mit `autoDecision: wait` kommen bereits per WhatsApp-Push (Watcher labs) — im Sweep nur melden, nicht als neu behandeln."
- [ ] **Step 4: Commit (TheBrain2, main)** — `git add tools/labs .claude/skills/standup/SKILL.md .claude/skills/eingang/SKILL.md && git commit -m "labs: Push-Watcher für wartende Gäste-Entwürfe (#Task) + Standup/Eingang-Zeilen"`

---

### Task 15: Deploy im Schattenmodus, Watcher installieren, Wiki-Nachzug

- [ ] **Step 1: Server-Deploy** (`deploy@guesty.remoterepublic.com`, Ablauf wie `docs/vault-deployment.md`): `git pull`, `npm install`, `npm run build`, `npm run db:migrate`, `.env`: `AUTO_SEND_MODE=shadow`, `pm2 restart`, Log prüfen: „Nachrichten-Loop gestartet". Dann `npm run webhook:register` → Secret in `.env` → `pm2 restart`. Test: eigene Testnachricht über Airbnb an Farmhouse schicken (Test-Gast wie bei Schnitt 4) → binnen 1 min Entwurf mit Ampel im Admin-UI.
- [ ] **Step 2: Watcher auf labs** (User claude): `cd ~/Development/TheBrain2 && git pull && tools/labs/install.sh`; erster Lauf mit `DRAFT_PUSH_DRY_RUN=1 tools/labs/draft-push.sh` gegen echte Daten prüfen, dann Dry-Run aus, `systemctl --user list-timers` zeigt `claude-draft-push.timer`.
- [ ] **Step 3: Wiki-Nachzug (TheBrain2, Hauptsession, kein Subagent):**
  - `wiki/projekte/Gäste-Messaging-Automation.md`: unter Architektur-Entscheidungen den Bullet „Kein Rollout-Stufen-Flag … Per-Nachricht-Freigabe ist das Sicherungs-Gate" mit Datum als überholt markieren und neuen Bullet „**Auto-Send-Gate (Micha, 19.09.2026, revidiert 07.07.):** …" (Kette, drei Schichten, Modi, Schattenphase mit Kriterium, Push-Watcher, Spec-Pfad) ergänzen; Status-Abschnitt: „Schnitt 7 — Auto-Send-Gate: deployed im Schattenmodus <Datum>". `aktualisiert`, `quellen` erhöhen.
  - `wiki/prozesse/Gästekommunikation Grundsätze.md`: Satz „Kein Auto-Send — und nie für Check-in-kritische Infos" ersetzen durch „Auto-Send nur über das Gate (Kategorien Dank/Ankunftszeit/Playbook-Fakt/Check-in-Standard); Codes, Geld, Storno, Beschwerden, Sonderwünsche, Sicherheit immer mit Freigabe" mit Datum.
  - `wiki/prozesse/Systemstand.md`: Kommunikations-Kanäle: Push-Watcher labs (Timer 07–23, alle 2 min) + Gäste-Messaging-Zeile „Auto-Send-Gate im Schattenmodus seit <Datum>".
  - `index.md` (Einzeiler der Projektseite anpassen), `log.md`: `## [<Datum>] update | Auto-Send-Gate + Push-Watcher → [[Gäste-Messaging-Automation]], [[Gästekommunikation Grundsätze]], [[Systemstand]]`.
- [ ] **Step 4: Tasks in SmartTasks** (Projekt 15 Gäste-Messaging-Automation): (a) „Auto-Send Schattenphase auswerten" — Assignee Micha, Due +14 Tage, Beschreibung: Kriterium ≥ 20 auto-Fälle, ≥ 95 % unverändert, 0 problematisch; Reihenfolge des Scharfschaltens entscheiden. (b) „Judge-Fixtures durch anonymisierte echte Fälle ersetzen (≥ 2 je Kategorie)" — Assignee Claude, Due wie (a). (c) „Push-Zeitfenster 07–23 bestätigen" — Assignee Micha, Due +3 Tage.
- [ ] **Step 5: Commit TheBrain2** — `git add wiki index.md log.md && git commit -m "Auto-Send-Gate: Entscheidung revidiert, Schnitt 7 im Schattenmodus, Push-Watcher (Spec 19.09.2026)"`.

---

## Self-Review (durchgeführt beim Schreiben)

- **Spec-Abdeckung:** 3.1 Webhook → Task 10 · 3.2 Loop/limit=100/Lock → Task 9 · 4 Kette → Task 7+8 · 5.1 Judge → Task 4 · 5.2 Mechanik → Task 3 · 5.3 Policy/Modus/Limit/Pause → Task 2+5+7 · 6 Datenmodell → Task 1 (Abweichung 1: `scheduler_state` statt `app_settings`) · 7.1 UI → Task 11 · 7.2 Agent-API → Task 12 · 7.3 Watcher → Task 14 · 7.4 Standup → Task 14 · 8 Fehlerfälle → Tasks 5/7/9/10/14 · 9 Schattenphase → Task 11 (Auswertung) + 15 · 11 Tests → je Task · 12 offene Punkte → Task 15 Step 4.
- **Typ-Konsistenz geprüft:** `markDraftSent(id, externalId, sentBy)` (Task 1) ↔ `draft-send-service` (Task 6) ↔ Runner-Deps `send(..., 'auto')` (Task 7); `GateInput` (Task 7) ↔ `DraftGenDeps.gate` (Task 8); `generateDraftsForProperty(p, deps, { onlyThreadIds })` (Task 8) ↔ Inbound-Handler (Task 10); `getAwaitingDrafts` Felder (Task 1) ↔ Agent-API-Mapping (Task 12) ↔ Watcher-Python (Task 14: `property.shortCode`, `guestName`, `guestMessageExcerpt`, `reason`, `adminUrl`, `createdAt`).
- **Bekannte Unschärfen (im Task genannt):** Regex-Feinschliff Task 3 Step 4; Guesty-Antwortformen der Webhook-Endpunkte (`listWebhooks`/`getWebhookSecret`) sind defensiv geparst; Judge-Fixtures sind synthetisch bis Task 15 Step 4 (b).
