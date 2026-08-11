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
  body: string | null; // NULL when status='needs_review'
  flag_reason: string | null; // set when status='needs_review'
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
