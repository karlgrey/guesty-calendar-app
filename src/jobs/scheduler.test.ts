// src/jobs/scheduler.test.ts
//
// Regression tests for #603: der tägliche Konsistenz-Check und der tägliche
// Force-Sync prüften die Stunde in Server-Lokalzeit statt in
// config.propertyTimezone, und merkten sich "heute schon gelaufen" nur im
// RAM (state.lastConsistencyCheck/lastDailyForceSync). Ein Deploy-Neustart
// innerhalb der Zielstunde (10.09.2026, 06:27:51Z) löschte den RAM-Marker,
// der Check lief erneut und verschickte eine zweite Alert-Mail.
//
// Nur die geprüften Funktionen werden importiert; alle schweren
// Job-Abhängigkeiten (ETL, Consistency-Job, DB-Repository) sind gemockt.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const runDailyConsistencyJobMock = vi.fn();
vi.mock('./consistency-check.js', () => ({
  runDailyConsistencyJob: (...args: unknown[]) => runDailyConsistencyJobMock(...args),
}));

const runETLJobMock = vi.fn();
const runLlmHealthCheckMock = vi.fn();
vi.mock('./llm-health-check.js', () => ({
  runLlmHealthCheck: (...args: unknown[]) => runLlmHealthCheckMock(...args),
}));

vi.mock('./etl-job.js', () => ({
  runETLJob: (...args: unknown[]) => runETLJobMock(...args),
}));

vi.mock('./weekly-email.js', () => ({
  sendWeeklySummaryEmailForProperty: vi.fn(),
  shouldSendWeeklyEmailForProperty: vi.fn(() => false),
}));
const sendPortfolioMonthlyEmailMock = vi.fn();
vi.mock('./bi-email.js', () => ({
  sendBiReportEmail: vi.fn(),
  shouldSendBiReport: vi.fn(() => false),
  sendPortfolioMonthlyEmail: (...args: unknown[]) => sendPortfolioMonthlyEmailMock(...args),
}));
const sendCalendarWeeklyEmailForPropertyMock = vi.fn();
vi.mock('./calendar-email.js', () => ({
  sendCalendarWeeklyEmailForProperty: (...args: unknown[]) => sendCalendarWeeklyEmailForPropertyMock(...args),
}));
const runPowerStayMailsMock = vi.fn();
vi.mock('./power-stay-email.js', () => ({
  runPowerStayMails: (...args: unknown[]) => runPowerStayMailsMock(...args),
}));
let mockedProperties: Array<{ slug: string; name: string }> = [];
vi.mock('../config/properties.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, getAllProperties: () => mockedProperties };
});
vi.mock('./sync-analytics.js', () => ({
  syncAnalytics: vi.fn(),
  shouldSyncAnalytics: vi.fn(() => false),
}));
vi.mock('./sync-google-calendar.js', () => ({
  syncGoogleCalendarForProperty: vi.fn(),
}));
vi.mock('./airbnb-mail/check-staleness.js', () => ({
  checkAirbnbMailStaleness: vi.fn(),
}));

const getSchedulerStateMock = vi.fn<(key: string) => string | null>(() => null);
const setSchedulerStateMock = vi.fn<(key: string, value: string) => void>();
vi.mock('../repositories/scheduler-state-repository.js', () => ({
  getSchedulerState: (...args: [string]) => getSchedulerStateMock(...args),
  setSchedulerState: (...args: [string, string]) => setSchedulerStateMock(...args),
}));

vi.mock('../config/index.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  return {
    ...mod,
    config: { ...mod.config, propertyTimezone: 'Europe/Berlin' },
  };
});

import {
  shouldRunDailyConsistencyCheck,
  checkAndRunDailyConsistencyCheck,
  loadConsistencyCheckState,
  shouldRunDailyForceSync,
  checkAndRunDailyForceSync,
  loadDailyForceSyncState,
  shouldRunDailyLlmHealthCheck,
  checkAndRunDailyLlmHealthCheck,
  loadLlmHealthCheckState,
  loadPortfolioMonthlyState,
  shouldSendPortfolioMonthly,
  checkAndSendPortfolioMonthly,
  shouldSendCalendarWeekly,
  calendarWeekKey,
  checkAndSendCalendarWeekly,
  checkAndSendPowerStayMails,
  resetSchedulerStateForTests,
} from './scheduler.js';

