import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';
import { createDraft, claimDraftRegeneration, applyDraftRegeneration, getDraftById } from './draft-repository.js';

// Stale-Draft-Regeneration (#699): claimDraftRegeneration ist die Drossel ("höchstens ein
// Versuch pro Draft und Fenster" auch bei parallelem Öffnen und nach Fehlschlag),
// applyDraftRegeneration schreibt die neue Fassung + Vorversion, ohne die draftId zu ändern.

let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

function seedThread(id: string) {
  db.prepare(`INSERT INTO message_threads (id, listing_id, source, channel, guest_name, first_message_at, last_message_at, message_count, last_synced_at)
    VALUES (?, 'L1', 'hostex', 'airbnb', 'Anna', '2026-09-19T10:00:00Z', '2026-09-19T10:00:00Z', 1, '2026-09-19T10:00:00Z')`).run(id);
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
  db.exec(mig('032_add_draft_regeneration.sql'));
  setDatabase(db);
  seedThread('hostex:t1');
});
afterEach(() => { resetDatabase(); db.close(); });

describe('claimDraftRegeneration', () => {
  it('alter, nie versuchter pending-LLM-Draft → true, setzt regen_attempted_at', () => {
    createDraft({ id: 'd1', thread_id: 'hostex:t1', provider: 'hostex', body: 'alt', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET created_at = datetime('now', '-7 hours') WHERE id = 'd1'`).run();
    expect(claimDraftRegeneration('d1', 6)).toBe(true);
    expect(getDraftById('d1')!.regen_attempted_at).toBeTruthy();
  });

  it('zweiter Claim direkt danach (gleiches Fenster) → false', () => {
    createDraft({ id: 'd2', thread_id: 'hostex:t1', provider: 'hostex', body: 'alt', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET created_at = datetime('now', '-7 hours') WHERE id = 'd2'`).run();
    expect(claimDraftRegeneration('d2', 6)).toBe(true);
    expect(claimDraftRegeneration('d2', 6)).toBe(false);
  });

  it('junger Draft (jünger als staleHours) → false', () => {
    createDraft({ id: 'd3', thread_id: 'hostex:t1', provider: 'hostex', body: 'neu', generated_by: 'llm' });
    expect(claimDraftRegeneration('d3', 6)).toBe(false);
  });

  it('status != pending → false', () => {
    createDraft({ id: 'd4', thread_id: 'hostex:t1', provider: 'hostex', body: 'alt', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET created_at = datetime('now', '-7 hours'), status = 'sent' WHERE id = 'd4'`).run();
    expect(claimDraftRegeneration('d4', 6)).toBe(false);
  });

  it('generated_by = manual → false', () => {
    createDraft({ id: 'd5', thread_id: 'hostex:t1', provider: 'hostex', body: 'alt', generated_by: 'manual' });
    db.prepare(`UPDATE message_drafts SET created_at = datetime('now', '-7 hours') WHERE id = 'd5'`).run();
    expect(claimDraftRegeneration('d5', 6)).toBe(false);
  });

  it('unbekannte draftId → false', () => {
    expect(claimDraftRegeneration('unknown', 6)).toBe(false);
  });

  it('vorheriger Versuch liegt außerhalb des Fensters → wieder true (nächstes Fenster erlaubt neuen Versuch)', () => {
    createDraft({ id: 'd6', thread_id: 'hostex:t1', provider: 'hostex', body: 'alt', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET created_at = datetime('now', '-20 hours'), regen_attempted_at = datetime('now', '-10 hours') WHERE id = 'd6'`).run();
    expect(claimDraftRegeneration('d6', 6)).toBe(true);
  });
});

describe('applyDraftRegeneration', () => {
  it('schreibt previous_body/previous_body_at/regenerated_at, lässt id gleich, überschreibt body', () => {
    createDraft({ id: 'd7', thread_id: 'hostex:t1', provider: 'hostex', body: 'alter Text', generated_by: 'llm' });
    const before = getDraftById('d7')!;
    expect(applyDraftRegeneration('d7', 'neuer Text')).toBe(true);
    const after = getDraftById('d7')!;
    expect(after.id).toBe('d7');
    expect(after.body).toBe('neuer Text');
    expect(after.previous_body).toBe('alter Text');
    expect(after.previous_body_at).toBe(before.created_at);
    expect(after.regenerated_at).toBeTruthy();
  });

  it('previous_body_at = vorheriges regenerated_at, wenn schon einmal regeneriert', () => {
    createDraft({ id: 'd8', thread_id: 'hostex:t1', provider: 'hostex', body: 'v1', generated_by: 'llm' });
    applyDraftRegeneration('d8', 'v2');
    const afterFirst = getDraftById('d8')!;
    applyDraftRegeneration('d8', 'v3');
    const afterSecond = getDraftById('d8')!;
    expect(afterSecond.previous_body).toBe('v2');
    expect(afterSecond.previous_body_at).toBe(afterFirst.regenerated_at);
  });

  it('Draft nicht mehr pending (z. B. gesendet) → false, nichts überschrieben', () => {
    createDraft({ id: 'd9', thread_id: 'hostex:t1', provider: 'hostex', body: 'gesendeter Text', generated_by: 'llm' });
    db.prepare(`UPDATE message_drafts SET status = 'sent' WHERE id = 'd9'`).run();
    expect(applyDraftRegeneration('d9', 'sollte nicht ankommen')).toBe(false);
    expect(getDraftById('d9')!.body).toBe('gesendeter Text');
  });
});
