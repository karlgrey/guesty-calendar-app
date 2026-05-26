# LLM-Based Conversion Classifier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tasks 2, 3 and 5 touch the Anthropic SDK — the implementer MUST invoke the `claude-api` skill for SDK details (caching syntax, tool-use, model IDs).**

**Goal:** Den regex-basierten Conversion-Classifier durch einen LLM-basierten ersetzen — Sync entkoppelt, separater Klassifizier-Lauf, CONFIRMED bleibt deterministisch.

**Architecture:** Anthropic Claude Sonnet 4.6 mit Tool-Use für strukturierte Ausgabe, Prompt-Caching für den System-Prompt mit 8 Few-Shot-Beispielen. Sync speichert Threads mit `conversion_category = NULL`. Ein separates Script (`classify-threads.ts`) macht den LLM-Pass; CONFIRMED-Threads umgehen den API-Call. Manuelle Overrides bleiben unangetastet.

**Tech Stack:** TypeScript, Node.js, Vitest, better-sqlite3, `@anthropic-ai/sdk` (neu), Claude Sonnet 4.6.

**Spec:** `docs/superpowers/specs/2026-05-26-llm-classifier-design.md`

---

## File Structure

| Datei | Rolle | Aktion |
|---|---|---|
| `src/db/migrations/015_add_classification_reasoning.sql` | Spalte `classification_reasoning TEXT` | Create |
| `src/types/messages.ts` | `MessageThread` um Feld erweitert | Modify |
| `package.json` | Dependency `@anthropic-ai/sdk` | Modify |
| `.env.example` | `ANTHROPIC_API_KEY` dokumentiert | Modify |
| `src/config/index.ts` | Zod-Schema um `anthropicApiKey` erweitert | Modify |
| `src/services/anthropic-client.ts` | Generischer SDK-Wrapper (Tool-Use, Caching, Retry) | Create |
| `src/services/anthropic-client.test.ts` | Wrapper-Tests (Mock-SDK) | Create |
| `src/utils/classifier-prompt.ts` | System-Prompt, Tool-Def, User-Message-Formatter, Few-Shots | Create |
| `src/utils/message-classifier.ts` | Regex-Code raus, async LLM-Aufruf rein | Modify (Rewrite) |
| `src/utils/message-classifier.test.ts` | Tests neu (Mock-basiert) | Modify (Rewrite) |
| `src/repositories/message-repository.ts` | `updateThreadClassification`-Signatur (`reasoning` statt `keywordsJson`) | Modify |
| `src/jobs/sync-guesty-messages.ts` | `classifyThread`-Aufruf entfernen | Modify |
| `src/jobs/sync-direct-email-messages.ts` | `classifyThread`-Aufruf entfernen | Modify |
| `src/scripts/classify-threads.ts` | Renamed von `reclassify-threads.ts`, async, error counter | Rename + Modify |
| `src/routes/admin.ts` | Thread-Modal zeigt Reasoning | Modify |

---

## Task 1: Migration 015 + Type extension

**Files:**
- Create: `src/db/migrations/015_add_classification_reasoning.sql`
- Modify: `src/types/messages.ts`

Migrations laufen automatisch beim Serverstart (`runMigrations()` in `src/index.ts:32`), und auch via `npx tsx src/scripts/run-migrations.ts`.

- [ ] **Step 1: Create the migration SQL file**

Create `src/db/migrations/015_add_classification_reasoning.sql`:

```sql
-- Migration 015: add classification_reasoning column for LLM-based classifier.
-- The LLM emits a one-sentence reasoning alongside category + confidence,
-- replacing the regex-era classification_keywords transparency channel.
-- The classification_keywords column is intentionally kept to preserve
-- historical regex classifications until they are re-classified.

ALTER TABLE message_threads ADD COLUMN classification_reasoning TEXT;
```

- [ ] **Step 2: Update `MessageThread` interface**

In `src/types/messages.ts` add the new field to `MessageThread` after `classification_keywords` (line ~48):

```ts
  classification_keywords: string | null; // JSON array — legacy from regex era, NULL for LLM-classified rows
  classification_reasoning: string | null; // LLM-emitted 1-sentence reasoning; NULL for legacy regex rows
```

- [ ] **Step 3: Apply the migration locally**

Run: `npx tsx src/scripts/run-migrations.ts`
Expected: output mentions migration 015 applied. Verify via:
`sqlite3 data/calendar.db ".schema message_threads"` → output contains `classification_reasoning TEXT`.

