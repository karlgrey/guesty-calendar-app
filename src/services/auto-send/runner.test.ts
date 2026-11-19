import { describe, it, expect, vi } from 'vitest';
import { runAutoSendGate, realGateDeps, recentHostMessages, type GateDeps, type GateInput } from './runner.js';
import type { MessageThread, Message } from '../../types/messages.js';
import type { PropertyConfig } from '../../config/properties.js';

// Final-Review F5 — Wiring-Tests für realGateDeps(): mocken NUR das, was realGateDeps
// selbst zusammenschraubt (Config, scheduler_state, Kanalauflösung, Draft-Repo-Passthrough).
// Beeinflusst die übrigen Tests in dieser Datei nicht — die injizieren ihre eigenen GateDeps
// und rufen realGateDeps() nie auf (Default-Parameter wird nur ohne explizite deps ausgewertet).
vi.mock('../../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, config: { ...mod.config, autoSendMode: 'shadow', autoSendDailyCap: 3 } };
});

const getSchedulerStateMock = vi.fn<(key: string) => string | null>(() => null);
vi.mock('../../repositories/scheduler-state-repository.js', () => ({
  getSchedulerState: (...args: [string]) => getSchedulerStateMock(...args),
  setSchedulerState: vi.fn(),
}));

const resolveOutboundModuleTypeMock = vi.fn<(messages: Message[]) => string | null>(() => null);
vi.mock('../guesty-channel.js', () => ({
  resolveOutboundModuleType: (...args: [Message[]]) => resolveOutboundModuleTypeMock(...args),
}));

const countAutoSentSinceMock = vi.fn<(sinceIso: string) => number>(() => 0);
vi.mock('../../repositories/draft-repository.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, countAutoSentSince: (...args: [string]) => countAutoSentSinceMock(...args) };
});

const thread = { id: 'hostex:t1', source: 'hostex', guest_name: 'Anna', channel: 'airbnb', reservation_status: 'confirmed' } as MessageThread;
const msgs = [{ id: 'm1', direction: 'inbound', body: 'Können wir um 13 Uhr kommen?', sent_at: '2026-09-19T10:00:00Z' }] as Message[];
const property = { slug: 'bootshaus', autoSend: undefined } as PropertyConfig;
const input: GateInput = { draftId: 'd1', body: 'Ja, 13 Uhr passt.', thread, messages: msgs, voice: 'V', facts: 'F', bookingContext: null, property };

const okVerdict = { kind: 'verdict', verdict: { category: 'ankunftszeit', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'r', promisedAction: null } } as const;
const promiseVerdict = { kind: 'verdict', verdict: { category: 'dank_smalltalk', answerableFromFacts: true, riskFlags: ['promises_action'], confidence: 'hoch', reasoning: 'r', promisedAction: 'Micha kümmert sich darum.' } } as const;
function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    envMode: 'live', dailyCap: 10,
    judge: vi.fn().mockResolvedValue(okVerdict),
    isPaused: vi.fn().mockReturnValue(false),
    hasHumanIntervention: vi.fn().mockReturnValue(false),
    hasFailedSend: vi.fn().mockReturnValue(false),
    countAutoSentSince: vi.fn().mockReturnValue(0),
    canSend: vi.fn().mockReturnValue(true),
    persistDecision: vi.fn(),
    claim: vi.fn().mockReturnValue(true),
    send: vi.fn().mockResolvedValue({ ok: true }),
    resolvePromiseTask: vi.fn().mockResolvedValue({ created: true, taskNumber: 742, reused: false }),
    resolveBookingRequestTask: vi.fn().mockResolvedValue({ created: true, taskNumber: 701, reused: false }),
    resolveBookingPeriod: vi.fn().mockReturnValue({ periodLabel: null, guestsCount: null }),
    persistBookingRequest: vi.fn(),
    ...over,
  };
}