beforeEach(() => {
  vi.useRealTimers();
  resetSchedulerStateForTests();
  runDailyConsistencyJobMock.mockReset().mockResolvedValue(undefined);
  runLlmHealthCheckMock.mockReset().mockResolvedValue('ok');
  runETLJobMock.mockReset().mockResolvedValue({ success: true, listing: {}, availability: {}, duration: 1 });
  getSchedulerStateMock.mockReset().mockReturnValue(null);
  setSchedulerStateMock.mockReset();
  sendPortfolioMonthlyEmailMock.mockReset().mockResolvedValue({ success: true, sent: true });
  mockedProperties = [{ slug: 'farmhouse', name: 'Farmhouse' }, { slug: 'rh40', name: 'RH40' }];
  sendCalendarWeeklyEmailForPropertyMock
    .mockReset()
    .mockImplementation(async (p: { slug: string }) => ({ success: true, sent: true, propertySlug: p.slug }));
});

describe('shouldRunDailyConsistencyCheck (Zeitzone Europe/Berlin, #603)', () => {
  it('läuft um 06:xx Europe/Berlin im Sommer (04:xx UTC), auch ohne Marker', () => {
    // 2026-06-15 ist CEST (UTC+2): 04:30 UTC = 06:30 Berlin.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T04:30:00.000Z'));

    expect(shouldRunDailyConsistencyCheck()).toBe(true);

    vi.useRealTimers();
  });

  it('läuft NICHT um 06:xx UTC im Sommer, weil das in Berlin bereits 08:xx ist (Regression #603)', () => {
    // Genau der 10.09.2026-Fall: 06:23Z ist im Sommer (CEST) 08:23 Berlin,
    // die alte Server-Lokalzeit-Prüfung (now.getHours() === 6, UTC in
    // Produktion) hätte hier faelschlich gefeuert.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T06:23:00.000Z'));

    expect(shouldRunDailyConsistencyCheck()).toBe(false);

    vi.useRealTimers();
  });

  it('läuft nicht erneut am selben Tag, wenn der Marker aus der DB schon gesetzt ist (Neustart-Simulation)', () => {
    // 2026-09-10 ist noch CEST (UTC+2): 04:30 UTC = 06:30 Berlin.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T04:30:00.000Z'));

    // Simuliert einen Prozess-Neustart: frischer State, Marker kommt aus der DB.
    resetSchedulerStateForTests();
    getSchedulerStateMock.mockReturnValue('2026-09-10');
    loadConsistencyCheckState();

    expect(shouldRunDailyConsistencyCheck()).toBe(false);

    vi.useRealTimers();
  });

  it('läuft am Folgetag wieder, auch wenn gestern schon gelaufen wurde', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T04:30:00.000Z')); // 06:30 Berlin, noch CEST

    resetSchedulerStateForTests();
    getSchedulerStateMock.mockReturnValue('2026-09-10'); // gestern
    loadConsistencyCheckState();

    expect(shouldRunDailyConsistencyCheck()).toBe(true);

    vi.useRealTimers();
  });
});

