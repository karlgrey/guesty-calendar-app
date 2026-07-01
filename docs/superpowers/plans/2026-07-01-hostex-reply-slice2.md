# Hostex Reply — Schnitt 2 (KI-Entwürfe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Beim Sync für jeden antwort-bedürftigen Hostex-Thread automatisch einen KI-Entwurf (in Michas Stimme, aus Vault-Voice + Objektfakten + Verlauf) als `pending`-Draft erzeugen; im UI editierbar freigeben → senden. Kein Auto-Send.

**Architecture:** Neue Lese-Schicht `vault-knowledge` (liest `.md` aus `VAULT_PATH`), `draft-service` (baut Prompt → `callClaudeTool` → Antworttext), ein Sync-Job `generate-hostex-drafts` (in `runHostexETL`), DB-Erweiterung (`model`-Spalte, `getThreadsNeedingDraft`, `updateDraftBody`) und UI-Anpassungen in `messages.ts`. Alle externen Abhängigkeiten (Claude, Vault, DB-Reads) werden injiziert, damit Tests ohne Netz/echte Dateien laufen.

**Tech Stack:** TypeScript (ESM, `.js`-Specifier), Express, better-sqlite3, `@anthropic-ai/sdk` via bestehendem `callClaudeTool`, Vitest.

## Global Constraints

- **ESM-Imports mit `.js`-Endung**, auch in `.ts`.
- **Kein Auto-Send.** Generierung erzeugt ausschließlich `pending`-Drafts; Versand bleibt der explizite Freigabe-Klick aus Schnitt 1.
- **Non-fatal:** Draft-Generierung darf den ETL nie abbrechen; Jobfunktionen fangen intern und geben Ergebnisobjekte zurück (werfen nicht).
- **Feature-Gate:** Ohne `VAULT_PATH` (Config) oder ohne `vaultNote` (Property) oder bei fehlender Vault-Datei wird die Generierung sauber übersprungen (no-op, geloggt).
- **Nur Hostex** (Guesty-Send ist nicht gebaut). Generierung nur für `source='hostex'`.
- **Kein echter Claude-/Dateisystem-Zugriff in Tests** — Deps werden injiziert; DB-Tests nutzen `setDatabase(new Database(':memory:'))`.
- **Path-Traversal-Schutz:** `vaultNote` muss `^[A-Za-z0-9._-]+\.md$` erfüllen.
- Modell: `claude-sonnet-4-6` (bestehender `DEFAULT_MODEL`). Tests ausführen: `npx vitest run <pfad>`; voller Lauf `npx vitest run`; `npx tsc`; `npm run lint`.

---

## File Structure

- **Modify** `src/config/index.ts` — `vaultPath` (schema + rawConfig aus `VAULT_PATH`).
- **Modify** `src/config/properties.ts` — `vaultNote?: string` (Interface + Zod).
- **Modify** `data/properties.json` — `vaultNote` bei den 2 Hostex-Objekten.
- **Create** `src/services/vault-knowledge.ts` (+ `.test.ts`) — `loadVoice` / `loadPropertyFacts`.
- **Create** `src/db/migrations/019_add_draft_model.sql`.
- **Modify** `src/types/messages.ts` — `model` auf `MessageDraft`/`NewDraft`.
- **Modify** `src/repositories/draft-repository.ts` — `createDraft` schreibt `model`; neu `updateDraftBody`.
- **Modify** `src/repositories/message-repository.ts` — neu `getThreadsNeedingDraft`.
- **Create** `src/services/draft-service.ts` (+ `.test.ts`) — `generateDraftForThread`, `SUBMIT_REPLY_TOOL`, `DRAFT_MODEL`.
- **Create** `src/jobs/hostex/generate-hostex-drafts.ts` (+ `.test.ts`) — `generateDraftsForProperty`, `DRAFT_GEN_CAP`.
- **Modify** `src/jobs/etl-job.ts` — Aufruf in `runHostexETL`.
- **Modify** `src/routes/messages.ts` + `src/routes/admin-layout.ts` — Badge, editierbarer Draft, Send-mit-Edit, Regenerate-Route, `.btn-ghost`.

---

### Task 1: Config `VAULT_PATH` + Property `vaultNote`

**Files:**
- Modify: `src/config/index.ts`
- Modify: `src/config/properties.ts`
- Modify: `data/properties.json`
- Test: `src/config/properties.vault-note.test.ts`

**Interfaces:**
- Produces: `config.vaultPath: string | undefined`; `PropertyConfig.vaultNote?: string`.

- [ ] **Step 1: Failing test schreiben**

```typescript
// src/config/properties.vault-note.test.ts
import { describe, it, expect } from 'vitest';
import { getPropertiesByProvider } from './properties.js';

describe('hostex properties vaultNote mapping', () => {
  it('both hostex properties carry a vaultNote pointing at their vault file', () => {
    const hostex = getPropertiesByProvider('hostex');
    const bySlug = Object.fromEntries(hostex.map((p) => [p.slug, p.vaultNote]));
    expect(bySlug['bootshaus-alte-oder']).toBe('Bootshaus.md');
    expect(bySlug['alte-schilderwerkstatt']).toBe('Alte-Schilderwerkstatt.md');
  });
});
```

- [ ] **Step 2: Test ausführen — muss fehlschlagen**

Run: `npx vitest run src/config/properties.vault-note.test.ts`
Expected: FAIL (`vaultNote` ist `undefined` / Property-Feld existiert nicht).

- [ ] **Step 3: `PropertyConfig` erweitern**

