import { describe, it, expect, vi } from 'vitest';
import { regenerateStaleDraftIfNeeded, type StaleDraftRegenDeps } from './stale-draft-regen.js';
import type { MessageThread, MessageDraft, Message } from '../types/messages.js';
import type { PropertyConfig } from '../config/properties.js';

// Stale-Draft-Regeneration (#699): GET /admin/messages/:threadId ruft diese Funktion vor dem
// Rendern auf — sie generiert einen zu alten pending-LLM-Entwurf still neu, DERSELBE
// Datensatz (draftId bleibt gleich). Deps komplett gemockt (Muster generate-drafts.test.ts).

const HOUR = 60 * 60 * 1000;

function mkThread(over: Partial<MessageThread> = {}): MessageThread {
  return {
    id: 'guesty:t1', listing_id: 'L1', source: 'guesty', channel: 'airbnb', guest_name: 'Anna', guest_email: null,
    first_message_at: '', last_message_at: '', message_count: 1, reservation_id: null, inquiry_id: null,
    reservation_status: null, conversion_category: null, classification_confidence: null,
    classification_keywords: null, classification_reasoning: null, raw_meta: null, manually_categorized: 0,
    manual_note: null, linked_thread_id: null, last_synced_at: '', ai_no_reply_at: null, discarded_at: null,
    ...over,
  };
}

function mkDraft(over: Partial<MessageDraft> = {}): MessageDraft {
  const oldIso = new Date(Date.now() - 7 * HOUR).toISOString();
  return {
    id: 'd1', thread_id: 'guesty:t1', provider: 'guesty', body: 'alter Text', status: 'pending',
    generated_by: 'llm', send_attempts: 0, external_message_id: null, error: null,
    created_at: oldIso, sent_at: null, model: 'claude-sonnet-5',
    auto_decision: null, auto_category: null, auto_flags: null, auto_reason: null, auto_mode: null,
    auto_judged_at: null, sent_by: null, sent_body_changed: null,
    smarttasks_task_id: null, smarttasks_task_guest_message_id: null,
    request_kind: null, platform_deadline_at: null,
    regenerated_at: null, regen_attempted_at: null, previous_body: null, previous_body_at: null,
    ...over,
  };
}

function mkMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'm1', thread_id: 'guesty:t1', direction: 'inbound', sent_at: new Date(Date.now() - 8 * HOUR).toISOString(),
    from_name: 'Anna', from_address: null, to_address: null, subject: null, body: 'Hallo, alles klar?',
    body_html: null, source: 'guesty', raw_meta: null,
    ...over,
  };
}

const property = { slug: 'farmhouse', provider: 'guesty', guestyPropertyId: 'L1', vaultNote: 'FH.md' } as unknown as PropertyConfig;

function deps(over: Partial<StaleDraftRegenDeps> = {}): StaleDraftRegenDeps {
  return {
    getActiveDraftByThread: vi.fn().mockReturnValue(mkDraft()),
    getMessages: vi.fn().mockReturnValue([mkMessage()]),
    getPropertyForThread: vi.fn().mockReturnValue(property),
    loadVoice: vi.fn().mockReturnValue('VOICE'),
    loadFacts: vi.fn().mockReturnValue('FACTS'),
    buildBookingContext: vi.fn().mockReturnValue(null),
    generate: vi.fn().mockResolvedValue({ kind: 'text', body: 'neuer Text' }),
    claim: vi.fn().mockReturnValue(true),
    apply: vi.fn().mockReturnValue(true),
    gate: vi.fn().mockResolvedValue({ decision: { decision: 'wait', reason: 'x', category: null, flags: [] }, mode: 'shadow', sent: false }),
    staleHours: 6,
    ...over,
  };
}

