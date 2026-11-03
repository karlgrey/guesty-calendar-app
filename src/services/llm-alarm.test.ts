import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { classifyLlmError, createLlmAlarmMonitor, type LlmAlarmEvent } from './llm-alarm.js';

function apiError(status: number, message: string, type: string | null = null): Error {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type: type ?? 'api_error', message } },
    message,
    new Headers(),
  );
}

function setup(threshold = 3, windowMinutes = 30) {
  let nowMs = Date.parse('2026-11-03T08:00:00Z');
  const events: LlmAlarmEvent[] = [];
  const monitor = createLlmAlarmMonitor({
    threshold,
    windowMs: windowMinutes * 60_000,
    now: () => new Date(nowMs),
    onEvent: (e) => events.push(e),
  });
  return {
    monitor,
    events,
    advance: (minutes: number) => {
      nowMs += minutes * 60_000;
    },
  };
}

describe('classifyLlmError', () => {
  it.each([
    [401, 'authentication_error'],
    [402, 'billing_error'],
    [403, 'permission_error'],
    [429, 'rate_limit_error'],
    [500, 'api_error'],
    [529, 'overloaded_error'],
  ])('HTTP %i (%s) ist alarmrelevant', (status, type) => {
    const c = classifyLlmError(apiError(status, 'boom', type));
    expect(c.relevant).toBe(true);
    expect(c.text).toContain(String(status));
  });

  it('400 „credit balance is too low“ (leeres Guthaben) ist alarmrelevant', () => {
    const c = classifyLlmError(
      apiError(400, 'Your credit balance is too low to access the Anthropic API.', 'invalid_request_error'),
    );
    expect(c.relevant).toBe(true);
    expect(c.text).toContain('credit balance');
  });

  it('gewöhnlicher 400 (fehlerhafter Request) ist NICHT alarmrelevant', () => {
    expect(classifyLlmError(apiError(400, 'max_tokens: invalid', 'invalid_request_error')).relevant).toBe(false);
  });

  it('Timeout und Verbindungsfehler sind alarmrelevant', () => {
    expect(classifyLlmError(new Anthropic.APIConnectionTimeoutError()).relevant).toBe(true);
    expect(classifyLlmError(new Anthropic.APIConnectionError({ message: 'ECONNRESET' })).relevant).toBe(true);
  });

  it('Fehler ohne HTTP-Bezug (Refusal, Token-Limit, Parse) sind NICHT alarmrelevant', () => {
    expect(classifyLlmError(new Error('Claude hat abgelehnt (stop_reason refusal)')).relevant).toBe(false);
    expect(classifyLlmError('irgendwas').relevant).toBe(false);
  });
});

describe('createLlmAlarmMonitor — Fehlerzähler', () => {
  it('alarmiert erst beim n-ten aufeinanderfolgenden Fehler, genau einmal', () => {
    const { monitor, events, advance } = setup(3);
    monitor.recordFailure(apiError(500, 'down'));
    advance(5);
    monitor.recordFailure(apiError(500, 'down'));
    expect(events).toHaveLength(0);
    advance(5);
    monitor.recordFailure(apiError(402, 'billing', 'billing_error'));
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('alarm');
    if (e.kind !== 'alarm') return;
    expect(e.reason).toBe('consecutive-failures');
    expect(e.failureCount).toBe(3);
    expect(e.lastError).toContain('402');
    expect(e.firstFailureAt).toBe('2026-11-03T08:00:00.000Z');

    // weitere Fehler → keine weitere Mail
    monitor.recordFailure(apiError(500, 'down'));
    monitor.recordFailure(apiError(500, 'down'));
    expect(events).toHaveLength(1);
    expect(monitor.getState().alarmed).toBe(true);
  });

  it('ein Erfolg zwischendurch setzt den Zähler zurück (keine Aufeinanderfolge)', () => {
    const { monitor, events } = setup(3);
    monitor.recordFailure(apiError(500, 'down'));
    monitor.recordFailure(apiError(500, 'down'));
    monitor.recordSuccess();
    monitor.recordFailure(apiError(500, 'down'));
    monitor.recordFailure(apiError(500, 'down'));
    expect(events).toHaveLength(0);
    expect(monitor.getState().consecutiveFailures).toBe(2);
  });

  it('Fehler älter als das Zeitfenster zählen nicht mit', () => {
    const { monitor, events, advance } = setup(3, 30);
    monitor.recordFailure(apiError(500, 'down'));
    advance(20);
    monitor.recordFailure(apiError(500, 'down'));
    advance(15); // erster Fehler ist jetzt 35 min alt
    monitor.recordFailure(apiError(500, 'down'));
    expect(events).toHaveLength(0);
    advance(5);
    monitor.recordFailure(apiError(500, 'down'));
    expect(events).toHaveLength(1);
  });

  it('nicht alarmrelevante Fehler zählen nicht und setzen nicht zurück', () => {
    const { monitor, events } = setup(3);
    monitor.recordFailure(apiError(500, 'down'));
    monitor.recordFailure(apiError(400, 'bad request', 'invalid_request_error'));
    monitor.recordFailure(new Error('refusal'));
    monitor.recordFailure(apiError(500, 'down'));
    expect(events).toHaveLength(0);
    expect(monitor.getState().consecutiveFailures).toBe(2);
  });
});

