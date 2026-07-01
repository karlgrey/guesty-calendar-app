# Hostex Reply — Schnitt 1 (Walking Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end Pfad „Hostex-Gastnachricht lesen → Antwort verfassen → freigeben → über Hostex senden → als outbound speichern", ohne LLM, ohne Auto-Send.

**Architecture:** Wir erweitern die bestehende `guesty-calendar-app`. Hostex-Nachrichten werden per Polling-Sync (gespiegelt vom Guesty-Message-Sync) in die vorhandenen `message_threads`/`messages`-Tabellen gelegt. Antworten laufen über eine neue `message_drafts`-Tabelle (Freigabe-Gate) und eine dünne provider-dispatchende `sendReply()`-Abstraktion, die in Schnitt 1 nur den Hostex-Zweig implementiert. Freigabe erfolgt manuell über eine minimale Admin-Seite.

**Tech Stack:** TypeScript (ESM, `.js`-Import-Specifier), Express, better-sqlite3, Bottleneck, Vitest.

## Global Constraints

- **ESM-Imports mit `.js`-Endung** (z. B. `import { getDatabase } from '../db/index.js'`), auch für `.ts`-Dateien — Repo-Konvention.
- **Kein Auto-Send.** Ein Draft wird nur durch einen expliziten POST (Micha klickt „Senden") versendet. Default aller Drafts: `status='pending'`.
- **Idempotenz beim Sync:** Nachrichten-`id` = `hostex:{message_id}`, Thread-`id` = `hostex:{conversation_id}`; Upserts nutzen `ON CONFLICT(id) DO UPDATE`.
- **Send-Idempotenz:** Vor dem Versand muss der Draft `status='pending'` sein; nach Erfolg `status='sent'`. Kein Versand eines bereits `sent`/`discarded` Drafts.
- **Hostex-Responses sind gewrappt:** `{ request_id, error_code, error_msg, data: {...} }`. Client-Methoden geben `data.*` zurück (Muster: `getProperties()` → `data.properties`).
- **Repo-Tests** laufen gegen `new Database(':memory:')` via `setDatabase()`/`resetDatabase()` aus `../db/index.js` — kein echtes DB-File, keine Netzwerkaufrufe.
- **Client-Fetch-Wrapper werden NICHT unit-getestet** (Repo-Konvention: keine `*-client.test.ts` vorhanden) — Verifikation über ein manuelles `src/scripts/*`-Skript. Getestet werden die **reinen Mapper** und die **Repository-Logik**.
- Tests ausführen: `npx vitest run <pfad>`. Lint: `npm run lint`.

---

## File Structure

- **Modify** `src/types/messages.ts` — `MessageSource` um `'hostex'` erweitern; Draft-Typen ergänzen (`DraftStatus`, `MessageDraft`, `NewDraft`).
- **Create** `src/db/migrations/018_add_message_drafts.sql` — neue Tabelle `message_drafts`.
- **Create** `src/repositories/draft-repository.ts` (+ `.test.ts`) — CRUD + Statusübergänge für Drafts.
- **Create** `src/scripts/dump-hostex-conversations.ts` — einmaliges Skript, das echte Hostex-Conversations als Fixture speichert.
- **Create** `src/test-fixtures/hostex/conversations.json` (generiert von obigem Skript).
- **Modify** `src/services/hostex-client.ts` — `getConversations`, `getConversationDetails`, `sendMessage` + Typen.
- **Create** `src/mappers/hostex/message-mapper.ts` (+ `.test.ts`) — reine Mapper: Hostex-Shape → `NewMessageThread`/`NewMessage`.
- **Create** `src/jobs/hostex/sync-hostex-messages.ts` (+ `.test.ts`) — orchestriert Client + Mapper + Upsert.
- **Modify** `src/repositories/message-repository.ts` (+ ggf. `.test.ts`) — `getThreadsNeedingReply()`.
- **Create** `src/services/message-sender.ts` (+ `.test.ts`) — `sendReply(thread, body, deps?)`, dispatch nach `thread.source`.
- **Create** `src/routes/messages.ts` — Admin-Routen + Minimal-UI.
- **Modify** `src/app.ts` — Router unter `/admin/messages` mounten (erbt `requireAuth`).

---

### Task 1: Hostex-Conversations-Fixture ziehen + interne Typen pinnen

Die genaue Feldstruktur der Hostex-Conversations/Messages-Endpunkte ist nicht dokumentiert-genug für sichere Mapper. Zuerst eine echte Antwort als Fixture speichern; die Mapper (Task 4) werden dagegen gebaut.

**Files:**
- Create: `src/scripts/dump-hostex-conversations.ts`
- Create (generiert): `src/test-fixtures/hostex/conversations.json`

**Interfaces:**
- Consumes: `getHostexClient()` aus `../services/hostex-client.js` (bestehender Singleton), `config.hostexAccessToken`.
- Produces: Fixture-Datei, an der Task 3/4 die realen Feldnamen ablesen.

- [ ] **Step 1: Dump-Skript schreiben**

```typescript
// src/scripts/dump-hostex-conversations.ts
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { getHostexClient } from '../services/hostex-client.js';

// Roh-Fetch über den bestehenden Client-Rohkanal ist privat; hier bewusst direkt via fetch,
// nur um die echte Antwortform zu inspizieren.
async function main() {
  const token = process.env.HOSTEX_ACCESS_TOKEN;
  if (!token) throw new Error('HOSTEX_ACCESS_TOKEN fehlt');
  const base = process.env.HOSTEX_API_URL ?? 'https://api.hostex.io/v3';

  const listRes = await fetch(`${base}/conversations?limit=5`, {
    headers: { 'Hostex-Access-Token': token, 'User-Agent': 'guesty-calendar-app' },
  });
  const list = await listRes.json();
  const firstId = list?.data?.conversations?.[0]?.id ?? list?.data?.conversations?.[0]?.conversation_id;

  let detail: unknown = null;
  if (firstId) {
    const detRes = await fetch(`${base}/conversations/${firstId}`, {
      headers: { 'Hostex-Access-Token': token, 'User-Agent': 'guesty-calendar-app' },
    });
    detail = await detRes.json();
  }

  const out = { list, detail };
  writeFileSync('src/test-fixtures/hostex/conversations.json', JSON.stringify(out, null, 2));
  console.log('Gespeichert. Top-level keys list.data:', Object.keys(list?.data ?? {}));
  console.log('Erste Conversation:', JSON.stringify(list?.data?.conversations?.[0], null, 2)?.slice(0, 800));
  console.log('Detail keys:', Object.keys((detail as any)?.data ?? {}));
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Skript ausführen und Fixture erzeugen**

Run: `npx tsx src/scripts/dump-hostex-conversations.ts`
Expected: Datei `src/test-fixtures/hostex/conversations.json` entsteht; Konsole zeigt die realen Feldnamen einer Conversation und die Message-Struktur im Detail.

- [ ] **Step 3: Feldnamen notieren**

Notiere aus der Konsolenausgabe die realen Schlüssel für: Conversation-ID, `channel_type`, Gastname; und pro Nachricht: Message-ID, Absenderrolle (`sender_role`/`sender_type`), Textfeld (`content`/`body`), Zeitstempel (`created_at`). Diese Namen werden in Task 3 (Typen) und Task 4 (Mapper) verbindlich verwendet. **Falls ein Name abweicht, in Task 3/4 exakt diesen Schlüssel einsetzen.**

- [ ] **Step 4: Commit**

```bash
git add src/scripts/dump-hostex-conversations.ts src/test-fixtures/hostex/conversations.json
git commit -m "chore(hostex): capture conversations fixture for message mapping"
```

---

### Task 2: Draft-Tabelle + draft-repository

**Files:**
- Create: `src/db/migrations/018_add_message_drafts.sql`
- Modify: `src/types/messages.ts` (Draft-Typen anhängen)
- Create: `src/repositories/draft-repository.ts`
- Test: `src/repositories/draft-repository.test.ts`

**Interfaces:**
- Consumes: `getDatabase()` aus `../db/index.js`.
- Produces:
  - `type DraftStatus = 'pending' | 'sent' | 'error' | 'discarded'`
  - `interface MessageDraft { id: string; thread_id: string; provider: 'hostex'|'guesty'; body: string; status: DraftStatus; generated_by: 'manual'|'llm'; send_attempts: number; external_message_id: string|null; error: string|null; created_at: string; sent_at: string|null }`
  - `type NewDraft = { id: string; thread_id: string; provider: 'hostex'|'guesty'; body: string; generated_by: 'manual'|'llm' }`
  - `createDraft(d: NewDraft): void`
  - `getDraftById(id: string): MessageDraft | null`
  - `getActiveDraftByThread(threadId: string): MessageDraft | null` (nur `status='pending'`)
  - `markDraftSent(id: string, externalMessageId: string): void`
  - `markDraftError(id: string, error: string): void` (erhöht `send_attempts`)
  - `discardDraft(id: string): void`

- [ ] **Step 1: Migration schreiben**

```sql
-- Migration: add message_drafts table
-- Created: 2026-07-01
--
-- Outbound reply drafts awaiting human approval. One 'pending' draft per thread
-- is the intended invariant (enforced in the repository/route layer, not the schema).

CREATE TABLE message_drafts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  provider TEXT NOT NULL,                       -- 'hostex' | 'guesty'
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- 'pending' | 'sent' | 'error' | 'discarded'
  generated_by TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'llm'
  send_attempts INTEGER NOT NULL DEFAULT 0,
  external_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  FOREIGN KEY (thread_id) REFERENCES message_threads(id) ON DELETE CASCADE
);