describe('runAutoSendGate', () => {
  it('live + auto → persistiert und sendet als auto', async () => {
    const d = deps();
    const r = await runAutoSendGate(input, d);
    expect(r).toMatchObject({ decision: { decision: 'auto' }, mode: 'live', sent: true });
    expect(d.persistDecision).toHaveBeenCalledWith('d1', expect.objectContaining({ decision: 'auto' }), 'live');
    expect(d.claim).toHaveBeenCalledWith('d1');
    expect(d.send).toHaveBeenCalledWith('d1', thread, 'Ja, 13 Uhr passt.', 'auto');
  });
  it('shadow + auto → persistiert, sendet NICHT', async () => {
    const d = deps({ envMode: 'shadow' });
    const r = await runAutoSendGate(input, d);
    expect(r.sent).toBe(false); expect(d.send).not.toHaveBeenCalled();
    expect(d.claim).not.toHaveBeenCalled();
    expect(d.persistDecision).toHaveBeenCalledWith('d1', expect.objectContaining({ decision: 'auto' }), 'shadow');
  });
  it('Property-Modus off schlägt Env live', async () => {
    const d = deps();
    const r = await runAutoSendGate({ ...input, property: { slug: 'x', autoSend: 'off' } as PropertyConfig }, d);
    expect(r.mode).toBe('off'); expect(r.decision.decision).toBe('wait'); expect(d.judge).not.toHaveBeenCalled();
    expect(d.persistDecision).not.toHaveBeenCalled();
  });
  it('live + wait → kein Send', async () => {
    const d = deps({ judge: vi.fn().mockResolvedValue({ kind: 'failed', error: 'x' }) });
    const r = await runAutoSendGate(input, d);
    expect(r.decision.decision).toBe('wait'); expect(d.send).not.toHaveBeenCalled();
  });
  it('Thread mit fehlgeschlagenem/hängendem Versand → wait, kein Send (F1)', async () => {
    const d = deps({ hasFailedSend: vi.fn().mockReturnValue(true) });
    const r = await runAutoSendGate(input, d);
    expect(r.decision.decision).toBe('wait');
    expect(r.decision.reason).toMatch(/Vorheriger Versand.*fehlgeschlagen/);
    expect(r.sent).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });
  it('Claim schlägt fehl → nicht gesendet, wait-Entscheidung nachträglich persistiert (F3)', async () => {
    const d = deps({ claim: vi.fn().mockReturnValue(false) });
    const r = await runAutoSendGate(input, d);
    expect(r.sent).toBe(false);
    expect(d.persistDecision).toHaveBeenCalledTimes(2);
    expect(d.persistDecision).toHaveBeenNthCalledWith(1, 'd1', expect.objectContaining({ decision: 'auto' }), 'live');
    expect(d.persistDecision).toHaveBeenNthCalledWith(2, 'd1', expect.objectContaining({
      decision: 'wait', reason: 'Entwurf konnte nicht für den Versand reserviert werden',
    }), 'live');
  });
  it('Send-Fehler → sent=false (Draft steht auf error, Push folgt über awaiting)', async () => {
    const d = deps({ send: vi.fn().mockResolvedValue({ ok: false, err: new Error('down') }) });
    expect((await runAutoSendGate(input, d)).sent).toBe(false);
  });
  it('Prüfmodell bekommt nur Gastnachrichten seit letzter Host-Antwort', async () => {
    const d = deps();
    const messages = [
      { id: '1', direction: 'inbound', body: 'alt', sent_at: '2026-09-18T10:00:00Z' },
      { id: '2', direction: 'outbound', body: 'host', sent_at: '2026-09-18T11:00:00Z' },
      { id: '3', direction: 'inbound', body: 'neu', sent_at: '2026-09-19T10:00:00Z' },
    ] as Message[];
    await runAutoSendGate({ ...input, messages }, d);
    expect((d.judge as any).mock.calls[0][0].guestMessages).toEqual(['neu']);
  });
  it('bekannte Ziffernfolgen aus Gastnachricht + Buchungskontext gelten als Kontext', async () => {
    const d = deps();
    await runAutoSendGate({ ...input, body: 'Bis 2026!', bookingContext: 'Check-in 19.09.2026' }, d);
    expect((d.persistDecision as any).mock.calls[0][1].flags).toEqual([]);
  });
  // #695: guestLanguage geht an Judge UND mechanische Prüfung — ein Entwurf in der falschen
  // Sprache wird auch dann erkannt, wenn das Prüfmodell (Mock) selbst kein Risk-Flag setzt.
  it('gibt guestLanguage an Judge weiter und lässt die mechanische Prüfung Sprachabweichungen erkennen (#695)', async () => {
    const d = deps();
    const r = await runAutoSendGate({ ...input, body: 'Ja, 13 Uhr passt.', guestLanguage: 'en' }, d);
    expect((d.judge as any).mock.calls[0][0].guestLanguage).toBe('en');
    expect(r.decision.decision).toBe('wait');
    expect(r.decision.flags).toContain('mech:language_mismatch');
  });
  it('ohne guestLanguage bleibt das Verhalten unverändert (Rückwärtskompatibilität, #695)', async () => {
    const d = deps();
    const r = await runAutoSendGate(input, d);
    expect((d.judge as any).mock.calls[0][0].guestLanguage).toBeUndefined();
    expect(r.decision.decision).toBe('auto');
  });
  it('attempt 2 markiert die persistierte Entscheidung mit „Neuversuch:“ im Reason (#695 Spec Punkt 3)', async () => {
    const d = deps();
    const r = await runAutoSendGate({ ...input, attempt: 2 }, d);
    expect(r.decision.reason).toMatch(/^Neuversuch: /);
    expect(d.persistDecision).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ reason: expect.stringMatching(/^Neuversuch: /) }),
      'live',
    );
  });
  it('ohne attempt (erster Versuch) bleibt der Reason unpräfixiert (#695)', async () => {
    const d = deps();
    const r = await runAutoSendGate(input, d);
    expect(r.decision.reason).not.toMatch(/^Neuversuch: /);
  });

  it('werfende Dep (z. B. DB-Fehler) → wait statt Exception, kein Send', async () => {
    const d = deps({ hasHumanIntervention: vi.fn(() => { throw new Error('db kaputt'); }) });
    const r = await runAutoSendGate(input, d);
    expect(r.sent).toBe(false);
    expect(r.decision.decision).toBe('wait');
    expect(d.persistDecision).toHaveBeenCalledWith(
      'd1',
      expect.objectContaining({ decision: 'wait', reason: expect.stringContaining('db kaputt') }),
      'live',
    );
    expect(d.send).not.toHaveBeenCalled();
  });
});

