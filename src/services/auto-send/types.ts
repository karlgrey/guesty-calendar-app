// src/services/auto-send/types.ts
//
// Gemeinsame Typen für das Auto-Send-Gate (Spec
// docs/superpowers/specs/2026-09-19-auto-send-gate-design.md).

export type AutoSendMode = 'off' | 'shadow' | 'live';
export const AUTO_SEND_MODES: AutoSendMode[] = ['off', 'shadow', 'live'];

export type JudgeCategory =
  | 'dank_smalltalk' | 'ankunftszeit' | 'playbook_fakt' | 'checkin_standard'
  | 'geld' | 'storno_datum' | 'beschwerde_schaden' | 'sonderwunsch' | 'medizin_sicherheit' | 'unklar';
export const JUDGE_CATEGORIES: JudgeCategory[] = [
  'dank_smalltalk', 'ankunftszeit', 'playbook_fakt', 'checkin_standard',
  'geld', 'storno_datum', 'beschwerde_schaden', 'sonderwunsch', 'medizin_sicherheit', 'unklar',
];
/** Nur diese Kategorien dürfen automatisch raus (Spec 5.3). */
export const AUTO_OK_CATEGORIES: ReadonlySet<JudgeCategory> = new Set([
  'dank_smalltalk', 'ankunftszeit', 'playbook_fakt', 'checkin_standard',
]);

export type JudgeRiskFlag =
  | 'invents_fact' | 'promises_action' | 'mentions_code' | 'contradicts_facts'
  | 'tone_off' | 'language_mismatch' | 'multi_topic';
export const JUDGE_RISK_FLAGS: JudgeRiskFlag[] = [
  'invents_fact', 'promises_action', 'mentions_code', 'contradicts_facts',
  'tone_off', 'language_mismatch', 'multi_topic',
];
export type JudgeConfidence = 'hoch' | 'mittel' | 'niedrig';

export interface JudgeVerdict {
  category: JudgeCategory;
  answerableFromFacts: boolean;
  riskFlags: JudgeRiskFlag[];
  confidence: JudgeConfidence;
  reasoning: string;
}
export type JudgeResult =
  | { kind: 'verdict'; verdict: JudgeVerdict }
  | { kind: 'failed'; error: string };

// #695: 'language_mismatch' zusätzlich als MechanicalFlag (eigener Wertebereich, keine Kollision
// mit dem gleichnamigen JudgeRiskFlag oben) — der mechanische Check erkennt Sprachabweichungen
// unabhängig vom Prüfmodell (Spec 2).
export type MechanicalFlag =
  | 'digits' | 'url' | 'email' | 'money' | 'phone' | 'code_words' | 'length' | 'empty'
  | 'language_mismatch';
export interface MechanicalFinding { flag: MechanicalFlag; match: string }

export interface AutoSendDecision {
  decision: 'auto' | 'wait';
  reason: string;               // deutscher Satz für die Ampel
  category: JudgeCategory | null;
  flags: string[];              // Modell-Flags + mechanische Flags, z. B. 'mech:url'
}
