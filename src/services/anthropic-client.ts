/**
 * Anthropic API client wrapper.
 *
 * Single public function: callClaudeTool — sends a Messages-API request with
 * a cache-controlled system prompt and a single user message and returns the
 * structured object described by `tool.input_schema`. Encapsulates retry with
 * exponential backoff for transient errors (429 / 5xx).
 *
 * Modell-Weiche (#758, Entscheid Micha 06.10.2026, Option A):
 *   - Sonnet 5.5 (`claude-sonnet-5-5`, Default): `thinking: { type: 'between_tools' }`
 *     (Sonnet 5.5 lehnt `disabled` mit 400 ab; between_tools = kein Extended
 *     Thinking, nur bei Effort high oder niedriger — wir setzen kein Effort, Default
 *     high) + Structured Outputs (`output_config.format`) statt erzwungenem
 *     Tool-Aufruf (Sonnet 5.5 lehnt tool_choice tool/any mit 400 ab). Alle
 *     Aufrufer nutzen das Tool nur als JSON-Träger — es wird nie ein Tool
 *     ausgeführt —, darum Structured Outputs statt auto+strict: garantiert
 *     schema-gültiges JSON, kein „Tool-Aufruf im Fließtext"-Fehlerbild.
 *     Antwort ohne gültiges JSON-Objekt → Retry, danach harter Fehler.
 *   - Alle anderen Modelle (z. B. Opus-5-Judge via JUDGE_MODEL): unverändert
 *     `thinking: { type: 'disabled' }` + erzwungener Tool-Aufruf.
 * Harte Regel: Thinking bleibt bei jedem Aufruf so niedrig wie das Modell es
 * zulässt — nie umgehen. Jede Antwort loggt `response.model` (Nachweis).
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import { ConfigError } from '../utils/errors.js';
import logger from '../utils/logger.js';

/** Einziger Ort für die Sonnet-Modell-ID der App (#758). */
export const SONNET_MODEL = 'claude-sonnet-5-5';
const DEFAULT_MODEL = SONNET_MODEL;
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

/**
 * Sonnet 5.5 akzeptiert `thinking: disabled` nicht; die niedrigste Stufe ist
 * `between_tools` — das wiederum akzeptiert ausschließlich Sonnet 5.5.
 */
export function usesBetweenTools(model: string): boolean {
  return model === SONNET_MODEL || model.startsWith(`${SONNET_MODEL}-`);
}

/** Von Structured Outputs nicht unterstützte JSON-Schema-Constraints. */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'minItems', 'maxItems', 'uniqueItems', 'pattern',
]);

/**
 * Macht ein Tool-input_schema Structured-Outputs-tauglich: jedes Objekt bekommt
 * `additionalProperties: false`, nicht unterstützte Constraints fallen weg
 * (die Aufrufer validieren Wertebereiche ohnehin selbst, z. B. confidence ∈ [0,1]).
 * Reine Funktion — das Eingabe-Schema bleibt unverändert.
 */
export function toStructuredOutputSchema(schema: unknown): Record<string, unknown> {
  return convertSchemaNode(schema) as Record<string, unknown>;
}

function convertSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convertSchemaNode);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, convertSchemaNode(v)]),
      );
    } else if (key === 'enum' || key === 'required' || key === 'const') {
      out[key] = value;
    } else {
      out[key] = convertSchemaNode(value);
    }
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

/** Antwort ohne verwertbares JSON-Objekt — transient, wird wiederholt (#758). */
class StructuredOutputError extends Error {
  readonly retryableOutput = true;
}

function isRetryableOutput(err: unknown): boolean {
  return err instanceof StructuredOutputError;
}

function parseStructuredOutput(content: Anthropic.ContentBlock[], toolName: string): Record<string, unknown> {
  const text = content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) {
    throw new StructuredOutputError(
      `Keine JSON-Antwort von Claude für ${toolName} (Blöcke: ${content.map((b) => b.type).join(',') || 'leer'})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StructuredOutputError(`Ungültiges JSON von Claude für ${toolName}: ${text.slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StructuredOutputError(`JSON-Antwort von Claude für ${toolName} ist kein Objekt`);
  }
  return parsed as Record<string, unknown>;
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
  const structured = usesBetweenTools(model);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = structured
        ? await client.messages.create({
            model,
            max_tokens: maxTokens,
            // SDK-Typen kennen between_tools noch nicht (Stand 0.98) — Cast statt SDK-Update.
            thinking: { type: 'between_tools' } as unknown as Anthropic.ThinkingConfigParam,
            system: [
              { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
              {
                type: 'text',
                text:
                  `Antworte ausschließlich mit einem JSON-Objekt nach dem vorgegebenen Schema. ` +
                  `Wo oben vom Tool ${tool.name} (Tool call / Tool-Aufruf) die Rede ist, ist genau dieses JSON-Objekt gemeint.`,
              },
            ],
            output_config: {
              format: { type: 'json_schema', schema: toStructuredOutputSchema(tool.input_schema) },
            },
            messages: [{ role: 'user', content: userMessage }],
          })
        : await client.messages.create({
            model,
            max_tokens: maxTokens,
            thinking: { type: 'disabled' },
            system: [
              { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
            ],
            tools: [tool],
            tool_choice: { type: 'tool', name: tool.name },
            messages: [{ role: 'user', content: userMessage }],
          });
      // Nachweis, welches Modell tatsächlich geantwortet hat (#758).
      logger.info(
        { model: response.model, requestedModel: model, tool: tool.name, stopReason: response.stop_reason },
        'Anthropic response',
      );
      if (response.stop_reason === 'refusal') {
        const category = (response as { stop_details?: { category?: string | null } | null }).stop_details?.category ?? 'unbekannt';
        throw new Error(`Claude hat abgelehnt (stop_reason refusal, Kategorie ${category})`);
      }
      // Am Token-Limit abgeschnittene Antworten liefern verstümmeltes
      // Tool-JSON (z. B. input ohne reply) — das ist ein harter Fehler,
      // kein verwertbarer Output (#379-Nachbefund, Fall Johannes: lange
      // Gastantwort sprengte die 512 Default-Tokens).
      if (response.stop_reason === 'max_tokens') {
        throw new Error(`Antwort am Token-Limit abgeschnitten (max_tokens=${maxTokens}) — Limit für diesen Aufruf erhöhen`);
      }
      if (structured) return parseStructuredOutput(response.content, tool.name);
      const block = response.content.find((b) => b.type === 'tool_use');
      if (!block || block.type !== 'tool_use') {
        throw new Error(
          `Expected a tool_use response block from Claude but got ${response.content.map((b) => b.type).join(',') || 'empty'}`,
        );
      }
      return block.input;
    } catch (err) {
      if (!(isRetryable(err) || isRetryableOutput(err)) || attempt === MAX_RETRIES - 1) throw err;
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
