/**
 * Admin-Formular „Zeit-Abweichung" in der Thread-Ansicht (#799).
 * Ruft denselben Service wie die Agent-API (`stay-times-service.ts`, source 'admin') —
 * kein zweiter Code-Pfad. Keine Gebühren, keine Datums-/Personenänderung.
 */
import type { StayTimesView, StayTimesInput } from '../services/stay-times-service.js';

function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

const SOURCE_LABEL = { override: 'Abweichung', provider: 'Provider', default: 'Standard' } as const;
const label = (src: keyof typeof SOURCE_LABEL | null) => (src ? SOURCE_LABEL[src] : 'unbekannt');

export interface TimesPanelQuery { times?: unknown; timeserr?: unknown; calsync?: unknown }

function notice(q: TimesPanelQuery): string {
  const style = 'background:var(--color-sand);padding:10px 14px;border-radius:8px';
  if (typeof q.timeserr === 'string' && q.timeserr) {
    return `<p class="subtitle" style="${style};border-left:4px solid var(--color-danger,#b3261e)">${esc(q.timeserr)}</p>`;
  }
  if (q.times === 'saved' || q.times === 'deleted') {
    const cal = q.calsync === '0' ? ' Kalender wird beim nächsten Lauf aktualisiert.' : q.calsync === '1' ? ' Kalender aktualisiert.' : '';
    return `<p class="subtitle" style="${style};border-left:4px solid var(--color-forest)">${q.times === 'saved' ? 'Zeit-Abweichung gespeichert.' : 'Zeit-Abweichung gelöscht.'}${esc(cal)}</p>`;
  }
  return '';
}

export function renderTimesPanel(threadId: string, view: StayTimesView, q: TimesPanelQuery = {}): string {
  const t = view.times;
  const o = t.override;
  const action = `/admin/messages/${encodeURIComponent(threadId)}/times`;
  const eff = `Ankunft <strong>${esc(t.effectiveArrival ?? '–')}</strong> (${label(t.arrivalSource)}) · `
    + `Abreise <strong>${esc(t.effectiveDeparture ?? '–')}</strong> (${label(t.departureSource)})`;
  const std = `Listing-Standard: ${esc(t.listingDefaultArrival ?? '–')} / ${esc(t.listingDefaultDeparture ?? '–')}`;
  const state = o
    ? `<span class="badge" style="background:var(--color-amber)">Abweichung aktiv</span>${o.blockNextDay ? ' <span class="badge">Folgetag geblockt</span>' : ''}`
    : '<span class="badge">keine Abweichung</span>';
  return `<div class="section">
    <h3>Zeit-Abweichung</h3>
    ${notice(q)}
    <p class="subtitle">${esc(view.checkIn)} → ${esc(view.checkOut)} · ${eff}<br>${std} · ${state}</p>
    <form method="POST" action="${action}">
      <div class="actions" style="align-items:flex-end;gap:12px;flex-wrap:wrap">
        <label>Ankunft (HH:mm)<br><input type="time" name="plannedArrival" value="${esc(o?.plannedArrival ?? '')}"></label>
        <label>Abreise (HH:mm)<br><input type="time" name="plannedDeparture" value="${esc(o?.plannedDeparture ?? '')}"></label>
        ${view.blocksNextDay ? `<label><input type="checkbox" name="blockNextDay" value="1"${o?.blockNextDay ? ' checked' : ''}> Folgetag blocken</label>` : ''}
      </div>
      <textarea name="note" rows="2" maxlength="500" placeholder="Notiz (z. B. per Chat zugesagt)" style="margin-top:10px">${esc(o?.note ?? '')}</textarea>
      <p class="subtitle" style="margin:6px 0">Leeres Zeitfeld = Provider-/Standardzeit gilt. Die Crew sieht die Abweichung als Marker im Kalender.</p>
      <div class="actions"><button type="submit" class="btn btn-primary">Speichern</button></div>
    </form>
    ${o ? `<form method="POST" action="${action}/delete" style="margin-top:8px"><button type="submit" class="btn btn-danger">Abweichung löschen</button></form>` : ''}
  </div>`;
}

/** Form-Body -> Service-Input (leere Zeitfelder = null = zurücksetzen; Checkbox nur, wenn das Objekt sie hat). */
export function timesFormToInput(body: Record<string, unknown> | undefined, includeBlock: boolean): StayTimesInput {
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const input: StayTimesInput = {
    plannedArrival: str(body?.plannedArrival),
    plannedDeparture: str(body?.plannedDeparture),
    note: str(body?.note),
  };
  if (includeBlock) input.blockNextDay = body?.blockNextDay === '1' || body?.blockNextDay === 'on';
  return input;
}