CREATE INDEX idx_message_drafts_thread ON message_drafts(thread_id, status);
```

- [ ] **Step 2: Draft-Typen an `src/types/messages.ts` anhängen**

```typescript
// --- Drafts (outbound reply, Schnitt 1) ---
export type DraftStatus = 'pending' | 'sent' | 'error' | 'discarded';

export interface MessageDraft {
  id: string;
  thread_id: string;
  provider: 'hostex' | 'guesty';
  body: string;
  status: DraftStatus;
  generated_by: 'manual' | 'llm';
  send_attempts: number;
  external_message_id: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

export type NewDraft = Pick<MessageDraft, 'id' | 'thread_id' | 'provider' | 'body' | 'generated_by'>;
```

- [ ] **Step 3: Failing test schreiben**

```typescript
// src/repositories/draft-repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createDraft, getDraftById, getActiveDraftByThread,
  markDraftSent, markDraftError, discardDraft,
} from './draft-repository.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE message_drafts (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider TEXT NOT NULL,
    body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    generated_by TEXT NOT NULL DEFAULT 'manual', send_attempts INTEGER NOT NULL DEFAULT 0,
    external_message_id TEXT, error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT
  );`);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('draft-repository', () => {
  it('creates and reads a pending draft', () => {
    createDraft({ id: 'd1', thread_id: 'hostex:c1', provider: 'hostex', body: 'Hallo', generated_by: 'manual' });
    const d = getDraftById('d1');
    expect(d?.status).toBe('pending');
    expect(d?.body).toBe('Hallo');
    expect(getActiveDraftByThread('hostex:c1')?.id).toBe('d1');
  });

  it('markDraftSent moves draft out of active and records external id', () => {
    createDraft({ id: 'd2', thread_id: 'hostex:c2', provider: 'hostex', body: 'x', generated_by: 'manual' });
    markDraftSent('d2', 'ext-99');
    expect(getActiveDraftByThread('hostex:c2')).toBeNull();
    const d = getDraftById('d2');
    expect(d?.status).toBe('sent');
    expect(d?.external_message_id).toBe('ext-99');
    expect(d?.sent_at).not.toBeNull();
  });

  it('markDraftError increments attempts and keeps error text', () => {
    createDraft({ id: 'd3', thread_id: 'hostex:c3', provider: 'hostex', body: 'x', generated_by: 'manual' });
    markDraftError('d3', 'boom');
    const d = getDraftById('d3');
    expect(d?.status).toBe('error');
    expect(d?.send_attempts).toBe(1);
    expect(d?.error).toBe('boom');
  });

  it('discardDraft removes it from active', () => {
    createDraft({ id: 'd4', thread_id: 'hostex:c4', provider: 'hostex', body: 'x', generated_by: 'manual' });
    discardDraft('d4');
    expect(getActiveDraftByThread('hostex:c4')).toBeNull();
    expect(getDraftById('d4')?.status).toBe('discarded');
  });
});
```

- [ ] **Step 4: Test ausführen — muss fehlschlagen**

Run: `npx vitest run src/repositories/draft-repository.test.ts`
Expected: FAIL („Failed to resolve import './draft-repository.js'" bzw. „createDraft is not a function").

- [ ] **Step 5: Repository implementieren**

