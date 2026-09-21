// src/services/auto-send/policy.test.ts
import { describe, it, expect } from 'vitest';
import { decide, wouldAutoWithPromiseTask, wouldAutoWithBookingTask, type PolicyInput } from './policy.js';
import type { JudgeResult } from './types.js';

const okJudge: JudgeResult = { kind: 'verdict', verdict: { category: 'ankunftszeit', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'r', promisedAction: null } };
const base: PolicyInput = { mode: 'live', paused: false, judge: okJudge, mechanical: [], threadHasHumanIntervention: false, threadHasFailedSend: false, autoSentToday: 0, dailyCap: 10, canSend: true };
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
  it('Vorheriger Versand im Thread fehlgeschlagen/hängt → wait', () => {
    expect(decide({ ...base, threadHasFailedSend: true }).reason).toMatch(/Vorheriger Versand.*fehlgeschlagen/);
  });
  it('Tageslimit erreicht → wait', () => expect(decide({ ...base, autoSentToday: 10 }).reason).toBe('Tageslimit erreicht (10/10)'));
  it('Kanal nicht auflösbar → wait', () => expect(decide({ ...base, canSend: false }).reason).toBe('Kanal unklar — kein Versand möglich'));
  it('shadow verhält sich wie live (Entscheidung, nicht Versand)', () => expect(decide({ ...base, mode: 'shadow' }).decision).toBe('auto'));
  it('Prüfergebnis-Flags landen auch bei wait durch anderen Grund in flags', () => {
    const d = decide({ ...base, judge: withVerdict({ riskFlags: ['tone_off'] }), mechanical: [{ flag: 'email', match: 'a@b.de' }] });
    expect(d.flags).toEqual(['tone_off', 'mech:email']);
  });
});

