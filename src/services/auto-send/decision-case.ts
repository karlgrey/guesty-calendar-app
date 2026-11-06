import type { MessageDraft } from '../../types/messages.js';
import { unifiedLineDiff } from '../../utils/line-diff.js';

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
 * gesendeten Text. Seit #1062 (Migration 039) sichert der erste Edit den Entwurfstext als
 * original_body — dann liefert 'changed' Entwurf, gesendeten Text und Zeilen-Diff. Fehlt
 * original_body (vor Migration 039 gesendet), bleibt draftTextLost=true. previous_body ist
 * NICHT der Ausgangstext, sondern die Vorversion einer automatischen Neugenerierung.
 */
export function autoDecisionTexts(
  outcome: AutoDecisionOutcome, body: string, originalBody?: string | null,
): { draftText: string | null; sentText: string | null; draftTextLost: boolean; diff: string | null } {
  if (outcome === 'changed') {
    if (originalBody == null) return { draftText: null, sentText: body, draftTextLost: true, diff: null };
    return { draftText: originalBody, sentText: body, draftTextLost: false, diff: unifiedLineDiff(originalBody, body) };
  }
  if (outcome === 'unchanged' || outcome === 'auto_sent') return { draftText: body, sentText: body, draftTextLost: false, diff: null };
  return { draftText: body, sentText: null, draftTextLost: false, diff: null };
}