- [ ] **Step 4: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/015_add_classification_reasoning.sql src/types/messages.ts
git commit -m "feat(db): add classification_reasoning column for LLM classifier"
```

---

## Task 2: Add Anthropic SDK + config

**Files:**
- Modify: `package.json` (via npm install)
- Modify: `.env.example`
- Modify: `src/config/index.ts`

Adds `@anthropic-ai/sdk` and an optional `ANTHROPIC_API_KEY` config field. **Optional** because sync runs without the LLM; only the classify script and `classifyThread()` itself require it at call-time.

**Sub-skill: invoke `claude-api` skill** before/while writing SDK code in subsequent tasks.

- [ ] **Step 1: Install the SDK**

Run: `npm install @anthropic-ai/sdk`
Expected: `package.json` and `package-lock.json` updated, `node_modules/@anthropic-ai/sdk` exists.

- [ ] **Step 2: Document the env var in `.env.example`**

In `.env.example`, append a new section:

```bash
# Anthropic API (used by the LLM-based conversion classifier — classify-threads.ts).
# Optional: only required when running the classify script. Leave unset for sync-only operation.
ANTHROPIC_API_KEY=
```

- [ ] **Step 3: Extend the Zod config schema**

In `src/config/index.ts`, locate the Zod schema definition and add an optional `anthropicApiKey` field. The exact insertion point follows the existing pattern of other env-var fields (look for e.g. `resendApiKey` or similar API-key fields). Add:

```ts
  anthropicApiKey: z.string().optional(),
```

And in the env-mapping section (where `process.env.X` is mapped):

```ts
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
```

Match the existing surrounding code style (commas, indentation, comments) exactly. If the schema is split into multiple blocks (e.g. required vs. optional), put `anthropicApiKey` in the optional block.

- [ ] **Step 4: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.example src/config/index.ts
git commit -m "feat(config): add @anthropic-ai/sdk dependency and ANTHROPIC_API_KEY config"
```

---

## Task 3: Generic Anthropic-client wrapper

**Files:**
- Create: `src/services/anthropic-client.ts`
- Create: `src/services/anthropic-client.test.ts`

A thin wrapper around `@anthropic-ai/sdk` that exposes one function: `callClaudeTool` — sends a messages-create request with a system prompt (cache-controlled), a single user message, and a forced tool-choice, and returns the typed tool input. Encapsulates retry/backoff and parse-error handling.

**Sub-skill required: invoke `claude-api` skill** for prompt-caching syntax, tool-use details, and model-ID conventions.

- [ ] **Step 1: Write the failing tests**

Create `src/services/anthropic-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK before importing the module under test.
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// Mock config to inject the API key.
vi.mock('../config/index.js', () => ({
  config: { anthropicApiKey: 'test-key' },
}));

import { callClaudeTool } from './anthropic-client.js';

const dummyTool = {
  name: 'classify_thread',
  description: 'Classify a thread.',
  input_schema: {
    type: 'object' as const,
    properties: {
      category: { type: 'string' },
      confidence: { type: 'number' },
    },
    required: ['category', 'confidence'],
  },
};

describe('callClaudeTool', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns the parsed tool input on a successful tool_use response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'classify_thread',
          input: { category: 'INFO', confidence: 0.7 },
        },
      ],
    });
    const out = await callClaudeTool({
      systemPrompt: 'You classify things.',
      userMessage: 'thread body',
      tool: dummyTool,
    });
    expect(out).toEqual({ category: 'INFO', confidence: 0.7 });
  });

  it('sends the system prompt with cache_control: ephemeral', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', name: 'classify_thread', input: { category: 'OTHER', confidence: 0.3 } }],
    });
    await callClaudeTool({
      systemPrompt: 'sys',
      userMessage: 'msg',
      tool: dummyTool,
    });
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    expect(callArgs.tool_choice).toEqual({ type: 'tool', name: 'classify_thread' });
    expect(callArgs.tools).toEqual([dummyTool]);
  });

  it('throws a clear error when the response has no tool_use block', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I refuse.' }],
    });
    await expect(
      callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: dummyTool }),
    ).rejects.toThrow(/tool_use/i);
  });

  it('throws ConfigError when ANTHROPIC_API_KEY is missing', async () => {
    vi.resetModules();
    vi.doMock('../config/index.js', () => ({ config: { anthropicApiKey: undefined } }));
    const { callClaudeTool: fresh } = await import('./anthropic-client.js');
    await expect(
      fresh({ systemPrompt: 's', userMessage: 'm', tool: dummyTool }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('retries on 429 and succeeds on the second attempt', async () => {
    const rateLimit = Object.assign(new Error('rate'), { status: 429 });
    mockCreate
      .mockRejectedValueOnce(rateLimit)
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', name: 'classify_thread', input: { category: 'OTHER', confidence: 0.3 } }],
      });
    const out = await callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: dummyTool });
    expect(out).toEqual({ category: 'OTHER', confidence: 0.3 });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/anthropic-client.test.ts`
Expected: FAIL — module `./anthropic-client.js` does not yet exist.

- [ ] **Step 3: Implement the wrapper**

Create `src/services/anthropic-client.ts`:

```ts
/**
 * Anthropic API client wrapper.
 *
 * Single public function: callClaudeTool — sends a Messages-API request with
 * a cache-controlled system prompt, a single user message, and a forced
 * tool-choice. Returns the typed tool input on success. Encapsulates retry
 * with exponential backoff for transient errors (429 / 5xx).
 *
 * Used by the conversion classifier; can be reused for other LLM features.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import { ConfigError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 512;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 500;

export interface ClaudeToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface CallClaudeToolInput {
  systemPrompt: string;
  userMessage: string;
  tool: ClaudeToolDefinition;
  model?: string;
  maxTokens?: number;
}

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  if (!config.anthropicApiKey) {
    throw new ConfigError(
      'ANTHROPIC_API_KEY is not set in .env — required for the LLM classifier.',
    );
  }
  cachedClient = new Anthropic({ apiKey: config.anthropicApiKey });
  return cachedClient;
}

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status;
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callClaudeTool({
  systemPrompt,
  userMessage,
  tool,
  model = DEFAULT_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
}: CallClaudeToolInput): Promise<unknown> {
  const client = getClient();
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: userMessage }],
      });
      const block = response.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') {
        throw new Error(
          `Expected a tool_use response block from Claude but got ${response.content.map((b) => b.type).join(',') || 'empty'}`,
        );
      }
      return block.input;
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === MAX_RETRIES - 1) throw err;
      const delay = BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 250);
      logger.warn(
        { attempt: attempt + 1, delay, error: err instanceof Error ? err.message : String(err) },
        'Anthropic call retryable error — backing off',
      );
      await sleep(delay);
    }
  }
  throw lastError;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/services/anthropic-client.test.ts`
Expected: all 5 PASS.

- [ ] **Step 5: Verify tsc**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/anthropic-client.ts src/services/anthropic-client.test.ts
git commit -m "feat(services): add Anthropic client wrapper with tool-use + caching + retry"
```

---

## Task 4: Classifier prompt module

**Files:**
- Create: `src/utils/classifier-prompt.ts`

Houses the system prompt (with 8 few-shots from real u19/farmhouse threads), the tool definition, and the user-message formatter. Separating from `message-classifier.ts` keeps that file focused on orchestration.

- [ ] **Step 1: Create the prompt module**

Create `src/utils/classifier-prompt.ts`:

```ts
/**
 * Conversion classifier — system prompt, tool definition, and user-message formatter.
 *
 * The system prompt is large (~2k tokens) by design: it carries the category
 * catalog and 8 few-shot examples drawn from real u19/farmhouse threads. It is
 * passed with cache_control: ephemeral so subsequent calls in a batch reuse it.
 *
 * The tool's category enum deliberately excludes CONFIRMED, REPEAT, and
 * PLAN_CHANGE — those are handled deterministically (status-based) or set
 * manually by an operator.
 */

import type { ClaudeToolDefinition } from '../services/anthropic-client.js';

