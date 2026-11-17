import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { setDatabase, resetDatabase } from '../db/index.js';
import { addRecipient, getActiveRecipientEmails, listRecipients, setSubscription } from '../repositories/report-recipient-repository.js';

vi.mock('../config/properties.js', () => ({
  getAllProperties: () => [
    { slug: 'farmhouse', name: 'Farmhouse Prasser' },
    { slug: 'u19', name: 'Uferstraße 19' },
    { slug: 'firenze-loft', name: 'Florenz Loft', reportingUntil: '2026-11-23' },
  ],
}));

import reportingRoutes from './reporting.js';
import { renderAdminNav } from './admin-layout.js';

let server: Server; let base: string; let db: Database.Database;
const mig = (n: string) => readFileSync(new URL(`../db/migrations/${n}`, import.meta.url), 'utf8');

beforeAll(async () => {
  const app = express();
  app.use('/admin/reporting', reportingRoutes);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(mig('041_add_report_recipients.sql'));
  setDatabase(db);
});
afterEach(() => { resetDatabase(); db.close(); });

const postJson = (body: unknown) =>
  fetch(`${base}/admin/reporting/subscriptions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
const postForm = (path: string, data: Record<string, string>) =>
  fetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString(),
  });

describe('GET /admin/reporting', () => {
  it('zeigt Empfänger, Spalten und Häkchen-Zustand', async () => {
    const m = addRecipient('m@example.com');
    addRecipient('c@example.com');
    setSubscription(m.id, 'weekly-summary', 'u19', true);
    setSubscription(m.id, 'portfolio-monthly', '', true);
    const html = await (await fetch(`${base}/admin/reporting`)).text();
    expect(html).toContain('m@example.com');
    expect(html).toContain('c@example.com');
    expect(html).toContain('Weekly Summary · Farmhouse Prasser');
    expect(html).toContain('Weekly Summary · Florenz Loft (bis 23.11.2026)');
    expect(html).toContain('Portfolio wöchentlich');
    expect(html).toContain('Portfolio monatlich');
    expect(html).toContain('Kalender (Nächste Gäste)');
    expect(html).toContain('/admin/reporting/recipients/1/delete');
    // genau zwei Häkchen gesetzt
    expect((html.match(/ checked/g) ?? []).length).toBe(2);
    expect(html).toMatch(/data-recipient="1" data-type="weekly-summary" data-slug="u19" checked/);
  });

  it('escaped Mailadressen', async () => {
    addRecipient('"><script>x</script>@example.com');
    const html = await (await fetch(`${base}/admin/reporting`)).text();
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('zeigt Fehlermeldung escaped', async () => {
    const html = await (await fetch(`${base}/admin/reporting?error=${encodeURIComponent('<b>kaputt</b>')}`)).text();
    expect(html).toContain('&lt;b&gt;kaputt&lt;/b&gt;');
    expect(html).not.toContain('<b>kaputt</b>');
  });
});

describe('POST /admin/reporting/subscriptions', () => {
  it('Toggle wirkt sofort auf getActiveRecipientEmails', async () => {
    const m = addRecipient('m@example.com');
    let r = await postJson({ recipientId: m.id, reportType: 'weekly-summary', propertySlug: 'farmhouse', active: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(getActiveRecipientEmails('weekly-summary', 'farmhouse')).toEqual(['m@example.com']);
    r = await postJson({ recipientId: m.id, reportType: 'weekly-summary', propertySlug: 'farmhouse', active: false });
    expect(r.status).toBe(200);
    expect(getActiveRecipientEmails('weekly-summary', 'farmhouse')).toEqual([]);
  });

  it('objektübergreifender Typ ignoriert den Slug', async () => {
    const m = addRecipient('m@example.com');
    const r = await postJson({ recipientId: m.id, reportType: 'portfolio-weekly', propertySlug: 'egal', active: true });
    expect(r.status).toBe(200);
    expect(getActiveRecipientEmails('portfolio-weekly')).toEqual(['m@example.com']);
  });

  it('400 bei ungültigem Typ, unbekanntem Slug, Nicht-Boolean, Nicht-Integer', async () => {
    const m = addRecipient('m@example.com');
    expect((await postJson({ recipientId: m.id, reportType: 'nope', propertySlug: '', active: true })).status).toBe(400);
    expect((await postJson({ recipientId: m.id, reportType: 'weekly-summary', propertySlug: 'gibts-nicht', active: true })).status).toBe(400);
    expect((await postJson({ recipientId: m.id, reportType: 'weekly-summary', propertySlug: '', active: true })).status).toBe(400);
    expect((await postJson({ recipientId: m.id, reportType: 'portfolio-weekly', propertySlug: '', active: 'ja' })).status).toBe(400);
    expect((await postJson({ recipientId: 'x', reportType: 'portfolio-weekly', propertySlug: '', active: true })).status).toBe(400);
  });

  it('404 bei unbekanntem Empfänger', async () => {
    const r = await postJson({ recipientId: 999, reportType: 'portfolio-weekly', propertySlug: '', active: true });
    expect(r.status).toBe(404);
  });
});

describe('Empfänger hinzufügen / entfernen', () => {
  it('gültige Adresse: angelegt ohne Häkchen, Redirect mit added', async () => {
    const r = await postForm('/admin/reporting/recipients', { email: '  Neu@Example.com ' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('/admin/reporting?added=');
    expect(listRecipients().map((x) => [x.email, x.subscriptions.length])).toEqual([['neu@example.com', 0]]);
  });

  it('ungültige Adresse: Redirect mit error, nichts angelegt', async () => {
    const r = await postForm('/admin/reporting/recipients', { email: 'kein-mail' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('/admin/reporting?error=');
    expect(listRecipients()).toHaveLength(0);
  });

  it('Entfernen löscht Empfänger samt Häkchen; unbekannt -> 404', async () => {
    const m = addRecipient('m@example.com');
    setSubscription(m.id, 'portfolio-weekly', '', true);
    const r = await postForm(`/admin/reporting/recipients/${m.id}/delete`, {});
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin/reporting');
    expect(listRecipients()).toHaveLength(0);
    expect(getActiveRecipientEmails('portfolio-weekly')).toEqual([]);
    expect((await postForm('/admin/reporting/recipients/999/delete', {})).status).toBe(404);
    expect((await postForm('/admin/reporting/recipients/abc/delete', {})).status).toBe(404);
  });
});

describe('Admin-Navigation', () => {
  it('enthält einen Link auf /admin/reporting', () => {
    expect(renderAdminNav('dashboard')).toContain('href="/admin/reporting"');
  });
});