In `src/config/properties.ts` im `interface PropertyConfig` (nach `name: string;`) ergänzen:

```typescript
  vaultNote?: string; // Dateiname der Objekt-Notiz im Vault (Areas/Hosting/Properties/<vaultNote>)
```

Im Zod-Schema für Properties (neben `name: z.string().min(1),`) ergänzen:

```typescript
  vaultNote: z.string().optional(),
```

- [ ] **Step 4: `data/properties.json` ergänzen**

Bei der Property mit `"slug": "bootshaus-alte-oder"` das Feld hinzufügen:

```json
  "vaultNote": "Bootshaus.md",
```

Bei `"slug": "alte-schilderwerkstatt"`:

```json
  "vaultNote": "Alte-Schilderwerkstatt.md",
```

- [ ] **Step 5: `config.vaultPath` ergänzen**

In `src/config/index.ts` im `configSchema` (bei den anderen optionalen Strings) ergänzen:

```typescript
  vaultPath: z.string().optional(),
```

Im `rawConfig`-Objekt (bei den anderen `process.env`-Zuordnungen) ergänzen:

```typescript
    vaultPath: process.env.VAULT_PATH,
```

- [ ] **Step 6: Test grün + Lint**

Run: `npx vitest run src/config/properties.vault-note.test.ts`
Expected: PASS.
Run: `npm run lint`
Expected: keine neuen Fehler.

- [ ] **Step 7: Commit**

```bash
git add src/config/index.ts src/config/properties.ts data/properties.json src/config/properties.vault-note.test.ts
git commit -m "feat(config): VAULT_PATH config + vaultNote per property"
```

---

### Task 2: `vault-knowledge.ts` — Voice + Objektfakten lesen

**Files:**
- Create: `src/services/vault-knowledge.ts`
- Test: `src/services/vault-knowledge.test.ts`

**Interfaces:**
- Consumes: `config.vaultPath` (Task 1).
- Produces:
  - `loadVoice(baseDir?: string | undefined): string | null`
  - `loadPropertyFacts(vaultNote: string, baseDir?: string | undefined): string | null`
  - Beide default `baseDir = config.vaultPath`. `null` bei fehlendem Pfad, unsicherem `vaultNote` oder fehlender Datei.

- [ ] **Step 1: Failing test schreiben**

```typescript
// src/services/vault-knowledge.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVoice, loadPropertyFacts } from './vault-knowledge.js';

let base: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'vault-'));
  mkdirSync(join(base, 'Areas/Hosting/Properties'), { recursive: true });
  writeFileSync(join(base, 'Areas/Hosting/_Voice.md'), 'VOICE-TEXT');
  writeFileSync(join(base, 'Areas/Hosting/Properties/Bootshaus.md'), 'BOOTSHAUS-FACTS');
});
afterAll(() => { rmSync(base, { recursive: true, force: true }); });

describe('vault-knowledge', () => {
  it('reads voice and property facts from the vault base dir', () => {
    expect(loadVoice(base)).toBe('VOICE-TEXT');
    expect(loadPropertyFacts('Bootshaus.md', base)).toBe('BOOTSHAUS-FACTS');
  });

  it('returns null when base dir is undefined (feature off)', () => {
    expect(loadVoice(undefined)).toBeNull();
    expect(loadPropertyFacts('Bootshaus.md', undefined)).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(loadPropertyFacts('DoesNotExist.md', base)).toBeNull();
  });

  it('rejects path-traversal / non-simple note names', () => {
    expect(loadPropertyFacts('../secret.md', base)).toBeNull();
    expect(loadPropertyFacts('sub/dir.md', base)).toBeNull();
    expect(loadPropertyFacts('Bootshaus.txt', base)).toBeNull();
  });
});
```

- [ ] **Step 2: Test ausführen — muss fehlschlagen**

Run: `npx vitest run src/services/vault-knowledge.test.ts`
Expected: FAIL (`Failed to resolve import './vault-knowledge.js'`).

- [ ] **Step 3: Implementieren**

```typescript
// src/services/vault-knowledge.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const HOSTING_DIR = 'Areas/Hosting';
const SAFE_NOTE = /^[A-Za-z0-9._-]+\.md$/;

function readVaultFile(relPath: string, baseDir: string | undefined): string | null {
  if (!baseDir) return null;
  try {
    return readFileSync(join(baseDir, relPath), 'utf8');
  } catch {
    logger.debug({ relPath }, 'vault-knowledge: file not readable (skipping)');
    return null;
  }
}

export function loadVoice(baseDir: string | undefined = config.vaultPath): string | null {
  return readVaultFile(join(HOSTING_DIR, '_Voice.md'), baseDir);
}

export function loadPropertyFacts(
  vaultNote: string,
  baseDir: string | undefined = config.vaultPath,
): string | null {
  if (!SAFE_NOTE.test(vaultNote)) {
    logger.warn({ vaultNote }, 'vault-knowledge: unsafe vaultNote rejected');
    return null;
  }
  return readVaultFile(join(HOSTING_DIR, 'Properties', vaultNote), baseDir);
}
```

- [ ] **Step 4: Test grün + Lint**

Run: `npx vitest run src/services/vault-knowledge.test.ts`
Expected: PASS (4 Tests).
Run: `npm run lint`
Expected: keine neuen Fehler.

- [ ] **Step 5: Commit**

```bash
git add src/services/vault-knowledge.ts src/services/vault-knowledge.test.ts
git commit -m "feat(vault): vault-knowledge reader for voice + property facts"
```

