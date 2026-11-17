import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../../db/index.js';
import { getActiveRecipientEmails, setSubscription, addRecipient, listRecipients } from '../../repositories/report-recipient-repository.js';
import { getSchedulerState } from '../../repositories/scheduler-state-repository.js';
import type { PropertyConfig, BiReportConfig } from '../../config/properties.js';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../utils/logger.js', () => ({
  default: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));

import { bootstrapReportRecipients } from './report-recipients-bootstrap.js';

let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../../db/migrations/${n}`, import.meta.url), 'utf8');

beforeEach(() => {
  warn.mockClear();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(mig('026_add_scheduler_state.sql'));
  db.exec(mig('041_add_report_recipients.sql'));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

const M = 'micha@example.com';
const C = 'christian@example.com';
const H = 'holger@example.com';
const U = 'ulf@example.com';
const A = 'angela@example.com';

const prop = (slug: string, recipients: string[], enabled = true) =>
  ({ slug, name: slug, weeklyReport: { enabled, recipients, day: 1, hour: 8 } }) as unknown as PropertyConfig;

const props = (): PropertyConfig[] => [
  prop('farmhouse', [M, C, H]),
  prop('u19', [M, C, H]),
  prop('alte-schilderwerkstatt', [M, C, H, U, A]),
  prop('bootshaus-alte-oder', [M, C, H, U, A], false),
  prop('firenze-loft', [M, C]),
];
const bi = (r: string[] = [M, C, H]) => ({ enabled: true, recipients: r }) as unknown as BiReportConfig;

describe('bootstrapReportRecipients', () => {
  it('importiert und seedet den Endzustand', () => {
    const res = bootstrapReportRecipients(props(), bi());
    expect(res.ran).toBe(true);
    expect(res.imported).toBe(5);
    expect(res.seeds.length).toBeGreaterThan(0);

    expect(getActiveRecipientEmails('weekly-summary', 'farmhouse')).toEqual([M, H]);
    expect(getActiveRecipientEmails('weekly-summary', 'u19')).toEqual([M, H]);
    expect(getActiveRecipientEmails('weekly-summary', 'alte-schilderwerkstatt')).toEqual([M, H, U, A]);
    expect(getActiveRecipientEmails('weekly-summary', 'bootshaus-alte-oder')).toEqual([M, H, U, A]);
    expect(getActiveRecipientEmails('weekly-summary', 'firenze-loft')).toEqual([M]);
    expect(getActiveRecipientEmails('portfolio-weekly')).toEqual([M, H]);
    expect(getActiveRecipientEmails('portfolio-monthly')).toEqual([C]);
    expect(getActiveRecipientEmails('calendar-weekly').sort()).toEqual([A, H, U].sort());
    expect(getSchedulerState('report_recipients_bootstrap_v1')).not.toBeNull();
  });

  it('zweiter Aufruf ist No-op, auch nach manueller Änderung', () => {
    bootstrapReportRecipients(props(), bi());
    const m = listRecipients().find((r) => r.email === M)!;
    setSubscription(m.id, 'weekly-summary', 'farmhouse', false);
    const res = bootstrapReportRecipients(props(), bi());
    expect(res.ran).toBe(false);
    expect(getActiveRecipientEmails('weekly-summary', 'farmhouse')).toEqual([H]);
  });

  it('fehlender christian: Warnung, Rest läuft', () => {
    const p = [prop('farmhouse', [M, H, U])];
    const res = bootstrapReportRecipients(p, bi([M, H]));
    expect(res.ran).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain('christian');
    expect(getActiveRecipientEmails('portfolio-monthly')).toEqual([]);
    expect(getActiveRecipientEmails('calendar-weekly').sort()).toEqual([H, U].sort());
  });

  it('mehrere Treffer mit verschiedenen Domains: Seed übersprungen und Warnung', () => {
    const p = [prop('farmhouse', [M, 'holger@example.com', 'holger@other.org'])];
    bootstrapReportRecipients(p, bi([]));
    expect(getActiveRecipientEmails('calendar-weekly')).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).toContain('holger');
  });

  it('christian ist einziger Empfänger von portfolio-monthly, auch bei Vorbelegung', () => {
    addRecipient(M); // id 1
    setSubscription(1, 'portfolio-monthly', '', true);
    bootstrapReportRecipients(props(), bi());
    expect(getActiveRecipientEmails('portfolio-monthly')).toEqual([C]);
  });

  it('leere Recipients: ran true, imported 0', () => {
    const res = bootstrapReportRecipients([prop('farmhouse', [])], bi([]));
    expect(res.ran).toBe(true);
    expect(res.imported).toBe(0);
    expect(getSchedulerState('report_recipients_bootstrap_v1')).not.toBeNull();
  });

  it('Adressen werden normalisiert und dedupliziert gezählt', () => {
    const res = bootstrapReportRecipients([prop('a', ['Micha@Example.com ']), prop('b', [M])], bi([]));
    expect(res.imported).toBe(1);
  });
});
