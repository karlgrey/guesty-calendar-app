/**
 * Draft-Prompt-Dump — Abnahme-Werkzeug für #440 / SmartTasks-Doc #20
 * ("Testplan Gäste-Bot Kanal-Regeln").
 *
 * Druckt den vollständigen System-Prompt (+ User-Message), den der Draft-Generator
 * (src/services/draft-service.ts) für einen Thread bauen würde — OHNE einen echten
 * Anthropic-API-Call. Zwei Quellen für den Thread:
 *
 *   - Ein echter Thread aus der lokalen DB (data/calendar.db) über seine Thread-ID.
 *   - Eine synthetische Fixture-Datei (JSON), wenn kein passender echter Thread lokal
 *     vorliegt — genau dafür sind die Testplan-Fälle A1–D5 als Fixtures unter
 *     data/testplan-440-fixtures/ angelegt.
 *
 * Nutzt bewusst dieselben exportierten Funktionen wie der echte Generierungspfad
 * (buildSystemPrompt, buildConversation aus draft-service.ts) — kein Nachbau, keine
 * Drift-Gefahr zwischen Abnahme-Tool und Produktivcode.
 *
 * Modi:
 *
 *   npx tsx src/scripts/dump-draft-prompt.ts <threadId>
 *     Echter Thread aus data/calendar.db. Baut Voice/Facts/BookingContext genau wie
 *     die App (loadVoice/loadPropertyFacts/buildBookingContext) und druckt den
 *     System-Prompt direkt über buildSystemPrompt/buildConversation — kein API-Call.
 *
 *   npx tsx src/scripts/dump-draft-prompt.ts --fixture data/testplan-440-fixtures/a1-catering-unconfirmed.json
 *     Synthetischer Thread aus einer Fixture-Datei (kein DB-Zugriff für den Thread
 *     selbst; Voice/Facts kommen weiterhin aus dem echten Vault über VAULT_PATH).
 *
 *   Zusätzlich --via-generate: läuft NICHT über buildSystemPrompt direkt, sondern
 *     durch generateDraftForThread() mit einem gemockten deps.call — zeigt den
 *     exakten Payload (systemPrompt, userMessage, tool, model, maxTokens), den der
 *     echte Aufrufer an callClaudeTool übergeben würde. Ebenfalls kein echter
 *     API-Call (deps.call ist ein lokaler Stub, der eine feste Dummy-Antwort liefert).
 *
 * Beispiele:
 *   npx tsx src/scripts/dump-draft-prompt.ts guesty:69b6fcf87c389e00131e3e75
 *   npx tsx src/scripts/dump-draft-prompt.ts --fixture data/testplan-440-fixtures/a1-catering-unconfirmed.json
 *   npx tsx src/scripts/dump-draft-prompt.ts --fixture data/testplan-440-fixtures/b2-catering-confirmed.json --via-generate
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initDatabase } from '../db/index.js';
import { getThreadById, getMessagesByThread } from '../repositories/message-repository.js';
import { getPropertyForThread } from '../utils/thread-property.js';
import { getPropertyBySlug } from '../config/properties.js';
import { loadVoice, loadPropertyFacts } from '../services/vault-knowledge.js';
import { buildBookingContext } from '../services/booking-context.js';
import {
  buildSystemPrompt, buildConversation, generateDraftForThread, type DraftDeps,
} from '../services/draft-service.js';
import type { CallClaudeToolInput } from '../services/anthropic-client.js';
import type { MessageThread, MessageChannel, Message, MessageDirection } from '../types/messages.js';

// --- Fixture-Schema (synthetischer Modus) -----------------------------------------

interface FixtureMessage {
  direction: MessageDirection;
  body: string;
  from_name?: string;
}

interface Fixture {
  caseId: string;
  description: string;
  propertySlug: string;
  thread: {
    channel: MessageChannel;
    reservation_status: string | null;
    guest_name?: string | null;
  };
  // Wenn gesetzt: direkt als Buchungskontext-Block verwendet (spart eine synthetische
  // reservations/inquiries-Zeile in der DB — die Fixtures beschreiben den Zustand
  // deklarativ). null/weggelassen = kein Buchungskontext-Block (wie ein Thread ohne
  // reservation_id/inquiry_id-Link).
  bookingContext?: string | null;
  messages: FixtureMessage[];
}

function loadFixture(path: string): Fixture {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Fixture;
  if (!parsed.propertySlug || !parsed.thread || !Array.isArray(parsed.messages)) {
    throw new Error(`Fixture ${path} ist unvollständig (propertySlug/thread/messages nötig)`);
  }
  return parsed;
}

// Baut ein vollständiges MessageThread-Objekt aus einer Fixture — Felder, die für den
// Prompt-Aufbau irrelevant sind, bekommen harmlose Default-Werte (gleiches Muster wie
// die thread()-Fixtures in draft-service.test.ts).
function threadFromFixture(fixture: Fixture, listingId: string, source: 'guesty' | 'hostex'): MessageThread {
  const now = new Date().toISOString();
  return {
    id: `synthetic:${fixture.caseId}`,
    listing_id: listingId,
    source,
    channel: fixture.thread.channel,
    guest_name: fixture.thread.guest_name ?? null,
    guest_email: null,
    first_message_at: now,
    last_message_at: now,
    message_count: fixture.messages.length,
    reservation_id: null,
    inquiry_id: null,
    reservation_status: fixture.thread.reservation_status,
    conversion_category: null,
    classification_confidence: null,
    classification_keywords: null,
    classification_reasoning: null,
    raw_meta: null,
    manually_categorized: 0,
    manual_note: null,
    linked_thread_id: null,
    ai_no_reply_at: null,
    last_synced_at: now,
  };
}

function messagesFromFixture(fixture: Fixture, threadId: string, source: 'guesty' | 'hostex'): Message[] {
  const baseMs = Date.now();
  // buildConversation() sortiert nicht neu, sondern übernimmt die Array-Reihenfolge — sent_at
  // dient hier nur der Typ-Vollständigkeit, aufsteigend, damit sie chronologisch aussieht.
  return fixture.messages.map((m, i) => ({
    id: randomUUID(),
    thread_id: threadId,
    direction: m.direction,
    sent_at: new Date(baseMs + i * 1000).toISOString(),
    from_name: m.from_name ?? (m.direction === 'inbound' ? (fixture.thread.guest_name ?? 'Gast') : m.direction === 'outbound' ? 'host' : null),
    from_address: null,
    to_address: null,
    subject: null,
    body: m.body,
    body_html: null,
    source,
    raw_meta: null,
  }));
}

// --- Ausgabe ------------------------------------------------------------------------

function printSection(title: string, body: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
  console.log(body);
}

async function dumpDirect(thread: MessageThread, messages: Message[], voice: string, facts: string, bookingContext: string | null): Promise<void> {
  const systemPrompt = buildSystemPrompt(voice, facts, bookingContext, thread);
  const userMessage = buildConversation(messages, thread.guest_name);
  printSection('THREAD-FAKTEN', JSON.stringify({
    id: thread.id, channel: thread.channel, reservation_status: thread.reservation_status,
    source: thread.source, guest_name: thread.guest_name,
  }, null, 2));
  printSection('SYSTEM PROMPT (buildSystemPrompt — kein API-Call)', systemPrompt);
  printSection('USER MESSAGE (buildConversation)', userMessage);
  console.log(`\n(System-Prompt-Länge: ${systemPrompt.length} Zeichen, User-Message-Länge: ${userMessage.length} Zeichen)`);
}

async function dumpViaGenerate(thread: MessageThread, messages: Message[], voice: string, facts: string, bookingContext: string | null): Promise<void> {
  let captured: CallClaudeToolInput | null = null;
  const deps: DraftDeps = {
    call: async (args: CallClaudeToolInput) => {
      captured = args;
      return { no_reply_needed: false, reply: '[DRY-RUN — kein echter Modellaufruf, nur Payload-Capture]' };
    },
  };

  const result = await generateDraftForThread({ thread, messages, voice, facts, bookingContext }, deps);

  if (!captured) {
    console.error('FEHLER: deps.call wurde nicht aufgerufen — generateDraftForThread hat vorher abgebrochen.');
    return;
  }
  const c: CallClaudeToolInput = captured;
  printSection('PAYLOAD AN deps.call (== callClaudeTool im echten Betrieb)', JSON.stringify({
    model: c.model, maxTokens: c.maxTokens, tool: c.tool.name,
  }, null, 2));
  printSection('SYSTEM PROMPT (via generateDraftForThread, gemockter deps.call)', c.systemPrompt);
  printSection('USER MESSAGE (via generateDraftForThread)', c.userMessage);
  printSection('DraftResult (mit Dummy-Antwort des Mocks)', JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const viaGenerate = args.includes('--via-generate');
  const fixtureIdx = args.indexOf('--fixture');
  const fixturePath = fixtureIdx >= 0 ? args[fixtureIdx + 1] : null;
  const threadIdArg = args.find((a) => !a.startsWith('--') && a !== fixturePath);

  if (!fixturePath && !threadIdArg) {
    console.error('Usage:');
    console.error('  npx tsx src/scripts/dump-draft-prompt.ts <threadId> [--via-generate]');
    console.error('  npx tsx src/scripts/dump-draft-prompt.ts --fixture <pfad.json> [--via-generate]');
    process.exit(1);
  }

  let thread: MessageThread | null;
  let messages: Message[];
  let voice: string | null;
  let facts: string | null;
  let bookingContext: string | null;

  if (fixturePath) {
    const fixture = loadFixture(fixturePath);
    const property = getPropertyBySlug(fixture.propertySlug);
    if (!property) {
      console.error(`Property '${fixture.propertySlug}' nicht in properties.json gefunden`);
      process.exit(1);
      return;
    }
    if (property.provider !== 'guesty' && property.provider !== 'hostex') {
      console.error(`Property '${fixture.propertySlug}' hat provider='${property.provider}' — Draft-Generierung läuft nur für guesty/hostex.`);
      process.exit(1);
      return;
    }
    const listingId = property.provider === 'guesty' ? property.guestyPropertyId! : property.hostexPropertyId!;
    thread = threadFromFixture(fixture, listingId, property.provider);
    messages = messagesFromFixture(fixture, thread.id, property.provider);
    voice = loadVoice();
    facts = property.vaultNote ? loadPropertyFacts(property.vaultNote) : null;
    bookingContext = fixture.bookingContext ?? null;
    console.log(`Fixture: ${fixture.caseId} — ${fixture.description}`);
    console.log(`Property: ${property.name} (${property.slug}, ${property.provider})`);
  } else {
    initDatabase();
    thread = getThreadById(threadIdArg!);
    if (!thread) {
      console.error(`Thread '${threadIdArg}' nicht in data/calendar.db gefunden — lokaler Sync-Stand evtl. zu alt, oder --fixture nutzen.`);
      process.exit(1);
      return;
    }
    messages = getMessagesByThread(thread.id);
    const property = getPropertyForThread(thread);
    voice = loadVoice();
    facts = property?.vaultNote ? loadPropertyFacts(property.vaultNote) : null;
    bookingContext = buildBookingContext(thread);
    console.log(`Thread: ${thread.id} (${thread.channel}, reservation_status=${thread.reservation_status ?? 'null'})`);
    console.log(`Property: ${property?.name ?? '(nicht auflösbar)'} (${property?.slug ?? '?'})`);
  }

  if (!voice || !facts) {
    console.error('Voice oder Objektfakten nicht ladbar — VAULT_PATH/.env prüfen (Voice fehlt: ' +
      `${!voice}, Facts fehlen: ${!facts}).`);
    process.exit(1);
    return;
  }

  if (viaGenerate) {
    await dumpViaGenerate(thread, messages, voice, facts, bookingContext);
  } else {
    await dumpDirect(thread, messages, voice, facts, bookingContext);
  }
}

main().catch((e) => {
  console.error('dump-draft-prompt fehlgeschlagen:', e);
  process.exit(1);
});
