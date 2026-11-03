/**
 * LLM-Alarm — Melde-Seite (#907): Log-Eintrag + Mail per Resend
 * (`email-service.ts`) und der prozessweite Monitor, an den
 * `callClaudeTool` (anthropic-client.ts) jeden Ausgang meldet.
 *
 * Schwellen: 3 aufeinanderfolgende alarmrelevante Fehler innerhalb von
 * 30 Minuten (Task #907). Empfänger: LLM_ALARM_RECIPIENTS, Fallback
 * CONSISTENCY_ALERT_RECIPIENTS, sonst nur logger.error.
 */

import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { sendEmail } from './email-service.js';
import { createLlmAlarmMonitor, type LlmAlarmEvent } from './llm-alarm.js';

export const APP_NAME = 'guesty-calendar-app';
export const LLM_ALARM_THRESHOLD = 3;
export const LLM_ALARM_WINDOW_MINUTES = 30;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function berlin(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

export function renderLlmAlarmMail(event: LlmAlarmEvent): { subject: string; text: string; html: string } {
  if (event.kind === 'alarm') {
    const cause =
      event.reason === 'health-check'
        ? 'Der tägliche LLM-Health-Check (Mini-Aufruf) ist fehlgeschlagen.'
        : `${event.failureCount} Anthropic-Aufrufe in Folge sind fehlgeschlagen (Schwelle: ${LLM_ALARM_THRESHOLD} innerhalb von ${event.windowMinutes} Minuten).`;
    const lines = [
      `App: ${APP_NAME}`,
      cause,
      `Erster Fehler: ${berlin(event.firstFailureAt)}`,
      `Letzter Fehler: ${berlin(event.lastFailureAt)}`,
      `Fehlertext: ${event.lastError}`,
      '',
      'Folge: KI-Entwürfe für Gäste-Nachrichten, Bewertungen und Vault-Vorschläge fallen aus, bis die API wieder antwortet.',
      'Prüfen: Anthropic-Guthaben/Auto-Reload in der Console, API-Key, status.anthropic.com.',
      'Eine Entwarnung folgt automatisch beim nächsten erfolgreichen Aufruf.',
    ];
    return {
      subject: `[${APP_NAME}] LLM-Alarm: Anthropic-Aufrufe schlagen fehl`,
      text: lines.join('\n'),
      html: `<p>${lines.map((l) => esc(l)).join('<br>')}</p>`,
    };
  }
  const lines = [
    `App: ${APP_NAME}`,
    'Anthropic-Aufrufe funktionieren wieder.',
    `Alarm seit: ${berlin(event.alarmedAt)}`,
    `Wieder ok seit: ${berlin(event.recoveredAt)}`,
  ];
  return {
    subject: `[${APP_NAME}] LLM-Entwarnung: Anthropic antwortet wieder`,
    text: lines.join('\n'),
    html: `<p>${lines.map((l) => esc(l)).join('<br>')}</p>`,
  };
}

export async function handleLlmAlarmEvent(event: LlmAlarmEvent): Promise<void> {
  if (event.kind === 'alarm') {
    logger.error({ app: APP_NAME, ...event }, '🚨 LLM-Alarm: Anthropic-Aufrufe schlagen fehl');
  } else {
    logger.info({ app: APP_NAME, ...event }, '✅ LLM-Entwarnung: Anthropic antwortet wieder');
  }

  const recipients = config.llmAlarmRecipients.length > 0 ? config.llmAlarmRecipients : config.consistencyAlertRecipients;
  if (recipients.length === 0) {
    logger.error(
      { app: APP_NAME, kind: event.kind },
      'LLM-Alarm ohne Empfänger (LLM_ALARM_RECIPIENTS / CONSISTENCY_ALERT_RECIPIENTS leer) — keine Mail',
    );
    return;
  }

  const mail = renderLlmAlarmMail(event);
  try {
    const ok = await sendEmail({ to: recipients, ...mail });
    if (!ok) logger.error({ app: APP_NAME, kind: event.kind }, 'LLM-Alarm-Mail konnte nicht versendet werden');
  } catch (error) {
    logger.error({ app: APP_NAME, kind: event.kind, error }, 'LLM-Alarm-Mail konnte nicht versendet werden');
  }
}

/** Prozessweiter Monitor — einzige Instanz, gespeist von callClaudeTool. */
export const llmAlarmMonitor = createLlmAlarmMonitor({
  threshold: LLM_ALARM_THRESHOLD,
  windowMs: LLM_ALARM_WINDOW_MINUTES * 60_000,
  onEvent: (event) => {
    void handleLlmAlarmEvent(event);
  },
});