// #696: Zusagen-Task-Wiring — resolvePromiseTask wird NUR aufgerufen, wenn der Entwurf
// sonst automatisch ginge, mit den richtigen Feldern, und das Ergebnis geht in die
// Entscheidung ein.
describe('runAutoSendGate: Zusagen-Task (#696)', () => {
  it('promises_action allein (sonst alles grün) → resolvePromiseTask aufgerufen, Ergebnis fließt in decision ein', async () => {
    const resolvePromiseTaskMock = vi.fn().mockResolvedValue({ created: true, taskNumber: 742, reused: false });
    const d = deps({ judge: vi.fn().mockResolvedValue(promiseVerdict), resolvePromiseTask: resolvePromiseTaskMock });
    const r = await runAutoSendGate(input, d);
    expect(r.decision.decision).toBe('auto');
    expect(r.decision.reason).toBe('Zusage → Task #742');
    expect(resolvePromiseTaskMock).toHaveBeenCalledTimes(1);
    const call = resolvePromiseTaskMock.mock.calls[0][0];
    expect(call).toMatchObject({
      draftId: 'd1', threadId: 'hostex:t1', guestMessageId: 'm1',
      guestName: 'Anna', guestMessage: 'Können wir um 13 Uhr kommen?',
      promisedAction: 'Micha kümmert sich darum.', mode: 'live', property,
    });
  });
  it('Task-Anlage schlägt fehl → decision wait mit fester Fehlermeldung, kein Send', async () => {
    const d = deps({
      judge: vi.fn().mockResolvedValue(promiseVerdict),
      resolvePromiseTask: vi.fn().mockResolvedValue({ created: false, taskNumber: null, reused: false }),
    });
    const r = await runAutoSendGate(input, d);
    expect(r.decision).toMatchObject({ decision: 'wait', reason: 'Task konnte nicht angelegt werden' });
    expect(r.sent).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });
  it('Schattenmodus: Task wird trotzdem angelegt, Reason markiert Schatten, nichts wird gesendet', async () => {
    const resolvePromiseTaskMock = vi.fn().mockResolvedValue({ created: true, taskNumber: 5, reused: false });
    const d = deps({ envMode: 'shadow', judge: vi.fn().mockResolvedValue(promiseVerdict), resolvePromiseTask: resolvePromiseTaskMock });
    const r = await runAutoSendGate(input, d);
    expect(resolvePromiseTaskMock).toHaveBeenCalledTimes(1);
    expect(resolvePromiseTaskMock.mock.calls[0][0].mode).toBe('shadow');
    expect(r.decision).toMatchObject({ decision: 'auto', reason: 'Zusage → Task #5 (Schattenmodus)' });
    expect(r.sent).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });
  it('anderes blockierendes Gate (z. B. Micha hat eingegriffen) → resolvePromiseTask wird GAR NICHT erst versucht', async () => {
    const resolvePromiseTaskMock = vi.fn();
    const d = deps({ judge: vi.fn().mockResolvedValue(promiseVerdict), hasHumanIntervention: vi.fn().mockReturnValue(true), resolvePromiseTask: resolvePromiseTaskMock });
    const r = await runAutoSendGate(input, d);
    expect(resolvePromiseTaskMock).not.toHaveBeenCalled();
    expect(r.decision.reason).toMatch(/schon eingegriffen/);
  });
  it('kein promises_action → resolvePromiseTask wird nicht aufgerufen (bestehende Tests unverändert)', async () => {
    const resolvePromiseTaskMock = vi.fn();
    const d = deps({ resolvePromiseTask: resolvePromiseTaskMock });
    await runAutoSendGate(input, d);
    expect(resolvePromiseTaskMock).not.toHaveBeenCalled();
  });
});