describe('checkAndRunDailyConsistencyCheck (Persistenz, #603)', () => {
  it('läuft und persistiert den Tagesmarker, wenn noch keiner gesetzt ist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T04:30:00.000Z')); // 06:30 Berlin

    await checkAndRunDailyConsistencyCheck();

    expect(runDailyConsistencyJobMock).toHaveBeenCalledTimes(1);
    expect(setSchedulerStateMock).toHaveBeenCalledWith('dailyConsistencyCheckLastRunDay', '2026-09-10');

    vi.useRealTimers();
  });

  it('Neustart-Simulation: Marker aus der DB verhindert einen zweiten Lauf am selben Tag', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T04:30:00.000Z')); // 06:30 Berlin

    // "Vor dem Neustart" lief der Check bereits erfolgreich und hat den
    // Marker persistiert (hier durch den Mock-Rückgabewert simuliert).
    getSchedulerStateMock.mockReturnValue('2026-09-10');

    // Neustart: frischer RAM-State, Marker wird beim Start aus der DB geladen.
    resetSchedulerStateForTests();
    loadConsistencyCheckState();

    await checkAndRunDailyConsistencyCheck();

    expect(runDailyConsistencyJobMock).not.toHaveBeenCalled();
    expect(setSchedulerStateMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe('shouldRunDailyForceSync (Zeitzone Europe/Berlin, #603)', () => {
  it('läuft um 02:xx Europe/Berlin im Sommer (00:xx UTC), auch ohne Marker', () => {
    // 2026-06-15 CEST: 00:30 UTC = 02:30 Berlin.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:30:00.000Z'));

    expect(shouldRunDailyForceSync()).toBe(true);

    vi.useRealTimers();
  });

  it('läuft NICHT um 02:xx UTC im Sommer, weil das in Berlin bereits 04:xx ist', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T02:30:00.000Z'));

    expect(shouldRunDailyForceSync()).toBe(false);

    vi.useRealTimers();
  });

  it('Neustart-Simulation: Marker aus der DB verhindert einen zweiten Lauf am selben Tag', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T00:30:00.000Z')); // 02:30 Berlin

    getSchedulerStateMock.mockReturnValue('2026-09-10');
    resetSchedulerStateForTests();
    loadDailyForceSyncState();

    expect(shouldRunDailyForceSync()).toBe(false);

    await checkAndRunDailyForceSync();
    expect(runETLJobMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('läuft am Folgetag wieder', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:30:00.000Z')); // 02:30 Berlin

    getSchedulerStateMock.mockReturnValue('2026-09-10'); // gestern
    resetSchedulerStateForTests();
    loadDailyForceSyncState();

    expect(shouldRunDailyForceSync()).toBe(true);

    vi.useRealTimers();
  });

  // #686 Nachzieh-Liste: der Nachrichtenschritt innerhalb runETLJob kann am 60s-Lock-Timeout
  // hängen und die ETL für diese Property dadurch mit success:false abschließen (non-fatal,
  // etl-job.ts wirft dabei nicht) — der Marker MUSS trotzdem gesetzt werden, sonst würde der
  // 2-Uhr-Deep-Sync bei jedem Lauf um 02:xx erneut (und erneut, und erneut …) versucht, statt
  // nur einmal pro Tag als "gelaufen" zu gelten.
  it('setzt den Marker auch, wenn runETLJob mit success:false zurückkommt (Nachrichtenschritt am Lock-Timeout gescheitert)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:30:00.000Z')); // 02:30 Berlin

    resetSchedulerStateForTests();
    loadDailyForceSyncState();
    runETLJobMock.mockResolvedValue({
      success: false,
      listing: { success: true },
      availability: { success: true },
      duration: 1,
    });

    expect(shouldRunDailyForceSync()).toBe(true);
    await checkAndRunDailyForceSync();

    expect(runETLJobMock).toHaveBeenCalledWith(true);
    expect(setSchedulerStateMock).toHaveBeenCalledWith('dailyForceSyncLastRunDay', '2026-09-11');
    // Marker gilt sofort auch im RAM-State — ein zweiter Check-Tick in derselben Stunde löst
    // keinen zweiten Lauf mehr aus.
    expect(shouldRunDailyForceSync()).toBe(false);

    vi.useRealTimers();
  });
});

describe('Täglicher LLM-Health-Check (07:00 Europe/Berlin, #907)', () => {
  it('läuft um 07:xx Berlin im Sommer (05:xx UTC), nicht um 06:xx oder 07:xx UTC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T05:30:00.000Z'));
    expect(shouldRunDailyLlmHealthCheck()).toBe(true);
    vi.setSystemTime(new Date('2026-06-15T04:30:00.000Z'));
    expect(shouldRunDailyLlmHealthCheck()).toBe(false);
    vi.setSystemTime(new Date('2026-06-15T07:30:00.000Z'));
    expect(shouldRunDailyLlmHealthCheck()).toBe(false);
    vi.useRealTimers();
  });

  it('läuft und persistiert den Tagesmarker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T05:30:00.000Z')); // 07:30 Berlin

    await checkAndRunDailyLlmHealthCheck();

    expect(runLlmHealthCheckMock).toHaveBeenCalledTimes(1);
    expect(setSchedulerStateMock).toHaveBeenCalledWith('llm_health_check_last_run_day', '2026-09-10');
    vi.useRealTimers();
  });

  it('Neustart-Simulation: Marker aus der DB verhindert zweiten Lauf am selben Tag', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T05:30:00.000Z'));
    getSchedulerStateMock.mockReturnValue('2026-09-10');
    resetSchedulerStateForTests();
    loadLlmHealthCheckState();

    await checkAndRunDailyLlmHealthCheck();

    expect(runLlmHealthCheckMock).not.toHaveBeenCalled();
    expect(setSchedulerStateMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('läuft am Folgetag wieder', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T05:30:00.000Z'));
    getSchedulerStateMock.mockReturnValue('2026-09-10');
    resetSchedulerStateForTests();
    loadLlmHealthCheckState();
    expect(shouldRunDailyLlmHealthCheck()).toBe(true);
    vi.useRealTimers();
  });
});

