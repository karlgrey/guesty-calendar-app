import { callClaudeTool } from '../anthropic-client.js';
import { config } from '../../config/index.js';
import { JUDGE_DRAFT_TOOL, buildJudgeSystemPrompt } from './judge-prompt.js';
import { JUDGE_CATEGORIES, JUDGE_RISK_FLAGS, type JudgeCategory, type JudgeResult, type JudgeRiskFlag } from './types.js';

export interface JudgeInput {
  guestMessages: string[];      // Gastnachrichten seit der letzten Host-Antwort, chronologisch
  draft: string;
  voice: string;
  facts: string;
  bookingContext: string | null;
  guestName: string | null;
}
export interface JudgeDeps { call: typeof callClaudeTool; model: string }
// deps-Default liest config.judgeModel erst beim tatsächlichen Aufruf (nicht beim Modul-Import) —
// so können Tests { call, model } injizieren, ohne dass config beim Import bereits geladen sein muss.
const defaultDeps = (): JudgeDeps => ({ call: callClaudeTool, model: config.judgeModel });

export function buildJudgeUserMessage(input: JudgeInput): string {
  return [
    `Gast: ${input.guestName ?? 'unbekannt'}`,
    '--- GASTNACHRICHT(EN), chronologisch ---',
    ...input.guestMessages.map((m, i) => `[${i + 1}] ${m}`),
    '--- ENDE GASTNACHRICHT ---',
    '--- ENTWURF (zu prüfen) ---', input.draft, '--- ENDE ENTWURF ---',
  ].join('\n');
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
  const riskFlags = (Array.isArray(o.risk_flags) ? o.risk_flags : []).filter((f): f is JudgeRiskFlag => JUDGE_RISK_FLAGS.includes(f as JudgeRiskFlag));
  return {
    kind: 'verdict',
    verdict: {
      category,
      answerableFromFacts: o.answerable_from_facts,
      riskFlags,
      confidence: o.confidence as 'hoch' | 'mittel' | 'niedrig',
      reasoning: typeof o.reasoning === 'string' ? o.reasoning.trim() : '',
    },
  };
}
