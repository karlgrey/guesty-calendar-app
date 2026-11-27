// src/routes/reporting.ts
// Admin-Seite "Reporting" (#1223): Matrix Empfänger x Report-Typ/Objekt. Häkchen speichern
// sofort in report_subscriptions; die Report-Jobs lesen ihre Empfänger bei jedem Versand frisch.
import express from 'express';
import { z } from 'zod';
import { getAllProperties } from '../config/properties.js';
import {
  addRecipient, getRecipientById, listRecipients, removeRecipient, setSubscription,
} from '../repositories/report-recipient-repository.js';
import {
  PER_PROPERTY_REPORT_TYPES, REPORT_TYPES, REPORT_TYPE_LABELS, isPerPropertyReportType, isReportType, reportTypeAppliesTo, type ReportType,
} from '../services/reporting/report-types.js';
import { renderAdminPage } from './admin-layout.js';

const router = express.Router();

function esc(s: string | number | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

const CROSS_PROPERTY_TYPES: ReportType[] = REPORT_TYPES.filter((t) => !isPerPropertyReportType(t));

const emailSchema = z.string().trim().email();

function queryString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

router.get('/', (req, res) => {
  const properties = getAllProperties();
  const recipients = listRecipients();
  const error = queryString(req.query.error);
  const added = queryString(req.query.added);

  const columns: Array<{ type: ReportType; slug: string; label: string }> = [
    ...PER_PROPERTY_REPORT_TYPES.flatMap((t) => properties.filter((p) => reportTypeAppliesTo(t, p.slug)).map((p) => ({
      type: t,
      slug: p.slug,
      label: `${REPORT_TYPE_LABELS[t]} · ${p.name}${p.reportingUntil ? ` (bis ${formatDate(p.reportingUntil)})` : ''}`,
    }))),
    ...CROSS_PROPERTY_TYPES.map((t) => ({ type: t, slug: '', label: REPORT_TYPE_LABELS[t] })),
  ];

  const head = `<tr><th class="email-col">Empfänger</th>${columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}<th></th></tr>`;
  const rows = recipients.map((r) => {
    const active = new Set(r.subscriptions.filter((s) => s.active).map((s) => `${s.reportType}|${s.propertySlug}`));
    const cells = columns.map((c) => {
      const checked = active.has(`${c.type}|${c.slug}`) ? ' checked' : '';
      return `<td><input type="checkbox" class="sub-toggle" data-recipient="${r.id}" data-type="${esc(c.type)}" data-slug="${esc(c.slug)}"${checked} aria-label="${esc(`${r.email}: ${c.label}`)}"></td>`;
    }).join('');
    return `<tr><td class="email-col">${esc(r.email)}</td>${cells}<td><form method="POST" action="/admin/reporting/recipients/${r.id}/delete" onsubmit="return confirm('Empfänger entfernen? Alle Häkchen gehen verloren.')"><button class="btn btn-danger btn-small">Entfernen</button></form></td></tr>`;
  }).join('');

  const body = `
<style>
  .container { max-width: 1200px; }
  .matrix-wrap { overflow-x: auto; }
  table.matrix { border-collapse: collapse; width: 100%; font-size: 14px; }
  table.matrix th, table.matrix td { padding: 10px 12px; border-bottom: 1px solid var(--color-stone); text-align: center; vertical-align: middle; }
  table.matrix th { font-size: 12px; color: var(--color-warm-gray); font-weight: 600; }
  table.matrix .email-col { text-align: left; white-space: nowrap; font-weight: 600; }
  table.matrix input[type=checkbox] { width: 18px; height: 18px; cursor: pointer; }
  .btn-small { padding: 6px 12px; font-size: 13px; }
  .add-form { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .add-form input[type=email] { font-family: var(--font-body); font-size: 15px; padding: 10px 14px; border: 1px solid var(--color-stone); border-radius: var(--radius-sm); min-width: 280px; }
  .flash { padding: 10px 14px; border-radius: var(--radius-sm); margin-bottom: 18px; font-size: 14px; }
  .flash-error { background: #faeae8; border: 1px solid var(--color-red); color: var(--color-red-dark); }
  .flash-ok { background: var(--color-sand); border: 1px solid var(--color-sage); color: var(--color-forest); }
  #save-state { font-size: 13px; color: var(--color-forest); margin-left: 12px; }
</style>
<h1>Reporting<span id="save-state"></span></h1>
<p class="subtitle">Empfänger der Mail-Reports. Änderungen wirken beim nächsten Versand. Konsistenz-Alert und LLM-Alarm werden weiterhin über die .env gesteuert und sind nicht Teil dieser Seite.</p>
${error ? `<div class="flash flash-error">${esc(error)}</div>` : ''}
${added ? `<div class="flash flash-ok">Empfänger ${esc(added)} hinzugefügt (ohne Häkchen).</div>` : ''}
<div class="section">
  <div class="matrix-wrap">
    ${recipients.length ? `<table class="matrix"><thead>${head}</thead><tbody>${rows}</tbody></table>` : '<p class="empty">Noch keine Empfänger.</p>'}
  </div>
</div>
<div class="section">
  <h3>Empfänger hinzufügen</h3>
  <form method="POST" action="/admin/reporting/recipients" class="add-form">
    <input type="email" name="email" required placeholder="name@example.com" aria-label="E-Mail-Adresse">
    <button class="btn btn-primary">Hinzufügen</button>
  </form>
</div>
<script>
document.querySelectorAll('.sub-toggle').forEach(function (box) {
  box.addEventListener('change', function () {
    var state = document.getElementById('save-state');
    fetch('/admin/reporting/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientId: Number(box.dataset.recipient),
        reportType: box.dataset.type,
        propertySlug: box.dataset.slug,
        active: box.checked
      })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.textContent = 'gespeichert';
      setTimeout(function () { state.textContent = ''; }, 1500);
    }).catch(function (e) {
      box.checked = !box.checked;
      alert('Speichern fehlgeschlagen: ' + e.message);
    });
  });
});
</script>`;

  res.send(renderAdminPage({ title: 'Reporting', active: 'reporting', body }));
});

router.post('/subscriptions', express.json(), (req, res) => {
  const { recipientId, reportType, propertySlug, active } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof recipientId !== 'number' || !Number.isInteger(recipientId)) {
    return res.status(400).json({ error: 'recipientId muss eine ganze Zahl sein' });
  }
  if (!isReportType(reportType)) return res.status(400).json({ error: 'Unbekannter Report-Typ' });
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active muss true oder false sein' });

  let slug = '';
  if (isPerPropertyReportType(reportType)) {
    if (typeof propertySlug !== 'string' || !getAllProperties().some((p) => p.slug === propertySlug)) {
      return res.status(400).json({ error: 'Unbekanntes Objekt' });
    }
    if (!reportTypeAppliesTo(reportType, propertySlug)) {
      return res.status(400).json({ error: 'Report-Typ gilt für dieses Objekt nicht' });
    }
    slug = propertySlug;
  }
  if (!getRecipientById(recipientId)) return res.status(404).json({ error: 'Empfänger nicht gefunden' });

  setSubscription(recipientId, reportType, slug, active);
  return res.json({ ok: true });
});

router.post('/recipients', express.urlencoded({ extended: false }), (req, res) => {
  const parsed = emailSchema.safeParse(req.body?.email);
  if (!parsed.success) {
    return res.redirect(`/admin/reporting?error=${encodeURIComponent('Ungültige E-Mail-Adresse')}`);
  }
  const recipient = addRecipient(parsed.data);
  return res.redirect(`/admin/reporting?added=${encodeURIComponent(recipient.email)}`);
});

router.post('/recipients/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !removeRecipient(id)) return res.status(404).send('Empfänger nicht gefunden');
  return res.redirect('/admin/reporting');
});

export default router;