describe('Portfolio monatlich (1. des Monats 06:xx Europe/Berlin, #1223)', () => {
  const KEY = 'portfolio_monthly_last_sent_month';

  it('sendet am 1. um 06:xx Berlin (Winter: 05:xx UTC), nicht am 2. und nicht um 07:xx', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-01T05:30:00.000Z')); // 06:30 Berlin (CET)
    expect(shouldSendPortfolioMonthly()).toBe(true);
    vi.setSystemTime(new Date('2026-12-01T06:30:00.000Z')); // 07:30 Berlin
    expect(shouldSendPortfolioMonthly()).toBe(false);
    vi.setSystemTime(new Date('2026-12-02T05:30:00.000Z'));
    expect(shouldSendPortfolioMonthly()).toBe(false);
    vi.useRealTimers();
  });

  it('Sommer: 06:xx Berlin = 04:xx UTC', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T04:30:00.000Z'));
    expect(shouldSendPortfolioMonthly()).toBe(true);
    vi.setSystemTime(new Date('2026-07-01T05:30:00.000Z'));
    expect(shouldSendPortfolioMonthly()).toBe(false);
    vi.useRealTimers();
  });

  it('sendet und persistiert den Monatsmarker YYYY-MM; zweiter Tick sendet nicht mehr', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-01T05:30:00.000Z'));
    await checkAndSendPortfolioMonthly();
    expect(sendPortfolioMonthlyEmailMock).toHaveBeenCalledTimes(1);
    expect(setSchedulerStateMock).toHaveBeenCalledWith(KEY, '2026-12');
    await checkAndSendPortfolioMonthly();
    expect(sendPortfolioMonthlyEmailMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('Neustart-Simulation: Marker aus der DB verhindert zweiten Versand im selben Monat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-01T05:30:00.000Z'));
    getSchedulerStateMock.mockImplementation((k: string) => (k === KEY ? '2026-12' : null));
    resetSchedulerStateForTests();
    loadPortfolioMonthlyState();
    await checkAndSendPortfolioMonthly();
    expect(sendPortfolioMonthlyEmailMock).not.toHaveBeenCalled();
    expect(setSchedulerStateMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('Folgemonat sendet wieder', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T05:30:00.000Z'));
    getSchedulerStateMock.mockImplementation((k: string) => (k === KEY ? '2026-12' : null));
    resetSchedulerStateForTests();
    loadPortfolioMonthlyState();
    expect(shouldSendPortfolioMonthly()).toBe(true);
    vi.useRealTimers();
  });

  it('kein Marker bei sent:false und bei Fehler (nächster Tick versucht es erneut)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-01T05:30:00.000Z'));
    sendPortfolioMonthlyEmailMock.mockResolvedValueOnce({ success: true, sent: false, error: 'No recipients' });
    await checkAndSendPortfolioMonthly();
    expect(setSchedulerStateMock).not.toHaveBeenCalled();
    sendPortfolioMonthlyEmailMock.mockRejectedValueOnce(new Error('boom'));
    await checkAndSendPortfolioMonthly();
    expect(setSchedulerStateMock).not.toHaveBeenCalled();
    expect(shouldSendPortfolioMonthly()).toBe(true);
    vi.useRealTimers();
  });
});

