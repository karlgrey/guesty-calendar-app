# Schnitt 4 — Guesty-Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Farmhouse Prasser + Uferstraße 19 (Provider Guesty) bekommen KI-Entwürfe und Freigabe-Send hinter der bestehenden Draft-/Freigabe-Abstraktion (`/admin/messages`).

**Architecture:** Der existierende (unverdrahtete) Guesty-Lese-Sync wird in Button + ETL eingehängt; die Draft-Generierung wird provider-agnostisch; `sendReply` bekommt einen Guesty-Zweig, der den Kanal (`module.type`) der letzten Gastnachricht spiegelt. Kein Send bei unklarem Kanal. Kein Auto-Send — jede Nachricht braucht Michas Freigabe-Klick.

**Tech Stack:** Node/TypeScript, better-sqlite3, Vitest (Fake-Deps-Pattern), Guesty Open API (`/communication/...`).

**Spec:** `docs/superpowers/specs/2026-07-07-guesty-send-design.md`

## Global Constraints

- Tests laufen mit `npx vitest run <datei>` (NIE `npm test` — das ist Watch-Mode).
- `npm run lint` ist kaputt (kein eslint.config.js) — nicht verwenden; `npm run build` ist der Typcheck.
- Bestehendes Hostex-Verhalten darf sich NICHT ändern (Cap 10, 72h-Fenster, atomic claim).
- Draft-`provider` ∈ `'hostex' | 'guesty'` (Typ existiert).
- Thread-/Message-IDs: `guesty:{id}`-Prefix (wie `hostex:{id}`).
- Conventional Commits (`feat:`, `test:`, `docs:` …).

---

### Task 1: Kanal-Spiegelung `resolveOutboundModuleType`

**Files:**
- Create: `src/services/guesty-channel.ts`
- Test: `src/services/guesty-channel.test.ts`

**Interfaces:**
- Consumes: `Message` aus `src/types/messages.ts` (Felder `direction`, `raw_meta`).
- Produces: `resolveOutboundModuleType(messages: Message[]): string | null` — Messages chronologisch aufsteigend (wie `getMessagesByThread` sie liefert); liest `raw_meta.type` der LETZTEN inbound-Message; `'log'`/fehlend/kein inbound → `null`.

- [ ] **Step 1: Failing Test schreiben**

