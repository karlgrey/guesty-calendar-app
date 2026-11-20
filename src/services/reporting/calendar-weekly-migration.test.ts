import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../../db/index.js';
import { addRecipient, getActiveRecipientEmails, setSubscription } from '../../repositories/report-recipient-repository.js';

// #1284: Migration 045 — calendar-weekly wandert von objektübergreifend auf je Objekt
let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../../db/migrations/${n}`, import.meta.url), 'utf8');

const SLUGS = ['farmhouse', 'u19', 'alte-schilderwerkstatt', 'bootshaus-alte-oder', 'firenze-loft'];
const H = 'holger@example.com';
const U = 'ulf@example.com';
const A = 'angela@example.com';
const M = 'micha@example.com';
const I = 'inaktiv@example.com';
const P = 'partial@example.com';

/** Altes objektübergreifendes Abo per rohem SQL (setSubscription verlangt jetzt einen Slug). */
const legacyCalendar = (id: number, active: 0 | 1 = 1) =>
  db.prepare("INSERT INTO report_subscriptions (recipient_id, report_type, property_slug, active) VALUES (?, 'calendar-weekly', '', ?)").run(id, active);

const dump = () =>
  db.prepare('SELECT recipient_id, report_type, property_slug, active, updated_at FROM report_subscriptions ORDER BY recipient_id, report_type, property_slug').all();

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(mig('026_add_scheduler_state.sql'));
  db.exec(mig('041_add_report_recipients.sql'));
  setDatabase(db);

  const h = addRecipient(H).id;
  const u = addRecipient(U).id;
  const a = addRecipient(A).id;
  const m = addRecipient(M).id;
  const i = addRecipient(I).id;
  const p = addRecipient(P).id;

  for (const s of ['farmhouse', 'u19', 'alte-schilderwerkstatt', 'bootshaus-alte-oder']) setSubscription(h, 'weekly-summary', s, true);
  for (const id of [u, a]) {
    for (const s of ['alte-schilderwerkstatt', 'bootshaus-alte-oder']) setSubscription(id, 'weekly-summary', s, true);
  }
  for (const s of SLUGS) setSubscription(m, 'weekly-summary', s, true);
  setSubscription(m, 'portfolio-weekly', '', true);
  for (const s of ['farmhouse', 'u19']) setSubscription(i, 'weekly-summary', s, true);
  setSubscription(p, 'weekly-summary', 'farmhouse', true);
  setSubscription(p, 'weekly-summary', 'u19', false);

  legacyCalendar(h);
  legacyCalendar(u);
  legacyCalendar(a);
  legacyCalendar(i, 0);
  legacyCalendar(p);
});
afterEach(() => { resetDatabase(); db.close(); });

describe('Migration 045 calendar-weekly je Objekt', () => {
  it('Holger bekommt calendar-weekly für genau seine vier weekly-summary-Objekte', () => {
    db.exec(mig('045_calendar_weekly_per_property.sql'));
    for (const s of ['farmhouse', 'u19', 'alte-schilderwerkstatt', 'bootshaus-alte-oder']) {
      expect(getActiveRecipientEmails('calendar-weekly', s)).toContain(H);
    }
    expect(getActiveRecipientEmails('calendar-weekly', 'firenze-loft')).not.toContain(H);
  });

  it('Ulf und Angela bekommen nur alte-schilderwerkstatt und bootshaus-alte-oder', () => {
    db.exec(mig('045_calendar_weekly_per_property.sql'));
    for (const s of ['alte-schilderwerkstatt', 'bootshaus-alte-oder']) {
      expect(getActiveRecipientEmails('calendar-weekly', s)).toEqual(expect.arrayContaining([U, A]));
    }
    for (const s of ['farmhouse', 'u19', 'firenze-loft']) {
      const list = getActiveRecipientEmails('calendar-weekly', s);
      expect(list).not.toContain(U);
      expect(list).not.toContain(A);
    }
  });

  it('Empfänger ohne calendar-weekly-Abo (Micha) bekommt keins', () => {
    db.exec(mig('045_calendar_weekly_per_property.sql'));
    for (const s of SLUGS) expect(getActiveRecipientEmails('calendar-weekly', s)).not.toContain(M);
  });

  it('inaktives objektübergreifendes Abo erzeugt keine Objekt-Abos', () => {
    db.exec(mig('045_calendar_weekly_per_property.sql'));
    for (const s of SLUGS) expect(getActiveRecipientEmails('calendar-weekly', s)).not.toContain(I);
    expect(db.prepare("SELECT COUNT(*) AS n FROM report_subscriptions s JOIN report_recipients r ON r.id = s.recipient_id WHERE r.email = ? AND s.report_type = 'calendar-weekly'").get(I)).toEqual({ n: 0 });
  });

  it('inaktives weekly-summary-Objekt zählt nicht', () => {
    db.exec(mig('045_calendar_weekly_per_property.sql'));
    expect(getActiveRecipientEmails('calendar-weekly', 'farmhouse')).toContain(P);
    expect(getActiveRecipientEmails('calendar-weekly', 'u19')).not.toContain(P);
  });

  it('keine objektübergreifende calendar-weekly-Zeile mehr (aktiv wie inaktiv)', () => {
    db.exec(mig('045_calendar_weekly_per_property.sql'));
    expect(db.prepare("SELECT COUNT(*) AS n FROM report_subscriptions WHERE report_type = 'calendar-weekly' AND property_slug = ''").get()).toEqual({ n: 0 });
  });

  it('bestehende Objekt-Abos werden nicht überschrieben', () => {
    const h = addRecipient(H).id;
    setSubscription(h, 'calendar-weekly', 'farmhouse', false);
    db.exec(mig('045_calendar_weekly_per_property.sql'));
    expect(getActiveRecipientEmails('calendar-weekly', 'farmhouse')).not.toContain(H);
    expect(getActiveRecipientEmails('calendar-weekly', 'u19')).toContain(H);
  });

  it('weekly-summary- und Portfolio-Abos bleiben unverändert', () => {
    const sel = "SELECT * FROM report_subscriptions WHERE report_type != 'calendar-weekly' ORDER BY recipient_id, report_type, property_slug";
    const before = db.prepare(sel).all();
    db.exec(mig('045_calendar_weekly_per_property.sql'));
    expect(db.prepare(sel).all()).toEqual(before);
  });

  it('ist idempotent', () => {
    db.exec(mig('045_calendar_weekly_per_property.sql'));
    const first = dump();
    db.exec(mig('045_calendar_weekly_per_property.sql'));
    expect(dump()).toEqual(first);
  });
});
