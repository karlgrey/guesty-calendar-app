import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  createDraft, setAutoDecision, markDraftSent, setSentBodyChanged, threadHasHumanIntervention,
  countAutoSentSince, getAwaitingDrafts, getAutoSendStats, listAutoDecisions, getDraftById,
  getLastSentDraftByThread, threadHasFailedSend, releaseAutoSendForThread,
} from './draft-repository.js';

let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

function seedThread(id: string, guest = 'Anna', manually = 0) {
  db.prepare(`INSERT INTO message_threads (id, listing_id, source, channel, guest_name, first_message_at, last_message_at, message_count, manually_categorized, last_synced_at)
    VALUES (?, 'L1', 'hostex', 'airbnb', ?, '2026-09-19T10:00:00Z', '2026-09-19T10:00:00Z', 1, ?, '2026-09-19T10:00:00Z')`).run(id, guest, manually);
  db.prepare(`INSERT INTO messages (id, thread_id, direction, sent_at, body, source) VALUES (?, ?, 'inbound', '2026-09-19T10:00:00Z', 'Können wir um 13 Uhr kommen? Danke!', 'hostex')`).run(`${id}:m1`, id);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(mig('014_add_messages_threads.sql'));
  db.exec(mig('015_add_manual_category.sql'));
  db.exec(mig('018_add_message_drafts.sql'));
  db.exec(mig('019_add_draft_model.sql'));
  db.exec(mig('020_add_feedback_and_suggestions.sql'));
  db.exec(mig('025_add_thread_discarded_at.sql'));
  db.exec(mig('027_add_auto_send.sql'));
  db.exec(mig('029_add_smarttasks_task.sql'));
  db.exec(mig('030_add_booking_request.sql'));
  db.exec(mig('031_add_judge_reasoning_and_release.sql'));
  setDatabase(db);
  seedThread('hostex:t1');
});
afterEach(() => { resetDatabase(); db.close(); });

