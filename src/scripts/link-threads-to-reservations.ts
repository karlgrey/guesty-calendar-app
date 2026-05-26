/**
 * Backfill: link Gmail message_threads to corresponding Guesty entities.
 *
 * Two passes:
 *  1. Match Gmail threads against manual / meetreet *reservations* and persist
 *     thread.reservation_id (booked direct-email leads → CONFIRMED).
 *  2. Match remaining Gmail threads against meetreet *conversations* (placeholder
 *     threads with company name) and persist thread.linked_thread_id (non-booked
 *     direct-email leads that came in via Meetreet).
 *
 * Usage:
 *   npx tsx src/scripts/link-threads-to-reservations.ts <slug>
 */

import { initDatabase, getDatabase } from '../db/index.js';
import { getPropertyBySlug } from '../config/properties.js';
import {
  matchThreadToReservation,
  type ReservationMatcherCandidate,
} from '../utils/thread-reservation-matcher.js';

interface ThreadRow {
  id: string;
  guest_name: string | null;
  guest_email: string | null;
  last_message_at: string;
  reservation_id: string | null;
  linked_thread_id: string | null;
  channel: string;
  reservation_status: string | null;
}

interface ReservationRow {
  reservation_id: string;
  guest_name: string | null;
  check_in: string;
  status: string;
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: link-threads-to-reservations.ts <slug>');
    process.exit(1);
  }
  const property = getPropertyBySlug(slug);
  if (!property) {
    console.error(`Property '${slug}' not found`);
    process.exit(1);
  }
  const listingId =
    property.guestyPropertyId ?? property.hostexPropertyId ?? property.airbnbListingId;
  if (!listingId) {
    console.error(`Property '${slug}' has no listing id`);
    process.exit(1);
  }

  initDatabase();
  const db = getDatabase();

  const threads = db
    .prepare(
      `SELECT id, guest_name, guest_email, last_message_at, reservation_id, linked_thread_id, channel, reservation_status
       FROM message_threads
       WHERE listing_id = ? AND source = 'gmail'`,
    )
    .all(listingId) as ThreadRow[];

  const reservations = db
    .prepare(
      `SELECT reservation_id, guest_name, check_in, status
       FROM reservations
       WHERE listing_id = ? AND source IN ('manual', 'meetreet')
         AND status IN ('confirmed', 'reserved', 'active')`,
    )
    .all(listingId) as ReservationRow[];

  const candidates: ReservationMatcherCandidate[] = reservations.map((r) => ({
    reservationId: r.reservation_id,
    guestName: r.guest_name,
    checkIn: r.check_in,
  }));

  console.log(`Threads (gmail): ${threads.length}, Reservation candidates: ${candidates.length}`);

  const updateStmt = db.prepare(
    `UPDATE message_threads
     SET reservation_id = ?,
         reservation_status = ?
     WHERE id = ?`,
  );

  let matched = 0;
  let alreadyLinked = 0;
  for (const t of threads) {
    if (t.reservation_id) {
      alreadyLinked++;
      continue;
    }
    const match = matchThreadToReservation(
      {
        guestName: t.guest_name,
        guestEmail: t.guest_email,
        lastMessageAt: t.last_message_at,
      },
      candidates,
    );
    if (!match) continue;

    const linkedRes = reservations.find((r) => r.reservation_id === match.reservationId);
    const newStatus = linkedRes?.status ?? null;

    updateStmt.run(
      match.reservationId,
      newStatus,
      t.id,
    );
    matched++;
    console.log(
      `  → ${t.guest_name || t.guest_email} → ${match.reservationId}` +
        ` (score ${match.score.toFixed(1)})`,
    );
  }

  console.log(`\nPass 1 (reservations). matched=${matched}, alreadyLinked=${alreadyLinked}, unmatched=${threads.length - matched - alreadyLinked}`);

  // ── Pass 2: link remaining Gmail threads to Meetreet placeholder threads ──
  // Meetreet inquiries carry the company name in guest_name (e.g. "Oatly Germany GmbH").
  // Match the same way as reservations — the matcher treats the candidates generically.
  const meetreetConvs = db
    .prepare(
      `SELECT id, guest_name, first_message_at
       FROM message_threads
       WHERE listing_id = ? AND source = 'guesty' AND channel = 'meetreet'`,
    )
    .all(listingId) as Array<{ id: string; guest_name: string | null; first_message_at: string }>;

  const linkThreadStmt = db.prepare(
    `UPDATE message_threads SET linked_thread_id = ? WHERE id = ?`,
  );

  // Refresh the threads list — Pass 1 updated some of them
  const threadsAfterPass1 = db
    .prepare(
      `SELECT id, guest_name, guest_email, last_message_at, reservation_id, linked_thread_id, channel, reservation_status
       FROM message_threads
       WHERE listing_id = ? AND source = 'gmail'`,
    )
    .all(listingId) as ThreadRow[];

  // Meetreet relays the inquiry from locations@meetreet.com — the guest name
  // is generic "meetreet" and the actual company is in the subject or body.
  // Subject patterns (when company appears in the heading):
  //   "Erinnerung:  fritz kola wartet auf dein Angebot (Farmhouse Prasser)"
  //   "⏰ Erinnerung:  Teamhero GmbH wartet auf dein Angebot"
  //   "Noch 24h für dein Angebot an fritz kola"
  //   "1 neue Nachricht von Juliane (Farmhouse Prasser)"
  // Body patterns (Meetreet's templated booking-request body — always present):
  //   "####Neue Buchungsanfrage von fritz kola für Farmhouse Prasser"
  //   "Für die Anfrage von fritz kola wurde folgende Nachricht …"
  const getInboundStmt = db.prepare(
    `SELECT subject, body FROM messages WHERE thread_id = ? AND direction = 'inbound' ORDER BY sent_at`,
  );
  const SUBJECT_PATTERNS: RegExp[] = [
    /Erinnerung:\s+(.+?)\s+wartet\s+auf/i,
    /Angebot\s+an\s+([^(]+?)(?:\s*\(|$)/i,
    /neue\s+Nachricht\s+von\s+([^(]+?)(?:\s*\(|$)/i,
  ];
  const BODY_PATTERNS: RegExp[] = [
    // Initial inquiry blast — Meetreet's templated body always contains this line
    /Neue\s+Buchungsanfrage\s+von\s+(.+?)\s+für\s+Farmhouse/i,
    // Message notification for an ongoing inquiry
    /Für\s+die\s+Anfrage\s+von\s+(.+?)\s+wurde\s+folgende/i,
  ];

  function extractMeetreetCompany(threadId: string): string | null {
    const rows = getInboundStmt.all(threadId) as Array<{ subject: string | null; body: string | null }>;
    // 1) Body patterns first — Meetreet's templated body always carries the
    //    canonical company, while subjects often name the Meetreet operator
    //    ("1 neue Nachricht von Laura") instead of the inquiring company.
    for (const row of rows) {
      const body = (row.body || '').replace(/\s+/g, ' ').trim();
      if (!body) continue;
      for (const re of BODY_PATTERNS) {
        const m = body.match(re);
        if (m && m[1]) return m[1].trim();
      }
    }
    // 2) Fallback to subject patterns
    for (const row of rows) {
      const subj = (row.subject || '').trim();
      if (!subj) continue;
      for (const re of SUBJECT_PATTERNS) {
        const m = subj.match(re);
        if (m && m[1]) return m[1].trim();
      }
    }
    return null;
  }

  // Lightweight Meetreet matcher: at least one distinctive (≥4 char, non-noise)
  // token from the lookup name appears in the candidate name. Higher overlap = higher score.
  // Handles cases the strict generic matcher misses ("Juliane" → "idalab GmbH Juliane").
  const NOISE_TOKENS = new Set(['gmbh', 'ag', 'kg', 'gbr', 'ug', 'mbh', 'co', 'ltd', 'inc']);
  function tokenize(s: string): string[] {
    return (s || '')
      .toLowerCase()
      .replace(/[,.()&]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !NOISE_TOKENS.has(t));
  }
  function matchMeetreet(
    lookup: string,
    candidates: Array<{ id: string; name: string | null; date: string }>,
    lastMessageAt: string,
  ): { id: string; score: number } | null {
    const lt = tokenize(lookup);
    if (lt.length === 0) return null;

    let best: { id: string; score: number; date: string } | null = null;
    for (const c of candidates) {
      const ct = tokenize(c.name || '');
      if (ct.length === 0) continue;

      // Token overlap — exact match OR prefix match (≥5 chars) to absorb typos
      // like "AnalyticaA" ↔ "Analytica" or "Reweee" ↔ "Rewe".
      const tokenMatches = (lookupTok: string) =>
        ct.some(
          (cTok) =>
            cTok === lookupTok ||
            (lookupTok.length >= 5 && cTok.length >= 5 &&
              (cTok.startsWith(lookupTok.slice(0, 5)) || lookupTok.startsWith(cTok.slice(0, 5)))),
        );

      const matchingTokens = lt.filter(tokenMatches);
      const overlap = matchingTokens.length;
      if (overlap === 0) continue;

      const allLookupTokensFound = lt.every(tokenMatches);
      const hasDistinctive = matchingTokens.some((t) => t.length >= 4);
      if (!allLookupTokensFound && !hasDistinctive) continue;

      const score = overlap + (allLookupTokensFound ? 1 : 0);
      if (
        !best ||
        score > best.score ||
        (score === best.score &&
          Math.abs(new Date(c.date).getTime() - new Date(lastMessageAt).getTime()) <
            Math.abs(new Date(best.date).getTime() - new Date(lastMessageAt).getTime()))
      ) {
        best = { id: c.id, score, date: c.date };
      }
    }
    return best ? { id: best.id, score: best.score } : null;
  }

  const meetreetMatchCandidates = meetreetConvs.map((c) => ({
    id: c.id,
    name: c.guest_name,
    date: c.first_message_at,
  }));

  let meetreetMatched = 0;
  let meetreetAlready = 0;
  let meetreetNoCompany = 0;
  for (const t of threadsAfterPass1) {
    if (t.reservation_id) continue;
    if (t.linked_thread_id) { meetreetAlready++; continue; }

    // For Meetreet-relayed threads (guest_name='meetreet'), extract company
    // from message subjects. For other threads, use the existing guest_name.
    const isMeetreetRelay = (t.guest_name || '').toLowerCase().trim() === 'meetreet';
    let lookupName = t.guest_name;
    if (isMeetreetRelay) {
      const company = extractMeetreetCompany(t.id);
      if (!company) { meetreetNoCompany++; continue; }
      lookupName = company;
    }

    const match = matchMeetreet(lookupName ?? '', meetreetMatchCandidates, t.last_message_at);
    if (!match) continue;
    linkThreadStmt.run(match.id, t.id);
    meetreetMatched++;
    const cand = meetreetConvs.find((c) => c.id === match.id);
    console.log(
      `  ↔ ${lookupName} ↔ ${cand?.guest_name} (Meetreet, score ${match.score})`,
    );
  }
  console.log(
    `\nPass 2 (meetreet). matched=${meetreetMatched}, alreadyLinked=${meetreetAlready}, no-company=${meetreetNoCompany}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
