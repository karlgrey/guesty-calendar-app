import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PropertyConfig } from '../config/properties.js';

const findExistingSmartTasksTaskIdMock = vi.fn<(threadId: string, guestMessageId: string) => number | null>();
const setSmartTasksTaskMock = vi.fn<(draftId: string, taskId: number, guestMessageId: string | null) => void>();
vi.mock('../repositories/draft-repository.js', () => ({
  findExistingSmartTasksTaskId: (...a: [string, string]) => findExistingSmartTasksTaskIdMock(...a),
  setSmartTasksTask: (...a: [string, number, string | null]) => setSmartTasksTaskMock(...a),
}));

const createTaskMock = vi.fn<(input: unknown) => Promise<{ id: number }>>();
vi.mock('./smarttasks-client.js', () => ({
  getSmartTasksClient: () => ({ createTask: (i: unknown) => createTaskMock(i) }),
}));

const { resolvePromiseTask, buildPromiseTaskTitle, buildPromiseTaskDescription, MICHA_SMARTTASKS_USER_ID } =
  await import('./promise-task-service.js');

const property = { slug: 'u19', shortCode: 'U19', name: 'Uferstrasse 19', smartTasksProjectId: 36 } as PropertyConfig;

const baseInput = {
  draftId: 'd1', threadId: 'guesty:t1', guestMessageId: 'guesty:t1:m1',
  guestName: 'Lorenzo Rossi', guestMessage: 'Thanks! The gate opener note is a bit off though.',
  draftBody: 'Danke dir! Ich kümmere mich darum, dass die Notiz korrigiert wird.',
  promisedAction: 'Micha kümmert sich, dass die Toröffner-Notiz korrigiert wird.',
  property, mode: 'live' as const,
};

beforeEach(() => {
  findExistingSmartTasksTaskIdMock.mockReset().mockReturnValue(null);
  setSmartTasksTaskMock.mockReset();
  createTaskMock.mockReset().mockResolvedValue({ id: 742 });
});

describe('buildPromiseTaskTitle', () => {
  it('Format: Zusage an Gast <Vorname> (<Code>): <promised_action>', () => {
    expect(buildPromiseTaskTitle(baseInput)).toBe(
      'Zusage an Gast Lorenzo (U19): Micha kümmert sich, dass die Toröffner-Notiz korrigiert wird.',
    );
  });
  it('fällt ohne shortCode auf slug zurück', () => {
    expect(buildPromiseTaskTitle({ ...baseInput, property: { ...property, shortCode: undefined } })).toContain('(u19):');
  });
  it('fällt ohne Gastnamen auf "Gast" zurück', () => {
    expect(buildPromiseTaskTitle({ ...baseInput, guestName: null })).toContain('Zusage an Gast Gast (U19)');
  });
});

describe('buildPromiseTaskDescription', () => {
  it('enthält Thread-Link, Zitate, Zusage und Datum', () => {
    const desc = buildPromiseTaskDescription(baseInput);
    expect(desc).toContain('Toröffner-Notiz korrigiert wird');
    expect(desc).toContain('> Thanks! The gate opener note is a bit off though.');
    expect(desc).toContain('> Danke dir! Ich kümmere mich darum, dass die Notiz korrigiert wird.');
    expect(desc).toMatch(/admin\/messages\/guesty%3At1/);
    expect(desc).toMatch(/Datum: \d{4}-\d{2}-\d{2}/);
  });
  it('markiert Schattenmodus zusätzlich', () => {
    expect(buildPromiseTaskDescription({ ...baseInput, mode: 'shadow' })).toContain('Schattenmodus');
  });
  it('kein Schatten-Hinweis im Live-Modus', () => {
    expect(buildPromiseTaskDescription({ ...baseInput, mode: 'live' })).not.toContain('Schattenmodus');
  });
});

describe('resolvePromiseTask', () => {
  it('legt einen neuen Task an, wenn keiner existiert — Felder korrekt gesetzt', async () => {
    const r = await resolvePromiseTask(baseInput);
    expect(r).toEqual({ created: true, taskNumber: 742, reused: false });
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    const call = createTaskMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.title).toBe(buildPromiseTaskTitle(baseInput));
    expect(call.status).toBe('To Do');
    expect(call.assigneeId).toBe(MICHA_SMARTTASKS_USER_ID);
    expect(call.projectId).toBe(36);
    expect(call.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(setSmartTasksTaskMock).toHaveBeenCalledWith('d1', 742, 'guesty:t1:m1');
  });

  it('Idempotenz: findet bestehenden Task für dieselbe Gastnachricht → kein neuer API-Aufruf', async () => {
    findExistingSmartTasksTaskIdMock.mockReturnValue(555);
    const r = await resolvePromiseTask(baseInput);
    expect(r).toEqual({ created: true, taskNumber: 555, reused: true });
    expect(createTaskMock).not.toHaveBeenCalled();
    // Der AKTUELLE Draft bekommt trotzdem die (wiederverwendete) Task-Id gespiegelt, damit
    // /drafts/awaiting und die Admin-UI für DIESEN Draft die Nummer zeigen.
    expect(setSmartTasksTaskMock).toHaveBeenCalledWith('d1', 555, 'guesty:t1:m1');
  });

  it('ohne guestMessageId: kein Idempotenz-Lookup, direkt anlegen', async () => {
    const r = await resolvePromiseTask({ ...baseInput, guestMessageId: null });
    expect(r).toEqual({ created: true, taskNumber: 742, reused: false });
    expect(findExistingSmartTasksTaskIdMock).not.toHaveBeenCalled();
    expect(setSmartTasksTaskMock).toHaveBeenCalledWith('d1', 742, null);
  });

  it('SmartTasks-API-Ausfall → created:false, kein Wurf, kein Crash', async () => {
    createTaskMock.mockRejectedValue(new Error('SmartTasks HTTP 503'));
    const r = await resolvePromiseTask(baseInput);
    expect(r).toEqual({ created: false, taskNumber: null, reused: false });
    expect(setSmartTasksTaskMock).not.toHaveBeenCalled();
  });

  it('getSmartTasksClient() wirft (kein Key konfiguriert) → created:false, kein Crash', async () => {
    createTaskMock.mockImplementation(() => { throw new Error('SMARTTASKS_API_KEY is required'); });
    const r = await resolvePromiseTask(baseInput);
    expect(r.created).toBe(false);
  });
});
