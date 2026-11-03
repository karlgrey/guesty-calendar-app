// src/mappers/hostex/alteration-card.ts
// #976 (Prüfer-Korrektur): reine Erkennung des offenen Änderungsantrags aus den Hostex-System-
// Karten — ohne DB-Import, damit message-mapper.ts (Regel: Mapper sind pure functions) nicht
// transitiv das Reservation-Repository zieht. Fachliche Einordnung und Heuristik:
// src/services/alteration-request.ts (re-exportiert diese Typen/Funktion).

export interface PendingAlteration {
  /** created_at der Antrags-Karte (ISO, wie von Hostex geliefert). */
  requestedAt: string;
  /** Anzeigetext der Karte (z. B. „Nov 20 ~ Nov 21 ・ 3 guests") — nur Anzeige, keine Logik. */
  describe: string | null;
}

/** Minimale Form einer Hostex-Conversation-Nachricht inkl. System-Karten-Attachment. */
export interface HostexCardLike {
  display_type: string;
  content?: string | null;
  created_at?: string | null;
  attachment?: { subject?: string | null; describe?: string | null } | null;
}

function ms(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return Date.parse(iso);
}

function closesAlteration(m: HostexCardLike): boolean {
  if (m.display_type !== 'Box') return false;
  const c = (m.content ?? '').toLowerCase();
  return c.includes('alteration') || c.includes('cancel');
}

/**
 * Offener Änderungsantrag = jüngste ReservationAlteration-Karte, nach der keine schließende Box
 * („Alteration request accepted", Storno o. ä.) kam. Reihenfolge der Eingabe egal (Hostex
 * liefert neueste zuerst) — entschieden wird über created_at.
 */
export function detectPendingHostexAlteration(messages: readonly HostexCardLike[]): PendingAlteration | null {
  let latestCard: HostexCardLike | null = null;
  let latestClose = -Infinity;
  for (const m of messages) {
    const t = ms(m.created_at);
    if (Number.isNaN(t)) continue;
    if (m.display_type === 'ReservationAlteration') {
      if (!latestCard || t > ms(latestCard.created_at)) latestCard = m;
    } else if (closesAlteration(m)) {
      if (t > latestClose) latestClose = t;
    }
  }
  if (!latestCard) return null;
  if (latestClose >= ms(latestCard.created_at)) return null;
  const describe = latestCard.attachment?.describe?.trim() || null;
  return { requestedAt: latestCard.created_at as string, describe };
}
