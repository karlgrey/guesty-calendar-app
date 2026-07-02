# Hostex Reply — Schnitt 3 (Vault-Feedback-Loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operator-Feedback zu einem Entwurf → LLM-Vorschlag für eine Vault-Ergänzung → nach Freigabe wird sie in die Vault-Datei geschrieben & committet; der nächste Entwurf zieht das aktualisierte Wissen.

**Architecture:** Neue DB-Tabellen (`draft_feedback`, `vault_suggestions`) + Repo; `suggestion-service` (LLM proposes edit, injizierbar); `vault-writer` (append-unter-Überschrift + git-commit, injizierbar); Feedback-Formular/-Route in `messages.ts`; „Vault-Vorschläge"-Seite `suggestions.ts`. Alle externen Abhängigkeiten (Claude, fs, git) injiziert → Tests ohne echten Claude/Netz; vault-writer testet gegen ein Temp-git-Repo.

**Tech Stack:** TypeScript (ESM, `.js`-Specifier), Express, better-sqlite3, `@anthropic-ai/sdk` via `callClaudeTool`, node:child_process (git), Vitest.

## Global Constraints

- **ESM-Imports mit `.js`-Endung**, auch in `.ts`.
- **Kuratierung:** Vault-Schreiben passiert NUR nach expliziter Freigabe eines Vorschlags. Vorschlags-Generierung schreibt nie.
- **MVP nur Ergänzungen** (Text unter eine Überschrift anhängen) — kein Ersetzen.
- **Pfad-Sicherheit:** `target_file` muss `^Areas/Hosting/[A-Za-z0-9._/-]+\.md$` erfüllen und darf kein `..` enthalten.
- **`target_file` wird von der Kategorie bestimmt** (Ton→`Areas/Hosting/_Voice.md`, Fakt→`Areas/Hosting/Properties/<vaultNote>`), NICHT vom LLM.
- **Feature-gated:** kein `VAULT_PATH` / Datei fehlt → keine Vorschlags-Generierung (Feedback wird trotzdem erfasst); git fehlt → Datei geschrieben, `committed:false` + Fehler.
- **Kein `git push`** (Propagation ist Folgeschritt).
- **Kein echter Claude-/Netz-Zugriff in Tests** — Deps injiziert; DB-Tests via `setDatabase(new Database(':memory:'))`; vault-writer gegen Temp-git-Repo.
- Modell: `claude-sonnet-4-6`. Tests: `npx vitest run <pfad>`; voll `npx vitest run`; `npx tsc`; `npm run lint`.

---

## File Structure

- **Create** `src/db/migrations/020_add_feedback_and_suggestions.sql`
- **Create** `src/types/feedback.ts`
- **Create** `src/repositories/feedback-repository.ts` (+ `.test.ts`)
- **Create** `src/services/suggestion-service.ts` (+ `.test.ts`)
- **Create** `src/services/vault-writer.ts` (+ `.test.ts`)
- **Modify** `src/routes/messages.ts` — Feedback-Formular im Draft-Block + `POST /:threadId/feedback`
- **Create** `src/routes/suggestions.ts` — `/admin/suggestions` (Liste + approve/discard)
- **Modify** `src/app.ts` — `suggestions`-Router mounten (vor `/admin`)
- **Modify** `src/routes/admin-layout.ts` — kleine CSS-Klassen falls nötig (`.diff-preview`)

---

### Task 1: DB + Typen + feedback-repository

**Files:**
- Create: `src/db/migrations/020_add_feedback_and_suggestions.sql`
- Create: `src/types/feedback.ts`
- Create: `src/repositories/feedback-repository.ts`
- Test: `src/repositories/feedback-repository.test.ts`

**Interfaces:**
- Produces:
  - Typen: `FeedbackCategory = 'ton'|'fakt'|'einmalig'`; `SuggestionStatus = 'pending'|'approved'|'discarded'`; `DraftFeedback`; `VaultSuggestion`; `NewFeedback`; `NewSuggestion`.
  - `createFeedback(f: NewFeedback): void`
  - `createSuggestion(s: NewSuggestion): void`
  - `getSuggestionById(id: string): VaultSuggestion | null`
  - `getPendingSuggestions(): VaultSuggestion[]`
  - `countPendingSuggestions(): number`
  - `markSuggestionApplied(id: string, commit: string | null): void`
  - `discardSuggestion(id: string): void`

