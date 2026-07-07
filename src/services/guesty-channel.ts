// src/services/guesty-channel.ts
import type { Message } from '../types/messages.js';

/**
 * Resolve the Guesty module.type for an outbound reply by mirroring the channel
 * of the LAST inbound guest message (its raw_meta.type, stored by
 * sync-guesty-messages). Strictly the last inbound counts — 'log', missing type,
 * unparseable raw_meta or no inbound at all → null, and callers MUST withhold
 * the send option (reply manually in the Guesty inbox instead).
 */
export function resolveOutboundModuleType(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction !== 'inbound') continue;
    try {
      const meta = m.raw_meta ? (JSON.parse(m.raw_meta) as { type?: unknown }) : null;
      const type = typeof meta?.type === 'string' ? meta.type : null;
      return type && type !== 'log' ? type : null;
    } catch {
      return null;
    }
  }
  return null;
}