describe('setAutoDecision / markDraftSent', () => {
  it('persistiert Entscheidung, Flags als JSON und sent_by', () => {
    createDraft({ id: 'd1', thread_id: 'hostex:t1', provider: 'hostex', body: 'Hallo', generated_by: 'llm' });
    setAutoDecision('d1', { decision: 'wait', reason: 'Kategorie Sonderwunsch — nie automatisch', category: 'sonderwunsch', flags: ['mech:url'] }, 'shadow');
    markDraftSent('d1', 'ext-1', 'auto');
    const d = getDraftById('d1')!;
    expect(d.auto_decision).toBe('wait');
    expect(JSON.parse(d.auto_flags!)).toEqual(['mech:url']);
    expect(d.auto_mode).toBe('shadow');
    expect(d.auto_judged_at).toBeTruthy();
    expect(d.sent_by).toBe('auto');
  });
  // #702 Punkt 4
  it('persistiert judgeReasoning in auto_judge_reasoning', () => {
    createDraft({ id: 'd1b', thread_id: 'hostex:t1', provider: 'hostex', body: 'Hallo', generated_by: 'llm' });
    setAutoDecision('d1b', { decision: 'auto', reason: 'ok', category: 'dank_smalltalk', flags: [], judgeReasoning: 'Reiner Dank, keine Sachaussage.' }, 'live');
    expect(getDraftById('d1b')!.auto_judge_reasoning).toBe('Reiner Dank, keine Sachaussage.');
  });
  it('judgeReasoning fehlt (ältere/handgebaute AutoSendDecision) → NULL, kein Fehler', () => {
    createDraft({ id: 'd1c', thread_id: 'hostex:t1', provider: 'hostex', body: 'Hallo', generated_by: 'llm' });
    setAutoDecision('d1c', { decision: 'wait', reason: 'x', category: null, flags: [] }, 'live');
    expect(getDraftById('d1c')!.auto_judge_reasoning).toBeNull();
  });
  it('markDraftSent ohne sentBy → micha', () => {
    createDraft({ id: 'd2', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    markDraftSent('d2', null);
    setSentBodyChanged('d2', true);
    const d = getDraftById('d2')!;
    expect(d.sent_by).toBe('micha');
    expect(d.sent_body_changed).toBe(1);
  });
});

// #702 Punkt 1: der Ausschluss gilt nur noch für die AKTUELLE Runde (Draft created_at NACH
// sent_at der letzten Gastnachricht) — mit Ausnahme von manually_categorized (keinem Draft
// zugeordnet, bleibt dauerhaft).
describe('threadHasHumanIntervention', () => {
  const since = '2026-09-19T10:00:00Z'; // sent_at der von seedThread() erzeugten Gastnachricht

  it('false ohne Verwerfen/Feedback/manuelle Kategorie', () => {
    expect(threadHasHumanIntervention('hostex:t1', since)).toBe(false);
  });
  it('true bei verworfenem Draft der aktuellen Runde (created_at nach since)', () => {
    createDraft({ id: 'd3', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='discarded' WHERE id='d3'`).run();
    expect(threadHasHumanIntervention('hostex:t1', since)).toBe(true);
  });
  it('false bei verworfenem Draft VOR der aktuellen Gastnachricht (ältere Runde zählt nicht mehr)', () => {
    createDraft({ id: 'd3b', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='discarded', created_at='2026-09-18 09:00:00' WHERE id='d3b'`).run();
    expect(threadHasHumanIntervention('hostex:t1', since)).toBe(false);
  });
  it('true bei Feedback-Zeile MIT draft_id der aktuellen Runde', () => {
    createDraft({ id: 'd4', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`INSERT INTO draft_feedback (id, thread_id, draft_id, category, note) VALUES ('f1','hostex:t1','d4','fakt','x')`).run();
    expect(threadHasHumanIntervention('hostex:t1', since)).toBe(true);
  });
  it('false bei Feedback OHNE draft_id (kein Rundenbezug — bleibt Wissens-Signal für den Vault, keine Sperre mehr)', () => {
    db.prepare(`INSERT INTO draft_feedback (id, thread_id, category, note) VALUES ('f2','hostex:t1','fakt','x')`).run();
    expect(threadHasHumanIntervention('hostex:t1', since)).toBe(false);
  });
  it('false bei Feedback zu einem Draft einer älteren Runde', () => {
    createDraft({ id: 'd5', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET created_at='2026-09-18 09:00:00' WHERE id='d5'`).run();
    db.prepare(`INSERT INTO draft_feedback (id, thread_id, draft_id, category, note) VALUES ('f3','hostex:t1','d5','fakt','x')`).run();
    expect(threadHasHumanIntervention('hostex:t1', since)).toBe(false);
  });
  it('true bei manueller Kategorie — bleibt dauerhaft, unabhängig von since (kein Rundenbezug)', () => {
    seedThread('hostex:t2', 'Ben', 1);
    expect(threadHasHumanIntervention('hostex:t2', '2099-01-01T00:00:00Z')).toBe(true);
  });
  it('lastGuestMessageSentAt = null → konservativ wie vor #702 (jeder verworfene Draft blockiert, egal wie alt)', () => {
    createDraft({ id: 'd6', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='discarded', created_at='2020-01-01 00:00:00' WHERE id='d6'`).run();
    expect(threadHasHumanIntervention('hostex:t1', null)).toBe(true);
  });
});

describe('threadHasFailedSend', () => {
  it('false ohne fehlgeschlagenen/hängenden Versand', () => {
    expect(threadHasFailedSend('hostex:t1')).toBe(false);
  });
  it('true bei Draft mit status=error', () => {
    createDraft({ id: 'fs1', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='error', error='Kanal' WHERE id='fs1'`).run();
    expect(threadHasFailedSend('hostex:t1')).toBe(true);
  });
  it('true bei Draft mit status=sending (hängender Versand)', () => {
    createDraft({ id: 'fs2', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='sending' WHERE id='fs2'`).run();
    expect(threadHasFailedSend('hostex:t1')).toBe(true);
  });
  it('false wenn nur sent/pending im Thread stehen', () => {
    createDraft({ id: 'fs3', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    markDraftSent('fs3', null, 'micha');
    createDraft({ id: 'fs4', thread_id: 'hostex:t1', provider: 'hostex', body: 'y', generated_by: 'llm' });
    expect(threadHasFailedSend('hostex:t1')).toBe(false);
  });
  // #702 Punkt 2
  it('releaseAutoSendForThread hebt eine BESTEHENDE Sperre auf', () => {
    createDraft({ id: 'fs5', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='error', error='Kanal' WHERE id='fs5'`).run();
    expect(threadHasFailedSend('hostex:t1')).toBe(true);
    releaseAutoSendForThread('hostex:t1');
    expect(threadHasFailedSend('hostex:t1')).toBe(false);
  });
  it('ein NEUER Fehlschlag NACH der Freigabe sperrt den Thread erneut', () => {
    createDraft({ id: 'fs6', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='error', error='Kanal', created_at='2026-09-19 08:00:00' WHERE id='fs6'`).run();
    db.prepare(`UPDATE message_threads SET auto_send_released_at='2026-09-19 09:00:00' WHERE id='hostex:t1'`).run();
    expect(threadHasFailedSend('hostex:t1')).toBe(false);
    createDraft({ id: 'fs7', thread_id: 'hostex:t1', provider: 'hostex', body: 'y', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='error', error='Kanal', created_at='2026-09-19 10:00:00' WHERE id='fs7'`).run();
    expect(threadHasFailedSend('hostex:t1')).toBe(true);
  });
  it('releaseAutoSendForThread ohne bestehende Sperre ist ein No-op (kein Fehler)', () => {
    expect(() => releaseAutoSendForThread('hostex:t1')).not.toThrow();
    expect(threadHasFailedSend('hostex:t1')).toBe(false);
  });
});

describe('countAutoSentSince / getAwaitingDrafts / stats', () => {
  it('zählt nur sent_by=auto ab Zeitpunkt', () => {
    for (const [id, by, at] of [['a1', 'auto', '2026-09-19 08:00:00'], ['a2', 'auto', '2026-09-18 23:00:00'], ['a3', 'micha', '2026-09-19 09:00:00']] as const) {
      createDraft({ id, thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
      db.prepare(`UPDATE message_drafts SET status='sent', sent_by=?, sent_at=? WHERE id=?`).run(by, at, id);
    }
    expect(countAutoSentSince('2026-09-19T00:00:00.000Z')).toBe(1);
  });
  it('getAwaitingDrafts liefert wait- und error-Drafts nach since, aufsteigend, mit Gast-Auszug', () => {
    createDraft({ id: 'w1', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    setAutoDecision('w1', { decision: 'wait', reason: 'Grund A', category: 'geld', flags: [] }, 'live');
    createDraft({ id: 'e1', thread_id: 'hostex:t1', provider: 'hostex', body: 'y', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='error', error='Kanal', created_at='2026-09-19 12:00:00' WHERE id='e1'`).run();
    createDraft({ id: 'ok1', thread_id: 'hostex:t1', provider: 'hostex', body: 'z', generated_by: 'llm' });
    setAutoDecision('ok1', { decision: 'auto', reason: 'ok', category: 'dank_smalltalk', flags: [] }, 'live');
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    expect(rows.map((r) => r.id).sort()).toEqual(['e1', 'w1']);
    expect(rows[0].guest_name).toBe('Anna');
    expect(rows[0].last_guest_message).toContain('13 Uhr');
    expect(rows.find((r) => r.id === 'e1')!.reason).toContain('Auto-Send fehlgeschlagen');
  });
  it('hängender Auto-Send (live, auto/pending, älter als 10 min) → enthalten mit Hänge-Grund (F3)', () => {
    createDraft({ id: 'stuck1', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET auto_decision='auto', auto_mode='live', status='pending', auto_judged_at=datetime('now','-15 minutes') WHERE id='stuck1'`).run();
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    const row = rows.find((r) => r.id === 'stuck1');
    expect(row).toBeDefined();
    expect(row!.reason).toBe('Auto-Send hängt — bitte manuell prüfen');
  });
  it('frischer Auto-Send (live, auto/pending, gerade geurteilt) → NICHT enthalten (F3)', () => {
    createDraft({ id: 'fresh1', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET auto_decision='auto', auto_mode='live', status='pending', auto_judged_at=datetime('now') WHERE id='fresh1'`).run();
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    expect(rows.find((r) => r.id === 'fresh1')).toBeUndefined();
  });
  it('Schatten-auto, 15 min alt, pending → NICHT enthalten (Re-Review: Spec 4 „Push nur für wait, auch im Schatten")', () => {
    createDraft({ id: 'shadow1', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET auto_decision='auto', auto_mode='shadow', status='pending', auto_judged_at=datetime('now','-15 minutes') WHERE id='shadow1'`).run();
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    expect(rows.find((r) => r.id === 'shadow1')).toBeUndefined();
  });
  it('hängender Versand (status=sending, älter als 10 min) → enthalten mit neutralem Hänge-Grund (F3, Re-Review)', () => {
    createDraft({ id: 'sending1', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='sending', created_at=datetime('now','-15 minutes') WHERE id='sending1'`).run();
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    const row = rows.find((r) => r.id === 'sending1');
    expect(row).toBeDefined();
    expect(row!.reason).toBe('Versand hängt — bitte manuell prüfen');
  });
  it('frischer Versand (status=sending, gerade erst geclaimt) → NICHT enthalten (F3)', () => {
    createDraft({ id: 'sending2', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='sending' WHERE id='sending2'`).run();
    const rows = getAwaitingDrafts('2026-01-01T00:00:00.000Z', 10);
    expect(rows.find((r) => r.id === 'sending2')).toBeUndefined();
  });
  it('getAutoSendStats zählt Schattenfälle unverändert/geändert', () => {
    createDraft({ id: 's1', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    setAutoDecision('s1', { decision: 'auto', reason: 'ok', category: 'dank_smalltalk', flags: [] }, 'shadow');
    markDraftSent('s1', null, 'micha'); setSentBodyChanged('s1', false);
    createDraft({ id: 's2', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    setAutoDecision('s2', { decision: 'auto', reason: 'ok', category: 'dank_smalltalk', flags: [] }, 'shadow');
    markDraftSent('s2', null, 'micha'); setSentBodyChanged('s2', true);
    createDraft({ id: 's3', thread_id: 'hostex:t1', provider: 'hostex', body: 'x', generated_by: 'llm' });
    setAutoDecision('s3', { decision: 'wait', reason: 'w', category: 'geld', flags: [] }, 'shadow');
    const s = getAutoSendStats('2026-01-01T00:00:00.000Z');
    expect(s).toEqual({ autoSent: 0, waited: 1, shadowWouldAuto: 2, shadowUnchanged: 1, shadowChanged: 1, shadowDiscarded: 0 });
    expect(listAutoDecisions(10).length).toBe(3);
  });
});

describe('getLastSentDraftByThread', () => {
  it('liefert den zuletzt gesendeten Draft eines Threads (neuester sent_at zuerst)', () => {
    createDraft({ id: 'g1', thread_id: 'hostex:t1', provider: 'hostex', body: 'älter', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='sent', sent_by='auto', sent_at='2026-09-19 08:00:00' WHERE id='g1'`).run();
    createDraft({ id: 'g2', thread_id: 'hostex:t1', provider: 'hostex', body: 'neuer', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status='sent', sent_by='micha', sent_at='2026-09-19 10:00:00' WHERE id='g2'`).run();
    const d = getLastSentDraftByThread('hostex:t1');
    expect(d?.id).toBe('g2');
  });
  it('null ohne gesendeten Draft', () => {
    createDraft({ id: 'g3', thread_id: 'hostex:t1', provider: 'hostex', body: 'pending', generated_by: 'llm' });
    expect(getLastSentDraftByThread('hostex:t1')).toBeNull();
  });
  it('null für unbekannten Thread', () => {
    expect(getLastSentDraftByThread('hostex:unknown')).toBeNull();
  });
});
