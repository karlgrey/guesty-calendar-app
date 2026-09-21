// src/services/auto-send/policy.ts
// Schicht 3 des Gates (Spec 5.3): reine Entscheidungsfunktion, kein I/O.
import { AUTO_OK_CATEGORIES, type AutoSendDecision, type AutoSendMode, type JudgeCategory, type JudgeResult, type JudgeRiskFlag, type MechanicalFinding, type MechanicalFlag } from './types.js';

export interface PolicyInput {
  mode: AutoSendMode; paused: boolean; judge: JudgeResult; mechanical: MechanicalFinding[];
  threadHasHumanIntervention: boolean; threadHasFailedSend: boolean; autoSentToday: number; dailyCap: number; canSend: boolean;
  /**
   * Ergebnis der Zusagen-Task-Anlage (#696) — nur relevant, wenn riskFlags GENAU
   * ['promises_action'] ist (isPromiseOnlyRisk()). null/undefined = (noch) nicht
   * versucht; der Runner ruft decide() dafür zuerst mit wouldAutoWithPromiseTask()
   * "trocken" auf (kein I/O), bevor er den SmartTasks-Aufruf überhaupt anstößt.
   */
  promiseTask?: { created: boolean; taskNumber: number | null } | null;
  /**
   * Ergebnis der Buchungsanfrage-Task-Anlage (#697) — nur relevant, wenn die Kategorie
   * 'buchungsanfrage' ist. Anders als promiseTask wird dieser Task für JEDE Buchungsanfrage
   * versucht (nicht nur, wenn der Entwurf sonst automatisch ginge) — Micha braucht ihn auch,
   * wenn die Rückfrage auf 'wait' steht. null/undefined = (noch) nicht versucht/kein
   * Buchungsanfrage-Fall. `deadlineLabel` ist die Berliner Frist ("Di 22:35") für den
   * Reason-Text, oder null, wenn keine Plattform-Frist erkannt wurde.
   */
  bookingTask?: { created: boolean; taskNumber: number | null; deadlineLabel: string | null } | null;
}

const CATEGORY_LABEL: Record<JudgeCategory, string> = {
  dank_smalltalk: 'Dank/Small Talk', ankunftszeit: 'Ankunftszeit', playbook_fakt: 'Playbook-Fakt', checkin_standard: 'Check-in-Standard',
  geld: 'Geld', storno_datum: 'Storno/Datum', beschwerde_schaden: 'Beschwerde/Schaden', sonderwunsch: 'Sonderwunsch',
  medizin_sicherheit: 'Medizin/Sicherheit', buchungsanfrage: 'Buchungsanfrage', unklar: 'Unklar',
};
const RISK_LABEL: Record<JudgeRiskFlag, string> = {
  invents_fact: 'erfundener Fakt', promises_action: 'Zusage einer Handlung', mentions_code: 'Zugangscode erwähnt',
  contradicts_facts: 'Widerspruch zum Playbook', tone_off: 'Ton passt nicht', language_mismatch: 'falsche Sprache',
  multi_topic: 'mehrere Themen', internal_rule_leak: 'interne Prüfbedingung an den Gast weitergegeben', // #697
};
const MECH_LABEL: Record<MechanicalFlag, string> = {
  digits: 'Ziffernfolge', url: 'Link', email: 'Mail-Adresse', money: 'Geldbetrag', phone: 'Telefonnummer',
  code_words: 'Code-Wort mit Ziffer', length: 'Text zu lang', empty: 'Text leer',
  language_mismatch: 'falsche Sprache (mechanisch erkannt)', // #695
  confirmation_words: 'Bestätigungswort in einer Buchungsanfrage-Rückfrage', // #697
};

/**
 * Zusage (#696): riskFlags trägt AUSSCHLIESSLICH 'promises_action' (kein weiteres Risiko)
 * und das Prüfmodell hat einen Zusagen-Text geliefert — nur dann greift die
 * Zusagen-Fastlane statt des generellen Risk-Flag-Waits.
 */
function isPromiseOnlyRisk(v: { riskFlags: JudgeRiskFlag[]; promisedAction: string | null }): boolean {
  return v.riskFlags.length === 1 && v.riskFlags[0] === 'promises_action' && !!v.promisedAction;
}