// #697: Buchungsanfrage — mechanische Erkennung (Guesty-System-Post), Kategorie-Override,
// Task-Anlage IMMER (nicht nur bei "würde sonst auto gehen"), Frist-Persistenz.
describe('runAutoSendGate: Buchungsanfrage (#697, Fall Anika)', () => {
  const bookingVerdict = { kind: 'verdict', verdict: { category: 'buchungsanfrage', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'r', promisedAction: null } } as const;
  const bookingMessages = [
    { id: 'm1', direction: 'inbound', body: 'Ich würde gern für ein Event buchen.', sent_at: '2026-09-21T20:34:58.000Z' },
    { id: 'm2', direction: 'system', body: 'New guest reservation request HMYYFAMPH8', sent_at: '2026-09-21T20:35:04.000Z' },
  ] as Message[];
  // #702: findOpenBookingRequest gated auf reservation_status — die Basis-Fixture `thread` oben
  // ist 'confirmed' (für andere Tests irrelevant), eine echte offene Buchungsanfrage ist es
  // aber nicht.
  const bookingThread = { ...thread, reservation_status: null } as MessageThread;
  const bookingInput: GateInput = { ...input, thread: bookingThread, body: 'Danke! Magst du uns sagen, um welchen Anlass es geht?', messages: bookingMessages };

  it('System-Post erkannt + alles grün → Task angelegt, Frist persistiert, decision auto mit Task+Frist', async () => {
    const resolveBookingRequestTaskMock = vi.fn().mockResolvedValue({ created: true, taskNumber: 701, reused: false });
    const persistBookingRequestMock = vi.fn();
    const resolveBookingPeriodMock = vi.fn().mockReturnValue({ periodLabel: '29.01.2027–31.01.2027', guestsCount: 15 });
    const d = deps({
      judge: vi.fn().mockResolvedValue(bookingVerdict),
      resolveBookingRequestTask: resolveBookingRequestTaskMock,
      persistBookingRequest: persistBookingRequestMock,
      resolveBookingPeriod: resolveBookingPeriodMock,
    });
    const r = await runAutoSendGate(bookingInput, d);
    expect(r.decision.decision).toBe('auto');
    expect(r.decision.category).toBe('buchungsanfrage');
    expect(r.decision.reason).toBe('Buchungsanfrage: Antwort automatisch, Airbnb-Entscheidung bei Micha → Task #701, Frist Di 22:35');
    expect(persistBookingRequestMock).toHaveBeenCalledWith('d1', 'request_to_book', '2026-09-22T20:35:04.000Z');
    expect(resolveBookingRequestTaskMock).toHaveBeenCalledTimes(1);
    expect(resolveBookingRequestTaskMock.mock.calls[0][0]).toMatchObject({
      draftId: 'd1', threadId: 'hostex:t1', systemMessageId: 'm2', requestKind: 'request_to_book',
      platformDeadlineAt: '2026-09-22T20:35:04.000Z', periodLabel: '29.01.2027–31.01.2027', guestsCount: 15,
    });
  });

  it('Kategorie-Override: Judge klassifiziert anders, System-Post erzwingt buchungsanfrage trotzdem', async () => {
    const d = deps({ judge: vi.fn().mockResolvedValue(okVerdict) /* ankunftszeit */ });
    const r = await runAutoSendGate(bookingInput, d);
    expect(r.decision.category).toBe('buchungsanfrage');
  });

  it('Task-Anlage schlägt fehl → wait mit fester Fehlermeldung, kein Send', async () => {
    const d = deps({
      judge: vi.fn().mockResolvedValue(bookingVerdict),
      resolveBookingRequestTask: vi.fn().mockResolvedValue({ created: false, taskNumber: null, reused: false }),
    });
    const r = await runAutoSendGate(bookingInput, d);
    expect(r.decision).toMatchObject({ decision: 'wait', reason: 'Task konnte nicht angelegt werden' });
    expect(r.sent).toBe(false);
  });

  it('promises_action bei buchungsanfrage ist harter Stopp — KEINE #696-Fastlane', async () => {
    const verdict = { kind: 'verdict', verdict: { category: 'buchungsanfrage', answerableFromFacts: true, riskFlags: ['promises_action'], confidence: 'hoch', reasoning: 'r', promisedAction: 'x' } } as const;
    const resolvePromiseTaskMock = vi.fn();
    const d = deps({ judge: vi.fn().mockResolvedValue(verdict), resolvePromiseTask: resolvePromiseTaskMock });
    const r = await runAutoSendGate(bookingInput, d);
    expect(r.decision.decision).toBe('wait');
    expect(r.decision.reason).toMatch(/Handlung/);
    expect(resolvePromiseTaskMock).not.toHaveBeenCalled();
  });

  it('ohne System-Post: resolveBookingRequestTask/persistBookingRequest werden NICHT aufgerufen (bestehende Tests unverändert)', async () => {
    const resolveBookingRequestTaskMock = vi.fn();
    const persistBookingRequestMock = vi.fn();
    const d = deps({ resolveBookingRequestTask: resolveBookingRequestTaskMock, persistBookingRequest: persistBookingRequestMock });
    await runAutoSendGate(input, d);
    expect(resolveBookingRequestTaskMock).not.toHaveBeenCalled();
    expect(persistBookingRequestMock).not.toHaveBeenCalled();
  });

  it('Schattenmodus: Task wird trotzdem angelegt, decision auto, nichts wird gesendet', async () => {
    const resolveBookingRequestTaskMock = vi.fn().mockResolvedValue({ created: true, taskNumber: 701, reused: false });
    const d = deps({ envMode: 'shadow', judge: vi.fn().mockResolvedValue(bookingVerdict), resolveBookingRequestTask: resolveBookingRequestTaskMock });
    const r = await runAutoSendGate(bookingInput, d);
    expect(r.decision.decision).toBe('auto');
    expect(r.sent).toBe(false);
    expect(resolveBookingRequestTaskMock).toHaveBeenCalledTimes(1);
  });

  it('mechanischer Bestätigungswort-Treffer im Entwurf → wait', async () => {
    const d = deps({ judge: vi.fn().mockResolvedValue(bookingVerdict) });
    const r = await runAutoSendGate({ ...bookingInput, body: 'Das passt, von uns aus steht einer Bestätigung nichts im Weg.' }, d);
    expect(r.decision.decision).toBe('wait');
    expect(r.decision.flags).toContain('mech:confirmation_words');
  });
});