---

### Task 3: DB/Repo — `model`-Spalte, `updateDraftBody`, `getThreadsNeedingDraft`

**Files:**
- Create: `src/db/migrations/019_add_draft_model.sql`
- Modify: `src/types/messages.ts`
- Modify: `src/repositories/draft-repository.ts`
- Modify: `src/repositories/message-repository.ts`
- Test: `src/repositories/draft-repository.model.test.ts`, `src/repositories/message-repository.needs-draft.test.ts`

**Interfaces:**
- Produces:
  - `MessageDraft.model: string | null`; `NewDraft` erlaubt optional `model?: string | null`.
  - `updateDraftBody(id: string, body: string): void`
  - `getThreadsNeedingDraft(listingId: string, limit: number): MessageThread[]`

- [ ] **Step 1: Migration schreiben**

```sql
-- Migration: add model column to message_drafts
-- Created: 2026-07-01
--
-- Records which LLM produced an llm-generated draft (null for manual drafts).

ALTER TABLE message_drafts ADD COLUMN model TEXT;
```

- [ ] **Step 2: Typen erweitern (`src/types/messages.ts`)**

Im `interface MessageDraft` ergänzen (nach `generated_by`):

```typescript
  model: string | null;
```

`NewDraft` ändern zu:

```typescript
export type NewDraft = Pick<MessageDraft, 'id' | 'thread_id' | 'provider' | 'body' | 'generated_by'> & {
  model?: string | null;
};
```

- [ ] **Step 3: Failing tests schreiben**

```typescript
// src/repositories/draft-repository.model.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { createDraft, getDraftById, updateDraftBody } from './draft-repository.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE message_drafts (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider TEXT NOT NULL,
    body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    generated_by TEXT NOT NULL DEFAULT 'manual', send_attempts INTEGER NOT NULL DEFAULT 0,
    external_message_id TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT, model TEXT
  );`);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('draft-repository model + updateDraftBody', () => {
  it('stores model on llm drafts and null when omitted', () => {
    createDraft({ id: 'd1', thread_id: 't1', provider: 'hostex', body: 'x', generated_by: 'llm', model: 'claude-sonnet-4-6' });
    createDraft({ id: 'd2', thread_id: 't2', provider: 'hostex', body: 'y', generated_by: 'manual' });
    expect(getDraftById('d1')?.model).toBe('claude-sonnet-4-6');
    expect(getDraftById('d2')?.model).toBeNull();
  });

  it('updateDraftBody replaces the body', () => {
    createDraft({ id: 'd3', thread_id: 't3', provider: 'hostex', body: 'old', generated_by: 'llm', model: 'm' });
    updateDraftBody('d3', 'new');
    expect(getDraftById('d3')?.body).toBe('new');
  });
});
```

```typescript
// src/repositories/message-repository.needs-draft.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getThreadsNeedingDraft } from './message-repository.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE message_threads (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, source TEXT NOT NULL, channel TEXT NOT NULL,
      guest_name TEXT, guest_email TEXT, first_message_at TEXT NOT NULL, last_message_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0, reservation_id TEXT, inquiry_id TEXT, reservation_status TEXT,
      conversion_category TEXT, classification_confidence REAL, classification_keywords TEXT,
      raw_meta TEXT, last_synced_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, direction TEXT NOT NULL, sent_at TEXT NOT NULL,
      from_name TEXT, from_address TEXT, to_address TEXT, subject TEXT, body TEXT NOT NULL, body_html TEXT,
      source TEXT NOT NULL, raw_meta TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE message_drafts (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', generated_by TEXT NOT NULL DEFAULT 'manual',
      send_attempts INTEGER NOT NULL DEFAULT 0, external_message_id TEXT, error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT, model TEXT
    );
  `);
  setDatabase(db);
  const t = db.prepare(`INSERT INTO message_threads (id,listing_id,source,channel,first_message_at,last_message_at,last_synced_at) VALUES (?,?,?,?,?,?,?)`);
  t.run('hostex:a', 'L1', 'hostex', 'airbnb', 't', '2026-06-30T10:00Z', 'now'); // inbound-latest, no draft -> needs draft
  t.run('hostex:b', 'L1', 'hostex', 'airbnb', 't', '2026-06-30T11:00Z', 'now'); // inbound-latest, HAS pending draft -> excluded
  t.run('hostex:c', 'L1', 'hostex', 'airbnb', 't', '2026-06-30T09:00Z', 'now'); // outbound-latest -> excluded
  t.run('hostex:d', 'L2', 'hostex', 'airbnb', 't', '2026-06-30T12:00Z', 'now'); // other listing -> excluded by filter
  const m = db.prepare(`INSERT INTO messages (id,thread_id,direction,sent_at,body,source) VALUES (?,?,?,?,?,?)`);
  m.run('m1', 'hostex:a', 'inbound', '2026-06-30T10:00Z', 'q', 'hostex');
  m.run('m2', 'hostex:b', 'inbound', '2026-06-30T11:00Z', 'q', 'hostex');
  m.run('m3', 'hostex:c', 'inbound', '2026-06-30T08:00Z', 'q', 'hostex');
  m.run('m4', 'hostex:c', 'outbound', '2026-06-30T09:00Z', 'a', 'hostex');
  m.run('m5', 'hostex:d', 'inbound', '2026-06-30T12:00Z', 'q', 'hostex');
  db.prepare(`INSERT INTO message_drafts (id,thread_id,provider,body,status,generated_by) VALUES ('dp','hostex:b','hostex','draft','pending','llm')`).run();
});
afterEach(() => { resetDatabase(); db.close(); });

describe('getThreadsNeedingDraft', () => {
  it('returns L1 hostex threads with inbound-latest and no pending draft, respecting limit', () => {
    expect(getThreadsNeedingDraft('L1', 10).map((t) => t.id)).toEqual(['hostex:a']);
  });
  it('respects the limit', () => {
    expect(getThreadsNeedingDraft('L1', 0).length).toBe(0);
  });
});
```

