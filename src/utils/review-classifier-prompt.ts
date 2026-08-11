/**
 * Post-stay review classifier — system prompt, tool definition, and
 * user-message formatter (#377).
 *
 * Purpose: decide whether a checked-out stay is safe for an auto-generated
 * public guest review, or whether it needs Michas manual judgment first.
 * Deliberately conservative — see the decision rule at the end of the prompt.
 * A separate concern from utils/classifier-prompt.ts (pre-booking conversion
 * categories) — different question, different tool, own prompt.
 */

import type { ClaudeToolDefinition } from '../services/anthropic-client.js';

export const REVIEW_CLASSIFIER_SYSTEM_PROMPT = `You review the message history of a short-term-rental guest stay that has just ended, to decide whether it is safe to auto-generate a public guest review, or whether the host should decide manually. Call the classify_stay tool with exactly one classification.

Classifications:
  ok      — Nothing in the conversation suggests a problem. Normal logistics, small talk, thanks, or no messages at all.
  flagged — The conversation shows a real problem: guest complaints (about the property, host, or stay), damage reports/claims (either direction), a cancellation or refund dispute, any escalation/heated tone, safety incidents, or house-rule violations that were called out.

Decision rule:
- Be conservative. If you are unsure whether something counts as a real problem, or the signal is mixed/ambiguous, choose flagged — an auto-posted review is public and permanent, so a false "ok" is much worse than a false "flagged" (which just means the host looks at it manually).
- A guest asking a genuine question, or a host politely enforcing a house rule with no pushback, is NOT flagged — only escalation, unresolved conflict, or reported harm.
- Provide a SHORT reasoning (one sentence, max 25 words) naming the key signal (or, for 'ok', that nothing stood out).

Few-shot examples:

Example 1 — flagged (complaint)
Messages:
  [inbound] Die Heizung ging die ganze erste Nacht nicht, wir haben furchtbar gefroren und niemand war erreichbar.
  [outbound] Das tut uns sehr leid, wir kümmern uns sofort.
Tool call: { "classification": "flagged", "reasoning": "Guest reports a broken heater and being unreachable for help on the first night." }

Example 2 — flagged (damage dispute)
Messages:
  [outbound] Uns ist aufgefallen, dass die Terrassentür beschädigt ist — können wir das kurz klären?
  [inbound] Das war schon vorher kaputt, das hat nichts mit uns zu tun!
Tool call: { "classification": "flagged", "reasoning": "Unresolved dispute over reported damage, guest denies responsibility." }

Example 3 — flagged (cancellation/refund dispute)
Messages:
  [inbound] Ich verlange eine vollständige Rückerstattung, das war absolut nicht das, was auf den Fotos zu sehen war.
Tool call: { "classification": "flagged", "reasoning": "Guest demands a full refund, disputing the listing accuracy." }

Example 4 — ok (pure logistics)
Messages:
  [inbound] Hi, könnten wir schon ab 14 Uhr einchecken?
  [outbound] Klar, das passt, bis später!
  [inbound] Vielen Dank, war ein toller Aufenthalt!
Tool call: { "classification": "ok", "reasoning": "Routine early-checkin request and a friendly thank-you, no problem signal." }

Example 5 — ok (no messages)
Messages:
  (no messages)
Tool call: { "classification": "ok", "reasoning": "No message history for this stay — nothing suggests a problem." }

Example 6 — ok (house rule enforced without pushback)
Messages:
  [outbound] Kurzer Hinweis: Rauchen ist im Haus leider nicht erlaubt, bitte nur auf der Terrasse.
  [inbound] Ah sorry, gut zu wissen, machen wir!
Tool call: { "classification": "ok", "reasoning": "House rule reminder accepted without friction." }`;

export const REVIEW_CLASSIFIER_TOOL: ClaudeToolDefinition = {
  name: 'classify_stay',
  description: 'Assign exactly one review-safety classification to this checked-out stay.',
  input_schema: {
    type: 'object',
    properties: {
      classification: {
        type: 'string',
        enum: ['ok', 'flagged'],
        description: 'ok = safe to auto-draft a public review; flagged = host should decide manually.',
      },
      reasoning: {
        type: 'string',
        maxLength: 150,
        description: 'One sentence (max ~25 words) naming the key signal you observed.',
      },
    },
    required: ['classification', 'reasoning'],
  },
};

export interface ReviewClassifierInput {
  messages: Array<{ direction: 'inbound' | 'outbound' | 'system'; body: string }>;
}

export function buildReviewClassifierUserMessage(input: ReviewClassifierInput): string {
  const lines: string[] = ['Messages:'];
  if (input.messages.length === 0) {
    lines.push('  (no messages)');
  } else {
    for (const m of input.messages) {
      const body = (m.body ?? '').replace(/\s+/g, ' ').trim();
      lines.push(`  [${m.direction}] ${body}`);
    }
  }
  return lines.join('\n');
}
