// src/services/auto-send/policy.ts
// Schicht 3 des Gates (Spec 5.3): reine Entscheidungsfunktion, kein I/O.
import { AUTO_OK_CATEGORIES, type AutoSendDecision, type AutoSendMode, type JudgeCategory, type JudgeResult, type JudgeRiskFlag, type MechanicalFinding, type MechanicalFlag } from './types.js';

export interface PolicyInput {
  mode: AutoSendMode; paused: boolean; judge: JudgeResult; mechanical: MechanicalFinding[];
  threadHasHumanIntervention: boolean; autoSentToday: number; dailyCap: number; canSend: boolean;
}

const CATEGORY_LABEL: Record<JudgeCategory, string> = {
  dank_smalltalk: 'Dank/Small Talk', ankunftszeit: 'Ankunftszeit', playbook_fakt: 'Playbook-Fakt', checkin_standard: 'Check-in-Standard',
  geld: 'Geld', storno_datum: 'Storno/Datum', beschwerde_schaden: 'Beschwerde/Schaden', sonderwunsch: 'Sonderwunsch',
  medizin_sicherheit: 'Medizin/Sicherheit', unklar: 'Unklar',
};
const RISK_LABEL: Record<JudgeRiskFlag, string> = {
  invents_fact: 'erfundener Fakt', promises_action: 'Zusage einer Handlung', mentions_code: 'Zugangscode erwähnt',
  contradicts_facts: 'Widerspruch zum Playbook', tone_off: 'Ton passt nicht', language_mismatch: 'falsche Sprache', multi_topic: 'mehrere Themen',
};
const MECH_LABEL: Record<MechanicalFlag, string> = {
  digits: 'Ziffernfolge', url: 'Link', email: 'Mail-Adresse', money: 'Geldbetrag', phone: 'Telefonnummer',
  code_words: 'Code-Wort mit Ziffer', length: 'Text zu lang', empty: 'Text leer',
};

export function decide(i: PolicyInput): AutoSendDecision {
  const verdict = i.judge.kind === 'verdict' ? i.judge.verdict : null;
  const flags = [...(verdict?.riskFlags ?? []), ...i.mechanical.map((m) => `mech:${m.flag}`)];
  const category = verdict?.category ?? null;
  const wait = (reason: string): AutoSendDecision => ({ decision: 'wait', reason, category, flags });

  if (i.mode === 'off') return wait('Auto-Send aus (Modus off)');
  if (i.paused) return wait('Auto-Send pausiert');
  if (i.judge.kind === 'failed') return wait(`Prüfung technisch fehlgeschlagen: ${i.judge.error}`);
  const v = i.judge.verdict;
  if (!AUTO_OK_CATEGORIES.has(v.category)) return wait(`Kategorie ${CATEGORY_LABEL[v.category]} — nie automatisch`);
  if (v.category === 'playbook_fakt' && !v.answerableFromFacts) return wait('Antwort nicht eindeutig aus dem Playbook belegt');
  if (v.riskFlags.length) return wait(`Prüfmodell: ${v.riskFlags.map((f) => RISK_LABEL[f]).join(', ')}`);
  if (i.mechanical.length) { const m = i.mechanical[0]; return wait(`Mechanischer Check: ${MECH_LABEL[m.flag]} im Text (${m.match})`); }
  if (v.confidence !== 'hoch') return wait(`Sicherheit des Prüfmodells nur „${v.confidence}"`);
  if (i.threadHasHumanIntervention) return wait('Micha hat in diesem Thread schon eingegriffen');
  if (!i.canSend) return wait('Kanal unklar — kein Versand möglich');
  if (i.autoSentToday >= i.dailyCap) return wait(`Tageslimit erreicht (${i.autoSentToday}/${i.dailyCap})`);
  return { decision: 'auto', reason: `${CATEGORY_LABEL[v.category]}, keine Risiken, Sicherheit hoch`, category, flags };
}
