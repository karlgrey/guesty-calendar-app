// src/jobs/llm-health-check.test.ts — täglicher LLM-Health-Check (#907)
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const cfg = vi.hoisted(() => ({ anthropicApiKey: 'sk-test' }));
vi.mock('../config/index.js', () => ({ config: cfg }));
vi.mock('../services/anthropic-client.js', () => ({ callClaudeTool: vi.fn() }));
vi.mock('../services/llm-alarm-mail.js', () => ({
  llmAlarmMonitor: { raiseHealthCheckFailure: vi.fn() },
}));

import { runLlmHealthCheck } from './llm-health-check.js';

const call = vi.fn();
const monitor = { raiseHealthCheckFailure: vi.fn() };
const deps = { call, monitor };

beforeEach(() => {
  call.mockReset();
  monitor.raiseHealthCheckFailure.mockReset();
  cfg.anthropicApiKey = 'sk-test';
});

describe('runLlmHealthCheck', () => {
  it('ohne API-Key: skipped, kein Aufruf, kein Alarm', async () => {
    cfg.anthropicApiKey = '';
    expect(await runLlmHealthCheck(deps)).toBe('skipped');
    expect(call).not.toHaveBeenCalled();
    expect(monitor.raiseHealthCheckFailure).not.toHaveBeenCalled();
  });

  it('Erfolg: ok, Mini-Aufruf mit maxTokens 64 und health_check-Tool, kein Alarm', async () => {
    call.mockResolvedValue({ ok: true });
    expect(await runLlmHealthCheck(deps)).toBe('ok');
    expect(call).toHaveBeenCalledTimes(1);
    const input = call.mock.calls[0][0];
    expect(input.maxTokens).toBe(64);
    expect(input.tool.name).toBe('health_check');
    expect(input.tool.input_schema.required).toEqual(['ok']);
    expect(monitor.raiseHealthCheckFailure).not.toHaveBeenCalled();
  });

  it('Fehler: failed + raiseHealthCheckFailure mit dem Fehler', async () => {
    const err = new Error('402 credit balance too low');
    call.mockRejectedValue(err);
    expect(await runLlmHealthCheck(deps)).toBe('failed');
    expect(monitor.raiseHealthCheckFailure).toHaveBeenCalledWith(err);
  });

  it('wirft nie, auch wenn der Monitor selbst wirft', async () => {
    call.mockRejectedValue(new Error('boom'));
    monitor.raiseHealthCheckFailure.mockImplementation(() => {
      throw new Error('mail kaputt');
    });
    await expect(runLlmHealthCheck(deps)).resolves.toBe('failed');
  });
});