- [ ] **Step 4: Tests ausführen — müssen fehlschlagen**

Run: `npx vitest run src/repositories/draft-repository.model.test.ts src/repositories/message-repository.needs-draft.test.ts`
Expected: FAIL (`updateDraftBody` / `getThreadsNeedingDraft` nicht definiert; `model` nicht gespeichert).

- [ ] **Step 5: `draft-repository.ts` anpassen**

`createDraft` ersetzen durch:

```typescript
export function createDraft(d: NewDraft): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO message_drafts (id, thread_id, provider, body, generated_by, model)
     VALUES (@id, @thread_id, @provider, @body, @generated_by, @model)`,
  ).run({ ...d, model: d.model ?? null });
}
```

Danach anhängen:

```typescript
export function updateDraftBody(id: string, body: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE message_drafts SET body = ? WHERE id = ?`).run(body, id);
}
```

- [ ] **Step 6: `message-repository.ts` erweitern**

Anhängen (Import `MessageThread` ggf. schon vorhanden):

```typescript
export function getThreadsNeedingDraft(listingId: string, limit: number): MessageThread[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT t.* FROM message_threads t
       WHERE t.source = 'hostex' AND t.listing_id = ?
         AND (
           SELECT m.direction FROM messages m
           WHERE m.thread_id = t.id
           ORDER BY m.sent_at DESC, m.created_at DESC LIMIT 1
         ) = 'inbound'
         AND NOT EXISTS (
           SELECT 1 FROM message_drafts d WHERE d.thread_id = t.id AND d.status = 'pending'
         )
       ORDER BY t.last_message_at DESC
       LIMIT ?`,
    )
    .all(listingId, limit) as MessageThread[];
}
```

- [ ] **Step 7: Tests grün + Migration smoke + Lint**

Run: `npx vitest run src/repositories/draft-repository.model.test.ts src/repositories/message-repository.needs-draft.test.ts`
Expected: PASS.
Run: `npm run db:migrate`
Expected: Migration 019 angewandt, keine Fehler.
Run: `npm run lint`
Expected: keine neuen Fehler.

- [ ] **Step 8: Commit**

```bash
git add src/db/migrations/019_add_draft_model.sql src/types/messages.ts src/repositories/draft-repository.ts src/repositories/message-repository.ts src/repositories/draft-repository.model.test.ts src/repositories/message-repository.needs-draft.test.ts
git commit -m "feat(drafts): model column, updateDraftBody, getThreadsNeedingDraft"
```

---

### Task 4: `draft-service.ts` — Entwurf via Claude

**Files:**
- Create: `src/services/draft-service.ts`
- Test: `src/services/draft-service.test.ts`

**Interfaces:**
- Consumes: `callClaudeTool`, `ClaudeToolDefinition` aus `./anthropic-client.js`; `MessageThread`, `Message` aus `../types/messages.js`.
- Produces:
  - `DRAFT_MODEL = 'claude-sonnet-4-6'`
  - `SUBMIT_REPLY_TOOL: ClaudeToolDefinition`
  - `interface DraftInput { thread: MessageThread; messages: Message[]; voice: string; facts: string }`
  - `interface DraftDeps { call: typeof callClaudeTool }`
  - `generateDraftForThread(input: DraftInput, deps?: DraftDeps): Promise<string | null>`

> **Hinweis:** `ClaudeToolDefinition` liegt in `src/services/anthropic-client.ts` (Felder `name`, `description`, `input_schema`). `SUBMIT_REPLY_TOOL` exakt an diese Typform anpassen (an einem bestehenden Tool-Objekt im Code orientieren, z. B. im Message-Classifier).

- [ ] **Step 1: Failing test schreiben**

```typescript
// src/services/draft-service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { generateDraftForThread } from './draft-service.js';
import type { MessageThread, Message } from '../types/messages.js';

function thread(): MessageThread {
  return {
    id: 'hostex:c1', listing_id: 'L', source: 'hostex', channel: 'airbnb', guest_name: 'Darleen',
    guest_email: null, first_message_at: '', last_message_at: '', message_count: 1, reservation_id: null,
    inquiry_id: null, reservation_status: null, conversion_category: null, classification_confidence: null,
    classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0,
    manual_note: null, linked_thread_id: null, last_synced_at: '',
  };
}
const messages: Message[] = [
  { id: 'm1', thread_id: 'hostex:c1', direction: 'inbound', sent_at: '2026-06-30T10:00Z', from_name: 'Darleen', from_address: null, to_address: null, subject: null, body: 'Kann ich früher einchecken?', body_html: null, source: 'hostex', raw_meta: null },
];

