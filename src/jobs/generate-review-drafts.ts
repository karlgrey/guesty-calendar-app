import { randomUUID } from 'node:crypto';
import { getRecentCheckoutIdsNeedingReview, getReservationById } from '../repositories/reservation-repository.js';
import { getThreadsByReservationId, getThreadsByListingAndGuestName, getMessagesByThread } from '../repositories/message-repository.js';
import { createReviewDraft } from '../repositories/review-draft-repository.js';
import { loadVoice } from '../services/vault-knowledge.js';
import { generateReviewForStay, REVIEW_MODEL } from '../services/review-draft-service.js';
import { classifyStayForReview, type ReviewClassifierResult } from '../utils/review-classifier.js';
import type { Message } from '../types/messages.js';
import type { NewReviewDraft } from '../types/reviews.js';
import type { PropertyConfig } from '../config/properties.js';
import logger from '../utils/logger.js';

export const REVIEW_DRAFT_CAP = 10;
// How far back we look for un-drafted checkouts. Capped below the Airbnb
// review deadline (checkout + 14 days) so we never bother drafting for a stay
// that's effectively already past its window — see the spec's "Verfallsdatum"
// requirement, computed client-side in the admin UI from check_out + 14 days.
export const REVIEW_LOOKBACK_DAYS = 13;
export const REVIEW_SINCE_MODIFIER = `-${REVIEW_LOOKBACK_DAYS} days`;

/**
 * Which message source + listing id a property's review drafts are generated
 * for. Mirrors resolveDraftSource (generate-drafts.ts) exactly — this is what
 * implements "alle Objekte AUSSER Florenz/Manifattura" (Design-Entscheidung
 * Micha 11.08.2026): Florenz runs on provider='airbnb-mail' with no reply
 * channel, so it falls through to null here just like it does for message
 * drafts. No separate opt-out flag needed unless a *guesty/hostex* property
 * needs excluding later.
 */