```typescript
// src/repositories/draft-repository.ts
import { getDatabase } from '../db/index.js';
import type { MessageDraft, NewDraft } from '../types/messages.js';

export function createDraft(d: NewDraft): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO message_drafts (id, thread_id, provider, body, generated_by)
     VALUES (@id, @thread_id, @provider, @body, @generated_by)`,
  ).run(d);
}

export function getDraftById(id: string): MessageDraft | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM message_drafts WHERE id = ?`).get(id) as MessageDraft | undefined;
  return row ?? null;
}

export function getActiveDraftByThread(threadId: string): MessageDraft | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM message_drafts WHERE thread_id = ? AND status = 'pending'
              ORDER BY created_at DESC LIMIT 1`)
    .get(threadId) as MessageDraft | undefined;
  return row ?? null;
}

export function markDraftSent(id: string, externalMessageId: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE message_drafts
     SET status = 'sent', external_message_id = ?, sent_at = datetime('now'), error = NULL
     WHERE id = ?`,
  ).run(externalMessageId, id);
}

export function markDraftError(id: string, error: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE message_drafts
     SET status = 'error', error = ?, send_attempts = send_attempts + 1
     WHERE id = ?`,
  ).run(error, id);
}

export function discardDraft(id: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE message_drafts SET status = 'discarded' WHERE id = ?`).run(id);
}
```

- [ ] **Step 6: Test ausführen — muss grün sein**

Run: `npx vitest run src/repositories/draft-repository.test.ts`
Expected: PASS (4 Tests).

- [ ] **Step 7: Migration lokal einspielen (Smoke)**

Run: `npm run db:migrate`
Expected: Migration `018_add_message_drafts.sql` wird angewandt (in Ausgabe/`migrations`-Tabelle sichtbar), keine Fehler.

- [ ] **Step 8: Commit**

```bash
git add src/db/migrations/018_add_message_drafts.sql src/types/messages.ts src/repositories/draft-repository.ts src/repositories/draft-repository.test.ts
git commit -m "feat(drafts): message_drafts table + draft repository"
```

---

### Task 3: Hostex-Client — Nachrichten lesen & senden

**Files:**
- Modify: `src/services/hostex-client.ts`
- Create: `src/scripts/verify-hostex-messages.ts` (manuelle Verifikation)

**Interfaces:**
- Consumes: bestehendes privates `call<T>(method, path, body?)` (Zeile ~60), `this.baseUrl`.
- Produces (Methoden auf `HostexClient`):
  - `getConversations(opts?: { limit?: number; offset?: number }): Promise<HostexConversation[]>`
  - `getConversationDetails(conversationId: string): Promise<HostexConversationDetail>`
  - `sendMessage(conversationId: string, message: string): Promise<{ message_id: string }>`
- Produces (Typen, exportiert):
  - `interface HostexGuest { name: string | null; email: string | null }`
  - `interface HostexConversation { id: string; channel_type: string; guest: HostexGuest | null }`
  - `interface HostexMessageRaw { id: string; sender_role: string; display_type: string; content: string; created_at: string }`
  - `interface HostexConversationDetail extends HostexConversation { messages: HostexMessageRaw[] }`

> **Feld-Reconciliation (aus Task-1-Fixture bestätigt):** Reale Form ist
> Conversation `{ id, channel_type, guest: { name, phone, email }, messages }`,
> Message `{ id, sender_role ('guest'|'host'), sender_name, display_type ('Text'|'Box'|'ReservationAlteration'), content, created_at }`.
> **Wichtig:** Der List-Endpoint verlangt zwingend `offset` (sonst HTTP 400) — die
> Methode `getConversations` sendet ihn immer mit. Nur `display_type === 'Text'`
> sind echte Gast/Host-Texte; `Box`/`ReservationAlteration` sind System-Karten
> (in Task 4 herausfiltern).

- [ ] **Step 1: Typen + Methoden in `hostex-client.ts` ergänzen**

```typescript
// Typen (oben bei den anderen Hostex-Typen einordnen)
export interface HostexGuest {
  name: string | null;
  email: string | null;
}
export interface HostexConversation {
  id: string;
  channel_type: string;
  guest: HostexGuest | null;
}
export interface HostexMessageRaw {
  id: string;
  sender_role: string;   // 'guest' | 'host'
  display_type: string;  // 'Text' | 'Box' | 'ReservationAlteration' — nur 'Text' ist echter Gesprächstext
  content: string;
  created_at: string;
}
export interface HostexConversationDetail extends HostexConversation {
  messages: HostexMessageRaw[];
}

// Methoden (in der HostexClient-Klasse, neben getProperties()):
// NB: der private call<T>() entpackt die Hostex-Envelope bereits (`return envelope.data`),
// daher hier NUR eine Ebene tippen — sonst käme undefined/leer zurück.
async getConversations(opts: { limit?: number; offset?: number } = {}): Promise<HostexConversation[]> {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;  // offset ist Pflicht (HTTP 400 ohne)
  const res = await this.call<{ conversations: HostexConversation[] }>(
    'GET', `/conversations?limit=${limit}&offset=${offset}`,
  );
  return res.conversations ?? [];
}

async getConversationDetails(conversationId: string): Promise<HostexConversationDetail> {
  return this.call<HostexConversationDetail>('GET', `/conversations/${conversationId}`);
}

async sendMessage(conversationId: string, message: string): Promise<{ message_id: string }> {
  const res = await this.call<{ message_id: string }>(
    'POST', `/conversations/${conversationId}`, { message },
  );
  return { message_id: res.message_id ?? '' };
}
```

- [ ] **Step 2: Manuelles Verifikationsskript schreiben (nur lesen — kein Send)**

```typescript
// src/scripts/verify-hostex-messages.ts
import 'dotenv/config';
import { getHostexClient } from '../services/hostex-client.js';

async function main() {
  const client = getHostexClient();
  const convs = await client.getConversations({ limit: 3 });
  console.log('conversations:', convs.length);
  console.log('first:', JSON.stringify(convs[0], null, 2));
  if (convs[0]) {
    const detail = await client.getConversationDetails(convs[0].id);
    console.log('messages in first:', detail.messages?.length);
    console.log('sample message:', JSON.stringify(detail.messages?.[0], null, 2));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Verifikationsskript ausführen**

Run: `npx tsx src/scripts/verify-hostex-messages.ts`
Expected: Konsole listet echte Conversations + eine Beispielnachricht; die Feldnamen decken sich mit den Typen aus Step 1 (sonst Typen anpassen und Step 3 wiederholen).

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: keine Fehler in `hostex-client.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/services/hostex-client.ts src/scripts/verify-hostex-messages.ts
git commit -m "feat(hostex): conversation read + sendMessage client methods"
```

---

### Task 4: Hostex-Message-Mapper (rein, TDD)

**Files:**
- Modify: `src/types/messages.ts` (`MessageSource` erweitern)
- Create: `src/mappers/hostex/message-mapper.ts`
- Test: `src/mappers/hostex/message-mapper.test.ts`

**Interfaces:**
- Consumes: `HostexConversationDetail`, `HostexMessageRaw` aus `../../services/hostex-client.js`; `NewMessageThread`, `NewMessage`, `MessageChannel` aus `../../types/messages.js`.
- Produces:
  - `mapHostexDirection(senderRole: string): 'inbound' | 'outbound' | 'system'`
  - `mapHostexChannel(channelType: string): MessageChannel`
  - `mapHostexConversation(detail: HostexConversationDetail, listingId: string, now: string): { thread: NewMessageThread; messages: NewMessage[] }` — filtert Nachrichten auf `display_type === 'Text'` (System-Karten `Box`/`ReservationAlteration` werden verworfen); Gastname aus `detail.guest?.name`.

- [ ] **Step 1: `MessageSource` in `src/types/messages.ts` erweitern**

Ändere die Union (aktuell `'guesty' | 'gmail'`) zu:

```typescript
export type MessageSource = 'guesty' | 'gmail' | 'hostex';
```

- [ ] **Step 2: Failing test schreiben**

```typescript
// src/mappers/hostex/message-mapper.test.ts
import { describe, it, expect } from 'vitest';
import { mapHostexDirection, mapHostexChannel, mapHostexConversation } from './message-mapper.js';
import type { HostexConversationDetail } from '../../services/hostex-client.js';

describe('hostex message mapper', () => {
  it('maps sender role to direction', () => {
    expect(mapHostexDirection('guest')).toBe('inbound');
    expect(mapHostexDirection('host')).toBe('outbound');
    expect(mapHostexDirection('automation')).toBe('system');
  });

  it('maps channel_type to internal channel', () => {
    expect(mapHostexChannel('airbnb')).toBe('airbnb');
    expect(mapHostexChannel('booking.com')).toBe('booking.com');
    expect(mapHostexChannel('manual')).toBe('manual');
    expect(mapHostexChannel('whatever')).toBe('other');
  });

  it('maps a conversation to thread + messages with stable ids, filtering non-Text', () => {
    const detail: HostexConversationDetail = {
      id: 'c-1', channel_type: 'airbnb', guest: { name: 'Darleen', email: '' },
      messages: [
        { id: 'm-1', sender_role: 'guest', display_type: 'Text', content: 'Hallo', created_at: '2026-06-30T10:00:00Z' },
        { id: 'm-2', sender_role: 'host', display_type: 'Text', content: 'Hi', created_at: '2026-06-30T11:00:00Z' },
        { id: 'm-3', sender_role: 'guest', display_type: 'ReservationAlteration', content: '', created_at: '2026-06-30T12:00:00Z' },
      ],
    };
    const { thread, messages } = mapHostexConversation(detail, 'listing-9', '2026-07-01T00:00:00Z');

    expect(thread.id).toBe('hostex:c-1');
    expect(thread.listing_id).toBe('listing-9');
    expect(thread.source).toBe('hostex');
    expect(thread.channel).toBe('airbnb');
    expect(thread.guest_name).toBe('Darleen');
    expect(thread.message_count).toBe(2); // only Text messages counted
    expect(thread.first_message_at).toBe('2026-06-30T10:00:00Z');
    expect(thread.last_message_at).toBe('2026-06-30T11:00:00Z');

    // the ReservationAlteration system card (m-3) is filtered out
    expect(messages.map((m) => m.id)).toEqual(['hostex:m-1', 'hostex:m-2']);
    expect(messages[0].direction).toBe('inbound');
    expect(messages[0].thread_id).toBe('hostex:c-1');
    expect(messages[0].body).toBe('Hallo');
    expect(messages[0].source).toBe('hostex');
  });
});
```

- [ ] **Step 3: Test ausführen — muss fehlschlagen**

Run: `npx vitest run src/mappers/hostex/message-mapper.test.ts`
Expected: FAIL („Failed to resolve import './message-mapper.js'").

- [ ] **Step 4: Mapper implementieren**

```typescript
// src/mappers/hostex/message-mapper.ts
import type { HostexConversationDetail } from '../../services/hostex-client.js';
import type { NewMessageThread, NewMessage, MessageChannel } from '../../types/messages.js';

export function mapHostexDirection(senderRole: string): 'inbound' | 'outbound' | 'system' {
  if (senderRole === 'guest') return 'inbound';
  if (senderRole === 'host') return 'outbound';
  return 'system';
}

export function mapHostexChannel(channelType: string): MessageChannel {
  const s = (channelType ?? '').toLowerCase();
  if (s === 'airbnb' || s === 'airbnb2') return 'airbnb';
  if (s === 'booking.com' || s === 'bookingcom') return 'booking.com';
  if (s.startsWith('vrbo')) return 'vrbo';
  if (s === 'manual') return 'manual';
  return 'other';
}

export function mapHostexConversation(
  detail: HostexConversationDetail,
  listingId: string,
  now: string,
): { thread: NewMessageThread; messages: NewMessage[] } {
  const threadId = `hostex:${detail.id}`;
  // Only 'Text' messages are real guest/host conversation; 'Box' and
  // 'ReservationAlteration' are system cards (Task-1-Fixture bestätigt).
  const posts = (detail.messages ?? []).filter((p) => p.display_type === 'Text');
  const guestName = detail.guest?.name ?? null;
  const times = posts.map((p) => p.created_at).filter(Boolean).sort();
  const firstAt = times[0] ?? now;
  const lastAt = times[times.length - 1] ?? now;

  const thread: NewMessageThread = {
    id: threadId,
    listing_id: listingId,
    source: 'hostex',
    channel: mapHostexChannel(detail.channel_type),
    guest_name: guestName,
    guest_email: null,
    first_message_at: firstAt,
    last_message_at: lastAt,
    message_count: posts.length,
    reservation_id: null,
    inquiry_id: null,
    reservation_status: null,
    conversion_category: null,
    classification_confidence: null,
    classification_keywords: null,
    raw_meta: JSON.stringify({ channel_type: detail.channel_type }),
    last_synced_at: now,
  };

  const messages: NewMessage[] = posts.map((p) => ({
    id: `hostex:${p.id}`,
    thread_id: threadId,
    direction: mapHostexDirection(p.sender_role),
    sent_at: p.created_at ?? now,
    from_name: p.sender_role === 'host' ? 'host' : guestName,
    from_address: null,
    to_address: null,
    subject: null,
    body: p.content ?? '',
    body_html: null,
    source: 'hostex',
    raw_meta: JSON.stringify({ sender_role: p.sender_role }),
  }));

  return { thread, messages };
}
```

> **Hinweis:** Falls `NewMessageThread`/`NewMessage` in `types/messages.ts` zusätzliche Pflichtfelder haben, die hier fehlen (TypeScript-Fehler beim Build), diese mit `null`/Defaults ergänzen — exakt wie der Guesty-Sync sie setzt (`src/jobs/sync-guesty-messages.ts`, Thread-/Message-Objektliterale).

- [ ] **Step 5: Test ausführen — muss grün sein**

Run: `npx vitest run src/mappers/hostex/message-mapper.test.ts`
Expected: PASS (3 Tests).

- [ ] **Step 6: Commit**

```bash
git add src/types/messages.ts src/mappers/hostex/message-mapper.ts src/mappers/hostex/message-mapper.test.ts
git commit -m "feat(hostex): pure message mapper + hostex MessageSource"
```

---

### Task 5: Hostex-Message-Sync-Job

**Files:**
- Create: `src/jobs/hostex/sync-hostex-messages.ts`
- Test: `src/jobs/hostex/sync-hostex-messages.test.ts`

**Interfaces:**
- Consumes: `mapHostexConversation` (Task 4); `upsertThread`, `upsertMessage` aus `../../repositories/message-repository.js`; `HostexConversation`, `HostexConversationDetail` (Task 3); `PropertyConfig` aus `../../config/properties.js`.
- Produces:
  - `interface HostexMessageSyncResult { success: boolean; threads: number; messages: number; error?: string }`
  - `syncHostexMessagesForProperty(property: PropertyConfig, client: HostexMessageClient, now?: string): Promise<HostexMessageSyncResult>`
  - `interface HostexMessageClient { getConversations(o?: { limit?: number; offset?: number }): Promise<HostexConversation[]>; getConversationDetails(id: string): Promise<HostexConversationDetail> }`

> Der Client wird als Parameter injiziert (statt intern `getHostexClient()` zu rufen), damit der Job ohne Netzwerk testbar ist. Der Scheduler übergibt den echten Client (Step 7).

- [ ] **Step 1: Failing test schreiben**

```typescript
// src/jobs/hostex/sync-hostex-messages.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../../db/index.js';
import { getMessagesByThread, getThreadById } from '../../repositories/message-repository.js';
import { syncHostexMessagesForProperty, type HostexMessageClient } from './sync-hostex-messages.js';
import type { PropertyConfig } from '../../config/properties.js';

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
  `);
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

const fakeClient: HostexMessageClient = {
  async getConversations() {
    return [{ id: 'c-1', channel_type: 'airbnb', guest: { name: 'Darleen', email: '' } }];
  },
  async getConversationDetails() {
    return {
      id: 'c-1', channel_type: 'airbnb', guest: { name: 'Darleen', email: '' },
      messages: [
        { id: 'm-1', sender_role: 'guest', display_type: 'Text', content: 'Hallo', created_at: '2026-06-30T10:00:00Z' },
      ],
    };
  },
};

const property = { slug: 'bootshaus', hostexPropertyId: 'listing-9' } as unknown as PropertyConfig;

describe('syncHostexMessagesForProperty', () => {
  it('persists threads and messages', async () => {
    const res = await syncHostexMessagesForProperty(property, fakeClient, '2026-07-01T00:00:00Z');
    expect(res.success).toBe(true);
    expect(res.threads).toBe(1);
    expect(res.messages).toBe(1);
    expect(getThreadById('hostex:c-1')?.guest_name).toBe('Darleen');
    expect(getMessagesByThread('hostex:c-1')[0].body).toBe('Hallo');
  });

  it('is idempotent on re-run (no duplicate rows)', async () => {
    await syncHostexMessagesForProperty(property, fakeClient, '2026-07-01T00:00:00Z');
    await syncHostexMessagesForProperty(property, fakeClient, '2026-07-01T01:00:00Z');
    expect(getMessagesByThread('hostex:c-1').length).toBe(1);
  });

  it('fails cleanly when hostexPropertyId is missing', async () => {
    const bad = { slug: 'x' } as unknown as PropertyConfig;
    const res = await syncHostexMessagesForProperty(bad, fakeClient, '2026-07-01T00:00:00Z');
    expect(res.success).toBe(false);
  });
});
```

- [ ] **Step 2: Test ausführen — muss fehlschlagen**

Run: `npx vitest run src/jobs/hostex/sync-hostex-messages.test.ts`
Expected: FAIL („Failed to resolve import './sync-hostex-messages.js'").

- [ ] **Step 3: Sync-Job implementieren**

```typescript
// src/jobs/hostex/sync-hostex-messages.ts
import { upsertThread, upsertMessage } from '../../repositories/message-repository.js';
import { mapHostexConversation } from '../../mappers/hostex/message-mapper.js';
import type { HostexConversation, HostexConversationDetail } from '../../services/hostex-client.js';
import type { PropertyConfig } from '../../config/properties.js';
import logger from '../../utils/logger.js';

export interface HostexMessageClient {
  getConversations(o?: { limit?: number; offset?: number }): Promise<HostexConversation[]>;
  getConversationDetails(id: string): Promise<HostexConversationDetail>;
}

export interface HostexMessageSyncResult {
  success: boolean;
  threads: number;
  messages: number;
  error?: string;
}

export async function syncHostexMessagesForProperty(
  property: PropertyConfig,
  client: HostexMessageClient,
  now: string = new Date().toISOString(),
): Promise<HostexMessageSyncResult> {
  const listingId = property.hostexPropertyId;
  if (!listingId) {
    return { success: false, threads: 0, messages: 0, error: 'No hostexPropertyId on property' };
  }

  try {
    const convs = await client.getConversations({ limit: 100 });
    let threads = 0;
    let messages = 0;

    for (const conv of convs) {
      const detail = await client.getConversationDetails(conv.id);
      const { thread, messages: msgs } = mapHostexConversation(detail, listingId, now);
      upsertThread(thread);
      for (const m of msgs) {
        upsertMessage(m);
        messages++;
      }
      threads++;
    }

    logger.info({ slug: property.slug, threads, messages }, 'Hostex: message sync done');
    return { success: true, threads, messages };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ slug: property.slug, err: msg }, 'Hostex: message sync failed');
    return { success: false, threads: 0, messages: 0, error: msg };
  }
}
```

- [ ] **Step 4: Test ausführen — muss grün sein**

Run: `npx vitest run src/jobs/hostex/sync-hostex-messages.test.ts`
Expected: PASS (3 Tests).

- [ ] **Step 5: In den Scheduler einhängen**

Öffne `src/jobs/scheduler.ts`. Finde die Stelle, an der Hostex-Properties gesynct werden (dort, wo `syncHostexReservations`/andere Hostex-Jobs pro Property aufgerufen werden). Ergänze direkt daneben — mit echtem Client:

```typescript
import { getHostexClient } from '../services/hostex-client.js';
import { syncHostexMessagesForProperty } from './hostex/sync-hostex-messages.js';

// ... innerhalb der Property-Schleife für Hostex-Properties (provider === 'hostex'):
await syncHostexMessagesForProperty(property, getHostexClient());
```

> Falls der Scheduler Hostex-Jobs noch nicht pro Property iteriert, orientiere dich exakt an `syncHostexReservations`-Aufrufstelle und füge den Message-Sync im selben Block hinzu.

- [ ] **Step 6: Manueller End-to-End-Lesetest gegen echte API**

Run: `npx tsx src/scripts/verify-hostex-messages.ts` (aus Task 3, liest bereits echt)
Danach optional den Sync einmal manuell über den bestehenden Sync-Runner anstoßen: `npm run sync` und in der DB (`data/calendar.db`) prüfen, dass `message_threads`/`messages` mit `source='hostex'` Zeilen enthalten.
Expected: Hostex-Threads erscheinen in der DB.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/hostex/sync-hostex-messages.ts src/jobs/hostex/sync-hostex-messages.test.ts src/jobs/scheduler.ts
git commit -m "feat(hostex): message sync job wired into scheduler"
```

---

### Task 6: `sendReply`-Abstraktion (provider-dispatch)

**Files:**
- Create: `src/services/message-sender.ts`
- Test: `src/services/message-sender.test.ts`

**Interfaces:**
- Consumes: `MessageThread` aus `../types/messages.js`; `getHostexClient()` aus `./hostex-client.js`.
- Produces:
  - `interface SendDeps { hostexSend(conversationId: string, body: string): Promise<{ message_id: string }> }`
  - `sendReply(thread: MessageThread, body: string, deps?: SendDeps): Promise<{ externalMessageId: string }>`

- [ ] **Step 1: Failing test schreiben**

```typescript
// src/services/message-sender.test.ts
import { describe, it, expect, vi } from 'vitest';
import { sendReply } from './message-sender.js';
import type { MessageThread } from '../types/messages.js';

function thread(source: MessageThread['source'], id: string): MessageThread {
  return {
    id, listing_id: 'L', source, channel: 'airbnb', guest_name: 'G', guest_email: null,
    first_message_at: '', last_message_at: '', message_count: 1, reservation_id: null,
    inquiry_id: null, reservation_status: null, conversion_category: null,
    classification_confidence: null, classification_keywords: null, classification_reasoning: null,
    raw_meta: null, manually_categorized: 0, manual_note: null, linked_thread_id: null, last_synced_at: '',
  };
}

describe('sendReply', () => {
  it('sends a hostex reply with the conversation id stripped of prefix', async () => {
    const hostexSend = vi.fn().mockResolvedValue({ message_id: 'ext-7' });
    const res = await sendReply(thread('hostex', 'hostex:c-42'), 'Hallo', { hostexSend });
    expect(hostexSend).toHaveBeenCalledWith('c-42', 'Hallo');
    expect(res.externalMessageId).toBe('ext-7');
  });

  it('throws for guesty in Schnitt 1', async () => {
    await expect(sendReply(thread('guesty', 'guesty:x'), 'Hi')).rejects.toThrow(/not implemented/i);
  });
});
```

- [ ] **Step 2: Test ausführen — muss fehlschlagen**

Run: `npx vitest run src/services/message-sender.test.ts`
Expected: FAIL („Failed to resolve import './message-sender.js'").

- [ ] **Step 3: Implementieren**

```typescript
// src/services/message-sender.ts
import type { MessageThread } from '../types/messages.js';
import { getHostexClient } from './hostex-client.js';

export interface SendDeps {
  hostexSend(conversationId: string, body: string): Promise<{ message_id: string }>;
}

const defaultDeps: SendDeps = {
  hostexSend: (conversationId, body) => getHostexClient().sendMessage(conversationId, body),
};

export async function sendReply(
  thread: MessageThread,
  body: string,
  deps: SendDeps = defaultDeps,
): Promise<{ externalMessageId: string }> {
  if (thread.source === 'hostex') {
    const conversationId = thread.id.replace(/^hostex:/, '');
    const { message_id } = await deps.hostexSend(conversationId, body);
    return { externalMessageId: message_id };
  }
  throw new Error(`sendReply: provider '${thread.source}' not implemented (Schnitt 1 = Hostex only)`);
}
```

- [ ] **Step 4: Test ausführen — muss grün sein**

Run: `npx vitest run src/services/message-sender.test.ts`
Expected: PASS (2 Tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/message-sender.ts src/services/message-sender.test.ts
git commit -m "feat(messaging): sendReply provider-dispatch (hostex branch)"
```

---

### Task 7: „Antwort nötig"-Abfrage im message-repository

**Files:**
- Modify: `src/repositories/message-repository.ts`
- Test: `src/repositories/message-repository.needs-reply.test.ts`

**Interfaces:**
- Consumes: `getDatabase()`.
- Produces: `getThreadsNeedingReply(): MessageThread[]` — Threads, deren jüngste Nachricht `direction='inbound'` ist (also unbeantwortet), sortiert nach `last_message_at DESC`.

- [ ] **Step 1: Failing test schreiben**

```typescript
// src/repositories/message-repository.needs-reply.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setDatabase, resetDatabase } from '../db/index.js';
import { getThreadsNeedingReply } from './message-repository.js';

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
  `);
  setDatabase(db);
  const t = db.prepare(`INSERT INTO message_threads
    (id,listing_id,source,channel,first_message_at,last_message_at,last_synced_at)
    VALUES (?,?,?,?,?,?,?)`);
  t.run('hostex:a', 'L', 'hostex', 'airbnb', '2026-06-30T09:00:00Z', '2026-06-30T10:00:00Z', 'now');
  t.run('hostex:b', 'L', 'hostex', 'airbnb', '2026-06-30T09:00:00Z', '2026-06-30T11:00:00Z', 'now');
  const m = db.prepare(`INSERT INTO messages (id,thread_id,direction,sent_at,body,source)
    VALUES (?,?,?,?,?,?)`);
  // Thread a: last message is inbound -> needs reply
  m.run('m1', 'hostex:a', 'inbound', '2026-06-30T10:00:00Z', 'Frage', 'hostex');
  // Thread b: last message is outbound (already answered) -> no reply needed
  m.run('m2', 'hostex:b', 'inbound', '2026-06-30T10:00:00Z', 'Frage', 'hostex');
  m.run('m3', 'hostex:b', 'outbound', '2026-06-30T11:00:00Z', 'Antwort', 'hostex');
});
afterEach(() => { resetDatabase(); db.close(); });

