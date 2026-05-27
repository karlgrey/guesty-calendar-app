/**
 * Conversation thread classifier.
 *
 * Two paths:
 *   1. Status-based shortcut: reservation_status ∈ {confirmed, reserved, active}
 *      → CONFIRMED with confidence 1.0, no LLM call.
 *   2. Otherwise: delegate to Claude via callClaudeTool, validate the structured
 *      response, return { category, confidence, reasoning }.
 *
 * REPEAT and PLAN_CHANGE remain manual-only (no auto rule). The LLM's enum
 * deliberately excludes them in classifier-prompt.ts.
 *
 * Throws on:
 *   - Anthropic API errors (propagated from callClaudeTool)
 *   - Invalid tool-response shape (category outside enum, confidence out of [0,1],
 *     missing reasoning, etc.)
 */

import type { ConversionCategory } from '../types/messages.js';
export type { ConversionCategory };

import { callClaudeTool } from '../services/anthropic-client.js';
import {
  CLASSIFIER_SYSTEM_PROMPT,
  CLASSIFIER_TOOL,
  buildClassifierUserMessage,
  type ClassifierThreadInput,
} from './classifier-prompt.js';

export type ClassifierInput = ClassifierThreadInput;

export interface ClassifierResult {
  category: ConversionCategory;
  confidence: number;
  reasoning: string;
}

const VALID_LLM_CATEGORIES = new Set<ConversionCategory>([
  'SPAM', 'COMMERCIAL', 'PARTY', 'DIRECT_DRIFT', 'PRICE',
  'NO_AVAILABILITY', 'INFO', 'OTHER',
]);

function isConfirmedStatus(status: string | null | undefined): boolean {
  return status === 'confirmed' || status === 'reserved' || status === 'active';
}

export async function classifyThread(
  input: ClassifierInput,
): Promise<ClassifierResult> {
  // 1) Deterministic CONFIRMED shortcut — no API call needed.
  if (isConfirmedStatus(input.reservationStatus)) {
    return {
      category: 'CONFIRMED',
      confidence: 1.0,
      reasoning: 'reservation_status is confirmed/reserved/active',
    };
  }

  // 2) LLM path.
  const raw = await callClaudeTool({
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    userMessage: buildClassifierUserMessage(input),
    tool: CLASSIFIER_TOOL,
  });

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Classifier: LLM tool response was not an object: ${JSON.stringify(raw)}`);
  }
  const obj = raw as Record<string, unknown>;
  const category = obj.category;
  const confidence = obj.confidence;
  const reasoning = obj.reasoning;

  if (typeof category !== 'string' || !VALID_LLM_CATEGORIES.has(category as ConversionCategory)) {
    throw new Error(`Classifier: invalid category from LLM: ${JSON.stringify(category)}`);
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1 || Number.isNaN(confidence)) {
    throw new Error(`Classifier: invalid confidence from LLM: ${JSON.stringify(confidence)}`);
  }
  if (typeof reasoning !== 'string' || reasoning.trim().length === 0) {
    throw new Error(`Classifier: invalid reasoning from LLM: ${JSON.stringify(reasoning)}`);
  }

  return {
    category: category as ConversionCategory,
    confidence,
    reasoning,
  };
}
