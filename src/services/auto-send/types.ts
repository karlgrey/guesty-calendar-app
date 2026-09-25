// src/services/auto-send/types.ts
//
// Gemeinsame Typen für das Auto-Send-Gate (Spec
// docs/superpowers/specs/2026-09-19-auto-send-gate-design.md).

export type AutoSendMode = 'off' | 'shadow' | 'live';
export const AUTO_SEND_MODES: AutoSendMode[] = ['off', 'shadow', 'live'];

export type JudgeCategory =
  | 'dank_smalltalk' | 'ankunftszeit' | 'playbook_fakt' | 'checkin_standard'
  | 'geld' | 'storno_datum' | 'beschwerde_schaden' | 'sonderwunsch' | 'medizin_sicherheit'
  // #697: Airbnb-Buchungsanfrage (Inquiry/Request-to-Book) — NIE in AUTO_OK_CATEGORIES (die
  // Annahme/Ablehnung entscheidet Micha immer selbst in Airbnb); eigener Policy-Zweig in
  // policy.ts erlaubt unter engen Bedingungen dennoch das automatische Versenden der
  // (reinen Rückfrage-)Antwort, siehe dort.
  | 'buchungsanfrage' | 'unklar';
export const JUDGE_CATEGORIES: JudgeCategory[] = [
  'dank_smalltalk', 'ankunftszeit', 'playbook_fakt', 'checkin_standard',
  'geld', 'storno_datum', 'beschwerde_schaden', 'sonderwunsch', 'medizin_sicherheit',
  'buchungsanfrage', 'unklar',
];
/** Nur diese Kategorien dürfen automatisch raus (Spec 5.3). 'buchungsanfrage' ist bewusst NICHT
 *  dabei — sie hat einen eigenen, engeren Policy-Zweig in decide() (#697). */
export const AUTO_OK_CATEGORIES: ReadonlySet<JudgeCategory> = new Set([
  'dank_smalltalk', 'ankunftszeit', 'playbook_fakt', 'checkin_standard',
]);

export type JudgeRiskFlag =
  | 'invents_fact' | 'promises_action' | 'mentions_code' | 'contradicts_facts'
  | 'tone_off' | 'language_mismatch' | 'multi_topic'
  // #697: Entwurf gibt eine interne Prüfbedingung (z. B. "passt Zweck und Personenzahl", "steht
  // einer Bestätigung nichts im Weg") wörtlich/sinngemäß an den Gast weiter, statt sie nur als
  // Frage zu formulieren — gilt für ALLE Kategorien, nicht nur buchungsanfrage.
  | 'internal_rule_leak';
export const JUDGE_RISK_FLAGS: JudgeRiskFlag[] = [
  'invents_fact', 'promises_action', 'mentions_code', 'contradicts_facts',
  'tone_off', 'language_mismatch', 'multi_topic', 'internal_rule_leak',
];
export type JudgeConfidence = 'hoch' | 'mittel' | 'niedrig';

export interface JudgeVerdict {
  category: JudgeCategory;
  answerableFromFacts: boolean;
  riskFlags: JudgeRiskFlag[];
  confidence: JudgeConfidence;
  reasoning: string;
  /** Ein Satz: was wird dem Gast zugesagt? Nur gesetzt, wenn riskFlags 'promises_action'
   *  enthält UND das Prüfmodell einen Text geliefert hat (#696) — sonst null. */
  promisedAction: string | null;
}
export type JudgeResult =
  | { kind: 'verdict'; verdict: JudgeVerdict }
  | { kind: 'failed'; error: string };

// #695: 'language_mismatch' zusätzlich als MechanicalFlag (eigener Wertebereich, keine Kollision
// mit dem gleichnamigen JudgeRiskFlag oben) — der mechanische Check erkennt Sprachabweichungen
// unabhängig vom Prüfmodell (Spec 2).
export type MechanicalFlag =
  | 'digits' | 'url' | 'email' | 'money' | 'phone' | 'code_words' | 'length' | 'empty'
  | 'language_mismatch'
  // #697: Bestätigungs-/Zusagewort im Entwurf einer Buchungsanfrage (nur relevant, wenn der
  // mechanische Check im Buchungsanfrage-Kontext läuft, siehe mechanical-checks.ts).
  | 'confirmation_words'
  // #698 (Fall Lorenzo U19): Entwurf nennt einen Wochentag (DE/EN), der nicht zum heutigen
  // Berliner Kalendertag bzw. zum Aufenthaltszeitraum passt (nur relevant, wenn der mechanische
  // Check mit `now` läuft, siehe mechanical-checks.ts/today-facts.ts).
  | 'zeitbezug_veraltet';
export interface MechanicalFinding { flag: MechanicalFlag; match: string }

export interface AutoSendDecision {
  decision: 'auto' | 'wait';
  reason: string;               // deutscher Satz für die Ampel (Policy-Text, decide())
  category: JudgeCategory | null;
  flags: string[];              // Modell-Flags + mechanische Flags, z. B. 'mech:url'
  // #702 Punkt 4: reasoning-Feld des Prüfmodells (JudgeVerdict.reasoning), von decide()
  // durchgereicht — null bei technisch fehlgeschlagenem Judge. Optional, damit bestehende
  // handgebaute AutoSendDecision-Literale (Tests, runner.ts-Fehlerpfade) ohne dieses Feld
  // weiterlaufen.
  judgeReasoning?: string | null;
}
