import { describe, it, expect, vi } from 'vitest';
import { judgeDraft, buildJudgeUserMessage } from './judge-service.js';

const input = { guestMessages: ['Können wir um 13 Uhr kommen?'], draft: 'Ja, 13 Uhr passt.', voice: 'V', facts: 'F', bookingContext: null, guestName: 'Anna' };

describe('judgeDraft', () => {
  it('parst ein gültiges Urteil', async () => {
    const call = vi.fn().mockResolvedValue({ category: 'ankunftszeit', answerable_from_facts: true, risk_flags: [], confidence: 'hoch', reasoning: 'Standardfrage.' });
    const r = await judgeDraft(input, { call, model: 'm' });
    expect(r).toEqual({ kind: 'verdict', verdict: { category: 'ankunftszeit', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'Standardfrage.', promisedAction: null } });
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

  // #695: die deterministisch erkannte Gastsprache geht als Fakt in den Judge-Kontext, damit
  // das Prüfmodell language_mismatch nicht mehr allein aus dem Gesprächstext erraten muss.
  it('User-Message enthält die erkannte ANTWORTSPRACHE, wenn guestLanguage gesetzt ist', () => {
    const m = buildJudgeUserMessage({ ...input, guestLanguage: 'en' });
    expect(m).toContain('ANTWORTSPRACHE');
    expect(m).toContain('Englisch');
  });
  it('ohne guestLanguage bleibt die User-Message unverändert (Rückwärtskompatibilität)', () => {
    const m = buildJudgeUserMessage(input);
    expect(m).not.toContain('ANTWORTSPRACHE');
  });

  // #696: promised_action — nur relevant, wenn das Modell es liefert.
  it('promises_action + promised_action → promisedAction im Urteil', async () => {
    const call = vi.fn().mockResolvedValue({
      category: 'dank_smalltalk', answerable_from_facts: true, risk_flags: ['promises_action'],
      confidence: 'hoch', reasoning: 'Dank mit Zusage.', promised_action: 'Micha kümmert sich, dass die Toröffner-Notiz korrigiert wird.',
    });
    const r = await judgeDraft(input, { call, model: 'm' });
    expect(r.kind === 'verdict' && r.verdict.promisedAction).toBe('Micha kümmert sich, dass die Toröffner-Notiz korrigiert wird.');
  });
  it('promises_action ohne promised_action-Text → promisedAction bleibt null, kein failed', async () => {
    const call = vi.fn().mockResolvedValue({
      category: 'dank_smalltalk', answerable_from_facts: true, risk_flags: ['promises_action'],
      confidence: 'hoch', reasoning: 'Dank mit Zusage.',
    });
    const r = await judgeDraft(input, { call, model: 'm' });
    expect(r.kind).toBe('verdict');
    expect(r.kind === 'verdict' && r.verdict.promisedAction).toBeNull();
  });
  it('leerer promised_action-String → null statt leerem String', async () => {
    const call = vi.fn().mockResolvedValue({
      category: 'dank_smalltalk', answerable_from_facts: true, risk_flags: ['promises_action'],
      confidence: 'hoch', reasoning: 'x', promised_action: '   ',
    });
    const r = await judgeDraft(input, { call, model: 'm' });
    expect(r.kind === 'verdict' && r.verdict.promisedAction).toBeNull();
  });
  it('ohne promises_action-Flag wird promised_action ignoriert (bleibt null)', async () => {
    const call = vi.fn().mockResolvedValue({
      category: 'ankunftszeit', answerable_from_facts: true, risk_flags: [],
      confidence: 'hoch', reasoning: 'x', promised_action: 'Sollte nicht vorkommen',
    });
    const r = await judgeDraft(input, { call, model: 'm' });
    // Bewusst nicht gefiltert (das Modell könnte es trotzdem liefern) — wird von policy.ts
    // ignoriert, da dort riskFlags auf genau ['promises_action'] geprüft wird.
    expect(r.kind === 'verdict' && r.verdict.promisedAction).toBe('Sollte nicht vorkommen');
  });
});