export function resolveReviewSource(
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

/** ISO/localized date (YYYY-MM-DD…) → German TT.MM.JJJJ, matching booking-context.ts's convention. */
function deDate(dateStr: string | null): string {
  if (!dateStr) return '?';
  const [y, m, d] = dateStr.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

function buildThreadHighlights(messages: Message[]): string {
  return messages
    .filter((m) => m.direction !== 'system')
    .map((m) => `${m.direction === 'inbound' ? 'Gast' : 'Host'}: ${m.body}`)
    .join('\n');
}

export interface ReviewDraftGenDeps {
  getCheckoutIds: (listingId: string, sinceModifier: string, limit: number) => string[];
  getReservation: (id: string) => ReturnType<typeof getReservationById>;
  getThreadsByReservation: (reservationId: string) => ReturnType<typeof getThreadsByReservationId>;
  getThreadsByGuestName: (listingId: string, guestName: string) => ReturnType<typeof getThreadsByListingAndGuestName>;
  getMessages: (threadId: string) => Message[];
  loadVoice: () => string | null;
  classify: (input: { messages: Array<{ direction: 'inbound' | 'outbound' | 'system'; body: string }> }) => Promise<ReviewClassifierResult>;
  generate: (input: Parameters<typeof generateReviewForStay>[0]) => Promise<string | null>;
  create: (d: NewReviewDraft) => void;
}

const realDeps: ReviewDraftGenDeps = {
  getCheckoutIds: getRecentCheckoutIdsNeedingReview,
  getReservation: getReservationById,
  getThreadsByReservation: getThreadsByReservationId,
  getThreadsByGuestName: getThreadsByListingAndGuestName,
  getMessages: getMessagesByThread,
  loadVoice: () => loadVoice(),
  classify: classifyStayForReview,
  generate: (input) => generateReviewForStay(input),
  create: createReviewDraft,
};

export async function generateReviewDraftsForProperty(
  property: PropertyConfig,
  deps: ReviewDraftGenDeps = realDeps,
): Promise<{ generated: number; flagged: number; skipped: number }> {
  const target = resolveReviewSource(property);
  if (!target) return { generated: 0, flagged: 0, skipped: 0 };
  const voice = deps.loadVoice();
  if (!voice) {
    logger.info({ slug: property.slug }, 'review-draft-gen: voice missing — skipping');
    return { generated: 0, flagged: 0, skipped: 0 };
  }

  const reservationIds = deps.getCheckoutIds(target.listingId, REVIEW_SINCE_MODIFIER, REVIEW_DRAFT_CAP);
  let generated = 0;
  let flagged = 0;
  let skipped = 0;

  for (const reservationId of reservationIds) {
    try {
      const reservation = deps.getReservation(reservationId);
      if (!reservation) { skipped++; continue; }

      // Guesty conversations link reservation_id directly; Hostex conversations
      // never carry it (API limitation) — fall back to a guest-name match.
      const threads = target.source === 'guesty'
        ? deps.getThreadsByReservation(reservationId)
        : reservation.guest_name
          ? deps.getThreadsByGuestName(target.listingId, reservation.guest_name)
          : [];
      const messages = threads
        .flatMap((t) => deps.getMessages(t.id))
        .sort((a, b) => a.sent_at.localeCompare(b.sent_at));

      const base: Pick<NewReviewDraft, 'id' | 'reservation_id' | 'listing_id' | 'provider' | 'guest_name' | 'check_out' | 'generated_by'> = {
        id: randomUUID(),
        reservation_id: reservationId,
        listing_id: target.listingId,
        provider: target.source,
        guest_name: reservation.guest_name,
        check_out: reservation.check_out_localized ?? reservation.check_out,
        generated_by: 'llm',
      };

      let classification: ReviewClassifierResult;
      if (messages.length === 0) {
        classification = { classification: 'ok', reasoning: 'Kein Nachrichtenverlauf für diesen Aufenthalt gefunden.' };
      } else {
        classification = await deps.classify({
          messages: messages.map((m) => ({ direction: m.direction, body: m.body })),
        });
      }

      const isFlagged = classification.classification === 'flagged';

      // Problem cases (Micha, 11.08.2026) also get a drafted review now — with
      // the hard "don't mention the problem" rule baked into the prompt (see
      // review-draft-service.ts's buildSystemPrompt). The flag itself stays
      // visible to Micha via flag_reason, never in the review text. status
      // stays 'pending' (not 'needs_review') so the existing compose/approve
      // flow just works; needs_review remains the reserve for "LLM produced
      // nothing" (flagged or not) — see routes/reviews.ts for how the admin
      // UI tells a flagged-but-drafted 'pending' apart from a normal one.
      const review = await deps.generate({
        guestName: reservation.guest_name,
        propertyName: property.name,
        checkInLabel: deDate(reservation.check_in_localized ?? reservation.check_in),
        checkOutLabel: deDate(reservation.check_out_localized ?? reservation.check_out),
        nights: reservation.nights_count ?? null,
        voice,
        threadHighlights: buildThreadHighlights(messages),
        flagged: isFlagged,
      });

      if (review) {
        deps.create({
          ...base,
          status: 'pending',
          body: review,
          flag_reason: isFlagged ? classification.reasoning : null,
          model: REVIEW_MODEL,
        });
        generated++;
      } else {
        deps.create({
          ...base,
          status: 'needs_review',
          body: null,
          flag_reason: isFlagged ? classification.reasoning : 'LLM konnte keine Bewertung erzeugen.',
        });
        flagged++;
      }
    } catch (err) {
      logger.warn(
        { reservationId, err: err instanceof Error ? err.message : String(err) },
        'review-draft-gen: reservation failed',
      );
      skipped++;
    }
  }

  logger.info({ slug: property.slug, generated, flagged, skipped }, 'review-draft-gen: done');
  return { generated, flagged, skipped };
}