describe('realGateDeps (Final-Review F5 — Wiring-Tests)', () => {
  it('envMode/dailyCap kommen aus config', () => {
    const d = realGateDeps();
    expect(d.envMode).toBe('shadow');
    expect(d.dailyCap).toBe(3);
  });
  it('isPaused liest scheduler_state-Key auto_send_paused, true nur bei "1"', () => {
    const d = realGateDeps();
    getSchedulerStateMock.mockReturnValue(null);
    expect(d.isPaused()).toBe(false);
    getSchedulerStateMock.mockReturnValue('0');
    expect(d.isPaused()).toBe(false);
    getSchedulerStateMock.mockReturnValue('1');
    expect(d.isPaused()).toBe(true);
    expect(getSchedulerStateMock).toHaveBeenCalledWith('auto_send_paused');
  });
  it('countAutoSentSince wird durchgereicht', () => {
    countAutoSentSinceMock.mockReturnValue(7);
    const d = realGateDeps();
    expect(d.countAutoSentSince('2026-09-19T00:00:00.000Z')).toBe(7);
    expect(countAutoSentSinceMock).toHaveBeenCalledWith('2026-09-19T00:00:00.000Z');
  });
  it('canSend: hostex-Thread → true, ohne Kanalauflösung zu fragen', () => {
    const d = realGateDeps();
    const hostexThread = { source: 'hostex' } as MessageThread;
    expect(d.canSend(hostexThread, [])).toBe(true);
  });
  it('canSend: guesty-Thread mit resolveOutboundModuleType=null → false', () => {
    resolveOutboundModuleTypeMock.mockReturnValue(null);
    const d = realGateDeps();
    const guestyThread = { source: 'guesty' } as MessageThread;
    expect(d.canSend(guestyThread, [])).toBe(false);
  });
});

