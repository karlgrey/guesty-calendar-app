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
vi.mock('./etl-job.js', () => ({
  runETLJob: (...args: unknown[]) => runETLJobMock(...args),
}));

vi.mock('./weekly-email.js', () => ({
  sendWeeklySummaryEmailForProperty: vi.fn(),
  shouldSendWeeklyEmailForProperty: vi.fn(() => false),
}));
vi.mock('./bi-email.js', () => ({
  sendBiReportEmail: vi.fn(),
  shouldSendBiReport: vi.fn(() => false),
}));
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
  resetSchedulerStateForTests,
} from './scheduler.js';

beforeEach(() => {
  vi.useRealTimers();
  resetSchedulerStateForTests();
  runDailyConsistencyJobMock.mockReset().mockResolvedValue(undefined);
  runETLJobMock.mockReset().mockResolvedValue({ success: true, listing: {}, availability: {}, duration: 1 });
  getSchedulerStateMock.mockReset().mockReturnValue(null);
  setSchedulerStateMock.mockReset();
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
});