- [ ] **Step 1: Migration schreiben**

```sql
-- Migration: draft feedback + vault suggestions (Schnitt 3 feedback loop)
-- Created: 2026-07-02

CREATE TABLE draft_feedback (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  draft_id TEXT,
  category TEXT NOT NULL,            -- 'ton' | 'fakt' | 'einmalig'
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE vault_suggestions (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL,
  target_file TEXT NOT NULL,
  target_heading TEXT NOT NULL,
  addition_text TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'discarded'
  applied_commit TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  FOREIGN KEY (feedback_id) REFERENCES draft_feedback(id) ON DELETE CASCADE
);

CREATE INDEX idx_vault_suggestions_status ON vault_suggestions(status);
```

- [ ] **Step 2: Typen (`src/types/feedback.ts`)**

```typescript
export type FeedbackCategory = 'ton' | 'fakt' | 'einmalig';
export type SuggestionStatus = 'pending' | 'approved' | 'discarded';

export interface DraftFeedback {
  id: string;
  thread_id: string;
  draft_id: string | null;
  category: FeedbackCategory;
  note: string;
  created_at?: string;
}
export type NewFeedback = Pick<DraftFeedback, 'id' | 'thread_id' | 'draft_id' | 'category' | 'note'>;

export interface VaultSuggestion {
  id: string;
  feedback_id: string;
  target_file: string;
  target_heading: string;
  addition_text: string;
  rationale: string;
  status: SuggestionStatus;
  applied_commit: string | null;
  created_at?: string;
  applied_at: string | null;
}
export type NewSuggestion = Pick<VaultSuggestion, 'id' | 'feedback_id' | 'target_file' | 'target_heading' | 'addition_text' | 'rationale'>;
```

- [ ] **Step 3: Failing test schreiben**

```typescript
// src/repositories/feedback-repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createFeedback, createSuggestion, getSuggestionById, getPendingSuggestions,
  countPendingSuggestions, markSuggestionApplied, discardSuggestion,
} from './feedback-repository.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE draft_feedback (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, draft_id TEXT, category TEXT NOT NULL,
      note TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE vault_suggestions (
      id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL, target_file TEXT NOT NULL,
      target_heading TEXT NOT NULL, addition_text TEXT NOT NULL, rationale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', applied_commit TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), applied_at TEXT
    );
  `);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function seedSuggestion(id: string) {
  createFeedback({ id: `fb-${id}`, thread_id: 't1', draft_id: 'd1', category: 'ton', note: 'zu lang' });
  createSuggestion({ id, feedback_id: `fb-${id}`, target_file: 'Areas/Hosting/_Voice.md', target_heading: '## Anti-Pattern', addition_text: '- Regel', rationale: 'weil' });
}

describe('feedback-repository', () => {
  it('creates a suggestion and lists it as pending', () => {
    seedSuggestion('s1');
    expect(getSuggestionById('s1')?.status).toBe('pending');
    expect(getPendingSuggestions().map((s) => s.id)).toEqual(['s1']);
    expect(countPendingSuggestions()).toBe(1);
  });

  it('markSuggestionApplied moves it out of pending and records the commit', () => {
    seedSuggestion('s2');
    markSuggestionApplied('s2', 'abc123');
    expect(getPendingSuggestions()).toEqual([]);
    const s = getSuggestionById('s2');
    expect(s?.status).toBe('approved');
    expect(s?.applied_commit).toBe('abc123');
    expect(s?.applied_at).not.toBeNull();
  });

  it('discardSuggestion removes it from pending', () => {
    seedSuggestion('s3');
    discardSuggestion('s3');
    expect(getPendingSuggestions()).toEqual([]);
    expect(getSuggestionById('s3')?.status).toBe('discarded');
  });
});
```

- [ ] **Step 4: Test ausführen — muss fehlschlagen**

Run: `npx vitest run src/repositories/feedback-repository.test.ts`
Expected: FAIL (`Failed to resolve import './feedback-repository.js'`).

- [ ] **Step 5: Repository implementieren**

```typescript
// src/repositories/feedback-repository.ts
import { getDatabase } from '../db/index.js';
import type { DraftFeedback, NewFeedback, VaultSuggestion, NewSuggestion } from '../types/feedback.js';