describe('getThreadsNeedingReply', () => {
  it('returns only threads whose latest message is inbound', () => {
    const ids = getThreadsNeedingReply().map((t) => t.id);
    expect(ids).toEqual(['hostex:a']);
  });
});
```

- [ ] **Step 2: Test ausführen — muss fehlschlagen**

Run: `npx vitest run src/repositories/message-repository.needs-reply.test.ts`
Expected: FAIL („getThreadsNeedingReply is not a function").

- [ ] **Step 3: Funktion an `message-repository.ts` anhängen**

```typescript
import type { MessageThread } from '../types/messages.js'; // falls noch nicht importiert

export function getThreadsNeedingReply(): MessageThread[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT t.* FROM message_threads t
       WHERE (
         SELECT m.direction FROM messages m
         WHERE m.thread_id = t.id
         ORDER BY m.sent_at DESC, m.created_at DESC
         LIMIT 1
       ) = 'inbound'
       ORDER BY t.last_message_at DESC`,
    )
    .all() as MessageThread[];
}
```

- [ ] **Step 4: Test ausführen — muss grün sein**

Run: `npx vitest run src/repositories/message-repository.needs-reply.test.ts`
Expected: PASS (1 Test).

- [ ] **Step 5: Commit**

```bash
git add src/repositories/message-repository.ts src/repositories/message-repository.needs-reply.test.ts
git commit -m "feat(messaging): getThreadsNeedingReply query"
```

---

### Task 8: Admin-Routen + Minimal-UI (Freigabe & Senden)

**Files:**
- Create: `src/routes/messages.ts`
- Modify: `src/app.ts` (Router mounten)

**Interfaces:**
- Consumes: `getThreadsNeedingReply`, `getThreadById`, `getMessagesByThread` (message-repository); `createDraft`, `getDraftById`, `getActiveDraftByThread`, `markDraftSent`, `markDraftError` (draft-repository); `sendReply` (message-sender); `upsertMessage` (message-repository); `requireAuth` wird beim Mount in `app.ts` gesetzt.
- Produces: Express-Router mit
  - `GET /admin/messages` — Liste offener Threads
  - `GET /admin/messages/:threadId` — Verlauf + Draft-Formular
  - `POST /admin/messages/:threadId/draft` — Draft aus Formularfeld `body` anlegen (`generated_by='manual'`)
  - `POST /admin/drafts/:draftId/send` — Freigabe-Klick: sendet & persistiert
  - `POST /admin/drafts/:draftId/discard` — verwirft Draft

> Kein Unit-Test (Repo hat kein supertest). Verifikation manuell im Browser (Step 4). Die Logik-Bausteine dahinter (Repos, sender, query) sind bereits getestet.

- [ ] **Step 1: Router implementieren**

```typescript
// src/routes/messages.ts
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  getThreadsNeedingReply, getThreadById, getMessagesByThread, upsertMessage,
} from '../repositories/message-repository.js';
import {
  createDraft, getDraftById, getActiveDraftByThread, markDraftSent, markDraftError,
} from '../repositories/draft-repository.js';
import { sendReply } from '../services/message-sender.js';

const router = express.Router();

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// Liste offener Threads
router.get('/', (_req, res) => {
  const threads = getThreadsNeedingReply();
  const rows = threads.map((t) =>
    `<li><a href="/admin/messages/${encodeURIComponent(t.id)}">${esc(t.guest_name) || t.id}</a>
     — ${esc(t.channel)} — ${esc(t.last_message_at)}</li>`,
  ).join('');
  res.type('html').send(`<h1>Offene Nachrichten (${threads.length})</h1><ul>${rows}</ul>`);
});

// Thread-Detail + Draft-Formular
router.get('/:threadId', (req, res) => {
  const thread = getThreadById(req.params.threadId);
  if (!thread) return res.status(404).send('Thread nicht gefunden');
  const msgs = getMessagesByThread(thread.id);
  const draft = getActiveDraftByThread(thread.id);
  const history = msgs.map((m) =>
    `<div class="${m.direction}"><b>${esc(m.direction)}</b> ${esc(m.sent_at)}<br>${esc(m.body)}</div>`,
  ).join('<hr>');

  const draftBlock = draft
    ? `<h3>Entwurf</h3><pre>${esc(draft.body)}</pre>
       <form method="POST" action="/admin/drafts/${draft.id}/send">
         <button type="submit">Senden (Freigabe)</button></form>
       <form method="POST" action="/admin/drafts/${draft.id}/discard">
         <button type="submit">Verwerfen</button></form>`
    : `<h3>Antwort verfassen</h3>
       <form method="POST" action="/admin/messages/${encodeURIComponent(thread.id)}/draft">
         <textarea name="body" rows="6" cols="60" required></textarea><br>
         <button type="submit">Entwurf speichern</button></form>`;

  res.type('html').send(
    `<a href="/admin/messages">&larr; zurück</a>
     <h1>${esc(thread.guest_name) || thread.id}</h1>
     <p>Kanal: ${esc(thread.channel)} — Provider: ${esc(thread.source)}</p>
     ${history}<hr>${draftBlock}`,
  );
});

// Draft anlegen (manuell)
router.post('/:threadId/draft', express.urlencoded({ extended: true }), (req, res, next) => {
  try {
    const thread = getThreadById(req.params.threadId);
    if (!thread) return res.status(404).send('Thread nicht gefunden');
    const body = String((req.body?.body ?? '')).trim();
    if (!body) return res.status(400).send('Leerer Entwurf');
    if (getActiveDraftByThread(thread.id)) return res.status(409).send('Es existiert bereits ein offener Entwurf');
    createDraft({
      id: randomUUID(), thread_id: thread.id,
      provider: thread.source === 'guesty' ? 'guesty' : 'hostex',
      body, generated_by: 'manual',
    });
    res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}`);
  } catch (e) { next(e); }
});

