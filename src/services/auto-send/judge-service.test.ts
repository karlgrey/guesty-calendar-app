import { describe, it, expect, vi } from 'vitest';
import { judgeDraft, buildJudgeUserMessage } from './judge-service.js';

const input = { guestMessages: ['Können wir um 13 Uhr kommen?'], draft: 'Ja, 13 Uhr passt.', voice: 'V', facts: 'F', bookingContext: null, guestName: 'Anna' };

describe('judgeDraft', () => {
  it('parst ein gültiges Urteil', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'ankunftszeit', answerable_from_facts: true, risk_flags: [], confidence: 'hoch', reasoning: 'Standardfrage.' });
    const r = await judgeDraft(input, { call, model: 'm' });
    expect(r).toEqual({ kind: 'verdict', verdict: { category: 'ankunftszeit', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'Standardfrage.' } });
    expect(call.mock.calls[0][0].model).toBe('m');
  });
  it('unbekannte Kategorie → failed', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'quatsch', answerable_from_facts: true, risk_flags: [], confidence: 'hoch', reasoning: 'x' });
    expect((await judgeDraft(input, { call, model: 'm' })).kind).toBe('failed');
  });
  it('unbekanntes Flag → failed statt stillschweigend verworfen (Final-Review F4: fail closed)', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'geld', answerable_from_facts: false, risk_flags: ['promises_action', 'wat'], confidence: 'mittel', reasoning: 'x' });
    const r = await judgeDraft(input, { call, model: 'm' });
    expect(r).toEqual({ kind: 'failed', error: 'Unbekanntes Risk-Flag: wat' });
  });
  it('gültige Flag-Liste bleibt unangetastet', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'geld', answerable_from_facts: false, risk_flags: ['promises_action', 'tone_off'], confidence: 'mittel', reasoning: 'x' });
    const r = await judgeDraft(input, { call, model: 'm' });
    expect(r.kind === 'verdict' && r.verdict.riskFlags).toEqual(['promises_action', 'tone_off']);
  });
  it('nicht-string-Element in risk_flags → failed', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'geld', answerable_from_facts: false, risk_flags: [123], confidence: 'mittel', reasoning: 'x' });
    const r = await judgeDraft(input, { call, model: 'm' });
    expect(r).toEqual({ kind: 'failed', error: 'Unbekanntes Risk-Flag: 123' });
  });
  it('fehlende Pflichtfelder → failed', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'geld' });
    expect((await judgeDraft(input, { call, model: 'm' })).kind).toBe('failed');
  });
  it('risk_flags fehlt → failed', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'geld', answerable_from_facts: true, confidence: 'hoch', reasoning: 'x' });
    expect(await judgeDraft(input, { call, model: 'm' })).toEqual({ kind: 'failed', error: 'risk_flags fehlt' });
  });
  it('reasoning fehlt → failed', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'geld', answerable_from_facts: true, risk_flags: [], confidence: 'hoch' });
    expect(await judgeDraft(input, { call, model: 'm' })).toEqual({ kind: 'failed', error: 'reasoning fehlt' });
  });
  it('leeres reasoning → failed', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'geld', answerable_from_facts: true, risk_flags: [], confidence: 'hoch', reasoning: '   ' });
    expect(await judgeDraft(input, { call, model: 'm' })).toEqual({ kind: 'failed', error: 'reasoning fehlt' });
  });
  it('Exception → failed mit Fehlertext', async () => {
    const call = vi.fn().mockRejectedValue(new Error('boom'));
    expect(await judgeDraft(input, { call, model: 'm' })).toEqual({ kind: 'failed', error: 'boom' });
  });
  it('User-Message enthält Gastnachricht und Entwurf getrennt', () => {
    const m = buildJudgeUserMessage(input);
    expect(m).toContain('--- GASTNACHRICHT');
    expect(m).toContain('--- ENTWURF');
    expect(m).toContain('13 Uhr');
  });
});
