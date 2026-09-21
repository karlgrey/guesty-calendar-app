// #702: Integrationstests für die drei geforderten Fixtures (Bauauftrag Spec Punkt 5) — echte
// Repository-Funktionen (threadHasHumanIntervention/threadHasFailedSend/countAutoSentSince/
// setAutoDecision) gegen eine In-Memory-SQLite-DB, Judge gemockt (kein Live-API-Call). Muster:
// draft-repository.smarttasks.test.ts. Anders als runner.test.ts (dort ist hasHumanIntervention
// selbst gemockt) prüft diese Datei die ECHTE SQL-Rundenscoping-Logik end-to-end durch den Gate.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../../db/index.js';
import {
  createDraft, setAutoDecision, threadHasHumanIntervention, threadHasFailedSend, countAutoSentSince,
} from '../../repositories/draft-repository.js';
import { runAutoSendGate, type GateDeps, type GateInput } from './runner.js';
import type { JudgeResult } from './types.js';
import type { Message, MessageThread } from '../../types/messages.js';
import type { PropertyConfig } from '../../config/properties.js';

let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../../db/migrations/${n}`, import.meta.url), 'utf8');

beforeEach(() => {
  db = new Database(':memory:');
  for (const n of [
    '014_add_messages_threads.sql', '015_add_manual_category.sql', '018_add_message_drafts.sql',
    '019_add_draft_model.sql', '020_add_feedback_and_suggestions.sql', '025_add_thread_discarded_at.sql',
    '027_add_auto_send.sql', '029_add_smarttasks_task.sql', '030_add_booking_request.sql',
    '031_add_judge_reasoning_and_release.sql',
  ]) db.exec(mig(n));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

function seedThread(over: { id: string; reservationStatus: string | null }) {
  db.prepare(
    `INSERT INTO message_threads (id, listing_id, source, channel, guest_name, first_message_at, last_message_at,
       message_count, reservation_status, manually_categorized, last_synced_at)
     VALUES (?, 'L1', 'guesty', 'airbnb', 'Anika', '2026-09-20T20:34:58Z', '2026-09-20T20:34:58Z', 1, ?, 0, '2026-09-20T20:34:58Z')`,
  ).run(over.id, over.reservationStatus);
}
function seedMessage(m: { id: string; threadId: string; direction: 'inbound' | 'outbound' | 'system'; body: string; sentAt: string }) {
  db.prepare(`INSERT INTO messages (id, thread_id, direction, sent_at, body, source) VALUES (?, ?, ?, ?, ?, 'guesty')`)
    .run(m.id, m.threadId, m.direction, m.sentAt, m.body);
}

const property = { slug: 'farmhouse', autoSend: undefined } as PropertyConfig;

// Real-Repo-Funktionen für hasHumanIntervention/hasFailedSend/countAutoSentSince/persistDecision,
// alles andere gemockt/gestubbt (kein Judge-API-Call, kein SmartTasks-Aufruf, kein echter Send).
function deps(over: Partial<GateDeps> & { judgeResult: JudgeResult }): GateDeps {
  return {
    envMode: 'live', dailyCap: 10,
    judge: async () => over.judgeResult,
    isPaused: () => false,
    hasHumanIntervention: threadHasHumanIntervention,
    hasFailedSend: threadHasFailedSend,
    countAutoSentSince,
    canSend: () => true,
    persistDecision: setAutoDecision,
    claim: () => true,
    send: async () => ({ ok: true }),
    resolvePromiseTask: async () => ({ created: false, taskNumber: null, reused: false }),
    resolveBookingRequestTask: async () => ({ created: true, taskNumber: 701, reused: false }),
    resolveBookingPeriod: () => ({ periodLabel: null, guestsCount: null }),
    persistBookingRequest: () => {},
    ...over,
  };
}

describe('#702 Fixture 1: alter discarded Draft, neue WLAN-Frage, Reservierung confirmed → auto', () => {
  it('der alte Eingriff (verworfener Draft VOR der aktuellen Buchungsbestätigung) blockiert die neue, unabhängige Frage nicht mehr', async () => {
    seedThread({ id: 'guesty:anika', reservationStatus: 'confirmed' });
    // Alter, verworfener Draft (Anikas ursprüngliche Buchungsanfrage-Rückfrage, 20.09.) — VOR der
    // aktuellen Gastnachricht unten.
    createDraft({ id: 'old-discarded', thread_id: 'guesty:anika', provider: 'guesty', body: 'alte Rückfrage', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='discarded', created_at='2026-09-20 12:00:00' WHERE id='old-discarded'`).run();
    // Neue, unabhängige Gastnachricht NACH dem Eingriff (Buchung inzwischen bestätigt).
    seedMessage({ id: 'm-wlan', threadId: 'guesty:anika', direction: 'inbound', body: 'Wie ist das WLAN-Passwort?', sentAt: '2026-09-21T09:00:00Z' });

    const messages: Message[] = [{ id: 'm-wlan', thread_id: 'guesty:anika', direction: 'inbound', body: 'Wie ist das WLAN-Passwort?', sent_at: '2026-09-21T09:00:00Z', from_name: null, from_address: null, to_address: null, subject: null, body_html: null, source: 'guesty', raw_meta: null }];
    const thread: MessageThread = { id: 'guesty:anika', listing_id: 'L1', source: 'guesty', channel: 'airbnb', guest_name: 'Anika', guest_email: null, first_message_at: '2026-09-20T20:34:58Z', last_message_at: '2026-09-21T09:00:00Z', message_count: 2, reservation_id: null, inquiry_id: null, reservation_status: 'confirmed', conversion_category: null, classification_confidence: null, classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0, manual_note: null, linked_thread_id: null, ai_no_reply_at: null, discarded_at: null, last_synced_at: '2026-09-21T09:00:00Z' };
    const input: GateInput = { draftId: 'new-wlan-draft', body: 'Das WLAN-Passwort steht am Router.', thread, messages, voice: 'V', facts: 'F', bookingContext: null, property };
    createDraft({ id: 'new-wlan-draft', thread_id: 'guesty:anika', provider: 'guesty', body: input.body, generated_by: 'llm' });

    const judgeResult: JudgeResult = { kind: 'verdict', verdict: { category: 'playbook_fakt', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'WLAN steht im Objektwissen.', promisedAction: null } };
    const r = await runAutoSendGate(input, deps({ judgeResult }));
    expect(r.decision.decision).toBe('auto');
    expect(r.decision.reason).not.toMatch(/schon eingegriffen/);
  });
});