export const CLASSIFIER_SYSTEM_PROMPT = `You are a conversion classifier for short-term-rental message threads. You receive a single thread (channel, reservation_status, messages with direction) and must assign exactly ONE category by calling the classify_thread tool.

Categories you may assign:
  SPAM           — Cold pitch directed at the host (property management, listing services, review boosting, channel-manager vendors offering tools to the host). NOT a real guest inquiry.
  COMMERCIAL     — Guest wants the property for commercial use (photo/video shoot, brand collaboration, influencer content). They are a potential customer but for non-vacation use.
  PARTY          — Guest wants the property for a private celebration: wedding, birthday, baptism, anniversary, day-use feier, family party. Always a private event.
  DIRECT_DRIFT   — Either side tries to take the conversation off-platform (sharing email/phone/WhatsApp, "let's book directly", or host pulling the guest back to Airbnb). Only meaningful for non-direct-email channels.
  PRICE          — Explicit price negotiation: guest's budget is below listing price, asks for a discount, or names a specific budget number they want accommodated.
  NO_AVAILABILITY — Host declines because the dates are taken. Includes paraphrased declines such as "we are booked until X, then again on Y — too close for cleaning", "leider belegt", "already booked".
  INFO           — Guest asks a genuine pre-booking question (transport, pets, amenities, check-in times, capacity, kids, dog) and no other category applies.
  OTHER          — None of the above. Rare. Threads that are pure statements without questions or signals.

Categories you may NOT assign (the system handles them itself):
  CONFIRMED, REPEAT, PLAN_CHANGE — do not output these; choose the best of the available ones instead.

Decision rules:
- Threads may be in any language (German, English, Italian, Russian, French, Spanish). Classify on meaning, regardless of language.
- When multiple categories could apply, prefer the more specific one. Priority order: SPAM > COMMERCIAL > PARTY > DIRECT_DRIFT > PRICE > NO_AVAILABILITY > INFO > OTHER.
- SPAM is a host-directed offer (someone selling a service to the host). COMMERCIAL is a guest wanting to use the property commercially. Do not confuse them.
- Provide a SHORT reasoning (one sentence, max 25 words) naming the key signal you saw.
- Confidence should reflect how unambiguous the signal is: 0.9+ for clear cases, 0.6–0.8 for plausible but mixed cases, 0.3–0.5 when you are guessing.

Few-shot examples:

Example 1 — SPAM
Thread:
  Channel: airbnb
  Reservation status: inquiry
  Messages:
    [inbound] Hallo Christian, mir ist aufgefallen, dass Sie ihre Unterkunft in Wandlitz verwalten. Ich unterstütze Hosts dabei, Auslastung und Bewertungsscore gezielt zu steigern...
Tool call: { "category": "SPAM", "confidence": 0.95, "reasoning": "Cold pitch offering host services (improving occupancy and review score)." }

Example 2 — COMMERCIAL
Thread:
  Channel: airbnb
  Reservation status: inquiry
  Messages:
    [inbound] Lieber Christian, ich bin Fotograf/in und bin auf deine schöne Unterkunft aufmerksam geworden. Ich befinde mich aktuell im gezielten Aufbau meiner Location-Datenbank für kommerzielle Shootings.
Tool call: { "category": "COMMERCIAL", "confidence": 0.92, "reasoning": "Photographer requesting the property as a commercial shoot location." }

Example 3 — PARTY
Thread:
  Channel: airbnb
  Reservation status: declined
  Messages:
    [inbound] Wir planen aktuell eine kleine Hochzeit in Berlin im Juni 2027, und da unser eigener Garten zu klein ist, suchen wir nach einem Ort, an dem wir...
Tool call: { "category": "PARTY", "confidence": 0.95, "reasoning": "Guest explicitly asking for a wedding venue." }

Example 4 — PRICE
Thread:
  Channel: airbnb
  Reservation status: inquiry
  Messages:
    [inbound] I am very interested in booking your home for a women's get-together in November. We do, however, have a maximum budget of 3000€ for the two nights. Would you be willing to accommodate us for 3000€?
Tool call: { "category": "PRICE", "confidence": 0.9, "reasoning": "Explicit budget below listing, asking host to accommodate." }

Example 5 — DIRECT_DRIFT
Thread:
  Channel: airbnb
  Reservation status: inquiry
  Messages:
    [inbound] Hi, können wir das per WhatsApp besprechen?
    [outbound] Bitte bucht regulär hier über Airbnb, das passt.
Tool call: { "category": "DIRECT_DRIFT", "confidence": 0.95, "reasoning": "Guest tries to move to WhatsApp; host explicitly pulls back to the platform." }

Example 6 — NO_AVAILABILITY
Thread:
  Channel: booking.com
  Reservation status: declined
  Messages:
    [inbound] We would like to inquire about reserving your farmhouse for a small family gathering to remember a dear friend.
    [outbound] I am sorry, but we are booked until the 19th and then again on the 23rd. That's too close for our cleaning staff.
Tool call: { "category": "NO_AVAILABILITY", "confidence": 0.95, "reasoning": "Host declines due to a tight cleaning gap between existing bookings." }

Example 7 — INFO
Thread:
  Channel: airbnb
  Reservation status: inquiry
  Messages:
    [inbound] Hello there, is it possible to arrive there with public transport?
Tool call: { "category": "INFO", "confidence": 0.85, "reasoning": "Pure pre-booking question about transport accessibility." }

Example 8 — OTHER
Thread:
  Channel: airbnb
  Reservation status: inquiry
  Messages:
    [inbound] Mein Team und ich würden gerne bei euch ein Offsite machen für 12 Personen.
Tool call: { "category": "OTHER", "confidence": 0.5, "reasoning": "Statement of intent only — no question, no negotiation, no off-platform attempt." }`;

export const CLASSIFIER_TOOL: ClaudeToolDefinition = {
  name: 'classify_thread',
  description: 'Assign exactly one conversion category to the message thread.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['SPAM', 'COMMERCIAL', 'PARTY', 'DIRECT_DRIFT', 'PRICE', 'NO_AVAILABILITY', 'INFO', 'OTHER'],
        description: 'The single best category for this thread.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'How unambiguous the signal is (0.9+ clear, 0.6–0.8 mixed, 0.3–0.5 guess).',
      },
      reasoning: {
        type: 'string',
        maxLength: 200,
        description: 'One sentence naming the key signal you observed.',
      },
    },
    required: ['category', 'confidence', 'reasoning'],
  },
};

export interface ClassifierThreadInput {
  channel: string;
  reservationStatus?: string | null;
  messages: Array<{ direction: 'inbound' | 'outbound' | 'system'; body: string }>;
}

