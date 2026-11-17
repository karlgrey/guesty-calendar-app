import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';
import {
  addRecipient,
  getActiveRecipientEmails,
  listRecipients,
  removeRecipient,
  setSubscription,
} from './report-recipient-repository.js';

// #1223: Report-Empfänger in der DB (Migration 041)
let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(mig('041_add_report_recipients.sql'));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('report-recipient-repository', () => {
  it('addRecipient normalisiert (trim, klein) und ist idempotent', () => {
    const a = addRecipient('  Micha@Example.com ');
    const b = addRecipient('micha@example.com');
    expect(a.email).toBe('micha@example.com');
    expect(b.id).toBe(a.id);
    expect(listRecipients()).toHaveLength(1);
  });

  it('getActiveRecipientEmails liefert nur aktive Häkchen des Typs/Objekts', () => {
    const m = addRecipient('m@example.com');
    const c = addRecipient('c@example.com');
    setSubscription(m.id, 'weekly-summary', 'farmhouse', true);
    setSubscription(c.id, 'weekly-summary', 'farmhouse', true);
    setSubscription(c.id, 'weekly-summary', 'u19', true);
    setSubscription(m.id, 'portfolio-weekly', '', true);

    expect(getActiveRecipientEmails('weekly-summary', 'farmhouse')).toEqual(['m@example.com', 'c@example.com']);
    expect(getActiveRecipientEmails('weekly-summary', 'u19')).toEqual(['c@example.com']);
    expect(getActiveRecipientEmails('portfolio-weekly')).toEqual(['m@example.com']);
    expect(getActiveRecipientEmails('calendar-weekly')).toEqual([]);

    setSubscription(c.id, 'weekly-summary', 'farmhouse', false);
    expect(getActiveRecipientEmails('weekly-summary', 'farmhouse')).toEqual(['m@example.com']);
  });

  it('objektübergreifende Typen ignorieren einen Slug, Objekt-Typen verlangen einen', () => {
    const m = addRecipient('m@example.com');
    setSubscription(m.id, 'portfolio-monthly', 'farmhouse', true); // Slug wird verworfen
    expect(getActiveRecipientEmails('portfolio-monthly')).toEqual(['m@example.com']);
    expect(() => setSubscription(m.id, 'weekly-summary', '', true)).toThrow();
    expect(() => getActiveRecipientEmails('weekly-summary')).toThrow();
  });

  it('listRecipients liefert die Häkchen je Empfänger', () => {
    const m = addRecipient('m@example.com');
    setSubscription(m.id, 'weekly-summary', 'farmhouse', true);
    setSubscription(m.id, 'portfolio-weekly', '', false);
    const [row] = listRecipients();
    expect(row.email).toBe('m@example.com');
    expect(row.subscriptions).toEqual([
      { reportType: 'portfolio-weekly', propertySlug: '', active: false },
      { reportType: 'weekly-summary', propertySlug: 'farmhouse', active: true },
    ]);
  });

  it('removeRecipient löscht Empfänger samt Häkchen', () => {
    const m = addRecipient('m@example.com');
    setSubscription(m.id, 'calendar-weekly', '', true);
    expect(removeRecipient(m.id)).toBe(true);
    expect(removeRecipient(m.id)).toBe(false);
    expect(getActiveRecipientEmails('calendar-weekly')).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM report_subscriptions').get()).toEqual({ n: 0 });
  });

  it('setSubscription auf unbekannten Empfänger wirft', () => {
    expect(() => setSubscription(999, 'calendar-weekly', '', true)).toThrow();
  });
});
