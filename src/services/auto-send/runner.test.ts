import { describe, it, expect, vi } from 'vitest';
import { runAutoSendGate, type GateDeps, type GateInput } from './runner.js';
import type { MessageThread, Message } from '../../types/messages.js';
import type { PropertyConfig } from '../../config/properties.js';

const thread = { id: 'hostex:t1', source: 'hostex', guest_name: 'Anna', channel: 'airbnb', reservation_status: 'confirmed' } as MessageThread;
const msgs = [{ id: 'm1', direction: 'inbound', body: 'Können wir um 13 Uhr kommen?', sent_at: '2026-09-19T10:00:00Z' }] as Message[];
const property = { slug: 'bootshaus', autoSend: undefined } as PropertyConfig;
const input: GateInput = { draftId: 'd1', body: 'Ja, 13 Uhr passt.', thread, messages: msgs, voice: 'V', facts: 'F', bookingContext: null, property };

const okVerdict = { kind: 'verdict', verdict: { category: 'ankunftszeit', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'r' } } as const;
function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    envMode: 'live', dailyCap: 10,
    judge: vi.fn().mockResolvedValue(okVerdict),
    isPaused: vi.fn().mockReturnValue(false),
    hasHumanIntervention: vi.fn().mockReturnValue(false),
    hasFailedSend: vi.fn().mockReturnValue(false),
    countAutoSentSince: vi.fn().mockReturnValue(0),
    canSend: vi.fn().mockReturnValue(true),
    persistDecision: vi.fn(),
    claim: vi.fn().mockReturnValue(true),
    send: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
}

describe('runAutoSendGate', () => {
  it('live + auto → persistiert und sendet als auto', async () => {
    const d = deps();
    const r = await runAutoSendGate(input, d);
    expect(r).toMatchObject({ decision: { decision: 'auto' }, mode: 'live', sent: true });
    expect(d.persistDecision).toHaveBeenCalledWith('d1', expect.objectContaining({ decision: 'auto' }), 'live');
    expect(d.claim).toHaveBeenCalledWith('d1');
    expect(d.send).toHaveBeenCalledWith('d1', thread, 'Ja, 13 Uhr passt.', 'auto');
  });
  it('shadow + auto → persistiert, sendet NICHT', async () => {
    const d = deps({ envMode: 'shadow' });
    const r = await runAutoSendGate(input, d);
    expect(r.sent).toBe(false); expect(d.send).not.toHaveBeenCalled();
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.persistDecision).toHaveBeenCalledWith('d1', expect.objectContaining({ decision: 'auto' }), 'shadow');
  });
  it('Property-Modus off schlägt Env live', async () => {
    const d = deps();
    const r = await runAutoSendGate({ ...input, property: { slug: 'x', autoSend: 'off' } as PropertyConfig }, d);
    expect(r.mode).toBe('off'); expect(r.decision.decision).toBe('wait'); expect(d.judge).not.toHaveBeenCalled();
    expect(d.persistDecision).not.toHaveBeenCalled();
  });
  it('live + wait → kein Send', async () => {
    const d = deps({ judge: vi.fn().mockResolvedValue({ kind: 'failed', error: 'x' }) });
    const r = await runAutoSendGate(input, d);
    expect(r.decision.decision).toBe('wait'); expect(d.send).not.toHaveBeenCalled();
  });
  it('Thread mit fehlgeschlagenem/hängendem Versand → wait, kein Send (F1)', async () => {
    const d = deps({ hasFailedSend: vi.fn().mockReturnValue(true) });
    const r = await runAutoSendGate(input, d);
    expect(r.decision.decision).toBe('wait');
    expect(r.decision.reason).toMatch(/Vorheriger Versand.*fehlgeschlagen/);
    expect(r.sent).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });
  it('Claim schlägt fehl → nicht gesendet', async () => {
    const d = deps({ claim: vi.fn().mockReturnValue(false) });
    expect((await runAutoSendGate(input, d)).sent).toBe(false);
  });
  it('Send-Fehler → sent=false (Draft steht auf error, Push folgt über awaiting)', async () => {
    const d = deps({ send: vi.fn().mockResolvedValue({ ok: false, err: new Error('down') }) });
    expect((await runAutoSendGate(input, d)).sent).toBe(false);
  });
  it('Prüfmodell bekommt nur Gastnachrichten seit letzter Host-Antwort', async () => {
    const d = deps();
    const messages = [
      { id: '1', direction: 'inbound', body: 'alt', sent_at: '2026-09-18T10:00:00Z' },
      { id: '2', direction: 'outbound', body: 'host', sent_at: '2026-09-18T11:00:00Z' },
      { id: '3', direction: 'inbound', body: 'neu', sent_at: '2026-09-19T10:00:00Z' },
    ] as Message[];
    await runAutoSendGate({ ...input, messages }, d);
    expect((d.judge as any).mock.calls[0][0].guestMessages).toEqual(['neu']);
  });
  it('bekannte Ziffernfolgen aus Gastnachricht + Buchungskontext gelten als Kontext', async () => {
    const d = deps();
    await runAutoSendGate({ ...input, body: 'Bis 2026!', bookingContext: 'Check-in 19.09.2026' }, d);
    expect((d.persistDecision as any).mock.calls[0][1].flags).toEqual([]);
  });
  it('werfende Dep (z. B. DB-Fehler) → wait statt Exception, kein Send', async () => {
    const d = deps({ hasHumanIntervention: vi.fn(() => { throw new Error('db kaputt'); }) });
    const r = await runAutoSendGate(input, d);
    expect(r.sent).toBe(false);
    expect(r.decision.decision).toBe('wait');
    expect(d.persistDecision).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ decision: 'wait', reason: expect.stringContaining('db kaputt') }),
      'live',
    );
    expect(d.send).not.toHaveBeenCalled();
  });
});