// Freigabe: senden
router.post('/drafts/:draftId/send', async (req, res, next) => {
  try {
    const draft = getDraftById(req.params.draftId);
    if (!draft) return res.status(404).send('Entwurf nicht gefunden');
    if (draft.status !== 'pending') return res.status(409).send('Entwurf ist nicht mehr offen');
    const thread = getThreadById(draft.thread_id);
    if (!thread) return res.status(404).send('Thread nicht gefunden');

    try {
      const { externalMessageId } = await sendReply(thread, draft.body);
      markDraftSent(draft.id, externalMessageId);
      upsertMessage({
        id: `sent:${draft.id}`, thread_id: thread.id, direction: 'outbound',
        sent_at: new Date().toISOString(), from_name: 'host', from_address: null, to_address: null,
        subject: null, body: draft.body, body_html: null, source: thread.source,
        raw_meta: JSON.stringify({ draftId: draft.id, externalMessageId }),
      });
      res.redirect(`/admin/messages/${encodeURIComponent(thread.id)}`);
    } catch (sendErr) {
      markDraftError(draft.id, sendErr instanceof Error ? sendErr.message : String(sendErr));
      res.status(502).send(`Versand fehlgeschlagen: ${esc(String(sendErr))}`);
    }
  } catch (e) { next(e); }
});