// #1191: Satzwiederholung gegenüber den letzten gesendeten Host-Nachrichten.
describe('recentHostMessages / Gate (#1191)', () => {
  const out = (id: string, body: string, t: string) => ({ id, direction: 'outbound', body, sent_at: t }) as Message;
  const inn = (id: string, body: string, t: string) => ({ id, direction: 'inbound', body, sent_at: t }) as Message;

  it('liefert nur die letzten 3 outbound-Bodies, chronologisch, ohne leere', () => {
    const m = [out('a', 'A', '1'), inn('g1', 'Gast', '2'), out('b', 'B', '3'), out('x', '  ', '4'), out('c', 'C', '5'), inn('g2', 'Gast2', '6'), out('d', 'D', '7')];
    expect(recentHostMessages(m)).toEqual(['B', 'C', 'D']);
    expect(recentHostMessages(m, 1)).toEqual(['D']);
  });
  const hostBody = 'Hey Nora,\n\nWenn es für euch passt, stell gern die Buchungsanfrage.\n\nLiebe Grüße, Micha';
  const thread2 = [out('h1', hostBody, '2026-09-19T09:00:00Z'), inn('g1', 'Wir sind 15 Personen.', '2026-09-19T10:00:00Z')];

  it('wiederholter Satz → wait mit Grund und mech-Flag, persistiert', async () => {
    const d = deps();
    const r = await runAutoSendGate({ ...input, body: 'Hey Nora,\n\nMit 15 passt das genau.\n\nWenn es für euch passt, stell gern die Buchungsanfrage.\n\nLiebe Grüße, Micha', messages: thread2 }, d);
    expect(r.decision.decision).toBe('wait');
    expect(r.decision.reason).toContain('wiederholt eigenen Satz');
    expect(r.decision.flags).toContain('mech:repeats_own_sentence');
    expect(d.persistDecision).toHaveBeenCalledWith('d1', expect.objectContaining({ decision: 'wait', reason: expect.stringContaining('wiederholt eigenen Satz') }), 'live');
    expect(d.send).not.toHaveBeenCalled();
  });
  it('Judge bekommt hostMessages', async () => {
    const d = deps();
    await runAutoSendGate({ ...input, messages: thread2 }, d);
    expect(d.judge).toHaveBeenCalledWith(expect.objectContaining({ hostMessages: [hostBody] }));
  });
});

