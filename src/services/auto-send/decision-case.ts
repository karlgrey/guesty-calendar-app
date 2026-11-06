import type { MessageDraft } from '../../types/messages.js';

// #1044: Outcome + Texte eines Auto-Send-Einzelfalls (reine Funktionen für /auto-send/decisions).

export type AutoDecisionOutcome = 'auto_sent' | 'changed' | 'unchanged' | 'discarded' | 'pending' | 'sending' | 'error';

export function autoDecisionOutcome(d: Pick<MessageDraft, 'status' | 'sent_by' | 'sent_body_changed'>): AutoDecisionOutcome {
  if (d.status === 'sent') {
    if (d.sent_by === 'auto') return 'auto_sent';
    if (d.sent_body_changed === 1) return 'changed';
    return 'unchanged';
  }
  return d.status as AutoDecisionOutcome;
}

/**
 * Beim Senden mit Änderung überschreibt POST /admin/messages/drafts/:id/send den body mit dem
 * gesendeten Text — der ursprüngliche Entwurf ist dann nicht mehr in der DB (previous_body ist
 * NICHT der Ausgangstext, sondern die Vorversion einer automatischen Neugenerierung).
 */
export function autoDecisionTexts(
  outcome: AutoDecisionOutcome, body: string,
): { draftText: string | null; sentText: string | null; draftTextLost: boolean } {
  if (outcome === 'changed') return { draftText: null, sentText: body, draftTextLost: true };
  if (outcome === 'unchanged' || outcome === 'auto_sent') return { draftText: body, sentText: body, draftTextLost: false };
  return { draftText: body, sentText: null, draftTextLost: false };
}
