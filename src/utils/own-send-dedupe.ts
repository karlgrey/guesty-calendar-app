import type { Message } from '../types/messages.js';

/** Max. Zeitabstand zwischen lokaler Sende-Zeile und Hostex-Echo (2 min). */
export const ECHO_WINDOW_MS = 120_000;
/** Beobachteter Versatz der Hostex-Hostzeit gegenüber unserer Serverzeit während Sommerzeit (1 h). */
export const ECHO_DST_OFFSET_MS = 3_600_000;

interface OwnMeta { draftId: string; externalMessageId: string }

function parseOwnMeta(m: Message): OwnMeta | null {
  if (m.direction !== 'outbound' || !m.raw_meta) return null;
  try {
    const meta = JSON.parse(m.raw_meta) as Record<string, unknown> | null;
    if (!meta || typeof meta !== 'object' || typeof meta.draftId !== 'string') return null;
    const ext = meta.externalMessageId;
    return { draftId: meta.draftId, externalMessageId: ext === null || ext === undefined ? '' : String(ext) };
  } catch {
    return null;
  }
}

function stripPrefix(id: string, source: string): string {
  const p = `${source}:`;
  return id.startsWith(p) ? id.slice(p.length) : id;
}

function normBody(b: string): string {
  return (b ?? '').replace(/\r\n/g, '\n').trim().replace(/\s+/g, ' ');
}

/** Abweichung vom erlaubten Zeitversatz (0 / 1 h) oder null, wenn außerhalb der Toleranz. */
function timeDeviation(a: number, b: number): number | null {
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const d = Math.abs(a - b);
  const dev = Math.min(d, Math.abs(d - ECHO_DST_OFFSET_MS));
  return dev <= ECHO_WINDOW_MS ? dev : null;
}

/**
 * Entfernt lokale Sende-Zeilen (raw_meta.draftId), wenn der Sync dieselbe Nachricht
 * bereits als Echo unter anderer ID geliefert hat. Rein lesend (keine DB-Änderung).
 * Das Echo bleibt, übernimmt aber das sent_at der eigenen Zeile (Serverzeit ist
 * verifiziert; Hostex-Hostzeit war im Sommerzeit-Fall um 1 h verschoben).
 * Ausgabe aufsteigend nach sent_at (stabil); unparsebare Zeiten kommen ans Ende
 * in Eingabereihenfolge. Eingabe wird nicht mutiert.
 */
export function dedupeOwnSendEchoes(messages: Message[]): Message[] {
  const items = messages.map((m) => ({ ...m }));
  const owns: { m: Message; meta: OwnMeta }[] = [];
  const echoes: Message[] = [];
  for (const m of items) {
    const meta = parseOwnMeta(m);
    if (meta) owns.push({ m, meta });
    else if (m.direction === 'outbound') echoes.push(m);
  }

  const usedEchoes = new Set<Message>();
  const droppedOwns = new Set<Message>();

  for (const { m: o, meta } of owns) {
    let match: Message | null = null;

    // a) ID-Match
    const ext = stripPrefix(meta.externalMessageId, o.source);
    if (ext) {
      match = echoes.find((e) => !usedEchoes.has(e) && e.thread_id === o.thread_id && e.source === o.source
        && stripPrefix(e.id, e.source) === ext) ?? null;
    }

    // b) Text + Zeitfenster
    if (!match) {
      const body = normBody(o.body);
      const ot = Date.parse(o.sent_at);
      let best = Infinity;
      for (const e of echoes) {
        if (usedEchoes.has(e) || e.thread_id !== o.thread_id || e.source !== o.source) continue;
        if (normBody(e.body) !== body) continue;
        const dev = timeDeviation(ot, Date.parse(e.sent_at));
        if (dev !== null && dev < best) { best = dev; match = e; }
      }
    }

    if (match) {
      usedEchoes.add(match);
      droppedOwns.add(o);
      match.sent_at = o.sent_at;
    }
  }

  const kept = items.filter((m) => !droppedOwns.has(m));
  const ts = (m: Message) => { const t = Date.parse(m.sent_at); return Number.isNaN(t) ? Infinity : t; };
  return kept
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ta = ts(a.m), tb = ts(b.m);
      if (ta === tb) return a.i - b.i;
      return ta < tb ? -1 : 1;
    })
    .map((x) => x.m);
}
