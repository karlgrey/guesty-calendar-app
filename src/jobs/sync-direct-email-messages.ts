/**
 * Sync direct-booking emails from a Gmail label into message_threads/messages.
 *
 * Strategy:
 * 1. Open the property's configured Gmail label via IMAP
 * 2. Fetch all messages with UID > last_synced_uid
 * 3. Filter out Airbnb-originated mails (sender domain check) — those come from Guesty
 * 4. Group by Gmail X-GM-THRID for threading; fall back to In-Reply-To / Subject
 * 5. Determine direction from sender: host email → outbound, anything else → inbound
 * 6. Upsert threads + messages (classification deferred to classify-threads.ts)
 *
 * Idempotent. UID watermark stored in direct_email_state.
 */

import { config } from '../config/index.js';
import { DirectEmailClient, type DirectMail } from '../services/direct-email-client.js';
import {
  upsertThread,
  upsertMessage,
  getLastEmailUid,
  setLastEmailUid,
  getMessagesByThread,
} from '../repositories/message-repository.js';
import {
  matchThreadToReservation,
  type ReservationMatcherCandidate,
} from '../utils/thread-reservation-matcher.js';
import { getDatabase } from '../db/index.js';
import logger from '../utils/logger.js';
import type { PropertyConfig } from '../config/properties.js';
import type {
  NewMessage,
  NewMessageThread,
} from '../types/messages.js';

export interface DirectEmailSyncResult {
  success: boolean;
  fetched: number;
  platformFiltered: number;
  hostInitiatedFiltered: number;
  upserted: number;
  threadsTouched: number;
  durationMs: number;
  error?: string;
}

// Mails to skip — these are platform notifications, transactional mails,
// or messages forwarded via the booking@ distribution list (which redistributes
// Airbnb/Booking.com/PayPal notifications).
//
// We already capture Airbnb conversations via the Guesty /communication/conversations
// API and Booking.com conversations via the same API. Direct-email sync should
// only capture genuine off-platform host-guest correspondence.

const SKIP_FROM_EMAILS = new Set<string>([
  // The booking@ distribution list is a forward-only alias; anything FROM it
  // is a re-broadcast of a platform notification, never an original guest email.
  // (Real guest emails sent TO booking@ have the actual guest in the From: header.)
  'booking@remoterepublic.com',
]);

const SKIP_FROM_DOMAINS = new Set<string>([
  // Airbnb — also covered by Guesty conversation API
  'airbnb.com',
  'reply.airbnb.com',
  'reply2.airbnb.com',
  'mail.airbnb.com',
  // Booking.com — covered by Guesty
  'booking.com',
  'reply.booking.com',
  // Transactional / financial
  'paypal.com',
  'paypal.de',
  'stripe.com',
]);