describe('generateDraftForThread', () => {
  it('passes voice+facts into the system prompt and returns the reply', async () => {
    const call = vi.fn().mockResolvedValue({ reply: 'Hallo Darleen, gern!' });
    const out = await generateDraftForThread({ thread: thread(), messages, voice: 'VOICE-X', facts: 'FACTS-Y' }, { call });
    expect(out).toBe('Hallo Darleen, gern!');
    const arg = call.mock.calls[0][0];
    expect(arg.systemPrompt).toContain('VOICE-X');
    expect(arg.systemPrompt).toContain('FACTS-Y');
    expect(arg.userMessage).toContain('Kann ich früher einchecken?');
  });

  it('returns null on an empty/malformed reply', async () => {
    const call = vi.fn().mockResolvedValue({ reply: '   ' });
    expect(await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call })).toBeNull();
    const call2 = vi.fn().mockResolvedValue({});
    expect(await generateDraftForThread({ thread: thread(), messages, voice: 'v', facts: 'f' }, { call: call2 })).toBeNull();
  });
});
```

- [ ] **Step 2: Test ausführen — muss fehlschlagen**

Run: `npx vitest run src/services/draft-service.test.ts`
Expected: FAIL (`Failed to resolve import './draft-service.js'`).

- [ ] **Step 3: Implementieren**

```typescript
// src/services/draft-service.ts
import { callClaudeTool, type ClaudeToolDefinition } from './anthropic-client.js';
import type { MessageThread, Message } from '../types/messages.js';

export const DRAFT_MODEL = 'claude-sonnet-4-6';

export const SUBMIT_REPLY_TOOL: ClaudeToolDefinition = {
  name: 'submit_reply',
  description: 'Gib die fertige Antwort an den Gast zurück (nur den Nachrichtentext).',
  input_schema: {
    type: 'object',
    properties: { reply: { type: 'string', description: 'Die fertige Gastantwort in Michas Stimme.' } },
    required: ['reply'],
  },
};

export interface DraftInput {
  thread: MessageThread;
  messages: Message[];
  voice: string;
  facts: string;
}
export interface DraftDeps {
  call: typeof callClaudeTool;
}
const defaultDeps: DraftDeps = { call: callClaudeTool };

function buildSystemPrompt(voice: string, facts: string): string {
  return [
    'Du entwirfst eine Antwort auf eine Gastnachricht für eine Ferienunterkunft, in Michas Stimme.',
    'Halte dich strikt an den folgenden Ton/Stil (Voice):',
    '--- VOICE ---', voice, '--- ENDE VOICE ---',
    'Nutze ausschließlich die folgenden Objektfakten. Erfinde nichts; fehlt ein Fakt, bleib allgemein.',
    '--- OBJEKTWISSEN ---', facts, '--- ENDE OBJEKTWISSEN ---',
    'Regeln: Kein Auto-Versand von Zugangscodes. Antworte in der Sprache des Gastes (Default Deutsch). Kurz und konkret.',
    'Gib die Antwort über das Tool submit_reply zurück (nur den Nachrichtentext, keine Anrede-Meta).',
  ].join('\n');
}

function buildConversation(messages: Message[]): string {
  const lines = messages.map((m) => {
    const who = m.direction === 'inbound' ? 'Gast' : m.direction === 'outbound' ? 'Host' : 'System';
    return `${who}: ${m.body}`;
  });
  return `Bisheriger Verlauf (chronologisch), beantworte die letzte Gastnachricht:\n${lines.join('\n')}`;
}

export async function generateDraftForThread(
  input: DraftInput,
  deps: DraftDeps = defaultDeps,
): Promise<string | null> {
  const out = await deps.call({
    systemPrompt: buildSystemPrompt(input.voice, input.facts),
    userMessage: buildConversation(input.messages),
    tool: SUBMIT_REPLY_TOOL,
    model: DRAFT_MODEL,
  });
  const reply = (out as { reply?: unknown } | null)?.reply;
  return typeof reply === 'string' && reply.trim() ? reply.trim() : null;
}
```

- [ ] **Step 4: Test grün + Lint**

Run: `npx vitest run src/services/draft-service.test.ts`
Expected: PASS (2 Tests).
Run: `npm run lint`
Expected: keine neuen Fehler.

- [ ] **Step 5: Commit**

```bash
git add src/services/draft-service.ts src/services/draft-service.test.ts
git commit -m "feat(drafts): draft-service generates a reply via Claude (injectable)"
```

---

### Task 5: Auto-Trigger-Job + ETL-Verdrahtung

**Files:**
- Create: `src/jobs/hostex/generate-hostex-drafts.ts`
- Modify: `src/jobs/etl-job.ts`
- Test: `src/jobs/hostex/generate-hostex-drafts.test.ts`

**Interfaces:**
- Consumes: `getThreadsNeedingDraft`, `getMessagesByThread` (message-repository); `createDraft` (draft-repository); `loadVoice`, `loadPropertyFacts` (vault-knowledge); `generateDraftForThread`, `DRAFT_MODEL` (draft-service); `PropertyConfig`.
- Produces:
  - `DRAFT_GEN_CAP = 10`
  - `interface DraftGenDeps { getThreads; getMessages; loadVoice; loadFacts; generate; create }` (Signaturen s. Code)
  - `generateDraftsForProperty(property: PropertyConfig, deps?: DraftGenDeps): Promise<{ generated: number; skipped: number }>`

- [ ] **Step 1: Failing test schreiben**

```typescript
// src/jobs/hostex/generate-hostex-drafts.test.ts
import { describe, it, expect, vi } from 'vitest';
import { generateDraftsForProperty, DRAFT_GEN_CAP, type DraftGenDeps } from './generate-hostex-drafts.js';
import type { PropertyConfig } from '../../config/properties.js';
import type { MessageThread } from '../../types/messages.js';

