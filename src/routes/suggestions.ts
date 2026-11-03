// src/routes/suggestions.ts
import express from 'express';
import {
  getSuggestionsByStatus, getSuggestionById, discardSuggestion,
} from '../repositories/feedback-repository.js';
import { approveVaultSuggestion, revokeVaultSuggestion } from '../services/vault-suggestion-service.js';
import { renderAdminPage } from './admin-layout.js';
import type { SuggestionStatus, VaultSuggestion } from '../types/feedback.js';

const router = express.Router();

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

const TABS: { status: SuggestionStatus; label: string }[] = [
  { status: 'pending', label: 'Offen' },
  { status: 'approved', label: 'Freigegeben' },
  { status: 'revoked', label: 'Zurückgezogen' },
  { status: 'discarded', label: 'Verworfen' },
];

function parseStatus(raw: unknown): SuggestionStatus {
  return TABS.find((t) => t.status === raw)?.status ?? 'pending';
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '–';
}

function renderActions(s: VaultSuggestion): string {
  const id = esc(s.id);
  if (s.status === 'pending') {
    return `<form method="POST" action="/admin/suggestions/${id}/approve"><button class="btn btn-primary">Freigeben & schreiben</button></form>
        <form method="POST" action="/admin/suggestions/${id}/discard"><button class="btn btn-danger">Verwerfen</button></form>`;
  }
  if (s.status === 'approved') {
    return `<form method="POST" action="/admin/suggestions/${id}/revoke" onsubmit="return confirm('Vorschlag zurückziehen? Die Zeile wird aus dem Vault entfernt und committet.')"><button class="btn btn-danger">Zurückziehen</button></form>`;
  }
  if (s.status === 'revoked') {
    return `<form method="POST" action="/admin/suggestions/${id}/approve"><button class="btn btn-primary">Erneut freigeben</button></form>`;
  }
  return '';
}

function renderMeta(s: VaultSuggestion): string {
  if (s.status === 'approved') {
    return `<p class="subtitle">Freigegeben ${esc(s.applied_at)} · Commit <code>${esc(shortSha(s.applied_commit))}</code></p>`;
  }
  if (s.status === 'revoked') {
    return `<p class="subtitle">Zurückgezogen ${esc(s.revoked_at)} · Revoke-Commit <code>${esc(shortSha(s.revoke_commit))}</code></p>`;
  }
  return '';
}

router.get('/', (req, res) => {
  const status = parseStatus(req.query.status);
  const list = getSuggestionsByStatus(status);
  const pushNotice = req.query.push === 'pending'
    ? '<p class="subtitle">⚠️ Vault committet, Push zu GitHub ausstehend — wird beim nächsten Sync automatisch nachgeholt.</p>'
    : '';
  const tabs = TABS.map((t) => t.status === status
    ? `<strong>${esc(t.label)}</strong>`
    : `<a href="/admin/suggestions?status=${t.status}">${esc(t.label)}</a>`).join(' · ');
  const items = list.map((s) => `
    <div class="section">
      <p class="subtitle" style="margin:0 0 8px"><span class="badge">${esc(s.target_file)}</span> → <span class="badge">${esc(s.target_heading)}</span></p>
      <div class="draft-preview">${esc(s.addition_text)}</div>
      <p class="subtitle">${esc(s.rationale)}</p>
      ${renderMeta(s)}
      <div class="actions">
        ${renderActions(s)}
      </div>
    </div>`).join('');
  const countLabel = status === 'pending' ? `${list.length} offen` : String(list.length);
  const body = `<a class="back-link" href="/admin/messages">&larr; Nachrichten</a>
    <h1>Vault-Vorschläge <span class="count-pill">${esc(countLabel)}</span></h1>
    <p class="subtitle">Vorschläge aus deinem Feedback. Freigeben schreibt die Ergänzung in den Vault und committet; Zurückziehen entfernt sie wieder.</p>
    <p class="subtitle">${tabs}</p>
    ${pushNotice}
    ${items || '<p class="empty">Keine Vorschläge in diesem Status.</p>'}`;
  res.type('html').send(renderAdminPage({ title: 'Vault-Vorschläge', body, active: 'suggestions' }));
});

router.post('/:id/approve', (req, res, next) => {
  try {
    const result = approveVaultSuggestion(req.params.id);
    if (!result.ok) { res.status(result.status).send(esc(result.error)); return; }
    res.redirect(result.pushed ? '/admin/suggestions' : '/admin/suggestions?push=pending');
  } catch (e) { next(e); }
});

router.post('/:id/revoke', (req, res, next) => {
  try {
    const result = revokeVaultSuggestion(req.params.id);
    if (!result.ok) { res.status(result.status).send(esc(result.error)); return; }
    res.redirect(result.pushed || result.alreadyRevoked
      ? '/admin/suggestions?status=approved'
      : '/admin/suggestions?status=approved&push=pending');
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
