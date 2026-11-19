// src/services/counter-offer-context.ts
// #1243: Gegenangebot-Notiz für eine Buchungsanfrage (Thread-Kopf, Buchungsanfrage-Task). Hängt
// Anfrage-Daten aus der DB (resolveThreadBookingSummary) mit den reinen Funktionen aus
// counter-offer.ts zusammen. Wirft nie — jeder Ausfall liefert null (die Notiz ist Zusatzinfo).
import type { Message, MessageThread } from '../types/messages.js';
import type { PropertyConfig } from '../config/properties.js';
import { resolveThreadBookingSummary } from './booking-context.js';
import {
  computeStayFacts, detectCounterOfferAmount, evaluateCounterOffer, formatCounterOfferNote,
} from './counter-offer.js';
import logger from '../utils/logger.js';

export function resolveCounterOfferNote(
  thread: MessageThread,
  messages: Message[],
  property: PropertyConfig | null,
  opts?: { onlyLatestGuestMessage?: boolean },
): string | null {
  try {
    const summary = resolveThreadBookingSummary(thread);
    if (!summary || summary.kind !== 'inquiry' || !summary.checkIn || !summary.checkOut) return null;
    const price = summary.guestPrice;
    let guestTotal: number;
    let estimated: boolean;
    if (price?.kind === 'estimated') { guestTotal = price.inclTax; estimated = true; }
    else if (price?.kind === 'actual') { guestTotal = price.total; estimated = false; }
    else return null; // accommodation (nicht vergleichbar) oder kein Gastpreis

    // Gastnachrichten von neu nach alt; die erste mit erkanntem Betrag zählt.
    const inbound = messages.filter((m) => m.direction === 'inbound');
    const candidates = opts?.onlyLatestGuestMessage ? inbound.slice(-1) : inbound;
    let offer: number | null = null;
    for (let i = candidates.length - 1; i >= 0 && offer == null; i--) {
      offer = detectCounterOfferAmount(candidates[i].body ?? '');
    }
    if (offer == null) return null;

    const stay = computeStayFacts(summary.checkIn, summary.checkOut, summary.requestedAt);
    const evaluation = evaluateCounterOffer({
      offer, guestTotal, currency: price.currency, stay, rule: property?.airbnbDiscount ?? null,
    });
    return evaluation ? formatCounterOfferNote(evaluation, estimated, stay) : null;
  } catch (err) {
    logger.warn({ threadId: thread.id, err: err instanceof Error ? err.message : String(err) }, 'counter-offer: Notiz nicht ermittelbar');
    return null;
  }
}