function mkThread(id: string): MessageThread {
  return {
    id, listing_id: 'L1', source: 'hostex', channel: 'airbnb', guest_name: 'G', guest_email: null,
    first_message_at: '', last_message_at: '', message_count: 1, reservation_id: null, inquiry_id: null,
    reservation_status: null, conversion_category: null, classification_confidence: null,
    classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0,
    manual_note: null, linked_thread_id: null, last_synced_at: '',
  };
}
const property = { slug: 'bootshaus', hostexPropertyId: 'L1', vaultNote: 'Bootshaus.md' } as unknown as PropertyConfig;

function deps(over: Partial<DraftGenDeps> = {}): DraftGenDeps {
  return {
    getThreads: vi.fn().mockReturnValue([mkThread('hostex:a'), mkThread('hostex:b')]),
    getMessages: vi.fn().mockReturnValue([]),
    loadVoice: vi.fn().mockReturnValue('VOICE'),
    loadFacts: vi.fn().mockReturnValue('FACTS'),
    generate: vi.fn().mockResolvedValue('REPLY'),
    create: vi.fn(),
    ...over,
  };
}

describe('generateDraftsForProperty', () => {
  it('creates one draft per needing-reply thread and reports counts', async () => {
    const d = deps();
    const res = await generateDraftsForProperty(property, d);
    expect(res).toEqual({ generated: 2, skipped: 0 });
    expect(d.create).toHaveBeenCalledTimes(2);
    expect((d.getThreads as any)).toHaveBeenCalledWith('L1', DRAFT_GEN_CAP);
  });

  it('skips a thread when generate returns null', async () => {
    const d = deps({ generate: vi.fn().mockResolvedValueOnce('REPLY').mockResolvedValueOnce(null) });
    const res = await generateDraftsForProperty(property, d);
    expect(res).toEqual({ generated: 1, skipped: 1 });
    expect(d.create).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when voice or facts are missing', async () => {
    const d = deps({ loadFacts: vi.fn().mockReturnValue(null) });
    const res = await generateDraftsForProperty(property, d);
    expect(res).toEqual({ generated: 0, skipped: 0 });
    expect(d.getThreads).not.toHaveBeenCalled();
  });

  it('is a no-op when the property has no vaultNote or hostexPropertyId', async () => {
    const d = deps();
    const bad = { slug: 'x', hostexPropertyId: 'L1' } as unknown as PropertyConfig;
    expect(await generateDraftsForProperty(bad, d)).toEqual({ generated: 0, skipped: 0 });
    expect(d.loadVoice).not.toHaveBeenCalled();
  });

  it('does not throw if generate rejects (counts as skipped)', async () => {
    const d = deps({ generate: vi.fn().mockRejectedValue(new Error('claude down')) });
    const res = await generateDraftsForProperty(property, d);
    expect(res.generated).toBe(0);
    expect(res.skipped).toBe(2);
  });
});
```

- [ ] **Step 2: Test ausführen — muss fehlschlagen**

Run: `npx vitest run src/jobs/hostex/generate-hostex-drafts.test.ts`
Expected: FAIL (`Failed to resolve import './generate-hostex-drafts.js'`).

- [ ] **Step 3: Implementieren**

```typescript
// src/jobs/hostex/generate-hostex-drafts.ts
import { randomUUID } from 'node:crypto';
import { getThreadsNeedingDraft, getMessagesByThread } from '../../repositories/message-repository.js';
import { createDraft } from '../../repositories/draft-repository.js';
import { loadVoice, loadPropertyFacts } from '../../services/vault-knowledge.js';
import { generateDraftForThread, DRAFT_MODEL } from '../../services/draft-service.js';
import type { MessageThread, Message, NewDraft } from '../../types/messages.js';
import type { PropertyConfig } from '../../config/properties.js';
import logger from '../../utils/logger.js';

export const DRAFT_GEN_CAP = 10;

export interface DraftGenDeps {
  getThreads: (listingId: string, limit: number) => MessageThread[];
  getMessages: (threadId: string) => Message[];
  loadVoice: () => string | null;
  loadFacts: (vaultNote: string) => string | null;
  generate: (input: { thread: MessageThread; messages: Message[]; voice: string; facts: string }) => Promise<string | null>;
  create: (d: NewDraft) => void;
}

const realDeps: DraftGenDeps = {
  getThreads: getThreadsNeedingDraft,
  getMessages: getMessagesByThread,
  loadVoice: () => loadVoice(),
  loadFacts: (vaultNote) => loadPropertyFacts(vaultNote),
  generate: (input) => generateDraftForThread(input),
  create: createDraft,
};

