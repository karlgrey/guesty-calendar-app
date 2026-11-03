/**
 * LLM-Alarm — reine Kernlogik (#907).
 *
 * Fällt die Anthropic-API aus oder ist das Guthaben leer, fallen die
 * Gäste-Entwürfe sonst still aus. Der Monitor zählt aufeinanderfolgende
 * alarmrelevante Fehler von `callClaudeTool`; ab `threshold` Fehlern
 * innerhalb von `windowMs` (ohne Erfolg dazwischen) meldet er GENAU EINEN
 * Alarm, beim nächsten Erfolg GENAU EINE Entwarnung. Zustand lebt im
 * Prozessspeicher (ein Neustart beginnt bei null — bei anhaltendem Ausfall
 * folgt nach `threshold` Fehlern ein neuer Alarm).
 *
 * Kein I/O hier — Mail + Log übernimmt `llm-alarm-mail.ts` über `onEvent`.
 */

export interface LlmErrorClassification {
  /** Zählt für den Alarm (Ausfall, Auth, Guthaben, Rate-Limit, Timeout). */
  relevant: boolean;
  /** Fehlertext für Log und Mail (inkl. HTTP-Status, falls vorhanden). */
  text: string;
}

export type LlmAlarmEvent =
  | {
      kind: 'alarm';
      reason: 'consecutive-failures' | 'health-check';
      failureCount: number;
      windowMinutes: number;
      firstFailureAt: string;
      lastFailureAt: string;
      lastError: string;
    }
  | {
      kind: 'all-clear';
      alarmedAt: string;
      recoveredAt: string;
    };

export interface LlmAlarmMonitorOptions {
  threshold: number;
  windowMs: number;
  now?: () => Date;
  onEvent: (event: LlmAlarmEvent) => void;
}

export interface LlmAlarmMonitor {
  recordSuccess(): void;
  recordFailure(err: unknown): void;
  /** Täglicher Health-Check fehlgeschlagen → sofort Alarm (jede Fehlerart). */
  raiseHealthCheckFailure(err: unknown): void;
  getState(): { alarmed: boolean; consecutiveFailures: number };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Alarmrelevant: HTTP 401/402/403/404/429/5xx, 400 mit „credit balance“ bzw.
 * error.type `billing_error` (leeres Guthaben kommt bei Anthropic als 400
 * invalid_request_error „Your credit balance is too low …“), sowie
 * Verbindungsfehler/Timeouts (SDK: APIError ohne Status). 404 = Modell
 * abgekündigt/für die Org nicht verfügbar (not_found_error „model: …“) —
 * die App ruft nur /v1/messages, ein 404 trifft dann jeden Aufruf (Prüfer
 * #907). Nicht relevant: sonstige 4xx (Fehler im Request) und Fehler ohne
 * HTTP-Bezug (Refusal, Token-Limit, ungültiges JSON) — die API hat dort
 * geantwortet.
 */
export function classifyLlmError(err: unknown): LlmErrorClassification {
  const message = errorMessage(err);
  if (!err || typeof err !== 'object') return { relevant: false, text: message };

  const e = err as { status?: unknown; type?: unknown; name?: unknown; constructor?: { name?: string } };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const type = typeof e.type === 'string' ? e.type : undefined;

  if (status !== undefined) {
    const text = `HTTP ${status}${type ? ` ${type}` : ''}: ${message}`;
    const relevant =
      status === 401 ||
      status === 402 ||
      status === 403 ||
      status === 404 ||
      status === 429 ||
      (status >= 500 && status < 600) ||
      type === 'billing_error' ||
      (status === 400 && /credit balance/i.test(message));
    return { relevant, text };
  }

  // SDK: APIConnectionError / APIConnectionTimeoutError (status undefined).
  const className = e.constructor?.name ?? '';
  if (/APIConnection(Timeout)?Error/.test(className) || /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND/i.test(message)) {
    return { relevant: true, text: `${className || 'Verbindungsfehler'}: ${message}` };
  }
  return { relevant: false, text: message };
}

export function createLlmAlarmMonitor(opts: LlmAlarmMonitorOptions): LlmAlarmMonitor {
  const now = opts.now ?? (() => new Date());
  let failures: number[] = [];
  let alarmedAt: Date | null = null;

  function emit(event: LlmAlarmEvent): void {
    try {
      opts.onEvent(event);
    } catch {
      // Melde-Fehler dürfen den LLM-Aufrufpfad nie stören.
    }
  }

  function raise(reason: 'consecutive-failures' | 'health-check', lastError: string, at: Date): void {
    alarmedAt = at;
    emit({
      kind: 'alarm',
      reason,
      failureCount: Math.max(failures.length, 1),
      windowMinutes: Math.round(opts.windowMs / 60_000),
      firstFailureAt: new Date(failures[0] ?? at.getTime()).toISOString(),
      lastFailureAt: at.toISOString(),
      lastError,
    });
  }

  return {
    recordSuccess() {
      failures = [];
      if (alarmedAt) {
        const since = alarmedAt;
        alarmedAt = null;
        emit({ kind: 'all-clear', alarmedAt: since.toISOString(), recoveredAt: now().toISOString() });
      }
    },

    recordFailure(err) {
      const { relevant, text } = classifyLlmError(err);
      if (!relevant) return;
      const at = now();
      failures.push(at.getTime());
      failures = failures.filter((t) => at.getTime() - t <= opts.windowMs);
      if (!alarmedAt && failures.length >= opts.threshold) raise('consecutive-failures', text, at);
    },

    raiseHealthCheckFailure(err) {
      if (alarmedAt) return;
      raise('health-check', classifyLlmError(err).text, now());
    },

    getState() {
      return { alarmed: alarmedAt !== null, consecutiveFailures: failures.length };
    },
  };
}
