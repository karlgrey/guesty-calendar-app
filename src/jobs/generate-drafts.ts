import { resolveAlterationSituation, withAlterationFact, type AlterationSituation } from '../services/alteration-request.js';
import { randomUUID } from 'node:crypto';
import { getThreadsNeedingDraft, getMessagesByThread, markThreadAiNoReply } from '../repositories/message-repository.js';
import { createDraft, updateDraftBody } from '../repositories/draft-repository.js';
import { loadVoice, loadPropertyFacts } from '../services/vault-knowledge.js';
import { generateDraftForThread, DRAFT_MODEL, type DraftResult } from '../services/draft-service.js';
import { buildBookingContext } from '../services/booking-context.js';
import { findOpenBookingRequest, type BookingRequestKind } from '../services/booking-request.js';
import { runAutoSendGate, recentHostMessages, type GateInput } from '../services/auto-send/runner.js';
import { findRepeatedOwnSentence } from '../services/auto-send/mechanical-checks.js';
import type { AutoSendDecision, AutoSendMode } from '../services/auto-send/types.js';
import { detectLanguage, type SupportedLanguage } from '../utils/language-detect.js';
import type { MessageThread, Message, NewDraft } from '../types/messages.js';
import type { PropertyConfig } from '../config/properties.js';
import { closeAnsweredInquiryTasks } from '../services/inquiry-task-closer.js';
import logger from '../utils/logger.js';

// #695: Sprach-Pin — die deterministisch erkannte Sprache der letzten Gastnachricht (nicht die
// erste, nicht die aller Nachrichten) entscheidet über die ANTWORTSPRACHE. Threads, die hier
// generiert werden, haben laut deps.getThreads() immer eine letzte Nachricht mit direction
// 'inbound' — daher genügt die letzte inbound-Nachricht in `messages`.
// Exportiert (#699): stale-draft-regen.ts braucht denselben Sprach-Pin-Input, keine Kopie.
export function lastInboundBody(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === 'inbound') return messages[i].body;
  }
  return '';
}

type GateResult = { decision: AutoSendDecision; mode: AutoSendMode; sent: boolean };

/**
 * #695 Spec Punkt 2: language_mismatch kann vom mechanischen Check ODER vom Prüfmodell kommen.
 * Defensiv gegen ein unvollständiges/leeres Gate-Ergebnis (z. B. Mode 'off' oder ein Gate-Mock
 * ohne decision-Feld) — soll nie werfen, nur „kein Neuversuch" signalisieren.
 */
function isLanguageMismatchWait(gateResult: GateResult | undefined): boolean {
  if (!gateResult?.decision || gateResult.decision.decision !== 'wait') return false;
  const flags = gateResult.decision.flags ?? [];
  return flags.includes('language_mismatch') || flags.includes('mech:language_mismatch');
}

/**
 * #1191 Spec Punkt 4: Neuversuch-Plan nach dem ersten Gate-Lauf — language_mismatch (#695) und
 * repeats_own_sentence (mechanisch) teilen sich GENAU EINEN Neuversuch; beide Korrekturen gehen
 * dann gemeinsam in den Prompt. null = kein Neuversuch. Exportiert für stale-draft-regen.ts.
 */
export function planDraftRetry(
  gateResult: GateResult | undefined, body: string, messages: Message[],
): { languageRetry?: true; repeatRetrySentence?: string } | null {
  const language = isLanguageMismatchWait(gateResult);
  const repeat = !!gateResult?.decision && gateResult.decision.decision === 'wait' &&
    (gateResult.decision.flags ?? []).includes('mech:repeats_own_sentence');
  if (!language && !repeat) return null;
  const plan: { languageRetry?: true; repeatRetrySentence?: string } = {};
  if (language) plan.languageRetry = true;
  if (repeat) {
    plan.repeatRetrySentence = findRepeatedOwnSentence(body, recentHostMessages(messages)) ??
      '(ein Satz aus deinen früheren Nachrichten)';
  }
  return plan;
}

export const DRAFT_GEN_CAP = 10;
// Only draft threads whose last guest message is newer than this — stale threads
// don't warrant an AI reply. Expressed as a SQLite datetime modifier.
export const DRAFT_MAX_AGE_HOURS = 72;
export const DRAFT_SINCE_MODIFIER = `-${DRAFT_MAX_AGE_HOURS} hours`;

/**
 * Which message source + listing id a property's drafts are generated for.
 * airbnb-mail (and anything else without a reply channel) → null = no drafts.
 */
export function resolveDraftSource(
  property: PropertyConfig,
): { source: 'hostex' | 'guesty'; listingId: string } | null {
  if (property.provider === 'hostex' && property.hostexPropertyId) {
    return { source: 'hostex', listingId: property.hostexPropertyId };
  }
  if (property.provider === 'guesty' && property.guestyPropertyId) {
    return { source: 'guesty', listingId: property.guestyPropertyId };
  }
  return null;
}

