/**
 * Direct-email IMAP client.
 *
 * Reads a Gmail label (e.g. "Booking-Farmhouse") and returns parsed messages
 * with all the threading headers we need (Message-ID, In-Reply-To, References,
 * X-GM-THRID). Used by sync-direct-email-messages.ts to build conversation
 * threads on the host side.
 *
 * Distinct from AirbnbImapClient because:
 *   - We need richer headers (to-address, in-reply-to, references)
 *   - We pull both inbound + outbound (Gmail filter places both in the label)
 *   - We extract X-GM-THRID for Gmail-native threading
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { ExternalApiError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export interface DirectEmailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
}

export interface DirectMail {
  uid: number;
  messageId: string;
  threadId: string | null;        // X-GM-THRID if available (Gmail native threading)
  subject: string;
  fromAddress: string;            // raw "Name <addr>" form
  fromName: string | null;
  fromEmail: string | null;
  toAddress: string;              // raw to header
  toEmail: string | null;
  inReplyTo: string | null;
  references: string[];
  receivedAt: string;             // ISO 8601
  htmlBody: string;
  textBody: string;
}

function parseAddress(addr: any): { name: string | null; email: string | null } {
  if (!addr || !addr.value || addr.value.length === 0) return { name: null, email: null };
  const first = addr.value[0];
  return {
    name: first.name || null,
    email: first.address || null,
  };
}

export class DirectEmailClient {
  private readonly config: DirectEmailConfig;
  private client: ImapFlow | null = null;

  constructor(config: DirectEmailConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
    });
    try {
      await this.client.connect();
      await this.client.mailboxOpen(this.config.mailbox);
    } catch (error) {
      logger.error(
        { error, mailbox: this.config.mailbox, host: this.config.host },
        'Direct-email IMAP connect failed',
      );
      throw new ExternalApiError(
        `IMAP connect failed for label '${this.config.mailbox}': ${error instanceof Error ? error.message : 'unknown'}`,
        0,
        'Direct-Email-IMAP',
      );
    }
  }

  /**
   * Fetch every message in the label whose UID > sinceUid.
   * Returns them in chronological order (lowest UID first).
   */
  async fetchNewMails(sinceUid: number): Promise<DirectMail[]> {
    if (!this.client) throw new Error('IMAP client not connected');
    const out: DirectMail[] = [];
    const searchRange = sinceUid > 0 ? `${sinceUid + 1}:*` : '1:*';

    // Gmail exposes X-GM-THRID via the X-GM-EXT-1 IMAP extension.
    // ImapFlow surfaces it natively when we request `threadId: true`.
    for await (const msg of this.client.fetch(searchRange, {
      uid: true,
      envelope: true,
      source: true,
      threadId: true,
    })) {
      try {
        const parsed = await simpleParser(msg.source as Buffer);
        const fromInfo = parseAddress(parsed.from);
        const firstTo = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
        const toInfo = parseAddress(firstTo);

        const referencesRaw = parsed.references;
        const references = Array.isArray(referencesRaw)
          ? referencesRaw
          : typeof referencesRaw === 'string'
            ? referencesRaw.split(/\s+/).filter(Boolean)
            : [];

        out.push({
          uid: msg.uid,
          messageId: parsed.messageId ?? `imap-uid-${msg.uid}@unknown`,
          threadId: msg.threadId ?? null,
          subject: parsed.subject ?? '',
          fromAddress: parsed.from?.text ?? '',
          fromName: fromInfo.name,
          fromEmail: fromInfo.email,
          toAddress: (Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to?.text) ?? '',
          toEmail: toInfo.email,
          inReplyTo: parsed.inReplyTo ?? null,
          references,
          receivedAt: (parsed.date ?? new Date()).toISOString(),
          htmlBody: typeof parsed.html === 'string' ? parsed.html : '',
          textBody: parsed.text ?? '',
        });
      } catch (error) {
        logger.warn({ error, uid: msg.uid }, 'Direct-email: failed to parse mail, skipping');
      }
    }
    return out;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
  }
}
