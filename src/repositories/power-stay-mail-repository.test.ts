// #1376: Versandvermerk der Strom-Mail je Gast
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';

vi.mock('../utils/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { claimPowerStayMail, getPowerStayMailIds, releasePowerStayMail } from './power-stay-mail-repository.js';

let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const m of ['026_add_scheduler_state.sql', '041_add_report_recipients.sql', '047_power_stay_mail.sql']) db.exec(mig(m));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

const claim = (id: string, slug = 'farmhouse', completeness: 'complete' | 'incomplete' = 'complete') =>
  claimPowerStayMail({ reservationId: id, propertySlug: slug, checkOutUtc: '2026-11-22T10:00:00.000Z', completeness, recipientCount: 2 });

describe('power-stay-mail-repository', () => {
  it('claim: erstes Mal true, zweites Mal false', () => {
    expect(claim('r1')).toBe(true);
    expect(claim('r1')).toBe(false);
    expect(db.prepare('SELECT * FROM power_stay_mails WHERE reservation_id = ?').get('r1')).toMatchObject({
      property_slug: 'farmhouse', check_out_utc: '2026-11-22T10:00:00.000Z', completeness: 'complete', recipient_count: 2,
    });
  });

  it('release: Vermerk weg, danach wieder claim-bar; unbekannte ID ist harmlos', () => {
    claim('r1');
    releasePowerStayMail('r1');
    expect(getPowerStayMailIds('farmhouse').has('r1')).toBe(false);
    expect(claim('r1')).toBe(true);
    expect(() => releasePowerStayMail('gibts-nicht')).not.toThrow();
  });

  it('getPowerStayMailIds: je Objekt', () => {
    claim('r1');
    claim('r2', 'farmhouse', 'incomplete');
    claim('x1', 'u19');
    expect(getPowerStayMailIds('farmhouse')).toEqual(new Set(['r1', 'r2']));
    expect(getPowerStayMailIds('u19')).toEqual(new Set(['x1']));
    expect(getPowerStayMailIds('leer')).toEqual(new Set());
  });
});