export function buildClassifierUserMessage(input: ClassifierThreadInput): string {
  const lines: string[] = [];
  lines.push(`Channel: ${input.channel}`);
  lines.push(`Reservation status: ${input.reservationStatus ?? 'unknown'}`);
  lines.push('Messages:');
  if (input.messages.length === 0) {
    lines.push('  (no messages)');
  } else {
    for (const m of input.messages) {
      const body = (m.body ?? '').replace(/\s+/g, ' ').trim();
      lines.push(`  [${m.direction}] ${body}`);
    }
  }
  return lines.join('\n');
}
```

- [ ] **Step 2: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean (no test step — pure data + formatter, exercised in Task 5 tests).

- [ ] **Step 3: Commit**

```bash
git add src/utils/classifier-prompt.ts
git commit -m "feat(classifier): add system prompt, tool definition, and user-message formatter"
```

---

## Task 5: Rewrite the classifier (TDD)

**Files:**
- Modify: `src/utils/message-classifier.ts` (full rewrite)
- Modify: `src/utils/message-classifier.test.ts` (full rewrite)

Replaces all regex logic with: deterministic CONFIRMED shortcut + LLM call via `callClaudeTool`. The old 26 tests are replaced by ~7 mock-based tests.

- [ ] **Step 1: Write the failing tests (full rewrite of the test file)**

Replace the entire contents of `src/utils/message-classifier.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCallClaudeTool = vi.fn();
vi.mock('../services/anthropic-client.js', () => ({
  callClaudeTool: mockCallClaudeTool,
}));

import { classifyThread } from './message-classifier.js';
import { CLASSIFIER_TOOL, buildClassifierUserMessage } from './classifier-prompt.js';

function msg(direction: 'inbound' | 'outbound' | 'system', body: string) {
  return { direction, body };
}

