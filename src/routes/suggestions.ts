// src/routes/suggestions.ts
import express from 'express';
import {
  getPendingSuggestions, getSuggestionById, markSuggestionApplied, discardSuggestion,
} from '../repositories/feedback-repository.js';
import { applySuggestion } from '../services/vault-writer.js';
import { renderAdminPage } from './admin-layout.js';

const router = express.Router();

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

router.get('/', (_req, res) => {
  const pending = getPendingSuggestions();
  const items = pending.map((s) => `
    <div class="section">
      <p class="subtitle" style="margin:0 0 8px"><span class="badge">${esc(s.target_file)}</span> → <span class="badge">${esc(s.target_heading)}</span></p>
      <div class="draft-preview">${esc(s.addition_text)}</div>
      <p class="subtitle">${esc(s.rationale)}</p>
      <div class="actions">
        <form method="POST" action="/admin/suggestions/${esc(s.id)}/approve"><button class="btn btn-primary">Freigeben & schreiben</button></form>
        <form method="POST" action="/admin/suggestions/${esc(s.id)}/discard"><button class="btn btn-danger">Verwerfen</button></form>
      </div>
    </div>`).join('');
  const body = `<a class="back-link" href="/admin/messages">&larr; Nachrichten</a>
    <h1>Vault-Vorschläge <span class="count-pill">${pending.length} offen</span></h1>
    <p class="subtitle">Vorschläge aus deinem Feedback. Freigeben schreibt die Ergänzung in den Vault und committet.</p>
    ${items || '<p class="empty">Keine offenen Vorschläge.</p>'}`;
  res.type('html').send(renderAdminPage({ title: 'Vault-Vorschläge', body }));
});

router.post('/:id/approve', (req, res, next) => {
  try {
    const s = getSuggestionById(req.params.id);
    if (!s) { res.status(404).send('Vorschlag nicht gefunden'); return; }
    if (s.status !== 'pending') { res.status(409).send('Vorschlag ist nicht mehr offen'); return; }
    const result = applySuggestion(s);
    if (!result.committed && result.error) { res.status(502).send(`Schreiben fehlgeschlagen: ${esc(result.error)}`); return; }
    markSuggestionApplied(s.id, result.commit);
    res.redirect('/admin/suggestions');
  } catch (e) { next(e); }
});

router.post('/:id/discard', (req, res, next) => {
  try {
    const s = getSuggestionById(req.params.id);
    if (!s) { res.status(404).send('Vorschlag nicht gefunden'); return; }
    discardSuggestion(s.id);
    res.redirect('/admin/suggestions');
  } catch (e) { next(e); }
});

export default router;
