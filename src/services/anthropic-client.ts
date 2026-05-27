/**
 * Anthropic API client wrapper.
 *
 * Single public function: callClaudeTool — sends a Messages-API request with
 * a cache-controlled system prompt, a single user message, and a forced
 * tool-choice. Returns the typed tool input on success. Encapsulates retry
 * with exponential backoff for transient errors (429 / 5xx).
 *
 * Used by the conversion classifier; can be reused for other LLM features.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import { ConfigError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 512;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 500;

export interface ClaudeToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface CallClaudeToolInput {
  systemPrompt: string;
  userMessage: string;
  tool: ClaudeToolDefinition;
  model?: string;
  maxTokens?: number;
}

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (cachedClient) return cachedClient;
  if (!config.anthropicApiKey) {
    throw new ConfigError(
      'ANTHROPIC_API_KEY is not set in .env — required for the LLM classifier.',
    );
  }
  cachedClient = new Anthropic({ apiKey: config.anthropicApiKey });
  return cachedClient;
}

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status;
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callClaudeTool({
  systemPrompt,
  userMessage,
  tool,
  model = DEFAULT_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
}: CallClaudeToolInput): Promise<unknown> {
  const client = getClient();
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: userMessage }],
      });
      const block = response.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') {
        throw new Error(
          `Expected a tool_use response block from Claude but got ${response.content.map((b) => b.type).join(',') || 'empty'}`,
        );
      }
      return block.input;
    } catch (err) {
      if (!isRetryable(err) || attempt === MAX_RETRIES - 1) throw err;
      const delay = BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 250);
      logger.warn(
        { attempt: attempt + 1, delay, error: err instanceof Error ? err.message : String(err) },
        'Anthropic call retryable error — backing off',
      );
      await sleep(delay);
    }
  }
  throw new Error('unreachable: retry loop completed without returning or throwing');
}
