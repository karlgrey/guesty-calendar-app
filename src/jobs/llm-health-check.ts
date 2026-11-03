/**
 * Täglicher LLM-Health-Check (#907): ein Mini-Aufruf über `callClaudeTool`.
 * Erfolg/Entwarnung meldet callClaudeTool selbst an `llmAlarmMonitor`; hier
 * wird nur im Fehlerfall zusätzlich sofort alarmiert (kein Schwellwert).
 * Wirft nie — ein Fehler hier darf den Scheduler nicht stören.
 */

import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { callClaudeTool, type CallClaudeToolInput } from '../services/anthropic-client.js';
import { llmAlarmMonitor } from '../services/llm-alarm-mail.js';

export type LlmHealthCheckResult = 'ok' | 'failed' | 'skipped';

export interface LlmHealthCheckDeps {
  call: (input: CallClaudeToolInput) => Promise<unknown>;
  monitor: { raiseHealthCheckFailure(err: unknown): void };
}

const defaultDeps: LlmHealthCheckDeps = {
  call: callClaudeTool,
  monitor: llmAlarmMonitor,
};

export async function runLlmHealthCheck(deps: LlmHealthCheckDeps = defaultDeps): Promise<LlmHealthCheckResult> {
  if (!config.anthropicApiKey) {
    logger.info('LLM-Health-Check übersprungen (kein ANTHROPIC_API_KEY)');
    return 'skipped';
  }
  try {
    await deps.call({
      systemPrompt: 'Health-Check der Anthropic-Anbindung.',
      userMessage: 'Antworte mit ok=true.',
      maxTokens: 64,
      tool: {
        name: 'health_check',
        description: 'Meldet, dass die API antwortet.',
        input_schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      },
    });
    logger.info('LLM-Health-Check ok');
    return 'ok';
  } catch (error) {
    logger.error({ error }, '❌ LLM-Health-Check fehlgeschlagen');
    try {
      deps.monitor.raiseHealthCheckFailure(error);
    } catch (alarmError) {
      logger.error({ error: alarmError }, '❌ LLM-Alarm beim Health-Check konnte nicht gemeldet werden');
    }
    return 'failed';
  }
}