describe('regenerateStaleDraftIfNeeded', () => {
  // (a) Draft älter als 6h → neuer body, Gate aufgerufen, regenerated
  it('alter Draft (>6h) → generiert neu, wendet an, ruft das Gate auf', async () => {
    const d = deps();
    const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
    expect(res).toEqual({ kind: 'regenerated' });
    expect(d.claim).toHaveBeenCalledWith('d1', 6);
    expect(d.generate).toHaveBeenCalledTimes(1);
    expect(d.apply).toHaveBeenCalledWith('d1', 'neuer Text');
    expect(d.gate).toHaveBeenCalledTimes(1);
    expect((d.gate as any).mock.calls[0][0]).toMatchObject({ draftId: 'd1', body: 'neuer Text' });
  });

  // (b) Draft jünger als 6h → unverändert, weder generate noch gate aufgerufen
  it('junger Draft (<6h) → fresh, weder generate noch claim noch gate', async () => {
    const d = deps({ getActiveDraftByThread: vi.fn().mockReturnValue(mkDraft({ created_at: new Date(Date.now() - 1 * HOUR).toISOString() })) });
    const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
    expect(res).toEqual({ kind: 'fresh' });
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.generate).not.toHaveBeenCalled();
    expect(d.gate).not.toHaveBeenCalled();
  });

  // (c) Generierung wirft/liefert failed → alter Draft unverändert, failed, kein throw
  it('generate liefert "failed" → kind failed, apply/gate nicht aufgerufen, kein throw', async () => {
    const d = deps({ generate: vi.fn().mockResolvedValue({ kind: 'failed', error: 'Tool-Output fehlt' }) });
    const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
    expect(res.kind).toBe('failed');
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.gate).not.toHaveBeenCalled();
  });

  it('generate wirft eine Exception → kind failed, kein throw', async () => {
    const d = deps({ generate: vi.fn().mockRejectedValue(new Error('Anthropic-Timeout')) });
    await expect(regenerateStaleDraftIfNeeded(mkThread(), d)).resolves.toMatchObject({ kind: 'failed' });
  });

  it('generate liefert "no_reply" → kind failed (kein markThreadAiNoReply-Pfad), alter Entwurf bleibt', async () => {
    const d = deps({ generate: vi.fn().mockResolvedValue({ kind: 'no_reply', reason: 'reiner Dank' }) });
    const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
    expect(res.kind).toBe('failed');
    expect(d.apply).not.toHaveBeenCalled();
  });

  it('kein aktiver Entwurf → skipped', async () => {
    const d = deps({ getActiveDraftByThread: vi.fn().mockReturnValue(null) });
    const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
    expect(res.kind).toBe('skipped');
    expect(d.claim).not.toHaveBeenCalled();
  });

  it('manueller Entwurf (generated_by=manual) → skipped', async () => {
    const d = deps({ getActiveDraftByThread: vi.fn().mockReturnValue(mkDraft({ generated_by: 'manual' })) });
    const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
    expect(res.kind).toBe('skipped');
  });

  it('Quelle nicht hostex/guesty → skipped', async () => {
    const d = deps();
    const res = await regenerateStaleDraftIfNeeded(mkThread({ source: 'gmail' as any }), d);
    expect(res.kind).toBe('skipped');
    expect(d.claim).not.toHaveBeenCalled();
  });

  it('kein listing_id → skipped', async () => {
    const d = deps();
    const res = await regenerateStaleDraftIfNeeded(mkThread({ listing_id: null as any }), d);
    expect(res.kind).toBe('skipped');
  });

  it('neue Gastnachricht seit Referenzzeit → skipped, kein claim', async () => {
    const d = deps({ getMessages: vi.fn().mockReturnValue([mkMessage({ sent_at: new Date().toISOString() })]) });
    const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
    expect(res.kind).toBe('skipped');
    expect(d.claim).not.toHaveBeenCalled();
  });

  // Review-Gate #699: in der DB kommt created_at/regenerated_at aus datetime('now') im
  // SQLite-Format "YYYY-MM-DD HH:MM:SS" (ohne "Z"), messages.sent_at dagegen als ISO mit "Z"
  // (Hostex/Guesty createdAt). Der Vergleich "neue Gastnachricht seit Referenzzeit" muss beide
  // Formate als UTC lesen — sonst verschiebt sich die Referenzzeit um den lokalen Offset.
  describe('gemischte Zeitformate (SQLite-UTC vs. ISO)', () => {
    const sqliteUtc = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

    it('Draft created_at im SQLite-Format (7h alt), Gastnachricht ISO 8h alt → regenerated', async () => {
      const d = deps({
        getActiveDraftByThread: vi.fn().mockReturnValue(mkDraft({ created_at: sqliteUtc(Date.now() - 7 * HOUR) })),
        getMessages: vi.fn().mockReturnValue([mkMessage({ sent_at: new Date(Date.now() - 8 * HOUR).toISOString() })]),
      });
      const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
      expect(res).toEqual({ kind: 'regenerated' });
    });

    it('Draft regenerated_at im SQLite-Format (7h alt), Gastnachricht ISO 6h alt (also NACH der Referenzzeit) → skipped', async () => {
      const d = deps({
        getActiveDraftByThread: vi.fn().mockReturnValue(mkDraft({
          created_at: sqliteUtc(Date.now() - 20 * HOUR),
          regenerated_at: sqliteUtc(Date.now() - 7 * HOUR),
        })),
        getMessages: vi.fn().mockReturnValue([mkMessage({ sent_at: new Date(Date.now() - 6 * HOUR).toISOString() })]),
      });
      const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
      expect(res.kind).toBe('skipped');
      expect(d.claim).not.toHaveBeenCalled();
    });

    it('Draft regenerated_at im SQLite-Format erst 2h alt (created_at 20h) → fresh, Referenzzeit ist regenerated_at', async () => {
      const d = deps({
        getActiveDraftByThread: vi.fn().mockReturnValue(mkDraft({
          created_at: sqliteUtc(Date.now() - 20 * HOUR),
          regenerated_at: sqliteUtc(Date.now() - 2 * HOUR),
        })),
      });
      const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
      expect(res).toEqual({ kind: 'fresh' });
      expect(d.claim).not.toHaveBeenCalled();
    });
  });

  it('hängender Live-Auto-Send (auto_decision=auto, auto_mode=live) → skipped, kein claim', async () => {
    const d = deps({ getActiveDraftByThread: vi.fn().mockReturnValue(mkDraft({ auto_decision: 'auto', auto_mode: 'live' })) });
    const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
    expect(res.kind).toBe('skipped');
    expect(d.claim).not.toHaveBeenCalled();
  });

  it('claim liefert false (schon versucht in diesem Fenster) → skipped, kein generate', async () => {
    const d = deps({ claim: vi.fn().mockReturnValue(false) });
    const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
    expect(res.kind).toBe('skipped');
    expect(d.generate).not.toHaveBeenCalled();
  });

  it('kein Vault-Wissen (property/voice/facts fehlt) → failed', async () => {
    const d = deps({ getPropertyForThread: vi.fn().mockReturnValue(undefined) });
    const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
    expect(res.kind).toBe('failed');
    expect(d.generate).not.toHaveBeenCalled();
  });

  it('apply liefert false (Draft inzwischen gesendet/verworfen) → skipped, Gate läuft nicht', async () => {
    const d = deps({ apply: vi.fn().mockReturnValue(false) });
    const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
    expect(res.kind).toBe('skipped');
    expect(d.gate).not.toHaveBeenCalled();
  });

  it('Gate wirft eine Exception → trotzdem "regenerated" (Neugenerierung war schon erfolgreich)', async () => {
    const d = deps({ gate: vi.fn().mockRejectedValue(new Error('Judge down')) });
    const res = await regenerateStaleDraftIfNeeded(mkThread(), d);
    expect(res.kind).toBe('regenerated');
  });
});