export interface DraftGenDeps {
  getThreads: (source: 'hostex' | 'guesty', listingId: string, limit: number, sinceModifier: string) => MessageThread[];
  getMessages: (threadId: string) => Message[];
  loadVoice: () => string | null;
  loadFacts: (vaultNote: string) => string | null;
  generate: (input: {
    thread: MessageThread; messages: Message[]; voice: string; facts: string; bookingContext: string | null;
    // #1243: das Objekt hat eine Rabatt-Linie für Plattform-Anfragen (properties.json airbnbDiscount).
    discountRuleApplies?: boolean;
    // #695: Sprach-Pin — Fakt statt Prosa-Regel im Prompt (Spec Punkt 1) + Flag für den
    // Neuversuch-Prompt-Zusatz (Spec Punkt 3).
    guestLanguage?: SupportedLanguage; languageRetry?: boolean;
    // #1191: Neuversuch nach repeats_own_sentence — der wiederholte Satz.
    repeatRetrySentence?: string | null;
    // #697: mechanisch erkannte Buchungsanfrage — wählt den Buchungsanfrage-Prompt-Block.
    isBookingRequest?: boolean;
    // #1004: Art der Anfrage (Inquiry/Request-to-Book) für Kontext + Schlusssatz im Block.
    requestKind?: BookingRequestKind | null;
    // #976: Änderungsantrag/-wunsch zu einer bestehenden Buchung.
    alteration?: AlterationSituation | null;
  }) => Promise<DraftResult>;
  create: (d: NewDraft) => void;
  markNoReply: (threadId: string) => void;
  // #364: what the platform already knows about this thread's booking
  // (reservation/inquiry link) — see booking-context.ts.
  buildBookingContext: (thread: MessageThread) => string | null;
  gate: (i: GateInput) => Promise<GateResult>;
  // #695: Body-Update für den einen automatischen Neuversuch — derselbe Draft-Datensatz wird
  // überschrieben statt einen zweiten anzulegen.
  updateDraftBody: (id: string, body: string) => void;
  // #976: Änderungs-Situation (optional; fehlt der Dep, gibt es keinen Änderungs-Block).
  resolveAlteration?: (thread: MessageThread, messages: Message[], isBookingRequest: boolean) => AlterationSituation | null;
  // #1210: Inquiry-Tasks beantworteter Anfragen schließen — läuft nach JEDEM Sync (Loop, Webhook,
  // ETL, „Jetzt syncen"), weil alle Sync-Pfade hier enden; deckt die direkt in Airbnb gesendete
  // Antwort ab. Optional (fehlt der Dep in Tests, passiert nichts); wirft nie.
  closeAnsweredInquiryTasks?: () => Promise<unknown>;
}

const realDeps: DraftGenDeps = {
  getThreads: getThreadsNeedingDraft,
  getMessages: getMessagesByThread,
  loadVoice: () => loadVoice(),
  loadFacts: (vaultNote) => loadPropertyFacts(vaultNote),
  generate: (input) => generateDraftForThread(input),
  create: createDraft,
  markNoReply: markThreadAiNoReply,
  buildBookingContext,
  gate: (i) => runAutoSendGate(i),
  updateDraftBody,
  resolveAlteration: (thread, messages, isBookingRequest) => resolveAlterationSituation(thread, messages, { isBookingRequest }),
  closeAnsweredInquiryTasks: () => closeAnsweredInquiryTasks(),
};

