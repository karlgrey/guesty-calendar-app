import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PropertyConfig } from '../config/properties.js';

const findExistingSmartTasksTaskIdMock = vi.fn<(threadId: string, systemMessageId: string) => number | null>();
const setSmartTasksTaskMock = vi.fn<(draftId: string, taskId: number, systemMessageId: string | null) => void>();
vi.mock('../repositories/draft-repository.js', () => ({
  findExistingSmartTasksTaskId: (...a: [string, string]) => findExistingSmartTasksTaskIdMock(...a),
  setSmartTasksTask: (...a: [string, number, string | null]) => setSmartTasksTaskMock(...a),
}));

const createTaskMock = vi.fn<(input: unknown) => Promise<{ id: number }>>();
vi.mock('./smarttasks-client.js', () => ({
  getSmartTasksClient: () => ({ createTask: (i: unknown) => createTaskMock(i) }),
}));

const {
  resolveBookingRequestTask, buildBookingTaskTitle, buildBookingTaskDescription,
} = await import('./booking-request-task-service.js');

const property = { slug: 'farmhouse', shortCode: 'FH', name: 'Farmhouse Prasser', smartTasksAirbnbProjectId: 37 } as PropertyConfig;

const baseInput = {
  draftId: 'd1', threadId: 'guesty:t1', systemMessageId: 'guesty:t1:sys1',
  requestKind: 'request_to_book' as const, platformDeadlineAt: '2026-09-22T20:35:04.000Z',
  guestName: 'Anika Beispiel', guestMessage: 'Hallo Michael, ich würde deine Unterkunft gern für ein Event buchen.',
  draftBody: 'Danke dir für die Anfrage! Magst du uns sagen, um welchen Anlass es sich handelt?',
  periodLabel: '29.01.2027–31.01.2027', guestsCount: 15,
  property, mode: 'live' as const,
};

beforeEach(() => {
  findExistingSmartTasksTaskIdMock.mockReset().mockReturnValue(null);
  setSmartTasksTaskMock.mockReset();
  createTaskMock.mockReset().mockResolvedValue({ id: 701 });
});

describe('buildBookingTaskTitle', () => {
  it('Format: Airbnb-Anfrage <Vorname>: <Code> <Zeitraum>, <Personen> P.', () => {
    expect(buildBookingTaskTitle(baseInput)).toBe('Airbnb-Anfrage Anika: FH 29.01.2027–31.01.2027, 15 P.');
  });
  it('ohne periodLabel: Zeitraum entfällt', () => {
    expect(buildBookingTaskTitle({ ...baseInput, periodLabel: null })).toBe('Airbnb-Anfrage Anika: FH, 15 P.');
  });
  it('ohne guestsCount: Personenzahl entfällt', () => {
    expect(buildBookingTaskTitle({ ...baseInput, guestsCount: null })).toBe('Airbnb-Anfrage Anika: FH 29.01.2027–31.01.2027');
  });
  it('ohne beides: nur Code', () => {
    expect(buildBookingTaskTitle({ ...baseInput, periodLabel: null, guestsCount: null })).toBe('Airbnb-Anfrage Anika: FH');
  });
  it('fällt ohne shortCode auf slug zurück', () => {
    expect(buildBookingTaskTitle({ ...baseInput, property: { ...property, shortCode: undefined } })).toContain('farmhouse');
  });
  it('fällt ohne Gastnamen auf "Gast" zurück, nimmt nur den Vornamen', () => {
    expect(buildBookingTaskTitle({ ...baseInput, guestName: null })).toContain('Airbnb-Anfrage Gast:');
    expect(buildBookingTaskTitle(baseInput)).not.toContain('Beispiel');
  });
});

describe('buildBookingTaskDescription', () => {
  it('enthält Anfrage-Art, Frist, Zitate, Thread-Link, Datum', () => {
    const desc = buildBookingTaskDescription(baseInput);
    expect(desc).toContain('Request-to-Book');
    expect(desc).toContain('Di 22:35');
    expect(desc).toContain('> Hallo Michael, ich würde deine Unterkunft gern für ein Event buchen.');
    expect(desc).toContain('> Danke dir für die Anfrage!');
    expect(desc).toMatch(/admin\/messages\/guesty%3At1/);
    expect(desc).toMatch(/Datum: \d{4}-\d{2}-\d{2}/);
    expect(desc).toContain('auch am Wochenende');
  });
  it('markiert Schattenmodus zusätzlich', () => {
    expect(buildBookingTaskDescription({ ...baseInput, mode: 'shadow' })).toContain('Schattenmodus');
  });
  it('kein Schatten-Hinweis im Live-Modus', () => {
    expect(buildBookingTaskDescription({ ...baseInput, mode: 'live' })).not.toContain('Schattenmodus');
  });
  it('Inquiry-Label bei requestKind=inquiry', () => {
    expect(buildBookingTaskDescription({ ...baseInput, requestKind: 'inquiry' })).toContain('Inquiry');
  });
});

describe('resolveBookingRequestTask', () => {
  it('legt einen neuen Task an — Felder korrekt gesetzt, Due = Frist-Kalendertag (auch Wochenende)', async () => {
    const r = await resolveBookingRequestTask(baseInput);
    expect(r).toEqual({ created: true, taskNumber: 701, reused: false });
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    const call = createTaskMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.title).toBe(buildBookingTaskTitle(baseInput));
    expect(call.status).toBe('To Do');
    expect(call.assigneeId).toBe(1);
    expect(call.projectId).toBe(37);
    expect(call.dueDate).toBe('2026-09-22');
    expect(setSmartTasksTaskMock).toHaveBeenCalledWith('d1', 701, 'guesty:t1:sys1');
  });

  it('Idempotenz: findet bestehenden Task für denselben System-Post → kein neuer API-Aufruf', async () => {
    findExistingSmartTasksTaskIdMock.mockReturnValue(555);
    const r = await resolveBookingRequestTask(baseInput);
    expect(r).toEqual({ created: true, taskNumber: 555, reused: true });
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(setSmartTasksTaskMock).toHaveBeenCalledWith('d1', 555, 'guesty:t1:sys1');
  });

  it('SmartTasks-Ausfall → created:false statt Exception', async () => {
    createTaskMock.mockRejectedValue(new Error('down'));
    const r = await resolveBookingRequestTask(baseInput);
    expect(r).toEqual({ created: false, taskNumber: null, reused: false });
  });
});
