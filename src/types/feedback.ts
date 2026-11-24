export type FeedbackCategory = 'ton' | 'fakt' | 'einmalig';
export type SuggestionStatus = 'pending' | 'approved' | 'discarded' | 'revoked';

export interface DraftFeedback {
  id: string;
  thread_id: string;
  draft_id: string | null;
  category: FeedbackCategory;
  note: string;
  created_at?: string;
}
export type NewFeedback = Pick<DraftFeedback, 'id' | 'thread_id' | 'draft_id' | 'category' | 'note'>;

/** Herkunft des Feedback-Loops im Admin-UI (DB-Default der Spalte `origin`, Migration 046). */
export const FEEDBACK_ORIGIN = 'feedback';

export interface VaultSuggestion {
  id: string;
  /** NULL bei Vorschlägen ohne Entwurfs-Feedback (Agent-API, #1295, Migration 046). */
  feedback_id: string | null;
  target_file: string;
  target_heading: string;
  addition_text: string;
  rationale: string;
  status: SuggestionStatus;
  applied_commit: string | null;
  created_at?: string;
  applied_at: string | null;
  revoked_at?: string | null;
  revoke_commit?: string | null;
  /** Herkunft (Migration 046): 'feedback' oder z. B. 'diff-auswertung'. Fehlt nur in Alt-Testschemata → wie 'feedback' behandeln. */
  origin?: string;
}
/** Feedback-Loop: immer mit feedback_id, origin bleibt der DB-Default 'feedback'. */
export type NewSuggestion = Pick<VaultSuggestion, 'id' | 'target_file' | 'target_heading' | 'addition_text' | 'rationale'> & { feedback_id: string };
/** Agent-API (#1295): ohne feedback_id, mit Herkunft. */
export type NewOriginSuggestion = Pick<VaultSuggestion, 'id' | 'target_file' | 'target_heading' | 'addition_text' | 'rationale'> & { origin: string };
