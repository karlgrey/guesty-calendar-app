import { callClaudeTool } from '../anthropic-client.js';
import { config } from '../../config/index.js';
import { JUDGE_DRAFT_TOOL, buildJudgeSystemPrompt } from './judge-prompt.js';
import { JUDGE_CATEGORIES, JUDGE_RISK_FLAGS, type JudgeCategory, type JudgeResult, type JudgeRiskFlag } from './types.js';
import { LANGUAGE_LABEL, type SupportedLanguage } from '../../utils/language-detect.js';

export interface JudgeInput {
  guestMessages: string[];      // Gastnachrichten seit der letzten Host-Antwort, chronologisch
  draft: string;
  voice: string;
  facts: string;
  bookingContext: string | null;
  guestName: string | null;
  // #695: deterministisch erkannte Sprache der letzten Gastnachricht (language-detect.ts) — als
  // Fakt in den Judge-Kontext, statt language_mismatch allein aus dem Text erraten zu lassen.
  // Optional, damit bestehende Aufrufer/Tests ohne dieses Feld weiterlaufen.
  guestLanguage?: SupportedLanguage;
}
export interface JudgeDeps { call: typeof callClaudeTool; model: string }
// deps-Default liest config.judgeModel erst beim tatsächlichen Aufruf (nicht beim Modul-Import) —
// so können Tests { call, model } injizieren, ohne dass config beim Import bereits geladen sein muss.
const defaultDeps = (): JudgeDeps => ({ call: callClaudeTool, model: config.judgeModel });

export function buildJudgeUserMessage(input: JudgeInput): string {
  const lines = [
    `Gast: ${input.guestName ?? 'unbekannt'}`,
  ];
  // #695: nur anhängen, wenn übergeben — hält die User-Message für Aufrufer ohne guestLanguage
  // unverändert (Rückwärtskompatibilität, z. B. Testfixtures in test-judge-fixtures.ts).
  if (input.guestLanguage) {
    lines.push(`ANTWORTSPRACHE laut deterministischer Erkennung: ${LANGUAGE_LABEL[input.guestLanguage]}`);
  }
  lines.push(
    '--- GASTNACHRICHT(EN), chronologisch ---',
    ...input.guestMessages.map((m, i) => `[${i + 1}] ${m}`),
    '--- ENDE GASTNACHRICHT ---',
    '--- ENTWURF (zu prüfen) ---', input.draft, '--- ENDE ENTWURF ---',
  );
  return lines.join('\n');
}

export async function judgeDraft(input: JudgeInput, deps: JudgeDeps = defaultDeps()): Promise<JudgeResult> {
  let out: unknown;
  try {
    out = await deps.call({
      systemPrompt: buildJudgeSystemPrompt(input.voice, input.facts, input.bookingContext),
      userMessage: buildJudgeUserMessage(input),
      tool: JUDGE_DRAFT_TOOL,
      model: deps.model,
      maxTokens: 600,
    });
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  if (!out || typeof out !== 'object') return { kind: 'failed', error: 'Prüf-Output fehlt oder ist kein Objekt' };
  const o = out as Record<string, unknown>;
  const category = o.category as JudgeCategory;
  if (!JUDGE_CATEGORIES.includes(category)) return { kind: 'failed', error: `Unbekannte Kategorie: ${String(o.category)}` };
  if (typeof o.answerable_from_facts !== 'boolean') return { kind: 'failed', error: 'answerable_from_facts fehlt' };
  if (!['hoch', 'mittel', 'niedrig'].includes(String(o.confidence))) return { kind: 'failed', error: 'confidence fehlt/ungültig' };
  if (!Array.isArray(o.risk_flags)) return { kind: 'failed', error: 'risk_flags fehlt' };
  const reasoning = typeof o.reasoning === 'string' ? o.reasoning.trim() : '';
  if (!reasoning) return { kind: 'failed', error: 'reasoning fehlt' };
  // Final-Review F4: unbekannte/ungültige Flags NICHT stillschweigend verwerfen — ein
  // Urteil, das nur unbekannte Flags trägt, sähe sonst nach dem Filtern risikofrei aus
  // (leeres riskFlags[]), obwohl das Prüfmodell tatsächlich ein Risiko markiert hat.
  // Fail closed statt fail open.
  for (const f of o.risk_flags) {
    if (typeof f !== 'string' || !JUDGE_RISK_FLAGS.includes(f as JudgeRiskFlag)) {
      return { kind: 'failed', error: `Unbekanntes Risk-Flag: ${String(f)}` };
    }
  }
  const riskFlags = o.risk_flags as JudgeRiskFlag[];
  // #696: promised_action ist nur relevant, wenn promises_action gesetzt ist — bei fehlendem/
  // leerem Text bleibt es null (fail-safe: die Zusagen-Fastlane in policy.ts greift dann
  // einfach nicht, der Entwurf fällt auf den normalen Risk-Flag-Wartepfad zurück, statt das
  // ganze Urteil als 'failed' zu verwerfen — anders als bei unbekannten Flags oben ist hier
  // kein Integritätsproblem, nur eine fehlende Zusatzinfo).
  const promisedAction = typeof o.promised_action === 'string' && o.promised_action.trim() ? o.promised_action.trim() : null;
  return {
    kind: 'verdict',
    verdict: {
      category,
      answerableFromFacts: o.answerable_from_facts,
      riskFlags,
      confidence: o.confidence as 'hoch' | 'mittel' | 'niedrig',
      reasoning,
      promisedAction,
    },
  };
}