export async function generateDraftsForProperty(
  property: PropertyConfig,
  deps: DraftGenDeps = realDeps,
): Promise<{ generated: number; skipped: number }> {
  if (!property.hostexPropertyId || !property.vaultNote) return { generated: 0, skipped: 0 };
  const voice = deps.loadVoice();
  const facts = deps.loadFacts(property.vaultNote);
  if (!voice || !facts) {
    logger.info({ slug: property.slug }, 'draft-gen: voice/facts missing — skipping');
    return { generated: 0, skipped: 0 };
  }

  const threads = deps.getThreads(property.hostexPropertyId, DRAFT_GEN_CAP);
  let generated = 0;
  let skipped = 0;
  for (const thread of threads) {
    try {
      const reply = await deps.generate({ thread, messages: deps.getMessages(thread.id), voice, facts });
      if (reply) {
        deps.create({ id: randomUUID(), thread_id: thread.id, provider: 'hostex', body: reply, generated_by: 'llm', model: DRAFT_MODEL });
        generated++;
      } else {
        skipped++;
      }
    } catch (err) {
      logger.warn({ threadId: thread.id, err: err instanceof Error ? err.message : String(err) }, 'draft-gen: thread failed');
      skipped++;
    }
  }
  logger.info({ slug: property.slug, generated, skipped }, 'draft-gen: done');
  return { generated, skipped };
}
```

- [ ] **Step 4: Test grün**

Run: `npx vitest run src/jobs/hostex/generate-hostex-drafts.test.ts`
Expected: PASS (5 Tests).

- [ ] **Step 5: In `runHostexETL` einhängen**

In `src/jobs/etl-job.ts` den Import ergänzen:

```typescript
import { generateDraftsForProperty } from './hostex/generate-hostex-drafts.js';
```

Direkt NACH dem bestehenden `await syncHostexMessagesForProperty(property, getHostexClient());` (in `runHostexETL`) einfügen:

```typescript
    await generateDraftsForProperty(property);
```

> `generateDraftsForProperty` wirft nicht (interne try/catch pro Thread, no-op ohne Vault/Config), daher ist der blanke `await` non-fatal — konsistent mit dem Message-Sync daneben.

- [ ] **Step 6: Voller Lauf + tsc + Lint**

Run: `npx vitest run`
Expected: alle grün.
Run: `npx tsc`
Expected: clean.
Run: `npm run lint`
Expected: keine neuen Fehler.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/hostex/generate-hostex-drafts.ts src/jobs/hostex/generate-hostex-drafts.test.ts src/jobs/etl-job.ts
git commit -m "feat(drafts): auto-generate hostex drafts during ETL (capped, non-fatal)"
```

---

### Task 6: UI — Badge, editierbarer Entwurf, Send-mit-Edit, Neu generieren

**Files:**
- Modify: `src/routes/messages.ts`
- Modify: `src/routes/admin-layout.ts` (`.btn-ghost`)

**Interfaces:**
- Consumes: `updateDraftBody` (draft-repository); `getPropertyByHostexId` (config/properties); `loadVoice`, `loadPropertyFacts` (vault-knowledge); `generateDraftForThread` (draft-service); `DRAFT_MODEL` (draft-service).

- [ ] **Step 1: `.btn-ghost` in `admin-layout.ts` ergänzen**

Im `BASE_CSS` nach den `.btn-danger`-Regeln einfügen:

```css
.btn-ghost { background: var(--color-sand); color: var(--color-warm-gray); border: 1px solid var(--color-stone); }
.btn-ghost:hover { background: var(--color-stone); }
```

- [ ] **Step 2: Imports in `messages.ts` erweitern**

```typescript
import {
  createDraft, getDraftById, getActiveDraftByThread, markDraftSent, markDraftError, discardDraft,
  claimDraftForSending, updateDraftBody,
} from '../repositories/draft-repository.js';
import { getPropertyByHostexId } from '../config/properties.js';
import { loadVoice, loadPropertyFacts } from '../services/vault-knowledge.js';
import { generateDraftForThread } from '../services/draft-service.js';
import { getMessagesByThread } from '../repositories/message-repository.js';
```

> `getMessagesByThread` ist ggf. schon importiert — dann nicht doppelt hinzufügen.

- [ ] **Step 3: Liste — Badge „Entwurf bereit"**

In der `router.get('/')`-Route den `rows`-Map-Block ersetzen durch:

```typescript
  const rows = threads
    .map((t) => {
      const name = esc(t.guest_name) || esc(t.id);
      const d = getActiveDraftByThread(t.id);
      const draftBadge = d
        ? `<span class="badge" style="background:var(--color-amber);color:#fff;border:none">${d.generated_by === 'llm' ? 'KI-Entwurf' : 'Entwurf'} bereit</span>`
        : '';
      return `<li><a href="/admin/messages/${encodeURIComponent(t.id)}">
        <span class="thread-name">${name}</span>
        <span class="thread-meta">${draftBadge}<span class="badge">${esc(t.channel)}</span><span>${esc(fmtDate(t.last_message_at))}</span></span>
      </a></li>`;
    })
    .join('');
```

- [ ] **Step 4: Thread-Ansicht — editierbarer Entwurf**

In `router.get('/:threadId')` den `draftBlock` ersetzen durch:

```typescript
  const draftBlock = draft
    ? `<h3>${draft.generated_by === 'llm' ? 'KI-Entwurf' : 'Entwurf'}</h3>
       <form method="POST" action="/admin/messages/drafts/${encodeURIComponent(draft.id)}/send">
         <textarea name="body" rows="7">${esc(draft.body)}</textarea>
         <div class="actions"><button type="submit" class="btn btn-primary">Senden (Freigabe)</button></div>
       </form>
       <div class="actions">
         <form method="POST" action="/admin/messages/${encodeURIComponent(thread.id)}/regenerate">
           <button type="submit" class="btn btn-ghost">Neu generieren</button></form>
         <form method="POST" action="/admin/messages/drafts/${encodeURIComponent(draft.id)}/discard">
           <button type="submit" class="btn btn-danger">Verwerfen</button></form>
       </div>`
    : `<h3>Antwort verfassen</h3>
       <form method="POST" action="/admin/messages/${encodeURIComponent(thread.id)}/draft">
         <textarea name="body" rows="6" required placeholder="Antwort an ${name} …"></textarea>
         <div class="actions"><button type="submit" class="btn btn-primary">Entwurf speichern</button></div>
       </form>`;
```

