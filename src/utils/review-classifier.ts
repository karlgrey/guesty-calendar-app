/**
 * Post-stay review classifier (#377).
 *
 * Decides whether a checked-out stay is safe to auto-draft a public guest
 * review for. No deterministic shortcut here (unlike message-classifier.ts's
 * CONFIRMED status shortcut) — every stay with any message history goes
 * through the LLM; callers skip the call entirely for threadless stays
 * (see generate-review-drafts.ts) and treat that as 'ok' directly.
 */

import { callClaudeTool } from '../services/anthropic-client.js';
import {
  REVIEW_CLASSIFIER_SYSTEM_PROMPT,
  REVIEW_CLASSIFIER_TOOL,
  buildReviewClassifierUserMessage,
  type ReviewClassifierInput,
} from './review-classifier-prompt.js';

export type { ReviewClassifierInput };

export interface ReviewClassifierResult {
  classification: 'ok' | 'flagged';
  reasoning: string;
}

const VALID_CLASSIFICATIONS = new Set(['ok', 'flagged']);

export async function classifyStayForReview(
  input: ReviewClassifierInput,
): Promise<ReviewClassifierResult> {
  const raw = await callClaudeTool({
    systemPrompt: REVIEW_CLASSIFIER_SYSTEM_PROMPT,
    userMessage: buildReviewClassifierUserMessage(input),
    tool: REVIEW_CLASSIFIER_TOOL,
  });

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Review classifier: LLM tool response was not an object: ${JSON.stringify(raw)}`);
  }
  const obj = raw as Record<string, unknown>;
  const classification = obj.classification;
  const reasoning = obj.reasoning;

  if (typeof classification !== 'string' || !VALID_CLASSIFICATIONS.has(classification)) {
    throw new Error(`Review classifier: invalid classification from LLM: ${JSON.stringify(classification)}`);
  }
  if (typeof reasoning !== 'string' || reasoning.trim().length === 0) {
    throw new Error(`Review classifier: invalid reasoning from LLM: ${JSON.stringify(reasoning)}`);
  }

  return { classification: classification as 'ok' | 'flagged', reasoning };
}