// #696: Zusagen-Fastlane — promises_action allein blockiert nicht mehr, sondern hängt
// von der (extern erledigten) Task-Anlage ab.
describe('decide: Zusagen-Fastlane (promises_action)', () => {
  const promiseVerdict = withVerdict({ riskFlags: ['promises_action'], promisedAction: 'Micha kümmert sich, dass die Notiz korrigiert wird.' });

  it('promises_action allein + Task angelegt → auto, Reason nennt Task-Nummer', () => {
    const d = decide({ ...base, judge: promiseVerdict, promiseTask: { created: true, taskNumber: 742 } });
    expect(d.decision).toBe('auto');
    expect(d.reason).toBe('Zusage → Task #742');
    expect(d.flags).toContain('promises_action');
  });
  it('promises_action allein + Task-Anlage fehlgeschlagen → wait mit fester Fehlermeldung', () => {
    const d = decide({ ...base, judge: promiseVerdict, promiseTask: { created: false, taskNumber: null } });
    expect(d).toMatchObject({ decision: 'wait', reason: 'Task konnte nicht angelegt werden' });
  });
  it('promises_action allein, promiseTask noch nicht aufgelöst (undefined/null) → wait wie fehlgeschlagen', () => {
    expect(decide({ ...base, judge: promiseVerdict }).reason).toBe('Task konnte nicht angelegt werden');
    expect(decide({ ...base, judge: promiseVerdict, promiseTask: null }).reason).toBe('Task konnte nicht angelegt werden');
  });
  it('Schattenmodus: Reason markiert Schatten zusätzlich zur Task-Nummer', () => {
    const d = decide({ ...base, mode: 'shadow', judge: promiseVerdict, promiseTask: { created: true, taskNumber: 5 } });
    expect(d.decision).toBe('auto');
    expect(d.reason).toBe('Zusage → Task #5 (Schattenmodus)');
  });
  it('promises_action + weiteres Risiko-Flag → normaler Wait-Pfad, keine Fastlane', () => {
    const d = decide({
      ...base,
      judge: withVerdict({ riskFlags: ['promises_action', 'tone_off'], promisedAction: 'x' }),
      promiseTask: { created: true, taskNumber: 1 },
    });
    expect(d.decision).toBe('wait');
    expect(d.reason).toMatch(/Handlung/);
  });
  it('promises_action ohne promisedAction-Text (Judge lieferte keinen Satz) → normaler Wait-Pfad', () => {
    const d = decide({ ...base, judge: withVerdict({ riskFlags: ['promises_action'], promisedAction: null }) });
    expect(d.decision).toBe('wait');
    expect(d.reason).toMatch(/Handlung/);
  });
  it('promises_action in geld-Kategorie bleibt wait (Kategorie-Sperre greift vor der Fastlane), kein Task-Versuch nötig', () => {
    const d = decide({ ...base, judge: withVerdict({ category: 'geld', riskFlags: ['promises_action'], promisedAction: 'x' }) });
    expect(d.decision).toBe('wait');
    expect(d.reason).toBe('Kategorie Geld — nie automatisch');
  });
  it('promises_action + playbook_fakt ohne Faktenbeleg bleibt wait (vor der Fastlane geprüft)', () => {
    const d = decide({ ...base, judge: withVerdict({ category: 'playbook_fakt', answerableFromFacts: false, riskFlags: ['promises_action'], promisedAction: 'x' }) });
    expect(d.reason).toMatch(/nicht eindeutig aus dem Playbook/);
  });
  it('promises_action + Tageslimit erreicht → wait, Fastlane greift nicht (kein Task-Versuch nötig)', () => {
    const d = decide({ ...base, judge: promiseVerdict, autoSentToday: 10 });
    expect(d.reason).toBe('Tageslimit erreicht (10/10)');
  });

  describe('wouldAutoWithPromiseTask (Vorab-Prüfung für den Runner, kein I/O)', () => {
    it('true, wenn alle anderen Gates passen und nur die Zusage fehlt', () => {
      expect(wouldAutoWithPromiseTask({ ...base, judge: promiseVerdict })).toBe(true);
    });
    it('false ohne promises_action', () => {
      expect(wouldAutoWithPromiseTask(base)).toBe(false);
    });
    it('false, wenn ein anderes Gate ohnehin blockiert (z. B. Mensch hat eingegriffen)', () => {
      expect(wouldAutoWithPromiseTask({ ...base, judge: promiseVerdict, threadHasHumanIntervention: true })).toBe(false);
    });
    it('false, wenn Kategorie gesperrt ist', () => {
      expect(wouldAutoWithPromiseTask({ ...base, judge: withVerdict({ category: 'geld', riskFlags: ['promises_action'], promisedAction: 'x' }) })).toBe(false);
    });
    it('false, wenn zusätzliches Risiko-Flag vorliegt', () => {
      expect(wouldAutoWithPromiseTask({ ...base, judge: withVerdict({ riskFlags: ['promises_action', 'tone_off'], promisedAction: 'x' }) })).toBe(false);
    });
  });
});

