// #1376: Migration 047 — report_subscriptions-Neuaufbau (CHECK um power-stay), power_stay_mails, Stichtag
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from './index.js';
import { addRecipient, getActiveRecipientEmails, removeRecipient, setSubscription } from '../repositories/report-recipient-repository.js';

let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`./migrations/${n}`, import.meta.url), 'utf8');

const dump = () =>
  db.prepare('SELECT recipient_id, report_type, property_slug, active, updated_at FROM report_subscriptions ORDER BY recipient_id, report_type, property_slug').all();

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(mig('026_add_scheduler_state.sql'));
  db.exec(mig('041_add_report_recipients.sql'));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('Migration 047', () => {
  it('bestehende Abos bleiben mit allen Spalten erhalten', () => {
    const a = addRecipient('a@example.com').id;
    const b = addRecipient('b@example.com').id;
    setSubscription(a, 'weekly-summary', 'farmhouse', true);
    setSubscription(a, 'portfolio-weekly', '', false);
    setSubscription(b, 'calendar-weekly', 'u19', true);
    db.prepare("UPDATE report_subscriptions SET updated_at = '2026-01-02 03:04:05' WHERE recipient_id = ?").run(b);
    const before = dump();
    expect(before).toHaveLength(3);

    db.exec(mig('047_power_stay_mail.sql'));

    expect(dump()).toEqual(before);
  });

  it('power-stay ist danach einfügbar, unbekannter Typ wird weiter abgelehnt', () => {
    const a = addRecipient('a@example.com').id;
    db.exec(mig('047_power_stay_mail.sql'));
    setSubscription(a, 'power-stay', 'farmhouse', true);
    expect(getActiveRecipientEmails('power-stay', 'farmhouse')).toEqual(['a@example.com']);
    expect(() => db.prepare("INSERT INTO report_subscriptions (recipient_id, report_type, property_slug) VALUES (?, 'gibts-nicht', '')").run(a)).toThrow(/CHECK/);
  });

  it('Index existiert, Default-Spalten und PK gelten weiter', () => {
    db.exec(mig('047_power_stay_mail.sql'));
    const idx = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_report_subscriptions_type'").get() as { tbl_name: string };
    expect(idx.tbl_name).toBe('report_subscriptions');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'report_subscriptions_new'").get()).toBeUndefined();
    const a = addRecipient('a@example.com').id;
    db.prepare("INSERT INTO report_subscriptions (recipient_id, report_type) VALUES (?, 'weekly-summary')").run(a);
    expect(db.prepare('SELECT property_slug, active FROM report_subscriptions').get()).toEqual({ property_slug: '', active: 1 });
    expect(() => db.prepare("INSERT INTO report_subscriptions (recipient_id, report_type) VALUES (?, 'weekly-summary')").run(a)).toThrow(/UNIQUE|PRIMARY/);
  });

  it('Stichtag-Key ist gesetzt (ISO-UTC) und ein bestehender Wert bleibt', () => {
    db.exec(mig('047_power_stay_mail.sql'));
    const row = db.prepare("SELECT value FROM scheduler_state WHERE key = 'power_stay_mail_since'").get() as { value: string };
    expect(row.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Math.abs(Date.now() - Date.parse(row.value))).toBeLessThan(60_000);
  });

  it('power_stay_mails: PK je Buchung, completeness-CHECK', () => {
    db.exec(mig('047_power_stay_mail.sql'));
    const ins = db.prepare("INSERT INTO power_stay_mails (reservation_id, property_slug, check_out_utc, completeness, recipient_count) VALUES (?, 'farmhouse', 'x', ?, 1)");
    ins.run('r1', 'complete');
    expect(() => ins.run('r1', 'complete')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => ins.run('r2', 'komisch')).toThrow(/CHECK/);
    expect((db.prepare("SELECT sent_at FROM power_stay_mails WHERE reservation_id = 'r1'").get() as { sent_at: string }).sent_at).toMatch(/Z$/);
  });

  it('Empfänger löschen (CASCADE) funktioniert weiter', () => {
    const a = addRecipient('a@example.com').id;
    setSubscription(a, 'weekly-summary', 'farmhouse', true);
    db.exec(mig('047_power_stay_mail.sql'));
    setSubscription(a, 'power-stay', 'farmhouse', true);
    expect(removeRecipient(a)).toBe(true);
    expect(dump()).toEqual([]);
  });

  it('Migration läuft auch mit foreign_keys = ON in einer Transaktion', () => {
    const a = addRecipient('a@example.com').id;
    setSubscription(a, 'weekly-summary', 'farmhouse', true);
    db.transaction(() => db.exec(mig('047_power_stay_mail.sql')))();
    expect(dump()).toHaveLength(1);
  });
});