describe('createLlmAlarmMonitor — Entwarnung', () => {
  it('nächster Erfolg nach Alarm löst genau eine Entwarnung aus und setzt zurück', () => {
    const { monitor, events, advance } = setup(2);
    monitor.recordFailure(apiError(529, 'overloaded', 'overloaded_error'));
    monitor.recordFailure(apiError(529, 'overloaded', 'overloaded_error'));
    advance(12);
    monitor.recordSuccess();
    expect(events.map((e) => e.kind)).toEqual(['alarm', 'all-clear']);
    const allClear = events[1];
    if (allClear.kind !== 'all-clear') throw new Error('expected all-clear');
    expect(allClear.alarmedAt).toBe('2026-11-03T08:00:00.000Z');
    expect(allClear.recoveredAt).toBe('2026-11-03T08:12:00.000Z');
    expect(monitor.getState()).toEqual({ alarmed: false, consecutiveFailures: 0 });

    monitor.recordSuccess();
    expect(events).toHaveLength(2);
  });

  it('Erfolg ohne vorherigen Alarm meldet nichts', () => {
    const { monitor, events } = setup(3);
    monitor.recordFailure(apiError(500, 'down'));
    monitor.recordSuccess();
    expect(events).toHaveLength(0);
  });

  it('nach Entwarnung kann erneut alarmiert werden', () => {
    const { monitor, events } = setup(1);
    monitor.recordFailure(apiError(500, 'down'));
    monitor.recordSuccess();
    monitor.recordFailure(apiError(401, 'invalid x-api-key', 'authentication_error'));
    expect(events.map((e) => e.kind)).toEqual(['alarm', 'all-clear', 'alarm']);
  });
});

describe('createLlmAlarmMonitor — Health-Check', () => {
  it('ein fehlgeschlagener Health-Check alarmiert sofort, auch mit nicht-HTTP-Fehler', () => {
    const { monitor, events } = setup(3);
    monitor.raiseHealthCheckFailure(new Error('Keine JSON-Antwort'));
    expect(events).toHaveLength(1);
    const e = events[0];
    if (e.kind !== 'alarm') throw new Error('expected alarm');
    expect(e.reason).toBe('health-check');
    expect(e.lastError).toContain('Keine JSON-Antwort');
  });

  it('kein zweiter Alarm, wenn bereits alarmiert', () => {
    const { monitor, events } = setup(1);
    monitor.recordFailure(apiError(500, 'down'));
    monitor.raiseHealthCheckFailure(apiError(500, 'down'));
    expect(events).toHaveLength(1);
  });

  it('onEvent-Fehler brechen den Monitor nicht', () => {
    const monitor = createLlmAlarmMonitor({
      threshold: 1,
      windowMs: 60_000,
      onEvent: vi.fn(() => {
        throw new Error('mail kaputt');
      }),
    });
    expect(() => monitor.recordFailure(apiError(500, 'down'))).not.toThrow();
    expect(monitor.getState().alarmed).toBe(true);
  });
});