```typescript
// src/services/guesty-channel.test.ts
import { describe, it, expect } from 'vitest';
import { resolveOutboundModuleType } from './guesty-channel.js';
import type { Message } from '../types/messages.js';

function msg(direction: Message['direction'], rawMeta: object | null, sentAt: string): Message {
  return {
    id: `m-${sentAt}`, thread_id: 't', direction, sent_at: sentAt,
    from_name: null, from_address: null, to_address: null, subject: null,
    body: 'x', body_html: null, source: 'guesty',
    raw_meta: rawMeta ? JSON.stringify(rawMeta) : null,
  };
}

describe('resolveOutboundModuleType', () => {
  it('mirrors the module type of the last inbound message', () => {
    const messages = [
      msg('inbound', { type: 'platform' }, '2026-01-01'),
      msg('outbound', { type: 'airbnb2' }, '2026-01-02'),
      msg('inbound', { type: 'airbnb2' }, '2026-01-03'),
    ];
    expect(resolveOutboundModuleType(messages)).toBe('airbnb2');
  });

  it('returns null when the last inbound has type log', () => {
    expect(resolveOutboundModuleType([msg('inbound', { type: 'log' }, '2026-01-01')])).toBeNull();
  });

  it('returns null when the last inbound has no type / broken raw_meta', () => {
    expect(resolveOutboundModuleType([msg('inbound', {}, '2026-01-01')])).toBeNull();
    const broken = msg('inbound', null, '2026-01-02');
    broken.raw_meta = '{not json';
    expect(resolveOutboundModuleType([broken])).toBeNull();
  });

  it('returns null when there is no inbound message at all', () => {
    expect(resolveOutboundModuleType([msg('outbound', { type: 'airbnb2' }, '2026-01-01')])).toBeNull();
    expect(resolveOutboundModuleType([])).toBeNull();
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run src/services/guesty-channel.test.ts`
Expected: FAIL („Cannot find module './guesty-channel.js'")

- [ ] **Step 3: Implementierung**

```typescript
// src/services/guesty-channel.ts
import type { Message } from '../types/messages.js';

/**
 * Resolve the Guesty module.type for an outbound reply by mirroring the channel
 * of the LAST inbound guest message (its raw_meta.type, stored by
 * sync-guesty-messages). Strictly the last inbound counts — 'log', missing type,
 * unparseable raw_meta or no inbound at all → null, and callers MUST withhold
 * the send option (reply manually in the Guesty inbox instead).
 */
export function resolveOutboundModuleType(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction !== 'inbound') continue;
    try {
      const meta = m.raw_meta ? (JSON.parse(m.raw_meta) as { type?: unknown }) : null;
      const type = typeof meta?.type === 'string' ? meta.type : null;
      return type && type !== 'log' ? type : null;
    } catch {
      return null;
    }
  }
  return null;
}
```

- [ ] **Step 4: Test grün**

Run: `npx vitest run src/services/guesty-channel.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/services/guesty-channel.ts src/services/guesty-channel.test.ts
git commit -m "feat: Kanal-Spiegelung für Guesty-Sends (resolveOutboundModuleType)"
```

---

### Task 2: `guestyClient.sendConversationMessage`

**Files:**
- Modify: `src/services/guesty-client.ts` (direkt nach `listConversationPosts`, ~Zeile 738)

**Interfaces:**
- Consumes: private `this.request<T>(endpoint, options)` (OAuth + Bottleneck + Backoff, existiert).
- Produces: `sendConversationMessage(conversationId: string, body: string, moduleType: string): Promise<{ messageId: string | null; raw: unknown }>`.

Kein Unit-Test (reiner API-Wrapper, wie die übrigen Client-Methoden; Verifikation beim kontrollierten Erst-Send, Task 10). Die Rohantwort wird geloggt, weil das Response-Schema laut Spec unbekannt ist.

- [ ] **Step 1: Methode einfügen**

```typescript
  /**
   * Send a reply into a conversation, mirroring the guest's channel.
   * moduleType examples: 'airbnb2' (Airbnb), 'platform' (delivered as email).
   * Response schema is undocumented — we log it raw and try common id fields;
   * callers must tolerate messageId === null (fallback dedup key).
   */
  async sendConversationMessage(
    conversationId: string,
    body: string,
    moduleType: string,
  ): Promise<{ messageId: string | null; raw: unknown }> {
    const res = await this.request<any>(
      `/communication/conversations/${conversationId}/send-message`,
      { method: 'POST', body: JSON.stringify({ module: { type: moduleType }, body }) },
    );
    logger.info({ conversationId, moduleType, response: res }, 'Guesty send-message response');
    const candidate = res?.data?._id ?? res?._id ?? res?.data?.post?._id ?? null;
    return { messageId: typeof candidate === 'string' ? candidate : null, raw: res };
  }
```

- [ ] **Step 2: Build als Typcheck**

Run: `npm run build`
Expected: kein Fehler

- [ ] **Step 3: Commit**

```bash
git add src/services/guesty-client.ts
git commit -m "feat: Guesty-Client send-message Endpoint"
```

---

### Task 3: `sendReply` Guesty-Zweig

**Files:**
- Modify: `src/services/message-sender.ts` (komplette Datei ersetzen, ist 23 Zeilen)
- Test: `src/services/message-sender.test.ts`

**Interfaces:**
- Consumes: `resolveOutboundModuleType` (Task 1), `guestyClient.sendConversationMessage` (Task 2), `getMessagesByThread` aus `src/repositories/message-repository.ts`.
- Produces: `sendReply(thread, body, deps?)` → `Promise<{ externalMessageId: string | null }>` (Rückgabetyp wird nullable!). `SendDeps` erweitert um `guestySend` + `getMessages`.

- [ ] **Step 1: Tests erweitern (failing)**

`src/services/message-sender.test.ts` — den Test `'throws for guesty in Schnitt 1'` ERSETZEN durch die drei neuen; Helper `thread()` bleibt; oben ergänzen `import type { Message } from '../types/messages.js';`:

```typescript
function inboundMsg(moduleType: string | null): Message {
  return {
    id: 'm1', thread_id: 'guesty:x', direction: 'inbound', sent_at: '2026-01-01',
    from_name: null, from_address: null, to_address: null, subject: null,
    body: 'q', body_html: null, source: 'guesty',
    raw_meta: moduleType ? JSON.stringify({ type: moduleType }) : null,
  };
}

  it('sends a guesty reply mirroring the last inbound module type', async () => {
    const guestySend = vi.fn().mockResolvedValue({ messageId: 'post-9' });
    const deps = { hostexSend: vi.fn(), guestySend, getMessages: vi.fn().mockReturnValue([inboundMsg('airbnb2')]) };
    const res = await sendReply(thread('guesty', 'guesty:c-1'), 'Hallo', deps);
    expect(guestySend).toHaveBeenCalledWith('c-1', 'Hallo', 'airbnb2');
    expect(res.externalMessageId).toBe('post-9');
  });

  it('refuses a guesty send when the channel cannot be resolved', async () => {
    const deps = { hostexSend: vi.fn(), guestySend: vi.fn(), getMessages: vi.fn().mockReturnValue([inboundMsg(null)]) };
    await expect(sendReply(thread('guesty', 'guesty:c-1'), 'Hi', deps)).rejects.toThrow(/Kanal nicht auflösbar/);
    expect(deps.guestySend).not.toHaveBeenCalled();
  });

  it('still throws for unknown providers', async () => {
    await expect(sendReply(thread('gmail', 'gmail:x'), 'Hi')).rejects.toThrow(/not implemented/i);
  });
```

Der bestehende Hostex-Test muss volle Deps übergeben: `{ hostexSend, guestySend: vi.fn(), getMessages: vi.fn().mockReturnValue([]) }`.

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run src/services/message-sender.test.ts`
Expected: FAIL (guestySend/getMessages nicht im Interface, Guesty wirft not-implemented)

- [ ] **Step 3: Implementierung**

```typescript
// src/services/message-sender.ts
import type { Message, MessageThread } from '../types/messages.js';
import { getHostexClient } from './hostex-client.js';
import { guestyClient } from './guesty-client.js';
import { getMessagesByThread } from '../repositories/message-repository.js';
import { resolveOutboundModuleType } from './guesty-channel.js';

export interface SendDeps {
  hostexSend(conversationId: string, body: string): Promise<{ message_id: string }>;
  guestySend(conversationId: string, body: string, moduleType: string): Promise<{ messageId: string | null }>;
  getMessages(threadId: string): Message[];
}

const defaultDeps: SendDeps = {
  hostexSend: (conversationId, body) => getHostexClient().sendMessage(conversationId, body),
  guestySend: (conversationId, body, moduleType) =>
    guestyClient.sendConversationMessage(conversationId, body, moduleType),
  getMessages: getMessagesByThread,
};

export async function sendReply(
  thread: MessageThread,
  body: string,
  deps: SendDeps = defaultDeps,
): Promise<{ externalMessageId: string | null }> {
  if (thread.source === 'hostex') {
    const conversationId = thread.id.replace(/^hostex:/, '');
    const { message_id } = await deps.hostexSend(conversationId, body);
    return { externalMessageId: message_id };
  }
  if (thread.source === 'guesty') {
    const conversationId = thread.id.replace(/^guesty:/, '');
    const moduleType = resolveOutboundModuleType(deps.getMessages(thread.id));
    if (!moduleType) {
      throw new Error('sendReply: Kanal nicht auflösbar — bitte direkt in der Guesty-Inbox antworten');
    }
    const { messageId } = await deps.guestySend(conversationId, body, moduleType);
    return { externalMessageId: messageId };
  }
  throw new Error(`sendReply: provider '${thread.source}' not implemented`);
}
```

- [ ] **Step 4: Tests grün + Build**

Run: `npx vitest run src/services/message-sender.test.ts && npm run build`
Expected: 4 passed; Build ok (Achtung: falls der Build wegen `externalMessageId: string | null` in `routes/messages.ts` meckert, ist das erst nach Task 8 relevant — dort wird die Route angepasst; in dem Fall den Build-Fehler notieren und in Task 8 beheben, Commit hier trotzdem).

- [ ] **Step 5: Commit**

```bash
git add src/services/message-sender.ts src/services/message-sender.test.ts
git commit -m "feat: sendReply Guesty-Zweig mit Kanal-Spiegelung"
```

---

### Task 4: `getThreadsNeedingDraft` bekommt `source`-Parameter

**Files:**
- Modify: `src/repositories/message-repository.ts:231-254`
- Test: `src/repositories/message-repository.needs-draft.test.ts`

**Interfaces:**
- Produces: `getThreadsNeedingDraft(source: 'hostex' | 'guesty', listingId: string, limit: number, sinceModifier: string): MessageThread[]` — Task 5 ruft sie mit beiden Sources auf.

- [ ] **Step 1: Test erweitern (failing)**

In `src/repositories/message-repository.needs-draft.test.ts`: im `beforeEach` zusätzliche Guesty-Zeilen einfügen (nach den hostex-Inserts):

```typescript
  t.run('guesty:g1', 'GL1', 'guesty', 'airbnb', '-1 hour'); // fresh guesty inbound -> NEEDS draft
  m.run('mg1', 'guesty:g1', 'inbound', '-1 hour', 'q', 'guesty');
```

Alle drei bestehenden Aufrufe auf die neue Signatur umstellen — `getThreadsNeedingDraft('hostex', 'L1', …)` — und einen Guesty-Test ergänzen:

```typescript
  it('filters by source: guesty listing only returns guesty threads', () => {
    expect(getThreadsNeedingDraft('guesty', 'GL1', 10, '-72 hours').map((r) => r.id)).toEqual(['guesty:g1']);
    expect(getThreadsNeedingDraft('hostex', 'GL1', 10, '-72 hours')).toEqual([]);
  });
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run src/repositories/message-repository.needs-draft.test.ts`
Expected: FAIL (Signatur passt nicht / falsche Ergebnisse)

- [ ] **Step 3: Implementierung**

In `src/repositories/message-repository.ts` die Funktion ersetzen:

```typescript
export function getThreadsNeedingDraft(
  source: 'hostex' | 'guesty',
  listingId: string,
  limit: number,
  sinceModifier: string,
): MessageThread[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT t.* FROM message_threads t
       WHERE t.source = ? AND t.listing_id = ?
         AND datetime(t.last_message_at) > datetime('now', ?)
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
    .all(source, listingId, sinceModifier, limit) as MessageThread[];
}
```

- [ ] **Step 4: Tests grün** (der Aufrufer `generate-hostex-drafts.ts` bricht jetzt beim Build — das behebt Task 5; nur die Testdatei prüfen)

Run: `npx vitest run src/repositories/message-repository.needs-draft.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/repositories/message-repository.ts src/repositories/message-repository.needs-draft.test.ts
git commit -m "feat: getThreadsNeedingDraft source-parametrisiert (hostex|guesty)"
```

---

### Task 5: Draft-Generierung provider-agnostisch (`generate-drafts.ts`)

**Files:**
- Move: `src/jobs/hostex/generate-hostex-drafts.ts` → `src/jobs/generate-drafts.ts`
- Move: `src/jobs/hostex/generate-hostex-drafts.test.ts` → `src/jobs/generate-drafts.test.ts`
- Modify: `src/jobs/etl-job.ts:18` (Import-Pfad), `src/routes/messages.ts:18` (Import-Pfad)

**Interfaces:**
- Consumes: `getThreadsNeedingDraft(source, listingId, limit, sinceModifier)` (Task 4).
- Produces: `generateDraftsForProperty(property, deps?)` (Signatur unverändert), neuer Export `resolveDraftSource(property: PropertyConfig): { source: 'hostex' | 'guesty'; listingId: string } | null`. `DraftGenDeps.getThreads` bekommt `source` als ersten Parameter.

- [ ] **Step 1: Dateien verschieben**

```bash
git mv src/jobs/hostex/generate-hostex-drafts.ts src/jobs/generate-drafts.ts
git mv src/jobs/hostex/generate-hostex-drafts.test.ts src/jobs/generate-drafts.test.ts
```

Danach in beiden Dateien die relativen Importe um eine Ebene kürzen (`../../` → `../`), und in `src/jobs/etl-job.ts` + `src/routes/messages.ts` den Import umstellen auf `.../jobs/generate-drafts.js` (etl-job: `'./generate-drafts.js'`; messages: `'../jobs/generate-drafts.js'`).

- [ ] **Step 2: Test erweitern (failing)**

In `src/jobs/generate-drafts.test.ts` einen Guesty-Fall ergänzen (Fake-Deps-Muster der Datei übernehmen — Property-Objekt mit `provider: 'guesty'`, `guestyPropertyId: 'GL9'`, `vaultNote` gesetzt):

```typescript
  it('generates drafts for a guesty property with provider=guesty', async () => {
    const created: NewDraft[] = [];
    const deps: DraftGenDeps = {
      getThreads: vi.fn().mockReturnValue([{ id: 'guesty:t1', guest_name: 'G' } as MessageThread]),
      getMessages: vi.fn().mockReturnValue([]),
      loadVoice: () => 'voice',
      loadFacts: () => 'facts',
      generate: vi.fn().mockResolvedValue('Hallo!'),
      create: (d) => created.push(d),
    };
    const property = {
      slug: 'farmhouse', name: 'Farmhouse', provider: 'guesty',
      guestyPropertyId: 'GL9', vaultNote: 'Gästekommunikation Farmhouse Prasser.md',
    } as PropertyConfig;
    const res = await generateDraftsForProperty(property, deps);
    expect(res.generated).toBe(1);
    expect(deps.getThreads).toHaveBeenCalledWith('guesty', 'GL9', 10, '-72 hours');
    expect(created[0].provider).toBe('guesty');
  });
```

Bestehende Hostex-Tests: `getThreads`-Assertions auf den neuen ersten Parameter `'hostex'` erweitern.

- [ ] **Step 3: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run src/jobs/generate-drafts.test.ts`
Expected: FAIL (guesty-Property wird geskippt / getThreads-Signatur)

- [ ] **Step 4: Implementierung**

In `src/jobs/generate-drafts.ts`:

```typescript
export function resolveDraftSource(
  property: PropertyConfig,
): { source: 'hostex' | 'guesty'; listingId: string } | null {
  if (property.provider === 'hostex' && property.hostexPropertyId) {
    return { source: 'hostex', listingId: property.hostexPropertyId };
  }
  if (property.provider === 'guesty' && property.guestyPropertyId) {
    return { source: 'guesty', listingId: property.guestyPropertyId };
  }
  return null; // airbnb-mail etc.: kein Draft-Kanal
}
```

`DraftGenDeps.getThreads` wird `(source: 'hostex' | 'guesty', listingId: string, limit: number, sinceModifier: string) => MessageThread[]`; in `generateDraftsForProperty` den Guard und den Aufruf ersetzen:

```typescript
  const target = resolveDraftSource(property);
  if (!target || !property.vaultNote) return { generated: 0, skipped: 0 };
  // … voice/facts-Gate unverändert …
  const threads = deps.getThreads(target.source, target.listingId, DRAFT_GEN_CAP, DRAFT_SINCE_MODIFIER);
  // … Loop unverändert, aber:
  deps.create({ id: randomUUID(), thread_id: thread.id, provider: target.source, body: reply, generated_by: 'llm', model: DRAFT_MODEL });
```

- [ ] **Step 5: Tests + Build grün**

Run: `npx vitest run src/jobs/generate-drafts.test.ts && npm run build`
Expected: alle Tests passed, Build ok

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Draft-Generierung provider-agnostisch (hostex + guesty)"
```

---

### Task 6: `getPropertyByGuestyId` + Regenerate/Feedback source-aware

**Files:**
- Modify: `src/config/properties.ts` (nach `getPropertyByHostexId`, ~Zeile 357)
- Modify: `src/routes/messages.ts` (Regenerate-Route ~209-229, Feedback-Route ~273)

**Interfaces:**
- Produces: `getPropertyByGuestyId(guestyId: string): PropertyConfig | undefined`; Route-Helper `getPropertyForThread(thread: MessageThread): PropertyConfig | undefined`.

- [ ] **Step 1: Lookup ergänzen** (`src/config/properties.ts`)

```typescript
/**
 * Get a property by its Guesty listing ID
 */
export function getPropertyByGuestyId(guestyId: string): PropertyConfig | undefined {
  return loadPropertiesConfig().find((p) => p.guestyPropertyId === guestyId);
}
```

- [ ] **Step 2: Routen umstellen** (`src/routes/messages.ts`)

Import erweitern: `import { getPropertyByHostexId, getPropertyByGuestyId, getPropertiesByProvider } from '../config/properties.js';` und Helper über den Routen einfügen:

```typescript
function getPropertyForThread(thread: { source: string; listing_id: string | null }): PropertyConfig | undefined {
  if (!thread.listing_id) return undefined;
  if (thread.source === 'hostex') return getPropertyByHostexId(thread.listing_id);
  if (thread.source === 'guesty') return getPropertyByGuestyId(thread.listing_id);
  return undefined;
}
```

(`import type { PropertyConfig } from '../config/properties.js';` mit aufnehmen.)

Regenerate-Route: Guard + Property-Lookup + Draft-Provider ersetzen:

```typescript
    if (!['hostex', 'guesty'].includes(thread.source) || !thread.listing_id) {
      res.status(400).send('Neu generieren ist nur für Hostex-/Guesty-Threads verfügbar'); return;
    }
    const property = getPropertyForThread(thread);
    // … voice/facts-Gate unverändert …
      createDraft({ id: randomUUID(), thread_id: thread.id, provider: thread.source as 'hostex' | 'guesty', body: reply, generated_by: 'llm', model: DRAFT_MODEL });
```

Feedback-Route (~Zeile 273): `const property = isTon ? null : getPropertyByHostexId(thread.listing_id ?? '');` → `const property = isTon ? null : getPropertyForThread(thread);`

- [ ] **Step 3: Build + bestehende Tests**

Run: `npm run build && npx vitest run src/services src/repositories/draft-repository.test.ts`
Expected: Build ok, Tests grün

- [ ] **Step 4: Commit**

```bash
git add src/config/properties.ts src/routes/messages.ts
git commit -m "feat: Regenerate + Feedback-Lookup für Guesty-Threads"
```

---

### Task 7: Guesty-Message-Sync einhängen (Button + ETL) + Sync-Zeitstempel

**Files:**
- Modify: `src/jobs/sync-guesty-messages.ts` (Signatur: optionale vorab-gefetchte Conversations; `fetchAllConversations` exportieren)
- Modify: `src/routes/messages.ts` (`runMessageSync`, ~236-245; „Letzter Sync"-Label ~61)
- Modify: `src/jobs/etl-job.ts` (Guesty-Zweig, nach Step 3 ~Zeile 230)
- Modify: `src/repositories/message-repository.ts` (`getLastHostexMessageSync` → `getLastMessageSync`)
- Test: `src/repositories/message-repository.last-sync.test.ts` (anpassen)

**Interfaces:**
- Produces: `syncGuestyMessagesForProperty(property, prefetchedConversations?: any[])`; `fetchAllConversations(): Promise<any[]>` (Export); `getLastMessageSync(): string | null` (MAX über `source IN ('hostex','guesty')`).

- [ ] **Step 1: `sync-guesty-messages.ts` anpassen**

`fetchAllConversations` mit `export` versehen; Signatur + erster Fetch:

```typescript
export async function syncGuestyMessagesForProperty(
  property: PropertyConfig,
  prefetchedConversations?: any[],
): Promise<GuestyMessageSyncResult> {
  // … unverändert bis:
    const allConvs = prefetchedConversations ?? (await fetchAllConversations());
```

- [ ] **Step 2: Repository-Zeitstempel generalisieren (Test zuerst)**

`src/repositories/message-repository.last-sync.test.ts`: Funktionsname auf `getLastMessageSync` umstellen und einen Fall ergänzen, in dem ein `guesty`-Thread den neuesten `last_synced_at` hat (erwartet: der Guesty-Zeitstempel gewinnt). Run: `npx vitest run src/repositories/message-repository.last-sync.test.ts` → FAIL. Dann in `message-repository.ts` umbenennen und SQL ändern:

```typescript
export function getLastMessageSync(): string | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT MAX(last_synced_at) AS last FROM message_threads WHERE source IN ('hostex','guesty')`)
    .get() as { last: string | null } | undefined;
  return row?.last ?? null;
}
```

Caller in `src/routes/messages.ts` (Import + Zeile 61) umstellen. Run: Test → PASS.

- [ ] **Step 3: Button-Sync erweitern** (`src/routes/messages.ts`, `runMessageSync`)

```typescript
async function runMessageSync(): Promise<void> {
  const client = getHostexClient();
  const detailCache = new Map<string, HostexConversationDetail>();
  for (const property of getPropertiesByProvider('hostex')) {
    await syncHostexMessagesForProperty(property, client, undefined, detailCache);
    await generateDraftsForProperty(property);
  }
  const guestyProps = getPropertiesByProvider('guesty');
  if (guestyProps.length > 0) {
    const conversations = await fetchAllConversations(); // account-weit: EIN Fetch pro Run
    for (const property of guestyProps) {
      await syncGuestyMessagesForProperty(property, conversations);
      await generateDraftsForProperty(property);
    }
  }
}
```

Imports ergänzen: `import { syncGuestyMessagesForProperty, fetchAllConversations } from '../jobs/sync-guesty-messages.js';`

- [ ] **Step 4: ETL-Guesty-Zweig erweitern** (`src/jobs/etl-job.ts`, im Guesty-Pfad nach Step 3/`syncInquiries`, vor dem Result-Building)

```typescript
    // Step 4 (non-fatal): conversations → message_threads/messages + AI drafts
    try {
      await syncGuestyMessagesForProperty(property);
    } catch (error) {
      logger.error({ error, propertySlug: slug }, 'Guesty: message sync error (non-fatal)');
    }
    try {
      await generateDraftsForProperty(property);
    } catch (error) {
      logger.error({ error, propertySlug: slug }, 'Guesty: draft-gen error (non-fatal)');
    }
```

Import oben ergänzen: `import { syncGuestyMessagesForProperty } from './sync-guesty-messages.js';`
(Bewusst OHNE prefetch: der ETL läuft pro Property; zwei account-weite Fetches/Stunde sind im Rate-Limit irrelevant. Log-Zeilen im Step-Stil „Step 4/4" sind optional.)

- [ ] **Step 5: Build + alle Tests**

Run: `npm run build && npx vitest run`
Expected: Build ok, alle Suiten grün

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Guesty-Message-Sync in Button + ETL eingehängt, Sync-Zeitstempel provider-übergreifend"
```

---

### Task 8: UI — Send-Gating, KI-Button für Guesty, Outbound-ID source-basiert

**Files:**
- Modify: `src/routes/messages.ts` (Thread-Detail ~79-135, Send-Route ~177-189)
- Modify: `src/repositories/draft-repository.ts:41` (`markDraftSent` nullable)

**Interfaces:**
- Consumes: `resolveOutboundModuleType` (Task 1).

- [ ] **Step 1: Thread-Detail anpassen**

Import: `import { resolveOutboundModuleType } from '../services/guesty-channel.js';`

In `GET /:threadId` nach `const msgs = getMessagesByThread(thread.id);`:

```typescript
  // Guesty: Senden nur, wenn der Kanal der letzten Gastnachricht spiegelbar ist.
  const canSend = thread.source !== 'guesty' || resolveOutboundModuleType(msgs) !== null;
```

Im `draftBlock` (Draft vorhanden) das Send-Formular gaten — die `<form … /send">…</form>` ersetzen durch:

```typescript
       ${canSend
         ? `<form method="POST" action="/admin/messages/drafts/${encodeURIComponent(draft.id)}/send">
              <textarea name="body" rows="7">${esc(draft.body)}</textarea>
              <div class="actions"><button type="submit" class="btn btn-primary">Senden (Freigabe)</button></div>
            </form>`
         : `<textarea rows="7" readonly>${esc(draft.body)}</textarea>
            <p class="subtitle">Kanal unklar — bitte direkt in der Guesty-Inbox antworten.</p>`}
```

„KI-Entwurf generieren"-Button (kein Draft, ~Zeile 118): Bedingung `thread.source === 'hostex'` → `['hostex', 'guesty'].includes(thread.source)`.

- [ ] **Step 2: Send-Route: Outbound-ID source-basiert + nullable externalMessageId** (~Zeile 177-189)

`sendReply` liefert seit Task 3 `externalMessageId: string | null`. `markDraftSent` in `src/repositories/draft-repository.ts:41` erwartet `string` — Signatur auf `string | null` erweitern (die Spalte `external_message_id` ist nullable, `.run(null, id)` ist gültig):

```typescript
export function markDraftSent(id: string, externalMessageId: string | null): void {
```

In der Send-Route:

```typescript
      const outboundId = externalMessageId ? `${thread.source}:${externalMessageId}` : `sent:${draft.id}`;
```

(Kommentar darüber entsprechend anpassen: gilt jetzt für hostex UND guesty.)

- [ ] **Step 3: Build + manueller Smoke-Test**

Run: `npm run build && npx vitest run`
Expected: ok. Dann `npm run dev`, `/admin/messages` öffnen: Hostex-Threads unverändert (Send-Button da); nach einem Guesty-Sync (Button „Jetzt syncen") erscheinen Guesty-Threads; ein Thread ohne auflösbaren Kanal zeigt den Hinweis statt Send.

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages.ts
git commit -m "feat: Guesty-Threads in /admin/messages — Send-Gating + KI-Entwurf-Button"
```

---

### Task 9: Konfiguration + Doku

**Files:**
- Modify: `data/properties.json` (farmhouse + u19)
- Modify: `CLAUDE.md` (Guest-Reply-Abschnitt)

- [ ] **Step 1: `vaultNote` ergänzen**

In `data/properties.json` beim Objekt mit `"slug": "farmhouse"` das Feld `"vaultNote": "Gästekommunikation Farmhouse Prasser.md"` und bei `"slug": "u19"` das Feld `"vaultNote": "Gästekommunikation Ferienwohnung Uferstraße 19.md"` einfügen (Position egal, konventionell nach `name`/`timezone`-Block). Beide Dateien existieren im Deploy-Vault (brainstem-gaeste, `scopes: [gaeste]` gesetzt).

- [ ] **Step 2: Startup-Smoke**

Run: `npm run build && node -e "require('./dist/config/properties.js').getAllProperties().forEach(p => console.log(p.slug, p.vaultNote ?? '-'))"`
Expected: farmhouse + u19 zeigen ihre vaultNote, kein Zod-Fehler.
(Falls der `node -e`-Aufruf am ESM-Setup scheitert: stattdessen `npm run dev` kurz starten und auf fehlerfreien Boot prüfen.)

- [ ] **Step 3: CLAUDE.md aktualisieren**

Im Abschnitt „Hostex Guest-Reply System": Titel/Intro auf „Guest-Reply System (Hostex + Guesty)" erweitern und einen kurzen Schnitt-4-Absatz ergänzen: Guesty-Send via `POST /communication/conversations/{id}/send-message`, Kanal-Spiegelung über `resolveOutboundModuleType` (raw_meta.type der letzten Gastnachricht, `log`/unklar → kein Send-Button), Draft-Generierung provider-agnostisch (`src/jobs/generate-drafts.ts`), Sync in Button + Guesty-ETL (non-fatal), Spec-Verweis `docs/superpowers/specs/2026-07-07-guesty-send-design.md`. Den „Send"-Absatz („Guesty: throws not-implemented") korrigieren.

- [ ] **Step 4: Commit**

```bash
git add data/properties.json CLAUDE.md
git commit -m "feat: vaultNote für Farmhouse + U19, Doku Schnitt 4"
```

---

### Task 10: Deploy + kontrollierter Erst-Send (manuell, mit Micha)

Kein Code — Verifikations-Checkliste aus der Spec (Abschnitt 8). NICHT ohne Micha durchführen.

- [ ] **Step 1: Deploy**

```bash
ssh deploy@guesty.remoterepublic.com "cd /opt/guesty-calendar-app && git pull && npm install && npm run build && pm2 restart guesty-calendar && pm2 logs guesty-calendar --lines 20 --nostream"
```
Expected: Boot ohne Zod-/Migrations-Fehler.

- [ ] **Step 2: Lese-Verifikation (ungefährlich)**

Auf `/admin/messages` „Jetzt syncen" klicken → Guesty-Threads (Farmhouse/U19) erscheinen; Stichprobe: Verlauf eines bekannten Threads stimmt mit Guesty-Inbox überein; KI-Entwürfe entstehen nur für frische (<72h) Threads mit letzter Gast-Nachricht.

- [ ] **Step 3: Erst-Send kontrolliert**

Ersten Send an eine beobachtbare Konversation freigeben (eigene Test-Anfrage oder unkritischer echter Thread, mit Micha abgestimmt). Verifizieren:
1. Nachricht kommt auf dem richtigen Kanal an (Airbnb-App/Guesty-Inbox),
2. Formatierung/Zeilenumbrüche ok,
3. PM2-Log „Guesty send-message response" ansehen → tatsächliches Response-Schema notieren; falls `messageId` null war, Feld-Pfad in `sendConversationMessage` nachziehen,
4. nach dem nächsten Sync: KEIN doppelter Outbound-Eintrag im Verlauf (Response-ID == Post-ID). Falls doch: Response-Schema-Fix aus Punkt 3 deployen.

- [ ] **Step 4: Ergebnis dokumentieren**

Spec-Abschnitt „Vorsicht & Erst-Send" um „Verifiziert am <Datum>: …" ergänzen; Projektseite [[Gäste-Messaging-Automation]] in TheBrain2: Schnitt 4 auf „gebaut" + die zwei ZU-KLÄREN als beantwortet markieren. Commit `docs: Erst-Send verifiziert (Schnitt 4)`.