describe('#702 Fixture 2: Micha verwirft den Draft zur AKTUELLEN Nachricht, Neugenerierung → wait', () => {
  it('ein Eingriff DERSELBEN Runde blockiert weiterhin', async () => {
    seedThread({ id: 'guesty:ben', reservationStatus: 'confirmed' });
    seedMessage({ id: 'm-frage', threadId: 'guesty:ben', direction: 'inbound', body: 'Können wir früher einchecken?', sentAt: '2026-09-21T09:00:00Z' });
    // Micha verwirft den ERSTEN Entwurf zu GENAU dieser Nachricht.
    createDraft({ id: 'discarded-current', thread_id: 'guesty:ben', provider: 'guesty', body: 'erster Entwurf', generated_by: 'llm' });
    // created_at explizit NACH m-frage gesetzt (statt uhrzeitabhängigem datetime('now') zu
    // vertrauen) — deterministisch, unabhängig vom tatsächlichen Testlauf-Zeitpunkt.
    db.prepare(`UPDATE message_drafts SET status='discarded', created_at='2026-09-21 09:05:00' WHERE id='discarded-current'`).run();

    const messages: Message[] = [{ id: 'm-frage', thread_id: 'guesty:ben', direction: 'inbound', body: 'Können wir früher einchecken?', sent_at: '2026-09-21T09:00:00Z', from_name: null, from_address: null, to_address: null, subject: null, body_html: null, source: 'guesty', raw_meta: null }];
    const thread: MessageThread = { id: 'guesty:ben', listing_id: 'L1', source: 'guesty', channel: 'airbnb', guest_name: 'Ben', guest_email: null, first_message_at: '2026-09-21T09:00:00Z', last_message_at: '2026-09-21T09:00:00Z', message_count: 1, reservation_id: null, inquiry_id: null, reservation_status: 'confirmed', conversion_category: null, classification_confidence: null, classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0, manual_note: null, linked_thread_id: null, ai_no_reply_at: null, discarded_at: null, last_synced_at: '2026-09-21T09:00:00Z' };
    const input: GateInput = { draftId: 'regenerated-draft', body: 'Neuer Entwurf zur selben Frage', thread, messages, voice: 'V', facts: 'F', bookingContext: null, property };
    createDraft({ id: 'regenerated-draft', thread_id: 'guesty:ben', provider: 'guesty', body: input.body, generated_by: 'llm' });

    const judgeResult: JudgeResult = { kind: 'verdict', verdict: { category: 'checkin_standard', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'Standard-Check-in-Frage.', promisedAction: null } };
    const r = await runAutoSendGate(input, deps({ judgeResult }));
    expect(r.decision.decision).toBe('wait');
    expect(r.decision.reason).toMatch(/schon eingegriffen/);
  });
});

