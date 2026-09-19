// src/services/auto-send/policy.test.ts
import { describe, it, expect } from 'vitest';
import { decide, type PolicyInput } from './policy.js';
import type { JudgeResult } from './types.js';

const okJudge: JudgeResult = { kind: 'verdict', verdict: { category: 'ankunftszeit', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'r' } };
const base: PolicyInput = { mode: 'live', paused: false, judge: okJudge, mechanical: [], threadHasHumanIntervention: false, autoSentToday: 0, dailyCap: 10, canSend: true };
const withVerdict = (over: Partial<(typeof okJudge)['verdict']>): JudgeResult =>
  ({ kind: 'verdict', verdict: { ...okJudge.verdict, ...over } });

describe('decide', () => {
  it('alles grün → auto', () => {
    const d = decide(base);
    expect(d.decision).toBe('auto');
    expect(d.category).toBe('ankunftszeit');
    expect(d.reason).toMatch(/Ankunftszeit/);
  });
  it('Modus off → wait, kein Gate-Grund', () => expect(decide({ ...base, mode: 'off' })).toMatchObject({ decision: 'wait', reason: 'Auto-Send aus (Modus off)' }));
  it('pausiert → wait', () => expect(decide({ ...base, paused: true }).reason).toBe('Auto-Send pausiert'));
  it('Prüfung technisch fehlgeschlagen → wait mit Fehlertext', () => {
    expect(decide({ ...base, judge: { kind: 'failed', error: 'timeout' } }).reason).toBe('Prüfung technisch fehlgeschlagen: timeout');
  });
  it('Kategorie außerhalb Whitelist → wait', () => {
    expect(decide({ ...base, judge: withVerdict({ category: 'geld' }) }).reason).toBe('Kategorie Geld — nie automatisch');
  });
  it('playbook_fakt ohne Faktenbeleg → wait', () => {
    expect(decide({ ...base, judge: withVerdict({ category: 'playbook_fakt', answerableFromFacts: false }) }).reason).toMatch(/nicht eindeutig aus dem Playbook/);
  });
  it('Risiko-Flag → wait, Flag in flags', () => {
    const d = decide({ ...base, judge: withVerdict({ riskFlags: ['promises_action'] }) });
    expect(d.decision).toBe('wait'); expect(d.flags).toContain('promises_action'); expect(d.reason).toMatch(/Handlung/);
  });
  it('confidence nicht hoch → wait', () => expect(decide({ ...base, judge: withVerdict({ confidence: 'mittel' }) }).reason).toMatch(/Sicherheit/));
  it('mechanischer Treffer → wait mit Fundstelle, Flag mech:*', () => {
    const d = decide({ ...base, mechanical: [{ flag: 'url', match: 'www.x.de' }] });
    expect(d.reason).toBe('Mechanischer Check: Link im Text (www.x.de)'); expect(d.flags).toEqual(['mech:url']);
  });
  it('Micha hat eingegriffen → wait', () => expect(decide({ ...base, threadHasHumanIntervention: true }).reason).toMatch(/schon eingegriffen/));
  it('Tageslimit erreicht → wait', () => expect(decide({ ...base, autoSentToday: 10 }).reason).toBe('Tageslimit erreicht (10/10)'));
  it('Kanal nicht auflösbar → wait', () => expect(decide({ ...base, canSend: false }).reason).toBe('Kanal unklar — kein Versand möglich'));
  it('shadow verhält sich wie live (Entscheidung, nicht Versand)', () => expect(decide({ ...base, mode: 'shadow' }).decision).toBe('auto'));
  it('Prüfergebnis-Flags landen auch bei wait durch anderen Grund in flags', () => {
    const d = decide({ ...base, judge: withVerdict({ riskFlags: ['tone_off'] }), mechanical: [{ flag: 'email', match: 'a@b.de' }] });
    expect(d.flags).toEqual(['tone_off', 'mech:email']);
  });
});
