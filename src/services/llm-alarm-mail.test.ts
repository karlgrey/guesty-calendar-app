import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendEmail, mockConfig } = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  mockConfig: { llmAlarmRecipients: [] as string[], consistencyAlertRecipients: [] as string[] },
}));
vi.mock('./email-service.js', () => ({ sendEmail: (...args: unknown[]) => sendEmail(...args) }));

vi.mock('../config/index.js', () => ({ config: mockConfig }));

vi.mock('../utils/logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import logger from '../utils/logger.js';
import { APP_NAME, renderLlmAlarmMail, handleLlmAlarmEvent } from './llm-alarm-mail.js';
import type { LlmAlarmEvent } from './llm-alarm.js';

const alarm: LlmAlarmEvent = {
  kind: 'alarm',
  reason: 'consecutive-failures',
  failureCount: 3,
  windowMinutes: 30,
  firstFailureAt: '2026-11-03T08:00:00.000Z',
  lastFailureAt: '2026-11-03T08:10:00.000Z',
  lastError: 'HTTP 400 invalid_request_error: Your credit balance is too low <x>',
};
const allClear: LlmAlarmEvent = {
  kind: 'all-clear',
  alarmedAt: '2026-11-03T08:10:00.000Z',
  recoveredAt: '2026-11-03T09:00:00.000Z',
};

describe('renderLlmAlarmMail', () => {
  it('Alarm-Mail nennt App-Name und Fehlertext (HTML escaped)', () => {
    const m = renderLlmAlarmMail(alarm);
    expect(APP_NAME).toBe('guesty-calendar-app');
    expect(m.subject).toContain('guesty-calendar-app');
    expect(m.subject).toMatch(/LLM-Alarm/);
    expect(m.text).toContain('guesty-calendar-app');
    expect(m.text).toContain('Your credit balance is too low <x>');
    expect(m.text).toContain('3');
    expect(m.html).toContain('guesty-calendar-app');
    expect(m.html).toContain('Your credit balance is too low &lt;x&gt;');
  });

  it('Health-Check-Alarm ist als solcher erkennbar', () => {
    const m = renderLlmAlarmMail({ ...alarm, reason: 'health-check', failureCount: 1 });
    expect(m.text).toMatch(/Health-Check/);
  });

  it('Entwarnung nennt App-Name', () => {
    const m = renderLlmAlarmMail(allClear);
    expect(m.subject).toContain('guesty-calendar-app');
    expect(m.subject).toMatch(/Entwarnung/);
    expect(m.text).toContain('guesty-calendar-app');
  });
});

describe('handleLlmAlarmEvent', () => {
  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue(true);
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.info).mockClear();
    mockConfig.llmAlarmRecipients = [];
    mockConfig.consistencyAlertRecipients = [];
  });

  it('Alarm: logger.error + Mail an LLM_ALARM_RECIPIENTS', async () => {
    mockConfig.llmAlarmRecipients = ['micha@example.com'];
    await handleLlmAlarmEvent(alarm);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ app: 'guesty-calendar-app', lastError: alarm.lastError }),
      expect.stringContaining('LLM-Alarm'),
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const arg = sendEmail.mock.calls[0][0];
    expect(arg.to).toEqual(['micha@example.com']);
    expect(arg.subject).toMatch(/LLM-Alarm/);
  });

  it('Fallback auf CONSISTENCY_ALERT_RECIPIENTS', async () => {
    mockConfig.consistencyAlertRecipients = ['ops@example.com'];
    await handleLlmAlarmEvent(alarm);
    expect(sendEmail.mock.calls[0][0].to).toEqual(['ops@example.com']);
  });

  it('ohne Empfänger: kein Versand, aber logger.error', async () => {
    await handleLlmAlarmEvent(allClear);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('LLM_ALARM_RECIPIENTS'));
  });

  it('Entwarnung: logger.info + Mail', async () => {
    mockConfig.llmAlarmRecipients = ['micha@example.com'];
    await handleLlmAlarmEvent(allClear);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ app: 'guesty-calendar-app' }), expect.stringContaining('Entwarnung'));
    expect(sendEmail.mock.calls[0][0].subject).toMatch(/Entwarnung/);
  });

  it('Versandfehler wird geloggt, nicht geworfen', async () => {
    mockConfig.llmAlarmRecipients = ['micha@example.com'];
    sendEmail.mockRejectedValueOnce(new Error('resend down'));
    await expect(handleLlmAlarmEvent(alarm)).resolves.toBeUndefined();
  });
});