export function createFeedback(f: NewFeedback): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO draft_feedback (id, thread_id, draft_id, category, note)
     VALUES (@id, @thread_id, @draft_id, @category, @note)`,
  ).run({ ...f, draft_id: f.draft_id ?? null });
}

export function createSuggestion(s: NewSuggestion): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO vault_suggestions (id, feedback_id, target_file, target_heading, addition_text, rationale)
     VALUES (@id, @feedback_id, @target_file, @target_heading, @addition_text, @rationale)`,
  ).run(s);
}

export function getSuggestionById(id: string): VaultSuggestion | null {
  const db = getDatabase();
  return (db.prepare(`SELECT * FROM vault_suggestions WHERE id = ?`).get(id) as VaultSuggestion | undefined) ?? null;
}

export function getPendingSuggestions(): VaultSuggestion[] {
  const db = getDatabase();
  return db.prepare(`SELECT * FROM vault_suggestions WHERE status = 'pending' ORDER BY created_at ASC`).all() as VaultSuggestion[];
}

export function countPendingSuggestions(): number {
  const db = getDatabase();
  const row = db.prepare(`SELECT COUNT(*) AS n FROM vault_suggestions WHERE status = 'pending'`).get() as { n: number };
  return row.n;
}

export function markSuggestionApplied(id: string, commit: string | null): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE vault_suggestions SET status = 'approved', applied_commit = ?, applied_at = datetime('now') WHERE id = ?`,
  ).run(commit, id);
}

export function discardSuggestion(id: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE vault_suggestions SET status = 'discarded' WHERE id = ?`).run(id);
}
```

- [ ] **Step 6: Test grün + Migration smoke + Lint**

Run: `npx vitest run src/repositories/feedback-repository.test.ts` → PASS (3).
Run: `npm run db:migrate` → Migration 020 angewandt, keine Fehler.
Run: `npm run lint` → keine neuen Fehler.

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations/020_add_feedback_and_suggestions.sql src/types/feedback.ts src/repositories/feedback-repository.ts src/repositories/feedback-repository.test.ts
git commit -m "feat(feedback): draft_feedback + vault_suggestions tables + repository"
```

---

### Task 2: `suggestion-service.ts` — LLM schlägt Vault-Edit vor

**Files:**
- Create: `src/services/suggestion-service.ts`
- Test: `src/services/suggestion-service.test.ts`

**Interfaces:**
- Consumes: `callClaudeTool`, `ClaudeToolDefinition` aus `./anthropic-client.js`.
- Produces:
  - `PROPOSE_VAULT_EDIT_TOOL: ClaudeToolDefinition`
  - `interface SuggestionInput { category: 'ton' | 'fakt'; note: string; draftBody: string; fileContent: string }`
  - `interface SuggestionDeps { call: typeof callClaudeTool }`
  - `generateSuggestion(input: SuggestionInput, deps?: SuggestionDeps): Promise<{ target_heading: string; addition_text: string; rationale: string } | null>`

> Orientiere `PROPOSE_VAULT_EDIT_TOOL.input_schema` an der exakten `ClaudeToolDefinition`-Form in `src/services/anthropic-client.ts` (Felder `name`, `description`, `input_schema` mit `type:'object'`, `properties`, `required`), wie beim `SUBMIT_REPLY_TOOL` in `draft-service.ts`.

- [ ] **Step 1: Failing test schreiben**

```typescript
// src/services/suggestion-service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { generateSuggestion } from './suggestion-service.js';

describe('generateSuggestion', () => {
  it('feeds note + draft + file content to the model and returns the proposal', async () => {
    const call = vi.fn().mockResolvedValue({
      target_heading: '## Anti-Pattern', addition_text: '- Nicht ungefragt andere Objekte anbieten', rationale: 'Gastfrage war nur zur Schilderwerkstatt',
    });
    const out = await generateSuggestion(
      { category: 'ton', note: 'erwähnt ungefragt das Bootshaus', draftBody: 'Hey Michael, ... am Bootshaus ...', fileContent: '# Voice\n## Anti-Pattern\n- alt' },
      { call },
    );
    expect(out?.target_heading).toBe('## Anti-Pattern');
    expect(out?.addition_text).toContain('Nicht ungefragt');
    const arg = call.mock.calls[0][0];
    expect(arg.userMessage).toContain('erwähnt ungefragt das Bootshaus');
    expect(arg.userMessage).toContain('am Bootshaus');
    expect(arg.userMessage).toContain('## Anti-Pattern'); // file content included
  });

  it('returns null on an empty/malformed proposal', async () => {
    const call = vi.fn().mockResolvedValue({ target_heading: '', addition_text: '', rationale: '' });
    expect(await generateSuggestion({ category: 'ton', note: 'x', draftBody: 'y', fileContent: 'z' }, { call })).toBeNull();
  });
});
```

