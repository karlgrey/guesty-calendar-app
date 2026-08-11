import { callClaudeTool, type ClaudeToolDefinition } from './anthropic-client.js';
import type { MessageThread, Message } from '../types/messages.js';

export const DRAFT_MODEL = 'claude-sonnet-5';

export const SUBMIT_REPLY_TOOL: ClaudeToolDefinition = {
  name: 'submit_reply',
  description: 'Gib die fertige Antwort an den Gast zurück — oder melde explizit, dass keine Antwort nötig ist.',
  input_schema: {
    type: 'object',
    properties: {
      no_reply_needed: {
        type: 'boolean',
        description:
          'true NUR, wenn die Nachricht weder eine Frage noch ein Anliegen/eine Bitte enthält ' +
          '(reines Danke/Bestätigung/Emoji). Sonst immer false — auch wenn die Nachricht mit Dank beginnt.',
      },
      reply: {
        type: 'string',
        description: 'Die fertige Gastantwort in Michas Stimme. Pflicht, wenn no_reply_needed=false.',
      },
      reason: {
        type: 'string',
        description: 'Kurze Begründung, nur wenn no_reply_needed=true (z. B. "reine Dankesnachricht ohne Frage").',
      },
    },
    required: ['no_reply_needed'],
  },
};

/**
 * #379: drei unterscheidbare Ausgänge statt string|null — der Aufrufer (generate-drafts.ts,
 * routes/messages.ts Regenerate) muss (b) bewusstes "keine Antwort nötig" von (c) technischem
 * Ausfall (Tool-Output fehlt/unbrauchbar) trennen können: nur (b) darf markThreadAiNoReply auslösen,
 * (c) soll beim nächsten Lauf erneut versucht werden.
 */
export type DraftResult =
  | { kind: 'text'; body: string }
  | { kind: 'no_reply'; reason: string }
  | { kind: 'failed'; error: string };

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
    'Keine Antwort nötig (no_reply_needed=true) NUR, wenn die Nachricht WEDER eine Frage NOCH ein ' +
      'Anliegen/eine Bitte enthält — also eine reine Dankes-/Bestätigungsnachricht oder ein bloßes Emoji.',
    'Beginnt eine Nachricht mit Dank, enthält aber danach eine Frage oder ein Anliegen, ist das KEIN ' +
      'Grund für no_reply_needed=true — antworte auf die Frage/das Anliegen. Im Zweifel antworten ' +
      '(no_reply_needed=false).',
    'Gib die Antwort über das Tool submit_reply zurück: entweder reply (nur der Nachrichtentext, ' +
      'keine Anrede-Meta) mit no_reply_needed=false, oder no_reply_needed=true mit reason.'
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
): Promise<DraftResult> {
  let out: unknown;
  try {
    out = await deps.call({
      systemPrompt: buildSystemPrompt(input.voice, input.facts, input.bookingContext ?? null),
      userMessage: buildConversation(input.messages, input.thread.guest_name),
      tool: SUBMIT_REPLY_TOOL,
      model: DRAFT_MODEL,
      // 512-Default reichte nicht für Antworten auf mehrteilige Gastfragen —
      // Tool-JSON wurde am Limit abgeschnitten (#379-Nachbefund, Fall Johannes).
      maxTokens: 1500,
    });
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }

  if (!out || typeof out !== 'object') {
    return { kind: 'failed', error: 'Tool-Output fehlt oder ist kein Objekt' };
  }
  const { no_reply_needed, reply, reason } = out as { no_reply_needed?: unknown; reply?: unknown; reason?: unknown };

  if (no_reply_needed === true) {
    return { kind: 'no_reply', reason: typeof reason === 'string' && reason.trim() ? reason.trim() : '(kein Grund angegeben)' };
  }
  if (typeof reply === 'string' && reply.trim()) {
    return { kind: 'text', body: reply.trim() };
  }
  return { kind: 'failed', error: 'Tool-Output ohne no_reply_needed=true und ohne verwertbaren reply-Text' };
}