export function decide(i: PolicyInput): AutoSendDecision {
  const verdict = i.judge.kind === 'verdict' ? i.judge.verdict : null;
  const flags = [...(verdict?.riskFlags ?? []), ...i.mechanical.map((m) => `mech:${m.flag}`)];
  const category = verdict?.category ?? null;
  const wait = (reason: string): AutoSendDecision => ({ decision: 'wait', reason, category, flags });

  if (i.mode === 'off') return wait('Auto-Send aus (Modus off)');
  if (i.paused) return wait('Auto-Send pausiert');
  if (i.judge.kind === 'failed') return wait(`Prüfung technisch fehlgeschlagen: ${i.judge.error}`);
  const v = i.judge.verdict;

  // #697: eigener, engerer Policy-Zweig für Buchungsanfragen — NIE Teil von AUTO_OK_CATEGORIES.
  // Anders als die Zusagen-Fastlane (#696) ist promises_action hier ein HARTER Stopp (keine
  // Ausnahme): jedes Risiko-Flag blockiert. Der Task wird für JEDE Buchungsanfrage versucht
  // (siehe runner.ts) — ohne ihn bleibt es bei 'wait', auch wenn sonst alles grün wäre.
  if (v.category === 'buchungsanfrage') {
    if (v.riskFlags.length) return wait(`Prüfmodell: ${v.riskFlags.map((f) => RISK_LABEL[f]).join(', ')}`);
    if (i.mechanical.length) { const m = i.mechanical[0]; return wait(`Mechanischer Check: ${MECH_LABEL[m.flag]} im Text (${m.match})`); }
    if (v.confidence !== 'hoch') return wait(`Sicherheit des Prüfmodells nur „${v.confidence}"`);
    if (i.threadHasHumanIntervention) return wait('Micha hat in diesem Thread schon eingegriffen');
    if (i.threadHasFailedSend) return wait('Vorheriger Versand in diesem Thread ist fehlgeschlagen — bitte manuell prüfen');
    if (!i.canSend) return wait('Kanal unklar — kein Versand möglich');
    if (i.autoSentToday >= i.dailyCap) return wait(`Tageslimit erreicht (${i.autoSentToday}/${i.dailyCap})`);
    if (!i.bookingTask?.created) return wait('Task konnte nicht angelegt werden');
    const deadlinePart = i.bookingTask.deadlineLabel ? `, Frist ${i.bookingTask.deadlineLabel}` : '';
    return {
      decision: 'auto',
      reason: `Buchungsanfrage: Rückfrage automatisch, Airbnb-Entscheidung bei Micha → Task #${i.bookingTask.taskNumber}${deadlinePart}`,
      category, flags,
    };
  }

  if (!AUTO_OK_CATEGORIES.has(v.category)) return wait(`Kategorie ${CATEGORY_LABEL[v.category]} — nie automatisch`);
  if (v.category === 'playbook_fakt' && !v.answerableFromFacts) return wait('Antwort nicht eindeutig aus dem Playbook belegt');
  const promiseOnly = isPromiseOnlyRisk(v);
  if (v.riskFlags.length && !promiseOnly) return wait(`Prüfmodell: ${v.riskFlags.map((f) => RISK_LABEL[f]).join(', ')}`);
  if (i.mechanical.length) { const m = i.mechanical[0]; return wait(`Mechanischer Check: ${MECH_LABEL[m.flag]} im Text (${m.match})`); }
  if (v.confidence !== 'hoch') return wait(`Sicherheit des Prüfmodells nur „${v.confidence}"`);
  if (i.threadHasHumanIntervention) return wait('Micha hat in diesem Thread schon eingegriffen');
  if (i.threadHasFailedSend) return wait('Vorheriger Versand in diesem Thread ist fehlgeschlagen — bitte manuell prüfen');
  if (!i.canSend) return wait('Kanal unklar — kein Versand möglich');
  if (i.autoSentToday >= i.dailyCap) return wait(`Tageslimit erreicht (${i.autoSentToday}/${i.dailyCap})`);
  if (promiseOnly) {
    if (!i.promiseTask?.created) return wait('Task konnte nicht angelegt werden');
    const shadowMarker = i.mode === 'shadow' ? ' (Schattenmodus)' : '';
    return { decision: 'auto', reason: `Zusage → Task #${i.promiseTask.taskNumber}${shadowMarker}`, category, flags };
  }
  return { decision: 'auto', reason: `${CATEGORY_LABEL[v.category]}, keine Risiken, Sicherheit hoch`, category, flags };
}

/**
 * Pure Vorab-Prüfung für den Runner (kein I/O): würde dieser Entwurf automatisch gehen,
 * WENN die Zusagen-Task-Anlage gelänge? Nur dann lohnt sich der SmartTasks-Aufruf
 * überhaupt — alle anderen Gates (Kategorie, Mechanik, Konfidenz, Thread-Zustand,
 * Tageslimit …) werden dafür schon vorab durchlaufen (dieselbe decide()-Logik, sentinel
 * promiseTask). Gibt false zurück, wenn der Entwurf ohnehin aus einem anderen Grund
 * wartet, oder wenn kein Zusagen-Fall vorliegt.
 */
export function wouldAutoWithPromiseTask(i: Omit<PolicyInput, 'promiseTask'>): boolean {
  const probe = decide({ ...i, promiseTask: { created: true, taskNumber: 0 } });
  return probe.decision === 'auto' && probe.flags.includes('promises_action');
}

/**
 * Pure Vorab-Prüfung (kein I/O, #697): würde dieser Buchungsanfrage-Entwurf automatisch gehen,
 * WENN die Task-Anlage gelänge? Nutzt dasselbe decide()-Verhalten mit einem Sentinel-bookingTask.
 * Anders als wouldAutoWithPromiseTask entscheidet dieser Check NICHT, ob der Task überhaupt
 * versucht wird (das passiert für jede Buchungsanfrage unconditional in runner.ts) — er dient
 * nur Testskripten wie test-judge-fixtures.ts, die decide() ohne echten SmartTasks-Aufruf prüfen.
 */
export function wouldAutoWithBookingTask(i: Omit<PolicyInput, 'bookingTask'>): boolean {
  const probe = decide({ ...i, bookingTask: { created: true, taskNumber: 0, deadlineLabel: null } });
  return probe.decision === 'auto' && probe.category === 'buchungsanfrage';
}
