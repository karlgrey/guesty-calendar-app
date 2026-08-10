import { callClaudeTool, type ClaudeToolDefinition } from './anthropic-client.js';
import type { MessageThread, Message } from '../types/messages.js';

export const DRAFT_MODEL = 'claude-sonnet-5';

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
  // #364: what the platform already knows about this thread's booking
  // (dates, nights, guests, confirmation code) — see booking-context.ts.
  // null when the thread isn't linked to a reservation/inquiry.
  bookingContext: string | null;
}
export interface DraftDeps {
  call: typeof callClaudeTool;
}
const defaultDeps: DraftDeps = { call: callClaudeTool };

function buildSystemPrompt(voice: string, facts: string, bookingContext: string | null): string {
  const lines = [
    'Du entwirfst eine Antwort auf eine Gastnachricht für eine Ferienunterkunft, in Michas Stimme.',
    'Halte dich strikt an den folgenden Ton/Stil (Voice):',
    '--- VOICE ---', voice, '--- ENDE VOICE ---',
    'Nutze ausschließlich die folgenden Objektfakten. Erfinde nichts; fehlt ein Fakt, bleib allgemein.',
    '--- OBJEKTWISSEN ---', facts, '--- ENDE OBJEKTWISSEN ---',
  ];
  if (bookingContext) {
    lines.push(
      '--- BUCHUNGSKONTEXT (liegt der Plattform bereits vor) ---',
      bookingContext,
      '--- ENDE BUCHUNGSKONTEXT ---',
      'Diese Buchungsdaten sind der Plattform bekannt — frage den Gast NIEMALS erneut nach Zeitraum, Nächten oder Personenzahl; beziehe dich stattdessen direkt darauf (z. B. bei Bestätigungen den Zeitraum nennen).'
    );
  }
  lines.push(
    'Regeln: Kein Auto-Versand von Zugangscodes. Antworte in der Sprache des Gastes (Default Deutsch). Kurz und konkret.',
    'Wenn keine Antwort nötig ist (z. B. reine Dankes-/Bestätigungsnachricht ohne Frage oder Anliegen), gib über submit_reply einen leeren String zurück.',
    'Gib die Antwort über das Tool submit_reply zurück (nur den Nachrichtentext, keine Anrede-Meta).'
  );
  return lines.join('\n');
}

function buildConversation(messages: Message[], guestName: string | null): string {
  const nameLine = guestName
    ? `Der Gast heißt „${guestName}". Sprich ihn direkt mit Vornamen an (Begrüßungs-Stil siehe Voice) — niemals mit „Liebe/Lieber Gast" o. Ä.`
    : 'Der Name des Gastes ist nicht bekannt — nutze eine natürliche namenlose Begrüßung im Voice-Stil, niemals „Liebe/Lieber Gast".';
  const lines = messages.map((m) => {
    const who = m.direction === 'inbound' ? 'Gast' : m.direction === 'outbound' ? 'Host' : 'System';
    return `${who}: ${m.body}`;
  });
  return `${nameLine}\n\nBisheriger Verlauf (chronologisch), beantworte die letzte Gastnachricht:\n${lines.join('\n')}`;
}

export async function generateDraftForThread(
  input: DraftInput,
  deps: DraftDeps = defaultDeps,
): Promise<string | null> {
  const out = await deps.call({
    systemPrompt: buildSystemPrompt(input.voice, input.facts, input.bookingContext ?? null),
    userMessage: buildConversation(input.messages, input.thread.guest_name),
    tool: SUBMIT_REPLY_TOOL,
    model: DRAFT_MODEL,
  });
  const reply = (out as { reply?: unknown } | null)?.reply;
  return typeof reply === 'string' && reply.trim() ? reply.trim() : null;
}