// Verwerfen
router.post('/drafts/:draftId/discard', (req, res, next) => {
  try {
    const draft = getDraftById(req.params.draftId);
    if (!draft) return res.status(404).send('Entwurf nicht gefunden');
    // discardDraft in draft-repository
    // (Import oben ergänzen, falls Linter meckert)
    const { discardDraft } = require('../repositories/draft-repository.js');
    discardDraft(draft.id);
    res.redirect(`/admin/messages/${encodeURIComponent(draft.thread_id)}`);
  } catch (e) { next(e); }
});

export default router;
```

> **Cleanup-Hinweis:** `discardDraft` sauber oben mit importieren (`import { ..., discardDraft } from '../repositories/draft-repository.js'`) und die inline-`require`-Zeile entfernen — ESM erlaubt kein `require`. Der inline-Fallback steht nur als Erinnerung; vor dem Commit ersetzen.

- [ ] **Step 2: Router in `src/app.ts` mounten**

Neben der bestehenden Zeile `app.use('/admin', requireAuth, adminRoutes);` ergänzen:

```typescript
import messagesRoutes from './routes/messages.js';
// ...
app.use('/admin/messages', requireAuth, messagesRoutes);
```

> Reihenfolge: Diese Zeile VOR `app.use('/admin', requireAuth, adminRoutes)` setzen, falls `adminRoutes` einen Catch-all unter `/admin` hat; sonst egal.

- [ ] **Step 3: Import fixen & Lint**

`discardDraft` in den Import oben aufnehmen und die inline-`require`-Zeile entfernen.
Run: `npm run lint`
Expected: keine Fehler.

- [ ] **Step 4: Manueller Browser-Durchstich**

Run: `npm run dev`
Dann im Browser (eingeloggt als Admin): `http://localhost:3000/admin/messages`
Erwartung:
1. Offene Hostex-Threads werden gelistet.
2. Thread öffnen → Verlauf sichtbar → Antwort tippen → „Entwurf speichern".
3. „Senden (Freigabe)" klicken → Nachricht geht über Hostex raus, erscheint als `outbound` im Verlauf, Draft ist weg.
> Für einen echten Sende-Test einen eigenen Test-Thread nutzen (nicht auf echte Gäste). Ohne echten Thread nur die Read-/Draft-Schritte prüfen.