describe('Kalender-Report je Objekt (montags 06:xx Europe/Berlin, #1223/#1284)', () => {
  const key = (slug: string) => `calendar_weekly_last_sent_week:${slug}`;
  const MO_48 = '2026-11-23T05:30:00.000Z'; // Mo 06:30 Berlin (CET), KW 48
  const calledSlugs = () => sendCalendarWeeklyEmailForPropertyMock.mock.calls.map((c) => (c[0] as { slug: string }).slug);

  it('ISO-Wochenschlüssel zweistellig, mit ISO-Wochenjahr', () => {
    expect(calendarWeekKey(new Date(MO_48))).toBe('2026-W48');
    expect(calendarWeekKey(new Date('2026-01-05T05:30:00.000Z'))).toBe('2026-W02');
    expect(calendarWeekKey(new Date('2026-12-28T05:30:00.000Z'))).toBe('2026-W53');
    expect(calendarWeekKey(new Date('2027-01-01T05:30:00.000Z'))).toBe('2026-W53'); // ISO-Wochenjahr != Kalenderjahr
  });

  it('sendet montags 06:xx Berlin, nicht dienstags, nicht um 07:xx', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MO_48));
    expect(shouldSendCalendarWeekly()).toBe(true);
    vi.setSystemTime(new Date('2026-11-23T06:30:00.000Z')); // 07:30
    expect(shouldSendCalendarWeekly()).toBe(false);
    vi.setSystemTime(new Date('2026-11-24T05:30:00.000Z')); // Di
    expect(shouldSendCalendarWeekly()).toBe(false);
    vi.useRealTimers();
  });

  it('außerhalb des Fensters wird nichts gesendet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T05:30:00.000Z'));
    await checkAndSendCalendarWeekly();
    expect(sendCalendarWeeklyEmailForPropertyMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('zwei Objekte: zwei Aufrufe, zwei Wochenmarker; zweiter Tick sendet nicht mehr', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MO_48));
    await checkAndSendCalendarWeekly();
    expect(calledSlugs()).toEqual(['farmhouse', 'rh40']);
    expect(setSchedulerStateMock).toHaveBeenCalledWith(key('farmhouse'), '2026-W48');
    expect(setSchedulerStateMock).toHaveBeenCalledWith(key('rh40'), '2026-W48');
    await checkAndSendCalendarWeekly();
    expect(sendCalendarWeeklyEmailForPropertyMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('Neustart-Simulation: Marker aus der DB überspringt nur das bereits versorgte Objekt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MO_48));
    getSchedulerStateMock.mockImplementation((k: string) => (k === key('farmhouse') ? '2026-W48' : null));
    resetSchedulerStateForTests();
    await checkAndSendCalendarWeekly();
    expect(calledSlugs()).toEqual(['rh40']);
    vi.useRealTimers();
  });

  it('nächster Montag sendet wieder', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-30T05:30:00.000Z'));
    getSchedulerStateMock.mockImplementation((k: string) => (k.startsWith('calendar_weekly_last_sent_week:') ? '2026-W48' : null));
    resetSchedulerStateForTests();
    await checkAndSendCalendarWeekly();
    expect(calledSlugs()).toEqual(['farmhouse', 'rh40']);
    expect(setSchedulerStateMock).toHaveBeenCalledWith(key('farmhouse'), '2026-W49');
    vi.useRealTimers();
  });

  it('kein Marker bei sent:false', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MO_48));
    sendCalendarWeeklyEmailForPropertyMock.mockResolvedValue({ success: true, sent: false, propertySlug: 'x', error: 'No recipients' });
    await checkAndSendCalendarWeekly();
    expect(sendCalendarWeeklyEmailForPropertyMock).toHaveBeenCalledTimes(2);
    expect(setSchedulerStateMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('Exception bei einem Objekt: das andere wird trotzdem gesendet und markiert', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(MO_48));
    sendCalendarWeeklyEmailForPropertyMock.mockImplementationOnce(async () => { throw new Error('boom'); });
    await checkAndSendCalendarWeekly();
    expect(calledSlugs()).toEqual(['farmhouse', 'rh40']);
    expect(setSchedulerStateMock).toHaveBeenCalledTimes(1);
    expect(setSchedulerStateMock).toHaveBeenCalledWith(key('rh40'), '2026-W48');
    vi.useRealTimers();
  });
});

describe('checkAndSendPowerStayMails (#1376)', () => {
  it('ruft runPowerStayMails auf und schluckt Fehler', async () => {
    runPowerStayMailsMock.mockReset().mockResolvedValue({ sent: 0, failed: 0, due: 0 });
    await checkAndSendPowerStayMails();
    expect(runPowerStayMailsMock).toHaveBeenCalledTimes(1);
    runPowerStayMailsMock.mockRejectedValueOnce(new Error('boom'));
    await expect(checkAndSendPowerStayMails()).resolves.toBeUndefined();
  });
});
