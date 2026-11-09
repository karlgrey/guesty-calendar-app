// #1082: Few-shot-Beispiele aus gesendeten Host-Nachrichten. Liefert Kandidaten (final gesendeter
// Text aus message_drafts, nie original_body) samt der Gastnachricht, auf die geantwortet wurde.
// Auswahl/Ranking passiert im Service; hier nur die Abfrage (outcome unchanged/changed laut
// services/auto-send/decision-case.ts: status sent und nicht von auto gesendet).
import { getDatabase } from '../db/index.js';

/** #1082: Kandidat für ein Stil-Beispiel — final gesendeter Host-Text aus message_drafts. */
export interface HostExampleCandidate {
  draftId: string;
  threadId: string;
  listingId: string;
  source: string;                     // message_threads.source
  body: string;                       // message_drafts.body (nach Send = gesendeter Text)
  sentAt: string | null;              // message_drafts.sent_at
  judgeCategory: string | null;       // message_drafts.auto_category
  conversionCategory: string | null;  // message_threads.conversion_category
  guestMessage: string | null;        // body der jüngsten inbound-Nachricht desselben Threads mit sent_at <= draft.created_at
}

export function listHostExampleCandidates(opts: { sinceIso: string; limit: number; excludeThreadId?: string | null }): HostExampleCandidate[] {
  return getDatabase().prepare(
    `SELECT d.id AS draftId, d.thread_id AS threadId, t.listing_id AS listingId, t.source AS source,
       d.body AS body, d.sent_at AS sentAt, d.auto_category AS judgeCategory,
       t.conversion_category AS conversionCategory,
       -- Prüfer #1082: "+m.direction" nimmt der Planer die Spalte als Index-Kandidat — sonst wählt er
       -- idx_messages_direction (Scan aller inbound-Nachrichten je Draft) statt idx_messages_thread.
       (SELECT m.body FROM messages m
         WHERE m.thread_id = d.thread_id AND +m.direction = 'inbound'
           AND datetime(m.sent_at) <= datetime(d.created_at)
         ORDER BY datetime(m.sent_at) DESC LIMIT 1) AS guestMessage
     FROM message_drafts d JOIN message_threads t ON t.id = d.thread_id
     WHERE d.status = 'sent' AND (d.sent_by IS NULL OR d.sent_by <> 'auto')
       AND datetime(COALESCE(d.sent_at, d.created_at)) >= datetime(@since)
       AND (@exclude IS NULL OR d.thread_id <> @exclude)
       AND TRIM(d.body, ' ' || char(9) || char(10) || char(13)) <> ''
     ORDER BY datetime(COALESCE(d.sent_at, d.created_at)) DESC LIMIT @limit`,
  ).all({ since: opts.sinceIso, exclude: opts.excludeThreadId ?? null, limit: opts.limit }) as HostExampleCandidate[];
}