// #1210 (Entscheidung Micha 17.11.2026): Inquiry mit automatisch gesendeter Antwort → kein Task;
// wartend/Schattenmodus → Task wie bisher; Request-to-Book unverändert.
describe('runAutoSendGate: Inquiry-Task nur, wenn die Antwort auf Micha wartet (#1210)', () => {
  const bookingVerdict = { kind: 'verdict', verdict: { category: 'buchungsanfrage', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'r', promisedAction: null } } as const;
  const inquiryMessages = [
    { id: 'm1', direction: 'inbound', body: 'Is the house free in May?', sent_at: '2026-11-16T10:00:00.000Z' },
    { id: 'm2', direction: 'system', body: 'New guest inquiry', sent_at: '2026-11-16T10:00:06.000Z' },
  ] as Message[];
  const rtbMessages = [
    { id: 'm1', direction: 'inbound', body: 'We would like to book.', sent_at: '2026-11-16T10:00:00.000Z' },
    { id: 'm2', direction: 'system', body: 'New guest reservation request HMXYZ', sent_at: '2026-11-16T10:00:06.000Z' },
  ] as Message[];
  const openThread = { ...thread, reservation_status: 'inquiry' } as MessageThread;
  const inquiryInput: GateInput = { ...input, thread: openThread, body: 'Hi! Yes, May is free.', messages: inquiryMessages };

  it('Inquiry, live, automatisch gesendet → KEIN Task, decision auto, gesendet', async () => {
    const task = vi.fn();
    const send = vi.fn().mockResolvedValue({ ok: true });
    const d = deps({ judge: vi.fn().mockResolvedValue(bookingVerdict), resolveBookingRequestTask: task, send });
    const r = await runAutoSendGate(inquiryInput, d);
    expect(r.decision.decision).toBe('auto');
    expect(r.decision.reason).toMatch(/^Inquiry: Antwort automatisch, kein Task nötig, Frist /);
    expect(r.sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(task).not.toHaveBeenCalled();
    expect(d.persistBookingRequest).toHaveBeenCalledWith('d1', 'inquiry', '2026-11-17T10:00:06.000Z');
  });

  it('Inquiry, live, Antwort wartet (z. B. Konfidenz mittel) → Task wird angelegt', async () => {
    const task = vi.fn().mockResolvedValue({ created: true, taskNumber: 801, reused: false });
    const verdict = { kind: 'verdict', verdict: { ...bookingVerdict.verdict, confidence: 'mittel' } } as const;
    const d = deps({ judge: vi.fn().mockResolvedValue(verdict), resolveBookingRequestTask: task });
    const r = await runAutoSendGate(inquiryInput, d);
    expect(r.decision.decision).toBe('wait');
    expect(task).toHaveBeenCalledTimes(1);
    expect(task.mock.calls[0][0]).toMatchObject({ requestKind: 'inquiry', systemMessageId: 'm2' });
  });

  it('Inquiry im Schattenmodus → Task wie bisher', async () => {
    const task = vi.fn().mockResolvedValue({ created: true, taskNumber: 802, reused: false });
    const d = deps({ envMode: 'shadow', judge: vi.fn().mockResolvedValue(bookingVerdict), resolveBookingRequestTask: task });
    const r = await runAutoSendGate(inquiryInput, d);
    expect(r.sent).toBe(false);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('Request-to-Book, live, automatisch gesendet → Task bleibt (unverändert)', async () => {
    const task = vi.fn().mockResolvedValue({ created: true, taskNumber: 803, reused: false });
    const d = deps({ judge: vi.fn().mockResolvedValue(bookingVerdict), resolveBookingRequestTask: task });
    const r = await runAutoSendGate({ ...inquiryInput, messages: rtbMessages }, d);
    expect(r.decision.reason).toMatch(/Task #803/);
    expect(r.sent).toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('Inquiry, Versand scheitert → Task wird nachgeholt (Antwort wartet jetzt auf Micha)', async () => {
    const task = vi.fn().mockResolvedValue({ created: true, taskNumber: 804, reused: false });
    const d = deps({
      judge: vi.fn().mockResolvedValue(bookingVerdict), resolveBookingRequestTask: task,
      send: vi.fn().mockResolvedValue({ ok: false, err: new Error('Guesty down') }),
    });
    const r = await runAutoSendGate(inquiryInput, d);
    expect(r.sent).toBe(false);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('Inquiry, Claim verloren → Task wird nachgeholt', async () => {
    const task = vi.fn().mockResolvedValue({ created: true, taskNumber: 805, reused: false });
    const d = deps({ judge: vi.fn().mockResolvedValue(bookingVerdict), resolveBookingRequestTask: task, claim: vi.fn().mockReturnValue(false) });
    const r = await runAutoSendGate(inquiryInput, d);
    expect(r.decision.decision).toBe('wait');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('Nachanlage wirft → kein Abbruch', async () => {
    const d = deps({
      judge: vi.fn().mockResolvedValue(bookingVerdict), resolveBookingRequestTask: vi.fn().mockRejectedValue(new Error('boom')),
      send: vi.fn().mockResolvedValue({ ok: false, err: new Error('x') }),
    });
    await expect(runAutoSendGate(inquiryInput, d)).resolves.toMatchObject({ sent: false });
  });
});

// #1243: kein Entwurf mit Preis oder Nachlass geht automatisch raus (Gate-Ergebnis, nicht nur Regex).
describe('runAutoSendGate: Preis/Nachlass im Entwurf (#1243)', () => {
  const bookingVerdict = { kind: 'verdict', verdict: { category: 'buchungsanfrage', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'r', promisedAction: null } } as const;
  const inquiryMessages = [
    { id: 'm1', direction: 'inbound', body: 'Wir würden gern anfragen, ob ihr uns preislich entgegenkommt.', sent_at: '2026-11-17T10:00:00.000Z' },
    { id: 'm2', direction: 'system', body: 'New guest inquiry', sent_at: '2026-11-17T10:00:06.000Z' },
  ] as Message[];
  const openThread = { ...thread, reservation_status: 'inquiry' } as MessageThread;
  const inq = (body: string): GateInput => ({ ...input, thread: openThread, body, messages: inquiryMessages });
  const mk = (over: Partial<GateDeps> = {}) => deps({ judge: vi.fn().mockResolvedValue(bookingVerdict), ...over });

  it('(a) Nachlass ohne Eurobetrag → wait mit mech:price_discount, kein Send', async () => {
    const d = mk();
    const r = await runAutoSendGate(inq('Hi! Ich kann dir 10 % Nachlass auf die Unterkunft anbieten.'), d);
    expect(r.decision.decision).toBe('wait');
    expect(r.decision.flags).toContain('mech:price_discount');
    expect(r.decision.reason).toBe('Mechanischer Check: Preis oder Nachlass im Text (10 %)');
    expect(r.sent).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });
  it('(b) Gesamtpreis im Text → wait, kein Send', async () => {
    const d = mk();
    const r = await runAutoSendGate(inq('Hi! Der Gesamtpreis liegt bei ca. 3.948,30 EUR inkl. Steuern.'), d);
    expect(r.decision.decision).toBe('wait');
    expect(r.decision.flags).toContain('mech:price_discount');
    expect(d.send).not.toHaveBeenCalled();
  });
  // Prüfer-Befund 1: die Gastnachricht fragt nach Preis → nie auto, auch wenn der Entwurf das übergeht.
  it('(c) Preisfrage des Gasts, Entwurf ohne Preis/Rabatt → wait mit mech:guest_price_topic, kein Send', async () => {
    const d = mk();
    const r = await runAutoSendGate(inq('Hi! Gern. Wie viele Personen seid ihr?'), d);
    expect(r.decision.decision).toBe('wait');
    expect(r.decision.flags).toContain('mech:guest_price_topic');
    expect(r.decision.reason).toBe('Mechanischer Check: Preis- oder Rabattfrage in der Gastnachricht (preislich)');
    expect(d.send).not.toHaveBeenCalled();
  });
  it('(d) Gegenprobe: Gast ohne Preisthema, Entwurf ohne Preis/Rabatt → auto wie bisher', async () => {
    const d = mk();
    const plain = [
      { id: 'm1', direction: 'inbound', body: 'Gibt es in der Nähe einen See zum Baden?', sent_at: '2026-11-17T10:00:00.000Z' },
      { id: 'm2', direction: 'system', body: 'New guest inquiry', sent_at: '2026-11-17T10:00:06.000Z' },
    ] as Message[];
    const r = await runAutoSendGate({ ...inq('Hi! Ja, ein Badesee liegt ganz in der Nähe.'), messages: plain }, d);
    expect(r.decision.decision).toBe('auto');
    expect(r.decision.flags).not.toContain('mech:price_discount');
    expect(r.decision.flags).not.toContain('mech:guest_price_topic');
    expect(d.send).toHaveBeenCalledTimes(1);
  });
  it.each([
    'So weit runter kann ich leider nicht gehen, aber ein Zehntel auf die Unterkunft kann ich euch entgegenkommen.',
    'Da kann ich euch leider nicht entgegenkommen, es bleibt bei dem Betrag, der dir angezeigt wird.',
  ])('(e) Prüfer-Live-Fälle ohne alte Trigger-Wörter → wait, kein Send: %s', async (body) => {
    const d = mk();
    const r = await runAutoSendGate(inq(body), d);
    expect(r.decision.decision).toBe('wait');
    expect(r.decision.flags).toContain('mech:price_discount');
    expect(d.send).not.toHaveBeenCalled();
  });
  it('playbook_fakt mit „10 % Rabatt“ → wait', async () => {
    const d = deps({ judge: vi.fn().mockResolvedValue({ kind: 'verdict', verdict: { category: 'playbook_fakt', answerableFromFacts: true, riskFlags: [], confidence: 'hoch', reasoning: 'r', promisedAction: null } }) });
    const r = await runAutoSendGate({ ...input, body: 'Ja, bei uns gibt es 10 % Rabatt.' }, d);
    expect(r.decision.decision).toBe('wait');
    expect(r.decision.flags).toContain('mech:price_discount');
    expect(d.send).not.toHaveBeenCalled();
  });
});

// #1243: Gegenangebot-Notiz geht in den Buchungsanfrage-Task (nur neue Anlagen, non-fatal).
describe('runAutoSendGate: Gegenangebot-Notiz im Task (#1243)', () => {
  const bookingVerdict = { kind: 'verdict', verdict: { category: 'buchungsanfrage', answerableFromFacts: true, riskFlags: [], confidence: 'mittel', reasoning: 'r', promisedAction: null } } as const;
  const msgsInq = [
    { id: 'm1', direction: 'inbound', body: 'Wir könnten 2.600 Euro anbieten', sent_at: '2026-11-17T10:00:00.000Z' },
    { id: 'm2', direction: 'system', body: 'New guest inquiry', sent_at: '2026-11-17T10:00:06.000Z' },
  ] as Message[];
  const gi: GateInput = { ...input, thread: { ...thread, reservation_status: 'inquiry' } as MessageThread, body: 'Hi!', messages: msgsInq };

  it('reicht die Notiz an taskInput.counterOfferNote durch', async () => {
    const task = vi.fn().mockResolvedValue({ created: true, taskNumber: 900, reused: false });
    const note = vi.fn().mockReturnValue('Notiz X');
    await runAutoSendGate(gi, deps({ judge: vi.fn().mockResolvedValue(bookingVerdict), resolveBookingRequestTask: task, resolveCounterOfferNote: note }));
    expect(note).toHaveBeenCalledWith(gi.thread, msgsInq, property);
    expect(task.mock.calls[0][0].counterOfferNote).toBe('Notiz X');
  });
  it('wirft die Notiz, wird der Task trotzdem angelegt (ohne Notiz)', async () => {
    const task = vi.fn().mockResolvedValue({ created: true, taskNumber: 901, reused: false });
    const note = vi.fn(() => { throw new Error('boom'); });
    await runAutoSendGate(gi, deps({ judge: vi.fn().mockResolvedValue(bookingVerdict), resolveBookingRequestTask: task, resolveCounterOfferNote: note }));
    expect(task).toHaveBeenCalledTimes(1);
    expect(task.mock.calls[0][0].counterOfferNote).toBeNull();
  });
  it('ohne Dep bleibt alles wie bisher (null)', async () => {
    const task = vi.fn().mockResolvedValue({ created: true, taskNumber: 902, reused: false });
    await runAutoSendGate(gi, deps({ judge: vi.fn().mockResolvedValue(bookingVerdict), resolveBookingRequestTask: task }));
    expect(task.mock.calls[0][0].counterOfferNote).toBeNull();
  });
});
