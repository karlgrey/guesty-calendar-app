import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';

// Nur mocken, was GET '/' (Offen + Alle-View) tatsächlich anfasst — der Rest
// des Moduls (Draft-/Sync-/LLM-Services) wird beim Import nicht ausgeführt,
// siehe agent-api.test.ts für dasselbe Muster.
vi.mock('../repositories/message-repository.js', () => ({
  getThreadsNeedingReply: vi.fn().mockReturnValue([
    {
      id: 'hostex:a', listing_id: 'L1', source: 'hostex', channel: 'airbnb',
      guest_name: 'Anna', last_message_at: '2026-08-17 09:00',
      // #976: offene Änderungsantrags-Karte (frisch, sonst verfällt sie nach 7 Tagen)
      raw_meta: JSON.stringify({ pending_alteration: { requestedAt: new Date().toISOString(), describe: null } }),
    },
  ]),
  getThreadById: vi.fn().mockReturnValue(null),
  getMessagesByThread: vi.fn().mockReturnValue([]),
  upsertMessage: vi.fn(),
  getLastMessageSync: vi.fn().mockReturnValue(null),
  markThreadAiNoReply: vi.fn(),
  // Nur für den Modul-Top-Level-Import von generate-drafts.ts nötig (baut dort
  // realDeps auf) — im GET '/'-Pfad selbst nie aufgerufen.
  getThreadsNeedingDraft: vi.fn().mockReturnValue([]),
  getMessagesSince: vi.fn().mockReturnValue([
    {
      id: 'm1', thread_id: 'hostex:a', direction: 'inbound', sent_at: '2026-08-17 09:00',
      body: 'Hallo <script>alert(1)</script> gibt es WLAN?', guest_name: 'Anna',
      source: 'hostex', listing_id: 'L1', channel: 'airbnb',
    },
    {
      id: 'm2', thread_id: 'hostex:a', direction: 'outbound', sent_at: '2026-08-16 18:30',
      body: '   ', guest_name: 'Anna', source: 'hostex', listing_id: 'L1', channel: 'airbnb',
    },
  ]),
}));
vi.mock('../repositories/draft-repository.js', () => ({
  createDraft: vi.fn(),
  getDraftById: vi.fn(),
  getActiveDraftByThread: vi.fn().mockReturnValue(null),
  markDraftSent: vi.fn(),
  markDraftError: vi.fn(),
  discardDraft: vi.fn(),
  claimDraftForSending: vi.fn(),
  updateDraftBody: vi.fn(),
}));
vi.mock('../repositories/feedback-repository.js', () => ({
  createFeedback: vi.fn(),
  createSuggestion: vi.fn(),
  countPendingSuggestions: vi.fn().mockReturnValue(0),
}));
vi.mock('../utils/thread-property.js', () => ({
  getPropertyForThread: vi.fn().mockReturnValue(undefined),
  propertyForBadge: vi.fn((thread: { listing_id: string | null }) =>
    thread.listing_id === 'L1'
      ? { slug: 'farmhouse', name: 'Farmhouse Prasser', shortCode: 'FH', uiColor: '#c75b3c' }
      : undefined,
  ),
}));
// #699: neuer messages.ts-Import — dieser Testfile prüft GET '/' (Offen + Alle-View), nicht
// GET /:threadId, daher komplett gemockt.
vi.mock('../services/stale-draft-regen.js', () => ({
  regenerateStaleDraftIfNeeded: vi.fn().mockResolvedValue({ kind: 'skipped', reason: 'test' }),
}));

import messagesRoutes, { renderAlterationHint } from './messages.js';

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use('/admin/messages', messagesRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

describe('GET /admin/messages (Reiter Offen/Alle)', () => {
  it('Default (kein view-Param) rendert 200 mit der Offen-Liste', async () => {
    const r = await fetch(`${base}/admin/messages`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('thread-list');
    expect(html).toContain('Offen');
    expect(html).toContain('Alle (14 Tage)');
    expect(html).not.toContain('class="feed-list"');
  });

  it('?view=alle liefert 200 und markiert den Alle-Tab aktiv', async () => {
    const r = await fetch(`${base}/admin/messages?view=alle`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('class="feed-list"');
    expect(html).toMatch(/class="tab tab-active"[^>]*>\s*Alle \(14 Tage\)/s);
  });

  it('?view=alle escaped Nachrichten-Snippets (XSS-Schutz)', async () => {
    const r = await fetch(`${base}/admin/messages?view=alle`);
    const html = await r.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('?view=alle zeigt "[ohne Text]" für leere/Whitespace-Bodies', async () => {
    const r = await fetch(`${base}/admin/messages?view=alle`);
    const html = await r.text();
    expect(html).toContain('[ohne Text]');
  });

  it('?view=alle zeigt den Objekt-Kürzel-Badge aus propertyForBadge', async () => {
    const r = await fetch(`${base}/admin/messages?view=alle`);
    const html = await r.text();
    expect(html).toContain('>FH<');
  });

  it('?view=alle verlinkt den Gastnamen auf den Thread', async () => {
    const r = await fetch(`${base}/admin/messages?view=alle`);
    const html = await r.text();
    expect(html).toContain('/admin/messages/hostex%3Aa');
  });
});

// #976: Änderungsantrag — Badge in der Threadliste (nur Plattform-Karte) + Hinweisbox im Detail.
describe('Änderungsantrag (#976)', () => {
  it('Threadliste zeigt das Badge „Änderungsantrag" bei pending_alteration in raw_meta', async () => {
    const r = await fetch(`${base}/admin/messages`);
    expect(await r.text()).toContain('Änderungsantrag');
  });

  it('renderAlterationHint: null → leer', () => {
    expect(renderAlterationHint(null)).toBe('');
  });

  it('renderAlterationHint: pending_request → Admin-Hinweis, HTML-escaped', () => {
    const html = renderAlterationHint({ kind: 'pending_request', requestedAt: '2026-11-01T10:00:00Z', describe: 'Nov 20 <b>3 guests' });
    expect(html).toContain('Änderungsantrag in Airbnb annehmen');
    expect(html).toContain('Nov 20 &lt;b&gt;3 guests');
    expect(html).not.toContain('<b>');
  });

  it('renderAlterationHint: guest_reports_change → Erkennungs-Hinweis', () => {
    const html = renderAlterationHint({ kind: 'guest_reports_change', detail: '4 Personen' });
    expect(html).toContain('Änderungswunsch erkannt (4 Personen)');
  });
});
