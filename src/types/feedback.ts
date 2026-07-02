export type FeedbackCategory = 'ton' | 'fakt' | 'einmalig';
export type SuggestionStatus = 'pending' | 'approved' | 'discarded';

export interface DraftFeedback {
  id: string;
  thread_id: string;
  draft_id: string | null;
  category: FeedbackCategory;
  note: string;
  created_at?: string;
}
export type NewFeedback = Pick<DraftFeedback, 'id' | 'thread_id' | 'draft_id' | 'category' | 'note'>;

export interface VaultSuggestion {
  id: string;
  feedback_id: string;
  target_file: string;
  target_heading: string;
  addition_text: string;
  rationale: string;
  status: SuggestionStatus;
  applied_commit: string | null;
  created_at?: string;
  applied_at: string | null;
}
export type NewSuggestion = Pick<VaultSuggestion, 'id' | 'feedback_id' | 'target_file' | 'target_heading' | 'addition_text' | 'rationale'>;
