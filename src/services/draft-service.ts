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

// #440 Root-Cause-Fix: Der Prompt gab dem Modell VOICE+OBJEKTWISSEN bisher nur als flachen
// Text-Dump, ohne je explizit zu sagen, auf welchem KANAL dieser Thread läuft oder ob die
// Buchung BESTÄTIGT ist — das Modell musste beides aus dem Gesprächstext erraten und dann selbst
// entscheiden, welche der vielen (teils kanalspezifischen, teils gegenläufigen) Regeln im
// Vault-Text gerade gelten. Zwei Vorfälle (Fall Sophie: Domain-Link in einer Airbnb-Anfrage vor
// Bestätigung; Fall Sophie #2: KI bietet in einer Airbnb-Anfrage ein Direktbuchungs-"Angebot" an)
// gingen exakt darauf zurück — die richtigen (zustandsabhängigen!) Regeln standen im Vault, aber
// ohne strukturierten Kanal-/Status-Fakt + Präzedenz-Hinweis wählte das Modell die falsche von
// mehreren im selben Dokument stehenden Anweisungen. WICHTIG (Präzisierung Micha): Es gibt KEIN
// pauschales Airbnb-Link-Verbot — nach bestätigter Buchung sind Links (z. B. Hausordnung)
// ausdrücklich erwünscht, das Vault formuliert seine Regeln bereits zustandsabhängig. Dieser Block
// macht Kanal+Status zur expliziten, nicht zu erratenden Tatsache und weist das Modell an,
// kanalfremde/statusfremde Regeln zu ignorieren bzw. explizite Ausnahmeklauseln im Vault-Text
// (z. B. "AUSNAHME Airbnb vor bestätigter Buchung") vorrangig zu behandeln — bewusst OHNE die
// konkreten Regeln hier zu duplizieren (die bleiben allein im Vault, sonst zwei Quellen für
// dieselbe Policy, die auseinanderlaufen können).
const CHANNEL_LABELS: Record<MessageThread['channel'], string> = {
  airbnb: 'Airbnb',
  'booking.com': 'Booking.com',
  vrbo: 'VRBO',
  direct_email: 'Direkt-E-Mail',
  manual: 'Manuell erfasst',
  landfolk: 'Landfolk',
  meetreet: 'Meetreet',
  other: 'Sonstiger/unbekannter Kanal',
};

// Deckungsgleich mit reservation-repository.ts (`status IN ('confirmed','reserved')` = aktive/
// bestätigte Buchung). Alles andere (null, 'inquiry', storniert/abgelehnt, unbekannt …) gilt
// konservativ als NICHT bestätigt — lieber eine bestätigte Buchung fälschlich vorsichtig
// behandeln als umgekehrt. Bekannte Grauzone: Hostex-Threads führen reservation_status aktuell
// NIE (message-mapper.ts setzt es hart auf null) — für Hostex-Airbnb-Threads liefert dieser Block
// deshalb immer "NICHT bestätigt", auch wenn die Buchung längst bestätigt ist (separates,
// vorbestehendes Datenmodell-Gap, siehe Bericht — nicht Teil dieses Fixes).
const CONFIRMED_RESERVATION_STATUSES = new Set(['confirmed', 'reserved']);

function resolveBookingStatusLabel(reservationStatus: string | null): string {
  if (reservationStatus && CONFIRMED_RESERVATION_STATUSES.has(reservationStatus)) {
    return 'bestätigt';
  }
  return 'NICHT bestätigt (bzw. Status unbekannt — konservativ als unbestätigt behandeln)';
}

function buildThreadFactsBlock(thread: Pick<MessageThread, 'channel' | 'reservation_status'>): string {
  const channelLabel = CHANNEL_LABELS[thread.channel] ?? thread.channel;
  const statusLabel = resolveBookingStatusLabel(thread.reservation_status);
  return [
    '### FAKTEN ZU DIESEM GESPRÄCH — gelten VOR jeder Regel in Voice/Objektwissen unten ###',
    `Kanal dieses Threads: ${channelLabel}`,
    `Buchungsstatus dieses Threads: ${statusLabel}`,
    'Voice und Objektwissen unten gelten kanal- und statusübergreifend — nicht jede Zeile darin passt ' +
      'auf DIESES Gespräch. Eine Regel, die einen ANDEREN Kanal oder Buchungsstatus voraussetzt (z. B. ' +
      '„bei Direktbuchung", „nach fester Buchung", „vor bestätigter Buchung", „Direktlink mitgeben"), ' +
      'wende nur an, wenn Kanal/Status oben dazu passen — sonst gilt sie HIER NICHT. Enthält das ' +
      'Objektwissen eine explizite Kanal-/Status-Ausnahme (z. B. „AUSNAHME Airbnb vor bestätigter ' +
      'Buchung"), hat DIESE Ausnahme Vorrang vor der allgemeineren Regel im selben Dokument, wenn ' +
      'Kanal/Status oben zutreffen.',
    '### ENDE FAKTEN ###',
  ].join('\n');
}

