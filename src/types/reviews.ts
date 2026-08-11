/**
 * Guest-review drafts (#377) — auto-generated after checkout.
 *
 * See migration 023_add_review_drafts.sql. One row per reservation: a review
 * is written once per stay (unlike message_drafts, which is per-thread and
 * repeats per exchange).
 */

export type ReviewDraftStatus = 'pending' | 'needs_review' | 'done' | 'discarded';

export interface ReviewDraft {
  id: string;
  reservation_id: string;
  listing_id: string;
  provider: 'hostex' | 'guesty';
  guest_name: string | null;
  check_out: string; // YYYY-MM-DD (localized)
  status: ReviewDraftStatus;
  body: string | null; // NULL when status='needs_review' (LLM produced no text)
  // Set when status='needs_review' (why nothing was produced), OR when
  // status='pending' AND the stay was classified 'flagged' — a drafted
  // review for a problem case (#377-Nachbesserung, Micha 11.08.2026): the
  // review text itself stays neutral (hard prompt rule), flag_reason is how
  // the admin UI still surfaces the warning. NULL = normal, unflagged draft.
  flag_reason: string | null;
  generated_by: 'manual' | 'llm';
  model: string | null;
  created_at: string;
  done_at: string | null;
}

export type NewReviewDraft = Pick<
  ReviewDraft,
  'id' | 'reservation_id' | 'listing_id' | 'provider' | 'guest_name' | 'check_out' | 'status' | 'generated_by'
> & {
  body?: string | null;
  flag_reason?: string | null;
  model?: string | null;
};