describe('classifyThread', () => {
  beforeEach(() => {
    mockCallClaudeTool.mockReset();
  });

  it('returns CONFIRMED deterministically and does NOT call the LLM', async () => {
    const out = await classifyThread({
      reservationStatus: 'confirmed',
      channel: 'airbnb',
      messages: [msg('inbound', 'beliebiger Text mit Hochzeit')],
    });
    expect(out.category).toBe('CONFIRMED');
    expect(out.confidence).toBe(1.0);
    expect(out.reasoning).toMatch(/reservation/i);
    expect(mockCallClaudeTool).not.toHaveBeenCalled();
  });

  it('also returns CONFIRMED for reserved and active statuses', async () => {
    for (const status of ['reserved', 'active']) {
      const out = await classifyThread({
        reservationStatus: status,
        channel: 'airbnb',
        messages: [],
      });
      expect(out.category).toBe('CONFIRMED');
    }
    expect(mockCallClaudeTool).not.toHaveBeenCalled();
  });

  it('delegates to the LLM for non-confirmed threads and returns the parsed result', async () => {
    mockCallClaudeTool.mockResolvedValueOnce({
      category: 'SPAM',
      confidence: 0.95,
      reasoning: 'Cold pitch offering host services.',
    });
    const out = await classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [msg('inbound', 'Ich unterstütze Hosts dabei, Auslastung zu steigern.')],
    });
    expect(out).toEqual({
      category: 'SPAM',
      confidence: 0.95,
      reasoning: 'Cold pitch offering host services.',
    });
    expect(mockCallClaudeTool).toHaveBeenCalledTimes(1);
  });

  it('passes the cached system prompt, tool, and formatted user message to the LLM', async () => {
    mockCallClaudeTool.mockResolvedValueOnce({
      category: 'INFO',
      confidence: 0.7,
      reasoning: 'Question about transport.',
    });
    await classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [msg('inbound', 'Is it possible to arrive by train?')],
    });
    const args = mockCallClaudeTool.mock.calls[0][0];
    expect(args.tool).toBe(CLASSIFIER_TOOL);
    expect(typeof args.systemPrompt).toBe('string');
    expect(args.systemPrompt.length).toBeGreaterThan(500); // big prompt with few-shots
    expect(args.userMessage).toBe(
      buildClassifierUserMessage({
        channel: 'airbnb',
        reservationStatus: 'inquiry',
        messages: [msg('inbound', 'Is it possible to arrive by train?')],
      }),
    );
  });

  it('rejects an LLM response with an invalid category', async () => {
    mockCallClaudeTool.mockResolvedValueOnce({
      category: 'NOT_A_REAL_CATEGORY',
      confidence: 0.5,
      reasoning: 'Hallucinated.',
    });
    await expect(
      classifyThread({
        reservationStatus: 'inquiry',
        channel: 'airbnb',
        messages: [msg('inbound', 'Hello')],
      }),
    ).rejects.toThrow(/category/i);
  });

  it('rejects an LLM response with confidence out of range', async () => {
    mockCallClaudeTool.mockResolvedValueOnce({
      category: 'OTHER',
      confidence: 1.5,
      reasoning: 'Out of range.',
    });
    await expect(
      classifyThread({
        reservationStatus: 'inquiry',
        channel: 'airbnb',
        messages: [msg('inbound', 'Hello')],
      }),
    ).rejects.toThrow(/confidence/i);
  });

  it('propagates API errors from callClaudeTool', async () => {
    mockCallClaudeTool.mockRejectedValueOnce(new Error('rate limited'));
    await expect(
      classifyThread({
        reservationStatus: 'inquiry',
        channel: 'airbnb',
        messages: [msg('inbound', 'Hello')],
      }),
    ).rejects.toThrow(/rate limited/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/utils/message-classifier.test.ts`
Expected: FAIL — the current `classifyThread` is synchronous, returns `matchedKeywords` not `reasoning`, and doesn't call any anthropic-client.

- [ ] **Step 3: Replace `message-classifier.ts` with the LLM-based implementation**

Replace the entire contents of `src/utils/message-classifier.ts` with:

```ts
/**
 * Conversation thread classifier.
 *
 * Two paths:
 *   1. Status-based shortcut: reservation_status ∈ {confirmed, reserved, active}
 *      → CONFIRMED with confidence 1.0, no LLM call.
 *   2. Otherwise: delegate to Claude via callClaudeTool, validate the structured
 *      response, return { category, confidence, reasoning }.
 *
 * REPEAT and PLAN_CHANGE remain manual-only (no auto rule). The LLM's enum
 * deliberately excludes them in classifier-prompt.ts.
 *
 * Throws on:
 *   - Anthropic API errors (propagated from callClaudeTool)
 *   - Invalid tool-response shape (category outside enum, confidence out of [0,1],
 *     missing reasoning, etc.)
 */

import type { ConversionCategory } from '../types/messages.js';
export type { ConversionCategory };

import { callClaudeTool } from '../services/anthropic-client.js';
import {
  CLASSIFIER_SYSTEM_PROMPT,
  CLASSIFIER_TOOL,
  buildClassifierUserMessage,
  type ClassifierThreadInput,
} from './classifier-prompt.js';

export type ClassifierInput = ClassifierThreadInput;

export interface ClassifierResult {
  category: ConversionCategory;
  confidence: number;
  reasoning: string;
}

const VALID_LLM_CATEGORIES = new Set<ConversionCategory>([
  'SPAM', 'COMMERCIAL', 'PARTY', 'DIRECT_DRIFT', 'PRICE',
  'NO_AVAILABILITY', 'INFO', 'OTHER',
]);

function isConfirmedStatus(status: string | null | undefined): boolean {
  return status === 'confirmed' || status === 'reserved' || status === 'active';
}

export async function classifyThread(
  input: ClassifierInput,
): Promise<ClassifierResult> {
  // 1) Deterministic CONFIRMED shortcut — no API call needed.
  if (isConfirmedStatus(input.reservationStatus)) {
    return {
      category: 'CONFIRMED',
      confidence: 1.0,
      reasoning: 'reservation_status is confirmed/reserved/active',
    };
  }

  // 2) LLM path.
  const raw = await callClaudeTool({
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    userMessage: buildClassifierUserMessage(input),
    tool: CLASSIFIER_TOOL,
  });

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Classifier: tool input was not an object: ${JSON.stringify(raw)}`);
  }
  const obj = raw as Record<string, unknown>;
  const category = obj.category;
  const confidence = obj.confidence;
  const reasoning = obj.reasoning;

  if (typeof category !== 'string' || !VALID_LLM_CATEGORIES.has(category as ConversionCategory)) {
    throw new Error(`Classifier: invalid category from LLM: ${JSON.stringify(category)}`);
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1 || Number.isNaN(confidence)) {
    throw new Error(`Classifier: invalid confidence from LLM: ${JSON.stringify(confidence)}`);
  }
  if (typeof reasoning !== 'string' || reasoning.length === 0) {
    throw new Error(`Classifier: invalid reasoning from LLM: ${JSON.stringify(reasoning)}`);
  }

  return {
    category: category as ConversionCategory,
    confidence,
    reasoning,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/utils/message-classifier.test.ts`
Expected: all 7 PASS.

- [ ] **Step 5: Note on tsc — interim breakage expected**

The new classifier returns `reasoning` (no `matchedKeywords`) and is `async`. This breaks the callers in `sync-guesty-messages.ts`, `sync-direct-email-messages.ts`, and `reclassify-threads.ts` until Tasks 6–8 fix them. **Do not run tsc here** — running the test (which exercises only the rewritten files and the mock) is the green signal for this task. Project-wide tsc is verified at the end of Task 8.

- [ ] **Step 6: Commit**

```bash
git add src/utils/message-classifier.ts src/utils/message-classifier.test.ts
git commit -m "feat(classifier): replace regex with LLM-based classifyThread (Sonnet 4.6 + tool-use)"
```

---

## Task 6: Update `updateThreadClassification` signature

**Files:**
- Modify: `src/repositories/message-repository.ts`

The repo function's last parameter changes from `keywordsJson` to `reasoning`, and the SQL writes to `classification_reasoning`.

- [ ] **Step 1: Update the function**

In `src/repositories/message-repository.ts`, replace the existing `updateThreadClassification` function with:

```ts
/**
 * Overwrite a thread's auto-classification with LLM output.
 * Guards on manually_categorized = 0 so manual overrides are never touched.
 */
export function updateThreadClassification(
  threadId: string,
  category: string,
  confidence: number,
  reasoning: string,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE message_threads
     SET conversion_category = ?,
         classification_confidence = ?,
         classification_reasoning = ?
     WHERE id = ? AND manually_categorized = 0`,
  ).run(category, confidence, reasoning, threadId);
}
```

- [ ] **Step 2: Verify tsc**

Run: `npx tsc --noEmit`
Expected: `classify-threads.ts` / `reclassify-threads.ts` may still fail to compile until Task 8 — that's expected. The repository file itself should compile.

- [ ] **Step 3: Commit**

```bash
git add src/repositories/message-repository.ts
git commit -m "feat(repo): updateThreadClassification writes reasoning instead of keywords"
```

---

## Task 7: Strip classification from sync paths

**Files:**
- Modify: `src/jobs/sync-guesty-messages.ts`
- Modify: `src/jobs/sync-direct-email-messages.ts`

Both sync jobs currently call `classifyThread()` inline and persist the result. After this task, both store threads with `conversion_category = null`, etc. — the LLM is not invoked by sync.

- [ ] **Step 1: Strip classification from `sync-guesty-messages.ts`**

In `src/jobs/sync-guesty-messages.ts`:
- Remove the import `import { classifyThread, type ConversionCategory } from '../utils/message-classifier.js';` (and replace with `import type { ConversionCategory } from '../types/messages.js';` if `ConversionCategory` is still referenced — but it likely isn't after removing the call).
- Inside the per-conversation loop, remove the `const classification = classifyThread({ ... })` call and the variables computed only for it (the `messages` array mapping for the classifier, the `primaryRes`-derived classifier inputs).
- In the `NewMessageThread` object construction, set the classification fields to null:

```ts
        conversion_category: null,
        classification_confidence: null,
        classification_keywords: null,
```

Make sure all references to `classification.category`, `classification.confidence`, `classification.matchedKeywords` are gone. The `mapChannel`, `mapDirection`, and post-mapping logic are unchanged.

- [ ] **Step 2: Strip classification from `sync-direct-email-messages.ts`**

In `src/jobs/sync-direct-email-messages.ts`:
- Find the line `import { classifyThread } from '../utils/message-classifier.js';` (around line 485 area) and remove it. (If only the type is used elsewhere, keep the type-only import via `../types/messages.js`.)
- Find every place the file builds a `NewMessageThread` and currently calls `classifyThread(...)` — replace those calls so the thread is built with:

```ts
        conversion_category: null,
        classification_confidence: null,
        classification_keywords: null,
```

(If the file has multiple thread-construction sites — e.g. a "placeholder" one and a "full" one — apply the same fix to every site that currently uses the classifier's output.)

- [ ] **Step 3: Verify tsc and tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean across the project; all tests pass (the test files that don't touch sync continue to pass; sync isn't unit-tested directly).

- [ ] **Step 4: Commit**

```bash
git add src/jobs/sync-guesty-messages.ts src/jobs/sync-direct-email-messages.ts
git commit -m "refactor(sync): decouple classification from sync — store threads with null category"
```

---

## Task 8: Rename + adapt the classify script

**Files:**
- Rename: `src/scripts/reclassify-threads.ts` → `src/scripts/classify-threads.ts`
- Modify: the renamed file (async, progress log, error counter, signature update)

- [ ] **Step 1: Rename the file with git**

```bash
git mv src/scripts/reclassify-threads.ts src/scripts/classify-threads.ts
```

- [ ] **Step 2: Update the script**

Replace the contents of `src/scripts/classify-threads.ts` with:

```ts
/**
 * LLM-classify a property's message threads.
 *
 * Iterates every auto-classified thread of the given property (manually_categorized = 0)
 * and runs the classifier on it. CONFIRMED threads are handled deterministically by
 * classifyThread itself (no API call). The Anthropic API is hit for the rest.
 *
 * Manual overrides are preserved by an extra guard in updateThreadClassification.
 *
 * Usage:
 *   npx tsx src/scripts/classify-threads.ts <slug>
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

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: classify-threads.ts <slug>');
    process.exit(1);
  }
  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found`);
    process.exit(1);
  }

  initDatabase();
  let listingId: string;
  try {
    listingId = getListingId(property);
  } catch (e) {
    console.error(
      `No listing id resolvable for '${slug}':`,
      e instanceof Error ? e.message : e,
    );
    process.exit(1);
  }

  const before = getCategoryCounts(listingId);
  // fetch all threads — no pagination needed for a one-shot CLI
  const threads = getThreadsByListing(listingId, { limit: 100000 });

  console.log(`Classifying ${threads.length} thread(s) for '${slug}'...`);

  let updated = 0;
  let skippedManual = 0;
  let failed = 0;
  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    if (thread.manually_categorized === 1) {
      skippedManual++;
      continue;
    }
    const messages = getMessagesByThread(thread.id).map((m) => ({
      direction: m.direction,
      body: m.body ?? '',
    }));
    try {
      const result = await classifyThread({
        reservationStatus: thread.reservation_status,
        channel: thread.channel,
        messages,
      });
      updateThreadClassification(
        thread.id,
        result.category,
        result.confidence,
        result.reasoning,
      );
      updated++;
    } catch (err) {
      failed++;
      console.error(
        `  ✗ thread ${thread.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if ((i + 1) % 25 === 0) {
      console.log(`  ... ${i + 1}/${threads.length} processed (${updated} ok, ${failed} fail, ${skippedManual} manual)`);
    }
  }

  const after = getCategoryCounts(listingId);
  console.log(`\n=== Classify '${slug}' (${listingId}) ===`);
  console.log(`threads total:    ${threads.length}`);
  console.log(`re-classified:    ${updated}`);
  console.log(`manual (skipped): ${skippedManual}`);
  console.log(`failed:           ${failed}`);
  console.log('\nbefore:', before);
  console.log('after: ', after);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Verify tsc**

Run: `npx tsc --noEmit`
Expected: clean across the whole project now (Tasks 5-8 should leave the graph consistent).

- [ ] **Step 4: Commit**

```bash
git add src/scripts/classify-threads.ts
git commit -m "feat(script): rename reclassify-threads → classify-threads, async, error counter, progress log"
```

---

## Task 9: Dashboard renders the reasoning

**Files:**
- Modify: `src/routes/admin.ts`

The conversion-dashboard thread-modal currently shows category + confidence + matched keywords. After this task it additionally shows the LLM-emitted reasoning when present.

- [ ] **Step 1: Add reasoning to the `/admin/conversions/:slug/thread/:threadId` JSON response**

In `src/routes/admin.ts`, locate the thread-detail handler (`GET /admin/conversions/:slug/thread/:threadId`, around line 4011). It selects fields from `message_threads` to return. Add `classification_reasoning` to the SELECT list and to the response object so the frontend can render it.

If the route currently does `SELECT * FROM message_threads WHERE id = ?` (or similar wildcard), the new column is already included — verify and skip this step.

- [ ] **Step 2: Render the reasoning in the modal**

In the modal-rendering JavaScript (inside the `/admin/conversions` HTML template, near the recat-box / classification_confidence display), add a small block:

```js
// In the modal-rendering function, after the classification_confidence row, render reasoning if present:
const reasoningHtml = t.classification_reasoning
  ? '<div class="modal-meta" style="margin-top: 8px; font-size: 12px; color: var(--color-warm-gray);">💡 ' + escapeHtml(t.classification_reasoning) + '</div>'
  : '';
```

And insert `reasoningHtml` into the rendered modal HTML at the appropriate location (next to or below the confidence display). The implementer should match the existing surrounding code's style; the snippet above is illustrative — adapt to the exact rendering pattern in the file.

- [ ] **Step 3: Verify tsc**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin.ts
git commit -m "feat(admin): render LLM reasoning in conversion thread modal"
```

---

## Task 10: Smoke-test the end-to-end flow

**Files:** none — verification task, no commit.

- [ ] **Step 1: Ensure `ANTHROPIC_API_KEY` is set in local `.env`**

If not already present in the local `.env` file, add it manually (the user provides the key). Without it the next steps fail with a clear `ConfigError`.

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 3: Classify u19 first (smaller, 52 threads)**

Run: `npx tsx src/scripts/classify-threads.ts u19`
Expected: output with `re-classified: N` (≤52), `failed: 0` ideally, and an `after` distribution that includes some `INFO`, possibly `SPAM`, `NO_AVAILABILITY`, etc. No exceptions.

- [ ] **Step 4: Spot-check a few u19 threads in the DB**

```bash
sqlite3 -column -header data/calendar.db "SELECT substr(guest_name,1,20) g, conversion_category cat, ROUND(classification_confidence,2) conf, substr(classification_reasoning,1,80) reason FROM message_threads WHERE listing_id='69849a19d793670014d4a11a' AND classification_reasoning IS NOT NULL ORDER BY last_message_at DESC LIMIT 8;"
```

Expected: reasonable categories with 1-sentence reasonings.

- [ ] **Step 5: Classify farmhouse (193 threads — bigger run, ~5 min)**

Run: `npx tsx src/scripts/classify-threads.ts farmhouse`
Expected: similar output, no exceptions.

- [ ] **Step 6: Verify the dashboard**

Open `http://localhost:3099/admin/conversions` (dev server should already be running; if not: `npm run dev`), log in, switch to each property, open a thread — the modal should now show the `💡` reasoning line.

---

## Rollout (after merge)

1. Push `feat/llm-classifier` to `origin` and merge to `main`.
2. Set `ANTHROPIC_API_KEY=...` in `/opt/guesty-calendar-app/.env` on the server.
3. `git pull && npm install && npm run build && pm2 restart guesty-calendar` — `runMigrations()` will apply migration 015 automatically on restart.
4. Run on the server:
   ```bash
   npx tsx src/scripts/classify-threads.ts farmhouse
   npx tsx src/scripts/classify-threads.ts u19
   ```
5. Verify the dashboard at `https://guesty.remoterepublic.com/admin/conversions`.