- [ ] **Step 5: Send-Route — editierten Text übernehmen**

Die `router.post('/drafts/:draftId/send', ...)`-Route: `express.urlencoded` als Middleware ergänzen und den (ggf. editierten) Body übernehmen. Signatur-Zeile ändern zu:

```typescript
router.post('/drafts/:draftId/send', express.urlencoded({ extended: true }), async (req, res, next) => {
```

Direkt NACH der thread-Existenzprüfung (`if (!thread) { ... return; }`) und VOR `claimDraftForSending` einfügen:

```typescript
    const edited = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (edited && edited !== draft.body) updateDraftBody(draft.id, edited);
    const bodyToSend = edited || draft.body;
```

Dann im Erfolgspfad `draft.body` durch `bodyToSend` ersetzen — sowohl im `sendReply`-Aufruf als auch beim `upsertMessage`-`body`:

```typescript
      const { externalMessageId } = await sendReply(thread, bodyToSend);
```
```typescript
        subject: null, body: bodyToSend, body_html: null, source: thread.source,
```

- [ ] **Step 6: Regenerate-Route ergänzen**

Vor `export default router;` einfügen:

```typescript
// Neu generieren: aktiven Entwurf verwerfen, frischen KI-Entwurf erzeugen (nur Hostex)
router.post('/:threadId/regenerate', async (req, res, next) => {
  try {
    const thread = getThreadById(req.params.threadId);
    if (!thread) { res.status(404).send('Thread nicht gefunden'); return; }
    if (thread.source !== 'hostex' || !thread.listing_id) {
      res.status(400).send('Neu generieren ist nur für Hostex-Threads verfügbar'); return;
    }
    const property = getPropertyByHostexId(thread.listing_id);
    const voice = loadVoice();
    const facts = property?.vaultNote ? loadPropertyFacts(property.vaultNote) : null;
    if (!voice || !facts) { res.status(400).send('Kein Vault-Wissen verfügbar (VAULT_PATH/vaultNote prüfen)'); return; }

    const existing = getActiveDraftByThread(thread.id);
    if (existing) discardDraft(existing.id);

    const reply = await generateDraftForThread({ thread, messages: getMessagesByThread(thread.id), voice, facts });
    if (reply) {
      createDraft({ id: randomUUID(), thread_id: thread.id, provider: 'hostex', body: reply, generated_by: 'llm', model: DRAFT_MODEL });
    }
    res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}`);
  } catch (e) { next(e); }
});
```

Und den `DRAFT_MODEL`-Import ergänzen:

```typescript
import { generateDraftForThread, DRAFT_MODEL } from '../services/draft-service.js';
```

(ersetzt den Import aus Step 2 — `DRAFT_MODEL` mit aufnehmen.)

- [ ] **Step 7: Verifizieren**

Run: `npx tsc`
Expected: clean.
Run: `npx vitest run`
Expected: alle grün (unverändert — reine Route/HTML-Änderungen).
Run: `npm run lint`
Expected: keine neuen Fehler; `grep -n "require(" src/routes/messages.ts` leer.
Run (Smoke): `PORT=3999 npm run dev &`, ~3s warten, dann
`curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3999/admin/messages/hostex:x/regenerate`
Expected: 302 (auth-Redirect — Route existiert & geschützt). Server danach beenden.

- [ ] **Step 8: Commit**

```bash
git add src/routes/messages.ts src/routes/admin-layout.ts
git commit -m "feat(messages): editable AI drafts, draft-ready badge, regenerate + send-with-edit"
```

---

## Self-Review

**Spec-Abdeckung:**
- Config `VAULT_PATH` + `vaultNote` → Task 1. ✓
- vault-knowledge (loadVoice/loadPropertyFacts, Traversal-Schutz) → Task 2. ✓
- `model`-Spalte + `updateDraftBody` + `getThreadsNeedingDraft` → Task 3. ✓
- draft-service (Prompt + Claude + null-Handling) → Task 4. ✓
- Auto-Trigger beim Sync (Cap, Idempotenz via getThreadsNeedingDraft, non-fatal, no-op ohne Wissen) → Task 5. ✓
- UI (Badge, editierbar, Send-mit-Edit, Neu generieren) → Task 6. ✓
- Nur Hostex; kein Auto-Send → durchgängig (getThreadsNeedingDraft filtert `source='hostex'`; Generierung schreibt nur `pending`). ✓
- Tests ohne echten Claude/FS-Zugriff → Deps injiziert (Task 4/5), Temp-Dir (Task 2), In-Memory-DB (Task 3). ✓

**Type-Konsistenz:** `NewDraft` mit optionalem `model` (Task 3) → genutzt in Task 5 `create`. `DraftInput`/`DraftDeps` (Task 4) → `generate`-Signatur in Task 5 `DraftGenDeps` deckungsgleich. `getThreadsNeedingDraft(listingId, limit)` (Task 3) → aufgerufen in Task 5 mit `(hostexPropertyId, DRAFT_GEN_CAP)`. `DRAFT_MODEL` (Task 4) → Task 5 + Task 6.

**Bekannte Grenzen (bewusst):** Generierung nur bis `DRAFT_GEN_CAP` pro Objekt/Lauf; restliche Threads in Folgeläufen. Prompt-Qualität am ersten echten Entwurf iterieren. Voice-Treue/Kosten werden im echten Betrieb beurteilt.

---

## Execution Handoff

Plan gespeichert unter `docs/superpowers/plans/2026-07-01-hostex-reply-slice2.md`.
