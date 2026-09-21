// src/services/smarttasks-client.ts
//
// Kleiner HTTP-Client für die SmartTasks-API (tasks.remoterepublic.com), Muster
// guesty-client.ts/hostex-client.ts: Bearer-Auth, dünne Fehlerbehandlung, kein
// Retry (Task-Anlage ist keine hochfrequente Operation, ein Fehlversuch darf den
// Versand nicht blockieren — siehe promise-task-service.ts, das den Fehler auffängt).
//
// Kernschutz (#696): der hier verwendete Key darf laut SmartTasks-Auslegung nur Tasks
// anlegen/kommentieren — keine Wiki-/Vault-Rechte. Siehe App-CLAUDE.md „SmartTasks-Client".
import { config } from '../config/index.js';
import { ExternalApiError } from '../utils/errors.js';
import logger, { logApiCall } from '../utils/logger.js';

export interface CreateSmartTaskInput {
  title: string;
  description?: string;
  status?: string;
  assigneeId?: number;
  projectId?: number;
  dueDate?: string; // YYYY-MM-DD
}

export interface SmartTasksTaskRef {
  id: number;
}

const REQUEST_TIMEOUT_MS = 10_000;

export class SmartTasksClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    apiKey: string | undefined = config.smartTasksApiKey,
    baseUrl: string = config.smartTasksApiUrl,
  ) {
    if (!apiKey) {
      throw new Error('SMARTTASKS_API_KEY is required to construct SmartTasksClient');
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * POST /tasks — legt einen Task an und gibt seine Id zurück. Wirft ExternalApiError
   * bei HTTP-Fehlern, Netzwerkfehlern und Timeout (kein automatischer Retry — der
   * Aufrufer entscheidet, wie ein Ausfall zu werten ist).
   */
  async createTask(input: CreateSmartTaskInput): Promise<SmartTasksTaskRef> {
    const path = '/tasks';
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startTime = Date.now();
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'guesty-calendar-app',
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
      } catch (err) {
        // Netzwerkfehler/Timeout (AbortController) — keine HTTP-Response vorhanden,
        // daher kein logApiCall (der braucht einen Statuscode).
        const msg = err instanceof Error ? err.message : String(err);
        const timedOut = err instanceof Error && err.name === 'AbortError';
        logger.warn({ path, err: msg, timedOut }, 'SmartTasks: Aufruf fehlgeschlagen (Netzwerk/Timeout)');
        throw new ExternalApiError(
          `SmartTasks-Aufruf fehlgeschlagen${timedOut ? ' (Timeout)' : ''}: ${msg}`,
          0,
          'SmartTasks',
          { path },
        );
      }
      const duration = Date.now() - startTime;
      logApiCall('SmartTasks', path, response.status, duration);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new ExternalApiError(
          `SmartTasks HTTP ${response.status}: ${text}`,
          response.status,
          'SmartTasks',
          { path },
        );
      }
      const data = (await response.json()) as { id?: unknown };
      if (typeof data.id !== 'number') {
        throw new ExternalApiError('SmartTasks: Antwort ohne Task-Id', response.status, 'SmartTasks', { path });
      }
      return { id: data.id };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Singleton — wirft bei Konstruktion, wenn SMARTTASKS_API_KEY fehlt (Aufrufer müssen
 *  das über try/catch abfangen, siehe promise-task-service.ts). */
let _client: SmartTasksClient | null = null;
export function getSmartTasksClient(): SmartTasksClient {
  if (!_client) _client = new SmartTasksClient();
  return _client;
}

/** Nur für Tests: Singleton zurücksetzen. */
export function resetSmartTasksClient(): void {
  _client = null;
}