describe('#702 Fixture 3: Request-to-Book offen, Gast beschreibt Geburtstagsrunde → buchungsanfrage, nicht sonderwunsch', () => {
  it('Kategorie-Vorrang greift für die Folgenachricht, obwohl der System-Post nicht direkt danach liegt', async () => {
    seedThread({ id: 'guesty:anika2', reservationStatus: null }); // noch nicht bestätigt
    seedMessage({ id: 'm1', threadId: 'guesty:anika2', direction: 'inbound', body: 'Ich würde gern für ein Event buchen.', sentAt: '2026-09-20T20:34:58Z' });
    seedMessage({ id: 'm2', threadId: 'guesty:anika2', direction: 'system', body: 'New guest reservation request HMYYFAMPH8', sentAt: '2026-09-20T20:35:04Z' });
    seedMessage({ id: 'm3', threadId: 'guesty:anika2', direction: 'outbound', body: 'Magst du uns sagen, um welchen Anlass es geht?', sentAt: '2026-09-21T09:01:00Z' });
    seedMessage({ id: 'm4', threadId: 'guesty:anika2', direction: 'inbound', body: 'Gemütliche Runde nach dem Geburtstag, wir kochen und machen Yoga.', sentAt: '2026-09-21T09:39:00Z' });

    const messages: Message[] = [
      { id: 'm1', thread_id: 'guesty:anika2', direction: 'inbound', body: 'Ich würde gern für ein Event buchen.', sent_at: '2026-09-20T20:34:58Z', from_name: null, from_address: null, to_address: null, subject: null, body_html: null, source: 'guesty', raw_meta: null },
      { id: 'm2', thread_id: 'guesty:anika2', direction: 'system', body: 'New guest reservation request HMYYFAMPH8', sent_at: '2026-09-20T20:35:04Z', from_name: null, from_address: null, to_address: null, subject: null, body_html: null, source: 'guesty', raw_meta: null },
      { id: 'm3', thread_id: 'guesty:anika2', direction: 'outbound', body: 'Magst du uns sagen, um welchen Anlass es geht?', sent_at: '2026-09-21T09:01:00Z', from_name: null, from_address: null, to_address: null, subject: null, body_html: null, source: 'guesty', raw_meta: null },
      { id: 'm4', thread_id: 'guesty:anika2', direction: 'inbound', body: 'Gemütliche Runde nach dem Geburtstag, wir kochen und machen Yoga.', sent_at: '2026-09-21T09:39:00Z', from_name: null, from_address: null, to_address: null, subject: null, body_html: null, source: 'guesty', raw_meta: null },
    ];
    const thread: MessageThread = { id: 'guesty:anika2', listing_id: 'L1', source: 'guesty', channel: 'airbnb', guest_name: 'Anika', guest_email: null, first_message_at: '2026-09-20T20:34:58Z', last_message_at: '2026-09-21T09:39:00Z', message_count: 4, reservation_id: null, inquiry_id: null, reservation_status: null, conversion_category: null, classification_confidence: null, classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0, manual_note: null, linked_thread_id: null, ai_no_reply_at: null, discarded_at: null, last_synced_at: '2026-09-21T09:39:00Z' };
    const input: GateInput = { draftId: 'followup-draft', body: 'Klingt schön! Wir bestätigen euch das gern.', thread, messages, voice: 'V', facts: 'F', bookingContext: 'Buchungsanfrage (noch nicht bestätigt): Zeitraum 29.01.2027–31.01.2027, 3 Nächte, 15 Personen.', property };
    createDraft({ id: 'followup-draft', thread_id: 'guesty:anika2', provider: 'guesty', body: input.body, generated_by: 'llm' });

    // Judge klassifiziert (fälschlich, ohne die #702-Erweiterung) als sonderwunsch mit Risiken —
    // die Erweiterung MUSS die Kategorie unabhängig davon auf buchungsanfrage überschreiben.
    const judgeResult: JudgeResult = {
      kind: 'verdict',
      verdict: { category: 'sonderwunsch', answerableFromFacts: false, riskFlags: ['invents_fact', 'promises_action', 'tone_off'], confidence: 'mittel', reasoning: 'Entwurf bestätigt die Feier, ohne dass das belegt ist.', promisedAction: 'Bestätigung der Buchung' },
    };
    const r = await runAutoSendGate(input, deps({ judgeResult }));
    expect(r.decision.category).toBe('buchungsanfrage');
    expect(r.decision.category).not.toBe('sonderwunsch');
    // Die Buchungsentscheidung bleibt bei Micha (Risiko-Flags + promises_action sind im
    // Buchungsanfrage-Zweig ein harter Stopp, keine #696-Fastlane) — Kommentar #697/2209.
    expect(r.decision.decision).toBe('wait');
  });
});