// Subject-pattern based filter for forwarded platform mails where the
// sender domain is rewritten (e.g. forwarded via booking@distribution-list).
// These subjects are unmistakably from a booking platform.
const SKIP_SUBJECT_PATTERNS: RegExp[] = [
  // Airbnb host notifications (German)
  /^Buchung\s+best[äa]tigt/i,
  /^Buchungs?erinnerung/i,
  /^Anfrage\s+für\s+[„"]/i,
  /^Deine\s+Buchungs[äa]nderung/i,
  /^Buchung\s+aktualisiert/i,
  /^Ausstehend:\s+Buchung/i,
  /möchte\s+die\s+Buchung\s+ändern/i,
  /^Neue\s+Nachricht\s+vom\s+Airbnb-Support/i,
  /^Dein\s+Best[äa]tigungscode/i,
  /^Wir\s+haben\s+eine\s+Auszahlung/i,
  /^RE:\s+Buchung\s+für\s+[„"]/i,
  /^RE:\s+Erkundigung\s+für\s+[„"]/i,
  // Booking.com
  /^RE:\s+Buchung\s+der\s+Unterkunft/i,
  /Know\s+Your\s+Partner/i,
  /Booking\.com/i,
  // PayPal
  /^Beleg\s+für\s+Ihre\s+PayPal-Zahlung/i,
  // Spam-report / list moderation noise
  /^Moderator['']?s\s+spam\s+report/i,
  // Platform marketing
  /^(No\s+more\s+empty\s+beds|Turn\s+your\s+page|Stand\s+out\s+in\s+search)/i,
];

// Marketing / transactional / bulk patterns — non-conversational noise.
const SKIP_BULK_SUBJECT_PATTERNS: RegExp[] = [
  // Order / shipping / invoice
  /^Deine\s+Bestellung/i,
  /^Danke\s+für\s+deine\s+Bestellung/i,
  /^Versandbest[äa]tigung/i,
  /^Deine\s+Rechnung/i,
  /Bestellnummer/i,
  // Review requests
  /^Hilf\s+uns\s+mit\s+deiner\s+Bewertung/i,
  /^Bitte\s+bewerte/i,
  /Bewertung\s+abgeben/i,
  // Newsletters / marketing campaigns
  /^Newsletter\b/i,
  /^\[Newsletter\]/i,
  /^Update\s+(von|aus|für)/i,
  /^News\s+(von|aus)/i,
  // System / account
  /^Airbnb-Account\s+von/i,
  /^Smoobu-Account/i,
  // Emoji-leading subjects are a very strong marketing signal
  // (legit business mails almost never start with an emoji)
  /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
];

// Sender local-parts that indicate transactional / marketing / no-reply.
// Conservative list — only patterns that are basically never used by real guests.
const SKIP_LOCAL_PARTS = new Set<string>([
  'shop', 'store', 'sales',
  'noreply', 'no-reply', 'do-not-reply', 'donotreply',
  'notifications', 'notification', 'notify', 'alerts',
  'newsletter', 'news',
  'marketing', 'mailings', 'campaigns',
]);

// True if the mail should be skipped (platform notification, transactional,
// marketing, newsletter, automated bulk). Conservative — only filters when
// at least one strong signal is present, so real conversations are never lost.
function shouldSkipMail(mail: DirectMail): { skip: boolean; reason: string | null } {
  const fromEmail = (mail.fromEmail || '').toLowerCase();
  const fromAddr = (mail.fromAddress || '').toLowerCase();
  const subject = mail.subject || '';

  // (1) Known platform forwards (booking@-list, airbnb/booking/paypal domains)
  if (fromEmail && SKIP_FROM_EMAILS.has(fromEmail)) return { skip: true, reason: 'platform-list' };
  const domain = fromEmail.split('@')[1];
  if (domain && SKIP_FROM_DOMAINS.has(domain)) return { skip: true, reason: 'platform-domain' };
  for (const d of SKIP_FROM_DOMAINS) {
    if (fromAddr.includes('@' + d + '>') || fromAddr.endsWith('@' + d)) {
      return { skip: true, reason: 'platform-domain' };
    }
  }

  // (2) Bulk-mail headers — the universal signal for newsletters & marketing
  // (set by every ESP: Mailchimp, Resend, Sendgrid, Klaviyo, etc.)
  if (mail.listUnsubscribe) return { skip: true, reason: 'list-unsubscribe-header' };
  if (mail.precedence && /^(bulk|list|junk)$/i.test(mail.precedence.trim())) {
    return { skip: true, reason: 'precedence-bulk' };
  }
  if (mail.autoSubmitted && !/^no$/i.test(mail.autoSubmitted.trim())) {
    return { skip: true, reason: 'auto-submitted' };
  }

  // (3) Sender local-part patterns — shop@, noreply@, newsletter@, etc.
  const localPart = fromEmail.split('@')[0];
  if (localPart && SKIP_LOCAL_PARTS.has(localPart)) {
    return { skip: true, reason: 'sender-local-part' };
  }

  // (4) Platform-notification subjects (forwarded with rewritten sender)
  if (SKIP_SUBJECT_PATTERNS.some((re) => re.test(subject))) {
    return { skip: true, reason: 'platform-subject' };
  }

  // (5) Bulk / transactional / marketing subjects
  if (SKIP_BULK_SUBJECT_PATTERNS.some((re) => re.test(subject))) {
    return { skip: true, reason: 'bulk-subject' };
  }

  return { skip: false, reason: null };
}

// Host emails — outbound direction. Anything else → inbound.
// Each property has booking@… (recipient) AND mic@dynamicdudes.com (your personal).
// We treat both as host. Extend the list if other team members reply.
function isFromHost(mail: DirectMail, property: PropertyConfig): boolean {
  const hostEmails = new Set<string>(
    [
      property.bookingRecipientEmail,
      'mic@dynamicdudes.com',
      'micha@remoterepublic.com',
    ]
      .filter(Boolean)
      .map((s) => s!.toLowerCase()),
  );
  if (mail.fromEmail && hostEmails.has(mail.fromEmail.toLowerCase())) return true;
  // Fallback: From contains domain
  const hostDomains = ['remoterepublic.com', 'dynamicdudes.com', 'farmhouse-prasser.de'];
  if (mail.fromAddress) {
    const lower = mail.fromAddress.toLowerCase();
    if (hostDomains.some((d) => lower.includes(`@${d}>`) || lower.endsWith(`@${d}`))) return true;
  }
  return false;
}

function deriveThreadId(mail: DirectMail): string {
  if (mail.threadId) return `gmail:${mail.threadId}`;
  // Fall back: use earliest reference (root of thread) or message-id itself
  const root = mail.references[0] ?? mail.inReplyTo ?? mail.messageId;
  return `gmail-thr:${root}`;
}

interface ThreadBucket {
  threadId: string;
  listingId: string;
  guestName: string | null;
  guestEmail: string | null;
  channel: 'direct_email';
  mails: DirectMail[];
}

function buildBuckets(mails: DirectMail[], property: PropertyConfig): ThreadBucket[] {
  const byThread = new Map<string, ThreadBucket>();
  for (const mail of mails) {
    const tid = deriveThreadId(mail);
    let bucket = byThread.get(tid);
    if (!bucket) {
      bucket = {
        threadId: tid,
        listingId: property.guestyPropertyId ?? property.hostexPropertyId ?? property.airbnbListingId!,
        guestName: null,
        guestEmail: null,
        channel: 'direct_email',
        mails: [],
      };
      byThread.set(tid, bucket);
    }
    bucket.mails.push(mail);
  }

  // Determine guest name/email per thread = the first inbound participant
  for (const bucket of byThread.values()) {
    const sorted = [...bucket.mails].sort((a, b) =>
      a.receivedAt.localeCompare(b.receivedAt),
    );
    for (const mail of sorted) {
      if (!isFromHost(mail, property)) {
        bucket.guestName = mail.fromName;
        bucket.guestEmail = mail.fromEmail;
        break;
      }
    }
  }

  return [...byThread.values()];
}

export async function syncDirectEmailMessagesForProperty(
  property: PropertyConfig,
): Promise<DirectEmailSyncResult> {
  const start = Date.now();
  const slug = property.slug;
  const label = property.directEmailLabel;

  if (!label) {
    return {
      success: false,
      fetched: 0,
      platformFiltered: 0,
      hostInitiatedFiltered: 0,
      upserted: 0,
      threadsTouched: 0,
      durationMs: 0,
      error: 'No directEmailLabel configured for property',
    };
  }
  if (!config.airbnbMailHost || !config.airbnbMailUser || !config.airbnbMailPassword) {
    return {
      success: false,
      fetched: 0,
      platformFiltered: 0,
      hostInitiatedFiltered: 0,
      upserted: 0,
      threadsTouched: 0,
      durationMs: 0,
      error: 'AIRBNB_MAIL_* env vars not configured (shared IMAP credentials)',
    };
  }

  const listingId =
    property.guestyPropertyId ?? property.hostexPropertyId ?? property.airbnbListingId;
  if (!listingId) {
    return {
      success: false,
      fetched: 0,
      platformFiltered: 0,
      hostInitiatedFiltered: 0,
      upserted: 0,
      threadsTouched: 0,
      durationMs: 0,
      error: 'No listing id resolvable for property',
    };
  }

  const client = new DirectEmailClient({
    host: config.airbnbMailHost,
    port: config.airbnbMailPort,
    user: config.airbnbMailUser,
    password: config.airbnbMailPassword,
    mailbox: label,
  });

  try {
    await client.connect();
    const sinceUid = getLastEmailUid(slug);
    const all = await client.fetchNewMails(sinceUid);
    logger.info({ slug, label, sinceUid, fetched: all.length }, 'Direct-email: fetched mails');

    // Apply skip filter once per mail; collect per-reason stats for transparency.
    const skipReasons: Record<string, number> = {};
    const relevant: DirectMail[] = [];
    for (const m of all) {
      const decision = shouldSkipMail(m);
      if (decision.skip) {
        skipReasons[decision.reason ?? 'unknown'] = (skipReasons[decision.reason ?? 'unknown'] ?? 0) + 1;
      } else {
        relevant.push(m);
      }
    }
    const platformFiltered = all.length - relevant.length;
    if (platformFiltered > 0) {
      logger.info({ slug, platformFiltered, reasons: skipReasons }, 'Direct-email: skip-filter breakdown');
    }

    // Advance the UID watermark past EVERYTHING we fetched, including filtered
    // mails. Otherwise the next poll would re-process them indefinitely.
    let maxUid = sinceUid;
    for (const m of all) maxUid = Math.max(maxUid, m.uid);

    let upserted = 0;
    const now = new Date().toISOString();

    const rawBuckets = buildBuckets(relevant, property);

    // Thread-level filter for host-initiated outreach (cold pitches, journalist
    // outreach, forwarded marketing). Only skip threads where the host is
    // clearly the initiator AND there's no substantial conversation back:
    //   • All messages from host (pure monologue, no reply received), OR
    //   • Earliest message from host AND total ≤ 2 messages (pitch + nothing
    //     or pitch + brief decline).
    // Threads with 3+ messages get a pass — Gmail sometimes back-threads an
    // old pitch with a much later genuine inquiry; the conversation is real.
    let hostInitiatedFiltered = 0;
    const buckets: typeof rawBuckets = [];
    for (const b of rawBuckets) {
      const sorted = [...b.mails].sort((a, b2) => a.receivedAt.localeCompare(b2.receivedAt));
      const earliestIsHost = isFromHost(sorted[0], property);
      const allHost = sorted.every((m) => isFromHost(m, property));
      const shortPitch = earliestIsHost && sorted.length <= 2;
      if (allHost || shortPitch) {
        hostInitiatedFiltered++;
        continue;
      }
      buckets.push(b);
    }
    if (hostInitiatedFiltered > 0) {
      logger.info({ slug, hostInitiatedFiltered }, 'Direct-email: skipped host-initiated threads');
    }

    for (const bucket of buckets) {
      // Step 1: Upsert thread shell first (FK target for messages)
      const sortedMails = [...bucket.mails].sort((a, b) =>
        a.receivedAt.localeCompare(b.receivedAt),
      );
      const placeholderThread: NewMessageThread = {
        id: bucket.threadId,
        listing_id: listingId,
        source: 'gmail',
        channel: 'direct_email',
        guest_name: bucket.guestName,
        guest_email: bucket.guestEmail,
        first_message_at: sortedMails[0].receivedAt,
        last_message_at: sortedMails[sortedMails.length - 1].receivedAt,
        message_count: bucket.mails.length,
        reservation_id: null,
        inquiry_id: null,
        reservation_status: null,
        conversion_category: null,
        classification_confidence: null,
        classification_keywords: null,
        raw_meta: null,
        last_synced_at: now,
      };
      upsertThread(placeholderThread);

      // Step 2: Upsert each mail
      for (const mail of bucket.mails) {
        maxUid = Math.max(maxUid, mail.uid);
        const direction = isFromHost(mail, property) ? 'outbound' : 'inbound';
        const msg: NewMessage = {
          id: `gmail:${mail.messageId}`,
          thread_id: bucket.threadId,
          direction,
          sent_at: mail.receivedAt,
          from_name: mail.fromName,
          from_address: mail.fromEmail ?? mail.fromAddress,
          to_address: mail.toEmail ?? mail.toAddress,
          subject: mail.subject,
          body: mail.textBody || stripHtml(mail.htmlBody),
          body_html: mail.htmlBody || null,
          source: 'gmail',
          raw_meta: JSON.stringify({
            uid: mail.uid,
            inReplyTo: mail.inReplyTo,
            references: mail.references,
            gmailThreadId: mail.threadId,
          }),
        };
        upsertMessage(msg);
        upserted++;
      }

      // Step 3: Re-upsert thread with updated timestamps and reservation link.
      // Try to link the thread to a manual reservation by name/email match.
      const existing = getMessagesByThread(bucket.threadId);

      const sorted = [...existing].sort((a, b) => a.sent_at.localeCompare(b.sent_at));
      const firstAt = sorted[0]?.sent_at ?? bucket.mails[0].receivedAt;
      const lastAt = sorted[sorted.length - 1]?.sent_at ?? bucket.mails[bucket.mails.length - 1].receivedAt;

      // Look up potential matching manual reservations for this property
      const candidates = getDatabase()
        .prepare(
          `SELECT reservation_id AS reservationId, guest_name AS guestName, check_in AS checkIn, status
           FROM reservations
           WHERE listing_id = ? AND source IN ('manual', 'meetreet')
             AND status IN ('confirmed', 'reserved', 'active')`,
        )
        .all(listingId) as Array<ReservationMatcherCandidate & { status: string }>;

      const match = matchThreadToReservation(
        {
          guestName: bucket.guestName,
          guestEmail: bucket.guestEmail,
          lastMessageAt: lastAt,
        },
        candidates,
      );

      const linkedRes = match
        ? candidates.find((c) => c.reservationId === match.reservationId)
        : null;
      const linkedStatus = linkedRes?.status ?? null;

      const thread: NewMessageThread = {
        id: bucket.threadId,
        listing_id: listingId,
        source: 'gmail',
        channel: 'direct_email',
        guest_name: bucket.guestName,
        guest_email: bucket.guestEmail,
        first_message_at: firstAt,
        last_message_at: lastAt,
        message_count: existing.length,
        reservation_id: match?.reservationId ?? null,
        inquiry_id: null,
        reservation_status: linkedStatus,
        conversion_category: null,
        classification_confidence: null,
        classification_keywords: null,
        raw_meta: JSON.stringify({ label, lastSubject: bucket.mails[bucket.mails.length - 1].subject }),
        last_synced_at: now,
      };
      upsertThread(thread);
    }

    if (maxUid > sinceUid) setLastEmailUid(slug, maxUid);

    const duration = Date.now() - start;
    logger.info(
      {
        slug,
        label,
        fetched: all.length,
        platformFiltered,
        upserted,
        threadsTouched: buckets.length,
        duration,
      },
      'Direct-email: sync completed',
    );

    return {
      success: true,
      fetched: all.length,
      platformFiltered,
      hostInitiatedFiltered,
      upserted,
      threadsTouched: buckets.length,
      durationMs: duration,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'unknown';
    logger.error({ slug, error: errMsg }, 'Direct-email: sync failed');
    return {
      success: false,
      fetched: 0,
      platformFiltered: 0,
      hostInitiatedFiltered: 0,
      upserted: 0,
      threadsTouched: 0,
      durationMs: Date.now() - start,
      error: errMsg,
    };
  } finally {
    await client.disconnect();
  }
}

// Cheap HTML strip — used only if textBody is missing.
function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
