/**
 * Property lookup for a message thread — shared by the admin Nachrichten-UI
 * (src/routes/messages.ts) and the read-only Agent API (src/routes/agent-api.ts)
 * so both resolve the same Property-Badge for a thread.
 */
import { getPropertyByGuestyId, getPropertyByHostexId, type PropertyConfig } from '../config/properties.js';

// Provider-aware property lookup: threads store the provider-native listing id.
export function getPropertyForThread(thread: { source: string; listing_id: string | null }): PropertyConfig | undefined {
  if (!thread.listing_id) return undefined;
  if (thread.source === 'hostex') return getPropertyByHostexId(thread.listing_id);
  if (thread.source === 'guesty') return getPropertyByGuestyId(thread.listing_id);
  return undefined;
}

// Property fürs Listen-Badge/-Tint (FH, U19, AS, BH …). Gmail-Threads tragen die
// Guesty-Listing-ID als listing_id, daher der generische Fallback über beide IDs.
export function propertyForBadge(thread: { source: string; listing_id: string | null }): PropertyConfig | undefined {
  return (
    getPropertyForThread(thread) ??
    (thread.listing_id
      ? getPropertyByGuestyId(thread.listing_id) ?? getPropertyByHostexId(thread.listing_id)
      : undefined)
  );
}