- [ ] **Step 5: Commit**

```bash
git add src/routes/messages.ts src/app.ts
git commit -m "feat(messaging): admin review UI + approve-and-send route (hostex)"
```

---

## Self-Review

**Spec coverage (Schnitt 1 aus dem Vault-Plan `Areas/Software/Guest-Messaging-Integration.md`):**
- 1a Hostex-Nachrichten lesen → Task 1 (Fixture), Task 3 (Client), Task 4 (Mapper), Task 5 (Sync-Job). ✓
- 1b Draft-Tabelle → Task 2. ✓
- 1c Sende-Abstraktion (Hostex-Zweig) → Task 6. ✓
- 1d Routen + Minimal-UI + Freigabe-Send → Task 7 (Query), Task 8 (Routen/UI). ✓
- Gotcha Dedup (idempotenter Sync) → Task 5 Test „idempotent on re-run". ✓
- Gotcha Send-Idempotenz (nur `pending` sendbar) → Task 8 Send-Route Statusprüfung. ✓
- Kein Auto-Send → Draft-Default `pending`, Versand nur per expliziter POST-Route. ✓

**Offen/Folgeschnitt (bewusst NICHT in Schnitt 1):**
- LLM-Entwurf + Voice/Objektwissen aus dem Vault → Schnitt 2.
- Guesty-Send-Zweig → Schnitt 2 (Abstraktion in Task 6 wirft bis dahin klar).
- Webhooks/Echtzeit → später; Polling reicht.
- Reservierungs-/Gastkontext an Hostex-Threads (Task 4 setzt `reservation_id=null`) → Schnitt 2, sobald Hostex-Reservierungen verknüpft werden.

**Type-Konsistenz geprüft:** `MessageSource` erweitert (Task 4) bevor `source:'hostex'` genutzt wird; `NewDraft`/`MessageDraft` in Task 2 definiert und in Task 8 konsumiert; `HostexConversationDetail`/`HostexMessageRaw` in Task 3 definiert, in Task 4/5 konsumiert; `sendReply`-Rückgabe `{externalMessageId}` in Task 6 definiert, in Task 8 konsumiert.

**Bekannte Reconciliation-Punkte (echte Welt):** Hostex-Conversations-Feldnamen werden in Task 1 aus der echten API bestätigt und in Task 3/4 ggf. angepasst. Das ist die einzige Stelle mit externer Unsicherheit — bewusst als erster Task isoliert.

---

## Execution Handoff

Plan gespeichert unter `docs/superpowers/plans/2026-07-01-hostex-reply-slice1.md`.