// #697: eigener, engerer Policy-Zweig für Buchungsanfragen — NIE Teil von AUTO_OK_CATEGORIES,
// promises_action ist hier ein harter Stopp (keine #696-Fastlane), Task wird IMMER verlangt.
describe('decide: Buchungsanfrage-Zweig (#697)', () => {
  const bookingVerdict = withVerdict({ category: 'buchungsanfrage', riskFlags: [] });

  it('alles grün + Task angelegt → auto, Reason nennt Task-Nummer + Frist', () => {
    const d = decide({ ...base, judge: bookingVerdict, bookingTask: { created: true, taskNumber: 701, deadlineLabel: 'Di 22:35' } });
    expect(d.decision).toBe('auto');
    expect(d.category).toBe('buchungsanfrage');
    expect(d.reason).toBe('Buchungsanfrage: Rückfrage automatisch, Airbnb-Entscheidung bei Micha → Task #701, Frist Di 22:35');
  });
  it('ohne deadlineLabel: Reason ohne Frist-Anhang', () => {
    const d = decide({ ...base, judge: bookingVerdict, bookingTask: { created: true, taskNumber: 701, deadlineLabel: null } });
    expect(d.reason).toBe('Buchungsanfrage: Rückfrage automatisch, Airbnb-Entscheidung bei Micha → Task #701');
  });
  it('Task-Anlage fehlgeschlagen → wait mit fester Fehlermeldung', () => {
    const d = decide({ ...base, judge: bookingVerdict, bookingTask: { created: false, taskNumber: null, deadlineLabel: null } });
    expect(d).toMatchObject({ decision: 'wait', reason: 'Task konnte nicht angelegt werden' });
  });
  it('bookingTask noch nicht aufgelöst (undefined/null) → wait wie fehlgeschlagen', () => {
    expect(decide({ ...base, judge: bookingVerdict }).reason).toBe('Task konnte nicht angelegt werden');
    expect(decide({ ...base, judge: bookingVerdict, bookingTask: null }).reason).toBe('Task konnte nicht angelegt werden');
  });
  it('promises_action → harter Stopp, KEINE Fastlane (anders als #696)', () => {
    const d = decide({
      ...base,
      judge: withVerdict({ category: 'buchungsanfrage', riskFlags: ['promises_action'], promisedAction: 'x' }),
      bookingTask: { created: true, taskNumber: 1, deadlineLabel: null },
    });
    expect(d.decision).toBe('wait');
    expect(d.reason).toMatch(/Handlung/);
  });
  it('internal_rule_leak (interne Bedingung an Gast weitergegeben) → wait', () => {
    const d = decide({ ...base, judge: withVerdict({ category: 'buchungsanfrage', riskFlags: ['internal_rule_leak'] }) });
    expect(d.decision).toBe('wait');
    expect(d.reason).toMatch(/interne Prüfbedingung/);
  });
  it('mechanischer Treffer (Bestätigungswort) → wait', () => {
    const d = decide({ ...base, judge: bookingVerdict, mechanical: [{ flag: 'confirmation_words', match: 'bestätigt' }] });
    expect(d.reason).toBe('Mechanischer Check: Bestätigungswort in einer Buchungsanfrage-Rückfrage im Text (bestätigt)');
  });
  it('confidence nicht hoch → wait, kein Task-Versuch nötig', () => {
    expect(decide({ ...base, judge: withVerdict({ category: 'buchungsanfrage', confidence: 'mittel' }) }).reason).toMatch(/Sicherheit/);
  });
  it('Micha hat eingegriffen → wait', () => {
    expect(decide({ ...base, judge: bookingVerdict, threadHasHumanIntervention: true }).reason).toMatch(/schon eingegriffen/);
  });
  it('Tageslimit erreicht → wait', () => {
    expect(decide({ ...base, judge: bookingVerdict, autoSentToday: 10 }).reason).toBe('Tageslimit erreicht (10/10)');
  });
  it('shadow verhält sich wie live (Entscheidung, nicht Versand)', () => {
    const d = decide({ ...base, mode: 'shadow', judge: bookingVerdict, bookingTask: { created: true, taskNumber: 9, deadlineLabel: null } });
    expect(d.decision).toBe('auto');
  });

  describe('wouldAutoWithBookingTask (Vorab-Prüfung, kein I/O)', () => {
    it('true, wenn alle anderen Gates passen und nur der Task fehlt', () => {
      expect(wouldAutoWithBookingTask({ ...base, judge: bookingVerdict })).toBe(true);
    });
    it('false ohne Kategorie buchungsanfrage', () => {
      expect(wouldAutoWithBookingTask(base)).toBe(false);
    });
    it('false bei Risiko-Flag', () => {
      expect(wouldAutoWithBookingTask({ ...base, judge: withVerdict({ category: 'buchungsanfrage', riskFlags: ['promises_action'], promisedAction: 'x' }) })).toBe(false);
    });
    it('false, wenn ein anderes Gate blockiert (Mensch hat eingegriffen)', () => {
      expect(wouldAutoWithBookingTask({ ...base, judge: bookingVerdict, threadHasHumanIntervention: true })).toBe(false);
    });
  });
});
