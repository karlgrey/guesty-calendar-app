/**
 * Airbnb IMAP Client
 *
 * Connects to a dedicated bot inbox (e.g. Gmail/Google Workspace) and fetches
 * new messages since a given IMAP UID. Used by sync-mail.ts.
 *
 * See docs/superpowers/specs/2026-05-18-airbnb-mail-integration-design.md
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { ExternalApiError } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import type { RawMail } from '../../types/airbnb-mail.js';

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox?: string;
}

export class AirbnbImapClient {
  private readonly config: ImapConfig;
  private client: ImapFlow | null = null;

  constructor(config: ImapConfig) {
    this.config = { mailbox: 'INBOX', ...config };
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
      await this.client.mailboxOpen(this.config.mailbox!);
    } catch (error) {
      logger.error({ error, host: this.config.host, user: this.config.user }, 'IMAP connect failed');
      throw new ExternalApiError(
        `IMAP connect failed: ${error instanceof Error ? error.message : 'unknown'}`,
        0,
        'Airbnb-IMAP'
      );
    }
  }

  async fetchNewMails(sinceUid: number): Promise<RawMail[]> {
    if (!this.client) throw new Error('IMAP client not connected');
    const out: RawMail[] = [];
    const searchRange = sinceUid > 0 ? `${sinceUid + 1}:*` : '1:*';

    for await (const msg of this.client.fetch(searchRange, {
      uid: true,
      envelope: true,
      source: true,
    })) {
      try {
        const parsed = await simpleParser(msg.source as Buffer);
        out.push({
          uid: msg.uid,
          messageId: parsed.messageId ?? `imap-uid-${msg.uid}@unknown`,
          subject: parsed.subject ?? '',
          fromAddress: parsed.from?.text ?? '',
          receivedAt: (parsed.date ?? new Date()).toISOString(),
          htmlBody: typeof parsed.html === 'string' ? parsed.html : '',
          textBody: parsed.text ?? '',
        });
      } catch (error) {
        logger.warn({ error, uid: msg.uid }, 'Failed to parse mail, skipping');
      }
    }
    return out;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // ignore — connection may already be dead
      }
      this.client = null;
    }
  }
}