- [ ] **Step 2: Test ausführen — muss fehlschlagen**

Run: `npx vitest run src/services/suggestion-service.test.ts`
Expected: FAIL (`Failed to resolve import './suggestion-service.js'`).

- [ ] **Step 3: Implementieren**

```typescript
// src/services/suggestion-service.ts
import { callClaudeTool, type ClaudeToolDefinition } from './anthropic-client.js';

const DRAFT_MODEL = 'claude-sonnet-4-6';

export const PROPOSE_VAULT_EDIT_TOOL: ClaudeToolDefinition = {
  name: 'propose_vault_edit',
  description: 'Schlage eine minimale Ergänzung für die Vault-Datei vor.',
  input_schema: {
    type: 'object',
    properties: {
      target_heading: { type: 'string', description: 'Eine BEREITS in der Datei existierende Überschrift (z. B. „## Anti-Pattern"), unter die der Text kommt.' },
      addition_text: { type: 'string', description: 'Der anzuhängende Text, i. d. R. ein einzelner Markdown-Bullet. Keine Umschreibung der Datei.' },
      rationale: { type: 'string', description: 'Kurze Begründung.' },
    },
    required: ['target_heading', 'addition_text', 'rationale'],
  },
};

export interface SuggestionInput {
  category: 'ton' | 'fakt';
  note: string;
  draftBody: string;
  fileContent: string;
}
export interface SuggestionDeps {
  call: typeof callClaudeTool;
}
const defaultDeps: SuggestionDeps = { call: callClaudeTool };

function buildSystemPrompt(category: 'ton' | 'fakt'): string {
  const kind = category === 'ton' ? 'Ton/Stil (Voice)' : 'Objektfakt';
  return [
    `Du pflegst eine kuratierte Wissensdatei (Kategorie: ${kind}) für Gästekommunikation.`,
    'Formuliere aus dem Feedback eine MINIMALE Ergänzung: einen einzelnen, klaren Markdown-Bullet.',
    'Wähle als target_heading eine Überschrift, die BEREITS in der Datei vorkommt. Erfinde nichts, keine ganze Datei umschreiben.',
    'Antworte über das Tool propose_vault_edit.',
  ].join('\n');
}

function buildUserMessage(input: SuggestionInput): string {
  return [
    `Feedback des Operators: ${input.note}`,
    '',
    'Beanstandeter Entwurf:',
    input.draftBody,
    '',
    'Aktueller Inhalt der Zieldatei:',
    '--- DATEI ---',
    input.fileContent,
    '--- ENDE DATEI ---',
  ].join('\n');
}

export async function generateSuggestion(
  input: SuggestionInput,
  deps: SuggestionDeps = defaultDeps,
): Promise<{ target_heading: string; addition_text: string; rationale: string } | null> {
  const out = (await deps.call({
    systemPrompt: buildSystemPrompt(input.category),
    userMessage: buildUserMessage(input),
    tool: PROPOSE_VAULT_EDIT_TOOL,
    model: DRAFT_MODEL,
  })) as { target_heading?: unknown; addition_text?: unknown; rationale?: unknown } | null;
  const heading = typeof out?.target_heading === 'string' ? out.target_heading.trim() : '';
  const addition = typeof out?.addition_text === 'string' ? out.addition_text.trim() : '';
  const rationale = typeof out?.rationale === 'string' ? out.rationale.trim() : '';
  if (!heading || !addition) return null;
  return { target_heading: heading, addition_text: addition, rationale };
}
```

- [ ] **Step 4: Test grün + Lint**

Run: `npx vitest run src/services/suggestion-service.test.ts` → PASS (2).
Run: `npm run lint` → keine neuen Fehler.

- [ ] **Step 5: Commit**