// Exportiert (statt privat) für das Abnahme-Werkzeug src/scripts/dump-draft-prompt.ts (#440,
// SmartTasks-Doc #20) — der Prompt-Dump MUSS exakt dieselbe Funktion verwenden wie der echte
// Generierungspfad, sonst könnte das Abnahme-Tool unbemerkt vom tatsächlichen Prompt abweichen.
export function buildSystemPrompt(
  voice: string,
  facts: string,
  bookingContext: string | null,
  thread: Pick<MessageThread, 'channel' | 'reservation_status'>,
): string {
  const lines = [
    buildThreadFactsBlock(thread),
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

/**
 * #384: die Anrede soll immer die Person treffen, die die LETZTE eingegangene Gastnachricht
 * unterschrieben hat (z. B. Buchung läuft auf "Anna", aber die Nachricht endet mit "Viele Grüße,
 * Lisa" → Anrede "Lisa") — nicht pauschal den Buchungsnamen. Bewusst als Prompt-Instruktion statt
 * deterministischer Regex-Extraktion gelöst: Signaturen sind sprachlich zu vielgestaltig (Sprache,
 * Grußformel, mit/ohne Nachname) für zuverlässiges Pattern-Matching, und das Modell sieht die
 * letzte Gastnachricht ohnehin im Verlauf — passt zum bestehenden Muster dieser Datei, in dem auch
 * andere Nuancen (z. B. no_reply_needed) dem Modell per Instruktion übergeben werden statt Regex.
 */
export function buildConversation(messages: Message[], guestName: string | null): string {
  const hasInbound = messages.some((m) => m.direction === 'inbound');
  const lines = messages.map((m) => {
    const who = m.direction === 'inbound' ? 'Gast' : m.direction === 'outbound' ? 'Host' : 'System';
    return `${who}: ${m.body}`;
  });

  let nameLine: string;
  if (!hasInbound) {
    // Keine Gastnachricht vorhanden (z. B. leerer Verlauf) — keine Signatur zu prüfen,
    // altes Verhalten unverändert: Buchungsname bzw. namenlose Begrüßung.
    nameLine = guestName
      ? `Der Gast heißt „${guestName}". Sprich ihn direkt mit Vornamen an (Begrüßungs-Stil siehe Voice) — niemals mit „Liebe/Lieber Gast" o. Ä.`
      : 'Der Name des Gastes ist nicht bekannt — nutze eine natürliche namenlose Begrüßung im Voice-Stil, niemals „Liebe/Lieber Gast".';
  } else {
    const signatureRule =
      'Anrede-Regel: Prüfe, ob die LETZTE Gastnachricht im Verlauf unten mit einem Namen ' +
      'unterschrieben ist (z. B. „Viele Grüße, Lisa", „LG Lisa", „Danke, Lisa Müller"). Ist eine ' +
      'Signatur erkennbar, sprich den Gast in der Anrede mit DIESEM Vornamen an — bei vollem Namen ' +
      '(Vor- + Nachname) NUR den Vornamen verwenden (aus „Lisa Müller" wird „Lisa").';
    nameLine = guestName
      ? `${signatureRule} Das gilt auch, wenn die Signatur vom Buchungsnamen „${guestName}" abweicht. ` +
        `Ist KEINE Signatur erkennbar, nutze stattdessen den Vornamen aus „${guestName}". ` +
        'Sprich den Gast direkt mit Vornamen an (Begrüßungs-Stil siehe Voice) — niemals mit „Liebe/Lieber Gast" o. Ä.'
      : `${signatureRule} Der Buchungsname ist nicht bekannt — ist auch keine Signatur erkennbar, ` +
        'nutze eine natürliche namenlose Begrüßung im Voice-Stil, niemals „Liebe/Lieber Gast".';
  }
  return `${nameLine}\n\nBisheriger Verlauf (chronologisch), beantworte die letzte Gastnachricht:\n${lines.join('\n')}`;
}

export async function generateDraftForThread(
  input: DraftInput,
  deps: DraftDeps = defaultDeps,
): Promise<DraftResult> {
  let out: unknown;
  try {
    out = await deps.call({
      systemPrompt: buildSystemPrompt(input.voice, input.facts, input.bookingContext ?? null, input.thread),
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