export async function generateDraftsForProperty(
  property: PropertyConfig,
  deps: DraftGenDeps = realDeps,
  opts: { onlyThreadIds?: string[] } = {},
): Promise<{ generated: number; skipped: number }> {
  if (deps.closeAnsweredInquiryTasks) {
    try {
      await deps.closeAnsweredInquiryTasks();
    } catch (err) {
      logger.warn({ slug: property.slug, err: err instanceof Error ? err.message : String(err) }, 'draft-gen: Inquiry-Task-Selbstschluss fehlgeschlagen (non-fatal)');
    }
  }
  const target = resolveDraftSource(property);
  if (!target || !property.vaultNote) return { generated: 0, skipped: 0 };
  const voice = deps.loadVoice();
  const facts = deps.loadFacts(property.vaultNote);
  if (!voice || !facts) {
    logger.info({ slug: property.slug }, 'draft-gen: voice/facts missing — skipping');
    return { generated: 0, skipped: 0 };
  }

  // Bei onlyThreadIds (Webhook-Kette) darf ein frischer Thread nicht am 10er-Cap
  // scheitern — höheres Limit, danach exakt auf die gewünschten Ids filtern.
  const limit = opts.onlyThreadIds ? Math.max(DRAFT_GEN_CAP, 100) : DRAFT_GEN_CAP;
  const threads = deps.getThreads(target.source, target.listingId, limit, DRAFT_SINCE_MODIFIER);
  const selected = opts.onlyThreadIds ? threads.filter((t) => opts.onlyThreadIds!.includes(t.id)) : threads;
  let generated = 0;
  let skipped = 0;
  const discountRuleApplies = !!property.airbnbDiscount; // #1243
  for (const thread of selected) {
    try {
      const bookingContext = deps.buildBookingContext(thread);
      const messages = deps.getMessages(thread.id);
      // #695: deterministisch erkannte Sprache der letzten Gastnachricht — als Fakt in den
      // Entwurfs-Prompt UND (weiter unten) in den Judge-Kontext, statt einer Prosa-Regel, die
      // von den (meist deutschen) Voice-Beispielen überstimmt werden kann.
      const guestLanguage = detectLanguage(lastInboundBody(messages));
      // #697/#702: Buchungsanfrage-Erkennung läuft VOR dem Entwurf, damit der richtige Prompt
      // gewählt wird (Spec: "Erkennung im Draft-Pfad läuft VOR dem Entwurf"). Seit #702 auch für
      // Folgenachrichten einer noch offenen Anfrage aktiv (findOpenBookingRequest durchsucht den
      // ganzen Thread, nicht nur den System-Post direkt nach der letzten Gastnachricht) — sonst
      // bekäme eine Folgenachricht wie Anikas Antwort auf unsere Rückfrage NICHT den
      // "nur Rückfrage, keine Zusage"-Prompt-Block (Fall Anika #702: genau das führte dazu, dass
      // der Entwurf eine Bestätigung formulierte). Der Gate-Lauf unten erkennt dieselbe
      // Buchungsanfrage unabhängig noch einmal aus `messages` (pure, kein zusätzliches I/O) —
      // keine Notwendigkeit, das Ergebnis hier durchzureichen.
      const openBookingRequest = findOpenBookingRequest(messages, thread.reservation_status);
      const isBookingRequest = openBookingRequest !== null;
      const requestKind = openBookingRequest?.requestKind ?? null; // #1004
      const alteration = deps.resolveAlteration?.(thread, messages, isBookingRequest) ?? null; // #976
      const gateContext = withAlterationFact(bookingContext, alteration);
      const result = await deps.generate({ thread, messages, voice, facts, bookingContext, guestLanguage, isBookingRequest, requestKind, alteration, discountRuleApplies });
      if (result.kind === 'text') {
        const draftId = randomUUID();
        deps.create({ id: draftId, thread_id: thread.id, provider: target.source, body: result.body, generated_by: 'llm', model: DRAFT_MODEL });
        generated++;
        try {
          const gateResult = await deps.gate({ draftId, body: result.body, thread, messages, voice, facts, bookingContext: gateContext, property, guestLanguage });
          const retry = planDraftRetry(gateResult, result.body, messages);
          if (retry) {
            // #695 Spec Punkt 3 / #1191 Spec Punkt 4: genau EIN automatischer Neuversuch mit
            // expliziter Korrektur-Anweisung (falsche Sprache und/oder wiederholter eigener Satz) —
            // derselbe Draft-Datensatz wird überschrieben, nicht neu angelegt.
            const retryResult = await deps.generate({ thread, messages, voice, facts, bookingContext, guestLanguage, ...retry, isBookingRequest, requestKind, alteration, discountRuleApplies });
            if (retryResult.kind === 'text') {
              deps.updateDraftBody(draftId, retryResult.body);
              try {
                await deps.gate({ draftId, body: retryResult.body, thread, messages, voice, facts, bookingContext: gateContext, property, guestLanguage, attempt: 2 });
              } catch (gateErr) {
                logger.warn({ threadId: thread.id, err: gateErr instanceof Error ? gateErr.message : String(gateErr) }, 'auto-send: Gate fehlgeschlagen (Neuversuch, Entwurf bleibt pending)');
              }
            }
            // retryResult.kind 'no_reply'/'failed': die ursprüngliche wait-Entscheidung aus dem
            // ersten Gate-Lauf bleibt bestehen — kein weiterer Versuch (#695 Akzeptanzkriterium).
          }
        } catch (gateErr) {
          logger.warn({ threadId: thread.id, err: gateErr instanceof Error ? gateErr.message : String(gateErr) }, 'auto-send: Gate fehlgeschlagen (Entwurf bleibt pending)');
        }
      } else if (result.kind === 'no_reply') {
        // Bewusste Modell-Entscheidung "keine Antwort nötig" — merken, damit weder der
        // nächste Cron-Lauf noch die UI denselben Stand erneut ans Modell schicken.
        logger.info({ threadId: thread.id, reason: result.reason }, 'draft-gen: no reply needed');
        deps.markNoReply(thread.id);
        skipped++;
      } else {
        // Technischer Ausfall (Tool-Output fehlt/unbrauchbar) — KEIN markNoReply, damit der
        // nächste Lauf es erneut versucht statt den Thread dauerhaft auszuschließen (#385).
        logger.warn({ threadId: thread.id, error: result.error }, 'draft-gen: thread failed (technical)');
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
