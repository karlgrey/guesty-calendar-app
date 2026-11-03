// src/scripts/test-draft-fixtures.ts
// #976: Live-Regressionslauf für den Entwurfs-Generator (generateDraftForThread) gegen das ECHTE
// Modell — prüft Länge/Inhalt der Entwürfe anhand src/test-fixtures/drafts/cases.json
// (Erwartungen: draft-fixture-check.ts). ACHTUNG: echte API-Kosten, daher nicht in `npm test`.
// KEIN Versand an Gäste, KEIN DB-Eintrag — es entsteht nur Text auf stdout.
// Aufruf: npm run test:drafts [-- --runs N] [-- --case <teilstring>]
//   --runs N     Läufe je Fall (Default 1) — Modellausgaben streuen, bei Prompt-Änderungen 3+ nehmen.
//   --case <s>   nur Fälle, deren Name <s> enthält (case-insensitive).
// Voice/Objektfakten kommen aus dem echten Vault (VAULT_PATH/.env), Thread/Nachrichten aus der Fixture
// (gleiches Muster wie dump-draft-prompt.ts, bewusst nachgebaut statt importiert).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getPropertyBySlug } from '../config/properties.js';
import { loadVoice, loadPropertyFacts } from '../services/vault-knowledge.js';
import { generateDraftForThread } from '../services/draft-service.js';
import { callClaudeTool } from '../services/anthropic-client.js';
import { detectLanguage } from '../utils/language-detect.js';
import { checkDraftExpectation, countSentences, stripGreetingAndClosing, type DraftExpectation } from '../services/draft-fixture-check.js';
import type { AlterationSituation } from '../services/alteration-request.js';
import type { MessageThread, MessageChannel, Message, MessageDirection } from '../types/messages.js';

export interface DraftCase {
  name: string;
  description: string;
  propertySlug: string;
  thread: { channel: MessageChannel; reservation_status: string | null; guest_name?: string | null };
  bookingContext?: string | null;
  alteration: AlterationSituation | null;
  messages: { direction: MessageDirection; body: string; from_name?: string }[];
  expect: DraftExpectation;
  now?: string;
}

function threadFromCase(c: DraftCase, listingId: string, source: 'guesty' | 'hostex', id: string): MessageThread {
  const now = new Date().toISOString();
  return {
    id, listing_id: listingId, source, channel: c.thread.channel,
    guest_name: c.thread.guest_name ?? null, guest_email: null,
    first_message_at: now, last_message_at: now, message_count: c.messages.length,
    reservation_id: null, inquiry_id: null, reservation_status: c.thread.reservation_status,
    conversion_category: null, classification_confidence: null, classification_keywords: null,
    classification_reasoning: null, raw_meta: null, manually_categorized: 0, manual_note: null,
    linked_thread_id: null, ai_no_reply_at: null, discarded_at: null, last_synced_at: now,
  };
}

function messagesFromCase(c: DraftCase, threadId: string, source: 'guesty' | 'hostex'): Message[] {
  const baseMs = Date.now();
  return c.messages.map((m, i) => ({
    id: randomUUID(), thread_id: threadId, direction: m.direction,
    sent_at: new Date(baseMs + i * 1000).toISOString(),
    from_name: m.from_name ?? (m.direction === 'inbound' ? (c.thread.guest_name ?? 'Gast') : m.direction === 'outbound' ? 'host' : null),
    from_address: null, to_address: null, subject: null, body: m.body, body_html: null, source, raw_meta: null,
  }));
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const runs = Math.max(1, Number.parseInt(argValue('--runs') ?? '1', 10) || 1);
  const filter = argValue('--case')?.toLowerCase();
  const all = JSON.parse(readFileSync(new URL('../test-fixtures/drafts/cases.json', import.meta.url), 'utf8')) as DraftCase[];
  const cases = filter ? all.filter((c) => c.name.toLowerCase().includes(filter)) : all;
  if (cases.length === 0) { console.error(`Kein Fall passt auf --case '${filter}'.`); process.exit(1); }

  const voice = loadVoice();
  if (!voice) { console.error('Voice nicht ladbar — VAULT_PATH/.env prüfen.'); process.exit(1); }

  let total = 0; let green = 0;
  for (const c of cases) {
    const property = getPropertyBySlug(c.propertySlug);
    if (!property) { console.error(`Property '${c.propertySlug}' (Fall '${c.name}') unbekannt.`); process.exit(1); }
    if (property.provider !== 'guesty' && property.provider !== 'hostex') {
      console.error(`Property '${c.propertySlug}' hat provider='${property.provider}' — Draft-Generierung läuft nur für guesty/hostex.`); process.exit(1);
    }
    const listingId = property.provider === 'guesty' ? property.guestyPropertyId! : property.hostexPropertyId!;
    const facts = property.vaultNote ? loadPropertyFacts(property.vaultNote) : null;
    if (!facts) { console.error(`Objektfakten für '${c.propertySlug}' nicht ladbar — VAULT_PATH/.env prüfen.`); process.exit(1); }
    console.log(`\n=== ${c.name} ===\n${c.description}`);
    for (let run = 1; run <= runs; run++) {
      total++;
      const id = `synthetic:${c.name}:${run}`;
      const thread = threadFromCase(c, listingId, property.provider, id);
      const messages = messagesFromCase(c, id, property.provider);
      const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
      const guestLanguage = detectLanguage(lastInbound?.body ?? '');
      const result = await generateDraftForThread(
        {
          thread, messages, voice, facts, bookingContext: c.bookingContext ?? null,
          alteration: c.alteration, now: c.now ? new Date(c.now) : undefined, guestLanguage,
        },
        { call: callClaudeTool },
      );
      const check = checkDraftExpectation(result, c.expect);
      if (check.pass) green++;
      console.log(`\n--- Lauf ${run}/${runs}: ${check.pass ? '✓' : '✗'} kind=${result.kind}`);
      if (result.kind === 'text') {
        console.log(result.body);
        console.log(`[Sätze=${countSentences(result.body)}, Zeichen ohne Anrede/Gruß=${stripGreetingAndClosing(result.body).length}]`);
      } else if (result.kind === 'no_reply') console.log(`(no_reply: ${result.reason})`);
      else console.log(`(failed: ${result.error})`);
      for (const f of check.failures) console.log(`  ✗ ${f}`);
    }
  }
  console.log(`\n${green}/${total} grün`);
  process.exit(green === total ? 0 : 1);
}

main().catch((e) => { console.error('test-draft-fixtures fehlgeschlagen:', e); process.exit(1); });