```bash
git add src/services/suggestion-service.ts src/services/suggestion-service.test.ts
git commit -m "feat(feedback): suggestion-service proposes a vault edit via Claude (injectable)"
```

---

### Task 3: `vault-writer.ts` — Ergänzung anhängen + committen

**Files:**
- Create: `src/services/vault-writer.ts`
- Test: `src/services/vault-writer.test.ts`

**Interfaces:**
- Consumes: `config.vaultPath`; `VaultSuggestion` aus `../types/feedback.js`.
- Produces:
  - `insertUnderHeading(content: string, heading: string, addition: string): string` (pure)
  - `applySuggestion(s: VaultSuggestion, deps?: VaultWriterDeps): { committed: boolean; commit: string | null; error?: string }`
  - `interface VaultWriterDeps { vaultPath: string | undefined; readFile: (p: string) => string; writeFile: (p: string, c: string) => void; git: (args: string[]) => string }`

- [ ] **Step 1: Failing tests schreiben**

```typescript
// src/services/vault-writer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertUnderHeading, applySuggestion, type VaultWriterDeps } from './vault-writer.js';
import type { VaultSuggestion } from '../types/feedback.js';

describe('insertUnderHeading (pure)', () => {
  it('appends at the END of the target section (before the next ## heading)', () => {
    const src = '# T\n## A\n- a1\n\n## B\n- b1\n';
    const out = insertUnderHeading(src, '## A', '- a2');
    expect(out).toBe('# T\n## A\n- a1\n- a2\n\n## B\n- b1\n');
  });
  it('appends heading + text at EOF when the heading is absent', () => {
    const out = insertUnderHeading('# T\n## A\n- a1\n', '## Neu', '- x');
    expect(out).toContain('## Neu\n- x');
  });
});

describe('applySuggestion (temp git repo)', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'vault-w-'));
    mkdirSync(join(base, 'Areas/Hosting'), { recursive: true });
    writeFileSync(join(base, 'Areas/Hosting/_Voice.md'), '# Voice\n## Anti-Pattern\n- alt\n');
    execFileSync('git', ['-C', base, 'init', '-q']);
    execFileSync('git', ['-C', base, 'config', 'user.email', 't@t.de']);
    execFileSync('git', ['-C', base, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', base, 'add', '.']);
    execFileSync('git', ['-C', base, 'commit', '-qm', 'init']);
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  function deps(): VaultWriterDeps {
    return {
      vaultPath: base,
      readFile: (p) => readFileSync(p, 'utf8'),
      writeFile: (p, c) => writeFileSync(p, c),
      git: (args) => String(execFileSync('git', ['-C', base, ...args])),
    };
  }
  const sug = (over: Partial<VaultSuggestion> = {}): VaultSuggestion => ({
    id: 's', feedback_id: 'f', target_file: 'Areas/Hosting/_Voice.md', target_heading: '## Anti-Pattern',
    addition_text: '- neu', rationale: 'r', status: 'pending', applied_commit: null, applied_at: null, ...over,
  });

  it('appends the addition to the file and commits', () => {
    const res = applySuggestion(sug(), deps());
    expect(res.committed).toBe(true);
    expect(res.commit).toMatch(/^[0-9a-f]{7,}/);
    expect(readFileSync(join(base, 'Areas/Hosting/_Voice.md'), 'utf8')).toContain('- alt\n- neu');
  });

  it('rejects an unsafe target_file without writing', () => {
    const res = applySuggestion(sug({ target_file: 'Areas/Hosting/../../secret.md' }), deps());
    expect(res.committed).toBe(false);
    expect(res.error).toMatch(/unsafe/i);
  });
});
```

- [ ] **Step 2: Test ausführen — muss fehlschlagen**

Run: `npx vitest run src/services/vault-writer.test.ts`
Expected: FAIL (`Failed to resolve import './vault-writer.js'`).

- [ ] **Step 3: Implementieren**

```typescript
// src/services/vault-writer.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { config } from '../config/index.js';
import type { VaultSuggestion } from '../types/feedback.js';

const SAFE_TARGET = /^Areas\/Hosting\/[A-Za-z0-9._/-]+\.md$/;

export interface VaultWriterDeps {
  vaultPath: string | undefined;
  readFile: (p: string) => string;
  writeFile: (p: string, c: string) => void;
  git: (args: string[]) => string;
}

function defaultDeps(): VaultWriterDeps {
  const vaultPath = config.vaultPath;
  return {
    vaultPath,
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, c) => writeFileSync(p, c),
    git: (args) => String(execFileSync('git', ['-C', vaultPath ?? '.', ...args])),
  };
}

/** Insert `addition` at the end of the section under `heading` (before the next `## `, else EOF). */
export function insertUnderHeading(content: string, heading: string, addition: string): string {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim() === heading.trim());
  if (idx === -1) {
    const sep = content.endsWith('\n') ? '' : '\n';
    return `${content}${sep}\n${heading}\n${addition}\n`;
  }
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  let insertAt = end;
  while (insertAt > idx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, addition);
  return lines.join('\n');
}

export function applySuggestion(
  s: VaultSuggestion,
  deps: VaultWriterDeps = defaultDeps(),
): { committed: boolean; commit: string | null; error?: string } {
  if (!SAFE_TARGET.test(s.target_file) || s.target_file.includes('..')) {
    return { committed: false, commit: null, error: 'unsafe target_file' };
  }
  if (!deps.vaultPath) return { committed: false, commit: null, error: 'VAULT_PATH not set' };

  const abs = join(deps.vaultPath, s.target_file);
  let content: string;
  try {
    content = deps.readFile(abs);
  } catch (err) {
    return { committed: false, commit: null, error: `read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  deps.writeFile(abs, insertUnderHeading(content, s.target_heading, s.addition_text));

  try {
    deps.git(['add', s.target_file]);
    deps.git(['commit', '-m', `Vault-Update via Feedback-Loop (${s.target_heading})`]);
    const commit = deps.git(['rev-parse', 'HEAD']).trim();
    return { committed: true, commit };
  } catch (err) {
    return { committed: false, commit: null, error: `git failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
```

- [ ] **Step 4: Tests grün + Lint**

Run: `npx vitest run src/services/vault-writer.test.ts` → PASS (4).
Run: `npm run lint` → keine neuen Fehler.

- [ ] **Step 5: Commit**

```bash
git add src/services/vault-writer.ts src/services/vault-writer.test.ts
git commit -m "feat(feedback): vault-writer appends under heading + commits (injectable git)"
```

---

### Task 4: Feedback erfassen — Formular + Route in `messages.ts`

**Files:**
- Modify: `src/routes/messages.ts`

**Interfaces:**
- Consumes: `createFeedback`, `createSuggestion` (feedback-repository); `generateSuggestion` (suggestion-service); `loadVoice`, `loadPropertyFacts` (vault-knowledge, bereits importiert); `getPropertyByHostexId` (bereits importiert); `getActiveDraftByThread` (bereits importiert); `randomUUID` (bereits importiert).

- [ ] **Step 1: Imports ergänzen**

```typescript
import { createFeedback, createSuggestion } from '../repositories/feedback-repository.js';
import { generateSuggestion } from '../services/suggestion-service.js';
```

- [ ] **Step 2: Feedback-Formular im Draft-Block einfügen**

In `router.get('/:threadId')`, im `draftBlock` für den Fall **mit** Draft (nach dem `<div class="actions">` mit Senden/Verwerfen/Neu generieren), vor dem schließenden Backtick dieses Zweigs, einfügen:

```typescript
       <details style="margin-top:16px">
         <summary style="cursor:pointer;color:var(--color-warm-gray)">Passt nicht? Feedback geben</summary>
         <form method="POST" action="/admin/messages/${encodeURIComponent(thread.id)}/feedback" style="margin-top:12px">
           <select name="category" class="badge" style="padding:6px 10px">
             <option value="ton">Ton/Voice</option>
             <option value="fakt">Objektfakt</option>
             <option value="einmalig">Einmalig</option>
           </select>
           <textarea name="note" rows="3" required placeholder="Was stört dich?" style="margin-top:10px"></textarea>
           <div class="actions"><button type="submit" class="btn btn-ghost">Feedback senden</button></div>
         </form>
       </details>
```

- [ ] **Step 3: Feedback-Route einfügen** (vor `export default router;`)

```typescript
// Feedback zu einem Entwurf: erfassen und (Ton/Fakt) einen Vault-Vorschlag generieren.
router.post('/:threadId/feedback', express.urlencoded({ extended: true }), async (req, res, next) => {
  try {
    const thread = getThreadById(req.params.threadId);
    if (!thread) { res.status(404).send('Thread nicht gefunden'); return; }
    const category = String(req.body?.category ?? '');
    const note = String(req.body?.note ?? '').trim();
    if (!['ton', 'fakt', 'einmalig'].includes(category) || !note) { res.status(400).send('Kategorie + Notiz nötig'); return; }

    const draft = getActiveDraftByThread(thread.id);
    const feedbackId = randomUUID();
    createFeedback({ id: feedbackId, thread_id: thread.id, draft_id: draft?.id ?? null, category: category as 'ton' | 'fakt' | 'einmalig', note });

    if (category !== 'einmalig') {
      const isTon = category === 'ton';
      const property = isTon ? null : getPropertyByHostexId(thread.listing_id ?? '');
      const targetFile = isTon
        ? 'Areas/Hosting/_Voice.md'
        : property?.vaultNote ? `Areas/Hosting/Properties/${property.vaultNote}` : null;
      const fileContent = isTon ? loadVoice() : property?.vaultNote ? loadPropertyFacts(property.vaultNote) : null;
      if (targetFile && fileContent) {
        const proposal = await generateSuggestion(
          { category: category as 'ton' | 'fakt', note, draftBody: draft?.body ?? '', fileContent },
        );
        if (proposal) {
          createSuggestion({
            id: randomUUID(), feedback_id: feedbackId, target_file: targetFile,
            target_heading: proposal.target_heading, addition_text: proposal.addition_text, rationale: proposal.rationale,
          });
          res.redirect('/admin/suggestions');
          return;
        }
      }
    }
    res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}`);
  } catch (e) { next(e); }
});
```

- [ ] **Step 4: Verifizieren**

Run: `npx tsc` → clean.
Run: `npx vitest run` → weiterhin grün.
Run: `npm run lint` → keine neuen Fehler; `grep -n "require(" src/routes/messages.ts` leer.
Smoke: `PORT=3999 npm run dev &`, ~3s warten, `curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3999/admin/messages/hostex:x/feedback` → 302; Server beenden.

- [ ] **Step 5: Commit**

```bash
git add src/routes/messages.ts
git commit -m "feat(feedback): 'Passt nicht?' form + feedback route (generates a vault suggestion)"
```

---

### Task 5: „Vault-Vorschläge"-Seite + Mount + Nav

**Files:**
- Create: `src/routes/suggestions.ts`
- Modify: `src/app.ts`
- Modify: `src/routes/messages.ts` (Nav-Link mit Pending-Count)

**Interfaces:**
- Consumes: `getPendingSuggestions`, `getSuggestionById`, `markSuggestionApplied`, `discardSuggestion`, `countPendingSuggestions` (feedback-repository); `applySuggestion` (vault-writer); `renderAdminPage` (admin-layout); `esc`-Muster.

- [ ] **Step 1: `src/routes/suggestions.ts` erstellen**

```typescript
// src/routes/suggestions.ts
import express from 'express';
import {
  getPendingSuggestions, getSuggestionById, markSuggestionApplied, discardSuggestion,
} from '../repositories/feedback-repository.js';
import { applySuggestion } from '../services/vault-writer.js';
import { renderAdminPage } from './admin-layout.js';

const router = express.Router();

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

router.get('/', (_req, res) => {
  const pending = getPendingSuggestions();
  const items = pending.map((s) => `
    <div class="section">
      <p class="subtitle" style="margin:0 0 8px"><span class="badge">${esc(s.target_file)}</span> → <span class="badge">${esc(s.target_heading)}</span></p>
      <div class="draft-preview">${esc(s.addition_text)}</div>
      <p class="subtitle">${esc(s.rationale)}</p>
      <div class="actions">
        <form method="POST" action="/admin/suggestions/${esc(s.id)}/approve"><button class="btn btn-primary">Freigeben & schreiben</button></form>
        <form method="POST" action="/admin/suggestions/${esc(s.id)}/discard"><button class="btn btn-danger">Verwerfen</button></form>
      </div>
    </div>`).join('');
  const body = `<a class="back-link" href="/admin/messages">&larr; Nachrichten</a>
    <h1>Vault-Vorschläge <span class="count-pill">${pending.length} offen</span></h1>
    <p class="subtitle">Vorschläge aus deinem Feedback. Freigeben schreibt die Ergänzung in den Vault und committet.</p>
    ${items || '<p class="empty">Keine offenen Vorschläge.</p>'}`;
  res.type('html').send(renderAdminPage({ title: 'Vault-Vorschläge', body }));
});

router.post('/:id/approve', (req, res, next) => {
  try {
    const s = getSuggestionById(req.params.id);
    if (!s) { res.status(404).send('Vorschlag nicht gefunden'); return; }
    if (s.status !== 'pending') { res.status(409).send('Vorschlag ist nicht mehr offen'); return; }
    const result = applySuggestion(s);
    if (!result.committed && result.error) { res.status(502).send(`Schreiben fehlgeschlagen: ${esc(result.error)}`); return; }
    markSuggestionApplied(s.id, result.commit);
    res.redirect('/admin/suggestions');
  } catch (e) { next(e); }
});

router.post('/:id/discard', (req, res, next) => {
  try {
    const s = getSuggestionById(req.params.id);
    if (!s) { res.status(404).send('Vorschlag nicht gefunden'); return; }
    discardSuggestion(s.id);
    res.redirect('/admin/suggestions');
  } catch (e) { next(e); }
});

export default router;
```

- [ ] **Step 2: In `src/app.ts` mounten** (vor `app.use('/admin', ...)`, neben dem messages-Mount)

```typescript
import suggestionsRoutes from './routes/suggestions.js';
// ...
app.use('/admin/suggestions', requireAuth, suggestionsRoutes);
```

- [ ] **Step 3: Nav-Link mit Pending-Count in der Messages-Liste**

In `messages.ts` `router.get('/')`, `countPendingSuggestions` importieren:

```typescript
import { countPendingSuggestions } from '../repositories/feedback-repository.js';
```

Im `sync-bar`-Bereich der Liste (neben dem Sync-Button/Label) ergänzen:

```typescript
        <a href="/admin/suggestions" class="btn btn-ghost">Vault-Vorschläge${(() => { const n = countPendingSuggestions(); return n ? ` (${n})` : ''; })()}</a>
```

- [ ] **Step 4: Verifizieren**

Run: `npx tsc` → clean.
Run: `npx vitest run` → grün.
Run: `npm run lint` → keine neuen Fehler; `grep -n "require(" src/routes/suggestions.ts` leer.
Smoke: `PORT=3999 npm run dev &`, ~3s, dann
`curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3999/admin/suggestions` → 302 und
`curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3999/admin/suggestions/x/approve` → 302. Server beenden.

- [ ] **Step 5: Commit**

```bash
git add src/routes/suggestions.ts src/app.ts src/routes/messages.ts
git commit -m "feat(feedback): vault suggestions review page (approve writes+commits) + nav"
```

---

## Self-Review

**Spec-Abdeckung:**
- DB (draft_feedback, vault_suggestions) + Repo → Task 1. ✓
- suggestion-service (LLM proposes, injectable, null-handling) → Task 2. ✓
- vault-writer (append-unter-Überschrift, Pfad-Sicherheit, git-commit, injectable) → Task 3. ✓
- Feedback erfassen (Formular + Route, Ton→Voice / Fakt→Objekt-Notiz, Einmalig=nur Log) → Task 4. ✓
- Vorschläge prüfen (Seite, approve=applySuggestion, discard) + Mount + Nav → Task 5. ✓
- Kuratierung (nur nach Freigabe schreiben), MVP-nur-Anhängen, target_file per Kategorie, Feature-Gate, kein push → durchgängig. ✓

**Type-Konsistenz:** `NewFeedback`/`NewSuggestion` (Task 1) → genutzt in Task 4. `generateSuggestion`-Rückgabe `{target_heading,addition_text,rationale}` (Task 2) → konsumiert in Task 4. `applySuggestion(s)` + `VaultWriterDeps` (Task 3) → genutzt in Task 5. `VaultSuggestion` (Task 1) → Parameter in Task 3/5.

**Bekannte Grenzen (bewusst):** nur Anhängen (kein Ersetzen); kein push; ein Vorschlag pro Feedback; Vorschlag nicht editierbar vor Freigabe. Prompt-Qualität am Bootshaus-Fall iterieren.

---

## Execution Handoff

Plan gespeichert unter `docs/superpowers/plans/2026-07-02-hostex-reply-slice3.md`.
